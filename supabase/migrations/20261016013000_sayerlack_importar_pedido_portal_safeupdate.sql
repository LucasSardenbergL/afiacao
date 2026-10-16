-- ============================================================================================
-- Importar pedido do portal Sayerlack — UPDATE com WHERE (pg-safeupdate) [money-path]
-- ⚠️ MIGRATION MANUAL. CREATE OR REPLACE da RPC de 20261014120000 (preserva o ACL: REVOKE anon/authenticated).
--
-- 1º uso real (pedido 2141068, 2026-10-16): a leitura do portal passou e a gravação recusou com
-- "UPDATE requires a WHERE clause". O Supabase carrega o pg-safeupdate nas sessões da API (PostgREST),
-- que recusa UPDATE/DELETE sem WHERE — e a função tinha 2 UPDATE sem WHERE na tabela temporária de itens.
-- O PG17 local não carrega a extensão, por isso a prova não pegou; o teste agora reprova UPDATE sem WHERE
-- no corpo da função. Tudo-ou-nada funcionou: nada foi gravado.
-- Única mudança: os 2 UPDATE ganham WHERE (qtde_omie/descricao IS NULL — ambos nascem NULL nesta transação).
-- ============================================================================================

CREATE OR REPLACE FUNCTION public.sayerlack_importar_pedido_portal(
  p_protocolo     text,
  p_data_entrega  date,
  p_valor_total   numeric,
  p_itens         jsonb,
  p_operador      uuid
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_existente   bigint;
  v_n           integer;
  v_sem_depara  text;
  v_fracionados text;
  v_fornecedor  text;
  v_n_fornec    integer;
  v_pedido_id   bigint;
  v_payload     jsonb;
  v_atualizados integer;
  v_po_omie     text;
BEGIN
  -- Gate de papel (defesa em profundidade; a tranca é o privilégio: só service_role executa).
  IF auth.uid() IS NOT NULL AND NOT (public.has_role(auth.uid(), 'employee'::app_role) OR public.has_role(auth.uid(), 'master'::app_role)) THEN
    RAISE EXCEPTION 'Acesso negado: requer perfil staff' USING ERRCODE = '42501';
  END IF;

  -- IP001 — payload. Ausente ≠ zero: nada aqui degrada para default.
  IF p_protocolo IS NULL OR p_protocolo !~ '^[0-9]{3,12}$' THEN
    RAISE EXCEPTION 'importar_portal: protocolo inválido (%)', coalesce(p_protocolo, 'null') USING ERRCODE = 'IP001';
  END IF;
  IF p_data_entrega IS NULL THEN
    RAISE EXCEPTION 'importar_portal: data de entrega ausente' USING ERRCODE = 'IP001';
  END IF;
  IF p_valor_total IS NULL OR p_valor_total = 'NaN'::numeric OR NOT (p_valor_total > 0 AND p_valor_total < 'Infinity'::numeric) THEN
    RAISE EXCEPTION 'importar_portal: valor_total não finito ou ≤ 0 (%)', coalesce(p_valor_total::text, 'null') USING ERRCODE = 'IP001';
  END IF;
  IF p_itens IS NULL OR jsonb_typeof(p_itens) <> 'array' OR jsonb_array_length(p_itens) = 0 THEN
    RAISE EXCEPTION 'importar_portal: pedido sem itens' USING ERRCODE = 'IP001';
  END IF;
  -- `IS DISTINCT FROM`, nunca `<>`: chave ausente dá NULL e `NULL <> 'number'` passaria (verde por ausência).
  IF EXISTS (
    SELECT 1 FROM jsonb_array_elements(p_itens) e
     WHERE jsonb_typeof(e) IS DISTINCT FROM 'object'
        OR jsonb_typeof(e->'sku_portal') IS DISTINCT FROM 'string'
        OR btrim(e->>'sku_portal') = ''
        OR jsonb_typeof(e->'qtde_portal') IS DISTINCT FROM 'number'
        OR jsonb_typeof(e->'valor_mercadoria') IS DISTINCT FROM 'number'
  ) THEN
    RAISE EXCEPTION 'importar_portal: item sem sku_portal/qtde_portal/valor_mercadoria' USING ERRCODE = 'IP001';
  END IF;
  IF EXISTS (
    SELECT 1 FROM jsonb_array_elements(p_itens) e
     WHERE NOT ((e->>'qtde_portal')::numeric > 0 AND (e->>'valor_mercadoria')::numeric > 0)
  ) THEN
    RAISE EXCEPTION 'importar_portal: qtde_portal ou valor_mercadoria ≤ 0' USING ERRCODE = 'IP001';
  END IF;

  -- Serializa importações do MESMO protocolo (duas abas, duplo clique): a 2ª espera e cai no "já existe".
  PERFORM pg_advisory_xact_lock(hashtext('sayerlack_importar_pedido_portal:' || p_protocolo));

  SELECT id INTO v_existente FROM public.pedido_compra_sugerido WHERE portal_protocolo = p_protocolo;
  IF v_existente IS NOT NULL THEN
    RETURN jsonb_build_object('pedido_id', v_existente, 'ja_existia', true);
  END IF;

  -- IP006 — PO lançado DIRETO no Omie com este nº do portal no contrato (sem passar pelo app: 210 Sayerlack
  -- assim em 2026-10-14). Importar criaria um 2º PO com outra chave AFI-<id>. Codex 2026-10-14, P1.
  -- Limite: o espelho `purchase_orders_tracking` tem a defasagem do sync — PO digitado no Omie minutos antes escapa.
  SELECT string_agg(coalesce(t.numero_pedido, '?'), ', ') INTO v_po_omie
    FROM public.purchase_orders_tracking t
   WHERE t.empresa::text = 'OBEN' AND btrim(t.numero_contrato_fornecedor) = p_protocolo;
  IF v_po_omie IS NOT NULL THEN
    RAISE EXCEPTION 'importar_portal: já existe pedido de compra no Omie com o contrato % (PO %)', p_protocolo, v_po_omie USING ERRCODE = 'IP006';
  END IF;

  v_n := jsonb_array_length(p_itens);

  -- IP005 — o mesmo SKU duas vezes no pedido do portal: a prova de custo é por item, não somamos às cegas.
  IF (SELECT count(DISTINCT upper(btrim(e->>'sku_portal'))) FROM jsonb_array_elements(p_itens) e) <> v_n THEN
    RAISE EXCEPTION 'importar_portal: SKU repetido no pedido % do portal', p_protocolo USING ERRCODE = 'IP005';
  END IF;

  -- De-para inverso: EXATAMENTE um mapeamento ativo OBEN por sku_portal (o UNIQUE é por sku_omie,
  -- então 2 sku_omie com o mesmo sku_portal é possível — e é ambíguo, logo "sem de-para").
  CREATE TEMP TABLE IF NOT EXISTS _importar_portal_itens (
    ordem int, sku_portal text, qtde_portal numeric, valor_mercadoria numeric,
    n_map int, sku_omie text, fornecedor_nome text, fator numeric, qtde_omie numeric, descricao text
  ) ON COMMIT DROP;
  TRUNCATE _importar_portal_itens;
  INSERT INTO _importar_portal_itens (ordem, sku_portal, qtde_portal, valor_mercadoria, n_map, sku_omie, fornecedor_nome, fator)
  SELECT e.ord::int,
         upper(btrim(e.val->>'sku_portal')),
         (e.val->>'qtde_portal')::numeric,
         (e.val->>'valor_mercadoria')::numeric,
         (SELECT count(*) FROM public.sku_fornecedor_externo d
           WHERE d.empresa = 'OBEN' AND d.ativo AND upper(btrim(d.sku_portal)) = upper(btrim(e.val->>'sku_portal'))),
         (SELECT min(d.sku_omie) FROM public.sku_fornecedor_externo d
           WHERE d.empresa = 'OBEN' AND d.ativo AND upper(btrim(d.sku_portal)) = upper(btrim(e.val->>'sku_portal'))),
         (SELECT min(d.fornecedor_nome) FROM public.sku_fornecedor_externo d
           WHERE d.empresa = 'OBEN' AND d.ativo AND upper(btrim(d.sku_portal)) = upper(btrim(e.val->>'sku_portal'))),
         (SELECT min(d.fator_conversao) FROM public.sku_fornecedor_externo d
           WHERE d.empresa = 'OBEN' AND d.ativo AND upper(btrim(d.sku_portal)) = upper(btrim(e.val->>'sku_portal')))
    FROM jsonb_array_elements(p_itens) WITH ORDINALITY AS e(val, ord);

  SELECT string_agg(sku_portal || CASE WHEN n_map > 1 THEN ' (ambíguo: ' || n_map || ' SKUs Omie)' ELSE '' END, ', ' ORDER BY ordem)
    INTO v_sem_depara
    FROM _importar_portal_itens WHERE n_map <> 1;
  IF v_sem_depara IS NOT NULL THEN
    RAISE EXCEPTION 'importar_portal: sem de-para ativo no app para: %', v_sem_depara USING ERRCODE = 'IP002';
  END IF;

  -- IP004 — todos do MESMO fornecedor, e ele é a Sayerlack (o disparo decide portal×Omie pelo nome).
  SELECT count(DISTINCT fornecedor_nome), min(fornecedor_nome) INTO v_n_fornec, v_fornecedor FROM _importar_portal_itens;
  IF v_n_fornec <> 1 OR v_fornecedor IS NULL OR v_fornecedor !~* 'sayerlack' THEN
    RAISE EXCEPTION 'importar_portal: de-para aponta fornecedor(es) inesperado(s): %',
      (SELECT string_agg(DISTINCT coalesce(fornecedor_nome, 'null'), ', ') FROM _importar_portal_itens) USING ERRCODE = 'IP004';
  END IF;

  -- IP003 — fator = unidades do PORTAL por unidade do Omie ⇒ qtde_omie = qtde_portal ÷ fator, INTEIRA.
  -- (O PO manda nQtde inteiro e a RPC de custo exige qtde_final inteira; arredondar aqui mudaria o preço.)
  UPDATE _importar_portal_itens
     SET qtde_omie = CASE WHEN fator > 0 THEN qtde_portal / fator END
   WHERE qtde_omie IS NULL;  -- WHERE obrigatório: o pg-safeupdate do Supabase recusa UPDATE sem WHERE vindo da API
  SELECT string_agg(sku_portal || ' (' || trim_scale(qtde_portal) || ' ÷ fator ' || coalesce(trim_scale(fator)::text, 'null') || ')', ', ' ORDER BY ordem)
    INTO v_fracionados
    FROM _importar_portal_itens
   WHERE qtde_omie IS NULL OR NOT (qtde_omie > 0) OR qtde_omie <> trunc(qtde_omie);
  IF v_fracionados IS NOT NULL THEN
    RAISE EXCEPTION 'importar_portal: quantidade não vira inteira no Omie: %', v_fracionados USING ERRCODE = 'IP003';
  END IF;

  UPDATE _importar_portal_itens t
     SET descricao = (SELECT p.descricao FROM public.omie_products p
                       WHERE p.account = 'oben' AND p.omie_codigo_produto::text = t.sku_omie
                       LIMIT 1)
   WHERE t.descricao IS NULL;  -- idem: sem WHERE o pg-safeupdate recusa (1º uso real, 2026-10-16)

  INSERT INTO public.pedido_compra_sugerido (
    empresa, fornecedor_nome, valor_total, num_skus, status,
    aprovado_por, aprovado_em, canal_usado,
    condicao_pagamento_codigo, condicao_pagamento_descricao, num_parcelas, condicao_origem,
    status_envio_portal, enviado_portal_em, portal_protocolo, portal_data_entrega,
    importado_portal_em, importado_portal_por, resposta_canal
  ) VALUES (
    'OBEN', v_fornecedor,
    (SELECT sum(valor_mercadoria) FROM _importar_portal_itens),  -- provisório: a RPC de custo regrava com o IPI
    v_n, 'aprovado_aguardando_disparo',
    p_operador, now(), 'portal_sayerlack',
    '000', 'À Vista', 1, 'importado_portal',
    'sucesso_portal', now(), p_protocolo, p_data_entrega,
    now(), p_operador,
    jsonb_build_object('importado_portal', true, 'valor_total_portal', p_valor_total)
  ) RETURNING id INTO v_pedido_id;

  INSERT INTO public.pedido_compra_item (
    pedido_id, sku_codigo_omie, sku_descricao, qtde_sugerida, qtde_final,
    preco_unitario, valor_linha, sku_portal_aprovado, fator_portal_aprovado
  )
  SELECT v_pedido_id, t.sku_omie, coalesce(t.descricao, t.sku_portal), t.qtde_omie, t.qtde_omie,
         t.valor_mercadoria / t.qtde_omie, t.valor_mercadoria, t.sku_portal, t.fator
    FROM _importar_portal_itens t
   ORDER BY t.ordem;

  -- O custo pela MESMA prova do fluxo normal. O IPI do payload é a conta da própria RPC de custo
  -- (round(round(merc,2) × alíquota ÷ 100, 2)) sobre a alíquota de `sayerlack_ipi_itens`; a prova
  -- EXTERNA é o total cobrado pelo portal (p_valor_total). Alíquota ausente vira 0 só aqui, no
  -- payload — a RPC de custo recusa antes (CP006, ausente ≠ zero) e nada é gravado.
  SELECT jsonb_agg(jsonb_build_object(
           'item_id', i.id,
           'qtde_final', i.qtde_final,
           'valor_mercadoria', i.valor_linha,
           'valor_ipi', round(round(i.valor_linha, 2) * coalesce(x.aliquota_pct, 0) / 100, 2)
         ) ORDER BY i.id)
    INTO v_payload
    FROM public.pedido_compra_item i
    LEFT JOIN public.sayerlack_ipi_itens(v_pedido_id) x ON x.item_id = i.id
   WHERE i.pedido_id = v_pedido_id;

  v_atualizados := public.sayerlack_aplicar_custo_portal(v_pedido_id, v_payload, p_valor_total);
  IF v_atualizados <> v_n THEN
    RAISE EXCEPTION 'importar_portal: custo aplicado em % de % itens — nada gravado', v_atualizados, v_n USING ERRCODE = 'IP001';
  END IF;

  RETURN jsonb_build_object('pedido_id', v_pedido_id, 'ja_existia', false);
END;
$function$;

DO $post$
DECLARE v_src text;
BEGIN
  SELECT prosrc INTO v_src FROM pg_proc
   WHERE oid = to_regprocedure('public.sayerlack_importar_pedido_portal(text, date, numeric, jsonb, uuid)');
  IF v_src IS NULL THEN
    RAISE EXCEPTION 'A1 FALHOU: RPC sayerlack_importar_pedido_portal ausente';
  END IF;
  IF EXISTS (SELECT 1 FROM regexp_matches(v_src, '\mUPDATE\s[^;]*;', 'gi') AS m(x) WHERE m.x[1] !~* '\mWHERE\M') THEN
    RAISE EXCEPTION 'A2 FALHOU: UPDATE sem WHERE no corpo — o pg-safeupdate do Supabase recusa a importação';
  END IF;
  IF has_function_privilege('anon', 'public.sayerlack_importar_pedido_portal(text, date, numeric, jsonb, uuid)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.sayerlack_importar_pedido_portal(text, date, numeric, jsonb, uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'A3 FALHOU: RPC executável por anon/authenticated — SECURITY DEFINER aberta';
  END IF;
  IF NOT has_function_privilege('service_role', 'public.sayerlack_importar_pedido_portal(text, date, numeric, jsonb, uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'A4 FALHOU: service_role sem EXECUTE — a edge não conseguiria importar';
  END IF;
END
$post$;
