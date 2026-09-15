#!/bin/bash
# Continuação do 01-fluxo-api.sh — assume cookies adm.txt / ana.txt / joao.txt
# no cwd. Cobre: desconto de fundador (status de conta, item 4 da spec),
# vagas de um plano com teto (mecanismo genérico, agora com reserva de 15 min
# em vez de 7 dias — item 5), webhook (assinatura HMAC, fail-closed, replay,
# idempotência, preço travado), 1ª cobrança (`criada`) ativando a conta,
# renovação estendendo a cobertura, evento sem ação virando pendência,
# comissão do vendedor.
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
B=${B:-http://localhost:3999}
cd "$ROOT/tests/e2e/saida"
J='Content-Type: application/json'
KEY=$(grep '^SAN_CHECKOUT_KEY=' "$ROOT/.env" | cut -d= -f2-)

# Assina como o San Checkout assina (API.md dele, 4.3.1): X-Checkout-Signature
# = "sha256=" + HMAC-SHA256 hex de "{timestamp}.{corpo cru}", com a
# X-Checkout-Key como segredo, e X-Checkout-Timestamp em segundos. NÃO existe
# header de segredo compartilhado — o X-Webhook-Secret que estava aqui era
# invenção nossa e nenhuma versão do contrato descreveu.
assinar(){ printf 'sha256=%s' "$(printf '%s.%s' "$1" "$2" | openssl dgst -sha256 -hmac "$KEY" -r | cut -d' ' -f1)"; }
enviar_webhook(){
  local corpo="$1" ts; ts=$(date +%s)
  curl -s -X POST "$B/webhook/san-checkout" -H "$J" \
    -H "X-Checkout-Signature: $(assinar "$ts" "$corpo")" -H "X-Checkout-Timestamp: $ts" -d "$corpo"
}
PG="psql -h localhost -U mostrai -d mostrai -tA"
export PGPASSWORD=mostrai
falhas=0
ok(){ echo "  ok  $1"; }
falha(){ echo "  FALHA $1 -> $2"; falhas=$((falhas+1)); }
esperar(){ if echo "$3" | grep -qE "$2"; then ok "$1"; else falha "$1" "$3"; fi; }

ANA=$($PG -c "select id from anunciantes where contato_email='ana@x.com'")
JOAO=$($PG -c "select id from anunciantes where contato_email='joao@x.com'")

echo "== fundador: status de conta com desconto e piso de compromisso (item 4) =="
curl -s -b adm.txt -X PATCH $B/admin/anunciantes/$ANA -H "$J" \
  -d '{"fundador":true,"fundador_desconto_percentual":10,"fundador_compromisso_minimo":3}' >/dev/null
r=$(curl -s -b ana.txt -X POST $B/anunciantes/$ANA/assinar -H "$J" -d '{"planoId":"essencial-1m"}')
esperar "plano abaixo do piso de compromisso do fundador é recusado" 'não está liberado' "$r"
r=$(curl -s -b ana.txt -X POST $B/anunciantes/$ANA/assinar -H "$J" -d '{"planoId":"essencial-12m"}')
esperar "assinar plano elegível pra fundador devolve link de checkout" 'checkoutUrl' "$r"
ASS=$($PG -c "select id from assinaturas where anunciante_id=$ANA and status='ativa' order by id desc limit 1")
esperar "assinatura criada no banco" '^[0-9a-f-]{8,}$|^[0-9]+$' "$ASS"
r=$(curl -s -H "X-Checkout-Key: $KEY" $B/plano/$ASS)
esperar "preço que o Checkout cobra já sai com os 10% de desconto (79,20 -> 71,28 x12 = 855,36)" '"valor":855\.36' "$r"
r=$(curl -s -b ana.txt -X POST $B/anunciantes/$ANA/assinar -H "$J" -d '{"planoId":"essencial-12m"}')
ASS2=$($PG -c "select count(*) from assinaturas where anunciante_id=$ANA and status='ativa'")
esperar "clique duplo não duplica assinatura" '^1$' "$ASS2"

echo "== vagas: plano com teto esgota (mecanismo genérico, agora 15 min de reserva — item 5) =="
curl -s -b adm.txt -X PATCH $B/admin/planos/destaque-1m -H "$J" -d '{"vagas":1}' >/dev/null
r=$(curl -s -c beto.txt -X POST $B/anunciantes/cadastro -H "$J" -d '{"nome_empresa":"Beto Lanches","cpf_cnpj":"12.ABC.345/01DE-35","endereco":"R","cidade":"Matão","uf":"SP","cep":"15990-000","contato_email":"beto@x.com","contato_telefone":"16 99463-5946","senha":"Senha12@","aceitou_termos":true}')
BETO=$(echo $r | sed 's/.*"id":\([0-9]*\),.*/\1/' | head -c 5)
r=$(curl -s -b beto.txt -X POST $B/anunciantes/$BETO/assinar -H "$J" -d '{"planoId":"destaque-1m"}')
esperar "primeira conta ocupa a vaga" 'checkoutUrl' "$r"
r=$(curl -s -c carla.txt -X POST $B/anunciantes/cadastro -H "$J" -d '{"nome_empresa":"Carla Doces","cpf_cnpj":"111.444.777-35","endereco":"R","cidade":"Matão","uf":"SP","cep":"15990-000","contato_email":"carla@x.com","contato_telefone":"16 99463-5947","senha":"Senha12@","aceitou_termos":true}')
CARLA=$(echo $r | sed 's/.*"id":\([0-9]*\),.*/\1/' | head -c 5)
r=$(curl -s -b carla.txt -X POST $B/anunciantes/$CARLA/assinar -H "$J" -d '{"planoId":"destaque-1m"}')
esperar "segunda conta não entra: vagas acabaram" 'vagas desse plano acabaram' "$r"
r=$(curl -s $B/planos); if echo "$r" | grep -q '"id":"destaque-1m"'; then falha "vitrine esconde plano sem vaga" "ainda aparece"; else ok "vitrine esconde plano sem vaga"; fi
curl -s -b adm.txt -X PATCH $B/admin/planos/destaque-1m -H "$J" -d '{"vagas":null}' >/dev/null

echo "== webhook: fail-closed =="
CORPO_FC='{"tipo":"assinatura"}'
TS=$(date +%s)
r=$(curl -s -o /dev/null -w "%{http_code}" -X POST $B/webhook/san-checkout -H "$J" -d "$CORPO_FC")
esperar "webhook sem assinatura é 401" '^401$' "$r"
r=$(curl -s -o /dev/null -w "%{http_code}" -X POST $B/webhook/san-checkout -H "$J" -H "X-Checkout-Signature: sha256=naoconfere" -H "X-Checkout-Timestamp: $TS" -d "$CORPO_FC")
esperar "webhook com assinatura errada é 401" '^401$' "$r"
# Replay: assinatura legítima, timestamp fora da janela de 300s (API.md 4.3.1, passo 1)
VELHO=$((TS-400))
r=$(curl -s -o /dev/null -w "%{http_code}" -X POST $B/webhook/san-checkout -H "$J" -H "X-Checkout-Signature: $(assinar "$VELHO" "$CORPO_FC")" -H "X-Checkout-Timestamp: $VELHO" -d "$CORPO_FC")
esperar "webhook reenviado fora da janela de 300s é 401" '^401$' "$r"

echo "== webhook: primeira cobrança paga (evento criada) =="
# 'criada' é o evento da PRIMEIRA cobrança paga; 'cobranca_confirmada' é a
# renovação (API.md 4.3.4). Era 'criada' que o Mostraí ignorava. O `eventoId`
# é atalho só do teste: com ele a dedupe não precisa consultar a rota 5.3 do
# Checkout, que não está no ar aqui.
#
# Desde a migration 021 não existe mínimo de telas nem cobertura adiada: quem
# pagou fica ativo na hora, e a cobertura é `compromisso_meses` cheio a partir
# do pagamento. Benefício comercial se dá no preço, nunca no tempo — aqui o
# preço já vem com o desconto de fundador (item 4 da spec).
r=$(enviar_webhook "{\"versao\":1,\"tipo\":\"assinatura\",\"planoId\":\"$ASS\",\"documento\":\"11222333000181\",\"evento\":\"criada\",\"eventoId\":\"ev-1\"}")
esperar "webhook aceito" '"ok":true' "$r"; sleep 1
st=$($PG -c "select status||'|'||coalesce(valor_mensal_travado::text,'')||'|'||(data_expiracao::date - now()::date) from anunciantes where id=$ANA")
esperar "conta fica ativa na primeira cobrança" '^ativo\|' "$st"
# O travado guarda o preço DO PLANO (79.20) — o desconto de fundador é lido
# ao vivo a cada cobrança (o admin pode mudar o percentual depois sem
# recongelar nada), não é somado ao valor travado.
esperar "preço travado é o do plano, sem o desconto (79.20)" '\|79\.20\|' "$st"
esperar "expiração ≈ 12 meses à frente (>= 360 dias)" '\|(3[6-9][0-9]|4[0-9][0-9])$' "$st"
cob=$($PG -c "select count(*)||'|'||sum(valor) from cobrancas_confirmadas where anunciante_id=$ANA")
esperar "cobrança registrada (71,28 x 12 = 855,36)" '^1\|855\.36' "$cob"
com=$($PG -c "select count(*)||'|'||comissao_valor from comissoes where anunciante_id=$ANA group by comissao_valor")
esperar "comissão do vendedor gerada (12% de 855,36 = 102,64)" '^1\|102.64' "$com"

echo "== webhook: reentrega idêntica não duplica =="
enviar_webhook "{\"versao\":1,\"tipo\":\"assinatura\",\"planoId\":\"$ASS\",\"documento\":\"11222333000181\",\"evento\":\"criada\",\"eventoId\":\"ev-1\"}" >/dev/null; sleep 1
cob=$($PG -c "select count(*) from cobrancas_confirmadas where anunciante_id=$ANA"); esperar "só 1 cobrança" '^1$' "$cob"
com=$($PG -c "select count(*) from comissoes where anunciante_id=$ANA"); esperar "só 1 comissão" '^1$' "$com"
exp1=$($PG -c "select data_expiracao::date from anunciantes where id=$ANA")

echo "== renovação (cobranca_confirmada) estende a cobertura =="
enviar_webhook "{\"versao\":1,\"tipo\":\"assinatura\",\"planoId\":\"$ASS\",\"documento\":\"11222333000181\",\"evento\":\"cobranca_confirmada\",\"eventoId\":\"ev-2\"}" >/dev/null; sleep 1
cob=$($PG -c "select count(*) from cobrancas_confirmadas where anunciante_id=$ANA"); esperar "renovação é uma 2ª cobrança" '^2$' "$cob"
exp2=$($PG -c "select data_expiracao::date from anunciantes where id=$ANA")
if [ "$exp2" \> "$exp1" ]; then ok "renovação empurrou a data de expiração"; else falha "renovação empurrou a data de expiração" "$exp1 -> $exp2"; fi

echo "== evento sem ação automática vira pendência, não derruba conta =="
enviar_webhook "{\"versao\":1,\"tipo\":\"assinatura\",\"planoId\":\"$ASS\",\"documento\":\"11222333000181\",\"evento\":\"cobranca_falhou\",\"eventoId\":\"ev-3\"}" >/dev/null; sleep 1
st=$($PG -c "select status from anunciantes where id=$ANA"); esperar "conta segue ativa depois de cobranca_falhou" '^ativo$' "$st"
pend=$($PG -c "select count(*) from eventos_assinatura_pendentes"); esperar "cobranca_falhou virou pendência pro admin" '^[1-9]' "$pend"

echo "== vendedor vê a comissão =="
# Duas comissões: a da 1ª cobrança e a da renovação. Comissão sobre renovação
# é o comportamento de hoje e é decisão de produto em aberto (PENDENCIAS, B).
r=$(curl -s -b joao.txt $B/vendedor/painel); esperar "painel do vendedor soma as duas comissões" '"totalAReceber":"?205\.28' "$r"
r=$(curl -s -b adm.txt $B/admin/comissoes); esperar "admin lista comissão com nome do vendedor" 'João' "$r"
r=$(curl -s -b adm.txt $B/admin/vendedores); esperar "admin lista vendedores" '"codigo_cupom"' "$r"

echo "== playlist do dispositivo com anunciante ativo =="
CHAVE=$($PG -c "select aparelho_id from dispositivos where apelido='Tela 1'")
DISP=$($PG -c "select id from dispositivos where apelido='Tela 1'")
r=$(curl -s "$B/playlist/$DISP?chave=$CHAVE"); esperar "playlist responde com itens ou vazio válido" '"itens"|"playlist"|\[' "$r"

echo; echo "falhas: $falhas"
