// Regra única do endereço (estação de endereços, 01/10/2026): os limites de
// cada parte e a leitura do "Número suspeito". Um arquivo só, para os dois
// lados — o navegador o carrega como script (`window.enderecoRegras`, usado
// por public/formulario.js) e o servidor o lê com `require`
// (src/lib/endereco.js). Mudar um limite aqui muda o formulário e a
// validação do servidor juntos; antes o formulário cortava o Número em 20
// caracteres e o servidor não tinha limite nenhum.
//
// O servidor é a fonte da verdade: ele valida e decide a pendência
// (src/pendencias/endereco.js). No navegador esta conta só serve para avisar
// na hora, antes de enviar.
(function (raiz, fabrica) {
  const regras = fabrica();
  if (typeof module === 'object' && module.exports) module.exports = regras;
  else raiz.enderecoRegras = regras;
})(globalThis, () => {
  // Caracteres por parte (o banco guarda `text`, sem teto: o teto é este).
  const LIMITES = { cep: 9, logradouro: 255, numero: 30, complemento: 255, bairro: 150, cidade: 150, uf: 2 };

  // Número é identificador do imóvel, não só dígito: 123, 12A, T7, T10,
  // 45-B, S/N, SN, Km 12. Letras, números, espaço, hífen e barra; começa por
  // letra ou número.
  const NUMERO_VALIDO = /^[\p{L}\p{N}][\p{L}\p{N} /-]*$/u;

  // Palavra de logradouro no começo, seguida de um nome: "Av Francisco",
  // "Rua XV", "R. Sete". Abreviação sozinha ou seguida de número ("R 5") não
  // conta — a leitura é conservadora de propósito.
  const PREFIXO_DE_LOGRADOURO =
    /^(rua|r|avenida|av|rodovia|rod|travessa|trav|tv|pra[cç]a|p[cç]a|alameda|al|estrada|estr|largo|viela)\.?\s+\p{L}{2,}/iu;

  const AVISO_NUMERO =
    'Confira este campo. Ele parece conter um endereço completo. O campo Número deve conter apenas algo como 123, 12A, T10 ou S/N.';

  // Parece endereço, não número? Só sinal forte: palavra de logradouro no
  // começo, três ou mais palavras de verdade (4+ letras, sem dígito) ou
  // tamanho muito acima de um identificador. Na dúvida, não é suspeito —
  // o aviso nunca bloqueia e nunca corrige nada sozinho.
  function numeroSuspeito(valor) {
    const texto = String(valor ?? '')
      .trim()
      .replace(/\s+/g, ' ');
    if (!texto) return false;
    if (PREFIXO_DE_LOGRADOURO.test(texto)) return true;
    const palavras = texto.split(' ').filter((p) => /^\p{L}{4,}$/u.test(p));
    if (palavras.length >= 3) return true;
    return texto.length > 20;
  }

  return { LIMITES, NUMERO_VALIDO, AVISO_NUMERO, numeroSuspeito };
});
