#!/usr/bin/env bash
# ╔══════════════════════════════════════════════════════════════════════════════════╗
# ║  HARNESS PG17 — M-13: sales_price_history sem created_at no futuro                ║
# ║   bash db/test-sales-price-history-created-at-futuro.sh > "$SCRATCH/t.log" 2>&1; echo $? ║
# ║                                                                                    ║
# ║  Semeia o estado de PROD (psql-ro 2026-10-11): 5 linhas 2120-10-25 00:00 do pedido ║
# ║  com created_at 2021-10-15 12:00 + linhas sadias. Aplica a migration REAL e prova: ║
# ║  as 5 herdam a data do pai, as sadias ficam intactas, o CHECK barra futuro (23514) ║
# ║  com folga de 1 dia, re-aplicar é no-op, e linha futura ÓRFÃ aborta tudo (alto).   ║
# ║  CONTROLE: antes da migration o insert no futuro PASSA.                            ║
# ║  FALSIFICAÇÃO: (F1) sem o CHECK o futuro volta a entrar; (F2) migration sabotada   ║
# ║  num espelho (sem UPDATE, CHECK frouxo) aborta na pós-condição M13_POS_FALHOU.     ║
# ╚══════════════════════════════════════════════════════════════════════════════════╝
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
export PGVER=17   # consumido pelo db/lib/pg-harness.sh via source
PORT="${PGPORT_TEST:-5532}"
SLUG="sph-futuro"
TMPD="$(mktemp -d "/tmp/pgtest-${SLUG}.XXXXXX")"
DATA="$TMPD/data"
MIG="$REPO_ROOT/supabase/migrations/20261011120300_sales_price_history_created_at_futuro.sql"
export LC_ALL=C LANG=C

# shellcheck disable=SC1091  # o gate roda sem -x; o helper e versionado ao lado, em db/lib/
. "$REPO_ROOT/db/lib/pg-harness.sh"

[ -f "$MIG" ] || { echo "migration nao encontrada: $MIG"; exit 1; }

cleanup() { "$PGBIN/pg_ctl" -D "$DATA" stop -m immediate >/dev/null 2>&1 || true; rm -rf "$TMPD"; }
trap cleanup EXIT

"$PGBIN/initdb" -D "$DATA" -U postgres -E UTF8 --locale=C >/dev/null
"$PGBIN/pg_ctl" -D "$DATA" -o "-p $PORT -k /tmp" -l "$TMPD/pg.log" -w start >/dev/null
"$PGBIN/createdb" -p "$PORT" -h /tmp -U postgres prove
P()  { "$PGBIN/psql" -X -p "$PORT" -h /tmp -U postgres -d prove -v ON_ERROR_STOP=1 "$@"; }
Pq() { P -tA "$@"; }

PASS=0; FAIL=0
ok()  { PASS=$((PASS+1)); echo "  ✅ $1"; }
bad() { FAIL=$((FAIL+1)); echo "  ❌ $1"; }
eq()  { if [ "$2" = "$3" ]; then ok "$1 (=$2)"; else bad "$1 — esperado [$3], veio [$2]"; fi; }

PAI="aaaaaaaa-0000-0000-0000-000000000001"

# ═══ ZONA 1 — estado de PROD ═══
P -q <<SQL
CREATE TABLE public.sales_orders (id uuid PRIMARY KEY, created_at timestamptz NOT NULL);
CREATE TABLE public.sales_price_history (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), customer_user_id uuid, product_id uuid,
  unit_price numeric, sales_order_id uuid REFERENCES public.sales_orders(id) ON DELETE SET NULL,
  created_at timestamptz DEFAULT now());
INSERT INTO public.sales_orders VALUES ('$PAI', '2021-10-15 12:00:00+00'),
                                       ('aaaaaaaa-0000-0000-0000-000000000002', '2026-10-01 12:00:00+00');
INSERT INTO public.sales_price_history(unit_price, sales_order_id, created_at)
  SELECT p, '$PAI', '2120-10-25 00:00:00+00' FROM unnest(ARRAY[51.9, 67.94, 51.09, 34.4, 247.64]) p;
INSERT INTO public.sales_price_history(unit_price, sales_order_id, created_at)
  SELECT 10 + g, 'aaaaaaaa-0000-0000-0000-000000000002', '2026-10-01 12:00:00+00' FROM generate_series(1, 20) g;
INSERT INTO public.sales_price_history(unit_price, sales_order_id, created_at) VALUES (9, NULL, '2010-09-14 00:00:00+00');
SQL
echo "═══ setup pronto (PG17 :$PORT) ═══"
SADIAS_ANTES=$(Pq -c "SELECT md5(string_agg(id::text || created_at::text, ',' ORDER BY id)) FROM public.sales_price_history WHERE created_at < now()")

# ═══ ZONA 2 — CONTROLE ═══
echo "── controle (antes da migration) ──"
eq "C1 5 linhas no futuro reproduzidas" "$(Pq -c "SELECT count(*) FROM public.sales_price_history WHERE created_at > now() + interval '1 day'")" 5
if P -q -c "BEGIN; INSERT INTO public.sales_price_history(unit_price, created_at) VALUES (1, '2120-01-01'); ROLLBACK;" >/dev/null 2>&1; then
  ok "C2 sem o CHECK o insert no futuro entra"
else bad "C2 o insert no futuro já falhava antes da migration — o controle não vale"; fi

# ═══ ZONA 3 — migration REAL ═══
P -q -f "$MIG" >/dev/null
echo "── asserts ──"
eq "A1 0 linhas no futuro" "$(Pq -c "SELECT count(*) FROM public.sales_price_history WHERE created_at > now() + interval '1 day'")" 0
eq "A2 as 5 herdaram o created_at do pedido pai (regra G6)" \
   "$(Pq -c "SELECT count(*) FROM public.sales_price_history WHERE sales_order_id = '$PAI' AND created_at = '2021-10-15 12:00:00+00'")" 5
eq "A3 linhas sadias intactas (md5 de id+created_at)" \
   "$(Pq -c "SELECT md5(string_agg(id::text || created_at::text, ',' ORDER BY id)) FROM public.sales_price_history WHERE sales_order_id IS DISTINCT FROM '$PAI'")" "$SADIAS_ANTES"
eq "A4 CHECK existe e está validado" \
   "$(Pq -c "SELECT count(*) FROM pg_constraint WHERE conname = 'sales_price_history_created_at_nao_futuro' AND convalidated")" 1
R=$(P -tA 2>&1 <<'SQL' || true
DO $$ BEGIN
  INSERT INTO public.sales_price_history(unit_price, created_at) VALUES (1, '2120-10-25');
  RAISE NOTICE 'ENTROU';
EXCEPTION WHEN check_violation THEN RAISE NOTICE 'BARRADO_23514';
END $$;
SQL
)
case "$R" in *BARRADO_23514*) ok "A5 insert em 2120 → 23514" ;; *) bad "A5 — veio: $R" ;; esac
if P -q -c "BEGIN; INSERT INTO public.sales_price_history(unit_price, created_at) VALUES (1, now() + interval '12 hours'); ROLLBACK;" >/dev/null 2>&1; then
  ok "A6 folga de 1 dia: now()+12h entra (fuso/relógio não derrubam o writer)"
else bad "A6 now()+12h foi barrado — CHECK apertado demais"; fi
if P -q -f "$MIG" >/dev/null 2>&1; then ok "A7 re-aplicar é no-op (idempotente)"; else bad "A7 2ª aplicação falhou"; fi

# A8: linha futura ÓRFÃ (sem pai) — o UPDATE não a corrige e o VALIDATE aborta TUDO, sem meio-aplicado
P -q -c "ALTER TABLE public.sales_price_history DROP CONSTRAINT sales_price_history_created_at_nao_futuro;"
P -q -c "INSERT INTO public.sales_price_history(unit_price, sales_order_id, created_at) VALUES (2, NULL, '2120-10-25');"
R=$(P -q -f "$MIG" 2>&1 || true)
case "$R" in *sales_price_history_created_at_nao_futuro*) ok "A8 órfã no futuro → a migration aborta no VALIDATE (alto)" ;; *) bad "A8 — veio: $(echo "$R" | tr '\n' ' ' | cut -c1-200)" ;; esac
eq "A9 abortou sem meio-aplicado (CHECK ausente, órfã intacta)" \
   "$(Pq -c "SELECT (SELECT count(*) FROM pg_constraint WHERE conname = 'sales_price_history_created_at_nao_futuro') || '/' || (SELECT count(*) FROM public.sales_price_history WHERE created_at > now() + interval '1 day')")" "0/1"
P -q -c "DELETE FROM public.sales_price_history WHERE created_at > now() + interval '1 day';"
P -q -f "$MIG" >/dev/null

# ═══ ZONA 4 — FALSIFICAÇÃO ═══
echo "── falsificação ──"
P -q -c "ALTER TABLE public.sales_price_history DROP CONSTRAINT sales_price_history_created_at_nao_futuro;"
if P -q -c "INSERT INTO public.sales_price_history(unit_price, sales_order_id, created_at) SELECT p, '$PAI', '2120-10-25' FROM unnest(ARRAY[1,2,3]) p;" >/dev/null 2>&1; then
  ok "F1 sem o CHECK o futuro volta a entrar (A5 tinha dente)"
else bad "F1 sem o CHECK o insert ainda falhou — A5 não prova o CHECK"; fi
# F2: espelho sem o UPDATE e com CHECK frouxo → as 3 futuras ficam e a pós-condição tem de abortar
awk '/^UPDATE public\.sales_price_history h/{pula=1} !pula{print} pula && /;$/{pula=0}' "$MIG" \
  | sed "s/CHECK (created_at <= now() + interval '1 day') NOT VALID/CHECK (created_at <= now() + interval '200 years') NOT VALID/" > "$TMPD/sabotada.sql"
if cmp -s "$MIG" "$TMPD/sabotada.sql"; then
  bad "F2 a sabotagem não alterou a migration — falsificação não rodou"
else
  R=$(P -q -f "$TMPD/sabotada.sql" 2>&1 || true)
  case "$R" in *M13_POS_FALHOU*) ok "F2 migration sabotada aborta na pós-condição (M13_POS_FALHOU)" ;; *) bad "F2 — veio: $(echo "$R" | tr '\n' ' ' | cut -c1-200)" ;; esac
fi

echo
echo "PASS=$PASS  FAIL=$FAIL"
[ "$FAIL" -eq 0 ]
