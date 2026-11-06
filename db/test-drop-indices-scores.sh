#!/usr/bin/env bash
# ╔══════════════════════════════════════════════════════════════════════════════════╗
# ║  HARNESS PG17 — plano v4 lote 11 / v7 D5: DROP dos 4 índices ociosos dos scores    ║
# ║   bash db/test-drop-indices-scores.sh > "$SCRATCH/t.log" 2>&1; echo $?             ║
# ║                                                                                    ║
# ║  Aplica a migration REAL 20261106205556 como o SQL Editor (o arquivo traz a        ║
# ║  transação). EXECUTA as duas guardas: a PRE aborta se um dos 4 ganhou scan (e nada ║
# ║  é dropado), a PÓS exige os 4 fora e PK + índices por data válidos. Idempotente.   ║
# ║  CONTROLE: antes do apply os 4 existem; o scan forçado aparece em idx_scan.        ║
# ║  FALSIFICAÇÃO: (F1) migration sem um dos DROP aborta na PÓS; (F2) PRE afrouxada    ║
# ║  deixa passar o índice lido (A1 tem dente).                                        ║
# ╚══════════════════════════════════════════════════════════════════════════════════╝
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
export PGVER=17   # consumido pelo db/lib/pg-harness.sh via source
PORT="${PGPORT_TEST:-5535}"
SLUG="drop-idx-scores"
TMPD="$(mktemp -d "/tmp/pgtest-${SLUG}.XXXXXX")"
DATA="$TMPD/data"
MIG="$REPO_ROOT/supabase/migrations/20261106205556_drop_indices_ociosos_scores.sql"
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

# ═══ ZONA 1 — estado de PROD (índices conferidos via psql-ro 2026-11-06) ═══
indices_ociosos() { P -q <<'SQL'
CREATE INDEX IF NOT EXISTS idx_health_history_customer ON public.health_score_history (customer_user_id, calculated_at DESC);
CREATE INDEX IF NOT EXISTS idx_health_history_farmer ON public.health_score_history (farmer_id, calculated_at DESC);
CREATE INDEX IF NOT EXISTS idx_priority_log_customer ON public.priority_score_log (customer_user_id, score_date DESC);
CREATE INDEX IF NOT EXISTS idx_priority_log_farmer_date ON public.priority_score_log (farmer_id, score_date DESC);
SELECT pg_stat_reset();
SQL
}
P -q <<'SQL'
CREATE TABLE public.health_score_history (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), customer_user_id uuid, farmer_id uuid, health_score numeric,
  calculated_at timestamptz DEFAULT now());
CREATE TABLE public.priority_score_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), customer_user_id uuid, farmer_id uuid, priority_score numeric,
  score_date date DEFAULT current_date);
CREATE INDEX idx_health_history_calculated_at ON public.health_score_history (calculated_at);
CREATE INDEX idx_priority_log_score_date ON public.priority_score_log (score_date);
INSERT INTO public.health_score_history (customer_user_id, farmer_id, health_score)
  SELECT gen_random_uuid(), gen_random_uuid(), 1 FROM generate_series(1, 500);
INSERT INTO public.priority_score_log (customer_user_id, farmer_id, priority_score)
  SELECT gen_random_uuid(), gen_random_uuid(), 1 FROM generate_series(1, 500);
SQL
indices_ociosos >/dev/null
echo "═══ setup pronto (PG17 :$PORT) ═══"

ociosos() { Pq -c "SELECT count(*) FROM pg_class WHERE relkind = 'i' AND relname IN ('idx_health_history_customer','idx_health_history_farmer','idx_priority_log_customer','idx_priority_log_farmer_date')"; }
ficam()   { Pq -c "SELECT count(*) FROM pg_index ix JOIN pg_class i ON i.oid = ix.indexrelid WHERE ix.indisvalid AND i.relname IN ('health_score_history_pkey','priority_score_log_pkey','idx_health_history_calculated_at','idx_priority_log_score_date')"; }
# lê pelo índice do cliente e espera o contador aparecer (o flush das estatísticas é assíncrono)
ler_pelo_indice() {
  P -q -c "SET enable_seqscan = off; SET enable_bitmapscan = off;
           SELECT count(*) FROM public.health_score_history WHERE customer_user_id = gen_random_uuid();
           SELECT pg_stat_force_next_flush();" >/dev/null
  for _ in $(seq 1 20); do
    [ "$(Pq -c "SELECT idx_scan FROM pg_stat_user_indexes WHERE indexrelname = 'idx_health_history_customer'")" -gt 0 ] && return 0
    sleep 0.5
  done
  return 1
}

echo "── controle ──"
eq "C1 antes: os 4 ociosos existem" "$(ociosos)" 4
if ler_pelo_indice; then ok "C2 scan forçado aparece em idx_scan"; else bad "C2 o scan não chegou ao contador"; fi

echo "── asserts ──"
R=$(P -q -f "$MIG" 2>&1 || true)
case "$R" in *D5_PRE_FALHOU*idx_health_history_customer*) ok "A1 índice lido desde a medição aborta na PRE (D5_PRE_FALHOU)" ;; *) bad "A1 — veio: $(echo "$R" | tr '\n' ' ' | cut -c1-200)" ;; esac
eq "A2 PRE abortou: nada foi dropado" "$(ociosos)" 4

P -q -c "SELECT pg_stat_reset();" >/dev/null
if P -q -f "$MIG" >/dev/null 2>&1; then ok "A3 com 0 scans a migration aplica"; else bad "A3 apply falhou"; fi
eq "A4 os 4 ociosos sumiram" "$(ociosos)" 0
eq "A5 PKs e índices por data seguem válidos" "$(ficam)" 4
if P -q -f "$MIG" >/dev/null 2>&1; then ok "A6 re-colar é no-op (idempotente)"; else bad "A6 2ª aplicação falhou"; fi
eq "A7 o corte do expurgo segue indexado" \
   "$(Pq -c "SET enable_seqscan = off; EXPLAIN (COSTS OFF) SELECT id FROM public.health_score_history WHERE calculated_at < now() - interval '60 days' LIMIT 10" | grep -c 'idx_health_history_calculated_at')" 1

# ═══ ZONA 3 — FALSIFICAÇÃO ═══
echo "── falsificação ──"
# F1: sem um dos DROP → a PÓS tem de abortar
indices_ociosos >/dev/null
grep -v '^DROP INDEX IF EXISTS public.idx_priority_log_farmer_date;' "$MIG" > "$TMPD/f1.sql"
if cmp -s "$MIG" "$TMPD/f1.sql"; then bad "F1 a sabotagem não removeu o DROP"; else
  R=$(P -q -f "$TMPD/f1.sql" 2>&1 || true)
  case "$R" in *D5_POS_FALHOU*) ok "F1 migration sem um DROP aborta na PÓS (D5_POS_FALHOU)" ;; *) bad "F1 — veio: $(echo "$R" | tr '\n' ' ' | cut -c1-200)" ;; esac
fi
# F2: PRE afrouxada → o índice lido passa e é dropado; o A1 é quem barra
eq "F2 controle: os 4 voltaram (a F1 desfez tudo)" "$(ociosos)" 4
ler_pelo_indice || bad "F2 o scan não chegou ao contador"
sed 's/AND idx_scan > 0;/AND idx_scan > 999999;/' "$MIG" > "$TMPD/f2.sql"
if cmp -s "$MIG" "$TMPD/f2.sql"; then bad "F2 sed não sabotou nada"; else
  if P -q -f "$TMPD/f2.sql" >/dev/null 2>&1 && [ "$(ociosos)" = 0 ]; then
    ok "F2 PRE afrouxada dropa o índice lido — A1 tem dente"
  else bad "F2 a sabotagem não mudou o desfecho"; fi
fi

echo
echo "PASS=$PASS  FAIL=$FAIL"
[ "$FAIL" -eq 0 ]
