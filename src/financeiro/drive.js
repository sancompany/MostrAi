const fs = require('fs');
const { google } = require('googleapis');

// Sobe o PDF de nota fiscal (emitida manualmente pelo admin, ver
// src/admin) pra pasta fixa do workspace San & Co. — conta de serviço,
// sem interação humana.
// A credencial da conta de serviço pode vir de duas formas, nesta ordem:
//
// 1. `GOOGLE_SERVICE_ACCOUNT_KEY` — o JSON inteiro dentro da variável. É o
//    caminho preferido em produção: o segredo fica no painel do Northflank e
//    nunca vira arquivo. Este repositório é PÚBLICO (CONSTRAINTS.md), então um
//    `google.json` na árvore é um acidente esperando acontecer.
// 2. `GOOGLE_SERVICE_ACCOUNT_KEY_PATH` — caminho de arquivo, para quem roda
//    local com o JSON fora do repositório.
//
// Sem nenhuma das duas, a função estoura com mensagem clara em vez de deixar a
// biblioteca procurar credencial padrão do ambiente e falhar longe daqui.
function autenticacao() {
  const escopos = ['https://www.googleapis.com/auth/drive.file'];
  const inline = process.env.GOOGLE_SERVICE_ACCOUNT_KEY;

  if (inline) {
    let credenciais;
    try {
      credenciais = JSON.parse(inline);
    } catch (err) {
      throw new Error('GOOGLE_SERVICE_ACCOUNT_KEY não é um JSON válido');
    }
    return new google.auth.GoogleAuth({ credentials: credenciais, scopes: escopos });
  }

  const caminho = process.env.GOOGLE_SERVICE_ACCOUNT_KEY_PATH;
  if (!caminho) {
    throw new Error('configure GOOGLE_SERVICE_ACCOUNT_KEY (o JSON) ou GOOGLE_SERVICE_ACCOUNT_KEY_PATH (o arquivo)');
  }
  return new google.auth.GoogleAuth({ keyFile: caminho, scopes: escopos });
}

async function subirNotaFiscal(caminhoLocalPdf, nomeArquivo) {
  const auth = autenticacao();
  const drive = google.drive({ version: 'v3', auth });
  const { data } = await drive.files.create({
    requestBody: { name: nomeArquivo, parents: [process.env.GOOGLE_DRIVE_FOLDER_ID] },
    media: { mimeType: 'application/pdf', body: fs.createReadStream(caminhoLocalPdf) },
    fields: 'id, webViewLink',
  });
  return { driveFileId: data.id, url: data.webViewLink };
}

module.exports = { subirNotaFiscal };
