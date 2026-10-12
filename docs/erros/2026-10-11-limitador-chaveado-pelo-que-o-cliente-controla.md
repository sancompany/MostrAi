# O limitador de tentativas chaveava pelo que o cliente controla

**Sintoma** (auditoria Review-Master, ciclo 1, 11/10/2026 — AUD-002 e
AUD-003, ALTOS e reproduzidos em servidor local). O teto de "10 tentativas
por IP a cada 15 min" do `src/lib/limite-tentativas.js` valia só no papel,
por dois caminhos independentes:

- **Grafia do caminho** (AUD-002). A chave era `${req.ip}:${req.path}` com o
  caminho cru. O Express, sem `case sensitive routing`/`strict routing`,
  roteia `/Anunciantes/login`, `/anunciantes/login/` e `/ANUNCIANTES/LOGIN`
  para o mesmo handler — e cada grafia ganhava um balde novo de 10.
- **Acerto zerava o balde do IP inteiro** (AUD-003). `zerarTentativas`
  apagava a chave do IP+rota, que era a mesma para toda conta. Com uma conta
  própria (cadastro público e grátis), 9 chutes na vítima + 1 login certo na
  própria conta reiniciava a contagem: 36 chutes seguidos sem um 429.

**Causa raiz.** A chave do balde era montada com o que o CLIENTE controla — a
grafia pedida —, e o acerto apagava o balde inteiro, inclusive os erros
contra outra conta. Um limitador só limita o que a chave distingue e o que
ninguém apaga.

**Correção** (sem migration; `tests/limite-login.test.js` sobe o app real):

- Rota = `req.route.path`, a rota como declarada.
- Dois baldes, cada um com o teto de 10 na janela, em sequência: o do IP
  primeiro, e o pedido que ele barrou não conta contra a conta. IP+rota em
  toda rota limitada; conta+rota nos dois logins e no esqueci-senha
  (`alvo:<HMAC do e-mail normalizado ou do usuário>:<rota>`). No acerto,
  `descontarAcerto(req, res)` tira 1 do balde do IP — a tentativa que
  acertou —, apaga o balde da conta que acertou e marca o navegador. Os erros
  contra outra conta ficam.
- Aparelho conhecido (OWASP, "device cookies"): o login certo emite
  `mostrai.aparelho` (sorteio + HMAC de rota, alvo e sorteio; 90 dias). O
  pedido que o traz conta num balde do aparelho, não no da conta. A
  redefinição de senha zera o balde da conta e também marca o navegador
  (`liberarConta`).

**O que a revisão ensinou no caminho** (12/10/2026):

- Pôr o alvo DENTRO da chave do IP (um balde por IP+e-mail) trocou "10 por
  IP" por "10 por alvo": credential stuffing (um e-mail vazado por chute) e a
  varredura de telas no provisionar ficaram sem teto.
- Só o balde do IP deixa a força bruta numa conta sem teto pra quem tem
  muitos endereços: um /48 IPv6 de túnel gratuito são 65.536 /64, 10 chutes
  cada contra a MESMA vítima. Por isso o balde da conta é SEPARADO e soma ao
  do IP, não o substitui.
- `tests/email-verificacao.test.js` apagava a tabela inteira antes de cada
  chamada; com `npm test` em paralelo, isso zerava no meio do laço o balde que
  o teste do limitador esperava ver estourar. Teste apaga só as próprias
  chaves.
- Somar os dois baldes em todo pedido deixava um IP só, já estourado no
  próprio balde, encher de novo o da conta a cada janela: a conta ficava
  travada pra sempre com 11 pedidos por janela, e redefinir a senha não
  destravava. Os docs diziam "por até 15 min" — falso.
- Pôr balde por conta só nos logins deixou o esqueci-senha só com o teto do
  IP: quem tem muitos endereços mandava links de redefinição sem teto pra
  mesma pessoa.

**Efeito aceito.** O balde da conta trava a dona junto com quem chuta — a
senha certa também recebe 429, senão o 429 diria ao atacante quando ele
acertou. Enquanto alguém mantiver 10 erros por janela contra a conta (um IP
basta), o login dela de aparelho novo fica travado; do aparelho onde já
entrou, entra; redefinir a senha destrava (RUNBOOK §6). Limites assumidos no
CONSTRAINTS.md: quem tem muitos endereços multiplica o teto do IP no que mira
muitas contas (stuffing, 409 do cadastro, links pra muitos e-mails).

**Regra que fica.** A chave de um limitador é montada pelo SERVIDOR a partir
do que ele decidiu (a rota registrada) — nunca do caminho como chegou. Um
balde segura um eixo só: o da origem segura quem tenta muitas contas de um
lugar; o da conta segura quem tenta uma conta de muitos lugares — força bruta
pede os dois. E o acerto devolve só o que é dele: 1 na origem, a própria
conta inteira. Balde que trava a vítima precisa de saída que o atacante não
tenha (aparelho conhecido, redefinição pelo e-mail) — senão o limitador vira
a arma.
