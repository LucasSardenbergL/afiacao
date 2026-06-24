#!/usr/bin/env bash
# ╔══════════════════════════════════════════════════════════════════════════════╗
# ║  PROVA PG17 — customer_metrics_mv: recência por order_date_kpi (dInc), não      ║
# ║  created_at (=previsão/now). Money-path Fase 2b. Alinha c/ get_customer_sales_  ║
# ║  summary. Codex xhigh 2026-06-23: teto/sem-overlap · AT TIME ZONE SP · cast     ║
# ║  numeric · DROP+CREATE transacional · contrato late-bound de get_customer_metrics.║
# ║  Lei de Ferro: migration REAL (psql -f) · assert negativo c/ SQLSTATE · falsific.║
# ╚══════════════════════════════════════════════════════════════════════════════╝
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PGVER=17
PGBIN="/opt/homebrew/opt/postgresql@${PGVER}/bin"
PORT="${PGPORT_TEST:-5467}"
SLUG="cmmv"
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

# ══ ZONA 1 — pré-requisitos: tabelas que a MV lê (colunas que ela toca) ══
P -q <<'SQL'
CREATE TABLE public.profiles (
  user_id     uuid PRIMARY KEY,
  name        text,
  document    text,
  is_employee boolean
);
CREATE TABLE public.sales_orders (
  id               uuid PRIMARY KEY,
  customer_user_id uuid NOT NULL,
  status           text NOT NULL,
  order_date_kpi   date,
  created_at       timestamptz,
  total            numeric
);
-- helper de teste (NÃO vai pra prod): hoje em SP menos n dias — mesma referência que a MV usa.
CREATE FUNCTION public.tdy(int) RETURNS date LANGUAGE sql AS $$ SELECT (now() AT TIME ZONE 'America/Sao_Paulo')::date - $1 $$;
SQL

# ══ ZONA 2 — aplica a migration REAL (Lei #1: o .sql commitado, não um stub) ══
MIG="$REPO_ROOT/supabase/migrations/20260623140000_recencia_mv_order_date_kpi.sql"
P -q -f "$MIG"
echo "migration aplicada: $(basename "$MIG")"

# get_customer_metrics() — assinatura EXATA de prod (contrato late-bound a provar). NÃO é da migration;
# crio aqui pra testar que a NOVA MV não quebra o SELECT * (tipos/ordem das 13 colunas).
P -q <<'SQL'
CREATE OR REPLACE FUNCTION public.get_customer_metrics()
 RETURNS TABLE(customer_user_id uuid, razao_social text, document text, ultima_compra_data timestamptz,
   dias_desde_ultima_compra integer, pedidos_90d bigint, faturamento_90d numeric, ticket_medio_90d numeric,
   faturamento_prev_90d numeric, intervalo_medio_dias numeric, atraso_relativo numeric,
   is_cold_start boolean, calculated_at timestamptz)
 LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $$ SELECT * FROM public.customer_metrics_mv; $$;
SQL

# ══ ZONA 3 — seed (datas relativas a hoje-SP via tdy(), mesma referência da MV) ══
K='a0000000-0000-0000-0000-000000000001'    # kpi-divergente (Oben-like): kpi=D-10, created_at=D-2 (previsão+recente)
N='a0000000-0000-0000-0000-000000000002'    # kpi-NULL → COALESCE created_at (D-5)
FUT='a0000000-0000-0000-0000-000000000003'  # previsão FUTURA (kpi-null, created_at=D+30)
B90='a0000000-0000-0000-0000-000000000004'  # borda: kpi=D-90 (entra 90d, NÃO prev)
B91='a0000000-0000-0000-0000-000000000005'  # borda: kpi=D-91 (entra prev, NÃO 90d)
CAD='a0000000-0000-0000-0000-000000000006'  # cadência não-inteira: D-50,D-30,D-5 → 22.5
EMP='a0000000-0000-0000-0000-000000000007'  # is_employee=true → fora da MV
CANC='a0000000-0000-0000-0000-000000000008' # só pedido cancelado → cold (9999), fora das janelas
TZ='a0000000-0000-0000-0000-000000000009'   # fallback TZ-borda: kpi-null, created_at=hoje 02:30 UTC = ontem 23:30 SP
P -q <<SQL
INSERT INTO public.profiles (user_id, name, document, is_employee) VALUES
  ('$K','K','d',false),('$N','N','d',false),('$FUT','FUT','d',false),('$B90','B90','d',false),
  ('$B91','B91','d',false),('$CAD','CAD','d',false),('$EMP','EMP','d',true),('$CANC','CANC','d',false),('$TZ','TZ','d',false);

INSERT INTO public.sales_orders (id, customer_user_id, status, order_date_kpi, created_at, total) VALUES
  ('50000000-0000-0000-0000-000000000001','$K','faturado',  tdy(10), (tdy(2)+time '12:00') AT TIME ZONE 'America/Sao_Paulo', 200),
  ('50000000-0000-0000-0000-000000000002','$N','faturado',  NULL,    (tdy(5)+time '12:00') AT TIME ZONE 'America/Sao_Paulo', 100),
  ('50000000-0000-0000-0000-000000000003','$FUT','faturado',NULL,    (tdy(-30)+time '12:00') AT TIME ZONE 'America/Sao_Paulo', 999),
  ('50000000-0000-0000-0000-000000000004','$B90','faturado',tdy(90), (tdy(90)+time '12:00') AT TIME ZONE 'America/Sao_Paulo', 50),
  ('50000000-0000-0000-0000-000000000005','$B91','faturado',tdy(91), (tdy(91)+time '12:00') AT TIME ZONE 'America/Sao_Paulo', 60),
  ('50000000-0000-0000-0000-000000000006','$CAD','faturado',tdy(50), (tdy(50)+time '12:00') AT TIME ZONE 'America/Sao_Paulo', 10),
  ('50000000-0000-0000-0000-000000000007','$CAD','faturado',tdy(30), (tdy(30)+time '12:00') AT TIME ZONE 'America/Sao_Paulo', 10),
  ('50000000-0000-0000-0000-000000000008','$CAD','faturado',tdy(5),  (tdy(5)+time '12:00') AT TIME ZONE 'America/Sao_Paulo', 10),
  ('50000000-0000-0000-0000-000000000009','$EMP','faturado',tdy(1),  (tdy(1)+time '12:00') AT TIME ZONE 'America/Sao_Paulo', 70),
  ('50000000-0000-0000-0000-000000000010','$CANC','cancelado',tdy(1),(tdy(1)+time '12:00') AT TIME ZONE 'America/Sao_Paulo', 80),
  ('50000000-0000-0000-0000-000000000011','$TZ','faturado', NULL,    (tdy(0)+time '02:30') AT TIME ZONE 'UTC', 40);
SQL
P -q -c "REFRESH MATERIALIZED VIEW public.customer_metrics_mv;"

mvval()  { Pq -c "SELECT $1 FROM public.customer_metrics_mv WHERE customer_user_id='$2';"; }
mvcnt()  { Pq -c "SELECT count(*) FROM public.customer_metrics_mv WHERE customer_user_id='$2';"; }

# mk_mv: recria a MV com 5 fragmentos parametrizados. Versão CORRETA reproduz o arquivo (S1 valida).
# As falsificações trocam UM fragmento e exigem vermelho. (Restauração sempre via psql -f = arquivo real.)
mk_mv() { # $1 d_expr  $2 ultima_expr  $3 teto90  $4 prev_upper(< ou <=)  $5 cad_expr
P -q <<SQL
DROP MATERIALIZED VIEW IF EXISTS public.customer_metrics_mv;
CREATE MATERIALIZED VIEW public.customer_metrics_mv AS
WITH base AS (SELECT so.customer_user_id, so.total, $1 AS d FROM public.sales_orders so WHERE so.status <> ALL (ARRAY['cancelado'::text,'rascunho'::text])),
last_order AS (SELECT customer_user_id, $2 AS ultima_compra_data, GREATEST(0,(now() AT TIME ZONE 'America/Sao_Paulo')::date - max(d))::integer AS dias_desde_ultima_compra FROM base GROUP BY customer_user_id),
orders_90d AS (SELECT customer_user_id, count(*) AS pedidos_90d, COALESCE(sum(total),0::numeric) AS faturamento_90d, CASE WHEN count(*)>0 THEN COALESCE(sum(total),0::numeric)/count(*)::numeric ELSE 0::numeric END AS ticket_medio_90d FROM base WHERE d >= (now() AT TIME ZONE 'America/Sao_Paulo')::date-90 $3 GROUP BY customer_user_id),
orders_prev_90d AS (SELECT customer_user_id, COALESCE(sum(total),0::numeric) AS faturamento_prev_90d FROM base WHERE d >= (now() AT TIME ZONE 'America/Sao_Paulo')::date-180 AND d $4 (now() AT TIME ZONE 'America/Sao_Paulo')::date-90 GROUP BY customer_user_id),
cadence AS (SELECT customer_user_id, CASE WHEN count(*)>=3 THEN $5 ELSE NULL::numeric END AS intervalo_medio_dias FROM base GROUP BY customer_user_id)
SELECT p.user_id AS customer_user_id, p.name AS razao_social, p.document, lo.ultima_compra_data, COALESCE(lo.dias_desde_ultima_compra,9999) AS dias_desde_ultima_compra, COALESCE(o90.pedidos_90d,0::bigint) AS pedidos_90d, COALESCE(o90.faturamento_90d,0::numeric) AS faturamento_90d, COALESCE(o90.ticket_medio_90d,0::numeric) AS ticket_medio_90d, COALESCE(op.faturamento_prev_90d,0::numeric) AS faturamento_prev_90d, c.intervalo_medio_dias, CASE WHEN c.intervalo_medio_dias IS NOT NULL AND c.intervalo_medio_dias>0::numeric THEN COALESCE(lo.dias_desde_ultima_compra,9999)::numeric/c.intervalo_medio_dias ELSE NULL::numeric END AS atraso_relativo, CASE WHEN c.intervalo_medio_dias IS NULL THEN true ELSE false END AS is_cold_start, now() AS calculated_at
FROM public.profiles p
LEFT JOIN last_order lo ON lo.customer_user_id=p.user_id
LEFT JOIN orders_90d o90 ON o90.customer_user_id=p.user_id
LEFT JOIN orders_prev_90d op ON op.customer_user_id=p.user_id
LEFT JOIN cadence c ON c.customer_user_id=p.user_id
WHERE p.is_employee=false OR p.is_employee IS NULL;
SQL
}
D_OK="COALESCE(so.order_date_kpi,(so.created_at AT TIME ZONE 'America/Sao_Paulo')::date)"
U_OK="(max(d)::timestamp AT TIME ZONE 'America/Sao_Paulo')"
T_OK="AND d <= (now() AT TIME ZONE 'America/Sao_Paulo')::date"
C_OK="((max(d)-min(d))::numeric / NULLIF(count(*)-1,0))"

echo "── asserts positivos / money-path (migration REAL) ──"
eq "P1 K dias_desde=10 (usa order_date_kpi, NÃO created_at=2)"      "$(mvval dias_desde_ultima_compra "$K")" "10"
eq "P2 K faturamento_90d=200 (D-10 dentro)"                         "$(mvval faturamento_90d "$K")" "200"
eq "P3 N dias_desde=5 (kpi NULL → COALESCE created_at)"            "$(mvval dias_desde_ultima_compra "$N")" "5"
eq "P4 FUT faturamento_90d=0 (previsão futura fora do TETO)"        "$(mvval faturamento_90d "$FUT")" "0"
eq "P5 FUT dias_desde=0 (GREATEST clamp do futuro)"                "$(mvval dias_desde_ultima_compra "$FUT")" "0"
eq "P6 B90 faturamento_90d=50 (D-90 dentro)"                       "$(mvval faturamento_90d "$B90")" "50"
eq "P7 B90 faturamento_prev_90d=0 (NÃO no prev — sem overlap)"     "$(mvval faturamento_prev_90d "$B90")" "0"
eq "P8a B91 faturamento_90d=0 (D-91 fora do 90d)"                  "$(mvval faturamento_90d "$B91")" "0"
eq "P8b B91 faturamento_prev_90d=60 (D-91 no prev)"               "$(mvval faturamento_prev_90d "$B91")" "60"
eq "P9 CAD intervalo_medio_dias=22.5 (cast numeric, não trunca)"   "$(mvval intervalo_medio_dias "$CAD")" "22.5000000000000000"
eq "P10 EMP fora da MV (is_employee=true)"                         "$(mvcnt x "$EMP")" "0"
eq "P11 CANC dias_desde=9999 (só cancelado → cold)"               "$(mvval dias_desde_ultima_compra "$CANC")" "9999"
eq "P12 TZ dias_desde=1 (fallback AT TIME ZONE SP: 02:30 UTC = ontem SP)" "$(mvval dias_desde_ultima_compra "$TZ")" "1"
eq "P13 K ultima_compra_data = meia-noite SP de D-10"             "$(mvval "ultima_compra_data = (tdy(10)::timestamp AT TIME ZONE 'America/Sao_Paulo')" "$K")" "t"

echo "── contrato late-bound: get_customer_metrics() SELECT * (tipos/ordem das 13 colunas) ──"
eq "C1 get_customer_metrics() roda + count = MV"  "$(Pq -c "SELECT count(*) FROM public.get_customer_metrics();")" "$(Pq -c "SELECT count(*) FROM public.customer_metrics_mv;")"
eq "C2 ultima_compra_data é timestamptz (pg_typeof via RPC)" "$(Pq -c "SELECT pg_typeof(ultima_compra_data)::text FROM public.get_customer_metrics() LIMIT 1;")" "timestamp with time zone"

echo "── GRANT (SQLSTATE 42501 + re-raise) ──"
eq "G1 service_role SELECT ok" "$(Pq -c "SET ROLE service_role; SELECT count(*) FROM public.customer_metrics_mv;" | tail -1)" "8"
R=$(P -tA 2>&1 <<'SQL'
SET ROLE authenticated;
DO $$ BEGIN
  PERFORM 1 FROM public.customer_metrics_mv;
  RAISE EXCEPTION 'AUTH_LEU';
EXCEPTION WHEN insufficient_privilege THEN RAISE NOTICE 'AUTH_NEGADO_OK';
  WHEN OTHERS THEN RAISE; END $$;
SQL
)
case "$R" in *AUTH_NEGADO_OK*) ok "G2 authenticated SELECT negado (42501)";; *) bad "G2 authenticated — veio: $R";; esac

echo "── anti-timezone (REFRESH sob UTC vs SP → resultados IDÊNTICOS) ──"
P -q -c "SET TIME ZONE 'UTC'; REFRESH MATERIALIZED VIEW public.customer_metrics_mv;"
TZ_EPOCH_UTC=$(Pq -c "SET TIME ZONE 'UTC'; SELECT extract(epoch FROM ultima_compra_data)::bigint FROM public.customer_metrics_mv WHERE customer_user_id='$K';" | tail -1)
TZ_DIAS_UTC=$(Pq -c "SET TIME ZONE 'UTC'; SELECT dias_desde_ultima_compra FROM public.customer_metrics_mv WHERE customer_user_id='$K';" | tail -1)
P -q -c "SET TIME ZONE 'America/Sao_Paulo'; REFRESH MATERIALIZED VIEW public.customer_metrics_mv;"
TZ_EPOCH_SP=$(Pq -c "SET TIME ZONE 'America/Sao_Paulo'; SELECT extract(epoch FROM ultima_compra_data)::bigint FROM public.customer_metrics_mv WHERE customer_user_id='$K';" | tail -1)
TZ_DIAS_SP=$(Pq -c "SET TIME ZONE 'America/Sao_Paulo'; SELECT dias_desde_ultima_compra FROM public.customer_metrics_mv WHERE customer_user_id='$K';" | tail -1)
eq "TZ1 epoch(ultima_compra_data K) idêntico UTC×SP" "$TZ_EPOCH_UTC" "$TZ_EPOCH_SP"
eq "TZ2 dias_desde K idêntico UTC×SP"                "$TZ_DIAS_UTC" "$TZ_DIAS_SP"
P -q -f "$MIG"   # restaura estado canônico (TZ default)

echo "── S1: mk_mv(correto) reproduz o arquivo real (fidelidade do falsificador) ──"
mk_mv "$D_OK" "$U_OK" "$T_OK" "<" "$C_OK"
eq "S1a mk_mv-correto: K dias_desde=10" "$(mvval dias_desde_ultima_compra "$K")" "10"
eq "S1b mk_mv-correto: CAD=22.5"        "$(mvval intervalo_medio_dias "$CAD")" "22.5000000000000000"
eq "S1c mk_mv-correto: FUT fat_90d=0"   "$(mvval faturamento_90d "$FUT")" "0"

echo "── falsificação (sabota 1 fragmento → exige VERMELHO → restaura arquivo) ──"
# F1: d = created_at cru (sem order_date_kpi) → K passa a refletir D-2, não D-10.
mk_mv "(so.created_at AT TIME ZONE 'America/Sao_Paulo')::date" "$U_OK" "$T_OK" "<" "$C_OK"
if [ "$(mvval dias_desde_ultima_compra "$K")" != "10" ]; then ok "F1 order_date_kpi tem dente (created_at deu dias=$(mvval dias_desde_ultima_compra "$K"), P1 quebraria)"; else bad "F1 sabotei p/ created_at e P1 NÃO mudou"; fi

# F2: ultima_compra_data = max(d)::timestamptz (sem AT TIME ZONE) → epoch difere entre UTC e SP.
mk_mv "$D_OK" "max(d)::timestamptz" "$T_OK" "<" "$C_OK"
P -q -c "SET TIME ZONE 'UTC'; REFRESH MATERIALIZED VIEW public.customer_metrics_mv;"
E_UTC=$(Pq -c "SET TIME ZONE 'UTC'; SELECT extract(epoch FROM ultima_compra_data)::bigint FROM public.customer_metrics_mv WHERE customer_user_id='$K';" | tail -1)
P -q -c "SET TIME ZONE 'America/Sao_Paulo'; REFRESH MATERIALIZED VIEW public.customer_metrics_mv;"
E_SP=$(Pq -c "SET TIME ZONE 'America/Sao_Paulo'; SELECT extract(epoch FROM ultima_compra_data)::bigint FROM public.customer_metrics_mv WHERE customer_user_id='$K';" | tail -1)
if [ "$E_UTC" != "$E_SP" ]; then ok "F2 AT TIME ZONE tem dente (cast cru: epoch UTC=$E_UTC ≠ SP=$E_SP, TZ1 quebraria)"; else bad "F2 tirei AT TIME ZONE e epoch UTC==SP"; fi

# F3: sem TETO superior no 90d → FUT (previsão futura) entra no faturamento_90d.
mk_mv "$D_OK" "$U_OK" "" "<" "$C_OK"
if [ "$(mvval faturamento_90d "$FUT")" != "0" ]; then ok "F3 teto-90d tem dente (futuro entrou: FUT fat=$(mvval faturamento_90d "$FUT"), P4 quebraria)"; else bad "F3 removi o teto e P4 NÃO mudou"; fi

# F4: cadência sem ::numeric → 45/2 = 22 (integer division), não 22.5.
mk_mv "$D_OK" "$U_OK" "$T_OK" "<" "((max(d)-min(d)) / NULLIF(count(*)-1,0))"
if [ "$(mvval intervalo_medio_dias "$CAD")" != "22.5000000000000000" ]; then ok "F4 cast numeric tem dente (trunca: CAD=$(mvval intervalo_medio_dias "$CAD"), P9 quebraria)"; else bad "F4 tirei ::numeric e CAD seguiu 22.5"; fi

# F5: fallback created_at::date SEM AT TIME ZONE → sob sessão UTC, TZ vira hoje (dias=0), não 1.
mk_mv "COALESCE(so.order_date_kpi, so.created_at::date)" "$U_OK" "$T_OK" "<" "$C_OK"
P -q -c "SET TIME ZONE 'UTC'; REFRESH MATERIALIZED VIEW public.customer_metrics_mv;"
TZD=$(Pq -c "SET TIME ZONE 'UTC'; SELECT dias_desde_ultima_compra FROM public.customer_metrics_mv WHERE customer_user_id='$TZ';" | tail -1)
if [ "$TZD" != "1" ]; then ok "F5 TZ-no-fallback tem dente (created_at::date cru sob UTC deu dias=$TZD, P12 quebraria)"; else bad "F5 tirei AT TIME ZONE do fallback e TZ seguiu 1 sob UTC"; fi
P -q -c "SET TIME ZONE 'America/Sao_Paulo';"

# F6: prev com <= today-90 → B90 (D-90) entra no prev também (overlap).
mk_mv "$D_OK" "$U_OK" "$T_OK" "<=" "$C_OK"
if [ "$(mvval faturamento_prev_90d "$B90")" != "0" ]; then ok "F6 sem-overlap tem dente (D-90 entrou no prev: B90 prev=$(mvval faturamento_prev_90d "$B90"), P7 quebraria)"; else bad "F6 troquei prev p/ <= e B90 prev seguiu 0"; fi

# F7 (contrato SILENCIOSO): ultima_compra_data como date NÃO quebra a RPC — o PG coage date→timestamptz.
# A coerção usa a TZ da SESSÃO da RPC → reintroduz não-determinismo SILENCIOSAMENTE (pior que quebra dura).
# Prova que preservar timestamptz COM (max(d)::timestamp AT TIME ZONE SP) na MV é o que blinda — não só o tipo.
mk_mv "$D_OK" "max(d)" "$T_OK" "<" "$C_OK"
EU=$(Pq -c "SET TIME ZONE 'UTC'; SELECT extract(epoch FROM ultima_compra_data)::bigint FROM public.get_customer_metrics() WHERE customer_user_id='$K';" | tail -1)
ES=$(Pq -c "SET TIME ZONE 'America/Sao_Paulo'; SELECT extract(epoch FROM ultima_compra_data)::bigint FROM public.get_customer_metrics() WHERE customer_user_id='$K';" | tail -1)
if [ "$EU" != "$ES" ]; then ok "F7 contrato-silencioso tem dente (date coage na RPC TZ-dependente: epoch UTC=$EU ≠ SP=$ES; C2/TZ1 protegem)"; else bad "F7 ultima_compra_data=date e epoch via RPC UTC==SP ($EU)"; fi
P -q -f "$MIG"   # restaura a migration REAL

echo "── pós-restauração: verde de novo (idempotência) ──"
P -q -c "REFRESH MATERIALIZED VIEW public.customer_metrics_mv;"
eq "P14 K dias_desde=10 de volta" "$(mvval dias_desde_ultima_compra "$K")" "10"

echo "──────────────────────────────"
echo "RESULTADO: $PASS ok / $FAIL fail"
[ "$FAIL" = "0" ] || { echo "❌ HARNESS VERMELHO"; exit 1; }
echo "✅ HARNESS VERDE"
