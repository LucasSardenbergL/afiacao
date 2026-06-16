-- =========================================================================
-- KB Versionamento — Fase A (ADITIVA). ⚠️ MIGRATION MANUAL (SQL Editor).
-- Não toca kb_product_specs / omie_product_spec_links / view / fila.
-- Só adiciona: kb_product_spec_versions + trigger de imutabilidade +
--              RPC aprovar_versao_boletim + backfill dos ~297 aprovados.
-- Spec: docs/superpowers/specs/2026-06-13-kb-versionamento-boletins-design.md §10.
-- Plano: docs/superpowers/plans/2026-06-13-kb-versionamento-boletins-faseA-banco.md
-- =========================================================================

-- =========================================================================
-- BLOCO A: tabela append-only de versões.
-- Identidade estável = (supplier, product_code_normalized).
-- Cada aprovação gera 1 linha imutável — a versão "viva" tem superseded_at IS NULL.
-- =========================================================================
CREATE TABLE IF NOT EXISTS public.kb_product_spec_versions (
  id                         uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  supplier                   text        NOT NULL,
  product_code_normalized    text        NOT NULL,
  product_code               text        NOT NULL,           -- forma de exibição desta versão
  kb_product_spec_id         uuid,                           -- id da linha em kb_product_specs no momento (conveniência)
  version_number             int         NOT NULL,
  source_document_id         uuid        REFERENCES public.kb_documents(id),
  change_type                text        NOT NULL
                               CHECK (change_type IN ('initial','bulletin_revision','correction','data_completion')),
  change_note                text,                           -- obrigatória em correction/data_completion

  -- ↓↓↓ ~37 CAMPOS TÉCNICOS — verbatim de kb_product_specs (sem id/document_id/supplier/product_code/extracted_by/approved_by/approved_at/created_at/updated_at)
  product_name               text,
  product_line               text,                           -- 'wood_pu' | 'wood_nitro' | 'hydropoxi' | 'auto'
  product_category           text,                           -- 'primer' | 'verniz' | 'tinta' | 'catalisador' | 'diluente'

  -- Propriedades físico-químicas
  densidade_g_cm3            numeric,
  solidos_pct                numeric,
  viscosidade_aplicacao_s    numeric,
  viscosidade_copo           text,                           -- 'CF4' | 'CF6' | 'CF8'
  brilho_ub                  numeric,
  dureza                     text,                           -- '3H', '2H' etc.

  -- Aplicação
  rendimento_m2_por_litro    numeric,
  demaos_recomendadas        integer,
  gramatura_g_m2_min         integer,
  gramatura_g_m2_max         integer,
  pot_life_horas             numeric,
  temp_aplicacao_c_min       numeric,
  temp_aplicacao_c_max       numeric,
  umidade_aplicacao_pct_min  numeric,
  umidade_aplicacao_pct_max  numeric,

  -- Compatibilidade
  catalisador_codigo         text,
  catalisador_proporcao_pct  numeric,
  diluente_codigo            text,
  equipamentos_aplicacao     text[],
  lixa_recomendada           text,
  substrato                  text[],

  -- Secagem
  secagem_manuseio_h         numeric,
  secagem_empilhamento_h     numeric,
  secagem_total_h            numeric,

  -- Armazenamento
  validade_dias              integer,
  temp_armazenamento_c_min   integer,
  temp_armazenamento_c_max   integer,

  -- Compliance
  certificacoes_aplicaveis   text[],
  isento_metais_pesados      text[],
  isento_substancias         text[],

  -- Notas qualitativas
  diferenciais_chave         text[],
  uso_recomendado            text,
  publico_alvo               text,

  -- Metadata de extração
  extraction_confidence      numeric,
  extraction_gaps            text[],
  -- ↑↑↑ fim dos campos técnicos

  -- Audit / controle de versão
  approved_by                uuid        REFERENCES auth.users(id),
  approved_at                timestamptz NOT NULL DEFAULT now(),
  superseded_at              timestamptz,                    -- NULL = versão viva (não-supersedida)
  created_at                 timestamptz NOT NULL DEFAULT now(),

  -- Garante sequência por produto (supplier+norm)
  CONSTRAINT kb_spec_versions_seq UNIQUE (supplier, product_code_normalized, version_number),

  -- CHECKs de não-negatividade (os mesmos do 0c, agora na tabela de versões onde os números vivem)
  CONSTRAINT kbv_rendimento_nonneg       CHECK (rendimento_m2_por_litro   IS NULL OR rendimento_m2_por_litro   >= 0),
  CONSTRAINT kbv_demaos_nonneg           CHECK (demaos_recomendadas       IS NULL OR demaos_recomendadas       >= 0),
  CONSTRAINT kbv_potlife_nonneg          CHECK (pot_life_horas            IS NULL OR pot_life_horas            >= 0),
  CONSTRAINT kbv_validade_nonneg         CHECK (validade_dias             IS NULL OR validade_dias             >= 0),
  CONSTRAINT kbv_catalisador_pct_nonneg  CHECK (catalisador_proporcao_pct IS NULL OR catalisador_proporcao_pct >= 0)
);

-- Índice principal: consultar versões de um produto em ordem
CREATE INDEX IF NOT EXISTS idx_kbv_identidade
  ON public.kb_product_spec_versions (supplier, product_code_normalized, version_number DESC);

-- Índice secundário: anti-join da fila de aprovação (§4c do spec)
CREATE INDEX IF NOT EXISTS idx_kbv_source_doc
  ON public.kb_product_spec_versions (source_document_id);

-- RLS: staff lê; INSERT/UPDATE/DELETE só via RPC DEFINER + service_role (sem policy de escrita para authenticated)
ALTER TABLE public.kb_product_spec_versions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS kbv_select_staff ON public.kb_product_spec_versions;
CREATE POLICY kbv_select_staff ON public.kb_product_spec_versions
  FOR SELECT
  USING (
    public.has_role(auth.uid(), 'employee'::app_role)
    OR public.has_role(auth.uid(), 'master'::app_role)
  );

-- =========================================================================
-- BLOCO B: trigger de imutabilidade.
-- Só superseded_at pode mudar numa versão já gravada.
-- Todos os outros campos do payload são bloqueados.
-- =========================================================================
CREATE OR REPLACE FUNCTION public.kbv_block_mutation()
RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  -- Compara o registro inteiro excluindo superseded_at:
  -- se qualquer outro campo mudou, rejeita.
  IF (to_jsonb(NEW) - 'superseded_at') IS DISTINCT FROM (to_jsonb(OLD) - 'superseded_at') THEN
    RAISE EXCEPTION 'kb_product_spec_versions é append-only: só superseded_at pode mudar (versão %)', OLD.id;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_kbv_immutable ON public.kb_product_spec_versions;
CREATE TRIGGER trg_kbv_immutable
  BEFORE UPDATE ON public.kb_product_spec_versions
  FOR EACH ROW EXECUTE FUNCTION public.kbv_block_mutation();

-- =========================================================================
-- BLOCO C: RPC aprovar_versao_boletim — única via de escrita de spec.
-- Grava a versão imutável + atualiza kb_product_specs (atual) na mesma transação.
-- Master-only via RAISE no forbidden (consistente com 0c).
-- =========================================================================
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
  ON CONFLICT (product_code) DO UPDATE SET
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

-- =========================================================================
-- BLOCO D: backfill idempotente dos ~297 specs aprovados como versão 1 ('initial').
-- Só insere onde não há NENHUMA versão ainda para a identidade (NOT EXISTS).
-- Re-rodar é seguro: NÃO duplica.
-- =========================================================================
INSERT INTO public.kb_product_spec_versions (
  supplier,
  product_code_normalized,
  product_code,
  kb_product_spec_id,
  version_number,
  source_document_id,
  change_type,
  change_note,
  -- campos técnicos (mesma lista dos 37, verbatim da tabela)
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
  -- audit
  approved_by,
  approved_at
)
SELECT
  coalesce(lower(btrim(s.supplier)), 'sayerlack'),
  btrim(regexp_replace(upper(normalize(coalesce(s.product_code, ''), NFKC)), '\s+', '', 'g')),
  s.product_code,
  s.id,      -- kb_product_spec_id = a linha atual
  1,         -- versão 1
  s.document_id,
  'initial',
  NULL,      -- change_note null para backfill inicial
  -- campos técnicos
  s.product_name,
  s.product_line,
  s.product_category,
  s.densidade_g_cm3,
  s.solidos_pct,
  s.viscosidade_aplicacao_s,
  s.viscosidade_copo,
  s.brilho_ub,
  s.dureza,
  s.rendimento_m2_por_litro,
  s.demaos_recomendadas,
  s.gramatura_g_m2_min,
  s.gramatura_g_m2_max,
  s.pot_life_horas,
  s.temp_aplicacao_c_min,
  s.temp_aplicacao_c_max,
  s.umidade_aplicacao_pct_min,
  s.umidade_aplicacao_pct_max,
  s.catalisador_codigo,
  s.catalisador_proporcao_pct,
  s.diluente_codigo,
  s.equipamentos_aplicacao,
  s.lixa_recomendada,
  s.substrato,
  s.secagem_manuseio_h,
  s.secagem_empilhamento_h,
  s.secagem_total_h,
  s.validade_dias,
  s.temp_armazenamento_c_min,
  s.temp_armazenamento_c_max,
  s.certificacoes_aplicaveis,
  s.isento_metais_pesados,
  s.isento_substancias,
  s.diferenciais_chave,
  s.uso_recomendado,
  s.publico_alvo,
  s.extraction_confidence,
  s.extraction_gaps,
  s.approved_by,
  coalesce(s.approved_at, s.created_at)  -- fallback pra created_at se approved_at NULL
FROM public.kb_product_specs s
WHERE s.approved_at IS NOT NULL
  AND NOT EXISTS (
    SELECT 1
      FROM public.kb_product_spec_versions v
     WHERE v.supplier              = coalesce(lower(btrim(s.supplier)), 'sayerlack')
       AND v.product_code_normalized = btrim(regexp_replace(upper(normalize(coalesce(s.product_code, ''), NFKC)), '\s+', '', 'g'))
  );

-- =========================================================================
-- Validação inline (retorna na saída do apply manual no SQL Editor).
-- =========================================================================
SELECT
  'kb_spec_versions_faseA OK'                                                                 AS status,
  (SELECT count(*)  FROM public.kb_product_spec_versions)                                     AS versoes_total,
  (SELECT count(*)  FROM public.kb_product_spec_versions WHERE superseded_at IS NULL)         AS versoes_vivas,
  (SELECT count(*)  FROM public.kb_product_spec_versions WHERE change_type = 'initial')       AS versoes_initial,
  (SELECT count(*)  FROM public.kb_product_specs WHERE approved_at IS NOT NULL)               AS specs_aprovadas,
  (SELECT count(*)  FROM pg_tables WHERE tablename = 'kb_product_spec_versions')              AS tabela_existe,
  (SELECT count(*)  FROM pg_trigger WHERE tgname = 'trg_kbv_immutable')                      AS trigger_imutabilidade,
  (SELECT count(*)  FROM pg_proc WHERE proname = 'aprovar_versao_boletim')                    AS rpc_existe,
  (SELECT count(*)  FROM pg_policies WHERE tablename = 'kb_product_spec_versions')            AS rls_policies;
