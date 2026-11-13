'use strict';

/**
 * Auto Token — servidor de licenças com emissão sob demanda.
 * Sem dependências externas: usa apenas módulos nativos do Node.js.
 *
 * Compatibilidade mantida com o AHK existente:
 *   POST /api/license
 *   application/x-www-form-urlencoded: key=...&hwid=...
 *
 * Administração:
 *   POST /admin/keys          { "orderId": "SHOP-123", "expires": null }
 *   POST /admin/keys/batch    { "count": 20, "expires": null }
 *   GET  /admin/stats
 *   POST /admin/keys/:key/revoke
 *   POST /admin/keys/:key/reset-device
 *
 * Todas as rotas /admin exigem Authorization: Bearer <LICENSE_ADMIN_TOKEN>.
 */

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '0.0.0.0';
const ADMIN_TOKEN = process.env.LICENSE_ADMIN_TOKEN || '';
const DB_FILE = process.env.KEYS_FILE || path.join(__dirname, 'keys.json');
const BODY_LIMIT = 32 * 1024;
const KEY_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // sem I, O, 0 e 1

if (!Number.isInteger(PORT) || PORT < 1 || PORT > 65535) {
  throw new Error('PORT inválida.');
}
if (ADMIN_TOKEN.length < 32) {
  throw new Error('Defina LICENSE_ADMIN_TOKEN com pelo menos 32 caracteres antes de iniciar.');
}

function ensureDatabase() {
  if (!fs.existsSync(DB_FILE)) {
    fs.mkdirSync(path.dirname(DB_FILE), { recursive: true });
    fs.writeFileSync(DB_FILE, '{}\n', { flag: 'wx', mode: 0o600 });
  }
}

function loadDatabase() {
  ensureDatabase();
  try {
    const parsed = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('Formato inválido');
    }
    return parsed;
  } catch (error) {
    // Nunca sobrescrever automaticamente um banco corrompido: isso poderia apagar licenças.
    throw new Error(`Não foi possível ler ${DB_FILE}: ${error.message}`);
  }
}

function saveDatabase(data) {
  const tempFile = `${DB_FILE}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  fs.writeFileSync(tempFile, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tempFile, DB_FILE);
}

function generateKey(database) {
  // 16 caracteres aleatórios em 32 símbolos (80 bits), em formato legível.
  for (let attempt = 0; attempt < 20; attempt += 1) {
    let raw = '';
    for (let i = 0; i < 16; i += 1) {
      raw += KEY_ALPHABET[crypto.randomInt(0, KEY_ALPHABET.length)];
    }
    const key = `ATK-${raw.slice(0, 4)}-${raw.slice(4, 8)}-${raw.slice(8, 12)}-${raw.slice(12, 16)}`;
    if (!Object.prototype.hasOwnProperty.call(database, key)) return key;
  }
  throw new Error('Não foi possível gerar uma chave única. Tente novamente.');
}

function normalizeExpiry(value) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new Error('expires deve estar no formato YYYY-MM-DD ou ser null.');
  }
  const date = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value) {
    throw new Error('Data de expiração inválida.');
  }
  return value;
}

function safeTokenEqual(candidate, expected) {
  if (typeof candidate !== 'string') return false;
  const a = Buffer.from(candidate);
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function isAdmin(req) {
  const header = req.headers.authorization || '';
  const match = /^Bearer\s+(.+)$/i.exec(header);
  return Boolean(match && safeTokenEqual(match[1], ADMIN_TOKEN));
}

function sendJson(res, statusCode, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
      if (Buffer.byteLength(body) > BODY_LIMIT) {
        reject(Object.assign(new Error('Corpo da requisição muito grande.'), { statusCode: 413 }));
        req.destroy();
      }
    });
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

function parseBody(raw, contentType) {
  if (!raw) return {};
  if (contentType.includes('application/json')) {
    try {
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error();
      return parsed;
    } catch {
      throw Object.assign(new Error('JSON inválido.'), { statusCode: 400 });
    }
  }
  const params = new URLSearchParams(raw);
  return Object.fromEntries(params.entries());
}

function findByOrderId(database, orderId) {
  if (!orderId) return null;
  for (const [key, license] of Object.entries(database)) {
    if (license && license.orderId === orderId) return { key, license };
  }
  return null;
}

function issueOne(database, { orderId = null, expires = null, note = null } = {}) {
  if (orderId !== null && (typeof orderId !== 'string' || orderId.length < 1 || orderId.length > 120)) {
    throw new Error('orderId deve ser um texto de 1 a 120 caracteres.');
  }
  if (orderId) {
    const existing = findByOrderId(database, orderId);
    if (existing) return { key: existing.key, license: existing.license, alreadyIssued: true };
  }

  const key = generateKey(database);
  const license = {
    hwid: null,
    expires: normalizeExpiry(expires),
    revoked: false,
    createdAt: new Date().toISOString(),
    orderId: orderId || undefined,
    note: typeof note === 'string' && note.trim() ? note.trim().slice(0, 200) : undefined,
  };
  database[key] = license;
  return { key, license, alreadyIssued: false };
}

function expiryHasPassed(expiry) {
  if (!expiry) return false;
  // A chave permanece válida durante todo o dia indicado em expires.
  const endOfDayUtc = new Date(`${expiry}T23:59:59.999Z`);
  return Date.now() > endOfDayUtc.getTime();
}

async function handleLicenseCheck(req, res) {
  const raw = await readBody(req);
  const body = parseBody(raw, req.headers['content-type'] || '');
  const key = String(body.key || '').toUpperCase().trim();
  const hwid = String(body.hwid || '').toLowerCase();

  if (!/^[A-Z0-9-]{6,40}$/.test(key) || !/^[0-9a-f]{64}$/.test(hwid)) {
    return sendJson(res, 200, { ok: false, msg: 'Chave inválida.' });
  }

  const database = loadDatabase();
  const license = database[key];
  if (!license || license.revoked) {
    return sendJson(res, 200, { ok: false, msg: 'Chave inválida ou desativada.' });
  }
  if (expiryHasPassed(license.expires)) {
    return sendJson(res, 200, { ok: false, msg: 'Chave expirada.' });
  }

  if (!license.hwid) {
    license.hwid = hwid;
    license.activated = new Date().toISOString();
    saveDatabase(database);
  }
  if (license.hwid !== hwid) {
    return sendJson(res, 200, { ok: false, msg: 'Esta chave já está em uso em outro PC.' });
  }

  return sendJson(res, 200, { ok: true, expires: license.expires || '' });
}

async function handleAdmin(req, res, pathname) {
  if (!isAdmin(req)) return sendJson(res, 401, { ok: false, error: 'Não autorizado.' });

  if (req.method === 'GET' && pathname === '/admin/stats') {
    const database = loadDatabase();
    const entries = Object.values(database);
    return sendJson(res, 200, {
      ok: true,
      total: entries.length,
      active: entries.filter((item) => item && !item.revoked && !expiryHasPassed(item.expires)).length,
      activated: entries.filter((item) => item && Boolean(item.hwid)).length,
      revoked: entries.filter((item) => item && Boolean(item.revoked)).length,
    });
  }

  // Importa licenças existentes uma única vez, sem substituir registros já cadastrados.
  if (req.method === 'POST' && pathname === '/admin/keys/import') {
    const raw = await readBody(req);
    const body = parseBody(raw, req.headers['content-type'] || 'application/json');
    const incoming = body.keys;
    if (!incoming || typeof incoming !== 'object' || Array.isArray(incoming)) {
      return sendJson(res, 400, { ok: false, error: 'Envie um objeto keys contendo as licenças.' });
    }
    const database = loadDatabase();
    let imported = 0;
    let skipped = 0;
    for (const [key, item] of Object.entries(incoming)) {
      if (!/^ATK-[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/.test(key)) {
        return sendJson(res, 400, { ok: false, error: `Formato de chave inválido: ${key}` });
      }
      if (!item || typeof item !== 'object' || Array.isArray(item) || (item.hwid !== null && item.hwid !== undefined) || item.revoked === true) {
        return sendJson(res, 400, { ok: false, error: `A licença ${key} não está livre para importação.` });
      }
      normalizeExpiry(item.expires);
      if (Object.prototype.hasOwnProperty.call(database, key)) {
        skipped += 1;
        continue;
      }
      database[key] = {
        hwid: null,
        expires: item.expires || null,
        revoked: false,
        createdAt: item.createdAt || new Date().toISOString(),
        orderId: item.orderId,
        note: item.note || 'Importada do estoque existente',
      };
      imported += 1;
    }
    if (imported > 0) saveDatabase(database);
    return sendJson(res, 200, { ok: true, imported, skipped, total: Object.keys(database).length });
  }

  if (req.method === 'POST' && (pathname === '/admin/keys' || pathname === '/admin/keys/batch')) {
    const raw = await readBody(req);
    const body = parseBody(raw, req.headers['content-type'] || 'application/json');
    const database = loadDatabase();
    const expires = normalizeExpiry(body.expires);

    if (pathname === '/admin/keys') {
      const result = issueOne(database, {
        orderId: body.orderId || null,
        expires,
        note: body.note || null,
      });
      if (!result.alreadyIssued) saveDatabase(database);
      return sendJson(res, result.alreadyIssued ? 200 : 201, {
        ok: true,
        key: result.key,
        expires: result.license.expires || null,
        alreadyIssued: result.alreadyIssued,
      });
    }

    const count = Number(body.count);
    if (!Number.isInteger(count) || count < 1 || count > 100) {
      return sendJson(res, 400, { ok: false, error: 'count deve ser um inteiro entre 1 e 100.' });
    }
    const keys = [];
    for (let i = 0; i < count; i += 1) {
      const result = issueOne(database, { expires, note: body.note || 'Lote administrativo' });
      keys.push(result.key);
    }
    saveDatabase(database);
    return sendJson(res, 201, { ok: true, count: keys.length, keys, expires });
  }

  const actionMatch = /^\/admin\/keys\/([A-Z0-9-]+)\/(revoke|reset-device)$/.exec(pathname);
  if (req.method === 'POST' && actionMatch) {
    const key = actionMatch[1];
    const action = actionMatch[2];
    const database = loadDatabase();
    const license = database[key];
    if (!license) return sendJson(res, 404, { ok: false, error: 'Chave não encontrada.' });

    if (action === 'revoke') license.revoked = true;
    if (action === 'reset-device') {
      license.hwid = null;
      delete license.activated;
    }
    saveDatabase(database);
    return sendJson(res, 200, { ok: true, key, action });
  }

  return sendJson(res, 404, { ok: false, error: 'Rota administrativa não encontrada.' });
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    if (req.method === 'GET' && url.pathname === '/health') {
      return sendJson(res, 200, { ok: true, service: 'auto-token-license-server' });
    }
    if (url.pathname === '/api/license' && req.method === 'POST') {
      return await handleLicenseCheck(req, res);
    }
    if (url.pathname.startsWith('/admin/')) {
      return await handleAdmin(req, res, url.pathname);
    }
    return sendJson(res, 404, { ok: false, error: 'Rota não encontrada.' });
  } catch (error) {
    const status = Number(error.statusCode) || 500;
    if (status >= 500) console.error(`[${new Date().toISOString()}]`, error);
    if (!res.headersSent) sendJson(res, status, { ok: false, error: status >= 500 ? 'Erro interno do servidor.' : error.message });
    else res.destroy();
  }
});

server.listen(PORT, HOST, () => {
  ensureDatabase();
  console.log(`Auto Token License Server ativo em http://${HOST}:${PORT}`);
  console.log(`Banco de licenças: ${DB_FILE}`);
  console.log('Rotas: POST /api/license | POST /admin/keys | POST /admin/keys/batch | GET /admin/stats');
});

process.on('SIGINT', () => server.close(() => process.exit(0)));
process.on('SIGTERM', () => server.close(() => process.exit(0)));
