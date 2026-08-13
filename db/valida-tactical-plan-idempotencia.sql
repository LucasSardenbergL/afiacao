-- Validação PÓS-APPLY de 20260802130000_tactical_plan_idempotencia_dia.sql
--
-- READ-ONLY e sem INVOCAR nada: lê pg_indexes / pg_get_functiondef / information_schema.
-- Validação que CHAMA a função mente nos dois sentidos (docs/agent/database.md §63) — a
-- `criar_plano_tatico` é SECURITY DEFINER com gate e ESCREVE, então invocá-la aqui seria
-- pior que inútil. Assim esta query roda igual no SQL Editor do founder e no psql-ro.
--
-- 🟣 Lovable → SQL Editor → cola → Run. Esperado: 6 linhas, TODAS com ok = true.

WITH def AS (
  SELECT regexp_replace(
           pg_get_functiondef('public.criar_plano_tatico(uuid,uuid,jsonb)'::regprocedure),
           '--[^\n]*', '', 'g'                       -- sem comentários: o assert tem de medir
         ) AS code                                    -- CÓDIGO, não a prosa que o descreve
), idx AS (
  SELECT indexdef FROM pg_indexes
   WHERE schemaname = 'public'
     AND indexname  = 'ux_farmer_tactical_plans_dia_operacional'
)
SELECT * FROM (
  SELECT 1 AS n, 'índice único parcial existe' AS check,
         (SELECT count(*) FROM idx) = 1 AS ok,
         COALESCE((SELECT left(indexdef, 120) FROM idx), '<AUSENTE>') AS detalhe

  UNION ALL
  SELECT 2, 'índice é UNIQUE e usa o eixo BRT (-3h) + plan_type',
         EXISTS (SELECT 1 FROM idx
                  WHERE indexdef LIKE 'CREATE UNIQUE INDEX%'
                    AND indexdef LIKE '%03:00:00%'
                    AND indexdef LIKE '%plan_type%'),
         COALESCE((SELECT right(indexdef, 150) FROM idx), '<AUSENTE>')

  UNION ALL
  -- Ancorado na ESTRUTURA (o EXISTS com a tabela e o predicado de status), não num nome
  -- solto: substring casaria dentro de qualquer identificador parecido.
  SELECT 3, 'RPC re-testa a existência DEPOIS do lock',
         (SELECT code ~ 'IF EXISTS \(\s*SELECT 1 FROM public\.farmer_tactical_plans' FROM def)
         AND (SELECT code ~ 'p\.status = ''gerado''' FROM def),
         (SELECT CASE WHEN code ~ 'IF EXISTS \(\s*SELECT 1 FROM public\.farmer_tactical_plans'
                      THEN 'bloco de idempotência presente' ELSE 'BLOCO AUSENTE' END FROM def)

  UNION ALL
  SELECT 4, 'RPC traduz unique_violation para a mensagem do contrato',
         (SELECT code ~ 'EXCEPTION WHEN unique_violation THEN' FROM def)
         AND (SELECT code LIKE '%gerado hoje para este cliente%' FROM def),
         (SELECT CASE WHEN code LIKE '%gerado hoje para este cliente%'
                      THEN 'mensagem do contrato presente' ELSE 'MENSAGEM DIVERGE' END FROM def)

  UNION ALL
  SELECT 5, 'as 4 colunas de bundle sem DEFAULT constante',
         (SELECT count(*) FROM information_schema.columns
           WHERE table_schema='public' AND table_name='farmer_tactical_plans'
             AND column_name IN ('bundle_lie','bundle_probability','bundle_incremental_margin','best_individual_lie')
             AND column_default IS NOT NULL) = 0,
         (SELECT string_agg(column_name || '=' || COALESCE(column_default,'<null>'), ', ')
            FROM information_schema.columns
           WHERE table_schema='public' AND table_name='farmer_tactical_plans'
             AND column_name IN ('bundle_lie','bundle_probability','bundle_incremental_margin','best_individual_lie'))

  UNION ALL
  -- 339 linhas em prod antes do apply, todas com bundle_recommendation_id NULL e 0 nos três
  -- números. Depois do backfill não pode sobrar nenhuma.
  SELECT 6, 'zero fabricado eliminado (linha sem bundle com 0 nos números)',
         (SELECT count(*) FROM public.farmer_tactical_plans
           WHERE bundle_recommendation_id IS NULL
             AND (bundle_lie = 0 OR bundle_probability = 0 OR bundle_incremental_margin = 0)) = 0
         AND (SELECT count(*) FROM public.farmer_tactical_plans WHERE best_individual_lie IS NOT NULL) = 0,
         (SELECT 'fabricadas=' || count(*) FILTER (WHERE bundle_recommendation_id IS NULL AND bundle_lie = 0)
                 || ' · best_individual_lie não-nulo=' || count(*) FILTER (WHERE best_individual_lie IS NOT NULL)
                 || ' · total=' || count(*)
            FROM public.farmer_tactical_plans)
) t ORDER BY n;
