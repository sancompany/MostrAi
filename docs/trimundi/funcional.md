# Trimundi — definição funcional (fundação)

O que o sistema faz, com detalhe suficiente para construir sem inventar
comportamento. Estação 4. É o único documento de definição que muda durante
o projeto: mudou o comportamento, muda aqui na mesma tarefa. Rotas em
`api.md`; tabelas em `modelo-de-dados.md`.

## 1. Público-alvo

- **Administrador.** O dono (ou a equipe dele) no Admin da Mostraí, atrás
  do Cloudflare Access. Quer montar evento, ingressos e combos, emitir
  cortesias e preparar a portaria sem planilha paralela. Usa no computador
  e conhece o Admin.
- **Operador de check-in.** Gente da portaria. Recebe do administrador um
  código de ativação e quer entrar rápido pelo celular e chegar à tela de
  check-in. Não conhece o sistema e não lê instrução.
- **Comprador e Participante.** Nesta versão existem só como dado (pedido de
  teste e cortesia), sem tela. A tela deles chega com a página pública
  (`proximas-versoes.md`).

## 2. Jornadas

### Administrador (principal)

1. Entra no Admin (Access + login do Admin) e clica em **Eventos** → T1.
2. Em T1, **+ Criar evento** → T1a. Escolhe o banner e o logo (com
   pré-visualização), "Evento novo" (nome) ou "Nova edição de um evento já
   cadastrado", preenche a edição e clica em **Criar evento**: a ficha é
   gravada, as imagens são enviadas e o endereço público sai do nome. A
   edição nasce em **Rascunho**.
3. Em T1a, se quiser, envia as imagens da galeria.
4. Em T2, cria os tipos de ingresso com seus lotes.
5. Em T3, se quiser, cria combos.
6. Em T1a, **Publicar**: a edição fica pronta para a venda, que chega com a
   página pública.
7. Em T4, emite cortesias, acompanha os ingressos emitidos e abre o QR de um
   ingresso.
8. Em T5, adiciona operadores e passa a cada um o código de ativação e o
   endereço `/ticket/ativar`.
9. No fim, **Pausar** ou **Encerrar** a edição em T1a.

### Administrador (secundárias)

- Editar uma edição já publicada (texto de termos novo vira versão nova, RN-T05).
- Encerrar um lote à mão (T2).
- Inativar um tipo de ingresso ou um combo (T2, T3).
- Cancelar uma cortesia (T4).
- Gerar novo código, desativar, reativar ou mudar as edições de um operador (T5).

### Operador

1. Recebe do administrador o e-mail que foi cadastrado, o código e o
   endereço `/ticket/ativar`.
2. Em T6, informa e-mail, código e a senha nova duas vezes → "Acesso
   ativado".
3. **Entrar** leva a T7, o login da Mostraí.
4. Com e-mail e senha, o servidor reconhece o operador e manda para T8.
5. Em T8, vê o próprio nome e as edições em que trabalha. **Sair** encerra
   a sessão e volta para T7.

### Fluxo técnico (sem tela)

Pedido de teste: a equipe técnica roda o script fora de produção, que cria
o pedido e simula a confirmação (RN-T19). O resultado aparece em T4 marcado
"Teste".

## 3. Telas

| # | Nome | URL | Quem | Mostra | Dá para | Leva para |
|---|---|---|---|---|---|---|
| T1 | Criar evento | `/admin/#trimundi/eventos` | Administrador | edições (evento — edição, data, local, status, endereço público) | + Criar evento; Abrir | T1a |
| T1a | Ficha da edição | `/admin/#trimundi/eventos/nova` · `/admin/#trimundi/eventos/<id>` | Administrador | evento + edição, imagens, versões vigentes dos termos | Salvar; Publicar, Pausar, Retomar venda, Encerrar; enviar e remover imagens | T1 |
| T2 | Criar ingressos | `/admin/#trimundi/ingressos/<edição>` | Administrador | seletor de edição; tipos de ingresso com lotes e números | + Criar ingresso; Editar; Encerrar lote | modal Ingresso |
| T3 | Criar promoção | `/admin/#trimundi/promocoes/<edição>` | Administrador | seletor de edição; combos com números | + Criar promoção; Editar | modal Promoção |
| T4 | Participantes | `/admin/#trimundi/participantes/<edição>` | Administrador | seletor de edição; ingressos emitidos | buscar; filtrar; Ver QR; + Emitir cortesia; Cancelar cortesia | modais Cortesia, QR, Cancelar |
| T5 | Adicionar operador | `/admin/#trimundi/operadores` | Administrador | operadores | + Adicionar operador; Editar; Gerar novo código; Desativar; Reativar | modais Operador, Código |
| T6 | Ativar acesso | `/ticket/ativar` | Operador, sem sessão | formulário | Ativar acesso | T7 |
| T7 | Entrar (existente) | `/anunciante/login.html` | Operador | a tela de login da Mostraí, sem mudança visual | Entrar | T8 |
| T8 | Check-in | `/ticket/checkin` | Operador com sessão | nome, edição, contador de entradas, câmera e campo de código, resultado da leitura | Ler QR Code; Consultar; Confirmar entrada; Sair | T7 |
| T9 | Edição (pública) | `/ticket/{evento}/{edição}` | Comprador | vitrine e compra | escolher; Continuar; Ir para o pagamento | Checkout → T10 |
| T10 | Pedido | `/ticket/pedido/{id}?t=…` | Quem tem o link | pagamento e ingressos com QR | Pagar agora; Imprimir; Baixar QR | Checkout |
| T11 | Recuperar ingressos | `/ticket/recuperar` | Comprador | formulário | Enviar o link | — |
| T12 | Pagamento simulado | `/ticket/dev/pagamento/{id}` | Só desenvolvimento | resumo do pedido | Aprovar; Recusar | T10 |

**Navegação:**
- No menu do Admin há um item só, **Eventos**, que abre o módulo
  `trimundi` com as cinco abas na ordem de T1 a T5.
- T2, T3 e T4 têm o mesmo seletor de edição ("Evento — Edição"). Ele lista
  as não encerradas primeiro e, sem edição no endereço, abre a mais recente
  não encerrada.
- Trocar de edição troca o endereço.

## 4. Estados de cada tela

| Tela | Vazio | Carregando | Erro | Sucesso | Sem permissão | Lista longa |
|---|---|---|---|---|---|---|
| T1 | "Nenhum evento ainda." + **+ Criar evento** | "Carregando..." (padrão do Admin) | erro de carga do Admin com **Tentar novamente** | lista | login do Admin, ou "Entrar de novo" do Access | encerradas recolhidas em **Mostrar encerradas (n)** |
| T1a | não se aplica: formulário em branco é edição nova | "Carregando..." | carga: padrão do Admin. Ao salvar: mensagem no campo e o formulário segue preenchido | aviso do que foi feito (§6) e continua na ficha | igual a T1 | galeria limitada a 8: não se aplica |
| T2 | sem edição: "Crie um evento primeiro." + **Criar evento**. Sem ingresso: "Nenhum ingresso nesta edição ainda." + **+ Criar ingresso** | padrão | padrão | um card por tipo, com tabela de lotes | igual a T1 | não se aplica: até 30 tipos com 10 lotes cabem na tela |
| T3 | sem edição: igual a T2. Sem combo: "Nenhuma promoção nesta edição ainda." + **+ Criar promoção**. Sem ingresso: botão desligado com "Crie um ingresso antes da promoção." | padrão | padrão | tabela de combos | igual a T1 | não se aplica |
| T4 | "Nenhum ingresso emitido nesta edição ainda." Sem ingresso criado: **+ Emitir cortesia** desligado com "Crie um ingresso antes da cortesia." Busca vazia: "Nada encontrado para “{busca}”." | padrão | padrão | tabela | igual a T1 | 50 por página, **Anterior** / **Próxima** e "{n} ingressos" |
| T5 | "Nenhum operador ainda." + **+ Adicionar operador** | padrão | padrão | tabela | igual a T1 | não se aplica (dezenas) |
| T6 | formulário | botão "Ativando..." travado | mensagem no formulário | "Acesso ativado..." + **Entrar** | não se aplica: é pública | não se aplica |
| T7 | sem mudança | sem mudança | sem mudança | operador vai para T8; conta da Mostraí, como hoje | não se aplica | não se aplica |
| T8 | não se aplica | "Carregando..." | "Não foi possível carregar agora." + **Tentar novamente** | nome e edições | sem sessão de operador, o servidor manda para T7 | não se aplica |

Mais dois estados em todas as telas do Admin:
- **Módulo desligado** (sem o banco da Trimundi configurado): "A Trimundi
  não está configurada neste ambiente."
- **Edição encerrada:** T1a, T2, T3 e T4 ficam só leitura, sem botões de
  criar, editar ou emitir.

## 5. Regras de negócio

Formato: regra → o que acontece quando é violada → quem vê. Os erros
seguem o padrão da Mostraí, `{ erro: '<texto>' }`, e o texto exato está em
§6.

- **RN-T01 Endereço público.**
  - O endereço do evento tem 3 a 60 caracteres `A–Z a–z 0–9 -`, começa por
    letra ou número e é único sem diferenciar maiúscula de minúscula.
  - O da edição tem 1 a 40 caracteres e é único dentro do evento.
  - Palavras reservadas para o evento: `ativar`, `checkin`, `api`, `admin`,
    `operador`, `pedido`, `webhook`, `entrar`, `sair`.
  - O endereço público é `/ticket/<evento>/<edição>`, sem diferenciar
    maiúscula.
  - Violação: 400 ou 409 com a mensagem no campo. Quem vê: o administrador.
  - **Gerado do nome** (10/11/2026) quando o administrador não escreve um
    nas configurações avançadas: sem acento, minúsculo, o que não é letra
    ou número vira hífen ("Festa de Verão" → `festa-de-verao`). Curto ou
    reservado ganha `-evento`. Se já existir, ganha número no fim (`-2`,
    `-3`...); duas criações ao mesmo tempo não escolhem o mesmo (trava por
    endereço-base). Escrito à mão, não ganha número: repetido → 409.
  - Editar a ficha nunca muda o endereço de quem já existe; campo vazio =
    fica o que está.
- **RN-T02 Endereço travado depois de publicado** (P-03). O da edição não
  muda depois da primeira publicação; o do evento, depois da primeira edição
  publicada. → 409. Quem vê: o administrador.
- **RN-T03 Status.**
  - Transições: Rascunho → Publicado; Publicado ⇄ Pausado; Rascunho,
    Publicado ou Pausado → Encerrado. Encerrado é final e só leitura.
  - Publicar exige: nome do evento e da edição, os dois endereços,
    classificação etária, regulamento e termos de compra.
  - Transição fora da lista → 409. Faltando campo → 422 com a lista do que
    falta. Quem vê: o administrador.
- **RN-T04 "A definir".**
  - Data e local podem ficar "A definir" em qualquer status (a caixa marcada
    grava nulo).
  - Com data, o término (opcional) vem depois do início → senão, 400 no
    campo.
- **RN-T05 Termos versionados.**
  - Regulamento e termos de compra são textos de até 50.000 caracteres.
  - Salvar um texto diferente do vigente cria versão nova (número seguinte e
    hash SHA-256) e a marca como vigente. Versão gravada nunca muda nem é
    apagada (o banco recusa).
  - Na ficha aparece "Versão {n}, de {data}". Quem vê: o administrador.
- **RN-T06 Imagens.**
  - Um banner, um logo (migration 008) e até 8 de galeria. JPEG, PNG ou
    WebP, conferidos pelo conteúdo (não pela extensão), até 8 MB.
  - Fora disso → 400. Banner ou logo novo substitui o anterior (e o arquivo
    antigo sai do armazenamento).
  - Banner: vitrine da TICK e topo da página de venda. Logo: ao lado do
    nome na página de venda e sobre o banner no card da vitrine.
  - Na ficha, banner e logo ficam pendentes (pré-visualização) até o
    **Salvar**; a galeria envia e remove na hora.
  - Sem o armazenamento configurado → 503 "imagens não configuradas neste
    ambiente".
- **RN-T07 Capacidade** (opcional, 1 a 1.000.000).
  - Com capacidade preenchida, nenhuma emissão nem reserva passa dela
    (pago, combo ou cortesia) → 409 "esgotado". Quem vê: o administrador ao
    emitir cortesia; o comprador, na fase do checkout.
  - Reduzir abaixo da ocupação → 409 com o número.
- **RN-T08 Tipo de ingresso.**
  - Nome de 1 a 60, único na edição; descrição até 500; limite por
    comprador opcional, de 1 a 20; benefícios do catálogo da edição;
    ativo ou inativo.
  - Inativo não vende; o já emitido continua válido.
- **RN-T09 Lotes.**
  - De 1 a 10 por tipo, numerados na ordem (1º lote, 2º lote…).
  - Preço de R$ 5,00 a R$ 50.000,00 (P-02); quantidade de 1 a 100.000;
    início e fim de venda opcionais, com fim depois do início.
  - Não dá para baixar a quantidade abaixo do vendido + reservado, nem
    apagar lote com venda → 409.
  - Preço novo vale para pedido novo; pedido existente guarda o preço dele
    (RN-T17).
- **RN-T10 Lote vigente.**
  - É o primeiro, na ordem, que não está encerrado e cujo início de venda
    já chegou (ou não tem início).
  - O lote se encerra sozinho quando esgota (vendidos = disponível) ou
    quando passa do fim de venda. O administrador também pode encerrar.
  - Encerrado não reabre. O seguinte assume na hora; se o início dele for
    mais tarde, há intervalo sem venda até lá.
  - Situação mostrada em T2:
    - **Agendado** (início no futuro);
    - **À venda** (o vigente);
    - **Aguardando o lote anterior**;
    - **Esgotado**;
    - **Encerrado** (por data ou à mão).
- **RN-T11 Cota que sobra.** O que não foi vendido do lote encerrado (por
  data, à mão ou por esgotar — inclusive a vaga de reserva que venceu sem
  pagamento) passa para o lote seguinte, no preço dele
  (`modelo-de-dados.md`, "Disponibilidade"). No **último** lote, que não
  tem seguinte, a vaga de reserva vencida volta para ele mesmo (só se ele
  fechou por esgotar). Quem vê: T2 mostra o disponível já somado.
- **RN-T12 Disponibilidade é do servidor.**
  - A reserva acontece numa transação que trava a edição (P-06).
  - Pedido que passaria da quantidade do lote, da quantidade do combo ou da
    capacidade → 409 "esgotado", nada é gravado.
  - O navegador nunca decide.
- **RN-T13 Reserva e prazo** (revisto em 09/11/2026, estoque estrito).
  - A reserva dura 30 min desde a criação do pedido, e o mesmo prazo vai
    como `expiraEm` ao Checkout, que recusa cobrar depois dele.
  - Confirmação que chega depois da reserva vencer emite se ainda couber no
    tipo de ingresso e na capacidade. Se não couber, o pedido fica **pago
    sem vaga** e vira aviso de devolução em T4.
  - Pagamento recusado (cartão negado, antifraude) não encerra o pedido: a
    reserva segue até vencer e o comprador pode tentar outro meio.
  - Pedido não pago no prazo fica **expirado**.
- **RN-T14 Limite por comprador.**
  - Conta os ingressos daquele tipo (pagos + reservados) do mesmo CPF de
    comprador na edição. Ingresso de combo e cortesia não contam (D-07).
  - Passar do limite → 409 "limite por comprador".
- **RN-T15 Benefícios.**
  - Catálogo por edição: nome de 1 a 60, descrição até 300, criado ali
    mesmo pelo **+ Novo benefício** (nos modais de ingresso, promoção e
    cortesia).
  - Na emissão, o ingresso guarda uma cópia dos benefícios; mudar o
    catálogo depois não muda o ingresso já emitido.
- **RN-T16 Combo (promoção).**
  - Campos:
    - nome de 1 a 60 e descrição até 500;
    - itens (tipo de ingresso × quantidade), com 2 a 20 ingressos no total;
    - benefício promocional por item, opcional;
    - preço total de R$ 5,00 a R$ 50.000,00;
    - quantidade de combos de 1 a 10.000;
    - validade opcional (de/até) e ativo ou inativo.
  - **Regra do dono (09/11/2026):** consome o estoque real dos tipos que o
    compõem (os lotes deles) e a capacidade da edição; nunca passa de
    nenhum dos dois. Não conta no limite por comprador (D-07).
  - Gera um ingresso por posição, cada um com participante, código, QR,
    check-in e benefícios próprios: os do tipo mais o promocional da
    posição, sem repetir o mesmo benefício (P-04).
  - O valor do combo se divide entre os ingressos em centavos (o resto vai
    no primeiro) e a soma bate com o preço do combo.
- **RN-T17 Pedido.**
  - Id imprevisível (UUID). Itens com o preço congelado na criação.
  - O total é a soma dos itens, em centavos, conferida na criação.
  - Chave de idempotência: o mesmo pedido mandado duas vezes não cria dois.
  - Participante (nome, CPF e e-mail) obrigatório para cada ingresso.
  - Origem: venda ou teste.
- **RN-T18 Confirmação de pagamento.**
  - Só por evento conferido: webhook assinado (HMAC, janela de 300 s,
    fechado na falha), a resposta do estorno ou a conciliação com o
    Checkout. Em desenvolvimento, o pagamento simulado gera o mesmo aviso
    assinado, marcado `simulado`.
  - Deduplica pelo `eventoId` e aplica uma vez.
  - O valor confirmado tem de bater com o total do pedido; divergente não
    emite e fica registrado com o motivo.
  - Emite os ingressos na mesma transação que passa o pedido a pago; o
    reenvio não emite de novo.
- **RN-T19 Pedido de teste.**
  - Criado pelo Admin em T4 (**Pedido de teste**), pelo mesmo caminho do
    comprador (estoque, reserva, pagamento, emissão); vale também em
    edição em rascunho.
  - Só fora de produção: a rota recusa com `NODE_ENV=production` (liberar
    em produção é decisão do dono, `pendencias.md`).
  - Aparece em T4 como "Teste" e nunca entra em receita nem métrica.
- **RN-T20 Cortesia.**
  - Campos: nome de 2 a 120, CPF válido, e-mail válido, um tipo de
    ingresso da edição, benefício opcional e classificação (convidado,
    equipe, patrocinador ou promocional).
  - Valor zero, fora de qualquer receita.
  - Conta na capacidade, não no lote, nem no limite por comprador.
  - Não em edição encerrada → 409.
  - Leva chave de idempotência: duplo clique não emite duas.
- **RN-T21 Cancelar cortesia** (P-05).
  - Pede motivo de 1 a 200. O QR deixa de valer e a vaga volta para a
    capacidade.
  - Ingresso pago não se cancela por aqui (estorno é da fase do checkout)
    → 409.
- **RN-T22 Participantes.**
  - Ingressos emitidos da edição (pagos confirmados, cortesias e testes),
    mais recentes primeiro, 50 por página.
  - Busca por nome, CPF, e-mail ou código do pedido. Filtros: **Todos**,
    **Pagos**, **Cortesias**, **Testes**, **Cancelados**. "Todos" não mostra
    os cancelados.
  - Colunas:
    - Participante, CPF (formatado) e E-mail;
    - Ingresso (tipo, e "combo {nome}" quando veio de combo);
    - Pedido (8 primeiros caracteres, ou "Cortesia");
    - Pagamento: Confirmado, Cortesia (gratuita) ou Teste;
    - Benefício;
    - Situação: Válido ou Cancelado.
- **RN-T23 Código e QR.**
  - Código aleatório de 128 bits, único.
  - O QR é `TM1.<código da edição>.<código do ingresso>.<assinatura>`, com
    assinatura Ed25519 por edição. Sem CPF, nome nem e-mail.
  - Aparece para o comprador na página do pedido (depois de pago) e no
    Admin (**Ver QR**, com **Baixar QR (PNG)**). Ingresso cancelado não
    tem QR.
- **RN-T24 Operador.**
  - Nome de 2 a 120; e-mail válido e único entre operadores.
  - E-mail que já é conta da Mostraí → 409 (D-05).
  - Permissão só de check-in, em todas as edições ou nas escolhidas.
  - Se depois alguém criar conta na Mostraí com o e-mail do operador, a
    lista marca "Acesso bloqueado pela conta da Mostraí".
- **RN-T25 Código de ativação.**
  - 8 caracteres (`XXXX-XXXX`), mostrado uma vez no Admin.
  - Vale 72 h, uso único; 5 erros o invalidam.
  - Gerar outro invalida o anterior. Gerar para operador ativo derruba a
    senha e as sessões dele (volta a "Aguardando ativação").
- **RN-T26 Ativação.**
  - E-mail + código + senha nova duas vezes. A regra da senha é a da
    Mostraí: 8 ou mais, com maiúscula, minúscula, número e símbolo.
  - Limite de 10 tentativas por 15 min por IP e por e-mail.
  - Código vencido → 410. Erros → 400. Excesso → 429.
- **RN-T27 Login do operador.**
  - Na tela da Mostraí. Se o e-mail não é de nenhuma conta da Mostraí e é
    de um operador ativo com a senha certa, abre a sessão de operador e o
    servidor manda para `/ticket/checkin`.
  - Operador desativado com a senha certa → 403.
  - Qualquer outro caso → a mesma resposta que a Mostraí dá hoje.
  - Conta da Mostraí: comportamento atual, sem mudança.
- **RN-T28 Sessão de operador.**
  - Só abre `/ticket/*`; nenhuma rota de conta da Mostraí nem do Admin a
    aceita.
  - Desativar o operador ou gerar código novo derruba a sessão na próxima
    requisição: 401, e a página volta a T7.
- **RN-T29 Histórico.**
  - Registram autor (usuário do Admin + e-mail do Access), quando, ação e
    entidade, sem dado pessoal no registro:
    - criação, alteração e mudança de status de edição;
    - versão nova de termos;
    - tipo de ingresso, lote, combo e benefício;
    - emissão e cancelamento de cortesia;
    - operador criado, editado, desativado ou reativado, e código gerado.
  - Gravado na mesma transação da ação.
- **RN-T30 LGPD.**
  - CPF nunca vai para log; e-mail só mascarado (`ad***@…`).
  - Anonimização nos prazos de D2 (`inventario-de-dados.md`).
- **RN-T32 Indicação de compradores e operadores** (10/11/2026).
  - Link permanente: todo comprador (na conta) e todo operador ativo (na
    tela de check-in, só nas edições autorizadas) têm um código fixo; o link
    é a página de venda de cada edição com `?ind=CÓDIGO`, sem dado pessoal.
  - Registro da indicação (`indicacao_origens`): a primeira indicação válida
    de uma conta numa edição fica. Outro link depois — outra aba, outro
    aparelho, pedido novo — não troca a origem. Antes do login, o código fica
    guardado no navegador (30 dias); ao entrar, o servidor registra.
  - Atribuição: um indicador por pedido (`pedidos.indicador_id`), fixo.
    Autorreferência (mesma conta ou mesmo CPF), operador desativado ou sem
    acesso à edição, conta apagada: a compra segue sem indicador.
  - Conversão confirmada: pedido pago com ingresso de pé. Pendente,
    expirado, cancelado, reembolsado ou contestado não conta; reembolso de
    um ingresso tira só aquele ingresso.
  - Pessoa indicada = conta compradora; ingressos vendidos por indicação =
    os ingressos de pé desses pedidos (4 ingressos = 1 pessoa, 4 ingressos).
  - Promoção (campanha) e benefício (recompensa) ficam separados da
    conversão: nada é concedido sem campanha ativa.
  - CPF mascarado em toda lista e ficha; o inteiro só pelo botão do Admin,
    auditado. Ranking e CSV: nome, categoria e números.
- **RN-T33 Check-in sem internet** (10/11/2026).
  - O operador baixa o pacote da edição com internet ("Baixar para usar sem
    internet"; com internet, ele se atualiza sozinho a cada 5 min). O pacote
    tem, por ingresso, o hash do código, a situação, se já entrou, o tipo e o
    primeiro nome — e a chave pública da edição. Sai do aparelho ao sair da
    conta.
  - Sem internet, o aparelho confere o QR (formato, edição, assinatura
    Ed25519 quando o navegador suporta, hash no pacote), a situação e o uso
    (no pacote ou neste aparelho). Código fora do pacote: "Não está nos dados
    baixados" — não liberar. Benefícios só com internet.
  - Cada entrada liberada fica no aparelho com id próprio e sobe quando a
    conexão volta (sozinha, ou "Sincronizar agora"). Sair da conta com
    entrada não enviada é bloqueado.
  - O servidor confere de novo; a entrada aceita segue única. A que chega
    depois de outra (outro aparelho, ou online) ou de ingresso cancelado ou
    bloqueado depois do pacote fica recusada e aparece em Participantes →
    "Conflitos do check-in sem internet".
  - Limite: dois aparelhos sem internet não se falam — os dois podem deixar
    a mesma pessoa entrar. Isso é detectado, não impedido.
  - Instalável como app (PWA): manifest e service worker próprios do
    check-in; a casca da página abre sem internet.
- **RN-T34 Aceite dos Termos com histórico** (10/11/2026).
  - Textos oficiais v1.2 em `docs/trimundi/legal/` (exatamente como o dono
    entregou); as páginas `/ticket/termos` e `/ticket/privacidade` dizem o
    mesmo texto, conferido por teste palavra por palavra.
  - O aceite só vale para a versão que a página apresentou: a página manda
    `versao_termos`; se não for a vigente (`src/trimundi/legal.js`), o
    servidor recusa (409) e a pessoa recarrega e lê a atual. Ninguém é dado
    como tendo aceitado uma versão que não viu.
  - Cada aceite é uma linha em `aceites_conta` (versão, hash dos dois
    documentos apresentados, maioridade, IP, navegador, data e hora, origem
    `cadastro` ou `reaceite`), que não muda nem se apaga (trigger de
    histórico). Os aceites que existiam antes entraram como `anterior`.
    As colunas da conta guardam só o aceite vigente, o que a compra confere.
  - Versão nova publicada: a conta fica com `aceite_pendente` e não compra
    até aceitar de novo; o aceite antigo continua no histórico.
- **RN-T35 Indique e acompanhe** (Minha conta, 10/11/2026).
  - Um link permanente por conta, `/tic/eventos?ind=CÓDIGO`, vale para
    qualquer evento (o código fica no navegador por 30 dias e segue até a
    página de venda); os links por edição continuam.
  - Acessos únicos: um navegador conta uma vez por link (id aleatório
    gerado no navegador, guardado só como hash em `indicacao_visitas`; sem
    IP, nome ou e-mail). A própria conta não conta. Limite de 60 acessos
    contados por hora por IP. É aproximado: outro navegador ou aparelho da
    mesma pessoa conta de novo; navegador com dados apagados também.
  - Contas criadas: navegador que chegou pelo link e depois entrou numa
    conta criada a partir dessa visita.
  - Compras: só as confirmadas (RN-T32). Nenhum dado de quem visitou ou
    comprou aparece para quem indicou.
- **RN-T31 Módulo desligado.** Sem `TRIMUNDI_DATABASE_URL`, as rotas da
  Trimundi respondem 503, as telas mostram o estado "não configurada" e o
  login da Mostraí não procura operador.

## 6. Textos que o sistema diz

### Menu e abas

- Menu: **Eventos**.
- Abas: **Criar evento** · **Criar ingressos** · **Criar promoção** ·
  **Participantes** · **Adicionar operador**.
- Seletor: rótulo "Edição"; cada opção, "{evento} — {edição}".

### T1 e T1a

- **Botões:**
  - **+ Criar evento**, **Abrir**, **Criar evento** / **Salvar alterações**,
    **Voltar** (barra presa no rodapé);
  - **Publicar**, **Pausar vendas**, **Retomar venda**, **Encerrar** (no
    cabeçalho da ficha);
  - banner e logo: **Escolher imagem**, **Substituir**, **Remover**,
    **Trocar**, **Cancelar**, **Desfazer** (ou arrastar o arquivo);
  - galeria: **Enviar imagem**, **Remover**.
- **Seções** (reorganização de 10/11/2026), em cartões numerados:
  1. **Identidade visual**: "Banner do evento" e "Logo do evento";
  2. **Informações principais**: **Evento novo** / **Nova edição de um
     evento já cadastrado**, "Nome do evento", "Código da edição",
     "Descrição", a linha "Página de venda" com o endereço que vai ser
     gerado, e **Configurações avançadas** (fechada) com "Endereço do
     evento" (prefixo `/ticket/`) e "Endereço da edição";
  3. **Data e classificação**: "Início" com **A definir**, "Término
     (opcional)", "Classificação etária" (Livre, 10, 12, 14, 16 ou 18 anos),
     "Capacidade do local", "Ingressos por CPF";
  4. **Localização**: **A definir**, "Nome do local", "CEP", "Endereço",
     "Número", "Complemento", "Bairro", "Cidade", "UF";
  5. **Regulamento e condições**: "Regulamento e condições de entrada",
     "Condições especiais (opcional)", "Termos e condições de compra", cada
     um com a versão vigente;
  6. **Galeria** (só depois de criada a edição).
- **Status:** Rascunho, Publicado, Pausado, Encerrado. Na lista, sem data
  aparece "A definir", e o endereço público como texto
  `/ticket/{evento}/{edição}`.
- **Avisos:** "Edição salva." · "Edição publicada." · "Venda pausada." ·
  "Venda retomada." · "Edição encerrada." · "Versão {n} dos termos de
  compra salva." · "Versão {n} do regulamento salva."
- **Confirmação de Encerrar:** "Encerrar {evento} — {edição}? Depois disso
  nada mais é vendido nem emitido, e a edição fica só para consulta."
- **Erros:**
  - "Preencha o nome do evento."
  - "Use de 3 a 60 letras, números ou hífen, começando por letra ou número."
  - "Esse endereço já é de outro evento."
  - "Essa edição já existe neste evento."
  - "Esse endereço é reservado — escolha outro."
  - "O endereço não muda depois de publicado."
  - "Para publicar, falta: {lista}."
  - "O término precisa ser depois do início."
  - "Envie uma imagem JPEG, PNG ou WebP de até 8 MB."
  - "A galeria aceita até 8 imagens."
  - "A capacidade não pode ficar abaixo do que já está ocupado ({n})."
  - "Não foi possível salvar a imagem agora — tente de novo."

### T2

- **Botões:** **+ Criar ingresso**, **Editar**, **+ Adicionar lote**,
  **Salvar ingresso**, **Encerrar lote**, **+ Novo benefício**.
- **Modal:** "Novo ingresso" / "Editar ingresso".
- **Campos:**
  - "Nome do ingresso", "Descrição", "Limite por comprador (opcional)",
    "Benefícios", "Ativo";
  - em cada lote: "Preço (R$)", "Quantidade", "Início das vendas",
    "Fim das vendas".
- **Colunas:** Lote · Preço · Quantidade · Vendidos · Reservados ·
  Disponíveis · Período · Situação.
- **Situações:** Agendado · À venda · Aguardando o lote anterior · Esgotado ·
  Encerrado.
- **Confirmação:** "Encerrar o {n}º lote? O próximo lote assume a venda na
  hora."
- **Avisos:** "Ingresso salvo." · "{n}º lote encerrado."
- **Erros:**
  - "O preço mínimo é R$ 5,00 (limite do meio de pagamento)."
  - "O preço máximo é R$ 50.000,00."
  - "A quantidade não pode ficar abaixo do que já foi vendido ou reservado
    ({n})."
  - "Cada ingresso tem de 1 a 10 lotes."
  - "Já existe um ingresso com esse nome nesta edição."
  - "O fim das vendas precisa ser depois do início."

### T3

- **Botões:** **+ Criar promoção**, **Editar**, **+ Incluir ingresso**,
  **Salvar promoção**.
- **Modal:** "Nova promoção" / "Editar promoção".
- **Campos:**
  - "Nome da promoção", "Descrição";
  - "Ingressos incluídos": por linha, "Ingresso", "Quantidade" e
    "Benefício promocional (opcional)";
  - "Preço total do combo (R$)", "Quantidade de combos";
  - "Válida de" e "até" (opcionais), "Ativa".
- **Colunas:** Promoção · Ingressos · Preço · Vendidos · Disponíveis ·
  Validade · Situação.
- **Situações:** Ativa · Inativa · Esgotada · Fora da validade.
- **Aviso:** "Promoção salva."
- **Erros:**
  - "Inclua de 2 a 20 ingressos no combo."
  - "O preço mínimo do combo é R$ 5,00."
  - "A quantidade não pode ficar abaixo dos combos já vendidos ou
    reservados ({n})."

### T4

- **Botões:** **+ Emitir cortesia**, **Ver QR**, **Baixar QR (PNG)**,
  **Cancelar cortesia**, **Anterior**, **Próxima**.
- **Busca e filtros:**
  - busca: "Buscar por nome, CPF, e-mail ou pedido";
  - filtros: Todos · Pagos · Cortesias · Testes · Cancelados.
- **Colunas:** Participante · CPF · E-mail · Ingresso · Pedido · Pagamento ·
  Benefício · Situação.
- **Modal "Emitir cortesia":**
  - campos "Nome do participante", "CPF", "E-mail", "Ingresso", "Benefício
    (opcional)" e "Classificação" (Convidado, Equipe, Patrocinador,
    Promocional);
  - botão **Emitir cortesia**;
  - aviso: "Cortesia emitida para {nome}."
- **Modal do QR:** "Ingresso {primeiros 8 do código}".
- **Cancelar:**
  - confirmação: "Cancelar a cortesia de {nome}? O QR deixa de valer."
  - campo: "Motivo";
  - aviso: "Cortesia cancelada."
- **Erros:**
  - "CPF inválido — confira os números." (o mesmo texto da Mostraí)
  - "Informe um e-mail válido."
  - "Não há mais vaga nesta edição."
  - "Só cortesia se cancela por aqui."

### T5

- **Botões:** **+ Adicionar operador**, **Adicionar e gerar código**,
  **Copiar**, **Editar**, **Gerar novo código**, **Desativar**,
  **Reativar**.
- **Campos:** "Nome", "E-mail" e "Edições": **Todas as edições** / **Só as
  escolhidas**, com caixas.
- **Modal do código:** "Código de ativação de {nome}: {XXXX-XXXX}. Vale 72
  horas e uma vez só. Envie também o endereço: {site}/ticket/ativar". O
  **Copiar** leva código e endereço.
- **Colunas:** Nome · E-mail · Edições · Situação · Último acesso.
- **Situações:** Aguardando ativação · Ativo · Desativado · Acesso bloqueado
  pela conta da Mostraí.
- **Confirmações:**
  - "Gerar um código novo para {nome}? O código anterior para de valer."
    (para operador ativo, mais: "e a senha atual também.")
  - "Desativar {nome}? O acesso para na hora."
- **Avisos:** "Operador adicionado." · "Operador salvo." · "Operador
  desativado." · "Operador reativado."
- **Erros:**
  - "Este e-mail já é de uma conta da Mostraí — use outro para o operador."
  - "Já existe um operador com este e-mail."

### T6

- **Título:** "Ativar acesso de operador".
- **Campos:** "E-mail", "Código de ativação", "Senha nova", "Repita a senha".
- **Botão:** **Ativar acesso** ("Ativando..." enquanto envia).
- **Sucesso:** "Acesso ativado. Agora entre com seu e-mail e a senha nova."
  + **Entrar**.
- **Erros:**
  - "E-mail ou código inválido."
  - "Este código venceu — peça um novo a quem organiza o evento."
  - "As duas senhas não são iguais."
  - a regra da senha da Mostraí: "a senha precisa ter no mínimo 8
    caracteres, com maiúscula, minúscula, número e símbolo";
  - "Muitas tentativas seguidas — espere alguns minutos."

### T7 (só para operador)

- Desativado: "Este acesso foi desativado — fale com quem organiza o
  evento."
- Banco da Trimundi fora do ar: a tela responde como a Mostraí sempre
  respondeu ("E-mail ou senha inválidos"), para o login dela não mudar nem
  dizer se o e-mail é conta (revisto em 09/11/2026).

### T8

- "Olá, {nome}." · seletor "Edição" · "Entradas: {n} de {total} ingressos"
  · **Ler QR Code** / **Desligar câmera** · "Ou digite o código do
  ingresso" · **Consultar** · **Sair**.
- Resultado: "Ingresso válido" (com **Confirmar entrada** e **Cancelar**) ·
  "Entrada registrada" · "Ingresso já utilizado" (com "Entrou em {data}, por
  {operador}") · "Ingresso cancelado" · "Ingresso bloqueado" (com o motivo) ·
  "Ingresso de outra edição" · "Ingresso inválido".
- Câmera bloqueada: "A câmera foi bloqueada. Libere o uso da câmera para
  este site nas configurações do navegador, ou digite o código."
- Espaço do link de indicação reservado na tela, vazio até o mecanismo
  existir (`proximas-versoes.md`).

### Páginas do comprador (T9 a T12)

- **T9 `/ticket/{evento}/{edição}`** — vitrine e compra: dados da edição,
  ingressos e promoções com preço e lote (nunca o número em estoque),
  quantidade, **Continuar**; depois, resumo da cotação, dados de quem
  compra e de cada participante ("Este ingresso é meu"), regras para
  aceitar e **Ir para o pagamento**. "Seus ingressos ficam reservados por
  30 minutos para o pagamento."
- **T10 `/ticket/pedido/{id}?t=…`** — situação do pedido, **Pagar agora**
  com o tempo da reserva, e depois de pago um cartão por ingresso (QR,
  código, participante, benefícios, situação), **Imprimir** e **Baixar
  QR**. Sem o token, não abre.
- **T11 `/ticket/recuperar`** — e-mail e CPF de quem comprou; resposta
  sempre igual: "Se houver pedido pago com esses dados, o link vai para o
  e-mail do comprador em alguns minutos."
- **T12 `/ticket/dev/pagamento/{id}`** — só desenvolvimento: **Aprovar
  pagamento** / **Recusar pagamento**.

### Módulo desligado

"A Trimundi não está configurada neste ambiente."

## 7. Quando dá errado

| Situação | O que o sistema faz | O que a pessoa vê |
|---|---|---|
| Duplo clique em salvar ou emitir | o botão trava enquanto envia (padrão do Admin); cortesia e pedido levam chave de idempotência | uma emissão só |
| A rede cai no meio de salvar | transação: nada pela metade é gravado | o erro e o formulário ainda preenchido |
| Dois pedidos pela última vaga | a transação que trava a edição deixa passar um (RN-T12) | o segundo recebe "esgotado" |
| Confirmação repetida, fora de ordem ou com valor errado | dedupe pelo `eventoId`; valor divergente não emite (RN-T18) | nada muda para quem já tem ingresso |
| Pagamento chega depois da reserva vencer | emite se couber; senão, "pago sem vaga" (RN-T13) | fase do checkout: fila de devolução |
| Banco da Trimundi fora do ar | as rotas da Trimundi falham; a Mostraí segue funcionando | Admin: erro de carga com **Tentar novamente**; operador: T7 com o texto de §6 |
| Armazenamento de imagem fora | a edição continua salva | "Não foi possível salvar a imagem agora — tente de novo." |
| Código de ativação errado 5 vezes | o código morre | "E-mail ou código inválido."; o administrador gera outro |
| Operador desativado com a tela aberta | a próxima requisição dá 401 | volta para T7 |
| Dois administradores na mesma edição | o último a salvar vence (o administrador hoje é um só) | — |
| Voltar no navegador no meio de um formulário | o formulário não guarda rascunho local | o que não foi salvo se perde (limite desta versão) |

## 8. Direitos e obrigações que viram tela

- **Nesta versão não há venda a consumidor nem conta de comprador ou
  participante.** Dado pessoal só entra por cortesia (digitada pelo
  administrador) e por pedido de teste (dado fictício).
- **Antes do primeiro dado real** (`pendencias.md`, "Antes de dado real"),
  precisam existir:
  - o canal do titular (o e-mail da Trimundi);
  - exportação e anonimização por CPF, feitas pelo Admin;
  - a política de privacidade cobrindo a Trimundi.
- **Aceite de termos:** o registro existe no banco (versão, hash, IP,
  navegador, RN-T05). Quem colhe o aceite é a página pública, na próxima
  fase.
- **Arrependimento em 7 dias** (CDC, art. 49), com estorno no mesmo fluxo,
  e **confirmação da compra por e-mail:** fase do checkout.

## 9. Métrica de sucesso e eventos de medição

**D1 — proposta, aguarda o dono** (`pendencias.md`).
- **Métrica principal:** ingressos emitidos por edição — pagos e cortesias
  contados separados — e a receita confirmada (só pagos de venda, nunca
  teste).
- **"Quantos ontem?":** quantos ingressos pagos e quantas cortesias foram
  emitidos ontem, e quanto entrou.

Eventos, todos emitidos no servidor, na tabela `metricas`, na mesma
transação do fato e sem dado pessoal:

| Evento | Propriedades | Responde |
|---|---|---|
| `catalogo:edicao_publica` | edicao_id, data_definida, local_definido | quantas edições abriram, e quantas sem data ou local |
| `catalogo:lote_abre` | lote_id, categoria_id, motivo (`primeiro`, `data`, `anterior_encerrado`) | como os lotes viram |
| `catalogo:lote_esgota` | lote_id, minutos_aberto | em quanto tempo cada lote acaba |
| `venda:pedido_cria` | edicao_id, ingressos_quantidade, total_centavos, origem | quantos pedidos e de que tamanho |
| `venda:pagamento_confirma` | pedido_id, total_centavos, minutos_desde_criacao, metodo | quanto entrou e em quanto tempo se paga |
| `venda:pedido_expira` | pedido_id, total_centavos | quanto se perde por não pagar |
| `emissao:ingresso_emite` | edicao_id, origem (`pago`, `cortesia`), categoria_id, promocao_id | a métrica principal |
| `emissao:cortesia_cancela` | edicao_id, classificacao | quanto de cortesia se desfaz |
| `acesso:operador_ativa` | operador_id | a portaria está pronta? |
| `acesso:checkin_registra` (fase do check-in) | edicao_id, escopo, resultado | quantos entraram |

## 10. O que fica fora desta versão

Ver `CONSTRAINTS.md` (vetos) e `proximas-versoes.md` (adiado).

## Prontidão desta definição

| Pergunta | Resposta |
|---|---|
| 1. Dá para construir cada tela lendo só isto? | Sim |
| 2. Cada papel tem jornada e cada tela pertence a uma? | Sim |
| 3. Cada regra tem consequência? | Sim |
| 4. Cada fluxo tem o "quando dá errado", e os eventos estão nomeados? | Sim, com D1 e D2 pendentes do dono |
