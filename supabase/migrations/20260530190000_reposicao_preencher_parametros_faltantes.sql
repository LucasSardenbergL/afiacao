-- Reposição — preenche parâmetros FALTANTES (ponto_pedido/estoque_maximo) automaticamente
-- ============================================================================
-- Problema (descoberto na auditoria): produto novo entra do Omie e a sku_parametros
-- nasce SEM ponto_pedido/estoque_maximo. O motor gerar_pedidos_sugeridos_ciclo exige os
-- dois preenchidos → produto fica INVISÍVEL pra compra (nunca sugerido). Achado: 124 de 272
-- SKUs do RENNER SAYERLACK (46%) estavam assim — compras silenciosamente perdidas. Não havia
-- passo automático que preenchesse: a função atualizar_parametros_numericos_skus (que aplica
-- os sugeridos de v_sku_parametros_sugeridos) só roda MANUAL (tela de Revisão) e RECALCULA TODOS
-- (sobrescreve ajuste manual).
--
-- Esta função é a versão SEGURA pra rodar automático (revisada com codex):
--   • FILL-ONLY-POR-CAMPO via COALESCE(sp.campo, v.sugerido) — NUNCA sobrescreve um valor já
--     preenchido (preserva ajuste manual). ⚠️ codex: o WHERE sozinho NÃO basta — uma linha com
--     ponto_pedido ajustado + estoque_maximo NULL entraria no UPDATE e o SET sobrescreveria o
--     ponto_pedido; por isso o COALESCE por campo é obrigatório.
--   • NÃO toca fornecedor_nome nem sku_descricao (preserva correções manuais de fornecedor).
--   • Métricas derivadas (demanda/lead time/z) são gravadas frescas (não são ajuste humano;
--     explicam de onde veio a sugestão).
--   • WHERE com guard de lacuna (ponto_pedido OU estoque_maximo NULL) → só toca linhas
--     incompletas; linhas 100% configuradas ficam intactas (nem as métricas).
--   • SKU sem histórico não tem linha em v_sku_parametros_sugeridos → continua NULL (precisa
--     de dado/manual). Aceitável: não dá pra sugerir parâmetro sem demanda.
-- Idempotente. Escopo por empresa (reposição é OBEN-only). Itens descontinuados seguem
-- barrados pelos guards do motor (habilitado/ativo/familia_nao_comprada/fracionado).

CREATE OR REPLACE FUNCTION public.preencher_parametros_faltantes_skus(p_empresa text)
RETURNS integer
LANGUAGE plpgsql
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE
  atualizados int := 0;
BEGIN
  UPDATE sku_parametros sp
  SET
    -- métricas derivadas (sempre frescas — não são ajuste manual)
    demanda_media_diaria       = v.demanda_media_diaria,
    demanda_desvio_padrao      = v.demanda_sigma_diario,
    demanda_coef_variacao      = v.coef_variacao_ordem,
    demanda_dias_com_movimento = v.num_ordens,
    valor_vendido_90d          = v.valor_total_90d,
    lt_medio_dias_uteis        = v.lead_time_medio,
    lt_desvio_padrao_dias      = v.lead_time_desvio,
    lt_p95_dias                = v.lt_p95_dias,
    fonte_leadtime             = v.fonte_leadtime,
    z_score                    = v.z_aplicado,
    -- CONFIG: fill-only-por-campo → preserva qualquer valor já existente (codex)
    estoque_seguranca   = COALESCE(sp.estoque_seguranca, v.estoque_seguranca_sugerido),
    ponto_pedido        = COALESCE(sp.ponto_pedido, v.ponto_pedido_sugerido),
    estoque_minimo      = COALESCE(sp.estoque_minimo, v.estoque_minimo_sugerido),
    cobertura_alvo_dias = COALESCE(sp.cobertura_alvo_dias, v.cobertura_alvo_dias),
    estoque_maximo      = COALESCE(sp.estoque_maximo, v.estoque_maximo_sugerido),
    ultima_atualizacao_calculo = NOW()
  FROM v_sku_parametros_sugeridos v
  WHERE sp.empresa = v.empresa
    AND sp.sku_codigo_omie = v.sku_codigo_omie
    AND sp.empresa = p_empresa
    AND (sp.ponto_pedido IS NULL OR sp.estoque_maximo IS NULL); -- só linhas com lacuna
  GET DIAGNOSTICS atualizados = ROW_COUNT;
  RETURN atualizados;
END;
$$;

-- Cron noturno: preenche os novos antes do ciclo de geração das 9h15 (gerar-pedidos-diario-oben).
-- SQL-local (sem net.http_post → sem a armadilha do timeout 5s do pg_net). Idempotente.
SELECT cron.schedule('reposicao-preencher-parametros-faltantes', '0 8 * * *',
  $cron$ SELECT public.preencher_parametros_faltantes_skus('OBEN'); $cron$);
