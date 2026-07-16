-- PR-3 do Canal WhatsApp: funil enviado→entregue→respondeu→proposta→pedido Omie.
-- Atribuição CONSERVADORA (precisão>recall, parecer Codex): pedido só conta no
-- canal com elo EXPLÍCITO sales_orders.whatsapp_conversation_id — nunca heurística
-- por telefone/janela temporal (atribuiria ao WhatsApp pedido fechado por telefone).

-- 1) Elo de atribuição (mesmo desenho do atendimento_id existente). Writer chega
--    no PR-4 (proposta 1-toque envia a cesta a partir da conversa); até lá os
--    estágios proposta/pedido leem 0 — honesto, não fabricado.
ALTER TABLE public.sales_orders
  ADD COLUMN IF NOT EXISTS whatsapp_conversation_id uuid REFERENCES public.whatsapp_conversations(id);

CREATE INDEX IF NOT EXISTS idx_so_whatsapp_conv
  ON public.sales_orders(whatsapp_conversation_id)
  WHERE whatsapp_conversation_id IS NOT NULL;

-- 2) RPC do funil: SECURITY INVOKER — RLS aplica nas 3 tabelas base (sends e
--    messages são staff-only ⇒ não-staff lê funil zerado, fail-closed).
--    "Respondeu" = mensagem 'in' na MESMA conversa em até 24h após o send
--    (janela padrão do canal; resposta ANTERIOR ao envio não conta).
--    "Enviado" exclui 'queued' (reserva de dedupe que pode nunca ter postado).
--    Receita: sum() ignora NULL — pedido sem total não vira zero fabricado.
CREATE OR REPLACE FUNCTION public.get_whatsapp_funil(p_dias int DEFAULT 30)
RETURNS TABLE (
  enviados bigint,
  entregues bigint,
  lidos bigint,
  falhas bigint,
  respondidos bigint,
  propostas bigint,
  pedidos_omie bigint,
  receita_omie numeric
) LANGUAGE sql STABLE SECURITY INVOKER SET search_path TO 'public'
AS $$
  WITH periodo AS (
    SELECT now() - make_interval(days => least(greatest(p_dias, 1), 365)) AS inicio
  ),
  sends AS (
    SELECT s.id, s.conversation_id, s.status, s.created_at
      FROM public.whatsapp_template_sends s, periodo
     WHERE s.created_at >= periodo.inicio
  ),
  respondidos AS (
    SELECT count(DISTINCT s.id) AS n
      FROM sends s
     WHERE s.status IN ('sent','delivered','read')
       AND EXISTS (
         SELECT 1 FROM public.whatsapp_messages m
          WHERE m.conversation_id = s.conversation_id
            AND m.direction = 'in'
            AND m.created_at > s.created_at
            AND m.created_at <= s.created_at + interval '24 hours'
       )
  ),
  pedidos AS (
    SELECT count(*) FILTER (WHERE true)                            AS propostas,
           count(*) FILTER (WHERE o.omie_pedido_id IS NOT NULL)    AS pedidos_omie,
           sum(o.total) FILTER (WHERE o.omie_pedido_id IS NOT NULL) AS receita_omie
      FROM public.sales_orders o, periodo
     WHERE o.whatsapp_conversation_id IS NOT NULL
       AND o.created_at >= periodo.inicio
  )
  SELECT
    (SELECT count(*) FROM sends WHERE status IN ('sent','delivered','read')) AS enviados,
    (SELECT count(*) FROM sends WHERE status IN ('delivered','read'))        AS entregues,
    (SELECT count(*) FROM sends WHERE status = 'read')                       AS lidos,
    (SELECT count(*) FROM sends WHERE status = 'failed')                     AS falhas,
    (SELECT n FROM respondidos)                                              AS respondidos,
    (SELECT propostas FROM pedidos)                                          AS propostas,
    (SELECT pedidos_omie FROM pedidos)                                       AS pedidos_omie,
    (SELECT receita_omie FROM pedidos)                                       AS receita_omie;
$$;

-- Função nova nasce com EXECUTE pra PUBLIC — revogar por nome (CLAUDE.md)
REVOKE ALL ON FUNCTION public.get_whatsapp_funil(int) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_whatsapp_funil(int) TO authenticated, service_role;
