-- ============================================================================
-- 05 — CATEGORIAS SEM MAPEAMENTO DRE
-- 🟢 read-only → eu rodo via psql-ro (fallback: cola no SQL Editor do Lovable)
-- ----------------------------------------------------------------------------
-- Categorias Omie com movimento no período que NÃO têm linha explícita em
-- fin_categoria_dre_mapping — caem na heurística por palavra-chave (sujeita a
-- erro). Cada uma com valor relevante vira: (a) classificar em /financeiro/mapping,
-- (b) candidata a pergunta pro contador ("X é CMV ou despesa operacional?").
-- READ-ONLY.
--
-- ⚠️ NÃO chame a RPC fin_categorias_sem_mapping(company,start,end):
--    ela é SECURITY DEFINER com gate "requer perfil financeiro"
--    (auth.role()='service_role' OR fin_user_can_access(company)) e dá
--    `ERROR: 42501: Acesso negado: requer perfil financeiro` em QUALQUER sessão
--    sem auth.uid() do app — tanto o psql-ro quanto o SQL Editor. A query (a)
--    abaixo é a MESMA lógica, direta nas tabelas — roda sem gate.
-- ============================================================================

-- (a) Categorias com movimento no período SEM linha no DRE (nem na empresa nem
--     no _default). Réplica direta da RPC fin_categorias_sem_mapping, nas 3
--     empresas de uma vez. EDITE só o período:
WITH p AS (SELECT DATE '2026-04-01' AS ini, DATE '2026-04-30' AS fim),   -- <<< EDITE
titulos AS (
  SELECT company, categoria_codigo, categoria_descricao, valor_documento
  FROM fin_contas_receber, p
  WHERE data_emissao BETWEEN p.ini AND p.fim AND categoria_codigo IS NOT NULL
  UNION ALL
  SELECT company, categoria_codigo, categoria_descricao, valor_documento
  FROM fin_contas_pagar, p
  WHERE data_emissao BETWEEN p.ini AND p.fim AND categoria_codigo IS NOT NULL
),
agg AS (
  SELECT company, categoria_codigo, categoria_descricao,
         round(sum(COALESCE(valor_documento,0))::numeric, 2) AS valor_periodo,
         count(*) AS qtd_titulos
  FROM titulos
  GROUP BY company, categoria_codigo, categoria_descricao
)
SELECT a.company, a.categoria_codigo, a.categoria_descricao,
       a.valor_periodo, a.qtd_titulos
FROM agg a
LEFT JOIN fin_categoria_dre_mapping m_co
       ON m_co.company = a.company   AND m_co.omie_codigo = a.categoria_codigo
LEFT JOIN fin_categoria_dre_mapping m_def
       ON m_def.company = '_default' AND m_def.omie_codigo = a.categoria_codigo
WHERE COALESCE(m_co.dre_linha, m_def.dre_linha) IS NULL   -- não mapeada (empresa sobrepõe _default)
  AND a.valor_periodo > 0
ORDER BY a.valor_periodo DESC;
-- categoria_descricao pode vir VAZIA (dado do Omie); o nome do plano de contas
-- está em fin_categorias (omie_codigo, descricao) se precisar enriquecer.

-- (b) CROSS-CHECK: o que o cálculo do DRE registrou como não-mapeado no snapshot
--     (qtd + lista). Diverge MUITO de (a)? Snapshot do DRE defasado — rode o (a).
WITH p AS (SELECT 2026 AS ano, 4 AS mes)   -- <<< EDITE
SELECT d.company, d.regime, d.qtd_categorias_sem_mapeamento,
       d.detalhamento -> 'categorias_nao_mapeadas' AS categorias_nao_mapeadas
FROM fin_dre_snapshots d, p
WHERE d.ano = p.ano AND d.mes = p.mes
ORDER BY d.company, d.regime;

-- (c) Títulos SEM categoria_codigo no período (não entram em (a) — são o balde
--     "nem código têm", não classificáveis):
WITH p AS (SELECT DATE '2026-04-01' AS ini, DATE '2026-04-30' AS fim)   -- <<< EDITE
SELECT 'receber' AS tabela, company, count(*) AS titulos, round(sum(valor_documento)::numeric,2) AS valor
FROM fin_contas_receber, p
WHERE categoria_codigo IS NULL AND data_emissao BETWEEN p.ini AND p.fim
GROUP BY company
UNION ALL
SELECT 'pagar', company, count(*), round(sum(valor_documento)::numeric,2)
FROM fin_contas_pagar, p
WHERE categoria_codigo IS NULL AND data_emissao BETWEEN p.ini AND p.fim
GROUP BY company
ORDER BY tabela, company;
