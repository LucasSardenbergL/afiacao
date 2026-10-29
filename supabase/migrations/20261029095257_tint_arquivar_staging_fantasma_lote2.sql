-- ═════════════════════════════════════════════════════════════════════════════════════════════════
-- Tintométrico — LOTE 2: arquiva e remove do staging as 7 cores-fantasma que o lote 1 não pegou
--
-- DECISÃO DO FOUNDER (2026-10-29): fechar a classe, SEM perder histórico. Mesmo molde de
-- 20261026214721_tint_arquivar_staging_fantasma.sql (lote 1, imutável); troca só ids, cores e motivo.
-- Depende de 20261026214720_tint_receita_versoes.sql (a tabela que guarda a cópia).
--
-- POR QUE UM LOTE 2: o recorte do lote 1 veio da janela de 24h do card "Fórmulas rejeitadas pela
-- fonte", não da CLASSE. Medida no staging (psql-ro, 2026-10-29: latest da chave com item de corante
-- '0' e dose 0 × último snapshot de chaves completo e aplicado, 667a154c… de 28/10 10:00), a classe
-- tinha exatamente estas 7 chaves: todas do conector 0.2.0 (jul-set/2026), conta oben, personalizadas,
-- 1 linha de staging e 6 itens cada, AUSENTES da fonte e anteriores ao snapshot. Controle positivo:
-- ESTOJO DE COURO (viva) presente no mesmo snapshot. Depois deste lote a classe fica com 0 chaves.
--
-- O QUE FAZ / NÃO FAZ, GUARDA e re-aplicação: idênticos ao lote 1 — cópia INTEIRA (to_jsonb com
-- raw_data + itens inteiros) em tint_receita_versoes como 'staging_arquivado', depois DELETE (itens
-- por CASCADE); tint_formulas e tint_sync_errors intocados; a guarda re-prova latest/lista/ausência
-- da fonte/anterioridade na hora, serializa pela trava do tick e aborta tudo se algo mudou.
-- Prova executada: db/test-tint-receita-versoes.sh (PG17).
-- ═════════════════════════════════════════════════════════════════════════════════════════════════

DO $arquivar$
DECLARE
  c_ids constant uuid[] := ARRAY[
    '71770a2f-7e45-406a-a329-b39080f41402',  -- 4602104
    '77439be5-8fec-40b9-81c9-a411bfbe64dc',  -- 885J COLA
    '00f2bf42-fb87-410d-a3ef-a44830206056',  -- CINZA LENADRO MICRO METALIZADA
    '31eeb240-cfd2-4b2d-9300-72bc374fa3ab',  -- KL (com espaço no fim)
    '4eacc77b-33d4-449d-845d-06a6e085c24d',  -- KL PALHA
    'bdf481d6-7d5b-4627-a076-b99c477b7c82',  -- MARILIES PALHA
    '79cce452-75f1-4382-97bb-a4dffd973256'   -- OVELHA MATHEUS
  ]::uuid[];
  c_cores constant text[] := ARRAY['4602104', '885J COLA', 'CINZA LENADRO MICRO METALIZADA', 'KL ',
                                   'KL PALHA', 'MARILIES PALHA', 'OVELHA MATHEUS'];
  c_motivo constant text :=
    'fantasma da fonte, lote 2: latest do conector 0.2.0 com slot livre gravado como corante 0, ausente do ultimo snapshot de chaves completo e aplicado (fecha a classe; decisao do founder 2026-10-29)';
  v_snap_id   uuid;
  v_snap_rec  timestamptz;
  v_ruim      text;
  v_presentes int;
BEGIN
  IF to_regclass('public.tint_receita_versoes') IS NULL THEN
    RAISE EXCEPTION 'arquivar-fantasma-lote2 ABORTADA: tint_receita_versoes não existe — aplique 20261026214720 antes';
  END IF;
  IF NOT pg_try_advisory_xact_lock(hashtext('tint_promocao_tick')) THEN
    RAISE EXCEPTION 'arquivar-fantasma-lote2 ABORTADA: promoção em curso (trava do tick ocupada) — re-rode em 1 minuto';
  END IF;

  SELECT count(*) INTO v_presentes FROM tint_staging_formulas WHERE id = ANY (c_ids);

  IF v_presentes > 0 THEN
    SELECT k.snapshot_id, max(k.created_at) INTO v_snap_id, v_snap_rec
      FROM tint_keys_snapshots k
     WHERE k.entity = 'formulas' AND k.account = 'oben'
     GROUP BY k.snapshot_id
    HAVING bool_and(k.aplicacao_status = 'aplicado')
       AND count(DISTINCT k.chunk_index) = max(k.total_chunks)
     ORDER BY max(k.generated_at) DESC, max(k.created_at) DESC
     LIMIT 1;
    IF v_snap_id IS NULL THEN
      RAISE EXCEPTION 'arquivar-fantasma-lote2 ABORTADA: nenhum snapshot de chaves completo e aplicado — sem prova de ausência na fonte';
    END IF;

    SELECT string_agg(format('%s [%s]: %s', s.id, s.cor_id, m.motivo), '; ') INTO v_ruim
      FROM tint_staging_formulas s
      CROSS JOIN LATERAL (
        SELECT CASE
          WHEN NOT (s.cor_id = ANY (c_cores)) THEN 'cor fora da lista'
          WHEN s.account <> 'oben' THEN 'conta inesperada'
          WHEN s.created_at >= v_snap_rec THEN 'staging posterior ao snapshot (evidência de presença)'
          WHEN EXISTS (SELECT 1 FROM tint_staging_formulas n
                        WHERE n.account = s.account AND n.store_code = s.store_code
                          AND n.cor_id = s.cor_id AND n.cod_produto = s.cod_produto AND n.id_base = s.id_base
                          AND COALESCE(n.subcolecao, '') = COALESCE(s.subcolecao, '')
                          AND n.personalizada = s.personalizada
                          AND (n.created_at, n.id) > (s.created_at, s.id))
            THEN 'não é mais a latest da chave'
          WHEN EXISTS (SELECT 1 FROM tint_keys_snapshots k
                        WHERE k.snapshot_id = v_snap_id AND k.entity = 'formulas'
                          AND k.keys ? (s.cor_id || '|' || s.cod_produto || '|' || s.id_base || '|'
                                        || CASE WHEN s.personalizada THEN 'true' ELSE 'false' END))
            THEN 'a chave VOLTOU para a fonte'
        END AS motivo
      ) m
     WHERE s.id = ANY (c_ids) AND m.motivo IS NOT NULL;
    IF v_ruim IS NOT NULL THEN
      RAISE EXCEPTION 'arquivar-fantasma-lote2 ABORTADA: o diagnóstico não vale mais para: %', v_ruim;
    END IF;

    INSERT INTO tint_receita_versoes
      (account, store_code, cor_id, cod_produto, id_base, subcolecao, personalizada, evento, nome_cor,
       id_embalagem, volume_final_ml, preco_final, itens, staging_formula_id, sync_run_id,
       agent_version, snapshot_id, staging_linha, motivo, recebido_em)
    SELECT s.account, s.store_code, s.cor_id, s.cod_produto, s.id_base, COALESCE(s.subcolecao, ''),
           s.personalizada, 'staging_arquivado', s.nome_cor, s.id_embalagem, s.volume_final_ml,
           s.preco_final,
           COALESCE((SELECT jsonb_agg(to_jsonb(i) ORDER BY i.ordem, i.id)
                       FROM tint_staging_formula_itens i WHERE i.staging_formula_id = s.id), '[]'::jsonb),
           s.id, s.sync_run_id, sr.metadata->>'agent_version', v_snap_id, to_jsonb(s), c_motivo, s.created_at
      FROM tint_staging_formulas s
      LEFT JOIN tint_sync_runs sr ON sr.id = s.sync_run_id
     WHERE s.id = ANY (c_ids)
    ON CONFLICT DO NOTHING;

    -- Só apaga o que tem cópia FIEL (mesmo nº de itens) — o arquivo é a pré-condição do DELETE.
    DELETE FROM tint_staging_formulas s
     WHERE s.id = ANY (c_ids)
       AND EXISTS (SELECT 1 FROM tint_receita_versoes v
                    WHERE v.staging_formula_id = s.id AND v.evento = 'staging_arquivado'
                      AND v.staging_linha = to_jsonb(s)
                      AND jsonb_array_length(v.itens) =
                          (SELECT count(*) FROM tint_staging_formula_itens i WHERE i.staging_formula_id = s.id));
  END IF;
END
$arquivar$;

-- ── PÓS-CONDIÇÃO ────────────────────────────────────────────────────────────────────────────────
DO $post$
DECLARE
  c_ids constant uuid[] := ARRAY[
    '71770a2f-7e45-406a-a329-b39080f41402', '77439be5-8fec-40b9-81c9-a411bfbe64dc',
    '00f2bf42-fb87-410d-a3ef-a44830206056', '31eeb240-cfd2-4b2d-9300-72bc374fa3ab',
    '4eacc77b-33d4-449d-845d-06a6e085c24d', 'bdf481d6-7d5b-4627-a076-b99c477b7c82',
    '79cce452-75f1-4382-97bb-a4dffd973256'
  ]::uuid[];
  v_n int;
BEGIN
  SELECT count(*) INTO v_n FROM tint_receita_versoes
   WHERE evento = 'staging_arquivado' AND staging_formula_id = ANY (c_ids)
     AND (staging_linha->>'id')::uuid = staging_formula_id
     AND staging_linha ? 'raw_data'
     AND jsonb_array_length(itens) > 0;
  IF v_n <> 7 THEN
    RAISE EXCEPTION 'P1 FALHOU: % de 7 linhas arquivadas com cópia íntegra', v_n;
  END IF;
  SELECT count(*) INTO v_n FROM tint_staging_formulas WHERE id = ANY (c_ids);
  IF v_n <> 0 THEN
    RAISE EXCEPTION 'P2 FALHOU: % das 7 linhas seguem no staging — vão continuar re-logando no Guard 4', v_n;
  END IF;
  SELECT count(*) INTO v_n FROM tint_staging_formula_itens WHERE staging_formula_id = ANY (c_ids);
  IF v_n <> 0 THEN
    RAISE EXCEPTION 'P3 FALHOU: % itens órfãos das 7 linhas no staging', v_n;
  END IF;
  RAISE NOTICE 'arquivar-fantasma-lote2 OK: 7 arquivadas, 0 no staging';
END
$post$;
