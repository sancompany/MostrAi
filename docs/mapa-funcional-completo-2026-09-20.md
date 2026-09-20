# Mapa funcional completo do Mostraí — revisão da Estação 5

> Inventário estático cruzado entre páginas, JavaScript, rotas, repositories, migrations e estado seguro de produção em 20/09/2026. “Existe” significa implementado; “confirmado manualmente” só quando há evidência real. Bugs técnicos pausados continuam registrados, mas não foram corrigidos nesta etapa.

## Como ler

- **OK código:** fluxo completo e coerente por leitura/testes existentes.
- **Parcial:** implementado, mas depende de integração, job, dado ou validação manual.
- **Bug confirmado:** contradição executável comprovada.
- **Suspeita:** requer navegação/dado real; não tratar como bug.
- **Legado:** mantido intencionalmente para links antigos.

## 1. Site público

| Página/área | Funções existentes | Estado e buracos |
|---|---|---|
| Home `/` | proposta, planos resumidos, fluxo da rede, CTA, redirecionamento de logado | OK código; revisar textos/mobile manualmente |
| Planos | catálogo dinâmico, ciclos, descontos/economia, cobertura, CTA para contratação | Parcial: catálogo depende de coerência entre ciclos; admin alerta divergências |
| Onde estamos | pontos públicos, status, categoria, endereço, fluxo agregado, foto configurável | OK código; privacidade e layout entram na rodada manual |
| Contato | valida campos, grava no banco antes de SMTP, avisa admin, fila de não respondidas | OK código; SMTP continua integração a observar |
| Cadastro | CPF/CNPJ, responsável, endereço/CEP, categoria, telefone, senha, termos, cupom, confirmação de e-mail | OK código; matriz de validação manual pendente |
| Login/logout | sessão PostgreSQL, bloqueio suspenso/excluído, migração de hash legado | OK código |
| Esqueci/redefinir senha | resposta não enumerável, token de 1h/uso único, regra de senha comum | OK; endpoint `afiliados` é compatibilidade intencional |
| Convite | consulta token, cadastro novo ou aceite em conta existente, papel ponto/vendedor | Parcial: combinações de convite precisam rodada manual |
| Obrigado | diferencia assinatura nova/troca e orienta próximo passo | Parcial: depende do retorno real do Checkout |
| Contratos/legal | termos, privacidade, contrato anunciante e comodato | Existe; sincronismo jurídico/conteúdo requer leitura manual |
| 404/500 | erro amigável e retorno | OK |
| Endpoints `seja-um-*` | retornam 410/redirecionam para conta/contato | Legado intencional |

## 2. Conta comum e perfil

| Função | Implementação | Estado/buraco |
|---|---|---|
| Uma conta, múltiplos papéis | `anunciantes.papeis` | OK |
| Ver/editar perfil e foto | `/anunciantes/me`, PATCH, upload JPEG normalizado | OK código |
| Confirmação obrigatória de e-mail | código de 6 dígitos, expiração/reenvio | OK código; entrega SMTP manual |
| Consentimento/comunicações | consultar e revogar/reativar | OK |
| Exportar dados | `/titular/meus-dados` | OK código |
| Arrependimento | consulta elegibilidade, pedido, cancelamento e fila admin | Parcial: estorno final é manual no Checkout |
| Exclusão | anonimização/bloqueios conforme vínculos | Parcial: validar todas combinações de papéis |
| Ativar modo anunciante | exige endereço e ramo | OK |
| Pedir modo ponto | candidatura interna; impede duplicata | OK |
| Modo vendedor | somente convite; edição de Pix | OK código |
| `bonus.ponto` | sempre `null` | **Não é bug:** módulo “ganhe tela” foi removido; chave é compatibilidade de frontend |
| Bônus de anúncio do ponto | calcula tempo ativo/opção, resgata cortesia quando elegível | Parcial: fluxo temporal real não validado |

## 3. Anunciante

| Grupo | Funções existentes | Estado/buracos |
|---|---|---|
| Painel sem plano | bloqueio e CTA | OK |
| Assinar | escolhe plano/ciclo, cria assinatura, redireciona Checkout | Parcial: integração externa |
| Gerenciar plano | resumo em modal, trocar, cancelar | Troca é problema técnico conhecido e **pausado**; restante parcial |
| Cobertura | lista pontos, busca, seleção até teto, sorteio estável sem escolha, bloqueio de ponto cheio | OK código; edge cases manuais pendentes |
| Criativos | upload imagem/vídeo, ffprobe, limites, normalização MP4/thumbnail, fila, motivo de reprovação, exclusão | OK código; matriz de codecs/tamanhos manual |
| Métricas | programadas/confirmadas, mês, horas, gráficos por dia/ponto, custo fixo, CSV proof-of-play | Player/proof-of-play conhecido e **pausado** |
| Banco de horas | saldo/idade/tempo ilustrativo | Problema/decisão técnica conhecida e **pausada** |
| Candidatura a ponto | card simplificado no fim do painel | OK código |
| Links de papéis | acesso ao Meu ponto/Vendas quando liberados | OK |

## 4. Dono de ponto

| Função | Estado |
|---|---|
| Ver endereços e telas da própria conta | OK código e autorização por dono |
| Cadastrar endereço adicional | cria ponto `a_instalar` + Tela 1; exige papel ponto | OK |
| Categoria do ponto | cadastro/admin gravam e playlist usa | OK código; teste manual concorrente × categoria pendente |
| Extrato de ajuda de custo | resumo e linhas por mês | OK código |
| Créditos de indicação | cupom, quantidade e progresso de tier | OK código |
| Trocar ajuda por tela/crédito | valida papel, opção e estado | Parcial: validar efeito financeiro real |
| Painel de cada tela | programadas/confirmadas e PIN | Parcial pela semântica pausada do player |
| Definir PIN | dono autorizado altera sua tela | OK |
| Criativos do próprio ponto | usa fluxo comum de criativo | OK código |

## 5. Vendedor

| Função | Estado |
|---|---|
| Entrada por convite | OK; não existe candidatura pública |
| Perfil/Pix | leitura e atualização | OK |
| Cupom | vínculo único em `vendedores` | OK |
| Painel | comissões, total comissionado/pago/a receber | OK código |
| Comissão | nasce da cobrança confirmada, percentual 10–30 | Parcial: validar cobrança real e dedupe |
| Pagamento | admin marca `pago_em` | OK código; pagamento externo/manual |
| Rotas antigas afiliado | 410 ou redirecionamento | Legado intencional |

## 6. Player e tela

Pareado por chave, playlist por tela, cache de lista/mídia, institucional, offline, heartbeat, painel PIN e confirmação existem. Os problemas de proof-of-play, janela, retry/idempotência e congelamento já estão documentados e **permanecem pausados por decisão do dono**. O modo `debug=1` existe localmente para diagnóstico, sem alteração contábil.

## 7. San Checkout e financeiro do cliente

| Função | Estado |
|---|---|
| Catálogo entregue ao Checkout | chave de integração, assinatura e pedido avulso | OK código |
| Assinatura nova | link/retorno, pagador, ciclo, descontos | Parcial externo |
| Webhook | HMAC, corpo cru, janela, fail-closed, transação, dedupe | OK código/testes |
| Primeira cobrança/renovação | eventos + conciliação por chargeId | Parcial: job não confirmado |
| Cancelamento | cliente/admin, cobertura e assinatura | Parcial externo |
| Troca proporcional | pedido/assinatura destino/histórico | Bug conhecido no Checkout, **pausado** |
| Contestação | suspende conta | OK código/teste |
| Nota fiscal | upload PDF ao Drive e estado | Parcial: Drive real |
| Eventos não correlacionados | fila, aplicar/descartar | OK código |
| Arrependimento | cancela; admin registra estorno manual | Parcial operacional |

## 8. Administração — todas as 24 seções

### Início

1. **Visão geral:** filas, receita recorrente, custos de pontos, amortização, fixos, margem, rede, offline, faturamento e conciliação.
2. **Métrica:** margem em seis meses, funil, tempo de filas e eventos brutos.

### Entrada

3. **Candidaturas:** listar, mudar estado e liberar papel/ponto na conta.
4. **Mensagens do site:** ler, ver falha de aviso SMTP e marcar respondida.
5. **Convites:** criar por papel/candidatura, listar, copiar e revogar.

### Operação

6. **Fila de criativos:** pendente/aprovado/reprovado, preview, aprovar/reprovar com motivo.
7. **Meus anúncios:** criar conta própria, frequência, upload e gestão sem plano.
8. **Pontos:** criar/editar, dono, categoria, comodato, ajuda, cota, status, acabamento, fluxo, fotos e nova tela.
9. **Ocupação dos pontos:** segundos por anunciante, bloqueio automático e liberação com folga.
10. **Telas:** listar/filtrar, status, custo, amortização, instalação, chave, PIN, painel e exclusão.
11. **Anunciantes:** criar/editar/suspender, papéis, parceiro, plano cortesia, categoria, cobertura, criativos e cancelamento.
12. **Vendedores:** Pix, cupom, percentual e status.

### Catálogo

13. **Planos:** criar, editar campos não contratuais, gerar nova versão para contrato, checar divergência entre ciclos.
14. **Planos arquivados:** listar versões e contas ainda dependentes.
15. **Benefícios:** criar/editar/ativar/excluir e associar ao catálogo.
16. **Categorias:** criar/editar/ativar/excluir; usada no bloqueio concorrente.
17. **Opções de comodato:** criar/editar valor, cota, crédito e plano bônus.

### Financeiro

18. **Cobranças:** listar pagamentos e anexar nota fiscal.
19. **Trocas de plano:** histórico de origem/destino/acerto.
20. **Banco de horas:** saldos, fila antiga e resolução manual.
21. **Comissões:** vendedor/Pix/valor e marcar pago.
22. **Pagar os pontos:** lançar mês, forma, comprovante e quitar.
23. **Devoluções:** fila de arrependimento e registrar estorno.
24. **Custos fixos:** criar/editar/ativar/excluir.
25. **Eventos pendentes:** inspecionar, aplicar manualmente ou resolver.

> A navegação possui 25 itens (não 24): o agrupamento anterior frequentemente esquecia “Meus anúncios”; este inventário o conta explicitamente.

## 9. Jobs e operação

| Função | Estado |
|---|---|
| Migrations no start | Implementado com advisory lock |
| Conciliação diária | Script e relatório existem; agenda Northflank não confirmada nesta sessão |
| Apuração mensal | Script existe; job não confirmado |
| Backup | Script existe; execução/restauração não confirmadas |
| Health | Produção responde |
| Deploy | documentado como main → Northflank; checkout atual sem remote |
| CI | migration limpa + `npm run check` |
| Auditoria semanal | workflow existe; vulnerabilidades abertas |

## 10. Bugs e buracos encontrados nesta passagem

### Novo bug confirmado — métrica histórica omite amortização

`src/admin/metrica.js` ainda filtra `p.status = 'ativo'`, mas desde a migration 045 os únicos estados de ponto são `a_instalar` e `em_operacao`. Consequência: a aba **Métrica**, no gráfico histórico de margem, calcula amortização como zero para todas as telas; a **Visão geral** usa corretamente `em_operacao`. Produção confirma que o ponto atual está `em_operacao`. Hoje o custo do equipamento é zero, então o número observado coincide por acaso; assim que houver custo, as duas telas divergem. Prioridade P1 financeiro/decisão. Menor correção futura: trocar o filtro e adicionar teste da consulta. Não corrigido nesta etapa de mapeamento.

### Buracos confirmados já conhecidos e pausados

- Proof-of-play e confirmação do player.
- Semântica de déficit físico versus banco de capacidade.
- Corridas do congelamento.
- Troca proporcional no Checkout.

### Parcial/não confirmado

- Jobs Northflank e restauração de backup.
- SMTP/Drive em operação atual.
- Todos os estados reais de assinatura/cancelamento/contestação.
- Bônus temporal de anúncio do ponto.
- Fluxos combinados de conta com três papéis.
- Matriz real de codecs, offline e dispositivos.

### Legado que não é bug

- Rotas/páginas de afiliado e `seja-um-*` com redirect/410.
- Colunas/tabelas antigas preservadas até drop autorizado.
- `bonus.ponto: null`, pois o módulo foi removido e a chave só mantém compatibilidade.
- Função morta `dispositivosRepo.contarAtivas()` ainda usa status antigo; não é chamada. É dívida técnica, enquanto a query ativa em `admin/metrica.js` é bug.

## 11. Ordem da revisão manual daqui em diante

Continuar do ponto atual do dono, sem reiniciar: para cada tela, testar happy path, vazio, erro, celular e efeito lateral. Sugestão de sequência restante quando não houver uma ordem já iniciada: autenticação/conta → painel anunciante → ponto → vendedor → admin Entrada → Operação → Catálogo → Financeiro. Todo achado deve receber uma das etiquetas: **bug**, **inconsistência**, **melhoria visual**, **decisão de produto**, **legado** ou **não confirmado**.

## 12. Inconsistências públicas corrigidas em 20/09/2026

Os Termos de Uso foram sincronizados com o produto atual em quatro pontos: toda conta nasce anunciante e vendedor entra somente por convite; vigência/cobertura começam no pagamento sem espera por ponto; cancelamento é self-service pelo painel com contato como contingência; e a distribuição foi descrita como orçamento por hora, distinguindo a operação real da estimativa comercial de 12 horas/dia. O contrato do anunciante e a vitrine já seguiam essas regras.
