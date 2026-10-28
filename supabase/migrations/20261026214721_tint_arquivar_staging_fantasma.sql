-- ═════════════════════════════════════════════════════════════════════════════════════════════════
-- Tintométrico — arquiva e remove do staging as 7 cores-fantasma do card "Fórmulas rejeitadas"
--
-- DECISÃO DO FOUNDER (2026-10-26, opção "A"): tirar do card, SEM perder histórico.
-- Depende de 20261026214720_tint_receita_versoes.sql (a tabela que guarda a cópia).
--
-- O DIAGNÓSTICO (psql-ro, 2026-10-26; nota completa no PR):
--   * As 7 são a LATEST do staging da sua chave, vindas do conector 0.2.0 (jul-set/2026) com o slot
--     livre gravado como corante '0'/dose 0 → o Guard 4 do promote as rejeita.
--   * Saíram da FONTE: 0 de 25 snapshots de chaves aplicados (28/09→26/10) as contêm —
--     CHOCOLATE AMARGO até 21/10 10:01 (provável renomeação: CHOCOLATE MEIO AMARGO chegou 21/10
--     13:05, mesmo produto e base). Controle: ESTOJO DE COURO (viva) está em 25/25.
--   * Catálogo já limpo: 0 fórmulas ativas/vendáveis (4602* nunca entraram; as 52 das outras 3
--     estão desativadas).
--   * Por que re-logam: o promote reexpande o latest de TODAS as cores de cada (produto, base)
--     tocado, e o Guard 4 grava a rejeição ANTES do filtro de fantasma da fonte (que já as barra).
--     O purge preserva a latest por chave → nunca sairiam sozinhas.
--
-- O QUE FAZ: para cada um dos 7 ids, grava em tint_receita_versoes um evento 'staging_arquivado'
-- com a linha INTEIRA (to_jsonb, inclui raw_data) e os itens INTEIROS, e só então apaga a linha
-- do staging (os itens saem por ON DELETE CASCADE). O que NÃO toca: tint_formulas (sem carimbo de
-- motivo — o CHECK motivo_exige_desativacao abortaria o run se o promote reativasse uma linha
-- carimbada), tint_sync_errors (os ~2.400 logs ficam).
--
-- GUARDA (re-prova o diagnóstico NA HORA do apply, para cada id ainda presente): é a latest da
-- chave, é da lista das 7 cores, a chave está AUSENTE do último snapshot completo aplicado e a
-- linha é anterior a ele. Qualquer falha ABORTA tudo. Serializa com o promote pela trava do tick
-- (o mesmo que o purge faz); trava ocupada → aborta pedindo para re-rodar.
-- Re-aplicar é no-op: arquivo ON CONFLICT DO NOTHING; o DELETE não acha nada.
-- Prova executada: db/test-tint-receita-versoes.sh (PG17).
-- ═════════════════════════════════════════════════════════════════════════════════════════════════

DO $arquivar$
DECLARE
  c_ids constant uuid[] := ARRAY[
    '66cbebc0-2c21-481c-a420-eee00aa1c71c',  -- 4602081
    '1f2ed55f-4bf7-44a1-b354-d6f139870ad9',  -- 4602092
    'c7e4fa46-5b9c-4715-9801-f06dc0294e46',  -- 4602093
    '8292ba62-aa72-4586-9faa-4bdf7db1fccf',  -- 4602100
    '2ef39afc-3ce4-477d-8bcd-35878c603541',  -- CAFELATTE ARAUCO ZAMBALD
    'd9237a8e-53ad-431e-8093-419300d0a894',  -- CHOCOLATE AMARGO (com espaço no fim)
    'd720a669-f558-4b37-a04a-95bafda747b8'   -- Y149 VERDE
  ]::uuid[];
  c_cores constant text[] := ARRAY['4602081', '4602092', '4602093', '4602100',
                                   'CAFELATTE ARAUCO ZAMBALD', 'CHOCOLATE AMARGO ', 'Y149 VERDE'];
  c_motivo constant text :=
    'fantasma da fonte: ausente de todos os snapshots de chaves aplicados; latest do conector 0.2.0 com slot livre gravado como corante 0 re-logava no Guard 4 (decisao do founder 2026-10-26, opcao A)';
  v_snap_id   uuid;
  v_snap_rec  timestamptz;
  v_ruim      text;
  v_presentes int;
BEGIN
  IF to_regclass('public.tint_receita_versoes') IS NULL THEN
    RAISE EXCEPTION 'arquivar-fantasma ABORTADA: tint_receita_versoes não existe — aplique 20261026214720 antes';
  END IF;
  IF NOT pg_try_advisory_xact_lock(hashtext('tint_promocao_tick')) THEN
    RAISE EXCEPTION 'arquivar-fantasma ABORTADA: promoção em curso (trava do tick ocupada) — re-rode em 1 minuto';
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
      RAISE EXCEPTION 'arquivar-fantasma ABORTADA: nenhum snapshot de chaves completo e aplicado — sem prova de ausência na fonte';
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
      RAISE EXCEPTION 'arquivar-fantasma ABORTADA: o diagnóstico não vale mais para: %', v_ruim;
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
    '66cbebc0-2c21-481c-a420-eee00aa1c71c', '1f2ed55f-4bf7-44a1-b354-d6f139870ad9',
    'c7e4fa46-5b9c-4715-9801-f06dc0294e46', '8292ba62-aa72-4586-9faa-4bdf7db1fccf',
    '2ef39afc-3ce4-477d-8bcd-35878c603541', 'd9237a8e-53ad-431e-8093-419300d0a894',
    'd720a669-f558-4b37-a04a-95bafda747b8'
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
  RAISE NOTICE 'arquivar-fantasma OK: 7 arquivadas, 0 no staging';
END
$post$;
