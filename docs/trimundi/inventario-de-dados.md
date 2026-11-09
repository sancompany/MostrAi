# Inventário de dados — Trimundi

Que dado, de quem, para quê, onde fica, quem mais recebe, por quanto tempo
e como sai. É o registro de operações que a LGPD exige (skill `legal`), e é
daqui que saem os Termos e a Política da Trimundi. Atualizado na mesma
tarefa que cria o dado.

**Onde fica:** no banco da Mostraí (Supabase, sa-east-1, São Paulo), no
esquema próprio `trimundi` (decisão do dono, 09/11/2026). Imagens no
Storage da Mostraí, sob `trimundi/`. Em desenvolvimento e testes, o banco
local da Mostraí, no mesmo esquema. **Nesta versão nenhum
dado real entra:** cortesia só com dado de teste até os itens "Antes de dado
real" de `pendencias.md` estarem feitos.

**Prazos de retenção:** D2 aprovada pelo dono em 09/11/2026 **com
ressalva**: a estrutura existe (`src/trimundi/retencao.js`) com os prazos
abaixo como **provisórios**, e nada é anonimizado sozinho — só por comando
manual com `--confirmar`. Os prazos definitivos esperam a revisão de um
advogado. Não é parecer jurídico.

| Dado | De quem | Para quê | Tabela | Quem mais recebe | Retenção (D2) | Como sai | Base legal |
|---|---|---|---|---|---|---|---|
| Nome, CPF e e-mail do comprador (copiados da conta; o telefone não é mais pedido) | quem paga | cobrança, nota fiscal, estorno, contestação | `compradores` | San Checkout e Asaas (pagador do pedido) | 5 anos após o pagamento | anonimização: apaga nome, CPF, e-mail e telefone e mantém o pedido com o id | execução de contrato; obrigação legal (fiscal) |
| Conta do cliente: nome, CPF, e-mail, hash da senha (scrypt), data da confirmação do e-mail, último acesso | quem cria a conta | comprar, ver os ingressos e o link de indicação | `clientes` | — | enquanto a conta existir; no pedido do titular sai sempre (o que tem guarda fiscal é o comprador de cada pedido) | anonimização: apaga nome, CPF, e-mail e senha | execução de contrato |
| Links de confirmação de e-mail e de senha nova (só o sha256 do token) | sistema | confirmar o e-mail; trocar a senha | `cliente_tokens` | — | 48 h / 60 min, uso único | anulados ao usar, ao pedir outro ou na anonimização | execução de contrato |
| Indicação: código do indicador, quem comprou pelo link (id da conta), recompensa e entrega | cliente ou operador que indica; cliente indicado | contar indicações pagas e entregar a recompensa | `indicadores`, `indicacoes`, `recompensas_indicacao` | — | junto do pedido | o nome some com a anonimização da conta | execução de contrato (campanha aceita pela pessoa) |
| Entrega do benefício do ingresso: data e operador | operador | não entregar duas vezes | `ingresso_beneficios.resgatado_*` | — | junto do ingresso | fica (sem pessoa) | execução de contrato |
| Nome, CPF e e-mail do participante | quem usa o ingresso (pode não ser o comprador) | identificar o titular do ingresso na entrada (a portaria vê o nome, nunca o CPF; o QR não leva nenhum dos dois) | `participantes` | — (o e-mail do ingresso vai para o comprador) | 180 dias após o fim da edição | anonimização: o ingresso e o check-in ficam, sem pessoa | execução de contrato (ingresso pago); legítimo interesse — controle de acesso (cortesia). A confirmar com advogado |
| Classificação da cortesia (convidado, equipe, patrocinador, promocional) | administrador | separar cortesia de venda; medir | `cortesias` | — | como o ingresso | fica (não identifica pessoa) | legítimo interesse |
| Nome, e-mail e hash da senha do operador; último acesso | operador | acesso ao check-in | `operadores` | — | enquanto ativo; desativado, 6 meses | anonimização | execução de contrato (relação com o organizador) |
| Código de ativação (só o HMAC, nunca o código) | gerado pelo Admin | primeiro acesso do operador | `operadores.codigo_hash` | — | 72 h ou até o uso | apagado ao ativar ou ao gerar outro | execução de contrato |
| Tentativas de login e de ativação: HMAC do e-mail (nunca em claro), IP ou o /64 do IPv6, contagem | quem tenta | limitar força bruta | `tentativas_acesso`, **no banco da Mostraí** (limitador compartilhado) | — | janela de 15 min | limpeza do limitador da Mostraí | legítimo interesse (segurança) |
| Sessão do operador ou do cliente (só o id) | operador, cliente | manter o login | `session`, no esquema `public` (sessão da aplicação) | — | 7 dias | expira | execução de contrato |
| Aceite dos termos: versão, hash do texto, IP, navegador, data | comprador (fase do checkout) | prova do que foi aceito | `aceites` | — | junto do pedido: 5 anos | anonimização junto do pedido | exercício regular de direitos |
| Histórico do Admin: usuário do Admin e e-mail do Cloudflare Access de quem agiu | administrador | quem fez o quê | `auditoria` | — | 5 anos | não se apaga no prazo; o registro não carrega dado de participante | legítimo interesse |
| Imagens da edição (banner e galeria) | administrador | divulgar a edição | `edicao_imagens` + armazenamento próprio | público (URL) | enquanto a edição existir | apagar objeto e linha | — (sem pessoa); com pessoa identificável, só com autorização de imagem dela |
| Acesso à página do pedido: só o sha256 do token | sistema | abrir o pedido pelo link | `pedido_acessos` | — | junto do pedido | revogável (`revogado_em`) | execução de contrato |
| Fila de e-mail: endereço, assunto e corpo (o corpo leva o link do pedido, ou o de confirmação/senha) | comprador, cliente | mandar o link dos ingressos e os de conta | `emails` | provedor de e-mail da Mostraí (SMTP dela) | 90 dias após o envio (provisório, D2): endereço e corpo viram `[removido]` na retenção manual | — | execução de contrato |
| Aviso de pagamento do Checkout (payload v2: valores, status, `chargeId`; sem documento do pagador) | San Checkout | confirmar, estornar, conciliar | `pagamento_eventos` | — | junto do pedido | — | execução de contrato; obrigação legal |
| Eventos de medição (sem dado pessoal) | sistema | métrica (D1) | `metricas` | — | 2 anos | purga | legítimo interesse |
| Log do servidor | sistema | operar e depurar | log do Northflank | Northflank | o do provedor | expira | legítimo interesse. CPF nunca vai para log; e-mail só mascarado (`ad***@…`) |

## Subprocessadores

| Quem | Para quê | Onde |
|---|---|---|
| Supabase | banco (esquema `trimundi`) e armazenamento de imagens — o projeto da Mostraí | sa-east-1, São Paulo |
| Northflank | aplicação (o mesmo serviço da Mostraí) | southamerica-east |
| Cloudflare | proxy, DNS e Access na frente do site | rede global da Cloudflare: declarar na Política como possível transferência internacional (revisar com advogado) |
| San Checkout e Asaas | pagamento (fase do checkout) | Brasil |
| Provedor de e-mail da Mostraí (SMTP) | e-mails da conta e dos ingressos | declarar na Política |

## Exclusão e anonimização (decidido no dia 1)

- **Não se apaga:** pedido, ingresso, check-in e cortesia. Esses
  registros contábeis e operacionais perdem a pessoa e ficam.
- **Anonimizar** é apagar nome, CPF, e-mail e telefone e marcar
  `anonimizado_em`. O id continua, e nada volta a apontar para a pessoa.
- **Pedido do titular antes do prazo:** anonimiza na hora o que não tem
  guarda legal. O que tem (comprador com pagamento, até 5 anos) fica
  registrado com o motivo.
- **Pedido do titular:** Admin → Eventos → Participantes → **Pedido do
  titular (LGPD)**: consulta por CPF, baixa os dados em JSON e anonimiza.
  A auditoria guarda só um HMAC do CPF. O canal para o titular pedir
  (alias de e-mail) ainda é pendência (`pendencias.md`).
