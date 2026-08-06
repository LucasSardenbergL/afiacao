-- ============================================================================
-- 07 — INTERCOMPANY (operações entre Colacor, Oben e Colacor SC)
-- 🟢 read-only → eu rodo via psql-ro (fallback: cola no SQL Editor do Lovable)
-- ----------------------------------------------------------------------------
-- Divergências aqui distorcem o consolidado e quase sempre viram pergunta pro
-- contador (ex.: "a NF da Colacor pra Oben está lançada nas duas pontas pelo
-- mesmo valor?"). A eliminação formal depende de fin_eliminacoes_log estar
-- populada; sem isso, apresente o consolidado como "soma simples, sem eliminação".
-- READ-ONLY.
-- ============================================================================

-- (a) divergências de matching CR↔CP entre empresas
SELECT empresa_origem, empresa_destino, status,
       count(*) AS qtd, round(sum(diff_valor)::numeric,2) AS soma_diferenca
FROM fin_ic_matches
WHERE status IN ('divergencia_valor','sem_contrapartida')
GROUP BY empresa_origem, empresa_destino, status
ORDER BY empresa_origem, empresa_destino, status;

-- (b) detalhe das maiores divergências (pra investigar título a título)
SELECT empresa_origem, empresa_destino, status,
       cr_id, cp_id, round(diff_valor::numeric,2) AS diff_valor
FROM fin_ic_matches
WHERE status IN ('divergencia_valor','sem_contrapartida')
ORDER BY abs(diff_valor) DESC NULLS LAST
LIMIT 30;

-- (c) eliminações intercompany aplicadas no período (se a tabela estiver populada)
WITH p AS (SELECT 2026 AS ano, 4 AS mes)   -- <<< EDITE
SELECT l.ano, l.mes, round(sum(l.valor_eliminado)::numeric,2) AS total_eliminado, count(*) AS qtd
FROM fin_eliminacoes_log l, p
WHERE l.ano = p.ano AND l.mes = p.mes
GROUP BY l.ano, l.mes;
