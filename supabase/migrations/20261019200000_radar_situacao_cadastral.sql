-- =============================================================================
-- Radar: SITUAÇÃO CADASTRAL (RFB) de quem já conhecemos — tabela + aplicação no finalize do lote
-- =============================================================================
-- Problema (medido na 1ª carga automática, lote 2026-08, 2026-10-19): 52.262 empresas sumiram do
-- dump entre 2026-05 e 2026-08 e SEGUEM na fila de prospecção com `ultimo_lote` antigo; 251 delas
-- são clientes. Sumir ≠ baixa (pode ser troca de CNAE principal) — a regra precisa da situação
-- cadastral EXTRAÍDA (02 ativa · 03 suspensa · 04 inapta · 08 baixada · 01 nula), não da ausência.
--
-- O que entra (idempotente; envelope BEGIN/COMMIT para SQL Editor/MCP; postcondição DO $post$):
--   1. `radar_situacao_cadastral` (cnpj, lote) — foto por lote de TODO CNPJ conhecido (radar ∪ clientes),
--      em qualquer situação. Sem FK para radar_empresas: cliente fora do radar também entra.
--      `alertado_em` = dedupe do aviso ao gestor (coluna dedicada, 1 escritor: radar_aplicar_situacao).
--   2. `radar_empresas.rfb_situacao/_data/_lote` — denormalização lida pela UI (select('*'), selo na
--      linha e na ficha). 1 escritor: radar_aplicar_situacao. O upsert do chunk NÃO toca essas colunas.
--   3. `radar_docs_clientes()` — espelho da normalização de documento de radar_recruzar_ja_cliente()
--      (20261019150000), devolvendo também o nome; a função viva NÃO é tocada (arquivo quente).
--   4. `radar_cnpjs_conhecidos(p_apos, p_limite)` — keyset para a edge entregar à carga a lista
--      radar ∪ clientes (ação `cnpjs_conhecidos`).
--   5. `radar_aplicar_situacao(p_lote, p_agora)` — chamada pela edge no finalize, DEPOIS do recruzar:
--      (a) foto do lote → colunas rfb_* (nunca regride para lote mais velho);
--      (b) LEAD (não-cliente, status ∉ descartado/virou_cliente) com 03/04/08 → descartado, com
--          linha em radar_contatos (criado_por = UUID DE SISTEMA, abaixo) e descarte_motivo;
--      (c) CLIENTE (ja_cliente OU documento nas fontes) com 03/04/08 visto pela 1ª VEZ para o par
--          (cnpj, situacao) → UMA linha em fornecedor_alerta por lote (e-mail ao gestor via
--          dispatch-notifications), com DENOMINADOR "de M clientes verificados"; marca alertado_em.
--          Nunca repete o aviso do mesmo (cnpj, situacao) em lotes seguintes.
--      (d) 02/01: só (a). Ausente ≠ zero: quem não tem linha no lote não muda de estado.
--
-- UUID DE SISTEMA (radar_contatos.criado_por é NOT NULL sem default e sem FK; as RPCs humanas gravam
-- auth.uid()): '00000000-0000-0000-0000-00000000ad0f' identifica "Radar · RFB (automático)". Não é
-- um auth.users; desfazer_contato_radar (filtra criado_por = auth.uid()) não desfaz linha de sistema
-- — por desenho: a verdade cadastral veio da Receita, não de um clique.
--
-- Prova PG17: db/test-radar-situacao-cadastral.sh (nucleo-ci.txt, --falsificar).
-- Diário: docs/historico/radar-situacao-cadastral.md
-- =============================================================================
BEGIN;

-- 1) Foto por lote ---------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.radar_situacao_cadastral (
  cnpj             text NOT NULL CHECK (cnpj ~ '^[0-9A-Z]{12}[0-9]{2}$'),
  lote             text NOT NULL CHECK (lote ~ '^[0-9]{4}-[0-9]{2}$'),
  situacao         text NOT NULL CHECK (situacao IN ('01','02','03','04','08')),
  data_situacao    date,
  motivo_codigo    text,
  motivo_descricao text,
  observado_em     timestamptz NOT NULL DEFAULT now(),
  alertado_em      timestamptz,   -- 1 escritor: radar_aplicar_situacao (dedupe do aviso ao gestor)
  PRIMARY KEY (cnpj, lote)
);
COMMENT ON TABLE public.radar_situacao_cadastral IS
  'Situação cadastral RFB por (cnpj, lote) de todo CNPJ conhecido (radar ∪ clientes). Escrita: edge radar-ingest (chunk_situacao, service_role). alertado_em só por radar_aplicar_situacao.';
CREATE INDEX IF NOT EXISTS idx_radar_situacao_lote_sit
  ON public.radar_situacao_cadastral (lote, situacao);
CREATE INDEX IF NOT EXISTS idx_radar_situacao_cnpj_alertado
  ON public.radar_situacao_cadastral (cnpj, situacao) WHERE alertado_em IS NOT NULL;

ALTER TABLE public.radar_situacao_cadastral ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "radar_situacao_cadastral_select_gestor" ON public.radar_situacao_cadastral;
CREATE POLICY "radar_situacao_cadastral_select_gestor" ON public.radar_situacao_cadastral
  FOR SELECT TO authenticated
  USING (public.pode_ver_carteira_completa((SELECT auth.uid())));
-- (sem policy de escrita para authenticated: service_role bypassa RLS, como nas demais radar_*)
REVOKE ALL ON TABLE public.radar_situacao_cadastral FROM anon, PUBLIC;

-- 2) Denormalização lida pela UI (1 escritor) --------------------------------------------------------
ALTER TABLE public.radar_empresas
  ADD COLUMN IF NOT EXISTS rfb_situacao      text,
  ADD COLUMN IF NOT EXISTS rfb_situacao_data date,
  ADD COLUMN IF NOT EXISTS rfb_situacao_lote text;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'radar_empresas_rfb_situacao_check') THEN
    ALTER TABLE public.radar_empresas
      ADD CONSTRAINT radar_empresas_rfb_situacao_check
      CHECK (rfb_situacao IS NULL OR rfb_situacao IN ('01','02','03','04','08'));
  END IF;
END $$;
COMMENT ON COLUMN public.radar_empresas.rfb_situacao IS
  'Situação cadastral RFB (01 nula · 02 ativa · 03 suspensa · 04 inapta · 08 baixada) do último lote aplicado. 1 escritor: radar_aplicar_situacao.';
COMMENT ON COLUMN public.radar_contatos.criado_por IS
  'auth.uid() do gestor nas RPCs humanas; 00000000-0000-0000-0000-00000000ad0f = Radar · RFB (automático, radar_aplicar_situacao).';

-- 3) Documentos de clientes com nome — ESPELHO da normalização de radar_recruzar_ja_cliente() -------
--    (20261019150000: numérico = só dígitos; alfanumérico = btrim+upper só para documento cru ou com a
--    máscara exata 00.000.000/0000-00; filtro final no formato RFB jul/2026). Mantenha os dois iguais —
--    a prova PG17 compara os conjuntos num seed.
CREATE OR REPLACE FUNCTION public.radar_docs_clientes()
RETURNS TABLE (doc text, nome text)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  WITH brutos AS (
    SELECT document AS bruto,
           COALESCE(NULLIF(btrim(razao_social), ''), NULLIF(btrim(name), '')) AS nome
      FROM public.profiles WHERE document IS NOT NULL
    UNION ALL
    SELECT cnpj_cpf,
           COALESCE(NULLIF(btrim(razao_social), ''), NULLIF(btrim(nome_fantasia), ''))
      FROM public.omie_clientes_nao_vinculados WHERE cnpj_cpf IS NOT NULL
  ),
  alnum AS (
    SELECT regexp_replace(d, '[-./]', '', 'g') AS doc, nome
      FROM (SELECT btrim(upper(bruto)) AS d, nome FROM brutos) x
     WHERE d ~ '^[0-9A-Z]{12}[0-9]{2}$'
        OR d ~ '^[0-9A-Z]{2}[.][0-9A-Z]{3}[.][0-9A-Z]{3}/[0-9A-Z]{4}-[0-9]{2}$'
  ),
  candidatos AS (
    SELECT regexp_replace(bruto, '[^0-9]', '', 'g') AS doc, nome FROM brutos
    UNION ALL
    SELECT doc, nome FROM alnum
  )
  SELECT DISTINCT ON (doc) doc, nome
    FROM candidatos
   WHERE doc ~ '^[0-9A-Z]{12}[0-9]{2}$'
   ORDER BY doc, nome NULLS LAST;
$$;

-- 4) Lista radar ∪ clientes para a carga (keyset: devolve até p_limite CNPJs > p_apos, ordenados) ----
CREATE OR REPLACE FUNCTION public.radar_cnpjs_conhecidos(p_apos text DEFAULT '', p_limite integer DEFAULT 50000)
RETURNS text[]
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT COALESCE(array_agg(cnpj ORDER BY cnpj), '{}'::text[])
    FROM (
      SELECT cnpj
        FROM (
          SELECT cnpj FROM public.radar_empresas WHERE cnpj > COALESCE(p_apos, '')
          UNION
          SELECT doc FROM public.radar_docs_clientes() WHERE doc > COALESCE(p_apos, '')
        ) u
       ORDER BY cnpj
       LIMIT LEAST(GREATEST(COALESCE(p_limite, 50000), 1), 50000)
    ) pagina;
$$;

-- 5) Texto único da situação (nota do contato, descarte_motivo e linha do e-mail) --------------------
CREATE OR REPLACE FUNCTION public.radar_rfb_descricao(p_situacao text, p_data date, p_motivo_codigo text, p_motivo_descricao text)
RETURNS text
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT 'RFB: '
      || CASE p_situacao WHEN '03' THEN 'SUSPENSA' WHEN '04' THEN 'INAPTA' WHEN '08' THEN 'BAIXADA'
                         WHEN '02' THEN 'ATIVA' WHEN '01' THEN 'NULA' ELSE 'situação ' || COALESCE(p_situacao, '?') END
      || ' em ' || COALESCE(to_char(p_data, 'DD/MM/YYYY'), 'data não informada')
      || ' (' || COALESCE(NULLIF(btrim(p_motivo_codigo), '') || ' — ' || NULLIF(btrim(p_motivo_descricao), ''),
                          NULLIF(btrim(p_motivo_codigo), ''), 'motivo não informado') || ')';
$$;

-- 6) Aplicação do lote --------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.radar_aplicar_situacao(p_lote text, p_agora timestamptz DEFAULT now())
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  c_sistema      constant uuid := '00000000-0000-0000-0000-00000000ad0f';  -- Radar · RFB (automático)
  v_fotos        integer := 0;
  v_leads        integer := 0;
  v_leads_upd    integer := 0;
  v_verificados  integer := 0;
  v_irregulares  integer := 0;
  v_novos        integer := 0;
  v_marcados     integer := 0;
  v_alerta_id    bigint;
  v_linhas       text;
BEGIN
  IF p_lote IS NULL OR p_lote !~ '^[0-9]{4}-[0-9]{2}$' THEN
    RAISE EXCEPTION 'lote inválido: %', COALESCE(p_lote, '(null)') USING ERRCODE = '22023';
  END IF;
  IF p_agora IS NULL THEN
    RAISE EXCEPTION 'p_agora não pode ser NULL' USING ERRCODE = '22023';
  END IF;

  -- Documentos de clientes, uma vez por chamada (pode ser chamada 2× na mesma transação: DROP antes).
  DROP TABLE IF EXISTS tmp_rfb_clientes;
  CREATE TEMP TABLE tmp_rfb_clientes ON COMMIT DROP AS
    SELECT doc, nome FROM public.radar_docs_clientes();
  CREATE INDEX ON tmp_rfb_clientes (doc);

  -- (a) Foto do lote → radar_empresas. Nunca regride para lote mais velho; só grava quando muda.
  UPDATE public.radar_empresas re
     SET rfb_situacao = s.situacao, rfb_situacao_data = s.data_situacao, rfb_situacao_lote = s.lote,
         updated_at = p_agora
    FROM public.radar_situacao_cadastral s
   WHERE s.lote = p_lote AND s.cnpj = re.cnpj
     AND (re.rfb_situacao_lote IS NULL OR re.rfb_situacao_lote <= p_lote)
     AND (re.rfb_situacao IS DISTINCT FROM s.situacao
          OR re.rfb_situacao_data IS DISTINCT FROM s.data_situacao
          OR re.rfb_situacao_lote IS DISTINCT FROM s.lote);
  GET DIAGNOSTICS v_fotos = ROW_COUNT;

  -- Irregulares do lote (03/04/08), classificados: cliente = ja_cliente OU documento nas fontes.
  DROP TABLE IF EXISTS tmp_rfb_irreg;
  CREATE TEMP TABLE tmp_rfb_irreg ON COMMIT DROP AS
    SELECT s.cnpj, s.situacao, s.data_situacao, s.motivo_codigo, s.motivo_descricao,
           re.prospeccao_status, re.razao_social,
           (re.cnpj IS NOT NULL) AS no_radar,
           -- vigente: o lote não é mais velho do que a foto já conhecida da empresa (re-rodar um mês
           -- antigo não descarta nem avisa com dado superado; fora do radar não há memória → vigente).
           (re.cnpj IS NULL OR COALESCE(re.rfb_situacao_lote, p_lote) <= p_lote) AS vigente,
           (COALESCE(re.ja_cliente, false) OR c.doc IS NOT NULL) AS cliente,
           c.nome AS nome_cliente,
           public.radar_rfb_descricao(s.situacao, s.data_situacao, s.motivo_codigo, s.motivo_descricao) AS descricao
      FROM public.radar_situacao_cadastral s
      LEFT JOIN public.radar_empresas re ON re.cnpj = s.cnpj
      LEFT JOIN tmp_rfb_clientes c ON c.doc = s.cnpj
     WHERE s.lote = p_lote AND s.situacao IN ('03','04','08');

  -- (b) LEAD irregular → descartado (append no histórico + estado). Re-rodar o lote: já descartado → 0.
  INSERT INTO public.radar_contatos (cnpj, acao, nota, criado_por, status_anterior, created_at)
  SELECT i.cnpj, 'descartado', i.descricao, c_sistema, i.prospeccao_status, p_agora
    FROM tmp_rfb_irreg i
   WHERE i.no_radar AND i.vigente AND NOT i.cliente
     AND i.prospeccao_status NOT IN ('descartado', 'virou_cliente');
  GET DIAGNOSTICS v_leads = ROW_COUNT;

  UPDATE public.radar_empresas re
     SET prospeccao_status = 'descartado', descarte_motivo = i.descricao,
         prospeccao_atualizado_em = p_agora, updated_at = p_agora
    FROM tmp_rfb_irreg i
   WHERE i.cnpj = re.cnpj AND i.no_radar AND i.vigente AND NOT i.cliente
     AND re.prospeccao_status NOT IN ('descartado', 'virou_cliente');
  GET DIAGNOSTICS v_leads_upd = ROW_COUNT;
  IF v_leads_upd <> v_leads THEN
    RAISE EXCEPTION 'radar_aplicar_situacao: histórico (%) e estado (%) divergiram no descarte do lote %',
      v_leads, v_leads_upd, p_lote USING ERRCODE = '25000';
  END IF;

  -- (c) CLIENTE irregular NOVO: nunca avisado para o mesmo (cnpj, situacao) — em lote nenhum.
  DROP TABLE IF EXISTS tmp_rfb_novos;
  CREATE TEMP TABLE tmp_rfb_novos ON COMMIT DROP AS
    SELECT i.*
      FROM tmp_rfb_irreg i
     WHERE i.cliente AND i.vigente
       AND NOT EXISTS (SELECT 1 FROM public.radar_situacao_cadastral a
                        WHERE a.cnpj = i.cnpj AND a.situacao = i.situacao AND a.alertado_em IS NOT NULL);

  SELECT count(*) INTO v_irregulares FROM tmp_rfb_irreg WHERE cliente AND vigente;
  SELECT count(*) INTO v_novos FROM tmp_rfb_novos;
  -- Denominador: clientes distintos com linha de situação NESTE lote (dentro e fora do radar).
  SELECT count(DISTINCT s.cnpj) INTO v_verificados
    FROM public.radar_situacao_cadastral s
    LEFT JOIN public.radar_empresas re ON re.cnpj = s.cnpj
    LEFT JOIN tmp_rfb_clientes c ON c.doc = s.cnpj
   WHERE s.lote = p_lote AND (COALESCE(re.ja_cliente, false) OR c.doc IS NOT NULL);

  IF v_novos > 0 THEN
    SELECT string_agg(
             COALESCE(NULLIF(btrim(n.razao_social), ''), NULLIF(btrim(n.nome_cliente), ''), 'razão social não informada')
             || ' (' || substr(n.cnpj, 1, 2) || '.' || substr(n.cnpj, 3, 3) || '.' || substr(n.cnpj, 6, 3)
             || '/' || substr(n.cnpj, 9, 4) || '-' || substr(n.cnpj, 13, 2) || '): ' || n.descricao,
             E'\n' ORDER BY n.situacao DESC, n.data_situacao DESC NULLS LAST, n.cnpj)
      INTO v_linhas
      FROM tmp_rfb_novos n;

    INSERT INTO public.fornecedor_alerta (empresa, tipo, severidade, titulo, mensagem, status, metadata)
    VALUES (
      'oben', 'outro', 'atencao',
      '[Radar] ' || v_novos || ' cliente(s) com baixa/inaptidão no lote ' || p_lote,
      'Clientes com situação cadastral irregular na Receita Federal (dump de CNPJ ' || p_lote || '), '
        || 'vistos pela primeira vez nesta situação:' || E'\n\n' || v_linhas || E'\n\n'
        || 'de ' || v_verificados || ' clientes verificados neste lote ('
        || v_irregulares || ' irregular(es) no total, ' || v_novos || ' novo(s)). '
        || 'Fonte: dados abertos de CNPJ da RFB — confira o cartão CNPJ antes de agir; '
        || 'leads na mesma situação foram descartados automaticamente no Radar.',
      'pendente_notificacao',
      jsonb_build_object('origem', 'radar_situacao_cadastral', 'lote', p_lote,
                         'cnpjs', (SELECT jsonb_agg(cnpj ORDER BY cnpj) FROM tmp_rfb_novos))
    )
    RETURNING id INTO v_alerta_id;
    IF v_alerta_id IS NULL THEN
      RAISE EXCEPTION 'radar_aplicar_situacao: fornecedor_alerta não materializou o aviso do lote %', p_lote
        USING ERRCODE = '25000';
    END IF;

    UPDATE public.radar_situacao_cadastral a
       SET alertado_em = p_agora
      FROM tmp_rfb_novos n
     WHERE a.cnpj = n.cnpj AND a.lote = p_lote;
    GET DIAGNOSTICS v_marcados = ROW_COUNT;
    IF v_marcados <> v_novos THEN
      RAISE EXCEPTION 'radar_aplicar_situacao: alertado_em marcou % de % linhas no lote %', v_marcados, v_novos, p_lote
        USING ERRCODE = '25000';
    END IF;
  END IF;

  RETURN jsonb_build_object(
    'lote', p_lote,
    'fotos_atualizadas', v_fotos,
    'leads_descartados', v_leads,
    'clientes_verificados', v_verificados,
    'clientes_irregulares', v_irregulares,
    'clientes_alertados_novos', v_novos,
    'alerta_id', v_alerta_id
  );
END;
$$;
COMMENT ON FUNCTION public.radar_aplicar_situacao(text, timestamptz) IS
  'Finalize do lote do Radar: foto RFB → rfb_* em radar_empresas; lead 03/04/08 → descartado (radar_contatos, criado_por de sistema); cliente 03/04/08 novo → 1 fornecedor_alerta por lote com denominador; dedupe por (cnpj, situacao) em alertado_em.';

-- ACL: só service_role (edge) e o owner. REVOKE nas duas pontas (PUBLIC e anon) + GRANT explícito.
REVOKE ALL ON FUNCTION public.radar_docs_clientes() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.radar_docs_clientes() TO service_role;
REVOKE ALL ON FUNCTION public.radar_cnpjs_conhecidos(text, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.radar_cnpjs_conhecidos(text, integer) TO service_role;
REVOKE ALL ON FUNCTION public.radar_aplicar_situacao(text, timestamptz) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.radar_aplicar_situacao(text, timestamptz) TO service_role;

-- 7) Postcondição: aborta o apply se qualquer peça faltar ou estiver insuficiente --------------------
DO $post$
DECLARE
  f text;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.radar_situacao_cadastral'::regclass AND contype = 'p'
      AND conkey = ARRAY[1::smallint, 2::smallint]
  ) THEN
    RAISE EXCEPTION 'A1 FALHOU: radar_situacao_cadastral sem PK (cnpj, lote) — o upsert do chunk_situacao não teria conflito e duplicaria';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_class WHERE oid = 'public.radar_situacao_cadastral'::regclass AND relrowsecurity) THEN
    RAISE EXCEPTION 'A2 FALHOU: radar_situacao_cadastral sem RLS';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'radar_situacao_cadastral'
                   AND policyname = 'radar_situacao_cadastral_select_gestor' AND cmd = 'SELECT') THEN
    RAISE EXCEPTION 'A3 FALHOU: policy de leitura do gestor ausente em radar_situacao_cadastral';
  END IF;
  IF (SELECT count(*) FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'radar_empresas'
         AND column_name IN ('rfb_situacao', 'rfb_situacao_data', 'rfb_situacao_lote')) <> 3 THEN
    RAISE EXCEPTION 'A4 FALHOU: radar_empresas sem as 3 colunas rfb_* — a UI não teria o selo';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'radar_empresas_rfb_situacao_check' AND convalidated) THEN
    RAISE EXCEPTION 'A5 FALHOU: CHECK radar_empresas_rfb_situacao_check ausente ou NOT VALID';
  END IF;
  FOREACH f IN ARRAY ARRAY['public.radar_docs_clientes()', 'public.radar_cnpjs_conhecidos(text, integer)',
                           'public.radar_aplicar_situacao(text, timestamptz)'] LOOP
    IF to_regprocedure(f) IS NULL THEN
      RAISE EXCEPTION 'A6 FALHOU: % ausente', f;
    END IF;
    IF NOT (SELECT prosecdef FROM pg_proc WHERE oid = to_regprocedure(f)) THEN
      RAISE EXCEPTION 'A6 FALHOU: % sem SECURITY DEFINER — a edge (service_role) não atravessaria a RLS', f;
    END IF;
    IF has_function_privilege('anon', f, 'EXECUTE')
       OR has_function_privilege('authenticated', f, 'EXECUTE')
       OR has_function_privilege('public', f, 'EXECUTE') THEN
      RAISE EXCEPTION 'A7 FALHOU: % executável por anon/authenticated/PUBLIC — qualquer sessão descartaria leads ou abriria alerta', f;
    END IF;
    IF NOT has_function_privilege('service_role', f, 'EXECUTE') THEN
      RAISE EXCEPTION 'A8 FALHOU: service_role (edge) sem EXECUTE em %', f;
    END IF;
  END LOOP;
  IF to_regprocedure('public.radar_rfb_descricao(text, date, text, text)') IS NULL THEN
    RAISE EXCEPTION 'A9 FALHOU: radar_rfb_descricao ausente';
  END IF;
  RAISE NOTICE 'radar: situação cadastral — tabela+RLS, colunas rfb_*, 3 funções SECURITY DEFINER com ACL fechada provadas';
END
$post$;

COMMIT;
