-- Portal Sayerlack, revisão 2, item 7.1 — vincular o PO lançado À MÃO no Omie ao pedido do app.
--
-- Antes: a importadora e a reconsulta da varredura DETECTAVAM o PO manual (`po_manual_no_omie`) e paravam — o pedido
-- ficava sem PO no app para sempre ("até existir a vinculação"). Agora as duas chamam esta porta, que vincula só
-- quando o espelho do Omie PROVA que o PO é a compra deste pedido:
--   1. contrato: o protocolo é um TOKEN EXATO do `numero_contrato_fornecedor` (gramática da varredura: split '/' +
--      btrim — o composto "a/b" vale para os dois), nunca substring; ou o código de integração é o `AFI-<id>` deste
--      pedido. Mais de um PO candidato = ambíguo (nada se vincula).
--   2. dono: o PO não pode estar vinculado a outro pedido, nem ter o `AFI-<outro id>` do app.
--   3. conteúdo: o conjunto de SKUs é IGUAL, a quantidade por SKU é IGUAL e o valor por SKU (`nValTot`, com IPI)
--      difere de qtde_final × preco_unitario em no máximo max(R$0,01; 0,5 centavo por unidade). Calibrado em prod
--      (2026-11-08): dos 213 POs que o próprio app criou para pedidos do portal, 206 casam ao centavo e os 7 que não
--      casam são edições reais (SKU acrescentado no Omie, quantidade dobrada, composto com o item do outro protocolo).
--      Composto cujo PO carrega os itens do OUTRO protocolo diverge por conteúdo — é o comportamento desejado.
--   Ausente ≠ zero: PO sem `produtos_consulta` legível, item sem código/quantidade/valor, ou pedido com item sem
--   quantidade/preço ⇒ `conteudo_ausente`, nunca "casou".
-- O vínculo grava os mesmos campos que o disparador grava ao conciliar (`omie_pedido_compra_*`, status `disparado`,
-- claim limpo) e a trilha em `acoes_execucoes` com o ANTES e o DEPOIS. Recusa de negócio volta como
-- {vinculado:false, motivo}; entrada malformada é 22023; corrida é 40001.

CREATE OR REPLACE FUNCTION public.sayerlack_vincular_po_manual(p_pedido_id bigint, p_ator uuid, p_origem text)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE
  r           public.pedido_compra_sugerido%ROWTYPE;
  v_po_atual  text;
  v_proto     text;
  v_n         int;
  v_po        public.purchase_orders_tracking%ROWTYPE;
  v_ids       uuid[];
  v_sync_st   text;
  v_sync_em   timestamptz;
  v_cod       text;
  v_composto  boolean;
  v_prod      jsonb;
  v_diff      jsonb;
  v_app_ok    boolean;
  v_po_ok     boolean;
  v_dono      bigint;
  v_antes     jsonb;
  v_exec      uuid;
BEGIN
  IF p_pedido_id IS NULL OR p_origem IS NULL OR p_origem NOT IN ('importar', 'varredura') THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = '[VINCULAR-ENTRADA] pedido e origem (importar|varredura) são obrigatórios';
  END IF;

  SELECT * INTO r FROM public.pedido_compra_sugerido WHERE id = p_pedido_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('vinculado', false, 'motivo', 'pedido_nao_encontrado');
  END IF;
  v_proto := btrim(COALESCE(r.portal_protocolo, ''));
  IF r.empresa IS DISTINCT FROM 'OBEN' OR v_proto = '' THEN
    RETURN jsonb_build_object('vinculado', false, 'motivo', 'sem_protocolo_do_portal');
  END IF;
  v_po_atual := NULLIF(NULLIF(btrim(COALESCE(r.omie_pedido_compra_id, '')), ''), '0');
  IF v_po_atual IS NOT NULL THEN
    RETURN jsonb_build_object('vinculado', false, 'motivo', 'tem_po', 'po_codigo', v_po_atual,
                              'po_numero', r.omie_pedido_compra_numero);
  END IF;
  IF r.status IS NULL OR r.status NOT IN ('aprovado_aguardando_disparo', 'falha_envio') THEN
    RETURN jsonb_build_object('vinculado', false, 'motivo', 'status_nao_vinculavel', 'status', r.status);
  END IF;
  -- Claim aberto, de qualquer idade: uma tentativa de disparo pode ter criado o AFI-<id> no Omie com a resposta
  -- perdida. Quem resolve é a conciliação por consulta do disparador; vincular aqui arriscaria DOIS POs.
  IF r.disparo_claim_em IS NOT NULL THEN
    RETURN jsonb_build_object('vinculado', false, 'motivo', 'disparo_pendente', 'pendente_desde', r.disparo_claim_em);
  END IF;

  -- 1. Contrato: candidatos vivos no espelho (UMA consulta — o predicado do contrato mora num lugar só).
  SELECT array_agg(t.id ORDER BY t.id) INTO v_ids
    FROM public.purchase_orders_tracking t
   WHERE t.empresa::text = 'OBEN'
     AND t.status::text IS DISTINCT FROM 'CANCELADO'
     AND (btrim(COALESCE(t.omie_codigo_integracao, '')) = 'AFI-' || r.id
          OR EXISTS (SELECT 1 FROM unnest(string_to_array(t.numero_contrato_fornecedor, '/')) AS c(n)
                      WHERE btrim(c.n) = v_proto));
  v_n := COALESCE(array_length(v_ids, 1), 0);
  IF v_n = 0 THEN
    RETURN jsonb_build_object('vinculado', false, 'motivo', 'sem_po_manual');
  END IF;
  IF v_n > 1 THEN
    RETURN jsonb_build_object('vinculado', false, 'motivo', 'po_ambiguo', 'candidatos', v_n);
  END IF;
  -- Trava a LINHA do PO (Codex 7.1 P1): serializa dois pedidos disputando o mesmo PO (o 2º, ao destravar, vê o dono
  -- no passo 2) e impede o sync de cancelar/editar o PO entre a escolha e a gravação. Revalida sob a trava.
  SELECT t.* INTO v_po FROM public.purchase_orders_tracking t WHERE t.id = v_ids[1] FOR UPDATE;
  IF NOT FOUND OR v_po.status::text = 'CANCELADO'
     OR NOT (btrim(COALESCE(v_po.omie_codigo_integracao, '')) = 'AFI-' || r.id
             OR v_proto = ANY (SELECT btrim(x) FROM unnest(string_to_array(v_po.numero_contrato_fornecedor, '/')) AS x)) THEN
    RAISE EXCEPTION USING ERRCODE = '40001', MESSAGE = '[VINCULAR-CORRIDA] o PO mudou no espelho durante a vinculação';
  END IF;
  -- Espelho velho prova só a cópia velha (Codex 7.1 P2): o sync incremental do OBEN roda a cada poucos minutos;
  -- parado há mais de 2 h (ou sem estado), não vincula.
  SELECT s.status, s.last_sync_at INTO v_sync_st, v_sync_em
    FROM public.sync_state s WHERE s.entity_type = 'pedidos_compra' AND s.account = 'oben';
  IF v_sync_em IS NULL OR v_sync_st IS DISTINCT FROM 'complete' OR v_sync_em < now() - interval '2 hours' THEN
    RETURN jsonb_build_object('vinculado', false, 'motivo', 'espelho_desatualizado', 'po_numero', v_po.numero_pedido,
                              'espelho_sync_status', v_sync_st, 'espelho_sync_em', v_sync_em);
  END IF;
  v_cod := NULLIF(NULLIF(v_po.omie_codigo_pedido::text, ''), '0');
  IF v_cod IS NULL THEN
    RETURN jsonb_build_object('vinculado', false, 'motivo', 'conteudo_ausente', 'detalhe', 'PO sem código no espelho');
  END IF;
  v_composto := array_length(string_to_array(COALESCE(v_po.numero_contrato_fornecedor, ''), '/'), 1) > 1;

  -- 2. Dono: o PO não é de outro pedido.
  IF btrim(COALESCE(v_po.omie_codigo_integracao, '')) ~ '^AFI-[0-9]+$'
     AND btrim(v_po.omie_codigo_integracao) <> 'AFI-' || r.id THEN
    RETURN jsonb_build_object('vinculado', false, 'motivo', 'po_de_outro_pedido',
                              'po_numero', v_po.numero_pedido, 'codigo_integracao', btrim(v_po.omie_codigo_integracao));
  END IF;
  SELECT p.id INTO v_dono FROM public.pedido_compra_sugerido p
   WHERE p.id <> r.id AND btrim(COALESCE(p.omie_pedido_compra_id, '')) = v_cod LIMIT 1;
  IF v_dono IS NOT NULL THEN
    RETURN jsonb_build_object('vinculado', false, 'motivo', 'po_de_outro_pedido',
                              'po_numero', v_po.numero_pedido, 'outro_pedido_id', v_dono);
  END IF;

  -- 3. Conteúdo. Ausente ≠ zero, nas duas pontas.
  v_prod := v_po.raw_data->'produtos_consulta';
  v_po_ok := v_prod IS NOT NULL AND jsonb_typeof(v_prod) = 'array' AND jsonb_array_length(v_prod) > 0
    AND NOT EXISTS (
      SELECT 1 FROM jsonb_array_elements(v_prod) e
       WHERE jsonb_typeof(e) <> 'object'
          OR jsonb_typeof(e->'nCodProd') IS DISTINCT FROM 'number'
          -- CASE, não OR: o SQL não garante a ordem do OR, e o cast de um não-número lançaria 22P02.
          OR CASE WHEN jsonb_typeof(e->'nQtde') = 'number' THEN (e->>'nQtde')::numeric <= 0 ELSE true END
          OR CASE WHEN jsonb_typeof(e->'nValTot') = 'number' THEN (e->>'nValTot')::numeric < 0 ELSE true END);
  v_app_ok := EXISTS (SELECT 1 FROM public.pedido_compra_item i WHERE i.pedido_id = r.id)
    AND NOT EXISTS (
      SELECT 1 FROM public.pedido_compra_item i
       WHERE i.pedido_id = r.id
         AND (NULLIF(btrim(COALESCE(i.sku_codigo_omie, '')), '') IS NULL
              OR i.qtde_final IS NULL OR i.qtde_final <= 0
              OR i.preco_unitario IS NULL OR i.preco_unitario <= 0));
  IF NOT v_po_ok OR NOT v_app_ok THEN
    RETURN jsonb_build_object('vinculado', false, 'motivo', 'conteudo_ausente', 'po_numero', v_po.numero_pedido,
                              'detalhe', CASE WHEN NOT v_po_ok THEN 'itens do PO ilegíveis no espelho do Omie'
                                              ELSE 'pedido do app com item sem SKU, quantidade ou preço' END);
  END IF;

  WITH app AS (
    SELECT btrim(i.sku_codigo_omie) AS sku, sum(i.qtde_final) AS q, sum(round(i.qtde_final * i.preco_unitario, 2)) AS v
      FROM public.pedido_compra_item i WHERE i.pedido_id = r.id GROUP BY 1
  ), po AS (
    SELECT (e->>'nCodProd') AS sku, sum((e->>'nQtde')::numeric) AS q, sum((e->>'nValTot')::numeric) AS v
      FROM jsonb_array_elements(v_prod) e GROUP BY 1
  ), j AS (
    SELECT COALESCE(a.sku, o.sku) AS sku, a.q AS qtde_app, o.q AS qtde_po, a.v AS valor_app, o.v AS valor_po
      FROM app a FULL JOIN po o ON o.sku = a.sku
  )
  SELECT COALESCE(jsonb_agg(to_jsonb(j) ORDER BY j.sku), '[]'::jsonb) INTO v_diff
    FROM j
   WHERE j.qtde_app IS NULL OR j.qtde_po IS NULL
      OR j.qtde_app <> j.qtde_po
      OR abs(j.valor_app - j.valor_po) > GREATEST(0.01, j.qtde_po * 0.005);
  IF jsonb_array_length(v_diff) > 0 THEN
    RETURN jsonb_build_object('vinculado', false, 'motivo', 'conteudo_divergente', 'po_numero', v_po.numero_pedido,
                              'po_codigo', v_cod, 'contrato', v_po.numero_contrato_fornecedor,
                              'contrato_composto', v_composto, 'diferencas', v_diff);
  END IF;

  -- 4. Vínculo + trilha, na MESMA transação.
  v_antes := jsonb_build_object('status', r.status, 'omie_pedido_compra_id', r.omie_pedido_compra_id,
                                'omie_pedido_compra_numero', r.omie_pedido_compra_numero,
                                'omie_registrado_em', r.omie_registrado_em, 'disparo_claim_em', r.disparo_claim_em);
  UPDATE public.pedido_compra_sugerido
     SET omie_pedido_compra_id = v_cod,
         omie_pedido_compra_numero = v_po.numero_pedido,
         omie_registrado_em = now(),
         status = 'disparado',
         disparo_claim_em = NULL,
         disparo_claim_por = NULL,
         atualizado_em = now()
   WHERE id = r.id
     AND status = r.status
     AND disparo_claim_em IS NULL
     AND NULLIF(NULLIF(btrim(COALESCE(omie_pedido_compra_id, '')), ''), '0') IS NULL;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  IF v_n <> 1 THEN
    -- Impossível sob o FOR UPDATE acima; se acontecer, nada fica meio feito.
    RAISE EXCEPTION USING ERRCODE = '40001', MESSAGE = '[VINCULAR-CORRIDA] o pedido mudou durante a vinculação';
  END IF;

  INSERT INTO public.acoes_execucoes (acao, origem, executado_por, iniciado_em, finalizado_em, status, detalhes)
  VALUES ('sayerlack_vincular_po_manual', CASE WHEN p_ator IS NULL THEN 'automatica' ELSE 'manual' END, p_ator,
          now(), now(), 'sucesso',
          jsonb_build_object(
            'pedido_id', r.id, 'protocolo', v_proto, 'origem', p_origem,
            'po_codigo', v_cod, 'po_numero', v_po.numero_pedido, 'contrato', v_po.numero_contrato_fornecedor,
            'contrato_composto', v_composto, 'codigo_integracao', v_po.omie_codigo_integracao,
            'po_status_espelho', v_po.status::text, 'espelho_atualizado_em', v_po.updated_at,
            'espelho_sync_status', v_sync_st, 'espelho_sync_em', v_sync_em,
            'antes', v_antes,
            'depois', jsonb_build_object('status', 'disparado', 'omie_pedido_compra_id', v_cod,
                                         'omie_pedido_compra_numero', v_po.numero_pedido)))
  RETURNING id INTO v_exec;

  RETURN jsonb_build_object('vinculado', true, 'motivo', 'vinculado', 'pedido_id', r.id, 'protocolo', v_proto,
                            'po_codigo', v_cod, 'po_numero', v_po.numero_pedido,
                            'contrato_composto', v_composto, 'execucao_id', v_exec);
END;
$$;
REVOKE ALL ON FUNCTION public.sayerlack_vincular_po_manual(bigint, uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.sayerlack_vincular_po_manual(bigint, uuid, text) FROM anon;
REVOKE ALL ON FUNCTION public.sayerlack_vincular_po_manual(bigint, uuid, text) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.sayerlack_vincular_po_manual(bigint, uuid, text) TO service_role;

-- ── POS ───────────────────────────────────────────────────────────────────────────────────────────
DO $pos$
BEGIN
  IF to_regprocedure('public.sayerlack_vincular_po_manual(bigint,uuid,text)') IS NULL THEN
    RAISE EXCEPTION 'V1 FALHOU: porta ausente';
  END IF;
  IF has_function_privilege('anon', 'public.sayerlack_vincular_po_manual(bigint,uuid,text)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.sayerlack_vincular_po_manual(bigint,uuid,text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'V2 FALHOU: porta aberta para anon/authenticated';
  END IF;
  IF NOT has_function_privilege('service_role', 'public.sayerlack_vincular_po_manual(bigint,uuid,text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'V3 FALHOU: service_role sem EXECUTE';
  END IF;
  RAISE NOTICE 'VINCULAR_PO_MANUAL_POS_OK';
END
$pos$;
