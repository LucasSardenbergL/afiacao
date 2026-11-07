-- ============================================================================================
-- Portal Sayerlack, pontos cegos, Onda 2 + 7.4 — condição de pagamento REAL [money-path]
-- Plano: docs/superpowers/plans/2026-11-06-sayerlack-portal-pontos-cegos.md (itens 2.6 e 7.4, decisões D-1 e D-2).
-- ⚠️ MIGRATION MANUAL. Ordem de deploy: ESTA migration → edges sayerlack-importar-pedido-portal e
--    enviar-pedido-portal-sayerlack (a edge de envio chama sayerlack_aplicar_condicao_portal; sem a migration a chamada
--    falha e o pedido segue com a condição de hoje — fail-open de propósito, nunca trava o envio).
--
-- ⚠️ Ordem: esta migration → enviar-pedido-portal-sayerlack v1.13 → disparar-pedidos-aprovados (que passa a recusar
--    PO de pedido do app ainda em default_a_vista; antes do envio novo, recusaria todos).
-- 1. sayerlack_condicao_portal_de_para — de-para EXPLÍCITO condição do portal → código do catálogo Omie OBEN (D-2).
--    Semente: "30 DIAS" → A30 "Para 30 dias (C)" (pela regra exata de texto daria T54 "Para 30 dias").
-- 2. sayerlack_condicao_portal_para_omie(texto) — a ÚNICA tradução (de-para primeiro, regra exata depois), IP007 sem
--    correspondente único. Usada pela importação e pelo envio.
-- 3. pedido_compra_sugerido.condicao_portal_lida — o texto que o portal mostrou (prova e sensor). Escritores: a RPC de
--    importar (no INSERT) e sayerlack_aplicar_condicao_portal (pedido do app) — pedidos disjuntos.
-- 4. sayerlack_importar_pedido_portal passa a usar a função (mesma assinatura ⇒ REPLACE preserva o ACL; reemitido).
-- 5. sayerlack_aplicar_condicao_portal(pedido, texto) — D-1: o pedido do APP aceito no portal passa a levar ao PO a
--    condição que o portal aplicou, em vez de "000 À Vista" fixo. Só sobre condicao_origem = 'default_a_vista',
--    só durante/depois do envio e sem PO no Omie; sem correspondente ⇒ segue default_a_vista com o texto lido, e o
--    disparo (disparar-pedidos-aprovados) recusa o PO até alguém escolher a condição.
-- Sem BEGIN/COMMIT: a transação é do executor (db:aplicar). Todo UPDATE com WHERE (pg-safeupdate).
-- ============================================================================================

-- 1) ── de-para explícito ──────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.sayerlack_condicao_portal_de_para (
  condicao_portal text        PRIMARY KEY,
  codigo_omie     text        NOT NULL,
  evidencia       text        NOT NULL,
  criado_em       timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.sayerlack_condicao_portal_de_para DROP CONSTRAINT IF EXISTS sayerlack_condicao_de_para_normalizada;
ALTER TABLE public.sayerlack_condicao_portal_de_para ADD CONSTRAINT sayerlack_condicao_de_para_normalizada
  CHECK (condicao_portal = upper(btrim(condicao_portal)) AND condicao_portal <> '' AND condicao_portal !~ '\s\s');
ALTER TABLE public.sayerlack_condicao_portal_de_para DROP CONSTRAINT IF EXISTS sayerlack_condicao_de_para_evidencia;
ALTER TABLE public.sayerlack_condicao_portal_de_para ADD CONSTRAINT sayerlack_condicao_de_para_evidencia CHECK (btrim(evidencia) <> '');
ALTER TABLE public.sayerlack_condicao_portal_de_para ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.sayerlack_condicao_portal_de_para FROM anon, authenticated;
GRANT SELECT ON public.sayerlack_condicao_portal_de_para TO service_role;
COMMENT ON TABLE public.sayerlack_condicao_portal_de_para IS
  'De-para explícito condição de pagamento do portal Sayerlack (texto normalizado: sem o prefixo "NN - ", caixa alta, espaço simples) → codigo de omie_condicao_pagamento_catalogo (OBEN). Vence a regra exata de texto. Decisão D-2 do founder (2026-11-06).';

INSERT INTO public.sayerlack_condicao_portal_de_para (condicao_portal, codigo_omie, evidencia) VALUES
  ('30 DIAS', 'A30', 'D-2 do founder (2026-11-06): "30 DIAS" do portal → "Para 30 dias (C)"; a regra exata de texto escolheria T54 "Para 30 dias"')
ON CONFLICT (condicao_portal) DO NOTHING;

-- 2) ── coluna de prova ───────────────────────────────────────────────────────────────────
ALTER TABLE public.pedido_compra_sugerido ADD COLUMN IF NOT EXISTS condicao_portal_lida text;
COMMENT ON COLUMN public.pedido_compra_sugerido.condicao_portal_lida IS
  'Texto da condição de pagamento que o portal Sayerlack mostrou para este pedido ("70 - 7 DIAS"). Escritores: sayerlack_importar_pedido_portal (pedido importado) e sayerlack_aplicar_condicao_portal (pedido do app). Nulo = não lida.';

-- 3) ── a tradução única ──────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.sayerlack_condicao_portal_normalizar(p_texto text)
RETURNS text
LANGUAGE sql IMMUTABLE
SET search_path TO 'public'
AS $fn$
  SELECT nullif(regexp_replace(upper(btrim(regexp_replace(coalesce(p_texto, ''), '^\s*[0-9A-Za-z]+\s+-\s+', ''))), '\s+', ' ', 'g'), '');
$fn$;

CREATE OR REPLACE FUNCTION public.sayerlack_condicao_portal_para_omie(p_condicao_portal text)
RETURNS TABLE (codigo text, descricao text, num_parcelas integer)
LANGUAGE plpgsql STABLE
SET search_path TO 'public'
AS $fn$
DECLARE
  v_norm    text := public.sayerlack_condicao_portal_normalizar(p_condicao_portal);
  v_txt     text;
  v_alvo    text;
  v_dp      text;
  v_matches integer;
  v_codigo  text;
  v_desc    text;
  v_parc    integer;
BEGIN
  SELECT d.codigo_omie INTO v_dp FROM public.sayerlack_condicao_portal_de_para d WHERE d.condicao_portal = v_norm;
  IF v_dp IS NOT NULL THEN
    -- De-para explícito: o código tem de existir ATIVO no catálogo OBEN — senão recusa (nunca cai na regra de texto).
    SELECT count(*), min(c.codigo), min(c.descricao), min(c.num_parcelas) INTO v_matches, v_codigo, v_desc, v_parc
      FROM public.omie_condicao_pagamento_catalogo c
     WHERE c.empresa = 'OBEN' AND c.ativo AND c.codigo = v_dp;
  ELSE
    -- Regra exata do founder (2026-11): "N DIAS" → "Para N dias"; "28/56" → a de mesmo texto; "À VISTA" → 000.
    v_txt := btrim(regexp_replace(coalesce(v_norm, ''), '\s*(DIAS|DIA|DDL|DD)\.?\s*$', ''));
    IF v_txt ~ '^[0-9]+$' THEN
      SELECT count(*), min(c.codigo), min(c.descricao), min(c.num_parcelas) INTO v_matches, v_codigo, v_desc, v_parc
        FROM public.omie_condicao_pagamento_catalogo c
       WHERE c.empresa = 'OBEN' AND c.ativo AND lower(btrim(c.descricao)) = 'para ' || v_txt::integer || ' dias';
    ELSIF v_txt ~ '^[0-9]+(\s*/\s*[0-9]+)+$' THEN
      v_alvo := regexp_replace(v_txt, '\s*/\s*', '/', 'g');
      SELECT count(*), min(c.codigo), min(c.descricao), min(c.num_parcelas) INTO v_matches, v_codigo, v_desc, v_parc
        FROM public.omie_condicao_pagamento_catalogo c
       WHERE c.empresa = 'OBEN' AND c.ativo AND regexp_replace(btrim(c.descricao), '\s*/\s*', '/', 'g') = v_alvo;
    ELSIF v_txt ~ '^(A|À) ?VISTA$' THEN
      SELECT count(*), min(c.codigo), min(c.descricao), min(c.num_parcelas) INTO v_matches, v_codigo, v_desc, v_parc
        FROM public.omie_condicao_pagamento_catalogo c
       WHERE c.empresa = 'OBEN' AND c.ativo AND c.codigo = '000';
    ELSE
      v_matches := 0;
    END IF;
  END IF;
  IF coalesce(v_matches, 0) <> 1 OR v_codigo IS NULL OR coalesce(v_parc, 0) < 1 THEN
    RAISE EXCEPTION 'importar_portal: condição de pagamento "%" do portal sem correspondente único no Omie', coalesce(p_condicao_portal, '(vazia)') USING ERRCODE = 'IP007';
  END IF;
  codigo := v_codigo; descricao := v_desc; num_parcelas := v_parc;
  RETURN NEXT;
END
$fn$;
REVOKE ALL ON FUNCTION public.sayerlack_condicao_portal_para_omie(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.sayerlack_condicao_portal_para_omie(text) FROM anon;
REVOKE ALL ON FUNCTION public.sayerlack_condicao_portal_para_omie(text) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.sayerlack_condicao_portal_para_omie(text) TO service_role;

-- 4) ── importar passa a usar a tradução única ─────────────────────────────────────────────
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
  v_cond_codigo text;
  v_cond_desc   text;
  v_cond_parc   integer;
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

  -- IP007 — condição de pagamento LIDA do portal ("70 - 7 DIAS") → código do catálogo Omie OBEN por UMA função
  -- (sayerlack_condicao_portal_para_omie): de-para explícito do founder primeiro (D-2), regra exata de texto depois.
  -- Sem correspondência única ⇒ a função lança IP007. Nunca chuta e nunca cai em "À Vista" (ausente ≠ à vista).
  SELECT c.codigo, c.descricao, c.num_parcelas INTO v_cond_codigo, v_cond_desc, v_cond_parc
    FROM public.sayerlack_condicao_portal_para_omie(p_condicao_portal) c;

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
    condicao_pagamento_codigo, condicao_pagamento_descricao, num_parcelas, condicao_origem, condicao_portal_lida,
    status_envio_portal, enviado_portal_em, portal_protocolo, portal_data_entrega,
    importado_portal_em, importado_portal_por, resposta_canal
  ) VALUES (
    'OBEN', v_fornecedor,
    (SELECT sum(valor_mercadoria) FROM _importar_portal_itens),  -- provisório: a RPC de custo regrava com o IPI
    v_n, 'aprovado_aguardando_disparo',
    p_operador, now(), 'portal_sayerlack',
    v_cond_codigo, v_cond_desc, v_cond_parc, 'portal_sayerlack', btrim(p_condicao_portal),
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

-- 5) ── D-1: condição REAL no pedido do app aceito no portal ───────────────────────────────
-- Chamada pela edge enviar-pedido-portal-sayerlack com o pedido ainda em `enviando_portal` (o claim DESTA execução),
-- ANTES de gravar sucesso_portal: nenhum disparo cria PO de pedido em envio, então quem vê sucesso_portal já vê a
-- condição (Codex P1, 2026-11-07: aplicar depois deixava outro disparo criar o PO com 000 no meio). Nunca lança por
-- "não deu": devolve o motivo e o pedido fica em `default_a_vista` — e o disparo RECUSA o PO de pedido do app com
-- protocolo nessa origem (fail-closed: sucesso no portal não prova pagamento à vista; Codex P1).
CREATE OR REPLACE FUNCTION public.sayerlack_aplicar_condicao_portal(p_pedido_id bigint, p_condicao_portal text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $fn$
DECLARE
  v_p      record;
  v_lida   text := nullif(btrim(coalesce(p_condicao_portal, '')), '');
  v_codigo text;
  v_desc   text;
  v_parc   integer;
BEGIN
  SELECT id, empresa, fornecedor_nome, status_envio_portal, omie_pedido_compra_id, condicao_origem,
         condicao_pagamento_codigo
    INTO v_p
    FROM public.pedido_compra_sugerido
   WHERE id = p_pedido_id
     FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('aplicado', false, 'motivo', 'pedido_inexistente');
  END IF;
  IF v_p.empresa <> 'OBEN' OR v_p.fornecedor_nome NOT ILIKE '%sayerlack%' THEN
    RETURN jsonb_build_object('aplicado', false, 'motivo', 'nao_e_sayerlack_oben');
  END IF;
  IF v_p.status_envio_portal IS NULL OR v_p.status_envio_portal NOT IN ('enviando_portal', 'sucesso_portal') THEN
    RETURN jsonb_build_object('aplicado', false, 'motivo', 'fora_do_envio_portal');
  END IF;
  IF nullif(btrim(coalesce(v_p.omie_pedido_compra_id, '')), '') IS NOT NULL AND btrim(v_p.omie_pedido_compra_id) <> '0' THEN
    RETURN jsonb_build_object('aplicado', false, 'motivo', 'po_ja_existe');
  END IF;

  -- O texto lido fica gravado sempre (prova e sensor "lida mas não aplicada"), mesmo quando não se aplica.
  UPDATE public.pedido_compra_sugerido SET condicao_portal_lida = v_lida WHERE id = p_pedido_id;

  IF v_lida IS NULL THEN
    RETURN jsonb_build_object('aplicado', false, 'motivo', 'condicao_nao_lida');
  END IF;
  -- Escolha humana feita no app não é sobrescrita (decisão de alguém; o texto do portal fica ao lado para conferir).
  IF v_p.condicao_origem IS DISTINCT FROM 'default_a_vista' THEN
    RETURN jsonb_build_object('aplicado', false, 'motivo', 'origem_' || coalesce(v_p.condicao_origem, 'nula'), 'condicao_portal', v_lida);
  END IF;

  BEGIN
    SELECT c.codigo, c.descricao, c.num_parcelas INTO v_codigo, v_desc, v_parc
      FROM public.sayerlack_condicao_portal_para_omie(v_lida) c;
  EXCEPTION WHEN SQLSTATE 'IP007' THEN
    RETURN jsonb_build_object('aplicado', false, 'motivo', 'sem_correspondente', 'condicao_portal', v_lida);
  END;

  UPDATE public.pedido_compra_sugerido
     SET condicao_pagamento_codigo    = v_codigo,
         condicao_pagamento_descricao = v_desc,
         num_parcelas                 = v_parc,
         dias_parcelas                = NULL,
         condicao_origem              = 'portal_sayerlack'
   WHERE id = p_pedido_id;
  RETURN jsonb_build_object('aplicado', true, 'codigo', v_codigo, 'descricao', v_desc, 'num_parcelas', v_parc,
    'anterior', v_p.condicao_pagamento_codigo, 'condicao_portal', v_lida);
END
$fn$;
REVOKE ALL ON FUNCTION public.sayerlack_aplicar_condicao_portal(bigint, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.sayerlack_aplicar_condicao_portal(bigint, text) FROM anon;
REVOKE ALL ON FUNCTION public.sayerlack_aplicar_condicao_portal(bigint, text) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.sayerlack_aplicar_condicao_portal(bigint, text) TO service_role;

-- 6) ── postcondição ──────────────────────────────────────────────────────────────────────
DO $post$
DECLARE
  v_src text;
  f     text;
  r     record;
BEGIN
  SELECT prosrc INTO v_src FROM pg_proc WHERE oid = to_regprocedure('public.sayerlack_importar_pedido_portal(text, date, numeric, jsonb, uuid, text)');
  IF v_src IS NULL OR v_src !~ 'sayerlack_condicao_portal_para_omie' OR v_src !~ 'condicao_portal_lida' THEN
    RAISE EXCEPTION 'B1 FALHOU: a RPC de importar não usa a tradução única / não grava condicao_portal_lida';
  END IF;
  IF v_src ~ 'lower\(btrim\(descricao\)\)' THEN
    RAISE EXCEPTION 'B2 FALHOU: regra de texto ainda duplicada dentro da RPC de importar';
  END IF;
  FOREACH f IN ARRAY ARRAY[
    'public.sayerlack_importar_pedido_portal(text, date, numeric, jsonb, uuid, text)',
    'public.sayerlack_condicao_portal_para_omie(text)',
    'public.sayerlack_aplicar_condicao_portal(bigint, text)'
  ] LOOP
    IF has_function_privilege('anon', f, 'EXECUTE') OR has_function_privilege('authenticated', f, 'EXECUTE') THEN
      RAISE EXCEPTION 'B3 FALHOU: % executável por anon/authenticated', f;
    END IF;
    IF NOT has_function_privilege('service_role', f, 'EXECUTE') THEN
      RAISE EXCEPTION 'B4 FALHOU: service_role sem EXECUTE em %', f;
    END IF;
    SELECT prosrc INTO v_src FROM pg_proc WHERE oid = to_regprocedure(f);
    IF EXISTS (SELECT 1 FROM regexp_matches(v_src, '\mUPDATE\s[^;]*;', 'gi') AS m(x) WHERE m.x[1] !~* '\mWHERE\M') THEN
      RAISE EXCEPTION 'B5 FALHOU: UPDATE sem WHERE em % — o pg-safeupdate recusa', f;
    END IF;
  END LOOP;
  -- O de-para semeado resolve EXECUTANDO (PL/pgSQL é late-bound) e para o código certo.
  SELECT * INTO r FROM public.sayerlack_condicao_portal_para_omie('70 - 30 DIAS');
  IF r.codigo IS DISTINCT FROM 'A30' THEN
    RAISE EXCEPTION 'B6 FALHOU: "30 DIAS" deveria dar A30 pelo de-para, deu %', r.codigo;
  END IF;
  SELECT * INTO r FROM public.sayerlack_condicao_portal_para_omie('70 - 7 DIAS');
  IF r.codigo IS DISTINCT FROM 'A07' THEN
    RAISE EXCEPTION 'B7 FALHOU: "7 DIAS" deveria dar A07 pela regra exata, deu %', r.codigo;
  END IF;
  IF has_table_privilege('anon', 'public.sayerlack_condicao_portal_de_para', 'SELECT')
     OR has_table_privilege('authenticated', 'public.sayerlack_condicao_portal_de_para', 'SELECT') THEN
    RAISE EXCEPTION 'B8 FALHOU: de-para de condição legível por anon/authenticated';
  END IF;
  RAISE NOTICE 'POSTCONDICAO_OK sayerlack condicao portal onda2';
END
$post$;
