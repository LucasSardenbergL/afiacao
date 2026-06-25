#!/usr/bin/env bash
# ╔══════════════════════════════════════════════════════════════════════════════╗
# ║  PROVA PG17 — 20260624170000_recencia_fonte_trigger_backfill                  ║
# ║  Trigger (order_items herda created_at do PAI, só Omie) + backfill oben+colacor║
# ║  bash db/test-recencia-fonte-trigger-backfill.sh > /tmp/t.log 2>&1; echo $?    ║
# ╚══════════════════════════════════════════════════════════════════════════════╝
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PGVER=17
PGBIN="/opt/homebrew/opt/postgresql@${PGVER}/bin"
PORT="${PGPORT_TEST:-5466}"
SLUG="recencia-fonte"
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

PASS=0; FAIL=0
ok()  { PASS=$((PASS+1)); echo "  ✅ $1"; }
bad() { FAIL=$((FAIL+1)); echo "  ❌ $1"; }
eq()  { if [ "$2" = "$3" ]; then ok "$1 (=$2)"; else bad "$1 — esperado [$3], veio [$2]"; fi; }

# roles base do Supabase (anon/authenticated/service_role) — a migration faz REVOKE neles
P -q -f "$REPO_ROOT/db/stubs-supabase.sql"
echo "═══ setup PG17 :$PORT ═══"

# ══════════════════════════════════════════════════════════════════════════════
# ZONA 1 — schema mínimo + SEED SUJO (antes da migration → não dispara o trigger)
# ══════════════════════════════════════════════════════════════════════════════
# created_at com DEFAULT now() (como prod) → prova que o trigger sobrescreve o default.
P -q <<'SQL'
CREATE TABLE public.sales_orders (
  id uuid PRIMARY KEY,
  account text,
  hash_payload text,
  order_date_kpi date,
  customer_user_id uuid,
  status text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE public.order_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sales_order_id uuid,
  customer_user_id uuid,
  omie_codigo_produto bigint,
  quantity numeric,
  unit_price numeric,
  discount numeric,
  product_id uuid,
  hash_payload text,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- A: Omie colacor SUJO (created_at=previsão futura 06-15; kpi=06-10)
INSERT INTO public.sales_orders(id, account, hash_payload, order_date_kpi, created_at) VALUES
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','colacor','omie_colacor_1001','2026-06-10','2026-06-15T03:00:00Z');
INSERT INTO public.order_items(sales_order_id, omie_codigo_produto, created_at) VALUES
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 101, '2026-03-05T10:00:00Z');  -- data de CARGA antiga

-- B: Omie oben — caso 00:00Z (bate em UTC, DIVERGE em SP). kpi=06-20
INSERT INTO public.sales_orders(id, account, hash_payload, order_date_kpi, created_at) VALUES
  ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb','oben','omie_oben_2002','2026-06-20','2026-06-20T00:00:00Z');
INSERT INTO public.order_items(sales_order_id, omie_codigo_produto, created_at) VALUES
  ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 202, '2026-06-20T00:00:00Z');

-- C: NÃO-Omie (app) — created_at = data real do app. NÃO deve ser tocado. kpi=06-01
INSERT INTO public.sales_orders(id, account, hash_payload, order_date_kpi, created_at) VALUES
  ('cccccccc-cccc-cccc-cccc-cccccccccccc','colacor','app_colacor_3003','2026-06-01','2026-06-22T14:30:00Z');
INSERT INTO public.order_items(sales_order_id, omie_codigo_produto, created_at) VALUES
  ('cccccccc-cccc-cccc-cccc-cccccccccccc', 303, '2026-06-22T14:30:00Z');

-- D: Omie oben com order_date_kpi NULL — NÃO deve ser tocado
INSERT INTO public.sales_orders(id, account, hash_payload, order_date_kpi, created_at) VALUES
  ('dddddddd-dddd-dddd-dddd-dddddddddddd','oben','omie_oben_999',NULL,'2026-06-25T00:00:00Z');

-- E: Omie colacor JÁ ALINHADO (meio-dia UTC). NÃO deve ser tocado (idempotência). kpi=06-12
INSERT INTO public.sales_orders(id, account, hash_payload, order_date_kpi, created_at) VALUES
  ('eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee','colacor','omie_colacor_5005','2026-06-12','2026-06-12T12:00:00Z');
SQL
echo "seed sujo aplicado (pré-trigger)"

# ══════════════════════════════════════════════════════════════════════════════
# ZONA 2 — APLICAR A MIGRATION REAL (cria o trigger + roda o backfill sobre o seed)
# ══════════════════════════════════════════════════════════════════════════════
MIG="$REPO_ROOT/supabase/migrations/20260624170000_recencia_fonte_trigger_backfill.sql"
P -q -f "$MIG"
echo "migration aplicada: $(basename "$MIG")"

# ══════════════════════════════════════════════════════════════════════════════
# ZONA 4 — ASSERTS
# ══════════════════════════════════════════════════════════════════════════════
echo "── asserts: BACKFILL (efeito no apply) ──"
TS() { Pq -c "SELECT to_char(created_at AT TIME ZONE 'UTC','YYYY-MM-DD HH24:MI:SS') FROM $1 WHERE $2;"; }

eq "P3a pai A corrigido p/ meio-dia UTC do kpi" "$(TS public.sales_orders "id='aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'")" "2026-06-10 12:00:00"
eq "P3b filho A1 corrigido (data de carga → data do pedido)" "$(TS public.order_items "sales_order_id='aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'")" "2026-06-10 12:00:00"
eq "M2 pai B (00:00Z) corrigido — predicado SP pegou apesar de bater UTC" "$(TS public.sales_orders "id='bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'")" "2026-06-20 12:00:00"
eq "M2b filho B1 (00:00Z) corrigido" "$(TS public.order_items "sales_order_id='bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'")" "2026-06-20 12:00:00"
eq "N2a pai C (NÃO-omie) INTOCADO" "$(TS public.sales_orders "id='cccccccc-cccc-cccc-cccc-cccccccccccc'")" "2026-06-22 14:30:00"
eq "N2a' filho C1 (NÃO-omie) INTOCADO" "$(TS public.order_items "sales_order_id='cccccccc-cccc-cccc-cccc-cccccccccccc'")" "2026-06-22 14:30:00"
eq "N2b pai D (kpi NULL) INTOCADO" "$(TS public.sales_orders "id='dddddddd-dddd-dddd-dddd-dddddddddddd'")" "2026-06-25 00:00:00"
eq "P3c pai E (já alinhado) INTOCADO" "$(TS public.sales_orders "id='eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee'")" "2026-06-12 12:00:00"

# M1: 0 divergentes (UTC E SP) entre Omie+kpi-not-null após backfill
DIV=$(Pq -c "SELECT count(*) FROM public.sales_orders WHERE hash_payload LIKE 'omie\_%' AND order_date_kpi IS NOT NULL AND ((created_at AT TIME ZONE 'UTC')::date <> order_date_kpi OR (created_at AT TIME ZONE 'America/Sao_Paulo')::date <> order_date_kpi);")
eq "M1 pais Omie divergentes (UTC|SP) após backfill" "$DIV" "0"
DIVI=$(Pq -c "SELECT count(*) FROM public.order_items oi JOIN public.sales_orders so ON so.id=oi.sales_order_id WHERE so.hash_payload LIKE 'omie\_%' AND so.order_date_kpi IS NOT NULL AND ((oi.created_at AT TIME ZONE 'UTC')::date <> so.order_date_kpi OR (oi.created_at AT TIME ZONE 'America/Sao_Paulo')::date <> so.order_date_kpi);")
eq "M1' itens Omie divergentes (UTC|SP) após backfill" "$DIVI" "0"

# N3: idempotência — re-rodar os 2 UPDATEs do backfill afeta 0 linhas
REIDEM=$(Pq -c "WITH u AS (UPDATE public.sales_orders SET created_at=((order_date_kpi+time '12:00') AT TIME ZONE 'UTC') WHERE account IN ('colacor','oben') AND hash_payload LIKE 'omie\_%' AND order_date_kpi IS NOT NULL AND ((created_at AT TIME ZONE 'UTC')::date <> order_date_kpi OR (created_at AT TIME ZONE 'America/Sao_Paulo')::date <> order_date_kpi) RETURNING 1) SELECT count(*) FROM u;")
eq "N3 backfill idempotente (re-run pai = 0 linhas)" "$REIDEM" "0"

# P4: paridade edge × backfill (mesmo instante)
PAR=$(Pq -c "SELECT ('2026-06-10T12:00:00.000Z'::timestamptz = ((date '2026-06-10' + time '12:00') AT TIME ZONE 'UTC'));")
eq "P4 paridade edge('T12:00Z') = backfill('+12:00 AT UTC')" "$PAR" "t"

echo "── asserts: TRIGGER (insert pós-migration) ──"
# P1: item NOVO em pedido Omie E (pai 06-12 12:00) SEM created_at → herda o pai (não now())
P -q -c "INSERT INTO public.order_items(sales_order_id, omie_codigo_produto) VALUES ('eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee', 501);"
eq "P1 trigger: item Omie sem created_at herda o pai" "$(TS public.order_items "sales_order_id='eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee' AND omie_codigo_produto=501")" "2026-06-12 12:00:00"

# P2: item NOVO em pedido Omie E com created_at SUJO explícito (2099) → SOBRESCRITO pelo pai
P -q -c "INSERT INTO public.order_items(sales_order_id, omie_codigo_produto, created_at) VALUES ('eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee', 502, '2099-01-01T00:00:00Z');"
eq "P2 trigger: created_at sujo explícito é sobrescrito pelo pai" "$(TS public.order_items "sales_order_id='eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee' AND omie_codigo_produto=502")" "2026-06-12 12:00:00"

# N1: item NOVO em pedido NÃO-Omie C com created_at explícito (2099) → INTOCADO (trigger não age)
P -q -c "INSERT INTO public.order_items(sales_order_id, omie_codigo_produto, created_at) VALUES ('cccccccc-cccc-cccc-cccc-cccccccccccc', 504, '2099-01-01T00:00:00Z');"
eq "N1 trigger: item de pedido NÃO-omie fica com o created_at passado" "$(TS public.order_items "sales_order_id='cccccccc-cccc-cccc-cccc-cccccccccccc' AND omie_codigo_produto=504")" "2099-01-01 00:00:00"

# ══════════════════════════════════════════════════════════════════════════════
# ZONA 5 — FALSIFICAÇÃO (sabota → exige VERMELHO → restaura)
# ══════════════════════════════════════════════════════════════════════════════
echo "── falsificação ──"

# FAL-2: meia-noite UTC recua 1 dia em SP (prova que a escolha MEIO-DIA tem dente)
MN_SP=$(Pq -c "SELECT to_char(((date '2026-06-10' + time '00:00') AT TIME ZONE 'UTC') AT TIME ZONE 'America/Sao_Paulo','YYYY-MM-DD');")
eq "FAL-2 meia-noite UTC vira 06-09 em SP (recua)" "$MN_SP" "2026-06-09"
MD_SP=$(Pq -c "SELECT to_char(((date '2026-06-10' + time '12:00') AT TIME ZONE 'UTC') AT TIME ZONE 'America/Sao_Paulo','YYYY-MM-DD');")
eq "FAL-2 meio-dia UTC mantém 06-10 em SP" "$MD_SP" "2026-06-10"

# FAL-3: predicado SÓ-UTC deixa o caso B (00:00Z) passar; UTC OR SP corrige
P -q -c "UPDATE public.sales_orders SET created_at='2026-06-20T00:00:00Z' WHERE id='bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';"
SOUTC=$(Pq -c "WITH u AS (UPDATE public.sales_orders SET created_at=((order_date_kpi+time '12:00') AT TIME ZONE 'UTC') WHERE id='bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb' AND (created_at AT TIME ZONE 'UTC')::date <> order_date_kpi RETURNING 1) SELECT count(*) FROM u;")
eq "FAL-3 predicado SÓ-UTC NÃO corrige B (deixa passar)" "$SOUTC" "0"
BSP=$(Pq -c "SELECT ((created_at AT TIME ZONE 'America/Sao_Paulo')::date <> order_date_kpi) FROM public.sales_orders WHERE id='bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';")
eq "FAL-3 B segue divergente em SP (furo do só-UTC exposto)" "$BSP" "t"
P -q -c "UPDATE public.sales_orders SET created_at=((order_date_kpi+time '12:00') AT TIME ZONE 'UTC') WHERE id='bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb' AND ((created_at AT TIME ZONE 'UTC')::date <> order_date_kpi OR (created_at AT TIME ZONE 'America/Sao_Paulo')::date <> order_date_kpi);"
eq "FAL-3 predicado real (UTC OR SP) corrige B" "$(TS public.sales_orders "id='bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'")" "2026-06-20 12:00:00"

# FAL-4: SEM o trigger, item Omie nasce com now() (não herda o pai)
P -q -c "DROP TRIGGER trg_order_items_created_at_omie ON public.order_items;"
P -q -c "INSERT INTO public.order_items(sales_order_id, omie_codigo_produto) VALUES ('eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee', 888);"
SEMTRIG=$(Pq -c "SELECT ((created_at AT TIME ZONE 'UTC')::date = '2026-06-12') FROM public.order_items WHERE sales_order_id='eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee' AND omie_codigo_produto=888;")
eq "FAL-4 sem trigger item Omie NÃO herda o pai (fica now)" "$SEMTRIG" "f"
P -q -c "DELETE FROM public.order_items WHERE sales_order_id='eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee' AND omie_codigo_produto=888;"

# FAL-1: trigger SEM o filtro omie_ tocaria pedido do app (prova que o filtro tem dente)
P -q <<'SQL'
CREATE OR REPLACE FUNCTION public.order_items_herdar_created_at_omie() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $f$
DECLARE v_pai timestamptz;
BEGIN
  SELECT created_at INTO v_pai FROM public.sales_orders WHERE id = NEW.sales_order_id;
  NEW.created_at := v_pai;   -- SABOTADO: sem o IF hash LIKE 'omie_%'
  RETURN NEW;
END; $f$;
CREATE TRIGGER trg_order_items_created_at_omie BEFORE INSERT ON public.order_items FOR EACH ROW EXECUTE FUNCTION public.order_items_herdar_created_at_omie();
SQL
P -q -c "INSERT INTO public.order_items(sales_order_id, omie_codigo_produto, created_at) VALUES ('cccccccc-cccc-cccc-cccc-cccccccccccc', 777, '2099-01-01T00:00:00Z');"
SAB=$(TS public.order_items "sales_order_id='cccccccc-cccc-cccc-cccc-cccccccccccc' AND omie_codigo_produto=777")
eq "FAL-1 sem filtro toca pedido NÃO-omie (vira o pai, não 2099)" "$SAB" "2026-06-22 14:30:00"
# restaura a função+trigger REAIS (re-aplica a migration; backfill idempotente=0)
P -q -c "DELETE FROM public.order_items WHERE sales_order_id='cccccccc-cccc-cccc-cccc-cccccccccccc' AND omie_codigo_produto=777;"
P -q -c "DROP TRIGGER trg_order_items_created_at_omie ON public.order_items;"
P -q -f "$MIG"
# confirma restaurado: item não-omie volta a ficar intocado
P -q -c "INSERT INTO public.order_items(sales_order_id, omie_codigo_produto, created_at) VALUES ('cccccccc-cccc-cccc-cccc-cccccccccccc', 779, '2099-01-01T00:00:00Z');"
eq "FAL-1 restaurado: filtro omie_ de volta (não-omie intocado)" "$(TS public.order_items "sales_order_id='cccccccc-cccc-cccc-cccc-cccccccccccc' AND omie_codigo_produto=779")" "2099-01-01 00:00:00"

echo "──────────────────────────────"
echo "RESULTADO: $PASS ok / $FAIL fail"
[ "$FAIL" = "0" ] || { echo "❌ HARNESS VERMELHO"; exit 1; }
echo "✅ HARNESS VERDE"
