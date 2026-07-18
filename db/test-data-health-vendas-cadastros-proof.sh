#!/usr/bin/env bash
# ╔══════════════════════════════════════════════════════════════════════════════════════════╗
# ║  PROVA PG17 — _data_health_compute: check `vendas_cadastros` larga o espelho omie_clientes ║
# ║  Migration: supabase/migrations/20260718220000_data_health_vendas_cadastros_proof.sql     ║
# ║  Rode:  bash db/test-data-health-vendas-cadastros-proof.sh > /tmp/t.log 2>&1; echo $?     ║
# ║                                                                                            ║
# ║  Aplica a função REAL (Lei #1 — NÃO uma micro-réplica): o risco declarado desta migration  ║
# ║  é a função falhar INTEIRA (LANGUAGE sql, um único UNION ALL de 24 checks ⇒ blackout do    ║
# ║  Sentinela, não degradação de um check). Provar isso exige EXECUTAR a função inteira, e    ║
# ║  por isso a ZONA 1 stuba as 17 relações que ela lê.                                        ║
# ║                                                                                            ║
# ║  O par que carrega a prova:                                                                ║
# ║    A9  — com a migration nova, `DROP TABLE omie_clientes` deixa os 24 checks DE PÉ         ║
# ║    F1  — com o corpo VELHO, o mesmo DROP derruba a função INTEIRA (42P01/undefined_table)  ║
# ║  Sem F1, A9 poderia estar medindo um harness que nunca dependeu do espelho.                ║
# ╚══════════════════════════════════════════════════════════════════════════════════════════╝
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PGVER=17
PGBIN="/opt/homebrew/opt/postgresql@${PGVER}/bin"
PORT="${PGPORT_TEST:-5463}"
SLUG="dhc-vendas-cadastros"
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

echo "═══ setup pronto (PG17 :$PORT) ═══"

# ══════════════════════════════════════════════════════════════════════════════════════════
# ZONA 1 — as 17 relações que a função lê (só as colunas tocadas; tipos conferidos via psql-ro).
#   O espelho `omie_clientes` é criado DE PROPÓSITO: o harness precisa poder DROPÁ-LO (A9/F1).
# ══════════════════════════════════════════════════════════════════════════════════════════
P -q <<'SQL'
CREATE SCHEMA IF NOT EXISTS private;

-- a tabela que SAI do check (mantida p/ o DROP das provas A9/F1)
CREATE TABLE public.omie_clientes            (user_id uuid, updated_at timestamptz);
-- a tabela que ENTRA no check
CREATE TABLE public.omie_customer_account_map(user_id uuid, account text, updated_at timestamptz);

CREATE TABLE public.fin_contas_correntes (saldo_data date, ativo boolean);
CREATE TABLE public.fin_contas_receber   (updated_at timestamptz);
CREATE TABLE public.fin_contas_pagar     (updated_at timestamptz);
CREATE TABLE public.fin_sync_log (
  action text, status text, companies text[], completed_at timestamptz,
  started_at timestamptz, error_message text
);
CREATE TABLE public.inventory_position   (synced_at timestamptz);
CREATE TABLE public.farmer_client_scores (customer_user_id uuid, calculated_at timestamptz);
CREATE TABLE public.product_costs (
  updated_at timestamptz, cost_final numeric, cost_confidence numeric, cost_source text
);
CREATE TABLE public.pedido_compra_sugerido (
  data_ciclo date, status text, aprovado_em timestamptz, atualizado_em timestamptz,
  status_envio_portal text, portal_proximo_retry_em timestamptz, portal_tentativas int
);
CREATE TABLE public.omie_products (
  id uuid DEFAULT gen_random_uuid(), omie_codigo_produto text, account text,
  tipo_produto text, metadata jsonb, familia text, ativo boolean,
  is_tintometric boolean, tint_type text,
  created_at timestamptz DEFAULT now(), updated_at timestamptz
);
CREATE TABLE public.sku_parametros (
  empresa text, fornecedor_nome text, ativo boolean, habilitado_reposicao_automatica boolean,
  tipo_reposicao text, sku_codigo_omie text
);
CREATE TABLE public.sku_estoque_atual (
  empresa text, ultima_sincronizacao timestamptz, fonte_sync text
);
CREATE TABLE public.tint_skus (
  id uuid DEFAULT gen_random_uuid(), account text, ativo boolean, omie_product_id uuid
);
CREATE TABLE public.fornecedor_alerta (
  id uuid DEFAULT gen_random_uuid(), criado_em timestamptz, status text, erro_notificacao text
);
CREATE TABLE public.sync_state (
  entity_type text, account text, status text, updated_at timestamptz,
  last_sync_at timestamptz, total_synced int, error_message text
);
CREATE TABLE private.customer_metrics_mv (customer_user_id uuid, calculated_at timestamptz);
SQL
echo "stubs criados (17 relações)"

# ══════════════════════════════════════════════════════════════════════════════════════════
# ZONA 2 — aplicar a migration REAL (Lei #1)
# ══════════════════════════════════════════════════════════════════════════════════════════
MIG="$REPO_ROOT/supabase/migrations/20260718220000_data_health_vendas_cadastros_proof.sql"

# A migration termina com blocos de VALIDAÇÃO que chamam a função e leem catálogo — úteis pro
# founder no SQL Editor, ruído aqui. Aplicamos só até o fecho do CREATE (o `;` após $function$).
# Temporários no tmpdir do PRÓPRIO harness (somem no trap): /tmp é compartilhado pelas ~30
# worktrees paralelas e um nome fixo lê/escreve o arquivo de OUTRA sessão (money-path.md: "o LOG mente").
# `mktemp` no macOS só expande XXXXXX no FIM do template — com sufixo ele cria o nome literal.
TMPD="$(dirname "$DATA")"
CREATE_ONLY="$TMPD/dhc-create.sql"
awk '/^CREATE OR REPLACE FUNCTION public\._data_health_compute/{f=1} f{print} /^\$function\$;$/{if(f) exit}' "$MIG" > "$CREATE_ONLY"
P -q -f "$CREATE_ONLY"
echo "migration aplicada: $(basename "$MIG") ($(wc -l < "$CREATE_ONLY") linhas de CREATE)"

# ══════════════════════════════════════════════════════════════════════════════════════════
# ZONA 3 — seeds. Cenário-base = o mundo de HOJE em produção (medido por psql-ro 2026-07-18):
#   espelho CONGELADO às 05:02 (writer morto na Fatia 4) · proof VIVA (1min) · produtos frescos.
# ══════════════════════════════════════════════════════════════════════════════════════════
# seed_proof <idade> — a fonte NOVA + produtos frescos. NÃO toca o espelho, então segue válida
# depois do `DROP TABLE omie_clientes` (asserts A9/A10 e toda a fase de restauro da ZONA 5).
seed_proof() {
  P -q <<SQL
TRUNCATE public.omie_customer_account_map, public.omie_products;
INSERT INTO public.omie_customer_account_map (user_id, account, updated_at) VALUES (gen_random_uuid(), 'oben', now() - interval '$1');
INSERT INTO public.omie_products (account, updated_at, ativo, familia) VALUES ('oben', now() - interval '1 hour', true, 'X');
SQL
}
# seed_espelho_congelado — reproduz o mundo de HOJE em prod: writer morto na Fatia 4, espelho parado
# há 40h (>30h ⇒ com a fonte ANTIGA o check já estaria 'stale'). Só válida enquanto a tabela existir.
seed_espelho_congelado() {
  P -q -c "TRUNCATE public.omie_clientes;"
  P -q -c "INSERT INTO public.omie_clientes (user_id, updated_at) VALUES (gen_random_uuid(), now() - interval '40 hours');"
}
seed_base() { seed_espelho_congelado; seed_proof "$1"; }
vc() { Pq -c "SELECT $1 FROM public._data_health_compute() WHERE source='vendas_cadastros';"; }

seed_base "10 minutes"

# ══════════════════════════════════════════════════════════════════════════════════════════
# ZONA 4 — asserts
# ══════════════════════════════════════════════════════════════════════════════════════════
echo "── asserts ──"

N=$(Pq -c "SELECT count(*) FROM public._data_health_compute();")
eq  "A1 a função INTEIRA executa (late-bound) e devolve 24 checks"   "$N"  "24"

eq  "A2 o check vendas_cadastros existe"                             "$(vc "count(*)")" "1"

BASIS=$(vc "freshness_basis")
case "$BASIS" in
  *omie_customer_account_map*) ok "A3 freshness_basis aponta a proof ($BASIS)" ;;
  *) bad "A3 freshness_basis não cita a proof — veio [$BASIS]" ;;
esac

eq  "A4 ⭐ proof fresca + espelho CONGELADO há 40h → 'ok' (é o mundo de hoje em prod)" "$(vc status)" "ok"

# limite de 30h: a proof é que decide agora
seed_base "31 hours"
eq  "A5 proof com 31h (>30h) → 'stale'"                              "$(vc status)" "stale"
seed_base "29 hours"
eq  "A6 proof com 29h (<30h) → 'ok'"                                 "$(vc status)" "ok"

P -q -c "TRUNCATE public.omie_customer_account_map;"
eq  "A7 proof VAZIA → 'broken' (degradação honesta, não 'ok')"       "$(vc status)" "broken"
seed_base "10 minutes"

CITA=$(Pq -c "SELECT pg_get_functiondef('public._data_health_compute()'::regprocedure) ~ '\momie_clientes\M';")
eq  "A8 o corpo NÃO cita mais omie_clientes (word-boundary)"          "$CITA" "f"

# ── isolamento por conta (correção do /codex xhigh) ────────────────────────────────────────
# A proof é multi-conta. Um `max()` GLOBAL seria mascarado pela conta mais fresca: oben roda a cada
# poucas horas e esconderia colacor parado há dias — Sentinela VERDE com uma conta morta.
P -q <<'SQL'
TRUNCATE public.omie_customer_account_map;
INSERT INTO public.omie_customer_account_map (user_id, account, updated_at) VALUES
  (gen_random_uuid(), 'oben',       now() - interval '31 hours'),  -- a conta que o check vigia: PARADA
  (gen_random_uuid(), 'colacor_sc', now() - interval '2 minutes'), -- outra conta: fresca
  (gen_random_uuid(), 'colacor',    now() - interval '2 minutes');
SQL
eq  "A8b ⭐ oben parado 31h NÃO é mascarado por outra conta fresca"   "$(vc status)" "stale"

P -q <<'SQL'
TRUNCATE public.omie_customer_account_map;
INSERT INTO public.omie_customer_account_map (user_id, account, updated_at) VALUES
  (gen_random_uuid(), 'colacor_sc', now() - interval '2 minutes'),
  (gen_random_uuid(), 'colacor',    now() - interval '2 minutes');
SQL
eq  "A8c ⭐ oben AUSENTE da proof → 'broken' (não 'ok' pelas outras contas)"  "$(vc status)" "broken"
seed_proof "10 minutes"

# ⭐ o assert que autoriza o DROP: sem o espelho, os 24 checks seguem de pé.
P -q -c "DROP TABLE public.omie_clientes;"
N2=$(Pq -c "SELECT count(*) FROM public._data_health_compute();")
eq  "A9 ⭐ SEM omie_clientes a função ainda devolve 24 checks"        "$N2" "24"
eq  "A10 ⭐ e vendas_cadastros segue 'ok' sem o espelho"              "$(vc status)" "ok"

# ══════════════════════════════════════════════════════════════════════════════════════════
# ZONA 5 — FALSIFICAÇÃO (Lei #3)
# ══════════════════════════════════════════════════════════════════════════════════════════
echo "── falsificação ──"

# Deriva o corpo VELHO do NOVO (auto-contido: sem depender de arquivo externo). `omie_customer_account_map`
# só ocorre no bloco vendas_cadastros, então a troca reversa reconstrói fielmente a versão pré-migration.
OCORR=$(grep -c "omie_customer_account_map" "$CREATE_ONLY")
eq  "F0 guard do método: 'omie_customer_account_map' ocorre 3× no corpo (a troca reversa é fiel)" "$OCORR" "3"
ANCORA=$(grep -c "FROM public.omie_customer_account_map WHERE account = 'oben'" "$CREATE_ONLY")
eq  "F0b guard: a query real (com filtro de conta) ocorre 1× — a âncora da reversão existe" "$ANCORA" "1"

# A reversão precisa de DOIS passos, em ordem: a query real perde a tabela E o filtro de conta
# (o espelho não tem coluna `account` — ele era UNIQUE(user_id), uma linha por user, conta nenhuma);
# só depois as 2 strings descritivas trocam de nome. Um `sed` global sozinho geraria
# `FROM omie_clientes WHERE account = 'oben'` e o CREATE morreria com 42703 — vermelho pelo motivo
# errado, que é exatamente o que a Lei #3 proíbe.
VELHO="$TMPD/dhc-velho.sql"
sed -e "s/FROM public.omie_customer_account_map WHERE account = 'oben'/FROM public.omie_clientes/" \
    -e "s/omie_customer_account_map(oben)/omie_clientes/g" \
    -e "s/omie_customer_account_map/omie_clientes/g" "$CREATE_ONLY" > "$VELHO"

# recria o espelho e restaura o corpo VELHO → tem de voltar a funcionar (sanidade do método)
P -q -c "CREATE TABLE public.omie_clientes (user_id uuid, updated_at timestamptz);"
P -q -c "INSERT INTO public.omie_clientes (user_id, updated_at) VALUES (gen_random_uuid(), now() - interval '40 hours');"
P -q -f "$VELHO"
eq  "F1a sanidade: corpo VELHO + espelho presente → 24 checks"        "$(Pq -c 'SELECT count(*) FROM public._data_health_compute();')" "24"
eq  "F1b ⭐ e com o espelho congelado 40h o check VELHO fica 'stale' (o alarme falso que a migration evita)" "$(vc status)" "stale"

# ⭐ F1c: o BLACKOUT. Corpo velho + DROP do espelho ⇒ a função INTEIRA falha (late-bound: o CREATE
#     passou, só o EXECUTE quebra). Captura a SQLSTATE esperada e RE-LANÇA o resto (Lei #2).
P -q -c "DROP TABLE public.omie_clientes;"
R=$(P -tA 2>&1 <<'SQL'
DO $$ BEGIN
  PERFORM count(*) FROM public._data_health_compute();
  RAISE EXCEPTION 'SENTINELA_FUNCAO_SOBREVIVEU';
EXCEPTION
  WHEN undefined_table THEN RAISE NOTICE 'BLACKOUT_CONFIRMADO_42P01';
  WHEN OTHERS THEN RAISE;
END $$;
SQL
)
case "$R" in
  *BLACKOUT_CONFIRMADO_42P01*) ok "F1c ⭐ corpo VELHO sem o espelho ⇒ função INTEIRA falha (42P01) — A9 tem dente" ;;
  *SENTINELA_FUNCAO_SOBREVIVEU*) bad "F1c a função velha sobreviveu ao DROP — A9 não prova nada" ;;
  *) bad "F1c erro inesperado — veio: $R" ;;
esac

# restaura o mundo verdadeiro (corpo NOVO, sem espelho) e confirma verde
P -q -f "$CREATE_ONLY"
eq  "F2 pós-restauro: corpo NOVO sem espelho → 24 checks"            "$(Pq -c 'SELECT count(*) FROM public._data_health_compute();')" "24"

# F5 ⭐: a 1ª versão desta migration usava `max()` GLOBAL da proof — foi o que o /codex xhigh
#        refutou. Sabotar de volta para o global tem de fazer A8b ficar VERDE com oben parado:
#        é a prova de que o `WHERE account = 'oben'` faz trabalho real, e não é decoração.
GLOB="$TMPD/dhc-global.sql"
sed "s/FROM public.omie_customer_account_map WHERE account = 'oben'/FROM public.omie_customer_account_map/" "$CREATE_ONLY" > "$GLOB"
P -q -f "$GLOB"
P -q <<'SQL'
TRUNCATE public.omie_customer_account_map;
INSERT INTO public.omie_customer_account_map (user_id, account, updated_at) VALUES
  (gen_random_uuid(), 'oben',       now() - interval '31 hours'),
  (gen_random_uuid(), 'colacor_sc', now() - interval '2 minutes');
SQL
SGLOB=$(vc status)
if [ "$SGLOB" = "ok" ]; then ok "F5 ⭐ com max() GLOBAL, colacor_sc fresco mascara oben parado 31h → A8b tem dente"; else bad "F5 sabotei p/ global e o check não ficou cego (veio [$SGLOB]) → A8b é fraco"; fi
P -q -f "$CREATE_ONLY"
seed_proof "10 minutes"
rm -f "$GLOB"

# F3: sabota o threshold (30h→99h) e exige que A5 (stale) fique VERMELHO
SAB="$TMPD/dhc-sab.sql"
sed "s/LEAST(vc.max_clientes, vc.max_produtos) > interval '30 hours'/LEAST(vc.max_clientes, vc.max_produtos) > interval '99 hours'/" "$CREATE_ONLY" > "$SAB"
P -q -f "$SAB"
seed_proof "31 hours"
S31=$(vc status)
if [ "$S31" = "ok" ]; then ok "F3 threshold sabotado p/ 99h ⇒ 31h vira 'ok' — A5 tem dente"; else bad "F3 sabotei o threshold e A5 não mudou (veio [$S31]) — assert fraco"; fi
P -q -f "$CREATE_ONLY"
seed_proof "10 minutes"
eq  "F4 pós-restauro final: volta a 'ok'"                            "$(vc status)" "ok"

rm -f "$CREATE_ONLY" "$VELHO" "$SAB"
echo "──────────────────────────────"
echo "RESULTADO: $PASS ok / $FAIL fail"
[ "$FAIL" = "0" ] || { echo "❌ HARNESS VERMELHO"; exit 1; }
echo "✅ HARNESS VERDE"
