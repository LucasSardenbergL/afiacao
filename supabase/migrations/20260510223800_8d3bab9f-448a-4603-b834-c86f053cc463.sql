
-- =============================================================
-- E1a: ALTER FUNCTION ... SET search_path = public, pg_temp
-- (apenas funções de aplicação; pula funções da extensão pg_trgm)
-- =============================================================
ALTER FUNCTION public.aplicar_promocoes_no_ciclo(text, date) SET search_path = public, pg_temp;
ALTER FUNCTION public.aprovar_pedido_sugerido(bigint, text) SET search_path = public, pg_temp;
ALTER FUNCTION public.atualizar_campanha_datas_corte(bigint, date, date) SET search_path = public, pg_temp;
ALTER FUNCTION public.atualizar_classificacao_skus(text) SET search_path = public, pg_temp;
ALTER FUNCTION public.atualizar_estados_eventos_comerciais() SET search_path = public, pg_temp;
ALTER FUNCTION public.atualizar_parametros_numericos_skus(text) SET search_path = public, pg_temp;
ALTER FUNCTION public.cancelar_pedido_sugerido(bigint, text, text) SET search_path = public, pg_temp;
ALTER FUNCTION public.ciclo_oportunidade_do_dia(text, date) SET search_path = public, pg_temp;
ALTER FUNCTION public.des_data_faturamento_prevista(date, text, text) SET search_path = public, pg_temp;
ALTER FUNCTION public.des_determinar_faixa(numeric, text) SET search_path = public, pg_temp;
ALTER FUNCTION public.detectar_outliers_empresa(text) SET search_path = public, pg_temp;
ALTER FUNCTION public.dias_uteis_entre(timestamp with time zone, timestamp with time zone) SET search_path = public, pg_temp;
ALTER FUNCTION public.expandir_promocao_item(bigint) SET search_path = public, pg_temp;
ALTER FUNCTION public.expandir_promocao_item(bigint, numeric) SET search_path = public, pg_temp;
ALTER FUNCTION public.fin_calcular_confiabilidade(text, integer, integer) SET search_path = public, pg_temp;
ALTER FUNCTION public.fin_consolidado_intercompany(integer, integer) SET search_path = public, pg_temp;
ALTER FUNCTION public.fin_refresh_analise_dimensoes() SET search_path = public, pg_temp;
ALTER FUNCTION public.fornecedor_operacional(text, text, timestamp with time zone) SET search_path = public, pg_temp;
ALTER FUNCTION public.fornecedor_polling_pendente(integer) SET search_path = public, pg_temp;
ALTER FUNCTION public.gerar_pedidos_oportunidade_ciclo(text, date, text[]) SET search_path = public, pg_temp;
ALTER FUNCTION public.gerar_pedidos_sugeridos_ciclo(text, date) SET search_path = public, pg_temp;
ALTER FUNCTION public.listar_skus_por_codigo_fornecedor(text, text) SET search_path = public, pg_temp;
ALTER FUNCTION public.marcar_alerta_notificado(bigint, boolean, text) SET search_path = public, pg_temp;
ALTER FUNCTION public.processar_alertas_pendentes_notificacao(text) SET search_path = public, pg_temp;
ALTER FUNCTION public.propagar_habilitacao_fornecedor() SET search_path = public, pg_temp;
ALTER FUNCTION public.proxima_janela_operacional(text, text, timestamp with time zone) SET search_path = public, pg_temp;
ALTER FUNCTION public.registrar_aumento_via_vision(text, text, text, date, date, jsonb, text, text, text, text, timestamp with time zone, numeric, text, text) SET search_path = public, pg_temp;
ALTER FUNCTION public.registrar_polling_resultado(bigint, integer, integer, integer, integer, integer, integer, text, text, jsonb) SET search_path = public, pg_temp;
ALTER FUNCTION public.registrar_substituicao_sku(text, text, text, text, text, text) SET search_path = public, pg_temp;
ALTER FUNCTION public.reprocessar_sku_items_via_raw_data(text) SET search_path = public, pg_temp;
ALTER FUNCTION public.resolver_sku_por_codigo_fornecedor(text, text) SET search_path = public, pg_temp;
ALTER FUNCTION public.rodar_bateria_simulacao(text, integer) SET search_path = public, pg_temp;
ALTER FUNCTION public.set_updated_at() SET search_path = public, pg_temp;
ALTER FUNCTION public.simular_formula_estoque(text, text, text, integer) SET search_path = public, pg_temp;
ALTER FUNCTION public.simular_puxar_volume_trimestre(text, integer, integer, numeric, text, integer) SET search_path = public, pg_temp;
ALTER FUNCTION public.sincronizar_ativo_omie_para_reposicao() SET search_path = public, pg_temp;
ALTER FUNCTION public.touch_des_updated_at() SET search_path = public, pg_temp;
ALTER FUNCTION public.touch_fornecedor_aumento() SET search_path = public, pg_temp;
ALTER FUNCTION public.touch_promocao() SET search_path = public, pg_temp;
ALTER FUNCTION public.touch_sugestao_updated_at() SET search_path = public, pg_temp;
ALTER FUNCTION public.trg_aumento_gera_alerta() SET search_path = public, pg_temp;
ALTER FUNCTION public.trg_campanha_gera_alerta() SET search_path = public, pg_temp;
ALTER FUNCTION public.validar_sku_para_aplicacao(text, text) SET search_path = public, pg_temp;

-- =============================================================
-- E1b: schema 'extensions' criado para uso futuro.
-- pg_trgm e pg_net permanecem em public (SKIPPED — dependências).
-- =============================================================
CREATE SCHEMA IF NOT EXISTS extensions;
GRANT USAGE ON SCHEMA extensions TO postgres, anon, authenticated, service_role;

-- =============================================================
-- E1c: Revoga SELECT em MVs para tirá-las do PostgREST
-- =============================================================
REVOKE SELECT ON public.fin_analise_cr_dimensoes FROM anon, authenticated;
REVOKE SELECT ON public.customer_metrics_mv FROM anon, authenticated;
REVOKE SELECT ON public.mv_sku_ranking_negociacao_paralela FROM anon, authenticated;
REVOKE SELECT ON public.fin_analise_cp_dimensoes FROM anon, authenticated;
