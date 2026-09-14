// CPF e CNPJ — validação por dígito verificador (módulo 11).
//
// Por que existe: até 14/09/2026 o Mostraí aceitava qualquer coisa no campo
// `cpf_cnpj`. Esse valor vai para o San Checkout e de lá para a Asaas como
// documento do pagador — documento inválido quebra a cobrança depois do
// cadastro, quando a pessoa já foi embora.
//
// O CNPJ é ALFANUMÉRICO desde julho de 2026 (Receita Federal, IN 2.229/2024 e
// NT COCAD/SUARA 2024.001): as 12 primeiras posições aceitam letras e dígitos,
// e só os 2 verificadores seguem numéricos. Cada caractere entra no cálculo
// como o código ASCII menos 48 — então '0'→0, '9'→9, 'A'→17, 'Z'→42. Um
// validador só numérico recusa empresa aberta de julho em diante, que é o pior
// tipo de bug: só aparece com cliente novo, e parece implicância do sistema.
// Conferido contra a NT da Receita em 14/09/2026.

const SO_ALFANUM = /[^0-9A-Za-z]/g;

function limpar(valor) {
  return String(valor || '').replace(SO_ALFANUM, '').toUpperCase();
}

// Peso decrescente de 9 a 2, repetindo, da direita para a esquerda.
function digito(base, pesos) {
  let soma = 0;
  for (let i = 0; i < base.length; i += 1) {
    soma += (base.charCodeAt(i) - 48) * pesos[i];
  }
  const resto = soma % 11;
  return resto < 2 ? 0 : 11 - resto;
}

function validarCpf(valor) {
  const cpf = limpar(valor);
  if (cpf.length !== 11 || /[^0-9]/.test(cpf)) return false;
  // Sequência repetida passa no módulo 11 por acidente (111.111.111-11).
  if (/^(\d)\1{10}$/.test(cpf)) return false;

  const d1 = digito(cpf.slice(0, 9), [10, 9, 8, 7, 6, 5, 4, 3, 2]);
  if (d1 !== Number(cpf[9])) return false;
  const d2 = digito(cpf.slice(0, 10), [11, 10, 9, 8, 7, 6, 5, 4, 3, 2]);
  return d2 === Number(cpf[10]);
}

function validarCnpj(valor) {
  const cnpj = limpar(valor);
  if (cnpj.length !== 14) return false;
  // Os dois verificadores continuam numéricos mesmo no CNPJ alfanumérico.
  if (/[^0-9]/.test(cnpj.slice(12))) return false;
  if (/^(.)\1{13}$/.test(cnpj)) return false;

  const d1 = digito(cnpj.slice(0, 12), [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2]);
  if (d1 !== Number(cnpj[12])) return false;
  const d2 = digito(cnpj.slice(0, 13), [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2]);
  return d2 === Number(cnpj[13]);
}

// O cadastro tem um campo só para os dois. Decide pelo tamanho, não pergunta.
function validarCpfOuCnpj(valor) {
  const v = limpar(valor);
  if (v.length === 11) return validarCpf(v) ? null : 'CPF inválido — confira os números.';
  if (v.length === 14) return validarCnpj(v) ? null : 'CNPJ inválido — confira os caracteres.';
  return 'Informe um CPF (11 dígitos) ou CNPJ (14 caracteres).';
}

function formatar(valor) {
  const v = limpar(valor);
  if (v.length === 11) return `${v.slice(0,3)}.${v.slice(3,6)}.${v.slice(6,9)}-${v.slice(9)}`;
  if (v.length === 14) return `${v.slice(0,2)}.${v.slice(2,5)}.${v.slice(5,8)}/${v.slice(8,12)}-${v.slice(12)}`;
  return v;
}

module.exports = { limpar, validarCpf, validarCnpj, validarCpfOuCnpj, formatar };
