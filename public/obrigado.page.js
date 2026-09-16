// Volta do pagamento: escolhe qual dos dois textos da página aparece.
//
// O San Checkout acrescenta `?pedido=ID` só quando a volta é de um PEDIDO
// avulso — hoje, só a troca de plano. Assinatura volta sem parâmetro nenhum
// (API.md do Checkout, seção 3.1). É por isso que a distinção cabe aqui, sem
// consultar o servidor: não é informação de dinheiro, é só qual caminho a
// pessoa fez.
//
// O que este arquivo NÃO faz, de propósito: dar o pagamento por confirmado.
// A query string é escrita por qualquer um — quem digitar `?pedido=X` na
// barra de endereço cai neste mesmo texto, e por isso o texto fala em
// "recebemos", nunca em "pago". Quem confirma pagamento é o webhook assinado.
const trocaDePlano = new URLSearchParams(location.search).has('pedido');

const bloco = document.querySelector(`[data-volta="${trocaDePlano ? 'troca' : 'assinatura'}"]`);
const outro = document.querySelector(`[data-volta="${trocaDePlano ? 'assinatura' : 'troca'}"]`);
if (bloco && outro) {
  bloco.hidden = false;
  outro.hidden = true;
}

if (trocaDePlano) {
  document.title = 'Troca de plano recebida na Mostraí';
}
