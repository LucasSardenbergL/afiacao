-- ═══════════════════════════════════════════════════════════════════════════════════════════════════
-- Portal Sayerlack — conferência SEM retrato não se compara consigo mesma (Codex revisão final, achado 1)
--
-- O furo: `sayerlack_conferir_portal`, sem retrato do pedido, comparava a leitura só em SKU/quantidade e SEMEAVA o
-- retrato com ela — preço, total e condição alterados no portal viravam a própria referência e o re-disparo seguia
-- com os valores do APP (o PO sai com o que está no pedido, não com o que o portal cobra).
-- Exposição medida em 2026-11-16 (psql-ro): 226 pedidos com protocolo, 222 sem retrato, TODOS já com PO ⇒ 0 expostos
-- hoje; o risco é o pedido futuro do app cujo disparo falhe e seja re-disparado pela importação.
--
-- A correção (decisão do founder, só SQL): no ramo sem retrato, a leitura é comparada também contra o que o
-- DISPARADOR mandaria ao Omie — valor por SKU (unitário SEM IPI provado × qtde_final, pedido inteiro decomposto e
-- coerente: a regra do `montarProdutosIncluir`), o total provado DESTE protocolo e o código de condição do pedido.
-- Divergiu ⇒ abre divergência pelo fluxo existente (gate `portal_divergencia_aberta_id`; o founder aceita pela porta
-- "Aceitar o portal", #3786). Só semeia o retrato quando TUDO bate. Referência ausente (pedido sem a decomposição
-- provada inteira e de quantidade inteira, total provado de outro protocolo, condição do app ausente, condição do
-- portal sem de-para) vira DIFERENÇA — nunca "bateu" (ausente ≠ zero) e nunca recusa muda: a recusa não grava gate,
-- e o disparador chamado direto sairia com os valores do app (Codex, 2ª rodada, P1).
-- A importação (origem 'importacao') passa pelo MESMO ramo: o pedido recém-gravado com a prova de custo bate consigo
-- mesmo por construção — e se não bater, o IP009 dela desfaz a importação.
-- A edge não muda: 'sem_referencia_app' é só mais um `tipo` de diferença (o resumo mostra o tipo cru até a v1.16).
--
-- Transação: do executor (`bun run db:aplicar`) — o arquivo NÃO leva BEGIN/COMMIT.
-- Prova: db/test-sayerlack-conferir-sem-retrato.sh (PG17, os dois locales, --falsificar).
-- ═══════════════════════════════════════════════════════════════════════════════════════════════════

-- Pré-flight: pg_get_functiondef da PROD em 2026-11-16 = a de 20261111180000 (md5(prosrc) f6d244caaf4fc661507cf6bf3fad78d4).
-- TRAVA antes de ler (ALTER sem efeito: a volatilidade viva) e PRE: md5 EXATO do corpo vivo ∈ {predecessor, este}.
DO $trava$
BEGIN
  IF to_regprocedure('public.sayerlack_conferir_portal(bigint,jsonb,bigint,text)') IS NOT NULL THEN
    ALTER FUNCTION public.sayerlack_conferir_portal(bigint, jsonb, bigint, text) VOLATILE;
  END IF;
END
$trava$;
DO $pre$
DECLARE
  v_vivo text := (SELECT md5(p.prosrc) FROM pg_catalog.pg_proc p
                   WHERE p.oid = to_regprocedure('public.sayerlack_conferir_portal(bigint,jsonb,bigint,text)'));
BEGIN
  IF v_vivo IS NULL OR v_vivo NOT IN ('f6d244caaf4fc661507cf6bf3fad78d4', '51672658268aa75c615948ca12d34554') THEN
    RAISE EXCEPTION 'PRE FALHOU: sayerlack_conferir_portal viva (md5 %) não é a da fatia 2 (aceitar o portal) nem esta', v_vivo;
  END IF;
END
$pre$;
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
  v_posterior boolean;
  v_marco    timestamptz;
  v_guc      text;
  v_ator     uuid;
  v_ref_valor boolean;
  v_cond_omie text;
BEGIN
  -- Entrada: a leitura inteira, ou nada. `IS DISTINCT FROM`, nunca `<>`: chave ausente dá NULL.
  IF p_pedido_id IS NULL OR p_origem IS NULL OR p_origem NOT IN ('importacao', 'redisparo', 'aceito_portal')
     OR p_leitura IS NULL OR jsonb_typeof(p_leitura) IS DISTINCT FROM 'object'
     OR jsonb_typeof(p_leitura->'protocolo') IS DISTINCT FROM 'string'
     OR jsonb_typeof(p_leitura->'condicao') IS DISTINCT FROM 'string'
     OR jsonb_typeof(p_leitura->'valor_total') IS DISTINCT FROM 'number'
     OR jsonb_typeof(p_leitura->'itens') IS DISTINCT FROM 'array'
     OR jsonb_array_length(p_leitura->'itens') = 0 THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = '[CONFERIR-ENTRADA] pedido, origem (importacao|redisparo|aceito_portal) e leitura completa são obrigatórios';
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

  -- 0. A divergência aberta e a ORDEM das observações, ANTES de qualquer escrita (Codex 5.2 rodada 2): só uma leitura
  --    provadamente posterior à última que viu a aberta pode semear retrato, fechar ou substituir. A importação
  --    (instante da gravação, não da captura) nunca é posterior a uma aberta. Fatia 2 (Codex b): nem ao marco do
  --    último retrato ACEITO — a leitura que o humano aceitou também ordena as que chegam depois.
  SELECT * INTO v_aberta FROM public.sayerlack_portal_divergencia
   WHERE pedido_id = r.id AND resolvida_em IS NULL FOR UPDATE;
  SELECT t.leitura_lido_ate INTO v_marco FROM public.sayerlack_portal_retrato t
   WHERE t.pedido_id = r.id ORDER BY t.versao DESC LIMIT 1;
  v_posterior := (v_aberta.id IS NULL
                  OR (p_origem = 'redisparo' AND v_de IS NOT NULL AND v_de > GREATEST(v_aberta.lido_ate, v_aberta.ultima_lido_ate)))
             AND (v_marco IS NULL OR (p_origem = 'redisparo' AND v_de IS NOT NULL AND v_de > v_marco));

  -- 0b. Modo 'aceito_portal' (fatia 2): só pela RPC `sayerlack_aceitar_portal`, que autoriza ESTA chamada pelo GUC
  --     local '<pedido>:<divergência>:<ator>' — e só sobre a leitura da PRÓPRIA divergência aberta (a ordem das
  --     observações não se aplica: não é uma leitura nova, é a que o humano aceitou).
  IF p_origem = 'aceito_portal' THEN
    v_guc := NULLIF(current_setting('app.sayerlack_aceitar_portal', true), '');
    IF v_guc IS NULL OR v_aberta.id IS NULL
       OR v_guc !~ '^[0-9]+:[0-9]+:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
       OR split_part(v_guc, ':', 1) IS DISTINCT FROM r.id::text
       OR split_part(v_guc, ':', 2) IS DISTINCT FROM v_aberta.id::text
       OR r.portal_divergencia_aberta_id IS DISTINCT FROM v_aberta.id THEN
      RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = '[CONFERIR-ACEITO] o modo aceito_portal é só da RPC sayerlack_aceitar_portal, sobre a divergência aberta do pedido';
    END IF;
    v_ator := split_part(v_guc, ':', 3)::uuid;
    IF p_leitura IS DISTINCT FROM v_aberta.leitura OR p_evidencia_id IS DISTINCT FROM v_aberta.evidencia_id THEN
      RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = '[CONFERIR-ACEITO] a leitura aceita tem de ser a da divergência aberta';
    END IF;
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

  -- 1b. Aceito: os itens que a RPC acabou de reescrever TÊM de bater com a leitura em SKU e quantidade — senão nada
  --     se grava (a RPC desfaz tudo). Depois: retrato v+1 desta leitura com o marco da última observação dela e a
  --     divergência fecha como 'aceito_portal'. O gate FICA (Codex código P1): o claim segue recusando até a releitura
  --     posterior ao marco bater com este retrato — aí o passo "bateu" abaixo o solta.
  IF p_origem = 'aceito_portal' THEN
    IF v_diff IS NOT NULL THEN
      RAISE EXCEPTION USING ERRCODE = 'AP009',
        MESSAGE = '[CONFERIR-ACEITO] os itens reescritos não batem com a leitura aceita: ' || left(v_diff::text, 300);
    END IF;
    INSERT INTO public.sayerlack_portal_retrato (pedido_id, versao, protocolo, origem, evidencia_id, itens,
                                                 valor_total, condicao_portal, condicao_normalizada, leitura_lido_ate)
    SELECT r.id,
           COALESCE((SELECT max(t.versao) FROM public.sayerlack_portal_retrato t WHERE t.pedido_id = r.id), 0) + 1,
           v_proto, 'aceito_portal', v_aberta.evidencia_id,
           (SELECT jsonb_agg(jsonb_build_object('sku_portal', upper(btrim(x.e->>'sku_portal')),
                                                'qtde_portal', (x.e->>'qtde_portal')::numeric,
                                                'valor_mercadoria', (x.e->>'valor_mercadoria')::numeric) ORDER BY x.o)
              FROM jsonb_array_elements(p_leitura->'itens') WITH ORDINALITY AS x(e, o)),
           (p_leitura->>'valor_total')::numeric, v_cond, v_norm,
           GREATEST(v_aberta.lido_ate, v_aberta.ultima_lido_ate)
    RETURNING * INTO v_ret;
    UPDATE public.sayerlack_portal_divergencia
       SET resolvida_em = now(), resolucao = 'aceito_portal', resolvida_por = v_ator
     WHERE id = v_aberta.id AND resolvida_em IS NULL;
    RETURN jsonb_build_object('conferido', true, 'divergente', false, 'aceito', true, 'pedido_id', r.id,
                              'retrato_criado', true, 'retrato_versao', v_ret.versao,
                              'divergencia_fechada_id', v_aberta.id, 'aguardando_releitura', true);
  END IF;

  -- 2. Retrato vigente (a maior versão). Sem retrato, ESTA leitura vira o retrato — SÓ se SKU e quantidade bateram
  --    (Codex 5.2 P1): uma 1ª leitura já divergente não pode virar a referência de valor e condição; quando o portal
  --    voltar ao pedido, a leitura que bater semeia.
  SELECT * INTO v_ret FROM public.sayerlack_portal_retrato WHERE pedido_id = r.id ORDER BY versao DESC LIMIT 1;

  -- 2a. [SEM-RETRATO-REF] Sem retrato, a leitura não pode se comparar consigo mesma (Codex revisão final, achado 1):
  --     valor por SKU, total e condição contra o que o DISPARADOR mandaria ao Omie — o unitário SEM IPI provado
  --     (`preco_unitario_sem_ipi_portal` × `qtde_final`, só com o pedido INTEIRO decomposto, coerente e de quantidade
  --     inteira: a regra do `montarProdutosIncluir`, que manda ceil(qtde)), o total provado DESTE protocolo e o código
  --     de condição do pedido. Ausente ≠ zero: referência ausente vira DIFERENÇA ('sem_referencia_app'; condição do app
  --     ausente ou do portal sem de-para = 'condicao'), nunca "bateu" — e nunca recusa muda (Codex, 2ª rodada P1: a
  --     recusa não grava gate e o disparador direto sairia com os valores do app). Divergiu ⇒ o fluxo de sempre
  --     (aberta, gate na linha, "Aceitar o portal" reescreve itens, custo e condição pela leitura); o retrato só nasce
  --     com TUDO batendo.
  IF v_ret.pedido_id IS NULL THEN
    v_ref_valor := EXISTS (SELECT 1 FROM public.pedido_compra_item i WHERE i.pedido_id = r.id)
       AND NOT EXISTS (SELECT 1 FROM public.pedido_compra_item i
                        WHERE i.pedido_id = r.id
                          AND NOT COALESCE(i.preco_unitario_sem_ipi_portal > 0 AND i.valor_ipi_portal >= 0
                                           AND i.valor_linha > 0 AND i.qtde_final > 0
                                           AND i.qtde_final = trunc(i.qtde_final)
                                           AND abs(i.preco_unitario_sem_ipi_portal * i.qtde_final + i.valor_ipi_portal
                                                   - i.valor_linha) <= 0.005, false))
       AND COALESCE(r.valor_total_portal_provado > 0, false)
       AND btrim(COALESCE(r.valor_total_portal_provado_protocolo, '')) = v_proto;
    BEGIN
      SELECT c.codigo INTO v_cond_omie FROM public.sayerlack_condicao_portal_para_omie(v_cond) c;
    EXCEPTION WHEN SQLSTATE 'IP007' THEN
      v_cond_omie := NULL;   -- sem de-para no Omie: a condição do portal não é a do pedido (diferença abaixo)
    END;

    IF v_ref_valor THEN
      WITH portal AS (
        SELECT upper(btrim(e->>'sku_portal')) AS sku, sum(round((e->>'valor_mercadoria')::numeric, 2)) AS v
          FROM jsonb_array_elements(p_leitura->'itens') e GROUP BY 1
      ), app AS (
        SELECT upper(btrim(i.sku_portal_aprovado)) AS sku, sum(round(i.preco_unitario_sem_ipi_portal * i.qtde_final, 2)) AS v
          FROM public.pedido_compra_item i
         WHERE i.pedido_id = r.id AND NULLIF(btrim(COALESCE(i.sku_portal_aprovado, '')), '') IS NOT NULL
         GROUP BY 1
      ), d AS (
        SELECT 'valor_item' AS tipo, COALESCE(p.sku, a.sku) AS sku, a.v AS app, p.v AS portal
          FROM portal p FULL JOIN app a ON a.sku = p.sku
         WHERE p.sku IS NULL OR a.sku IS NULL OR abs(p.v - a.v) > 0.005
        UNION ALL
        SELECT 'valor_total', NULL, r.valor_total_portal_provado, (p_leitura->>'valor_total')::numeric
         WHERE abs(r.valor_total_portal_provado - (p_leitura->>'valor_total')::numeric) > 0.005
      )
      SELECT COALESCE(v_diff, '[]'::jsonb)
             || COALESCE(jsonb_agg(jsonb_build_object('tipo', d.tipo, 'sku', d.sku, 'app', d.app, 'portal', d.portal)), '[]'::jsonb)
        INTO v_diff FROM d;
    ELSE
      v_diff := COALESCE(v_diff, '[]'::jsonb) || jsonb_build_array(jsonb_build_object(
        'tipo', 'sem_referencia_app', 'sku', NULL, 'app', NULL, 'portal', (p_leitura->>'valor_total')::numeric));
    END IF;
    IF NULLIF(btrim(COALESCE(r.condicao_pagamento_codigo, '')), '') IS NULL OR v_cond_omie IS NULL
       OR v_cond_omie <> btrim(r.condicao_pagamento_codigo) THEN
      v_diff := COALESCE(v_diff, '[]'::jsonb) || jsonb_build_array(jsonb_build_object(
        'tipo', 'condicao', 'sku', NULL,
        'app', NULLIF(btrim(COALESCE(r.condicao_pagamento_codigo, '')), '')
               || COALESCE(' · ' || NULLIF(btrim(r.condicao_pagamento_descricao), ''), ''),
        'portal', v_cond));
    END IF;
    IF v_diff = '[]'::jsonb THEN
      v_diff := NULL;
    END IF;
  END IF;

  IF v_ret.pedido_id IS NULL AND v_diff IS NULL AND v_posterior THEN
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

  -- 3. Valor por SKU, total e condição contra o retrato (sem retrato, a referência foi o próprio pedido — 2a).
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

  -- O mesmo diff E o mesmo conteúdo (Codex fatia 2, a): a aberta segue valendo (não empilha linha a cada importação,
  -- e a ordem não importa). O conteúdo é que prova que a leitura guardada (a que o aceite aplica) ainda é a do
  -- portal (sem retrato com referência parcial, valor/total/condição podem não ter entrado no diff).
  IF v_diff IS NOT NULL AND v_aberta.id IS NOT NULL AND v_aberta.diferencas = v_diff
     AND v_aberta.retrato_versao IS NOT DISTINCT FROM v_ret.versao
     AND public.sayerlack__portal_leitura_conteudo(v_aberta.leitura) = public.sayerlack__portal_leitura_conteudo(p_leitura) THEN
    -- Carimba a ÚLTIMA observação do mesmo diff (Codex 5.2 P1): uma leitura mais velha que ESTA não pode fechá-la.
    UPDATE public.sayerlack_portal_divergencia
       SET ultima_lido_ate = v_ate, ultima_evidencia_id = p_evidencia_id
     WHERE id = v_aberta.id AND v_ate > GREATEST(v_aberta.lido_ate, v_aberta.ultima_lido_ate);
    RETURN jsonb_build_object('conferido', true, 'divergente', true, 'pedido_id', r.id, 'divergencia_id', v_aberta.id,
                              'retrato_criado', v_criado, 'retrato_versao', v_ret.versao, 'diferencas', v_diff,
                              'pendente_desde', r.disparo_claim_em);
  END IF;
  -- Fechar ou substituir a aberta exige leitura provadamente POSTERIOR à dela (e ao marco do retrato aceito).
  IF NOT v_posterior THEN
    RETURN jsonb_build_object('conferido', false, 'motivo', 'leitura_antiga', 'pedido_id', r.id,
                              'divergencia_id', v_aberta.id,
                              'divergencia_lido_ate', GREATEST(v_aberta.lido_ate, v_aberta.ultima_lido_ate),
                              'aceito_lido_ate', v_marco);
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

-- ── POS ───────────────────────────────────────────────────────────────────────────────────────────
DO $pos$
DECLARE
  f text := 'public.sayerlack_conferir_portal(bigint,jsonb,bigint,text)';
BEGIN
  IF to_regprocedure(f) IS NULL OR position('[SEM-RETRATO-REF]' IN pg_get_functiondef(f::regprocedure)) = 0
     OR position('preco_unitario_sem_ipi_portal' IN pg_get_functiondef(f::regprocedure)) = 0 THEN
    RAISE EXCEPTION 'SR1 FALHOU: a porta no ar não compara a leitura sem retrato com o próprio pedido';
  END IF;
  IF position('app.sayerlack_aceitar_portal' IN pg_get_functiondef(f::regprocedure)) = 0
     OR position('v_marco' IN pg_get_functiondef(f::regprocedure)) = 0 THEN
    RAISE EXCEPTION 'SR2 FALHOU: a porta perdeu o modo aceito_portal ou o marco do retrato aceito';
  END IF;
  IF has_function_privilege('anon', f, 'EXECUTE') OR has_function_privilege('authenticated', f, 'EXECUTE')
     OR NOT has_function_privilege('service_role', f, 'EXECUTE') THEN
    RAISE EXCEPTION 'SR3 FALHOU: a porta aberta para anon/authenticated ou fechada para service_role';
  END IF;
  RAISE NOTICE 'CONFERIR_SEM_RETRATO_POS_OK';
END
$pos$;
