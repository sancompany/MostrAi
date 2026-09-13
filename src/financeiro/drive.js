const fs = require('fs');
const { google } = require('googleapis');

// Sobe o PDF de nota fiscal (emitida manualmente pelo admin, ver
// src/admin) pra pasta fixa do workspace San & Co. — conta de serviço,
// sem interação humana.
async function subirNotaFiscal(caminhoLocalPdf, nomeArquivo) {
  const auth = new google.auth.GoogleAuth({
    keyFile: process.env.GOOGLE_SERVICE_ACCOUNT_KEY_PATH,
    scopes: ['https://www.googleapis.com/auth/drive.file'],
  });
  const drive = google.drive({ version: 'v3', auth });
  const { data } = await drive.files.create({
    requestBody: { name: nomeArquivo, parents: [process.env.GOOGLE_DRIVE_FOLDER_ID] },
    media: { mimeType: 'application/pdf', body: fs.createReadStream(caminhoLocalPdf) },
    fields: 'id, webViewLink',
  });
  return { driveFileId: data.id, url: data.webViewLink };
}

module.exports = { subirNotaFiscal };
