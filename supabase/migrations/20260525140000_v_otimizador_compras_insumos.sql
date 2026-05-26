-- supabase/migrations/20260525140000_v_otimizador_compras_insumos.sql
-- Otimizador de Compras: view de INSUMOS (só junta fatos; nenhuma regra financeira — a matemática do
-- net-R$ marginal vive no helper TS testável src/lib/reposicao/compras-otimizador-helpers.ts).
-- Estende v_oportunidade_economica_hoje com o lote mínimo do fornecedor + prazo padrão + frete.
-- security_invoker=on (herda a RLS das fontes). Idempotente (CREATE OR REPLACE).
--
-- DESVIOS DO SCHEMA ASSUMIDO NO BRIEFING (confirmados em supabase/schema-snapshot.sql):
--  * As configs de fornecedor (prazo/custo adicional) NÃO têm fornecedor_codigo_omie — a chave natural é
--    fornecedor_nome (+ empresa). v_oportunidade_economica_hoje também não expõe fornecedor_codigo_omie,
--    então os joins usam o.fornecedor_nome diretamente. (sku_parametros TEM fornecedor_codigo_omie, mas
--    não há onde casá-lo nas configs — fica fora.)
--  * fornecedor_custo_adicional_config é EAV (colunas tipo/valor; tipo IN
--    ('frete_perc_valor','frete_fixo','taxa_pedido')) — não há 3 colunas separadas. Faço o pivot via
--    agregação condicional num CTE antes do join. A "taxa de pedido" (tipo='taxa_pedido') é exposta como
--    frete_taxa_pedido.
--  * Filtro ativo=true nas duas configs (descartar linhas desativadas).
--
-- SEMÂNTICA: custo_capital_efetivo_perc (de v_oportunidade_economica_hoje) é
-- cm_anual*100 = (selic_anual + spread_oportunidade + armazenagem_fisica), ou seja PERCENTUAL AO ANO
-- (%/ano), não por período. O frontend deve dividir por 100 para obter a fração anual.
CREATE OR REPLACE VIEW v_otimizador_compras_insumos
WITH (security_invoker = on) AS
WITH frete AS (
  SELECT
    cac.empresa,
    cac.fornecedor_nome,
    max(cac.valor) FILTER (WHERE cac.tipo = 'frete_perc_valor') AS frete_perc_valor,
    max(cac.valor) FILTER (WHERE cac.tipo = 'frete_fixo')       AS frete_fixo,
    max(cac.valor) FILTER (WHERE cac.tipo = 'taxa_pedido')      AS frete_taxa_pedido
  FROM fornecedor_custo_adicional_config cac
  WHERE cac.ativo = true
  GROUP BY cac.empresa, cac.fornecedor_nome
),
-- O join direto em fornecedor_prazo_pagamento_config (padrao=true AND ativo=true) pode devolver >1 linha
-- por fornecedor → duplicaria SKUs. Pré-agrega pra garantir 1 prazo por (empresa, fornecedor_nome).
prazo AS (
  SELECT
    ppc.empresa,
    ppc.fornecedor_nome,
    max(ppc.desconto_ou_encargo_perc) AS prazo_padrao_perc -- 1 linha por fornecedor (determinístico)
  FROM fornecedor_prazo_pagamento_config ppc
  WHERE ppc.padrao = true AND ppc.ativo = true
  GROUP BY ppc.empresa, ppc.fornecedor_nome
)
SELECT
  o.*,
  sp.lote_minimo_fornecedor,
  sp.fornecedor_codigo_omie,
  p.prazo_padrao_perc,
  f.frete_perc_valor,
  f.frete_fixo,
  f.frete_taxa_pedido
FROM v_oportunidade_economica_hoje o
LEFT JOIN sku_parametros sp
  ON sp.empresa = o.empresa AND sp.sku_codigo_omie = o.sku_codigo_omie
LEFT JOIN prazo p
  ON p.empresa = o.empresa AND p.fornecedor_nome = o.fornecedor_nome
LEFT JOIN frete f
  ON f.empresa = o.empresa AND f.fornecedor_nome = o.fornecedor_nome;

SELECT 'v_otimizador_compras_insumos OK' AS status, count(*) AS linhas FROM v_otimizador_compras_insumos;
