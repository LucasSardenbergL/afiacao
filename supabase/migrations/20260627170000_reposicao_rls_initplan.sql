-- =============================================================================
-- REPOSIÇÃO — RLS has_role por-linha → InitPlan O(1) (mata o 500 de
-- v_oportunidade_economica_hoje). ⚠️ APLICAÇÃO MANUAL: colar no SQL Editor.
--
-- Bug: 36 policies de 15 tabelas base chamam has_role(auth.uid(),…) DIRETO no
-- USING/WITH CHECK. has_role é SECURITY DEFINER STABLE → o planner NÃO inlina e
-- avalia POR LINHA. Sob a view security_invoker (RLS desce a ~20 tabelas) +
-- explosão do generate_series (~537k linhas), o count do badge toca ~3,8GB e
-- estoura statement_timeout=8s do authenticated em cache frio → PostgREST 500.
-- Provado read-only: estrutural 885ms/11k buffers SEM RLS vs 495k buffers COM.
--
-- Fix: envolver a expressão num (SELECT …) escalar → InitPlan (1×/statement).
-- Semântica IDÊNTICA (mesma função, mesmo resultado: staff vê, não-staff não),
-- só muda o plano. Mesmo padrão de 20260613130000 (radar) e #1098 (tint).
-- ALTER POLICY (atômico, preserva cmd/roles/permissive, sem janela fail-closed,
-- idempotente). Gerado do estado REAL por-policy (não inventa cláusula;
-- redundâncias has_role(master) repetidas preservadas verbatim).
-- Provado em PG17: db/test-reposicao-rls-initplan.sh.
-- Spec: docs/superpowers/specs/2026-06-27-reposicao-rls-initplan-oportunidade-economica-design.md
-- =============================================================================

-- Guard de pré-flight (idempotente): aborta ANTES de qualquer ALTER se o conjunto
-- de policies-alvo divergiu da geração (policy removida/adicionada). As wrapped
-- ainda contêm 'has_role' no texto → 36 também após re-rodar (re-aplicar é seguro).
-- Achado Codex (xhigh, 2026-06-27): sem isto, um ALTER sobre estado divergente
-- sobrescreveria silenciosamente uma lógica de autorização alterada após a geração.
DO $$
DECLARE found int;
BEGIN
  SELECT count(*) INTO found FROM pg_policies
  WHERE schemaname = 'public'
    AND tablename = ANY(ARRAY['venda_items_history','sku_leadtime_history','sku_parametros','sku_grupo_producao','inventory_position','fornecedor_grupo_producao','fornecedor_cadeia_logistica','fornecedor_habilitado_reposicao','fornecedor_aumento_item','fornecedor_aumento_anunciado','promocao_campanha','promocao_item','omie_products','empresa_configuracao_custos','categoria_aumento_familia_mapeamento'])
    AND (qual ILIKE '%has_role%' OR with_check ILIKE '%has_role%');
  IF found <> 36 THEN
    RAISE EXCEPTION 'RLS InitPlan ABORTADO: esperava 36 policies has_role nas 15 tabelas, achou % — estado de prod divergiu da geração. Regenerar a migration (pré-flight read-only) antes de aplicar.', found;
  END IF;
END $$;

ALTER POLICY "Admin/manager editam categoria_aumento_familia_mapeamento" ON public.categoria_aumento_familia_mapeamento
  USING ((SELECT (has_role((SELECT auth.uid()), 'master'::app_role) OR has_role((SELECT auth.uid()), 'master'::app_role) OR has_role((SELECT auth.uid()), 'master'::app_role))))
  WITH CHECK ((SELECT (has_role((SELECT auth.uid()), 'master'::app_role) OR has_role((SELECT auth.uid()), 'master'::app_role) OR has_role((SELECT auth.uid()), 'master'::app_role))));

ALTER POLICY "Staff lê categoria_aumento_familia_mapeamento" ON public.categoria_aumento_familia_mapeamento
  USING ((SELECT (has_role((SELECT auth.uid()), 'master'::app_role) OR has_role((SELECT auth.uid()), 'master'::app_role) OR has_role((SELECT auth.uid()), 'master'::app_role) OR has_role((SELECT auth.uid()), 'employee'::app_role))));

ALTER POLICY staff_empresa_configuracao_custos_delete ON public.empresa_configuracao_custos
  USING ((SELECT (has_role((SELECT auth.uid()), 'master'::app_role) OR has_role((SELECT auth.uid()), 'employee'::app_role))));

ALTER POLICY staff_empresa_configuracao_custos_insert ON public.empresa_configuracao_custos
  WITH CHECK ((SELECT (has_role((SELECT auth.uid()), 'master'::app_role) OR has_role((SELECT auth.uid()), 'employee'::app_role))));

ALTER POLICY staff_empresa_configuracao_custos_select ON public.empresa_configuracao_custos
  USING ((SELECT (has_role((SELECT auth.uid()), 'master'::app_role) OR has_role((SELECT auth.uid()), 'employee'::app_role))));

ALTER POLICY staff_empresa_configuracao_custos_update ON public.empresa_configuracao_custos
  USING ((SELECT (has_role((SELECT auth.uid()), 'master'::app_role) OR has_role((SELECT auth.uid()), 'employee'::app_role))))
  WITH CHECK ((SELECT (has_role((SELECT auth.uid()), 'master'::app_role) OR has_role((SELECT auth.uid()), 'employee'::app_role))));

ALTER POLICY "Admin/manager editam fornecedor_aumento_anunciado" ON public.fornecedor_aumento_anunciado
  USING ((SELECT (has_role((SELECT auth.uid()), 'master'::app_role) OR has_role((SELECT auth.uid()), 'master'::app_role) OR has_role((SELECT auth.uid()), 'master'::app_role))))
  WITH CHECK ((SELECT (has_role((SELECT auth.uid()), 'master'::app_role) OR has_role((SELECT auth.uid()), 'master'::app_role) OR has_role((SELECT auth.uid()), 'master'::app_role))));

ALTER POLICY "Staff lê fornecedor_aumento_anunciado" ON public.fornecedor_aumento_anunciado
  USING ((SELECT (has_role((SELECT auth.uid()), 'master'::app_role) OR has_role((SELECT auth.uid()), 'master'::app_role) OR has_role((SELECT auth.uid()), 'master'::app_role) OR has_role((SELECT auth.uid()), 'employee'::app_role))));

ALTER POLICY "Admin/manager editam fornecedor_aumento_item" ON public.fornecedor_aumento_item
  USING ((SELECT (has_role((SELECT auth.uid()), 'master'::app_role) OR has_role((SELECT auth.uid()), 'master'::app_role) OR has_role((SELECT auth.uid()), 'master'::app_role))))
  WITH CHECK ((SELECT (has_role((SELECT auth.uid()), 'master'::app_role) OR has_role((SELECT auth.uid()), 'master'::app_role) OR has_role((SELECT auth.uid()), 'master'::app_role))));

ALTER POLICY "Staff lê fornecedor_aumento_item" ON public.fornecedor_aumento_item
  USING ((SELECT (has_role((SELECT auth.uid()), 'master'::app_role) OR has_role((SELECT auth.uid()), 'master'::app_role) OR has_role((SELECT auth.uid()), 'master'::app_role) OR has_role((SELECT auth.uid()), 'employee'::app_role))));

ALTER POLICY staff_fornecedor_cadeia_logistica_delete ON public.fornecedor_cadeia_logistica
  USING ((SELECT (has_role((SELECT auth.uid()), 'master'::app_role) OR has_role((SELECT auth.uid()), 'employee'::app_role))));

ALTER POLICY staff_fornecedor_cadeia_logistica_insert ON public.fornecedor_cadeia_logistica
  WITH CHECK ((SELECT (has_role((SELECT auth.uid()), 'master'::app_role) OR has_role((SELECT auth.uid()), 'employee'::app_role))));

ALTER POLICY staff_fornecedor_cadeia_logistica_select ON public.fornecedor_cadeia_logistica
  USING ((SELECT (has_role((SELECT auth.uid()), 'master'::app_role) OR has_role((SELECT auth.uid()), 'employee'::app_role))));

ALTER POLICY staff_fornecedor_cadeia_logistica_update ON public.fornecedor_cadeia_logistica
  USING ((SELECT (has_role((SELECT auth.uid()), 'master'::app_role) OR has_role((SELECT auth.uid()), 'employee'::app_role))))
  WITH CHECK ((SELECT (has_role((SELECT auth.uid()), 'master'::app_role) OR has_role((SELECT auth.uid()), 'employee'::app_role))));

ALTER POLICY staff_fornecedor_grupo_producao_delete ON public.fornecedor_grupo_producao
  USING ((SELECT (has_role((SELECT auth.uid()), 'master'::app_role) OR has_role((SELECT auth.uid()), 'employee'::app_role))));

ALTER POLICY staff_fornecedor_grupo_producao_insert ON public.fornecedor_grupo_producao
  WITH CHECK ((SELECT (has_role((SELECT auth.uid()), 'master'::app_role) OR has_role((SELECT auth.uid()), 'employee'::app_role))));

ALTER POLICY staff_fornecedor_grupo_producao_select ON public.fornecedor_grupo_producao
  USING ((SELECT (has_role((SELECT auth.uid()), 'master'::app_role) OR has_role((SELECT auth.uid()), 'employee'::app_role))));

ALTER POLICY staff_fornecedor_grupo_producao_update ON public.fornecedor_grupo_producao
  USING ((SELECT (has_role((SELECT auth.uid()), 'master'::app_role) OR has_role((SELECT auth.uid()), 'employee'::app_role))))
  WITH CHECK ((SELECT (has_role((SELECT auth.uid()), 'master'::app_role) OR has_role((SELECT auth.uid()), 'employee'::app_role))));

ALTER POLICY staff_fornecedor_habilitado_reposicao_delete ON public.fornecedor_habilitado_reposicao
  USING ((SELECT (has_role((SELECT auth.uid()), 'master'::app_role) OR has_role((SELECT auth.uid()), 'employee'::app_role))));

ALTER POLICY staff_fornecedor_habilitado_reposicao_insert ON public.fornecedor_habilitado_reposicao
  WITH CHECK ((SELECT (has_role((SELECT auth.uid()), 'master'::app_role) OR has_role((SELECT auth.uid()), 'employee'::app_role))));

ALTER POLICY staff_fornecedor_habilitado_reposicao_select ON public.fornecedor_habilitado_reposicao
  USING ((SELECT (has_role((SELECT auth.uid()), 'master'::app_role) OR has_role((SELECT auth.uid()), 'employee'::app_role))));

ALTER POLICY staff_fornecedor_habilitado_reposicao_update ON public.fornecedor_habilitado_reposicao
  USING ((SELECT (has_role((SELECT auth.uid()), 'master'::app_role) OR has_role((SELECT auth.uid()), 'employee'::app_role))))
  WITH CHECK ((SELECT (has_role((SELECT auth.uid()), 'master'::app_role) OR has_role((SELECT auth.uid()), 'employee'::app_role))));

ALTER POLICY "Staff can manage inventory" ON public.inventory_position
  USING ((SELECT (has_role((SELECT auth.uid()), 'master'::app_role) OR has_role((SELECT auth.uid()), 'employee'::app_role))))
  WITH CHECK ((SELECT (has_role((SELECT auth.uid()), 'master'::app_role) OR has_role((SELECT auth.uid()), 'employee'::app_role))));

ALTER POLICY staff_inventory_position_select ON public.inventory_position
  USING ((SELECT (has_role((SELECT auth.uid()), 'master'::app_role) OR has_role((SELECT auth.uid()), 'employee'::app_role) OR has_role((SELECT auth.uid()), 'master'::app_role) OR has_role((SELECT auth.uid()), 'master'::app_role))));

ALTER POLICY "Staff can manage products" ON public.omie_products
  USING ((SELECT (has_role((SELECT auth.uid()), 'master'::app_role) OR has_role((SELECT auth.uid()), 'employee'::app_role))))
  WITH CHECK ((SELECT (has_role((SELECT auth.uid()), 'master'::app_role) OR has_role((SELECT auth.uid()), 'employee'::app_role))));

ALTER POLICY "Admin/manager/master editam campanhas" ON public.promocao_campanha
  USING ((SELECT (has_role((SELECT auth.uid()), 'master'::app_role) OR has_role((SELECT auth.uid()), 'master'::app_role) OR has_role((SELECT auth.uid()), 'master'::app_role))))
  WITH CHECK ((SELECT (has_role((SELECT auth.uid()), 'master'::app_role) OR has_role((SELECT auth.uid()), 'master'::app_role) OR has_role((SELECT auth.uid()), 'master'::app_role))));

ALTER POLICY "Staff vê campanhas" ON public.promocao_campanha
  USING ((SELECT (has_role((SELECT auth.uid()), 'master'::app_role) OR has_role((SELECT auth.uid()), 'master'::app_role) OR has_role((SELECT auth.uid()), 'master'::app_role) OR has_role((SELECT auth.uid()), 'employee'::app_role))));

ALTER POLICY "Admin/manager/master editam itens" ON public.promocao_item
  USING ((SELECT (has_role((SELECT auth.uid()), 'master'::app_role) OR has_role((SELECT auth.uid()), 'master'::app_role) OR has_role((SELECT auth.uid()), 'master'::app_role))))
  WITH CHECK ((SELECT (has_role((SELECT auth.uid()), 'master'::app_role) OR has_role((SELECT auth.uid()), 'master'::app_role) OR has_role((SELECT auth.uid()), 'master'::app_role))));

ALTER POLICY "Staff vê itens" ON public.promocao_item
  USING ((SELECT (has_role((SELECT auth.uid()), 'master'::app_role) OR has_role((SELECT auth.uid()), 'master'::app_role) OR has_role((SELECT auth.uid()), 'master'::app_role) OR has_role((SELECT auth.uid()), 'employee'::app_role))));

ALTER POLICY staff_sku_grupo_producao_delete ON public.sku_grupo_producao
  USING ((SELECT (has_role((SELECT auth.uid()), 'master'::app_role) OR has_role((SELECT auth.uid()), 'employee'::app_role))));

ALTER POLICY staff_sku_grupo_producao_insert ON public.sku_grupo_producao
  WITH CHECK ((SELECT (has_role((SELECT auth.uid()), 'master'::app_role) OR has_role((SELECT auth.uid()), 'employee'::app_role))));

ALTER POLICY staff_sku_grupo_producao_select ON public.sku_grupo_producao
  USING ((SELECT (has_role((SELECT auth.uid()), 'master'::app_role) OR has_role((SELECT auth.uid()), 'employee'::app_role))));

ALTER POLICY staff_sku_grupo_producao_update ON public.sku_grupo_producao
  USING ((SELECT (has_role((SELECT auth.uid()), 'master'::app_role) OR has_role((SELECT auth.uid()), 'employee'::app_role))))
  WITH CHECK ((SELECT (has_role((SELECT auth.uid()), 'master'::app_role) OR has_role((SELECT auth.uid()), 'employee'::app_role))));

ALTER POLICY staff_sku_leadtime_history_all ON public.sku_leadtime_history
  USING ((SELECT (has_role((SELECT auth.uid()), 'master'::app_role) OR has_role((SELECT auth.uid()), 'employee'::app_role) OR has_role((SELECT auth.uid()), 'master'::app_role) OR has_role((SELECT auth.uid()), 'master'::app_role))))
  WITH CHECK ((SELECT (has_role((SELECT auth.uid()), 'master'::app_role) OR has_role((SELECT auth.uid()), 'employee'::app_role) OR has_role((SELECT auth.uid()), 'master'::app_role) OR has_role((SELECT auth.uid()), 'master'::app_role))));

ALTER POLICY staff_sku_parametros_select ON public.sku_parametros
  USING ((SELECT (has_role((SELECT auth.uid()), 'master'::app_role) OR has_role((SELECT auth.uid()), 'employee'::app_role) OR has_role((SELECT auth.uid()), 'master'::app_role) OR has_role((SELECT auth.uid()), 'master'::app_role))));

ALTER POLICY staff_venda_items_history_select ON public.venda_items_history
  USING ((SELECT (has_role((SELECT auth.uid()), 'master'::app_role) OR has_role((SELECT auth.uid()), 'employee'::app_role))));

-- Validação pós-apply: as 36 devem ter virado InitPlan (subselect no USING/WITH CHECK).
-- Esperado: policies_wrapped = 36.
SELECT count(*) AS policies_wrapped_esperado_36
FROM pg_policies
WHERE schemaname = 'public'
  AND tablename = ANY(ARRAY['venda_items_history','sku_leadtime_history','sku_parametros','sku_grupo_producao','inventory_position','fornecedor_grupo_producao','fornecedor_cadeia_logistica','fornecedor_habilitado_reposicao','fornecedor_aumento_item','fornecedor_aumento_anunciado','promocao_campanha','promocao_item','omie_products','empresa_configuracao_custos','categoria_aumento_familia_mapeamento'])
  AND (qual ILIKE '%select%' OR with_check ILIKE '%select%');
