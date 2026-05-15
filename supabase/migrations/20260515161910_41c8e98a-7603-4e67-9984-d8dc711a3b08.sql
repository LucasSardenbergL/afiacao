-- ============ PR1 ============
ALTER TABLE public.pedido_compra_sugerido
  DROP CONSTRAINT IF EXISTS pedido_compra_sugerido_status_envio_portal_check;
ALTER TABLE public.pedido_compra_sugerido
  ADD CONSTRAINT pedido_compra_sugerido_status_envio_portal_check
  CHECK (status_envio_portal IN (
    'nao_aplicavel','pendente_envio_portal','enviando_portal','enviado_portal','falha_envio_portal',
    'sucesso_portal','aceito_portal_sem_protocolo','indeterminado_requer_conciliacao','erro_retentavel','erro_nao_retentavel'
  ));

DROP INDEX IF EXISTS idx_pedido_status_envio_portal;
CREATE INDEX IF NOT EXISTS idx_pedido_status_envio_portal
  ON public.pedido_compra_sugerido (status_envio_portal)
  WHERE status_envio_portal IN ('pendente_envio_portal','falha_envio_portal','erro_retentavel');

CREATE TABLE IF NOT EXISTS public.pedidos_portal_tentativas (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  pedido_id bigint NOT NULL REFERENCES public.pedido_compra_sugerido(id) ON DELETE CASCADE,
  iniciado_em timestamptz NOT NULL DEFAULT now(),
  concluido_em timestamptz,
  status_resultado text NOT NULL,
  elapsed_ms integer,
  evidence jsonb NOT NULL DEFAULT '{}'::jsonb,
  browserless_response_ms integer,
  erro text
);
CREATE INDEX IF NOT EXISTS idx_pedidos_portal_tentativas_pedido ON public.pedidos_portal_tentativas (pedido_id, iniciado_em DESC);
CREATE INDEX IF NOT EXISTS idx_pedidos_portal_tentativas_iniciado ON public.pedidos_portal_tentativas (iniciado_em DESC);
CREATE INDEX IF NOT EXISTS idx_pedidos_portal_tentativas_status ON public.pedidos_portal_tentativas (status_resultado);

ALTER TABLE public.pedidos_portal_tentativas ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS pedidos_portal_tentativas_select_staff ON public.pedidos_portal_tentativas;
CREATE POLICY pedidos_portal_tentativas_select_staff
  ON public.pedidos_portal_tentativas FOR SELECT TO authenticated
  USING (public.has_role(auth.uid(), 'employee'::app_role) OR public.has_role(auth.uid(), 'master'::app_role));

CREATE OR REPLACE FUNCTION public.envio_portal_lock_candidatos(p_max integer DEFAULT 5)
 RETURNS TABLE(id bigint, empresa text, fornecedor_nome text, status_envio_portal text, portal_tentativas integer, portal_protocolo text)
 LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $function$
BEGIN
  IF auth.uid() IS NULL OR NOT (public.has_role(auth.uid(), 'employee'::app_role) OR public.has_role(auth.uid(), 'master'::app_role)) THEN
    RAISE EXCEPTION 'Acesso negado: requer perfil staff' USING ERRCODE = '42501';
  END IF;
  RETURN QUERY
  WITH candidatos AS (
    SELECT p.id, p.status_envio_portal AS status_anterior
    FROM public.pedido_compra_sugerido p
    WHERE p.status = 'disparado'
      AND p.status_envio_portal IN ('pendente_envio_portal','erro_retentavel')
      AND COALESCE(p.portal_tentativas, 0) < 3
      AND p.fornecedor_nome ILIKE '%SAYERLACK%' AND p.empresa = 'OBEN'
      AND (p.portal_proximo_retry_em IS NULL OR p.portal_proximo_retry_em <= now())
    ORDER BY p.aprovado_em ASC NULLS LAST, p.id ASC
    LIMIT p_max FOR UPDATE SKIP LOCKED
  ),
  travados AS (
    UPDATE public.pedido_compra_sugerido p
    SET status_envio_portal = 'enviando_portal'
    FROM candidatos c WHERE p.id = c.id
    RETURNING p.id, p.empresa, p.fornecedor_nome, c.status_anterior AS status_envio_portal,
              COALESCE(p.portal_tentativas, 0) AS portal_tentativas, p.portal_protocolo
  )
  SELECT t.id, t.empresa, t.fornecedor_nome, t.status_envio_portal, t.portal_tentativas, t.portal_protocolo FROM travados t;
END; $function$;

REVOKE ALL ON FUNCTION public.envio_portal_lock_candidatos(integer) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.envio_portal_lock_candidatos(integer) FROM authenticated, anon;
GRANT EXECUTE ON FUNCTION public.envio_portal_lock_candidatos(integer) TO service_role;

-- ============ PR4 ============
ALTER TABLE public.pedido_compra_sugerido
  ADD COLUMN IF NOT EXISTS portal_data_entrega date;
COMMENT ON COLUMN public.pedido_compra_sugerido.portal_data_entrega IS
  'Data de entrega confirmada pelo portal Sayerlack no momento do submit. Usada para calcular dDtPrevisao do pedido de compra no Omie (= portal_data_entrega + 2 dias corridos).';

-- ============ PR5 ============
ALTER TABLE public.pedido_compra_sugerido
  ADD COLUMN IF NOT EXISTS split_parent_id bigint REFERENCES public.pedido_compra_sugerido(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS split_lote integer,
  ADD COLUMN IF NOT EXISTS split_total integer;

CREATE INDEX IF NOT EXISTS idx_pedido_compra_split_parent
  ON public.pedido_compra_sugerido (split_parent_id) WHERE split_parent_id IS NOT NULL;

CREATE OR REPLACE FUNCTION public.pedido_compra_split(p_pedido_id bigint, p_chunk_size integer DEFAULT 4)
RETURNS TABLE(filho_id bigint, lote integer, total integer)
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO public, pg_temp AS $function$
DECLARE
  v_status text; v_split_parent bigint; v_itens_total integer;
  v_total_chunks integer; v_chunk_idx integer; v_filho_id bigint;
BEGIN
  IF auth.uid() IS NOT NULL THEN
    IF NOT (public.has_role(auth.uid(), 'employee'::app_role) OR public.has_role(auth.uid(), 'master'::app_role)) THEN
      RAISE EXCEPTION 'Acesso negado: requer perfil staff' USING ERRCODE = '42501';
    END IF;
  END IF;
  IF p_chunk_size < 1 THEN RAISE EXCEPTION 'chunk_size deve ser >= 1'; END IF;

  SELECT status, split_parent_id INTO v_status, v_split_parent
  FROM public.pedido_compra_sugerido WHERE id = p_pedido_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Pedido % não encontrado', p_pedido_id; END IF;
  IF v_status <> 'aprovado_aguardando_disparo' THEN
    RAISE EXCEPTION 'Pedido % com status=% não pode ser dividido (esperado: aprovado_aguardando_disparo)', p_pedido_id, v_status;
  END IF;
  IF v_split_parent IS NOT NULL THEN
    RAISE EXCEPTION 'Pedido % já é filho de um split (parent=%)', p_pedido_id, v_split_parent;
  END IF;

  SELECT count(*) INTO v_itens_total FROM public.pedido_compra_item WHERE pedido_id = p_pedido_id;
  IF v_itens_total <= p_chunk_size THEN RETURN; END IF;
  v_total_chunks := ceil(v_itens_total::numeric / p_chunk_size)::integer;

  FOR v_chunk_idx IN 1..v_total_chunks LOOP
    INSERT INTO public.pedido_compra_sugerido (
      empresa, fornecedor_nome, grupo_codigo, data_ciclo,
      horario_geracao, horario_corte_planejado, valor_total, num_skus, status,
      condicao_pagamento_codigo, condicao_pagamento_descricao,
      num_parcelas, dias_parcelas, condicao_origem, aprovado_em, aprovado_por,
      criado_em, atualizado_em, split_parent_id, split_lote, split_total
    )
    SELECT p.empresa, p.fornecedor_nome, p.grupo_codigo, p.data_ciclo,
      p.horario_geracao, p.horario_corte_planejado, 0, 0,
      'aprovado_aguardando_disparo',
      p.condicao_pagamento_codigo, p.condicao_pagamento_descricao,
      p.num_parcelas, p.dias_parcelas, p.condicao_origem, p.aprovado_em, p.aprovado_por,
      now(), now(), p_pedido_id, v_chunk_idx, v_total_chunks
    FROM public.pedido_compra_sugerido p WHERE p.id = p_pedido_id
    RETURNING id INTO v_filho_id;

    WITH lote_ids AS (
      SELECT id FROM public.pedido_compra_item WHERE pedido_id = p_pedido_id
      ORDER BY id OFFSET (v_chunk_idx - 1) * p_chunk_size LIMIT p_chunk_size
    )
    UPDATE public.pedido_compra_item pci SET pedido_id = v_filho_id
    FROM lote_ids WHERE pci.id = lote_ids.id;

    UPDATE public.pedido_compra_sugerido f SET
      num_skus = (SELECT count(*) FROM public.pedido_compra_item WHERE pedido_id = f.id),
      valor_total = COALESCE((SELECT sum(COALESCE(valor_linha, qtde_final * preco_unitario, 0))
         FROM public.pedido_compra_item WHERE pedido_id = f.id), 0)
    WHERE f.id = v_filho_id;

    filho_id := v_filho_id; lote := v_chunk_idx; total := v_total_chunks;
    RETURN NEXT;
  END LOOP;

  UPDATE public.pedido_compra_sugerido SET
    status = 'split_em_filhos', status_envio_portal = 'nao_aplicavel',
    split_total = v_total_chunks, atualizado_em = now()
  WHERE id = p_pedido_id;
END; $function$;

REVOKE ALL ON FUNCTION public.pedido_compra_split(bigint, integer) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.pedido_compra_split(bigint, integer) FROM anon;
GRANT EXECUTE ON FUNCTION public.pedido_compra_split(bigint, integer) TO authenticated, service_role;