-- Portal Sayerlack, revisão 2, item 5.2 (5B), fatia 1 — detectar o pedido ALTERADO NO PORTAL antes do re-disparo.
--
-- Antes: o botão "importar" relia o portal e, sem PO, re-disparava o pedido ANTIGO do app — se o fornecedor trocou
-- SKU, quantidade, preço ou condição no portal, o PO saía errado. Agora a importadora confere antes de qualquer
-- disparo e o claim recusa pedido com divergência aberta.
--
-- Objetos (1 escritor: `sayerlack_conferir_portal`, SECURITY DEFINER — ninguém mais tem INSERT/UPDATE neles):
--   1. `sayerlack_portal_retrato` — o RETRATO INICIAL durável (leitura parseada: itens com valor, total, condição).
--      Versionado (a fatia 2, "aceitar o portal", grava a versão seguinte pela mesma porta). Nunca se altera.
--      Nasce na MESMA transação que cria o pedido importado (a RPC de importar chama a porta) — resposta perdida ou
--      falha depois do INSERT não pode perder a referência (Codex 5.2 P1). Pedido nascido no app: a 1ª leitura.
--   2. `sayerlack_portal_divergencia` — o diff de cada divergência, com a LEITURA que a causou (é o que a fatia 2
--      aplica), o intervalo da leitura e a evidência 7.2. No máximo 1 aberta por pedido.
--   3. `pedido_compra_sugerido.portal_divergencia_aberta_id` — o GATE. Mora NA LINHA do pedido porque o claim decide
--      no WHERE do próprio UPDATE (EvalPlanQual reavalia só a linha; um NOT EXISTS noutra tabela leria o snapshot
--      velho e deixaria passar a divergência gravada durante a espera pela trava).
--
-- Regra (decisão do founder): SKU e quantidade se comparam com os itens do PRÓPRIO pedido (sku_portal_aprovado,
-- qtde_final × fator_portal_aprovado — fator = unidades do portal por unidade do Omie); valor (por SKU e o total —
-- o total carrega o IPI, que o portal não expõe por item) e condição (normalizada) se comparam com o retrato. Sem
-- retrato, ESTA leitura vira o retrato. Ausente ≠ zero: item do pedido sem SKU do portal, fator ou quantidade é uma
-- DIFERENÇA, nunca "bateu"; leitura sem total, condição ou item legível é 22023 (não semeia nem autoriza).
-- Ordem das observações (Codex 5.2 P1): divergência aberta só se fecha/substitui com leitura PROVADAMENTE posterior
-- (lido_de > lido_ate da aberta); senão {conferido:false, motivo:'leitura_antiga'} sem escrever.
-- Claim de disparo aberto não impede a conferência: a divergência grava o gate e, daí em diante, o claim recusa —
-- o disparador trata essa pendência SÓ por consulta ao Omie (como no cancelado no portal).
-- Só confere pedido sem PO e em status disparável; recusa de negócio volta como {conferido:false, motivo}.

-- ── 1. Retrato inicial ──────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.sayerlack_portal_retrato (
  pedido_id            bigint NOT NULL REFERENCES public.pedido_compra_sugerido(id) ON DELETE CASCADE,
  versao               integer NOT NULL CHECK (versao >= 1),
  protocolo            text NOT NULL,
  origem               text NOT NULL CHECK (origem IN ('importacao', 'redisparo', 'aceito_portal')),
  evidencia_id         bigint REFERENCES public.sayerlack_portal_evidencia(id),
  itens                jsonb NOT NULL CHECK (jsonb_typeof(itens) = 'array' AND jsonb_array_length(itens) > 0),
  valor_total          numeric NOT NULL CHECK (valor_total > 0),
  condicao_portal      text NOT NULL,
  condicao_normalizada text NOT NULL,
  criado_em            timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (pedido_id, versao)
);
COMMENT ON TABLE public.sayerlack_portal_retrato IS
  '5.2 Sayerlack: retrato do pedido no portal contra o qual valor e condição se comparam. 1 escritor = sayerlack_conferir_portal.';

-- ── 2. Divergências ─────────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.sayerlack_portal_divergencia (
  id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  pedido_id      bigint NOT NULL REFERENCES public.pedido_compra_sugerido(id) ON DELETE CASCADE,
  protocolo      text NOT NULL,
  evidencia_id   bigint REFERENCES public.sayerlack_portal_evidencia(id),
  retrato_versao integer,          -- nulo: a 1ª leitura já divergia em SKU/quantidade (não virou retrato)
  leitura        jsonb NOT NULL CHECK (jsonb_typeof(leitura) = 'object'),
  lido_de        timestamptz NOT NULL,
  lido_ate       timestamptz NOT NULL,
  -- A ÚLTIMA leitura que viu o MESMO diff (Codex 5.2 P1): fechar exige leitura posterior a ela, não só à 1ª.
  ultima_lido_ate      timestamptz,
  ultima_evidencia_id  bigint REFERENCES public.sayerlack_portal_evidencia(id),
  diferencas     jsonb NOT NULL CHECK (jsonb_typeof(diferencas) = 'array' AND jsonb_array_length(diferencas) > 0),
  detectada_em   timestamptz NOT NULL DEFAULT now(),
  resolvida_em   timestamptz,
  resolucao      text CHECK (resolucao IN ('portal_voltou', 'substituida', 'aceito_portal')),
  resolvida_por  uuid,
  CONSTRAINT sayerlack_portal_divergencia_resolucao CHECK ((resolvida_em IS NULL) = (resolucao IS NULL))
);
COMMENT ON TABLE public.sayerlack_portal_divergencia IS
  '5.2 Sayerlack: pedido do app × leitura do portal. Aberta (resolvida_em nula) bloqueia o claim de disparo. 1 escritor = sayerlack_conferir_portal.';
CREATE UNIQUE INDEX IF NOT EXISTS sayerlack_portal_divergencia_uma_aberta
  ON public.sayerlack_portal_divergencia (pedido_id) WHERE resolvida_em IS NULL;
CREATE INDEX IF NOT EXISTS sayerlack_portal_divergencia_pedido_idx
  ON public.sayerlack_portal_divergencia (pedido_id, detectada_em DESC);

-- ── 3. Gate na linha do pedido ──────────────────────────────────────────────────────────────────────
ALTER TABLE public.pedido_compra_sugerido ADD COLUMN IF NOT EXISTS portal_divergencia_aberta_id bigint;
COMMENT ON COLUMN public.pedido_compra_sugerido.portal_divergencia_aberta_id IS
  '5.2 Sayerlack: divergência portal × app aberta (sayerlack_portal_divergencia.id). Não nula ⇒ reposicao_claim_disparo recusa. 1 escritor = sayerlack_conferir_portal.';

-- ── ACL: leitura para staff; escrita SÓ pela porta (SECURITY DEFINER) ───────────────────────────────
ALTER TABLE public.sayerlack_portal_retrato ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.sayerlack_portal_divergencia ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.sayerlack_portal_retrato FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON TABLE public.sayerlack_portal_divergencia FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON TABLE public.sayerlack_portal_retrato TO authenticated, service_role;
GRANT SELECT ON TABLE public.sayerlack_portal_divergencia TO authenticated, service_role;
DROP POLICY IF EXISTS staff_le_portal_retrato ON public.sayerlack_portal_retrato;
CREATE POLICY staff_le_portal_retrato ON public.sayerlack_portal_retrato
  FOR SELECT TO authenticated
  USING ((SELECT public.has_role(auth.uid(), 'master'::app_role)) OR (SELECT public.has_role(auth.uid(), 'employee'::app_role)));
DROP POLICY IF EXISTS staff_le_portal_divergencia ON public.sayerlack_portal_divergencia;
CREATE POLICY staff_le_portal_divergencia ON public.sayerlack_portal_divergencia
  FOR SELECT TO authenticated
  USING ((SELECT public.has_role(auth.uid(), 'master'::app_role)) OR (SELECT public.has_role(auth.uid(), 'employee'::app_role)));

-- ── 4. A porta ──────────────────────────────────────────────────────────────────────────────────────
-- p_leitura: {protocolo, condicao, valor_total, itens:[{sku_portal, qtde_portal, valor_mercadoria}], lido_de?, lido_ate?}
CREATE OR REPLACE FUNCTION public.sayerlack_conferir_portal(
  p_pedido_id bigint, p_leitura jsonb, p_evidencia_id bigint, p_origem text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE
  r          public.pedido_compra_sugerido%ROWTYPE;
  v_proto    text;
  v_cond     text;
  v_norm     text;
  v_de       timestamptz;
  v_ate      timestamptz;
  v_ret      public.sayerlack_portal_retrato%ROWTYPE;
  v_criado   boolean := false;
  v_diff     jsonb;
  v_aberta   public.sayerlack_portal_divergencia%ROWTYPE;
  v_div_id   bigint;
BEGIN
  -- Entrada: a leitura inteira, ou nada. `IS DISTINCT FROM`, nunca `<>`: chave ausente dá NULL.
  IF p_pedido_id IS NULL OR p_origem IS NULL OR p_origem NOT IN ('importacao', 'redisparo')
     OR p_leitura IS NULL OR jsonb_typeof(p_leitura) IS DISTINCT FROM 'object'
     OR jsonb_typeof(p_leitura->'protocolo') IS DISTINCT FROM 'string'
     OR jsonb_typeof(p_leitura->'condicao') IS DISTINCT FROM 'string'
     OR jsonb_typeof(p_leitura->'valor_total') IS DISTINCT FROM 'number'
     OR jsonb_typeof(p_leitura->'itens') IS DISTINCT FROM 'array'
     OR jsonb_array_length(p_leitura->'itens') = 0 THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = '[CONFERIR-ENTRADA] pedido, origem (importacao|redisparo) e leitura completa são obrigatórios';
  END IF;
  -- CASE, não OR, antes de cada cast: o SQL não garante a ordem do OR e o cast de um não-número lançaria 22P02.
  IF NOT ((p_leitura->>'valor_total')::numeric > 0)
     OR EXISTS (
       SELECT 1 FROM jsonb_array_elements(p_leitura->'itens') e
        WHERE jsonb_typeof(e) IS DISTINCT FROM 'object'
           OR jsonb_typeof(e->'sku_portal') IS DISTINCT FROM 'string'
           OR btrim(e->>'sku_portal') = ''
           OR CASE WHEN jsonb_typeof(e->'qtde_portal') = 'number' THEN (e->>'qtde_portal')::numeric <= 0 ELSE true END
           OR CASE WHEN jsonb_typeof(e->'valor_mercadoria') = 'number' THEN (e->>'valor_mercadoria')::numeric < 0 ELSE true END) THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = '[CONFERIR-ENTRADA] leitura com total ou item ilegível';
  END IF;
  v_cond := btrim(p_leitura->>'condicao');
  v_norm := public.sayerlack_condicao_portal_normalizar(v_cond);
  IF v_norm IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = '[CONFERIR-ENTRADA] condição de pagamento ilegível na leitura';
  END IF;
  BEGIN
    v_de  := NULLIF(p_leitura->>'lido_de', '')::timestamptz;
    v_ate := NULLIF(p_leitura->>'lido_ate', '')::timestamptz;
  EXCEPTION WHEN invalid_datetime_format OR datetime_field_overflow OR invalid_time_zone_displacement_value THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = '[CONFERIR-ENTRADA] intervalo da leitura ilegível';
  END;
  IF (v_de IS NULL) <> (v_ate IS NULL) OR v_ate < v_de OR NOT isfinite(v_de) OR NOT isfinite(v_ate) THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = '[CONFERIR-ENTRADA] intervalo da leitura incompleto ou invertido';
  END IF;

  SELECT * INTO r FROM public.pedido_compra_sugerido WHERE id = p_pedido_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('conferido', false, 'motivo', 'pedido_nao_encontrado');
  END IF;
  v_proto := btrim(COALESCE(r.portal_protocolo, ''));
  IF v_proto = '' OR v_proto IS DISTINCT FROM btrim(p_leitura->>'protocolo') THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = '[CONFERIR-ENTRADA] a leitura não é do protocolo deste pedido';
  END IF;
  IF NULLIF(NULLIF(btrim(COALESCE(r.omie_pedido_compra_id, '')), ''), '0') IS NOT NULL THEN
    RETURN jsonb_build_object('conferido', false, 'motivo', 'tem_po', 'pedido_id', r.id);
  END IF;
  IF r.status IS NULL OR r.status NOT IN ('aprovado_aguardando_disparo', 'falha_envio') THEN
    RETURN jsonb_build_object('conferido', false, 'motivo', 'status_nao_conferivel', 'pedido_id', r.id, 'status', r.status);
  END IF;

  -- 1. SKU e quantidade contra os itens do PRÓPRIO pedido (não dependem do retrato).
  WITH app_item AS (
    SELECT i.id, upper(btrim(i.sku_portal_aprovado)) AS sku, i.qtde_final * i.fator_portal_aprovado AS q,
           (NULLIF(btrim(COALESCE(i.sku_portal_aprovado, '')), '') IS NULL
            OR i.fator_portal_aprovado IS NULL OR i.fator_portal_aprovado <= 0
            OR i.qtde_final IS NULL OR i.qtde_final <= 0) AS ausente
      FROM public.pedido_compra_item i WHERE i.pedido_id = r.id
  ), app AS (
    SELECT sku, trim_scale(sum(q)) AS q FROM app_item WHERE NOT ausente GROUP BY 1
  ), portal AS (
    SELECT upper(btrim(e->>'sku_portal')) AS sku, trim_scale(sum((e->>'qtde_portal')::numeric)) AS q
      FROM jsonb_array_elements(p_leitura->'itens') e GROUP BY 1
  ), d AS (
    -- Ausente ≠ zero: pedido sem item, ou item sem SKU do portal/fator/quantidade, é diferença.
    SELECT 'pedido_sem_itens' AS tipo, NULL::text AS sku, NULL::numeric AS app, NULL::numeric AS portal
     WHERE NOT EXISTS (SELECT 1 FROM app_item)
    UNION ALL
    SELECT 'item_sem_mapa_portal', 'item ' || a.id, NULL, NULL FROM app_item a WHERE a.ausente
    UNION ALL
    SELECT CASE WHEN a.sku IS NULL THEN 'sku_novo_no_portal' WHEN p.sku IS NULL THEN 'sku_fora_do_portal'
                ELSE 'quantidade' END,
           COALESCE(a.sku, p.sku), a.q, p.q
      FROM app a FULL JOIN portal p ON p.sku = a.sku
     WHERE a.sku IS NULL OR p.sku IS NULL OR a.q <> p.q
  )
  SELECT jsonb_agg(jsonb_build_object('tipo', d.tipo, 'sku', d.sku, 'app', d.app, 'portal', d.portal))
    INTO v_diff FROM d;

  -- 2. Retrato vigente (a maior versão). Sem retrato, ESTA leitura vira o retrato — SÓ se SKU e quantidade bateram
  --    (Codex 5.2 P1): uma 1ª leitura já divergente não pode virar a referência de valor e condição; quando o portal
  --    voltar ao pedido, a leitura que bater semeia.
  SELECT * INTO v_ret FROM public.sayerlack_portal_retrato WHERE pedido_id = r.id ORDER BY versao DESC LIMIT 1;
  IF NOT FOUND AND v_diff IS NULL THEN
    INSERT INTO public.sayerlack_portal_retrato (pedido_id, versao, protocolo, origem, evidencia_id, itens,
                                                 valor_total, condicao_portal, condicao_normalizada)
    SELECT r.id, 1, v_proto, p_origem, p_evidencia_id,
           (SELECT jsonb_agg(jsonb_build_object('sku_portal', upper(btrim(x.e->>'sku_portal')),
                                                'qtde_portal', (x.e->>'qtde_portal')::numeric,
                                                'valor_mercadoria', (x.e->>'valor_mercadoria')::numeric) ORDER BY x.o)
              FROM jsonb_array_elements(p_leitura->'itens') WITH ORDINALITY AS x(e, o)),
           (p_leitura->>'valor_total')::numeric, v_cond, v_norm
    RETURNING * INTO v_ret;
    v_criado := true;
  END IF;

  -- 3. Valor por SKU, total e condição contra o retrato (sem retrato não há referência: só SKU/quantidade valem).
  IF v_ret.pedido_id IS NOT NULL THEN
    WITH portal AS (
      SELECT upper(btrim(e->>'sku_portal')) AS sku, sum((e->>'valor_mercadoria')::numeric) AS v
        FROM jsonb_array_elements(p_leitura->'itens') e GROUP BY 1
    ), ret AS (
      SELECT e->>'sku_portal' AS sku, sum((e->>'valor_mercadoria')::numeric) AS v
        FROM jsonb_array_elements(v_ret.itens) e GROUP BY 1
    ), d AS (
      -- Valor por SKU contra o retrato (FULL JOIN: SKU que entrou/saiu desde o retrato também conta).
      SELECT 'valor_item' AS tipo, COALESCE(p.sku, t.sku) AS sku, t.v AS app, p.v AS portal
        FROM portal p FULL JOIN ret t ON t.sku = p.sku
       WHERE p.sku IS NULL OR t.sku IS NULL OR abs(p.v - t.v) > 0.005
      UNION ALL
      SELECT 'valor_total', NULL, v_ret.valor_total, (p_leitura->>'valor_total')::numeric
       WHERE abs(v_ret.valor_total - (p_leitura->>'valor_total')::numeric) > 0.005
    )
    SELECT COALESCE(v_diff, '[]'::jsonb)
           || COALESCE(jsonb_agg(jsonb_build_object('tipo', d.tipo, 'sku', d.sku, 'app', d.app, 'portal', d.portal)), '[]'::jsonb)
      INTO v_diff FROM d;
    IF v_ret.condicao_normalizada IS DISTINCT FROM v_norm THEN
      v_diff := v_diff || jsonb_build_array(jsonb_build_object(
        'tipo', 'condicao', 'sku', NULL, 'app', v_ret.condicao_portal, 'portal', v_cond));
    END IF;
  END IF;
  -- Ordem estável (o "mesmo diff" compara jsonb); vazio = NULL.
  SELECT jsonb_agg(e ORDER BY e->>'tipo', e->>'sku') INTO v_diff FROM jsonb_array_elements(COALESCE(v_diff, '[]'::jsonb)) e;
  IF v_diff IS NOT NULL AND v_de IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = '[CONFERIR-ENTRADA] divergência exige o intervalo da leitura (lido_de/lido_ate)';
  END IF;

  SELECT * INTO v_aberta FROM public.sayerlack_portal_divergencia
   WHERE pedido_id = r.id AND resolvida_em IS NULL FOR UPDATE;

  -- O mesmo diff: a aberta segue valendo (não empilha linha a cada importação, e a ordem não importa).
  IF v_diff IS NOT NULL AND v_aberta.id IS NOT NULL AND v_aberta.diferencas = v_diff
     AND v_aberta.retrato_versao IS NOT DISTINCT FROM v_ret.versao THEN
    -- Carimba a ÚLTIMA observação do mesmo diff (Codex 5.2 P1): uma leitura mais velha que ESTA não pode fechá-la.
    UPDATE public.sayerlack_portal_divergencia
       SET ultima_lido_ate = v_ate, ultima_evidencia_id = p_evidencia_id
     WHERE id = v_aberta.id AND v_ate > GREATEST(v_aberta.lido_ate, v_aberta.ultima_lido_ate);
    RETURN jsonb_build_object('conferido', true, 'divergente', true, 'pedido_id', r.id, 'divergencia_id', v_aberta.id,
                              'retrato_criado', v_criado, 'retrato_versao', v_ret.versao, 'diferencas', v_diff,
                              'pendente_desde', r.disparo_claim_em);
  END IF;
  -- Fechar ou substituir a aberta exige leitura provadamente POSTERIOR à dela.
  IF v_aberta.id IS NOT NULL
     AND (v_de IS NULL OR v_de <= GREATEST(v_aberta.lido_ate, v_aberta.ultima_lido_ate)) THEN
    RETURN jsonb_build_object('conferido', false, 'motivo', 'leitura_antiga', 'pedido_id', r.id,
                              'divergencia_id', v_aberta.id,
                              'divergencia_lido_ate', GREATEST(v_aberta.lido_ate, v_aberta.ultima_lido_ate));
  END IF;

  IF v_diff IS NULL THEN
    IF v_aberta.id IS NOT NULL THEN
      UPDATE public.sayerlack_portal_divergencia SET resolvida_em = now(), resolucao = 'portal_voltou'
       WHERE id = v_aberta.id;
    END IF;
    UPDATE public.pedido_compra_sugerido SET portal_divergencia_aberta_id = NULL
     WHERE id = r.id AND portal_divergencia_aberta_id IS NOT NULL;
    RETURN jsonb_build_object('conferido', true, 'divergente', false, 'pedido_id', r.id,
                              'retrato_criado', v_criado, 'retrato_versao', v_ret.versao,
                              'divergencia_fechada_id', v_aberta.id, 'pendente_desde', r.disparo_claim_em);
  END IF;

  IF v_aberta.id IS NOT NULL THEN
    UPDATE public.sayerlack_portal_divergencia SET resolvida_em = now(), resolucao = 'substituida'
     WHERE id = v_aberta.id;
  END IF;
  INSERT INTO public.sayerlack_portal_divergencia (pedido_id, protocolo, evidencia_id, retrato_versao, leitura,
                                                   lido_de, lido_ate, diferencas)
  VALUES (r.id, v_proto, p_evidencia_id, v_ret.versao, p_leitura, v_de, v_ate, v_diff)
  RETURNING id INTO v_div_id;
  UPDATE public.pedido_compra_sugerido SET portal_divergencia_aberta_id = v_div_id WHERE id = r.id;

  RETURN jsonb_build_object('conferido', true, 'divergente', true, 'pedido_id', r.id, 'divergencia_id', v_div_id,
                            'retrato_criado', v_criado, 'retrato_versao', v_ret.versao, 'diferencas', v_diff,
                            'pendente_desde', r.disparo_claim_em);
END;
$$;
REVOKE ALL ON FUNCTION public.sayerlack_conferir_portal(bigint, jsonb, bigint, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.sayerlack_conferir_portal(bigint, jsonb, bigint, text) FROM anon;
REVOKE ALL ON FUNCTION public.sayerlack_conferir_portal(bigint, jsonb, bigint, text) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.sayerlack_conferir_portal(bigint, jsonb, bigint, text) TO service_role;

-- ── 5. Importar: o retrato nasce na MESMA transação que cria o pedido ───────────────────────────────
-- Pré-flight: pg_get_functiondef da PROD em 2026-11-09 = a de 20261107140000 (corpo idêntico). Isto a recria com
-- UMA mudança: antes do RETURN final, a porta grava o retrato desta leitura e prova que o pedido recém-criado bate
-- com ela; qualquer coisa diferente de "conferido sem divergência" desfaz a importação (IP009).
CREATE OR REPLACE FUNCTION public.sayerlack_importar_pedido_portal(p_protocolo text, p_data_entrega date, p_valor_total numeric, p_itens jsonb, p_operador uuid, p_condicao_portal text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_conf        jsonb;
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

  -- 5.2 (Codex P1): o retrato desta leitura nasce AQUI, na mesma transação do pedido — uma resposta perdida ou uma
  -- falha depois deste ponto não pode deixar o pedido sem a referência contra a qual a próxima leitura se compara.
  -- A porta também prova que o pedido recém-gravado bate com a leitura; se não bater, nada fica gravado.
  v_conf := public.sayerlack_conferir_portal(
    v_pedido_id,
    jsonb_build_object(
      'protocolo', p_protocolo, 'condicao', btrim(p_condicao_portal), 'valor_total', p_valor_total,
      'lido_de', now(), 'lido_ate', now(),
      'itens', (SELECT jsonb_agg(jsonb_build_object('sku_portal', e->'sku_portal', 'qtde_portal', e->'qtde_portal',
                                                    'valor_mercadoria', e->'valor_mercadoria') ORDER BY o)
                  FROM jsonb_array_elements(p_itens) WITH ORDINALITY AS x(e, o))),
    NULL, 'importacao');
  IF v_conf->>'conferido' IS DISTINCT FROM 'true' OR v_conf->>'divergente' IS DISTINCT FROM 'false' THEN
    RAISE EXCEPTION 'importar_portal: o pedido gravado não bate com a leitura do portal (%)', left(v_conf::text, 300)
      USING ERRCODE = 'IP009';
  END IF;

  RETURN jsonb_build_object('pedido_id', v_pedido_id, 'ja_existia', false);
END;
$function$;
REVOKE ALL ON FUNCTION public.sayerlack_importar_pedido_portal(text, date, numeric, jsonb, uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.sayerlack_importar_pedido_portal(text, date, numeric, jsonb, uuid, text) FROM anon;
REVOKE ALL ON FUNCTION public.sayerlack_importar_pedido_portal(text, date, numeric, jsonb, uuid, text) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.sayerlack_importar_pedido_portal(text, date, numeric, jsonb, uuid, text) TO service_role;

-- ── 6. Claim: recusa divergência aberta, NO MESMO WHERE QUE GRAVA ───────────────────────────────────
-- Pré-flight: pg_get_functiondef da PROD em 2026-11-09 = a de 20261108120000 (só o veto do 6). Isto a recria com
-- UMA condição a mais no WHERE e o ramo da mensagem; o resto é idêntico.
CREATE OR REPLACE FUNCTION public.reposicao_claim_disparo(p_pedido_id bigint, p_origem text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_status text;
  v_desde  timestamptz;
  v_atual  text;
  v_cod    text;
  v_sprot  text;
  v_sem    timestamptz;
  v_claim  timestamptz;
  v_div    bigint;
BEGIN
  -- ⚠️ O guard e a escrita são UMA instrução. Não separe: o `status IN (…)`, o veto de cancelado no portal e o da
  -- divergência portal × app (5.2) presos a ESTE WHERE são o que faz o Postgres re-avaliá-los contra a linha
  -- recém-commitada (EvalPlanQual, READ COMMITTED). Movê-los para um SELECT acima reabre o Cenário B.
  -- `atualizado_em` NÃO é tocado.
  UPDATE pedido_compra_sugerido
     SET disparo_claim_em  = COALESCE(disparo_claim_em, NOW()),
         disparo_claim_por = COALESCE(disparo_claim_por,
                                      left(COALESCE(NULLIF(btrim(p_origem), ''), 'edge'), 120))
   WHERE id = p_pedido_id
     AND status IN ('aprovado_aguardando_disparo', 'falha_envio')
     AND portal_situacao_codigo IS DISTINCT FROM '6'
     AND portal_divergencia_aberta_id IS NULL
  RETURNING status, disparo_claim_em INTO v_status, v_desde;

  IF v_status IS NOT NULL THEN
    RETURN jsonb_build_object('claimed', true, 'pedido_id', p_pedido_id,
                              'status', v_status, 'desde', v_desde);
  END IF;

  -- 0 linhas. A DECISÃO já foi tomada acima — esta leitura só MONTA A MENSAGEM.
  SELECT status, portal_situacao_codigo, portal_situacao_protocolo, portal_situacao_em, disparo_claim_em,
         portal_divergencia_aberta_id
    INTO v_atual, v_cod, v_sprot, v_sem, v_claim, v_div
    FROM pedido_compra_sugerido WHERE id = p_pedido_id;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('claimed', false, 'pedido_id', p_pedido_id,
                              'motivo', 'pedido não encontrado');
  END IF;

  IF v_cod = '6' AND v_atual IN ('aprovado_aguardando_disparo', 'falha_envio') THEN
    -- `pendente_desde` não nulo = uma tentativa anterior abriu a pendência e não chegou ao desfecho: pode haver
    -- PO no Omie com resposta perdida. A edge concilia SÓ POR CONSULTA (nunca IncluirPedCompra).
    RETURN jsonb_build_object(
      'claimed', false, 'pedido_id', p_pedido_id, 'status', v_atual,
      'bloqueio', 'cancelado_no_portal', 'pendente_desde', v_claim, 'situacao_em', v_sem,
      'motivo', 'pedido cancelado no portal Sayerlack (protocolo ' || COALESCE(v_sprot, '?') ||
                ', lido em ' || COALESCE(to_char(v_sem AT TIME ZONE 'America/Sao_Paulo', 'DD/MM HH24:MI'), '?') ||
                '): disparo bloqueado'
    );
  END IF;

  IF v_div IS NOT NULL AND v_atual IN ('aprovado_aguardando_disparo', 'falha_envio') THEN
    -- Idem: com pendência aberta (`pendente_desde`), a edge concilia SÓ POR CONSULTA — repetir o IncluirPedCompra
    -- mandaria ao Omie o pedido antigo que o portal já não tem.
    RETURN jsonb_build_object(
      'claimed', false, 'pedido_id', p_pedido_id, 'status', v_atual,
      'bloqueio', 'alterado_no_portal', 'pendente_desde', v_claim, 'divergencia_id', v_div,
      'motivo', 'pedido alterado no portal Sayerlack (divergência #' || v_div ||
                ' com o pedido do app): disparo bloqueado até aceitar o portal ou o portal voltar'
    );
  END IF;

  RETURN jsonb_build_object(
    'claimed', false, 'pedido_id', p_pedido_id, 'status', v_atual,
    'motivo', 'pedido não está mais disparável (status atual: '
              || COALESCE(v_atual, '(desconhecido)') || ')'
  );
END;
$function$;
REVOKE ALL ON FUNCTION public.reposicao_claim_disparo(bigint, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.reposicao_claim_disparo(bigint, text) FROM anon;
REVOKE ALL ON FUNCTION public.reposicao_claim_disparo(bigint, text) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.reposicao_claim_disparo(bigint, text) TO service_role;

-- ── POS ───────────────────────────────────────────────────────────────────────────────────────────
DO $pos$
DECLARE
  f text := 'public.sayerlack_conferir_portal(bigint,jsonb,bigint,text)';
  c text := 'public.reposicao_claim_disparo(bigint,text)';
  i text := 'public.sayerlack_importar_pedido_portal(text,date,numeric,jsonb,uuid,text)';
  t text;
BEGIN
  IF to_regprocedure(f) IS NULL THEN RAISE EXCEPTION 'C1 FALHOU: porta ausente'; END IF;
  IF has_function_privilege('anon', f, 'EXECUTE') OR has_function_privilege('authenticated', f, 'EXECUTE')
     OR has_function_privilege('anon', c, 'EXECUTE') OR has_function_privilege('authenticated', c, 'EXECUTE')
     OR has_function_privilege('anon', i, 'EXECUTE') OR has_function_privilege('authenticated', i, 'EXECUTE') THEN
    RAISE EXCEPTION 'C2 FALHOU: porta aberta para anon/authenticated';
  END IF;
  IF NOT has_function_privilege('service_role', f, 'EXECUTE') OR NOT has_function_privilege('service_role', c, 'EXECUTE')
     OR NOT has_function_privilege('service_role', i, 'EXECUTE') THEN
    RAISE EXCEPTION 'C3 FALHOU: service_role sem EXECUTE';
  END IF;
  IF position('portal_divergencia_aberta_id IS NULL' IN pg_get_functiondef(c::regprocedure)) = 0 THEN
    RAISE EXCEPTION 'C4 FALHOU: o claim não recusa a divergência aberta';
  END IF;
  IF position('sayerlack_conferir_portal' IN pg_get_functiondef(i::regprocedure)) = 0 THEN
    RAISE EXCEPTION 'C7 FALHOU: a importação não grava o retrato';
  END IF;
  FOREACH t IN ARRAY ARRAY['public.sayerlack_portal_retrato', 'public.sayerlack_portal_divergencia'] LOOP
    IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = t::regclass) THEN
      RAISE EXCEPTION 'C5 FALHOU: % sem RLS', t;
    END IF;
    IF has_table_privilege('service_role', t, 'INSERT') OR has_table_privilege('service_role', t, 'UPDATE')
       OR has_table_privilege('authenticated', t, 'INSERT') OR has_table_privilege('authenticated', t, 'UPDATE')
       OR has_table_privilege('anon', t, 'SELECT') THEN
      RAISE EXCEPTION 'C6 FALHOU: % com escrita fora da porta (ou leitura anon)', t;
    END IF;
  END LOOP;
  RAISE NOTICE 'CONFERIR_PORTAL_POS_OK';
END
$pos$;
