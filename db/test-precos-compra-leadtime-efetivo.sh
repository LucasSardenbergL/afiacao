#!/usr/bin/env bash
# ╔══════════════════════════════════════════════════════════════════════════════╗
# ║  PROVA — CTE precos_compra de v_sku_parametros_sugeridos lê a fonte por NFe   ║
# ║  bash db/test-precos-compra-leadtime-efetivo.sh > /tmp/t.log 2>&1; echo $?    ║
# ║  (NÃO pipe pra tail — engole o exit≠0; §2 do CLAUDE.md.)                      ║
# ║                                                                               ║
# ║  Lei de Ferro:                                                                ║
# ║   1. Aplica as migrations REAIS (a Fase 0 que cria v_sku_leadtime_efetivo +   ║
# ║      a desta entrega). Os stubs são só as deps periféricas que a view lê.     ║
# ║   2. Assert negativo captura a condição esperada; nada de WHEN OTHERS mudo.   ║
# ║   3. Falsificação: sabota a fonte → exige VERMELHO → restaura.                ║
# ╚══════════════════════════════════════════════════════════════════════════════╝
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PGVER=17
PGBIN="/opt/homebrew/opt/postgresql@${PGVER}/bin"
PORT="${PGPORT_TEST:-5462}"
SLUG="precoscompra"
DATA="$(mktemp -d "/tmp/pgtest-${SLUG}.XXXXXX")/data"
export LC_ALL=C LANG=C

[ -x "$PGBIN/initdb" ] || { echo "postgresql@${PGVER} ausente: brew install postgresql@${PGVER}"; exit 1; }
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
Pq() { P -tAq "$@"; }

P -q -f "$REPO_ROOT/db/stubs-supabase.sql"
P -q <<'SQL'
CREATE OR REPLACE FUNCTION auth.uid()  RETURNS uuid LANGUAGE sql STABLE AS $f$ SELECT nullif(current_setting('test.uid', true), '')::uuid $f$;
ALTER ROLE service_role BYPASSRLS;
SQL

PASS=0; FAIL=0
ok()  { PASS=$((PASS+1)); echo "  ✅ $1"; }
bad() { FAIL=$((FAIL+1)); echo "  ❌ $1"; }
eq()  { if [ "$2" = "$3" ]; then ok "$1 (=$2)"; else bad "$1 — esperado [$3], veio [$2]"; fi; }

echo "═══ setup pronto (PG17 :$PORT) ═══"

# ══════════════════════════════════════════════════════════════════════════════
# ZONA 1 — PRÉ-REQUISITOS (tipos/colunas conferidos na PROD via psql-ro, 2026-07-16)
# ══════════════════════════════════════════════════════════════════════════════
P -q <<'SQL'
CREATE TYPE empresa_reposicao AS ENUM ('OBEN','COLACOR');
CREATE TYPE status_pedido_compra AS ENUM ('aberto','faturado','recebido');

CREATE TABLE purchase_orders_tracking (
  id uuid PRIMARY KEY, empresa empresa_reposicao, omie_codigo_pedido bigint,
  fornecedor_nome text, nfe_chave_acesso text, raw_data jsonb
);
CREATE TABLE sku_leadtime_history (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tracking_id uuid, empresa empresa_reposicao, sku_codigo_omie bigint,
  sku_codigo text, sku_descricao text, sku_unidade text, sku_ncm text,
  fornecedor_codigo_omie bigint, fornecedor_nome text, grupo_leadtime text,
  quantidade_pedida numeric, quantidade_recebida numeric,
  valor_unitario numeric, valor_total numeric,
  t1_data_pedido timestamptz, t2_data_faturamento timestamptz,
  t3_data_cte timestamptz, t4_data_recebimento timestamptz,
  lt_bruto_dias_uteis int, lt_faturamento_dias_uteis int, lt_logistica_dias_uteis int,
  created_at timestamptz DEFAULT now(), updated_at timestamptz DEFAULT now(),
  origem_compra text
);

-- v_sku_leadtime_history_normal: corpo REAL da prod (pg_get_viewdef).
CREATE OR REPLACE VIEW public.v_sku_leadtime_history_normal WITH (security_invoker = on) AS
 SELECT id, tracking_id, empresa, sku_codigo_omie, sku_codigo, sku_descricao, sku_unidade,
    sku_ncm, fornecedor_codigo_omie, fornecedor_nome, grupo_leadtime, quantidade_pedida,
    quantidade_recebida, valor_unitario, valor_total, t1_data_pedido, t2_data_faturamento,
    t3_data_cte, t4_data_recebimento, lt_bruto_dias_uteis, lt_faturamento_dias_uteis,
    lt_logistica_dias_uteis, created_at, updated_at, origem_compra
   FROM sku_leadtime_history
  WHERE origem_compra = 'normal'::text;

-- deps periféricas (stub: só as colunas que a view alvo lê, com os tipos da prod)
CREATE TABLE empresa_configuracao_custos (
  empresa text, selic_anual numeric, spread_oportunidade numeric, armazenagem_fisica numeric,
  custo_pedido_manual numeric, custo_pedido_api numeric, modo_pedido text,
  z_classe_a numeric, z_classe_b numeric, z_classe_c numeric
);
CREATE TABLE venda_items_history (
  empresa text, sku_codigo_omie bigint, data_emissao date, quantidade numeric, valor_total numeric
);
CREATE TABLE inventory_position (
  omie_codigo_produto bigint, cmc numeric, account text, synced_at timestamptz
);
CREATE TABLE fornecedor_grupo_producao (empresa text, fornecedor_nome text, grupo_codigo text);
CREATE TABLE fornecedor_habilitado_reposicao (empresa text, fornecedor_nome text, habilitado boolean);

CREATE VIEW v_sku_classificacao_abc_xyz AS SELECT
  NULL::text AS empresa, NULL::bigint AS sku_codigo_omie, NULL::text AS sku_descricao,
  NULL::bigint AS num_ordens, NULL::numeric AS valor_total_90d, NULL::numeric AS demanda_media_diaria,
  NULL::numeric AS qtde_media_por_ordem, NULL::numeric AS qtde_desvio_por_ordem,
  NULL::numeric AS coef_variacao_ordem, NULL::text AS classe_abc_proposta,
  NULL::text AS classe_xyz_proposta, NULL::text AS classe_consolidada_proposta WHERE false;
CREATE VIEW v_sku_demanda_rajada AS SELECT
  NULL::text AS empresa, NULL::bigint AS sku_codigo_omie, NULL::numeric AS p90_diario,
  NULL::numeric AS p95_diario, NULL::numeric AS p99_diario, NULL::numeric AS p90_quando_vende,
  NULL::numeric AS p95_quando_vende, NULL::numeric AS pico_maximo_dia,
  NULL::bigint AS dias_com_movimento, NULL::numeric AS valor_total_180d WHERE false;
CREATE VIEW v_sku_lt_teorico AS SELECT
  NULL::text AS empresa, NULL::text AS sku_codigo_omie, NULL::text AS grupo_codigo,
  NULL::bigint AS lt_total_teorico_dias_uteis WHERE false;
CREATE VIEW v_sku_sigma_demanda AS SELECT
  NULL::text AS empresa, NULL::text AS sku_codigo_omie, NULL::numeric AS sigma_demanda_diaria WHERE false;
SQL

# A classificação ABC é a espinha do FROM da view alvo — precisa ser TABELA pra semear.
P -q <<'SQL'
DROP VIEW v_sku_classificacao_abc_xyz;
CREATE TABLE v_sku_classificacao_abc_xyz (
  empresa text, sku_codigo_omie bigint, sku_descricao text, num_ordens bigint,
  valor_total_90d numeric, demanda_media_diaria numeric, qtde_media_por_ordem numeric,
  qtde_desvio_por_ordem numeric, coef_variacao_ordem numeric, classe_abc_proposta text,
  classe_xyz_proposta text, classe_consolidada_proposta text
);
SQL

echo ""
echo "═══ 1. Aplicando as migrations REAIS (Lei #1) ═══"
# Fase 0 (#1343): cria v_sku_leadtime_efetivo + v_sku_leadtime_estatisticas
P -q -f "$REPO_ROOT/supabase/migrations/20260716180000_leadtime_efetivo_dedup_nfe.sql"
echo "  20260716180000 (Fase 0) aplicada — v_sku_leadtime_efetivo existe"

# ══════════════════════════════════════════════════════════════════════════════
# ZONA 2 — CENÁRIO. Cada SKU isola UM invariante.
#
#  SKU 1001 "multiplicidade": NFe-X faturou 3 pedidos (3 cópias, todas concordam)
#           + NFe-Y única.  X: 100/10 = 10/un   Y: 100/5 = 20/un
#           crua    -> AVG(10,10,10,20) = 12.5  e n=4   (ponderado pela cópia)
#           efetiva -> AVG(10,20)       = 15.0  e n=2   (1 obs por NFe)
#  SKU 1002 "divergência": NFe-Z, 2 cópias que CONCORDAM no valor e DIVERGEM na
#           quantidade -> a efetiva emite quantidade_recebida=NULL -> a obs sai
#           pelo `> 0`. É a ÚNICA obs do SKU => o SKU some da CTE.
#           Tem venda => fonte_preco deve DEGRADAR p/ 'venda_estimado', não mentir.
#  SKU 1003 "cmc-first": tem cmc => preco_item_eoq ancora no cmc, imune à troca.
#  SKU 1004 "escopo": origem_compra='oportunidade_promo' => fora nas DUAS fontes.
# ══════════════════════════════════════════════════════════════════════════════
P -q <<'SQL'
INSERT INTO empresa_configuracao_custos VALUES ('OBEN', 10, 5, 5, 100, 50, 'manual', 2.05, 1.65, 1.28);

INSERT INTO purchase_orders_tracking(id, empresa, omie_codigo_pedido, nfe_chave_acesso) VALUES
  ('aaaaaaaa-0000-0000-0000-000000000001','OBEN', 1, 'NFE-X'),
  ('aaaaaaaa-0000-0000-0000-000000000002','OBEN', 2, 'NFE-X'),
  ('aaaaaaaa-0000-0000-0000-000000000003','OBEN', 3, 'NFE-X'),
  ('aaaaaaaa-0000-0000-0000-000000000004','OBEN', 4, 'NFE-Y'),
  ('bbbbbbbb-0000-0000-0000-000000000001','OBEN', 5, 'NFE-Z'),
  ('bbbbbbbb-0000-0000-0000-000000000002','OBEN', 6, 'NFE-Z'),
  ('cccccccc-0000-0000-0000-000000000001','OBEN', 7, 'NFE-W'),
  ('dddddddd-0000-0000-0000-000000000001','OBEN', 8, 'NFE-V');

-- SKU 1001: NFe-X replicada 3x (concordam) + NFe-Y única
INSERT INTO sku_leadtime_history(tracking_id, empresa, sku_codigo_omie, fornecedor_nome,
    quantidade_recebida, valor_total, t1_data_pedido, lt_bruto_dias_uteis, origem_compra) VALUES
  ('aaaaaaaa-0000-0000-0000-000000000001','OBEN',1001,'FORN-A', 10, 100, now(), 5, 'normal'),
  ('aaaaaaaa-0000-0000-0000-000000000002','OBEN',1001,'FORN-A', 10, 100, now(), 5, 'normal'),
  ('aaaaaaaa-0000-0000-0000-000000000003','OBEN',1001,'FORN-A', 10, 100, now(), 5, 'normal'),
  ('aaaaaaaa-0000-0000-0000-000000000004','OBEN',1001,'FORN-A',  5, 100, now(), 5, 'normal');

-- SKU 1002: NFe-Z 2 cópias, concordam no valor, DIVERGEM na quantidade
INSERT INTO sku_leadtime_history(tracking_id, empresa, sku_codigo_omie, fornecedor_nome,
    quantidade_recebida, valor_total, t1_data_pedido, lt_bruto_dias_uteis, origem_compra) VALUES
  ('bbbbbbbb-0000-0000-0000-000000000001','OBEN',1002,'FORN-A', 10, 100, now(), 5, 'normal'),
  ('bbbbbbbb-0000-0000-0000-000000000002','OBEN',1002,'FORN-A', 20, 100, now(), 5, 'normal');

-- SKU 1003: cmc-first
INSERT INTO sku_leadtime_history(tracking_id, empresa, sku_codigo_omie, fornecedor_nome,
    quantidade_recebida, valor_total, t1_data_pedido, lt_bruto_dias_uteis, origem_compra) VALUES
  ('cccccccc-0000-0000-0000-000000000001','OBEN',1003,'FORN-A', 10, 100, now(), 5, 'normal');
INSERT INTO inventory_position(omie_codigo_produto, cmc, account, synced_at)
  VALUES (1003, 99, 'oben', now());

-- SKU 1004: compra de oportunidade — deve ficar fora nas DUAS fontes
INSERT INTO sku_leadtime_history(tracking_id, empresa, sku_codigo_omie, fornecedor_nome,
    quantidade_recebida, valor_total, t1_data_pedido, lt_bruto_dias_uteis, origem_compra) VALUES
  ('dddddddd-0000-0000-0000-000000000001','OBEN',1004,'FORN-A', 10, 1000, now(), 5, 'oportunidade_promo');

-- venda: dá a SKU 1002 um fallback honesto ('venda_estimado') quando perder o preço
INSERT INTO venda_items_history(empresa, sku_codigo_omie, data_emissao, quantidade, valor_total) VALUES
  ('OBEN',1001, CURRENT_DATE-10, 1, 50),
  ('OBEN',1002, CURRENT_DATE-10, 1, 50),
  ('OBEN',1003, CURRENT_DATE-10, 1, 50),
  ('OBEN',1004, CURRENT_DATE-10, 1, 50);

INSERT INTO v_sku_classificacao_abc_xyz VALUES
  ('OBEN',1001,'SKU 1001', 5, 1000, 2, 1, 0.1, 0.1, 'A','X','AX'),
  ('OBEN',1002,'SKU 1002', 5, 1000, 2, 1, 0.1, 0.1, 'A','X','AX'),
  ('OBEN',1003,'SKU 1003', 5, 1000, 2, 1, 0.1, 0.1, 'A','X','AX'),
  ('OBEN',1004,'SKU 1004', 5, 1000, 2, 1, 0.1, 0.1, 'A','X','AX');

INSERT INTO fornecedor_habilitado_reposicao VALUES ('OBEN','FORN-A', true);
SQL

# leitura da CTE por SKU, direto da view alvo
preco() { Pq -c "SELECT COALESCE(round(preco_compra_real,4)::text,'NULL') FROM v_sku_parametros_sugeridos WHERE sku_codigo_omie=$1;"; }
ncomp() { Pq -c "SELECT COALESCE(n_compras::text,'NULL')              FROM v_sku_parametros_sugeridos WHERE sku_codigo_omie=$1;"; }
fonte() { Pq -c "SELECT COALESCE(fonte_preco,'NULL')                  FROM v_sku_parametros_sugeridos WHERE sku_codigo_omie=$1;"; }
eoq()   { Pq -c "SELECT COALESCE(round(preco_item_eoq,4)::text,'NULL') FROM v_sku_parametros_sugeridos WHERE sku_codigo_omie=$1;"; }

echo ""
echo "═══ 2. O DEFEITO reproduzido (view ANTIGA: MESMO corpo, fonte crua) ═══"
# A view "antiga" é derivada da PRÓPRIA migration pelo sed inverso (efetiva -> normal).
# Duas razões:
#  1. Auto-contido: não depende de colar aqui as 326 linhas do corpo de prod.
#  2. É o teste que importa: a antiga nasce com as MESMAS 51 colunas, então o
#     CREATE OR REPLACE da migration real é exercitado contra o contrato de verdade
#     (renomear/reordenar coluna aborta — foi o que pegou o stub de 6 colunas que
#     este harness tinha antes). A ÚNICA diferença entre as duas é a fonte da CTE.
sed 's/v_sku_leadtime_efetivo/v_sku_leadtime_history_normal/g' \
  "$REPO_ROOT/supabase/migrations/20260717020000_precos_compra_leadtime_efetivo.sql" > /tmp/pr-b-antiga.sql
P -q -f /tmp/pr-b-antiga.sql
echo "  view antiga instalada (CTE lendo v_sku_leadtime_history_normal)"
eq "SKU 1001: preço PONDERADO pela cópia (defeito)"    "$(preco 1001)" "12.5000"
eq "SKU 1001: n_compras conta LINHA, não NFe (defeito)" "$(ncomp 1001)" "4"
eq "SKU 1002: preço fabricado sobre cópias divergentes" "$(preco 1002)" "7.5000"
eq "SKU 1002: fonte_preco afirma 'compra_real'"         "$(fonte 1002)" "compra_real"
eq "SKU 1004: compra de oportunidade fora (escopo)"     "$(preco 1004)" "NULL"

echo ""
echo "═══ 3. Aplicando a migration DESTA entrega (Lei #1) ═══"
# a migration real carrega o corpo de prod inteiro; aqui ela sobrepõe a view antiga.
if P -q -f "$REPO_ROOT/supabase/migrations/20260717020000_precos_compra_leadtime_efetivo.sql" > /tmp/pr-b-apply.log 2>&1; then
  echo "  20260717020000 aplicada"
else
  echo "  ❌ a migration REAL não aplicou:"; sed -n '1,12p' /tmp/pr-b-apply.log; FAIL=$((FAIL+1))
fi

echo ""
echo "═══ 4. O CONSERTO ═══"
eq "SKU 1001: preço passa a contar NFe (12.5 -> 15)"  "$(preco 1001)" "15.0000"
eq "SKU 1001: n_compras conta NFe, não linha (4 -> 2)" "$(ncomp 1001)" "2"
# ausente != zero: a NFe de quantidade incognoscível SAI; não vira 0 nem representante.
eq "SKU 1002: cópias divergentes -> preço NULL, não fabricado" "$(preco 1002)" "NULL"
eq "SKU 1002: n_compras NULL (nenhuma NFe utilizável)"         "$(ncomp 1002)" "NULL"
eq "SKU 1002: fonte_preco DEGRADA honestamente"                "$(fonte 1002)" "venda_estimado"
eq "SKU 1002: preco_item_eoq cai no fallback de venda (55%)"   "$(eoq 1002)"   "27.5000"
# cmc-first: a troca de fonte não pode mexer em quem ancora no cmc
eq "SKU 1003: fonte_preco segue 'cmc'"          "$(fonte 1003)" "cmc"
eq "SKU 1003: preco_item_eoq segue o cmc (=99)" "$(eoq 1003)"   "99.0000"
# escopo: a view efetiva lê da normal => NÃO herda filtro de brinde; oportunidade segue fora
eq "SKU 1004: oportunidade continua fora (escopo intacto)" "$(preco 1004)" "NULL"
# contrato do CREATE OR REPLACE
eq "view manteve security_invoker=on" \
   "$(Pq -c "SELECT (reloptions::text ILIKE '%security_invoker=on%')::text FROM pg_class WHERE relname='v_sku_parametros_sugeridos';")" "true"
eq "view expõe as 51 colunas da prod" \
   "$(Pq -c "SELECT count(*)::text FROM information_schema.columns WHERE table_name='v_sku_parametros_sugeridos';")" "51"
eq "ordem das colunas preservada (1ª/última)" \
   "$(Pq -c "SELECT string_agg(column_name,',') FROM (SELECT column_name FROM information_schema.columns WHERE table_name='v_sku_parametros_sugeridos' AND ordinal_position IN (1,51) ORDER BY ordinal_position) s;")" \
   "empresa,estoque_seguranca_sugerido"

echo ""
echo "═══ 5. FALSIFICAÇÃO (Lei #3) — sabota e EXIGE vermelho ═══"
# Sabotagem A: volta a fonte da CTE p/ a view crua-por-linha. Os asserts do conserto
# DEVEM ficar vermelhos — senão eles não estavam medindo a dedup.
P -q -f /tmp/pr-b-antiga.sql > /tmp/pr-b-sabota.log 2>&1 || true
p="$(preco 1001)"; n="$(ncomp 1001)"
if [ "$p" = "15.0000" ] || [ "$n" = "2" ]; then
  bad "FALSIFICAÇÃO A: sabotei a fonte e o assert seguiu VERDE (preço=$p n=$n) — sem dente"
else
  ok "FALSIFICAÇÃO A: com a fonte crua o preço volta a $p e n a $n — os asserts têm dente"
fi
P -q -f "$REPO_ROOT/supabase/migrations/20260717020000_precos_compra_leadtime_efetivo.sql" >/dev/null 2>&1
eq "restaurado após falsificação A" "$(preco 1001)" "15.0000"

# Sabotagem B: fabrica preço onde a quantidade é incognoscível (COALESCE(qtd,1)) — a
# tentação exata que o "ausente != zero" proíbe. O assert do 1002 DEVE ficar vermelho.
P -q <<'SQL' >/dev/null 2>&1
CREATE OR REPLACE VIEW public.v_sku_leadtime_efetivo_fabricado AS
  SELECT empresa, sku_codigo_omie, dedup_key, COALESCE(quantidade_recebida, 1) AS quantidade_recebida, valor_total
  FROM v_sku_leadtime_efetivo;
SQL
p_fab="$(Pq -c "SELECT COALESCE(round(avg(valor_total/NULLIF(quantidade_recebida,0)),4)::text,'NULL') FROM v_sku_leadtime_efetivo_fabricado WHERE sku_codigo_omie=1002 AND quantidade_recebida>0 AND valor_total>0;")"
if [ "$p_fab" = "NULL" ]; then
  bad "FALSIFICAÇÃO B: fabriquei quantidade e ainda deu NULL — o cenário não exercita a divergência"
else
  ok "FALSIFICAÇÃO B: fabricar quantidade inventa preço $p_fab p/ o SKU 1002 — é isto que o NULL evita"
fi
P -q -c "DROP VIEW public.v_sku_leadtime_efetivo_fabricado;" >/dev/null 2>&1

# Sabotagem C: o assert de escopo tem dente? Promove a compra de oportunidade a 'normal'
# e exija que o SKU 1004 APAREÇA — provando que é o filtro, e não o vazio, que o mantinha fora.
P -q -c "UPDATE sku_leadtime_history SET origem_compra='normal' WHERE sku_codigo_omie=1004;"
if [ "$(preco 1004)" = "NULL" ]; then
  bad "FALSIFICAÇÃO C: virei a oportunidade em 'normal' e o SKU seguiu fora — o assert de escopo é vazio"
else
  ok "FALSIFICAÇÃO C: como 'normal' o SKU 1004 entra (=$(preco 1004)) — quem o excluía era o filtro"
fi
P -q -c "UPDATE sku_leadtime_history SET origem_compra='oportunidade_promo' WHERE sku_codigo_omie=1004;"
eq "restaurado após falsificação C" "$(preco 1004)" "NULL"

echo ""
echo "═══════════════════════════════════════════"
echo "  PASS=$PASS  FAIL=$FAIL"
echo "═══════════════════════════════════════════"
[ "$FAIL" -eq 0 ] || exit 1
