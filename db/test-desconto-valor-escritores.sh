#!/usr/bin/env bash
# ╔══════════════════════════════════════════════════════════════════════════════════╗
# ║ PROVA PG17 — desconto_valor atravessa os TRÊS escritores de order_items           ║
# ║ Rode: bash db/test-desconto-valor-escritores.sh > /tmp/t.log 2>&1; echo "exit=$?" ║
# ╚══════════════════════════════════════════════════════════════════════════════════╝
#
# O QUE ESTA PROVA EXISTE PARA PEGAR: `desconto_valor` distingue NÃO APURADO (NULL) de "o Omie
# informou que não há desconto" (0). Essa distinção é a entrega inteira — e ela morre de três
# jeitos, nenhum deles ruidoso:
#
#   1. um `coalesce(..., 0)` em qualquer dos escritores carimba "sem desconto" no acervo;
#   2. `aplicar_edicao_pedido_omie` APAGA e reinsere as linhas — sem a coluna no INSERT, editar
#      um pedido zera para NULL um desconto já apurado;
#   3. `reconciliar_pedidos_omie` troca preço/quantidade — conservar o desconto antigo o deixaria
#      colado numa base que mudou, que é pior que perdê-lo: passa a afirmar errado.
#
# Nenhum desses três produz exceção, log ou divergência de total. Só um teste que EXECUTA as
# funções e lê a coluna depois os vê.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
export PGVER=17   # consumido pelo db/lib/pg-harness.sh via source
PORT="${PGPORT_TEST:-5473}"
SLUG="desconto-valor-escritores"
DATA="$(mktemp -d "/tmp/pgtest-${SLUG}.XXXXXX")/data"
export LC_ALL=C LANG=C

# PGBIN: resolvido por plataforma (macOS Homebrew / Linux PGDG) com conferência POSITIVA da
# major — é o que deixa esta prova rodar no núcleo do CI (db/nucleo-ci.txt). O caminho fixo do
# Homebrew que morava aqui a prendia à máquina local, e a §F (o G5 intocado, 2026-09-10) só vale
# como gate se o CI a executar.
# shellcheck disable=SC1091  # o gate roda sem -x; o helper é versionado ao lado, em db/lib/
. "$REPO_ROOT/db/lib/pg-harness.sh"

cleanup() { "$PGBIN/pg_ctl" -D "$DATA" stop -m immediate >/dev/null 2>&1 || true; rm -rf "$(dirname "$DATA")"; }
trap cleanup EXIT

"$PGBIN/initdb" -D "$DATA" -U postgres -E UTF8 --locale=C >/dev/null
"$PGBIN/pg_ctl" -D "$DATA" -o "-p $PORT -k /tmp" -l "/tmp/pg-${SLUG}.log" -w start >/dev/null
"$PGBIN/createdb" -p "$PORT" -h /tmp -U postgres prove
P()  { "$PGBIN/psql" -p "$PORT" -h /tmp -U postgres -d prove -v ON_ERROR_STOP=1 "$@"; }
Pq() { P -tA "$@"; }

P -q -f "$REPO_ROOT/db/stubs-supabase.sql"
P -q <<'SQL'
CREATE OR REPLACE FUNCTION auth.uid()  RETURNS uuid LANGUAGE sql STABLE AS $f$ SELECT nullif(current_setting('test.uid', true), '')::uuid $f$;
CREATE OR REPLACE FUNCTION auth.role() RETURNS text LANGUAGE sql STABLE AS $f$ SELECT nullif(current_setting('test.role', true), '') $f$;
ALTER ROLE service_role BYPASSRLS;
SQL

PASS=0; FAIL=0
# mktemp exige que o padrão TERMINE em X (macOS): um sufixo depois do XXXXXX faz mkstemp falhar,
# e com `set -e` o harness aborta antes do primeiro assert — barulhento, que é o certo.
TMPF="$(mktemp "${TMPDIR:-/tmp}/fn-sabotada.XXXXXX")"
ok()  { PASS=$((PASS+1)); echo "  ✅ $1"; }
bad() { FAIL=$((FAIL+1)); echo "  ❌ $1"; }
eq()  { if [ "$2" = "$3" ]; then ok "$1 (=$2)"; else bad "$1 — esperado [$3], veio [$2]"; fi; }

echo "═══ setup pronto (PG17 :$PORT) ═══"

c1="11111111-1111-1111-1111-111111111111"
sys="33333333-3333-3333-3333-333333333333"
p1="aaaaaaaa-0000-0000-0000-000000000001"

# ── ZONA 1 — pré-requisitos de schema ────────────────────────────────────────────────────────
P -q <<'SQL'
CREATE TABLE public.omie_products (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), omie_codigo_produto bigint, account text);
CREATE TABLE public.sales_orders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_user_id uuid NOT NULL, created_by uuid NOT NULL,
  items jsonb NOT NULL DEFAULT '[]'::jsonb,
  subtotal numeric NOT NULL DEFAULT 0, discount numeric NOT NULL DEFAULT 0, total numeric NOT NULL DEFAULT 0,
  status text NOT NULL DEFAULT 'rascunho', notes text,
  omie_pedido_id bigint, omie_numero_pedido text,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  account text NOT NULL DEFAULT 'oben', hash_payload text,
  customer_address text, customer_phone text, order_date_kpi date,
  omie_payload jsonb, omie_response jsonb, lido_em timestamptz, omie_reconciliado_em timestamptz);
-- `desconto_valor` como em produção (20260908072658): numeric, NULLABLE, SEM DEFAULT. Um DEFAULT 0
-- aqui faria TODO assert de NULL passar por acidente do stub, provando o oposto do que se quer.
CREATE TABLE public.order_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sales_order_id uuid NOT NULL REFERENCES public.sales_orders(id) ON DELETE CASCADE,
  customer_user_id uuid NOT NULL,
  product_id uuid REFERENCES public.omie_products(id),
  omie_codigo_produto bigint,
  quantity numeric NOT NULL DEFAULT 1, unit_price numeric, discount numeric DEFAULT 0,
  desconto_valor numeric,
  omie_codigo_item bigint,
  created_at timestamptz DEFAULT now(), hash_payload text);
CREATE TABLE public.sales_price_history (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_user_id uuid NOT NULL, product_id uuid NOT NULL, unit_price numeric NOT NULL,
  sales_order_id uuid, created_at timestamptz NOT NULL DEFAULT now());
CREATE UNIQUE INDEX uniq_sales_orders_omie_hash
  ON public.sales_orders (account, hash_payload) WHERE hash_payload LIKE 'omie\_%';
SQL

# MOLDE — o schema da Zona 1, SEM migration e SEM dado. As seções G, H e I criam bancos a partir
# dele, por dois motivos: elas precisam do trigger de coerência da prod (que A-F não podem ter — a
# F2c depende da AUSÊNCIA dele), e o diferencial exige estado inicial idêntico para a função antiga
# e a nova. `-T` copia também os stubs de auth; as roles são do cluster.
"$PGBIN/createdb" -p "$PORT" -h /tmp -U postgres -T prove molde

# ── ZONA 2 — aplica a migration REAL (Lei #1) ────────────────────────────────────────────────
# `find`, não `ls`: SC2012 — e aqui não é purismo, o gate `lint:shell` entra em ZERO.
# `sort` porque a ordem do find não é garantida, e o alvo é a migration mais RECENTE
# com este slug (se um dia houver uma correção posterior, é ela que vale).
MIG="$(find "$REPO_ROOT/supabase/migrations" -name "*_desconto_valor_atravessa_os_escritores.sql" | sort | tail -1)"
[ -n "$MIG" ] || { echo "migration não encontrada — o harness testaria o NADA"; exit 1; }
P -q -f "$MIG"
echo "migration aplicada: $(basename "$MIG")"

# ── ZONA 3 — seed ────────────────────────────────────────────────────────────────────────────
P -q <<SQL
INSERT INTO auth.users(id) VALUES ('$c1'),('$sys') ON CONFLICT DO NOTHING;
INSERT INTO public.omie_products(id, omie_codigo_produto, account) VALUES ('$p1', 555, 'oben');
SQL

echo "═══ A · criar_pedidos_com_itens (ingestão) ═══"

# A1/A2/A3 num pedido só: os três estados da coluna têm de coexistir na MESMA escrita, senão o
# teste não distingue "grava o que veio" de "grava sempre a mesma coisa".
P -q <<SQL
SELECT public.criar_pedidos_com_itens('[{
  "customer_user_id": "$c1", "created_by": "$sys", "account": "oben",
  "hash_payload": "omie_oben_9001", "omie_pedido_id": 9001, "omie_numero_pedido": "9001",
  "items": [], "subtotal": 0, "discount": 0, "total": 0, "status": "importado",
  "itens": [
    {"omie_codigo_produto": 555, "quantity": 2, "unit_price": 100, "desconto_valor": 10, "hash_payload": "omie_oben_9001_555"},
    {"omie_codigo_produto": 556, "quantity": 1, "unit_price": 50,  "desconto_valor": 0,  "hash_payload": "omie_oben_9001_556"},
    {"omie_codigo_produto": 557, "quantity": 3, "unit_price": 20,                        "hash_payload": "omie_oben_9001_557"}
  ]}]'::jsonb);
SQL
A1=$(Pq -c "SELECT desconto_valor FROM public.order_items WHERE omie_codigo_produto=555;")
eq "A1 desconto informado chega inteiro na coluna" "$A1" "10"
A2=$(Pq -c "SELECT desconto_valor FROM public.order_items WHERE omie_codigo_produto=556;")
eq "A2 zero é DADO e é gravado como zero (não vira NULL)" "$A2" "0"
# O assert central da entrega. `IS NULL` explícito porque -tA devolve string vazia tanto para NULL
# quanto para '' — comparar com "" casaria os dois e o teste mentiria.
A3=$(Pq -c "SELECT desconto_valor IS NULL FROM public.order_items WHERE omie_codigo_produto=557;")
eq "A3 ausente vira NULL, NUNCA 0 (o coalesce que a coluna existe para evitar)" "$A3" "t"
A4=$(Pq -c "SELECT discount FROM public.order_items WHERE omie_codigo_produto=557;")
eq "A4 a coluna LEGADO segue com seu default 0 (esta entrega não a toca)" "$A4" "0"

echo "═══ B · aplicar_edicao_pedido_omie (o desconto sobrevive ao DELETE+INSERT) ═══"

SOID=$(Pq -c "SELECT id FROM public.sales_orders WHERE hash_payload='omie_oben_9001';")
P -q <<SQL
SELECT public.aplicar_edicao_pedido_omie(
  '$SOID'::uuid,
  '[{"omie_codigo_produto": 555, "quantidade": 2, "valor_unitario": 100, "desconto": null}]'::jsonb,
  '[{"omie_codigo_produto": 555, "quantity": 2, "unit_price": 100, "desconto_valor": 10}]'::jsonb,
  200, NULL, '{}'::jsonb, '{}'::jsonb, now());
SQL
B1=$(Pq -c "SELECT desconto_valor FROM public.order_items WHERE sales_order_id='$SOID' AND omie_codigo_produto=555;")
eq "B1 desconto apurado ATRAVESSA a edição (delete+insert não o come)" "$B1" "10"

P -q <<SQL
SELECT public.aplicar_edicao_pedido_omie(
  '$SOID'::uuid,
  '[{"omie_codigo_produto": 555, "quantidade": 2, "valor_unitario": 100, "desconto": null}]'::jsonb,
  '[{"omie_codigo_produto": 555, "quantity": 2, "unit_price": 100}]'::jsonb,
  200, NULL, '{}'::jsonb, '{}'::jsonb, now());
SQL
B2=$(Pq -c "SELECT desconto_valor IS NULL FROM public.order_items WHERE sales_order_id='$SOID' AND omie_codigo_produto=555;")
eq "B2 edição SEM desconto deixa NÃO APURADO, não fabrica 0" "$B2" "t"

echo "═══ C · reconciliar_pedidos_omie (invalida, não conserva) ═══"

P -q <<SQL
UPDATE public.order_items SET desconto_valor = 10
 WHERE sales_order_id='$SOID' AND omie_codigo_produto=555;
SELECT public.reconciliar_pedidos_omie('[{
  "account": "oben", "hash_payload": "omie_oben_9001", "omie_pedido_id": 9001,
  "status": "importado", "total": 240,
  "items": [{"omie_codigo_produto": 555, "quantidade": 2, "valor_unitario": 120, "desconto": 0}],
  "itens": [{"omie_codigo_produto": 555, "quantity": 2, "unit_price": 120, "discount": 0, "hash_payload": "omie_oben_9001_555"}]
  }]'::jsonb, ARRAY['importado','separacao','enviado','faturado','cancelado'], now());
SQL
C0=$(Pq -c "SELECT unit_price FROM public.order_items WHERE sales_order_id='$SOID' AND omie_codigo_produto=555;")
eq "C0 (controle) a reconciliação de fato mudou a base — sem isto, C1 passa por inércia" "$C0" "120"
C1=$(Pq -c "SELECT desconto_valor IS NULL FROM public.order_items WHERE sales_order_id='$SOID' AND omie_codigo_produto=555;")
eq "C1 base mudou → desconto INVALIDADO (não colado na base nova)" "$C1" "t"

echo "═══ D · a identidade de linha do #2405 sobrevive ao replace ═══"

# O #2405 mergeou em 2026-09-09 e a seção 1/3 foi REGENERADA sobre a versão dele. O risco deixou
# de ser "aplicar por cima e reverter" e passou a ser "regenerar de um snapshot velho e apagar" —
# mesmo dano, outra porta. A postcondição cobra os dois campos juntos; aqui prova-se que ela morde.
D0=$(Pq -c "SELECT position('omie_codigo_item' in pg_get_functiondef(p.oid)) > 0 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname='criar_pedidos_com_itens';")
eq "D0 a função aplicada carrega a identidade de linha do #2405" "$D0" "t"
D1=$(Pq -c "SELECT position('desconto_valor' in pg_get_functiondef(p.oid)) > 0 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname='criar_pedidos_com_itens';")
eq "D1 e o desconto canônico, na MESMA função (consolidada, não alternada)" "$D1" "t"

# Falsificação da cobrança: uma versão SEM omie_codigo_item tem de fazer a postcondição abortar.
SABD="/tmp/sabotado-identidade-${SLUG}.sql"
# Remove a coluna E o valor de forma CONSISTENTE. A primeira versão desta sabotagem comentava só
# o valor e deixava a vírgula de `v_created_at,` órfã: a migration morria de erro de SINTAXE, não
# na postcondição, e o assert lia "não abortou pela minha causa" como "não abortou". Sabotagem que
# quebra o arquivo por outro motivo não exercita o eixo que se quer medir.
perl -0pe 's/, omie_codigo_item\n/\n/; s/ *v_created_at,( *-- G6)\n *CASE WHEN \(SELECT ok FROM ga\) THEN c\.cid END\n/               v_created_at\1\n/' "$MIG" > "$SABD"
if grep -q "discount, desconto_valor, hash_payload, created_at, omie_codigo_item" "$SABD"; then
  bad "D2.0 a sabotagem da identidade NÃO removeu a coluna do INSERT — o assert seria teatro"
else
  ok "D2.0 (controle da sabotagem) a identidade foi removida do INSERT de fato"
  D2=$(P -q -v ON_ERROR_STOP=0 -f "$SABD" 2>&1 | grep -c "perdeu a coluna omie_codigo_item" || true)
  eq "D2 a postcondição ABORTA quando a identidade de linha some" "$D2" "1"
  P -q -f "$MIG" >/dev/null
fi

echo "═══ F · o total LÍQUIDO atravessa as RPCs INTOCADAS (2026-09-10) ═══"

# A entrega do subtotal líquido NÃO tem migration: a fórmula mudou na edge (`apurarSubtotalPedido`,
# _shared/omie-pedido.ts) e as RPCs seguem as mesmas. O que se prova aqui é que as RPCs, como estão
# em prod, fazem com o payload NOVO o que a decisão supõe — em especial o G5, que ficou intocado de
# propósito. Números do pedido real oben 12183048572: bruto 1629,25, desconto 139,91, líquido 1489,34.
P -q -c "DELETE FROM public.sales_orders WHERE hash_payload LIKE 'omie\_oben\_91%';" >/dev/null
itens_desc() {  # $1 = número do pedido. As duas linhas do pedido real, com o desconto apurado.
  echo "[{\"omie_codigo_produto\": 555, \"quantity\": 1, \"unit_price\": 460.25, \"desconto_valor\": 23.01, \"hash_payload\": \"omie_oben_$1_555\"},
         {\"omie_codigo_produto\": 556, \"quantity\": 2, \"unit_price\": 584.5,  \"desconto_valor\": 116.9, \"hash_payload\": \"omie_oben_$1_556\"}]"
}
criar() {  # $1 = número, $2 = total do payload, $3 = itens → devolve o jsonb da RPC
  Pq -c "SELECT public.criar_pedidos_com_itens('[{
    \"customer_user_id\": \"$c1\", \"created_by\": \"$sys\", \"account\": \"oben\",
    \"hash_payload\": \"omie_oben_$1\", \"omie_pedido_id\": $1, \"omie_numero_pedido\": \"$1\",
    \"items\": [], \"subtotal\": $2, \"discount\": 0, \"total\": $2, \"status\": \"importado\",
    \"itens\": $3}]'::jsonb);"
}
orfao_legado() {  # $1 = número, $2 = total gravado no NASCIMENTO (semântica antiga = bruto)
  P -q -c "INSERT INTO public.sales_orders (customer_user_id, created_by, items, subtotal, total, status, omie_pedido_id, account, hash_payload)
           VALUES ('$c1', '$sys', '[]', $2, $2, 'importado', $1, 'oben', 'omie_oben_$1');" >/dev/null
}
n_itens() { Pq -c "SELECT count(*) FROM public.order_items oi JOIN public.sales_orders so ON so.id = oi.sales_order_id WHERE so.hash_payload = 'omie_oben_$1';"; }

# F1 — pedido NOVO nasce com o total líquido, e o cabeçalho é a soma das linhas pela régua.
R=$(criar 9101 1489.34 "$(itens_desc 9101)")
eq "F1.0 (controle) o pedido novo entrou" "$(printf '%s' "$R" | grep -c '"inserted": 1')" "1"
F1=$(Pq -c "SELECT total FROM public.sales_orders WHERE hash_payload='omie_oben_9101';")
eq "F1 o cabeçalho guarda o LÍQUIDO que a edge mandou" "$F1" "1489.34"
F1b=$(Pq -c "SELECT so.total = sum(oi.quantity * oi.unit_price - oi.desconto_valor)
               FROM public.sales_orders so JOIN public.order_items oi ON oi.sales_order_id = so.id
              WHERE so.hash_payload='omie_oben_9101' GROUP BY so.total;")
eq "F1b cabeçalho == Σ (qtd·preço − desconto_valor) das linhas — a identidade que a passada no acervo vai usar" "$F1b" "t"

# F2 — a premissa do G5 intocado. Um órfão cujo pai nasceu com o total BRUTO (semântica antiga)
# recebe o payload LÍQUIDO: o G5 RECUSA e reporta, em vez de reparar com cabeçalho que não
# descreve as linhas. É fail-closed, e é o comportamento certo para a transição.
orfao_legado 9102 1629.25
R=$(criar 9102 1489.34 "$(itens_desc 9102)")
eq "F2 órfão legado BRUTO × payload LÍQUIDO → divergência reportada" "$(printf '%s' "$R" | grep -c '"divergence": \[{')" "1"
eq "F2a e NÃO reparado (nenhuma linha inserida)" "$(n_itens 9102)" "0"

# F2b — o formato do ÚNICO órfão de prod (total 0, items vazio). O veredito não depende da
# fórmula: com o bruto (1629,25) ele já divergia; com o líquido (1489,34) segue divergindo.
orfao_legado 9103 0
R=$(criar 9103 1629.25 "$(itens_desc 9103)")
eq "F2b.0 o formato do órfão real (total 0) já divergia com o payload BRUTO (a fórmula antiga)" "$(printf '%s' "$R" | grep -c '"divergence": \[{')" "1"
R=$(criar 9103 1489.34 "$(itens_desc 9103)")
eq "F2b e segue divergindo com o LÍQUIDO — a mudança de fórmula não muda o veredito dele" "$(printf '%s' "$R" | grep -c '"divergence": \[{')" "1"

# F2c — CONTROLE de F2: sem desconto, bruto == líquido e o reparo passa. Sem este, F2 seria
# indistinguível de um G5 que recusa tudo.
orfao_legado 9104 200
R=$(criar 9104 200 '[{"omie_codigo_produto": 555, "quantity": 2, "unit_price": 100, "desconto_valor": 0, "hash_payload": "omie_oben_9104_555"}]')
eq "F2c (controle) órfão SEM desconto é reparado normalmente" "$(printf '%s' "$R" | grep -c '"repaired": 1')" "1"

# F3 — o reprocess converge o legado: pedido COM linhas, gravado bruto, reconciliado com o payload
# líquido. O cabeçalho vira o líquido numa passada e a segunda leitura não reescreve mais nada.
R=$(criar 9105 1629.25 "$(itens_desc 9105)")
# O carimbo vai no PASSADO e cresce: a RPC recusa `p_lido_em` no futuro (guard do compare-and-set
# contra relógio envenenado do chamador), então "+N minutos" aqui seria teste instável ou vermelho.
reconc() {  # $1 = número, $2 = total, $3 = deslocamento do carimbo em minutos (negativo = passado)
  Pq -c "SELECT public.reconciliar_pedidos_omie('[{
    \"account\": \"oben\", \"hash_payload\": \"omie_oben_$1\", \"omie_pedido_id\": $1, \"total\": $2, \"items\": [],
    \"itens\": [{\"omie_codigo_produto\": 555, \"quantity\": 1, \"unit_price\": 460.25, \"discount\": 0, \"hash_payload\": \"omie_oben_$1_555\"},
                {\"omie_codigo_produto\": 556, \"quantity\": 2, \"unit_price\": 584.5,  \"discount\": 0, \"hash_payload\": \"omie_oben_$1_556\"}]
    }]'::jsonb, ARRAY['importado','separacao','enviado','faturado','cancelado'], now() + interval '$3 minutes') ->> 'divergences';"
}
eq "F3.0 a 1ª reconciliação conta a mudança de total" "$(reconc 9105 1489.34 -2)" "1"
F3=$(Pq -c "SELECT total || '/' || subtotal FROM public.sales_orders WHERE hash_payload='omie_oben_9105';")
eq "F3 total E subtotal convergem para o líquido numa passada" "$F3" "1489.34/1489.34"
F3b=$(Pq -c "SELECT string_agg(desconto_valor::text, ',' ORDER BY omie_codigo_produto) FROM public.order_items oi JOIN public.sales_orders so ON so.id = oi.sales_order_id WHERE so.hash_payload='omie_oben_9105';")
eq "F3b as linhas (base inalterada) conservam o desconto apurado" "$F3b" "23.01,116.9"
eq "F3c a 2ª leitura igual não conta divergência — convergiu, não oscila" "$(reconc 9105 1489.34 -1)" "0"

# F4 — sem desconto, a fórmula nova dá o MESMO número: a reconciliação não reescreve o total.
R=$(criar 9106 200 '[{"omie_codigo_produto": 555, "quantity": 2, "unit_price": 100, "desconto_valor": 0, "hash_payload": "omie_oben_9106_555"}]')
eq "F4 pedido sem desconto: nenhuma divergência de total na reconciliação" "$(P -tA -c "SELECT public.reconciliar_pedidos_omie('[{\"account\": \"oben\", \"hash_payload\": \"omie_oben_9106\", \"omie_pedido_id\": 9106, \"total\": 200, \"items\": [], \"itens\": [{\"omie_codigo_produto\": 555, \"quantity\": 2, \"unit_price\": 100, \"discount\": 0, \"hash_payload\": \"omie_oben_9106_555\"}]}]'::jsonb, ARRAY['importado','separacao','enviado','faturado','cancelado'], now() - interval '1 minute') ->> 'divergences';")" "0"

# F5 — FALSIFICAÇÃO de F2, com o conserto REJEITADO como sabotagem: aumentar a tolerância do G5.
# Com uma tolerância maior que o desconto, o mesmo órfão legado passa a ser REPARADO com o cabeçalho
# bruto sobre linhas líquidas — duas portas de aprovação, e a errada abre. Se F5 não ficar vermelho,
# F2 não tem dente. O controle é F2, na MESMA invocação e com a função verdadeira, logo acima.
SABG5="/tmp/sabotado-g5-${SLUG}.sql"
sed 's/v_pl_total) > 0\.01/v_pl_total) > 200/' "$MIG" > "$SABG5"
if ! grep -q "v_pl_total) > 200" "$SABG5"; then
  bad "F5.0 a sabotagem da tolerância NÃO alterou o G5 — a falsificação seria teatro"
else
  ok "F5.0 (controle da sabotagem) o G5 passou a tolerar R\$ 200"
  awk '/^CREATE OR REPLACE FUNCTION public.criar_pedidos_com_itens/{d=1} d{print} d&&/^;$/{exit}' "$SABG5" > "$TMPF"
  [ -s "$TMPF" ] || bad "F5.0b o recorte da função sabotada saiu VAZIO"
  P -q -v ON_ERROR_STOP=1 -f "$TMPF" >/dev/null
  orfao_legado 9107 1629.25
  R=$(criar 9107 1489.34 "$(itens_desc 9107)")
  if [ "$(n_itens 9107)" = "2" ]; then
    ok "F5 com tolerância, o órfão legado é REPARADO sob cabeçalho bruto — F2 tem dente"
  else
    bad "F5 sabotado, o órfão legado NÃO foi reparado (itens=$(n_itens 9107)) — F2 pode passar por outro motivo"
  fi
  P -q -f "$MIG" >/dev/null   # restaura a função verdadeira (a migration inteira é idempotente)
  R=$(criar 9108 1489.34 "$(itens_desc 9108)")
  eq "F5r (restauração) a função verdadeira voltou: pedido novo entra de novo" "$(printf '%s' "$R" | grep -c '"inserted": 1')" "1"
fi

echo "═══ E · FALSIFICAÇÃO (Lei #3): sabota → exige VERMELHO → restaura ═══"

# E1 — o coalesce(...,0) na ingestão. Se este assert não ficar vermelho, A3 não tem dente e todo
# o resto da prova é decoração: a coluna aceitaria "desconto zero" carimbado no acervo inteiro.
SAB="/tmp/sabotado-${SLUG}.sql"
sed "s/(\(c\.\)\{0,1\}it->>'desconto_valor')::numeric,/coalesce((\1it->>'desconto_valor')::numeric, 0),/g" "$MIG" > "$SAB"
if ! grep -q "coalesce((c.it->>'desconto_valor')::numeric, 0)" "$SAB"; then
  bad "E0 a sabotagem NÃO alterou a seção 1/3 (a que o assert observa) — a falsificação seria teatro"
else
  ok "E0 (controle da sabotagem) o texto mudou de fato"
  P -q -c "DROP TABLE IF EXISTS public.order_items CASCADE;" >/dev/null 2>&1 || true
  P -q <<'SQL'
CREATE TABLE public.order_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sales_order_id uuid NOT NULL REFERENCES public.sales_orders(id) ON DELETE CASCADE,
  customer_user_id uuid NOT NULL, product_id uuid REFERENCES public.omie_products(id),
  omie_codigo_produto bigint, quantity numeric NOT NULL DEFAULT 1, unit_price numeric,
  discount numeric DEFAULT 0, desconto_valor numeric, omie_codigo_item bigint,
  created_at timestamptz DEFAULT now(), hash_payload text);
SQL
  # A postcondição da PRÓPRIA migration deve barrar o coalesce. Se ela deixar passar, o arquivo
  # sabotado aplica limpo — e é isso que este assert mede.
  E1=$(P -q -v ON_ERROR_STOP=0 -f "$SAB" 2>&1 | grep -c "coalesce(desconto_valor, 0)" || true)
  eq "E1 a POSTCONDIÇÃO pega o coalesce(...,0) sabotado" "$E1" "1"

  # E2 — mesmo com a postcondição, prove o EFEITO: com o coalesce, o ausente deixa de ser NULL.
  # Postcondição e efeito são camadas distintas; sabotar uma por vez é o que distingue as duas.
  P -q -c "DROP FUNCTION IF EXISTS public.criar_pedidos_com_itens(jsonb);" >/dev/null
  # Recorte da função sabotada. O `-s` é o CONTROLE: recorte vazio faria o assert abaixo medir um
  # pedido que nunca foi criado, e "não virou 0" leria-se como aprovação. E o erro do apply vai
  # para o log em vez de ser engolido — foi assim que a quebra do delimitador passou despercebida.
  awk '/^CREATE OR REPLACE FUNCTION public.criar_pedidos_com_itens/{d=1} d{print} d&&/^;$/{exit}' "$SAB" > "$TMPF"
  [ -s "$TMPF" ] || bad "E2.0 o recorte da função sabotada saiu VAZIO — o assert abaixo mediria o nada"
  P -q -v ON_ERROR_STOP=1 -f "$TMPF" > "$TMPF.log" 2>&1 || true
  P -q -c "DELETE FROM public.sales_orders;" >/dev/null
  P -q > "$TMPF.pedido.log" 2>&1 <<SQL || true
SELECT public.criar_pedidos_com_itens('[{
  "customer_user_id": "$c1", "created_by": "$sys", "account": "oben",
  "hash_payload": "omie_oben_9002", "omie_pedido_id": 9002, "omie_numero_pedido": "9002",
  "items": [], "subtotal": 0, "discount": 0, "total": 0, "status": "importado",
  "itens": [{"omie_codigo_produto": 557, "quantity": 3, "unit_price": 20, "hash_payload": "omie_oben_9002_557"}]}]'::jsonb);
SQL
  if grep -qi "erro\|error" "$TMPF.pedido.log"; then
    bad "E2.1 a criação do pedido sabotado FALHOU — o assert abaixo mediria ausência, não efeito: $(cut -c1-160 "$TMPF.pedido.log" | head -2 | tr '\n' ' ')"
  fi
  E2N=$(Pq -c "SELECT count(*) FROM public.order_items WHERE omie_codigo_produto=557;")
  if [ "$E2N" != "1" ]; then
    bad "E2.2 esperava exatamente 1 linha do SKU 557, vieram [$E2N] — o assert abaixo mediria o nada"
  fi
  # `is_null` explícito: `-tA` devolve string vazia tanto para NULL quanto para '', e comparar com
  # "" casaria os dois. O que se quer saber é se o coalesce sabotado transformou NULL em 0.
  E2=$(Pq -c "SELECT coalesce(desconto_valor::text, 'NULO') FROM public.order_items WHERE omie_codigo_produto=557;")
  if [ "$E2" = "0" ]; then
    ok "E2 sabotado, o ausente VIRA 0 — A3 tem dente (é este número que ele barra)"
    PASS=$((PASS+1))
  else
    bad "E2 sabotado, o ausente NÃO virou 0 (veio [$E2]) — A3 pode estar passando por outro motivo"
  fi
fi

# E3 — a conservação na reconciliação. Sabota `desconto_valor = NULL` → o valor antigo fica
# colado na base nova. É o defeito que o Codex apontou, e ele não produz erro nenhum.
P -q -c "DROP FUNCTION IF EXISTS public.criar_pedidos_com_itens(jsonb);" >/dev/null
P -q -f "$MIG" >/dev/null
SAB3="/tmp/sabotado3-${SLUG}.sql"
sed "s/                 desconto_valor = NULL,/                 desconto_valor = coalesce(NULL, oi.desconto_valor),/" "$MIG" > "$SAB3"
if ! grep -q "coalesce(NULL, oi.desconto_valor)" "$SAB3"; then
  bad "E3.0 a sabotagem da reconciliação NÃO alterou o arquivo — assert seria teatro"
else
  ok "E3.0 (controle da sabotagem) o texto da reconciliação mudou de fato"
  awk '/^CREATE OR REPLACE FUNCTION public.reconciliar_pedidos_omie/{d=1} d{print} d&&/^;$/{exit}' "$SAB3" > "$TMPF"
  [ -s "$TMPF" ] || bad "E3.0b o recorte da reconciliação sabotada saiu VAZIO"
  P -q -v ON_ERROR_STOP=1 -f "$TMPF" >/dev/null
  P -q -c "DELETE FROM public.sales_orders;" >/dev/null
  P -q <<SQL >/dev/null
SELECT public.criar_pedidos_com_itens('[{
  "customer_user_id": "$c1", "created_by": "$sys", "account": "oben",
  "hash_payload": "omie_oben_9003", "omie_pedido_id": 9003, "omie_numero_pedido": "9003",
  "items": [], "subtotal": 0, "discount": 0, "total": 0, "status": "importado",
  "itens": [{"omie_codigo_produto": 555, "quantity": 2, "unit_price": 100, "desconto_valor": 10, "hash_payload": "omie_oben_9003_555"}]}]'::jsonb);
SQL
  SO3=$(Pq -c "SELECT id FROM public.sales_orders WHERE hash_payload='omie_oben_9003';")
  P -q <<SQL >/dev/null
SELECT public.reconciliar_pedidos_omie('[{
  "account": "oben", "hash_payload": "omie_oben_9003", "omie_pedido_id": 9003,
  "status": "importado", "total": 240,
  "items": [{"omie_codigo_produto": 555, "quantidade": 2, "valor_unitario": 120, "desconto": 0}],
  "itens": [{"omie_codigo_produto": 555, "quantity": 2, "unit_price": 120, "discount": 0, "hash_payload": "omie_oben_9003_555"}]
  }]'::jsonb, ARRAY['importado','separacao','enviado','faturado','cancelado'], now());
SQL
  E3=$(Pq -c "SELECT desconto_valor FROM public.order_items WHERE sales_order_id='$SO3' AND omie_codigo_produto=555;")
  if [ "$E3" = "10" ]; then
    ok "E3 sabotado, o desconto de 10 fica COLADO na base 120 — C1 tem dente"
    PASS=$((PASS+1))
  else
    bad "E3 sabotado, o desconto não se conservou (veio [$E3]) — C1 pode passar por inércia"
  fi
fi

# ═════════════════════════════════════════════════════════════════════════════════════════════════
# G · H · I — reconciliar_pedidos_omie CARREGA o desconto da linha e isola o pedido incoerente
# (migration *_reconciliar_carrega_desconto_e_isola_coerencia.sql, 2026-09-14).
#
# Bancos PRÓPRIOS, criados do MOLDE, com a cadeia REAL da prod: os 3 escritores ($MIG) + o trigger
# DEFERRED de coerência do agregado. Sem o trigger, um fixture incoerente passaria e o assert
# mediria uma capacidade de commit que a prod não tem — foi o que o parecer Codex apontou nas §A-F.
# ═════════════════════════════════════════════════════════════════════════════════════════════════
MIG_COER="$REPO_ROOT/supabase/migrations/20260907220000_pedido_venda_coerencia_agregado.sql"
MIG_RECONC="$(find "$REPO_ROOT/supabase/migrations" -name "*_reconciliar_carrega_desconto_e_isola_coerencia.sql" | sort | tail -1)"
[ -n "$MIG_RECONC" ] || { echo "migration da reconciliação não encontrada — G/H/I testariam o NADA"; exit 1; }
MD5_BASE="136b40ad30ac7bec2a8105907b1e9fa6"   # md5(prosrc) de reconciliar_pedidos_omie em PROD, 2026-09-14

DB=""
Q()   { "$PGBIN/psql" -p "$PORT" -h /tmp -U postgres -d "$DB" -v ON_ERROR_STOP=1 -tA -c "$1"; }
Qf()  { "$PGBIN/psql" -p "$PORT" -h /tmp -U postgres -d "$DB" -v ON_ERROR_STOP=1 -q -c "SET client_min_messages = warning" -f "$1"; }
Qft() { "$PGBIN/psql" -p "$PORT" -h /tmp -U postgres -d "$DB" -v ON_ERROR_STOP=1 -q -tA -f "$1"; }
tem() { if grep -q -- "$2" <<< "$1"; then echo sim; else echo nao; fi; }

# Helpers de TESTE (schema `teste`, só nestes bancos). Montam o pedido como a edge monta: items-jsonb
# e linhas descrevendo o MESMO multiconjunto. Item do fixture: {"cod","q","p","cid"?,"dv"?} — a
# PRESENÇA de "dv" decide a presença de "desconto_valor" no payload, que é o eixo edge nova × velha.
HELPERS_SQL=$(cat <<'SQL'
CREATE SCHEMA IF NOT EXISTS teste;
CREATE OR REPLACE FUNCTION teste.itens_rpc(p_num bigint, p_itens jsonb) RETURNS jsonb LANGUAGE sql AS $f$
  SELECT coalesce(jsonb_agg(
           jsonb_build_object('omie_codigo_produto', (i->>'cod')::bigint, 'quantity', i->'q',
                              'unit_price', i->'p', 'discount', 0,
                              'hash_payload', 'omie_oben_' || p_num || '_' || (i->>'cod'))
           || CASE WHEN i ? 'cid' THEN jsonb_build_object('omie_codigo_item', i->'cid') ELSE '{}'::jsonb END
           || CASE WHEN i ? 'dv'  THEN jsonb_build_object('desconto_valor', i->'dv')    ELSE '{}'::jsonb END
           || CASE WHEN i ? 'pid' THEN jsonb_build_object('product_id', i->'pid')       ELSE '{}'::jsonb END
           ORDER BY o), '[]'::jsonb)
    FROM jsonb_array_elements(p_itens) WITH ORDINALITY AS t(i, o)
$f$;
CREATE OR REPLACE FUNCTION teste.items_json(p_itens jsonb) RETURNS jsonb LANGUAGE sql AS $f$
  SELECT coalesce(jsonb_agg(jsonb_build_object('omie_codigo_produto', (i->>'cod')::bigint, 'descricao', 'x',
           'quantidade', i->'q', 'valor_unitario', i->'p', 'desconto', 0) ORDER BY o), '[]'::jsonb)
    FROM jsonb_array_elements(p_itens) WITH ORDINALITY AS t(i, o)
$f$;
CREATE OR REPLACE FUNCTION teste.criar(p_num bigint, p_itens jsonb, p_total numeric) RETURNS jsonb LANGUAGE sql AS $f$
  SELECT public.criar_pedidos_com_itens(jsonb_build_array(jsonb_build_object(
    'customer_user_id', '11111111-1111-1111-1111-111111111111', 'created_by', '33333333-3333-3333-3333-333333333333',
    'account', 'oben', 'hash_payload', 'omie_oben_' || p_num, 'omie_pedido_id', p_num,
    'omie_numero_pedido', p_num::text, 'items', teste.items_json(p_itens), 'subtotal', p_total,
    'discount', 0, 'total', p_total, 'status', 'importado', 'itens', teste.itens_rpc(p_num, p_itens))))
$f$;
-- p_items_extra: entradas a mais SÓ no items-jsonb — o formato de pedido que o banco recusa
CREATE OR REPLACE FUNCTION teste.pedido_rpc(p_num bigint, p_itens jsonb, p_total numeric, p_items_extra jsonb DEFAULT '[]')
RETURNS jsonb LANGUAGE sql AS $f$
  SELECT jsonb_build_object('account', 'oben', 'hash_payload', 'omie_oben_' || p_num, 'omie_pedido_id', p_num,
    'status_omie', NULL, 'total', p_total,
    'items', teste.items_json(p_itens) || p_items_extra, 'itens', teste.itens_rpc(p_num, p_itens))
$f$;
CREATE OR REPLACE FUNCTION teste.reconc(p_pedidos jsonb, p_min int) RETURNS jsonb LANGUAGE sql AS $f$
  SELECT public.reconciliar_pedidos_omie(p_pedidos, ARRAY['importado','separacao','enviado','faturado','cancelado'],
                                         now() + make_interval(mins => p_min))
$f$;
CREATE OR REPLACE FUNCTION teste.linha(p_num bigint, p_cod bigint) RETURNS public.order_items LANGUAGE sql AS $f$
  SELECT oi.* FROM public.order_items oi JOIN public.sales_orders so ON so.id = oi.sales_order_id
   WHERE so.hash_payload = 'omie_oben_' || p_num AND oi.omie_codigo_produto = p_cod
$f$;
-- dois produtos para os cenários com product_id (G15): a FK de order_items exige a linha
INSERT INTO public.omie_products (id, omie_codigo_produto, account) VALUES
  ('aaaaaaaa-0000-0000-0000-000000000555', 555, 'oben'),
  ('aaaaaaaa-0000-0000-0000-000000000556', 556, 'oben')
ON CONFLICT (id) DO NOTHING;
SQL
)

novo_banco() {  # $1 = banco, $2 = nova|antiga. Deixa DB apontando para ele.
  DB="$1"
  "$PGBIN/createdb" -p "$PORT" -h /tmp -U postgres -T molde "$DB"
  Qf "$MIG" >/dev/null
  Qf "$MIG_COER" >/dev/null
  if [ "$2" = "nova" ]; then Qf "$MIG_RECONC" >/dev/null; fi
  Q "$HELPERS_SQL" >/dev/null
}
cria()    { Q "SELECT teste.criar($1, '$2', $3)" >/dev/null; }
reconc1() { Q "SELECT teste.reconc(jsonb_build_array(teste.pedido_rpc($1, '$2', $3)), $4)"; }  # num itens total minutos
jget()    { Q "SELECT \$j\$$1\$j\$::jsonb ->> '$2'"; }
sens()    { Q "SELECT concat_ws('/', r->>'corrections', r->>'desconto_corrigido', r->>'desconto_apurado', r->>'identidade_adotada') FROM (SELECT \$j\$$1\$j\$::jsonb AS r) x"; }
dv()      { Q "SELECT coalesce((teste.linha($1, $2)).desconto_valor::text, 'NULO')"; }
precos()  { Q "SELECT string_agg((teste.linha(n, 555)).unit_price::text, ',' ORDER BY n) FROM unnest(ARRAY[9301,9302,9303]) n"; }

echo "═══ G · reconciliar_pedidos_omie CARREGA o desconto da linha ═══"
novo_banco prove_g nova

MD5_NOVO="$(grep -o "'$MD5_BASE', '[0-9a-f]\{32\}'" "$MIG_RECONC" | grep -o "'[0-9a-f]\{32\}'\$" | tr -d "'" || true)"
eq "G0 o corpo aplicado é o que a PRÉ-CONDIÇÃO declara (md5 do prosrc == o da migration)" \
  "$(Q "SELECT md5(prosrc) FROM pg_proc WHERE proname='reconciliar_pedidos_omie'")" "$MD5_NOVO"
eq "G0b reaplicar a migration é idempotente (a pré-condição aceita o próprio corpo)" \
  "$(if Qf "$MIG_RECONC" >/dev/null 2>&1; then echo sim; else echo nao; fi)" "sim"

# G1 — o cenário do parecer: linha 1×100 com desconto 10; o Omie muda SÓ o desconto para 20.
cria 9201 '[{"cod":555,"q":1,"p":100,"dv":10}]' 90
eq "G1.0 (controle) a linha nasce com desconto 10 sob total 90" "$(dv 9201 555)/$(Q "SELECT total FROM public.sales_orders WHERE hash_payload='omie_oben_9201'")" "10/90"
R=$(reconc1 9201 '[{"cod":555,"q":1,"p":100,"dv":20}]' 80 -10)
eq "G1 SÓ o desconto mudou no Omie → a linha passa a 20 (antes: seguia 10 sob o pai 80)" "$(dv 9201 555)" "20"
eq "G1b o pai recebe o total líquido novo" "$(Q "SELECT total FROM public.sales_orders WHERE hash_payload='omie_oben_9201'")" "80"
eq "G1c pai == Σ(qtd·preço − desconto_valor): a conta do fin-valor-cockpit fecha" \
  "$(Q "SELECT so.total = sum(oi.quantity * oi.unit_price - oi.desconto_valor) FROM public.sales_orders so JOIN public.order_items oi ON oi.sales_order_id = so.id WHERE so.hash_payload='omie_oben_9201' GROUP BY so.total")" "t"
eq "G1d conta como CORREÇÃO de desconto (corrections/corrigido/apurado/adotada)" "$(sens "$R")" "1/1/0/0"

# G2 — idempotência: a 2ª leitura igual não reescreve a linha nem conta nada.
X0=$(Q "SELECT xmin FROM public.order_items WHERE id = (teste.linha(9201, 555)).id")
R=$(reconc1 9201 '[{"cod":555,"q":1,"p":100,"dv":20}]' 80 -9)
eq "G2 2ª leitura igual: linha intocada (xmin) e nada contado" "$(Q "SELECT xmin FROM public.order_items WHERE id = (teste.linha(9201, 555)).id")|$(sens "$R")" "$X0|0/0/0/0"

# G3/G4 — chave PRESENTE com null (item sem preço cujo desconto a régua não sabe converter).
cria 9202 '[{"cod":555,"q":1,"p":100,"dv":0},{"cod":556,"q":2,"p":null,"dv":5}]' 100
eq "G3.0 (controle) a linha sem preço nasce com desconto 5" "$(dv 9202 556)" "5"
R=$(reconc1 9202 '[{"cod":555,"q":1,"p":100,"dv":0},{"cod":556,"q":2,"p":null,"dv":null}]' 100 -10)
eq "G3 null PRESENTE sobre desconto conhecido → NULL (não apurado): nunca conserva o 5" "$(dv 9202 556)" "NULO"
eq "G3b é correção de desconto conhecido" "$(sens "$R")" "1/1/0/0"
X0=$(Q "SELECT xmin FROM public.order_items WHERE id = (teste.linha(9202, 556)).id")
R=$(reconc1 9202 '[{"cod":555,"q":1,"p":100,"dv":0},{"cod":556,"q":2,"p":null,"dv":null}]' 100 -9)
eq "G4 NULL==NULL: a leitura seguinte, ainda ilegível, não reescreve (xmin) nem conta" "$(Q "SELECT xmin FROM public.order_items WHERE id = (teste.linha(9202, 556)).id")|$(sens "$R")" "$X0|0/0/0/0"

# G5 — APURAÇÃO: linha legado NULL, a leitura informa "sem desconto".
cria 9203 '[{"cod":555,"q":2,"p":50}]' 100
eq "G5.0 (controle) a linha legado nasce NÃO APURADA" "$(dv 9203 555)" "NULO"
R=$(reconc1 9203 '[{"cod":555,"q":2,"p":50,"dv":0}]' 100 -10)
eq "G5 a leitura diz 'sem desconto' → 0 gravado (zero é DADO, não NULL)" "$(dv 9203 555)" "0"
eq "G5b apuração NÃO é correção nem adoção: corrections 0, corrigido 0, apurado 1, adotada 0" "$(sens "$R")" "0/0/1/0"
eq "G5c e não conta upsert (o cabeçalho não mudou de conteúdo)" "$(jget "$R" upserts)" "0"

# G6/G7 — a base mudou: com a chave, grava o desconto da base NOVA; sem ela, invalida como antes.
cria 9204 '[{"cod":555,"q":1,"p":100,"dv":10}]' 90
reconc1 9204 '[{"cod":555,"q":1,"p":120,"dv":12}]' 108 -10 >/dev/null
eq "G6 base E desconto mudaram → preço 120 com desconto 12 (nem NULL, nem o 10 velho)" "$(Q "SELECT (teste.linha(9204, 555)).unit_price")/$(dv 9204 555)" "120/12"
cria 9205 '[{"cod":555,"q":1,"p":100,"dv":10}]' 90
reconc1 9205 '[{"cod":555,"q":1,"p":120}]' 120 -10 >/dev/null
eq "G7 payload SEM a chave (edge velha) e base mudada → NULL, a regra de antes" "$(dv 9205 555)" "NULO"

# G8 — linha NOVA.
cria 9206 '[{"cod":555,"q":1,"p":100,"dv":0}]' 100
reconc1 9206 '[{"cod":555,"q":1,"p":100,"dv":0},{"cod":557,"q":1,"p":50,"dv":5}]' 145 -10 >/dev/null
eq "G8 linha NOVA nasce com o desconto lido" "$(dv 9206 557)" "5"

# G9 — lixo não é desconto, e lixo não vira 0.
n=9207
for lixo in '-5' '"NaN"' '"Infinity"'; do
  cria "$n" '[{"cod":555,"q":1,"p":100,"dv":10}]' 90
  reconc1 "$n" "[{\"cod\":555,\"q\":1,\"p\":100,\"dv\":$lixo}]" 100 -10 >/dev/null
  eq "G9 desconto lixo ($lixo) vira NULL — nem conserva o 10, nem vira 0" "$(dv "$n" 555)" "NULO"
  n=$((n + 1))
done

# G10 — adoção de identidade JUNTO com desconto mudado.
cria 9210 '[{"cod":555,"q":1,"p":100,"dv":10}]' 90
R=$(reconc1 9210 '[{"cod":555,"q":1,"p":100,"cid":7001,"dv":20}]' 80 -10)
eq "G10 identidade e desconto gravados juntos" "$(Q "SELECT (teste.linha(9210, 555)).omie_codigo_item")/$(dv 9210 555)" "7001/20"
eq "G10b conta como correção, não como adoção pura" "$(sens "$R")" "1/1/0/0"

# G11 — mesma linha (codigo_item) com OUTRO SKU no Omie: o SKU é gravado, e o banco aceita.
cria 9211 '[{"cod":555,"q":1,"p":100,"cid":7101,"dv":10}]' 90
R=$(reconc1 9211 '[{"cod":556,"q":1,"p":100,"cid":7101,"dv":20}]' 80 -10)
eq "G11 SKU trocado sob o mesmo codigo_item: linha 556 com desconto 20, sem falha" \
  "$(Q "SELECT string_agg(oi.omie_codigo_produto || '/' || oi.desconto_valor, ',') FROM public.order_items oi JOIN public.sales_orders so ON so.id = oi.sales_order_id WHERE so.hash_payload='omie_oben_9211'")|$(jget "$R" falhas)" "556/20|[]"

# G12 — diferença abaixo da tolerância: a linha CONVERGE ao valor exato do jsonb.
cria 9212 '[{"cod":555,"q":1,"p":100,"dv":0}]' 100
R=$(reconc1 9212 '[{"cod":555,"q":1,"p":100.0000004,"dv":0}]' 100 -10)
eq "G12 ruído de 4e-7 no preço: converge exato, sem falha e sem contar correção" \
  "$(Q "SELECT (teste.linha(9212, 555)).unit_price")|$(jget "$R" falhas)|$(sens "$R")" "100.0000004|[]|0/0/0/0"

# G13-G15 — cenários adversariais da validação INDEPENDENTE por execução feita pela sessão
# quirky-rosalind-ac9c16 (2026-09-14, 31/31 contra esta migration): casamento por `omie_codigo_item`
# com o SKU mudando de dono dentro do pedido.
P555="aaaaaaaa-0000-0000-0000-000000000555"
P556="aaaaaaaa-0000-0000-0000-000000000556"
skus_por_id() {  # $1 = pedido → "cid:sku:produto,…" em ordem de identidade
  Q "SELECT string_agg(oi.omie_codigo_item || ':' || oi.omie_codigo_produto || ':' || coalesce(right(oi.product_id::text, 3), 'nulo'), ',' ORDER BY oi.omie_codigo_item) FROM public.order_items oi JOIN public.sales_orders so ON so.id = oi.sales_order_id WHERE so.hash_payload = 'omie_oben_$1'"
}
# G13 (H1b) — identidades PERMUTADAS entre duas linhas de conteúdo diferente.
cria 9213 '[{"cod":555,"q":1,"p":100,"cid":7301,"dv":0},{"cod":556,"q":2,"p":50,"cid":7302,"dv":0}]' 200
R=$(reconc1 9213 '[{"cod":556,"q":1,"p":100,"cid":7301,"dv":0},{"cod":555,"q":2,"p":50,"cid":7302,"dv":0}]' 200 -10)
eq "G13 identidades permutadas: cada codigo_item fica com o SKU que o Omie deu a ele, sem falha" "$(skus_por_id 9213)|$(jget "$R" falhas)" "7301:556:nulo,7302:555:nulo|[]"
# G14 (H1c) — SÓ o SKU mudou (product_id NULL dos dois lados, desconto igual). É o termo `a.cod` da
# decisão exata que reescreve a linha: sem ele nada mais difere, e o banco recusaria o agregado.
cria 9214 '[{"cod":555,"q":1,"p":100,"cid":7401,"dv":0}]' 100
R=$(reconc1 9214 '[{"cod":556,"q":1,"p":100,"cid":7401,"dv":0}]' 100 -10)
eq "G14 só o SKU mudou sob a mesma identidade: reescreve, conta correção, sem falha" "$(skus_por_id 9214)|$(jget "$R" corrections)|$(jget "$R" falhas)" "7401:556:nulo|1|[]"
# G15 (H1d) — duas linhas de conteúdo IDÊNTICO, identidades permutadas, product_id preenchido. O
# multiconjunto que o trigger compara (SKU, qtd, preço, desconto) é o MESMO antes e depois: se o SKU não
# for gravado, o banco ACEITA e o product_id de um produto fica colado no SKU do outro — a chave de
# custo da margem trocada em silêncio (H4c mostra a função antiga fazendo exatamente isso).
LINHAS_G15_ANTES="[{\"cod\":555,\"q\":1,\"p\":100,\"cid\":7501,\"pid\":\"$P555\",\"dv\":0},{\"cod\":556,\"q\":1,\"p\":100,\"cid\":7502,\"pid\":\"$P556\",\"dv\":0}]"
LINHAS_G15_DEPOIS="[{\"cod\":556,\"q\":1,\"p\":100,\"cid\":7501,\"pid\":\"$P556\",\"dv\":0},{\"cod\":555,\"q\":1,\"p\":100,\"cid\":7502,\"pid\":\"$P555\",\"dv\":0}]"
cria 9215 "$LINHAS_G15_ANTES" 200
R=$(reconc1 9215 "$LINHAS_G15_DEPOIS" 200 -10)
eq "G15 conteúdo idêntico com identidades permutadas: cada SKU fica com o SEU produto" "$(skus_por_id 9215)|$(jget "$R" falhas)" "7501:556:556,7502:555:555|[]"

echo "═══ H · um pedido incoerente vira FALHA DO PEDIDO — não derruba a chamada ═══"
# Lote de 3: 9301 e 9303 mudam de preço (bons); 9302 muda de preço E o items-jsonb traz um item sem
# SKU (ruim — o banco recusa o agregado). A ordem por hash põe o ruim NO MEIO.
semeia_h() { for n in 9301 9302 9303; do cria "$n" '[{"cod":555,"q":1,"p":100,"dv":0}]' 100; done; }
LOTE_H="jsonb_build_array(
  teste.pedido_rpc(9301, '[{\"cod\":555,\"q\":1,\"p\":110,\"dv\":0}]', 110),
  teste.pedido_rpc(9302, '[{\"cod\":555,\"q\":1,\"p\":120,\"dv\":0}]', 120,
                   '[{\"descricao\":\"item sem SKU\",\"quantidade\":1,\"valor_unitario\":5,\"desconto\":0}]'),
  teste.pedido_rpc(9303, '[{\"cod\":555,\"q\":1,\"p\":130,\"dv\":0}]', 130))"

novo_banco prove_h0 antiga
eq "H0.0 a função ANTIGA desta prova é byte a byte a da prod (md5 do prosrc)" "$(Q "SELECT md5(prosrc) FROM pg_proc WHERE proname='reconciliar_pedidos_omie'")" "$MD5_BASE"
semeia_h
set +e; OUT=$(Q "SELECT teste.reconc($LOTE_H, -10)" 2>&1); RC=$?; set -e
OUT_V=$("$PGBIN/psql" -p "$PORT" -h /tmp -U postgres -d "$DB" -v VERBOSITY=verbose -tA -c "SELECT teste.reconc($LOTE_H, -9)" 2>&1 || true)
eq "H0 (contrafactual = o incidente de prod) a função antiga perde a chamada INTEIRA no commit, com 23514" "$RC|$(tem "$OUT_V" '23514')" "1|sim"
eq "H0b e nenhum pedido do lote foi reconciliado — nem os dois bons" "$(precos)" "100,100,100"
[ -n "$OUT" ] || true

novo_banco prove_h nova
semeia_h
R=$(Q "SELECT teste.reconc($LOTE_H, -10)")
eq "H1 a função NOVA commita: os bons são reconciliados, o ruim fica na revisão anterior" "$(precos)" "110,100,130"
eq "H1b o ruim vai para falhas com a SQLSTATE do banco, e o items-jsonb dele é o de antes" \
  "$(Q "SELECT (r->'falhas'->0->>'hash') || '/' || (r->'falhas'->0->>'sqlstate') || '/' || jsonb_array_length(r->'falhas') FROM (SELECT \$j\$$R\$j\$::jsonb AS r) x")|$(Q "SELECT jsonb_array_length(items) FROM public.sales_orders WHERE hash_payload='omie_oben_9302'")" "omie_oben_9302/23514/1|1"
eq "H2 os contadores contam SÓ os bons (corrections/upserts/divergences)" "$(jget "$R" corrections)/$(jget "$R" upserts)/$(jget "$R" divergences)" "2/2/2"
eq "H3 depois do commit, TODOS os pedidos seguem coerentes" "$(Q "SELECT count(*) FROM (SELECT public.pedido_venda_exigir_coerencia(id) FROM public.sales_orders) x" 2>&1 || true)" "3"

# H4 — MUDANÇA INTENCIONAL fora do diferencial: pedido revertido por DADO (22P02, product_id que não é
# uuid) com identidade completa. A antiga somava `identidade_usada` ANTES de escrever, e o pedido
# revertido ficava contado; a nova só soma quem passou a checagem. Os dois lados medidos aqui.
LOTE_DADO="jsonb_build_array(jsonb_build_object('account', 'oben', 'hash_payload', 'omie_oben_9304', 'omie_pedido_id', 9304,
  'status_omie', NULL, 'total', 100, 'items', teste.items_json('[{\"cod\":555,\"q\":1,\"p\":100}]'),
  'itens', jsonb_build_array(jsonb_build_object('omie_codigo_produto', 555, 'quantity', 1, 'unit_price', 100, 'discount', 0,
    'hash_payload', 'omie_oben_9304_555', 'omie_codigo_item', 7304, 'product_id', 'nao-e-uuid'))))"
DB=prove_h0
cria 9304 '[{"cod":555,"q":1,"p":100,"cid":7304}]' 100
R=$(Q "SELECT teste.reconc($LOTE_DADO, -8)")
V_ANTIGA="$(jget "$R" identidade_usada)/$(Q "SELECT jsonb_array_length(\$j\$$R\$j\$::jsonb->'falhas')")"
DB=prove_h
cria 9304 '[{"cod":555,"q":1,"p":100,"cid":7304}]' 100
R=$(Q "SELECT teste.reconc($LOTE_DADO, -8)")
V_NOVA="$(jget "$R" identidade_usada)/$(Q "SELECT jsonb_array_length(\$j\$$R\$j\$::jsonb->'falhas')")"
eq "H4 pedido revertido por DADO: a antiga contava identidade_usada, a nova não (identidade_usada/falhas)" "$V_ANTIGA|$V_NOVA" "1/1|0/1"
# H4c — CONTRAFACTUAL de G15 com a função ANTIGA: sem gravar o SKU ela commita SEM erro, com o
# product_id de cada produto colado no SKU do outro — o trigger não vê, porque o multiconjunto é igual.
DB=prove_h0
cria 9215 "$LINHAS_G15_ANTES" 200
R=$(reconc1 9215 "$LINHAS_G15_DEPOIS" 200 -10)
eq "H4c (contrafactual de G15) a função ANTIGA commita calada com o produto trocado de SKU" "$(skus_por_id 9215)|$(jget "$R" falhas)" "7501:555:556,7502:556:555|[]"

echo "═══ I · DIFERENCIAL — payload SEM a chave: a nova == a antiga em todo caminho que já commitava ═══"
# As mudanças INTENCIONAIS para edge velha ficam FORA daqui e têm assert próprio: SKU sob o mesmo
# codigo_item (G11), ruído abaixo da tolerância (G12) e o pedido incoerente (H) — os três caminhos
# em que a função antiga nem commitava.
CEN="$TMPF.cenarios.sql"
cat > "$CEN" <<'SQL'
CREATE TABLE teste.saidas (cenario text PRIMARY KEY, r jsonb);
SELECT teste.criar(9401, '[{"cod":555,"q":1,"p":100,"dv":10}]', 90);
INSERT INTO teste.saidas SELECT 'S01-base-muda', teste.reconc(jsonb_build_array(teste.pedido_rpc(9401, '[{"cod":555,"q":1,"p":120}]', 120)), -30);
SELECT teste.criar(9402, '[{"cod":555,"q":1,"p":100,"dv":10}]', 90);
INSERT INTO teste.saidas SELECT 'S02-adocao-pura', teste.reconc(jsonb_build_array(teste.pedido_rpc(9402, '[{"cod":555,"q":1,"p":100,"cid":7202}]', 90)), -30);
SELECT teste.criar(9403, '[{"cod":555,"q":1,"p":100,"dv":10}]', 90);
INSERT INTO teste.saidas SELECT 'S03-linha-nova', teste.reconc(jsonb_build_array(teste.pedido_rpc(9403, '[{"cod":555,"q":1,"p":100},{"cod":557,"q":2,"p":10}]', 110)), -30);
SELECT teste.criar(9404, '[{"cod":555,"q":1,"p":100,"dv":10},{"cod":557,"q":1,"p":10,"dv":1}]', 99);
INSERT INTO teste.saidas SELECT 'S04-linha-sai', teste.reconc(jsonb_build_array(teste.pedido_rpc(9404, '[{"cod":555,"q":1,"p":100}]', 90)), -30);
SELECT teste.criar(9405, '[{"cod":555,"q":1,"p":100,"dv":10}]', 90);
INSERT INTO teste.saidas SELECT 'S05-nada-muda', teste.reconc(jsonb_build_array(teste.pedido_rpc(9405, '[{"cod":555,"q":1,"p":100}]', 90)), -30);
INSERT INTO teste.saidas SELECT 'S06-leitura-velha', teste.reconc(jsonb_build_array(teste.pedido_rpc(9405, '[{"cod":555,"q":1,"p":999}]', 999)), -60);
SELECT teste.criar(9407, '[{"cod":555,"q":1,"p":100},{"cod":555,"q":2,"p":100}]', 300);
INSERT INTO teste.saidas SELECT 'S07-sku-repetido', teste.reconc(jsonb_build_array(teste.pedido_rpc(9407, '[{"cod":555,"q":1,"p":100},{"cod":555,"q":2,"p":110}]', 320)), -30);
SELECT teste.criar(9408, '[{"cod":556,"q":1,"p":null,"dv":5}]', 0);
INSERT INTO teste.saidas SELECT 'S08a-sem-preco', teste.reconc(jsonb_build_array(teste.pedido_rpc(9408, '[{"cod":556,"q":1,"p":null}]', 0)), -30);
INSERT INTO teste.saidas SELECT 'S08b-preco-chega', teste.reconc(jsonb_build_array(teste.pedido_rpc(9408, '[{"cod":556,"q":1,"p":50}]', 50)), -20);
SELECT teste.criar(9409, '[{"cod":555,"q":1,"p":100,"cid":7409,"dv":10}]', 90);
INSERT INTO teste.saidas SELECT 'S09-identidade-qtd', teste.reconc(jsonb_build_array(teste.pedido_rpc(9409, '[{"cod":555,"q":3,"p":100,"cid":7409}]', 300)), -30);
INSERT INTO teste.saidas SELECT 'S10-lote-misto', teste.reconc(jsonb_build_array(
  teste.pedido_rpc(9499, '[{"cod":555,"q":1,"p":1}]', 1),
  jsonb_build_object('account', 'oben', 'hash_payload', 'omie_oben_9401', 'omie_pedido_id', 9401, 'total', 1, 'items', '[]'::jsonb, 'itens', '[]'::jsonb),
  teste.pedido_rpc(9403, '[{"cod":555,"q":1,"p":100},{"cod":557,"q":2,"p":10}]', 110)), -10);
SELECT 'CENARIOS_FIM_OK';
SQL
DUMP="$TMPF.dump.sql"
cat > "$DUMP" <<'SQL'
SELECT 'SAIDA|' || cenario || '|' || (r - 'desconto_apurado' - 'desconto_corrigido')::text FROM teste.saidas ORDER BY cenario;
SELECT 'PAI|' || hash_payload || '|' || status || '|' || total || '|' || subtotal || '|' || items::text FROM public.sales_orders ORDER BY hash_payload;
SELECT 'LINHA|' || so.hash_payload || '|' || oi.omie_codigo_produto || '|' || oi.quantity || '|' || coalesce(oi.unit_price::text, 'NULO')
       || '|' || coalesce(oi.discount::text, 'NULO') || '|' || coalesce(oi.desconto_valor::text, 'NULO')
       || '|' || coalesce(oi.omie_codigo_item::text, 'NULO') || '|' || coalesce(oi.hash_payload, 'NULO')
  FROM public.order_items oi JOIN public.sales_orders so ON so.id = oi.sales_order_id
 ORDER BY so.hash_payload, oi.omie_codigo_produto, oi.quantity, oi.unit_price NULLS FIRST;
SQL
roda_cenarios() {  # $1 = arquivo do retrato. Roda os cenários no banco DB e grava o retrato normalizado.
  if ! Qf "$CEN" > "$1.log" 2>&1 || ! grep -q "CENARIOS_FIM_OK" "$1.log"; then
    bad "I.x os cenários NÃO rodaram até o fim em $DB — o diferencial compararia o nada: $(head -c 200 "$1.log")"
  fi
  Qft "$DUMP" > "$1"
}
novo_banco prove_i_antiga antiga
roda_cenarios "$TMPF.i-antiga"
# Linhas finais esperadas, por pedido: 9401·1  9402·1  9403·2 (ganhou a 557)  9404·1 (perdeu a 557)
# 9405·1  9407·2 (ambíguo, intocado)  9408·1  9409·1  = 10. Contar à mão é o controle: um número
# que só "bate com o que saiu" não distingue cenário rodado de cenário engolido.
eq "I0 (controle) a antiga rodou as 11 saídas e deixou as 10 linhas previstas" "$(grep -c '^SAIDA|' "$TMPF.i-antiga" || true)/$(grep -c '^LINHA|' "$TMPF.i-antiga" || true)" "11/10"
eq "I0b (controle) os cenários exercitaram os ramos: adoção, stale, ambíguo, sem pai, sem item, deleção" \
  "$(Q "SELECT concat_ws('|', (SELECT r->>'identidade_adotada' FROM teste.saidas WHERE cenario='S02-adocao-pura'), (SELECT r->>'stale' FROM teste.saidas WHERE cenario='S06-leitura-velha'), (SELECT r->>'ambiguo' FROM teste.saidas WHERE cenario='S07-sku-repetido'), (SELECT r->>'sem_pai' FROM teste.saidas WHERE cenario='S10-lote-misto'), (SELECT r->>'sem_item' FROM teste.saidas WHERE cenario='S10-lote-misto'), (SELECT r->>'corrections' FROM teste.saidas WHERE cenario='S04-linha-sai'))")" "1|1|1|1|1|1"
novo_banco prove_i_nova nova
roda_cenarios "$TMPF.i-nova"
if diff "$TMPF.i-antiga" "$TMPF.i-nova" > "$TMPF.i-diff"; then
  ok "I1 sem a chave, retorno e estado final da NOVA são idênticos aos da antiga ($(wc -l < "$TMPF.i-nova" | tr -d ' ') linhas de retrato)"
else
  bad "I1 a nova DIVERGE da antiga sem a chave: $(head -c 400 "$TMPF.i-diff" | tr '\n' ' ')"
fi
eq "I2 e os sensores novos ficam em ZERO sem a chave — nenhuma apuração/correção fabricada" \
  "$(Q "SELECT count(*) FROM teste.saidas WHERE (r->>'desconto_apurado')::int <> 0 OR (r->>'desconto_corrigido')::int <> 0")" "0"

echo "═══ FG/FH/FI/FP · FALSIFICAÇÃO (Lei #3): cada assert acima tem de ficar VERMELHO sob a sua sabotagem ═══"
# O CONTROLE verde de cada uma é o assert correspondente acima, na MESMA invocação, com a função
# verdadeira. Cada sabotagem ganha banco NOVO e aplica só o RECORTE da função sabotada (a migration
# inteira abortaria na própria postcondição, e o assert mediria a função antiga).
sabotado() {  # $1 = rótulo (vira o banco), $2 = programa perl -0pe
  local sab="$TMPF.$1.sql"
  perl -0pe "$2" "$MIG_RECONC" > "$sab"
  if cmp -s "$sab" "$MIG_RECONC"; then bad "$1.0 a sabotagem NÃO alterou a migration — o assert seria teatro"; return 1; fi
  DB="$1"
  "$PGBIN/createdb" -p "$PORT" -h /tmp -U postgres -T molde "$DB"
  Qf "$MIG" >/dev/null
  Qf "$MIG_COER" >/dev/null
  awk '/^CREATE OR REPLACE FUNCTION public.reconciliar_pedidos_omie/{d=1} d{print} d&&/^;$/{exit}' "$sab" > "$sab.fn"
  if [ ! -s "$sab.fn" ]; then bad "$1.0 o recorte da função sabotada saiu VAZIO"; return 1; fi
  if ! Qf "$sab.fn" > "$sab.log" 2>&1; then bad "$1.0 a função sabotada não compilou (mediria a antiga): $(head -c 160 "$sab.log")"; return 1; fi
  Q "$HELPERS_SQL" >/dev/null
  ok "$1.0 (controle da sabotagem) a função mudou e compilou"
}
confere() {  # $1 = rótulo, $2 = valor sob sabotagem, $3 = o valor que prova o dano, $4 = o assert que tem dente
  if [ "$2" = "$3" ]; then ok "$1 sabotado, veio [$2] — $4 tem dente"; else bad "$1 sabotado, veio [$2] (esperava o dano [$3]) — $4 pode passar por outro motivo"; fi
}

if sabotado fg1 's/\n[ ]+AND \(NOT d\.traz_desconto\n[ ]+OR a\.desconto_valor IS NOT DISTINCT FROM d\.desconto_valor\) \)/\n                        )/'; then
  cria 9201 '[{"cod":555,"q":1,"p":100,"dv":10}]' 90
  reconc1 9201 '[{"cod":555,"q":1,"p":100,"dv":20}]' 80 -10 >/dev/null
  confere FG1 "$(dv 9201 555)" "10" "G1 (sem o termo do desconto, o 10 velho fica sob o pai 80)"
fi
if sabotado fg2 's/OR a\.desconto_valor IS NOT DISTINCT FROM d\.desconto_valor\) \)/OR abs(a.desconto_valor - d.desconto_valor) < 1e-6) )/'; then
  cria 9202 '[{"cod":555,"q":1,"p":100,"dv":0},{"cod":556,"q":2,"p":null,"dv":5}]' 100
  reconc1 9202 '[{"cod":555,"q":1,"p":100,"dv":0},{"cod":556,"q":2,"p":null,"dv":null}]' 100 -10 >/dev/null
  confere FG2 "$(dv 9202 556)" "5" "G3 (comparação NULL-blind conserva o desconto que a leitura não sabe ler)"
fi
if sabotado fg3 's/desconto_valor = d\.desconto_valor,/desconto_valor = NULL,/'; then
  cria 9204 '[{"cod":555,"q":1,"p":100,"dv":10}]' 90
  reconc1 9204 '[{"cod":555,"q":1,"p":120,"dv":12}]' 108 -10 >/dev/null
  confere FG3 "$(dv 9204 555)" "NULO" "G6 (o UPDATE volta a só invalidar)"
fi
SAB_COALESCE="s/CASE WHEN \(it->>'desconto_valor'\)::numeric >= 0\n[ ]+AND \(it->>'desconto_valor'\)::numeric < 'Infinity'::numeric\n[ ]+THEN \(it->>'desconto_valor'\)::numeric END AS desconto_valor/coalesce((it->>'desconto_valor')::numeric, 0) AS desconto_valor/"
if sabotado fg4 "$SAB_COALESCE"; then
  cria 9202 '[{"cod":555,"q":1,"p":100,"dv":0},{"cod":556,"q":2,"p":null,"dv":5}]' 100
  reconc1 9202 '[{"cod":555,"q":1,"p":100,"dv":0},{"cod":556,"q":2,"p":null,"dv":null}]' 100 -10 >/dev/null
  confere FG4 "$(dv 9202 556)" "0" "G3 (o coalesce fabrica 'sem desconto' onde a leitura não soube ler)"
  DB=fp1
  "$PGBIN/createdb" -p "$PORT" -h /tmp -U postgres -T molde "$DB"
  Qf "$MIG" >/dev/null
  Qf "$MIG_COER" >/dev/null
  OUT=$(Qf "$TMPF.fg4.sql" 2>&1 || true)
  eq "FP1 a POSTCONDIÇÃO da migration inteira aborta o coalesce(desconto_valor, 0)" "$(tem "$OUT" 'FALHOU A3')" "sim"
  eq "FP1b e o abort DESFAZ o replace: a função segue a antiga" "$(Q "SELECT md5(prosrc) FROM pg_proc WHERE proname='reconciliar_pedidos_omie'")" "$MD5_BASE"
fi
if sabotado fg5 "s/CASE WHEN \(it->>'desconto_valor'\)::numeric >= 0\n[ ]+AND \(it->>'desconto_valor'\)::numeric < 'Infinity'::numeric\n[ ]+THEN \(it->>'desconto_valor'\)::numeric END AS desconto_valor/(it->>'desconto_valor')::numeric AS desconto_valor/"; then
  cria 9207 '[{"cod":555,"q":1,"p":100,"dv":10}]' 90
  reconc1 9207 '[{"cod":555,"q":1,"p":100,"dv":-5}]' 100 -10 >/dev/null
  confere FG5 "$(dv 9207 555)" "-5" "G9 (sem a régua de finitude, desconto negativo é gravado)"
fi
if sabotado fg6 's/AND NOT \(d\.traz_desconto AND a\.desconto_valor IS NOT NULL\n[ ]+AND \(d\.desconto_valor IS NULL\n[ ]+OR abs\(a\.desconto_valor - d\.desconto_valor\) >= 1e-6\)\)/AND NOT (d.traz_desconto AND a.desconto_valor IS DISTINCT FROM d.desconto_valor)/'; then
  cria 9203 '[{"cod":555,"q":2,"p":50}]' 100
  R=$(reconc1 9203 '[{"cod":555,"q":2,"p":50,"dv":0}]' 100 -10)
  confere FG6 "$(sens "$R")" "1/0/1/0" "G5b (a apuração infla corrections)"
fi
if sabotado fg7 's/WHERE conteudo_mudou = 0 AND id_adotada\)/WHERE conteudo_mudou = 0)/'; then
  cria 9203 '[{"cod":555,"q":2,"p":50}]' 100
  R=$(reconc1 9203 '[{"cod":555,"q":2,"p":50,"dv":0}]' 100 -10)
  confere FG7 "$(sens "$R")" "0/0/1/1" "G5b (a apuração vira adoção de identidade no sensor)"
fi
if sabotado fg8 's/\n[ ]+omie_codigo_produto = d\.cod,//'; then
  cria 9211 '[{"cod":555,"q":1,"p":100,"cid":7101,"dv":10}]' 90
  R=$(reconc1 9211 '[{"cod":556,"q":1,"p":100,"cid":7101,"dv":20}]' 80 -10)
  confere FG8 "$(Q "SELECT (teste.linha(9211, 555)).omie_codigo_produto")|$(Q "SELECT jsonb_array_length(\$j\$$R\$j\$::jsonb->'falhas')")" "555|1" "G11 (sem gravar o SKU, o banco recusa a própria escrita)"
  cria 9215 "$LINHAS_G15_ANTES" 200
  R=$(reconc1 9215 "$LINHAS_G15_DEPOIS" 200 -10)
  confere FG8b "$(skus_por_id 9215)|$(jget "$R" falhas)" "7501:555:556,7502:556:555|[]" "G15 (sem gravar o SKU, a troca de produto passa CALADA pelo trigger)"
fi
if sabotado fg9 's/AND a\.unit_price IS NOT DISTINCT FROM d\.unit_price/AND ((a.unit_price IS NULL AND d.unit_price IS NULL) OR (a.unit_price IS NOT NULL AND d.unit_price IS NOT NULL AND abs(a.unit_price - d.unit_price) < 1e-6))/'; then
  cria 9212 '[{"cod":555,"q":1,"p":100,"dv":0}]' 100
  R=$(reconc1 9212 '[{"cod":555,"q":1,"p":100.0000004,"dv":0}]' 100 -10)
  confere FG9 "$(Q "SELECT (teste.linha(9212, 555)).unit_price")|$(Q "SELECT jsonb_array_length(\$j\$$R\$j\$::jsonb->'falhas')")" "100|1" "G12 (decidir por tolerância deixa a linha velha sob o jsonb exato)"
fi
if sabotado fg10 's/AND NOT \([ ]+a\.cod[ ]+IS NOT DISTINCT FROM d\.cod\n[ ]+AND a\.quantity/AND NOT (      a.quantity/'; then
  cria 9214 '[{"cod":555,"q":1,"p":100,"cid":7401,"dv":0}]' 100
  R=$(reconc1 9214 '[{"cod":556,"q":1,"p":100,"cid":7401,"dv":0}]' 100 -10)
  confere FG10 "$(skus_por_id 9214)|$(Q "SELECT jsonb_array_length(\$j\$$R\$j\$::jsonb->'falhas')")" "7401:555:nulo|1" "G14 (sem o termo a.cod na decisão, só o SKU trocado não reescreve e o banco recusa)"
fi
if sabotado fh1 's/\n[ ]+IF v_cab_mudou OR \(v_del \+ v_upd_tot \+ v_ins\) > 0 THEN\n[ ]+PERFORM public\.pedido_venda_exigir_coerencia\(v_order_id\);\n[ ]+END IF;//'; then
  semeia_h
  set +e; Q "SELECT teste.reconc($LOTE_H, -10)" >/dev/null 2>&1; RC=$?; set -e
  confere FH1 "$RC|$(precos)" "1|100,100,100" "H1 (sem a checagem no bloco, o pedido ruim volta a derrubar a chamada)"
fi
# shellcheck disable=SC2016  # o $1 abaixo é a retrorreferência do perl, não variável do shell
if sabotado fh2 's/\n      v_corrections := v_corrections \+ v_del \+ v_upd \+ v_ins;\n      v_id_adotada  := v_id_adotada \+ v_adot;/\n      v_id_adotada  := v_id_adotada + v_adot;/; s/(\n      IF v_cab_mudou OR \(v_del \+ v_upd_tot \+ v_ins\) > 0 THEN)/\n      v_corrections := v_corrections + v_del + v_upd + v_ins;$1/'; then
  semeia_h
  R=$(Q "SELECT teste.reconc($LOTE_H, -10)")
  confere FH2 "$(jget "$R" corrections)" "3" "H2 (somar antes da checagem conta o trabalho revertido)"
fi
if sabotado fh3 's/v_usou_id := true;   -- somado a v_id_usada/v_id_usada := v_id_usada + 1; -- somado a v_id_usada/'; then
  cria 9304 '[{"cod":555,"q":1,"p":100,"cid":7304}]' 100
  R=$(Q "SELECT teste.reconc($LOTE_DADO, -8)")
  confere FH3 "$(jget "$R" identidade_usada)" "1" "H4 (somar identidade_usada antes de escrever conta o pedido revertido)"
fi
if sabotado fi1 's/desconto_valor = d\.desconto_valor,/desconto_valor = coalesce(d.desconto_valor, oi.desconto_valor),/'; then
  roda_cenarios "$TMPF.i-fi1"
  if diff -q "$TMPF.i-antiga" "$TMPF.i-fi1" >/dev/null; then
    bad "FI1 sabotado (conserva o desconto sem a chave), o diferencial NÃO viu — I1 não tem dente"
  else
    ok "FI1 sabotado (conserva o desconto sem a chave), o diferencial acusa — I1 tem dente"
  fi
fi
# FP2 — a PRÉ-CONDIÇÃO: outro corpo vivo (a função de hoje com uma linha a mais) não é sobrescrito.
DB=fp2
"$PGBIN/createdb" -p "$PORT" -h /tmp -U postgres -T molde "$DB"
Qf "$MIG" >/dev/null
Qf "$MIG_COER" >/dev/null
awk '/^CREATE OR REPLACE FUNCTION public.reconciliar_pedidos_omie/{d=1} d{print} d&&/^;$/{exit}' "$MIG" \
  | perl -0pe 's/\nDECLARE\n/\nDECLARE\n  -- outra entrega mexeu aqui\n/' > "$TMPF.fp2.sql"
Qf "$TMPF.fp2.sql" >/dev/null
MD5_OUTRO=$(Q "SELECT md5(prosrc) FROM pg_proc WHERE proname='reconciliar_pedidos_omie'")
OUT=$(Qf "$MIG_RECONC" 2>&1 || true)
eq "FP2 a PRÉ-CONDIÇÃO recusa aplicar sobre um corpo que não foi o medido" "$(tem "$OUT" 'outra entrega o recriou')|$([ "$MD5_OUTRO" != "$MD5_BASE" ] && echo difere)" "sim|difere"
eq "FP2b e o corpo alheio segue intacto" "$(Q "SELECT md5(prosrc) FROM pg_proc WHERE proname='reconciliar_pedidos_omie'")" "$MD5_OUTRO"
rm -f "$TMPF".*

# Formato `N ok / N fail`: é o que o runner do núcleo (db/roda-nucleo-ci.sh) sabe contar. O
# `N ok · N falhas` que estava aqui não casava a regex dele — a prova sairia "exit 0 sem contagem".
echo "═══ RESULTADO: $PASS ok / $FAIL fail ═══"
[ "$FAIL" -eq 0 ]
