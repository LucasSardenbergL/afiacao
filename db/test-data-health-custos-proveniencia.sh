#!/usr/bin/env bash
# ╔══════════════════════════════════════════════════════════════════════════════╗
# ║  HARNESS PG17 — Sentinela VIGIA da proveniência de custo (follow-up #1019)     ║
# ║  Prova os 2 invariantes money-path em product_costs + o push (watchdog/        ║
# ║  heartbeat) + falsificação. Migration: 20260623160000_data_health_custos_      ║
# ║  proveniencia.sql. Rode: bash db/test-data-health-custos-proveniencia.sh \     ║
# ║    > /tmp/t.log 2>&1; echo "exit=$?"   (NÃO pipe pra tail — engole o exit≠0)    ║
# ║  Asserts revisados pós-challenge Codex (tab/newline, severidade/contexto,      ║
# ║  linha exata heartbeat, sequencial I1→I2, re-alert, F3/F4 simétricos).         ║
# ╚══════════════════════════════════════════════════════════════════════════════╝
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PGVER=17
PGBIN="/opt/homebrew/opt/postgresql@${PGVER}/bin"
PORT="${PGPORT_TEST:-5468}"
SLUG="custos-prov"
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
# ZONA 1 — STUBS: todas as tabelas que as 3 funções LEEM/ESCREVEM (colunas usadas).
#   Tabelas vazias ⇒ os outros 20 checks dão broken/unknown (sem ERRO); só product_costs
#   eu semeio. fin_alertas precisa do índice único PARCIAL (o watchdog faz ON CONFLICT
#   (company,tipo) WHERE dismissed_at IS NULL). _vendas_familia_ausente_lista_email = stub.
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
CREATE TABLE public.sync_state (entity_type text, account text, status text, last_sync_at timestamptz);
CREATE TABLE public.tint_skus (id uuid, account text, ativo boolean, omie_product_id uuid);
CREATE TABLE public.fornecedor_alerta (id uuid DEFAULT gen_random_uuid(), empresa text, tipo text, severidade text, titulo text, mensagem text, status text, criado_em timestamptz DEFAULT now(), erro_notificacao text);
CREATE TABLE public.fin_alertas (id uuid DEFAULT gen_random_uuid(), company text, tipo text, severidade text, mensagem text, contexto jsonb, dismissed_at timestamptz, criado_em timestamptz DEFAULT now());
CREATE UNIQUE INDEX fin_alertas_company_tipo_uniq ON public.fin_alertas (company, tipo) WHERE dismissed_at IS NULL;
CREATE FUNCTION public._vendas_familia_ausente_lista_email(int) RETURNS text LANGUAGE sql STABLE AS $f$ SELECT NULL::text $f$;
SQL

# ══════════════════════════════════════════════════════════════════════════════
# ZONA 2 — APLICAR A MIGRATION REAL (Lei #1)
# ══════════════════════════════════════════════════════════════════════════════
MIG="$REPO_ROOT/supabase/migrations/20260623160000_data_health_custos_proveniencia.sql"
P -q -f "$MIG"
echo "migration aplicada: $(basename "$MIG")"

# helpers de leitura da função sob teste
chk()    { Pq -c "SELECT status   FROM public._data_health_compute() WHERE source='$1';"; }
chksev() { Pq -c "SELECT severity FROM public._data_health_compute() WHERE source='$1';"; }
seed1()  { P -q -c "TRUNCATE public.product_costs; INSERT INTO public.product_costs(product_id,cost_source,cost_confidence,cost_final,updated_at) VALUES (gen_random_uuid(),$1,$2,$3,now());"; }
# sabotagem: replace LITERAL (robusto a metacaracteres da regex) via python; aplica a versão furada
sabota() {  # $1=OLD literal  $2=NEW literal  $3=count esperado
  local SAB; SAB=$(mktemp /tmp/sab-custos.XXXXXX.sql)
  SAB="$SAB" MIG="$MIG" SAB_OLD="$1" SAB_NEW="$2" SAB_CNT="$3" python3 - <<'PYEOF'
import os
s = open(os.environ['MIG']).read()
old, new, cnt = os.environ['SAB_OLD'], os.environ['SAB_NEW'], int(os.environ['SAB_CNT'])
assert s.count(old) == cnt, f"sabota: esperei {cnt} de [{old}], achei {s.count(old)}"
open(os.environ['SAB'], 'w').write(s.replace(old, new))
PYEOF
  P -q -f "$SAB"; rm -f "$SAB"
}

echo "── asserts ──"

# A0 — a função EXECUTA (pega bug late-bound do watchdog/heartbeat) e tem 22 checks
N=$(Pq -c "SELECT count(*) FROM public._data_health_compute();")
eq "A0 compute executa e tem 22 checks (20→22)" "$N" "22"
# A0b — forma da linha dos count-checks (domain + age NULL + expected_max NULL)
eq "A0b I1 domain=estoque"   "$(Pq -c "SELECT domain FROM public._data_health_compute() WHERE source='custos_proxy_conf_alta';")" "estoque"
eq "A0c I1 age_seconds NULL"  "$(Pq -c "SELECT age_seconds IS NULL FROM public._data_health_compute() WHERE source='custos_proxy_conf_alta';")" "t"
eq "A0d I2 expected_max NULL" "$(Pq -c "SELECT expected_max_age_seconds IS NULL FROM public._data_health_compute() WHERE source='custos_product_cost_revivido';")" "t"

# A1 — BASELINE VERDE: só sources válidos
P -q <<'SQL'
TRUNCATE public.product_costs;
INSERT INTO public.product_costs(product_id,cost_source,cost_confidence,cost_final,updated_at) VALUES
 (gen_random_uuid(),'CMC',0.85,10.0,now()),
 (gen_random_uuid(),'FAMILY_MARGIN_PROXY',0.5,5.0,now()),
 (gen_random_uuid(),'CMC_MARGEM_ATIPICA',0.6,8.0,now());
SQL
eq "A1a I1 verde (só válidos)"        "$(chk custos_proxy_conf_alta)"      "ok"
eq "A1b I1 severity=info quando verde" "$(chksev custos_proxy_conf_alta)"  "info"
eq "A1c I2 verde"                      "$(chk custos_product_cost_revivido)" "ok"

# A2 — POSITIVO I1: proxy carimbado conf alta
P -q -c "INSERT INTO public.product_costs(product_id,cost_source,cost_confidence,cost_final,updated_at) VALUES (gen_random_uuid(),'FAMILY_MARGIN_PROXY',0.75,5.0,now());"
eq "A2a I1 detecta proxy conf>=0.7"       "$(chk custos_proxy_conf_alta)"     "stale"
eq "A2b I1 severity=warning quando viola" "$(chksev custos_proxy_conf_alta)"  "warning"
eq "A2c I2 não afetado por viol. I1"      "$(chk custos_product_cost_revivido)" "ok"

# A3 — FRONTEIRAS I1 (>= exato / abaixo / cost_final / NULLs)
seed1 "'DEFAULT_PROXY'" "0.70" "5.0"; eq "A3a conf=0.70 conta (>=)"           "$(chk custos_proxy_conf_alta)" "stale"
seed1 "'DEFAULT_PROXY'" "0.69" "5.0"; eq "A3b conf=0.69 NÃO conta"            "$(chk custos_proxy_conf_alta)" "ok"
seed1 "'DEFAULT_PROXY'" "0.90" "0.0"; eq "A3c cost_final=0 NÃO conta"         "$(chk custos_proxy_conf_alta)" "ok"
seed1 "'DEFAULT_PROXY'" "NULL" "5.0"; eq "A3d cost_confidence NULL NÃO conta"  "$(chk custos_proxy_conf_alta)" "ok"
seed1 "NULL"           "0.90" "5.0"; eq "A3e source NULL+conf alta DETECTA (proveniência ausente)" "$(chk custos_proxy_conf_alta)" "stale"

# A4 — POSITIVO I2 + NORMALIZAÇÃO (paridade com .trim() do TS: espaço/tab/newline)
seed1 "'PRODUCT_COST'"   "0.50" "10.0"; eq "A4a I2 detecta PRODUCT_COST"            "$(chk custos_product_cost_revivido)" "stale"
seed1 "' product_cost '" "0.50" "10.0"; eq "A4b I2 normaliza ' product_cost ' (espaço+casing)" "$(chk custos_product_cost_revivido)" "stale"
seed1 "E'\tPRODUCT_COST'" "0.50" "10.0"; eq "A4c I2 normaliza TAB (btrim falharia)"  "$(chk custos_product_cost_revivido)" "stale"
seed1 "E'PRODUCT_COST\n'" "0.50" "10.0"; eq "A4d I2 normaliza NEWLINE (btrim falharia)" "$(chk custos_product_cost_revivido)" "stale"
# e o I1: um CMC com tab (real escrito sujo) NÃO deve falso-positivar (normalização casa o consumo→real)
seed1 "E'\tCMC\n'" "0.80" "10.0"; eq "A4e CMC c/ whitespace: I1 NÃO falso-positiva (normaliza p/ real)" "$(chk custos_proxy_conf_alta)" "ok"

# A5 — SEPARAÇÃO dos invariantes: PRODUCT_COST conf alta dispara SÓ I2, não I1
#      (contradição saudável: PRODUCT_COST é consumer-real p/ I1, writer-forbidden p/ I2)
seed1 "'PRODUCT_COST'" "0.95" "10.0"
eq "A5a PRODUCT_COST conf alta: I1 NÃO dispara (está na whitelist real)" "$(chk custos_proxy_conf_alta)"      "ok"
eq "A5b PRODUCT_COST conf alta: I2 dispara"                              "$(chk custos_product_cost_revivido)" "stale"

# A6 — PUSH (watchdog) — achado do Codex: 2 sources = 2 alertas INDEPENDENTES (simultâneo)
P -q <<'SQL'
TRUNCATE public.product_costs; TRUNCATE public.fin_alertas; TRUNCATE public.fornecedor_alerta;
INSERT INTO public.product_costs(product_id,cost_source,cost_confidence,cost_final,updated_at) VALUES
 (gen_random_uuid(),'FAMILY_MARGIN_PROXY',0.80,5.0,now()),   -- viola I1
 (gen_random_uuid(),'PRODUCT_COST',0.50,10.0,now());          -- viola I2
SELECT public.data_health_watchdog();
SQL
A=$(Pq -c "SELECT count(*) FROM public.fin_alertas WHERE tipo IN ('data_health_custos_proxy_conf_alta','data_health_custos_product_cost_revivido') AND dismissed_at IS NULL;")
eq "A6a watchdog cria 2 fin_alertas distintos (resolve o blind spot do ON CONFLICT)" "$A" "2"
eq "A6b e-mail I1 (exatamente 1)" "$(Pq -c "SELECT count(*) FROM public.fornecedor_alerta WHERE titulo='[Saúde de dados] custos_proxy_conf_alta';")" "1"
eq "A6c e-mail I2 (exatamente 1)" "$(Pq -c "SELECT count(*) FROM public.fornecedor_alerta WHERE titulo='[Saúde de dados] custos_product_cost_revivido';")" "1"
eq "A6d severidade do alerta I1 = aviso" "$(Pq -c "SELECT severidade FROM public.fin_alertas WHERE tipo='data_health_custos_proxy_conf_alta' AND dismissed_at IS NULL;")" "aviso"
eq "A6e contexto.source preenchido (I2)" "$(Pq -c "SELECT contexto->>'source' FROM public.fin_alertas WHERE tipo='data_health_custos_product_cost_revivido' AND dismissed_at IS NULL;")" "custos_product_cost_revivido"

# A7 — DISMISS: volta a verde ⇒ watchdog encerra os alertas
P -q <<'SQL'
TRUNCATE public.product_costs;
INSERT INTO public.product_costs(product_id,cost_source,cost_confidence,cost_final,updated_at) VALUES (gen_random_uuid(),'CMC',0.85,10.0,now());
SELECT public.data_health_watchdog();
SQL
eq "A7 volta a verde → watchdog faz dismiss (0 ativos)" "$(Pq -c "SELECT count(*) FROM public.fin_alertas WHERE tipo IN ('data_health_custos_proxy_conf_alta','data_health_custos_product_cost_revivido') AND dismissed_at IS NULL;")" "0"

# A7b — RE-ALERT após dismiss (prova que o índice único PARCIAL permite novo ativo)
P -q <<'SQL'
TRUNCATE public.product_costs;
INSERT INTO public.product_costs(product_id,cost_source,cost_confidence,cost_final,updated_at) VALUES (gen_random_uuid(),'FAMILY_MARGIN_PROXY',0.80,5.0,now());
SELECT public.data_health_watchdog();
SQL
eq "A7b re-alerta após dismiss (índice parcial permite novo ativo)" "$(Pq -c "SELECT count(*) FROM public.fin_alertas WHERE tipo='data_health_custos_proxy_conf_alta' AND dismissed_at IS NULL;")" "1"

# A8 — HEARTBEAT: linha EXATA do resumo (não só substring). Estado: I1 stale, I2 ok.
P -q -c "TRUNCATE public.fornecedor_alerta; SELECT public.fin_sync_heartbeat();" >/dev/null
eq "A8a heartbeat linha exata 'custos_proxy_conf_alta: stale'"  "$(Pq -c "SELECT mensagem ~ 'custos_proxy_conf_alta: stale' FROM public.fornecedor_alerta WHERE titulo LIKE '[Watchdog%' LIMIT 1;")" "t"
eq "A8b heartbeat linha exata 'custos_product_cost_revivido: ok'" "$(Pq -c "SELECT mensagem ~ 'custos_product_cost_revivido: ok' FROM public.fornecedor_alerta WHERE titulo LIKE '[Watchdog%' LIMIT 1;")" "t"

# A9 — SEQUENCIAL (o cenário EXATO do achado Codex): I1 alerta primeiro; depois I2 aparece
#      e DEVE alertar mesmo com I1 ativo (o que 1 source combinado silenciaria via ON CONFLICT).
echo "  · A9 cenário sequencial I1→I2:"
P -q <<'SQL'
TRUNCATE public.product_costs; TRUNCATE public.fin_alertas; TRUNCATE public.fornecedor_alerta;
INSERT INTO public.product_costs(product_id,cost_source,cost_confidence,cost_final,updated_at) VALUES (gen_random_uuid(),'FAMILY_MARGIN_PROXY',0.80,5.0,now());
SELECT public.data_health_watchdog();   -- passo 1: só I1
SQL
eq "A9a passo1: I1 alerta criado" "$(Pq -c "SELECT count(*) FROM public.fin_alertas WHERE tipo='data_health_custos_proxy_conf_alta' AND dismissed_at IS NULL;")" "1"
P -q <<'SQL'
INSERT INTO public.product_costs(product_id,cost_source,cost_confidence,cost_final,updated_at) VALUES (gen_random_uuid(),'PRODUCT_COST',0.50,10.0,now());
SELECT public.data_health_watchdog();   -- passo 2: I2 aparece, I1 segue ativo
SQL
eq "A9b passo2: I2 alerta MESMO com I1 já ativo" "$(Pq -c "SELECT count(*) FROM public.fin_alertas WHERE tipo='data_health_custos_product_cost_revivido' AND dismissed_at IS NULL;")" "1"
eq "A9c passo2: e-mail de I2 disparou (não silenciado por I1 ativo)" "$(Pq -c "SELECT count(*) FROM public.fornecedor_alerta WHERE titulo='[Saúde de dados] custos_product_cost_revivido';")" "1"

# ══════════════════════════════════════════════════════════════════════════════
# ZONA 5 — FALSIFICAÇÃO (sabota a migração → exige que o assert daquela defesa vire VERMELHO → restaura)
# ══════════════════════════════════════════════════════════════════════════════
echo "── falsificação ──"

# F1 — sabota o THRESHOLD de I1 (0.7 → 0.99): a violação conf 0.80 escapa (A2 tinha dente)
P -q -c "TRUNCATE public.product_costs; INSERT INTO public.product_costs(product_id,cost_source,cost_confidence,cost_final,updated_at) VALUES (gen_random_uuid(),'FAMILY_MARGIN_PROXY',0.80,5.0,now());"
eq "F1-pre I1 detecta" "$(chk custos_proxy_conf_alta)" "stale"
sabota "cost_confidence >= 0.7" "cost_confidence >= 0.99" 1
eq "F1 sabota threshold→0.99: I1 PARA de detectar" "$(chk custos_proxy_conf_alta)" "ok"
P -q -f "$MIG"; eq "F1-pós restaurado: I1 volta a detectar" "$(chk custos_proxy_conf_alta)" "stale"

# F2 — sabota a NORMALIZAÇÃO (regexp_replace → coalesce puro): ' product_cost ' escapa (A4 tinha dente)
seed1 "' product_cost '" "0.50" "10.0"
eq "F2-pre I2 detecta normalizado" "$(chk custos_product_cost_revivido)" "stale"
sabota "upper(regexp_replace(coalesce(cost_source,''), '^\s+|\s+\$', '', 'g'))" "upper(coalesce(cost_source,''))" 2
eq "F2 sabota normalização: ' product_cost ' ESCAPA" "$(chk custos_product_cost_revivido)" "ok"
P -q -f "$MIG"; eq "F2-pós restaurado: I2 normalizado volta a detectar" "$(chk custos_product_cost_revivido)" "stale"

# F3 — sabota o IN-LIST do push removendo I1 do watchdog+heartbeat: só 1 alerta (A6 tinha dente)
P -q <<'SQL'
TRUNCATE public.product_costs; TRUNCATE public.fin_alertas; TRUNCATE public.fornecedor_alerta;
INSERT INTO public.product_costs(product_id,cost_source,cost_confidence,cost_final,updated_at) VALUES
 (gen_random_uuid(),'FAMILY_MARGIN_PROXY',0.80,5.0,now()),
 (gen_random_uuid(),'PRODUCT_COST',0.50,10.0,now());
SQL
sabota "'custos_proxy_conf_alta','custos_product_cost_revivido'" "'custos_product_cost_revivido'" 2
P -q -c "SELECT public.data_health_watchdog();" >/dev/null
eq "F3 sabota IN-list (tira I1): 1 alerta, não 2" "$(Pq -c "SELECT count(*) FROM public.fin_alertas WHERE tipo IN ('data_health_custos_proxy_conf_alta','data_health_custos_product_cost_revivido') AND dismissed_at IS NULL;")" "1"
P -q -f "$MIG"

# F4 — simétrico: sabota removendo I2 do IN-list: só 1 alerta (prova o push de I2 independente)
P -q <<'SQL'
TRUNCATE public.product_costs; TRUNCATE public.fin_alertas; TRUNCATE public.fornecedor_alerta;
INSERT INTO public.product_costs(product_id,cost_source,cost_confidence,cost_final,updated_at) VALUES
 (gen_random_uuid(),'FAMILY_MARGIN_PROXY',0.80,5.0,now()),
 (gen_random_uuid(),'PRODUCT_COST',0.50,10.0,now());
SQL
sabota "'custos_proxy_conf_alta','custos_product_cost_revivido'" "'custos_proxy_conf_alta'" 2
P -q -c "SELECT public.data_health_watchdog();" >/dev/null
eq "F4 sabota IN-list (tira I2): 1 alerta, não 2 (simétrico de F3)" "$(Pq -c "SELECT count(*) FROM public.fin_alertas WHERE tipo IN ('data_health_custos_proxy_conf_alta','data_health_custos_product_cost_revivido') AND dismissed_at IS NULL;")" "1"
P -q -f "$MIG"

echo "──────────────────────────────"
echo "RESULTADO: $PASS ok / $FAIL fail"
[ "$FAIL" = "0" ] || { echo "❌ HARNESS VERMELHO"; exit 1; }
echo "✅ HARNESS VERDE"
