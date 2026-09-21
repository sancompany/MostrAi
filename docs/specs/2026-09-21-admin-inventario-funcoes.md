# Inventário completo das funções do admin

> Levantado em 21/09/2026 lendo `public/admin/index.page.js` (3.270 linhas)
> inteiro, linha a linha. É a lista que o dono usa para decidir o que fica e o
> que sai no redesenho. Numeração estável: use "8.5" para se referir a um item.
>
> **Nada aqui foi alterado.** Este documento é só o mapa.

## G. Funções globais (valem para todas as telas)

| # | Função |
|---|---|
| G.1 | Login por usuário e senha (sessão em cookie httpOnly) |
| G.2 | Sair |
| G.3 | Sessão persistente — reabre já logado |
| G.4 | Menu lateral: 5 grupos, 25 itens |
| G.5 | Badge de contagem no menu (9 filas) |
| G.6 | Navegação por endereço (`#aba`), funciona com o voltar do navegador |
| G.7 | Botão "Atualizar" recarrega a aba atual |
| G.8 | Título + subtítulo explicativo em cada tela |
| G.9 | Aviso flutuante de salvo/erro |
| G.10 | Flash verde no campo que acabou de salvar |
| G.11 | Busca livre em qualquer tabela |
| G.12 | Chips de filtro por status |
| G.13 | Ordenar clicando no cabeçalho da coluna |
| G.14 | Contador "X de Y" no rodapé da tabela |
| G.15 | Estado vazio automático ("nada cadastrado" ≠ "nada com esse filtro") |
| G.16 | Uma aba que quebra não derruba o admin inteiro |

## 1. Visão geral (`#resumo`)

| # | Função |
|---|---|
| 1.1 | Alertas de fila clicáveis — 9 tipos, urgentes em destaque |
| 1.2 | Mensagem "Rede em montagem" com primeiros passos (rede zerada) |
| 1.3 | Mensagem "Tudo em dia" |
| 1.4 | KPI Receita recorrente |
| 1.5 | KPI Custo dos pontos |
| 1.6 | KPI Amortização |
| 1.7 | KPI Custos fixos (com atalho "editar") |
| 1.8 | KPI Margem (azul/vermelho) |
| 1.9 | KPI Pontos ativos (+ telas no ar, + novos em 30 dias) |
| 1.10 | KPI Alcance da rede (pessoas/mês) |
| 1.11 | KPI Exibições em 30 dias (+ % do programado) |
| 1.12 | KPI Anunciantes novos em 30 dias |
| 1.13 | Linha de status da conciliação diária (quando rodou, o que fez, se atrasou) |
| 1.14 | Gráfico de faturamento dos últimos 6 meses |
| 1.15 | Barras: pontos por status |
| 1.16 | Barras: anunciantes por situação |

## 2. Métrica (`#metrica`)

| # | Função |
|---|---|
| 2.1 | KPI Margem deste mês |
| 2.2 | KPI Conversão checkout → pago |
| 2.3 | KPI Conversão cadastro → pago |
| 2.4 | Tabela margem mês a mês (receita, pontos, amortização, fixos, margem) |
| 2.5 | Aviso de que os custos são os de hoje repetidos em todo mês |
| 2.6 | Tabela do funil mês a mês |
| 2.7 | Tabela de tempo das filas (mediana e pior caso, por semana) |
| 2.8 | Bloco recolhível de instrumentação (eventos gravados) |

## 3. Candidaturas (`#candidaturas`)

| # | Função |
|---|---|
| 3.1 | Lista: data, tipo, nome, comércio+endereço, contato, mensagem |
| 3.2 | Badge de origem (pedido do painel / bônus do plano) |
| 3.3 | Link direto de WhatsApp |
| 3.4 | Mudar status (nova / em contato / recusada) |
| 3.5 | "Liberar na conta" — cria o ponto e a Tela 1 |
| 3.6 | "Gerar convite" (pergunta se também vai ser anunciante) |
| 3.7 | Copiar link do convite |
| 3.8 | Badge da situação do convite (usado / aberto / expirado) |
| 3.9 | Filtros por status e por tipo |

## 4. Mensagens do site (`#contato`)

| # | Função |
|---|---|
| 4.1 | KPI esperando resposta (prazo legal) |
| 4.2 | KPI aviso por e-mail que não saiu |
| 4.3 | Lista: data, nome, e-mail, telefone, mensagem |
| 4.4 | Badge "e-mail enviado / não saiu" |
| 4.5 | Marcar como respondida |
| 4.6 | Filtros |

## 5. Convites (`#convites`)

| # | Função |
|---|---|
| 5.1 | Formulário de novo convite (papéis, nome, e-mail, validade em dias) |
| 5.2 | Lista: criado, papéis, pra quem, validade, situação, conta criada |
| 5.3 | Copiar link |
| 5.4 | Revogar |
| 5.5 | Filtros |

## 6. Fila de criativos (`#criativos`)

| # | Função |
|---|---|
| 6.1 | Chips: em análise / aprovados / reprovados |
| 6.2 | Preview do vídeo (com controles) ou da imagem |
| 6.3 | Nome do anunciante, id, duração, data de envio |
| 6.4 | Aprovar |
| 6.5 | Reprovar com motivo obrigatório (vai no painel e no e-mail do anunciante) |
| 6.6 | Mudar de aprovado ↔ reprovado depois |

## 7. Meus anúncios — conta própria (`#meusanuncios`)

| # | Função |
|---|---|
| 7.1 | Criar a conta própria (nome, CNPJ, frequência por hora) |
| 7.2 | Editar frequência por hora, por tela |
| 7.3 | Pausar / despausar a conta |
| 7.4 | Subir anúncio (vídeo ou imagem) |
| 7.5 | Lista dos anúncios com duração e situação |
| 7.6 | Pôr no ar / tirar do ar |
| 7.7 | Contador "X no ar · Y no total · sem teto" |

## 8. Pontos (`#pontos`)

| # | Função |
|---|---|
| 8.1 | Upload da foto de exemplo do "ponto completo" (site público) |
| 8.2 | Formulário de novo ponto manual |
| 8.3 | Lista: id, nome, responsável+contato, dono (conta), cidade |
| 8.4 | Editar segmento do local (bloqueia concorrente) |
| 8.5 | Editar modalidade de comodato |
| 8.6 | Editar ajuda de custo R$/mês |
| 8.7 | Editar cota de autoanúncio por hora |
| 8.8 | Editar status (a instalar / em operação) |
| 8.9 | Editar fluxo estimado mensal |
| 8.10 | Marcar molde/acabamento completo |
| 8.11 | Ver telas do ponto ("2/3 no ar") com atalho pra aba Telas |
| 8.12 | "+ tela" — cria outra TV nesse endereço (apelido + custo) |
| 8.13 | Upload da foto do ponto + link "ver foto" |
| 8.14 | Filtros (todos / com tela fora do ar / por status) |

## 9. Ocupação dos pontos (`#ocupacaopontos`)

| # | Função |
|---|---|
| 9.1 | KPI pontos travados |
| 9.2 | KPI pontos com assinante |
| 9.3 | Bloco destacado dos pontos travados |
| 9.4 | Tabela ponto × anunciante com segundos/hora e % de ocupação |
| 9.5 | Badge de situação (livre / perto de 80% / travado) |
| 9.6 | Liberar ponto pra escolha nova (só com folga real) |
| 9.7 | Filtros |

## 10. Telas (`#telas`)

| # | Função |
|---|---|
| 10.1 | Filtro por ponto (quando vem da aba Pontos) |
| 10.2 | Lista: id, ponto+cidade+status do ponto |
| 10.3 | Editar apelido da tela |
| 10.4 | Editar status da tela (ativa / em reparo / inativa) |
| 10.5 | Último sinal + badge "sem sinal" |
| 10.6 | Gerar chave do aparelho |
| 10.7 | Trocar chave (avisa que derruba a TV atual) |
| 10.8 | Copiar link do player |
| 10.9 | Definir / trocar / remover PIN do painel da TV |
| 10.10 | Editar custo do equipamento |
| 10.11 | Editar meses de amortização |
| 10.12 | Amortização por mês (calculada) |
| 10.13 | Editar data de instalação |
| 10.14 | Painel da tela — abre na linha: exibições por anunciante em 30 dias |
| 10.15 | Excluir tela |
| 10.16 | Filtros (todas / sem sinal / sem chave / por status) |

## 11. Anunciantes (`#anunciantes`)

| # | Função |
|---|---|
| 11.1 | Aviso de divergência entre ciclos do mesmo plano |
| 11.2 | Texto explicativo "o produto é do tier, a oferta é do ciclo" |
| 11.3 | Formulário de novo anunciante manual (mostra a senha gerada uma vez) |
| 11.4 | Lista: id, empresa, badges de papel, badge parceiro, badge excluída |
| 11.5 | Documento e contato (e-mail + telefone) |
| 11.6 | Editar ramo / categoria |
| 11.7 | Ver plano atual + badge cortesia (com motivo) |
| 11.8 | Data de expiração |
| 11.9 | Editar status (comum / parceiro) |
| 11.10 | Editar suspensa (sim / não) |
| 11.11 | Data de entrada |
| 11.12 | Subir anúncio direto na conta do cliente (entra já aprovado) |
| 11.13 | Liberar plano de cortesia (escolhe plano + motivo) |
| 11.14 | Marcar / editar / remover parceiro (desconto % + compromisso mínimo) |
| 11.15 | Cancelar assinatura (para a recorrência no San Checkout) |
| 11.16 | Restaurar conta excluída (janela de 60 dias) |
| 11.17 | Filtros (todos / comum / parceiro / dono de ponto / vendedor / excluídas) |

## 12. Vendedores (`#vendedores`)

| # | Função |
|---|---|
| 12.1 | Lista: conta, nome, e-mail, telefone |
| 12.2 | Editar chave Pix |
| 12.3 | Ver cupom + copiar link de indicação |
| 12.4 | Editar comissão % (10 a 30) |
| 12.5 | Editar status (aprovado / inativo) |
| 12.6 | Data de entrada |
| 12.7 | Filtros |

## 13. Planos (`#planos`)

| # | Função |
|---|---|
| 13.1 | Aviso de divergência entre os ciclos do mesmo tier |
| 13.2 | Texto explicativo tier × ciclo |
| 13.3 | Formulário de novo plano (14 campos + benefícios) |
| 13.4 | Cartões agrupados por ciclo (mensal / trimestral / semestral / anual) |
| 13.5 | Badge "X/3 na vitrine" por ciclo |
| 13.6 | Marcar "Mais escolhido" (salva na hora) |
| 13.7 | Marcar "Na vitrine" (salva na hora) |
| 13.8 | Editar nome |
| 13.9 | Editar subtítulo (salva na hora) |
| 13.10 | Editar preço cheio |
| 13.11 | Editar desconto % |
| 13.12 | Preço final e total do ciclo recalculados ao vivo |
| 13.13 | Editar segundos de tela por hora + "= até Xh de tela/mês" ao vivo |
| 13.14 | Editar pontos incluídos |
| 13.15 | Editar duração máxima da peça |
| 13.16 | Marcar benefícios do plano |
| 13.17 | Editar limite de criativos |
| 13.18 | Editar vagas (salva na hora) |
| 13.19 | Editar desconto comodato % |
| 13.20 | "Salvar novo plano" — acende só ao mudar contrato; publica versão nova |
| 13.21 | Texto explicativo do versionamento no rodapé |

## 14. Planos arquivados (`#planosarquivados`)

| # | Função |
|---|---|
| 14.1 | KPI versões aposentadas + quantas ainda têm conta ativa |
| 14.2 | Tabela com 12 colunas (id, nome, ciclo, valor, criativos, tela/hora, pontos, benefícios, aposentada em, substituída por, contas ativas, cobranças) |
| 14.3 | Aviso de que não dá pra apagar (obrigação fiscal) |

## 15. Benefícios (`#beneficios`)

| # | Função |
|---|---|
| 15.1 | Criar benefício (texto + ordem) |
| 15.2 | Editar texto (reescreve o card de todos os planos) |
| 15.3 | Editar ordem |
| 15.4 | Ativar / desativar |
| 15.5 | Excluir (tira de todos os planos) |
| 15.6 | Filtros |

## 16. Categorias (`#categorias`)

| # | Função |
|---|---|
| 16.1 | Criar categoria |
| 16.2 | Editar nome |
| 16.3 | Ativar / desativar (aparece no cadastro) |
| 16.4 | Excluir (bloqueado se já estiver em uso) |
| 16.5 | Filtros |

## 17. Opções de comodato (`#comodato`)

| # | Função |
|---|---|
| 17.1 | Aviso de divergência entre ciclos (repetido da tela Planos) |
| 17.2 | Texto explicativo tier × ciclo (repetido da tela Planos) |
| 17.3 | Criar nova opção |
| 17.4 | Editar nome |
| 17.5 | Editar ajuda de custo R$/mês |
| 17.6 | Editar cota de espaços/hora |
| 17.7 | Editar chamada do site |
| 17.8 | Editar benefícios (um por linha) |
| 17.9 | Escolher plano de bônus |
| 17.10 | Editar "após N meses" |
| 17.11 | Editar "por M meses" |
| 17.12 | Editar ordem |
| 17.13 | Ativar / desativar |

## 18. Cobranças (`#cobrancas`)

| # | Função |
|---|---|
| 18.1 | KPI total confirmado |
| 18.2 | KPI notas por emitir |
| 18.3 | Lista: id, anunciante, valor, data |
| 18.4 | Anexar PDF da nota fiscal (envia ao selecionar) |
| 18.5 | Ver PDF da nota já emitida |
| 18.6 | Filtros |

## 19. Trocas de plano (`#trocas`)

| # | Função |
|---|---|
| 19.1 | KPI trocas pagas + total arrecadado em diferenças |
| 19.2 | KPI esperando pagamento |
| 19.3 | Tabela: anunciante, de, para, diferença, situação, pedido em, pago em |
| 19.4 | Filtros |

## 20. Banco de horas (`#bancohoras`)

| # | Função |
|---|---|
| 20.1 | KPI saldo ativo hoje |
| 20.2 | KPI esperando decisão |
| 20.3 | Bloco da fila de decisão, com contato do anunciante |
| 20.4 | Marcar como resolvido (não move dinheiro) |
| 20.5 | Tabela: anunciante, mês, pedidas, entregues, no banco, drenado, saldo, situação |
| 20.6 | Filtros |

## 21. Comissões (`#comissoes`)

| # | Função |
|---|---|
| 21.1 | KPI total a pagar |
| 21.2 | KPI por vendedor (até 3) com a chave Pix |
| 21.3 | Tabela: vendedor, anunciante, venda, comissão, data, Pix, situação |
| 21.4 | Marcar como paga / desfazer |
| 21.5 | Filtros |

## 22. Pagar os pontos (`#pagamentospontos`)

| # | Função |
|---|---|
| 22.1 | KPI em aberto |
| 22.2 | KPI pontos sem lançamento no mês |
| 22.3 | Formulário de lançamento (ponto, competência, valor, forma, observação, "já paguei") |
| 22.4 | Tabela de lançamentos |
| 22.5 | Marcar como pago / desfazer |
| 22.6 | Filtros |

## 23. Devoluções (`#arrependimentos`)

| # | Função |
|---|---|
| 23.1 | KPI a devolver |
| 23.2 | Tabela: protocolo, anunciante+e-mail, CPF/CNPJ, valor, pedido em, situação |
| 23.3 | Campo do id do estorno + "Registrar devolução" |
| 23.4 | Ver comprovante das já devolvidas |
| 23.5 | Filtros |

## 24. Custos fixos (`#custos`)

| # | Função |
|---|---|
| 24.1 | KPI custos fixos ativos |
| 24.2 | KPI amortização das telas |
| 24.3 | KPI ajuda de custo aos pontos |
| 24.4 | Criar custo fixo |
| 24.5 | Editar nome |
| 24.6 | Editar valor mensal |
| 24.7 | Editar observação |
| 24.8 | Ativar / desativar (entra ou não na margem) |
| 24.9 | Excluir |
| 24.10 | Filtros |

## 25. Eventos pendentes (`#eventos`)

| # | Função |
|---|---|
| 25.1 | Testar SMTP (host, porta, usuário, tamanho da senha, remetente, destino, diagnóstico) |
| 25.2 | Tabela de eventos: id, motivo, quando |
| 25.3 | Ver payload cru do webhook |
| 25.4 | "Aplicar este ciclo" — credita de verdade, reconferindo no San Checkout |
| 25.5 | "Só marcar resolvido" — não credita nada |
