#!/usr/bin/env bash
# ╔══════════════════════════════════════════════════════════════════════════════╗
# ║ PROVA PG17 — criar_pedidos_com_itens (atomicidade pai+filho do sync Omie)      ║
# ║ Spec: docs/superpowers/specs/2026-06-17-atomicidade-pedido-itens-omie-design.md║
# ║ Rode: bash db/test-criar-pedidos-com-itens.sh > /tmp/t.log 2>&1; echo "exit=$?"║
# ╚══════════════════════════════════════════════════════════════════════════════╝
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PGVER=17
PGBIN="/opt/homebrew/opt/postgresql@${PGVER}/bin"
PORT="${PGPORT_TEST:-5461}"
SLUG="criar-pedidos-com-itens"
DATA="$(mktemp -d "/tmp/pgtest-${SLUG}.XXXXXX")/data"
export LC_ALL=C LANG=C

[ -x "$PGBIN/initdb" ] || { echo "postgresql@${PGVER} ausente: brew install postgresql@${PGVER} pgvector"; exit 1; }
CELLAR="$(brew --prefix "postgresql@${PGVER}")"
cp -Rn "$CELLAR"/share/postgresql/. "/opt/homebrew/share/postgresql@${PGVER}/" 2>/dev/null || true
mkdir -p "/opt/homebrew/lib/postgresql@${PGVER}"
cp -Rn "$CELLAR"/lib/postgresql/. "/opt/homebrew/lib/postgresql@${PGVER}/" 2>/dev/null || true

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
ok()  { PASS=$((PASS+1)); echo "  ✅ $1"; }
bad() { FAIL=$((FAIL+1)); echo "  ❌ $1"; }
eq()  { if [ "$2" = "$3" ]; then ok "$1 (=$2)"; else bad "$1 — esperado [$3], veio [$2]"; fi; }

echo "═══ setup pronto (PG17 :$PORT) ═══"

# UUIDs fixos
c1="11111111-1111-1111-1111-111111111111"
c2="22222222-2222-2222-2222-222222222222"
sys="33333333-3333-3333-3333-333333333333"
p1="aaaaaaaa-0000-0000-0000-000000000001"
p2="aaaaaaaa-0000-0000-0000-000000000002"

# ── ZONA 1 — pré-requisitos de schema (fiel ao prod: NOT NULL/defaults/FK CASCADE) ──
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
  customer_address text, customer_phone text, order_date_kpi date);
CREATE TABLE public.order_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sales_order_id uuid NOT NULL REFERENCES public.sales_orders(id) ON DELETE CASCADE,
  customer_user_id uuid NOT NULL,
  product_id uuid REFERENCES public.omie_products(id),
  omie_codigo_produto bigint,
  quantity numeric NOT NULL DEFAULT 1, unit_price numeric NOT NULL DEFAULT 0, discount numeric DEFAULT 0,
  created_at timestamptz DEFAULT now(), hash_payload text);
CREATE TABLE public.sales_price_history (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_user_id uuid NOT NULL, product_id uuid NOT NULL, unit_price numeric NOT NULL,
  sales_order_id uuid, created_at timestamptz NOT NULL DEFAULT now());
ALTER TABLE public.sales_orders ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.order_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.sales_price_history ENABLE ROW LEVEL SECURITY;
SQL

# ── ZONA 2 — aplica a migration REAL (Lei #1) ──
MIG="$REPO_ROOT/supabase/migrations/20260617160000_criar_pedidos_com_itens.sql"
P -q -f "$MIG"
echo "migration aplicada: $(basename "$MIG")"

# índice unique foi criado?
HASIDX=$(Pq -c "SELECT count(*) FROM pg_indexes WHERE indexname='uniq_sales_orders_omie_hash';")
eq "M0 índice unique criado" "$HASIDX" "1"

# ── ZONA 3 — seed (como postgres: superuser, sem RLS) ──
P -q <<SQL
INSERT INTO auth.users(id) VALUES ('$c1'),('$c2'),('$sys') ON CONFLICT DO NOTHING;
INSERT INTO public.omie_products(id, omie_codigo_produto, account) VALUES
  ('$p1',1001,'oben'),('$p2',1002,'oben');
GRANT EXECUTE ON FUNCTION public.criar_pedidos_com_itens(jsonb) TO service_role;  -- (já na migration; idempotente)
-- órfão 777 p/ reparo (created_at ANTIGO; cabeçalho casa com o payload do reparo)
INSERT INTO public.sales_orders(customer_user_id,created_by,account,hash_payload,total,status,order_date_kpi,created_at,omie_pedido_id)
  VALUES ('$c1','$sys','oben','omie_oben_777',50,'faturado','2023-01-15','2023-01-15T00:00:00Z',777);
-- órfão 888 p/ divergência (total local=100)
INSERT INTO public.sales_orders(customer_user_id,created_by,account,hash_payload,total,status,order_date_kpi,omie_pedido_id)
  VALUES ('$c1','$sys','oben','omie_oben_888',100,'faturado','2024-02-02',888);
-- completo 999 (já tem 1 item) p/ skip_complete
WITH so AS (
  INSERT INTO public.sales_orders(customer_user_id,created_by,account,hash_payload,total,status,omie_pedido_id)
  VALUES ('$c1','$sys','oben','omie_oben_999',30,'faturado',999) RETURNING id)
INSERT INTO public.order_items(sales_order_id,customer_user_id,omie_codigo_produto,product_id,quantity,unit_price)
  SELECT id,'$c1',1001,'$p1',1,30 FROM so;
-- órfãos p/ corrida (A9) e falsificações (556/778/889)
INSERT INTO public.sales_orders(customer_user_id,created_by,account,hash_payload,total,status,order_date_kpi,created_at,omie_pedido_id) VALUES
  ('$c1','$sys','oben','omie_oben_555',50,'faturado','2023-01-15','2023-01-15T00:00:00Z',555),
  ('$c1','$sys','oben','omie_oben_556',50,'faturado','2023-01-15','2023-01-15T00:00:00Z',556),
  ('$c1','$sys','oben','omie_oben_778',50,'faturado','2023-03-03','2023-03-03T00:00:00Z',778),
  ('$c1','$sys','oben','omie_oben_889',100,'faturado','2024-02-02','2024-02-02T00:00:00Z',889),
  ('$c1','$sys','oben','omie_oben_780',50,'separacao','2024-03-03','2024-03-03T00:00:00Z',780),
  ('$c1','$sys','oben','omie_oben_781',50,'faturado','2024-04-04','2024-04-04T00:00:00Z',781);
-- price pré-existente p/ o 781 (Codex P2: reparo não pode duplicar histórico de preço)
INSERT INTO public.sales_price_history(customer_user_id, product_id, unit_price, sales_order_id)
  SELECT '$c1','$p1',50, id FROM public.sales_orders WHERE hash_payload='omie_oben_781';
SQL

# helper: chama a RPC 1x e popula INS REP SKC SKN DIV FAIL
rpc() {
  local row
  row=$(Pq -c "WITH r AS (SELECT public.criar_pedidos_com_itens('$1'::jsonb) AS j)
    SELECT j->>'inserted',j->>'repaired',j->>'items',j->>'skipped_complete',j->>'skipped_no_items',
           jsonb_array_length(j->'divergence'),jsonb_array_length(j->'failed') FROM r;")
  IFS='|' read -r INS REP ITEMS SKC SKN DIV FAILED <<< "$row"   # FAILED (não FAIL — colidiria com o contador)
}
cnt() { Pq -c "SELECT count(*) FROM public.order_items oi JOIN public.sales_orders so ON so.id=oi.sales_order_id WHERE so.hash_payload='$1';"; }
paiexiste() { Pq -c "SELECT count(*) FROM public.sales_orders WHERE hash_payload='$1';"; }

echo "── asserts ──"

# A0 — POSITIVO: pedido novo c/ 2 itens + 2 preços → pai+filhos atômico (G9/G10)
J=$(cat <<EOF
[{"account":"oben","hash_payload":"omie_oben_100","customer_user_id":"$c1","created_by":"$sys","total":40,"status":"faturado","omie_pedido_id":100,"order_date_kpi":"2026-06-10","created_at":"2026-06-10T12:00:00Z","itens":[{"omie_codigo_produto":1001,"product_id":"$p1","quantity":2,"unit_price":10},{"omie_codigo_produto":1002,"product_id":"$p2","quantity":1,"unit_price":20}],"precos":[{"product_id":"$p1","unit_price":10},{"product_id":"$p2","unit_price":20}]}]
EOF
)
rpc "$J"
eq "A0 inserted=1" "$INS" "1"
eq "A0 items=2 (contador da RPC)" "$ITEMS" "2"
eq "A0 2 order_items" "$(cnt omie_oben_100)" "2"
PH=$(Pq -c "SELECT count(*) FROM public.sales_price_history WHERE sales_order_id=(SELECT id FROM public.sales_orders WHERE hash_payload='omie_oben_100');")
eq "A0 2 sales_price_history (G10)" "$PH" "2"
SAME0=$(Pq -c "SELECT bool_and(oi.created_at = so.created_at) FROM public.order_items oi JOIN public.sales_orders so ON so.id=oi.sales_order_id WHERE so.hash_payload='omie_oben_100';")
eq "A0 created_at do item = do pai (G6)" "$SAME0" "t"

# A1 — ATOMICIDADE (G9): pedido 102 c/ item de FK inválida reverte o PAI; 101 (bom) entra
J=$(cat <<EOF
[{"account":"oben","hash_payload":"omie_oben_101","customer_user_id":"$c1","created_by":"$sys","total":10,"status":"faturado","omie_pedido_id":101,"itens":[{"omie_codigo_produto":1001,"product_id":"$p1","quantity":1,"unit_price":10}]},{"account":"oben","hash_payload":"omie_oben_102","customer_user_id":"$c1","created_by":"$sys","total":20,"status":"faturado","omie_pedido_id":102,"itens":[{"omie_codigo_produto":9999,"product_id":"99999999-9999-9999-9999-999999999999","quantity":1,"unit_price":20}],"precos":[{"product_id":"99999999-9999-9999-9999-999999999999","unit_price":20}]}]
EOF
)
rpc "$J"
eq "A1 bom (101) entrou" "$(paiexiste omie_oben_101)" "1"
eq "A1 ruim (102) pai REVERTIDO (atomicidade)" "$(paiexiste omie_oben_102)" "0"
eq "A1 failed=1" "$FAILED" "1"
PH102=$(Pq -c "SELECT count(*) FROM public.sales_price_history sph JOIN public.sales_orders so ON so.id=sph.sales_order_id WHERE so.hash_payload='omie_oben_102';")
eq "A1 preço do 102 também revertido (G10 atômico)" "$PH102" "0"

# A2 — IDEMPOTÊNCIA (G2): mesmo pedido novo 2x → não duplica pai
J=$(cat <<EOF
[{"account":"oben","hash_payload":"omie_oben_103","customer_user_id":"$c1","created_by":"$sys","total":10,"status":"faturado","omie_pedido_id":103,"itens":[{"omie_codigo_produto":1001,"product_id":"$p1","quantity":1,"unit_price":10}]}]
EOF
)
rpc "$J"; rpc "$J"
eq "A2 pai não duplica (1 só)" "$(paiexiste omie_oben_103)" "1"
eq "A2 2ª chamada = skipped_complete" "$SKC" "1"

# A3 — G7: pedido novo SEM item válido (codigo_produto null) → pai NÃO entra
J=$(cat <<EOF
[{"account":"oben","hash_payload":"omie_oben_104","customer_user_id":"$c1","created_by":"$sys","total":10,"status":"faturado","omie_pedido_id":104,"itens":[{"omie_codigo_produto":null,"product_id":"$p1","quantity":1,"unit_price":10}]}]
EOF
)
rpc "$J"
eq "A3 pai sem item NÃO criado (G7)" "$(paiexiste omie_oben_104)" "0"
eq "A3 skipped_no_items=1" "$SKN" "1"

# A4 — REPARO (G4) + created_at coerente (G6): órfão antigo 777 → itens c/ data do pai (2023), não hoje
J=$(cat <<EOF
[{"account":"oben","hash_payload":"omie_oben_777","customer_user_id":"$c1","created_by":"$sys","total":50,"status":"faturado","order_date_kpi":"2023-01-15","itens":[{"omie_codigo_produto":1001,"product_id":"$p1","quantity":1,"unit_price":25},{"omie_codigo_produto":1002,"product_id":"$p2","quantity":1,"unit_price":25}]}]
EOF
)
rpc "$J"
eq "A4 repaired=1" "$REP" "1"
eq "A4 items=2 (restaurados)" "$ITEMS" "2"
eq "A4 órfão reparado (2 itens)" "$(cnt omie_oben_777)" "2"
SAME4=$(Pq -c "SELECT bool_and(oi.created_at = so.created_at) FROM public.order_items oi JOIN public.sales_orders so ON so.id=oi.sales_order_id WHERE so.hash_payload='omie_oben_777';")
eq "A4 item reparado usa created_at do PAI (2023, não hoje — G6)" "$SAME4" "t"
ANO=$(Pq -c "SELECT EXTRACT(year FROM oi.created_at)::int FROM public.order_items oi JOIN public.sales_orders so ON so.id=oi.sales_order_id WHERE so.hash_payload='omie_oben_777' LIMIT 1;")
eq "A4 ano do item reparado = 2023 (não 2026)" "$ANO" "2023"

# A5 — DIVERGÊNCIA (G5): órfão 888 (total local=100), payload total=999 → NÃO repara, marca divergence
J=$(cat <<EOF
[{"account":"oben","hash_payload":"omie_oben_888","customer_user_id":"$c1","created_by":"$sys","total":999,"status":"faturado","order_date_kpi":"2024-02-02","itens":[{"omie_codigo_produto":1001,"product_id":"$p1","quantity":1,"unit_price":999}]}]
EOF
)
rpc "$J"
eq "A5 divergence=1" "$DIV" "1"
eq "A5 repaired=0 (não reconcilia)" "$REP" "0"
eq "A5 órfão divergente segue SEM itens" "$(cnt omie_oben_888)" "0"

# A6 — SKIP_COMPLETE (G4): pedido 999 já tem item → reparo é no-op (não vira 2)
J=$(cat <<EOF
[{"account":"oben","hash_payload":"omie_oben_999","customer_user_id":"$c1","created_by":"$sys","total":30,"status":"faturado","itens":[{"omie_codigo_produto":1001,"product_id":"$p1","quantity":1,"unit_price":30},{"omie_codigo_produto":1002,"product_id":"$p2","quantity":1,"unit_price":30}]}]
EOF
)
rpc "$J"
eq "A6 skipped_complete=1" "$SKC" "1"
eq "A6 itens inalterados (1, não 2)" "$(cnt omie_oben_999)" "1"

# A5b — STATUS evoluiu não bloqueia reparo (Codex P1#2): órfão 'separacao' total=50,
# payload 'faturado' total=50 (MESMO total) → repara (status fora do guard)
J=$(cat <<EOF
[{"account":"oben","hash_payload":"omie_oben_780","customer_user_id":"$c1","created_by":"$sys","total":50,"status":"faturado","order_date_kpi":"2024-03-03","itens":[{"omie_codigo_produto":1001,"product_id":"$p1","quantity":1,"unit_price":50}]}]
EOF
)
rpc "$J"
eq "A5b status evoluiu (separacao→faturado) NÃO bloqueia (P1#2)" "$REP" "1"
eq "A5b sem divergência espúria" "$DIV" "0"
eq "A5b 780 reparado (1 item)" "$(cnt omie_oben_780)" "1"

# A7b — price idempotente no reparo (Codex P2): órfão 781 já tem 1 price → reparo não duplica
J=$(cat <<EOF
[{"account":"oben","hash_payload":"omie_oben_781","customer_user_id":"$c1","created_by":"$sys","total":50,"status":"faturado","order_date_kpi":"2024-04-04","itens":[{"omie_codigo_produto":1001,"product_id":"$p1","quantity":1,"unit_price":50}],"precos":[{"product_id":"$p1","unit_price":50}]}]
EOF
)
rpc "$J"
eq "A7b 781 reparado (1 item)" "$(cnt omie_oben_781)" "1"
PH781=$(Pq -c "SELECT count(*) FROM public.sales_price_history sph JOIN public.sales_orders so ON so.id=sph.sales_order_id WHERE so.hash_payload='omie_oben_781';")
eq "A7b reparo NÃO duplica price (1, não 2)" "$PH781" "1"

# A8 — GRANT (G1): authenticated NÃO executa; service_role executa
R=$(P -tA 2>&1 <<'SQL'
SET ROLE authenticated;
DO $$ BEGIN
  PERFORM public.criar_pedidos_com_itens('[]'::jsonb);
  RAISE EXCEPTION 'EXECUTOU_NAO_DEVIA';
EXCEPTION
  WHEN insufficient_privilege THEN RAISE NOTICE 'GRANT_NEGADO_OK';
  WHEN OTHERS THEN RAISE;
END $$;
SQL
)
case "$R" in *GRANT_NEGADO_OK*) ok "A8 authenticated negado (42501)" ;; *) bad "A8 — veio: $R" ;; esac
SRV=$(Pq -c "SET ROLE service_role; SELECT (public.criar_pedidos_com_itens('[]'::jsonb))->>'inserted';" | tail -1)
eq "A8 service_role executa" "$SRV" "0"

# A9 — CORRIDA (G3): reparo concorrente do mesmo órfão (555) NÃO duplica itens
corrida() {  # $1 = hash; popula CNT_R
  local hash="$1"
  ( P -q <<SQL
BEGIN;
SELECT id FROM public.sales_orders WHERE hash_payload='$hash' FOR UPDATE;
SELECT pg_sleep(4);
INSERT INTO public.order_items(sales_order_id,customer_user_id,omie_codigo_produto,product_id,quantity,unit_price,created_at)
  SELECT id,customer_user_id,1001,'$p1',1,25,created_at FROM public.sales_orders WHERE hash_payload='$hash';
COMMIT;
SQL
  ) &
  local apid=$!
  sleep 1.5
  local jb
  jb=$(cat <<EOF
[{"account":"oben","hash_payload":"$hash","customer_user_id":"$c1","created_by":"$sys","total":50,"status":"faturado","order_date_kpi":"2023-01-15","itens":[{"omie_codigo_produto":1001,"product_id":"$p1","quantity":1,"unit_price":25}]}]
EOF
)
  Pq -c "SELECT public.criar_pedidos_com_itens('$jb'::jsonb);" >/dev/null
  wait $apid || true
  CNT_R=$(cnt "$hash")
}
corrida omie_oben_555
eq "A9 corrida: reparo concorrente não duplica (FOR UPDATE serializou)" "$CNT_R" "1"

# ════════════════════════════════════════════════════════════════════════════
# ZONA 5 — FALSIFICAÇÃO (Lei #3): sabota cada guard → exige VERMELHO → restaura
# ════════════════════════════════════════════════════════════════════════════
echo "── falsificação (sabota → exige vermelho → restaura) ──"
SAB="/tmp/mig-sabotada-${SLUG}.sql"
restaura() { P -q -f "$MIG"; }   # re-aplica a versão verdadeira (idempotente)

# F1 (G3 FOR UPDATE): sem o lock, a corrida duplica → CNT vira 2
sed 's/ FOR UPDATE;/;/' "$MIG" > "$SAB"; P -q -f "$SAB"
corrida omie_oben_556
if [ "$CNT_R" = "2" ]; then ok "F1 sem FOR UPDATE a corrida DUPLICA (=2) → A9 tem dente"; else bad "F1 sabotei FOR UPDATE e não duplicou (veio $CNT_R) → A9 fraco"; fi
restaura

# F2 (G6 created_at): trocando v_created_at por now(), reparo de órfão antigo vira HOJE
sed 's/v_created_at  -- G6/now()  -- G6/g' "$MIG" > "$SAB"; P -q -f "$SAB"
J=$(cat <<EOF
[{"account":"oben","hash_payload":"omie_oben_778","customer_user_id":"$c1","created_by":"$sys","total":50,"status":"faturado","order_date_kpi":"2023-03-03","itens":[{"omie_codigo_produto":1001,"product_id":"$p1","quantity":1,"unit_price":50}]}]
EOF
)
Pq -c "SELECT public.criar_pedidos_com_itens('$J'::jsonb);" >/dev/null
SAMEF=$(Pq -c "SELECT bool_and(oi.created_at = so.created_at) FROM public.order_items oi JOIN public.sales_orders so ON so.id=oi.sales_order_id WHERE so.hash_payload='omie_oben_778';")
if [ "$SAMEF" = "f" ]; then ok "F2 com now() o item NÃO bate com o pai → A4 tem dente"; else bad "F2 sabotei created_at e itens ainda batem com o pai (veio $SAMEF) → A4 fraco"; fi
restaura

# F3 (G5 divergência): sem o guard, repara cabeçalho divergente (889 total=100, payload=999)
sed 's/IF v_diverge THEN/IF false THEN/' "$MIG" > "$SAB"; P -q -f "$SAB"
J=$(cat <<EOF
[{"account":"oben","hash_payload":"omie_oben_889","customer_user_id":"$c1","created_by":"$sys","total":999,"status":"faturado","order_date_kpi":"2024-02-02","itens":[{"omie_codigo_produto":1001,"product_id":"$p1","quantity":1,"unit_price":999}]}]
EOF
)
Pq -c "SELECT public.criar_pedidos_com_itens('$J'::jsonb);" >/dev/null
DI=$(cnt omie_oben_889)
if [ "$DI" != "0" ]; then ok "F3 sem o guard, cabeçalho divergente é reparado (itens=$DI) → A5 tem dente"; else bad "F3 sabotei divergência e não reparou → A5 fraco"; fi
restaura
P -q -c "DELETE FROM public.order_items oi USING public.sales_orders so WHERE oi.sales_order_id=so.id AND so.hash_payload='omie_oben_889';" >/dev/null

# F4 (G7 não-cria-sem-item): com WHERE true, pai sem item válido é criado
sed 's/WHERE v_item_count > 0/WHERE true/' "$MIG" > "$SAB"; P -q -f "$SAB"
J=$(cat <<EOF
[{"account":"oben","hash_payload":"omie_oben_106","customer_user_id":"$c1","created_by":"$sys","total":10,"status":"faturado","omie_pedido_id":106,"itens":[{"omie_codigo_produto":null,"quantity":1,"unit_price":10}]}]
EOF
)
Pq -c "SELECT public.criar_pedidos_com_itens('$J'::jsonb);" >/dev/null
if [ "$(paiexiste omie_oben_106)" = "1" ]; then ok "F4 sem o WHERE, pai órfão é criado → A3 tem dente"; else bad "F4 sabotei G7 e o pai não entrou → A3 fraco"; fi
restaura

# F5 (G1 grant): concedendo a authenticated, A8 deixa de barrar
P -q -c "GRANT EXECUTE ON FUNCTION public.criar_pedidos_com_itens(jsonb) TO authenticated;"
R=$(P -tA 2>&1 <<'SQL'
SET ROLE authenticated;
DO $$ BEGIN
  PERFORM public.criar_pedidos_com_itens('[]'::jsonb);
  RAISE NOTICE 'SABOTAGEM_EXECUTOU';
EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'AINDA_BARRA'; END $$;
SQL
)
case "$R" in *SABOTAGEM_EXECUTOU*) ok "F5 com grant a authenticated o gate cai → A8 tem dente" ;; *) bad "F5 concedi grant e ainda barrou → A8 fraco" ;; esac
restaura  # re-aplica REVOKE FROM authenticated da migration

# F6 (G2 índice): sem o índice unique, a RPC não consegue ON CONFLICT → pedido vai p/ failed (42P10)
P -q -c "DROP INDEX public.uniq_sales_orders_omie_hash;"
J=$(cat <<EOF
[{"account":"oben","hash_payload":"omie_oben_107","customer_user_id":"$c1","created_by":"$sys","total":10,"status":"faturado","omie_pedido_id":107,"itens":[{"omie_codigo_produto":1001,"product_id":"$p1","quantity":1,"unit_price":10}]}]
EOF
)
SS=$(Pq -c "SELECT (public.criar_pedidos_com_itens('$J'::jsonb))#>>'{failed,0,sqlstate}';")
if [ "$SS" = "42P10" ]; then ok "F6 sem o índice a RPC falha (42P10) → o índice é necessário p/ o ON CONFLICT"; else bad "F6 droppei o índice e não veio 42P10 (veio '$SS')"; fi
restaura  # recria o índice

# ── veredito ──
echo "──────────────────────────────"
echo "RESULTADO: $PASS ok / $FAIL fail"
[ "$FAIL" = "0" ] || { echo "❌ HARNESS VERMELHO"; exit 1; }
echo "✅ HARNESS VERDE"
