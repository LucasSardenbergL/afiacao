
CREATE OR REPLACE FUNCTION public.import_tint_formulas(p_account text, p_personalizada boolean, p_rows jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  r jsonb;
  v_imported int := 0;
  v_updated int := 0;
  v_errors int := 0;
  v_produto_id uuid;
  v_base_id uuid;
  v_emb_id uuid;
  v_sub_id uuid;
  v_sku_id uuid;
  v_formula_id uuid;
  v_corante_id uuid;
  v_existing_formula_id uuid;
  v_cor_key text;
  v_i int;
BEGIN
  FOR r IN SELECT * FROM jsonb_array_elements(p_rows)
  LOOP
    BEGIN
      -- Upsert produto
      INSERT INTO public.tint_produtos (account, cod_produto, descricao)
      VALUES (p_account, r->>'cod_produto', COALESCE(r->>'produto', r->>'cod_produto'))
      ON CONFLICT (account, cod_produto) DO NOTHING
      RETURNING id INTO v_produto_id;
      IF v_produto_id IS NULL THEN
        SELECT id INTO v_produto_id FROM public.tint_produtos WHERE account = p_account AND cod_produto = r->>'cod_produto';
      END IF;

      -- Upsert base
      INSERT INTO public.tint_bases (account, id_base_sayersystem, descricao)
      VALUES (p_account, r->>'id_base', COALESCE(r->>'base', r->>'id_base'))
      ON CONFLICT (account, id_base_sayersystem) DO NOTHING
      RETURNING id INTO v_base_id;
      IF v_base_id IS NULL THEN
        SELECT id INTO v_base_id FROM public.tint_bases WHERE account = p_account AND id_base_sayersystem = r->>'id_base';
      END IF;

      -- Upsert embalagem
      INSERT INTO public.tint_embalagens (account, id_embalagem_sayersystem, descricao, volume_ml)
      VALUES (p_account, r->>'id_embalagem', r->>'embalagem', COALESCE((r->>'embalagem_ml')::numeric, 0))
      ON CONFLICT (account, id_embalagem_sayersystem) DO UPDATE SET volume_ml = EXCLUDED.volume_ml
      RETURNING id INTO v_emb_id;
      IF v_emb_id IS NULL THEN
        SELECT id INTO v_emb_id FROM public.tint_embalagens WHERE account = p_account AND id_embalagem_sayersystem = r->>'id_embalagem';
      END IF;

      -- Upsert subcoleção (se existir)
      v_sub_id := NULL;
      IF r->>'subcolecao' IS NOT NULL AND r->>'subcolecao' != '' THEN
        INSERT INTO public.tint_subcolecoes (account, id_subcolecao_sayersystem, descricao)
        VALUES (p_account, r->>'subcolecao', COALESCE(r->>'sub_colecao', r->>'subcolecao'))
        ON CONFLICT (account, id_subcolecao_sayersystem) DO NOTHING
        RETURNING id INTO v_sub_id;
        IF v_sub_id IS NULL THEN
          SELECT id INTO v_sub_id FROM public.tint_subcolecoes WHERE account = p_account AND id_subcolecao_sayersystem = r->>'subcolecao';
        END IF;
      END IF;

      -- Upsert SKU
      INSERT INTO public.tint_skus (account, produto_id, base_id, embalagem_id)
      VALUES (p_account, v_produto_id, v_base_id, v_emb_id)
      ON CONFLICT (account, produto_id, base_id, embalagem_id) DO NOTHING
      RETURNING id INTO v_sku_id;
      IF v_sku_id IS NULL THEN
        SELECT id INTO v_sku_id FROM public.tint_skus WHERE account = p_account AND produto_id = v_produto_id AND base_id = v_base_id AND embalagem_id = v_emb_id;
      END IF;

      -- Check if formula exists
      SELECT id INTO v_existing_formula_id FROM public.tint_formulas
      WHERE account = p_account
        AND cor_id = r->>'cor_id'
        AND produto_id = v_produto_id
        AND base_id = v_base_id
        AND COALESCE(subcolecao_id, '00000000-0000-0000-0000-000000000000'::uuid) = COALESCE(v_sub_id, '00000000-0000-0000-0000-000000000000'::uuid)
        AND embalagem_id = v_emb_id;

      IF v_existing_formula_id IS NOT NULL THEN
        UPDATE public.tint_formulas SET
          id_seq = COALESCE((r->>'id_seq')::int, id_seq),
          nome_cor = COALESCE(r->>'nome_cor', nome_cor),
          sku_id = v_sku_id,
          volume_final_ml = COALESCE((r->>'volume_finalml')::numeric, volume_final_ml),
          preco_final_sayersystem = COALESCE((r->>'preco_final')::numeric, preco_final_sayersystem),
          data_geracao = CASE WHEN r->>'data_geracao' IS NOT NULL AND r->>'data_geracao' != '' THEN (r->>'data_geracao')::timestamptz ELSE data_geracao END,
          updated_at = now()
        WHERE id = v_existing_formula_id;
        v_formula_id := v_existing_formula_id;
        v_updated := v_updated + 1;
      ELSE
        INSERT INTO public.tint_formulas (account, id_seq, cor_id, nome_cor, produto_id, base_id, embalagem_id, subcolecao_id, sku_id, volume_final_ml, preco_final_sayersystem, data_geracao, personalizada)
        VALUES (
          p_account,
          (r->>'id_seq')::int,
          r->>'cor_id',
          r->>'nome_cor',
          v_produto_id,
          v_base_id,
          v_emb_id,
          v_sub_id,
          v_sku_id,
          (r->>'volume_finalml')::numeric,
          (r->>'preco_final')::numeric,
          CASE WHEN r->>'data_geracao' IS NOT NULL AND r->>'data_geracao' != '' THEN (r->>'data_geracao')::timestamptz ELSE now() END,
          p_personalizada
        )
        RETURNING id INTO v_formula_id;
        v_imported := v_imported + 1;
      END IF;

      -- Delete old items and re-insert
      DELETE FROM public.tint_formula_itens WHERE formula_id = v_formula_id;

      -- FIX: use r->>('corante' || v_i::text) for the check, not r->>'corante' || v_i::text
      FOR v_i IN 1..6 LOOP
        v_cor_key := r->>('corante' || v_i::text);
        IF v_cor_key IS NOT NULL AND v_cor_key != '' THEN
          SELECT id INTO v_corante_id FROM public.tint_corantes
          WHERE account = p_account AND id_corante_sayersystem = v_cor_key;
          IF v_corante_id IS NOT NULL AND COALESCE((r->>('qtd' || v_i::text || 'ml'))::numeric, 0) > 0 THEN
            INSERT INTO public.tint_formula_itens (formula_id, corante_id, ordem, qtd_ml)
            VALUES (v_formula_id, v_corante_id, v_i, (r->>('qtd' || v_i::text || 'ml'))::numeric)
            ON CONFLICT (formula_id, corante_id) DO UPDATE SET qtd_ml = EXCLUDED.qtd_ml, ordem = EXCLUDED.ordem;
          END IF;
        END IF;
      END LOOP;

    EXCEPTION WHEN OTHERS THEN
      v_errors := v_errors + 1;
      RAISE NOTICE 'Error processing row: %', SQLERRM;
    END;
  END LOOP;

  RETURN jsonb_build_object('imported', v_imported, 'updated', v_updated, 'errors', v_errors);
END;
$function$;
