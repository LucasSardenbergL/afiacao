-- db/reposicao-demanda-insumos-bom.sql
-- ============================================================================
-- Demanda de INSUMOS DE PRODUÇÃO via explosão de BOM (money-path).
-- PR-1: só cria as views-fonte. NÃO religa nada → inerte por construção.
-- Spec: docs/superpowers/specs/2026-07-09-reposicao-demanda-insumos-producao-bom-design.md
-- NÃO vai em supabase/migrations/. Colar no SQL Editor do Lovable → Run.
-- ============================================================================

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. CANDIDATOS: tradução crua ficha(Colacor) → OBEN + cardinalidade + unidades.
--    Não filtra nada; é a base tanto do elegível quanto da quarentena.
--    O de-para de consolidação (N→1) é aplicado ao pai E ao componente, para
--    casar com o espaço de SKU de v_venda_items_history_efetivo (Codex #7:
--    hoje o DILUENTE PU DFA.4128LT é PAI na malha e está consolidado).
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE VIEW v_pcp_malha_oben_cand WITH (security_invoker = true) AS
WITH oben_ativo AS (
  -- 1 linha por codigo. `n` expõe a ambiguidade em vez de escondê-la (nunca LIMIT 1).
  SELECT codigo,
         count(*)                 AS n,
         min(omie_codigo_produto) AS omie
  FROM omie_products
  WHERE account = 'oben' AND ativo AND codigo IS NOT NULL AND btrim(codigo) <> ''
  GROUP BY codigo
),
col AS (
  SELECT omie_codigo_produto, codigo
  FROM omie_products
  WHERE account = 'colacor' AND codigo IS NOT NULL AND btrim(codigo) <> ''
),
efetivo AS (
  -- MESMO predicado de v_venda_items_history_efetivo (isola dos mapas da feature antiga)
  SELECT sku_codigo_antigo::bigint AS antigo, sku_codigo_novo::bigint AS novo
  FROM sku_substituicao
  WHERE empresa = 'OBEN' AND status = 'aplicada'
    AND acao_parametros = 'consolidar_demanda'
    -- [Codex #6] {1,18} limita a bigint: sem isso um código-lixo >18 dígitos passa no
    -- regex e o ::bigint estoura (out-of-range), derrubando a VIEW INTEIRA em runtime.
    AND sku_codigo_novo ~ '^\d{1,18}$' AND sku_codigo_antigo ~ '^\d{1,18}$'
)
SELECT
  m.pai_codigo,
  m.componente_codigo,
  m.quantidade,
  m.unidade                               AS un_ficha,
  COALESCE(m.perc_perda, 0)               AS perc_perda,
  pob.n                                   AS n_pai_oben,
  cob.n                                   AS n_comp_oben,
  COALESCE(ep.novo, pob.omie)             AS pai_oben,   -- espaço EFETIVO
  COALESCE(ec.novo, cob.omie)             AS comp_oben,  -- espaço EFETIVO
  cfin.unidade                            AS un_estoque, -- unidade do insumo FINAL
  cfin.ativo                              AS comp_ativo,
  pcol.codigo                             AS pai_codigo_prd,   -- NULL = pai não resolveu no catálogo colacor
  ccol.codigo                             AS comp_codigo_prd   -- NULL = componente não resolveu no catálogo colacor
FROM vw_pcp_malha_componentes m
LEFT JOIN col pcol ON pcol.omie_codigo_produto = m.pai_codigo
LEFT JOIN col ccol ON ccol.omie_codigo_produto = m.componente_codigo
LEFT JOIN oben_ativo pob ON pob.codigo = pcol.codigo
LEFT JOIN oben_ativo cob ON cob.codigo = ccol.codigo
LEFT JOIN efetivo    ep  ON ep.antigo   = pob.omie
LEFT JOIN efetivo    ec  ON ec.antigo   = cob.omie
LEFT JOIN omie_products cfin
       ON cfin.omie_codigo_produto = COALESCE(ec.novo, cob.omie)
      AND cfin.account = 'oben';

COMMENT ON VIEW v_pcp_malha_oben_cand IS
  'Tradução crua da ficha técnica (malha Omie, cód. Colacor) para o espaço de SKU OBEN efetivo. Não filtra: expõe cardinalidade (n_pai_oben/n_comp_oben) e unidades para os guards. Base de v_pcp_malha_oben e _quarentena.';

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. ELEGÍVEL: só o par inequívoco. Todo guard é fail-closed.
--    HAVING count(DISTINCT quantidade)=1 → duplicata exata deduplica;
--    par com qtdes divergentes NÃO passa (cai na quarentena). Codex #2.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE VIEW v_pcp_malha_oben WITH (security_invoker = true) AS
SELECT
  c.pai_oben,
  c.comp_oben,
  min(c.quantidade) AS quantidade,   -- seguro: HAVING garante que todas são iguais
  min(c.un_ficha)   AS unidade
FROM v_pcp_malha_oben_cand c
WHERE c.n_pai_oben = 1                       -- 0 = sumiu; >1 = ambíguo → quarentena
  AND c.n_comp_oben = 1
  AND c.pai_oben IS NOT NULL
  AND c.comp_oben IS NOT NULL
  AND c.pai_oben <> c.comp_oben              -- auto-referência dobraria a demanda
  AND c.quantidade > 0
  AND c.perc_perda = 0                       -- não aplicar fator de perda silencioso
  -- [Codex #7] normaliza caixa/espaço: 'L' vs 'l ' não deve virar falso-quarentena
  AND btrim(upper(c.un_ficha)) = btrim(upper(c.un_estoque))
  AND c.comp_ativo
GROUP BY c.pai_oben, c.comp_oben
HAVING count(DISTINCT c.quantidade) = 1
   -- [Codex #1] 2+ componentes DISTINTOS colapsando no mesmo comp_oben (via de-para) DEVERIAM
   -- somar, mas min() aqui subcompraria. Fail-closed: não entra no elegível, vai p/ quarentena.
   AND count(DISTINCT c.componente_codigo) = 1;

COMMENT ON VIEW v_pcp_malha_oben IS
  'Ficha técnica traduzida p/ OBEN, apenas pares inequívocos (cardinalidade 1:1, unidade da ficha = unidade de estoque, sem perda, sem auto-referência, qtde consistente). O excluído vive em v_pcp_malha_oben_quarentena com motivo.';

-- ─────────────────────────────────────────────────────────────────────────────
-- 3. QUARENTENA: nada some calado. Um motivo por linha excluída.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE VIEW v_pcp_malha_oben_quarentena WITH (security_invoker = true) AS
WITH classif AS (
  SELECT c.*,
    CASE
      WHEN c.pai_codigo_prd IS NULL                   THEN 'pai_nao_resolvido_colacor'
      WHEN c.comp_codigo_prd IS NULL                  THEN 'componente_nao_resolvido_colacor'
      WHEN c.n_pai_oben IS NULL OR c.n_pai_oben = 0   THEN 'pai_sem_par_oben_ativo'
      WHEN c.n_pai_oben > 1                           THEN 'pai_ambiguo_oben'
      WHEN c.n_comp_oben IS NULL OR c.n_comp_oben = 0 THEN 'componente_sem_par_oben_ativo'
      WHEN c.n_comp_oben > 1                          THEN 'componente_ambiguo_oben'
      WHEN NOT COALESCE(c.comp_ativo, false)          THEN 'componente_inativo_oben'
      WHEN c.pai_oben = c.comp_oben                   THEN 'auto_referencia'
      WHEN c.quantidade IS NULL OR c.quantidade <= 0  THEN 'quantidade_invalida'
      WHEN c.perc_perda <> 0                          THEN 'perc_perda_nao_suportada'
      WHEN btrim(upper(c.un_ficha)) IS DISTINCT FROM btrim(upper(c.un_estoque)) THEN 'unidade_divergente'
      ELSE NULL
    END AS motivo
  FROM v_pcp_malha_oben_cand c
)
SELECT pai_codigo, componente_codigo, pai_oben, comp_oben,
       quantidade, un_ficha, un_estoque, perc_perda, motivo
FROM classif WHERE motivo IS NOT NULL
UNION ALL
-- par de MESMA origem com quantidades divergentes (duplicata de sync divergente)
SELECT c.pai_codigo, c.componente_codigo, c.pai_oben, c.comp_oben,
       c.quantidade, c.un_ficha, c.un_estoque, c.perc_perda,
       'quantidade_divergente_no_par'::text
FROM classif c
WHERE c.motivo IS NULL
  AND (c.pai_oben, c.comp_oben) IN (
        SELECT pai_oben, comp_oben FROM classif
        WHERE motivo IS NULL
        GROUP BY 1,2 HAVING count(DISTINCT quantidade) > 1
                        AND count(DISTINCT componente_codigo) = 1)
UNION ALL
-- [Codex #1] 2+ componentes DISTINTOS resolvem para o mesmo insumo OBEN (via de-para).
-- Somariam, mas o elegível pegaria min → subcompra. Fail-closed: quarentena até haver
-- uma regra de soma explícita (fora do escopo do PR-1).
SELECT c.pai_codigo, c.componente_codigo, c.pai_oben, c.comp_oben,
       c.quantidade, c.un_ficha, c.un_estoque, c.perc_perda,
       'multiplos_componentes_mesmo_insumo'::text
FROM classif c
WHERE c.motivo IS NULL
  AND (c.pai_oben, c.comp_oben) IN (
        SELECT pai_oben, comp_oben FROM classif
        WHERE motivo IS NULL
        GROUP BY 1,2 HAVING count(DISTINCT componente_codigo) > 1);

COMMENT ON VIEW v_pcp_malha_oben_quarentena IS
  'Pares da ficha EXCLUÍDOS da explosão, com motivo. Fila de exceção: precisão>recall — insumo com unidade divergente ou cardinalidade ambígua não vira compra, mas fica visível aqui.';

-- ─────────────────────────────────────────────────────────────────────────────
-- Segurança (padrão P0 do repo — docs/agent/database.md §4; db/pcp-f1a-m2-nucleo.sql).
-- security_invoker=true (acima) faz as views respeitarem a RLS staff-only das
-- tabelas-base; o REVOKE fecha a anon-key pública (senão a ficha técnica vaza).
-- ─────────────────────────────────────────────────────────────────────────────
REVOKE ALL ON public.v_pcp_malha_oben_cand, public.v_pcp_malha_oben, public.v_pcp_malha_oben_quarentena FROM anon, PUBLIC;
GRANT SELECT ON public.v_pcp_malha_oben_cand, public.v_pcp_malha_oben, public.v_pcp_malha_oben_quarentena TO authenticated;

-- ─────────────────────────────────────────────────────────────────────────────
-- 4. DEMANDA EFETIVA = vendas diretas ⊕ consumo explodido.
--    Shape IDÊNTICO a v_venda_items_history_efetivo (as 4 views estatísticas do
--    PR-2 esperam este formato — ordem de colunas preservada).
--    NÃO altera v_venda_items_history_efetivo (preço/receita real seguem lá).
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE VIEW v_sku_demanda_efetiva WITH (security_invoker = true) AS
SELECT
  id, empresa, nfe_chave_acesso, nfe_numero, nfe_serie, data_emissao,
  cliente_codigo_omie, cliente_razao_social, cliente_cnpj_cpf, cliente_uf, cliente_cidade,
  sku_codigo_omie, sku_codigo, sku_descricao, sku_ncm, sku_unidade,
  quantidade, valor_unitario, valor_total, cfop, raw_data, created_at
FROM v_venda_items_history_efetivo

UNION ALL

SELECT
  -- id determinístico (view não pode usar gen_random_uuid: quebraria estabilidade)
  md5(v.id::text || ':' || mo.comp_oben::text)::uuid  AS id,
  v.empresa,
  v.nfe_chave_acesso,          -- ⚠️ HERDADA DO PAI: num_ordens=count(DISTINCT nfe).
                               --    Com NULL o insumo conta 0 ordens e NUNCA gradua.
  v.nfe_numero,
  v.nfe_serie,
  v.data_emissao,              -- a data do consumo = a da venda do pai
  v.cliente_codigo_omie, v.cliente_razao_social, v.cliente_cnpj_cpf,
  v.cliente_uf, v.cliente_cidade,
  mo.comp_oben                 AS sku_codigo_omie,   -- o INSUMO
  ins.codigo                   AS sku_codigo,
  ins.descricao                AS sku_descricao,
  ins.ncm                      AS sku_ncm,
  ins.unidade                  AS sku_unidade,       -- unidade do INSUMO (não 'UN' do pai)
  v.quantidade * mo.quantidade AS quantidade,        -- a explosão
  NULL::numeric                AS valor_unitario,    -- V3: receita honesta (ausente≠zero)
  NULL::numeric                AS valor_total,
  v.cfop, v.raw_data, v.created_at
FROM v_venda_items_history_efetivo v
JOIN v_pcp_malha_oben mo   ON mo.pai_oben = v.sku_codigo_omie
JOIN omie_products ins     ON ins.omie_codigo_produto = mo.comp_oben
                          AND ins.account = 'oben'
WHERE v.empresa = 'OBEN'    -- guard: nunca cruzar empresa
  AND v.quantidade > 0;   -- [Codex #10] devolução de tingidor não recompõe componente

COMMENT ON VIEW v_sku_demanda_efetiva IS
  'Demanda = venda direta ⊕ consumo de insumo derivado da ficha técnica. A linha de consumo herda a NF do pai (num_ordens) e usa a unidade do insumo; valor de venda é NULL (insumo não gera receita). PR-2 aponta as 4 views estatísticas para cá.';

-- Segurança (padrão P0 — docs/agent/database.md §4). Esta view lê v_venda_items_history_efetivo
-- (dados de venda/cliente sensíveis, já invoker=on em prod): manter a cadeia invoker=on e
-- fechar a anon-key. v_venda_items_history_efetivo é a folha que governa venda_items_history.
REVOKE ALL ON public.v_sku_demanda_efetiva FROM anon, PUBLIC;
GRANT SELECT ON public.v_sku_demanda_efetiva TO authenticated;
