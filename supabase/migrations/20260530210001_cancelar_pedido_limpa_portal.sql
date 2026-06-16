-- ============================================================
-- Portal Sayerlack — Fase 1.1: cancelar limpa o sub-fluxo do portal
-- ============================================================
-- A RPC cancelar_pedido_sugerido setava status='cancelado_humano' mas NUNCA
-- tocava status_envio_portal → um pedido cancelado ficava com
-- status_envio_portal='pendente_envio_portal' (e portal_proximo_retry_em
-- agendado) pra sempre, poluindo a aba Pendentes, os KPIs e o check de saúde
-- de dados reposicao_portal (que filtra só por status_envio_portal). Foi a
-- causa dos ids 153/166/172 aparecerem como "presos no portal" mesmo cancelados.
--
-- Fix: ao cancelar, também zera o sub-fluxo do portal (nao_aplicavel) e cancela
-- qualquer retry agendado. Corpo verbatim do schema-snapshot (843-866) + as 2
-- linhas novas; o guard de status (disparado/concluido_recebido) é preservado.
-- Idempotente (CREATE OR REPLACE; re-rodar não muda nada).

CREATE OR REPLACE FUNCTION public.cancelar_pedido_sugerido(
  p_pedido_id bigint, p_usuario text, p_justificativa text
) RETURNS jsonb
LANGUAGE plpgsql
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE
  v_pedido RECORD;
BEGIN
  SELECT * INTO v_pedido FROM pedido_compra_sugerido WHERE id = p_pedido_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('error', 'pedido não encontrado');
  END IF;
  IF v_pedido.status IN ('disparado', 'concluido_recebido') THEN
    RETURN jsonb_build_object('error', 'pedido já foi disparado em ' || v_pedido.horario_disparo_real::text);
  END IF;
  UPDATE pedido_compra_sugerido
  SET status = 'cancelado_humano',
      cancelado_por = p_usuario,
      cancelado_em = NOW(),
      justificativa_cancelamento = p_justificativa,
      status_envio_portal = 'nao_aplicavel',  -- Fase 1: cancelar limpa o sub-fluxo do portal
      portal_proximo_retry_em = NULL,         -- Fase 1: e cancela qualquer retry agendado
      atualizado_em = NOW()
  WHERE id = p_pedido_id;
  RETURN jsonb_build_object('status', 'ok', 'pedido_id', p_pedido_id);
END;
$$;
