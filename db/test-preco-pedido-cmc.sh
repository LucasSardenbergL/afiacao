#!/usr/bin/env bash
# Testa A2-parte-2 (preco_unitario do pedido = cmc-primeiro) num PG17 descartável.
# (1) CREATE OR REPLACE da RPC sobre o snapshot → parseia + íntegra (pega erro de transcrição grosso).
# (2) END-TO-END: semeia 1 SKU OBEN, chama gerar_pedidos_sugeridos_ciclo, confere:
#     - preco_unitario do item = cmc (536), NÃO a média (436);  ← a mudança
#     - cmc=0 e cmc<0 caem pra média (não viram 0);             ← guard CASE WHEN cmc>0
#     - qtde_final = ceil(max - estoque) e filtros sobreviveram à transcrição (prova funcional).
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PGVER=17
PGBIN="/opt/homebrew/opt/postgresql@${PGVER}/bin"
PORT=5435
DATA="$(mktemp -d /tmp/pgtest-precoped.XXXXXX)/data"
export LC_ALL=C LANG=C
MIG="$REPO_ROOT/supabase/migrations/20260606180000_reposicao_preco_pedido_cmc.sql"

[ -x "$PGBIN/initdb" ] || { echo "postgresql@${PGVER} ausente"; exit 1; }
CELLAR="$(brew --prefix postgresql@${PGVER})"
cp -Rn "$CELLAR"/share/postgresql/. "/opt/homebrew/share/postgresql@${PGVER}/" 2>/dev/null || true
mkdir -p "/opt/homebrew/lib/postgresql@${PGVER}"
cp -Rn "$CELLAR"/lib/postgresql/. "/opt/homebrew/lib/postgresql@${PGVER}/" 2>/dev/null || true
cleanup() { "$PGBIN/pg_ctl" -D "$DATA" stop -m immediate >/dev/null 2>&1 || true; rm -rf "$(dirname "$DATA")"; }
trap cleanup EXIT

"$PGBIN/initdb" -D "$DATA" -U postgres -E UTF8 --locale=C >/dev/null
"$PGBIN/pg_ctl" -D "$DATA" -o "-p $PORT -k /tmp" -l /tmp/pg-precoped.log -w start >/dev/null
"$PGBIN/createdb" -p "$PORT" -h /tmp -U postgres pp_verify
P() { "$PGBIN/psql" -p "$PORT" -h /tmp -U postgres -d pp_verify "$@"; }

RR="$(mktemp /tmp/snap-pp.XXXXXX.sql)"
sed -E 's/^(CREATE SCHEMA public;)/-- \1/' "$REPO_ROOT/supabase/schema-snapshot.sql" \
  | grep -vE '^\\(un)?restrict ' > "$RR"
P -v ON_ERROR_STOP=1 -q -f "$REPO_ROOT/db/stubs-supabase.sql"
P -v ON_ERROR_STOP=1 -q -f "$REPO_ROOT/supabase/schema-extensions-prelude.sql"
P --single-transaction -v ON_ERROR_STOP=1 -q -f "$RR"
rm -f "$RR"
echo "SNAPSHOT OK."

# ⚠️ Snapshot (Jun 5) STALE: faltam colunas recentes que a RPC viva referencia (§6 picking-bridge).
# Em prod elas EXISTEM (#575 tipo_produto, #608 minimo_forcado_manual). Patch p/ casar prod.
P -v ON_ERROR_STOP=1 -q <<'SQL'
ALTER TABLE public.omie_products ADD COLUMN IF NOT EXISTS tipo_produto text;
ALTER TABLE public.sku_parametros ADD COLUMN IF NOT EXISTS minimo_forcado_manual numeric;
-- FKs irrelevantes ao que testamos (lógica de preço da RPC) — dropo no PG17 descartável p/ semear livre
ALTER TABLE public.sku_leadtime_history DROP CONSTRAINT IF EXISTS sku_leadtime_history_tracking_id_fkey;
SQL
echo "PATCH colunas stale OK."

# (1) CREATE OR REPLACE → parseia + resolve colunas (transcrição grossa quebraria aqui).
P -v ON_ERROR_STOP=1 -q -f "$MIG"
echo "REPLACE OK (RPC parseia + íntegra)."
P -v ON_ERROR_STOP=1 -tA -c "SELECT 'tem_cmc_first=' || (CASE WHEN pg_get_functiondef('public.gerar_pedidos_sugeridos_ciclo(text,date)'::regprocedure) ILIKE '%CASE WHEN ip.cmc > 0 THEN ip.cmc END%' THEN 'sim' ELSE 'NAO' END);"

# (2) END-TO-END
echo ""
echo "END-TO-END (asserts):"
P -v ON_ERROR_STOP=1 -tA <<'SQL'
-- limpa o que vamos usar
TRUNCATE pedido_compra_item, pedido_compra_sugerido CASCADE;
DELETE FROM sku_parametros        WHERE empresa='OBEN' AND sku_codigo_omie::text IN ('100','200','300');
DELETE FROM inventory_position    WHERE omie_codigo_produto::text IN ('100','200','300');
DELETE FROM sku_leadtime_history  WHERE empresa='OBEN' AND sku_codigo_omie::text IN ('100','200','300');
DELETE FROM sku_estoque_atual     WHERE empresa='OBEN' AND sku_codigo_omie::text IN ('100','200','300');
DELETE FROM omie_products         WHERE account='oben' AND omie_codigo_produto::text IN ('100','200','300');
DELETE FROM fornecedor_habilitado_reposicao WHERE empresa='OBEN' AND fornecedor_nome IN ('FORN A');

-- omie_products: 3 SKUs Produto NORMAL ('01'); a presença de tipo_produto NOT NULL satisfaz o guard
INSERT INTO omie_products (omie_codigo_produto, account, codigo, descricao, ativo, tipo_produto)
VALUES (100,'oben','PRD100','PROD 100',true,'01'),(200,'oben','PRD200','PROD 200',true,'01'),(300,'oben','PRD300','PROD 300',true,'01')
ON CONFLICT (omie_codigo_produto, account) DO UPDATE SET tipo_produto=EXCLUDED.tipo_produto, ativo=true, descricao=EXCLUDED.descricao;

-- sku_parametros: habilitados, automatica, fornecedor, ponto_pedido=10, max=100
INSERT INTO sku_parametros (empresa, sku_codigo_omie, sku_descricao, fornecedor_nome, habilitado_reposicao_automatica, tipo_reposicao, ponto_pedido, estoque_maximo)
VALUES ('OBEN',100,'PROD 100','FORN A',true,'automatica',10,100),
       ('OBEN',200,'PROD 200','FORN A',true,'automatica',10,100),
       ('OBEN',300,'PROD 300','FORN A',true,'automatica',10,100);

-- inventory_position: 100 cmc=536 (usa cmc) ; 200 cmc=0 (cai média) ; 300 cmc=-5 (cai média)
INSERT INTO inventory_position (omie_codigo_produto, account, saldo, cmc, synced_at)
VALUES (100,'oben',5,536.00,now()),(200,'oben',5,0,now()),(300,'oben',5,-5.00,now());

-- sku_leadtime_history: média de compras (valor_total/qtde) — 100→436,80 ; 200→100 ; 300→200
INSERT INTO sku_leadtime_history (tracking_id, empresa, sku_codigo_omie, t1_data_pedido, quantidade_recebida, valor_total)
VALUES (gen_random_uuid(),'OBEN',100,now(),10,4368.00),
       (gen_random_uuid(),'OBEN',200,now(),10,1000.00),
       (gen_random_uuid(),'OBEN',300,now(),10,2000.00);

-- sku_estoque_atual: estoque_fisico=5 (<= ponto_pedido 10 → precisa repor)
INSERT INTO sku_estoque_atual (empresa, sku_codigo_omie, estoque_fisico, estoque_pendente_entrada)
VALUES ('OBEN',100,5,0),('OBEN',200,5,0),('OBEN',300,5,0);

-- fornecedor habilitado (fornece horario_corte_pedido)
INSERT INTO fornecedor_habilitado_reposicao (id, empresa, fornecedor_nome, habilitado, horario_corte_pedido)
VALUES (9001,'OBEN','FORN A',true,'10:00:00');

-- chama o motor
SELECT * FROM public.gerar_pedidos_sugeridos_ciclo('OBEN', CURRENT_DATE);

-- asserts sobre os itens gerados
SELECT 'B1 sku100 preco_unitario = cmc 536 (NÃO 436): ' || (preco_unitario = 536.00)
  FROM pedido_compra_item WHERE sku_codigo_omie::text='100'
UNION ALL SELECT 'B2 sku200 cmc=0 cai pra média 100: ' || (preco_unitario = 100.00)
  FROM pedido_compra_item WHERE sku_codigo_omie::text='200'
UNION ALL SELECT 'B3 sku300 cmc<0 cai pra média 200: ' || (preco_unitario = 200.00)
  FROM pedido_compra_item WHERE sku_codigo_omie::text='300'
UNION ALL SELECT 'B4 sku100 qtde_final = ceil(100-5)=95 (qtde-inteira viva): ' || (qtde_final = 95)
  FROM pedido_compra_item WHERE sku_codigo_omie::text='100'
UNION ALL SELECT 'B5 sku100 valor_linha = 95*536 = 50920: ' || (valor_linha = 50920.00)
  FROM pedido_compra_item WHERE sku_codigo_omie::text='100'
UNION ALL SELECT 'B6 gerou 3 itens (filtros sobreviveram): ' || ((SELECT count(*) FROM pedido_compra_item)=3);
SQL
echo ""
echo "✅ test-preco-pedido-cmc OK"
