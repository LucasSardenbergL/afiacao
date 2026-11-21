#!/usr/bin/env bash
# ════════════════════════════════════════════════════════════════════════════════════════════════
# PROVA — days_since_last_purchase / avg_monthly_spend_180d NULL para quem não tem venda (sem o 999/R$0)
# Migration: supabase/migrations/20261121220000_base_vendas_nula_sem_historico.sql
# Roda:  bash db/test-base-vendas-nula-sem-historico.sh > /tmp/t.log 2>&1; echo "exit=$?"
#        (NUNCA `| tail` — o pipe engole o exit code)
#        bash db/test-base-vendas-nula-sem-historico.sh --falsificar   → controle verde + cada sabotagem
#        vermelha NO assert dela, na MESMA invocação (a sabotagem age numa CÓPIA da migration)
#
# Parte dos predecessores VERBATIM da prod (db/fixtures/base-vendas-predecessores-prod-20261121.sql) e
# aplica a migration REAL numa transação única (-1, como o `db:aplicar`). PL/pgSQL é late-bound: tudo
# abaixo EXECUTA a RPC e o trigger.
#
#   P0  predecessores = corpos da prod (md5 do prosrc)
#   O1  payload do v1.7 (999/0 numéricos) segue aceito — edge velha × RPC nova é seguro
#   A1  dias NULL explícito GRAVA NULL sobre o 999 (sem COALESCE) · A1b gasto NULL grava NULL sobre o 0
#   A2  ZERO medido (gasto 0) e 999 MEDIDO gravam o número — não viram NULL
#   A3  churn_risk/priority_score NULL explícitos seguem aceitos (guards dos precedentes intactos)
#   A4  chave ausente de avg_repurchase_interval segue preservando
#   L1  lote misto (válida + sem a chave days_since_last_purchase) → 23514 e ZERO linhas
#   L1b lote misto (válida + sem a chave avg_monthly_spend_180d) → 23514 e ZERO linhas
#   L2  lote misto (válida + sem a chave churn_risk) → 23514 (guard do #4060 intacto)
#   L3  lote misto (válida + category_count NULL, que segue CORE) → 23514
#   F1  fencing: run que não é dono → 55000 · F2 p_run_id '' → 22004 · F3 o dono grava
#   T1  sem_historico, 999→NULL e 0→NULL isolados → NÃO enfileira (o dreno é 500/noite)
#   T2  stale, dias 200→201 (só a base mudou) → NÃO enfileira (o trigger não observa a base, como antes)
#   T3  primeira venda (sem_historico→ativo, churn/priority NULL→número, base NULL→medida) → ENFILEIRA 1
#   T3b com a 1ª entrada PROCESSADA, repetir o mesmo payload → nenhuma entrada nova (nada mudou)
#   D1  insert esparso (só IDs, como reconcile_score_owner_from_carteira) nasce com dias/gasto NULL, não 0
#   K1  ACL: anon/authenticated/PUBLIC sem EXECUTE; service_role e sandbox_exec com EXECUTE
#   I1  idempotente: re-aplicar passa (PRE aceita "este")
#   N1  PRE anti-deriva: corpo vivo desconhecido → aborta com 'PRE FALHOU' e NADA muda
# ════════════════════════════════════════════════════════════════════════════════════════════════
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MIG_REAL="$REPO_ROOT/supabase/migrations/20261121220000_base_vendas_nula_sem_historico.sql"

if [ "${1:-}" = "--falsificar" ]; then
  # <sabotagem>:<assert que TEM de acusá-la>
  SABOTAGENS="guard_base_some:L1 guard_so_dias:L1b coalesce_dias:A1 coalesce_gasto:A1b dias_null_rejeitado:A1 guard_churn_some:L2 sem_fencing:F1 trigger_observa_base:T1 intervalo_sem_preservar:A4 gasto_nao_gravado:A2 default_fica:D1"
  LOGDIR="$(mktemp -d "/tmp/falsifica-base-vendas-nula.XXXXXX")"
  echo "== CONTROLE =="
  if ! SABOTAGEM="" bash "$0" > "$LOGDIR/controle.log" 2>&1; then
    echo "CONTROLE VERMELHO — falsificacao abortada (log: $LOGDIR/controle.log)"; tail -15 "$LOGDIR/controle.log"; exit 1
  fi
  grep -q '^TESTE_BASE_VENDAS_NULA_OK$' "$LOGDIR/controle.log" || { echo "CONTROLE sem marcador de fim"; exit 1; }
  echo "controle verde ($(grep -c '^  OK ' "$LOGDIR/controle.log") OK)"
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
  echo "FALSIFICACAO_BASE_VENDAS_NULA_OK"
  exit 0
fi

export PGVER=17
# shellcheck disable=SC1091  # caminho resolvido em runtime a partir de REPO_ROOT
. "$REPO_ROOT/db/lib/pg-harness.sh"
PORT="${PGPORT_TEST:-5497}"
SLUG="base-vendas-nula-$$"
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
  sab "s/v.md5 IS DISTINCT FROM '743cdb8c4ef2b488c28a78a6c56353c0'/false/"
  sab "s/IS DISTINCT FROM 'fbed094342f63ec8313a349755c68a72' THEN/IS DISTINCT FROM NULL AND false THEN/"
}
case "${SABOTAGEM:-}" in
  "") ;;
  guard_base_some)      sab 's/IF v_sem_base > 0 THEN/IF false THEN/' ;;
  guard_so_dias)        sab "s/     OR NOT jsonb_exists(e.elem, 'avg_monthly_spend_180d');/     ;/" ;;
  coalesce_dias)        sab 's/    days_since_last_purchase = u.days_since_last_purchase,/    days_since_last_purchase = COALESCE(u.days_since_last_purchase, f.days_since_last_purchase),/' ;;
  coalesce_gasto)       sab 's/    avg_monthly_spend_180d   = u.avg_monthly_spend_180d,/    avg_monthly_spend_180d   = COALESCE(u.avg_monthly_spend_180d, f.avg_monthly_spend_180d),/' ;;
  dias_null_rejeitado)  sab "s/  WHERE NOT jsonb_exists(e.elem, 'days_since_last_purchase')/  WHERE (e.elem->>'days_since_last_purchase') IS NULL/" ;;
  guard_churn_some)     sab 's/IF v_sem_churn > 0 THEN/IF false THEN/' ;;
  sem_fencing)          sab 's/  IF p_run_id IS NOT NULL THEN/  IF false THEN/' ;;
  gasto_nao_gravado)    sab 's/    avg_monthly_spend_180d   = u.avg_monthly_spend_180d,/    avg_monthly_spend_180d   = f.avg_monthly_spend_180d,/' ;;
  default_fica)         sab 's/  ALTER COLUMN days_since_last_purchase DROP DEFAULT,/  ALTER COLUMN days_since_last_purchase SET DEFAULT 0,/; s/  ALTER COLUMN avg_monthly_spend_180d   DROP DEFAULT;/  ALTER COLUMN avg_monthly_spend_180d   SET DEFAULT 0;/; s/AND column_default IS NOT NULL) THEN/AND false) THEN/' ;;
  intervalo_sem_preservar) sab 's/CASE WHEN u.tem_avg_repurchase_interval THEN u.avg_repurchase_interval ELSE f.avg_repurchase_interval END/u.avg_repurchase_interval/' ;;
  trigger_observa_base)
    # O mundo em que a fila OBSERVA a base: a transição 999→NULL enfileiraria os 15.766. T1 tem de acusar.
    cat >> "$MIG" <<'SQL'
CREATE OR REPLACE FUNCTION public.enqueue_visit_score_recalc_from_client_score() RETURNS trigger
 LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $f$
BEGIN
  IF NEW.days_since_last_purchase IS DISTINCT FROM OLD.days_since_last_purchase AND NEW.farmer_id IS NOT NULL THEN
    INSERT INTO public.visit_score_recalc_queue (customer_user_id, farmer_id, reason)
    VALUES (NEW.customer_user_id, NEW.farmer_id, 'score_changed')
    ON CONFLICT (customer_user_id) WHERE processed_at IS NULL DO NOTHING;
  END IF;
  RETURN NEW;
END $f$;
SQL
    ;;
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

# ── Esquema mínimo, nas formas da PROD (information_schema/pg_index, psql-ro 2026-11-21) ──
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

Ps -f "$REPO_ROOT/db/fixtures/base-vendas-predecessores-prod-20261121.sql"
Ps <<'SQL'
CREATE TRIGGER trg_farmer_client_scores_enqueue_visit_recalc AFTER UPDATE ON public.farmer_client_scores
  FOR EACH ROW EXECUTE FUNCTION public.enqueue_visit_score_recalc_from_client_score();
-- ACL da prod antes da migration (postgres, service_role, sandbox_exec).
REVOKE ALL ON FUNCTION public.apply_score_updates(jsonb,text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.apply_score_updates(jsonb,text) TO service_role, sandbox_exec_fzvklzpomgnyikkfkzai;
REVOKE ALL ON FUNCTION public.enqueue_visit_score_recalc_from_client_score() FROM PUBLIC, anon, authenticated;
SQL

echo "=== P — predecessores ==="
eq "P0 apply_score_updates = corpo da prod" "$(Pq -c "SELECT md5(prosrc) FROM pg_proc WHERE oid='public.apply_score_updates(jsonb,text)'::regprocedure")" "3507b641249de3ce80f714e6b39c7381"
eq "P0 trigger = corpo da prod" "$(Pq -c "SELECT md5(prosrc) FROM pg_proc WHERE oid='public.enqueue_visit_score_recalc_from_client_score()'::regprocedure")" "fbed094342f63ec8313a349755c68a72"

# ── Fixtures: clientes nomeados, no estado de prod (sem_historico com o sentinela 999/0) ──
Ps <<'SQL'
CREATE TABLE public.cli(nome text PRIMARY KEY, uid uuid, status text, dias int, gasto numeric, churn numeric, prio numeric);
INSERT INTO public.cli VALUES
  ('a','00000000-0000-0000-0000-00000000000a','sem_historico',999,0,NULL,NULL),
  ('b','00000000-0000-0000-0000-00000000000b','ativo',12,350,30,30),
  ('c','00000000-0000-0000-0000-00000000000c','stale',200,75,90,40),
  ('d','00000000-0000-0000-0000-00000000000d','sem_historico',999,0,NULL,NULL),
  ('e','00000000-0000-0000-0000-00000000000e','stale',998,0,98,45),
  ('f','00000000-0000-0000-0000-00000000000f','ativo',40,800,50,50),
  ('g','00000000-0000-0000-0000-000000000001','sem_historico',999,0,NULL,NULL);
INSERT INTO public.farmer_client_scores(customer_user_id, farmer_id, priority_score, churn_risk, sales_history_status,
  avg_repurchase_interval, days_since_last_purchase, avg_monthly_spend_180d, category_count)
SELECT uid, '00000000-0000-0000-0000-0000000000ff', prio, churn, status, 30, dias, gasto, 0 FROM public.cli;
SQL

echo "=== aplica a migration (transação única, como o db:aplicar) ==="
if P -q -1 -f "$MIG" >"$TMPD/mig.log" 2>&1; then ok "migration aplicou (exit 0)"; else bad "migration FALHOU: $(tail -c 400 "$TMPD/mig.log")"; fi

# payload <cliente> <dias json|omit> <gasto json|omit> <churn json|omit> <prio json|omit> [status] [extra]
payload() {
  local cli="$1" dias="$2" gasto="$3" churn="$4" prio="$5" status="${6:-}" extra="${7:-}"
  local di=""; [ "$dias" != omit ] && di=", \"days_since_last_purchase\": $dias"
  local ga=""; [ "$gasto" != omit ] && ga=", \"avg_monthly_spend_180d\": $gasto"
  local ch=""; [ "$churn" != omit ] && ch=", \"churn_risk\": $churn"
  local pr=""; [ "$prio" != omit ] && pr=", \"priority_score\": $prio"
  local st=""; [ -n "$status" ] && st=", \"sales_history_status\": \"$status\""
  Pq -c "SELECT jsonb_build_array(jsonb_build_object('id', f.id, 'health_score', 0, 'health_class', 'critico',
    'rf_score', 0, 'g_score', 0, 'category_count', 0, 'calculated_at', now(), 'updated_at', now())
    || '{\"_\": 0 ${di}${ga}${ch}${pr}${st}${extra}}'::jsonb - '_')
    FROM public.farmer_client_scores f JOIN public.cli c ON c.uid = f.customer_user_id WHERE c.nome = '$cli'"
}
col() { Pq -c "SELECT COALESCE(f.$2::text,'NULL') FROM public.farmer_client_scores f JOIN public.cli c ON c.uid = f.customer_user_id WHERE c.nome = '$1'"; }
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

echo "=== O — compatibilidade com a edge v1.7 ==="
eq "O1 payload do v1.7 (999/0 numéricos) segue aceito" "$(sqlstate_de "$(payload g 999 0 null null sem_historico)" NULL)" "OK"
eq "O1 o 999 do v1.7 é gravado como veio" "$(col g days_since_last_purchase)" "999"

echo "=== A — apply_score_updates ==="
# Via sqlstate_de (não Ps): se a RPC recusar o NULL, o vermelho tem de cair NESTE assert, não no
# ON_ERROR_STOP abortando o script inteiro (a falsificação `dias_null_rejeitado` exige o assert certo).
eq "A1 dias/gasto NULL explícitos são aceitos" "$(sqlstate_de "$(payload a null null null null sem_historico)" NULL)" "OK"
eq "A1 dias NULL grava NULL sobre o 999" "$(col a days_since_last_purchase)" "NULL"
eq "A1b gasto NULL grava NULL sobre o 0" "$(col a avg_monthly_spend_180d)" "NULL"
aplica "$(payload c 201 0 90 40 stale)" NULL
eq "A2 gasto 0 MEDIDO grava 0 (não vira NULL)" "$(col c avg_monthly_spend_180d)" "0"
aplica "$(payload e 999 0 98 45 stale)" NULL
eq "A2 999 MEDIDO grava 999" "$(col e days_since_last_purchase)" "999"
eq "A3 churn/priority NULL seguem aceitos" "$(sqlstate_de "$(payload d null null null null sem_historico)" NULL)" "OK"
eq "A3 priority NULL gravado" "$(col d priority_score)" "NULL"
eq "A4 chave ausente de avg_repurchase_interval preserva" "$(col c avg_repurchase_interval)" "30"

echo "=== L — lote misto ==="
VALIDA="$(payload f 41 800 49 49 ativo)"
ANTES="$(foto)"
eq "L1 válida + sem a chave days_since_last_purchase → 23514" "$(sqlstate_de "$(Pq -c "SELECT '$VALIDA'::jsonb || '$(payload g omit null null null sem_historico)'::jsonb")" NULL)" "23514"
eq "L1 ZERO linhas alteradas" "$(foto)" "$ANTES"
eq "L1 sentinela: a válida, sozinha, passaria" "$(sqlstate_de "$VALIDA" NULL)" "OK"
Ps -c "UPDATE public.farmer_client_scores f SET days_since_last_purchase = 40 FROM public.cli c WHERE c.uid=f.customer_user_id AND c.nome='f'"
ANTES="$(foto)"
eq "L1b válida + sem a chave avg_monthly_spend_180d → 23514" "$(sqlstate_de "$(Pq -c "SELECT '$VALIDA'::jsonb || '$(payload g null omit null null sem_historico)'::jsonb")" NULL)" "23514"
eq "L1b ZERO linhas alteradas" "$(foto)" "$ANTES"
eq "L2 válida + sem a chave churn_risk → 23514" "$(sqlstate_de "$(Pq -c "SELECT '$VALIDA'::jsonb || '$(payload g null null omit null sem_historico)'::jsonb")" NULL)" "23514"
eq "L2 ZERO linhas alteradas" "$(foto)" "$ANTES"
CORE_NULA="$(payload g null null null null sem_historico | sed 's/"category_count": 0/"category_count": null/')"
eq "L3 válida + category_count NULL (segue CORE) → 23514" "$(sqlstate_de "$(Pq -c "SELECT '$VALIDA'::jsonb || '$CORE_NULA'::jsonb")" NULL)" "23514"
eq "L3 ZERO linhas alteradas" "$(foto)" "$ANTES"

echo "=== F — fencing ==="
Ps -c "INSERT INTO public.sync_state(entity_type, account, status, metadata) VALUES ('calculate_scores','global','syncing','{\"run_id\":\"dono\"}')"
ANTES="$(foto)"
eq "F1 run que não é dono → 55000" "$(sqlstate_de "$VALIDA" "'intruso'")" "55000"
eq "F1 nada gravado" "$(foto)" "$ANTES"
eq "F2 p_run_id vazio → 22004" "$(sqlstate_de "$VALIDA" "''")" "22004"
eq "F3 o dono grava" "$(sqlstate_de "$VALIDA" "'dono'")" "OK"

echo "=== T — trigger de fila ==="
# Estado de prod (sentinela 999/0, churn/priority já NULL) gravado à mão; fila zerada DEPOIS.
Ps -c "UPDATE public.farmer_client_scores f SET days_since_last_purchase = c.dias, avg_monthly_spend_180d = c.gasto, churn_risk = c.churn, priority_score = c.prio, sales_history_status = c.status FROM public.cli c WHERE c.uid=f.customer_user_id"
Ps -c "DELETE FROM public.visit_score_recalc_queue"
aplica "$(payload d null null null null sem_historico)" "'dono'"
eq "T1 sentinela: os dias de d viraram NULL" "$(col d days_since_last_purchase)" "NULL"
eq "T1 999→NULL e 0→NULL isolados de sem_historico NÃO enfileiram" "$(fila d)" "0"
aplica "$(payload c 201 0 90 40 stale)" "'dono'"
eq "T2 sentinela: os dias de c viraram 201" "$(col c days_since_last_purchase)" "201"
eq "T2 stale, só a base mudou (200→201) → NÃO enfileira" "$(fila c)" "0"
aplica "$(payload a 0 420 45 45 ativo)" "'dono'"
eq "T3 primeira venda (base NULL→medida, churn/priority NULL→45) → ENFILEIRA 1" "$(fila a)" "1"
# T3b: a 1ª entrada é PROCESSADA antes de repetir — assim o índice parcial + ON CONFLICT não escondem uma
# 2ª tentativa indevida (achado Codex): repetir o mesmo payload não pode criar entrada PENDENTE nova.
Ps -c "UPDATE public.visit_score_recalc_queue SET processed_at = now()"
aplica "$(payload a 0 420 45 45 ativo)" "'dono'"
eq "T3b repetir o mesmo payload (1ª entrada processada) → nenhuma pendente nova" "$(Pq -c "SELECT count(*) FROM public.visit_score_recalc_queue WHERE processed_at IS NULL")" "0"
eq "T total: só a primeira venda entrou na fila" "$(Pq -c "SELECT count(*) FROM public.visit_score_recalc_queue")" "1"

echo "=== D — defaults ==="
# Insert esparso, como reconcile_score_owner_from_carteira (só customer_user_id/farmer_id).
Ps -c "INSERT INTO public.cli VALUES ('n','00000000-0000-0000-0000-000000000009','novo',NULL,NULL,NULL,NULL)"
Ps -c "INSERT INTO public.farmer_client_scores(customer_user_id, farmer_id) VALUES ('00000000-0000-0000-0000-000000000009','00000000-0000-0000-0000-0000000000ff')"
eq "D1 insert esparso: dias nasce NULL (não 0 = 'comprou hoje')" "$(col n days_since_last_purchase)" "NULL"
eq "D1 insert esparso: gasto nasce NULL (não R\$ 0)" "$(col n avg_monthly_spend_180d)" "NULL"

echo "=== K — ACL ==="
for r in anon authenticated; do
  eq "K1 $r sem EXECUTE na RPC" "$(Pq -c "SELECT has_function_privilege('$r','public.apply_score_updates(jsonb,text)','EXECUTE')")" "f"
done
eq "K1 service_role com EXECUTE na RPC" "$(Pq -c "SELECT has_function_privilege('service_role','public.apply_score_updates(jsonb,text)','EXECUTE')")" "t"
eq "K1 sandbox_exec preservado na RPC" "$(Pq -c "SELECT has_function_privilege('sandbox_exec_fzvklzpomgnyikkfkzai','public.apply_score_updates(jsonb,text)','EXECUTE')")" "t"
eq "K1 PUBLIC fora do ACL da RPC" "$(Pq -c "SELECT count(*) FROM pg_proc p, aclexplode(p.proacl) a WHERE p.oid='public.apply_score_updates(jsonb,text)'::regprocedure AND a.grantee=0")" "0"
eq "K1 corpo final = o da migration" "$(Pq -c "SELECT md5(prosrc) FROM pg_proc WHERE oid='public.apply_score_updates(jsonb,text)'::regprocedure")" "$(if [ -z "${SABOTAGEM:-}" ]; then echo 743cdb8c4ef2b488c28a78a6c56353c0; else Pq -c "SELECT md5(prosrc) FROM pg_proc WHERE oid='public.apply_score_updates(jsonb,text)'::regprocedure"; fi)"

echo "=== I — idempotência ==="
if P -q -1 -f "$MIG" >"$TMPD/mig2.log" 2>&1; then ok "I1 re-aplicar passa"; else bad "I1 re-aplicar FALHOU: $(tail -c 300 "$TMPD/mig2.log")"; fi

echo "=== N — PRE anti-deriva ==="
Ps -c "CREATE OR REPLACE FUNCTION public.apply_score_updates(p_updates jsonb, p_run_id text DEFAULT NULL) RETURNS integer LANGUAGE plpgsql SET search_path TO 'public' AS \$f\$ BEGIN RETURN -1; END \$f\$"
if [ -z "${SABOTAGEM:-}" ]; then
  if P -q -1 -f "$MIG" >"$TMPD/mig3.log" 2>&1; then
    bad "N1 migration passou com corpo vivo desconhecido"
  else
    if grep -q 'PRE FALHOU: apply_score_updates' "$TMPD/mig3.log"; then ok "N1 abortou pela PRE (ramo certo)"; else bad "N1 abortou por OUTRO motivo: $(tail -c 300 "$TMPD/mig3.log")"; fi
  fi
  eq "N1 nada mudou (apply sabotado intocado)" "$(Pq -c "SELECT prosrc LIKE '%RETURN -1%' FROM pg_proc WHERE oid='public.apply_score_updates(jsonb,text)'::regprocedure")" "t"
fi

echo
echo "PASS=$PASS  FAIL=$FAIL"
[ "$FAIL" -eq 0 ] || exit 1
[ "$PASS" -ge 44 ] || { echo "PASS abaixo do piso (44) — suite truncada"; exit 1; }
echo "TESTE_BASE_VENDAS_NULA_OK"
