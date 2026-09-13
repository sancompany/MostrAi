# Inventário de dados — Mostraí

Que dado, de quem, para quê, onde fica, quem mais recebe, por quanto tempo,
como é apagado. Atualizado na mesma tarefa que cria o dado. É daqui que saem
os Termos de Uso e a Política de Privacidade (skill `legal`).

Onde fica: banco Postgres no Supabase (projeto próprio do Mostraí, São Paulo);
arquivos no Supabase Storage (bucket público para criativos e avatares);
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
| Candidatura (nome, comércio, contato, endereço) | pessoa que se candidata a ponto ou vendedor | triagem pelo dono | `candidaturas.*` | — | 6 meses se recusada; vira conta se aprovada | purga por job |
| Convite (token, papéis, validade) | gerado pelo dono | cadastro por convite | `convites.*` | a pessoa convidada (link) | até usar ou expirar + 30 dias | purga |
| Chave de aparelho e PIN da tela | gerado pelo dono | autenticar a TV | `dispositivos.aparelho_id`, `dispositivos.pin_hash` | a TV | enquanto o dispositivo existir | trocar/apagar no admin |
| Último sinal da tela | gerado pela TV | alerta de offline | `dispositivos.ultima_vez_online` | — | só o último | sobrescrito |
| Sessão (cookie) | todos | manter login | tabela `session` (connect-pg-simple) | — | 7 dias | expira |
| Endereço IP em tentativas de login | todos | limitar tentativas | memória do processo | — | 15 minutos | expira |
| Tokens de redefinição de senha | todos | recuperação | `tokens_senha` | — | 1 hora | uso único / expira |

**Terceiros que recebem dado:** San Checkout e Asaas (pagador: nome,
documento, e-mail, telefone); Supabase (tudo, como hospedagem); Google Drive
(notas fiscais); provedor de e-mail transacional (e-mail e nome). O QR do
link de indicação do vendedor é gerado por serviço externo (api.qrserver.com)
recebendo só a URL pública do cupom — sem dado pessoal.

**Dado de menor:** não é coletado. Cadastro exige CPF/CNPJ de empresa ou
responsável adulto.
