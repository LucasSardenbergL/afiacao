#!/usr/bin/env bash
# ════════════════════════════════════════════════════════════════════════════════════════════════
# PROVA — churn_risk NULL para sem_historico
# Migration: supabase/migrations/20261121150000_churn_risk_nulo_sem_historico.sql
# Roda:  bash db/test-churn-risk-nulo-sem-historico.sh > /tmp/t.log 2>&1; echo "exit=$?"
#        (NUNCA `| tail` — o pipe engole o exit code)
#        bash db/test-churn-risk-nulo-sem-historico.sh --falsificar   → controle verde + cada sabotagem
#        vermelha NO assert dela (a sabotagem age numa CÓPIA da migration, nunca no arquivo commitado)
#
# Parte dos predecessores VERBATIM da prod (db/fixtures/churn-nulo-predecessores-prod-20261121.sql) e
# aplica a migration REAL numa transação única (-1, como o `db:aplicar`). PL/pgSQL é late-bound: tudo
# abaixo EXECUTA a RPC e o trigger.
#
#   P0  predecessores = corpos da prod (md5 do prosrc)
#   A1  NULL explícito em churn_risk GRAVA NULL (sobrescreve o 100; sem COALESCE)
#   A2  número em churn_risk grava o número (0 inclusive)
#   A3  priority_score NULL explícito segue aceito (o guard do precedente não regrediu)
#   A4  chave AUSENTE de avg_repurchase_interval segue preservando
#   L1  lote misto (válida + sem a chave churn_risk) → 23514 e ZERO linhas alteradas
#   L2  lote misto (válida + sem a chave priority_score) → 23514 e ZERO linhas (guard do precedente intacto)
#   L3  lote misto (válida + chave CORE nula) → 23514 e ZERO linhas
#   F1  fencing: run que não é dono → 55000 · F2 p_run_id '' → 22004 · F3 o dono grava
#   T1  sem_historico→sem_historico SEM pedido, churn 100→NULL isolado → NÃO enfileira
#   T2  sem_historico→sem_historico COM pedido (cabeçalho), churn 100→NULL → ENFILEIRA (o par do Codex)
#   T2b só pedido cancelado/apagado (fora do universo canônico) → NÃO enfileira
#   T3  primeira venda (sem_historico→ativo, churn NULL→45) → ENFILEIRA
#   T4  sem_historico→ativo com churn 100→NULL → ENFILEIRA (a exceção exige NEW sem_historico)
#   T5  ativo→ativo, churn→NULL → ENFILEIRA (a exceção é só de sem_historico)
#   T6  stale, churn 90→80 → ENFILEIRA
#   T7  sem_historico sem pedido, churn e priority →NULL juntos → NÃO enfileira; com expansion mudando → ENFILEIRA
#   K1  ACL: anon/authenticated sem EXECUTE nas duas; service_role e sandbox_exec com EXECUTE na RPC
#   I1  idempotente: re-aplicar passa (PRE aceita "este")
#   N1  PRE anti-deriva: corpo vivo desconhecido → aborta com 'PRE FALHOU' e NADA muda
# ════════════════════════════════════════════════════════════════════════════════════════════════
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MIG_REAL="$REPO_ROOT/supabase/migrations/20261121150000_churn_risk_nulo_sem_historico.sql"

if [ "${1:-}" = "--falsificar" ]; then
  # <sabotagem>:<assert que TEM de acusá-la>
  SABOTAGENS="guard_chave_ausente:L1 coalesce_volta:A1 null_rejeitado:A1 guard_prioridade_some:L2 trigger_sem_excecao:T1 trigger_ignora_pedido:T2 trigger_ignora_universo:T2b trigger_ignora_status_novo:T4 sem_fencing:F1 intervalo_sem_preservar:A4"
  LOGDIR="$(mktemp -d "/tmp/falsifica-churn-nulo.XXXXXX")"
  echo "== CONTROLE =="
  if ! SABOTAGEM="" bash "$0" > "$LOGDIR/controle.log" 2>&1; then
    echo "CONTROLE VERMELHO — falsificacao abortada (log: $LOGDIR/controle.log)"; tail -15 "$LOGDIR/controle.log"; exit 1
  fi
  grep -q '^TESTE_CHURN_NULO_OK$' "$LOGDIR/controle.log" || { echo "CONTROLE sem marcador de fim"; exit 1; }
  echo "controle verde"
  falhas=0; n_sab=0
  for par in $SABOTAGENS; do
    s="${par%%:*}"; a="${par#*:}"; n_sab=$((n_sab+1))
    if SABOTAGEM="$s" bash "$0" > "$LOGDIR/$s.log" 2>&1; then
      echo "XX $s: suite ficou VERDE"; falhas=$((falhas+1)); continue
    fi
    if ! grep -q "SABOTAGEM ATIVA: $s" "$LOGDIR/$s.log"; then
      echo "XX $s: sabotagem NAO aplicou"; falhas=$((falhas+1)); continue
    fi
    if ! grep -q "^  FAIL $a " "$LOGDIR/$s.log"; then
      echo "XX $s: vermelho, mas NAO no assert $a (log: $LOGDIR/$s.log)"; falhas=$((falhas+1)); continue
    fi
    echo "ok $s -> vermelho em $a"
  done
  echo "FALSIFICACAO: $((n_sab - falhas))/$n_sab sabotagens acusadas pelo assert certo"
  echo "SABOTAGENS: $((n_sab - falhas)) vermelhas / $falhas falhas"
  [ "$falhas" -eq 0 ] || exit 1
  echo "FALSIFICACAO_CHURN_NULO_OK"
  exit 0
fi

export PGVER=17
# shellcheck disable=SC1091  # caminho resolvido em runtime a partir de REPO_ROOT
. "$REPO_ROOT/db/lib/pg-harness.sh"
PORT="${PGPORT_TEST:-5496}"
SLUG="churn-nulo-$$"
TMPD="$(mktemp -d "/tmp/pgtest-${SLUG}.XXXXXX")"
DATA="$TMPD/data"
export LC_ALL="${LC_ALL:-C}" LANG="${LANG:-C}"

cleanup() { "$PGBIN/pg_ctl" -D "$DATA" stop -m immediate >/dev/null 2>&1 || true; rm -rf "$TMPD"; }
trap cleanup EXIT

# ── Cópia da migration (a sabotagem só mexe na cópia) ──
MIG="$TMPD/mig.sql"
cp "$MIG_REAL" "$MIG"
sab() { # $1 = padrão sed (BSD/GNU portátil via -i.bak)
  sed -i.bak "$1" "$MIG"; rm -f "$MIG.bak"
}
cegar_md5() { # a sabotagem muda o corpo → PRE/PÓS por md5 abortariam ANTES do assert sob teste
  sab "s/v.md5 IS DISTINCT FROM '3507b641249de3ce80f714e6b39c7381'/false/; s/v.md5 IS DISTINCT FROM 'fbed094342f63ec8313a349755c68a72'/false/"
  sab "s/v_apply IS DISTINCT FROM 'cfed7452509290eede629acc01619c62' AND/false AND/; s/v_trigger IS DISTINCT FROM 'f863be30b7a6a6c8d3ad4d6ab3d4cce2' AND/false AND/"
}
case "${SABOTAGEM:-}" in
  "") ;;
  guard_chave_ausente)    sab 's/IF v_sem_churn > 0 THEN/IF false THEN/' ;;
  coalesce_volta)         sab 's/churn_risk               = u.churn_risk,/churn_risk               = COALESCE(u.churn_risk, f.churn_risk),/' ;;
  null_rejeitado)         sab "s/WHERE NOT jsonb_exists(e.elem, 'churn_risk');/WHERE (e.elem->>'churn_risk') IS NULL;/" ;;
  guard_prioridade_some)  sab 's/IF v_sem_prioridade > 0 THEN/IF false THEN/' ;;
  trigger_sem_excecao)    sab 's/AND NOT (NEW.churn_risk IS NULL/AND NOT (false/' ;;
  trigger_ignora_pedido)  sab 's/                                AND so.deleted_at IS NULL$/                                AND false/' ;;
  trigger_ignora_universo) sab "s/                                AND so.status NOT IN ('cancelado', 'rascunho', 'pendente', 'orcamento')));/                                ));/" ;;
  trigger_ignora_status_novo) sab "s/AND NEW.sales_history_status IS NOT DISTINCT FROM 'sem_historico'\$/AND true/" ;;
  sem_fencing)            sab 's/  IF p_run_id IS NOT NULL THEN/  IF false THEN/' ;;
  intervalo_sem_preservar) sab 's/CASE WHEN u.tem_avg_repurchase_interval THEN u.avg_repurchase_interval ELSE f.avg_repurchase_interval END/u.avg_repurchase_interval/' ;;
  *) echo "SABOTAGEM desconhecida: $SABOTAGEM"; exit 2 ;;
esac
if [ -n "${SABOTAGEM:-}" ]; then
  cegar_md5
  if cmp -s "$MIG" "$MIG_REAL"; then echo "sabotagem $SABOTAGEM nao alterou a copia"; exit 2; fi
  echo "SABOTAGEM ATIVA: $SABOTAGEM"
fi

"$PGBIN/initdb" -D "$DATA" -U postgres -E UTF8 --locale=C >/dev/null
"$PGBIN/pg_ctl" -D "$DATA" -o "-p $PORT -k /tmp" -l "$TMPD/pg.log" -w start >/dev/null
"$PGBIN/createdb" -p "$PORT" -h /tmp -U postgres prove
P()  { "$PGBIN/psql" -X -p "$PORT" -h /tmp -U postgres -d prove -v ON_ERROR_STOP=1 "$@"; }
Pq() { P -tA "$@"; }
Ps() { P -q "$@" >/dev/null; }

PASS=0; FAIL=0
ok()  { PASS=$((PASS+1)); echo "  OK   $1"; }
bad() { FAIL=$((FAIL+1)); echo "  FAIL $1"; }
eq()  { if [ "$2" = "$3" ]; then ok "$1 (=$2)"; else bad "$1 — esperado [$3], veio [$2]"; fi; }

Ps -f "$REPO_ROOT/db/stubs-supabase.sql"

# ── Esquema mínimo, nas formas da PROD (pg_attribute/pg_index, psql-ro 2026-11-20) ──
Ps <<'SQL'
CREATE TABLE public.sync_state (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  entity_type text NOT NULL, account text NOT NULL DEFAULT 'vendas',
  status text DEFAULT 'idle', metadata jsonb DEFAULT '{}'::jsonb
);
CREATE TABLE public.farmer_client_scores (
  id uuid DEFAULT gen_random_uuid() NOT NULL PRIMARY KEY,
  customer_user_id uuid NOT NULL UNIQUE, farmer_id uuid NOT NULL,
  rf_score numeric DEFAULT 0, m_score numeric, g_score numeric DEFAULT 0,
  health_score numeric DEFAULT 0, health_class text DEFAULT 'critico', churn_risk numeric DEFAULT 0,
  priority_score numeric DEFAULT 0, days_since_last_purchase integer DEFAULT 0,
  avg_repurchase_interval numeric, avg_monthly_spend_180d numeric DEFAULT 0,
  gross_margin_pct numeric, category_count integer DEFAULT 0, sales_history_status text,
  itens_com_custo bigint, itens_sem_custo bigint, expansion_score numeric, signal_modifiers jsonb,
  calculated_at timestamptz DEFAULT now(), updated_at timestamptz DEFAULT now()
);
CREATE TABLE public.priority_score_log (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  customer_user_id uuid NOT NULL, farmer_id uuid NOT NULL,
  priority_score numeric DEFAULT 0,
  margin_potential_component numeric DEFAULT 0, churn_risk_component numeric DEFAULT 0,
  repurchase_component numeric DEFAULT 0, goal_proximity_component numeric DEFAULT 0,
  score_date date NOT NULL DEFAULT ((now() AT TIME ZONE 'America/Sao_Paulo'))::date,
  calculated_at timestamptz NOT NULL DEFAULT now(), created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE public.visit_score_recalc_queue (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  customer_user_id uuid NOT NULL, farmer_id uuid NOT NULL, reason text NOT NULL,
  source_event_id uuid, enqueued_at timestamptz NOT NULL DEFAULT now(), processed_at timestamptz, error text
);
CREATE TABLE public.sales_orders (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  customer_user_id uuid, status text, deleted_at timestamptz, created_at timestamptz DEFAULT now()
);
CREATE INDEX idx_sales_orders_customer_created ON public.sales_orders (customer_user_id, created_at DESC);
CREATE UNIQUE INDEX uniq_visit_score_queue_pending ON public.visit_score_recalc_queue (customer_user_id) WHERE processed_at IS NULL;
DO $$ BEGIN CREATE ROLE sandbox_exec_fzvklzpomgnyikkfkzai; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
SQL

Ps -f "$REPO_ROOT/db/fixtures/churn-nulo-predecessores-prod-20261121.sql"
Ps <<'SQL'
CREATE TRIGGER trg_farmer_client_scores_enqueue_visit_recalc AFTER UPDATE ON public.farmer_client_scores
  FOR EACH ROW EXECUTE FUNCTION public.enqueue_visit_score_recalc_from_client_score();
-- ACL da prod antes da migration (postgres, service_role, sandbox_exec).
REVOKE ALL ON FUNCTION public.apply_score_updates(jsonb,text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.apply_score_updates(jsonb,text) TO service_role, sandbox_exec_fzvklzpomgnyikkfkzai;
REVOKE ALL ON FUNCTION public.enqueue_visit_score_recalc_from_client_score() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.enqueue_visit_score_recalc_from_client_score() TO service_role, sandbox_exec_fzvklzpomgnyikkfkzai;
SQL

echo "=== P — predecessores ==="
eq "P0 apply_score_updates = corpo da prod" "$(Pq -c "SELECT md5(prosrc) FROM pg_proc WHERE oid='public.apply_score_updates(jsonb,text)'::regprocedure")" "cfed7452509290eede629acc01619c62"
eq "P0 trigger = corpo da prod" "$(Pq -c "SELECT md5(prosrc) FROM pg_proc WHERE oid='public.enqueue_visit_score_recalc_from_client_score()'::regprocedure")" "f863be30b7a6a6c8d3ad4d6ab3d4cce2"

# ── Fixtures: clientes nomeados ──
Ps <<'SQL'
CREATE TABLE public.cli(nome text PRIMARY KEY, uid uuid, status text, churn numeric, prio numeric);
INSERT INTO public.cli VALUES
  ('a','00000000-0000-0000-0000-00000000000a','sem_historico',100,NULL),
  ('b','00000000-0000-0000-0000-00000000000b','ativo',30,30),
  ('c','00000000-0000-0000-0000-00000000000c','stale',90,40),
  ('d','00000000-0000-0000-0000-00000000000d','sem_historico',100,NULL),
  ('e','00000000-0000-0000-0000-00000000000e','sem_historico',100,NULL),
  ('f','00000000-0000-0000-0000-00000000000f','ativo',50,50),
  ('g','00000000-0000-0000-0000-000000000001','sem_historico',100,67),
  ('h','00000000-0000-0000-0000-000000000002','sem_historico',100,NULL),
  ('i','00000000-0000-0000-0000-000000000003','sem_historico',100,NULL);
INSERT INTO public.farmer_client_scores(customer_user_id, farmer_id, priority_score, churn_risk, sales_history_status, avg_repurchase_interval)
SELECT uid, '00000000-0000-0000-0000-0000000000ff', prio, churn, status, 30 FROM public.cli;
-- e: sem_historico pela RECEITA dos itens, mas com um CABEÇALHO de pedido válido (o caso que a visita vê como comprador).
INSERT INTO public.sales_orders(customer_user_id, status) VALUES ('00000000-0000-0000-0000-00000000000e', 'faturado');
-- i: só pedido CANCELADO e um APAGADO — fora do universo canônico, então a visita o trata como "nunca comprou".
INSERT INTO public.sales_orders(customer_user_id, status, deleted_at) VALUES
  ('00000000-0000-0000-0000-000000000003', 'cancelado', NULL),
  ('00000000-0000-0000-0000-000000000003', 'faturado', now());
SQL

echo "=== aplica a migration (transação única, como o db:aplicar) ==="
if P -q -1 -f "$MIG" >"$TMPD/mig.log" 2>&1; then ok "migration aplicou (exit 0)"; else bad "migration FALHOU: $(tail -c 400 "$TMPD/mig.log")"; fi

# payload <cliente> <churn json | omit> <prio json | omit> [status] [extra json com vírgula inicial]
payload() {
  local cli="$1" churn="$2" prio="$3" status="${4:-}" extra="${5:-}"
  local ch=""; [ "$churn" != omit ] && ch=", \"churn_risk\": $churn"
  local pr=""; [ "$prio" != omit ] && pr=", \"priority_score\": $prio"
  local st=""; [ -n "$status" ] && st=", \"sales_history_status\": \"$status\""
  Pq -c "SELECT jsonb_build_array(jsonb_build_object('id', f.id, 'health_score', 0, 'health_class', 'critico',
    'rf_score', 0, 'g_score', 0, 'days_since_last_purchase', 999,
    'avg_monthly_spend_180d', 0, 'category_count', 0, 'calculated_at', now(), 'updated_at', now())
    || '{\"_\": 0 ${ch}${pr}${st}${extra}}'::jsonb - '_')
    FROM public.farmer_client_scores f JOIN public.cli c ON c.uid = f.customer_user_id WHERE c.nome = '$cli'"
}
col() { Pq -c "SELECT COALESCE(f.$2::text,'NULL') FROM public.farmer_client_scores f JOIN public.cli c ON c.uid = f.customer_user_id WHERE c.nome = '$1'"; }
churn() { col "$1" churn_risk; }
fila() { Pq -c "SELECT count(*) FROM public.visit_score_recalc_queue q JOIN public.cli c ON c.uid = q.customer_user_id WHERE c.nome = '$1'"; }
# Captura a SQLSTATE do apply sem engolir o resto: imprime o código, ou OK se não lançou.
sqlstate_de() { # $1 = payload jsonb, $2 = p_run_id SQL literal
  Pq -c "DO \$t\$ BEGIN PERFORM public.apply_score_updates('$1'::jsonb, $2); RAISE NOTICE 'ESTADO=OK'; EXCEPTION
    WHEN check_violation THEN RAISE NOTICE 'ESTADO=23514';
    WHEN object_not_in_prerequisite_state THEN RAISE NOTICE 'ESTADO=55000';
    WHEN null_value_not_allowed THEN RAISE NOTICE 'ESTADO=22004';
    WHEN OTHERS THEN RAISE; END \$t\$" 2>&1 | sed -n 's/.*ESTADO=\([A-Z0-9]*\).*/\1/p'
}
foto() { Pq -c "SELECT md5(string_agg(f::text, '|' ORDER BY f.id)) FROM public.farmer_client_scores f"; }
aplica() { Ps -c "SELECT public.apply_score_updates('$1'::jsonb, $2)"; }

echo "=== A — apply_score_updates ==="
# Via sqlstate_de (não Ps): se a RPC recusar o NULL, o vermelho tem de cair NESTE assert, não no
# ON_ERROR_STOP abortando o script inteiro (a falsificação `null_rejeitado` exige o assert certo).
eq "A1 churn NULL explícito é aceito" "$(sqlstate_de "$(payload a null null sem_historico)" NULL)" "OK"
eq "A1 churn NULL explícito grava NULL sobre o 100" "$(churn a)" "NULL"
aplica "$(payload b 0 31 ativo)" NULL
eq "A2 número grava o número (0 medido não vira NULL)" "$(churn b)" "0"
eq "A3 priority NULL explícito segue aceito" "$(sqlstate_de "$(payload g null null sem_historico)" NULL)" "OK"
eq "A3 priority NULL gravado sobre o 67" "$(col g priority_score)" "NULL"
aplica "$(payload c 90 40 stale)" NULL
eq "A4 chave ausente de avg_repurchase_interval preserva" "$(col c avg_repurchase_interval)" "30"

echo "=== L — lote misto ==="
VALIDA="$(payload f 49 49 ativo)"
ANTES="$(foto)"
eq "L1 válida + sem a chave churn_risk → 23514" "$(sqlstate_de "$(Pq -c "SELECT '$VALIDA'::jsonb || '$(payload d omit null sem_historico)'::jsonb")" NULL)" "23514"
eq "L1 ZERO linhas alteradas" "$(foto)" "$ANTES"
eq "L1 sentinela: a válida, sozinha, passaria" "$(sqlstate_de "$VALIDA" NULL)" "OK"
Ps -c "UPDATE public.farmer_client_scores f SET churn_risk = 50, priority_score = 50 FROM public.cli c WHERE c.uid=f.customer_user_id AND c.nome='f'"
ANTES="$(foto)"
eq "L2 válida + sem a chave priority_score → 23514" "$(sqlstate_de "$(Pq -c "SELECT '$VALIDA'::jsonb || '$(payload d null omit sem_historico)'::jsonb")" NULL)" "23514"
eq "L2 ZERO linhas alteradas" "$(foto)" "$ANTES"
CORE_NULA="$(payload d null null sem_historico | sed 's/"health_score": 0/"health_score": null/')"
eq "L3 válida + CORE nula → 23514" "$(sqlstate_de "$(Pq -c "SELECT '$VALIDA'::jsonb || '$CORE_NULA'::jsonb")" NULL)" "23514"
eq "L3 ZERO linhas alteradas" "$(foto)" "$ANTES"

echo "=== F — fencing ==="
Ps -c "INSERT INTO public.sync_state(entity_type, account, status, metadata) VALUES ('calculate_scores','global','syncing','{\"run_id\":\"dono\"}')"
ANTES="$(foto)"
eq "F1 run que não é dono → 55000" "$(sqlstate_de "$VALIDA" "'intruso'")" "55000"
eq "F1 nada gravado" "$(foto)" "$ANTES"
eq "F2 p_run_id vazio → 22004" "$(sqlstate_de "$VALIDA" "''")" "22004"
eq "F3 o dono grava" "$(sqlstate_de "$VALIDA" "'dono'")" "OK"

echo "=== T — trigger ==="
# Estado inicial de cada caso, gravado à mão (fora da RPC) e com a fila zerada DEPOIS.
Ps -c "UPDATE public.farmer_client_scores f SET churn_risk = c.churn, priority_score = c.prio, sales_history_status = c.status FROM public.cli c WHERE c.uid=f.customer_user_id"
Ps -c "UPDATE public.farmer_client_scores f SET priority_score = 67 FROM public.cli c WHERE c.uid=f.customer_user_id AND c.nome='h'"
Ps -c "DELETE FROM public.visit_score_recalc_queue"
# T1: d segue sem_historico, sem pedido, churn 100 → NULL, nada mais muda
aplica "$(payload d null null sem_historico)" "'dono'"
eq "T1 sentinela: o churn de d virou NULL" "$(churn d)" "NULL"
eq "T1 100→NULL isolado de sem_historico SEM pedido NÃO enfileira" "$(fila d)" "0"
# T2: e segue sem_historico, mas TEM cabeçalho de pedido → a visita o vê como comprador
aplica "$(payload e null null sem_historico)" "'dono'"
eq "T2 sentinela: o churn de e virou NULL" "$(churn e)" "NULL"
eq "T2 sem_historico COM pedido, 100→NULL → ENFILEIRA" "$(fila e)" "1"
# T2b: i só tem pedido cancelado/apagado → fora do universo canônico → mesmo veredito do sem-pedido
aplica "$(payload i null null sem_historico)" "'dono'"
eq "T2b sem_historico só com pedido cancelado/apagado, 100→NULL → NÃO enfileira" "$(fila i)" "0"
# T3: a (sem_historico, churn NULL desde A1) faz a primeira compra → ativo, 45
Ps -c "UPDATE public.farmer_client_scores f SET churn_risk = NULL FROM public.cli c WHERE c.uid=f.customer_user_id AND c.nome='a'"
Ps -c "DELETE FROM public.visit_score_recalc_queue"
aplica "$(payload a 45 45 ativo)" "'dono'"
eq "T3 primeira venda (sem_historico→ativo, churn NULL→45) → ENFILEIRA" "$(fila a)" "1"
# T4: g sem_historico → ativo com churn 100 → NULL (a exceção exige NEW também sem_historico)
Ps -c "UPDATE public.farmer_client_scores f SET churn_risk = 100, priority_score = NULL, sales_history_status='sem_historico' FROM public.cli c WHERE c.uid=f.customer_user_id AND c.nome='g'"
Ps -c "DELETE FROM public.visit_score_recalc_queue"
aplica "$(payload g null null ativo)" "'dono'"
eq "T4 sem_historico→ativo, churn 100→NULL → ENFILEIRA" "$(fila g)" "1"
# T5: b comprador ativo, churn → NULL (não deveria acontecer, mas se acontecer é mudança de insumo)
Ps -c "UPDATE public.farmer_client_scores f SET churn_risk = 30, priority_score = 30 FROM public.cli c WHERE c.uid=f.customer_user_id AND c.nome='b'"
Ps -c "DELETE FROM public.visit_score_recalc_queue"
aplica "$(payload b null 30 ativo)" "'dono'"
eq "T5 ativo→ativo, churn→NULL → ENFILEIRA" "$(fila b)" "1"
# T6: c stale, churn 90 → 80
Ps -c "UPDATE public.farmer_client_scores f SET churn_risk = 90, priority_score = 40 FROM public.cli c WHERE c.uid=f.customer_user_id AND c.nome='c'"
Ps -c "DELETE FROM public.visit_score_recalc_queue"
aplica "$(payload c 80 40 stale)" "'dono'"
eq "T6 stale, churn 90→80 → ENFILEIRA" "$(fila c)" "1"
# T7: h sem_historico sem pedido, churn 100→NULL e priority 67→NULL JUNTOS (as duas correções) → NÃO enfileira
Ps -c "DELETE FROM public.visit_score_recalc_queue"
aplica "$(payload h null null sem_historico)" "'dono'"
eq "T7 churn e priority →NULL juntos em sem_historico sem pedido NÃO enfileira" "$(fila h)" "0"
Ps -c "UPDATE public.farmer_client_scores f SET churn_risk = 100, expansion_score = 5 FROM public.cli c WHERE c.uid=f.customer_user_id AND c.nome='h'"
Ps -c "DELETE FROM public.visit_score_recalc_queue"
Ps -c "UPDATE public.farmer_client_scores f SET churn_risk = NULL, expansion_score = 6 FROM public.cli c WHERE c.uid=f.customer_user_id AND c.nome='h'"
eq "T7 churn→NULL + expansion mudou → ENFILEIRA" "$(fila h)" "1"

echo "=== K — ACL ==="
for r in anon authenticated; do
  eq "K1 $r sem EXECUTE na RPC" "$(Pq -c "SELECT has_function_privilege('$r','public.apply_score_updates(jsonb,text)','EXECUTE')")" "f"
  eq "K1 $r sem EXECUTE no trigger" "$(Pq -c "SELECT has_function_privilege('$r','public.enqueue_visit_score_recalc_from_client_score()','EXECUTE')")" "f"
done
eq "K1 service_role com EXECUTE na RPC" "$(Pq -c "SELECT has_function_privilege('service_role','public.apply_score_updates(jsonb,text)','EXECUTE')")" "t"
eq "K1 sandbox_exec preservado na RPC" "$(Pq -c "SELECT has_function_privilege('sandbox_exec_fzvklzpomgnyikkfkzai','public.apply_score_updates(jsonb,text)','EXECUTE')")" "t"
eq "K1 PUBLIC fora do ACL da RPC" "$(Pq -c "SELECT count(*) FROM pg_proc p, aclexplode(p.proacl) a WHERE p.oid='public.apply_score_updates(jsonb,text)'::regprocedure AND a.grantee=0")" "0"

echo "=== I — idempotência ==="
if P -q -1 -f "$MIG" >"$TMPD/mig2.log" 2>&1; then ok "I1 re-aplicar passa"; else bad "I1 re-aplicar FALHOU: $(tail -c 300 "$TMPD/mig2.log")"; fi

echo "=== N — PRE anti-deriva ==="
Ps -c "CREATE OR REPLACE FUNCTION public.apply_score_updates(p_updates jsonb, p_run_id text DEFAULT NULL) RETURNS integer LANGUAGE plpgsql SET search_path TO 'public' AS \$f\$ BEGIN RETURN -1; END \$f\$"
ANTES_N1="$(Pq -c "SELECT md5(prosrc) FROM pg_proc WHERE oid='public.enqueue_visit_score_recalc_from_client_score()'::regprocedure")"
if [ -z "${SABOTAGEM:-}" ]; then
  if P -q -1 -f "$MIG" >"$TMPD/mig3.log" 2>&1; then
    bad "N1 migration passou com corpo vivo desconhecido"
  else
    if grep -q 'PRE FALHOU: apply_score_updates' "$TMPD/mig3.log"; then ok "N1 abortou pela PRE (ramo certo)"; else bad "N1 abortou por OUTRO motivo: $(tail -c 300 "$TMPD/mig3.log")"; fi
  fi
  eq "N1 nada mudou (apply sabotado intocado)" "$(Pq -c "SELECT prosrc LIKE '%RETURN -1%' FROM pg_proc WHERE oid='public.apply_score_updates(jsonb,text)'::regprocedure")" "t"
  eq "N1 nada mudou (trigger intocado)" "$(Pq -c "SELECT md5(prosrc) FROM pg_proc WHERE oid='public.enqueue_visit_score_recalc_from_client_score()'::regprocedure")" "$ANTES_N1"
fi

echo
echo "RESULTADO: $PASS OK, $FAIL FAIL"
[ "$FAIL" -eq 0 ] || exit 1
[ "$PASS" -ge 42 ] || { echo "PASS abaixo do piso (42) — suite truncada"; exit 1; }
echo "TESTE_CHURN_NULO_OK"
