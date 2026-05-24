-- PR5 — Split de pedidos Sayerlack > 4 itens em filhos menores
-- O Browserless mata a função em 60s. Pelo trace real (15/05/2026), cada
-- item leva ~7.5s e setup/submit consome ~22s, então um pedido com mais
-- de 4 itens corre risco de não caber. Em vez de torcer, divide:
--   1 pedido aprovado (pai) → N filhos com até 4 itens cada.
-- Cada filho passa pelo fluxo normal (portal → protocolo → Omie),
-- gerando N pedidos Sayerlack e N pedidos de compra no Omie distintos.

-- 1. Colunas de relacionamento e auditoria
ALTER TABLE public.pedido_compra_sugerido
  ADD COLUMN IF NOT EXISTS split_parent_id bigint REFERENCES public.pedido_compra_sugerido(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS split_lote integer,
  ADD COLUMN IF NOT EXISTS split_total integer;

CREATE INDEX IF NOT EXISTS idx_pedido_compra_split_parent
  ON public.pedido_compra_sugerido (split_parent_id)
  WHERE split_parent_id IS NOT NULL;

COMMENT ON COLUMN public.pedido_compra_sugerido.split_parent_id IS
  'Se preenchido, este pedido é um filho gerado por pedido_compra_split() a partir do pedido referenciado (que ficou com status=split_em_filhos).';
COMMENT ON COLUMN public.pedido_compra_sugerido.split_lote IS
  'Lote 1-based deste filho dentro do split (1=primeiro chunk, 2=segundo, ...). Null em pedidos não divididos.';
COMMENT ON COLUMN public.pedido_compra_sugerido.split_total IS
  'Quantidade total de filhos gerados no split. No pai: total de filhos criados. Nos filhos: igual ao do pai. Null em pedidos não divididos.';

-- 2. RPC pedido_compra_split — atômica.
--    Carrega pedido com FOR UPDATE, valida estado, conta itens, cria N
--    filhos clonando metadados, MOVE chunks de itens para cada filho,
--    recalcula valor_total/num_skus dos filhos e marca o pai como
--    'split_em_filhos'. Tudo em uma única transação Postgres.
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
  -- ACL: service_role (sem auth.uid()) passa direto; user JWT exige staff.
  IF auth.uid() IS NOT NULL THEN
    IF NOT (public.has_role(auth.uid(), 'employee'::app_role) OR public.has_role(auth.uid(), 'master'::app_role)) THEN
      RAISE EXCEPTION 'Acesso negado: requer perfil staff' USING ERRCODE = '42501';
    END IF;
  END IF;

  IF p_chunk_size < 1 THEN
    RAISE EXCEPTION 'chunk_size deve ser >= 1';
  END IF;

  -- Lock no pai pra evitar split concorrente.
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

  -- Conta itens. Se cabe num chunk, não divide.
  SELECT count(*) INTO v_itens_total FROM public.pedido_compra_item WHERE pedido_id = p_pedido_id;

  IF v_itens_total <= p_chunk_size THEN
    RETURN;
  END IF;

  v_total_chunks := ceil(v_itens_total::numeric / p_chunk_size)::integer;

  -- Cria N filhos clonando metadados relevantes do pai (sem itens).
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

    -- Move chunk de itens pro filho atual (ORDER BY id, OFFSET, LIMIT).
    WITH lote_ids AS (
      SELECT id FROM public.pedido_compra_item
      WHERE pedido_id = p_pedido_id
      ORDER BY id
      OFFSET (v_chunk_idx - 1) * p_chunk_size
      LIMIT p_chunk_size
    )
    UPDATE public.pedido_compra_item pci
    SET pedido_id = v_filho_id
    FROM lote_ids
    WHERE pci.id = lote_ids.id;

    -- Recalcula totais do filho a partir dos itens já reapontados.
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

  -- Marca o pai como dividido. NÃO entra em fila de envio nem de Omie.
  UPDATE public.pedido_compra_sugerido SET
    status = 'split_em_filhos',
    status_envio_portal = 'nao_aplicavel',
    split_total = v_total_chunks,
    atualizado_em = now()
  WHERE id = p_pedido_id;
END;
$function$;

REVOKE ALL ON FUNCTION public.pedido_compra_split(bigint, integer) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.pedido_compra_split(bigint, integer) FROM anon;
GRANT EXECUTE ON FUNCTION public.pedido_compra_split(bigint, integer) TO authenticated, service_role;
