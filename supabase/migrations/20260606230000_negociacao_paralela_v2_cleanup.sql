-- Negociação Paralela v2: desliga a esteira diária que empilhava sugestões e limpa as pendentes.
-- A tela v2 calcula a fila Top 3 client-side sobre v_sku_parametros_sugeridos (não usa mais a matview de score).
-- A matview mv_sku_ranking_negociacao_paralela e a função de score ficam DORMENTES (não dropadas):
-- v_sugestao_negociacao_ativa faz LEFT JOIN com a matview (campo categoria) e o badge da sidebar a consome.
-- Limpeza física da matview/score = follow-up separado (mapear dependências antes).

-- 1) Desliga o cron de geração diária (10/dia, válido 14d → ~130 empilhadas).
-- Idempotente: unschedule POR jobid só se existir (cron.unschedule(nome) LANÇA erro se o job não existe).
SELECT cron.unschedule(jobid) FROM cron.job WHERE jobname = 'afiacao_sugestoes_diarias';

-- 2) Limpa as sugestões empilhadas pela esteira (nova/visualizada), preservando as que viraram negociação real.
UPDATE public.sugestao_negociacao_paralela
SET status = 'ignorada'
WHERE empresa = 'OBEN'
  AND status IN ('nova', 'visualizada');

-- Validação:
SELECT 'NEG_V2_CLEANUP' AS bloco,
  (SELECT count(*) FROM cron.job WHERE jobname = 'afiacao_sugestoes_diarias') AS crons_geracao_restantes, -- esperado 0
  (SELECT count(*) FROM public.sugestao_negociacao_paralela
     WHERE empresa = 'OBEN' AND status IN ('nova','visualizada')) AS sugestoes_pendentes; -- esperado 0
