-- Fase 2a — fixes pós-challenge do Codex (PR fix-forward). Money-path.
-- Achados endereçados:
--  #1 (P1): cmc_ledger era legível por TODO employee → vendedora lia o CMC cru,
--           furando o role-gate. Restringe leitura a pode_ver_carteira_completa.
--  #4 (low): ordenar CMC por synced_at (espelha a RPC de reposição 20260606190000;
--           updated_at também é fresco via trigger update_inventory_updated_at, mas
--           synced_at é o sinal canônico). Frescor do tint deixa de ser now() fabricado
--           → LEAST(synced_at da base, min synced_at dos corantes).
--  #5 (P1): fórmula tint não amarrada à empresa → custo cross-empresa. Liga tf.account = empresa.
--  #7 (P1): preco/cmc NULL ou NaN caíam em 'saudavel' (verde fabricado). NaN é numeric
--           válido no PG e ordena alto. Guarda preco/cmc/piso/meta contra NULL e NaN.
--  #8 (P1): all-or-nothing do tint não validava qtd_ml → item zero/negativo/NaN subestimava.
--  #P2: cap de tamanho do input (anti-abuso de chamada direta).
-- Idempotente. Aplicar via SQL Editor. (O #1 também foi entregue inline p/ apply imediato.)

-- ── #1: gate de leitura do ledger (mesmo gate do número na RPC) ──
DROP POLICY IF EXISTS "cmc_ledger_select_staff"  ON public.cmc_ledger;
DROP POLICY IF EXISTS "cmc_ledger_select_gestor" ON public.cmc_ledger;
CREATE POLICY "cmc_ledger_select_gestor" ON public.cmc_ledger
  FOR SELECT TO authenticated
  USING (pode_ver_carteira_completa(auth.uid()));

-- ── #7: markup_policy não aceita NaN/Infinity (defesa na escrita) ──
ALTER TABLE public.markup_policy DROP CONSTRAINT IF EXISTS markup_policy_finite;
ALTER TABLE public.markup_policy ADD CONSTRAINT markup_policy_finite CHECK (
  piso_markup <> 'NaN'::numeric AND meta_markup <> 'NaN'::numeric
  AND piso_markup < 'Infinity'::numeric AND meta_markup < 'Infinity'::numeric
);

-- ── RPC corrigida ──
CREATE OR REPLACE FUNCTION public.get_preco_cockpit(p_itens jsonb)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $cockpit$
DECLARE
  v_pode_num boolean;
  v_out jsonb := '[]'::jsonb;
  v_item jsonb;
  v_empresa text; v_codigo bigint; v_preco numeric; v_formula uuid;
  v_cmc numeric; v_prov text; v_fresc timestamptz; v_familia text;
  v_piso numeric; v_meta numeric; v_tem_pol boolean;
  v_faixa text; v_motivo text; v_markup numeric; v_folga numeric;
  v_accounts text[];
  v_preco_ok boolean;
  v_cmc_ok boolean;
BEGIN
  IF NOT (auth.uid() IS NOT NULL
    AND (has_role(auth.uid(),'employee'::app_role) OR has_role(auth.uid(),'master'::app_role))) THEN
    RAISE EXCEPTION 'forbidden' USING errcode = '42501';
  END IF;
  -- #P2: cap de input (a UI manda <= ~50; chamada direta não abusa).
  IF jsonb_array_length(p_itens) > 200 THEN
    RAISE EXCEPTION 'too many items (max 200)' USING errcode = '22023';
  END IF;
  v_pode_num := pode_ver_carteira_completa(auth.uid());

  FOR v_item IN SELECT * FROM jsonb_array_elements(p_itens)
  LOOP
    -- reset por item (SELECT INTO sem linhas mantém valor anterior)
    v_cmc := NULL; v_prov := NULL; v_fresc := NULL; v_familia := NULL;
    v_piso := NULL; v_meta := NULL;

    v_empresa := lower(v_item->>'empresa');
    v_codigo  := (v_item->>'codigo')::bigint;
    v_preco   := (v_item->>'preco')::numeric;
    v_formula := NULLIF(v_item->>'tint_formula_id','')::uuid;
    -- #7: preco válido = não-nulo e não-NaN (NaN no PG numeric = NaN é TRUE; testar por igualdade).
    v_preco_ok := v_preco IS NOT NULL AND v_preco <> 'NaN'::numeric;

    v_accounts := CASE v_empresa
            WHEN 'oben'       THEN ARRAY['vendas','oben']
            WHEN 'colacor'    THEN ARRAY['colacor_vendas','colacor']
            WHEN 'colacor_sc' THEN ARRAY['servicos','colacor_sc']
            ELSE ARRAY[v_empresa] END;

    IF v_formula IS NOT NULL THEN
      -- ── TINT: custo por CMC, all-or-nothing, amarrado à empresa ──
      DECLARE
        v_base_cmc numeric;
        v_base_synced timestamptz;
        v_cor_total numeric;
        v_cor_faltando int;
        v_n_itens int;
        v_cor_min_synced timestamptz;
      BEGIN
        -- CMC da base: fórmula (DA EMPRESA) → tint_sku → omie_products → inventory_position.
        SELECT ip.cmc, ip.synced_at INTO v_base_cmc, v_base_synced
        FROM tint_formulas tf
        JOIN tint_skus ts
          ON ts.id = tf.sku_id
          OR (tf.sku_id IS NULL AND ts.account = tf.account
              AND ts.produto_id = tf.produto_id AND ts.base_id = tf.base_id
              AND ts.embalagem_id = tf.embalagem_id)
        JOIN omie_products opb ON opb.id = ts.omie_product_id
        JOIN inventory_position ip ON ip.omie_codigo_produto = opb.omie_codigo_produto
              AND ip.account = ANY(v_accounts)
        WHERE tf.id = v_formula
          AND tf.account = v_empresa            -- #5: fórmula tem que ser DA empresa consultada
          AND ip.cmc > 0 AND ip.cmc <> 'NaN'::numeric
        ORDER BY ip.synced_at DESC NULLS LAST LIMIT 1;

        -- Corantes: Σ(qtd_ml × cmc/volume); conta itens e faltantes (#8: qtd_ml > 0 e finito).
        SELECT
          count(*),
          count(*) FILTER (
            WHERE ipc.cmc IS NULL OR ipc.cmc <= 0 OR ipc.cmc = 'NaN'::numeric
               OR c.volume_total_ml IS NULL OR c.volume_total_ml <= 0
               OR fi.qtd_ml IS NULL OR fi.qtd_ml <= 0 OR fi.qtd_ml = 'NaN'::numeric),
          COALESCE(SUM(fi.qtd_ml * ipc.cmc / NULLIF(c.volume_total_ml,0)), 0),
          min(ipc.synced_at)
        INTO v_n_itens, v_cor_faltando, v_cor_total, v_cor_min_synced
        FROM tint_formula_itens fi
        JOIN tint_corantes c       ON c.id = fi.corante_id
        LEFT JOIN omie_products opc ON opc.id = c.omie_product_id
        LEFT JOIN LATERAL (
          SELECT ip.cmc, ip.synced_at FROM inventory_position ip
          WHERE ip.omie_codigo_produto = opc.omie_codigo_produto AND ip.cmc > 0 AND ip.cmc <> 'NaN'::numeric
            AND ip.account = ANY(v_accounts)
          ORDER BY ip.synced_at DESC NULLS LAST LIMIT 1
        ) ipc ON true
        WHERE fi.formula_id = v_formula;

        -- ALL-OR-NOTHING: base sem CMC, qualquer corante faltando, ou fórmula vazia → nulo.
        IF v_base_cmc IS NULL OR v_base_cmc <= 0 OR v_base_cmc = 'NaN'::numeric
           OR v_n_itens = 0 OR v_cor_faltando > 0 THEN
          v_cmc := NULL; v_prov := 'tint(custo incompleto)'; v_fresc := NULL;
        ELSE
          v_cmc := v_base_cmc + v_cor_total;
          v_prov := 'tint(CMC base+corantes)';
          v_fresc := LEAST(v_base_synced, v_cor_min_synced);  -- #4: frescor honesto (o mais velho)
        END IF;
      END;
    ELSE
      -- ── Não-tint: CMC account-aware (freshest por synced_at, cmc>0) ──
      SELECT ip.cmc, 'inventory_position('||ip.account||')', ip.synced_at
        INTO v_cmc, v_prov, v_fresc
      FROM inventory_position ip
      WHERE ip.omie_codigo_produto = v_codigo
        AND ip.cmc > 0 AND ip.cmc <> 'NaN'::numeric
        AND ip.account = ANY(v_accounts)
      ORDER BY ip.synced_at DESC NULLS LAST
      LIMIT 1;
    END IF;

    -- #7: cmc válido = não-nulo, > 0 e não-NaN.
    v_cmc_ok := v_cmc IS NOT NULL AND v_cmc > 0 AND v_cmc <> 'NaN'::numeric;

    -- Família (p/ resolução da política) — omie_products usa convenção empresa.
    SELECT op.familia INTO v_familia
    FROM omie_products op
    WHERE op.omie_codigo_produto = v_codigo AND op.account = v_empresa
    LIMIT 1;

    -- Política (conta→família→sku); #7: ignora piso/meta NaN.
    SELECT rp.piso_markup, rp.meta_markup INTO v_piso, v_meta
    FROM resolve_markup_policy(v_empresa, v_codigo, v_familia) rp;
    v_tem_pol := v_piso IS NOT NULL AND v_meta IS NOT NULL
                 AND v_piso <> 'NaN'::numeric AND v_meta <> 'NaN'::numeric;

    -- Faixa (espelha classificarFaixa). #7: preco/cmc inválido → neutro, NUNCA verde.
    IF NOT v_cmc_ok OR NOT v_preco_ok THEN
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

    IF v_cmc_ok AND v_preco_ok THEN
      v_markup := (v_preco - v_cmc) / v_cmc * 100;
      v_folga  := v_preco - v_cmc;
    ELSE
      v_markup := NULL; v_folga := NULL;
    END IF;

    v_out := v_out || jsonb_build_array(jsonb_build_object(
      'codigo', v_codigo, 'empresa', v_empresa,
      'faixa', v_faixa, 'motivo', v_motivo,
      'tem_custo', v_cmc_ok,
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
$cockpit$;

REVOKE ALL ON FUNCTION public.get_preco_cockpit(jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_preco_cockpit(jsonb) TO authenticated;

-- ── Validação pós-apply ──
SELECT
  (SELECT count(*) FROM pg_policies WHERE tablename='cmc_ledger' AND policyname='cmc_ledger_select_gestor') AS ledger_gate_1,
  (SELECT count(*) FROM pg_policies WHERE tablename='cmc_ledger') AS ledger_policies_1,
  (SELECT count(*) FROM pg_constraint WHERE conname='markup_policy_finite') AS check_1,
  (SELECT count(*) FROM pg_proc WHERE proname='get_preco_cockpit') AS func_1;
-- esperado: 1, 1, 1, 1
