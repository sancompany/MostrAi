# CONSTRAINTS — Trimundi

O que a Trimundi **não** faz, as regras que não se afrouxam e os limites
assumidos. O que se quer para depois não mora aqui: mora em
`proximas-versoes.md`.

## Vetos (não construir)

- **Cobrança própria.** Pagamento é sempre pelo San Checkout, como
  contratante próprio da Trimundi (skill `checkout`). Dado de cartão nunca
  passa pela Trimundi.
- **Tabela da Trimundi no `public`, ou da Mostraí no `trimundi`.** A
  Trimundi mora no banco da Mostraí, mas só no esquema `trimundi` (decisão
  do dono, 09/11/2026 — exceção registrada abaixo). A conexão dela só entra
  no pool depois de o servidor confirmar o esquema; o migrador confere de
  novo antes de cada arquivo. Se um lado precisa de algo do outro, chama a
  função do módulo dono do dado, nunca a tabela dele.
- **Elemento da Mostraí na experiência da Trimundi.** Páginas públicas,
  conta do cliente, login do operador e e-mail usam a marca Trimundi; nenhum
  link leva ao site da Mostraí (teste `trimundi-identidade`). O e-mail sai
  pelo remetente da Mostraí, com a logo e o nome Trimundi no corpo (decisão
  do dono).
- **Cadastro público de operador.** Só o Admin cria operador.
- **Gamificação.** Indicação é link, rastreio e recompensa — sem níveis,
  pontos ou ranking.
- **Segredo no navegador ou no repositório.** A chave do contratante, o
  segredo de assinatura do QR e a conexão do banco moram só em variável de
  ambiente do servidor. O repositório é público.
- **QR com dado pessoal.** O QR carrega só versão, código público da
  edição, código do ingresso e assinatura.
- **Operador com acesso ao Admin ou a dado administrativo.** A sessão de
  operador só abre `/ticket/*` e só tem a permissão de check-in.
- **Venda acima da disponibilidade.** Quem decide se há vaga é o servidor,
  numa transação; o navegador nunca decide.
- **Itens do pedido em JSON** e **dinheiro em ponto flutuante**
  (`docs/erros/2026-09-14-dinheiro-em-ponto-flutuante.md`).

## Regras duras

As 12 regras de funcionamento do pedido do dono (09/11/2026). Violar
qualquer uma é defeito. Onde cada uma mora: `modelo-de-dados.md`, "Travas e
invariantes".

1. Cada ingresso individual tem identificador único e QR próprio.
2. Um pedido pode conter vários ingressos.
3. Cada ingresso tem seu próprio participante.
4. Combos geram ingressos individuais; o combo é a oferta, nunca um
   ingresso compartilhado.
5. Cortesias não contam como receita.
6. Ingresso pago só é emitido depois da confirmação legítima do pagamento
   pelo servidor.
7. A confirmação de pagamento é idempotente: nunca emite em dobro.
8. Nenhuma venda acima da disponibilidade.
9. O QR não expõe CPF nem outro dado pessoal.
10. O aceite dos termos guarda a versão aceita e a identificação do aceite.
11. Operador só tem permissão de check-in.
12. Dado pessoal tratado conforme a LGPD (`inventario-de-dados.md`).

Do contrato do San Checkout (`API.md` v2), igual na Mostraí:
- id de pedido imprevisível (UUID);
- `X-Checkout-Key` conferida em toda chamada recebida;
- webhook com HMAC sobre o corpo cru, janela de 300 s e comparação em tempo
  constante;
- deduplicação pelo `eventoId`;
- campo, status e evento desconhecidos são ignorados com 200.

Do banco:
- migrations só acrescentam e moram em `src/trimundi/db/migrations/`
  (numeração própria);
- migration aplicada nunca se edita;
- toda tabela nasce com RLS ligado e sem política.

## Limites assumidos

- **Escala desta versão:** só o Admin, sem venda pública. Nenhuma decisão de
  arquitetura foi tomada por carga. A escala da venda se decide antes dela
  (spec, §9).
- **Processo e deploy divididos com a Mostraí** (spec §5, opção 1). Um pico
  de venda pode derrubar os dois projetos, e publicar um publica o outro.
  Sai antes da venda pública, com a decisão do serviço próprio.
- **Reserva serializada por edição** (P-06). Toda criação de pedido trava a
  linha da edição: simples e correto, mas uma edição vende um pedido por
  vez. Medir quantos pedidos por segundo cabem antes da venda pública.
- **Login próprio** (substitui o D-05, 09/11/2026). O operador entra em
  `/ticket/entrar` e o cliente em `/ticket/conta`; a tela de login da
  Mostraí não conhece nenhum dos dois e voltou a ser exatamente a da `main`.
- **Tentativa de login e sessão ficam no `public`.** O limitador
  (`tentativas_acesso`) e a sessão (`session`) são da aplicação. Lá só
  existem a chave HMAC do e-mail e o id do operador ou do cliente, sem nome
  nem e-mail em claro. É o único dado da Trimundi fora do esquema dela, e é
  pseudônimo.
- **Uma conexão de sessão.** O esquema é posto por conexão (`SET
  search_path`), então a Trimundi só liga com o pooler de SESSÃO (5432);
  com o de transação (6543) o módulo fica desligado.
- **O administrador é um usuário só**, o mesmo da Mostraí. O histórico
  registra também o e-mail do Cloudflare Access, que é por pessoa.
- **E-mail da Mostraí** (decisão do dono). Confirmação de conta, senha e
  ingressos saem pelo SMTP e remetente da Mostraí: dividem a cota e a
  reputação de envio dela. O acesso do operador nasce por código mostrado no
  Admin (P-01).

## Exceções registradas

| Regra | Exceção | Sai quando |
|---|---|---|
| um projeto por repositório e por serviço (skill `leis`, "A pasta-mãe"; skill `classificar`, teste da entrega) | a Trimundi mora no repositório e na aplicação da Mostraí, por decisão do dono (09/11/2026, D-01). A fronteira fica no código: prefixo `trimundi`, esquema próprio, documentos próprios | venda pública com volume que peça serviço próprio, ou a Mostraí ser entregue a terceiro |
| banco próprio por projeto (skill `classificar`) | a Trimundi usa o banco da Mostraí, no esquema `trimundi`, por decisão do dono (09/11/2026: "banco e imagens utiliza a própria estrutura da Mostraí"). Isolamento lógico: esquema próprio, conexão que falha fechado, sem FK cruzada, RLS em toda tabela, API pública do Supabase sem acesso ao esquema. Backup: o da Mostraí cobre; restaurar só a Trimundi com `pg_restore -n trimundi` | o mesmo gatilho da linha acima; separar é apontar `TRIMUNDI_DATABASE_URL` para outro banco (o mesmo esquema), sem mudar código |
