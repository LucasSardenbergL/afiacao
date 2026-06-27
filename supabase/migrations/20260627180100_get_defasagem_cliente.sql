-- Fase 2b — RPC da defasagem de repasse POR CLIENTE. Money-path (só-leitura).
-- SEPARADA da get_preco_cockpit (single-responsibility; não regride a RPC de markup).
--
-- Pra cada item {empresa, codigo, preco}:
--   ÂNCORA = última linha order_items do (customer_user_id, omie_codigo_produto) JOIN
--   sales_orders, account-aware (ponte da empresa), status allowlist positiva,
--   omie_pedido_id NOT NULL, deleted_at NULL. Data = dInc do omie_payload (fallback
--   order_date_kpi); sem data confiável → sem_data_confiavel. Multi-pedido no mesmo dia
--   → média ponderada por quantity. Desconto (order_items.discount>0 OU sales_orders
--   .discount>0) → neutro/desconto_nao_provado.
--   C_last = cmc_snapshot na data da âncora (janela ±7 dias, freshest); senão neutro.
--   C_now  = inventory_position freshest (cmc>0, account=ANY); synced_at stale (>48h)
--            → sem_custo_atual_fresco.
--   Regra à prova de catraca = MESMA do helper defasagem.ts (oráculo duplo).
--
-- Saída por item (visível p/ vendedora): status_defasagem, tem_ancora, p_req,
--   alta_custo_perc, data_ancora ('MM/AAAA'), motivo, calculated_at.
-- Role-gated (pode_ver_carteira_completa): p_last, c_last, c_now, markup_anterior.
--
-- Gate idêntico à 2a: auth.uid() + has_role(employee|master) senão 42501. REVOKE anon.
-- Aplicar via SQL Editor. Prova real: db/test-defasagem.sh (PG17 + falsificações).

CREATE OR REPLACE FUNCTION public.get_defasagem_cliente(p_itens jsonb, p_customer_user_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $defasagem$
DECLARE
  -- constantes (espelho de DEFASAGEM_CONST do helper)
  c_tol_pp        constant numeric := 3;      -- pontos percentuais
  c_piso_alta     constant numeric := 2;      -- % alta mínima (anti-ruído)
  c_piso_acao_pp  constant numeric := 2;      -- % de p_now
  c_piso_acao_rs  constant numeric := 1;      -- R$ absolutos
  c_ancora_max    constant int     := 18;     -- meses
  c_quarentena    constant numeric := 50;     -- % alta absurda
  c_janela_dias   constant int     := 7;      -- ±dias da data da âncora p/ casar C_last
  c_stale_horas   constant int     := 48;     -- C_now stale se synced_at < now()-48h

  v_pode_num boolean;
  v_out jsonb := '[]'::jsonb;
  v_item jsonb;
  v_empresa text; v_codigo bigint; v_preco numeric; v_accounts text[];

  v_p_last numeric; v_qtd_ancora numeric; v_data_ancora date;
  v_disc boolean; v_qty_carrinho numeric;
  v_c_last numeric; v_c_now numeric; v_c_now_synced timestamptz;
  v_status text; v_motivo text; v_p_req numeric; v_alta_perc numeric;
  v_markup_ant numeric; v_tem_ancora boolean;
  v_razao numeric; v_alta numeric; v_subiu_preco numeric; v_gap_reais numeric; v_piso_acao numeric;
  v_data_label text;
BEGIN
  -- Gate de staff IDÊNTICO à 2a.
  IF NOT (auth.uid() IS NOT NULL
    AND (has_role(auth.uid(),'employee'::app_role) OR has_role(auth.uid(),'master'::app_role))) THEN
    RAISE EXCEPTION 'forbidden' USING errcode = '42501';
  END IF;
  IF jsonb_array_length(p_itens) > 200 THEN
    RAISE EXCEPTION 'too many items (max 200)' USING errcode = '22023';
  END IF;
  v_pode_num := pode_ver_carteira_completa(auth.uid());

  FOR v_item IN SELECT * FROM jsonb_array_elements(p_itens)
  LOOP
    -- reset por item
    v_p_last := NULL; v_qtd_ancora := NULL; v_data_ancora := NULL; v_disc := NULL;
    v_c_last := NULL; v_c_now := NULL; v_c_now_synced := NULL; v_qty_carrinho := NULL;
    v_status := NULL; v_motivo := NULL; v_p_req := NULL; v_alta_perc := NULL;
    v_markup_ant := NULL; v_tem_ancora := false; v_data_label := NULL;

    v_empresa := lower(v_item->>'empresa');
    v_codigo  := (v_item->>'codigo')::bigint;
    v_preco   := (v_item->>'preco')::numeric;
    v_qty_carrinho := NULLIF(v_item->>'qty','')::numeric;  -- opcional (G5); se ausente, qty_ratio passa

    v_accounts := CASE v_empresa
            WHEN 'oben'       THEN ARRAY['vendas','oben']
            WHEN 'colacor'    THEN ARRAY['colacor_vendas','colacor']
            WHEN 'colacor_sc' THEN ARRAY['servicos','colacor_sc']
            ELSE ARRAY[v_empresa] END;

    -- ── ÂNCORA: última compra REAL deste cliente p/ este produto (account-aware) ──
    -- Data da âncora: dInc do omie_payload (DD/MM/YYYY) → fallback order_date_kpi.
    -- Pega o pedido mais recente por essa data; média ponderada por quantity é tratada
    -- abaixo (mesmo dia). Aqui resolvemos a DATA e o flag de desconto do pedido vencedor.
    WITH ancora AS (
      SELECT
        oi.unit_price,
        oi.quantity,
        oi.discount AS disc_item,
        so.discount AS disc_pedido,
        COALESCE(
          to_date(NULLIF(so.omie_payload->'infoCadastro'->>'dInc',''),'DD/MM/YYYY'),
          so.order_date_kpi
        ) AS data_real,
        (so.omie_payload->'infoCadastro'->>'dInc') IS NOT NULL
          OR so.order_date_kpi IS NOT NULL AS data_ok
      FROM order_items oi
      JOIN sales_orders so ON so.id = oi.sales_order_id
      WHERE oi.customer_user_id = p_customer_user_id
        AND oi.omie_codigo_produto = v_codigo
        AND so.account = ANY(v_accounts)
        AND so.status IN ('faturado','importado','separacao','enviado')  -- allowlist POSITIVA
        AND so.omie_pedido_id IS NOT NULL
        AND so.deleted_at IS NULL
    ),
    melhor_data AS (
      -- a data da âncora = a maior data_real entre as linhas válidas (com data_ok)
      SELECT max(data_real) AS data_real
      FROM ancora
      WHERE data_ok AND data_real IS NOT NULL
    ),
    no_dia AS (
      -- todas as linhas naquele dia → média ponderada por quantity do unit_price
      SELECT
        a.*,
        (SELECT data_real FROM melhor_data) AS data_alvo
      FROM ancora a
      WHERE a.data_real = (SELECT data_real FROM melhor_data)
    )
    SELECT
      CASE WHEN sum(quantity) > 0
           THEN sum(unit_price * quantity) / sum(quantity)
           ELSE NULL END,
      sum(quantity),
      (SELECT data_real FROM melhor_data),
      bool_or(COALESCE(disc_item,0) > 0 OR COALESCE(disc_pedido,0) > 0),
      (count(*) > 0)
    INTO v_p_last, v_qtd_ancora, v_data_ancora, v_disc, v_tem_ancora
    FROM no_dia;

    -- ── C_now: CMC atual freshest (account-aware), + frescor (G6) ──
    SELECT ip.cmc, ip.synced_at
      INTO v_c_now, v_c_now_synced
    FROM inventory_position ip
    WHERE ip.omie_codigo_produto = v_codigo
      AND ip.cmc > 0 AND ip.cmc <> 'NaN'::numeric
      AND ip.account = ANY(v_accounts)
    ORDER BY ip.synced_at DESC NULLS LAST
    LIMIT 1;

    -- ── C_last: cmc_snapshot na data da âncora, janela ±7 dias, o mais próximo ──
    IF v_data_ancora IS NOT NULL THEN
      SELECT cs.cmc
        INTO v_c_last
      FROM cmc_snapshot cs
      WHERE cs.omie_codigo_produto = v_codigo
        AND cs.account = ANY(v_accounts)
        AND cs.cmc > 0 AND cs.cmc <> 'NaN'::numeric
        AND abs(cs.data_posicao - v_data_ancora) <= c_janela_dias
      ORDER BY abs(cs.data_posicao - v_data_ancora) ASC, cs.synced_at DESC
      LIMIT 1;
    END IF;

    -- ════════ REGRA À PROVA DE CATRACA (1:1 com defasagem.ts) ════════
    -- Ordem dos guards = literal da spec §5.2-5.4.
    IF NOT v_tem_ancora THEN
      v_status := 'sem_historico'; v_motivo := 'sem_historico';
    ELSIF v_disc THEN
      v_status := 'neutro'; v_motivo := 'desconto_nao_provado';
    ELSIF v_data_ancora IS NULL THEN
      v_status := 'sem_data_confiavel'; v_motivo := 'sem_data_confiavel';
    ELSIF v_c_now IS NULL OR v_c_now_synced IS NULL
          OR v_c_now_synced < now() - make_interval(hours => c_stale_horas) THEN
      v_status := 'sem_custo_atual_fresco'; v_motivo := 'sem_custo_atual_fresco';
    ELSIF v_c_last IS NULL THEN
      -- sem snapshot na janela → neutro (não arrisca FP — Codex #1)
      v_status := 'neutro'; v_motivo := 'sem_custo_historico';
    ELSIF v_p_last IS NULL OR v_p_last <= 0 OR v_p_last = 'NaN'::numeric
          OR v_c_last <= 0 OR v_c_last = 'NaN'::numeric
          OR v_c_now  <= 0 OR v_c_now  = 'NaN'::numeric THEN
      v_status := 'neutro'; v_motivo := 'sem_base';
    ELSIF v_qty_carrinho IS NOT NULL AND v_qtd_ancora IS NOT NULL AND v_qtd_ancora > 0
          AND (v_qty_carrinho / v_qtd_ancora >= 10 OR v_qtd_ancora / v_qty_carrinho >= 10) THEN
      -- G5: ordem de grandeza divergente → revisar
      v_status := 'revisar'; v_motivo := 'qty_divergente';
    ELSIF EXTRACT(EPOCH FROM (now() - v_data_ancora::timestamptz)) / (86400 * 30.4375) > c_ancora_max THEN
      v_status := 'neutro'; v_motivo := 'ancora_antiga';
    ELSE
      v_razao := v_c_now / v_c_last;
      IF v_razao - 1 > c_quarentena / 100 THEN
        v_status := 'revisar'; v_motivo := 'quarentena_custo';
      ELSIF v_p_last <= v_c_last THEN
        v_status := 'neutro'; v_motivo := 'prejuizo_ancora';   -- G1
      ELSIF v_c_now <= v_c_last THEN
        v_status := 'sem_alta'; v_motivo := 'custo_nao_subiu';
      ELSE
        v_alta := v_razao - 1;
        IF v_alta < c_piso_alta / 100 THEN
          v_status := 'sem_alta'; v_motivo := 'alta_ruido';
        ELSE
          v_p_req := round(v_p_last * v_razao, 2);
          v_alta_perc := v_alta * 100;
          v_subiu_preco := CASE WHEN v_preco > 0 THEN v_preco / v_p_last - 1 ELSE -1 END;
          IF v_subiu_preco < v_alta - c_tol_pp / 100 THEN
            -- passa por razão → testa piso de ação (em R$ arredondado a centavo)
            v_gap_reais := round(v_p_req, 2) - round(v_preco, 2);
            v_piso_acao := greatest((c_piso_acao_pp / 100) * v_preco, c_piso_acao_rs);
            IF v_gap_reais < v_piso_acao THEN
              v_status := 'em_dia'; v_motivo := 'gap_abaixo_do_piso';
            ELSE
              v_status := 'defasado'; v_motivo := 'custo_subiu_preco_nao_acompanhou';
            END IF;
          ELSE
            v_status := 'em_dia'; v_motivo := 'preco_acompanhou';
          END IF;
        END IF;
      END IF;
    END IF;

    -- markup anterior (só p/ gestor) — só faz sentido com base válida.
    IF v_p_last IS NOT NULL AND v_c_last IS NOT NULL AND v_c_last > 0 AND v_c_last <> 'NaN'::numeric THEN
      v_markup_ant := (v_p_last - v_c_last) / v_c_last * 100;
    END IF;

    -- rótulo da data da âncora = MM/AAAA
    v_data_label := CASE WHEN v_data_ancora IS NOT NULL THEN to_char(v_data_ancora,'MM/YYYY') ELSE NULL END;

    v_out := v_out || jsonb_build_array(jsonb_build_object(
      'codigo', v_codigo, 'empresa', v_empresa,
      'status_defasagem', v_status,
      'tem_ancora', v_tem_ancora,
      'p_req', to_jsonb(v_p_req),
      'alta_custo_perc', to_jsonb(v_alta_perc),
      'data_ancora', to_jsonb(v_data_label),
      'motivo', v_motivo,
      'calculated_at', now(),
      -- role-gated (absolutos só p/ pode_ver_carteira_completa):
      'p_last',         CASE WHEN v_pode_num THEN to_jsonb(v_p_last)      ELSE 'null'::jsonb END,
      'c_last',         CASE WHEN v_pode_num THEN to_jsonb(v_c_last)      ELSE 'null'::jsonb END,
      'c_now',          CASE WHEN v_pode_num THEN to_jsonb(v_c_now)       ELSE 'null'::jsonb END,
      'markup_anterior',CASE WHEN v_pode_num THEN to_jsonb(v_markup_ant)  ELSE 'null'::jsonb END
    ));
  END LOOP;

  RETURN v_out;
END;
$defasagem$;

REVOKE ALL ON FUNCTION public.get_defasagem_cliente(jsonb, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_defasagem_cliente(jsonb, uuid) TO authenticated;

-- ── Validação pós-apply ──
SELECT
  (SELECT count(*) FROM pg_proc WHERE proname='get_defasagem_cliente') AS func_1,
  (SELECT count(*) FROM information_schema.role_routine_grants
     WHERE routine_name='get_defasagem_cliente' AND grantee='anon') AS anon_grant_0;
-- esperado: 1, 0
