-- Pré-claim atômico do portal Sayerlack (SQL puro).
--
-- POR QUE RPC e não PostgREST: o #592/§7 documentou um incidente (324 pedidos presos)
-- causado por um claim de status_envio_portal via .update().filter().select() pela API
-- REST, que quebra com 42703 ("column pedido_compra_sugerido.status_envio_portal does
-- not exist") — o banco está íntegro, só o PostgREST falha. A lição do projeto: TODOS os
-- claims dessa coluna são RPC SQL pura (envio_portal_lock_candidatos, envio_portal_claim_ids).
--
-- O QUE FAZ: o iniciarEnvioPortalSayerlack (edge disparar-pedidos-aprovados) chama esta RPC
-- para "normalizar" o pedido para 'pendente_envio_portal' ANTES de enfileirar o envio async,
-- mas CONDICIONALMENTE: se uma execução concorrente já marcou 'enviando_portal' (entre o
-- pré-check e aqui), NÃO rebaixa — senão reabriria o pedido para o claim downstream e geraria
-- uma 2ª sessão Browserless (PO duplicado na Renner). Cobre NULL via COALESCE (linhas legadas).
-- Grava o relógio de stale ESTÁVEL (+15min) que o lote-retry (envio_portal_lock_candidatos) usa
-- — NÃO usa atualizado_em (trigger de timestamp reiniciaria o relógio e recriaria o blind-spot).
-- Retorna true se reivindicou (deve enfileirar), false se o claim foi perdido (não enfileira).

CREATE OR REPLACE FUNCTION public.iniciar_envio_portal_pre_claim(p_pedido_id bigint)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_claimed boolean;
BEGIN
  UPDATE public.pedido_compra_sugerido
     SET status_envio_portal = 'pendente_envio_portal',
         portal_erro = NULL,
         portal_proximo_retry_em = now() + interval '15 minutes'
   WHERE id = p_pedido_id
     AND COALESCE(status_envio_portal, 'nao_aplicavel') <> 'enviando_portal'
  RETURNING true INTO v_claimed;
  RETURN COALESCE(v_claimed, false);
END;
$$;

-- Chamada apenas pela edge (service_role). Fora do alcance de anon/authenticated.
REVOKE ALL ON FUNCTION public.iniciar_envio_portal_pre_claim(bigint) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.iniciar_envio_portal_pre_claim(bigint) FROM anon;
REVOKE ALL ON FUNCTION public.iniciar_envio_portal_pre_claim(bigint) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.iniciar_envio_portal_pre_claim(bigint) TO service_role;
