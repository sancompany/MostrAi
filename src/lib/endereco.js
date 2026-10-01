// Endereço em partes, num lugar só (D5, rodada de 24/09/2026 — decisão do
// dono: CEP, logradouro, número, complemento, bairro, cidade e UF em campos
// separados em todo o sistema; migration 086).
//
// `endereco` continua existindo como a linha "logradouro, número", composta
// AQUI a partir das partes: é o que a busca de ponto duplicado, a lista
// pública de pontos e o link do mapa já leem. Nenhuma rota compõe essa linha
// por conta própria — e nenhum formulário também (antes cada um colava
// `${rua}, ${numero}` do seu jeito no navegador).
//
// Limites e leitura do Número (estação de endereços, 01/10/2026) moram em
// public/endereco-regras.js, o mesmo arquivo que o navegador carrega — um
// limite só pros dois lados.

const { LIMITES, NUMERO_VALIDO, numeroSuspeito } = require('../../public/endereco-regras');

const PARTES = ['cep', 'logradouro', 'numero', 'complemento', 'bairro', 'cidade', 'uf'];
// O que um endereço completo precisa ter. Complemento é o único opcional.
const OBRIGATORIAS = ['cep', 'logradouro', 'numero', 'bairro', 'cidade', 'uf'];
const ROTULO = {
  cep: 'CEP',
  logradouro: 'logradouro',
  numero: 'número',
  bairro: 'bairro',
  cidade: 'cidade',
  uf: 'UF',
};

// Nome do campo na mensagem de erro de formato/tamanho.
const NOME = {
  cep: 'CEP',
  logradouro: 'Logradouro',
  numero: 'Número',
  complemento: 'Complemento',
  bairro: 'Bairro',
  cidade: 'Cidade',
  uf: 'UF',
  endereco: 'Endereço',
};
// A linha composta, quando um cliente antigo manda só ela: rua + ", " + número.
const LIMITE_DA_LINHA = LIMITES.logradouro + 2 + LIMITES.numero;

function limpo(valor) {
  if (valor === undefined) return undefined;
  const texto = String(valor ?? '').trim();
  return texto || null;
}

function compor(logradouro, numero) {
  if (!logradouro) return null;
  return numero ? `${logradouro}, ${numero}` : logradouro;
}

// As colunas a gravar a partir do corpo de uma requisição. Só devolve chave
// pro que veio (undefined = não mexe), então serve pra criação e pra PATCH.
// `atual` (a linha gravada) entra na composição quando o PATCH manda só uma
// das duas partes da linha — trocar só o número não pode apagar a rua.
//
// Compatibilidade: cliente que ainda manda só `endereco` (página antiga em
// cache no meio do deploy, integração) é aceito como veio, sem partes.
function colunasDoEndereco(corpo, atual = null) {
  const colunas = {};
  for (const parte of PARTES) {
    const valor = limpo(corpo?.[parte]);
    if (valor !== undefined) colunas[parte] = valor;
  }
  if (colunas.uf) colunas.uf = colunas.uf.toUpperCase();
  // CEP sempre gravado como 00000-000 (o formulário já manda assim; a API
  // podia receber só os dígitos). Só quando são exatamente 8 dígitos — o
  // resto fica como veio e quem valida recusa.
  const digitosDoCep = colunas.cep?.replace(/\D/g, '');
  if (digitosDoCep?.length === 8) colunas.cep = `${digitosDoCep.slice(0, 5)}-${digitosDoCep.slice(5)}`;
  if (colunas.logradouro !== undefined || colunas.numero !== undefined) {
    const logradouro = colunas.logradouro !== undefined ? colunas.logradouro : (atual?.logradouro ?? null);
    const numero = colunas.numero !== undefined ? colunas.numero : (atual?.numero ?? null);
    // Sem logradouro pra compor (registro de antes da migration 086 copiado
    // de um lugar pro outro, ex.: candidatura antiga virando ponto), vale a
    // linha que veio junto — ou a gravada, se o PATCH não tocou na rua.
    const linhaEnviada = corpo?.endereco !== undefined ? limpo(corpo.endereco) : undefined;
    colunas.endereco =
      compor(logradouro, numero) ??
      linhaEnviada ??
      (colunas.logradouro === undefined ? (atual?.endereco ?? null) : null);
  } else if (corpo?.endereco !== undefined) {
    colunas.endereco = limpo(corpo.endereco);
  }
  return colunas;
}

// Primeira parte obrigatória que falta (pra mensagem de erro), ou null.
// Endereço no formato antigo (só `endereco`) é conferido como sempre foi:
// linha, cidade, UF e CEP.
function parteQueFalta(colunas) {
  const formatoAntigo = colunas.logradouro === undefined && colunas.endereco !== undefined;
  const exigidas = formatoAntigo ? ['endereco', 'cidade', 'uf', 'cep'] : OBRIGATORIAS;
  const falta = exigidas.find((p) => !colunas[p]);
  if (!falta) return null;
  return falta === 'endereco' ? 'endereço' : ROTULO[falta];
}

// Formato e tamanho de cada parte que VEIO no corpo (a que não veio não é
// conferida — registro antigo continua salvando o que não foi tocado).
// Devolve { campo, erro } da primeira parte errada, ou null. Vale para toda
// porta de entrada (cadastro, convite, perfil, candidatura de ponto, edição
// do ponto, Admin); dado copiado de um registro já gravado (candidatura
// virando ponto) não passa por aqui, pra nunca travar registro antigo.
function problemaNoEndereco(corpo) {
  for (const parte of [...PARTES, 'endereco']) {
    const valor = corpo?.[parte];
    if (valor === undefined || valor === null) continue;
    // Objeto ou lista no lugar de texto: nunca vira String() gravada.
    if (typeof valor !== 'string' && typeof valor !== 'number')
      return { campo: parte, erro: `${NOME[parte]} inválido.` };
    const texto = String(valor).trim();
    if (!texto) continue;
    const limite = parte === 'endereco' ? LIMITE_DA_LINHA : LIMITES[parte];
    if (parte !== 'cep' && texto.length > limite) {
      return { campo: parte, erro: `${NOME[parte]} pode ter no máximo ${limite} caracteres.` };
    }
  }
  const cep = limpo(corpo?.cep);
  if (cep && !(/^[\d.\s-]+$/.test(cep) && cep.replace(/\D/g, '').length === 8)) {
    return { campo: 'cep', erro: 'CEP inválido — use 8 dígitos.' };
  }
  const uf = limpo(corpo?.uf);
  if (uf && !/^[A-Za-z]{2}$/.test(uf)) return { campo: 'uf', erro: 'UF são 2 letras, como SP.' };
  const numero = limpo(corpo?.numero);
  if (numero && !NUMERO_VALIDO.test(numero)) {
    return {
      campo: 'numero',
      erro: 'Número aceita só letras, números, espaço, hífen e barra — por exemplo 123, 12A, T10 ou S/N.',
    };
  }
  return null;
}

// O cliente viu o aviso de Número suspeito e confirmou que está certo
// (src/pendencias/endereco.js não reabre a pendência pra esse valor). Chega
// como booleano (JSON) ou "1" (formulário enviado com FormData).
function numeroConfirmado(corpo) {
  return corpo?.numero_confirmado === true || corpo?.numero_confirmado === '1';
}

// A conta tem endereço completo? O que já está gravado conta — inclusive a
// linha antiga sem as partes, que não obriga ninguém a recadastrar.
function temEndereco(linha) {
  if (!linha) return false;
  const temRua = linha.logradouro ? !!linha.numero : !!linha.endereco;
  return !!(temRua && linha.cidade && linha.uf && linha.cep);
}

// A linha de exibição: "Avenida 28 de Agosto, 2502 - Sala 3 - Alto" (e, com
// `comCidade`, ", Matão/SP"). Linha antiga sem partes sai como foi gravada.
function linhaEndereco(linha, { comCidade = false } = {}) {
  if (!linha) return '';
  const rua = linha.logradouro ? compor(linha.logradouro, linha.numero) : linha.endereco || '';
  const partes = [rua, linha.complemento, linha.bairro].filter(Boolean).join(' - ');
  if (!comCidade) return partes;
  const cidade = [linha.cidade, linha.uf].filter(Boolean).join('/');
  return [partes, cidade].filter(Boolean).join(', ');
}

module.exports = {
  PARTES,
  LIMITES,
  colunasDoEndereco,
  parteQueFalta,
  problemaNoEndereco,
  numeroSuspeito,
  numeroConfirmado,
  temEndereco,
  linhaEndereco,
};
