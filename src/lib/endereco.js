// Endereço em partes, num lugar só (D5, rodada de 24/09/2026 — decisão do
// dono: CEP, logradouro, número, complemento, bairro, cidade e UF em campos
// separados em todo o sistema; migration 086).
//
// `endereco` continua existindo como a linha "logradouro, número", composta
// AQUI a partir das partes: é o que a busca de ponto duplicado, a lista
// pública de pontos e o link do mapa já leem. Nenhuma rota compõe essa linha
// por conta própria — e nenhum formulário também (antes cada um colava
// `${rua}, ${numero}` do seu jeito no navegador).

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

module.exports = { PARTES, colunasDoEndereco, parteQueFalta, temEndereco, linhaEndereco };
