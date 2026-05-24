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
  IF auth.uid() IS NULL OR NOT (public.has_role(auth.uid(), 'employee'::app_role) OR public.has_role(auth.uid(), 'master'::app_role)) THEN
    RAISE EXCEPTION 'Acesso negado: requer perfil staff' USING ERRCODE = '42501';
  END IF;
  FOR r IN SELECT * FROM jsonb_array_elements(p_rows)
  LOOP
    BEGIN
      INSERT INTO public.tint_produtos (account, cod_produto, descricao)
      VALUES (p_account, r->>'cod_produto', COALESCE(r->>'produto', r->>'cod_produto'))
      ON CONFLICT (account, cod_produto) DO NOTHING
      RETURNING id INTO v_produto_id;
      IF v_produto_id IS NULL THEN
        SELECT id INTO v_produto_id FROM public.tint_produtos WHERE account = p_account AND cod_produto = r->>'cod_produto';
      END IF;

      INSERT INTO public.tint_bases (account, id_base_sayersystem, descricao)
      VALUES (p_account, r->>'id_base', COALESCE(r->>'base', r->>'id_base'))
      ON CONFLICT (account, id_base_sayersystem) DO NOTHING
      RETURNING id INTO v_base_id;
      IF v_base_id IS NULL THEN
        SELECT id INTO v_base_id FROM public.tint_bases WHERE account = p_account AND id_base_sayersystem = r->>'id_base';
      END IF;

      INSERT INTO public.tint_embalagens (account, id_embalagem_sayersystem, descricao, volume_ml)
      VALUES (p_account, r->>'id_embalagem', r->>'embalagem', COALESCE((r->>'embalagem_ml')::numeric, 0))
      ON CONFLICT (account, id_embalagem_sayersystem) DO UPDATE SET volume_ml = EXCLUDED.volume_ml
      RETURNING id INTO v_emb_id;
      IF v_emb_id IS NULL THEN
        SELECT id INTO v_emb_id FROM public.tint_embalagens WHERE account = p_account AND id_embalagem_sayersystem = r->>'id_embalagem';
      END IF;

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

      INSERT INTO public.tint_skus (account, produto_id, base_id, embalagem_id)
      VALUES (p_account, v_produto_id, v_base_id, v_emb_id)
      ON CONFLICT (account, produto_id, base_id, embalagem_id) DO NOTHING
      RETURNING id INTO v_sku_id;
      IF v_sku_id IS NULL THEN
        SELECT id INTO v_sku_id FROM public.tint_skus WHERE account = p_account AND produto_id = v_produto_id AND base_id = v_base_id AND embalagem_id = v_emb_id;
      END IF;

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
          p_account, (r->>'id_seq')::int, r->>'cor_id', r->>'nome_cor',
          v_produto_id, v_base_id, v_emb_id, v_sub_id, v_sku_id,
          (r->>'volume_finalml')::numeric, (r->>'preco_final')::numeric,
          CASE WHEN r->>'data_geracao' IS NOT NULL AND r->>'data_geracao' != '' THEN (r->>'data_geracao')::timestamptz ELSE now() END,
          p_personalizada
        )
        RETURNING id INTO v_formula_id;
        v_imported := v_imported + 1;
      END IF;

      DELETE FROM public.tint_formula_itens WHERE formula_id = v_formula_id;

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

CREATE OR REPLACE FUNCTION public.tint_run_reconciliation(p_sync_run_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_run record;
  v_recon_id uuid;
  v_matches int := 0;
  v_divergences int := 0;
  v_only_csv int := 0;
  v_only_sync int := 0;
  v_total int := 0;
  r record;
BEGIN
  IF auth.uid() IS NULL OR NOT (public.has_role(auth.uid(), 'employee'::app_role) OR public.has_role(auth.uid(), 'master'::app_role)) THEN
    RAISE EXCEPTION 'Acesso negado: requer perfil staff' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO v_run FROM tint_sync_runs WHERE id = p_sync_run_id;
  IF v_run IS NULL THEN
    RETURN jsonb_build_object('error', 'Sync run not found');
  END IF;

  INSERT INTO tint_reconciliation_runs (account, store_code, sync_run_id, status)
  VALUES (v_run.account, v_run.store_code, p_sync_run_id, 'running')
  RETURNING id INTO v_recon_id;

  FOR r IN
    SELECT sf.id, sf.cor_id, sf.nome_cor, sf.cod_produto, sf.id_base, sf.id_embalagem,
           sf.volume_final_ml AS stg_vol, sf.preco_final AS stg_preco,
           tf.id AS official_id, tf.volume_final_ml AS off_vol, tf.preco_final_sayersystem AS off_preco,
           tf.nome_cor AS off_nome
    FROM tint_staging_formulas sf
    LEFT JOIN tint_formulas tf ON tf.account = sf.account AND tf.cor_id = sf.cor_id
      AND tf.produto_id = (SELECT tp.id FROM tint_produtos tp WHERE tp.account = sf.account AND tp.cod_produto = sf.cod_produto LIMIT 1)
      AND tf.base_id = (SELECT tb.id FROM tint_bases tb WHERE tb.account = sf.account AND tb.id_base_sayersystem = sf.id_base LIMIT 1)
      AND tf.embalagem_id = (SELECT te.id FROM tint_embalagens te WHERE te.account = sf.account AND te.id_embalagem_sayersystem = sf.id_embalagem LIMIT 1)
    WHERE sf.sync_run_id = p_sync_run_id
  LOOP
    v_total := v_total + 1;
    IF r.official_id IS NULL THEN
      v_only_sync := v_only_sync + 1;
      INSERT INTO tint_reconciliation_items (reconciliation_run_id, entity_type, entity_key, sync_value, diff_type)
      VALUES (v_recon_id, 'formula', r.cor_id || '|' || COALESCE(r.cod_produto,'') || '|' || COALESCE(r.id_base,'') || '|' || COALESCE(r.id_embalagem,''),
              jsonb_build_object('cor_id', r.cor_id, 'nome_cor', r.nome_cor, 'volume', r.stg_vol, 'preco', r.stg_preco),
              'only_sync');
    ELSE
      DECLARE
        v_diffs text[] := ARRAY[]::text[];
      BEGIN
        IF COALESCE(r.stg_vol,0) != COALESCE(r.off_vol,0) THEN v_diffs := array_append(v_diffs, 'volume_final_ml'); END IF;
        IF COALESCE(r.stg_preco,0) != COALESCE(r.off_preco,0) THEN v_diffs := array_append(v_diffs, 'preco_final'); END IF;
        IF COALESCE(r.nome_cor,'') != COALESCE(r.off_nome,'') THEN v_diffs := array_append(v_diffs, 'nome_cor'); END IF;

        IF array_length(v_diffs, 1) IS NULL OR array_length(v_diffs, 1) = 0 THEN
          v_matches := v_matches + 1;
          INSERT INTO tint_reconciliation_items (reconciliation_run_id, entity_type, entity_key, diff_type)
          VALUES (v_recon_id, 'formula', r.cor_id || '|' || COALESCE(r.cod_produto,''), 'match');
        ELSE
          v_divergences := v_divergences + 1;
          INSERT INTO tint_reconciliation_items (reconciliation_run_id, entity_type, entity_key,
            csv_value, sync_value, diff_type, diff_fields, diff_details)
          VALUES (v_recon_id, 'formula', r.cor_id || '|' || COALESCE(r.cod_produto,''),
            jsonb_build_object('volume', r.off_vol, 'preco', r.off_preco, 'nome_cor', r.off_nome),
            jsonb_build_object('volume', r.stg_vol, 'preco', r.stg_preco, 'nome_cor', r.nome_cor),
            'divergence', v_diffs,
            jsonb_build_object('fields', v_diffs));
        END IF;
      END;
    END IF;

    UPDATE tint_staging_formulas SET staging_status = 
      CASE WHEN r.official_id IS NULL THEN 'only_sync'
           WHEN (SELECT count(*) FROM tint_reconciliation_items WHERE reconciliation_run_id = v_recon_id AND entity_key = r.cor_id || '|' || COALESCE(r.cod_produto,'') AND diff_type = 'match') > 0 THEN 'matched'
           ELSE 'divergent' END
    WHERE id = r.id;
  END LOOP;

  FOR r IN
    SELECT sc.id, sc.id_corante_sayersystem, sc.descricao AS stg_desc, sc.preco_litro AS stg_preco,
           tc.id AS official_id, tc.descricao AS off_desc, tc.preco_litro AS off_preco
    FROM tint_staging_corantes sc
    LEFT JOIN tint_corantes tc ON tc.account = sc.account AND tc.id_corante_sayersystem = sc.id_corante_sayersystem
    WHERE sc.sync_run_id = p_sync_run_id
  LOOP
    v_total := v_total + 1;
    IF r.official_id IS NULL THEN
      v_only_sync := v_only_sync + 1;
      INSERT INTO tint_reconciliation_items (reconciliation_run_id, entity_type, entity_key, sync_value, diff_type)
      VALUES (v_recon_id, 'corante', r.id_corante_sayersystem,
              jsonb_build_object('descricao', r.stg_desc, 'preco_litro', r.stg_preco), 'only_sync');
    ELSE
      DECLARE v_diffs2 text[] := ARRAY[]::text[];
      BEGIN
        IF COALESCE(r.stg_preco,0) != COALESCE(r.off_preco,0) THEN v_diffs2 := array_append(v_diffs2, 'preco_litro'); END IF;
        IF COALESCE(r.stg_desc,'') != COALESCE(r.off_desc,'') THEN v_diffs2 := array_append(v_diffs2, 'descricao'); END IF;
        IF array_length(v_diffs2, 1) IS NULL OR array_length(v_diffs2, 1) = 0 THEN
          v_matches := v_matches + 1;
          INSERT INTO tint_reconciliation_items (reconciliation_run_id, entity_type, entity_key, diff_type)
          VALUES (v_recon_id, 'corante', r.id_corante_sayersystem, 'match');
        ELSE
          v_divergences := v_divergences + 1;
          INSERT INTO tint_reconciliation_items (reconciliation_run_id, entity_type, entity_key,
            csv_value, sync_value, diff_type, diff_fields)
          VALUES (v_recon_id, 'corante', r.id_corante_sayersystem,
            jsonb_build_object('descricao', r.off_desc, 'preco_litro', r.off_preco),
            jsonb_build_object('descricao', r.stg_desc, 'preco_litro', r.stg_preco),
            'divergence', v_diffs2);
        END IF;
      END;
    END IF;
  END LOOP;

  UPDATE tint_reconciliation_runs SET
    status = 'complete', completed_at = now(),
    total_compared = v_total, matches = v_matches, divergences = v_divergences,
    only_csv = v_only_csv, only_sync = v_only_sync
  WHERE id = v_recon_id;

  RETURN jsonb_build_object(
    'reconciliation_run_id', v_recon_id,
    'total', v_total, 'matches', v_matches,
    'divergences', v_divergences, 'only_csv', v_only_csv, 'only_sync', v_only_sync
  );
END;
$function$;

CREATE OR REPLACE FUNCTION public.estimar_impacto_exclusao_outlier(p_evento_id bigint)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_evento RECORD;
  v_sigma_atual numeric;
  v_media_atual numeric;
  v_sigma_sem numeric;
  v_media_sem numeric;
  v_d numeric;
  v_lt numeric;
  v_z numeric := 1.65;
  v_em_atual numeric;
  v_em_sem numeric;
BEGIN
  IF auth.uid() IS NULL OR NOT (public.has_role(auth.uid(), 'employee'::app_role) OR public.has_role(auth.uid(), 'master'::app_role)) THEN
    RAISE EXCEPTION 'Acesso negado: requer perfil staff' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO v_evento FROM eventos_outlier WHERE id = p_evento_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('error', 'Evento não encontrado');
  END IF;

  IF v_evento.tipo = 'venda_atipica' THEN
    SELECT AVG(quantidade), STDDEV_SAMP(quantidade) INTO v_media_atual, v_sigma_atual
    FROM venda_items_history
    WHERE empresa::text = v_evento.empresa AND sku_codigo_omie::text = v_evento.sku_codigo_omie
      AND data_emissao >= CURRENT_DATE - INTERVAL '180 days' AND quantidade > 0;
    SELECT AVG(quantidade), STDDEV_SAMP(quantidade) INTO v_media_sem, v_sigma_sem
    FROM venda_items_history
    WHERE empresa::text = v_evento.empresa AND sku_codigo_omie::text = v_evento.sku_codigo_omie
      AND data_emissao >= CURRENT_DATE - INTERVAL '180 days' AND quantidade > 0
      AND NOT (data_emissao::date = v_evento.data_evento AND nfe_chave_acesso::text = COALESCE(v_evento.detalhes->>'nfe', ''));
    SELECT demanda_media_diaria, lt_medio_dias_uteis INTO v_d, v_lt
    FROM sku_parametros WHERE empresa = v_evento.empresa AND sku_codigo_omie::text = v_evento.sku_codigo_omie LIMIT 1;
    v_d := COALESCE(v_d, v_media_atual);
    v_lt := COALESCE(v_lt, 10);
    v_em_atual := CEIL(v_z * COALESCE(v_sigma_atual, 0) * SQRT(v_lt));
    v_em_sem := CEIL(v_z * COALESCE(v_sigma_sem, 0) * SQRT(v_lt));
    RETURN jsonb_build_object(
      'tipo', 'venda_atipica',
      'sigma_atual', ROUND(COALESCE(v_sigma_atual, 0), 2),
      'sigma_sem', ROUND(COALESCE(v_sigma_sem, 0), 2),
      'media_atual', ROUND(COALESCE(v_media_atual, 0), 2),
      'media_sem', ROUND(COALESCE(v_media_sem, 0), 2),
      'em_atual', v_em_atual, 'em_sem', v_em_sem,
      'delta_em', v_em_sem - v_em_atual, 'd', v_d, 'lt', v_lt
    );
  ELSE
    SELECT AVG(lt_bruto_dias_uteis), STDDEV_SAMP(lt_bruto_dias_uteis) INTO v_media_atual, v_sigma_atual
    FROM sku_leadtime_history WHERE empresa::text = v_evento.empresa AND sku_codigo_omie::text = v_evento.sku_codigo_omie;
    SELECT AVG(lt_bruto_dias_uteis), STDDEV_SAMP(lt_bruto_dias_uteis) INTO v_media_sem, v_sigma_sem
    FROM sku_leadtime_history WHERE empresa::text = v_evento.empresa AND sku_codigo_omie::text = v_evento.sku_codigo_omie
      AND NOT (data_pedido::date = v_evento.data_evento);
    RETURN jsonb_build_object(
      'tipo', 'lt_atipico',
      'sigma_atual', ROUND(COALESCE(v_sigma_atual, 0), 2),
      'sigma_sem', ROUND(COALESCE(v_sigma_sem, 0), 2),
      'media_atual', ROUND(COALESCE(v_media_atual, 0), 2),
      'media_sem', ROUND(COALESCE(v_media_sem, 0), 2)
    );
  END IF;
END;
$function$;

CREATE OR REPLACE FUNCTION public.resolver_outlier(p_evento_id bigint, p_decisao text, p_justificativa text DEFAULT NULL::text, p_usuario_email text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_evento RECORD;
  v_novo_status text;
BEGIN
  IF auth.uid() IS NULL OR NOT (public.has_role(auth.uid(), 'employee'::app_role) OR public.has_role(auth.uid(), 'master'::app_role)) THEN
    RAISE EXCEPTION 'Acesso negado: requer perfil staff' USING ERRCODE = '42501';
  END IF;
  IF p_decisao NOT IN ('aceitar', 'excluir', 'ignorar') THEN
    RAISE EXCEPTION 'Decisão inválida: %. Use aceitar/excluir/ignorar', p_decisao;
  END IF;
  SELECT * INTO v_evento FROM eventos_outlier WHERE id = p_evento_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Evento outlier % não encontrado', p_evento_id;
  END IF;
  IF v_evento.status != 'pendente' THEN
    RAISE EXCEPTION 'Evento já resolvido com status: %', v_evento.status;
  END IF;
  v_novo_status := CASE p_decisao
    WHEN 'aceitar' THEN 'aceito'
    WHEN 'excluir' THEN 'excluido'
    WHEN 'ignorar' THEN 'ignorado'
  END;
  UPDATE eventos_outlier
  SET status = v_novo_status, decidido_em = now(),
      decidido_por = p_usuario_email, justificativa_decisao = p_justificativa
  WHERE id = p_evento_id;
  IF p_decisao = 'excluir' THEN
    INSERT INTO observacoes_excluidas (
      empresa, sku_codigo_omie, tipo_observacao, data_observacao,
      referencia_original, valor_excluido, excluido_por,
      evento_outlier_id, justificativa
    ) VALUES (
      v_evento.empresa, v_evento.sku_codigo_omie,
      CASE WHEN v_evento.tipo = 'venda_atipica' THEN 'venda' ELSE 'leadtime' END,
      v_evento.data_evento,
      COALESCE(v_evento.detalhes->>'nfe', v_evento.detalhes->>'pedido_compra', v_evento.id::text),
      v_evento.valor_observado, p_usuario_email, v_evento.id, p_justificativa
    )
    ON CONFLICT (empresa, sku_codigo_omie, tipo_observacao, data_observacao, referencia_original)
    DO UPDATE SET
      valor_excluido = EXCLUDED.valor_excluido,
      excluido_por = EXCLUDED.excluido_por,
      justificativa = EXCLUDED.justificativa,
      excluido_em = now();
  END IF;
  RETURN jsonb_build_object('evento_id', p_evento_id, 'novo_status', v_novo_status, 'decisao', p_decisao);
END;
$function$;

CREATE OR REPLACE FUNCTION public.sugerir_negociacao_paralela_hoje(p_empresa text DEFAULT 'OBEN'::text, p_limite integer DEFAULT 10)
 RETURNS TABLE(out_sugestao_id bigint, out_sku_codigo_omie text, out_sku_descricao text, out_motivo text, out_score_final numeric, out_volume_financeiro_12m numeric, out_preco_medio_unitario numeric, out_categoria text, out_motivo_legivel text)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_dia_mes int;
  v_eh_fim_mes boolean;
BEGIN
  IF auth.uid() IS NULL OR NOT (public.has_role(auth.uid(), 'employee'::app_role) OR public.has_role(auth.uid(), 'master'::app_role)) THEN
    RAISE EXCEPTION 'Acesso negado: requer perfil staff' USING ERRCODE = '42501';
  END IF;
  v_dia_mes := EXTRACT(DAY FROM CURRENT_DATE)::int;
  v_eh_fim_mes := v_dia_mes >= 20;
  UPDATE sugestao_negociacao_paralela
  SET status = 'ignorada'
  WHERE empresa = p_empresa AND status IN ('nova', 'visualizada') AND valido_ate < CURRENT_DATE;
  RETURN QUERY
  WITH candidatos AS (
    SELECT 
      r.sku_codigo_omie AS sku_cod, r.sku_descricao AS sku_desc,
      r.score_final AS score_val, r.volume_financeiro_12m AS vol_12m,
      r.preco_medio_unitario AS preco_med, r.promocoes_12m AS promo_12m,
      r.perc_meses_com_promo AS perc_promo, r.categoria AS cat,
      CASE 
        WHEN r.categoria IN ('prioritario', 'forte') AND r.perc_meses_com_promo < 30 AND v_eh_fim_mes
          THEN 'combinacao_heuristica'
        WHEN r.categoria IN ('prioritario', 'forte') AND r.perc_meses_com_promo < 30 
          THEN 'candidato_forte_sem_promo_recente'
        WHEN v_eh_fim_mes AND r.categoria IN ('prioritario', 'forte', 'moderado')
          THEN 'consumo_abaixo_tipico_fim_de_mes'
        ELSE 'score_alto_ciclo_semanal'
      END AS motivo_comp
    FROM mv_sku_ranking_negociacao_paralela r
    WHERE r.empresa = p_empresa
      AND r.categoria IN ('prioritario', 'forte', 'moderado')
      AND NOT EXISTS (
        SELECT 1 FROM promocao_item pi
        JOIN promocao_campanha pc ON pc.id = pi.campanha_id
        WHERE pc.empresa = r.empresa
          AND pc.tipo_origem = 'desconto_flat_condicional'
          AND pc.estado IN ('ativa', 'negociando')
          AND pi.sku_codigo_omie::text = r.sku_codigo_omie AND pi.ativo = true
      )
      AND NOT EXISTS (
        SELECT 1 FROM sugestao_negociacao_paralela sng
        WHERE sng.empresa = r.empresa AND sng.sku_codigo_omie = r.sku_codigo_omie
          AND sng.status IN ('nova', 'visualizada', 'acao_tomada')
          AND sng.valido_ate >= CURRENT_DATE
      )
    ORDER BY r.score_final DESC LIMIT p_limite
  ),
  inserted AS (
    INSERT INTO sugestao_negociacao_paralela (
      empresa, sku_codigo_omie, sku_descricao, motivo, motivo_detalhes, 
      score_final, volume_financeiro_12m, preco_medio_unitario,
      promocoes_12m, perc_meses_com_promo, valido_ate
    )
    SELECT 
      p_empresa, c.sku_cod, c.sku_desc, c.motivo_comp,
      jsonb_build_object('dia_mes', v_dia_mes, 'eh_fim_mes', v_eh_fim_mes,
        'categoria_ranking', c.cat, 'heuristica_disparou', c.motivo_comp),
      c.score_val, c.vol_12m, c.preco_med, c.promo_12m, c.perc_promo,
      CURRENT_DATE + interval '14 days'
    FROM candidatos c
    RETURNING id, sku_codigo_omie, sku_descricao, motivo, score_final, 
              volume_financeiro_12m, preco_medio_unitario
  )
  SELECT 
    ins.id, ins.sku_codigo_omie, ins.sku_descricao, ins.motivo, ins.score_final,
    ins.volume_financeiro_12m, ins.preco_medio_unitario, c.cat,
    CASE ins.motivo
      WHEN 'combinacao_heuristica' 
        THEN format('Candidato %s (score %s) sem promoção nos últimos %s%% dos meses, estamos em fim de mês (dia %s). Momento ótimo para negociar.',
          c.cat, ins.score_final, ROUND(c.perc_promo, 0), v_dia_mes)
      WHEN 'candidato_forte_sem_promo_recente' 
        THEN format('Candidato %s (score %s) que raramente entra em promoção (%s%% dos últimos 12 meses). Provavelmente aceita desconto paralelo.',
          c.cat, ins.score_final, ROUND(c.perc_promo, 0))
      WHEN 'consumo_abaixo_tipico_fim_de_mes' 
        THEN format('Dia %s. SKU categoria %s, consumo recorrente, vale completar volume do mês negociando desconto condicional.',
          v_dia_mes, c.cat)
      ELSE format('Top candidato do ranking (score %s, categoria %s). Vale avaliar para negociação.',
        ins.score_final, c.cat)
    END
  FROM inserted ins
  JOIN candidatos c ON c.sku_cod = ins.sku_codigo_omie;
END;
$function$;