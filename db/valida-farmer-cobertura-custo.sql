-- ═══════════════════════════════════════════════════════════════════════════════════════════════
-- VALIDAÇÃO PÓS-APPLY — 20260728120000_farmer_persiste_cobertura_custo
-- ═══════════════════════════════════════════════════════════════════════════════════════════════
-- Cole no SQL Editor do Lovable DEPOIS de aplicar a migration. Espera-se ✅ em TODAS as linhas.
--
-- ⚠️ O docs/migrations-audit.md NÃO é evidência para esta migration: ele a detecta pela função
-- `apply_score_updates`, que JÁ existia desde junho (5 migrations anteriores a recriam). O audit
-- diria "aplicado" mesmo que ninguém tivesse rodado nada. Esta query checa só o que passa a existir
-- DEPOIS desta migration: as 2 colunas e os marcadores novos no corpo da função.

WITH checagens AS (
  SELECT 1 AS ord,
         'colunas itens_com_custo/itens_sem_custo (bigint, nullable, SEM default)' AS checagem,
         (SELECT count(*) FROM information_schema.columns
           WHERE table_schema = 'public' AND table_name = 'farmer_client_scores'
             AND column_name IN ('itens_com_custo','itens_sem_custo')
             AND data_type = 'bigint' AND is_nullable = 'YES' AND column_default IS NULL) = 2 AS ok
  UNION ALL
  SELECT 2, 'apply_score_updates TRANSPORTA as 2 contagens (padrao jsonb_exists)',
         (SELECT pg_get_functiondef(p.oid) LIKE '%tem_itens_com_custo%'
             AND pg_get_functiondef(p.oid) LIKE '%tem_itens_sem_custo%'
            FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
           WHERE n.nspname = 'public' AND p.proname = 'apply_score_updates')
  UNION ALL
  SELECT 3, 'guard das 12 chaves CORE PRESERVADO (nao regrediu ao recriar a funcao)',
         (SELECT pg_get_functiondef(p.oid) LIKE '%contrato full-update violado%'
            FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
           WHERE n.nspname = 'public' AND p.proname = 'apply_score_updates')
  UNION ALL
  SELECT 4, 'anon e authenticated SEM EXECUTE (a falha ABERTA nao entrou)',
         NOT has_function_privilege('anon','public.apply_score_updates(jsonb)','EXECUTE')
     AND NOT has_function_privilege('authenticated','public.apply_score_updates(jsonb)','EXECUTE')
  UNION ALL
  SELECT 5, 'service_role COM EXECUTE (a edge consegue gravar)',
         has_function_privilege('service_role','public.apply_score_updates(jsonb)','EXECUTE')
)
SELECT ord, CASE WHEN ok THEN '✅ OK' ELSE '❌ FALHOU' END AS status, checagem
FROM checagens ORDER BY ord;

-- ───────────────────────────────────────────────────────────────────────────────────────────────
-- SEGUNDA PARTE — rode só DEPOIS de publicar a edge nova E o cron de scores rodar
-- ───────────────────────────────────────────────────────────────────────────────────────────────
-- Antes do 1º run pós-deploy: com_cobertura_computada = 0 (todas NULL). Isso é o ESPERADO, não
-- falha: a migration só abre a coluna; quem a preenche é a edge. Depois do run, o total coberto
-- deve bater com o nº de clientes que get_customer_margin_summary() retorna.
SELECT
  count(*)                                          AS clientes,
  count(itens_com_custo)                            AS com_cobertura_computada,
  count(*) FILTER (WHERE itens_com_custo = 0)       AS zero_itens_computaveis,
  count(*) FILTER (WHERE itens_com_custo > 0)       AS com_ao_menos_1_item,
  count(gross_margin_pct)                           AS com_margem_conhecida,
  -- coerência: margem conhecida DEVE implicar cobertura > 0. Qualquer linha aqui é bug.
  count(*) FILTER (WHERE gross_margin_pct IS NOT NULL AND COALESCE(itens_com_custo,0) = 0)
                                                    AS INCOERENTES_margem_sem_item
FROM public.farmer_client_scores;
