-- Closed-loop da lista de ligação (PR2c): escrita do log de contato por staff via RPC SECURITY DEFINER.
-- Hoje route_contact_log só tem policy de SELECT (staff); a escrita era reservada a service_role (PR2b).
-- Estas RPCs dão ao VENDEDOR (authenticated) um caminho de escrita controlado:
--   • farmer_id := auth.uid() server-side (anti-IDOR — o cliente não escolhe o vendedor);
--   • canal fixo 'ligacao'; status validado contra a allow-list;
--   • gate staff (employee/master) + VISIBILIDADE DE CARTEIRA (não basta ser staff — tem que poder
--     afetar ESTE cliente; senão um vendedor registraria opt_out/convertido de cliente alheio);
--   • advisory lock por chave lógica + dedupe 2min (idempotência do duplo-toque no celular).
-- Idempotente (CREATE OR REPLACE). ⚠️ APLICAR MANUALMENTE no SQL Editor do Lovable.

CREATE OR REPLACE FUNCTION public.registrar_contato_rota(
  p_customer_user_id uuid, p_status text, p_data_rota date,
  p_bucket text DEFAULT NULL, p_valor numeric DEFAULT NULL
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_uid uuid := auth.uid(); v_existing uuid; v_id uuid;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.user_roles ur WHERE ur.user_id = v_uid AND ur.role IN ('employee','master')) THEN
    RAISE EXCEPTION 'forbidden: staff only';
  END IF;
  IF p_customer_user_id IS NULL THEN RAISE EXCEPTION 'customer_user_id required'; END IF;
  IF p_data_rota IS NULL THEN RAISE EXCEPTION 'data_rota required'; END IF;
  IF p_status NOT IN ('convertido','respondido','sem_resposta','opt_out') THEN
    RAISE EXCEPTION 'invalid status: %', p_status;
  END IF;
  -- staff responde "é staff?", não "pode afetar ESTE cliente?" — exige visibilidade de carteira.
  IF NOT (COALESCE(public.pode_ver_carteira_completa(v_uid), false)
          OR public.carteira_visivel_para(p_customer_user_id, v_uid)) THEN
    RAISE EXCEPTION 'forbidden: customer not visible';
  END IF;
  -- serializa o dedupe por chave lógica (evita race do SELECT→INSERT em double-click concorrente).
  PERFORM pg_advisory_xact_lock(hashtextextended(
    v_uid::text||':'||p_customer_user_id::text||':'||p_data_rota::text||':'||p_status||':ligacao', 0));
  -- dedupe idempotente: mesmo vendedor+cliente+rota+status nos últimos 2 min → devolve o existente.
  SELECT id INTO v_existing FROM public.route_contact_log
   WHERE farmer_id = v_uid AND customer_user_id = p_customer_user_id
     AND data_rota = p_data_rota AND status = p_status AND canal = 'ligacao'
     AND created_at > now() - interval '2 minutes'
   ORDER BY created_at DESC LIMIT 1;
  IF v_existing IS NOT NULL THEN
    RETURN jsonb_build_object('id', v_existing, 'deduped', true);
  END IF;
  INSERT INTO public.route_contact_log (data_rota, customer_user_id, farmer_id, canal, valor_da_ligacao, bucket, status)
  VALUES (p_data_rota, p_customer_user_id, v_uid, 'ligacao', p_valor, p_bucket, p_status)
  RETURNING id INTO v_id;
  RETURN jsonb_build_object('id', v_id, 'deduped', false);
END $$;

-- Undo curto: deleta SÓ o próprio registro recente (own + < 5 min) — suporta o "Desfazer" do UI.
-- Retorna {deleted} (não no-op silencioso) p/ a UI não mostrar "desfeito" quando expirou/já apagado.
CREATE OR REPLACE FUNCTION public.desfazer_contato_rota(p_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_deleted int;
BEGIN
  DELETE FROM public.route_contact_log
   WHERE id = p_id AND farmer_id = auth.uid() AND created_at > now() - interval '5 minutes';
  GET DIAGNOSTICS v_deleted = ROW_COUNT;
  RETURN jsonb_build_object('deleted', v_deleted > 0);
END $$;

REVOKE ALL ON FUNCTION public.registrar_contato_rota(uuid,text,date,text,numeric) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.desfazer_contato_rota(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.registrar_contato_rota(uuid,text,date,text,numeric) TO authenticated;
GRANT EXECUTE ON FUNCTION public.desfazer_contato_rota(uuid) TO authenticated;
