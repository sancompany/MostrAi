#!/bin/bash
# Continuação do e2e.sh — assume cookies adm.txt / ana.txt / joao.txt no cwd e
# o servidor reiniciado com PROGRAMA_FUNDADOR_ATIVO=true.
# Cobre: vitrine mostra fundador com vagas, assinar fundador, vagas esgotam,
# webhook (fail-closed, idempotente, preço travado, meses grátis, mínimo de
# telas), cobertura ligando quando a tela entra, comissão do vendedor.
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

echo "== vitrine com programa fundador aberto =="
r=$(curl -s $B/planos); esperar "fundador aparece na vitrine" '"id":"fundador-12m"' "$r"
esperar "vitrine informa vagas restantes" '"vagas_restantes":1' "$r"
esperar "plano fundador vem primeiro" '^\[\{"id":"fundador-12m"' "$r"

echo "== assinar fundador =="
r=$(curl -s -b ana.txt -X POST $B/anunciantes/$ANA/assinar -H "$J" -d '{"planoId":"fundador-12m"}')
esperar "assinar devolve link de checkout" 'checkoutUrl' "$r"
ASS=$($PG -c "select id from assinaturas where anunciante_id=$ANA and status='ativa' order by id desc limit 1")
esperar "assinatura criada no banco" '^[0-9a-f-]{8,}$|^[0-9]+$' "$ASS"
r=$(curl -s -b ana.txt -X POST $B/anunciantes/$ANA/assinar -H "$J" -d '{"planoId":"fundador-12m"}')
ASS2=$($PG -c "select count(*) from assinaturas where anunciante_id=$ANA and status='ativa'")
esperar "clique duplo não duplica assinatura" '^1$' "$ASS2"

echo "== vagas esgotam =="
r=$(curl -s -c beto.txt -X POST $B/anunciantes/cadastro -H "$J" -d '{"nome_empresa":"Beto Lanches","cpf_cnpj":"333","endereco":"R","cidade":"Matão","uf":"SP","cep":"1","contato_email":"beto@x.com","contato_telefone":"16","senha":"Senha12@","aceitou_termos":true}')
BETO=$(echo $r | sed 's/.*"id":\([0-9]*\),.*/\1/' | head -c 5)
r=$(curl -s -b beto.txt -X POST $B/anunciantes/$BETO/assinar -H "$J" -d '{"planoId":"fundador-12m"}')
esperar "segunda conta não entra: vagas acabaram" 'vagas desse plano acabaram' "$r"
r=$(curl -s $B/planos); if echo "$r" | grep -q fundador-12m; then falha "vitrine esconde fundador sem vaga" "ainda aparece"; else ok "vitrine esconde fundador sem vaga"; fi

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
# deixa só uma tela ativa: o plano fundador pede 2
DISP2=$($PG -c "select id from dispositivos where apelido='Tela 2'")
curl -s -b adm.txt -X PATCH $B/admin/dispositivos/$DISP2 -H "$J" -d '{"status":"reparo"}' >/dev/null
# 'criada' é o evento da PRIMEIRA cobrança paga (API.md 4.3.4) — era este o
# caso que o Mostraí ignorava. O `eventoId` é atalho só do teste: com ele a
# dedupe não precisa consultar a rota 5.3 do Checkout, que não está no ar aqui.
r=$(enviar_webhook "{\"versao\":1,\"tipo\":\"assinatura\",\"planoId\":\"$ASS\",\"documento\":\"222\",\"evento\":\"criada\",\"eventoId\":\"ev-1\"}")
esperar "webhook aceito" '"ok":true' "$r"; sleep 1
st=$($PG -c "select status||'|'||coalesce(valor_mensal_travado::text,'')||'|'||meses_gratis_creditados||'|'||meses_cobertura_pendentes||'|'||coalesce(data_expiracao::date::text,'') from anunciantes where id=$ANA")
esperar "conta fica aguardando_ponto (1 tela < mínimo 2)" '^aguardando_ponto\|' "$st"
esperar "preço travado em 149" '\|149(\.0+)?\|' "$st"
esperar "1 mês grátis creditado" '\|149(\.0+)?\|1\|' "$st"
esperar "13 meses pendentes (12 pagos + 1 grátis)" '\|13\|' "$st"
cob=$($PG -c "select count(*)||'|'||sum(valor) from cobrancas_confirmadas where anunciante_id=$ANA")
esperar "cobrança registrada (149 x 12 = 1788)" '^1\|1788' "$cob"
com=$($PG -c "select count(*)||'|'||comissao_valor from comissoes where anunciante_id=$ANA group by comissao_valor")
esperar "comissão do vendedor gerada (12% de 1788 = 214.56)" '^1\|214.56' "$com"

echo "== webhook: reentrega idêntica não duplica =="
enviar_webhook "{\"versao\":1,\"tipo\":\"assinatura\",\"planoId\":\"$ASS\",\"documento\":\"222\",\"evento\":\"criada\",\"eventoId\":\"ev-1\"}" >/dev/null; sleep 1
cob=$($PG -c "select count(*) from cobrancas_confirmadas where anunciante_id=$ANA"); esperar "só 1 cobrança" '^1$' "$cob"
com=$($PG -c "select count(*) from comissoes where anunciante_id=$ANA"); esperar "só 1 comissão" '^1$' "$com"
mg=$($PG -c "select meses_gratis_creditados from anunciantes where id=$ANA"); esperar "meses grátis não repetem" '^1$' "$mg"

echo "== cobertura liga quando a segunda tela volta =="
curl -s -b adm.txt -X PATCH $B/admin/dispositivos/$DISP2 -H "$J" -d '{"status":"ativo"}' >/dev/null; sleep 1
st=$($PG -c "select status||'|'||meses_cobertura_pendentes||'|'||(data_expiracao::date - now()::date) from anunciantes where id=$ANA")
esperar "conta ativa" '^ativo\|' "$st"
esperar "pendentes zerados" '\|0\|' "$st"
esperar "expiração ≈ 13 meses à frente (>= 390 dias)" '\|(39[0-9]|4[0-9][0-9])$' "$st"

echo "== vendedor vê a comissão =="
r=$(curl -s -b joao.txt $B/vendedor/painel); esperar "painel do vendedor soma a receber" '"totalAReceber":"?214' "$r"
r=$(curl -s -b adm.txt $B/admin/comissoes); esperar "admin lista comissão com nome do vendedor" 'João' "$r"
r=$(curl -s -b adm.txt $B/admin/vendedores); esperar "admin lista vendedores" '"codigo_cupom"' "$r"

echo "== playlist do dispositivo com anunciante ativo =="
CHAVE=$($PG -c "select aparelho_id from dispositivos where apelido='Tela 1'")
DISP=$($PG -c "select id from dispositivos where apelido='Tela 1'")
r=$(curl -s "$B/playlist/$DISP?chave=$CHAVE"); esperar "playlist responde com itens ou vazio válido" '"itens"|"playlist"|\[' "$r"

echo; echo "falhas: $falhas"
