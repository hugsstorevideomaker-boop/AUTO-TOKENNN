# Auto Token — publicar o servidor no Railway

Este pacote contém somente o servidor e scripts administrativos. O banco de licenças fica em um volume persistente do Railway, não no GitHub.

## 1) Criar o repositório privado no GitHub

1. Entre em https://github.com e crie um repositório **Private** chamado `auto-token-license-server`.
2. Envie para ele os arquivos desta pasta: `license_server.js`, `package.json` e, se desejar, `.gitignore`.
3. **Não envie** `.env`, `keys.json`, chaves de clientes ou `LICENSE_ADMIN_TOKEN` ao GitHub.

## 2) Publicar no Railway

1. Entre em https://railway.com e crie um projeto.
2. Escolha **Deploy from GitHub Repo** e selecione o repositório privado.
3. Abra o serviço criado → **Settings** → **Networking** → **Generate Domain**.
4. Em **Settings / Volumes**, crie um volume com mount path `/data`.
5. Em **Variables**, adicione:
   - `HOST` = `0.0.0.0`
   - `KEYS_FILE` = `/data/keys.json`
   - `LICENSE_ADMIN_TOKEN` = um segredo aleatório longo (não compartilhe).
6. O Railway define `PORT` automaticamente. O comando de início é `npm start`.
7. Aguarde o deploy ficar verde e abra `https://SEU-DOMINIO/health`. Deve aparecer `{"ok":true,"service":"auto-token-license-server"}`.

## 3) Gerar o segredo administrativo no Windows

Com Node.js instalado, abra o PowerShell e execute:

```powershell
node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"
```

Copie o resultado para a variável `LICENSE_ADMIN_TOKEN` do Railway. Guarde esse segredo em local seguro. **Nunca coloque esse segredo no AHK distribuído aos compradores.**

## 4) Importar as 20 chaves já cadastradas no ShopEasy

Baixe o `keys.json` do pacote do lote de 20 chaves e coloque-o na mesma pasta do script `importar-keys.ps1`. Abra o PowerShell nessa pasta e execute (substitua o domínio e o segredo pelos seus valores):

```powershell
$env:LICENSE_SERVER_URL = "https://SEU-DOMINIO.up.railway.app"
$env:LICENSE_ADMIN_TOKEN = "SEU_SEGREDO_ADMINISTRATIVO"
.\importar-keys.ps1 -ArquivoKeys ".\keys.json"
```

O servidor importa apenas chaves ainda livres. Se rodar novamente, não duplica nem substitui as existentes.

## 5) Atualizar o Auto Token

No início do `auto_token.ahk`, configure `LICENSE_URL` para:

```ahk
global LICENSE_URL := "https://SEU-DOMINIO.up.railway.app/api/license"
```

Depois salve e compile o AHK em EXE no Windows. Antes de distribuir, teste a ativação com uma das chaves e confirme que o vínculo HWID aparece no servidor.

## 6) Emitir uma chave nova após aprovar o PIX

Depois de verificar o dinheiro recebido e aprovar o pedido manualmente no ShopEasy, execute:

```powershell
$env:LICENSE_SERVER_URL = "https://SEU-DOMINIO.up.railway.app"
$env:LICENSE_ADMIN_TOKEN = "SEU_SEGREDO_ADMINISTRATIVO"
.\gerar-chave.ps1 -OrderId "ID-REAL-DO-PEDIDO"
```

Entregue a chave retornada ao cliente. Repetir o mesmo OrderId retorna a chave do mesmo pedido, evitando emitir outra licença por engano.

## Segurança e custos

- Mantenha o repositório privado e não publique o segredo administrativo.
- O volume `/data` é indispensável: sem ele, `keys.json` pode ser perdido em novo deploy/reinício.
- Faça backup periódico de `/data/keys.json`.
- O plano grátis do Railway oferece créditos limitados; confira o uso no painel. O serviço pode parar quando o crédito terminar.
