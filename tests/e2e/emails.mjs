// E-mails capturados pelo servidor dos roteiros (EMAIL_CAPTURA, ligado em
// restart.sh): cada mensagem é uma linha JSON em saida/emails.jsonl. É daqui
// que os roteiros tiram o código de verificação — no banco ele só existe
// como hash (migration 097), e nenhum e-mail sai de verdade.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ARQUIVO = path.join(path.dirname(fileURLToPath(import.meta.url)), 'saida', 'emails.jsonl');

export function emailsPara(destino) {
  if (!fs.existsSync(ARQUIVO)) return [];
  return fs
    .readFileSync(ARQUIVO, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l))
    .filter((m) => String(m.to).toLowerCase() === String(destino).toLowerCase());
}

// Último código de 6 dígitos mandado pra `destino`, esperando até `ms` o
// processador da fila entregar (ele despacha na hora, mas é assíncrono).
export async function codigoPara(destino, { ms = 5000, depoisDe = 0 } = {}) {
  const fim = Date.now() + ms;
  while (Date.now() < fim) {
    const comCodigo = emailsPara(destino).filter((m) => Date.parse(m.em) >= depoisDe && /^\d{6}$/m.test(m.text));
    if (comCodigo.length) return comCodigo.at(-1).text.match(/^\d{6}$/m)[0];
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error(`nenhum código chegou pra ${destino} em ${ms} ms`);
}
