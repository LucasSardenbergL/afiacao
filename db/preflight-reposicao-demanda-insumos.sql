-- db/preflight-reposicao-demanda-insumos.sql
-- READ-ONLY. Rodar via ~/.config/afiacao/psql-ro. Congela as premissas do PR-1.

-- P1: a malha não tem par duplicado (senão a regra de dedup muda de inerte p/ ativa)
SELECT 'P1_pares_duplicados' AS chk,
       count(*) AS valor  -- esperado: 0
FROM (SELECT pai_codigo, componente_codigo FROM vw_pcp_malha_componentes
      GROUP BY 1,2 HAVING count(*) > 1) t;

-- P2: perc_perda fora do escopo OBEN ativo
SELECT 'P2_perc_perda_no_escopo_oben' AS chk, count(*) AS valor  -- esperado: 0
FROM vw_pcp_malha_componentes m
JOIN omie_products opc ON opc.omie_codigo_produto=m.componente_codigo AND opc.account='colacor'
JOIN omie_products opb ON opb.codigo=opc.codigo AND opb.account='oben' AND opb.ativo
WHERE COALESCE(m.perc_perda,0) <> 0;

-- P3: codigo ambíguo (>1 linha ativa) na conta oben, entre os codigos da malha
SELECT 'P3_codigo_ambiguo_oben' AS chk, count(*) AS valor  -- esperado: 0
FROM (
  SELECT op.codigo FROM omie_products op
  WHERE op.account='oben' AND op.ativo AND op.codigo IN (
    SELECT c.codigo FROM omie_products c
    WHERE c.account='colacor' AND c.omie_codigo_produto IN (
      SELECT componente_codigo FROM vw_pcp_malha_componentes
      UNION SELECT pai_codigo FROM vw_pcp_malha_componentes))
  GROUP BY op.codigo HAVING count(*) > 1
) t;

-- P4: auto-referência
SELECT 'P4_auto_referencia' AS chk, count(*) AS valor  -- esperado: 0
FROM vw_pcp_malha_componentes WHERE pai_codigo = componente_codigo;

-- P5: interseção malha × de-para de consolidação (esperado: 1, como PAI)
SELECT 'P5_intersecao_depara' AS chk, count(*) AS valor
FROM sku_substituicao s
WHERE s.status='aplicada' AND s.acao_parametros='consolidar_demanda';

-- P6: baseline do BASE — demanda explodida esperada (~0.5776 L/dia)
WITH receita AS (
  SELECT m.pai_codigo, m.quantidade AS qtde_base
  FROM vw_pcp_malha_componentes m WHERE m.componente_codigo = 394035943
),
pai_oben AS (
  SELECT r.qtde_base, opb.omie_codigo_produto AS pai
  FROM receita r
  JOIN omie_products opc ON opc.omie_codigo_produto=r.pai_codigo AND opc.account='colacor'
  JOIN omie_products opb ON opb.codigo=opc.codigo AND opb.account='oben'
)
SELECT 'P6_demanda_explodida_base_dia' AS chk,
       round(sum(COALESCE(sp.demanda_media_diaria,0) * po.qtde_base)::numeric, 4) AS valor
FROM pai_oben po
LEFT JOIN sku_parametros sp ON sp.sku_codigo_omie::bigint = po.pai AND sp.empresa='OBEN';

-- P7: nada depende ainda de v_sku_demanda_efetiva (deve não existir)
SELECT 'P7_view_ja_existe' AS chk,
       count(*) AS valor  -- esperado: 0
FROM pg_class WHERE relname = 'v_sku_demanda_efetiva';

-- P8: viewdef verbatim das 4 views estatísticas (baseline p/ o EXCEPT ALL do Task 4)
SELECT 'P8_viewdef' AS chk, c.relname,
       md5(pg_get_viewdef(c.oid, true)) AS md5_viewdef
FROM pg_class c
WHERE c.relname IN ('v_sku_demanda_estatisticas','v_sku_sigma_demanda',
                    'v_sku_demanda_rajada','v_sku_candidatos_primeira_compra',
                    'v_venda_items_history_efetivo')
ORDER BY c.relname;
