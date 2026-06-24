#!/usr/bin/env bash
# ╔══════════════════════════════════════════════════════════════════════════════╗
# ║  PROVA PG17 — get_customer_sales_summary() v4 (seed de farmer_client_scores)   ║
# ║  Money-path: alimenta recência/receita/diversidade do auto-seed. Substitui a   ║
# ║  leitura crua order_items .limit(10000) sem .order() (truncava ~30%).          ║
# ║  v4: BLOCKLIST (alinha princípio c/ #935 — status novo ENTRA, anti-subcontagem;║
# ║  não-vendas cancelado/rascunho/pendente/orcamento FICAM FORA).                 ║
# ║  v5: blinda o FALLBACK created_at::date com AT TIME ZONE 'America/Sao_Paulo'    ║
# ║  (recência TZ-determinística; follow-up #4 do design da MV, espelha #1023).     ║
# ║  Aplica v3→v4→v5 (simula a ordem de prod: CREATE OR REPLACE encadeado).         ║
# ║  Lei de Ferro: migration REAL · assert negativo c/ SQLSTATE · falsificação.    ║
# ╚══════════════════════════════════════════════════════════════════════════════╝
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PGVER=17
PGBIN="/opt/homebrew/opt/postgresql@${PGVER}/bin"
PORT="${PGPORT_TEST:-5466}"
SLUG="gcss"
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
ALTER ROLE service_role BYPASSRLS;
SQL

PASS=0; FAIL=0
ok()  { PASS=$((PASS+1)); echo "  ✅ $1"; }
bad() { FAIL=$((FAIL+1)); echo "  ❌ $1"; }
eq()  { if [ "$2" = "$3" ]; then ok "$1 (=$2)"; else bad "$1 — esperado [$3], veio [$2]"; fi; }

echo "═══ setup pronto (PG17 :$PORT) ═══"

# ══ ZONA 1 — pré-requisitos: order_items + sales_orders (colunas que a RPC toca) ══
P -q <<'SQL'
CREATE TABLE public.sales_orders (
  id             uuid PRIMARY KEY,
  status         text NOT NULL,  -- espelha prod (status é NOT NULL → NOT IN não é NULL-blind aqui)
  deleted_at     timestamptz,
  order_date_kpi date,
  created_at     timestamptz          -- fallback do COALESCE quando order_date_kpi IS NULL
);
CREATE TABLE public.order_items (
  id               uuid PRIMARY KEY,
  sales_order_id   uuid,
  customer_user_id uuid,
  product_id       uuid,
  unit_price       numeric,
  quantity         numeric,
  created_at       timestamptz
);
SQL

# ══ ZONA 2 — aplica as migrations REAIS na ORDEM de prod: v3 (allowlist) → v4 (blocklist) → v5 (tz) ══
MIG3="$REPO_ROOT/supabase/migrations/20260618180000_get_customer_sales_summary.sql"
MIG4="$REPO_ROOT/supabase/migrations/20260618190000_get_customer_sales_summary_blocklist.sql"
MIG="$REPO_ROOT/supabase/migrations/20260623150000_get_customer_sales_summary_tz_fallback.sql"  # v5 = verdade atual; restaurações apontam aqui
P -q -f "$MIG3"   # estado v3 (allowlist) — histórico
P -q -f "$MIG4"   # v4 CREATE OR REPLACE (blocklist) — histórico
P -q -f "$MIG"    # v5 CREATE OR REPLACE (blocklist + fallback TZ-determinístico) — a transição que vai pra prod
echo "migrations aplicadas: v3 → v4 → $(basename "$MIG")"

# ══ ZONA 3 — seed (cobre invariantes + edge cases Codex r2 + a inversão allowlist→blocklist) ══
# oi.created_at = '2020-01-01' em TODOS (munição p/ F3: provar que NÃO se usa created_at do item).
P -q <<'SQL'
INSERT INTO public.sales_orders (id, status, deleted_at, order_date_kpi, created_at) VALUES
  ('50000000-0000-0000-0000-000000000001','faturado',  NULL,  current_date-10, (current_date-10)::timestamptz),  -- A dentro 180d
  ('50000000-0000-0000-0000-000000000002','enviado',   NULL,  current_date-200,(current_date-200)::timestamptz), -- A FORA 180d
  ('50000000-0000-0000-0000-000000000003','cancelado', NULL,  current_date-5,  (current_date-5)::timestamptz),   -- B cancelado 615M EXCLUÍDO
  ('50000000-0000-0000-0000-000000000004','importado', NULL,  current_date-20, (current_date-20)::timestamptz),  -- B
  ('50000000-0000-0000-0000-000000000005','faturado',  NULL,  current_date-1,  (current_date-1)::timestamptz),   -- C
  ('50000000-0000-0000-0000-000000000006','faturado',  NULL,  current_date-3,  (current_date-3)::timestamptz),   -- D customer NULL EXCLUÍDO
  ('50000000-0000-0000-0000-000000000007','enviado',   NULL,  current_date-300,(current_date-300)::timestamptz), -- E FORA 180d
  ('50000000-0000-0000-0000-000000000008','entregue', NULL,  current_date-2,  (current_date-2)::timestamptz),   -- F status NOVO → blocklist INCLUI
  ('50000000-0000-0000-0000-000000000009','faturado',  NULL,  current_date-4,  (current_date-4)::timestamptz),   -- F
  ('50000000-0000-0000-0000-000000000010','faturado',  now(), current_date-1,  (current_date-1)::timestamptz),   -- G deleted EXCLUÍDO
  ('50000000-0000-0000-0000-000000000011','faturado',  NULL,  current_date-6,  (current_date-6)::timestamptz),   -- G
  ('50000000-0000-0000-0000-000000000012','faturado',  NULL,  NULL,            (current_date-5)::timestamptz),   -- H kpi NULL → COALESCE p/ created_at
  ('50000000-0000-0000-0000-000000000013','faturado',  NULL,  current_date+30, (current_date+30)::timestamptz),  -- I data FUTURA
  ('50000000-0000-0000-0000-000000000014','orcamento', NULL,  current_date-1,  (current_date-1)::timestamptz),   -- B orçamento (não-venda) EXCLUÍDO
  -- Bordas TZ (follow-up #4): order_date_kpi NULL → cai no FALLBACK created_at. Ancoradas em today_sp
  -- (= (now() AT TIME ZONE SP)::date, absoluto) p/ que o caso de borda independa de QUANDO o teste roda.
  ('50000000-0000-0000-0000-000000000015','faturado', NULL, NULL, (((now() AT TIME ZONE 'America/Sao_Paulo')::date)::timestamp + time '02:30') AT TIME ZONE 'UTC'),         -- TZR: hoje 02:30 UTC = ontem 23:30 SP (1ª ocorrência: recência)
  ('50000000-0000-0000-0000-000000000016','faturado', NULL, NULL, ((((now() AT TIME ZONE 'America/Sao_Paulo')::date)+1)::timestamp + time '01:00') AT TIME ZONE 'UTC');     -- TZW: (hoje+1) 01:00 UTC = hoje 22:00 SP (2ª ocorrência: janela 180d)

INSERT INTO public.order_items (id, sales_order_id, customer_user_id, product_id, unit_price, quantity, created_at) VALUES
  ('70000000-0000-0000-0000-000000000001','50000000-0000-0000-0000-000000000001','aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','60000000-0000-0000-0000-000000000001',100,2,   '2020-01-01'), -- A 200
  ('70000000-0000-0000-0000-000000000002','50000000-0000-0000-0000-000000000001','aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','60000000-0000-0000-0000-000000000002', 50,NULL,'2020-01-01'), -- A 50 (qty null→1)
  ('70000000-0000-0000-0000-000000000003','50000000-0000-0000-0000-000000000002','aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','60000000-0000-0000-0000-000000000001',1000,1, '2020-01-01'),-- A 1000 (fora 180d)
  ('70000000-0000-0000-0000-000000000004','50000000-0000-0000-0000-000000000003','bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb','60000000-0000-0000-0000-000000000003',615000000,1,'2020-01-01'),-- B 615M CANCELADO
  ('70000000-0000-0000-0000-000000000005','50000000-0000-0000-0000-000000000004','bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb','60000000-0000-0000-0000-000000000003',300,1,'2020-01-01'),  -- B 300
  ('70000000-0000-0000-0000-000000000006','50000000-0000-0000-0000-000000000005','cccccccc-cccc-cccc-cccc-cccccccccccc','60000000-0000-0000-0000-000000000004',NULL,5,'2020-01-01'), -- C 0 (price null→0)
  ('70000000-0000-0000-0000-000000000007','50000000-0000-0000-0000-000000000005','cccccccc-cccc-cccc-cccc-cccccccccccc',NULL,80,0,'2020-01-01'),                                  -- C 80 (qty 0→1, prod null)
  ('70000000-0000-0000-0000-000000000008','50000000-0000-0000-0000-000000000006',NULL,'60000000-0000-0000-0000-000000000001',999,1,'2020-01-01'),                                 -- D customer NULL
  ('70000000-0000-0000-0000-000000000009','50000000-0000-0000-0000-000000000007','eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee','60000000-0000-0000-0000-000000000005',500,1,'2020-01-01'),  -- E 500 (fora 180d)
  ('70000000-0000-0000-0000-000000000010','50000000-0000-0000-0000-000000000008','ffffffff-ffff-ffff-ffff-ffffffffffff','60000000-0000-0000-0000-000000000006',777,1,'2020-01-01'),  -- F 777 DEVOLVIDO (status novo)
  ('70000000-0000-0000-0000-000000000011','50000000-0000-0000-0000-000000000009','ffffffff-ffff-ffff-ffff-ffffffffffff','60000000-0000-0000-0000-000000000006',10,1,'2020-01-01'),   -- F 10
  ('70000000-0000-0000-0000-000000000012','50000000-0000-0000-0000-000000000010','99999999-9999-9999-9999-999999999999','60000000-0000-0000-0000-000000000007',888,1,'2020-01-01'),  -- G 888 DELETED
  ('70000000-0000-0000-0000-000000000013','50000000-0000-0000-0000-000000000011','99999999-9999-9999-9999-999999999999','60000000-0000-0000-0000-000000000007',20,1,'2020-01-01'),   -- G 20
  ('70000000-0000-0000-0000-000000000014','50000000-0000-0000-0000-000000000012','88888888-8888-8888-8888-888888888888','60000000-0000-0000-0000-000000000008',40,1,'2020-01-01'),   -- H 40 (kpi null)
  ('70000000-0000-0000-0000-000000000015','50000000-0000-0000-0000-000000000013','12121212-1212-1212-1212-121212121212','60000000-0000-0000-0000-000000000009',60,1,'2020-01-01'),   -- I 60 (futuro)
  ('70000000-0000-0000-0000-000000000016','50000000-0000-0000-0000-000000000014','bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb','60000000-0000-0000-0000-00000000000a',5000,1,'2020-01-01'),-- B 5000 ORÇAMENTO
  ('70000000-0000-0000-0000-000000000017','50000000-0000-0000-0000-000000000015','d1d1d1d1-d1d1-d1d1-d1d1-d1d1d1d1d1d1','60000000-0000-0000-0000-00000000000b',30,1,'2020-01-01'),  -- TZR 30 (kpi-null borda recência)
  ('70000000-0000-0000-0000-000000000018','50000000-0000-0000-0000-000000000016','d2d2d2d2-d2d2-d2d2-d2d2-d2d2d2d2d2d2','60000000-0000-0000-0000-00000000000c',140,1,'2020-01-01');-- TZW 140 (kpi-null borda janela 180d)

GRANT SELECT ON public.order_items, public.sales_orders TO service_role, anon, authenticated;
SQL

A='aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'
B='bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'
C='cccccccc-cccc-cccc-cccc-cccccccccccc'
E='eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee'
F='ffffffff-ffff-ffff-ffff-ffffffffffff'
G='99999999-9999-9999-9999-999999999999'
H='88888888-8888-8888-8888-888888888888'
I='12121212-1212-1212-1212-121212121212'
TZR='d1d1d1d1-d1d1-d1d1-d1d1-d1d1d1d1d1d1'  # kpi-null, created_at=hoje 02:30 UTC (=ontem 23:30 SP) → borda da recência (1ª ocorrência)
TZW='d2d2d2d2-d2d2-d2d2-d2d2-d2d2d2d2d2d2'  # kpi-null, created_at=(hoje+1) 01:00 UTC (=hoje 22:00 SP) → borda do teto da janela 180d (2ª ocorrência)
val() { Pq -c "SELECT $1 FROM public.get_customer_sales_summary() WHERE customer_user_id='$2';"; }

echo "── asserts positivos / money-path (v4 blocklist) ──"
# Cobertura 100% (anti-truncamento): a RPC agrega TODOS os itens válidos
eq "A0 itens crus semeados" "$(Pq -c "SELECT count(*) FROM public.order_items;")" "18"
COB=$(Pq -c "SELECT sum(item_count) FROM public.get_customer_sales_summary();")
DIRECT=$(Pq -c "SELECT count(*) FROM public.order_items oi JOIN public.sales_orders so ON so.id=oi.sales_order_id WHERE so.status NOT IN ('cancelado','rascunho','pendente','orcamento') AND so.deleted_at IS NULL AND oi.customer_user_id IS NOT NULL;")
eq "A1 cobertura sum(item_count)=count direto" "$COB" "$DIRECT"
eq "A1b cobertura = 14 válidos (4 excluídos: cancelado/null/deleted/orçamento; +2 bordas TZ)" "$COB" "14"
eq "A2 clientes na RPC = 10 (8 + TZR + TZW)" "$(Pq -c "SELECT count(*) FROM public.get_customer_sales_summary();")" "10"

# Paridade revenue + janela 180d + recência (SQL) + diversidade
eq "A3 total_revenue A = 1250"                       "$(val "(total_revenue=1250)" "$A")" "t"
eq "A4 revenue_180d A = 250 (item -200d fora)"       "$(val "(revenue_180d=250)" "$A")" "t"
eq "A5 days A ∈ [9,11] (reflete -10, não -200)"      "$(val "(days_since_last_purchase BETWEEN 9 AND 11)" "$A")" "t"
eq "A6 category_count A = 2"                         "$(val "(category_count=2)" "$A")" "t"
eq "A7 total_revenue B = 300 (cancelado 615M E orçamento 5000 FORA)" "$(val "(total_revenue=300)" "$B")" "t"
eq "A8 total_revenue C = 80 (price null→0, qty 0→1)" "$(val "(total_revenue=80)" "$C")" "t"
eq "A9 category_count C = 1 (product NULL ignorado)" "$(val "(category_count=1)" "$C")" "t"
eq "A10 revenue_180d E = 0 (sem compra 180d, !null)" "$(val "(revenue_180d=0 AND revenue_180d IS NOT NULL)" "$E")" "t"
eq "A11 customer-null fora da RPC"                   "$(Pq -c "SELECT count(*) FROM public.get_customer_sales_summary() WHERE customer_user_id IS NULL;")" "0"
# A INVERSÃO da v4: status NOVO de venda ('entregue') ENTRA na blocklist (anti-subcontagem #935).
# Trade-off aceito: um status NOVO de NÃO-venda (ex.: 'estornado') também entraria — é o preço
# da blocklist vs allowlist, decidido a favor de não subcontar venda real (ver #935 + spec v4).
eq "A12 total_revenue F = 787 ('entregue' status-novo ENTRA: 777+10)" "$(val "(total_revenue=787)" "$F")" "t"
eq "A13 total_revenue G = 20 (deleted FORA)"         "$(val "(total_revenue=20)" "$G")" "t"
# Codex r2: COALESCE kpi-null → cliente não vira "morto"
eq "A14a days H ∈ [4,6] (kpi NULL → COALESCE created_at, não 999)" "$(val "(days_since_last_purchase BETWEEN 4 AND 6)" "$H")" "t"
eq "A14b revenue_180d H = 40 (kpi-null entra na janela)"          "$(val "(revenue_180d=40)" "$H")" "t"
# Codex r2: data futura → clamp recência + excluir do spend
eq "A15a days I = 0 (futuro → GREATEST clamp)"        "$(val "(days_since_last_purchase=0)" "$I")" "t"
eq "A15b revenue_180d I = 0 (futuro fora janela)"     "$(val "(revenue_180d=0)" "$I")" "t"
eq "A15c total_revenue I = 60 (all-time inclui)"      "$(val "(total_revenue=60)" "$I")" "t"

echo "── asserts de GRANT/REVOKE (SQLSTATE 42501 + re-raise) ──"
eq "A16 service_role executa" "$(Pq -c "SET ROLE service_role; SELECT count(*) FROM public.get_customer_sales_summary();" | tail -1)" "10"
R=$(P -tA 2>&1 <<'SQL'
SET ROLE anon;
DO $$ BEGIN
  PERFORM 1 FROM public.get_customer_sales_summary();
  RAISE EXCEPTION 'ANON_EXECUTOU';
EXCEPTION WHEN insufficient_privilege THEN RAISE NOTICE 'ANON_NEGADO_OK';
  WHEN OTHERS THEN RAISE; END $$;
SQL
)
case "$R" in *ANON_NEGADO_OK*) ok "A17 anon negado (42501)";; *) bad "A17 anon — veio: $R";; esac
R=$(P -tA 2>&1 <<'SQL'
SET ROLE authenticated;
DO $$ BEGIN
  PERFORM 1 FROM public.get_customer_sales_summary();
  RAISE EXCEPTION 'AUTH_EXECUTOU';
EXCEPTION WHEN insufficient_privilege THEN RAISE NOTICE 'AUTH_NEGADO_OK';
  WHEN OTHERS THEN RAISE; END $$;
SQL
)
case "$R" in *AUTH_NEGADO_OK*) ok "A18 authenticated negado (42501)";; *) bad "A18 authenticated — veio: $R";; esac

echo "── anti-timezone (follow-up #4): RPC sob UTC vs SP → IDÊNTICO nas 2 ocorrências do fallback ──"
# `now()` e o teto today_sp já são TZ-absolutos; o ÚNICO ponto TZ-sensível é o fallback created_at::date.
# TZR/TZW têm order_date_kpi NULL → exercitam o fallback. `| tail -1` descarta a tag 'SET' (padrão do harness da MV).
# TZR (created_at hoje 02:30 UTC = ontem 23:30 SP): 1ª ocorrência (recência max). A data civil correta é SP → days=1.
DR_UTC=$(Pq -c "SET TIME ZONE 'UTC';               SELECT days_since_last_purchase FROM public.get_customer_sales_summary() WHERE customer_user_id='$TZR';" | tail -1)
DR_SP=$( Pq -c "SET TIME ZONE 'America/Sao_Paulo'; SELECT days_since_last_purchase FROM public.get_customer_sales_summary() WHERE customer_user_id='$TZR';" | tail -1)
eq "TZ1 days(TZR) idêntico UTC×SP (recência determinística)"  "$DR_UTC" "$DR_SP"
eq "TZ1b days(TZR)=1 (data civil SP de ontem, não a UTC de hoje)" "$DR_SP" "1"
# TZW (created_at (hoje+1) 01:00 UTC = hoje 22:00 SP): 2ª ocorrência (FILTER da janela). Em SP a data é HOJE,
# dentro do teto today_sp → 140. created_at::date cru sob UTC daria amanhã (> teto) → 0.
RW_UTC=$(Pq -c "SET TIME ZONE 'UTC';               SELECT revenue_180d FROM public.get_customer_sales_summary() WHERE customer_user_id='$TZW';" | tail -1)
RW_SP=$( Pq -c "SET TIME ZONE 'America/Sao_Paulo'; SELECT revenue_180d FROM public.get_customer_sales_summary() WHERE customer_user_id='$TZW';" | tail -1)
eq "TZ2 revenue_180d(TZW) idêntico UTC×SP (janela determinística)"   "$RW_UTC" "$RW_SP"
eq "TZ2b revenue_180d(TZW)=140 (data civil SP=hoje, dentro do teto)" "$RW_SP" "140"
P -q -c "SET TIME ZONE 'America/Sao_Paulo';"   # volta ao default canônico p/ as falsificações abaixo

echo "── falsificação (sabota → exige VERMELHO → restaura v5) ──"
# F1 (INVERSÃO v4): blocklist → allowlist amnésica → 'entregue' (status novo) SAI → F vira 10.
P -q <<'SQL'
CREATE OR REPLACE FUNCTION public.get_customer_sales_summary()
RETURNS TABLE(customer_user_id uuid, days_since_last_purchase int, total_revenue numeric, revenue_180d numeric, item_count bigint, category_count bigint)
LANGUAGE sql STABLE SECURITY INVOKER SET search_path=public AS $fn$
  SELECT oi.customer_user_id,
    GREATEST(0,(now() AT TIME ZONE 'America/Sao_Paulo')::date - max(COALESCE(so.order_date_kpi,so.created_at::date)))::int,
    COALESCE(sum(COALESCE(oi.unit_price,0)*COALESCE(NULLIF(oi.quantity,0),1)),0),
    COALESCE(sum(COALESCE(oi.unit_price,0)*COALESCE(NULLIF(oi.quantity,0),1)) FILTER (WHERE COALESCE(so.order_date_kpi,so.created_at::date) BETWEEN (now() AT TIME ZONE 'America/Sao_Paulo')::date-180 AND (now() AT TIME ZONE 'America/Sao_Paulo')::date),0),
    count(*), count(DISTINCT oi.product_id)
  FROM public.order_items oi JOIN public.sales_orders so ON so.id=oi.sales_order_id
  WHERE so.status IN ('faturado','importado','separacao','enviado')   -- SABOTADO: allowlist amnésica
    AND so.deleted_at IS NULL AND oi.customer_user_id IS NOT NULL
  GROUP BY oi.customer_user_id;
$fn$;
SQL
RAWF=$(val "total_revenue" "$F")
if [ "$(val "(total_revenue=787)" "$F")" = "f" ]; then ok "F1 blocklist tem dente (allowlist excluiu 'entregue' status-novo: F=$RAWF, A12 quebraria)"; else bad "F1 sabotei blocklist→allowlist e A12 NÃO mudou"; fi
P -q -f "$MIG"

# F2: remove FILTER de 180d → revenue_180d = total all-time → A revenue_180d vira 1250.
P -q <<'SQL'
CREATE OR REPLACE FUNCTION public.get_customer_sales_summary()
RETURNS TABLE(customer_user_id uuid, days_since_last_purchase int, total_revenue numeric, revenue_180d numeric, item_count bigint, category_count bigint)
LANGUAGE sql STABLE SECURITY INVOKER SET search_path=public AS $fn$
  SELECT oi.customer_user_id,
    GREATEST(0,(now() AT TIME ZONE 'America/Sao_Paulo')::date - max(COALESCE(so.order_date_kpi,so.created_at::date)))::int,
    COALESCE(sum(COALESCE(oi.unit_price,0)*COALESCE(NULLIF(oi.quantity,0),1)),0),
    COALESCE(sum(COALESCE(oi.unit_price,0)*COALESCE(NULLIF(oi.quantity,0),1)),0),  -- SABOTADO: sem FILTER 180d
    count(*), count(DISTINCT oi.product_id)
  FROM public.order_items oi JOIN public.sales_orders so ON so.id=oi.sales_order_id
  WHERE so.status NOT IN ('cancelado','rascunho','pendente','orcamento')
    AND so.deleted_at IS NULL AND oi.customer_user_id IS NOT NULL
  GROUP BY oi.customer_user_id;
$fn$;
SQL
if [ "$(val "(revenue_180d=250)" "$A")" = "f" ]; then ok "F2 FILTER 180d tem dente (sem filter A=$(val revenue_180d "$A"), A4 quebraria)"; else bad "F2 removi o FILTER e A4 NÃO mudou"; fi
P -q -f "$MIG"

# F3: max(COALESCE(order_date_kpi,...)) → max(oi.created_at) (item, = 2020) → days A explode.
P -q <<'SQL'
CREATE OR REPLACE FUNCTION public.get_customer_sales_summary()
RETURNS TABLE(customer_user_id uuid, days_since_last_purchase int, total_revenue numeric, revenue_180d numeric, item_count bigint, category_count bigint)
LANGUAGE sql STABLE SECURITY INVOKER SET search_path=public AS $fn$
  SELECT oi.customer_user_id,
    GREATEST(0,(now() AT TIME ZONE 'America/Sao_Paulo')::date - max(oi.created_at::date))::int,  -- SABOTADO: created_at do item
    COALESCE(sum(COALESCE(oi.unit_price,0)*COALESCE(NULLIF(oi.quantity,0),1)),0),
    COALESCE(sum(COALESCE(oi.unit_price,0)*COALESCE(NULLIF(oi.quantity,0),1)) FILTER (WHERE COALESCE(so.order_date_kpi,so.created_at::date) BETWEEN (now() AT TIME ZONE 'America/Sao_Paulo')::date-180 AND (now() AT TIME ZONE 'America/Sao_Paulo')::date),0),
    count(*), count(DISTINCT oi.product_id)
  FROM public.order_items oi JOIN public.sales_orders so ON so.id=oi.sales_order_id
  WHERE so.status NOT IN ('cancelado','rascunho','pendente','orcamento')
    AND so.deleted_at IS NULL AND oi.customer_user_id IS NOT NULL
  GROUP BY oi.customer_user_id;
$fn$;
SQL
if [ "$(val "(days_since_last_purchase BETWEEN 9 AND 11)" "$A")" = "f" ]; then ok "F3 order_date_kpi tem dente (created_at deu days=$(val days_since_last_purchase "$A"), A5 quebraria)"; else bad "F3 troquei p/ created_at e A5 NÃO mudou"; fi
P -q -f "$MIG"

# F4: remove GREATEST → futuro vira days NEGATIVO → A15a (days I=0) quebraria.
P -q <<'SQL'
CREATE OR REPLACE FUNCTION public.get_customer_sales_summary()
RETURNS TABLE(customer_user_id uuid, days_since_last_purchase int, total_revenue numeric, revenue_180d numeric, item_count bigint, category_count bigint)
LANGUAGE sql STABLE SECURITY INVOKER SET search_path=public AS $fn$
  SELECT oi.customer_user_id,
    ((now() AT TIME ZONE 'America/Sao_Paulo')::date - max(COALESCE(so.order_date_kpi,so.created_at::date)))::int,  -- SABOTADO: sem GREATEST clamp
    COALESCE(sum(COALESCE(oi.unit_price,0)*COALESCE(NULLIF(oi.quantity,0),1)),0),
    COALESCE(sum(COALESCE(oi.unit_price,0)*COALESCE(NULLIF(oi.quantity,0),1)) FILTER (WHERE COALESCE(so.order_date_kpi,so.created_at::date) BETWEEN (now() AT TIME ZONE 'America/Sao_Paulo')::date-180 AND (now() AT TIME ZONE 'America/Sao_Paulo')::date),0),
    count(*), count(DISTINCT oi.product_id)
  FROM public.order_items oi JOIN public.sales_orders so ON so.id=oi.sales_order_id
  WHERE so.status NOT IN ('cancelado','rascunho','pendente','orcamento')
    AND so.deleted_at IS NULL AND oi.customer_user_id IS NOT NULL
  GROUP BY oi.customer_user_id;
$fn$;
SQL
if [ "$(val "(days_since_last_purchase=0)" "$I")" = "f" ]; then ok "F4 clamp tem dente (futuro deu days=$(val days_since_last_purchase "$I"), A15a quebraria)"; else bad "F4 removi GREATEST e A15a NÃO mudou"; fi
P -q -f "$MIG"

# F5: remove upper bound da janela (só >= hoje-180) → futuro (I) entra no revenue_180d → A15b quebraria.
P -q <<'SQL'
CREATE OR REPLACE FUNCTION public.get_customer_sales_summary()
RETURNS TABLE(customer_user_id uuid, days_since_last_purchase int, total_revenue numeric, revenue_180d numeric, item_count bigint, category_count bigint)
LANGUAGE sql STABLE SECURITY INVOKER SET search_path=public AS $fn$
  SELECT oi.customer_user_id,
    GREATEST(0,(now() AT TIME ZONE 'America/Sao_Paulo')::date - max(COALESCE(so.order_date_kpi,so.created_at::date)))::int,
    COALESCE(sum(COALESCE(oi.unit_price,0)*COALESCE(NULLIF(oi.quantity,0),1)),0),
    COALESCE(sum(COALESCE(oi.unit_price,0)*COALESCE(NULLIF(oi.quantity,0),1)) FILTER (WHERE COALESCE(so.order_date_kpi,so.created_at::date) >= (now() AT TIME ZONE 'America/Sao_Paulo')::date-180),0),  -- SABOTADO: sem upper bound
    count(*), count(DISTINCT oi.product_id)
  FROM public.order_items oi JOIN public.sales_orders so ON so.id=oi.sales_order_id
  WHERE so.status NOT IN ('cancelado','rascunho','pendente','orcamento')
    AND so.deleted_at IS NULL AND oi.customer_user_id IS NOT NULL
  GROUP BY oi.customer_user_id;
$fn$;
SQL
if [ "$(val "(revenue_180d=0)" "$I")" = "f" ]; then ok "F5 upper bound tem dente (futuro entrou: I revenue_180d=$(val revenue_180d "$I"), A15b quebraria)"; else bad "F5 removi upper bound e A15b NÃO mudou"; fi
P -q -f "$MIG"

# F6: revoga EXECUTE de service_role → A16 quebraria.
P -q -c "REVOKE EXECUTE ON FUNCTION public.get_customer_sales_summary() FROM service_role;"
R=$(P -tA 2>&1 <<'SQL'
SET ROLE service_role;
DO $$ BEGIN
  PERFORM 1 FROM public.get_customer_sales_summary();
  RAISE NOTICE 'SR_AINDA_EXECUTA';
EXCEPTION WHEN insufficient_privilege THEN RAISE NOTICE 'SR_NEGADO';
  WHEN OTHERS THEN RAISE; END $$;
SQL
)
case "$R" in *SR_NEGADO*) ok "F6 GRANT tem dente (sem grant, service_role negado → A16 quebraria)";; *) bad "F6 revoguei o grant e service_role AINDA executa: $R";; esac
P -q -f "$MIG"

# F7 (anti-subcontagem v4): provar que a blocklist NÃO deixa orçamento (não-venda) entrar.
# Sabota o WHERE para incluir orçamento → B vira 5300 → A7 (B=300) quebraria.
P -q <<'SQL'
CREATE OR REPLACE FUNCTION public.get_customer_sales_summary()
RETURNS TABLE(customer_user_id uuid, days_since_last_purchase int, total_revenue numeric, revenue_180d numeric, item_count bigint, category_count bigint)
LANGUAGE sql STABLE SECURITY INVOKER SET search_path=public AS $fn$
  SELECT oi.customer_user_id,
    GREATEST(0,(now() AT TIME ZONE 'America/Sao_Paulo')::date - max(COALESCE(so.order_date_kpi,so.created_at::date)))::int,
    COALESCE(sum(COALESCE(oi.unit_price,0)*COALESCE(NULLIF(oi.quantity,0),1)),0),
    COALESCE(sum(COALESCE(oi.unit_price,0)*COALESCE(NULLIF(oi.quantity,0),1)) FILTER (WHERE COALESCE(so.order_date_kpi,so.created_at::date) BETWEEN (now() AT TIME ZONE 'America/Sao_Paulo')::date-180 AND (now() AT TIME ZONE 'America/Sao_Paulo')::date),0),
    count(*), count(DISTINCT oi.product_id)
  FROM public.order_items oi JOIN public.sales_orders so ON so.id=oi.sales_order_id
  WHERE so.status NOT IN ('cancelado','rascunho','pendente')   -- SABOTADO: deixou 'orcamento' entrar
    AND so.deleted_at IS NULL AND oi.customer_user_id IS NOT NULL
  GROUP BY oi.customer_user_id;
$fn$;
SQL
if [ "$(val "(total_revenue=300)" "$B")" = "f" ]; then ok "F7 blocklist exclui orçamento (deixei entrar: B=$(val total_revenue "$B"), A7 quebraria)"; else bad "F7 deixei 'orcamento' entrar e A7 NÃO mudou"; fi
P -q -f "$MIG"

# FTZ (follow-up #4): reverte o fallback p/ created_at::date CRU nas DUAS ocorrências → sob sessão UTC a
# data civil vira a UTC (não a de SP) → TZ1/TZ2 divergem. Prova que o AT TIME ZONE SP do v5 tem dente.
P -q <<'SQL'
CREATE OR REPLACE FUNCTION public.get_customer_sales_summary()
RETURNS TABLE(customer_user_id uuid, days_since_last_purchase int, total_revenue numeric, revenue_180d numeric, item_count bigint, category_count bigint)
LANGUAGE sql STABLE SECURITY INVOKER SET search_path=public AS $fn$
  SELECT oi.customer_user_id,
    GREATEST(0,(now() AT TIME ZONE 'America/Sao_Paulo')::date - max(COALESCE(so.order_date_kpi,so.created_at::date)))::int,  -- SABOTADO: ::date cru (1ª)
    COALESCE(sum(COALESCE(oi.unit_price,0)*COALESCE(NULLIF(oi.quantity,0),1)),0),
    COALESCE(sum(COALESCE(oi.unit_price,0)*COALESCE(NULLIF(oi.quantity,0),1)) FILTER (WHERE COALESCE(so.order_date_kpi,so.created_at::date) BETWEEN (now() AT TIME ZONE 'America/Sao_Paulo')::date-180 AND (now() AT TIME ZONE 'America/Sao_Paulo')::date),0),  -- SABOTADO: ::date cru (2ª)
    count(*), count(DISTINCT oi.product_id)
  FROM public.order_items oi JOIN public.sales_orders so ON so.id=oi.sales_order_id
  WHERE so.status NOT IN ('cancelado','rascunho','pendente','orcamento')
    AND so.deleted_at IS NULL AND oi.customer_user_id IS NOT NULL
  GROUP BY oi.customer_user_id;
$fn$;
SQL
FDR_UTC=$(Pq -c "SET TIME ZONE 'UTC';               SELECT days_since_last_purchase FROM public.get_customer_sales_summary() WHERE customer_user_id='$TZR';" | tail -1)
FDR_SP=$( Pq -c "SET TIME ZONE 'America/Sao_Paulo'; SELECT days_since_last_purchase FROM public.get_customer_sales_summary() WHERE customer_user_id='$TZR';" | tail -1)
if [ "$FDR_UTC" != "$FDR_SP" ]; then ok "FTZ-a recência tem dente (::date cru: days UTC=$FDR_UTC ≠ SP=$FDR_SP, TZ1 quebraria)"; else bad "FTZ-a reverti p/ ::date cru e days UTC==SP ($FDR_UTC)"; fi
FRW_UTC=$(Pq -c "SET TIME ZONE 'UTC';               SELECT revenue_180d FROM public.get_customer_sales_summary() WHERE customer_user_id='$TZW';" | tail -1)
FRW_SP=$( Pq -c "SET TIME ZONE 'America/Sao_Paulo'; SELECT revenue_180d FROM public.get_customer_sales_summary() WHERE customer_user_id='$TZW';" | tail -1)
if [ "$FRW_UTC" != "$FRW_SP" ]; then ok "FTZ-b janela tem dente (::date cru: revenue_180d UTC=$FRW_UTC ≠ SP=$FRW_SP, TZ2 quebraria)"; else bad "FTZ-b reverti p/ ::date cru e revenue_180d UTC==SP ($FRW_UTC)"; fi
P -q -c "SET TIME ZONE 'America/Sao_Paulo';"
P -q -f "$MIG"   # restaura a v5 REAL

# pós-restauração: confirma verde de novo (migration idempotente, asserts voltam)
eq "A19 pós-restauração: blocklist de volta (F=787)" "$(val "(total_revenue=787)" "$F")" "t"
eq "A20 pós-restauração: anti-TZ de volta (days TZR=1 sob UTC)" "$(Pq -c "SET TIME ZONE 'UTC'; SELECT days_since_last_purchase FROM public.get_customer_sales_summary() WHERE customer_user_id='$TZR';" | tail -1)" "1"

echo "──────────────────────────────"
echo "RESULTADO: $PASS ok / $FAIL fail"
[ "$FAIL" = "0" ] || { echo "❌ HARNESS VERMELHO"; exit 1; }
echo "✅ HARNESS VERDE"
