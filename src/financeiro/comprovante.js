// Comprovante de pagamento em PDF — anexo do e-mail de pagamento confirmado.
//
// É COMPROVANTE, não nota fiscal: a contratada ainda não tem CNPJ (contrato do
// anunciante, cláusula 1) e não há emissão fiscal. O texto obrigatório abaixo
// diz exatamente isso, e o documento nunca se chama de outro jeito.
//
// Nasce SÓ de evento financeiro confirmado: uma linha de
// `cobrancas_confirmadas` — o número do comprovante é o id dela, então há um
// comprovante por ciclo confirmado, e gerar de novo dá o mesmo documento.
//
// PDF escrito à mão (PDF 1.4, uma página, fontes padrão Helvetica e
// Helvetica-Bold em WinAnsiEncoding — ISO 32000-1, 9.6.2 e anexo D): cobre
// todo acento do português sem embutir fonte, e evita uma dependência de
// dezenas de pacotes pra desenhar uma página de texto.

const TEXTO_OBRIGATORIO =
  'Este documento comprova o pagamento da contratação indicada e não substitui documento fiscal quando sua emissão for aplicável.';

// Quem recebe. Enquanto a pessoa jurídica não existe, o dono decide como o
// recebedor aparece (docs/PENDENCIAS.md): sem a variável, só o nome do negócio.
function recebedor() {
  return process.env.MOSTRAI_COMPROVANTE_RECEBEDOR || 'Mostraí — San & Co.';
}

const CICLO = { 1: 'mensal', 3: 'trimestral', 6: 'semestral', 12: 'anual' };

const FUSO = 'America/Sao_Paulo';
const dataHora = (d) =>
  new Date(d).toLocaleString('pt-BR', {
    timeZone: FUSO,
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
const reais = (v) => Number(v).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });

// CPF é dado pessoal: aparece mascarado (***.456.789-**). CNPJ é da empresa e
// sai inteiro — é o que identifica o pagador num comprovante.
function documentoDoPagador(doc) {
  const d = String(doc || '').replace(/\D/g, '');
  if (d.length === 11) return `CPF ***.${d.slice(3, 6)}.${d.slice(6, 9)}-**`;
  if (d.length === 14)
    return `CNPJ ${d.slice(0, 2)}.${d.slice(2, 5)}.${d.slice(5, 8)}/${d.slice(8, 12)}-${d.slice(12)}`;
  return null;
}

function numeroDoComprovante(cobrancaId) {
  return `MST-${String(cobrancaId).padStart(6, '0')}`;
}

// ---------------------------------------------------------------------------
// Texto → bytes WinAnsi. Latin-1 cobre os acentos; as poucas marcas fora dele
// que aparecem em texto brasileiro têm posição própria na WinAnsi (anexo D).
// ---------------------------------------------------------------------------
const WINANSI_EXTRA = {
  '€': 0x80,
  '…': 0x85,
  '‘': 0x91,
  '’': 0x92,
  '“': 0x93,
  '”': 0x94,
  '•': 0x95,
  '–': 0x96,
  '—': 0x97,
};

function winAnsi(texto) {
  const bytes = [];
  for (const ch of String(texto)) {
    const cp = ch.codePointAt(0);
    if (WINANSI_EXTRA[ch]) bytes.push(WINANSI_EXTRA[ch]);
    else if (cp >= 0x20 && cp <= 0xff && !(cp >= 0x7f && cp <= 0x9f)) bytes.push(cp);
    else bytes.push(0x3f); // '?'
  }
  // Parênteses e barra invertida delimitam string no PDF.
  return Buffer.from(bytes)
    .toString('latin1')
    .replace(/[\\()]/g, (c) => `\\${c}`);
}

// Quebra por palavra num número de caracteres — a fonte é proporcional, então
// o limite é conservador (Helvetica 10 pt ≈ 5 pt por caractere médio).
function quebrar(texto, porLinha) {
  const linhas = [];
  let atual = '';
  for (const palavra of String(texto).split(/\s+/)) {
    if (atual && (atual + ' ' + palavra).length > porLinha) {
      linhas.push(atual);
      atual = palavra;
    } else {
      atual = atual ? `${atual} ${palavra}` : palavra;
    }
  }
  if (atual) linhas.push(atual);
  return linhas;
}

// ---------------------------------------------------------------------------
// Montagem do PDF
// ---------------------------------------------------------------------------
const LARGURA = 595; // A4 em pontos
const ALTURA = 842;
const MARGEM = 56;

function montarConteudo(linhas) {
  const comandos = [];
  let y = ALTURA - MARGEM;
  for (const l of linhas) {
    if (l.espaco) {
      y -= l.espaco;
      continue;
    }
    if (l.regua) {
      comandos.push(`0.8 0.8 0.8 RG 0.75 w ${MARGEM} ${y} m ${LARGURA - MARGEM} ${y} l S`);
      y -= 14;
      continue;
    }
    const tamanho = l.tamanho || 10;
    const fonte = l.negrito ? 'F2' : 'F1';
    const cor = l.cinza ? '0.35 0.35 0.35 rg' : '0 0 0 rg';
    comandos.push(`BT ${cor} /${fonte} ${tamanho} Tf ${MARGEM} ${y} Td (${winAnsi(l.texto)}) Tj ET`);
    if (l.valor !== undefined) {
      comandos.push(`BT 0 0 0 rg /F1 ${tamanho} Tf ${MARGEM + 150} ${y} Td (${winAnsi(l.valor)}) Tj ET`);
    }
    y -= Math.round(tamanho * 1.6);
  }
  return comandos.join('\n');
}

function montarPdf(conteudo, titulo, criadoEm) {
  const quando = new Date(criadoEm).toISOString().replace(/[-:T]/g, '').slice(0, 14);
  const objetos = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${LARGURA} ${ALTURA}] /Resources << /Font << /F1 5 0 R /F2 6 0 R >> >> /Contents 4 0 R >>`,
    `<< /Length ${Buffer.byteLength(conteudo, 'latin1')} >>\nstream\n${conteudo}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>',
    `<< /Title (${winAnsi(titulo)}) /Producer (${winAnsi('Mostraí')}) /CreationDate (D:${quando}Z) >>`,
  ];
  let pdf = '%PDF-1.4\n%\xe2\xe3\xcf\xd3\n';
  const posicoes = [];
  objetos.forEach((corpo, i) => {
    posicoes.push(Buffer.byteLength(pdf, 'latin1'));
    pdf += `${i + 1} 0 obj\n${corpo}\nendobj\n`;
  });
  const inicioXref = Buffer.byteLength(pdf, 'latin1');
  pdf += `xref\n0 ${objetos.length + 1}\n0000000000 65535 f \n`;
  for (const p of posicoes) pdf += `${String(p).padStart(10, '0')} 00000 n \n`;
  pdf += `trailer\n<< /Size ${objetos.length + 1} /Root 1 0 R /Info 7 0 R >>\nstartxref\n${inicioXref}\n%%EOF\n`;
  return Buffer.from(pdf, 'latin1');
}

// dados: { cobrancaId, confirmadoEm, valor, plano: { nome, compromisso_meses },
//          anunciante: { nome_empresa, cpf_cnpj, contato_email } }
// Sem "vigência": o comprovante prova o PAGAMENTO. Quando o ciclo pago fica
// guardado atrás de um benefício em vigor, a data de cobertura não é a do
// pagamento — e um papel de dinheiro não pode trazer data errada.
function gerarComprovante(dados) {
  const { cobrancaId, confirmadoEm, valor, plano, anunciante } = dados;
  if (!cobrancaId || !confirmadoEm || !(Number(valor) > 0)) {
    throw new Error('comprovante só nasce de cobrança confirmada (id, data e valor)');
  }
  const numero = numeroDoComprovante(cobrancaId);
  const meses = plano.compromisso_meses;
  const ciclo = CICLO[meses] || `${meses} meses`;
  const documento = documentoDoPagador(anunciante.cpf_cnpj);

  const linhas = [
    { texto: 'Mostraí', negrito: true, tamanho: 22 },
    { texto: 'Anúncios nas telas do comércio local', cinza: true, tamanho: 10 },
    { espaco: 10 },
    { texto: 'COMPROVANTE DE PAGAMENTO', negrito: true, tamanho: 15 },
    { texto: `Nº ${numero}`, cinza: true, tamanho: 10 },
    { espaco: 6 },
    { regua: true },
    { texto: 'Pagamento confirmado em', negrito: true, valor: `${dataHora(confirmadoEm)} (horário de Brasília)` },
    { texto: 'Valor pago', negrito: true, valor: reais(valor) },
    { texto: 'Referente a', negrito: true, valor: `Plano ${plano.nome} — ciclo ${ciclo}` },
    { texto: 'Processado por', negrito: true, valor: 'San Checkout (Asaas)' },
    { espaco: 4 },
    { regua: true },
    { texto: 'Pagador', negrito: true, valor: anunciante.nome_empresa },
    ...(documento ? [{ texto: '', valor: documento }] : []),
    ...(anunciante.contato_email ? [{ texto: '', valor: anunciante.contato_email }] : []),
    { espaco: 4 },
    { texto: 'Recebedor', negrito: true, valor: recebedor() },
    { espaco: 4 },
    { regua: true },
    ...quebrar(TEXTO_OBRIGATORIO, 88).map((t) => ({ texto: t, tamanho: 10 })),
    { espaco: 8 },
    { texto: `Emitido pela Mostraí a partir da cobrança confirmada nº ${cobrancaId}.`, cinza: true, tamanho: 8 },
  ];
  return {
    nomeArquivo: `comprovante-${numero}.pdf`,
    pdf: montarPdf(montarConteudo(linhas), `Comprovante de pagamento ${numero}`, confirmadoEm),
  };
}

module.exports = { gerarComprovante, numeroDoComprovante, documentoDoPagador, TEXTO_OBRIGATORIO };
