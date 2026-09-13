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
SECRET=$(grep '^SAN_CHECKOUT_WEBHOOK_SECRET=' "$ROOT/.env" | cut -d= -f2-)
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
r=$(curl -s -o /dev/null -w "%{http_code}" -X POST $B/webhook/san-checkout -H "$J" -d '{"tipo":"assinatura"}')
esperar "webhook sem segredo é 401" '^401$' "$r"
r=$(curl -s -o /dev/null -w "%{http_code}" -X POST $B/webhook/san-checkout -H "$J" -H "X-Webhook-Secret: errado" -d '{"tipo":"assinatura"}')
esperar "webhook com segredo errado é 401" '^401$' "$r"

echo "== webhook: cobrança confirmada com rede abaixo do mínimo (2 telas, 1 ativa) =="
# deixa só uma tela ativa: o plano fundador pede 2
DISP2=$($PG -c "select id from dispositivos where apelido='Tela 2'")
curl -s -b adm.txt -X PATCH $B/admin/dispositivos/$DISP2 -H "$J" -d '{"status":"reparo"}' >/dev/null
r=$(curl -s -X POST $B/webhook/san-checkout -H "$J" -H "X-Webhook-Secret: $SECRET" -d "{\"tipo\":\"assinatura\",\"planoId\":\"$ASS\",\"documento\":\"222\",\"evento\":\"cobranca_confirmada\",\"eventoId\":\"ev-1\"}")
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
curl -s -X POST $B/webhook/san-checkout -H "$J" -H "X-Webhook-Secret: $SECRET" -d "{\"tipo\":\"assinatura\",\"planoId\":\"$ASS\",\"documento\":\"222\",\"evento\":\"cobranca_confirmada\",\"eventoId\":\"ev-1\"}" >/dev/null; sleep 1
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
