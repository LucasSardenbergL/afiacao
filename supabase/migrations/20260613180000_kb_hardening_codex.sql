-- =========================================================================
-- KB HARDENING (Codex retroativo #805/#802). ⚠️ MIGRATION MANUAL (SQL Editor).
-- A: GRANT service_role na RPC de claim (bug latente: a edge não executava após REVOKE de public).
-- C: aprovar_versao_boletim usa ON CONFLICT pela IDENTIDADE COMPOSTA (supplier, product_code_normalized),
--    não pelo product_code textual — corrige variação caixa/espaço (vira UPDATE/v2 em vez de erro) e
--    transforma colisão cross-fornecedor em ERRO (não sobrescrita silenciosa). NÃO dropa a UNIQUE global.
-- D: revoga escrita direta de kb_product_specs (front só LÊ; toda escrita passa pela RPC DEFINER).
-- E: impõe "1 versão viva" (índice parcial) + append-only de verdade (trigger rejeita DELETE/reviver).
-- O BLOCO C é VERBATIM da 20260613150000 + 2 linhas no ON CONFLICT (validado por diff mecânico).
-- =========================================================================

-- ===== BLOCO A: GRANT service_role na RPC de claim (#802-P3) =====
GRANT EXECUTE ON FUNCTION public.kb_extraction_draft_claim(uuid, uuid) TO service_role;

-- ===== BLOCO C: aprovar_versao_boletim — ON CONFLICT pela identidade composta (#805-P1.2) =====
CREATE OR REPLACE FUNCTION public.aprovar_versao_boletim(
  p_payload      jsonb,
  p_document_id  uuid,
  p_change_type  text,
  p_change_note  text DEFAULT NULL
) RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid     uuid    := auth.uid();
  v_supplier text   := lower(btrim(coalesce(p_payload->>'supplier', 'sayerlack')));
  v_code    text    := coalesce(p_payload->>'product_code', '');
  -- Normalização NFKC + uppercase + remove whitespace (espelha a coluna GENERATED do 0a)
  v_norm    text    := btrim(regexp_replace(upper(normalize(v_code, NFKC)), '\s+', '', 'g'));
  v_next    int;
  v_spec_id uuid;
  v_version_id uuid;
BEGIN
  -- Gate master-only (consistente com 0c)
  IF NOT public.has_role(v_uid, 'master'::app_role) THEN
    RAISE EXCEPTION 'forbidden: somente master pode aprovar versões de boletim';
  END IF;

  -- Validações de entrada
  IF v_norm = '' THEN
    RAISE EXCEPTION 'product_code obrigatório no payload';
  END IF;
  IF p_change_type NOT IN ('initial', 'bulletin_revision', 'correction', 'data_completion') THEN
    RAISE EXCEPTION 'change_type inválido: %. Valores aceitos: initial, bulletin_revision, correction, data_completion', p_change_type;
  END IF;
  IF p_change_type IN ('correction', 'data_completion') AND coalesce(btrim(p_change_note), '') = '' THEN
    RAISE EXCEPTION 'change_note é obrigatória quando change_type = %', p_change_type;
  END IF;

  -- Advisory lock por produto: serializa version_number para concorrência
  PERFORM pg_advisory_xact_lock(hashtext(v_supplier || '|' || v_norm));

  -- Passo 1: upsert em kb_product_specs (mantém ponteiro "atual" como hoje)
  -- approved_by e approved_at são server-side (não vêm do payload)
  INSERT INTO public.kb_product_specs AS s (
    document_id,
    product_code,
    product_name,
    supplier,
    product_line,
    product_category,
    densidade_g_cm3,
    solidos_pct,
    viscosidade_aplicacao_s,
    viscosidade_copo,
    brilho_ub,
    dureza,
    rendimento_m2_por_litro,
    demaos_recomendadas,
    gramatura_g_m2_min,
    gramatura_g_m2_max,
    pot_life_horas,
    temp_aplicacao_c_min,
    temp_aplicacao_c_max,
    umidade_aplicacao_pct_min,
    umidade_aplicacao_pct_max,
    catalisador_codigo,
    catalisador_proporcao_pct,
    diluente_codigo,
    equipamentos_aplicacao,
    lixa_recomendada,
    substrato,
    secagem_manuseio_h,
    secagem_empilhamento_h,
    secagem_total_h,
    validade_dias,
    temp_armazenamento_c_min,
    temp_armazenamento_c_max,
    certificacoes_aplicaveis,
    isento_metais_pesados,
    isento_substancias,
    diferenciais_chave,
    uso_recomendado,
    publico_alvo,
    extraction_confidence,
    extraction_gaps,
    extracted_by,
    approved_by,
    approved_at
  )
  SELECT
    p_document_id,
    r.product_code,
    r.product_name,
    lower(btrim(coalesce(r.supplier, 'sayerlack'))),
    r.product_line,
    r.product_category,
    r.densidade_g_cm3,
    r.solidos_pct,
    r.viscosidade_aplicacao_s,
    r.viscosidade_copo,
    r.brilho_ub,
    r.dureza,
    r.rendimento_m2_por_litro,
    r.demaos_recomendadas,
    r.gramatura_g_m2_min,
    r.gramatura_g_m2_max,
    r.pot_life_horas,
    r.temp_aplicacao_c_min,
    r.temp_aplicacao_c_max,
    r.umidade_aplicacao_pct_min,
    r.umidade_aplicacao_pct_max,
    r.catalisador_codigo,
    r.catalisador_proporcao_pct,
    r.diluente_codigo,
    r.equipamentos_aplicacao,
    r.lixa_recomendada,
    r.substrato,
    r.secagem_manuseio_h,
    r.secagem_empilhamento_h,
    r.secagem_total_h,
    r.validade_dias,
    r.temp_armazenamento_c_min,
    r.temp_armazenamento_c_max,
    r.certificacoes_aplicaveis,
    r.isento_metais_pesados,
    r.isento_substancias,
    r.diferenciais_chave,
    r.uso_recomendado,
    r.publico_alvo,
    r.extraction_confidence,
    r.extraction_gaps,
    v_uid,    -- extracted_by = master que aprovou
    v_uid,    -- approved_by server-side
    now()     -- approved_at server-side
  FROM jsonb_populate_record(null::public.kb_product_specs, p_payload) r
  ON CONFLICT (supplier, product_code_normalized) DO UPDATE SET
    product_code             = excluded.product_code,
    document_id              = excluded.document_id,
    product_name             = excluded.product_name,
    supplier                 = excluded.supplier,
    product_line             = excluded.product_line,
    product_category         = excluded.product_category,
    densidade_g_cm3          = excluded.densidade_g_cm3,
    solidos_pct              = excluded.solidos_pct,
    viscosidade_aplicacao_s  = excluded.viscosidade_aplicacao_s,
    viscosidade_copo         = excluded.viscosidade_copo,
    brilho_ub                = excluded.brilho_ub,
    dureza                   = excluded.dureza,
    rendimento_m2_por_litro  = excluded.rendimento_m2_por_litro,
    demaos_recomendadas      = excluded.demaos_recomendadas,
    gramatura_g_m2_min       = excluded.gramatura_g_m2_min,
    gramatura_g_m2_max       = excluded.gramatura_g_m2_max,
    pot_life_horas           = excluded.pot_life_horas,
    temp_aplicacao_c_min     = excluded.temp_aplicacao_c_min,
    temp_aplicacao_c_max     = excluded.temp_aplicacao_c_max,
    umidade_aplicacao_pct_min = excluded.umidade_aplicacao_pct_min,
    umidade_aplicacao_pct_max = excluded.umidade_aplicacao_pct_max,
    catalisador_codigo       = excluded.catalisador_codigo,
    catalisador_proporcao_pct = excluded.catalisador_proporcao_pct,
    diluente_codigo          = excluded.diluente_codigo,
    equipamentos_aplicacao   = excluded.equipamentos_aplicacao,
    lixa_recomendada         = excluded.lixa_recomendada,
    substrato                = excluded.substrato,
    secagem_manuseio_h       = excluded.secagem_manuseio_h,
    secagem_empilhamento_h   = excluded.secagem_empilhamento_h,
    secagem_total_h          = excluded.secagem_total_h,
    validade_dias            = excluded.validade_dias,
    temp_armazenamento_c_min = excluded.temp_armazenamento_c_min,
    temp_armazenamento_c_max = excluded.temp_armazenamento_c_max,
    certificacoes_aplicaveis = excluded.certificacoes_aplicaveis,
    isento_metais_pesados    = excluded.isento_metais_pesados,
    isento_substancias       = excluded.isento_substancias,
    diferenciais_chave       = excluded.diferenciais_chave,
    uso_recomendado          = excluded.uso_recomendado,
    publico_alvo             = excluded.publico_alvo,
    extraction_confidence    = excluded.extraction_confidence,
    extraction_gaps          = excluded.extraction_gaps,
    approved_by              = v_uid,
    approved_at              = now(),
    updated_at               = now()
  RETURNING s.id INTO v_spec_id;

  -- Passo 2: próxima versão = max+1 por identidade
  SELECT coalesce(max(version_number), 0) + 1
    INTO v_next
    FROM public.kb_product_spec_versions
   WHERE supplier = v_supplier AND product_code_normalized = v_norm;

  -- Passo 3: supersede a versão viva anterior (só superseded_at muda — permitido pelo trigger)
  UPDATE public.kb_product_spec_versions
     SET superseded_at = now()
   WHERE supplier              = v_supplier
     AND product_code_normalized = v_norm
     AND superseded_at IS NULL;

  -- Passo 4: insere a nova versão imutável
  INSERT INTO public.kb_product_spec_versions (
    supplier,
    product_code_normalized,
    product_code,
    kb_product_spec_id,
    version_number,
    source_document_id,
    change_type,
    change_note,
    -- campos técnicos (mesma lista dos 37 campos do CREATE TABLE acima)
    product_name,
    product_line,
    product_category,
    densidade_g_cm3,
    solidos_pct,
    viscosidade_aplicacao_s,
    viscosidade_copo,
    brilho_ub,
    dureza,
    rendimento_m2_por_litro,
    demaos_recomendadas,
    gramatura_g_m2_min,
    gramatura_g_m2_max,
    pot_life_horas,
    temp_aplicacao_c_min,
    temp_aplicacao_c_max,
    umidade_aplicacao_pct_min,
    umidade_aplicacao_pct_max,
    catalisador_codigo,
    catalisador_proporcao_pct,
    diluente_codigo,
    equipamentos_aplicacao,
    lixa_recomendada,
    substrato,
    secagem_manuseio_h,
    secagem_empilhamento_h,
    secagem_total_h,
    validade_dias,
    temp_armazenamento_c_min,
    temp_armazenamento_c_max,
    certificacoes_aplicaveis,
    isento_metais_pesados,
    isento_substancias,
    diferenciais_chave,
    uso_recomendado,
    publico_alvo,
    extraction_confidence,
    extraction_gaps,
    -- audit server-side
    approved_by,
    approved_at
  )
  SELECT
    v_supplier,
    v_norm,
    r.product_code,
    v_spec_id,
    v_next,
    p_document_id,
    p_change_type,
    p_change_note,
    -- campos técnicos do payload
    r.product_name,
    r.product_line,
    r.product_category,
    r.densidade_g_cm3,
    r.solidos_pct,
    r.viscosidade_aplicacao_s,
    r.viscosidade_copo,
    r.brilho_ub,
    r.dureza,
    r.rendimento_m2_por_litro,
    r.demaos_recomendadas,
    r.gramatura_g_m2_min,
    r.gramatura_g_m2_max,
    r.pot_life_horas,
    r.temp_aplicacao_c_min,
    r.temp_aplicacao_c_max,
    r.umidade_aplicacao_pct_min,
    r.umidade_aplicacao_pct_max,
    r.catalisador_codigo,
    r.catalisador_proporcao_pct,
    r.diluente_codigo,
    r.equipamentos_aplicacao,
    r.lixa_recomendada,
    r.substrato,
    r.secagem_manuseio_h,
    r.secagem_empilhamento_h,
    r.secagem_total_h,
    r.validade_dias,
    r.temp_armazenamento_c_min,
    r.temp_armazenamento_c_max,
    r.certificacoes_aplicaveis,
    r.isento_metais_pesados,
    r.isento_substancias,
    r.diferenciais_chave,
    r.uso_recomendado,
    r.publico_alvo,
    r.extraction_confidence,
    r.extraction_gaps,
    v_uid,
    now()
  FROM jsonb_populate_record(null::public.kb_product_spec_versions, p_payload) r
  RETURNING id INTO v_version_id;

  -- Passo 5: RECONCILIAÇÃO com #802 — rascunho cumpriu seu papel, remove na mesma transação.
  -- DEFINER bypassa a RLS master-only de kb_extraction_drafts.
  -- Se p_document_id for NULL (aprovação manual sem documento), o DELETE é no-op.
  DELETE FROM public.kb_extraction_drafts
   WHERE document_id = p_document_id;

  RETURN v_version_id;
END;
$$;

REVOKE ALL ON FUNCTION public.aprovar_versao_boletim(jsonb, uuid, text, text) FROM anon, public;
GRANT EXECUTE ON FUNCTION public.aprovar_versao_boletim(jsonb, uuid, text, text) TO authenticated;

-- ===== BLOCO D: revoga escrita direta de kb_product_specs (#805-P1) =====
-- O front só LÊ kb_product_specs direto (4 callers = .select, confirmado por grep); toda escrita
-- passa pela RPC aprovar_versao_boletim (SECURITY DEFINER, roda como owner → não afetada).
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON public.kb_product_specs FROM authenticated;

-- ===== BLOCO E: invariantes "1 viva" + append-only impostos no banco (#805-P2.1) =====
-- E1: no máximo 1 versão viva (superseded_at IS NULL) por identidade.
CREATE UNIQUE INDEX IF NOT EXISTS kbv_uma_viva
  ON public.kb_product_spec_versions (supplier, product_code_normalized)
  WHERE superseded_at IS NULL;

-- E2: append-only de verdade — rejeita DELETE + só permite superseded_at NULL→NOT NULL (não reviver).
CREATE OR REPLACE FUNCTION public.kbv_block_mutation()
RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'kb_product_spec_versions é append-only: DELETE proibido (versão %)', OLD.id;
  END IF;
  IF (to_jsonb(NEW) - 'superseded_at') IS DISTINCT FROM (to_jsonb(OLD) - 'superseded_at') THEN
    RAISE EXCEPTION 'kb_product_spec_versions é append-only: só superseded_at pode mudar (versão %)', OLD.id;
  END IF;
  IF OLD.superseded_at IS NOT NULL AND NEW.superseded_at IS NULL THEN
    RAISE EXCEPTION 'kb_product_spec_versions: não é permitido reviver versão supersedida (versão %)', OLD.id;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_kbv_immutable ON public.kb_product_spec_versions;
CREATE TRIGGER trg_kbv_immutable
  BEFORE UPDATE OR DELETE ON public.kb_product_spec_versions
  FOR EACH ROW EXECUTE FUNCTION public.kbv_block_mutation();

-- ===== Validação inline =====
SELECT
  'kb_hardening_codex OK'                                                                          AS status,
  has_function_privilege('service_role', 'public.kb_extraction_draft_claim(uuid,uuid)', 'EXECUTE') AS a_grant_claim,
  (position('supplier, product_code_normalized' in pg_get_functiondef('public.aprovar_versao_boletim(jsonb,uuid,text,text)'::regprocedure)) > 0) AS c_conflict_composta,
  (NOT has_table_privilege('authenticated', 'public.kb_product_specs', 'INSERT'))                  AS d_sem_insert,
  (NOT has_table_privilege('authenticated', 'public.kb_product_specs', 'UPDATE'))                  AS d_sem_update,
  has_table_privilege('authenticated', 'public.kb_product_specs', 'SELECT')                        AS d_mantem_select,
  (SELECT count(*) FROM pg_indexes WHERE indexname = 'kbv_uma_viva')                               AS e_indice_viva,
  (SELECT count(*) FROM pg_trigger WHERE tgname = 'trg_kbv_immutable')                             AS e_trigger;
