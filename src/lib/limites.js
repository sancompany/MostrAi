// Limites de negócio que mais de um domínio precisa conhecer. Moram aqui, num
// lugar só, porque o teste de "isso está duplicado?" é: se este número mudar,
// em quantos arquivos eu preciso encostar?

// Quantos criativos de uma conta entram na rotação de uma tela.
//
// O teto é DURO, decidido pelo dono em 17/09/2026 ("limitamos ao máximo do
// máximo mesmo, 3 criativos somente"). Ele já existia dentro do gerador, mas
// só lá: o admin tinha `max="3"` no input, que é validação de navegador e
// nada mais, e nenhuma rota conferia. Um plano criado com 5 pela API era
// aceito, vendido com 5 na vitrine, e a tela rodava 3 — sem aviso em lugar
// nenhum, porque o corte era silencioso no fim da linha.
//
// Agora o número vive aqui e quem valida é o repositório de planos, antes de
// gravar. O corte no gerador continua como última defesa (dado antigo, ou
// alguém escrevendo no banco à mão), mas deixou de ser o único.
const CRIATIVOS_POR_CONTA = 3;

module.exports = { CRIATIVOS_POR_CONTA };
