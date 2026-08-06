-- ═══════════════════════════════════════════════════════════════════════════
-- Tintométrico Fase 3 — revalidação no SUBMIT (a fronteira que TODA via cruza)
--
-- Problema (plano 2026-07-17 §Fase 3): a proteção de preço tint vive só na UI
-- do picker (selectTintPrice). O cache de preço dura 5min; a conversão de
-- orçamento (SalesQuotes.convertToOrder), a edição (useSalesOrderEdit) e o
-- retry idempotente re-enviam `valor_unitario` persistido/velho DIRETO ao edge
-- omie-vendas-sync → preço obsoleto/fórmula morta vira PV real no Omie sem
-- barreira (subfaturamento silencioso — o mesmo mal das 240 receitas parciais).
--
-- Fecho: o edge (criar_pedido/alterar_pedido — fronteira final comum) chama
-- `tint_gate_revalida` ANTES de tocar o Omie. Regras (endurecidas por DOIS
-- challenges Codex xhigh 2026-07-19 — design e diff):
--   1. A identificação de item tint NÃO depende só do marcador `tint_cor_id`
--      do payload (removível pelo caller): item SEM cor cujo PRODUTO é base
--      tintométrica (omie_products.is_tintometric AND tint_type='base') é
--      bloqueado na criação (o push nunca produziu base sem cor — 0 na
--      história) e, na edição, só passa se IDÊNTICO ao baseline persistido
--      (linha inbound do balcão físico preservada — 5.167 no histórico).
--      `omie_codigo_produto` aceita number OU string numérica (o edge trafega
--      os dois) — código não-numérico é payload_invalido, nunca "não-tint".
--   2. Fórmula canônica ATUAL resolvida por (produto→sku→v_tint_formula_
--      canonica); desativada/inexistente ⇒ bloqueia (formula_morta). Fonte
--      DECLARADA exige `tint_formula_id` válido e pertencente a (conta, cor)
--      — sem isso, payload_invalido (anti-adulteração). Produto com MAIS de
--      um SKU candidato para a cor e sem fórmula declarada que desambigue ⇒
--      bloqueia (formula_ambigua) — nunca desempatar célula por UUID.
--   3. Preço recomputado AGORA (get_tint_price + preco_csv_legado); motor sem
--      preço ⇒ bloqueia TODAS as fontes (paridade com selectTintPrice regra 1).
--   4. Valida contra a FONTE DECLARADA (tint_price_source + tint_discount_pct,
--      0 ≤ d < 100) — preserva a ESCOLHA da vendedora (2b: "tabela versão
--      anterior" é legítima; o que barra é preço OBSOLETO, não a escolha).
--      Fonte 'manual' = preço digitado na edição: passa se ≥ piso atual
--      min(calc, tabela) — subir é livre, baixar além do piso não.
--   5. Item sem metadados só cai no piso legado min(fontes) com PROVA de
--      proveniência server-side: o item correspondente no jsonb PERSISTIDO
--      (sales_orders.items) também não tem metadados. Payload que OMITE
--      metadados que o persistido tem ⇒ bloqueia (metadados_ausentes).
--   6. Edição: item tint IDÊNTICO ao baseline (produto+cor+qtd+valor+fonte+
--      desconto, com CONTAGEM por assinatura) passa com warning — o valor já
--      está no Omie; barrar impediria editar parcela/observação. Item novo/
--      alterado revalida. ⚠️ Pré-requisito: o caller NÃO persiste items antes
--      do gate (o front da edição aguarda o edge — Codex P1 do design).
--   7. Fonte 'cliente' validada por tint_ultimo_preco_cliente EXCLUINDO o
--      próprio pedido (p_exclude_sales_order_id) — anti-autovalidação.
--
-- `tint_ultimo_preco_cliente` substitui a inferência crua do picker
-- (useTintColorSelect ~:229 — 50 pedidos SEM filtro de status): só pedido REAL
-- no Omie (omie_pedido_id NOT NULL), não-cancelado, janela de 180 dias — e o
-- MESMO helper valida a fonte no gate (paridade estrutural, zero espelho).
--
-- Paridade numérica com o cliente JS (por construção, não por tolerância):
-- toda a aritmética roda em FLOAT8 (IEEE754 = Number do JS), a partir do MESMO
-- texto decimal que o PostgREST serializa ao front:
--   ceil10:  ceil(v*10)/10           ≡ Math.ceil(v*10)/10        (select-price)
--   round2:  floor(v*100 + 0.5)/100  ≡ Math.round(v*100)/100     (desconto)
-- (round(dp) do Postgres é half-to-even ≠ Math.round — por isso floor+0.5.)
-- Comparação final com tolerância 0.005 (igualdade de centavos).
--
-- Autorização: tint_gate_revalida é service_role-only (só o edge chama;
-- REVOKE por nome — FROM PUBLIC não tira anon/authenticated no Supabase).
-- tint_ultimo_preco_cliente é INVOKER com grant a authenticated: sob o picker
-- ela respeita a RLS de sales_orders EXATAMENTE como a query crua que
-- substitui (não dá acesso novo); sob o edge (service_role) bypassa como hoje.
--
-- Prova: db/test-tint-gate-revalida.sh (PG17, snapshot + migrations reais,
-- falsificação por invariante). Plano: docs/superpowers/plans/
-- 2026-07-17-tint-receita-perdida-remediacao.md §Fase 3.
-- ═══════════════════════════════════════════════════════════════════════════

-- ───────────────────────────────────────────────────────────────────────────
-- 1. Último preço PRATICADO do cliente para (produto, cor) — endurecido.
--    Fonte única da inferência 'cliente': o picker (authenticated, sob RLS)
--    e o gate (service_role) chamam a MESMA função. p_exclude_sales_order_id
--    tira o pedido CORRENTE da inferência (anti-autovalidação na edição).
-- ───────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.tint_ultimo_preco_cliente(
  p_customer_user_id uuid,
  p_product_id uuid,
  p_cor_id text,
  p_exclude_sales_order_id uuid DEFAULT NULL
)
RETURNS jsonb
LANGUAGE sql
STABLE
SET search_path = public, pg_temp
AS $$
  SELECT jsonb_build_object(
    'price', (it.item->>'valor_unitario')::float8,
    'date',  so.created_at,
    'sales_order_id', so.id
  )
  FROM public.sales_orders so
  -- CASE defensivo: linha histórica com items não-array NÃO pode derrubar a
  -- RPC (a ordem de avaliação WHERE×LATERAL não é garantida pelo planner —
  -- um typeof no WHERE não protegeria o jsonb_array_elements).
  CROSS JOIN LATERAL jsonb_array_elements(
    CASE WHEN jsonb_typeof(so.items) = 'array' THEN so.items ELSE '[]'::jsonb END
  ) AS it(item)
  WHERE so.customer_user_id = p_customer_user_id
    AND so.account = 'oben'
    -- acordo comercial só conta se virou pedido REAL no Omie…
    AND so.omie_pedido_id IS NOT NULL
    -- …não-cancelado…
    AND so.status IS DISTINCT FROM 'cancelado'
    -- …recente (validade da inferência; fora da janela = renegociar)…
    AND so.created_at >= now() - interval '180 days'
    -- …e NUNCA o pedido que está sendo validado (anti-autovalidação)
    AND (p_exclude_sales_order_id IS NULL OR so.id <> p_exclude_sales_order_id)
    AND it.item->>'product_id' = p_product_id::text
    AND it.item->>'tint_cor_id' = p_cor_id
    AND jsonb_typeof(it.item->'valor_unitario') = 'number'
    AND (it.item->>'valor_unitario')::float8 > 0
  ORDER BY so.created_at DESC
  LIMIT 1
$$;

COMMENT ON FUNCTION public.tint_ultimo_preco_cliente(uuid, uuid, text, uuid) IS
  'Fase 3 tint: último preço praticado do cliente para (produto omie, cor) — '
  'só pedido real no Omie, não-cancelado, janela 180d, excluindo o pedido '
  'corrente (anti-autovalidação). Fonte ÚNICA da fonte "cliente": o picker '
  '(INVOKER, sob RLS) e o gate do submit usam a mesma função. NULL = sem '
  'acordo comprovado na janela.';

-- ───────────────────────────────────────────────────────────────────────────
-- 2. O gate da fronteira: revalida cada item tint do payload contra o estado
--    ATUAL (canônica + motor + fonte declarada), usando o jsonb PERSISTIDO
--    como baseline de proveniência (legado × novo) e de intocabilidade.
-- ───────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.tint_gate_revalida(
  p_account text,
  p_customer_user_id uuid,
  p_sales_order_id uuid,
  p_contexto text,
  p_items jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SET search_path = public, pg_temp
AS $$
DECLARE
  v_bloqueios jsonb := '[]'::jsonb;
  v_warnings  jsonb := '[]'::jsonb;
  v_baseline  jsonb;
  v_base_sigs jsonb;              -- {assinatura: count} do baseline
  v_usados    jsonb := '{}'::jsonb; -- {assinatura: count} já consumidos do payload
  v_item      jsonb;
  v_idx       int;
  v_cor       text;
  v_cod_txt   text;
  v_sig       text;
  v_base_n    int;
  v_uso_n     int;
  v_declarada uuid;
  v_declarada_coerente boolean;
  v_prod_id   uuid;
  v_is_base_tint boolean;
  v_n_skus    int;
  v_can_id    uuid;
  v_can_csv   numeric;
  v_price     jsonb;
  v_calc_raw  float8;
  v_calc      float8;
  v_tab       float8;
  v_vu        float8;
  v_fonte     text;
  v_desc      float8;
  v_esperado  float8;
  v_floor     float8;
  v_ult       jsonb;
  v_motivo    text;
  v_legado_ok boolean;

  -- espelhos JS (float8 de ponta a ponta — ver cabeçalho):
  --   ceil10(v) ≡ Math.ceil(v*10)/10 · round2(v) ≡ floor(v*100+0.5)/100
BEGIN
  IF p_contexto NOT IN ('criacao', 'edicao') THEN
    RETURN jsonb_build_object('ok', false, 'bloqueios', jsonb_build_array(
      jsonb_build_object('index', -1, 'motivo', 'payload_invalido',
                         'detalhe', 'contexto desconhecido: ' || COALESCE(p_contexto, 'NULL'))),
      'warnings', v_warnings);
  END IF;
  IF p_items IS NULL OR jsonb_typeof(p_items) <> 'array' THEN
    RETURN jsonb_build_object('ok', false, 'bloqueios', jsonb_build_array(
      jsonb_build_object('index', -1, 'motivo', 'payload_invalido',
                         'detalhe', 'items ausente ou não é array')),
      'warnings', v_warnings);
  END IF;

  -- Baseline PERSISTIDO (fonte de proveniência/intocabilidade — o caller não
  -- controla; a edição só persiste APÓS o gate). Linha ausente ⇒ '[]'.
  SELECT CASE WHEN jsonb_typeof(so.items) = 'array' THEN so.items ELSE '[]'::jsonb END
    INTO v_baseline
  FROM public.sales_orders so WHERE so.id = p_sales_order_id;
  v_baseline := COALESCE(v_baseline, '[]'::jsonb);

  -- Assinaturas do baseline (com contagem): T|produto|cor|qtd|valor|fonte|desc
  -- para item tint; B|produto|qtd|valor para base-sem-cor. Números
  -- canonicalizados via float8::text; campo malformado vira '?' (nunca erro).
  SELECT COALESCE(jsonb_object_agg(sig, n), '{}'::jsonb) INTO v_base_sigs
  FROM (
    SELECT
      CASE WHEN bi.item->>'tint_cor_id' IS NOT NULL AND bi.item->>'tint_cor_id' <> '' THEN
        'T|' || COALESCE(bi.item->>'omie_codigo_produto', '?') || '|' || (bi.item->>'tint_cor_id') || '|'
             || CASE WHEN jsonb_typeof(bi.item->'quantidade') = 'number'
                     THEN ((bi.item->>'quantidade')::float8)::text ELSE '?' END || '|'
             || CASE WHEN jsonb_typeof(bi.item->'valor_unitario') = 'number'
                     THEN ((bi.item->>'valor_unitario')::float8)::text ELSE '?' END || '|'
             || COALESCE(bi.item->>'tint_price_source', '-') || '|'
             || CASE WHEN jsonb_typeof(bi.item->'tint_discount_pct') = 'number'
                     THEN ((bi.item->>'tint_discount_pct')::float8)::text ELSE '0' END
      ELSE
        'B|' || COALESCE(bi.item->>'omie_codigo_produto', '?') || '|'
             || CASE WHEN jsonb_typeof(bi.item->'quantidade') = 'number'
                     THEN ((bi.item->>'quantidade')::float8)::text ELSE '?' END || '|'
             || CASE WHEN jsonb_typeof(bi.item->'valor_unitario') = 'number'
                     THEN ((bi.item->>'valor_unitario')::float8)::text ELSE '?' END
      END AS sig,
      count(*) AS n
    FROM jsonb_array_elements(v_baseline) AS bi(item)
    GROUP BY 1
  ) s;

  FOR v_idx, v_item IN
    SELECT (ord - 1)::int, val
    FROM jsonb_array_elements(p_items) WITH ORDINALITY AS t(val, ord)
  LOOP
    v_cor := NULLIF(v_item->>'tint_cor_id', '');

    -- valor_unitario numérico (o edge já barrou ≤0/NaN antes; defesa em profundidade)
    IF jsonb_typeof(v_item->'valor_unitario') <> 'number' THEN
      v_bloqueios := v_bloqueios || jsonb_build_object(
        'index', v_idx, 'cor_id', v_cor, 'motivo', 'payload_invalido',
        'detalhe', 'valor_unitario não numérico');
      CONTINUE;
    END IF;
    v_vu := (v_item->>'valor_unitario')::float8;

    -- Código do produto: number OU string numérica (o edge trafega os dois —
    -- Codex P1 do diff: "900001" string escapava da classificação). Código
    -- ilegível NUNCA vira "não-tint": é payload_invalido (fail-closed).
    v_cod_txt := v_item->>'omie_codigo_produto';
    IF v_cod_txt IS NULL OR v_cod_txt !~ '^[0-9]{1,15}$' THEN
      v_bloqueios := v_bloqueios || jsonb_build_object(
        'index', v_idx, 'cor_id', v_cor, 'motivo', 'payload_invalido',
        'detalhe', 'omie_codigo_produto ausente/não numérico: ' || COALESCE(v_cod_txt, 'NULL'));
      CONTINUE;
    END IF;

    v_prod_id := NULL; v_is_base_tint := false;
    SELECT op.id, COALESCE(op.is_tintometric, false) AND op.tint_type = 'base'
      INTO v_prod_id, v_is_base_tint
    FROM public.omie_products op
    WHERE op.omie_codigo_produto = v_cod_txt::bigint
      AND op.account = p_account;

    IF v_cor IS NULL THEN
      -- Item SEM marcador tint: só interessa se o PRODUTO é base tintométrica
      -- (classificação server-side — a ausência do marcador NÃO decide sozinha;
      -- Codex P1: omitir tint_cor_id não pode desligar o gate).
      CONTINUE WHEN NOT v_is_base_tint;
      IF p_contexto = 'criacao' THEN
        -- Push nunca produziu base sem cor (0 na história) — omissão = bloqueio.
        v_bloqueios := v_bloqueios || jsonb_build_object(
          'index', v_idx, 'motivo', 'base_sem_cor',
          'detalhe', 'base tintométrica sem cor não é vendável pelo app — escolha a cor no balcão de tinta');
        CONTINUE;
      END IF;
      -- Edição: linha inbound (balcão físico, importada do Omie) é legítima —
      -- mas SÓ intocada (mesma assinatura B| com contagem no baseline).
      v_sig := 'B|' || v_cod_txt || '|'
            || CASE WHEN jsonb_typeof(v_item->'quantidade') = 'number'
                    THEN ((v_item->>'quantidade')::float8)::text ELSE '?' END || '|'
            || (v_vu)::text;
      v_base_n := COALESCE((v_base_sigs->>v_sig)::int, 0);
      v_uso_n  := COALESCE((v_usados->>v_sig)::int, 0);
      IF v_uso_n < v_base_n THEN
        v_usados := jsonb_set(v_usados, ARRAY[v_sig], to_jsonb(v_uso_n + 1));
        CONTINUE; -- inbound preservada
      END IF;
      v_bloqueios := v_bloqueios || jsonb_build_object(
        'index', v_idx, 'motivo', 'base_sem_cor_alterada',
        'detalhe', 'base tintométrica sem cor alterada/nova na edição — reprecifique pela tela de tinta');
      CONTINUE;
    END IF;

    -- ── item COM tint_cor_id ──
    IF v_prod_id IS NULL THEN
      v_bloqueios := v_bloqueios || jsonb_build_object(
        'index', v_idx, 'cor_id', v_cor, 'motivo', 'produto_nao_encontrado',
        'detalhe', 'produto do item tint não existe na conta ' || p_account);
      CONTINUE;
    END IF;

    -- Edição: item IDÊNTICO ao baseline (assinatura completa, com contagem)
    -- passa com warning — o valor já está no Omie; barrar impediria editar
    -- parcela/observação. Item novo/alterado segue para a validação.
    IF p_contexto = 'edicao' THEN
      v_sig := 'T|' || v_cod_txt || '|' || v_cor || '|'
            || CASE WHEN jsonb_typeof(v_item->'quantidade') = 'number'
                    THEN ((v_item->>'quantidade')::float8)::text ELSE '?' END || '|'
            || (v_vu)::text || '|'
            || COALESCE(v_item->>'tint_price_source', '-') || '|'
            || CASE WHEN jsonb_typeof(v_item->'tint_discount_pct') = 'number'
                    THEN ((v_item->>'tint_discount_pct')::float8)::text ELSE '0' END;
      v_base_n := COALESCE((v_base_sigs->>v_sig)::int, 0);
      v_uso_n  := COALESCE((v_usados->>v_sig)::int, 0);
      IF v_uso_n < v_base_n THEN
        v_usados := jsonb_set(v_usados, ARRAY[v_sig], to_jsonb(v_uso_n + 1));
        v_warnings := v_warnings || jsonb_build_object(
          'index', v_idx, 'cor_id', v_cor, 'aviso', 'tint_intocado',
          'detalhe', 'item tint idêntico ao pedido persistido — preço não revalidado (já está no Omie)');
        CONTINUE;
      END IF;
    END IF;

    -- fórmula declarada (cast defensivo — uuid inválido vira NULL)
    v_declarada := NULL;
    IF (v_item->>'tint_formula_id') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
      v_declarada := (v_item->>'tint_formula_id')::uuid;
    END IF;
    -- fórmula declarada COERENTE = existe em tint_formulas para (conta, cor) —
    -- qualquer geração (a declarada pode ser a gêmea re-canonizada). Fórmula
    -- ALHEIA (outra conta/cor) ou inexistente NÃO desambigua nem audita nada.
    v_declarada_coerente := false;
    IF v_declarada IS NOT NULL THEN
      SELECT EXISTS (
        SELECT 1 FROM public.tint_formulas tf
        WHERE tf.id = v_declarada AND tf.account = p_account AND tf.cor_id = v_cor
      ) INTO v_declarada_coerente;
    END IF;

    v_fonte := v_item->>'tint_price_source';

    -- Fonte declarada pelo PICKER exige a fórmula que o picker viu (anti-
    -- adulteração — Codex P1 do diff). 'manual' (edição humana) e legado não
    -- têm picker por trás, então não exigem.
    IF v_fonte IN ('calculado', 'tabela', 'cliente') AND NOT v_declarada_coerente THEN
      v_bloqueios := v_bloqueios || jsonb_build_object(
        'index', v_idx, 'cor_id', v_cor, 'motivo', 'payload_invalido',
        'detalhe', 'fonte declarada sem tint_formula_id válido de (conta, cor) — reprecifique no balcão de tinta');
      CONTINUE;
    END IF;

    -- Canônicas candidatas da célula: produto pode ter MAIS de um SKU com a
    -- cor. Sem fórmula declarada que desambigue, célula ambígua BLOQUEIA
    -- (nunca desempatar preço por UUID — Codex P1 do diff).
    SELECT count(*) INTO v_n_skus
    FROM public.tint_skus s
    JOIN public.v_tint_formula_canonica c
      ON c.account = p_account AND c.sku_id = s.id AND c.cor_id = v_cor
    WHERE s.omie_product_id = v_prod_id
      AND s.account = p_account;

    IF v_n_skus = 0 THEN
      v_bloqueios := v_bloqueios || jsonb_build_object(
        'index', v_idx, 'cor_id', v_cor, 'motivo', 'formula_morta',
        'detalhe', 'não há fórmula ativa/canônica desta cor para o produto — reprecifique no balcão de tinta');
      CONTINUE;
    END IF;

    v_can_id := NULL; v_can_csv := NULL;
    IF v_n_skus > 1 THEN
      -- só a fórmula declarada (do picker) desambigua a célula
      SELECT c.id, c.preco_csv_legado INTO v_can_id, v_can_csv
      FROM public.tint_skus s
      JOIN public.v_tint_formula_canonica c
        ON c.account = p_account AND c.sku_id = s.id AND c.cor_id = v_cor
      WHERE s.omie_product_id = v_prod_id
        AND s.account = p_account
        AND c.id = v_declarada;
      IF v_can_id IS NULL THEN
        v_bloqueios := v_bloqueios || jsonb_build_object(
          'index', v_idx, 'cor_id', v_cor, 'motivo', 'formula_ambigua',
          'detalhe', 'o produto tem mais de um SKU com esta cor e a fórmula declarada não resolve — reprecifique no balcão de tinta');
        CONTINUE;
      END IF;
    ELSE
      SELECT c.id, c.preco_csv_legado INTO v_can_id, v_can_csv
      FROM public.tint_skus s
      JOIN public.v_tint_formula_canonica c
        ON c.account = p_account AND c.sku_id = s.id AND c.cor_id = v_cor
      WHERE s.omie_product_id = v_prod_id
        AND s.account = p_account;
    END IF;

    IF v_declarada_coerente AND v_declarada <> v_can_id THEN
      -- geração trocou (ex.: Fase 5 desativar a SAYERLACK) — informa, não barra;
      -- o PREÇO é validado contra a canônica atual de qualquer forma.
      v_warnings := v_warnings || jsonb_build_object(
        'index', v_idx, 'cor_id', v_cor, 'aviso', 'formula_recanonizada',
        'declarada', v_declarada, 'canonica', v_can_id);
    END IF;

    -- motor de preço AGORA (get_tint_price REAL — sem cache de 5min)
    v_price := public.get_tint_price(v_can_id);
    v_calc_raw := (v_price->>'precoFinal')::float8;
    IF v_calc_raw IS NULL THEN
      -- paridade com selectTintPrice regra 1: motor sem preço bloqueia TODAS
      -- as fontes (inclusive tabela/cliente) — nunca vender o que a RPC barra.
      v_motivo := CASE
        WHEN NOT COALESCE((v_price->>'baseDisponivel')::boolean, false) THEN 'base'
        WHEN NOT COALESCE((v_price->>'corantesCompletos')::boolean, false) THEN 'corante'
        ELSE 'receita' END;
      v_bloqueios := v_bloqueios || jsonb_build_object(
        'index', v_idx, 'cor_id', v_cor, 'motivo', 'sem_preco_motor',
        'detalhe', 'motor honesto sem preço (' || v_motivo || ') — corrija no Omie/tintométrico antes de vender');
      CONTINUE;
    END IF;

    v_calc := ceil(v_calc_raw * 10) / 10;                       -- ceil10 (≡ JS)
    v_tab  := CASE WHEN v_can_csv IS NOT NULL AND v_can_csv > 0
                   THEN ceil((v_can_csv)::float8 * 10) / 10 ELSE NULL END;

    -- desconto declarado (0 ≤ d < 100; ausente = 0). d=100 é incompatível com
    -- o guard global preço>0 do edge — contrato alinhado (Codex).
    v_desc := 0;
    IF v_item ? 'tint_discount_pct' THEN
      IF jsonb_typeof(v_item->'tint_discount_pct') <> 'number' THEN
        v_bloqueios := v_bloqueios || jsonb_build_object(
          'index', v_idx, 'cor_id', v_cor, 'motivo', 'desconto_invalido',
          'detalhe', 'tint_discount_pct não numérico');
        CONTINUE;
      END IF;
      v_desc := (v_item->>'tint_discount_pct')::float8;
      IF v_desc < 0 OR v_desc >= 100 THEN
        v_bloqueios := v_bloqueios || jsonb_build_object(
          'index', v_idx, 'cor_id', v_cor, 'motivo', 'desconto_invalido',
          'detalhe', 'tint_discount_pct fora de 0–99.99: ' || v_desc);
        CONTINUE;
      END IF;
    END IF;

    IF v_fonte = 'calculado' THEN
      v_esperado := floor(v_calc * (1 - v_desc/100) * 100 + 0.5) / 100;

    ELSIF v_fonte = 'tabela' THEN
      IF v_tab IS NULL THEN
        v_bloqueios := v_bloqueios || jsonb_build_object(
          'index', v_idx, 'cor_id', v_cor, 'motivo', 'fonte_tabela_indisponivel',
          'detalhe', 'a fonte "tabela" foi escolhida mas a chave não tem mais CSV — reprecifique no balcão');
        CONTINUE;
      END IF;
      v_esperado := floor(v_tab * (1 - v_desc/100) * 100 + 0.5) / 100;

    ELSIF v_fonte = 'cliente' THEN
      v_ult := public.tint_ultimo_preco_cliente(
        p_customer_user_id, v_prod_id, v_cor, p_sales_order_id);
      IF v_ult IS NULL OR jsonb_typeof(v_ult->'price') <> 'number' THEN
        v_bloqueios := v_bloqueios || jsonb_build_object(
          'index', v_idx, 'cor_id', v_cor, 'motivo', 'preco_cliente_sem_historico',
          'detalhe', 'a fonte "cliente" exige pedido real no Omie (não-cancelado, últimos 180 dias) — não encontrado');
        CONTINUE;
      END IF;
      v_esperado := floor((v_ult->>'price')::float8 * (1 - v_desc/100) * 100 + 0.5) / 100;

    ELSIF v_fonte = 'manual' THEN
      -- Preço digitado pelo humano na EDIÇÃO (o front seta 'manual' ao editar
      -- valor de item tint): subir é livre; baixar além do piso atual das
      -- fontes legítimas bloqueia. Nada abaixo do que 'tabela'/'calculado'
      -- sem desconto já permitiriam (Codex P1 do diff: sem esta fonte, todo
      -- aumento manual legítimo caía em metadados_ausentes).
      v_floor := LEAST(v_calc, COALESCE(v_tab, v_calc));
      IF v_vu < v_floor - 0.005 THEN
        v_bloqueios := v_bloqueios || jsonb_build_object(
          'index', v_idx, 'cor_id', v_cor, 'motivo', 'preco_obsoleto',
          'detalhe', 'preço manual abaixo do piso atual das fontes (calc/tabela) — reprecifique no balcão de tinta',
          'esperado_minimo', v_floor, 'recebido', v_vu);
      END IF;
      CONTINUE;

    ELSIF v_fonte IS NULL THEN
      -- SEM metadados: o fallback legado (piso) EXIGE prova de proveniência —
      -- existe no baseline persistido um item da MESMA célula TAMBÉM sem fonte
      -- (orçamento/pedido pré-Fase-3). Sem essa prova, item novo que omite
      -- metadados é bloqueado (o fallback não é controlável pelo caller).
      SELECT EXISTS (
        SELECT 1 FROM jsonb_array_elements(v_baseline) AS bi(item)
        WHERE bi.item->>'omie_codigo_produto' = v_cod_txt
          AND bi.item->>'tint_cor_id' = v_cor
          AND bi.item->>'tint_price_source' IS NULL
      ) INTO v_legado_ok;
      IF NOT v_legado_ok THEN
        v_bloqueios := v_bloqueios || jsonb_build_object(
          'index', v_idx, 'cor_id', v_cor, 'motivo', 'metadados_ausentes',
          'detalhe', 'item tint sem fonte de preço declarada e sem lastro legado no pedido — reprecifique no balcão de tinta');
        CONTINUE;
      END IF;
      v_floor := LEAST(v_calc, COALESCE(v_tab, v_calc));
      IF v_vu < v_floor - 0.005 THEN
        v_bloqueios := v_bloqueios || jsonb_build_object(
          'index', v_idx, 'cor_id', v_cor, 'motivo', 'preco_obsoleto',
          'detalhe', 'preço abaixo do piso atual das fontes (calc/tabela) — reprecifique no balcão de tinta',
          'esperado_minimo', v_floor, 'recebido', v_vu);
      END IF;
      CONTINUE;

    ELSE
      -- fonte desconhecida (typo/adulteração) — nunca cair no fallback
      v_bloqueios := v_bloqueios || jsonb_build_object(
        'index', v_idx, 'cor_id', v_cor, 'motivo', 'fonte_invalida',
        'detalhe', 'tint_price_source desconhecida: ' || v_fonte);
      CONTINUE;
    END IF;

    -- Auditoria: preco_sem_desconto declarado divergente da fonte recomputada
    -- vira WARNING (o preço COBRADO já é validado acima — bloquear aqui só
    -- criaria falso positivo sem proteção extra).
    IF jsonb_typeof(v_item->'tint_preco_sem_desconto') = 'number' THEN
      IF abs((v_item->>'tint_preco_sem_desconto')::float8 -
             CASE v_fonte
               WHEN 'calculado' THEN v_calc
               WHEN 'tabela'    THEN v_tab
               ELSE (v_ult->>'price')::float8
             END) > 0.005 THEN
        v_warnings := v_warnings || jsonb_build_object(
          'index', v_idx, 'cor_id', v_cor, 'aviso', 'preco_sem_desconto_divergente',
          'declarado', (v_item->>'tint_preco_sem_desconto')::float8);
      END IF;
    END IF;

    IF abs(v_vu - v_esperado) > 0.005 THEN
      v_bloqueios := v_bloqueios || jsonb_build_object(
        'index', v_idx, 'cor_id', v_cor, 'motivo', 'preco_divergente',
        'detalhe', 'o preço da fonte "' || v_fonte || '" mudou desde a montagem do pedido — reprecifique no balcão de tinta',
        'fonte', v_fonte, 'esperado', v_esperado, 'recebido', v_vu);
    END IF;
  END LOOP;

  RETURN jsonb_build_object(
    'ok', jsonb_array_length(v_bloqueios) = 0,
    'bloqueios', v_bloqueios,
    'warnings', v_warnings);
END;
$$;

COMMENT ON FUNCTION public.tint_gate_revalida(text, uuid, uuid, text, jsonb) IS
  'Fase 3 tint: gate da fronteira omie-vendas-sync (criar_pedido/alterar_'
  'pedido). Revalida item tint contra o estado ATUAL (canônica viva + preço '
  'recomputado + fonte declarada, aritmética float8 ≡ JS). Baseline persistido '
  'decide proveniência (legado=piso) e intocabilidade (edição). Fontes: '
  'calculado/tabela/cliente (exigem tint_formula_id coerente) · manual (piso) '
  '· ausente (legado com lastro). Base tint sem cor: bloqueia na criação; na '
  'edição só intocada (inbound). Multi-SKU sem fórmula que desambigue: '
  'bloqueia. service_role-only. Bloqueio ⇒ {ok:false,bloqueios:[…]} — o edge '
  'NÃO toca o Omie.';

-- ───────────────────────────────────────────────────────────────────────────
-- 3. Autorização (default privileges do Supabase dão EXECUTE a todos — revogar
--    POR NOME; FROM PUBLIC sozinho não tira anon/authenticated).
-- ───────────────────────────────────────────────────────────────────────────
REVOKE ALL ON FUNCTION public.tint_gate_revalida(text, uuid, uuid, text, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.tint_gate_revalida(text, uuid, uuid, text, jsonb) TO service_role;

REVOKE ALL ON FUNCTION public.tint_ultimo_preco_cliente(uuid, uuid, text, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.tint_ultimo_preco_cliente(uuid, uuid, text, uuid) TO authenticated, service_role;

-- RPC nova consumida pelo frontend (picker) via PostgREST
NOTIFY pgrst, 'reload schema';
