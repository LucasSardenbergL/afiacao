-- #6 (auditoria 2026-06-04): QR público de histórico de ferramenta quebrado.
--
-- A rota pública /tool/:id (gerada por QR em ToolHistory, "Escaneie para acessar o histórico")
-- lia user_tools/tool_events DIRETO, mas essas tabelas só têm policy own-scoped/staff (sem anon)
-- → o visitante NÃO-LOGADO sempre via "Ferramenta não encontrada".
--
-- Fix: RPC SECURITY DEFINER escopada por UUID, callable por anon, que devolve SÓ campos seguros
-- (nome/categoria/datas de afiação/eventos) — NUNCA o user_id (dono) nem as outras ferramentas dele.
-- Padrão das RPCs públicas do repo (mesma ideia do get_tint_price). O front passa a chamar a RPC.

CREATE OR REPLACE FUNCTION public.get_public_tool_history(p_tool_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_tool jsonb;
  v_events jsonb;
BEGIN
  IF p_tool_id IS NULL THEN
    RETURN NULL;
  END IF;

  -- Ferramenta: só campos públicos (sem user_id).
  SELECT jsonb_build_object(
    'id', ut.id,
    'internal_code', ut.internal_code,
    'generated_name', ut.generated_name,
    'custom_name', ut.custom_name,
    'specifications', ut.specifications,
    'last_sharpened_at', ut.last_sharpened_at,
    'next_sharpening_due', ut.next_sharpening_due,
    'created_at', ut.created_at,
    'tool_categories', jsonb_build_object('name', COALESCE(tc.name, ''))
  ) INTO v_tool
  FROM public.user_tools ut
  LEFT JOIN public.tool_categories tc ON tc.id = ut.tool_category_id
  WHERE ut.id = p_tool_id;

  IF v_tool IS NULL THEN
    RETURN NULL; -- ferramenta inexistente → front mostra "não encontrada"
  END IF;

  SELECT COALESCE(
    jsonb_agg(
      jsonb_build_object(
        'id', te.id,
        'event_type', te.event_type,
        'description', te.description,
        'created_at', te.created_at
      ) ORDER BY te.created_at DESC
    ),
    '[]'::jsonb
  ) INTO v_events
  FROM public.tool_events te
  WHERE te.user_tool_id = p_tool_id;

  RETURN jsonb_build_object('tool', v_tool, 'events', v_events);
END;
$$;

-- Público (QR sem login).
REVOKE ALL ON FUNCTION public.get_public_tool_history(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_public_tool_history(uuid) TO anon, authenticated;
