-- Fase 2a: cockpit de preço por linha. Batch, SECURITY DEFINER, staff-gated,
-- payload role-gated (número só pode_ver_carteira_completa). CMC account-aware
-- (ponte de convenção inventory_position × omie_products). Degradação honesta:
-- ausência → neutro, nunca 0/verde fabricado. Espelha o helper cockpit-preco.ts.
--
-- Tint (tint_formula_id != null): custo por CMC ALL-OR-NOTHING = CMC_base +
-- Σ(qtd_ml × CMC_corante / volume_total_ml). Base OU qualquer corante sem CMC,
-- ou fórmula vazia → custo nulo (neutro). NUNCA soma parcial. NÃO reusa
-- get_tint_price (que usa valor_unitario + soma parcial + custoBase=0).
--
-- Schema confirmado (snapshot): tint_formulas.sku_id (uuid, NULLABLE) → tint_skus;
-- tint_skus.omie_product_id = produto Omie da BASE; tint_corantes.omie_product_id
-- + volume_total_ml. Fallback de base pela chave natural quando sku_id IS NULL.
--
-- ⚠️ RESET por item: plpgsql SELECT INTO mantém o valor anterior quando 0 linhas
-- → CMC/política de um item vazaria pro próximo. Resetar no topo do loop.

CREATE OR REPLACE FUNCTION public.get_preco_cockpit(p_itens jsonb)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_pode_num boolean;
  v_out jsonb := '[]'::jsonb;
  v_item jsonb;
  v_empresa text; v_codigo bigint; v_preco numeric; v_formula uuid;
  v_cmc numeric; v_prov text; v_fresc timestamptz; v_familia text;
  v_piso numeric; v_meta numeric; v_tem_pol boolean;
  v_faixa text; v_motivo text; v_markup numeric; v_folga numeric;
  v_accounts text[];
BEGIN
  IF NOT (auth.uid() IS NOT NULL
    AND (has_role(auth.uid(),'employee'::app_role) OR has_role(auth.uid(),'master'::app_role))) THEN
    RAISE EXCEPTION 'forbidden' USING errcode = '42501';
  END IF;
  v_pode_num := pode_ver_carteira_completa(auth.uid());

  FOR v_item IN SELECT * FROM jsonb_array_elements(p_itens)
  LOOP
    -- reset por item (anti-vazamento de SELECT INTO sem linhas)
    v_cmc := NULL; v_prov := NULL; v_fresc := NULL; v_familia := NULL;
    v_piso := NULL; v_meta := NULL;

    v_empresa := lower(v_item->>'empresa');
    v_codigo  := (v_item->>'codigo')::bigint;
    v_preco   := (v_item->>'preco')::numeric;
    v_formula := NULLIF(v_item->>'tint_formula_id','')::uuid;

    v_accounts := CASE v_empresa
            WHEN 'oben'       THEN ARRAY['vendas','oben']
            WHEN 'colacor'    THEN ARRAY['colacor_vendas','colacor']
            WHEN 'colacor_sc' THEN ARRAY['servicos','colacor_sc']
            ELSE ARRAY[v_empresa] END;

    IF v_formula IS NOT NULL THEN
      -- ── TINT: custo por CMC, all-or-nothing ──
      DECLARE
        v_base_cmc numeric;
        v_cor_total numeric;
        v_cor_faltando int;
        v_n_itens int;
      BEGIN
        -- CMC da base: fórmula → tint_sku (por sku_id, ou chave natural se sku_id NULL)
        -- → omie_products(base) → inventory_position (ponte de conta, freshest cmc>0).
        SELECT ip.cmc INTO v_base_cmc
        FROM tint_formulas tf
        JOIN tint_skus ts
          ON ts.id = tf.sku_id
          OR (tf.sku_id IS NULL AND ts.account = tf.account
              AND ts.produto_id = tf.produto_id AND ts.base_id = tf.base_id
              AND ts.embalagem_id = tf.embalagem_id)
        JOIN omie_products opb ON opb.id = ts.omie_product_id
        JOIN inventory_position ip ON ip.omie_codigo_produto = opb.omie_codigo_produto
              AND ip.account = ANY(v_accounts)
        WHERE tf.id = v_formula AND ip.cmc > 0
        ORDER BY ip.updated_at DESC NULLS LAST LIMIT 1;

        -- Corantes: Σ(qtd_ml × cmc_corante / volume_total_ml); conta itens e faltantes.
        SELECT
          count(*),
          count(*) FILTER (WHERE ipc.cmc IS NULL OR ipc.cmc <= 0 OR c.volume_total_ml IS NULL OR c.volume_total_ml <= 0),
          COALESCE(SUM(fi.qtd_ml * ipc.cmc / NULLIF(c.volume_total_ml,0)), 0)
        INTO v_n_itens, v_cor_faltando, v_cor_total
        FROM tint_formula_itens fi
        JOIN tint_corantes c       ON c.id = fi.corante_id
        LEFT JOIN omie_products opc ON opc.id = c.omie_product_id
        LEFT JOIN LATERAL (
          SELECT ip.cmc FROM inventory_position ip
          WHERE ip.omie_codigo_produto = opc.omie_codigo_produto AND ip.cmc > 0
            AND ip.account = ANY(v_accounts)
          ORDER BY ip.updated_at DESC NULLS LAST LIMIT 1
        ) ipc ON true
        WHERE fi.formula_id = v_formula;

        -- ALL-OR-NOTHING: base sem CMC, qualquer corante faltando, ou fórmula vazia → nulo.
        IF v_base_cmc IS NULL OR v_base_cmc <= 0 OR v_n_itens = 0 OR v_cor_faltando > 0 THEN
          v_cmc := NULL; v_prov := 'tint(custo incompleto)'; v_fresc := NULL;
        ELSE
          v_cmc := v_base_cmc + v_cor_total;
          v_prov := 'tint(CMC base+corantes)'; v_fresc := now();
        END IF;
      END;
    ELSE
      -- ── Não-tint: CMC account-aware (freshest com cmc>0) ──
      SELECT ip.cmc, 'inventory_position('||ip.account||')', ip.updated_at
        INTO v_cmc, v_prov, v_fresc
      FROM inventory_position ip
      WHERE ip.omie_codigo_produto = v_codigo
        AND ip.cmc > 0
        AND ip.account = ANY(v_accounts)
      ORDER BY ip.updated_at DESC NULLS LAST
      LIMIT 1;
    END IF;

    -- Família (p/ resolução da política) — omie_products usa convenção empresa.
    SELECT op.familia INTO v_familia
    FROM omie_products op
    WHERE op.omie_codigo_produto = v_codigo AND op.account = v_empresa
    LIMIT 1;

    -- Política (conta→família→sku)
    SELECT rp.piso_markup, rp.meta_markup INTO v_piso, v_meta
    FROM resolve_markup_policy(v_empresa, v_codigo, v_familia) rp;
    v_tem_pol := v_piso IS NOT NULL AND v_meta IS NOT NULL;

    -- Faixa (espelha classificarFaixa do helper)
    IF v_cmc IS NULL OR NOT (v_cmc > 0) THEN
      v_faixa := 'neutro'; v_motivo := 'sem_custo';
    ELSIF v_preco < v_cmc THEN
      v_faixa := 'vermelho'; v_motivo := 'abaixo_do_custo';
    ELSIF NOT v_tem_pol THEN
      v_faixa := 'neutro'; v_motivo := 'sem_politica';
    ELSIF v_preco < v_cmc * (1 + v_piso/100) THEN
      v_faixa := 'amarelo'; v_motivo := 'abaixo_do_piso';
    ELSIF v_preco < v_cmc * (1 + v_meta/100) THEN
      v_faixa := 'verde'; v_motivo := 'abaixo_da_meta';
    ELSE
      v_faixa := 'verde'; v_motivo := 'saudavel';
    END IF;

    IF v_cmc IS NOT NULL AND v_cmc > 0 THEN
      v_markup := (v_preco - v_cmc) / v_cmc * 100;
      v_folga  := v_preco - v_cmc;
    ELSE
      v_markup := NULL; v_folga := NULL;
    END IF;

    v_out := v_out || jsonb_build_array(jsonb_build_object(
      'codigo', v_codigo, 'empresa', v_empresa,
      'faixa', v_faixa, 'motivo', v_motivo,
      'tem_custo', (v_cmc IS NOT NULL AND v_cmc > 0),
      'tem_politica', v_tem_pol,
      'calculated_at', now(),
      -- role-gated (número só pra quem pode_ver_carteira_completa):
      'cmc',          CASE WHEN v_pode_num THEN to_jsonb(v_cmc)    ELSE 'null'::jsonb END,
      'markup_perc',  CASE WHEN v_pode_num THEN to_jsonb(v_markup) ELSE 'null'::jsonb END,
      'folga_reais',  CASE WHEN v_pode_num THEN to_jsonb(v_folga)  ELSE 'null'::jsonb END,
      'piso_markup',  CASE WHEN v_pode_num THEN to_jsonb(v_piso)   ELSE 'null'::jsonb END,
      'meta_markup',  CASE WHEN v_pode_num THEN to_jsonb(v_meta)   ELSE 'null'::jsonb END,
      'proveniencia', CASE WHEN v_pode_num THEN to_jsonb(v_prov)   ELSE 'null'::jsonb END,
      'frescor',      CASE WHEN v_pode_num THEN to_jsonb(v_fresc)  ELSE 'null'::jsonb END
    ));
  END LOOP;

  RETURN v_out;
END;
$$;

REVOKE ALL ON FUNCTION public.get_preco_cockpit(jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_preco_cockpit(jsonb) TO authenticated;

-- ── Validação pós-apply ──
SELECT (SELECT count(*) FROM pg_proc WHERE proname='get_preco_cockpit') AS func_1; -- esperado: 1
