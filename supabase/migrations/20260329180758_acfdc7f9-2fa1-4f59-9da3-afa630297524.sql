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
$function$