-- PR-2 do Canal WhatsApp: fila "respondeu→topo" com last_outbound_at REAL.
-- Mata o falso-negativo do v1 (cap 200 do inbox + proxy last_message_at): a
-- pendência agora é decidida no SQL sobre um timestamp de outbound dedicado,
-- com 1 writer só (trigger em whatsapp_messages) — as edges NÃO escrevem nele.

-- 1) Coluna dedicada (proxy last_message_at marcava template automático como "resposta")
ALTER TABLE public.whatsapp_conversations
  ADD COLUMN IF NOT EXISTS last_outbound_at timestamptz;

-- 2) Trigger 1-writer: toda mensagem out avança o marcador (greatest ignora NULL;
--    out atrasado/reprocessado não regride). O IF interno é defesa caso o trigger
--    seja recriado sem o WHEN.
CREATE OR REPLACE FUNCTION public.wa_msg_touch_last_outbound()
RETURNS trigger LANGUAGE plpgsql SET search_path TO 'public'
AS $$
BEGIN
  IF NEW.direction = 'out' THEN
    UPDATE public.whatsapp_conversations
       SET last_outbound_at = greatest(last_outbound_at, NEW.created_at)
     WHERE id = NEW.conversation_id;
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_wa_msg_last_outbound ON public.whatsapp_messages;
CREATE TRIGGER trg_wa_msg_last_outbound
  AFTER INSERT ON public.whatsapp_messages
  FOR EACH ROW WHEN (NEW.direction = 'out')
  EXECUTE FUNCTION public.wa_msg_touch_last_outbound();

-- 3) Backfill do histórico (idempotente — só avança, nunca regride)
UPDATE public.whatsapp_conversations c
   SET last_outbound_at = m.max_out
  FROM (SELECT conversation_id, max(created_at) AS max_out
          FROM public.whatsapp_messages
         WHERE direction = 'out'
         GROUP BY conversation_id) m
 WHERE m.conversation_id = c.id
   AND (c.last_outbound_at IS NULL OR c.last_outbound_at < m.max_out);

-- 4) RPC da fila: SECURITY INVOKER — a RLS staff de whatsapp_conversations aplica
--    (não-staff recebe 0 rows, fail-closed). Janela de 24h pelo relógio do SERVIDOR.
--    Conversa com dono (assigned_operator_id) só aparece pro dono; sem dono, pra todo staff
--    (demanda abandonada é pior que fila compartilhada). LIMIT 500 documenta o teto
--    (pendentes de 24h ≪ isso; o cap de 1000 do PostgREST nunca morde).
CREATE OR REPLACE FUNCTION public.get_whatsapp_pendentes()
RETURNS TABLE (
  conversation_id uuid,
  customer_user_id uuid,
  contact_name text,
  phone_e164 text,
  last_inbound_at timestamptz
) LANGUAGE sql STABLE SECURITY INVOKER SET search_path TO 'public'
AS $$
  SELECT c.id, c.customer_user_id, c.contact_name, c.phone_e164, c.last_inbound_at
    FROM public.whatsapp_conversations c
   WHERE c.status <> 'fechada'
     AND c.last_inbound_at IS NOT NULL
     AND c.last_inbound_at > now() - interval '24 hours'
     AND (c.last_outbound_at IS NULL OR c.last_outbound_at < c.last_inbound_at)
     AND (c.assigned_operator_id IS NULL OR c.assigned_operator_id = (SELECT auth.uid()))
   ORDER BY c.last_inbound_at ASC
   LIMIT 500;
$$;

-- Função nova nasce com EXECUTE pra PUBLIC — revogar por nome (CLAUDE.md)
REVOKE ALL ON FUNCTION public.get_whatsapp_pendentes() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_whatsapp_pendentes() TO authenticated, service_role;

-- 5) Índice parcial da fila (conversas vivas por recência de inbound)
CREATE INDEX IF NOT EXISTS idx_wa_conv_pendentes
  ON public.whatsapp_conversations (last_inbound_at)
  WHERE status <> 'fechada';
