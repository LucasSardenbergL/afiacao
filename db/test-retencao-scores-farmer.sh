#!/usr/bin/env bash
# ╔══════════════════════════════════════════════════════════════════════════════════╗
# ║  HARNESS PG17 — M-17: retenção de 90 dias em health_score_history/priority_score_log ║
# ║   bash db/test-retencao-scores-farmer.sh > "$SCRATCH/t.log" 2>&1; echo $?          ║
# ║                                                                                    ║
# ║  Aplica a migration REAL 20261011120400 e EXECUTA o expurgo (plpgsql é late-bound):║
# ║  corte exato na borda (89/91 dias), lotes menores que o volume, piso de 30 dias    ║
# ║  (22023), fecho para anon/authenticated (42501), cron agendado 1x mesmo re-aplicado║
# ║  CONTROLE: antes do expurgo as linhas velhas existem (o DELETE tem o que apagar).  ║
# ║  FALSIFICAÇÃO: (F1) corpo sabotado (> em vez de <) apaga o recente e o assert de   ║
# ║  borda fica vermelho; (F2) migration sem o cron aborta na pós-condição.            ║
# ╚══════════════════════════════════════════════════════════════════════════════════╝
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
export PGVER=17   # consumido pelo db/lib/pg-harness.sh via source
PORT="${PGPORT_TEST:-5533}"
SLUG="retencao-scores"
TMPD="$(mktemp -d "/tmp/pgtest-${SLUG}.XXXXXX")"
DATA="$TMPD/data"
MIG="$REPO_ROOT/supabase/migrations/20261011120400_retencao_scores_farmer.sql"
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

# ═══ ZONA 1 — estado de PROD (colunas medidas via psql-ro 2026-10-11) ═══
P -q -f "$REPO_ROOT/db/stubs-supabase.sql"
P -q <<'SQL'
CREATE SCHEMA IF NOT EXISTS private;
-- prod: authenticated/anon TÊM USAGE em private (policies chamam private.cap_*) — sem isto o 42501
-- viria do SCHEMA e o assert de fecho passaria sem o REVOKE
GRANT USAGE ON SCHEMA private TO authenticated, anon;
-- cron.schedule com a semântica do pg_cron: re-agendar o MESMO nome atualiza o job
CREATE OR REPLACE FUNCTION cron.schedule(p_jobname text, p_schedule text, p_command text)
RETURNS bigint LANGUAGE plpgsql AS $$
DECLARE v_id bigint;
BEGIN
  SELECT jobid INTO v_id FROM cron.job WHERE jobname = p_jobname;
  IF v_id IS NULL THEN
    SELECT COALESCE(MAX(jobid), 0) + 1 INTO v_id FROM cron.job;
    INSERT INTO cron.job (jobid, jobname, schedule, command, active) VALUES (v_id, p_jobname, p_schedule, p_command, true);
  ELSE
    UPDATE cron.job SET schedule = p_schedule, command = p_command WHERE jobid = v_id;
  END IF;
  RETURN v_id;
END $$;

CREATE TABLE public.health_score_history (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), customer_user_id uuid, farmer_id uuid, health_score numeric,
  health_class text, rf_score numeric, m_score numeric, g_score numeric, x_score numeric, s_score numeric,
  churn_risk numeric, calculated_at timestamptz DEFAULT now(), created_at timestamptz DEFAULT now());
CREATE INDEX idx_health_history_customer ON public.health_score_history (customer_user_id, calculated_at DESC);
CREATE TABLE public.priority_score_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), customer_user_id uuid, farmer_id uuid, priority_score numeric,
  margin_potential_component numeric, churn_risk_component numeric, repurchase_component numeric,
  goal_proximity_component numeric, score_date date DEFAULT current_date, calculated_at timestamptz DEFAULT now(),
  created_at timestamptz DEFAULT now());
CREATE INDEX idx_priority_log_customer ON public.priority_score_log (customer_user_id, score_date DESC);

-- 300 velhas (91..200 dias), 200 recentes (0..89 dias) em cada tabela
INSERT INTO public.health_score_history (health_score, calculated_at)
  SELECT 1, now() - make_interval(days => 91 + (g % 110)) FROM generate_series(1, 300) g;
INSERT INTO public.health_score_history (health_score, calculated_at)
  SELECT 1, now() - make_interval(days => g % 90) FROM generate_series(1, 200) g;
INSERT INTO public.priority_score_log (priority_score, score_date)
  SELECT 1, current_date - (91 + (g % 110)) FROM generate_series(1, 300) g;
INSERT INTO public.priority_score_log (priority_score, score_date)
  SELECT 1, current_date - (g % 90) FROM generate_series(1, 200) g;
SQL
echo "═══ setup pronto (PG17 :$PORT) ═══"

contar() { Pq -c "SELECT (SELECT count(*) FROM public.health_score_history WHERE calculated_at < now() - interval '90 days') || '/' || (SELECT count(*) FROM public.health_score_history) || '|' || (SELECT count(*) FROM public.priority_score_log WHERE score_date < current_date - 90) || '/' || (SELECT count(*) FROM public.priority_score_log)"; }

echo "── controle ──"
eq "C1 antes: velhas/total em cada tabela" "$(contar)" "300/500|300/500"

# ═══ ZONA 2 — migration REAL (2x) ═══
P -q -f "$MIG" >/dev/null
if P -q -f "$MIG" >/dev/null 2>&1; then ok "A0 re-aplicar é no-op (idempotente)"; else bad "A0 2ª aplicação falhou"; fi

echo "── asserts ──"
eq "A1 exatamente 1 job, mesmo re-aplicado" "$(Pq -c "SELECT count(*) FROM cron.job WHERE jobname = 'expurgo-scores-farmer' AND schedule = '30 4 1 * *' AND active")" 1
eq "A2 índices por data criados" "$(Pq -c "SELECT count(*) FROM pg_indexes WHERE indexname IN ('idx_health_history_calculated_at','idx_priority_log_score_date')")" 2
eq "A3 migration NÃO expurga sozinha (o 1º expurgo é do cron)" "$(contar)" "300/500|300/500"

# A4: expurgo com lote MENOR que o volume (força o laço a dar várias voltas)
R=$(Pq -c "WITH r AS (SELECT private.expurgar_scores_antigos(90, 7) AS j) SELECT (j ->> 'health_score_history') || '+' || (j ->> 'priority_score_log') FROM r")
eq "A4 expurgo devolve as contagens com lote 7 (laço de várias voltas)" "$R" "300+300"
eq "A5 sobram só as recentes (0 velhas, 200 por tabela)" "$(contar)" "0/200|0/200"

# A6: borda — 89 dias fica, 91 sai
P -q -c "INSERT INTO public.health_score_history (health_score, calculated_at) VALUES (89, now() - interval '89 days'), (91, now() - interval '91 days');
         INSERT INTO public.priority_score_log (priority_score, score_date) VALUES (89, current_date - 89), (91, current_date - 91);"
Pq -c "SELECT private.expurgar_scores_antigos(90)" >/dev/null
eq "A6 borda: 89 dias fica, 91 sai (nas 2 tabelas)" \
   "$(Pq -c "SELECT string_agg(health_score::text, ',' ORDER BY health_score) FROM public.health_score_history WHERE health_score > 1")|$(Pq -c "SELECT string_agg(priority_score::text, ',' ORDER BY priority_score) FROM public.priority_score_log WHERE priority_score > 1")" "89|89"
eq "A7 re-rodar sem nada velho apaga 0" "$(Pq -c "SELECT (private.expurgar_scores_antigos(90) ->> 'health_score_history') || '/' || (private.expurgar_scores_antigos(90) ->> 'priority_score_log')")" "0/0"

# A8: piso de 30 dias
R=$(P -tA 2>&1 <<'SQL' || true
DO $$ BEGIN
  PERFORM private.expurgar_scores_antigos(7);
  RAISE NOTICE 'ACEITOU_7';
EXCEPTION WHEN invalid_parameter_value THEN RAISE NOTICE 'RECUSOU_22023';
END $$;
SQL
)
case "$R" in *RECUSOU_22023*) ok "A8 retenção < 30 dias recusada (22023)" ;; *) bad "A8 — veio: $R" ;; esac

# A9/A10: fechada para authenticated e anon (42501 na fronteira)
for role in authenticated anon; do
  R=$(P -tA 2>&1 <<SQL || true
BEGIN; SET LOCAL ROLE $role;
DO \$\$ BEGIN
  PERFORM private.expurgar_scores_antigos(90);
  RAISE NOTICE 'EXECUTOU';
EXCEPTION WHEN insufficient_privilege THEN RAISE NOTICE 'BARRADO_42501';
END \$\$;
ROLLBACK;
SQL
)
  case "$R" in *BARRADO_42501*) ok "A-$role não executa o expurgo (42501)" ;; *) bad "A-$role — veio: $(echo "$R" | tr '\n' ' ' | cut -c1-200)" ;; esac
done

# ═══ ZONA 3 — FALSIFICAÇÃO ═══
echo "── falsificação ──"
# F1: corpo com a comparação invertida → apaga o RECENTE; o assert de borda A6 tem de ficar vermelho
P -q -c "INSERT INTO public.health_score_history (health_score, calculated_at) VALUES (91, now() - interval '91 days');"
sed 's/WHERE calculated_at < v_corte LIMIT/WHERE calculated_at > v_corte LIMIT/' "$MIG" > "$TMPD/f1.sql"
if cmp -s "$MIG" "$TMPD/f1.sql"; then bad "F1 sed não sabotou nada"; else
  P -q -f "$TMPD/f1.sql" >/dev/null
  Pq -c "SELECT private.expurgar_scores_antigos(90)" >/dev/null
  V=$(Pq -c "SELECT coalesce(string_agg(health_score::text, ',' ORDER BY health_score), '') FROM public.health_score_history WHERE health_score > 1")
  if [ "$V" != "89" ]; then ok "F1 comparação invertida muda a borda (veio [$V] ≠ 89) — A6 tem dente"; else bad "F1 sabotagem passou despercebida pela borda"; fi
  P -q -f "$MIG" >/dev/null   # restaura o corpo verdadeiro
fi
# F2: migration sem o cron.schedule → a pós-condição tem de abortar
P -q -c "DELETE FROM cron.job WHERE jobname = 'expurgo-scores-farmer';"
grep -v "^SELECT cron.schedule('expurgo-scores-farmer'" "$MIG" > "$TMPD/f2.sql"
if cmp -s "$MIG" "$TMPD/f2.sql"; then bad "F2 a sabotagem não removeu o cron"; else
  R=$(P -q -f "$TMPD/f2.sql" 2>&1 || true)
  case "$R" in *M17_POS_FALHOU*) ok "F2 migration sem o cron aborta na pós-condição (M17_POS_FALHOU)" ;; *) bad "F2 — veio: $(echo "$R" | tr '\n' ' ' | cut -c1-200)" ;; esac
fi

echo
echo "PASS=$PASS  FAIL=$FAIL"
[ "$FAIL" -eq 0 ]
