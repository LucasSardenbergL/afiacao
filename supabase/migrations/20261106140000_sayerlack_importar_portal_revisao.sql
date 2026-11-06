-- ============================================================================================
-- Importar pedido do portal Sayerlack — revisão Fable + Codex (2026-11) [money-path]
-- ⚠️ MIGRATION MANUAL. Ordem de deploy: ESTA migration → edge sayerlack-importar-pedido-portal (chama a assinatura nova).
--
-- RPC sayerlack_importar_pedido_portal ganha p_condicao_portal (assinatura nova ⇒ DROP + CREATE ⇒ ACL reemitido abaixo):
--   • IP006 compara CADA número de contrato composto ("1998739/1998740") — antes o botão criava 2º PO (P1).
--   • IP008 recusa enquanto houver pedido do app em envio/conciliação no portal — a mesma trava do cron (P1).
--   • IP007 condição de pagamento LIDA do portal → catálogo do Omie por texto exato; antes gravava a condição à vista fixa (P1).
-- Nova sayerlack_painel_portal(): leitura SÓ de staff para o card "Varredura do portal" em Gerir pedidos —
--   pendências abertas do cron, importados recentes e importados ainda sem PO no Omie.
-- Todos os UPDATE com WHERE (pg-safeupdate do Supabase recusa UPDATE sem WHERE vindo da API).
-- ============================================================================================

DROP FUNCTION IF EXISTS public.sayerlack_importar_pedido_portal(text, date, numeric, jsonb, uuid);

CREATE OR REPLACE FUNCTION public.sayerlack_importar_pedido_portal(
  p_protocolo     text,
  p_data_entrega  date,
  p_valor_total   numeric,
  p_itens         jsonb,
  p_operador      uuid,
  p_condicao_portal text
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
  v_em_voo      text;
  v_cond_txt    text;
  v_cond_alvo   text;
  v_cond_n      integer;
  v_cond_codigo text;
  v_cond_desc   text;
  v_cond_parc   integer;
  v_cond_matches integer;
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
   WHERE t.empresa::text = 'OBEN'
     -- Contrato COMPOSTO ("1998739/1998740", 15 POs em prod): compara cada número (Codex+Fable 2026-11, P1).
     AND EXISTS (SELECT 1 FROM unnest(string_to_array(t.numero_contrato_fornecedor, '/')) AS c(n) WHERE btrim(c.n) = p_protocolo);
  IF v_po_omie IS NOT NULL THEN
    RAISE EXCEPTION 'importar_portal: já existe pedido de compra no Omie com o contrato % (PO %)', p_protocolo, v_po_omie USING ERRCODE = 'IP006';
  END IF;

  -- IP008 — pedido do PRÓPRIO app em envio/conciliação no portal (ainda sem protocolo no banco): o nº digitado pode
  -- ser ele — importar criaria 2º pedido e tomaria o protocolo do envio em voo (Codex+Fable 2026-11). Mesma trava do cron.
  SELECT string_agg('#' || id || ' (' || status_envio_portal || ')', ', ' ORDER BY id) INTO v_em_voo
    FROM public.pedido_compra_sugerido
   WHERE empresa = 'OBEN'
     AND status_envio_portal IN ('enviando_portal', 'aceito_portal_sem_protocolo', 'indeterminado_requer_conciliacao');
  IF v_em_voo IS NOT NULL THEN
    RAISE EXCEPTION 'importar_portal: pedido(s) do app em envio/conciliação no portal: % — espere terminar (ou concilie) e importe de novo', v_em_voo USING ERRCODE = 'IP008';
  END IF;

  -- IP007 — condição de pagamento LIDA do portal ("70 - 7 DIAS") → catálogo do Omie por correspondência EXATA de texto
  -- (regra do founder, 2026-11): "N DIAS" → "Para N dias"; "28/56" → a condição de mesmo texto; "À VISTA" → 000.
  -- Sem correspondência única ⇒ recusa. Nunca chuta e nunca cai em "À Vista" (ausente ≠ à vista).
  v_cond_txt := upper(btrim(regexp_replace(coalesce(p_condicao_portal, ''), '^\s*[0-9A-Za-z]+\s+-\s+', '')));
  v_cond_txt := btrim(regexp_replace(v_cond_txt, '\s*(DIAS|DIA|DDL|DD)\.?\s*$', ''));
  IF v_cond_txt ~ '^[0-9]+$' THEN
    v_cond_n := v_cond_txt::integer;
    SELECT count(*), min(codigo), min(descricao), min(num_parcelas) INTO v_cond_matches, v_cond_codigo, v_cond_desc, v_cond_parc
      FROM public.omie_condicao_pagamento_catalogo
     WHERE empresa = 'OBEN' AND ativo AND lower(btrim(descricao)) = 'para ' || v_cond_n || ' dias';
  ELSIF v_cond_txt ~ '^[0-9]+(\s*/\s*[0-9]+)+$' THEN
    v_cond_alvo := regexp_replace(v_cond_txt, '\s*/\s*', '/', 'g');
    SELECT count(*), min(codigo), min(descricao), min(num_parcelas) INTO v_cond_matches, v_cond_codigo, v_cond_desc, v_cond_parc
      FROM public.omie_condicao_pagamento_catalogo
     WHERE empresa = 'OBEN' AND ativo AND regexp_replace(btrim(descricao), '\s*/\s*', '/', 'g') = v_cond_alvo;
  ELSIF v_cond_txt ~ '^(A|À) ?VISTA$' THEN
    SELECT count(*), min(codigo), min(descricao), min(num_parcelas) INTO v_cond_matches, v_cond_codigo, v_cond_desc, v_cond_parc
      FROM public.omie_condicao_pagamento_catalogo
     WHERE empresa = 'OBEN' AND ativo AND codigo = '000';
  ELSE
    v_cond_matches := 0;
  END IF;
  IF coalesce(v_cond_matches, 0) <> 1 OR v_cond_codigo IS NULL OR coalesce(v_cond_parc, 0) < 1 THEN
    RAISE EXCEPTION 'importar_portal: condição de pagamento "%" do portal sem correspondente único no Omie', coalesce(p_condicao_portal, '(vazia)') USING ERRCODE = 'IP007';
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
    v_cond_codigo, v_cond_desc, v_cond_parc, 'portal_sayerlack',
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

REVOKE ALL ON FUNCTION public.sayerlack_importar_pedido_portal(text, date, numeric, jsonb, uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.sayerlack_importar_pedido_portal(text, date, numeric, jsonb, uuid, text) FROM anon;
REVOKE ALL ON FUNCTION public.sayerlack_importar_pedido_portal(text, date, numeric, jsonb, uuid, text) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.sayerlack_importar_pedido_portal(text, date, numeric, jsonb, uuid, text) TO service_role;

CREATE OR REPLACE FUNCTION public.sayerlack_painel_portal()
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $painel$
BEGIN
  IF auth.uid() IS NULL OR NOT (public.has_role(auth.uid(), 'employee'::app_role) OR public.has_role(auth.uid(), 'master'::app_role)) THEN
    RAISE EXCEPTION 'Acesso negado: requer perfil staff' USING ERRCODE = '42501';
  END IF;
  RETURN jsonb_build_object(
    'pendencias', coalesce((
      SELECT jsonb_agg(jsonb_build_object('protocolo', f.protocolo, 'mensagem', f.mensagem, 'tentativas', f.tentativas,
                                          'primeira_em', f.primeira_em, 'ultima_em', f.ultima_em) ORDER BY f.ultima_em DESC)
        FROM (SELECT * FROM public.sayerlack_varredura_falha WHERE resolvido_em IS NULL ORDER BY ultima_em DESC LIMIT 50) f
    ), '[]'::jsonb),
    'sem_po', coalesce((
      SELECT jsonb_agg(jsonb_build_object('pedido_id', p.id, 'protocolo', p.portal_protocolo, 'status', p.status,
                                          'importado_em', p.importado_portal_em) ORDER BY p.importado_portal_em DESC)
        FROM (SELECT * FROM public.pedido_compra_sugerido
               WHERE importado_portal_em IS NOT NULL
                 AND (omie_pedido_compra_id IS NULL OR btrim(omie_pedido_compra_id::text) IN ('', '0'))
                 AND status NOT IN ('cancelado', 'rejeitado', 'expirado_sem_aprovacao')
               ORDER BY importado_portal_em DESC LIMIT 50) p
    ), '[]'::jsonb),
    'importados', coalesce((
      SELECT jsonb_agg(jsonb_build_object('pedido_id', p.id, 'protocolo', p.portal_protocolo, 'omie_numero', p.omie_pedido_compra_numero,
                                          'valor_total', p.valor_total, 'importado_em', p.importado_portal_em,
                                          'origem', CASE WHEN p.importado_portal_por IS NULL THEN 'cron' ELSE 'botao' END)
               ORDER BY p.importado_portal_em DESC)
        FROM (SELECT * FROM public.pedido_compra_sugerido
               WHERE importado_portal_em >= now() - interval '14 days'
               ORDER BY importado_portal_em DESC LIMIT 50) p
    ), '[]'::jsonb)
  );
END;
$painel$;

REVOKE ALL ON FUNCTION public.sayerlack_painel_portal() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.sayerlack_painel_portal() FROM anon;
GRANT EXECUTE ON FUNCTION public.sayerlack_painel_portal() TO authenticated, service_role;

DO $post$
DECLARE v_src text;
BEGIN
  IF to_regprocedure('public.sayerlack_importar_pedido_portal(text, date, numeric, jsonb, uuid)') IS NOT NULL THEN
    RAISE EXCEPTION 'A1 FALHOU: a assinatura antiga (5 args, condição à vista fixa) ainda existe';
  END IF;
  SELECT prosrc INTO v_src FROM pg_proc WHERE oid = to_regprocedure('public.sayerlack_importar_pedido_portal(text, date, numeric, jsonb, uuid, text)');
  IF v_src IS NULL THEN
    RAISE EXCEPTION 'A2 FALHOU: RPC nova (6 args) ausente';
  END IF;
  IF EXISTS (SELECT 1 FROM regexp_matches(v_src, '\mUPDATE\s[^;]*;', 'gi') AS m(x) WHERE m.x[1] !~* '\mWHERE\M') THEN
    RAISE EXCEPTION 'A3 FALHOU: UPDATE sem WHERE no corpo — o pg-safeupdate do Supabase recusa a importação';
  END IF;
  IF v_src ~ '''000'',\s*''À Vista''' THEN
    RAISE EXCEPTION 'A4 FALHOU: condição à vista fixa ainda no corpo';
  END IF;
  IF has_function_privilege('anon', 'public.sayerlack_importar_pedido_portal(text, date, numeric, jsonb, uuid, text)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.sayerlack_importar_pedido_portal(text, date, numeric, jsonb, uuid, text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'A5 FALHOU: RPC de importar executável por anon/authenticated — SECURITY DEFINER aberta';
  END IF;
  IF NOT has_function_privilege('service_role', 'public.sayerlack_importar_pedido_portal(text, date, numeric, jsonb, uuid, text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'A6 FALHOU: service_role sem EXECUTE — a edge não conseguiria importar';
  END IF;
  IF has_function_privilege('anon', 'public.sayerlack_painel_portal()', 'EXECUTE') THEN
    RAISE EXCEPTION 'A7 FALHOU: painel do portal executável por anon';
  END IF;
END
$post$;
