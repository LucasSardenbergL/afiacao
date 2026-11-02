#!/usr/bin/env bash
# ╔══════════════════════════════════════════════════════════════════════════════════╗
# ║  HARNESS PG17 — B4 (plano v4, lote 12): expurgo de tint_sync_runs / tint_sync_errors ║
# ║   bash db/test-expurgo-logs-tint.sh > "$SCRATCH/t.log" 2>&1; echo $?                ║
# ║                                                                                    ║
# ║  Aplica a migration REAL 20261101221749 e EXECUTA o expurgo (plpgsql é late-bound),║
# ║  com as 14 FKs de PROD apontando para tint_sync_runs (12 CASCADE, 2 NO ACTION):    ║
# ║  run com QUALQUER filha fica (e a filha também), run da fila da promoção fica,     ║
# ║  borda 29/31 dias (runs) e 59/61 (erros), lotes com teto, guarda de FK sem índice, ║
# ║  piso de 30 dias (22023), fecho para anon/authenticated (42501), cron 1x.          ║
# ║  CONTROLE: antes do expurgo as linhas velhas existem (o DELETE tem o que apagar).  ║
# ║  FALSIFICAÇÃO: (F1) sem o NOT EXISTS a staging cascateia; (F2) sem o filtro de     ║
# ║  promoção a fila some; (F3) sem o cron e (F4) sem índice a pós-condição aborta.    ║
# ╚══════════════════════════════════════════════════════════════════════════════════╝
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
export PGVER=17   # consumido pelo db/lib/pg-harness.sh via source
PORT="${PGPORT_TEST:-5534}"
SLUG="expurgo-logs-tint"
TMPD="$(mktemp -d "/tmp/pgtest-${SLUG}.XXXXXX")"
DATA="$TMPD/data"
MIG="$REPO_ROOT/supabase/migrations/20261101221749_expurgo_logs_tintometrico.sql"
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
# a migration vai pelo db:aplicar, que fornece a transação: aqui o -1 faz esse papel
aplicar() { P -q -1 -f "$1"; }

PASS=0; FAIL=0
ok()  { PASS=$((PASS+1)); echo "  ✅ $1"; }
bad() { FAIL=$((FAIL+1)); echo "  ❌ $1"; }
eq()  { if [ "$2" = "$3" ]; then ok "$1 (=$2)"; else bad "$1 — esperado [$3], veio [$2]"; fi; }

# ═══ ZONA 1 — estado de PROD (FKs/índices medidos via psql-ro 2026-11-01) ═══
P -q -f "$REPO_ROOT/db/stubs-supabase.sql"
P -q <<'SQL'
CREATE SCHEMA IF NOT EXISTS private;
-- prod: authenticated/anon TÊM USAGE em private — sem isto o 42501 viria do SCHEMA e o assert de fecho
-- passaria sem o REVOKE
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

CREATE TABLE public.tint_integration_settings (id uuid PRIMARY KEY DEFAULT gen_random_uuid());
CREATE TABLE public.tint_sync_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  setting_id uuid NOT NULL REFERENCES public.tint_integration_settings(id) ON DELETE CASCADE,
  account text, store_code text, sync_type text, status text NOT NULL DEFAULT 'running',
  started_at timestamptz NOT NULL DEFAULT now(), completed_at timestamptz, metadata jsonb,
  created_at timestamptz NOT NULL DEFAULT now(), idempotency_key text, idempotency_response jsonb,
  promocao_status text CHECK (promocao_status IS NULL OR promocao_status IN ('pendente','promovido','erro','descartado')),
  promovido_em timestamptz);
CREATE INDEX idx_tint_sync_runs_started_at ON public.tint_sync_runs (started_at);
CREATE TABLE public.tint_sync_errors (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sync_run_id uuid NOT NULL REFERENCES public.tint_sync_runs(id) ON DELETE CASCADE,
  entity_type text, error_message text, error_details jsonb, created_at timestamptz NOT NULL DEFAULT now());
CREATE INDEX idx_tint_sync_errors_run ON public.tint_sync_errors (sync_run_id);

-- as outras 13 filhas, com o ON DELETE e o índice de PROD (6 sem índice em sync_run_id)
DO $$
DECLARE r record;
BEGIN
  FOR r IN SELECT * FROM (VALUES
      ('tint_staging_produtos', 'CASCADE', true), ('tint_staging_bases', 'CASCADE', true),
      ('tint_staging_embalagens', 'CASCADE', true), ('tint_staging_skus', 'CASCADE', true),
      ('tint_staging_corantes', 'CASCADE', true), ('tint_staging_formulas', 'CASCADE', true),
      ('tint_staging_preparacoes', 'CASCADE', true),
      ('tint_staging_formula_itens', 'CASCADE', false), ('tint_staging_preparacao_itens', 'CASCADE', false),
      ('tint_staging_cores_catalogo', 'CASCADE', false), ('tint_staging_cores_personalizadas', 'CASCADE', false),
      ('tint_staging_precos_base', 'NO ACTION', false), ('tint_reconciliation_runs', 'NO ACTION', false)
    ) v(t, regra, idx)
  LOOP
    EXECUTE format('CREATE TABLE public.%I (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), sync_run_id uuid REFERENCES public.tint_sync_runs(id) ON DELETE %s)', r.t, r.regra);
    IF r.idx THEN EXECUTE format('CREATE INDEX ON public.%I (sync_run_id)', r.t); END IF;
  END LOOP;
END $$;
-- a 14ª: sync_run_id é a PK (o índice vem dela)
CREATE TABLE public.tint_staging_preparacao_manifestos (
  sync_run_id uuid PRIMARY KEY REFERENCES public.tint_sync_runs(id) ON DELETE CASCADE);

INSERT INTO public.tint_integration_settings DEFAULT VALUES;
CREATE FUNCTION pg_temp.mk(p_tag text, p_dias int, p_status text DEFAULT 'complete', p_promo text DEFAULT NULL)
RETURNS uuid LANGUAGE sql AS $f$
  INSERT INTO public.tint_sync_runs (setting_id, status, promocao_status, started_at, created_at, metadata)
  SELECT id, p_status, p_promo, now() - make_interval(days => p_dias), now() - make_interval(days => p_dias),
         jsonb_build_object('tag', p_tag)
    FROM public.tint_integration_settings LIMIT 1
  RETURNING id $f$;

-- apagáveis
SELECT pg_temp.mk('velho_livre', 31);
SELECT pg_temp.mk('velho_promovido', 31, 'complete', 'promovido');
SELECT pg_temp.mk('velho_descartado', 31, 'complete', 'descartado');
SELECT pg_temp.mk('velho_status_error', 31, 'error');
SELECT pg_temp.mk('velho_nova_filha', 35);
SELECT pg_temp.mk('velho_bulk', 60 + g) FROM generate_series(1, 20) g;
WITH r AS (SELECT pg_temp.mk('velho_erro_antigo', 40) id)
  INSERT INTO public.tint_sync_errors (sync_run_id, error_message, created_at) SELECT id, 'e61', now() - interval '61 days' FROM r;
-- retidos
SELECT pg_temp.mk('recente', 29);
SELECT pg_temp.mk('velho_pendente', 40, 'complete', 'pendente');
SELECT pg_temp.mk('velho_erro_promo', 40, 'complete', 'erro');
SELECT pg_temp.mk('velho_running', 40, 'running');
WITH r AS (SELECT pg_temp.mk('velho_erro_recente', 40) id)
  INSERT INTO public.tint_sync_errors (sync_run_id, error_message, created_at) SELECT id, 'e59', now() - interval '59 days' FROM r;
-- "linha referenciada não é apagada": um run velho por filha, nas duas regras de FK
WITH r AS (SELECT pg_temp.mk('ref_skus', 40) id) INSERT INTO public.tint_staging_skus (sync_run_id) SELECT id FROM r;
WITH r AS (SELECT pg_temp.mk('ref_formula_itens', 40) id) INSERT INTO public.tint_staging_formula_itens (sync_run_id) SELECT id FROM r;
WITH r AS (SELECT pg_temp.mk('ref_manifesto', 40) id) INSERT INTO public.tint_staging_preparacao_manifestos (sync_run_id) SELECT id FROM r;
WITH r AS (SELECT pg_temp.mk('ref_precos_noaction', 40) id) INSERT INTO public.tint_staging_precos_base (sync_run_id) SELECT id FROM r;
WITH r AS (SELECT pg_temp.mk('ref_reconc_noaction', 40) id) INSERT INTO public.tint_reconciliation_runs (sync_run_id) SELECT id FROM r;
SQL
echo "═══ setup pronto (PG17 :$PORT) ═══"

tags()   { Pq -c "SELECT string_agg(DISTINCT metadata->>'tag', ',' ORDER BY metadata->>'tag') FROM public.tint_sync_runs WHERE metadata->>'tag' <> 'velho_bulk'"; }
bulk()   { Pq -c "SELECT count(*) FROM public.tint_sync_runs WHERE metadata->>'tag' = 'velho_bulk'"; }
filhas() { Pq -c "SELECT concat((SELECT count(*) FROM public.tint_staging_skus), (SELECT count(*) FROM public.tint_staging_formula_itens), (SELECT count(*) FROM public.tint_staging_preparacao_manifestos), (SELECT count(*) FROM public.tint_staging_precos_base), (SELECT count(*) FROM public.tint_reconciliation_runs))"; }
erros()  { Pq -c "SELECT string_agg(error_message, ',' ORDER BY error_message) FROM public.tint_sync_errors"; }
TODAS="recente,ref_formula_itens,ref_manifesto,ref_precos_noaction,ref_reconc_noaction,ref_skus,velho_descartado,velho_erro_antigo,velho_erro_promo,velho_erro_recente,velho_livre,velho_nova_filha,velho_pendente,velho_promovido,velho_running,velho_status_error"
RETIDAS="recente,ref_formula_itens,ref_manifesto,ref_precos_noaction,ref_reconc_noaction,ref_skus,velho_erro_promo,velho_erro_recente,velho_nova_filha,velho_pendente,velho_running"

echo "── controle ──"
eq "C1 antes: todos os runs existem" "$(tags)" "$TODAS"
eq "C2 antes: 20 runs velhos em massa" "$(bulk)" 20
eq "C3 antes: 1 linha em cada filha referenciada" "$(filhas)" "11111"
eq "C4 antes: erro de 59 e de 61 dias" "$(erros)" "e59,e61"

# ═══ ZONA 2 — migration REAL (2x) ═══
aplicar "$MIG" >/dev/null
if aplicar "$MIG" >/dev/null 2>&1; then ok "A0 re-aplicar é no-op (idempotente)"; else bad "A0 2ª aplicação falhou"; fi

echo "── asserts ──"
eq "A1 exatamente 1 job, mesmo re-aplicado" "$(Pq -c "SELECT count(*) FROM cron.job WHERE jobname = 'expurgo-logs-tint' AND schedule = '41 * * * *' AND active")" 1
eq "A2 nenhuma FK de tint_sync_runs sem índice" "$(Pq -c "SELECT count(*) FROM pg_constraint c WHERE c.contype = 'f' AND c.confrelid = 'public.tint_sync_runs'::regclass AND NOT EXISTS (SELECT 1 FROM pg_index ix WHERE ix.indrelid = c.conrelid AND ix.indkey[0] = c.conkey[1] AND ix.indpred IS NULL)")" 0
eq "A3 migration NÃO expurga sozinha (o 1º expurgo é do cron)" "$(tags)|$(bulk)|$(erros)" "$TODAS|20|e59,e61"

# A4: teto por chamada — lote 3 x 2 lotes apaga 6 runs (os mais velhos: bulk) e avisa que resta
R=$(Pq -c "WITH r AS (SELECT private.expurgar_logs_tint(30, 60, 3, 2) AS j) SELECT (j->>'tint_sync_errors') || '+' || (j->>'tint_sync_runs') || '+' || (j->>'resta') FROM r")
eq "A4 lote 3 x 2: 1 erro + 6 runs, resta=true" "$R" "1+6+true"
eq "A5 os 6 saíram do bulk (ordem por started_at)" "$(bulk)" 14

# A6: guarda — FK nova sem índice recusa a chamada INTEIRA (nem os erros saem)
P -q -c "CREATE TABLE public.tint_nova_filha (id serial PRIMARY KEY, sync_run_id uuid REFERENCES public.tint_sync_runs(id) ON DELETE CASCADE);"
R=$(P -tA 2>&1 <<'SQL' || true
DO $$ BEGIN
  PERFORM private.expurgar_logs_tint();
  RAISE NOTICE 'ACEITOU';
EXCEPTION WHEN object_not_in_prerequisite_state THEN RAISE NOTICE 'RECUSOU_55000 %', SQLERRM;
END $$;
SQL
)
case "$R" in *RECUSOU_55000*expurgo_tint_fk_sem_indice*tint_nova_filha*) ok "A6 FK sem índice recusada (55000)" ;; *) bad "A6 — veio: $(echo "$R" | tr '\n' ' ' | cut -c1-200)" ;; esac
eq "A7 a recusa não apagou nada" "$(bulk)|$(tags)" "14|$TODAS"
# com índice, a filha nova passa a proteger o run dela sem mudar a função
P -q -c "CREATE INDEX ON public.tint_nova_filha (sync_run_id);
         INSERT INTO public.tint_nova_filha (sync_run_id) SELECT id FROM public.tint_sync_runs WHERE metadata->>'tag' = 'velho_nova_filha';"

# A8: chamada padrão
R=$(Pq -c "WITH r AS (SELECT private.expurgar_logs_tint() AS j) SELECT (j->>'tint_sync_errors') || '+' || (j->>'tint_sync_runs') || '+' || (j->>'resta') FROM r")
eq "A8 padrão: 0 erro + 19 runs (14 bulk + 5 velhos sem filha), resta=false" "$R" "0+19+false"
eq "A9 ficam exatamente os retidos (+ o da filha nova)" "$(tags)" "$RETIDAS"
eq "A10 linha referenciada: nenhuma filha perdeu linha (CASCADE e NO ACTION)" "$(filhas)|$(Pq -c "SELECT count(*) FROM public.tint_nova_filha")" "11111|1"
eq "A11 borda dos erros: 59 dias fica, 61 saiu (junto com o run dele)" "$(erros)" "e59"
eq "A12 re-rodar sem nada velho apaga 0" "$(Pq -c "SELECT (j->>'tint_sync_errors') || '+' || (j->>'tint_sync_runs') FROM (SELECT private.expurgar_logs_tint() j) z")" "0+0"

# A13/A14: pisos
for args in "7, 60" "30, 7" "30, 60, 0" "30, 60, 10, 0"; do
  R=$(P -tA 2>&1 <<SQL || true
DO \$\$ BEGIN
  PERFORM private.expurgar_logs_tint($args);
  RAISE NOTICE 'ACEITOU';
EXCEPTION WHEN invalid_parameter_value THEN RAISE NOTICE 'RECUSOU_22023';
END \$\$;
SQL
)
  case "$R" in *RECUSOU_22023*) ok "A-piso ($args) recusado (22023)" ;; *) bad "A-piso ($args) — veio: $R" ;; esac
done

# fecho para authenticated e anon (42501 na fronteira)
for role in authenticated anon; do
  R=$(P -tA 2>&1 <<SQL || true
BEGIN; SET LOCAL ROLE $role;
DO \$\$ BEGIN
  PERFORM private.expurgar_logs_tint();
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
# F1: sem o NOT EXISTS por filha → o run velho com staging sai e a staging vai junto no CASCADE.
# As filhas NO ACTION saem antes: com elas o DELETE abortaria em 23503 em vez de cascatear calado.
P -q -c "DELETE FROM public.tint_staging_precos_base; DELETE FROM public.tint_reconciliation_runs;"
sed "s/' AND NOT EXISTS (SELECT 1 FROM %s f WHERE f.%I = s.id)'/' AND (%L IS NOT NULL OR %L IS NOT NULL)'/" "$MIG" > "$TMPD/f1.sql"
if cmp -s "$MIG" "$TMPD/f1.sql"; then bad "F1 sed não sabotou nada"; else
  aplicar "$TMPD/f1.sql" >/dev/null
  Pq -c "SELECT private.expurgar_logs_tint()" >/dev/null
  V=$(Pq -c "SELECT count(*) FROM public.tint_staging_skus")
  if [ "$V" = "0" ]; then ok "F1 sem o NOT EXISTS a staging cascateia (skus=0) — A10 tem dente"; else bad "F1 sabotagem não apagou a staging (skus=$V)"; fi
  aplicar "$MIG" >/dev/null   # restaura o corpo verdadeiro
fi
# F2: sem o filtro de promoção → a fila (pendente/erro) some pelo tempo
P -q -c "INSERT INTO public.tint_sync_runs (setting_id, status, promocao_status, started_at, metadata)
         SELECT id, 'complete', 'pendente', now() - interval '45 days', '{\"tag\":\"f2\"}' FROM public.tint_integration_settings;"
sed "s/s.promocao_status IN (''promovido'', ''descartado'')/s.promocao_status IS NOT NULL/" "$MIG" > "$TMPD/f2.sql"
if cmp -s "$MIG" "$TMPD/f2.sql"; then bad "F2 sed não sabotou nada"; else
  aplicar "$TMPD/f2.sql" >/dev/null
  Pq -c "SELECT private.expurgar_logs_tint()" >/dev/null
  V=$(Pq -c "SELECT count(*) FROM public.tint_sync_runs WHERE metadata->>'tag' = 'f2'")
  if [ "$V" = "0" ]; then ok "F2 sem o filtro de promoção o run pendente some — A9 tem dente"; else bad "F2 sabotagem passou despercebida (f2=$V)"; fi
  aplicar "$MIG" >/dev/null
fi
# F3: migration sem o cron.schedule → a pós-condição aborta
P -q -c "DELETE FROM cron.job WHERE jobname = 'expurgo-logs-tint';"
grep -v "^SELECT cron.schedule('expurgo-logs-tint'" "$MIG" | grep -v "^  \$cron\$SET statement_timeout" > "$TMPD/f3.sql"
if cmp -s "$MIG" "$TMPD/f3.sql"; then bad "F3 a sabotagem não removeu o cron"; else
  R=$(aplicar "$TMPD/f3.sql" 2>&1 || true)
  case "$R" in *B4_POS_FALHOU*job=0*) ok "F3 migration sem o cron aborta na pós-condição" ;; *) bad "F3 — veio: $(echo "$R" | tr '\n' ' ' | cut -c1-200)" ;; esac
  aplicar "$MIG" >/dev/null   # devolve o cron
fi
# F4: migration sem o índice da formula_itens → a pós-condição aborta (fk_sem_indice=1)
P -q -c "DROP INDEX public.idx_tint_staging_formula_itens_sync_run_id;"
grep -v "idx_tint_staging_formula_itens_sync_run_id$" "$MIG" | grep -v "^  ON public.tint_staging_formula_itens (sync_run_id);" > "$TMPD/f4.sql"
if cmp -s "$MIG" "$TMPD/f4.sql"; then bad "F4 a sabotagem não removeu o índice"; else
  R=$(aplicar "$TMPD/f4.sql" 2>&1 || true)
  case "$R" in *B4_POS_FALHOU*fk_sem_indice=1*) ok "F4 migration sem o índice da filha aborta na pós-condição" ;; *) bad "F4 — veio: $(echo "$R" | tr '\n' ' ' | cut -c1-200)" ;; esac
fi

echo
echo "PASS=$PASS  FAIL=$FAIL"
[ "$FAIL" -eq 0 ]
