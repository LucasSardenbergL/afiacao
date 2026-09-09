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
# p3..p5 servem SÓ ao A12 (régua do codigo_item): ele precisa de 5 SKUs distintos para que os 5
# valores inválidos sejam linhas separadas — com SKU repetido o caso mediria outra coisa.
p3="aaaaaaaa-0000-0000-0000-000000000003"
p4="aaaaaaaa-0000-0000-0000-000000000004"
p5="aaaaaaaa-0000-0000-0000-000000000005"

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
  quantity numeric NOT NULL DEFAULT 1, unit_price numeric, discount numeric DEFAULT 0,  -- unit_price NULLABLE e sem default: ausente <> zero (#2224, conferido em prod)
  created_at timestamptz DEFAULT now(), hash_payload text,
  -- IDENTIDADE DE LINHA: a coluna vem da 20260906180000 (provada em test-reconciliar-pedidos-omie.sh).
  -- Aqui ela e PRE-REQUISITO de schema, como o indice unique canonico logo abaixo.
  omie_codigo_item bigint);
CREATE TABLE public.sales_price_history (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_user_id uuid NOT NULL, product_id uuid NOT NULL, unit_price numeric NOT NULL,
  sales_order_id uuid, created_at timestamptz NOT NULL DEFAULT now());
ALTER TABLE public.sales_orders ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.order_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.sales_price_history ENABLE ROW LEVEL SECURITY;
-- Índice canônico (em prod vem da migration 20260617133634 #929) — PRÉ-REQUISITO da RPC.
-- Predicado 'omie\_%' (underscore LITERAL); a RPC usa o MESMO no ON CONFLICT (match exato exigido).
CREATE UNIQUE INDEX uniq_sales_orders_omie_hash
  ON public.sales_orders (account, hash_payload) WHERE hash_payload LIKE 'omie\_%';
SQL

# ── ZONA 2 — aplica a migration REAL (Lei #1) ──
# A base traz o GRANT/REVOKE (G1) e o corpo original; a nova RECRIA a funcao por cima — a ordem
# aqui e a MESMA de prod, onde o apply e manual e quem vence e quem foi colado por ultimo.
MIG_BASE="$REPO_ROOT/supabase/migrations/20260617160000_criar_pedidos_com_itens.sql"
MIG="$REPO_ROOT/supabase/migrations/20260908163659_pedido_nasce_com_identidade_de_linha.sql"
P -q -f "$MIG_BASE"
P -q -f "$MIG"
echo "migrations aplicadas: $(basename "$MIG_BASE") + $(basename "$MIG")"

# índice canônico (pré-req da 133634) presente — a RPC só casa o ON CONFLICT se o predicado bater
HASIDX=$(Pq -c "SELECT count(*) FROM pg_indexes WHERE indexname='uniq_sales_orders_omie_hash';")
eq "M0 índice canônico presente (pré-req; A0/A2 provam o ON CONFLICT casa omie\\_%)" "$HASIDX" "1"

# ── ZONA 3 — seed (como postgres: superuser, sem RLS) ──
P -q <<SQL
INSERT INTO auth.users(id) VALUES ('$c1'),('$c2'),('$sys') ON CONFLICT DO NOTHING;
INSERT INTO public.omie_products(id, omie_codigo_produto, account) VALUES
  ('$p1',1001,'oben'),('$p2',1002,'oben'),
  ('$p3',1003,'oben'),('$p4',1004,'oben'),('$p5',1005,'oben');
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
# identidade GRAVADA, em ordem estavel de SKU. `coalesce(...,'NULL')` mantem o ausente VISIVEL:
# `string_agg` pula NULL em silencio, e "1,3" seria indistinguivel de "1,NULL,3" — exatamente a
# cegueira que faz um assert de identidade parecer verde quando a coluna nao foi gravada.
ident() { Pq -c "SELECT coalesce(string_agg(coalesce(oi.omie_codigo_item::text,'NULL'), ',' ORDER BY oi.omie_codigo_produto, oi.omie_codigo_item NULLS LAST), '<sem linhas>') FROM public.order_items oi JOIN public.sales_orders so ON so.id=oi.sales_order_id WHERE so.hash_payload='$1';"; }

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

# ─── IDENTIDADE DE LINHA NO NASCIMENTO (20260908163659) ───────────────────────
# ⚠️ O acervo de prod tem `omie_codigo_item` NULL em 98,6% das linhas, e o payload do
# `ListarPedidos` traz o campo em 100% dos itens. Um assert que só olhasse "não quebrou" passaria
# nos dois mundos. Por isso cada caso abaixo fixa a STRING EXATA de identidades gravadas.

# A10 — POSITIVO: identidades DISTINTAS → gravadas (é isso que torna o guard de ambiguidade da
#       reconciliar_pedidos_omie inalcançável para este pedido, em vez de contornável)
J=$(cat <<EOF
[{"account":"oben","hash_payload":"omie_oben_200","customer_user_id":"$c1","created_by":"$sys","total":30,"status":"faturado","omie_pedido_id":200,"itens":[{"omie_codigo_produto":1001,"product_id":"$p1","quantity":1,"unit_price":10,"omie_codigo_item":501},{"omie_codigo_produto":1002,"product_id":"$p2","quantity":1,"unit_price":20,"omie_codigo_item":502}]}]
EOF
)
rpc "$J"
eq "A10 pedido entrou" "$INS" "1"
eq "A10 identidade GRAVADA nas 2 linhas" "$(ident omie_oben_200)" "501,502"

# A11 — G-a: identidade REPETIDA no payload → NULL em TODAS as linhas (a régua é POR PEDIDO, como
#       o v_ident da reconciliação), e o pedido entra normalmente. Gravar o repetido criaria a
#       condição G-b lá, que PULA o pedido para sempre — congelar é pior que degradar.
J=$(cat <<EOF
[{"account":"oben","hash_payload":"omie_oben_201","customer_user_id":"$c1","created_by":"$sys","total":30,"status":"faturado","omie_pedido_id":201,"itens":[{"omie_codigo_produto":1001,"product_id":"$p1","quantity":1,"unit_price":10,"omie_codigo_item":777},{"omie_codigo_produto":1002,"product_id":"$p2","quantity":1,"unit_price":20,"omie_codigo_item":777}]}]
EOF
)
rpc "$J"
eq "A11 G-a: pedido com identidade repetida ENTRA (degrada, não perde a venda)" "$INS" "1"
eq "A11 G-a: 2 order_items" "$(cnt omie_oben_201)" "2"
eq "A11 G-a: identidade NULL em TODAS (não só nas repetidas)" "$(ident omie_oben_201)" "NULL,NULL"

# A11b — G-a contamina o pedido INTEIRO: a linha de identidade única CONVIVE com o par repetido e
#        ainda assim sai NULL. Sem este caso, um guard por LINHA passaria no A11.
J=$(cat <<EOF
[{"account":"oben","hash_payload":"omie_oben_202","customer_user_id":"$c1","created_by":"$sys","total":40,"status":"faturado","omie_pedido_id":202,"itens":[{"omie_codigo_produto":1001,"product_id":"$p1","quantity":1,"unit_price":10,"omie_codigo_item":888},{"omie_codigo_produto":1001,"product_id":"$p1","quantity":1,"unit_price":10,"omie_codigo_item":888},{"omie_codigo_produto":1002,"product_id":"$p2","quantity":1,"unit_price":20,"omie_codigo_item":999}]}]
EOF
)
rpc "$J"
eq "A11b G-a é por PEDIDO: a linha de identidade ÚNICA também sai NULL" "$(ident omie_oben_202)" "NULL,NULL,NULL"

# A12 — A RÉGUA: `codigo_item` inválido vira NULL e NÃO derruba a subtransação G9 (o pedido é
#       gravado). Cada valor abaixo é um que `::bigint` cru aceitaria como identidade FALSA ou
#       explodiria: 0 (Number("")===0 do lado da edge), negativo, fracionário, texto, vazio.
J=$(cat <<EOF
[{"account":"oben","hash_payload":"omie_oben_203","customer_user_id":"$c1","created_by":"$sys","total":50,"status":"faturado","omie_pedido_id":203,"itens":[{"omie_codigo_produto":1001,"product_id":"$p1","quantity":1,"unit_price":10,"omie_codigo_item":0},{"omie_codigo_produto":1002,"product_id":"$p2","quantity":1,"unit_price":10,"omie_codigo_item":-5},{"omie_codigo_produto":1003,"product_id":"$p3","quantity":1,"unit_price":10,"omie_codigo_item":1.5},{"omie_codigo_produto":1004,"product_id":"$p4","quantity":1,"unit_price":10,"omie_codigo_item":"abc"},{"omie_codigo_produto":1005,"product_id":"$p5","quantity":1,"unit_price":10,"omie_codigo_item":""}]}]
EOF
)
rpc "$J"
eq "A12 régua: pedido com codigo_item sujo NÃO é perdido (G9 intacta)" "$INS" "1"
eq "A12 régua: failed=0 (cast seguro, não exceção)" "$FAILED" "0"
eq "A12 régua: os 5 inválidos viram NULL" "$(ident omie_oben_203)" "NULL,NULL,NULL,NULL,NULL"

# A13 — PARCIAL distinto: identidade só em algumas linhas → grava o que tem, NULL no resto.
#       Ausente não é duplicata de ausente; tratar dois NULL como conflito zeraria a adoção.
J=$(cat <<EOF
[{"account":"oben","hash_payload":"omie_oben_204","customer_user_id":"$c1","created_by":"$sys","total":30,"status":"faturado","omie_pedido_id":204,"itens":[{"omie_codigo_produto":1001,"product_id":"$p1","quantity":1,"unit_price":10,"omie_codigo_item":601},{"omie_codigo_produto":1002,"product_id":"$p2","quantity":1,"unit_price":10},{"omie_codigo_produto":1003,"product_id":"$p3","quantity":1,"unit_price":10}]}]
EOF
)
rpc "$J"
eq "A13 parcial: grava a que tem, NULL nas ausentes" "$(ident omie_oben_204)" "601,NULL,NULL"

# A14 — REGRESSÃO #2224 (CONTROLE NEGATIVO da derivação): o modo de falha mais caro desta migration
#       não é ela não pegar — é ela pegar REVERTENDO o corpo vigente. Preço ausente tem de seguir
#       NULL, nunca R$ 0,00 fabricado; e o 0 que o Omie DE FATO informa segue passando como 0.
J=$(cat <<EOF
[{"account":"oben","hash_payload":"omie_oben_205","customer_user_id":"$c1","created_by":"$sys","total":10,"status":"faturado","omie_pedido_id":205,"itens":[{"omie_codigo_produto":1001,"product_id":"$p1","quantity":1},{"omie_codigo_produto":1002,"product_id":"$p2","quantity":1,"unit_price":0}]}]
EOF
)
rpc "$J"
PREC=$(Pq -c "SELECT string_agg(coalesce(oi.unit_price::text,'NULL'), ',' ORDER BY oi.omie_codigo_produto) FROM public.order_items oi JOIN public.sales_orders so ON so.id=oi.sales_order_id WHERE so.hash_payload='omie_oben_205';")
eq "A14 régua de preço do #2224 SOBREVIVEU à derivação (ausente=NULL, zero informado=0)" "$PREC" "NULL,0"

# ════════════════════════════════════════════════════════════════════════════
# ZONA 5 — FALSIFICAÇÃO (Lei #3): sabota cada guard → exige VERMELHO → restaura
# ════════════════════════════════════════════════════════════════════════════
echo "── falsificação (sabota → exige vermelho → restaura) ──"
SAB="/tmp/mig-sabotada-${SLUG}.sql"
restaura() { P -q -f "$MIG_BASE"; P -q -f "$MIG"; }   # re-aplica as DUAS (idempotentes)

# Toda sabotagem passa por aqui: um `sed` que nao casa mais (porque o corpo evoluiu) produz um
# arquivo IDENTICO ao verdadeiro, o guard segue no ar, e a falsificacao vira teatro silencioso —
# ela "prova" que o assert tem dente sem nunca ter tirado o dente. Exige-se diferenca de bytes.
sabota() {  # sabota <expr-sed> <rotulo>
  sed "$1" "$MIG" > "$SAB"
  if cmp -s "$SAB" "$MIG"; then bad "SABOTAGEM INERTE ($2): o sed não mudou nada — falsificação sem dente"; return 1; fi
  P -q -f "$SAB"; return 0
}

# F1 (G3 FOR UPDATE): sem o lock, a corrida duplica → CNT vira 2
sabota 's/ FOR UPDATE;/;/' 'F1 FOR UPDATE'
corrida omie_oben_556
if [ "$CNT_R" = "2" ]; then ok "F1 sem FOR UPDATE a corrida DUPLICA (=2) → A9 tem dente"; else bad "F1 sabotei FOR UPDATE e não duplicou (veio $CNT_R) → A9 fraco"; fi
restaura

# F2 (G6 created_at): trocando v_created_at por now(), reparo de órfão antigo vira HOJE
sabota 's/v_created_at,  -- G6/now(),  -- G6/g' 'F2 created_at'
J=$(cat <<EOF
[{"account":"oben","hash_payload":"omie_oben_778","customer_user_id":"$c1","created_by":"$sys","total":50,"status":"faturado","order_date_kpi":"2023-03-03","itens":[{"omie_codigo_produto":1001,"product_id":"$p1","quantity":1,"unit_price":50}]}]
EOF
)
Pq -c "SELECT public.criar_pedidos_com_itens('$J'::jsonb);" >/dev/null
SAMEF=$(Pq -c "SELECT bool_and(oi.created_at = so.created_at) FROM public.order_items oi JOIN public.sales_orders so ON so.id=oi.sales_order_id WHERE so.hash_payload='omie_oben_778';")
if [ "$SAMEF" = "f" ]; then ok "F2 com now() o item NÃO bate com o pai → A4 tem dente"; else bad "F2 sabotei created_at e itens ainda batem com o pai (veio $SAMEF) → A4 fraco"; fi
restaura

# F3 (G5 divergência): sem o guard, repara cabeçalho divergente (889 total=100, payload=999)
sabota 's/IF v_diverge THEN/IF false THEN/' 'F3 divergência'
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
sabota 's/WHERE v_item_count > 0/WHERE true/' 'F4 não-cria-sem-item'
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
restaura
# ⚠️ `restaura` re-aplica a MIGRATION, e o índice NÃO vem dela (é pré-requisito da ZONA 1, da
# migration 20260617133634). O comentário antigo aqui dizia "recria o índice" e era FALSO: o banco
# seguia sem índice até o fim do script. Enquanto o F6 foi o ÚLTIMO caso isso não teve sintoma —
# qualquer caso acrescentado depois nasce falhando com 42P10, indistinguível de um guard com dente.
P -q -c "CREATE UNIQUE INDEX IF NOT EXISTS uniq_sales_orders_omie_hash ON public.sales_orders (account, hash_payload) WHERE hash_payload LIKE 'omie\_%';"
IDXOK=$(Pq -c "SELECT count(*) FROM pg_indexes WHERE indexname='uniq_sales_orders_omie_hash';")
eq "F6r índice REALMENTE recriado (o restaura da migration não o traz de volta)" "$IDXOK" "1"

# F7 (G-a): sem o guard, a identidade REPETIDA é GRAVADA → A11 tem dente
sabota 's/count(cid) = count(DISTINCT cid)/count(cid) = count(cid)/' 'F7 G-a' && {
  J=$(cat <<EOF
[{"account":"oben","hash_payload":"omie_oben_211","customer_user_id":"$c1","created_by":"$sys","total":30,"status":"faturado","omie_pedido_id":211,"itens":[{"omie_codigo_produto":1001,"product_id":"$p1","quantity":1,"unit_price":10,"omie_codigo_item":777},{"omie_codigo_produto":1002,"product_id":"$p2","quantity":1,"unit_price":20,"omie_codigo_item":777}]}]
EOF
)
  Pq -c "SELECT public.criar_pedidos_com_itens('$J'::jsonb);" >/dev/null
  ID7=$(ident omie_oben_211)
  if [ "$ID7" = "777,777" ]; then ok "F7 sem G-a a identidade repetida É gravada (777,777) → A11 tem dente"; else bad "F7 sabotei o G-a e não veio 777,777 (veio '$ID7') → A11 fraco"; fi
}
restaura

# F8 (régua): afrouxando o regex, o 0 vira identidade FALSA gravada → A12 tem dente
sabota "s/\^\[1-9\]\[0-9\]{0,17}\\\$/^[0-9]+\$/" 'F8 régua' && {
  J=$(cat <<EOF
[{"account":"oben","hash_payload":"omie_oben_212","customer_user_id":"$c1","created_by":"$sys","total":10,"status":"faturado","omie_pedido_id":212,"itens":[{"omie_codigo_produto":1001,"product_id":"$p1","quantity":1,"unit_price":10,"omie_codigo_item":0}]}]
EOF
)
  Pq -c "SELECT public.criar_pedidos_com_itens('$J'::jsonb);" >/dev/null
  ID8=$(ident omie_oben_212)
  if [ "$ID8" = "0" ]; then ok "F8 régua frouxa grava 0 como identidade FALSA → A12 tem dente"; else bad "F8 sabotei a régua e o 0 não foi gravado (veio '$ID8') → A12 fraco"; fi
}
restaura

# F9 (identidade nunca gravada): com a expressão em NULL o corpo COMPILA, o INSERT roda e a
#     coluna fica NULL para sempre — a falha SILENCIOSA exata que esta migration existe para
#     fechar, e o estado em que a RPC estava antes dela.
sabota 's/CASE WHEN (SELECT ok FROM ga) THEN c.cid END/NULL::bigint/' 'F9 identidade nunca gravada' && {
  J=$(cat <<EOF
[{"account":"oben","hash_payload":"omie_oben_213","customer_user_id":"$c1","created_by":"$sys","total":10,"status":"faturado","omie_pedido_id":213,"itens":[{"omie_codigo_produto":1001,"product_id":"$p1","quantity":1,"unit_price":10,"omie_codigo_item":901}]}]
EOF
)
  Pq -c "SELECT public.criar_pedidos_com_itens('$J'::jsonb);" >/dev/null
  ID9=$(ident omie_oben_213)
  if [ "$ID9" = "NULL" ]; then ok "F9 com a expressão em NULL a identidade some → A10 tem dente"; else bad "F9 sabotei a gravação e a identidade sobreviveu (veio '$ID9') → A10 fraco"; fi
}
restaura

# ── veredito ──
echo "──────────────────────────────"
echo "RESULTADO: $PASS ok / $FAIL fail"
[ "$FAIL" = "0" ] || { echo "❌ HARNESS VERMELHO"; exit 1; }
echo "✅ HARNESS VERDE"
