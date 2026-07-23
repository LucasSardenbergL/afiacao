#!/usr/bin/env bash
# ════════════════════════════════════════════════════════════════════════════════════════════════
# PROVA — LEASE do calculate-scores (fecha o last-writer-wins entre runs sobrepostos)
# Migration: supabase/migrations/20260728120001_calculate_scores_lease.sql
# Roda:  bash db/test-calculate-scores-lease.sh > /tmp/t.log 2>&1; echo "exit=$?"
#
# O FURO (achado /codex 2026-07-22): o writer monta o payload do SNAPSHOT lido no INÍCIO do run e o
# envia no FIM, sem exclusão mútua. Um run com marginRefreshFatal (overlay de margem PULADO) carrega
# o snapshot VELHO no payload; se ele terminar DEPOIS de um run saudável, RESTAURA o valor velho.
#
# ── ZONA LEASE (mecânica; espelha db/test-carteira-rebuild-lease.sh) ──
#   L1  lease ausente → claim = true (cria 'syncing')
#   L2  claim enquanto 'syncing' recente → false  ← a exclusão mútua, o furo fechado
#   L3  claim 'syncing' STALE (>15min) → true (auto-libera; prova now() do BANCO, não da edge)
#   L4  claim sobre 'complete' → true (reivindica lease liberado)
#   L5  finalize do run DONO → true + status='complete'
#   L6  finalize de run ALHEIO → false + status segue 'syncing' (ownership)
#   L7  finalize sobre 'complete' posto POR FORA (fase='inicio') → false (não re-finaliza estado alheio)
#   L8  IDEMPOTÊNCIA: finalize repetido do MESMO run → true, true (retry após resposta HTTP perdida —
#       real aqui: o cron corta em 150s e a edge segue viva)
#   L9  VALIDAÇÃO: status ∉ {complete,error} → 22023; run_id vazio → 22004
#   L10 REVOKE: anon E authenticated NÃO executam; service_role executa
#   L11 RLS: employee NÃO adultera a linha 'calculate_scores' (policy RESTRICTIVE); toca outras entity_type
#   L12 CONCORRÊNCIA REAL: 8 claims simultâneos → 0 workers falham, EXATAMENTE 1 't' e 7 'f'
#
# ── ZONA CORRIDA (o efeito no DADO — pedido explicitamente no challenge /codex) ──
# `teste_run()` modela o run da edge FIELMENTE (claim → snapshot → apply → finalize) e registra uma
# TRILHA DE EVENTOS por run. A propriedade provada NÃO é "as duas ordens terminam bem" — é
# **dois runs sobrepostos nunca chegam AMBOS ao snapshot/apply** (calibração do /codex). Sem a
# trilha, "o perdedor não escreveu" seria só o harness escolhendo não chamar o apply.
# Cada cenário é INDEPENDENTE (SEED próprio): encadear estados faz um cenário provar o resíduo do
# anterior em vez da própria propriedade.
#   R1  BASELINE-DO-BUG, ordem A→B (saudável commita, degradado commita DEPOIS): SEM lease o degradado
#       RESTAURA margem/cobertura velhas. Prova que a corrida é real — e que R3/R4 têm o que fechar.
#   R2  BASELINE-DO-BUG, ordem B→A: SEM lease o dado fica CERTO — por acaso, só pela ordem. É o par
#       que mostra que o desfecho hoje é sorte, não desenho.
#   R3  COM LEASE, o SAUDÁVEL ganha: A segura o lease, B (degradado) chega DENTRO da janela e é
#       PULADO — eventos de B = só 'skipped', sem snapshot e sem apply. Valor final NOVO.
#   R4  COM LEASE, o DEGRADADO ganha (o caso que mais importa): B segura o lease, A é PULADO, B relê
#       o corrente e o regrava (NO-OP DE VERDADE — nada restaurado) e finaliza 'error' (como a edge,
#       que lança marginRefreshFatal DEPOIS do apply); A RETENTA após a liberação e converge.
#   R5  guard anti-regressão: run único saudável escreve normalmente (serializar ≠ "não escreve").
#   R6  IDEMPOTÊNCIA do claim: re-claim com o MESMO run_id → true (retry após resposta HTTP perdida
#       não deixa o lease preso até o TTL); claim de run DIFERENTE segue barrado. E o cenário
#       adversarial da cláusula (R6d-f): depois do TTL, OUTRO run assume e o ANTIGO que volta NÃO
#       rouba o lease — a cláusula reconhece o dono CORRENTE, não qualquer id que já foi dono.
#
# ── FALSIFICAÇÃO ──
#   F0  prova que a sabotagem do claim APLICOU (senão "não casou nada" se lê como "assert sem dente")
#   F1  claim SEM o WHERE → 2º claim no lease fresco PASSA (L2 tem dente)
#   F2  finalize SEM ownership → finalize alheio PASSA (L6 tem dente)
#   F3  policy RESTRICTIVE de UPDATE dropada → employee ADULTERA o lease (L11 tem dente)
#   F4  claim SEM o WHERE → os dois runs entram e o degradado restaura o velho (R3e tem dente).
#       Amarra a MECÂNICA (L2) ao EFEITO NO DADO (R3e).
#   F5  claim SEM o WHERE → o run que devia ser PULADO chega ao snapshot/apply (R3c tem dente).
#       Sem ela, "o dado ficou certo" e "o perdedor foi barrado" seriam crenças separadas e só a
#       primeira teria falsificação.
#
# ⚠️ O que este harness NÃO prova: que a EDGE chama o claim antes de ler o snapshot (é TS, não SQL).
#    Isso é coberto por supabase/functions/calculate-scores/ordem-lease_test.ts, com falsificação
#    própria. Sem aquele guard, mover o select para antes do claim deixaria TUDO aqui verde.
#
# ⚠️ TELL de vermelho inválido: o total de asserts é FIXADO em TOTAL_ESPERADO e conferido no fim —
#    "não rodou nada" e "rodou e falhou" têm de ser distinguíveis (§ money-path.md).
# ════════════════════════════════════════════════════════════════════════════════════════════════
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PGVER=17
PGBIN="/opt/homebrew/opt/postgresql@${PGVER}/bin"
PORT="${PGPORT_TEST:-5496}"
SLUG="calculate-scores-lease"
DATA="$(mktemp -d "/tmp/pgtest-${SLUG}.XXXXXX")/data"
export LC_ALL=C LANG=C

MIG_LEASE="$REPO_ROOT/supabase/migrations/20260728120001_calculate_scores_lease.sql"
MIG_RPC="$REPO_ROOT/supabase/migrations/20260728120000_farmer_persiste_cobertura_custo.sql"

[ -x "$PGBIN/initdb" ] || { echo "postgresql@${PGVER} ausente: brew install postgresql@${PGVER} pgvector"; exit 1; }
[ -f "$MIG_LEASE" ] || { echo "migration do lease nao encontrada: $MIG_LEASE"; exit 1; }
[ -f "$MIG_RPC" ]   || { echo "migration da RPC nao encontrada: $MIG_RPC"; exit 1; }

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

P -q -f "$REPO_ROOT/db/stubs-supabase.sql" >/dev/null
# auth.uid() lê o GUC test.uid (impersonação de RLS); service_role BYPASSRLS (espelha o admin do Supabase).
P -q <<'SQL'
CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $f$ SELECT nullif(current_setting('test.uid', true), '')::uuid $f$;
ALTER ROLE service_role BYPASSRLS;
SQL

PASS=0; FAIL=0
ok()  { PASS=$((PASS+1)); echo "  OK   $1"; }
bad() { FAIL=$((FAIL+1)); echo "  FAIL $1"; }
eq()  { if [ "$2" = "$3" ]; then ok "$1 (=$2)"; else bad "$1 -- esperado [$3], veio [$2]"; fi; }

echo "=== setup pronto (PG17 :$PORT) ==="

# ════════════════════════════════════════════════════════════════════════════════════════════════
# ZONA 1 — PRÉ-REQUISITOS: sync_state e farmer_client_scores no schema REAL de PROD
# ════════════════════════════════════════════════════════════════════════════════════════════════
# sync_state espelha a PROD: SEM constraint UNIQUE em pg_constraint, com UNIQUE INDEX (as duas chaves
# reais conferidas por psql-ro 2026-07-23 — idx_sync_state_entity_account e sync_state_entity_account_uq).
# Espelhar o design em vez da prod deixaria o ON CONFLICT verde num banco que a prod não tem.
P -q <<'SQL'
-- app_role/user_roles/has_role: a policy permissiva "Staff can manage sync state" os usa.
DO $$ BEGIN CREATE TYPE public.app_role AS ENUM ('master','employee','customer'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
CREATE TABLE public.user_roles (user_id uuid, role public.app_role);
CREATE FUNCTION public.has_role(uid uuid, r public.app_role) RETURNS boolean LANGUAGE sql STABLE AS $f$ SELECT EXISTS(SELECT 1 FROM public.user_roles WHERE user_id=uid AND role=r) $f$;

CREATE TABLE public.sync_state (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  entity_type text NOT NULL,
  account text DEFAULT 'vendas'::text NOT NULL,
  last_sync_at timestamptz, last_page integer DEFAULT 0, last_cursor text,
  total_synced integer DEFAULT 0, status text DEFAULT 'idle'::text, error_message text,
  metadata jsonb DEFAULT '{}'::jsonb, created_at timestamptz DEFAULT now(), updated_at timestamptz DEFAULT now()
);
CREATE UNIQUE INDEX sync_state_entity_account_uq ON public.sync_state (entity_type, account);
ALTER TABLE public.sync_state ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Staff can manage sync state" ON public.sync_state FOR ALL
  USING (public.has_role(auth.uid(),'master') OR public.has_role(auth.uid(),'employee'));
-- concede TRUNCATE (como em prod: authenticated TEM) → a migration REVOGA → o assert prova o dente
GRANT SELECT, INSERT, UPDATE, DELETE, TRUNCATE ON public.sync_state TO authenticated, anon, service_role;
GRANT SELECT ON public.user_roles TO authenticated, anon, service_role;

-- farmer_client_scores: schema real de PROD, SEM as colunas de cobertura (a migration 20260728120000
-- as ADICIONA — aplicá-la aqui prova a cadeia inteira, não só o lease).
CREATE TABLE public.farmer_client_scores (
  id uuid DEFAULT gen_random_uuid() NOT NULL PRIMARY KEY,
  customer_user_id uuid NOT NULL,
  farmer_id uuid NOT NULL,
  rf_score numeric DEFAULT 0,
  m_score numeric,
  g_score numeric DEFAULT 0,
  x_score numeric DEFAULT 0,
  s_score numeric DEFAULT 0,
  health_score numeric DEFAULT 0,
  health_class text DEFAULT 'critico',
  churn_risk numeric DEFAULT 0,
  recover_score numeric DEFAULT 0,
  expansion_score numeric DEFAULT 0,
  eff_score numeric DEFAULT 0,
  priority_score numeric DEFAULT 0,
  days_since_last_purchase integer DEFAULT 0,
  avg_repurchase_interval numeric DEFAULT 0,
  avg_monthly_spend_180d numeric DEFAULT 0,
  gross_margin_pct numeric,
  category_count integer DEFAULT 0,
  answer_rate_60d numeric DEFAULT 0,
  whatsapp_reply_rate_60d numeric DEFAULT 0,
  revenue_potential numeric DEFAULT 0,
  calculated_at timestamptz DEFAULT now(),
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now(),
  signal_modifiers jsonb DEFAULT '{}'::jsonb,
  last_signal_recalc_at timestamptz,
  sales_history_status text,
  CONSTRAINT farmer_client_scores_customer_unique UNIQUE (customer_user_id)
);
SQL

# ════════════════════════════════════════════════════════════════════════════════════════════════
# ZONA 2 — APLICAR AS MIGRATIONS REAIS (Lei #1: nunca um stub da lógica)
# ════════════════════════════════════════════════════════════════════════════════════════════════
P -q -f "$MIG_RPC"   >/dev/null   # apply_score_updates + colunas de cobertura
P -q -f "$MIG_LEASE" >/dev/null   # claim/finalizar + policies RESTRICTIVE
echo "=== migrations aplicadas ==="

CLEAR()  { P -q -c "DELETE FROM public.sync_state WHERE entity_type='calculate_scores';" >/dev/null; }
STATUS() { Pq -c "SELECT status FROM public.sync_state WHERE entity_type='calculate_scores' AND account='global';"; }

# ════════════════════════════════════════════════════════════════════════════════════════════════
# ZONA 3 — ASSERTS DO LEASE (mecânica)
# ════════════════════════════════════════════════════════════════════════════════════════════════
echo "-- zona lease: mecanica --"
CLEAR
eq "L1 lease ausente -> claim true"        "$(Pq -c "SELECT public.claim_calculate_scores('run-1');")" "t"
eq "L2 claim com 'syncing' fresco -> FALSE (exclusao mutua)" "$(Pq -c "SELECT public.claim_calculate_scores('run-2');")" "f"

P -q -c "UPDATE public.sync_state SET last_sync_at = now() - interval '6 minutes' WHERE entity_type='calculate_scores';" >/dev/null
eq "L2b claim com 'syncing' de 6min -> ainda FALSE (TTL 15min)" "$(Pq -c "SELECT public.claim_calculate_scores('run-2b');")" "f"

P -q -c "UPDATE public.sync_state SET last_sync_at = now() - interval '16 minutes' WHERE entity_type='calculate_scores';" >/dev/null
eq "L3 claim com 'syncing' STALE 16min -> true (auto-libera)" "$(Pq -c "SELECT public.claim_calculate_scores('run-3');")" "t"

P -q -c "UPDATE public.sync_state SET status='complete' WHERE entity_type='calculate_scores';" >/dev/null
eq "L4 claim sobre 'complete' -> true" "$(Pq -c "SELECT public.claim_calculate_scores('run-4');")" "t"

# L5: finalize do DONO
CLEAR; Pq -c "SELECT public.claim_calculate_scores('dono-1');" >/dev/null
eq "L5 finalize do DONO -> true" "$(Pq -c "SELECT public.finalizar_calculate_scores('dono-1','complete');")" "t"
eq "L5b status virou complete"   "$(STATUS)" "complete"

# L6: ownership
CLEAR; Pq -c "SELECT public.claim_calculate_scores('dono-2');" >/dev/null
eq "L6 finalize ALHEIO -> false"          "$(Pq -c "SELECT public.finalizar_calculate_scores('INTRUSO','complete');")" "f"
eq "L6b status segue syncing (intocado)"  "$(STATUS)" "syncing"

# L7: 'complete' posto POR FORA (fase='inicio') não é re-finalizável
CLEAR; Pq -c "SELECT public.claim_calculate_scores('dono-3');" >/dev/null
P -q -c "UPDATE public.sync_state SET status='complete' WHERE entity_type='calculate_scores';" >/dev/null
eq "L7 finalize sobre complete-por-fora -> false" "$(Pq -c "SELECT public.finalizar_calculate_scores('dono-3','complete');")" "f"

# L8: idempotência do MESMO run
CLEAR; Pq -c "SELECT public.claim_calculate_scores('idem-1');" >/dev/null
eq "L8 finalize 1a vez -> true"  "$(Pq -c "SELECT public.finalizar_calculate_scores('idem-1','complete');")" "t"
eq "L8b finalize repetido -> true (idempotente)" "$(Pq -c "SELECT public.finalizar_calculate_scores('idem-1','complete');")" "t"
eq "L8c alheio sobre complete -> false" "$(Pq -c "SELECT public.finalizar_calculate_scores('OUTRO','complete');")" "f"

# L9: validação de argumentos — assert NEGATIVO com SQLSTATE esperada + re-raise (Lei #2)
CLEAR; Pq -c "SELECT public.claim_calculate_scores('val-1');" >/dev/null
R=$(P -tA <<'SQL' 2>&1
DO $$ BEGIN
  PERFORM public.finalizar_calculate_scores('val-1','LIXO');
  RAISE NOTICE 'SEM_ERRO_STATUS';
EXCEPTION
  WHEN invalid_parameter_value THEN RAISE NOTICE 'SQLSTATE_22023_OK';
  WHEN OTHERS THEN RAISE;
END $$;
SQL
); case "$R" in *SQLSTATE_22023_OK*) ok "L9 status invalido -> 22023" ;; *) bad "L9 -- veio: $R" ;; esac

R=$(P -tA <<'SQL' 2>&1
DO $$ BEGIN
  PERFORM public.claim_calculate_scores('');
  RAISE NOTICE 'SEM_ERRO_RUNID';
EXCEPTION
  WHEN null_value_not_allowed THEN RAISE NOTICE 'SQLSTATE_22004_OK';
  WHEN OTHERS THEN RAISE;
END $$;
SQL
); case "$R" in *SQLSTATE_22004_OK*) ok "L9b run_id vazio -> 22004" ;; *) bad "L9b -- veio: $R" ;; esac

# L10: GRANTs
eq "L10 service_role executa claim"       "$(Pq -c "SELECT has_function_privilege('service_role','public.claim_calculate_scores(text)','EXECUTE');")" "t"
eq "L10b anon NAO executa claim"          "$(Pq -c "SELECT has_function_privilege('anon','public.claim_calculate_scores(text)','EXECUTE');")" "f"
eq "L10c authenticated NAO executa claim" "$(Pq -c "SELECT has_function_privilege('authenticated','public.claim_calculate_scores(text)','EXECUTE');")" "f"
eq "L10d authenticated NAO executa finalizar" "$(Pq -c "SELECT has_function_privilege('authenticated','public.finalizar_calculate_scores(text,text)','EXECUTE');")" "f"
eq "L10e authenticated perdeu TRUNCATE em sync_state" "$(Pq -c "SELECT has_table_privilege('authenticated','public.sync_state','TRUNCATE');")" "f"

# L11: RLS — employee não adultera a chave do lease, mas toca outras entity_type
EMP='22222222-2222-2222-2222-222222222222'
P -q -v emp="$EMP" <<'SQL' >/dev/null
INSERT INTO auth.users(id) VALUES (:'emp'::uuid) ON CONFLICT DO NOTHING;
INSERT INTO public.user_roles(user_id, role) VALUES (:'emp'::uuid, 'employee') ON CONFLICT DO NOTHING;
SQL
CLEAR; Pq -c "SELECT public.claim_calculate_scores('rls-1');" >/dev/null
R=$(P -tA -v emp="$EMP" <<'SQL' 2>&1
SELECT set_config('test.uid', :'emp', false); SET ROLE authenticated;
DO $$ DECLARE n int; BEGIN
  UPDATE public.sync_state SET status='hacked' WHERE entity_type='calculate_scores';
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n>0 THEN RAISE NOTICE 'RLS_FUROU_%', n; ELSE RAISE NOTICE 'RLS_BLOQUEOU'; END IF;
END $$;
SQL
); case "$R" in *RLS_BLOQUEOU*) ok "L11 employee NAO adultera o lease (policy RESTRICTIVE)" ;; *) bad "L11 -- veio: $R" ;; esac
eq "L11b status do lease intocado" "$(STATUS)" "syncing"

R=$(P -tA -v emp="$EMP" <<'SQL' 2>&1
SELECT set_config('test.uid', :'emp', false); SET ROLE authenticated;
DO $$ DECLARE n int; BEGIN
  INSERT INTO public.sync_state(entity_type, account, status) VALUES ('outra_entidade','x','idle');
  UPDATE public.sync_state SET status='ok2' WHERE entity_type='outra_entidade';
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n=1 THEN RAISE NOTICE 'RLS_PERMITIU_OUTRA'; ELSE RAISE NOTICE 'RLS_BLOQUEOU_DEMAIS_%', n; END IF;
END $$;
SQL
); case "$R" in *RLS_PERMITIU_OUTRA*) ok "L11c employee toca OUTRAS entity_type (policy cirurgica)" ;; *) bad "L11c -- veio: $R" ;; esac

# L12: concorrência real
echo "-- zona lease: concorrencia real --"
CLEAR
CDIR="$(mktemp -d /tmp/claim-cs-conc.XXXXXX)"; pids=()
for i in $(seq 1 8); do
  "$PGBIN/psql" -p "$PORT" -h /tmp -U postgres -d prove -tA \
    -c "SELECT public.claim_calculate_scores('conc-$i');" > "$CDIR/c$i.out" 2>"$CDIR/c$i.err" &
  pids+=($!)
done
fail_workers=0; for pid in "${pids[@]}"; do wait "$pid" || fail_workers=$((fail_workers+1)); done
TRUES="$(cat "$CDIR"/c*.out | command grep -c '^t$' || true)"
FALSES="$(cat "$CDIR"/c*.out | command grep -c '^f$' || true)"
eq "L12 nenhum worker falhou"   "$fail_workers" "0"
eq "L12b exatamente 1 vence"    "$TRUES" "1"
eq "L12c os outros 7 perdem"    "$FALSES" "7"
rm -rf "$CDIR"

# ════════════════════════════════════════════════════════════════════════════════════════════════
# ZONA 4 — CORRIDA: o efeito no DADO (run saudável x run com marginRefreshFatal)
# ════════════════════════════════════════════════════════════════════════════════════════════════
# Modela o writer da edge: um run monta o payload a partir do SNAPSHOT que ELE leu no início.
#   p_degradado=true  → marginRefreshFatal: o overlay é PULADO e o payload carrega o snapshot VELHO
#                       (é exatamente o que index.ts faz hoje: `itens_com_custo: client.itens_com_custo`).
#   p_degradado=false → run saudável: o overlay entra e o payload carrega os valores NOVOS.
# health_score/churn_risk são obrigatórios no contrato da RPC (12 chaves CORE) → sempre presentes.
P -q <<'SQL' >/dev/null
CREATE OR REPLACE FUNCTION public.teste_payload_run(
  p_snapshot   jsonb,     -- a linha como ESTE run a leu no inicio
  p_margem_nova numeric,  -- overlay (so entra se saudavel)
  p_com_novo   bigint,
  p_sem_novo   bigint,
  p_degradado  boolean
) RETURNS jsonb LANGUAGE sql IMMUTABLE AS $$
  SELECT jsonb_build_array(jsonb_build_object(
    'id',                       p_snapshot->>'id',
    'health_score',             50,
    'health_class',             'estavel',
    'churn_risk',               50,
    'priority_score',           10,
    'rf_score',                 10,
    'g_score',                  10,
    'days_since_last_purchase', 5,
    'avg_monthly_spend_180d',   100,
    'category_count',           2,
    'calculated_at',            now(),
    'updated_at',               now(),
    -- O GRUPO DA MARGEM: degradado reenvia o que leu; saudavel envia o overlay.
    'gross_margin_pct', CASE WHEN p_degradado THEN (p_snapshot->>'gross_margin_pct')::numeric ELSE p_margem_nova END,
    'm_score',          CASE WHEN p_degradado THEN (p_snapshot->>'m_score')::numeric          ELSE p_margem_nova END,
    'itens_com_custo',  CASE WHEN p_degradado THEN (p_snapshot->>'itens_com_custo')::bigint   ELSE p_com_novo END,
    'itens_sem_custo',  CASE WHEN p_degradado THEN (p_snapshot->>'itens_sem_custo')::bigint   ELSE p_sem_novo END
  ));
$$;

-- Le a linha como a edge le (select *) — o SNAPSHOT do inicio do run.
CREATE OR REPLACE FUNCTION public.teste_snapshot(p_cli uuid) RETURNS jsonb
LANGUAGE sql STABLE AS $$ SELECT to_jsonb(f) FROM public.farmer_client_scores f WHERE f.customer_user_id = p_cli $$;

-- Trilha de eventos por run. A propriedade a provar NAO e "as duas ordens terminam bem" — e
-- "dois runs sobrepostos nunca chegam AMBOS ao snapshot/apply" (calibracao do challenge /codex).
-- Sem a trilha, "o perdedor nao escreveu" seria so o harness escolhendo nao chamar o apply; com ela,
-- quem decide e o PROTOCOLO.
CREATE TABLE public.teste_eventos (run_id text, evento text, em timestamptz DEFAULT clock_timestamp());

-- Modela o run da edge FIELMENTE: claim -> (se perdeu, PULA) -> snapshot -> apply -> finalize.
-- p_finalizar=false deixa o lease preso de proposito (simula o run AINDA VIVO, para sobrepor outro).
-- O degradado finaliza 'error', nao 'complete': na edge, marginRefreshFatal e LANCADO depois do
-- apply e cai no catch — o run degradado sempre termina em erro (correcao do /codex).
CREATE OR REPLACE FUNCTION public.teste_run(
  p_run_id text, p_cli uuid, p_degradado boolean,
  p_margem numeric, p_com bigint, p_sem bigint, p_finalizar boolean DEFAULT true
) RETURNS text LANGUAGE plpgsql AS $$
DECLARE v_snap jsonb; BEGIN
  IF NOT public.claim_calculate_scores(p_run_id) THEN
    INSERT INTO public.teste_eventos(run_id, evento) VALUES (p_run_id, 'skipped');
    RETURN 'skipped';
  END IF;
  INSERT INTO public.teste_eventos(run_id, evento) VALUES (p_run_id, 'snapshot');
  v_snap := public.teste_snapshot(p_cli);
  INSERT INTO public.teste_eventos(run_id, evento) VALUES (p_run_id, 'apply');
  PERFORM public.apply_score_updates(public.teste_payload_run(v_snap, p_margem, p_com, p_sem, p_degradado));
  IF p_finalizar THEN
    PERFORM public.finalizar_calculate_scores(p_run_id, CASE WHEN p_degradado THEN 'error' ELSE 'complete' END);
  END IF;
  RETURN CASE WHEN p_degradado THEN 'error' ELSE 'complete' END;
END $$;
SQL

CLI='33333333-3333-3333-3333-333333333333'
FARM='44444444-4444-4444-4444-444444444444'
# Estado VELHO (o que o run degradado vai carregar): margem 99, cobertura 77/88.
SEED() {
  P -q -v cli="$CLI" -v farm="$FARM" <<'SQL' >/dev/null
DELETE FROM public.farmer_client_scores WHERE customer_user_id = :'cli'::uuid;
INSERT INTO public.farmer_client_scores
  (customer_user_id, farmer_id, gross_margin_pct, m_score, itens_com_custo, itens_sem_custo)
VALUES (:'cli'::uuid, :'farm'::uuid, 99, 99, 77, 88);
SQL
}
# Estado atual da linha, compacto: margem/m_score/com/sem.
# ⚠️ Interpolação pelo SHELL ('$CLI'), não por -v/:'cli': o psql NÃO substitui variáveis em `-c`
# (o lexer de variáveis só roda em input de stdin/arquivo) — com -v o literal `:'cli'` chega ao
# servidor e vira syntax error. Nos heredocs abaixo o :'cli' funciona porque ali é stdin.
LINHA() { Pq -c "SELECT concat_ws('/', gross_margin_pct, m_score, itens_com_custo, itens_sem_custo) FROM public.farmer_client_scores WHERE customer_user_id = '$CLI'::uuid;"; }

echo "-- zona corrida: baseline do bug (SEM lease) --"
# R1 — ordem A->B: os DOIS leem antes de qualquer escrita; o degradado commita por ULTIMO.
SEED
P -q -v cli="$CLI" <<'SQL' >/dev/null
-- os dois runs leem o MESMO snapshot velho (99/99/77/88)
CREATE TEMP TABLE snapA AS SELECT public.teste_snapshot(:'cli'::uuid) AS s;
CREATE TEMP TABLE snapB AS SELECT public.teste_snapshot(:'cli'::uuid) AS s;
-- A (saudavel) escreve os valores NOVOS
SELECT public.apply_score_updates(public.teste_payload_run((SELECT s FROM snapA), 53, 3, 37, false));
-- B (degradado) termina DEPOIS e reenvia o snapshot VELHO
SELECT public.apply_score_updates(public.teste_payload_run((SELECT s FROM snapB), 53, 3, 37, true));
SQL
eq "R1 SEM lease, ordem A->B: o degradado RESTAURA o velho (bug reproduzido)" "$(LINHA)" "99/99/77/88"

# R2 — ordem B->A: mesmo bug latente, desfecho certo por ACASO (a ordem salvou).
SEED
P -q -v cli="$CLI" <<'SQL' >/dev/null
CREATE TEMP TABLE snapA2 AS SELECT public.teste_snapshot(:'cli'::uuid) AS s;
CREATE TEMP TABLE snapB2 AS SELECT public.teste_snapshot(:'cli'::uuid) AS s;
SELECT public.apply_score_updates(public.teste_payload_run((SELECT s FROM snapB2), 53, 3, 37, true));
SELECT public.apply_score_updates(public.teste_payload_run((SELECT s FROM snapA2), 53, 3, 37, false));
SQL
eq "R2 SEM lease, ordem B->A: fica certo por ACASO (o desfecho e a ordem, nao o desenho)" "$(LINHA)" "53/53/3/37"

echo "-- zona corrida: COM lease --"
# Trilha de eventos por run: prova QUEM chegou ao snapshot/apply.
EVENTOS() { Pq -c "SELECT coalesce(string_agg(evento, ',' ORDER BY em), '(nenhum)') FROM public.teste_eventos WHERE run_id = '$1';"; }
LIMPA_EV() { P -q -c "TRUNCATE public.teste_eventos;" >/dev/null; }

# ── R3: o SAUDAVEL ganha o lease; o degradado chega DURANTE ────────────────────────────────────
# Cada cenario e INDEPENDENTE (SEED proprio) — encadear estados faz um cenario provar o residuo do
# anterior em vez da propria propriedade (correcao do /codex).
SEED; CLEAR; LIMPA_EV
# A reivindica e NAO finaliza (p_finalizar=false): modela o run ainda VIVO, com a janela aberta.
eq "R3 A (saudavel) roda e segura o lease" "$(Pq -c "SELECT public.teste_run('A-run','$CLI'::uuid,false,53,3,37,false);")" "complete"
# B (degradado) chega DENTRO da janela de A.
eq "R3b B (degradado) e PULADO"            "$(Pq -c "SELECT public.teste_run('B-run','$CLI'::uuid,true,53,3,37,true);")" "skipped"
eq "R3c B nao chegou ao snapshot nem ao apply" "$(EVENTOS B-run)" "skipped"
eq "R3d A chegou ao snapshot e ao apply"       "$(EVENTOS A-run)" "snapshot,apply"
Pq -c "SELECT public.finalizar_calculate_scores('A-run','complete');" >/dev/null
eq "R3e COM lease: o degradado NAO vence (valor novo preservado)" "$(LINHA)" "53/53/3/37"

# ── R4: o DEGRADADO ganha o lease; o saudavel chega DURANTE e RETENTA depois ───────────────────
# O caso que mais importa: o degradado nao pode deixar dano permanente. Ele regrava o que leu
# (no-op de verdade sob o lease), finaliza 'error' — como a edge faz, pois marginRefreshFatal e
# lancado depois do apply — e o saudavel converge no run seguinte.
SEED; CLEAR; LIMPA_EV
eq "R4 B (degradado) ganha o lease e segura"   "$(Pq -c "SELECT public.teste_run('B2-run','$CLI'::uuid,true,53,3,37,false);")" "error"
eq "R4b A (saudavel) chega DURANTE e e PULADO" "$(Pq -c "SELECT public.teste_run('A2-run','$CLI'::uuid,false,53,3,37,true);")" "skipped"
eq "R4c A nao chegou ao snapshot nem ao apply" "$(EVENTOS A2-run)" "skipped"
eq "R4d o degradado sozinho e NO-OP: regrava o que leu, nada restaurado" "$(LINHA)" "99/99/77/88"
# B finaliza com 'error' (o run degradado SEMPRE termina em erro na edge) e libera o lease.
eq "R4e B finaliza como 'error'" "$(Pq -c "SELECT public.finalizar_calculate_scores('B2-run','error');")" "t"
# O saudavel RETENTA depois da liberacao: agora ganha, rele e converge.
eq "R4f A retenta apos a liberacao e ganha" "$(Pq -c "SELECT public.teste_run('A3-run','$CLI'::uuid,false,53,3,37,true);")" "complete"
eq "R4g convergiu para o valor novo"        "$(LINHA)" "53/53/3/37"

# ── R5: guard anti-regressao — serializar nao pode virar "nao escreve" ─────────────────────────
SEED; CLEAR; LIMPA_EV
eq "R5 run unico saudavel escreve normalmente" "$(Pq -c "SELECT public.teste_run('solo-run','$CLI'::uuid,false,53,3,37,true);")" "complete"
eq "R5b lease nao trava a escrita" "$(LINHA)" "53/53/3/37"

# ── R6: idempotencia do claim — retry com o MESMO run_id nao fica preso (achado /codex) ────────
# Se o banco confirma o claim mas a resposta HTTP se perde, o retry usa o MESMO run_id. Sem o
# re-claim do dono ele receberia false e o lease ficaria preso ate o TTL de 15min.
CLEAR
eq "R6 1o claim do run"                    "$(Pq -c "SELECT public.claim_calculate_scores('retry-1');")" "t"
eq "R6b RE-claim do MESMO run_id -> true (retry idempotente)" "$(Pq -c "SELECT public.claim_calculate_scores('retry-1');")" "t"
eq "R6c claim de run DIFERENTE segue barrado" "$(Pq -c "SELECT public.claim_calculate_scores('outro-run');")" "f"

# R6d — o cenario adversarial da clausula de re-claim: o run ANTIGO nao pode ROUBAR o lease de quem
# assumiu depois do TTL. Se o `OR metadata->>'run_id' = p_run_id` reconhecesse qualquer id que JA
# tenha sido dono (e nao o dono CORRENTE), um zumbi ressuscitaria e voltariamos a ter dois writers.
CLEAR
Pq -c "SELECT public.claim_calculate_scores('zumbi');" >/dev/null
P -q -c "UPDATE public.sync_state SET last_sync_at = now() - interval '16 minutes' WHERE entity_type='calculate_scores';" >/dev/null
eq "R6d apos o TTL, OUTRO run assume"            "$(Pq -c "SELECT public.claim_calculate_scores('sucessor');")" "t"
eq "R6e o run ANTIGO volta e NAO rouba o lease"  "$(Pq -c "SELECT public.claim_calculate_scores('zumbi');")" "f"
eq "R6f dono corrente segue sendo o sucessor"    "$(Pq -c "SELECT metadata->>'run_id' FROM public.sync_state WHERE entity_type='calculate_scores';")" "sucessor"

# ════════════════════════════════════════════════════════════════════════════════════════════════
# ZONA 5 — FALSIFICAÇÃO (Lei #3): sabotar e EXIGIR vermelho
# ════════════════════════════════════════════════════════════════════════════════════════════════
echo "-- falsificacao --"
# Sabotagem do claim: WHERE removido. Aplicada 1x e usada por F1 e F4.
SABOTA_CLAIM() {
  P -q <<'SQL' >/dev/null
CREATE OR REPLACE FUNCTION public.claim_calculate_scores(p_run_id text)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE v_claimed boolean := false; BEGIN
  INSERT INTO public.sync_state (entity_type, account, status, last_sync_at, total_synced, metadata, updated_at)
  VALUES ('calculate_scores','global','syncing',now(),0,jsonb_build_object('run_id',p_run_id,'fase','inicio'),now())
  ON CONFLICT (entity_type, account) DO UPDATE
    SET status='syncing', last_sync_at=now(), metadata=jsonb_build_object('run_id',p_run_id,'fase','inicio'), updated_at=now()
  RETURNING true INTO v_claimed;   -- WHERE REMOVIDO
  RETURN COALESCE(v_claimed,false); END $$;
SQL
}
# Prova que a sabotagem APLICOU (senao "nao casou nada" se le como "assert sem dente")
SABOTA_CLAIM
if Pq -c "SELECT pg_get_functiondef('public.claim_calculate_scores(text)'::regprocedure);" | command grep -q "WHERE REMOVIDO"; then
  ok "F0 sabotagem do claim APLICOU (tell contra vermelho invalido)"
else
  bad "F0 sabotagem do claim NAO aplicou -- falsificacao INVALIDA"
fi

# F1: sem o WHERE, o 2º claim no lease fresco passa → L2 tem dente
CLEAR; Pq -c "SELECT public.claim_calculate_scores('sab-1');" >/dev/null
case "$(Pq -c "SELECT public.claim_calculate_scores('sab-2');")" in
  t) ok "F1 sem o WHERE o 2o claim fresco PASSOU (L2 tem dente)" ;;
  *) bad "F1 L2 fraco -- a sabotagem nao mudou o resultado" ;;
esac

# F4: com o claim sabotado, a CORRIDA volta — o degradado pega o lease, roda junto e restaura o velho.
# Amarra a mecânica (L2) ao efeito no dado (R3): sem esta, "o lock funciona" e "o dado fica certo"
# seriam duas crenças separadas.
SEED; CLEAR
CA="$(Pq -c "SELECT public.claim_calculate_scores('F4-A');")"
CB="$(Pq -c "SELECT public.claim_calculate_scores('F4-B');")"
P -q -v cli="$CLI" <<'SQL' >/dev/null
CREATE TEMP TABLE snapF4a AS SELECT public.teste_snapshot(:'cli'::uuid) AS s;
CREATE TEMP TABLE snapF4b AS SELECT public.teste_snapshot(:'cli'::uuid) AS s;
SELECT public.apply_score_updates(public.teste_payload_run((SELECT s FROM snapF4a), 53, 3, 37, false));
SELECT public.apply_score_updates(public.teste_payload_run((SELECT s FROM snapF4b), 53, 3, 37, true));
SQL
if [ "$CA" = "t" ] && [ "$CB" = "t" ] && [ "$(LINHA)" = "99/99/77/88" ]; then
  ok "F4 claim sabotado -> os dois runs entram e o degradado RESTAURA o velho (R3e tem dente)"
else
  bad "F4 R3e fraco -- claims [$CA/$CB], linha [$(LINHA)] (esperado t/t e 99/99/77/88)"
fi

# F5: com o claim sabotado, o run que DEVERIA ser pulado chega ao snapshot e ao apply — falsifica o
# assert de EVENTOS (R3c/R4c), que e o que prova a propriedade "dois runs sobrepostos nunca chegam
# ambos ao snapshot/apply". Sem esta, "o dado ficou certo" e "o perdedor foi barrado" seriam duas
# crencas separadas e so a primeira teria falsificacao.
SEED; CLEAR; LIMPA_EV
Pq -c "SELECT public.teste_run('F5-A','$CLI'::uuid,false,53,3,37,false);" >/dev/null
Pq -c "SELECT public.teste_run('F5-B','$CLI'::uuid,true,53,3,37,true);"  >/dev/null
case "$(EVENTOS F5-B)" in
  *snapshot*apply*) ok "F5 claim sabotado -> o run que devia ser PULADO chegou ao snapshot/apply (R3c tem dente)" ;;
  skipped)          bad "F5 R3c fraco -- o run seguiu 'skipped' mesmo com o claim sabotado" ;;
  *)                bad "F5 eventos inesperados: [$(EVENTOS F5-B)]" ;;
esac
P -q -f "$MIG_LEASE" >/dev/null   # restaura

# F2: finalize sem ownership → finalize alheio passa → L6 tem dente
P -q <<'SQL' >/dev/null
CREATE OR REPLACE FUNCTION public.finalizar_calculate_scores(p_run_id text, p_status text)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE v_done boolean := false; BEGIN
  UPDATE public.sync_state SET status=p_status, last_sync_at=now(), updated_at=now()
   WHERE entity_type='calculate_scores' AND account='global' AND status='syncing'
  RETURNING true INTO v_done;   -- OWNERSHIP (run_id) REMOVIDO
  RETURN COALESCE(v_done,false); END $$;
SQL
CLEAR; Pq -c "SELECT public.claim_calculate_scores('own-1');" >/dev/null
case "$(Pq -c "SELECT public.finalizar_calculate_scores('ALHEIO','complete');")" in
  t) ok "F2 sem ownership o finalize alheio PASSOU (L6 tem dente)" ;;
  *) bad "F2 L6 fraco" ;;
esac
P -q -f "$MIG_LEASE" >/dev/null

# F3: policy RESTRICTIVE de UPDATE dropada → employee adultera o lease → L11 tem dente
P -q -c "DROP POLICY calculate_scores_lease_no_update ON public.sync_state;" >/dev/null
CLEAR; Pq -c "SELECT public.claim_calculate_scores('f3');" >/dev/null
R=$(P -tA -v emp="$EMP" <<'SQL' 2>&1
SELECT set_config('test.uid', :'emp', false); SET ROLE authenticated;
DO $$ DECLARE n int; BEGIN
  UPDATE public.sync_state SET status='hacked' WHERE entity_type='calculate_scores';
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n>0 THEN RAISE NOTICE 'SABOTAGEM_FUROU_%', n; ELSE RAISE NOTICE 'AINDA_BLOQUEIA'; END IF;
END $$;
SQL
); case "$R" in *SABOTAGEM_FUROU*) ok "F3 sem a policy o employee adultera o lease (L11 tem dente)" ;; *) bad "F3 L11 fraco -- veio: $R" ;; esac
P -q -f "$MIG_LEASE" >/dev/null

# ════════════════════════════════════════════════════════════════════════════════════════════════
echo "------------------------------------------------------------"
TOTAL=$((PASS+FAIL))
TOTAL_ESPERADO=54
echo "RESULTADO: $PASS ok / $FAIL fail (total $TOTAL)"
# TELL anti-"vermelho invalido": total diferente do esperado = o harness nao rodou o que devia
# (sabotagem que nao aplicou, heredoc engolido, assert que nem executou) — exit 2, distinto do 1.
if [ "$TOTAL" != "$TOTAL_ESPERADO" ]; then
  echo "HARNESS INVALIDO: rodaram $TOTAL asserts, esperados $TOTAL_ESPERADO"
  exit 2
fi
[ "$FAIL" = "0" ] || { echo "HARNESS VERMELHO"; exit 1; }
echo "HARNESS VERDE ($PASS asserts)"
