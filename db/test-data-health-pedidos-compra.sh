#!/usr/bin/env bash
# ╔══════════════════════════════════════════════════════════════════════════════╗
# ║  HARNESS PG17 — Sentinela VIGIA do sync de PEDIDOS DE COMPRA (2026-06-26)      ║
# ║  Prova o check `pedidos_compra_sync` do _data_health_compute() em todos os     ║
# ║  estados do heartbeat sync_state + o push (watchdog/heartbeat) + falsificação. ║
# ║  Migration: 20260626150000_data_health_check_pedidos_compra_sync.sql           ║
# ║  Rode: bash db/test-data-health-pedidos-compra.sh > /tmp/t.log 2>&1; echo $?   ║
# ║        (NÃO pipe pra tail — engole o exit≠0, §2 CLAUDE.md)                      ║
# ╚══════════════════════════════════════════════════════════════════════════════╝
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PGVER=17
PGBIN="/opt/homebrew/opt/postgresql@${PGVER}/bin"
PORT="${PGPORT_TEST:-5471}"
SLUG="pedidos-compra"
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

P -q -f "$REPO_ROOT/db/stubs-supabase.sql"

PASS=0; FAIL=0
ok()  { PASS=$((PASS+1)); echo "  ✅ $1"; }
bad() { FAIL=$((FAIL+1)); echo "  ❌ $1"; }
eq()  { if [ "$2" = "$3" ]; then ok "$1 (=$2)"; else bad "$1 — esperado [$3], veio [$2]"; fi; }

echo "═══ setup PG17 :$PORT ═══"

# ══════════════════════════════════════════════════════════════════════════════
# ZONA 1 — STUBS: as 14 tabelas que as 3 funções LEEM (colunas usadas). Vazias ⇒ os
#   outros 22 checks dão broken/unknown SEM erro; só sync_state(pedidos_compra) eu semeio.
#   ⚠️ sync_state ganha updated_at/error_message/total_synced (o check novo os usa — o stub
#   do teste de custos só tinha as 4 colunas do estoque). fin_alertas precisa do índice único
#   PARCIAL (o watchdog faz ON CONFLICT (company,tipo) WHERE dismissed_at IS NULL).
# ══════════════════════════════════════════════════════════════════════════════
P -q <<'SQL'
CREATE TABLE public.fin_contas_correntes (saldo_data timestamptz, ativo boolean);
CREATE TABLE public.fin_contas_receber  (updated_at timestamptz);
CREATE TABLE public.fin_contas_pagar    (updated_at timestamptz);
CREATE TABLE public.fin_sync_log (status text, completed_at timestamptz, action text, companies text[], started_at timestamptz, error_message text);
CREATE TABLE public.inventory_position (synced_at timestamptz);
CREATE TABLE public.pedido_compra_sugerido (data_ciclo date, status text, aprovado_em timestamptz, status_envio_portal text, portal_proximo_retry_em timestamptz, portal_tentativas int, atualizado_em timestamptz);
CREATE TABLE public.farmer_client_scores (calculated_at timestamptz);
CREATE TABLE public.product_costs (product_id uuid, cost_source text, cost_confidence numeric, cost_final numeric, updated_at timestamptz);
CREATE TABLE public.omie_clientes (updated_at timestamptz);
CREATE TABLE public.omie_products (id uuid, updated_at timestamptz, tipo_produto text, metadata jsonb, account text, familia text, ativo boolean, created_at timestamptz, is_tintometric boolean, tint_type text, omie_codigo_produto text);
CREATE TABLE public.sku_parametros (empresa text, fornecedor_nome text, ativo boolean, habilitado_reposicao_automatica boolean, tipo_reposicao text, sku_codigo_omie text);
CREATE TABLE public.sync_state (entity_type text, account text, status text, last_sync_at timestamptz, updated_at timestamptz, error_message text, total_synced int);
CREATE TABLE public.tint_skus (id uuid, account text, ativo boolean, omie_product_id uuid);
CREATE TABLE public.fornecedor_alerta (id uuid DEFAULT gen_random_uuid(), empresa text, tipo text, severidade text, titulo text, mensagem text, status text, criado_em timestamptz DEFAULT now(), erro_notificacao text);
CREATE TABLE public.fin_alertas (id uuid DEFAULT gen_random_uuid(), company text, tipo text, severidade text, mensagem text, contexto jsonb, dismissed_at timestamptz, criado_em timestamptz DEFAULT now());
CREATE UNIQUE INDEX fin_alertas_company_tipo_uniq ON public.fin_alertas (company, tipo) WHERE dismissed_at IS NULL;
CREATE FUNCTION public._vendas_familia_ausente_lista_email(int) RETURNS text LANGUAGE sql STABLE AS $f$ SELECT NULL::text $f$;
SQL

# ══════════════════════════════════════════════════════════════════════════════
# ZONA 2 — APLICAR A MIGRATION REAL (Lei #1) — recria as 3 funções (corpo de prod + novo check)
# ══════════════════════════════════════════════════════════════════════════════
MIG="$REPO_ROOT/supabase/migrations/20260626150000_data_health_check_pedidos_compra_sync.sql"
P -q -f "$MIG"
echo "migration aplicada: $(basename "$MIG")"

# helpers
chk()    { Pq -c "SELECT status   FROM public._data_health_compute() WHERE source='pedidos_compra_sync';"; }
chksev() { Pq -c "SELECT severity FROM public._data_health_compute() WHERE source='pedidos_compra_sync';"; }
# _set_pc(status, last_sync_age, updated_age): status NULL ⇒ marcador AUSENTE; last_age NULL ⇒ last_sync_at NULL
P -q <<'SQL'
CREATE OR REPLACE FUNCTION _set_pc(p_status text, p_last_age interval, p_upd_age interval)
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  DELETE FROM public.sync_state WHERE entity_type='pedidos_compra' AND account='oben';
  IF p_status IS NOT NULL THEN
    INSERT INTO public.sync_state (entity_type, account, status, last_sync_at, updated_at, error_message, total_synced)
    VALUES ('pedidos_compra','oben', p_status,
            CASE WHEN p_last_age IS NULL THEN NULL ELSE now()-p_last_age END,
            now()-p_upd_age, '3 erro(s) na coleta, 0 sincronizado(s)', 5);
  END IF;
END $$;
SQL
# sabotagem: replace literal robusto a metacaracteres via python
sabota() {  # $1=OLD  $2=NEW  $3=count esperado
  local SAB; SAB=$(mktemp /tmp/sab-pc.XXXXXX.sql)
  SAB="$SAB" MIG="$MIG" SAB_OLD="$1" SAB_NEW="$2" SAB_CNT="$3" python3 - <<'PYEOF'
import os
s = open(os.environ['MIG']).read()
old, new, cnt = os.environ['SAB_OLD'], os.environ['SAB_NEW'], int(os.environ['SAB_CNT'])
assert s.count(old) == cnt, f"sabota: esperei {cnt} de [{old}], achei {s.count(old)}"
open(os.environ['SAB'], 'w').write(s.replace(old, new))
PYEOF
  P -q -f "$SAB"; rm -f "$SAB"
}

echo "── asserts (estados do heartbeat) ──"

# E0 — a função EXECUTA (pega bug late-bound) e tem 23 checks (22→23), source presente 1×
eq "E0a compute executa e tem 23 checks (22→23)" "$(Pq -c "SELECT count(*) FROM public._data_health_compute();")" "23"
eq "E0b pedidos_compra_sync existe 1×"            "$(Pq -c "SELECT count(*) FROM public._data_health_compute() WHERE source='pedidos_compra_sync';")" "1"
eq "E0c domain=estoque"                           "$(Pq -c "SELECT domain FROM public._data_health_compute() WHERE source='pedidos_compra_sync';")" "estoque"

# E1 — marcador AUSENTE → broken (nunca rodou; VALUES+LEFT JOIN garante a linha, não some)
P -q -c "SELECT _set_pc(NULL, NULL, NULL);";              eq "E1 ausente → broken"            "$(chk)" "broken"
# E2 — complete fresco → ok
P -q -c "SELECT _set_pc('complete', interval '10 min', interval '10 min');"; eq "E2 complete fresco → ok" "$(chk)" "ok"
# E3 — complete há 7h (>6h) → stale (atraso; cron roda a cada 2h)
P -q -c "SELECT _set_pc('complete', interval '7 hours', interval '10 min');"; eq "E3 complete 7h → stale" "$(chk)" "stale"
# E4 — complete há 25h (>24h) → broken (cron/orquestrador morto)
P -q -c "SELECT _set_pc('complete', interval '25 hours', interval '10 min');"; eq "E4 complete 25h → broken" "$(chk)" "broken"
# E5 — error (precedência sobre idade, mesmo com last_sync_at fresco) → broken
P -q -c "SELECT _set_pc('error', interval '10 min', interval '10 min');"; eq "E5 error (last fresco) → broken" "$(chk)" "broken"
# E5b — error sem sucesso prévio (last_sync_at NULL) → broken
P -q -c "SELECT _set_pc('error', NULL, interval '10 min');"; eq "E5b error sem last_sync → broken" "$(chk)" "broken"
# E6 — partial (coleta truncada) → stale (o achado-chave do Codex: NÃO pode virar complete/ok)
P -q -c "SELECT _set_pc('partial', interval '10 min', interval '10 min');"; eq "E6 partial → stale" "$(chk)" "stale"
# E7 — running fresco (updated_at <1h) → ok (sync em andamento)
P -q -c "SELECT _set_pc('running', interval '10 min', interval '10 min');"; eq "E7 running <1h → ok" "$(chk)" "ok"
# E8 — running órfão (updated_at >1h = morreu no meio) → broken
P -q -c "SELECT _set_pc('running', interval '10 min', interval '2 hours');"; eq "E8 running órfão 2h → broken" "$(chk)" "broken"
# E9 — status DESCONHECIDO (fail-safe Codex #21: só complete/running-fresco são saudáveis) → broken
P -q -c "SELECT _set_pc('zzz_desconhecido', interval '10 min', interval '10 min');"; eq "E9 status desconhecido → broken" "$(chk)" "broken"

# E10 — severity FIXO critical (em stale E em broken) — evita o furo do ON CONFLICT do watchdog
P -q -c "SELECT _set_pc('partial', interval '10 min', interval '10 min');"; eq "E10a severity critical (stale)" "$(chksev)" "critical"
P -q -c "SELECT _set_pc('error', interval '10 min', interval '10 min');";   eq "E10b severity critical (broken)" "$(chksev)" "critical"

# E11 — age_seconds = idade do ÚLTIMO SUCESSO; em 'error' last_sync_at NÃO foi tocado pela edge,
#       então se houve sucesso antigo, o age reflete ele (não o erro). Aqui: error + last 3h → age≈3h.
P -q -c "SELECT _set_pc('error', interval '3 hours', interval '10 min');"
eq "E11 age_seconds reflete último sucesso (~3h=10800s, faixa)" "$(Pq -c "SELECT (age_seconds BETWEEN 10000 AND 12000) FROM public._data_health_compute() WHERE source='pedidos_compra_sync';")" "t"

# E12 — push intacto: watchdog E heartbeat referenciam o source nos IN-lists
eq "E12a watchdog referencia pedidos_compra_sync" "$(Pq -c "SELECT count(*) FROM pg_proc WHERE proname='data_health_watchdog' AND pg_get_functiondef(oid) LIKE '%pedidos_compra_sync%';")" "1"
eq "E12b heartbeat referencia pedidos_compra_sync" "$(Pq -c "SELECT count(*) FROM pg_proc WHERE proname='fin_sync_heartbeat' AND pg_get_functiondef(oid) LIKE '%pedidos_compra_sync%';")" "1"

echo "── push (data_health_watchdog) ──"
# E13 — error → watchdog cria fin_alertas + e-mail (fornecedor_alerta) p/ o source
P -q <<'SQL'
TRUNCATE public.fin_alertas; TRUNCATE public.fornecedor_alerta;
SELECT _set_pc('error', interval '10 min', interval '10 min');
SELECT public.data_health_watchdog();
SQL
eq "E13a fin_alertas ativo p/ pedidos_compra_sync" "$(Pq -c "SELECT count(*) FROM public.fin_alertas WHERE tipo='data_health_pedidos_compra_sync' AND dismissed_at IS NULL;")" "1"
eq "E13b e-mail [Saúde de dados] pedidos_compra_sync" "$(Pq -c "SELECT count(*) FROM public.fornecedor_alerta WHERE titulo='[Saúde de dados] pedidos_compra_sync';")" "1"
eq "E13c severidade=urgente (critical→urgente)" "$(Pq -c "SELECT severidade FROM public.fornecedor_alerta WHERE titulo='[Saúde de dados] pedidos_compra_sync' LIMIT 1;")" "urgente"
# E14 — volta a complete fresco → watchdog faz dismiss
P -q <<'SQL'
SELECT _set_pc('complete', interval '10 min', interval '10 min');
SELECT public.data_health_watchdog();
SQL
eq "E14 dismiss ao voltar a ok" "$(Pq -c "SELECT count(*) FROM public.fin_alertas WHERE tipo='data_health_pedidos_compra_sync' AND dismissed_at IS NULL;")" "0"

# E15 — heartbeat diário inclui o source na linha de resumo
P -q -c "SELECT _set_pc('error', interval '10 min', interval '10 min'); TRUNCATE public.fornecedor_alerta; SELECT public.fin_sync_heartbeat();" >/dev/null
eq "E15 heartbeat resumo tem linha 'pedidos_compra_sync: broken'" "$(Pq -c "SELECT mensagem ~ 'pedidos_compra_sync: broken' FROM public.fornecedor_alerta WHERE titulo LIKE '[Watchdog%' LIMIT 1;")" "t"

# ══════════════════════════════════════════════════════════════════════════════
# ZONA 5 — FALSIFICAÇÃO (sabota → exige VERMELHO no assert daquela defesa → restaura)
# ══════════════════════════════════════════════════════════════════════════════
echo "── falsificação ──"

# F1 — sabota o THRESHOLD de stale (6h→600h): E3 (7h) deixa de ser stale (prova que E3 tinha dente)
P -q -c "SELECT _set_pc('complete', interval '7 hours', interval '10 min');"
eq "F1-pre complete 7h → stale" "$(chk)" "stale"
sabota "m.last_sync_at > interval '6 hours'" "m.last_sync_at > interval '600 hours'" 1
eq "F1 sabota threshold→600h: 7h PARA de ser stale" "$(chk)" "ok"
P -q -f "$MIG"; eq "F1-pós restaurado: 7h volta a stale" "$(chk)" "stale"

# F2 — sabota a detecção de ERROR (broken→ok): E5 deixa de pegar a falha total (tinha dente)
P -q -c "SELECT _set_pc('error', interval '10 min', interval '10 min');"
eq "F2-pre error → broken" "$(chk)" "broken"
sabota "WHEN m.marker_status = 'error' THEN 'broken'" "WHEN m.marker_status = 'error' THEN 'ok'" 1
eq "F2 sabota error→ok: falha total ESCAPA" "$(chk)" "ok"
P -q -f "$MIG"; eq "F2-pós restaurado: error volta a broken" "$(chk)" "broken"

# F3 — sabota o ÓRFÃO running (1h→999h): E8 (running 2h) deixa de ser broken (tinha dente)
P -q -c "SELECT _set_pc('running', interval '10 min', interval '2 hours');"
eq "F3-pre running órfão 2h → broken" "$(chk)" "broken"
sabota "now() - m.updated_at > interval '1 hour' THEN 'broken'" "now() - m.updated_at > interval '999 hours' THEN 'broken'" 1
eq "F3 sabota órfão→999h: running 2h vira ok (em andamento)" "$(chk)" "ok"
P -q -f "$MIG"; eq "F3-pós restaurado: running 2h volta a broken" "$(chk)" "broken"

# F4 — sabota o IN-list do watchdog (tira o source): o push NÃO cria alerta (E13 tinha dente)
P -q <<'SQL'
TRUNCATE public.fin_alertas; TRUNCATE public.fornecedor_alerta;
SELECT _set_pc('error', interval '10 min', interval '10 min');
SQL
sabota "'custos_product_cost_revivido','pedidos_compra_sync')" "'custos_product_cost_revivido')" 1
P -q -c "SELECT public.data_health_watchdog();" >/dev/null
eq "F4 sabota IN-list watchdog: 0 alertas p/ pedidos_compra_sync" "$(Pq -c "SELECT count(*) FROM public.fin_alertas WHERE tipo='data_health_pedidos_compra_sync' AND dismissed_at IS NULL;")" "0"
P -q -f "$MIG"

echo "──────────────────────────────"
echo "RESULTADO: $PASS ok / $FAIL fail"
[ "$FAIL" = "0" ] || { echo "❌ HARNESS VERMELHO"; exit 1; }
echo "✅ HARNESS VERDE"
