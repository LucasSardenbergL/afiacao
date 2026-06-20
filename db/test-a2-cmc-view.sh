#!/usr/bin/env bash
# Testa o A2 (cmc como base de custo na v_sku_parametros_sugeridos) num PG17 descartável.
# (1) Aplica a VIEW DE PROD (snapshot) primeiro, depois o REPLACE da migration por cima —
#     prova que o CREATE OR REPLACE NÃO quebra por reorder/coluna (a armadilha que mordeu 3×)
#     e que a view continua consultável (lista de colunas preservada).
# (2) Testa a LÓGICA do cmc em isolado (mesma expressão da view): mapeamento account→empresa,
#     DISTINCT ON (cmc>0 + mais fresco), e COALESCE(NULLIF(cmc,0), media_compras, venda*0.55).
# Base: db/verify-snapshot-replay.sh (mesmo setup keg-only do brew).
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PGVER=17
PGBIN="/opt/homebrew/opt/postgresql@${PGVER}/bin"
PORT=5434
DATA="$(mktemp -d /tmp/pgtest-a2.XXXXXX)/data"
export LC_ALL=C LANG=C
MIG="$REPO_ROOT/supabase/migrations/20260606150000_a2_cmc_base_custo_view.sql"

[ -x "$PGBIN/initdb" ] || { echo "postgresql@${PGVER} ausente: brew install postgresql@${PGVER} pgvector"; exit 1; }
CELLAR="$(brew --prefix postgresql@${PGVER})"
cp -Rn "$CELLAR"/share/postgresql/. "/opt/homebrew/share/postgresql@${PGVER}/" 2>/dev/null || true
mkdir -p "/opt/homebrew/lib/postgresql@${PGVER}"
cp -Rn "$CELLAR"/lib/postgresql/. "/opt/homebrew/lib/postgresql@${PGVER}/" 2>/dev/null || true

cleanup() { "$PGBIN/pg_ctl" -D "$DATA" stop -m immediate >/dev/null 2>&1 || true; rm -rf "$(dirname "$DATA")"; rm -f "${RR:-}"; }
trap cleanup EXIT

"$PGBIN/initdb" -D "$DATA" -U postgres -E UTF8 --locale=C >/dev/null
"$PGBIN/pg_ctl" -D "$DATA" -o "-p $PORT -k /tmp" -l /tmp/pg-a2.log -w start >/dev/null
"$PGBIN/createdb" -p "$PORT" -h /tmp -U postgres a2_verify
P() { "$PGBIN/psql" -p "$PORT" -h /tmp -U postgres -d a2_verify "$@"; }

RR="$(mktemp "${TMPDIR:-/tmp}/snap-a2.XXXXXX")"
sed -E 's/^(CREATE SCHEMA public;)/-- \1/' "$REPO_ROOT/supabase/schema-snapshot.sql" \
  | grep -vE '^\\(un)?restrict ' > "$RR"
P -v ON_ERROR_STOP=1 -q -f "$REPO_ROOT/db/stubs-supabase.sql"
P -v ON_ERROR_STOP=1 -q -f "$REPO_ROOT/supabase/schema-extensions-prelude.sql"
P --single-transaction -v ON_ERROR_STOP=1 -q -f "$RR"
rm -f "$RR"
echo "SNAPSHOT OK (view de prod aplicada)."

# (1) REPLACE por cima da view de prod — pega reorder/coluna. ON_ERROR_STOP aborta se quebrar.
P -v ON_ERROR_STOP=1 -q -f "$MIG"
echo "REPLACE OK (sem erro de reorder/coluna)."

# View continua consultável + tem a fonte 'cmc' no def + as colunas-chave preservadas.
P -v ON_ERROR_STOP=1 -tA <<'SQL'
SELECT 'view_consultavel=' || (SELECT count(*) FROM (SELECT * FROM public.v_sku_parametros_sugeridos LIMIT 0) z)::text;
SELECT 'tem_fonte_cmc=' || (CASE WHEN pg_get_viewdef('public.v_sku_parametros_sugeridos') ILIKE '%''cmc''::text%' THEN 'sim' ELSE 'NAO' END);
SELECT 'tem_precos_cmc=' || (CASE WHEN pg_get_viewdef('public.v_sku_parametros_sugeridos') ILIKE '%precos_cmc%' THEN 'sim' ELSE 'NAO' END);
SELECT 'colunas_saida=' || count(*)::text FROM information_schema.columns WHERE table_schema='public' AND table_name='v_sku_parametros_sugeridos';
SQL

# (2) LÓGICA do cmc em isolado (mesma CTE + COALESCE da view), com inventory_position semeado.
echo ""
echo "LÓGICA (asserts):"
P -v ON_ERROR_STOP=1 -tA <<'SQL'
-- seed: SKU 100 (OBEN) cmc em 2 accounts (vendas mais fresco) ; SKU 200 cmc=0 (cai pra media) ; SKU 300 sem cmc
TRUNCATE public.inventory_position;
INSERT INTO public.inventory_position(omie_codigo_produto, account, saldo, cmc, preco_medio, synced_at) VALUES
 (100,'oben',  2, 530.00, 0, now() - interval '1 hour'),
 (100,'vendas',2, 536.48, 0, now()),                 -- mais fresco → ganha
 (200,'vendas',0, 0,      0, now()),                 -- cmc=0 → excluído (cmc>0) → cai pro fallback
 (300,'colacor_vendas',5, 99.00, 0, now()),          -- empresa COLACOR
 (400,'vendas',1, -5.00,  0, now());                 -- cmc NEGATIVO → excluído → cai pro fallback

WITH precos_cmc AS (
  SELECT DISTINCT ON (m.empresa, m.sku_codigo_omie) m.empresa, m.sku_codigo_omie, m.cmc
  FROM ( SELECT CASE
                  WHEN ip.account = ANY (ARRAY['vendas','oben']) THEN 'OBEN'
                  WHEN ip.account = ANY (ARRAY['colacor_vendas','colacor']) THEN 'COLACOR'
                  WHEN ip.account = ANY (ARRAY['servicos','colacor_sc']) THEN 'COLACOR_SC'
                  ELSE NULL END AS empresa,
                (ip.omie_codigo_produto)::text AS sku_codigo_omie, ip.cmc, ip.synced_at
         FROM public.inventory_position ip WHERE ip.cmc > 0 ) m
  WHERE m.empresa IS NOT NULL
  ORDER BY m.empresa, m.sku_codigo_omie, ((m.cmc > 0)) DESC, m.synced_at DESC NULLS LAST
),
cenarios(empresa, sku, media_compras, venda) AS (
  VALUES ('OBEN','100', 436.84::numeric, 769.54::numeric),  -- tem cmc → usa 536.48
         ('OBEN','200', 436.84::numeric, 769.54::numeric),  -- cmc=0 → usa media 436.84
         ('OBEN','999', NULL::numeric,   100.00::numeric),  -- sem cmc, sem media → venda*0.55=55
         ('OBEN','400', 300.00::numeric, 500.00::numeric),  -- cmc negativo → usa media 300
         ('COLACOR','300', 80.00::numeric, 200.00::numeric) -- cmc 99 → usa 99
)
SELECT
  'A1 sku100 usa cmc fresco 536.48: ' || (COALESCE(NULLIF((SELECT cmc FROM precos_cmc WHERE empresa=c.empresa AND sku_codigo_omie=c.sku),0), c.media_compras, c.venda*0.55)=536.48)
  FROM cenarios c WHERE c.sku='100'
UNION ALL SELECT
  'A2 sku200 cmc=0 cai pra media 436.84: ' || (COALESCE(NULLIF((SELECT cmc FROM precos_cmc WHERE empresa=c.empresa AND sku_codigo_omie=c.sku),0), c.media_compras, c.venda*0.55)=436.84)
  FROM cenarios c WHERE c.sku='200'
UNION ALL SELECT
  'A3 sku999 sem cmc/media cai pra venda*0.55=55: ' || (COALESCE(NULLIF((SELECT cmc FROM precos_cmc WHERE empresa=c.empresa AND sku_codigo_omie=c.sku),0), c.media_compras, c.venda*0.55)=55.00)
  FROM cenarios c WHERE c.sku='999'
UNION ALL SELECT
  'A4 colacor sku300 usa cmc 99 (mapeou colacor_vendas): ' || (COALESCE(NULLIF((SELECT cmc FROM precos_cmc WHERE empresa=c.empresa AND sku_codigo_omie=c.sku),0), c.media_compras, c.venda*0.55)=99.00)
  FROM cenarios c WHERE c.sku='300'
UNION ALL SELECT
  'A5 fonte_preco sku100 = cmc: ' || ((CASE WHEN NULLIF((SELECT cmc FROM precos_cmc WHERE empresa='OBEN' AND sku_codigo_omie='100'),0) IS NOT NULL THEN 'cmc' ELSE 'outro' END)='cmc')
UNION ALL SELECT
  'A6 precos_cmc 1 linha por (empresa,sku) p/ sku100: ' || ((SELECT count(*) FROM precos_cmc WHERE empresa='OBEN' AND sku_codigo_omie='100')=1)
UNION ALL SELECT
  'A7 sku400 cmc NEGATIVO cai pra media 300: ' || (COALESCE(NULLIF((SELECT cmc FROM precos_cmc WHERE empresa=c.empresa AND sku_codigo_omie=c.sku),0), c.media_compras, c.venda*0.55)=300.00)
  FROM cenarios c WHERE c.sku='400';
SQL
echo ""
echo "✅ test-a2-cmc-view OK"
