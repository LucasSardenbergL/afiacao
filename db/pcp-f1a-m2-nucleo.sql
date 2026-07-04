-- PCP Fase 1A — M2: extração da malha + parser dimensional + pcp_itens + destilação paramétrica.
-- Aplicar no SQL Editor do Lovable (founder), DEPOIS do M1 + sync (staging populado).
-- SHAPE LOCK: expressões jsonb abaixo assumem itens em payload->'itens' com campos
--   ident.idProdMalha / ident.codProdMalha / ident.descrProdMalha / quantProdMalha / unidProdMalha.
--   Confirmado/ajustado no probe (plano Task 4.5). Divergiu? Ajustar SÓ vw_pcp_malha_itens.
-- Spec: docs/superpowers/specs/2026-07-03-pcp-colacor-blueprint-design.md (§3 Camadas 0 e 4; Gate 0 Codex #7)
BEGIN;

-- ── 0) Config ──────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.pcp_config (
  key text PRIMARY KEY,
  value jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO public.pcp_config (key, value) VALUES
  ('tolerancia_abrasivo', '0.005'),   -- área nominal deve bater quase exata (0,5%)
  ('tolerancia_insumo',   '0.05'),    -- cola/catalisador/fita: 5%
  ('min_amostras_regra',  '3'),       -- linha com menos amostras usa a regra global '*'
  ('dispersao_max_regra', '0.10')     -- regra com MAD relativa acima disto é INSTÁVEL (não valida ninguém)
ON CONFLICT (key) DO NOTHING;

-- Número tolerante (painel Codex P1): Omie pode mandar '1,611', '' ou lixo — cast direto
-- derrubaria a VIEW inteira. Inválido ⇒ NULL (nunca fabricar), o status da validação acusa.
CREATE OR REPLACE FUNCTION public.fn_pcp_num(p_raw text)
RETURNS numeric LANGUAGE sql IMMUTABLE AS $$
SELECT CASE
  WHEN v ~ '^-?\d+(\.\d+)?$' THEN v::numeric
END
FROM (SELECT replace(trim(coalesce(p_raw,'')), ',', '.') AS v) t
$$;

-- ── 1) Extração da malha (TODO o mapeamento de shape vive AQUI) ────────────
CREATE OR REPLACE VIEW public.vw_pcp_malha_itens
WITH (security_invoker = true) AS
SELECT
  s.omie_codigo_produto AS pai_codigo,
  NULLIF(COALESCE(i->'ident'->>'idProdMalha', i->'ident'->>'idMalha', i->>'idProdMalha'), '')::bigint
    AS componente_id,
  COALESCE(i->'ident'->>'codProdMalha', i->>'codProdMalha')       AS componente_codigo_txt,
  COALESCE(i->'ident'->>'descrProdMalha', i->>'descrProdMalha')   AS componente_descricao_omie,
  fn_pcp_num(COALESCE(i->>'quantProdMalha', i->>'quantidade'))    AS quantidade,
  upper(COALESCE(i->>'unidProdMalha', i->>'unidade'))             AS unidade,
  fn_pcp_num(i->>'percPerdaProdMalha')                            AS perc_perda
FROM public.pcp_malha_staging s
CROSS JOIN LATERAL jsonb_array_elements(
  -- array-aware (painel Codex): COALESCE pegaria 'itens' VAZIO e nunca cairia no fallback
  CASE
    WHEN jsonb_typeof(s.payload->'itens') = 'array' AND jsonb_array_length(s.payload->'itens') > 0
      THEN s.payload->'itens'
    WHEN jsonb_typeof(s.payload->'itensMalha') = 'array'
      THEN s.payload->'itensMalha'
    ELSE '[]'::jsonb
  END
) AS i;

-- Resolve o componente contra omie_products (por id Omie; fallback por codigo string).
CREATE OR REPLACE VIEW public.vw_pcp_malha_componentes
WITH (security_invoker = true) AS
SELECT
  m.pai_codigo, m.quantidade, m.unidade, m.perc_perda,
  COALESCE(byid.omie_codigo_produto, bycod.omie_codigo_produto)      AS componente_codigo,
  COALESCE(byid.descricao, bycod.descricao, m.componente_descricao_omie) AS componente_descricao,
  COALESCE(byid.familia, bycod.familia)                              AS componente_familia
FROM public.vw_pcp_malha_itens m
LEFT JOIN public.omie_products byid
  ON byid.omie_codigo_produto = m.componente_id AND byid.account = 'colacor'
LEFT JOIN public.omie_products bycod
  ON m.componente_id IS NULL AND bycod.codigo = m.componente_codigo_txt AND bycod.account = 'colacor';

-- ── 2) Parser dimensional (NUNCA fabrica: sem match ⇒ NULL + formato explícito) ──
CREATE OR REPLACE FUNCTION public.fn_pcp_parse_dimensoes(p_descricao text)
RETURNS TABLE (largura_mm int, comprimento_mm int, grao int, diametro_mm int, formato text)
LANGUAGE sql IMMUTABLE AS $$
WITH d AS (SELECT upper(coalesce(p_descricao,'')) AS s),
dims AS (SELECT regexp_match((SELECT s FROM d), '\m(\d{2,4})X(\d{3,6})MM\M') AS m),
gr   AS (SELECT regexp_match((SELECT s FROM d), '\mP(\d{2,4})\M') AS m),
diam AS (SELECT regexp_match((SELECT s FROM d), '\m(\d{2,3})MM\M') AS m)
SELECT
  (SELECT m[1]::int FROM dims),
  (SELECT m[2]::int FROM dims),
  (SELECT m[1]::int FROM gr),
  CASE WHEN (SELECT m FROM dims) IS NULL AND (SELECT s FROM d) ~ '^(DISCO|BLOCO)'
       THEN (SELECT m[1]::int FROM diam) END,
  CASE WHEN (SELECT m FROM dims) IS NOT NULL THEN 'dimensional'
       WHEN (SELECT s FROM d) ~ '^(DISCO|BLOCO)' AND (SELECT m FROM diam) IS NOT NULL THEN 'disco'
       ELSE 'sem_match' END
$$;

-- ── 3) Itens PCP (dados mestres) ───────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.pcp_itens (
  omie_codigo_produto bigint PRIMARY KEY,
  empresa        text NOT NULL DEFAULT 'colacor',
  codigo         text,
  descricao      text NOT NULL,
  familia        text,
  tipo_produto   text,
  tipo_item      text NOT NULL CHECK (tipo_item IN ('cinta','rolo','jumbo','disco','tingidor','folha','outro')),
  linha_modelo   text,
  largura_mm     int,
  comprimento_mm int,
  grao           int,
  diametro_mm    int,
  formato_parse  text NOT NULL CHECK (formato_parse IN ('dimensional','disco','sem_match')),
  politica       text CHECK (politica IN ('MTS_ROLO','MTS','MTO')),  -- humano/Fase 3; refresh NÃO sobrescreve
  lote_minimo    numeric,          -- Fase 3 preenche (spec Camada 0 item 1); refresh NÃO sobrescreve
  lote_multiplo  numeric,
  leadtime_padrao_dias int,
  refreshed_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_pcp_itens_linha ON public.pcp_itens (linha_modelo);
CREATE INDEX IF NOT EXISTS idx_pcp_itens_tipo  ON public.pcp_itens (tipo_item);

CREATE OR REPLACE FUNCTION public.fn_pcp_refresh_itens()
RETURNS TABLE (total int, dimensionais int, discos int, sem_match int)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  INSERT INTO pcp_itens (omie_codigo_produto, empresa, codigo, descricao, familia, tipo_produto,
    tipo_item, linha_modelo, largura_mm, comprimento_mm, grao, diametro_mm, formato_parse, refreshed_at)
  SELECT p.omie_codigo_produto, 'colacor', p.codigo, p.descricao, p.familia, p.tipo_produto,
    CASE WHEN upper(p.descricao) LIKE 'CINTA %'  THEN 'cinta'
         WHEN upper(p.descricao) LIKE 'ROLO %'   THEN 'rolo'
         WHEN upper(p.descricao) LIKE 'JUMBO %'  THEN 'jumbo'
         WHEN p.familia ILIKE '%disco%'          THEN 'disco'
         WHEN p.familia = 'Tingidor Tingimix'    THEN 'tingidor'
         WHEN p.familia ILIKE '%folha%'          THEN 'folha'
         ELSE 'outro' END,
    COALESCE(NULLIF(trim(p.metadata->>'modelo'), ''),
             (regexp_match(p.descricao, '^(?:CINTA|ROLO|JUMBO)\s+(\S+)'))[1]),
    d.largura_mm, d.comprimento_mm, d.grao, d.diametro_mm, d.formato, now()
  FROM omie_products p
  CROSS JOIN LATERAL fn_pcp_parse_dimensoes(p.descricao) d
  WHERE p.account = 'colacor'
  ON CONFLICT (omie_codigo_produto) DO UPDATE SET
    codigo = EXCLUDED.codigo, descricao = EXCLUDED.descricao, familia = EXCLUDED.familia,
    tipo_produto = EXCLUDED.tipo_produto, tipo_item = EXCLUDED.tipo_item,
    linha_modelo = EXCLUDED.linha_modelo, largura_mm = EXCLUDED.largura_mm,
    comprimento_mm = EXCLUDED.comprimento_mm, grao = EXCLUDED.grao,
    diametro_mm = EXCLUDED.diametro_mm, formato_parse = EXCLUDED.formato_parse, refreshed_at = now();

  RETURN QUERY SELECT count(*)::int,
    count(*) FILTER (WHERE pcp_itens.formato_parse = 'dimensional')::int,
    count(*) FILTER (WHERE pcp_itens.formato_parse = 'disco')::int,
    count(*) FILTER (WHERE pcp_itens.formato_parse = 'sem_match')::int
  FROM pcp_itens;
END $$;

-- ── 4) Papel do componente na malha ────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.fn_pcp_papel_componente(p_descricao text, p_familia text)
RETURNS text LANGUAGE sql IMMUTABLE AS $$
SELECT CASE
  WHEN upper(coalesce(p_descricao,'')) ~ '^(ROLO|JUMBO)\s'                      THEN 'abrasivo_base'
  WHEN upper(coalesce(p_descricao,'')) ~ 'DESMODUR|CATALISADOR'
    OR coalesce(p_familia,'') ILIKE '%catalisador%'                             THEN 'catalisador'
  -- FITA antes de cola (painel Codex): "FITA ADESIVA" tem que ser fita, não cola
  WHEN upper(coalesce(p_descricao,'')) ~ '\mFITA\M'                             THEN 'fita'
  WHEN upper(coalesce(p_descricao,'')) ~ 'A455|ADESIVO|\mCOLA\M'
    OR coalesce(p_familia,'') ILIKE '%cola%' OR coalesce(p_familia,'') ILIKE '%adesivo%' THEN 'cola'
  ELSE 'outro'
END $$;

-- ── 5) Regras destiladas (BOM paramétrica) ─────────────────────────────────
CREATE TABLE IF NOT EXISTS public.pcp_bom_regras (
  linha_modelo text NOT NULL,   -- '*' = regra global (fallback p/ linha com poucas amostras)
  papel  text NOT NULL CHECK (papel IN ('abrasivo_base','cola','catalisador','fita')),
  metodo text NOT NULL CHECK (metodo IN ('area_nominal','g_por_mm_largura','razao_sobre_cola','cm_overlap_largura')),
  coef numeric,
  amostras int NOT NULL,
  dispersao numeric,            -- MAD relativa (mediana de |x-med|/med) — qualidade da regra
  derivado_em timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (linha_modelo, papel)
);

CREATE OR REPLACE FUNCTION public.fn_pcp_destilar_bom()
RETURNS int LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_regras int;
  v_min int := coalesce((SELECT (value)::int FROM pcp_config WHERE key = 'min_amostras_regra'), 3);
BEGIN
  DROP TABLE IF EXISTS tmp_obs, tmp_ratio;  -- re-execução na MESMA transação não pode quebrar
  DELETE FROM pcp_bom_regras;

  -- Observações: componentes das malhas cujo PAI é cinta/rolo com dimensões parseadas.
  CREATE TEMP TABLE tmp_obs ON COMMIT DROP AS
  SELECT pai.linha_modelo, pai.omie_codigo_produto AS pai_codigo, pai.largura_mm,
         fn_pcp_papel_componente(c.componente_descricao, c.componente_familia) AS papel,
         c.quantidade, c.unidade
  FROM vw_pcp_malha_componentes c
  JOIN pcp_itens pai ON pai.omie_codigo_produto = c.pai_codigo
  WHERE pai.tipo_item IN ('cinta','rolo') AND pai.formato_parse = 'dimensional'
    AND pai.linha_modelo IS NOT NULL AND c.quantidade IS NOT NULL;

  -- Guarda (painel Codex): universo vazio NÃO pode zerar as regras boas —
  -- o RAISE reverte o DELETE acima (mesma transação).
  IF NOT EXISTS (SELECT 1 FROM tmp_obs) THEN
    RAISE EXCEPTION 'fn_pcp_destilar_bom: universo de observações VAZIO — abortando sem apagar regras (staging/refresh rodaram?)';
  END IF;

  -- Razões observadas por papel (NULL quando não se aplica — nunca inventar).
  CREATE TEMP TABLE tmp_ratio ON COMMIT DROP AS
  SELECT o.linha_modelo, o.papel,
    CASE o.papel
      WHEN 'cola'        THEN CASE WHEN o.unidade = 'G' AND o.largura_mm > 0 THEN o.quantidade / o.largura_mm END
      WHEN 'fita'        THEN CASE WHEN o.unidade = 'CM' THEN o.quantidade - o.largura_mm / 10.0 END
      WHEN 'catalisador' THEN CASE WHEN o.unidade = 'G' AND cola.quantidade > 0 THEN o.quantidade / cola.quantidade END
    END AS ratio
  FROM tmp_obs o
  LEFT JOIN LATERAL (
    SELECT o2.quantidade FROM tmp_obs o2
    WHERE o2.pai_codigo = o.pai_codigo AND o2.papel = 'cola' AND o2.unidade = 'G'
    LIMIT 1
  ) cola ON o.papel = 'catalisador'
  WHERE o.papel IN ('cola','fita','catalisador');

  -- Regras por linha (só papéis com razão) + abrasivo_base (área nominal, coef 1.0).
  INSERT INTO pcp_bom_regras (linha_modelo, papel, metodo, coef, amostras, dispersao)
  WITH med AS (
    SELECT linha_modelo, papel,
           percentile_cont(0.5) WITHIN GROUP (ORDER BY ratio) AS coef,
           count(*) AS amostras
    FROM tmp_ratio WHERE ratio IS NOT NULL
    GROUP BY linha_modelo, papel
    HAVING count(*) >= v_min
  ),
  glob AS (
    SELECT '*'::text AS linha_modelo, papel,
           percentile_cont(0.5) WITHIN GROUP (ORDER BY ratio) AS coef,
           count(*) AS amostras
    FROM tmp_ratio WHERE ratio IS NOT NULL
    GROUP BY papel
  ),
  unida AS (SELECT * FROM med UNION ALL SELECT * FROM glob)
  SELECT u.linha_modelo, u.papel,
    CASE u.papel WHEN 'cola' THEN 'g_por_mm_largura'
                 WHEN 'catalisador' THEN 'razao_sobre_cola'
                 WHEN 'fita' THEN 'cm_overlap_largura' END,
    u.coef, u.amostras,
    (SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY abs(r.ratio - u.coef) / NULLIF(abs(u.coef), 0))
       FROM tmp_ratio r
      WHERE r.papel = u.papel AND r.ratio IS NOT NULL
        AND (u.linha_modelo = '*' OR r.linha_modelo = u.linha_modelo))
  FROM unida u;

  INSERT INTO pcp_bom_regras (linha_modelo, papel, metodo, coef, amostras, dispersao)
  SELECT o.linha_modelo, 'abrasivo_base', 'area_nominal', 1.0, count(*), NULL::numeric
  FROM tmp_obs o WHERE o.papel = 'abrasivo_base' AND o.unidade = 'M2'
  GROUP BY o.linha_modelo
  UNION ALL
  SELECT '*', 'abrasivo_base', 'area_nominal', 1.0, count(*), NULL::numeric
  FROM tmp_obs o WHERE o.papel = 'abrasivo_base' AND o.unidade = 'M2';

  SELECT count(*) INTO v_regras FROM pcp_bom_regras;
  RETURN v_regras;
END $$;

-- ── 6) Validação: a fórmula reproduz a malha? ──────────────────────────────
CREATE OR REPLACE VIEW public.vw_pcp_bom_validacao
WITH (security_invoker = true) AS
WITH comp AS (
  SELECT c.*, pai.linha_modelo, pai.largura_mm, pai.comprimento_mm, pai.formato_parse,
         pai.descricao AS pai_descricao, pai.tipo_item AS pai_tipo,
         fn_pcp_papel_componente(c.componente_descricao, c.componente_familia) AS papel
  FROM vw_pcp_malha_componentes c
  JOIN pcp_itens pai ON pai.omie_codigo_produto = c.pai_codigo
  WHERE pai.tipo_item IN ('cinta','rolo')
),
com_regra AS (
  SELECT comp.*, r.coef, r.metodo, r.dispersao AS regra_dispersao,
    CASE WHEN r.linha_modelo = comp.linha_modelo THEN 'linha' WHEN r.linha_modelo = '*' THEN 'global' END AS regra_origem,
    (SELECT c2.quantidade FROM comp c2
      WHERE c2.pai_codigo = comp.pai_codigo AND c2.papel = 'cola' AND c2.unidade = 'G' LIMIT 1) AS qtd_cola_pai
  FROM comp
  LEFT JOIN LATERAL (
    SELECT coef, metodo, dispersao, linha_modelo FROM pcp_bom_regras r
    WHERE r.papel = comp.papel AND r.linha_modelo IN (comp.linha_modelo, '*')
    ORDER BY (r.linha_modelo = comp.linha_modelo) DESC
    LIMIT 1
  ) r ON comp.papel <> 'outro'
)
SELECT pai_codigo, pai_descricao, pai_tipo, linha_modelo, largura_mm, comprimento_mm,
  componente_codigo, componente_descricao, papel, quantidade AS observado, unidade, regra_origem,
  CASE
    WHEN formato_parse <> 'dimensional' THEN NULL
    WHEN papel = 'abrasivo_base' AND unidade = 'M2' THEN largura_mm::numeric * comprimento_mm / 1e6
    WHEN papel = 'cola'        AND unidade = 'G'  AND metodo = 'g_por_mm_largura'   THEN coef * largura_mm
    WHEN papel = 'catalisador' AND unidade = 'G'  AND metodo = 'razao_sobre_cola'   THEN coef * qtd_cola_pai
    WHEN papel = 'fita'        AND unidade = 'CM' AND metodo = 'cm_overlap_largura' THEN largura_mm / 10.0 + coef
  END AS esperado,
  CASE WHEN papel = 'abrasivo_base'
       THEN coalesce((SELECT (value)::numeric FROM pcp_config WHERE key = 'tolerancia_abrasivo'), 0.005)
       ELSE coalesce((SELECT (value)::numeric FROM pcp_config WHERE key = 'tolerancia_insumo'), 0.05)
  END AS tolerancia,
  CASE
    WHEN formato_parse <> 'dimensional' THEN 'sem_dims'
    WHEN papel = 'outro' THEN 'papel_desconhecido'
    WHEN papel = 'abrasivo_base' AND unidade IS DISTINCT FROM 'M2' THEN 'unidade_inesperada'
    WHEN papel IN ('cola','catalisador') AND unidade IS DISTINCT FROM 'G' THEN 'unidade_inesperada'
    WHEN papel = 'fita' AND unidade IS DISTINCT FROM 'CM' THEN 'unidade_inesperada'
    WHEN coef IS NULL AND papel <> 'abrasivo_base' THEN 'sem_regra'
    WHEN papel = 'catalisador' AND qtd_cola_pai IS NULL THEN 'sem_base_cola'
    -- regra instável (painel Claude P1 + Codex): dispersão alta = mediana possivelmente
    -- contaminada na 1ª destilação — NÃO valida ninguém; revisão humana.
    WHEN papel <> 'abrasivo_base' AND regra_dispersao >
         coalesce((SELECT (value)::numeric FROM pcp_config WHERE key = 'dispersao_max_regra'), 0.10)
      THEN 'regra_instavel'
    WHEN quantidade IS NULL THEN 'sem_quantidade'
    WHEN abs(quantidade - (CASE
        WHEN papel = 'abrasivo_base' THEN largura_mm::numeric * comprimento_mm / 1e6
        WHEN papel = 'cola' THEN coef * largura_mm
        WHEN papel = 'catalisador' THEN coef * qtd_cola_pai
        WHEN papel = 'fita' THEN largura_mm / 10.0 + coef END))
       / NULLIF((CASE
        WHEN papel = 'abrasivo_base' THEN largura_mm::numeric * comprimento_mm / 1e6
        WHEN papel = 'cola' THEN coef * largura_mm
        WHEN papel = 'catalisador' THEN coef * qtd_cola_pai
        WHEN papel = 'fita' THEN largura_mm / 10.0 + coef END), 0)
      <= (CASE WHEN papel = 'abrasivo_base'
           THEN coalesce((SELECT (value)::numeric FROM pcp_config WHERE key = 'tolerancia_abrasivo'), 0.005)
           ELSE coalesce((SELECT (value)::numeric FROM pcp_config WHERE key = 'tolerancia_insumo'), 0.05) END)
      THEN 'ok'
    ELSE 'excecao'
  END AS status
FROM com_regra;

-- ── 7) Exceções materializadas (fila de revisão do founder) ────────────────
CREATE TABLE IF NOT EXISTS public.pcp_bom_excecoes (
  pai_codigo bigint NOT NULL,
  componente_codigo bigint,
  papel text NOT NULL,
  pai_descricao text,
  componente_descricao text,
  observado numeric,
  esperado numeric,
  unidade text,
  status text NOT NULL,
  materializado_em timestamptz NOT NULL DEFAULT now(),
  disposicao text CHECK (disposicao IN ('aceitar','corrigir_omie','regra_especifica')),
  disposicao_nota text,
  PRIMARY KEY (pai_codigo, papel, componente_codigo)
);

CREATE OR REPLACE FUNCTION public.fn_pcp_materializar_excecoes()
RETURNS int LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v int;
BEGIN
  DELETE FROM pcp_bom_excecoes WHERE disposicao IS NULL;
  INSERT INTO pcp_bom_excecoes (pai_codigo, componente_codigo, papel, pai_descricao,
    componente_descricao, observado, esperado, unidade, status)
  SELECT pai_codigo, coalesce(componente_codigo, 0), papel, pai_descricao,
    componente_descricao, observado, esperado, unidade, status
  FROM vw_pcp_bom_validacao
  WHERE status IN ('excecao','sem_regra','unidade_inesperada','papel_desconhecido','sem_quantidade','sem_base_cola','regra_instavel')
  ON CONFLICT (pai_codigo, papel, componente_codigo) DO UPDATE
    SET observado = EXCLUDED.observado, esperado = EXCLUDED.esperado,
        status = EXCLUDED.status, materializado_em = now();
  GET DIAGNOSTICS v = ROW_COUNT;
  RETURN v;
END $$;

-- Helper de triagem (painel Gemini P1 — fricção do founder): 1 chamada em vez de UPDATE cru.
-- SECURITY DEFINER com gate de staff INTERNO (fail-closed); chamável por RPC do app no futuro.
CREATE OR REPLACE FUNCTION public.fn_pcp_dispor_excecao(
  p_pai bigint, p_papel text, p_componente bigint, p_disposicao text, p_nota text DEFAULT NULL)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  -- Gate de staff. auth.uid() lê o GUC do JWT e funciona sob SECURITY DEFINER;
  -- current_user NÃO serve (em SECURITY DEFINER é o OWNER=postgres → furaria o gate, deixando
  -- QUALQUER authenticated dispor). auth.uid() NULL = sem JWT (postgres no SQL Editor / service_role):
  -- chamada confiável, permitida. authenticated COM uid não-staff é barrado.
  IF (SELECT auth.uid()) IS NOT NULL
     AND NOT (has_role((SELECT auth.uid()), 'master'::app_role)
           OR has_role((SELECT auth.uid()), 'employee'::app_role)) THEN
    RAISE EXCEPTION 'fn_pcp_dispor_excecao: apenas staff';
  END IF;
  UPDATE pcp_bom_excecoes
     SET disposicao = p_disposicao, disposicao_nota = p_nota
   WHERE pai_codigo = p_pai AND papel = p_papel AND componente_codigo = coalesce(p_componente, 0);
  RETURN FOUND;
END $$;

-- ── 8) RLS + grants ────────────────────────────────────────────────────────
ALTER TABLE public.pcp_config       ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.pcp_itens        ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.pcp_bom_regras   ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.pcp_bom_excecoes ENABLE ROW LEVEL SECURITY;

-- DROP IF EXISTS antes de cada policy: re-colar no SQL Editor é esperado (mesma regra do M1).
DROP POLICY IF EXISTS pcp_config_select_staff ON public.pcp_config;
CREATE POLICY pcp_config_select_staff ON public.pcp_config FOR SELECT TO authenticated
  USING (has_role((SELECT auth.uid()), 'master'::app_role) OR has_role((SELECT auth.uid()), 'employee'::app_role));
DROP POLICY IF EXISTS pcp_itens_select_staff ON public.pcp_itens;
CREATE POLICY pcp_itens_select_staff ON public.pcp_itens FOR SELECT TO authenticated
  USING (has_role((SELECT auth.uid()), 'master'::app_role) OR has_role((SELECT auth.uid()), 'employee'::app_role));
DROP POLICY IF EXISTS pcp_bom_regras_select_staff ON public.pcp_bom_regras;
CREATE POLICY pcp_bom_regras_select_staff ON public.pcp_bom_regras FOR SELECT TO authenticated
  USING (has_role((SELECT auth.uid()), 'master'::app_role) OR has_role((SELECT auth.uid()), 'employee'::app_role));
DROP POLICY IF EXISTS pcp_bom_excecoes_select_staff ON public.pcp_bom_excecoes;
CREATE POLICY pcp_bom_excecoes_select_staff ON public.pcp_bom_excecoes FOR SELECT TO authenticated
  USING (has_role((SELECT auth.uid()), 'master'::app_role) OR has_role((SELECT auth.uid()), 'employee'::app_role));
-- founder marca disposição pela UI futura; hoje SQL Editor. Policy de UPDATE restrita a staff:
DROP POLICY IF EXISTS pcp_bom_excecoes_update_staff ON public.pcp_bom_excecoes;
CREATE POLICY pcp_bom_excecoes_update_staff ON public.pcp_bom_excecoes FOR UPDATE TO authenticated
  USING (has_role((SELECT auth.uid()), 'master'::app_role) OR has_role((SELECT auth.uid()), 'employee'::app_role))
  WITH CHECK (has_role((SELECT auth.uid()), 'master'::app_role) OR has_role((SELECT auth.uid()), 'employee'::app_role));

REVOKE ALL ON public.pcp_config, public.pcp_itens, public.pcp_bom_regras, public.pcp_bom_excecoes FROM anon;
REVOKE ALL ON public.pcp_config, public.pcp_itens, public.pcp_bom_regras, public.pcp_bom_excecoes FROM authenticated;
GRANT SELECT ON public.pcp_config, public.pcp_itens, public.pcp_bom_regras, public.pcp_bom_excecoes TO authenticated;
GRANT UPDATE (disposicao, disposicao_nota) ON public.pcp_bom_excecoes TO authenticated;

REVOKE ALL ON public.vw_pcp_malha_itens, public.vw_pcp_malha_componentes, public.vw_pcp_bom_validacao FROM anon;
GRANT SELECT ON public.vw_pcp_malha_itens, public.vw_pcp_malha_componentes, public.vw_pcp_bom_validacao TO authenticated;

-- Funções mutadoras: só service_role/postgres (gate na fronteira; edge/SQL Editor).
REVOKE EXECUTE ON FUNCTION public.fn_pcp_refresh_itens() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.fn_pcp_destilar_bom() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.fn_pcp_materializar_excecoes() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_pcp_parse_dimensoes(text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.fn_pcp_papel_componente(text, text) TO authenticated;
-- dispor_excecao: gate de staff é INTERNO (fail-closed) — anon fora, authenticated pode chamar
REVOKE EXECUTE ON FUNCTION public.fn_pcp_dispor_excecao(bigint, text, bigint, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fn_pcp_dispor_excecao(bigint, text, bigint, text, text) TO authenticated;

COMMIT;
