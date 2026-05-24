-- ============================================================================
-- Fatia E3 Fase 1 - Revoke SECURITY DEFINER public exec & enable invoker views
-- ============================================================================
-- Bloco (1): REVOKE EXECUTE FROM PUBLIC, anon nas 18 funcoes SECURITY DEFINER
--            do schema public listadas no inventario E3. Mantemos GRANT para
--            authenticated e service_role. NAO tocamos nos helpers de RLS
--            (has_role, get_user_role, get_commercial_role, is_super_admin,
--            fin_user_can_access).
-- Bloco (2): ALTER VIEW ... SET (security_invoker=on) nas 34 views, para que
--            consultas respeitem a RLS do usuario chamador, e nao do owner.
-- Bloco (3): Garantir REVOKE ALL FROM anon, authenticated nas 4 MVs,
--            mantendo os GRANTs especificos ja aplicados em E1c.
-- NAO altera RLS de tabelas, policies, dados, cron, codigo ou edge functions.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- BLOCO 1: REVOKE EXECUTE FROM PUBLIC, anon (18 funcoes SECURITY DEFINER)
-- ---------------------------------------------------------------------------
REVOKE EXECUTE ON FUNCTION public.auto_assign_commercial_super_admin() FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.auto_assign_commercial_super_admin() TO authenticated, service_role;

REVOKE EXECUTE ON FUNCTION public.auto_assign_user_role() FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.auto_assign_user_role() TO authenticated, service_role;

REVOKE EXECUTE ON FUNCTION public.award_loyalty_points() FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.award_loyalty_points() TO authenticated, service_role;

REVOKE EXECUTE ON FUNCTION public.converter_sugestao_em_campanha_flat(p_sugestao_id bigint, p_desconto_perc numeric, p_volume_minimo numeric, p_volume_unidade text, p_data_fim date, p_responsavel_nome text, p_canal text, p_observacoes text) FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.converter_sugestao_em_campanha_flat(p_sugestao_id bigint, p_desconto_perc numeric, p_volume_minimo numeric, p_volume_unidade text, p_data_fim date, p_responsavel_nome text, p_canal text, p_observacoes text) TO authenticated, service_role;

REVOKE EXECUTE ON FUNCTION public.detectar_skus_sem_grupo(p_empresa text) FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.detectar_skus_sem_grupo(p_empresa text) TO authenticated, service_role;

REVOKE EXECUTE ON FUNCTION public.fin_calcular_confiabilidade(p_company text, p_ano integer, p_mes integer) FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.fin_calcular_confiabilidade(p_company text, p_ano integer, p_mes integer) TO authenticated, service_role;

REVOKE EXECUTE ON FUNCTION public.fin_consolidado_intercompany(p_ano integer, p_mes integer) FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.fin_consolidado_intercompany(p_ano integer, p_mes integer) TO authenticated, service_role;

REVOKE EXECUTE ON FUNCTION public.fin_projecao_13_semanas(p_company text, p_saldo_inicial numeric) FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.fin_projecao_13_semanas(p_company text, p_saldo_inicial numeric) TO authenticated, service_role;

REVOKE EXECUTE ON FUNCTION public.get_customer_metrics() FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.get_customer_metrics() TO authenticated, service_role;

REVOKE EXECUTE ON FUNCTION public.import_tint_formulas(p_account text, p_personalizada boolean, p_rows jsonb) FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.import_tint_formulas(p_account text, p_personalizada boolean, p_rows jsonb) TO authenticated, service_role;

REVOKE EXECUTE ON FUNCTION public.limpar_sugestoes_antigas() FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.limpar_sugestoes_antigas() TO authenticated, service_role;

REVOKE EXECUTE ON FUNCTION public.protect_master_config() FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.protect_master_config() TO authenticated, service_role;

REVOKE EXECUTE ON FUNCTION public.refresh_customer_metrics() FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.refresh_customer_metrics() TO authenticated, service_role;

REVOKE EXECUTE ON FUNCTION public.refresh_sku_ranking_negociacao() FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.refresh_sku_ranking_negociacao() TO authenticated, service_role;

REVOKE EXECUTE ON FUNCTION public.registrar_historico_sku_parametros() FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.registrar_historico_sku_parametros() TO authenticated, service_role;

REVOKE EXECUTE ON FUNCTION public.set_status_envio_portal_on_disparo() FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.set_status_envio_portal_on_disparo() TO authenticated, service_role;

REVOKE EXECUTE ON FUNCTION public.sugerir_negociacao_paralela_hoje(p_empresa text, p_limite integer) FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.sugerir_negociacao_paralela_hoje(p_empresa text, p_limite integer) TO authenticated, service_role;

REVOKE EXECUTE ON FUNCTION public.tint_run_reconciliation(p_sync_run_id uuid) FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.tint_run_reconciliation(p_sync_run_id uuid) TO authenticated, service_role;

-- ---------------------------------------------------------------------------
-- BLOCO 2: ALTER VIEW ... SET (security_invoker = on) - 34 views
-- ---------------------------------------------------------------------------
ALTER VIEW public.fin_aging_pagar SET (security_invoker = on);
ALTER VIEW public.fin_aging_receber SET (security_invoker = on);
ALTER VIEW public.fin_dre_competencia_base SET (security_invoker = on);
ALTER VIEW public.fin_fluxo_caixa_diario SET (security_invoker = on);
ALTER VIEW public.v_cron_jobs_falhas SET (security_invoker = on);
ALTER VIEW public.v_cron_jobs_status SET (security_invoker = on);
ALTER VIEW public.v_des_checkin_atual SET (security_invoker = on);
ALTER VIEW public.v_des_desconto_por_checkin SET (security_invoker = on);
ALTER VIEW public.v_des_pedidos_em_transito SET (security_invoker = on);
ALTER VIEW public.v_des_posicao_trimestre_ao_vivo SET (security_invoker = on);
ALTER VIEW public.v_des_snapshot_mais_recente SET (security_invoker = on);
ALTER VIEW public.v_desconto_flat_condicional_ativo SET (security_invoker = on);
ALTER VIEW public.v_envios_portal_status SET (security_invoker = on);
ALTER VIEW public.v_fornecedor_lt_logistica_total SET (security_invoker = on);
ALTER VIEW public.v_fornecedor_sla_compliance SET (security_invoker = on);
ALTER VIEW public.v_leadtime_por_grupo SET (security_invoker = on);
ALTER VIEW public.v_notificacoes_status SET (security_invoker = on);
ALTER VIEW public.v_oportunidade_economica_hoje SET (security_invoker = on);
ALTER VIEW public.v_pedidos_em_aberto SET (security_invoker = on);
ALTER VIEW public.v_promocao_avaliacao_hoje SET (security_invoker = on);
ALTER VIEW public.v_promocao_item_efetivo SET (security_invoker = on);
ALTER VIEW public.v_simulacao_comparativa SET (security_invoker = on);
ALTER VIEW public.v_simulacao_ranking_global SET (security_invoker = on);
ALTER VIEW public.v_sku_aumento_vigente SET (security_invoker = on);
ALTER VIEW public.v_sku_classificacao_abc_xyz SET (security_invoker = on);
ALTER VIEW public.v_sku_demanda_estatisticas SET (security_invoker = on);
ALTER VIEW public.v_sku_demanda_rajada SET (security_invoker = on);
ALTER VIEW public.v_sku_leadtime_estatisticas SET (security_invoker = on);
ALTER VIEW public.v_sku_leadtime_history_normal SET (security_invoker = on);
ALTER VIEW public.v_sku_lt_teorico SET (security_invoker = on);
ALTER VIEW public.v_sku_parametros_sugeridos SET (security_invoker = on);
ALTER VIEW public.v_sku_sigma_demanda SET (security_invoker = on);
ALTER VIEW public.v_sku_sla_compliance SET (security_invoker = on);
ALTER VIEW public.v_sugestao_negociacao_ativa SET (security_invoker = on);

-- ---------------------------------------------------------------------------
-- BLOCO 3: Garantir REVOKE ALL FROM anon, authenticated nas 4 MVs.
-- Os GRANTs especificos aplicados em E1c sao mantidos.
-- ---------------------------------------------------------------------------
REVOKE ALL ON public.customer_metrics_mv FROM anon, authenticated;
REVOKE ALL ON public.fin_analise_cp_dimensoes FROM anon, authenticated;
REVOKE ALL ON public.fin_analise_cr_dimensoes FROM anon, authenticated;
REVOKE ALL ON public.mv_sku_ranking_negociacao_paralela FROM anon, authenticated;
