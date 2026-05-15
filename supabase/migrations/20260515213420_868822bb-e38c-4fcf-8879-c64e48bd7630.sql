CREATE OR REPLACE FUNCTION public.pedido_compra_split(
  p_pedido_id bigint,
  p_chunk_size integer DEFAULT 4
)
RETURNS TABLE(filho_id bigint, lote integer, total integer)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, pg_temp
AS $function$
DECLARE
  v_status text;
  v_split_parent bigint;
  v_itens_total integer;
  v_total_chunks integer;
  v_chunk_idx integer;
  v_filho_id bigint;
BEGIN
  IF auth.uid() IS NOT NULL THEN
    IF NOT (public.has_role(auth.uid(), 'employee'::app_role) OR public.has_role(auth.uid(), 'master'::app_role)) THEN
      RAISE EXCEPTION 'Acesso negado: requer perfil staff' USING ERRCODE = '42501';
    END IF;
  END IF;

  IF p_chunk_size < 1 THEN
    RAISE EXCEPTION 'chunk_size deve ser >= 1';
  END IF;

  SELECT status, split_parent_id INTO v_status, v_split_parent
  FROM public.pedido_compra_sugerido
  WHERE id = p_pedido_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Pedido % não encontrado', p_pedido_id;
  END IF;

  IF v_status <> 'aprovado_aguardando_disparo' THEN
    RAISE EXCEPTION 'Pedido % com status=% não pode ser dividido (esperado: aprovado_aguardando_disparo)', p_pedido_id, v_status;
  END IF;

  IF v_split_parent IS NOT NULL THEN
    RAISE EXCEPTION 'Pedido % já é filho de um split (parent=%)', p_pedido_id, v_split_parent;
  END IF;

  SELECT count(*) INTO v_itens_total FROM public.pedido_compra_item WHERE pedido_id = p_pedido_id;

  IF v_itens_total <= p_chunk_size THEN
    RETURN;
  END IF;

  v_total_chunks := ceil(v_itens_total::numeric / p_chunk_size)::integer;

  FOR v_chunk_idx IN 1..v_total_chunks LOOP
    INSERT INTO public.pedido_compra_sugerido (
      empresa, fornecedor_nome, grupo_codigo, data_ciclo,
      horario_geracao, horario_corte_planejado,
      valor_total, num_skus,
      status,
      condicao_pagamento_codigo, condicao_pagamento_descricao,
      num_parcelas, dias_parcelas, condicao_origem,
      aprovado_em, aprovado_por,
      criado_em, atualizado_em,
      split_parent_id, split_lote, split_total
    )
    SELECT
      p.empresa, p.fornecedor_nome, p.grupo_codigo, p.data_ciclo,
      p.horario_geracao, p.horario_corte_planejado,
      0, 0,
      'aprovado_aguardando_disparo',
      p.condicao_pagamento_codigo, p.condicao_pagamento_descricao,
      p.num_parcelas, p.dias_parcelas, p.condicao_origem,
      p.aprovado_em, p.aprovado_por,
      now(), now(),
      p_pedido_id, v_chunk_idx, v_total_chunks
    FROM public.pedido_compra_sugerido p
    WHERE p.id = p_pedido_id
    RETURNING id INTO v_filho_id;

    WITH lote_ids AS (
      SELECT id FROM public.pedido_compra_item
      WHERE pedido_id = p_pedido_id
      ORDER BY id
      LIMIT p_chunk_size
    )
    UPDATE public.pedido_compra_item pci
    SET pedido_id = v_filho_id
    FROM lote_ids
    WHERE pci.id = lote_ids.id;

    UPDATE public.pedido_compra_sugerido f
    SET
      num_skus = (SELECT count(*) FROM public.pedido_compra_item WHERE pedido_id = f.id),
      valor_total = COALESCE(
        (SELECT sum(COALESCE(valor_linha, qtde_final * preco_unitario, 0))
         FROM public.pedido_compra_item WHERE pedido_id = f.id),
        0
      )
    WHERE f.id = v_filho_id;

    filho_id := v_filho_id;
    lote := v_chunk_idx;
    total := v_total_chunks;
    RETURN NEXT;
  END LOOP;

  UPDATE public.pedido_compra_sugerido SET
    status = 'split_em_filhos',
    status_envio_portal = 'nao_aplicavel',
    split_total = v_total_chunks,
    atualizado_em = now()
  WHERE id = p_pedido_id;
END;
$function$;