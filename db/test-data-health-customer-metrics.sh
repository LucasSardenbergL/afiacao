#!/usr/bin/env bash
# ╔══════════════════════════════════════════════════════════════════════════════╗
# ║  PROVA PG17 — watchdog de frescor customer_metrics no _data_health_compute()   ║
# ║  Migração: supabase/migrations/20260717160000_data_health_customer_metrics_… ║
# ║  Rode:  bash db/test-data-health-customer-metrics.sh > /tmp/t.log 2>&1; echo $?║
# ║                                                                                ║
# ║  ESCOPO (decisão consciente — ver skill prove-sql-money-path §Lei #1):          ║
# ║   Provar a função de 546 linhas INTEIRA no PG17 é inviável (SQL function valida ║
# ║   TODAS as referências no CREATE → exigiria stubar ~23 tabelas das outras       ║
# ║   branches). Então provamos O BLOCO: extraímos o SELECT REAL da migração        ║
# ║   (verbatim, via awk) e o rodamos sob uma âncora tipada idêntica ao RETURNS     ║
# ║   TABLE + o SELECT-final que nula campos de problema quando ok. Isso pega       ║
# ║   aridade (11 col), resolução de tipo do UNION, e a lógica broken/stale/ok.     ║
# ║   A INSERÇÃO no ponto certo (sem tocar as 23 branches) é provada por diff       ║
# ║   estrutural vs a def da PROD (no PR). Falsificação obrigatória inclusa.        ║
# ╚══════════════════════════════════════════════════════════════════════════════╝
set -euo pipefail

# ── arranque PG17 descartável (contorna keg-only do brew; idêntico ao template da skill) ──
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PGVER=17
PGBIN="/opt/homebrew/opt/postgresql@${PGVER}/bin"
PORT="${PGPORT_TEST:-5471}"     # mude se colidir com outro harness (multi-worktree)
SLUG="cm-datahealth"
DATA="$(mktemp -d "/tmp/pgtest-${SLUG}.XXXXXX")/data"
export LC_ALL=C LANG=C          # sem isso o postmaster aborta ("became multithreaded during startup")
MIG="$REPO_ROOT/supabase/migrations/20260717160000_data_health_customer_metrics_watchdog.sql"

[ -x "$PGBIN/initdb" ] || { echo "postgresql@${PGVER} ausente: brew install postgresql@${PGVER} pgvector"; exit 1; }
[ -f "$MIG" ] || { echo "migração ausente: $MIG"; exit 1; }

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
eq()  { if [ "$2" = "$3" ]; then ok "$1 (=[$2])"; else bad "$1 — esperado [$3], veio [$2]"; fi; }
contains() { case "$2" in *"$3"*) ok "$1 (contém [$3])";; *) bad "$1 — [$2] não contém [$3]";; esac; }

echo "═══ setup PG17 :$PORT ═══"

# ══════════════════════════════════════════════════════════════════════════════
# ZONA 1 — PRÉ-REQUISITO: schema private + stub da MV que o bloco lê
#   (nome idêntico ao da PROD: private.customer_metrics_mv; só as 2 colunas que o
#    bloco toca. calculated_at é timestamptz na PROD — validado via psql-ro.)
# ══════════════════════════════════════════════════════════════════════════════
P -q <<'SQL'
CREATE SCHEMA IF NOT EXISTS private;
CREATE TABLE private.customer_metrics_mv (
  customer_user_id uuid,
  calculated_at    timestamp with time zone
);
SQL

# ══════════════════════════════════════════════════════════════════════════════
# ZONA 2 — FUNÇÃO DE TESTE = micro-réplica fiel da _data_health_compute p/ o source
#   'customer_metrics'. Corpo: âncora tipada (== RETURNS TABLE, WHERE false → 0 linha,
#   fixa a resolução de tipo do UNION exatamente como na 1ª branch real) + o BLOCO
#   REAL extraído da migração (verbatim via awk) + o SELECT final que nula os campos
#   de problema quando status='ok' (idêntico ao rodapé da função da PROD).
#   $1 = interval do threshold ('8 hours' real; '99 hours' na falsificação).
# ══════════════════════════════════════════════════════════════════════════════
TMPFN="$(mktemp /tmp/cm-testfn.XXXXXX.sql)"
build_test_fn() {
  local IV="$1"
  {
    echo "CREATE OR REPLACE FUNCTION public._test_cm_data_health()"
    echo " RETURNS TABLE(source text, domain text, status text, age_seconds bigint, expected_max_age_seconds bigint, freshness_basis text, message text, last_error text, probable_cause text, how_to_fix text, severity text)"
    echo " LANGUAGE sql STABLE AS \$fn\$"
    echo "  WITH checks AS ("
    echo "    SELECT NULL::text AS source, NULL::text AS domain, NULL::text AS status,"
    echo "           NULL::bigint AS age_seconds, NULL::bigint AS expected_max_age_seconds, NULL::text AS freshness_basis,"
    echo "           NULL::text AS message, NULL::text AS last_error, NULL::text AS probable_cause,"
    echo "           NULL::text AS how_to_fix, NULL::text AS severity"
    echo "    WHERE false"
    # ↓ bloco REAL da migração (UNION ALL + SELECT 'customer_metrics' … FROM … cm); interval parametrizável p/ falsificar
    awk '/SELECT '\''customer_metrics'\''/{f=1; print "    UNION ALL"} f{print} /FROM private\.customer_metrics_mv cm/{exit}' "$MIG" \
      | sed "s/interval '8 hours'/interval '$IV'/"
    echo "  )"
    echo "  SELECT c.source, c.domain, COALESCE(NULLIF(c.status,''),'unknown') AS status,"
    echo "    c.age_seconds, c.expected_max_age_seconds, c.freshness_basis, c.message,"
    echo "    CASE WHEN COALESCE(NULLIF(c.status,''),'unknown')='ok' THEN NULL ELSE c.last_error END,"
    echo "    CASE WHEN COALESCE(NULLIF(c.status,''),'unknown')='ok' THEN NULL ELSE c.probable_cause END,"
    echo "    CASE WHEN COALESCE(NULLIF(c.status,''),'unknown')='ok' THEN NULL ELSE c.how_to_fix END,"
    echo "    c.severity"
    echo "  FROM checks c;"
    echo "\$fn\$;"
  } > "$TMPFN"
  P -q -f "$TMPFN"
}
build_test_fn "8 hours"
echo "função de teste criada (aridade/tipo validados pelo CREATE)"

# helpers de cenário
seed_empty() { P -q -c "TRUNCATE private.customer_metrics_mv;"; }
seed_age()   { P -q -c "TRUNCATE private.customer_metrics_mv; INSERT INTO private.customer_metrics_mv(customer_user_id, calculated_at) VALUES (gen_random_uuid(), now() - interval '$1');"; }
f() { Pq -c "SELECT $1 FROM public._test_cm_data_health();"; }

# ══════════════════════════════════════════════════════════════════════════════
# ZONA 4 — ASSERTS (positivo / limites / constantes)
# ══════════════════════════════════════════════════════════════════════════════
echo "── asserts ──"

# sanidade: âncora WHERE false não emite → exatamente 1 linha (a do bloco)
seed_age '1 hour'
eq "A0 emite 1 linha (âncora não polui)" "$(f 'count(*)')" "1"

# A1 — MV vazia → broken (max NULL)
seed_empty
eq       "A1 broken.status"          "$(f status)"         "broken"
eq       "A1 broken.age_seconds NULL" "$(f age_seconds)"   ""
contains "A1 broken.message"          "$(f message)"        "nunca"
eq       "A1 broken.probable_cause"   "$(f probable_cause)" "refresh_customer_metrics nunca rodou"
eq       "A1 broken.severity"         "$(f severity)"       "warning"

# A2 — recente (1h) → ok, e campos de problema NULADOS por status=ok
seed_age '1 hour'
eq "A2 ok.status"                "$(f status)"                     "ok"
eq "A2 ok.source"                "$(f source)"                     "customer_metrics"
eq "A2 ok.domain"                "$(f domain)"                     "vendas"
eq "A2 ok.freshness_basis"       "$(f freshness_basis)"            "max_calculated_at"
eq "A2 ok.expected_max_age(8h)"  "$(f expected_max_age_seconds)"   "28800"
eq "A2 ok.probable_cause NULADO" "$(f probable_cause)"             ""
eq "A2 ok.how_to_fix NULADO"     "$(f how_to_fix)"                 ""
eq "A2 ok.last_error NULADO"     "$(f last_error)"                 ""

# A3 — velho (9h > 8h) → stale, com how_to_fix/probable_cause PRESENTES
seed_age '9 hours'
eq       "A3 stale.status"        "$(f status)"         "stale"
eq       "A3 stale.probable_cause" "$(f probable_cause)" "cron afiacao_customer_metrics_refresh_6h travado ou REFRESH falhando"
contains "A3 stale.how_to_fix"    "$(f how_to_fix)"     "refresh_customer_metrics()"

# A4/A5 — borda exata do threshold de 8h
seed_age '7 hours 59 minutes'; eq "A4 borda 7h59 → ok"    "$(f status)" "ok"
seed_age '8 hours 1 minute';   eq "A5 borda 8h01 → stale" "$(f status)" "stale"

# ══════════════════════════════════════════════════════════════════════════════
# ZONA 5 — FALSIFICAÇÃO (Lei #3): sabota o threshold → detecção de stale MORRE → restaura
#   Sentinela = valor de status por igualdade exata (não substring da message) → anti-teatro.
# ══════════════════════════════════════════════════════════════════════════════
echo "── falsificação ──"
build_test_fn "99 hours"         # sabota: 8h → 99h
seed_age '9 hours'               # cenário que na versão real é 'stale'
FALSE_STATUS="$(f status)"
eq "F1 sabotado (99h): 9h vira 'ok' verde-falso (A3 depende MESMO do threshold)" "$FALSE_STATUS" "ok"

build_test_fn "8 hours"          # restaura cirurgicamente
seed_age '9 hours'
eq "F1 restaurado: 9h volta a 'stale'" "$(f status)" "stale"
rm -f "$TMPFN"

# ── veredito ──
echo "──────────────────────────────"
echo "RESULTADO: $PASS ok / $FAIL fail"
[ "$FAIL" = "0" ] || { echo "❌ HARNESS VERMELHO"; exit 1; }
echo "✅ HARNESS VERDE"
