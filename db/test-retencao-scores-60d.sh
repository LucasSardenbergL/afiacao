#!/usr/bin/env bash
# ╔══════════════════════════════════════════════════════════════════════════════════╗
# ║  HARNESS PG17 — plano v4 lote 11 (B1): retenção de 60 dias, semanal, com teto     ║
# ║   bash db/test-retencao-scores-60d.sh > "$SCRATCH/t.log" 2>&1; echo $?             ║
# ║                                                                                    ║
# ║  Parte do estado de PROD (a 20261011120400 aplicada) e aplica a migration REAL     ║
# ║  20261102183000 numa transação (como o db:aplicar), 2x. EXECUTA o expurgo:         ║
# ║  borda 59/61, teto de 60 lotes por chamada (resta_*), piso de 30 dias e de lote    ║
# ║  (22023), fecho para anon/authenticated (42501), PRE recusa corpo desconhecido,    ║
# ║  o comando do cron roda como está.                                                 ║
# ║  CONTROLE: o md5 do predecessor no harness = o medido em prod; o md5 escrito na    ║
# ║  PRE/PÓS = o do corpo deste arquivo; antes do expurgo as linhas velhas existem.    ║
# ║  FALSIFICAÇÃO: (F1) sem teto o assert do teto fica vermelho; (F2) comparação       ║
# ║  invertida muda a borda; (F3) migration sem o cron aborta na pós-condição.         ║
# ╚══════════════════════════════════════════════════════════════════════════════════╝
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
export PGVER=17   # consumido pelo db/lib/pg-harness.sh via source
PORT="${PGPORT_TEST:-5534}"
SLUG="retencao-60d"
TMPD="$(mktemp -d "/tmp/pgtest-${SLUG}.XXXXXX")"
DATA="$TMPD/data"
MIG_ANT="$REPO_ROOT/supabase/migrations/20261011120400_retencao_scores_farmer.sql"
MIG="$REPO_ROOT/supabase/migrations/20261102183000_retencao_scores_60d_semanal.sql"
MD5_PROD_ANT="0bfea5073c058c213deb795422bbd2ec"   # md5(prosrc) em prod, psql-ro 2026-11-02
export LC_ALL=C LANG=C

# shellcheck disable=SC1091  # o gate roda sem -x; o helper e versionado ao lado, em db/lib/
. "$REPO_ROOT/db/lib/pg-harness.sh"

[ -f "$MIG" ] && [ -f "$MIG_ANT" ] || { echo "migration nao encontrada"; exit 1; }

cleanup() { "$PGBIN/pg_ctl" -D "$DATA" stop -m immediate >/dev/null 2>&1 || true; rm -rf "$TMPD"; }
trap cleanup EXIT

"$PGBIN/initdb" -D "$DATA" -U postgres -E UTF8 --locale=C >/dev/null
"$PGBIN/pg_ctl" -D "$DATA" -o "-p $PORT -k /tmp" -l "$TMPD/pg.log" -w start >/dev/null
"$PGBIN/createdb" -p "$PORT" -h /tmp -U postgres prove
P()  { "$PGBIN/psql" -X -p "$PORT" -h /tmp -U postgres -d prove -v ON_ERROR_STOP=1 "$@"; }
Pq() { P -tA "$@"; }
# o db:aplicar é quem dá a transação: o arquivo não leva BEGIN/COMMIT
aplicar() { P -q -1 -f "$1"; }

PASS=0; FAIL=0
ok()  { PASS=$((PASS+1)); echo "  ✅ $1"; }
bad() { FAIL=$((FAIL+1)); echo "  ❌ $1"; }
eq()  { if [ "$2" = "$3" ]; then ok "$1 (=$2)"; else bad "$1 — esperado [$3], veio [$2]"; fi; }

# o CREATE FUNCTION de um arquivo de migration, sozinho (para medir o md5 e sabotar o corpo)
corpo() { awk '/^CREATE OR REPLACE FUNCTION private.expurgar_scores_antigos/{f=1} f{print} /^\$function\$;/{f=0}' "$1"; }

# ═══ ZONA 1 — estado de PROD ═══
P -q -f "$REPO_ROOT/db/stubs-supabase.sql"
P -q <<'SQL'
CREATE SCHEMA IF NOT EXISTS private;
-- prod: authenticated/anon TÊM USAGE em private — sem isto o 42501 viria do SCHEMA
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

-- 300 velhas (61..170 dias), 200 recentes (0..59 dias) em cada tabela
INSERT INTO public.health_score_history (health_score, calculated_at)
  SELECT 1, now() - make_interval(days => 61 + (g % 110)) FROM generate_series(1, 300) g;
INSERT INTO public.health_score_history (health_score, calculated_at)
  SELECT 1, now() - make_interval(days => g % 60) FROM generate_series(1, 200) g;
INSERT INTO public.priority_score_log (priority_score, score_date)
  SELECT 1, current_date - (61 + (g % 110)) FROM generate_series(1, 300) g;
INSERT INTO public.priority_score_log (priority_score, score_date)
  SELECT 1, current_date - (g % 60) FROM generate_series(1, 200) g;
SQL
P -q -f "$MIG_ANT" >/dev/null   # prod: a 20261011120400 está aplicada (job mensal, corte de 90)
echo "═══ setup pronto (PG17 :$PORT) ═══"

contar() { Pq -c "SELECT (SELECT count(*) FROM public.health_score_history WHERE calculated_at < now() - interval '60 days') || '/' || (SELECT count(*) FROM public.health_score_history) || '|' || (SELECT count(*) FROM public.priority_score_log WHERE score_date < current_date - 60) || '/' || (SELECT count(*) FROM public.priority_score_log)"; }
md5_vivo() { Pq -c "SELECT md5(prosrc) FROM pg_proc WHERE oid = to_regprocedure('private.expurgar_scores_antigos(int, int)')"; }

echo "── controle ──"
eq "C0 md5 do corpo da 20261011120400 no harness = o medido em prod" "$(md5_vivo)" "$MD5_PROD_ANT"
"$PGBIN/createdb" -p "$PORT" -h /tmp -U postgres medir
corpo "$MIG" > "$TMPD/corpo.sql"
"$PGBIN/psql" -X -p "$PORT" -h /tmp -U postgres -d medir -v ON_ERROR_STOP=1 -q -c "CREATE SCHEMA private;" -f "$TMPD/corpo.sql"
MD5_ESTE=$("$PGBIN/psql" -X -p "$PORT" -h /tmp -U postgres -d medir -tA -c "SELECT md5(prosrc) FROM pg_proc WHERE proname = 'expurgar_scores_antigos'")
echo "  md5 do corpo deste arquivo: $MD5_ESTE"
eq "C1 o md5 escrito na PRE e na PÓS é o do corpo deste arquivo (2 ocorrências)" \
   "$(grep -c "'$MD5_ESTE'" "$MIG")" 2
eq "C2 antes: velhas/total em cada tabela" "$(contar)" "300/500|300/500"

# ═══ ZONA 2 — migration REAL (2x) ═══
aplicar "$MIG" >/dev/null
if aplicar "$MIG" >/dev/null 2>&1; then ok "A0 re-aplicar é no-op (idempotente)"; else bad "A0 2ª aplicação falhou"; fi

echo "── asserts ──"
eq "A1 1 job, semanal, com timeouts e (60, 10000)" "$(Pq -c "SELECT count(*) FROM cron.job WHERE jobname = 'expurgo-scores-farmer' AND schedule = '30 4 * * 0' AND active AND command LIKE '%statement_timeout%lock_timeout%private.expurgar_scores_antigos(60, 10000);'")" 1
eq "A2 nenhum outro job com o mesmo nome" "$(Pq -c "SELECT count(*) FROM cron.job WHERE jobname = 'expurgo-scores-farmer'")" 1
eq "A3 defaults novos" "$(Pq -c "SELECT pg_get_function_arguments(to_regprocedure('private.expurgar_scores_antigos(int, int)'))")" "p_dias integer DEFAULT 60, p_lote integer DEFAULT 10000"
eq "A4 migration NÃO expurga sozinha (o 1º expurgo é do cron)" "$(contar)" "300/500|300/500"

R=$(Pq -c "WITH r AS (SELECT private.expurgar_scores_antigos() AS j) SELECT (j ->> 'health_score_history') || '+' || (j ->> 'priority_score_log') || ' ' || (j ->> 'resta_health') || '/' || (j ->> 'resta_priority') FROM r")
eq "A5 expurgo pelos defaults apaga as velhas e não deixa resto" "$R" "300+300 false/false"
eq "A6 sobram só as recentes (0 velhas, 200 por tabela)" "$(contar)" "0/200|0/200"

# A7: borda — 59 dias fica, 61 sai
P -q -c "INSERT INTO public.health_score_history (health_score, calculated_at) VALUES (59, now() - interval '59 days'), (61, now() - interval '61 days');
         INSERT INTO public.priority_score_log (priority_score, score_date) VALUES (59, current_date - 59), (61, current_date - 61);"
Pq -c "SELECT private.expurgar_scores_antigos(60)" >/dev/null
borda() { echo "$(Pq -c "SELECT coalesce(string_agg(health_score::text, ',' ORDER BY health_score), '') FROM public.health_score_history WHERE health_score > 1")|$(Pq -c "SELECT coalesce(string_agg(priority_score::text, ',' ORDER BY priority_score), '') FROM public.priority_score_log WHERE priority_score > 1")"; }
eq "A7 borda: 59 dias fica, 61 sai (nas 2 tabelas)" "$(borda)" "59|59"

# A8: teto — 70 velhas com lote 1: a chamada para em 60 por tabela e avisa que resta; a seguinte termina
velhas70() { P -q -c "INSERT INTO public.health_score_history (health_score, calculated_at) SELECT 1, now() - interval '100 days' FROM generate_series(1, 70);
                      INSERT INTO public.priority_score_log (priority_score, score_date) SELECT 1, current_date - 100 FROM generate_series(1, 70);"; }
teto() { Pq -c "WITH r AS (SELECT private.expurgar_scores_antigos(60, 1) AS j) SELECT (j ->> 'health_score_history') || '+' || (j ->> 'priority_score_log') || ' ' || (j ->> 'resta_health') || '/' || (j ->> 'resta_priority') FROM r"; }
velhas70
eq "A8 1ª chamada para no teto de 60 lotes e avisa resta" "$(teto)" "60+60 true/true"
eq "A9 2ª chamada leva o resto" "$(teto)" "10+10 false/false"
eq "A10 re-rodar sem nada velho apaga 0" "$(teto)" "0+0 false/false"

# A11: pisos — retenção < 30 dias e lote fora de 1..50000
for args in "29, 10000" "60, 0" "60, 50001" "NULL, 10000"; do
  R=$(P -tA 2>&1 <<SQL || true
DO \$\$ BEGIN
  PERFORM private.expurgar_scores_antigos($args);
  RAISE NOTICE 'ACEITOU';
EXCEPTION WHEN invalid_parameter_value THEN RAISE NOTICE 'RECUSOU_22023';
END \$\$;
SQL
)
  case "$R" in *RECUSOU_22023*) ok "A11 ($args) recusado (22023)" ;; *) bad "A11 ($args) — veio: $(echo "$R" | tr '\n' ' ' | cut -c1-200)" ;; esac
done

# A12/A13: fechada para authenticated e anon (42501 na fronteira)
for role in authenticated anon; do
  R=$(P -tA 2>&1 <<SQL || true
BEGIN; SET LOCAL ROLE $role;
DO \$\$ BEGIN
  PERFORM private.expurgar_scores_antigos(60);
  RAISE NOTICE 'EXECUTOU';
EXCEPTION WHEN insufficient_privilege THEN RAISE NOTICE 'BARRADO_42501';
END \$\$;
ROLLBACK;
SQL
)
  case "$R" in *BARRADO_42501*) ok "A-$role não executa o expurgo (42501)" ;; *) bad "A-$role — veio: $(echo "$R" | tr '\n' ' ' | cut -c1-200)" ;; esac
done

# A14: o comando do cron, como está gravado, roda (SETs + chamada)
CMD=$(Pq -c "SELECT command FROM cron.job WHERE jobname = 'expurgo-scores-farmer'")
velhas70
R=$(Pq -c "$CMD" | tail -1)
eq "A14 o comando do cron, como gravado, roda e apaga" \
   "$(Pq -c "SELECT (j ->> 'health_score_history') || '+' || (j ->> 'priority_score_log') FROM (SELECT '$R'::jsonb AS j) r")" "70+70"

# A15: PRE — corpo vivo desconhecido (nem o predecessor nem este) aborta a migration
corpo "$MIG" | sed 's/c_max_lotes CONSTANT int := 60;/c_max_lotes CONSTANT int := 61;/' > "$TMPD/deriva.sql"
P -q -f "$TMPD/deriva.sql"
R=$(aplicar "$MIG" 2>&1 || true)
case "$R" in *B1_PRE_FALHOU*) ok "A15 corpo vivo desconhecido aborta na PRE (B1_PRE_FALHOU)" ;; *) bad "A15 — veio: $(echo "$R" | tr '\n' ' ' | cut -c1-200)" ;; esac
P -q -f "$TMPD/corpo.sql"   # restaura o corpo deste arquivo
if aplicar "$MIG" >/dev/null 2>&1; then ok "A16 com o corpo deste arquivo vivo, re-aplica"; else bad "A16 re-aplicação falhou"; fi

# ═══ ZONA 3 — FALSIFICAÇÃO (o corpo sabotado vai direto, sem a migration: a PRE o recusaria) ═══
echo "── falsificação ──"
# F1: sem teto → a 1ª chamada apaga as 70 e o assert A8 fica vermelho
corpo "$MIG" | sed 's/c_max_lotes CONSTANT int := 60;/c_max_lotes CONSTANT int := 1000000;/' > "$TMPD/f1.sql"
if cmp -s "$TMPD/corpo.sql" "$TMPD/f1.sql"; then bad "F1 sed não sabotou nada"; else
  P -q -f "$TMPD/f1.sql"; velhas70
  V=$(teto)
  if [ "$V" != "60+60 true/true" ]; then ok "F1 sem teto o A8 muda (veio [$V]) — A8 tem dente"; else bad "F1 sabotagem passou despercebida pelo teto"; fi
  P -q -f "$TMPD/corpo.sql"; teto >/dev/null; teto >/dev/null
fi
# F2: comparação invertida → apaga o RECENTE; a borda A7 tem de mudar
corpo "$MIG" | sed 's/WHERE calculated_at < v_corte LIMIT/WHERE calculated_at > v_corte LIMIT/' > "$TMPD/f2.sql"
if cmp -s "$TMPD/corpo.sql" "$TMPD/f2.sql"; then bad "F2 sed não sabotou nada"; else
  P -q -f "$TMPD/f2.sql"
  P -q -c "INSERT INTO public.health_score_history (health_score, calculated_at) VALUES (61, now() - interval '61 days');"
  Pq -c "SELECT private.expurgar_scores_antigos(60)" >/dev/null
  V=$(borda)
  if [ "$V" != "59|59" ]; then ok "F2 comparação invertida muda a borda (veio [$V]) — A7 tem dente"; else bad "F2 sabotagem passou despercebida pela borda"; fi
  P -q -f "$TMPD/corpo.sql"
fi
# F3: migration sem o cron.schedule → a pós-condição tem de abortar
P -q -c "DELETE FROM cron.job WHERE jobname = 'expurgo-scores-farmer';"
# shellcheck disable=SC2016  # o $cron$ é o dollar-quote literal do SQL, não variável
grep -v "^SELECT cron.schedule('expurgo-scores-farmer'" "$MIG" | grep -v '^  \$cron\$SET statement_timeout' > "$TMPD/f3.sql"
if cmp -s "$MIG" "$TMPD/f3.sql"; then bad "F3 a sabotagem não removeu o cron"; else
  R=$(aplicar "$TMPD/f3.sql" 2>&1 || true)
  case "$R" in *B1_POS_FALHOU*) ok "F3 migration sem o cron aborta na pós-condição (B1_POS_FALHOU)" ;; *) bad "F3 — veio: $(echo "$R" | tr '\n' ' ' | cut -c1-200)" ;; esac
fi

echo
echo "PASS=$PASS  FAIL=$FAIL"
[ "$FAIL" -eq 0 ]
