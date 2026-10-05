# Inventário de dados — Mostraí

Que dado, de quem, para quê, onde fica, quem mais recebe, por quanto tempo,
como é apagado. Atualizado na mesma tarefa que cria o dado. É daqui que saem
os Termos de Uso e a Política de Privacidade (skill `legal`).

Onde fica: banco Postgres no Supabase (projeto próprio do Mostraí, São Paulo);
arquivos no Supabase Storage (bucket `criativos`, que guarda criativo, avatar e
foto de ponto — **precisa ser público**, porque o código serve por
`getPublicUrl`; hoje está privado e isso é pendência do dono);
notas fiscais no Google Drive da San & Co. (pasta do Mostraí).

| Dado | De quem | Para quê | Tabela/coluna | Quem mais recebe | Retenção | Apagamento |
|---|---|---|---|---|---|---|
| Nome da empresa, endereço, cidade, UF, CEP | anunciante / dono de ponto | identificar a conta, emitir nota, listar pontos no site | `anunciantes.*` | San Checkout (nome e documento do pagador) | enquanto a conta existir + 5 anos (fiscal) | soft-delete de 60 dias (`excluido_em`), depois apagamento manual |
| CPF/CNPJ da empresa | anunciante | cobrança e nota fiscal | `anunciantes.cpf_cnpj` | San Checkout, Asaas (via Checkout) | 5 anos após última cobrança (fiscal) | idem |
| E-mail de acesso | todos os papéis | login, recuperação de senha, confirmação de pagamento | `anunciantes.contato_email` | provedor de e-mail transacional | enquanto a conta existir | idem |
| Telefone/WhatsApp | todos | contato operacional | `anunciantes.contato_telefone`, `pontos.responsavel_contato` | — | enquanto a conta existir | idem |
| Senha | todos | autenticação | `anunciantes.senha_hash` (scrypt; legado bcrypt migra no login) | — | enquanto a conta existir | apagada com a conta |
| Nome, CPF, telefone e e-mail do responsável | anunciante (opcional) | contato humano | `anunciantes.responsavel_*` | — | enquanto a conta existir | idem |
| Foto de perfil | todos (opcional) | avatar | Storage `avatares/` | público (URL) | enquanto a conta existir | apagar objeto no storage |
| Chave Pix e CPF do vendedor | vendedor | pagar comissão | `vendedores.chave_pix`, `anunciantes.cpf_cnpj` | — | 5 anos após último pagamento | com a conta |
| Cupom e comissões | vendedor | atribuição e pagamento | `vendedores.codigo_cupom`, `comissoes.*` | — | 5 anos (fiscal) | não se apaga; anonimiza a conta |
| Endereço do ponto, fluxo estimado, foto de instalação | dono de ponto | operar a rede, listar no site (só endereço e status) | `pontos.*`, Storage `pontos/` | público: nome, endereço, status | enquanto o ponto existir | manual |
| Custo de equipamento por tela | dono (admin) | margem | `dispositivos.custo_equipamento` | — | indefinido (contábil) | manual |
| Criativos (vídeo/imagem) | anunciante | veiculação | `criativos.*`, Storage | público (URL); telas dos pontos | enquanto ativo + 90 dias | apagar objeto e linha |
| Exibições por tela e hora | gerado pelo sistema | entrega, pacing, comprovante | `exibicoes_contador` | anunciante (agregado) | 2 anos | purga por job |
| Cobranças confirmadas, nota fiscal (PDF) | anunciante | fiscal | `cobrancas_confirmadas`, Drive | contador do dono | 5 anos (fiscal) | não se apaga no prazo |
| Eventos de pagamento pendentes (payload do webhook) | anunciante | reconciliação | `eventos_assinatura_pendentes` | — | até resolver + 1 ano | purga |
| Eventos recebidos do webhook do Checkout (payload completo: id da assinatura, CPF/CNPJ do pagador em `documento`, valores) | anunciante (via San Checkout) | não perder evento financeiro entre o 200 e o efeito; reprocessar depois de falha | `webhooks_recebidos` (migration 096) | — | processado: 30 dias; morto: 90 dias | expurgo automático de hora em hora (src/financeiro/webhook-inbox.js) |
| Candidatura (nome, comércio, contato, endereço) | pessoa que se candidata a ponto ou vendedor | triagem pelo dono | `candidaturas.*` | — | 6 meses se recusada; vira conta se aprovada | purga por job |
| Convite (token, papéis, validade) | gerado pelo dono | cadastro por convite | `convites.*` | a pessoa convidada (link) | até usar ou expirar + 30 dias | purga |
| Chave de aparelho e PIN da tela | gerado pelo dono | autenticar a TV | `dispositivos.aparelho_id`, `dispositivos.pin_hash` | a TV | enquanto o dispositivo existir | trocar/apagar no admin |
| Último sinal da tela | gerado pela TV | alerta de offline | `dispositivos.ultima_vez_online` | — | só o último | sobrescrito |
| Sessão (cookie) | todos | manter login | tabela `session` (connect-pg-simple) | — | 7 dias | expira |
| Endereço IP em tentativas de login | todos | limitar tentativas | memória do processo | — | 15 minutos | expira |
| Tokens de redefinição de senha | todos | recuperação | `tokens_senha` | — | 1 hora | uso único / expira; trocar a senha apaga todos os da conta |
| Código de verificação de e-mail (só o HMAC, nunca o código) + endereço que o recebeu | todos | provar que o e-mail de login é da pessoa (cadastro e troca) | `codigos_email` (migration 097) | — | 10 minutos de validade; apagado ao confirmar ou 1 dia depois de vencer | expurgo automático (src/email/outbox.js) |
| Fila de e-mails: destinatário, nome da empresa, dados mínimos do aviso (plano, valor); código/link CIFRADO enquanto não sai | todos | entregar os e-mails com nova tentativa | `email_outbox` (migration 097) | provedor de e-mail (na entrega) | com código/link: 2 dias (o segredo some assim que a mensagem termina); enviada: 30 dias; abandonada/descartada: 90 dias | expurgo automático de hora em hora (src/email/outbox.js) |
| Trilha de troca de e-mail de login (anterior, novo, origem, usuário do admin) | todos | segurança da conta e suporte | `alteracoes_email` (migration 097) | — | enquanto a conta existir | apagada na anonimização da conta excluída (60 dias), junto com os códigos e a fila de e-mails da conta |
| Comunicado da plataforma: texto enviado, público, quem enviou (usuário do admin), e por conta destinatária a situação da entrega (enviado/falhou/fora do público) e o motivo da falha **sem endereço** | admin (texto) / todos (quem recebeu) | avisos de funcionamento do serviço (RN-68) e diagnóstico de entrega; o endereço só existe na fila enquanto ela guarda a mensagem | `comunicados`, `comunicados_destinatarios` (id da conta, nunca o e-mail), `comunicados_reenvios` (migration 108) | provedor de e-mail (na entrega, um destinatário por mensagem) | texto: indefinido (é comunicação da própria empresa); por destinatário: enquanto a conta existir | conta apagada leva o registro dela (ON DELETE CASCADE); na anonimização o registro fica só com o id, sem dado pessoal |
| Interesse em hospedar um Ponto Móvel (empresa, responsável, telefone, e-mail, endereço) | quem se oferece pelo site ou painel | o Admin entrar em contato e agendar | `hospedagem_interesses` (migration 113) | — | enquanto a conta existir; sem conta, 6 meses depois de recusado | manual; exportado ao titular |
| Hospedagem (local, endereço, período, tempo operacional, benefício) e saldo de hospedagem | conta anfitriã | calcular e veicular o benefício | `pontos_moveis_hospedagens`, `saldo_hospedagem_lancamentos` (migration 113) | — | enquanto a conta existir | com a conta; exportado ao titular |
| Termo de hospedagem FÍSICO (migration 115 — o aceite eletrônico, com IP e navegador, saiu; tabela `hospedagem_aceites` removida, 0 aceites em produção): só o controle operacional — assinado sim/não, data da assinatura, observação, qual Admin marcou e quando | conta anfitriã | controle de que o termo em papel foi assinado antes de a hospedagem começar (execução de contrato) | colunas `termo_*` de `pontos_moveis_hospedagens` | — | enquanto houver hospedagem + 5 anos (prazo prescricional do contrato); o papel assinado fica arquivado fisicamente na Mostraí | exportado ao titular junto com a hospedagem |
| Entrega/retirada do equipamento: itens, condição, observação, foto, Admin | Admin (sobre o equipamento na anfitriã) | prova da condição do equipamento | `hospedagem_movimentacoes`, Storage `pontos/movel-*-<uuid>.jpg` (nome aleatório; bucket público) | — | enquanto houver hospedagem + 5 anos | manual |

**Terceiros que recebem dado:** San Checkout e Asaas (pagador: nome,
documento, e-mail, telefone); Supabase (tudo, como hospedagem); Google Drive
(notas fiscais); provedor de e-mail transacional (e-mail e nome). QR code
não passa por terceiro: o QR institucional (27/09/2026, RN-66) é gerado no
próprio servidor (biblioteca `qrcode`) e só contém a URL pública
`/q/anuncie` — sem dado pessoal. (A linha antiga falava de um QR de vendedor
gerado em api.qrserver.com; não existe código que faça isso hoje.)

**Dado de menor:** não é coletado. Cadastro exige CPF/CNPJ de empresa ou
responsável adulto.

## ViaCEP — consulta de endereço (acrescentado em 15/09/2026)

**O que sai:** só o CEP digitado, em `GET https://viacep.com.br/ws/{cep}/json/`.
Nenhum outro dado do formulário acompanha — nem nome, nem documento, nem
contato. A chamada parte do NAVEGADOR da pessoa (`public/formulario.js`), então
o que o ViaCEP vê é o IP dela, não o do nosso servidor.

**Por que sai:** preencher endereço sozinho no cadastro de anunciante, na
candidatura de ponto e no cadastro de endereço novo do ponto.

**Base legal:** execução de contrato — o endereço é exigido para nota fiscal e
para localizar o ponto.

**Por que estava faltando aqui:** a integração entrou junto com a máscara de CEP
e ninguém registrou. Foi achada pela varredura de 15/09 (`docs/furos.md`, lente
"informação faltando") e entrou na Política de Privacidade, seção 4, na mesma
correção. Terceiro que recebe dado pessoal e não está no inventário é
exatamente o que a LGPD cobra.
