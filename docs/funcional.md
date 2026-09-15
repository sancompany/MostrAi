# Definição funcional — Mostraí

O que o sistema faz, tela por tela, em detalhe suficiente para construir sem
inventar comportamento. Escrito na Estação 4 (14/09/2026).

Vizinhos: `docs/specs/2026-09-12-mostrai.md` diz **por que** o projeto existe;
`CONSTRAINTS.md` diz **o que ele não faz**; este diz **o que ele faz**.

> Este é o único documento de definição que muda durante o projeto. Mudou o
> comportamento, muda aqui na mesma tarefa.

---

## 1. Público-alvo

| Papel | O que quer resolver | O que sabe fazer sozinho |
|---|---|---|
| **Anunciante** | aparecer nas telas da cidade sem produzir campanha nem entender mídia; paga um valor fixo por mês | se cadastra, assina plano e sobe um vídeo pelo celular. Não lê manual |
| **Dono de ponto** | ganhar ajuda de custo ou anunciar o próprio negócio cedendo uma parede | liga a TV e não mexe mais. Usa o painel raramente, pelo celular |
| **Vendedor** | indicar anunciantes e receber comissão | manda o link com o cupom dele pelo WhatsApp. Acompanha o que tem a receber |
| **Administrador** (o dono do Mostraí) | aprovar quem entra, ver margem real, operar a rede | conhece o sistema inteiro. Usa no computador |
| **Tela** (aparelho, não pessoa) | tocar a playlist da própria tela sem ninguém por perto | nada. É um navegador em modo quiosque numa TV de comércio de terceiro |

Papel sem tela não existe; tela sem papel ninguém abre.

---

## 2. Jornadas

### 2.1 Anunciante — do site ao vídeo no ar

1. Chega em `/` ou `/planos.html` e vê a grade de planos com preço e frequência.
2. Escolhe um plano e clica em assinar → vai para `/anunciante/cadastro.html`.
3. Preenche empresa, CNPJ/CPF, endereço, contato e senha; aceita os termos.
4. A conta nasce com o papel **anunciante** e status `pendente_aprovacao`.
5. O administrador aprova (ou recusa) no admin.
6. Aprovado, volta ao painel e assina o plano → é levado ao San Checkout.
7. Paga. O webhook `criada` chega, a conta vira `ativo` e a cobertura começa.
8. Sobe o vídeo na aba **Anúncios**. O sistema normaliza com ffmpeg e gera a thumb.
9. O administrador aprova o criativo.
10. O vídeo entra na playlist de todas as telas ativas, na frequência do plano.
11. O anunciante acompanha exibições na própria aba.

### 2.2 Dono de ponto — da candidatura à tela no ar

1. Chega em `/seja-um-ponto.html` e manda a **candidatura** (não cria conta).
2. O administrador avalia bairro e ramo e decide.
3. Aprovado, recebe um **convite** (link) por WhatsApp, ou o administrador libera o papel numa conta que já existe.
4. Abre `/convite.html?t=…`, define senha, e a conta nasce com o papel **ponto**.
5. O administrador cadastra o ponto e as telas, define custo e prazo de amortização de cada uma, e gera a **chave de aparelho**.
6. A TV abre o link do player uma vez; a chave fica guardada no aparelho.
7. O dono do ponto define o **PIN** da tela no próprio painel
   (`/anunciante/ponto.html` → a tela → "PIN desta tela") e passa a acompanhar
   ali — ou pelo painel da própria TV, com 5 toques no canto e o PIN.
8. Sobe o **próprio anúncio** na cota do comodato, em "Meu anúncio na minha
   tela": mesma conferência de conteúdo que vale para qualquer anúncio da rede.

### 2.3 Vendedor — do convite à comissão

1. Recebe convite do administrador (não existe cadastro aberto).
2. Abre `/convite.html?t=…`, a conta nasce com o papel **vendedor** e um cupom.
3. Manda `/anunciante/cadastro.html?ref=CUPOM` para o interessado.
4. O indicado assina e paga.
5. A comissão é gerada sobre o valor confirmado, no percentual da conta do vendedor.
6. Acompanha em `/anunciante/vendedor.html`; o administrador marca como paga.

### 2.4 Administrador — o dia a dia

1. Entra em `/admin` (usuário e senha; o Cloudflare Access é a porta).
2. Vê o **resumo**: receita, ajuda de custo, amortização, custos fixos e **margem real**.
3. Aprova contas, candidaturas e criativos.
4. Gera convites, cadastra pontos e telas, define chave e PIN.
5. Edita a grade de planos e os benefícios.
6. Confere cobranças, comissões e a fila de eventos pendentes.

### 2.5 Tela — o ciclo do player

1. A TV abre `/player.html?tela=<id>` com a chave guardada.
2. Pede a playlist da hora; sem chave válida, 401.
3. Toca os vídeos em ordem, avisa `played` a cada exibição e manda `heartbeat`.
4. Cinco toques no canto superior direito (ou tecla P) pedem o PIN e abrem o painel daquela tela.

**Jornadas secundárias:** redefinir senha, editar perfil, excluir conta, pedir
ativação de um papel novo pelo painel, resgatar bônus de módulo cruzado.

---

## 3. Telas

| Tela | URL | Quem acessa | O que mostra | O que dá para fazer | Para onde leva |
|---|---|---|---|---|---|
| Início | `/` | público | o que é a rede, pontos, chamada | conhecer | planos, seja-um-ponto |
| Planos | `/planos.html` | público | grade de 3 níveis × 4 ciclos, e o plano fundador se aberto | escolher plano | cadastro |
| Pontos | `/pontos.html` | público | os comércios da rede | ver onde o anúncio roda | — |
| Comodato | `/comodato.html` | público | as opções de quem cede a parede | entender a contrapartida | seja-um-ponto |
| Seja um ponto | `/seja-um-ponto.html` | público | formulário de candidatura | enviar candidatura | — |
| Seja um vendedor | `/seja-um-vendedor.html` | público | formulário de candidatura | enviar candidatura | — |
| Contato | `/contato.html` | público | formulário | mandar mensagem | — |
| Cadastro | `/anunciante/cadastro.html` | público | formulário de conta (aceita `?ref=CUPOM`) | criar conta de anunciante | painel |
| Login | `/anunciante/login.html` | público | e-mail e senha | entrar | painel |
| Esqueci a senha | `/esqueci-senha.html` | público | e-mail | pedir link | — |
| Redefinir senha | `/redefinir-senha.html?token=` | quem tem o token | nova senha | trocar a senha | login |
| Convite | `/convite.html?t=TOKEN` | quem tem o convite | papéis que o convite concede | criar conta ou aceitar logado | painel |
| Painel | `/anunciante/painel.html` | conta logada | abas Anúncios / Meu ponto / Vendas | assinar, subir criativo, ver exibições, baixar o comprovante de veiculação (CSV), e **pedir a arte pelo WhatsApp** (anúncio simples incluído, ou gravação orçada à parte) | perfil, ponto, vendedor |
| Meu ponto | `/anunciante/ponto.html` | conta com papel ponto | telas do ponto, cota, **sinal de cada tela**, e o **extrato** do que já foi pago e do que está em aberto | definir PIN, acompanhar | — |
| Vendas | `/anunciante/vendedor.html` | conta com papel vendedor | cupom, indicados, comissões | copiar link, informar Pix | — |
| Perfil | `/anunciante/perfil.html` | conta logada | dados da conta | editar, trocar foto, excluir conta | — |
| Player | `/player.html?tela=ID` | a TV, com chave | o vídeo da vez | tocar; 5 toques abrem o painel por PIN | — |
| Admin | `/admin/` | administrador | tudo: resumo, contas, candidaturas, convites, pontos, telas, planos, benefícios, cobranças, comissões, vendedores, custos fixos, eventos pendentes, e **Meus anúncios** (a conta do próprio Mostraí) | operar a rede inteira | — |
| Termos de uso | `/termos-de-uso.html` | público | o contrato | ler | — |
| Política de privacidade | `/politica-de-privacidade.html` | público | uso de dados | ler | — |
| Contrato do anunciante | `/contrato-anunciante.html` | público | condições do plano | ler | — |

**Legado, mantido só para link salvo:** `/afiliado/*` responde 410 apontando
para a conta única. `POST /seja-um-ponto` responde 410 de propósito — o
caminho é a candidatura.

---

## 4. Estados de cada tela

Escrito por grupo, porque o padrão se repete.

**Planos (`/planos.html`)**
- *Vazio:* nenhum plano ativo → "os planos estão sendo atualizados, fale com a gente".
- *Carregando:* esqueleto dos cards.
- *Erro:* "não conseguimos carregar os planos agora" com botão de tentar de novo.
- *Sucesso:* a grade.
- *Sem permissão:* não se aplica — a tela é pública.
- *Lista longa:* não se aplica — são sempre 12 linhas, no máximo 13 com o fundador.

**Painel (`/anunciante/painel.html`)**
- *Vazio:* aba sem papel mostra o **card de ativação**, não uma tela em branco.
- *Carregando:* abas visíveis, conteúdo em esqueleto.
- *Erro:* faixa no topo com "não conseguimos carregar seus dados".
- *Sucesso:* conteúdo da aba.
- *Sem permissão:* sessão expirada → volta para o login.
- *Lista longa:* criativos e exibições paginam a partir de 50 linhas.

**Player (`/player.html`)**
- *Vazio:* playlist sem itens → tela institucional do Mostraí, nunca tela preta.
- *Carregando:* logo enquanto o primeiro vídeo carrega.
- *Erro:* sem rede → toca o que está em cache e tenta de novo a cada ciclo.
- *Sucesso:* o vídeo.
- *Sem permissão:* chave inválida → "tela não autorizada — fale com o Mostraí".
- *Lista longa:* o gerador corta em 200 slots por hora (trava de segurança).

**Admin (`/admin/`)**
- *Vazio:* cada aba diz o que fazer primeiro ("nenhuma candidatura ainda").
- *Carregando:* tabela em esqueleto.
- *Erro:* mensagem por seção, nunca uma página de erro inteira.
- *Sucesso:* a tabela.
- *Sem permissão:* 401 → tela de login do admin.
- *Lista longa:* tabelas paginam a partir de 100 linhas.

**Formulários públicos (cadastro, candidatura, contato, convite)**
- *Vazio:* campos limpos com rótulo visível.
- *Carregando:* botão desabilitado com "enviando…".
- *Erro:* mensagem **por campo**, e a geral acima do botão.
- *Sucesso:* confirmação na própria tela, sem redirecionar sem avisar.
- *Sem permissão:* convite usado ou expirado → "este convite não vale mais".
- *Lista longa:* não se aplica.

---

## 5. Regras de negócio

**RN-01 — A grade de planos é fixa: 3 níveis × 4 ciclos = 12 linhas.**
Essencial, Destaque e Máximo; mensal, trimestral, semestral e anual. Não existe
criar plano, só editar um dos 12. Cada célula é isolada — editar
Essencial-mensal não toca Essencial-anual. *Violada:* o admin não oferece a
ação. *Quem vê:* administrador.

**RN-02 — O que se desliga é o ciclo inteiro.** Um nível isolado só sai
enquanto o ciclo dele está ativo, para promoção. Plano desativado aparece
apagado **só no admin**, nunca para o cliente. *Violada:* o plano some da
vitrine. *Quem vê:* administrador vê apagado; o público não vê nada.

**RN-03 — Dono de ponto e vendedor só nascem por convite.** Não existe cadastro
público para esses papéis. *Violada:* `POST /seja-um-ponto` responde 410.
*Quem vê:* quem tentou.

**RN-04 — Benefício comercial se dá no preço, nunca no tempo.** A assinatura do
San Checkout não tem carência, mês grátis nem pular ciclo. Desconto entra no
valor que `GET /plano/{id}` devolve. *Violada:* não há caminho no código.
*Quem vê:* ninguém — é veto estrutural.

**RN-05 — A primeira cobrança paga chega como `criada`; renovação como
`cobranca_confirmada`.** Os dois creditam um ciclo, pela mesma dedupe por
`chargeId`. *Violada:* o evento vira pendência e espera a conciliação.
*Quem vê:* administrador, na fila de eventos pendentes.

**RN-06 — O webhook é fail-closed.** Sem assinatura HMAC válida, dentro da
janela de 300s, sobre o corpo cru, é 401. *Violada:* nada é creditado.
*Quem vê:* ninguém na hora; a conciliação diária corrige.

**RN-07 — Tela ≠ ponto.** Playlist, chave, PIN, sinal e custo vivem em
`dispositivos`. Ajuda de custo e cota de autoanúncio vivem no ponto, e a cota é
dividida entre as telas dele. *Violada:* não há caminho. *Quem vê:* —

**RN-08 — Nada de usuário e senha na TV.** A tela autentica por chave de
aparelho, revogável no admin. O PIN de 4 a 6 dígitos abre **apenas** o painel
daquela tela. *Violada:* 401 no player. *Quem vê:* quem está na frente da TV.

**RN-09 — A playlist tem teto de 200 slots por hora.** Trava de segurança sobre
os 240 slots teóricos. *Violada:* o gerador corta o excedente. *Quem vê:*
ninguém — é proteção silenciosa.

**RN-10 — A frequência compensa déficit da hora anterior.** Quem ficou devendo
exibição recebe a mais na hora seguinte. *Violada:* não há caminho.
*Quem vê:* o anunciante, na contagem de exibições.

**RN-11 — Preço travado.** A conta paga o valor de quando entrou
(`valor_mensal_travado`), mesmo que o plano suba depois. *Violada:* não há
caminho. *Quem vê:* o anunciante, na fatura.

**RN-12 — Comissão do vendedor é gerada a cada cobrança confirmada**, inclusive
renovação, no percentual da conta dele — **confirmado pelo dono em
15/09/2026: mantém**. O percentual é do VENDEDOR (`vendedores.comissao_percentual`),
não do plano, então troca de plano de quem ele indicou nunca muda a comissão.
O dono define o valor entre **10% e 30%** (migration 035); fora da faixa a
rota recusa. *Violada:* não há caminho. *Quem vê:* vendedor e administrador.

**RN-13 — Troca de plano de quem já paga é recusada.** O sistema manda falar
com o administrador, para evitar cobrança dupla na Asaas. O caminho é cancelar
e assinar de novo. *Violada:* mensagem na tela. *Quem vê:* o anunciante.

**RN-14 — Fundador é status de conta, marcado à mão pelo administrador**
(migration 033, 15/09/2026) — não é mais plano de catálogo, nem trava por
variável de ambiente (isso deixou de fazer sentido quando RN-27/item 9 passou
a travar o preço de QUALQUER plano assinado). A conta marcada `fundador`
ganha um desconto percentual — definido pelo administrador, por conta — nos
planos que ele liberar (piso de compromisso em meses, ex.: só trimestral pra
cima). Fora do piso, a assinatura é recusada. *Violada:* "esse plano não está
liberado para conta fundadora". *Quem vê:* o anunciante.

**RN-32 — Desconto de comodato por plano (item 8 da spec).** Conta com papel
`ponto` (comodato) recebe o desconto que o administrador definiu pra aquele
plano de anunciante especificamente (`planos.desconto_comodato_percentual`,
campo de contrato — só muda por versão nova). Some com o desconto de
fundador, se a conta tiver os dois. *Violada:* não há caminho — o desconto
já sai no preço. *Quem vê:* o anunciante, no valor cobrado pelo San Checkout.

**RN-33 — Vagas: qualquer plano pode ter teto (campo `vagas`), sem vaga o
plano some da vitrine.** Uma assinatura sem cobrança confirmada solta a vaga
sozinha depois de 15 minutos (decisão do dono, 15/09/2026 — era 7 dias).
*Violada:* "as vagas desse plano acabaram". *Quem vê:* o anunciante.

**RN-15 — Exclusão de conta é soft-delete de 60 dias.** A conta some do sistema
na hora; o suporte pode reverter dentro de 60 dias. Não há tela de desfazer.
*Violada:* conta excluída não loga. *Quem vê:* quem excluiu.

**RN-16 — Limite de 10 tentativas por 15 minutos, por IP e rota.** Vale para
login, admin e redefinição. Reinício do servidor zera (é em memória).
*Violada:* "muitas tentativas, tente mais tarde". *Quem vê:* quem tentou.

**RN-22 — A peça é feita fora do site e sobe direto na conta do cliente.** Não
existe editor de anúncio no sistema. Quem não tem arte pede pelo WhatsApp, a
partir do painel: **anúncio simples é incluído no plano**; **gravação de vídeo é
serviço de produtora parceira, orçada à parte**. Nos dois casos a reunião e o
fechamento acontecem na conversa, e o resultado sobe pelo admin. Criativo que o
operador sobe entra **já aprovado** (quem aprovaria é quem acabou de subir) e
fica marcado em `editado_pelo_operador`, para ninguém cobrar do anunciante um
vídeo que o Mostraí montou. *Violada:* conta inexistente responde 404; o teto de
criativos do plano continua valendo nas contas de cliente. *Quem vê:* o
administrador.

**RN-23 — O admin pode liberar um plano de graça (cortesia).** Põe a conta no
ar sem criar assinatura nem cobrança: o San Checkout não fica sabendo, nada é
cobrado agora nem na renovação, e a cobertura simplesmente vence na data. A
conta em cortesia **não trava preço** — acabada a cortesia, ela assina pelo
valor da vitrine. O resumo do admin separa `anunciantesAtivosPagantes` de
`anunciantesEmCortesia`, porque "5 ativos" com três liberados de graça é a
leitura errada do número que mais importa. *Violada:* liberar cortesia por cima
de plano pago ativo responde 409 — cancele a assinatura antes, senão a
cobertura comprada seria apagada e pareceria um upgrade. *Quem vê:* o
administrador, com o motivo registrado na própria linha.

**RN-21 — O Mostraí tem uma conta de anunciante própria, e só uma.** Ela vive
no admin, em "Meus anúncios": anuncia a rede nas telas da rede. Difere de uma
conta comum em três pontos e só neles — não assina plano (a frequência vem de
`frequencia_dia_propria`), não tem teto de criativos, e nunca gera cobrança,
então não entra na receita nem na margem. Difere também da cota de autoanúncio
do ponto, que só roda nas telas daquele comércio: a conta própria roda na rede
inteira. *Violada:* tentar criar a segunda recebe 409 antes de qualquer
inserção, e o índice único do banco é a última defesa. Conta comum **não pode**
se marcar como própria — a marca não existe no caminho de cadastro, só na
rota do admin. *Quem vê:* o administrador.

**RN-18 — O anunciante é avisado quando o vídeo entra no ar.** Na transição do
criativo para `aprovado` — e só na transição —, sai um e-mail dizendo que ele
está na playlist. Salvar de novo um criativo já aprovado não reenvia.
*Violada:* nada acontece; a aprovação não depende do e-mail. *Quem vê:* o
anunciante, na caixa de entrada.

**RN-19 — O comprovante de veiculação respeita o período escolhido.** O CSV
sai com `;` e BOM UTF-8, porque o Excel em português com vírgula junta tudo
numa coluna e come os acentos. Período aceito: de 1 a 365 dias; fora disso é
limitado, não recusado. *Violada:* conta diferente da própria recebe 403.
*Quem vê:* o anunciante.

**RN-20 — O pagamento ao ponto é um lançamento por ponto por mês.** Lançar o
mesmo mês de novo atualiza o valor em vez de criar outro — é o que impede pagar
duas vezes por duplo clique no admin. Enquanto `pago_em` é nulo, a linha está
em aberto. *Violada:* o banco recusa pela chave única. *Quem vê:* o dono do
ponto, no extrato; o administrador, na lista do ponto.

**RN-24 — O titular baixa os próprios dados sem pedir a ninguém.**
`GET /titular/meus-dados` devolve, num JSON só, a conta e tudo que ela gerou —
pontos, telas, criativos, assinaturas, cobranças, comissões nas duas pontas,
exibições, pagamentos recebidos como ponto, candidaturas. Não inclui senha nem
chave/PIN de aparelho: isso é credencial, não dado do titular, e exportar hash
só ajuda quem roubar o arquivo. *Violada:* não há caminho automático — a rota é
uma leitura. *Quem vê:* o próprio titular, no perfil.

**RN-25 — Só se revoga o que é consentimento.** Comunicação de novidade e
oferta depende de consentimento e se desliga a qualquer tempo; o contato do
responsável e a foto são opcionais e se apagam na hora. Nome, documento,
endereço e histórico de cobrança têm outra base legal — execução de contrato e
obrigação fiscal — e não se revogam isoladamente: saem junto com a conta. A
trava da comunicação mora no remetente (`enviarNovidade`), não em quem chama.
*Violada:* uma mensagem de divulgação que não passe por `enviarNovidade`.
*Quem vê:* o titular, no perfil; o administrador, na coluna
`comunicacoes_revogado_em`.

**RN-26 — Arrependimento em 7 dias devolve tudo, e o prazo conta da primeira
cobrança confirmada.** É o art. 49 do CDC, e a venda é a consumidor à
distância. O botão só existe dentro do prazo. Ao pedir: a assinatura é
cancelada no San Checkout **antes** de qualquer mudança aqui (se falhar, nada
muda e a pessoa tenta de novo), a conta é suspensa e o anúncio sai do ar na
hora, e o valor **integral** já pago vira um pedido de devolução na fila do
admin — não há pró-rata pelos dias em que o anúncio rodou, o direito não é
proporcional. O estorno em si é executado no painel do Checkout/Asaas, porque a
API dele não expõe estorno; o admin registra o comprovante pra fechar o pedido.
*Violada:* o índice único barra um segundo pedido em aberto por conta.
*Quem vê:* o titular, no perfil; o administrador, na aba Devoluções e no alerta
da visão geral.

**RN-27 — Plano assinado é imutável para quem assinou.** Os campos do plano
se dividem em dois. **Vitrine** (`ativo`, `vagas`, `rotulo`,
`destaque_no_site`) muda na hora: não alcança ninguém que já é cliente.
**Contrato** (`nome`, `valor_mensal`, `compromisso_meses`, `frequencia_dia`,
`cobertura`, `limite_criativos`, `preco_travado`, `fundador`,
`ponto_apos_meses`, benefícios) não se edita: publica-se uma **versão nova**,
com id novo, e a anterior é aposentada. Quem já assinou fica na versão
antiga — mesmo preço, mesma frequência, mesmos benefícios, mesmo limite de
criativos. Id novo é obrigatório porque o San Checkout guarda a assinatura
pela chave `planoId` + `documento` (`API.md` 4.2): duas versões com o mesmo
id tornariam cancelamento e conciliação ambíguos. O Checkout já congela
`valor` e `ciclo` na criação e nunca reconsulta o plano — o que faltava era o
que o Mostraí lê ao vivo. *Violada:* `PATCH` com campo de contrato responde
409 dizendo qual campo e qual é o caminho; o banco recusa plano aposentado e
ativo ao mesmo tempo. *Quem vê:* o administrador, na aba Planos (o botão
"Publicar nova versão" só acende quando um campo de contrato muda) e na aba
Planos arquivados, que mostra quantas contas ativas cada versão ainda tem.

**RN-28 — Tela fora do ar não recebe playlist nem conta exibição.** Chave de
aparelho certa não basta: se a tela está em `reparo`/`inativo`, ou se o ponto
dela saiu do ar, `GET /playlist/:id` responde 403 e o player para de tocar o
cache e escreve o motivo na própria TV. Sem isso o anunciante pagava por
exibição numa tela que a operação já sabia que não estava no ar. *Violada:*
não há caminho — a guarda é o próprio `exigirAparelho`. *Quem vê:* o operador,
na TV; o anunciante, no painel, porque a exibição simplesmente não é contada.

**RN-29 — Reprovar criativo exige motivo, e o motivo chega ao anunciante.**
O admin não reprova sem escrever por quê; o motivo aparece no card da peça no
painel do anunciante, junto do que fazer (excluir e subir a versão corrigida),
e sai por e-mail. *Violada:* a tela não deixa reprovar com o campo vazio.
*Quem vê:* anunciante e administrador.

**RN-30 — O teto de 200 slots por hora corta proporcionalmente.** Quando a
soma das frequências contratadas passa do teto da hora, cada anunciante perde
a mesma fração do que pediu (regra dos maiores restos, sobre a lista já
embaralhada) — em vez de o corte ser um sorteio que zerava a hora de quem
ficasse pra depois do item 200. O aperto vira evento `playlist:teto_corta`.
*Violada:* não há caminho. *Quem vê:* o dono, na aba Métrica.

**RN-31 — Conta excluída não recebe ciclo.** A exclusão cancela a assinatura no
Checkout antes de marcar `excluido_em`; uma cobrança em trânsito que chegue
depois não credita cobertura nem paga comissão — vira pendência para alguém
devolver o dinheiro à mão. *Violada:* o webhook registra a pendência com o
motivo. *Quem vê:* administrador, em Eventos pendentes.

**RN-17 — Migrations são aditivas.** Drop de coluna ou tabela só com permissão
nominal do dono, em migration própria. Migration aplicada nunca é editada.
*Violada:* não há caminho automático. *Quem vê:* administrador.

---

## 6. Textos que o sistema diz

| Onde | Texto |
|---|---|
| Botão de assinar | **Assinar plano** |
| Cadastro concluído | Conta criada. Avisaremos por e-mail quando ela for aprovada. |
| Conta pendente | Sua conta está em análise. Assim que for aprovada você já pode assinar um plano. |
| Senha fraca | A senha precisa de 8 caracteres, uma maiúscula e um símbolo. |
| E-mail já cadastrado | Já existe uma conta com esse e-mail. Tente entrar ou recuperar a senha. |
| Convite usado | Este convite não vale mais. Fale com a gente para receber outro. |
| Fundador sem vaga | As vagas desse plano acabaram. |
| Troca de plano | Para trocar de plano, fale com a gente — evitamos cobrança duplicada. |
| Player sem chave | Tela não autorizada — fale com o Mostraí. |
| PIN errado | PIN incorreto. |
| Playlist vazia | *(tela institucional do Mostraí, sem texto de erro)* |
| Muitas tentativas | Muitas tentativas. Tente de novo em alguns minutos. |
| Erro genérico | Não conseguimos completar agora. Tente de novo em instantes. |
| E-mail de pagamento | Assunto: **Pagamento confirmado — Mostraí**. Corpo: o plano, o valor e até quando a cobertura vale. |
| E-mail de anúncio no ar | Assunto: **Seu anúncio está no ar — Mostraí**. Corpo: o vídeo foi aprovado e entrou na playlist, com o link do painel para acompanhar as exibições. |
| Extrato vazio | Nenhum pagamento lançado ainda. Assim que o primeiro mês for fechado, ele aparece aqui. |
| Exclusão de conta | Sua conta foi excluída. Você tem 60 dias para pedir a volta pelo nosso contato. |

---

## 7. Quando dá errado

| Situação | O que o sistema faz | O que a pessoa vê |
|---|---|---|
| San Checkout fora do ar ao assinar | não cria assinatura local órfã; devolve erro | "não conseguimos abrir o pagamento agora" |
| Webhook não chega | a conciliação diária encontra a cobrança e credita | nada — a conta ativa sozinha em até 24h |
| Webhook chega duas vezes | dedupe por `chargeId|status`; o segundo não faz nada | nada |
| Webhook sem `chargeId` consultável | vira pendência, **não credita no escuro** | administrador vê na fila |
| Rede cai no meio do upload | o criativo não é criado; nada meio-gravado | "o envio falhou, tente de novo" |
| ffmpeg falha ao normalizar | o criativo fica pendente, sem entrar na playlist | "estamos processando seu vídeo" |
| Duplo clique em assinar | a segunda chamada encontra assinatura aberta e devolve o mesmo link | mesma tela de pagamento |
| Volta no navegador depois de pagar | a página de status consulta o Checkout | o estado real |
| TV sem internet | toca o cache e tenta a cada ciclo | o vídeo continua rodando |
| Chave de aparelho revogada | 401 na playlist | "tela não autorizada" |
| Migration falha no deploy | aborta o deploy; o container antigo continua | nada — o site não cai |
| Storage fora do ar | o vídeo não carrega; a playlist continua | tela institucional |

---

## 8. Direitos e obrigações que viram tela

Todos ficam no mesmo lugar: o bloco "Seus dados e seus direitos", dentro do
popup de perfil do painel — junto de "excluir conta", e não escondido numa
página de política que ninguém abre.

- **Exportar dados da conta** — `GET /titular/meus-dados`, baixa um JSON com
  tudo (RN-24).
- **Excluir conta** — existe, no popup de perfil do painel (RN-15).
- **Revogar consentimento** — `POST /titular/consentimento`: desliga as
  comunicações de divulgação, ou apaga os dados opcionais (RN-25).
- **Canal do titular** — `/contato.html`, que grava a mensagem e avisa por e-mail.
- **Confirmação da contratação** — e-mail de pagamento confirmado (seção 6).
- **Direito de arrependimento (7 dias)** — `POST /titular/arrependimento`
  (RN-26): cancela a cobrança, tira o anúncio do ar e abre a devolução na fila
  do admin.
- **Termos de uso e Política de privacidade** — as páginas existem; o conteúdo
  é revisado na Estação 7 (skill `legal`).

---

## 9. A métrica de sucesso e os eventos que a alimentam

**Métrica principal:** margem mensal real — receita confirmada menos ajuda de
custo aos pontos, menos amortização das telas, menos custos fixos. Definida na
Estação 1. É precursora de receita porque uma rede que cresce com margem
negativa quebra crescendo.

Convenção: `categoria:objeto_acao`, verbo no presente; propriedades
`objeto_adjetivo`.

| Evento | Onde é emitido | Propriedades | Pergunta que responde |
|---|---|---|---|
| `conta:cadastro_conclui` | **servidor** | `papel_inicial`, `veio_de_cupom` | quantos se cadastraram ontem? |
| `conta:aprovacao_recebe` | servidor | `papel_liberado`, `horas_ate_aprovar` | quanto tempo a fila de aprovação leva? |
| `plano:assinatura_inicia` | servidor | `plano_id`, `plano_ciclo`, `valor_cobrado` | quantos chegam ao checkout? |
| `pagamento:cobranca_confirma` | **servidor (webhook)** | `plano_id`, `valor_confirmado`, `ciclo_numero` | quantos pagaram ontem? — é a receita |
| `criativo:video_aprova` | servidor | `horas_ate_aprovar` | o vídeo entra no ar rápido? (é o mesmo gatilho do e-mail da RN-18) |
| `exibicao:video_toca` | **não vai para `eventos`** — ver abaixo | — | a entrega prometida aconteceu? |
| `tela:dispositivo_ativa` | servidor | `ponto_id`, `custo_aparelho` | a rede cresceu quanto? |
| `ponto:candidatura_aprova` | servidor | `bairro`, `ramo` | de onde vêm os pontos? |
| `comissao:vendedor_gera` | servidor | `vendedor_id`, `comissao_valor` | quanto a indicação custa? |
| `ponto:pagamento_quita` | servidor | `ponto_id`, `valor`, `competencia` | quanto a rede custou em ajuda de custo? |
| `conta:exclusao_pede` | servidor | `dias_de_vida`, `tinha_plano_ativo` | quem sai, e quando? |

Os três críticos — cadastro, exibição e pagamento confirmado — são **de
servidor**, nunca do navegador.

**Construído em 14/09/2026** (migration 027): tabela
`eventos(id, nome, anunciante_id, propriedades, interno, criado_em)`,
`src/lib/eventos.js` para emitir, `src/admin/metrica.js` com as três consultas
salvas e a aba **Métrica** no admin. Três decisões que a tabela acima não
dizia, e que precisam de motivo escrito:

1. **`usuario_id` virou `anunciante_id`.** É essa a tabela de gente do sistema
   — anunciante, dono de ponto e vendedor são papéis da mesma conta.
2. **`exibicao:video_toca` não vira linha em `eventos`.** `exibicoes_contador`
   já guarda isso agregado por hora, por tela e por anunciante, com
   programadas **e** confirmadas — estritamente mais do que a linha de evento
   carregaria. Uma linha por exibição seria a maior tabela do sistema,
   crescendo para sempre, para responder a mesma pergunta pior. Fica registrado
   como decisão, não como esquecimento.
3. **`conta:cadastro_conclui` também sai do cadastro feito pelo admin.** O
   negócio fecha por WhatsApp e o dono cadastra o cliente depois; deixar de
   fora furaria o funil justamente no caminho que mais vende. A propriedade
   `pelo_operador` separa os dois.

**Filtro de uso interno:** a coluna `interno` é decidida na hora do evento, não
depois — a conta própria do Mostraí (`conta_propria`) e as contas listadas em
`EVENTOS_CONTAS_INTERNAS`. Todas as três consultas filtram `NOT interno`.
Marcar depois seria tarde: o número já teria sido lido.

**As três consultas** (`GET /admin/metrica`): a margem mês a mês, que é a
métrica principal; o funil cadastro → aprovação → checkout aberto → pagamento,
onde a distância entre os dois últimos é a única perda que o banco sozinho não
mostra (assinatura abandonada não vira linha em lugar nenhum); e o tempo das
filas do dono, em mediana e pior caso — mediana porque uma conta esquecida por
duas semanas puxaria a média e esconderia que o resto sai no mesmo dia.

---

## 10. O que fica fora desta versão

Os vetos estão em `CONSTRAINTS.md`; o que fica para depois, com condição de
entrada, está em `docs/proximas-versoes.md`. Nada é repetido aqui.
