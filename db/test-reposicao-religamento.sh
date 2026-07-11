#!/usr/bin/env bash
# Harness PG17 do RELIGAMENTO (PR-2) — prova EXECUTANDO que, ao trocar o FROM das 4
# views estatísticas de v_venda_items_history_efetivo → v_sku_demanda_efetiva:
#   A. RELIGAMENTO   — o INSUMO ganha demanda_total_90d > 0 (antes era ausente);
#   B. NÃO-REGRESSÃO — SKU não-insumo (300) IDÊNTICO antes/depois nas 4 views (EXCEPT ALL);
#   C. FIX #10       — devolução do pai (qtde<0) NÃO vira consumo negativo do insumo;
#   D. GRADUAÇÃO     — o insumo herda 2 NFs distintas dos pais → num_ordens=2 (sai de AGUARDANDO);
#   E. RLS           — security_invoker preservado nas 4 views recriadas.
# + FALSIFICAÇÃO (um assert só vale se QUEBRA quando o guard some):
#   SAB1 — v_sku_demanda_efetiva SEM o guard #10 → a devolução VAZA como consumo negativo (C1 quebraria);
#   SAB2 — remover security_invoker de 1 view religada → E1 cai de 4 p/ 3.
#
# MONEY-PATH (muda comportamento de compra). SQL sob teste, aplicado NESTA ORDEM:
#   db/reposicao-demanda-insumos-bom.sql (com fix #10)  →  db/reposicao-religamento-insumos.sql
# Bootstrap: db/test-reposicao-demanda-insumos-bom.sh (mesmo initdb/snapshot/deps).
# PORT=5444 (≠ 5442 consolidação · ≠ 5443 bom — roda em paralelo). Pré-req: brew install postgresql@17.
#
# ⚠️ security_invoker: o PG17 LOCAL grava reloptions como `security_invoker=true`; a PROD (Supabase)
#    grava `=on`. O assert E aceita AMBOS (a validação pós-apply na prod casa `=on`).
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
export LC_ALL=en_US.UTF-8 LANG=en_US.UTF-8
PGVER=17
PGBIN="/opt/homebrew/opt/postgresql@${PGVER}/bin"
PORT=5444
DATA="$(mktemp -d /tmp/pgtest-relig.XXXXXX)/data"
WORK="$(mktemp -d /tmp/relig-work.XXXXXX)"

[ -x "$PGBIN/initdb" ] || { echo "postgresql@${PGVER} ausente: brew install postgresql@${PGVER}"; exit 1; }

CELLAR="$(brew --prefix postgresql@${PGVER})"
cp -Rn "$CELLAR"/share/postgresql/. "/opt/homebrew/share/postgresql@${PGVER}/" 2>/dev/null || true
mkdir -p "/opt/homebrew/lib/postgresql@${PGVER}"
cp -Rn "$CELLAR"/lib/postgresql/. "/opt/homebrew/lib/postgresql@${PGVER}/" 2>/dev/null || true

cleanup() { "$PGBIN/pg_ctl" -D "$DATA" stop -m immediate >/dev/null 2>&1 || true; rm -rf "$(dirname "$DATA")" "$WORK"; rm -f "${RR:-}"; }
trap cleanup EXIT

"$PGBIN/initdb" -D "$DATA" -U postgres -E UTF8 --locale=en_US.UTF-8 >/dev/null
"$PGBIN/pg_ctl" -D "$DATA" -o "-p $PORT -k /tmp" -l /tmp/pg-relig.log -w start >/dev/null
"$PGBIN/createdb" -p "$PORT" -h /tmp -U postgres relig_verify
P() { "$PGBIN/psql" -p "$PORT" -h /tmp -U postgres -d relig_verify "$@"; }

RR="$(mktemp "${TMPDIR:-/tmp}/snap-relig.XXXXXX")"
sed -E 's/^(CREATE SCHEMA public;)/-- \1/' "$REPO_ROOT/supabase/schema-snapshot.sql" \
  | grep -vE '^\\(un)?restrict ' > "$RR"

echo "→ stubs + prelude + snapshot…"
P -v ON_ERROR_STOP=1 -q -f "$REPO_ROOT/db/stubs-supabase.sql"
P -v ON_ERROR_STOP=1 -q -f "$REPO_ROOT/supabase/schema-extensions-prelude.sql"
P --single-transaction -v ON_ERROR_STOP=1 -q -f "$RR"
rm -f "$RR"

echo "→ dependências (PCP + consolidação — vieram DEPOIS do dump)…"
P -v ON_ERROR_STOP=1 -q -f "$REPO_ROOT/db/pcp-f1a-m1-staging.sql"
P -v ON_ERROR_STOP=1 -q -f "$REPO_ROOT/db/pcp-f1a-m2-nucleo.sql"
P -v ON_ERROR_STOP=1 -q -f "$REPO_ROOT/db/reposicao-consolidacao-demanda.sql"   # as 4 views v1: FROM v_venda_items_history_efetivo

echo "→ PR-1 (com fix #10): v_pcp_malha_oben* + v_sku_demanda_efetiva…"
P -v ON_ERROR_STOP=1 -q -f "$REPO_ROOT/db/reposicao-demanda-insumos-bom.sql"

# ── Helpers ──
PASS=0
Pq() { P -tA -q "$@"; }
assert_eq() { if [ "$2" = "$3" ]; then PASS=$((PASS+1)); echo "  ✓ $1"; else echo "  ✗ $1: esperado='$2' obtido='$3'"; exit 1; fi; }
# conta quantas das 4 views religadas têm security_invoker (aceita 'true' do PG17 e 'on' da prod).
inv4() { Pq -c "SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
  WHERE n.nspname='public'
    AND c.relname IN ('v_sku_demanda_estatisticas','v_sku_sigma_demanda','v_sku_demanda_rajada','v_sku_candidatos_primeira_compra')
    AND (c.reloptions @> ARRAY['security_invoker=true'] OR c.reloptions @> ARRAY['security_invoker=on']);"; }

set_malha() {
  P -v ON_ERROR_STOP=1 -q -c "
    INSERT INTO pcp_malha_staging (omie_codigo_produto, empresa, payload, sync_run_id, synced_at)
    VALUES ($1, 'colacor',
            jsonb_build_object('ident', jsonb_build_object('idProduto', $1), 'itens', '$2'::jsonb),
            1, now())
    ON CONFLICT (omie_codigo_produto) DO UPDATE SET payload = EXCLUDED.payload;"
}

# ══════════════════════════════════════════════════════════════════════════
# Fixtures (mesmos do PR-1 Step 1/5 + a DEVOLUÇÃO do pai p/ o fix #10)
# ══════════════════════════════════════════════════════════════════════════
echo "→ seed: pcp_run_logs (FK do sync_run_id=1 de set_malha)…"
P -v ON_ERROR_STOP=1 -q -c "INSERT INTO pcp_run_logs (empresa, funcao, status) VALUES ('colacor','test-harness-relig','ok');"

echo "→ catálogo colacor↔oben (pai 100/200 · insumo BASE 101/201 · sem-ficha 300)…"
P -v ON_ERROR_STOP=1 -q <<'SQL'
INSERT INTO omie_products (id, omie_codigo_produto, codigo, descricao, account, ativo, unidade)
VALUES (gen_random_uuid(), 100, 'PRD_PAI',      'TINGIDOR X',        'colacor', true, 'UN'),
       (gen_random_uuid(), 200, 'PRD_PAI',      'TINGIDOR X',        'oben',    true, 'UN'),
       (gen_random_uuid(), 101, 'PRD_BASE',     'BASE',              'colacor', true, 'L'),
       (gen_random_uuid(), 201, 'PRD_BASE',     'BASE',              'oben',    true, 'L'),
       (gen_random_uuid(), 300, 'PRD_SEMFICHA', 'PRODUTO SEM FICHA', 'oben',    true, 'UN');
SQL

echo "→ ficha: pai 100 leva 0.9 L do insumo 101 (→ oben: pai 200 leva 0.9 L do 201)"
set_malha 100 '[{"idProdMalha":101,"quantProdMalha":0.9,"unidProdMalha":"L","percPerdaProdMalha":0}]'

echo "→ vendas: NFE-1 (pai 200 q1) · NFE-2 (pai 200 q2) · NFE-3 (300 q7) · NFE-DEV (pai 200 q-1 DEVOLUÇÃO)"
P -v ON_ERROR_STOP=1 -q <<'SQL'
INSERT INTO venda_items_history
  (id, empresa, nfe_chave_acesso, data_emissao, sku_codigo_omie, sku_descricao,
   sku_unidade, quantidade, valor_unitario, valor_total, created_at)
VALUES
  (gen_random_uuid(),'OBEN','NFE-1',   CURRENT_DATE - 10, 200, 'TINGIDOR X','UN',  1, 100,  100, now()),
  (gen_random_uuid(),'OBEN','NFE-2',   CURRENT_DATE - 5,  200, 'TINGIDOR X','UN',  2, 100,  200, now()),
  (gen_random_uuid(),'OBEN','NFE-3',   CURRENT_DATE - 3,  300, 'SEM FICHA', 'UN',  7,  10,   70, now()),
  (gen_random_uuid(),'OBEN','NFE-DEV', CURRENT_DATE - 2,  200, 'TINGIDOR X','UN', -1, 100, -100, now());
SQL

echo "→ sanidade: a malha real enxerga o par 200→201"
assert_eq "setup: par 200->201 elegivel" "1" "$(Pq -c "SELECT count(*) FROM v_pcp_malha_oben WHERE pai_oben=200 AND comp_oben=201;")"

# ══════════════════════════════════════════════════════════════════════════
# BASELINE das 4 views ANTES do religamento (ainda leem v_venda_items_history_efetivo),
# JÁ COM os fixtures → o EXCEPT ALL do SKU não-insumo compara mesmos-dados/só-a-fonte-muda.
# ══════════════════════════════════════════════════════════════════════════
echo "→ baseline pré-religamento das 4 views (com fixtures)…"
for v in v_sku_demanda_estatisticas v_sku_sigma_demanda v_sku_demanda_rajada v_sku_candidatos_primeira_compra; do
  P -v ON_ERROR_STOP=1 -q -c "CREATE TABLE base_${v} AS SELECT * FROM ${v};"
done

echo "→ PRE: o insumo 201 AINDA não aparece (as 4 views leem só a venda direta)"
assert_eq "PRE1 insumo 201 ausente antes do religamento" "0" \
  "$(Pq -c "SELECT count(*) FROM v_sku_demanda_estatisticas WHERE sku_codigo_omie=201 AND empresa='OBEN';")"

# ══════════════════════════════════════════════════════════════════════════
# APLICAR O RELIGAMENTO (as 4 views passam a ler v_sku_demanda_efetiva)
# ══════════════════════════════════════════════════════════════════════════
echo "→ RELIGAMENTO…"
P -v ON_ERROR_STOP=1 -q -f "$REPO_ROOT/db/reposicao-religamento-insumos.sql"

# ── A. RELIGAMENTO ──
echo "→ A. o insumo 201 ganha demanda após religar"
assert_eq "A1 insumo com demanda>0" "t" \
  "$(Pq -c "SELECT COALESCE(demanda_total_90d,0)>0 FROM v_sku_demanda_estatisticas WHERE sku_codigo_omie=201 AND empresa='OBEN';")"
# 0.9 (NFE-1) + 1.8 (NFE-2) = 2.7; a devolução NFE-DEV é filtrada pelo fix #10 (comparação NUMÉRICA, robusta a formatação)
assert_eq "A2 demanda_total_90d = 2.7 (devolucao NAO conta)" "t" \
  "$(Pq -c "SELECT demanda_total_90d = 2.7 FROM v_sku_demanda_estatisticas WHERE sku_codigo_omie=201 AND empresa='OBEN';")"

# ── B. NÃO-REGRESSÃO (EXCEPT ALL bidirecional do SKU não-insumo 300, nas 4 views) ──
echo "→ B. SKU não-insumo (300) idêntico antes/depois nas 4 views"
for v in v_sku_demanda_estatisticas v_sku_sigma_demanda v_sku_demanda_rajada v_sku_candidatos_primeira_compra; do
  got=$(Pq -c "SELECT count(*) FROM (
                 (SELECT * FROM ${v} WHERE sku_codigo_omie::text='300' EXCEPT ALL SELECT * FROM base_${v} WHERE sku_codigo_omie::text='300')
                 UNION ALL
                 (SELECT * FROM base_${v} WHERE sku_codigo_omie::text='300' EXCEPT ALL SELECT * FROM ${v} WHERE sku_codigo_omie::text='300')) d;")
  assert_eq "B:${v} nao-insumo (300) intacto" "0" "$got"
done

# ── C. FIX #10 ──
echo "→ C. devolução do pai NÃO gera consumo negativo do insumo"
assert_eq "C1 sem consumo negativo do insumo 201" "0" \
  "$(Pq -c "SELECT count(*) FROM v_sku_demanda_efetiva WHERE sku_codigo_omie=201 AND quantidade<0;")"

# ── D. GRADUAÇÃO ──
echo "→ D. o insumo herda 2 NFs distintas (NFE-1, NFE-2) → num_ordens=2"
assert_eq "D1 num_ordens=2 (devolucao NAO conta como ordem)" "2" \
  "$(Pq -c "SELECT num_ordens FROM v_sku_demanda_estatisticas WHERE sku_codigo_omie=201 AND empresa='OBEN';")"

# ── E. RLS ──
echo "→ E. security_invoker preservado nas 4 views religadas"
assert_eq "E1 as 4 views security_invoker" "4" "$(inv4)"

# ══════════════════════════════════════════════════════════════════════════
# FALSIFICAÇÃO — sabotar → exigir vermelho
# ══════════════════════════════════════════════════════════════════════════
echo "→ SAB1: v_sku_demanda_efetiva SEM o guard #10 → a devolução vaza como consumo negativo (C1 quebraria)"
P -q -c "CREATE OR REPLACE VIEW v_sku_demanda_efetiva WITH (security_invoker = true) AS
  SELECT id, empresa, nfe_chave_acesso, nfe_numero, nfe_serie, data_emissao,
         cliente_codigo_omie, cliente_razao_social, cliente_cnpj_cpf, cliente_uf, cliente_cidade,
         sku_codigo_omie, sku_codigo, sku_descricao, sku_ncm, sku_unidade,
         quantidade, valor_unitario, valor_total, cfop, raw_data, created_at
  FROM v_venda_items_history_efetivo
  UNION ALL
  SELECT md5(v.id::text || ':' || mo.comp_oben::text)::uuid, v.empresa,
         v.nfe_chave_acesso, v.nfe_numero, v.nfe_serie, v.data_emissao,
         v.cliente_codigo_omie, v.cliente_razao_social, v.cliente_cnpj_cpf, v.cliente_uf, v.cliente_cidade,
         mo.comp_oben, ins.codigo, ins.descricao, ins.ncm, ins.unidade,
         v.quantidade * mo.quantidade, NULL::numeric, NULL::numeric,
         v.cfop, v.raw_data, v.created_at
  FROM v_venda_items_history_efetivo v
  JOIN v_pcp_malha_oben mo ON mo.pai_oben = v.sku_codigo_omie
  JOIN omie_products ins ON ins.omie_codigo_produto = mo.comp_oben AND ins.account='oben'
  WHERE v.empresa='OBEN';"   -- SEM 'AND v.quantidade > 0'
neg=$(Pq -c "SELECT count(*) FROM v_sku_demanda_efetiva WHERE sku_codigo_omie=201 AND quantidade<0;")
if [ "$neg" = "0" ]; then echo "  ✗ SAB1 INÚTIL: C1 não detecta a remoção do guard #10"; exit 1; fi
echo "  ✓ S1 ok (sem o guard #10 a devolução vira consumo -0.9 → C1 protege de verdade; vazou $neg linha(s))"
PASS=$((PASS+1))
P -v ON_ERROR_STOP=1 -q -f "$REPO_ROOT/db/reposicao-demanda-insumos-bom.sql"   # restaura a versão real (com guard)

echo "→ SAB2: remover security_invoker de 1 view religada → E1 cai p/ 3"
P -q -c "ALTER VIEW v_sku_demanda_estatisticas RESET (security_invoker);"   # equivale a um CREATE OR REPLACE sem o WITH
got=$(inv4)
if [ "$got" != "3" ]; then echo "  ✗ SAB2 INÚTIL: E1 não detectou a view sem security_invoker (obtido=$got, esperava 3)"; exit 1; fi
echo "  ✓ S2 ok (view sem security_invoker → E1 cai p/ 3; logo E1 protege a RLS)"
PASS=$((PASS+1))
P -q -c "ALTER VIEW v_sku_demanda_estatisticas SET (security_invoker = true);"   # restaura

# ── prova de que a sabotagem foi DESFEITA (não mascarada) ──
echo "→ RESTORE: C1 volta a 0 e E1 volta a 4"
assert_eq "R-C1 consumo negativo zerado de novo" "0" \
  "$(Pq -c "SELECT count(*) FROM v_sku_demanda_efetiva WHERE sku_codigo_omie=201 AND quantidade<0;")"
assert_eq "R-E1 as 4 views security_invoker de novo" "4" "$(inv4)"

echo ""
echo "PASS=$PASS"
echo "✅ religamento (PR-2): demanda do insumo + não-regressão + fix#10 + graduação + RLS — provado com falsificação"
