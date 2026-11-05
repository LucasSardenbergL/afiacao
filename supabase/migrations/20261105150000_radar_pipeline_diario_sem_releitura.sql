-- ============================================================
-- Mini (2026-11-05): o pipeline diário do Radar deixa de reler radar_empresas quando nada mudou.
--
-- POR QUÊ: das 06:15 às 06:39 UTC o pipeline lia ~6,4 GB do disco por dia (série de 60 s de 05/11):
--   06:16 recruzar 1,5 GB (os 2 count(*) de denominador = 2 seq scans dos 731 MB), 06:30 score 2,3 GB
--   (CTEs muni/ufs/fatores = 3 seq scans) e 06:39 agregado 2,6 GB. Em 8 dias o recruzar marcou 0
--   empresas nas 8 rodadas e o score alterou 0 linhas em 6 — relia tudo para concluir que nada mudou.
-- O QUE MUDA:
--   1. idx_radar_empresas_ja_cliente (municipio_codigo, uf) WHERE ja_cliente — ~1,5 mil linhas: as
--      contagens de já-clientes e as CTEs muni/ufs do score viram leitura de índice.
--   2. idx_radar_empresas_updated_at — max(updated_at) por 1 descida de índice (a "versão" que o score
--      já usa na guarda de concorrência).
--   3. radar_recruzar_ja_cliente_tick(): os denominadores viram ja_cliente_antes/ja_cliente_total pelo
--      índice parcial (o candidatos_antes = count(NOT ja_cliente) era o seq scan; nenhum leitor o usa).
--   4. radar_score_recalcular(): gate por impressão digital (lote, início do lote, versão da fórmula,
--      max(updated_at), nº de já-clientes) gravada em radar_score_estado no fim de rodada LIMPA. Igual →
--      não recalcula, mas REGISTRA a rodada (data_health e radar_avisar_lote leem lote_vigente dela).
--      Rede: a rodada do 7º dia recalcula de qualquer jeito. Heurístico numa corrida de commit (ver o corpo).
--   5. Semente do estado a partir da última rodada COMPLETA e limpa (pulados = 0) do lote vigente, se nada
--      foi escrito em radar_empresas depois dela — a 1ª rodada do cron depois do apply já pode pular.
-- FICA: o agregado das 06:35 depende do relógio (corte de "estabelecida" = hoje − 5 anos) e segue
--   recalculando 1×/dia — próxima fatia.
-- Recria função VIVA no molde TRAVA → PRE → CREATE → PÓS (predecessoras = corpo de prod de 2026-11-05,
-- db/fixtures/radar-pipeline-predecessoras-prod-20261105.sql). Arquivo para `bun run db:aplicar` (sem
-- BEGIN/COMMIT). Prova PG17: db/test-radar-pipeline-diario.sh.
-- ============================================================

-- TRAVA, antes de ler: ALTER sem efeito (a volatilidade VIVA) em cada função que a PRE guarda.
DO $trava$
BEGIN
  IF to_regprocedure('public.radar_score_recalcular()') IS NOT NULL THEN
    ALTER FUNCTION public.radar_score_recalcular() VOLATILE;
  END IF;
  IF to_regprocedure('public.radar_recruzar_ja_cliente_tick()') IS NOT NULL THEN
    ALTER FUNCTION public.radar_recruzar_ja_cliente_tick() VOLATILE;
  END IF;
END
$trava$;

-- PRE: md5 EXATO do corpo vivo ∈ {predecessor de prod, este}. Ausente ABORTA.
DO $pre$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT x.alvo, x.vivo, x.predecessor, x.este
      FROM (VALUES
        ('radar_score_recalcular',
         (SELECT md5(p.prosrc) FROM pg_catalog.pg_proc p WHERE p.oid = to_regprocedure('public.radar_score_recalcular()')),
         'c31dfcacae0898868b6c120556043c88', 'f61d210fe9e3a75c042cde6b8b9443bf'),
        ('radar_recruzar_ja_cliente_tick',
         (SELECT md5(p.prosrc) FROM pg_catalog.pg_proc p WHERE p.oid = to_regprocedure('public.radar_recruzar_ja_cliente_tick()')),
         '01f19eac2a57ce2dfaf6a677b73a6a0d', 'ca3ee373afecbb1312f68f394c435be6')
      ) AS x(alvo, vivo, predecessor, este)
  LOOP
    IF r.vivo IS NULL OR r.vivo NOT IN (r.predecessor, r.este) THEN
      RAISE EXCEPTION 'PRE FALHOU: % vivo (md5 %) não é o predecessor revisado nem este', r.alvo, r.vivo;
    END IF;
  END LOOP;
END
$pre$;

-- Estado do gate do score: 1 linha, 1 escritor (radar_score_recalcular, SECURITY DEFINER).
CREATE TABLE IF NOT EXISTS public.radar_score_estado (
  id               smallint PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  lote             text,
  lote_iniciado_em timestamptz,
  versao_formula   text,
  max_updated_at   timestamptz,
  ja_cliente_n     bigint,
  calculado_em     timestamptz NOT NULL
);
ALTER TABLE public.radar_score_estado ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.radar_score_estado FROM PUBLIC, anon, authenticated;
COMMENT ON TABLE public.radar_score_estado IS
  'Impressão digital do último cálculo COMPLETO do score do Radar (gate do radar_score_recalcular). Apagar a linha força o próximo cálculo.';

CREATE INDEX IF NOT EXISTS idx_radar_empresas_ja_cliente
  ON public.radar_empresas (municipio_codigo, uf) WHERE ja_cliente;
CREATE INDEX IF NOT EXISTS idx_radar_empresas_updated_at
  ON public.radar_empresas (updated_at);

CREATE OR REPLACE FUNCTION public.radar_recruzar_ja_cliente_tick()
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_ini              timestamptz := clock_timestamp();
  v_marcados         integer;
  v_ja_cliente_antes bigint;
  v_ja_cliente_total bigint;
BEGIN
  -- Denominador ANTES do trabalho (fase-sem-sinal.md), pelo índice parcial de já-clientes — nunca um
  -- count(NOT ja_cliente), que é seq scan dos 731 MB (Mini, 2026-11-05).
  SELECT count(*) INTO v_ja_cliente_antes FROM public.radar_empresas WHERE ja_cliente;

  -- Erro aqui PROPAGA de propósito (ver cabeçalho).
  v_marcados := public.radar_recruzar_ja_cliente();

  SELECT count(*) INTO v_ja_cliente_total FROM public.radar_empresas WHERE ja_cliente;

  -- Registro ao FINAL, atômico com o trabalho; fail-open: observabilidade nunca derruba o recruzamento.
  BEGIN
    INSERT INTO public.acoes_execucoes
      (acao, origem, iniciado_em, finalizado_em, status, detalhes)
    VALUES
      ('radar.recruzar_ja_cliente', 'automatica', v_ini, clock_timestamp(), 'sucesso',
       jsonb_build_object(
         'marcados', v_marcados,
         'ja_cliente_antes', v_ja_cliente_antes,
         'ja_cliente_total', v_ja_cliente_total));
  EXCEPTION WHEN OTHERS THEN
    NULL;
  END;

  RETURN v_marcados;
END;
$function$;

CREATE OR REPLACE FUNCTION public.radar_score_recalcular()
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_ini            timestamptz := clock_timestamp();
  v_vigente        text;
  v_vigente_inicio timestamptz;
  v_ref            date;
  v_resumo         jsonb;
  -- Versão da FÓRMULA gravada com o score (v4 = nova migration que troca esta constante e os pesos).
  c_versao         CONSTANT text := 'v3';
  -- Rede de segurança do gate: sem mudança detectada, a rodada diária do 7º dia recalcula mesmo assim
  -- (6 d 23 h: o cron das 06:30 nunca cai alguns ms antes do vencimento e empurra para o 8º — Codex BAIXO 3).
  -- O gate é heurístico numa corrida: transação que começou ANTES da leitura da impressão e commita DEPOIS,
  -- sem mudar o nº de já-clientes, fica invisível ao max(updated_at) — a rede de 7 dias é o teto da
  -- defasagem (Codex MÉDIO 1; os escritores reais são a ingestão, que muda o lote, e o cadastro de 1 linha).
  c_validade       CONSTANT interval := interval '6 days 23 hours';
  v_est            public.radar_score_estado%ROWTYPE;
  v_tem_estado     boolean;
  v_fp_upd         timestamptz;
  v_fp_jc          bigint;
BEGIN
  -- Um cálculo por vez: o estado do gate é lido e gravado sob a mesma trava.
  PERFORM pg_advisory_xact_lock(20261105, 1);

  -- Lote vigente: a foto mais nova que terminou. Sem ela, nada pontua (NULL honesto, nunca 0).
  SELECT s.mes_referencia, s.iniciado_em
    INTO v_vigente, v_vigente_inicio
    FROM public.radar_ingest_state s
   WHERE s.status = 'complete'
   ORDER BY s.mes_referencia DESC
   LIMIT 1;
  -- Referência de idade = 1º dia do mês do lote (dado), nunca o relógio da sessão (relogio-nu-da-sessao-gate).
  v_ref := CASE WHEN v_vigente IS NULL THEN NULL ELSE to_date(v_vigente || '-01', 'YYYY-MM-DD') END;

  -- GATE (Mini, 2026-11-05): o score só depende do lote, da fórmula, das colunas da linha (toda escrita
  -- de ingestão/recruzamento bumpa updated_at) e da contagem de já-clientes por município/UF. Nada disso
  -- depende do relógio. A impressão digital é lida ANTES do cálculo, pelos índices (max de updated_at e
  -- o parcial de ja_cliente): nunca a tabela. Igual à do último cálculo completo → não relê os 731 MB.
  SELECT max(re.updated_at) INTO v_fp_upd FROM public.radar_empresas re;
  SELECT count(*) INTO v_fp_jc FROM public.radar_empresas re WHERE re.ja_cliente;

  SELECT * INTO v_est FROM public.radar_score_estado WHERE id = 1;
  v_tem_estado := FOUND;

  IF v_tem_estado
     AND v_est.lote IS NOT DISTINCT FROM v_vigente
     AND v_est.lote_iniciado_em IS NOT DISTINCT FROM v_vigente_inicio
     AND v_est.versao_formula IS NOT DISTINCT FROM c_versao
     AND v_est.max_updated_at IS NOT DISTINCT FROM v_fp_upd
     AND v_est.ja_cliente_n IS NOT DISTINCT FROM v_fp_jc
     AND v_est.calculado_em > v_ini - c_validade THEN
    v_resumo := jsonb_build_object(
      'lote_vigente', v_vigente,
      'versao_formula', c_versao,
      'recalculou', false,
      'motivo', 'nada mudou desde o último cálculo completo',
      'ultimo_calculo_em', v_est.calculado_em,
      'duracao_ms', round(extract(epoch FROM clock_timestamp() - v_ini) * 1000)::integer);
    -- O registro diário continua (data_health e radar_avisar_lote leem lote_vigente da última rodada).
    BEGIN
      INSERT INTO public.acoes_execucoes
        (acao, origem, iniciado_em, finalizado_em, status, detalhes)
      VALUES
        ('radar.score_recalcular', 'automatica', v_ini, clock_timestamp(), 'sucesso', v_resumo);
    EXCEPTION WHEN OTHERS THEN
      NULL;
    END;
    RETURN v_resumo;
  END IF;

  -- UM comando: cálculo, UPDATE e resumo partilham o MESMO snapshot (Codex MÉDIO 3).
  WITH
  -- Pesos VERSIONADOS por esta migration. Tier da curadoria (scripts/radar/cnaes-alvo.txt), informado pela
  -- penetração medida em 2026-10-19 (ja_cliente/total por CNAE): tier 1 ≥ 0,4 %, tier 3 < 0,1 %.
  pesos_cnae(cnae, tier, pontos, rotulo) AS (VALUES
    ('3101200', 1, 25, 'móveis de madeira'),
    ('3102100', 1, 25, 'móveis de metal'),
    ('3103900', 1, 25, 'móveis de outros materiais'),
    ('2391503', 1, 25, 'marmoraria'),
    ('1629301', 1, 25, 'artefatos de madeira'),
    ('9529105', 1, 25, 'restauração de mobiliário'),
    ('1622699', 2, 15, 'carpintaria para construção'),
    ('1622602', 2, 15, 'esquadrias de madeira'),
    ('1622601', 2, 15, 'casas de madeira'),
    ('1623400', 2, 15, 'tanoaria e embalagens de madeira'),
    ('1610203', 2, 15, 'serraria'),
    ('1610204', 2, 15, 'resserragem'),
    ('1610205', 2, 15, 'tratamento de madeira'),
    ('4743100', 2, 15, 'vidraçaria'),
    ('2511000', 2, 15, 'estruturas metálicas'),
    ('2542000', 3,  8, 'serralheria'),
    ('2512800', 3,  8, 'esquadrias de metal'),
    ('2539001', 3,  8, 'usinagem e solda'),
    ('2539002', 3,  8, 'tratamento e polimento de metais'),
    ('2319200', 3,  8, 'artigos de vidro'),
    ('1621800', 3,  8, 'madeira laminada e chapas')
  ),
  -- Códigos tier 1 da curadoria, para o fator de atividade SECUNDÁRIA (v3).
  tier1 AS (
    SELECT array_agg(cnae) AS codigos FROM pesos_cnae WHERE tier = 1
  ),
  muni AS (
    SELECT e.municipio_codigo, count(*)::integer AS n
      FROM public.radar_empresas e
     WHERE e.ja_cliente AND e.municipio_codigo IS NOT NULL
     GROUP BY e.municipio_codigo
  ),
  ufs AS (
    SELECT e.uf, count(*)::integer AS n
      FROM public.radar_empresas e
     WHERE e.ja_cliente AND e.uf IS NOT NULL
     GROUP BY e.uf
  ),
  fatores AS (
    SELECT
      e.cnpj,
      e.score         AS score_atual,
      e.score_motivos AS motivos_atuais,
      e.score_versao  AS versao_formula_atual,
      e.updated_at    AS versao,          -- recruzamento e ingestão bumpam updated_at: é a versão lida
      e.ja_cliente    AS ja_cliente_lido,
      CASE
        WHEN v_vigente IS NULL          THEN 'sem lote vigente'
        WHEN e.ja_cliente               THEN 'já é cliente'
        WHEN e.ultimo_lote < v_vigente  THEN 'fora da foto vigente'
        WHEN e.ultimo_lote > v_vigente  THEN 'lote em ingestão'   -- chunk de lote `running` (Codex ALTO 1)
      END AS nulo_motivo,
      -- CNAE
      COALESCE(pc.pontos, 0) AS p_cnae,
      CASE pc.tier
        WHEN 1 THEN 'CNAE prioritário (' || pc.rotulo || ')'
        WHEN 2 THEN 'CNAE intermediário (' || pc.rotulo || ')'
        WHEN 3 THEN 'CNAE de apoio (' || pc.rotulo || ')'
      END AS m_cnae,
      -- atividade secundária prioritária (v3): principal tier 2/3 com algum secundário tier 1. Só soma.
      CASE WHEN e.cnaes_secundarios && t1.codigos THEN CASE pc.tier WHEN 2 THEN 10 WHEN 3 THEN 7 ELSE 0 END ELSE 0 END AS p_cnae_sec,
      CASE WHEN pc.tier IN (2, 3) AND e.cnaes_secundarios && t1.codigos THEN
        'atividade secundária prioritária (' ||
        (SELECT p2.rotulo FROM unnest(e.cnaes_secundarios) AS s(c) JOIN pesos_cnae p2 ON p2.cnae = s.c AND p2.tier = 1
          ORDER BY p2.cnae LIMIT 1) || ')'
      END AS m_cnae_sec,
      -- porte
      CASE e.porte WHEN '05' THEN 10 WHEN '03' THEN 8 WHEN '01' THEN 3 ELSE 0 END AS p_porte,
      CASE e.porte WHEN '05' THEN 'porte demais (médio/grande)' WHEN '03' THEN 'porte EPP' WHEN '01' THEN 'porte ME' END AS m_porte,
      -- capital social (NULL = sem ponto e sem motivo)
      CASE
        WHEN e.capital_social >= 1000000 THEN 15
        WHEN e.capital_social >=  500000 THEN 12
        WHEN e.capital_social >=  100000 THEN 10
        WHEN e.capital_social >=   50000 THEN 6
        WHEN e.capital_social >=   10000 THEN 3
        ELSE 0
      END AS p_capital,
      CASE
        WHEN e.capital_social >= 1000000 THEN 'capital ≥ R$ 1 mi'
        WHEN e.capital_social >=  500000 THEN 'capital R$ 500 mil–1 mi'
        WHEN e.capital_social >=  100000 THEN 'capital R$ 100–500 mil'
        WHEN e.capital_social >=   50000 THEN 'capital R$ 50–100 mil'
        WHEN e.capital_social >=   10000 THEN 'capital R$ 10–50 mil'
      END AS m_capital,
      -- idade na referência do lote (anos completos); o motivo cita a referência (Codex BAIXO 6)
      CASE
        WHEN e.data_abertura IS NULL OR v_ref IS NULL THEN 0
        WHEN e.data_abertura > v_ref - interval '1 year'   THEN 4
        WHEN e.data_abertura > v_ref - interval '3 years'  THEN 6
        WHEN e.data_abertura > v_ref - interval '10 years' THEN 10
        ELSE 8
      END AS p_idade,
      CASE
        WHEN e.data_abertura IS NULL OR v_ref IS NULL THEN NULL
        WHEN e.data_abertura > v_ref - interval '1 year'   THEN 'empresa com menos de 1 ano (ref. ' || v_vigente || ')'
        WHEN e.data_abertura > v_ref - interval '3 years'  THEN 'empresa com 1–3 anos (ref. ' || v_vigente || ')'
        WHEN e.data_abertura > v_ref - interval '10 years' THEN 'empresa com 3–10 anos (ref. ' || v_vigente || ')'
        ELSE 'empresa com 10+ anos (ref. ' || v_vigente || ')'
      END AS m_idade,
      -- proximidade comercial
      CASE
        WHEN m.n >= 30 THEN 20
        WHEN m.n >= 10 THEN 15
        WHEN m.n >=  3 THEN 10
        WHEN m.n >=  1 THEN 6
        WHEN u.n >= 100 THEN 5
        ELSE 0
      END AS p_prox,
      CASE
        WHEN m.n >= 1   THEN 'município com ' || m.n || ' cliente' || CASE WHEN m.n > 1 THEN 's' ELSE '' END
        WHEN u.n >= 100 THEN 'UF com ' || u.n || ' clientes'
      END AS m_prox,
      -- contato
      CASE WHEN e.telefone1 IS NOT NULL OR e.telefone2 IS NOT NULL THEN 7 ELSE 0 END AS p_tel,
      CASE WHEN e.telefone1 IS NOT NULL OR e.telefone2 IS NOT NULL THEN 'telefone disponível' END AS m_tel,
      CASE WHEN e.email IS NOT NULL THEN 3 ELSE 0 END AS p_email,
      CASE WHEN e.email IS NOT NULL THEN 'e-mail disponível' END AS m_email,
      -- inédito no lote vigente
      CASE WHEN v_vigente_inicio IS NOT NULL AND e.primeira_vista_em >= v_vigente_inicio THEN 10 ELSE 0 END AS p_inedito,
      CASE WHEN v_vigente_inicio IS NOT NULL AND e.primeira_vista_em >= v_vigente_inicio THEN 'inédito no lote ' || v_vigente END AS m_inedito
    FROM public.radar_empresas e
    CROSS JOIN tier1 t1
    LEFT JOIN pesos_cnae pc ON pc.cnae = e.cnae_principal
    LEFT JOIN muni m ON m.municipio_codigo = e.municipio_codigo
    LEFT JOIN ufs  u ON u.uf = e.uf
  ),
  calc AS (
    SELECT
      f.cnpj, f.score_atual, f.motivos_atuais, f.versao_formula_atual, f.versao, f.ja_cliente_lido,
      CASE WHEN f.nulo_motivo IS NOT NULL THEN NULL
           ELSE (f.p_cnae + f.p_cnae_sec + f.p_porte + f.p_capital + f.p_idade + f.p_prox + f.p_tel + f.p_email + f.p_inedito)::smallint
      END AS score_novo,
      CASE WHEN f.nulo_motivo IS NOT NULL THEN ARRAY[f.nulo_motivo]
           ELSE array_remove(ARRAY[f.m_cnae, f.m_cnae_sec, f.m_porte, f.m_capital, f.m_idade, f.m_prox, f.m_tel, f.m_email, f.m_inedito], NULL)
      END AS motivos_novos,
      -- Sem score não há fórmula aplicada: a versão acompanha o NULL (ausente, nunca 'v3' sobre nota inexistente).
      CASE WHEN f.nulo_motivo IS NOT NULL THEN NULL ELSE c_versao END AS versao_formula_nova
    FROM fatores f
  ),
  upd AS (
    UPDATE public.radar_empresas e
       SET score = c.score_novo,
           score_motivos = c.motivos_novos,
           score_versao = c.versao_formula_nova,
           score_em = v_ini
      FROM calc c
     WHERE c.cnpj = e.cnpj
       AND (c.score_novo, c.motivos_novos, c.versao_formula_nova) IS DISTINCT FROM (c.score_atual, c.motivos_atuais, c.versao_formula_atual)
       -- Guarda de VERSÃO (Codex ALTO 2): se a linha mudou depois do snapshot (EvalPlanQual reavalia só a
       -- linha-alvo), não grava score velho — pula e deixa para a próxima rodada.
       AND e.updated_at IS NOT DISTINCT FROM c.versao
       AND e.ja_cliente = c.ja_cliente_lido
    RETURNING e.cnpj
  )
  SELECT jsonb_build_object(
           'lote_vigente', v_vigente,
           'versao_formula', c_versao,
           'recalculou', true,
           'avaliados', count(*),
           'a_alterar', count(*) FILTER (WHERE (c.score_novo, c.motivos_novos, c.versao_formula_nova) IS DISTINCT FROM (c.score_atual, c.motivos_atuais, c.versao_formula_atual)),
           'alterados', (SELECT count(*) FROM upd),
           'pulados', count(*) FILTER (WHERE (c.score_novo, c.motivos_novos, c.versao_formula_nova) IS DISTINCT FROM (c.score_atual, c.motivos_atuais, c.versao_formula_atual)) - (SELECT count(*) FROM upd),
           'com_score', count(c.score_novo),
           'sem_score', jsonb_build_object(
             'ja_cliente',       count(*) FILTER (WHERE c.score_novo IS NULL AND c.motivos_novos = ARRAY['já é cliente']),
             'fora_da_foto',     count(*) FILTER (WHERE c.score_novo IS NULL AND c.motivos_novos = ARRAY['fora da foto vigente']),
             'lote_em_ingestao', count(*) FILTER (WHERE c.score_novo IS NULL AND c.motivos_novos = ARRAY['lote em ingestão']),
             'sem_lote',         count(*) FILTER (WHERE c.score_novo IS NULL AND c.motivos_novos = ARRAY['sem lote vigente'])),
           'faixas', jsonb_build_object(
             '0-19',   count(*) FILTER (WHERE c.score_novo BETWEEN  0 AND 19),
             '20-39',  count(*) FILTER (WHERE c.score_novo BETWEEN 20 AND 39),
             '40-59',  count(*) FILTER (WHERE c.score_novo BETWEEN 40 AND 59),
             '60-79',  count(*) FILTER (WHERE c.score_novo BETWEEN 60 AND 79),
             '80-100', count(*) FILTER (WHERE c.score_novo BETWEEN 80 AND 100)),
           'duracao_ms', round(extract(epoch FROM clock_timestamp() - v_ini) * 1000)::integer)
    INTO v_resumo
    FROM calc c;

  -- Grava a impressão digital SÓ com rodada limpa: linha pulada pela guarda de versão (mudou depois do
  -- snapshot) apaga o estado, e a próxima rodada recalcula.
  IF (v_resumo->>'pulados')::bigint = 0 THEN
    INSERT INTO public.radar_score_estado AS t
           (id, lote, lote_iniciado_em, versao_formula, max_updated_at, ja_cliente_n, calculado_em)
    VALUES (1, v_vigente, v_vigente_inicio, c_versao, v_fp_upd, v_fp_jc, v_ini)
    ON CONFLICT (id) DO UPDATE
       SET lote = EXCLUDED.lote, lote_iniciado_em = EXCLUDED.lote_iniciado_em,
           versao_formula = EXCLUDED.versao_formula, max_updated_at = EXCLUDED.max_updated_at,
           ja_cliente_n = EXCLUDED.ja_cliente_n, calculado_em = EXCLUDED.calculado_em;
  ELSE
    DELETE FROM public.radar_score_estado WHERE id = 1;
  END IF;

  -- Registro ao FINAL, atômico com o trabalho; fail-open: observabilidade nunca derruba o recálculo.
  BEGIN
    INSERT INTO public.acoes_execucoes
      (acao, origem, iniciado_em, finalizado_em, status, detalhes)
    VALUES
      ('radar.score_recalcular', 'automatica', v_ini, clock_timestamp(), 'sucesso', v_resumo);
  EXCEPTION WHEN OTHERS THEN
    NULL;
  END;

  RETURN v_resumo;
END;
$function$;

-- Semente: a última rodada completa (detalhes com 'pulados') do lote vigente, limpa, sem escrita posterior em
-- radar_empresas (todo escritor das colunas do score bumpa updated_at), É um cálculo consistente com a impressão
-- de agora. Sem isso a 1ª rodada do cron recalcularia tudo de novo. Estado já existente fica.
DO $semente$
DECLARE
  v_lote  text;
  v_ini   timestamptz;
  v_upd   timestamptz;
  v_jc    bigint;
  r_ini   timestamptz;
  r_det   jsonb;
BEGIN
  IF EXISTS (SELECT 1 FROM public.radar_score_estado) THEN
    RETURN;
  END IF;
  SELECT s.mes_referencia, s.iniciado_em INTO v_lote, v_ini
    FROM public.radar_ingest_state s WHERE s.status = 'complete' ORDER BY s.mes_referencia DESC LIMIT 1;
  SELECT e.iniciado_em, e.detalhes INTO r_ini, r_det
    FROM public.acoes_execucoes e
   WHERE e.acao = 'radar.score_recalcular' AND e.status = 'sucesso'
   ORDER BY e.iniciado_em DESC LIMIT 1;
  SELECT max(re.updated_at) INTO v_upd FROM public.radar_empresas re;
  SELECT count(*) INTO v_jc FROM public.radar_empresas re WHERE re.ja_cliente;
  IF r_ini IS NOT NULL
     AND v_lote IS NOT NULL
     AND r_det->>'lote_vigente' IS NOT DISTINCT FROM v_lote
     AND r_det->>'versao_formula' = 'v3'
     AND (r_det->>'pulados') = '0'
     AND v_upd < r_ini THEN
    INSERT INTO public.radar_score_estado
           (id, lote, lote_iniciado_em, versao_formula, max_updated_at, ja_cliente_n, calculado_em)
    VALUES (1, v_lote, v_ini, 'v3', v_upd, v_jc, r_ini);
    RAISE NOTICE 'semente do gate: estado = rodada de %', r_ini;
  ELSE
    RAISE NOTICE 'semente do gate: sem rodada limpa posterior à última escrita — a próxima rodada recalcula';
  END IF;
END
$semente$;

-- PÓS
DO $post$
DECLARE
  f text;
BEGIN
  -- P1: as 2 funções vivas são ESTE arquivo (md5 exato do prosrc).
  IF (SELECT md5(prosrc) FROM pg_catalog.pg_proc WHERE oid = to_regprocedure('public.radar_score_recalcular()'))
     IS DISTINCT FROM 'f61d210fe9e3a75c042cde6b8b9443bf' THEN
    RAISE EXCEPTION 'P1 FALHOU: radar_score_recalcular vivo não é o corpo deste arquivo';
  END IF;
  IF (SELECT md5(prosrc) FROM pg_catalog.pg_proc WHERE oid = to_regprocedure('public.radar_recruzar_ja_cliente_tick()'))
     IS DISTINCT FROM 'ca3ee373afecbb1312f68f394c435be6' THEN
    RAISE EXCEPTION 'P1 FALHOU: radar_recruzar_ja_cliente_tick vivo não é o corpo deste arquivo';
  END IF;
  -- P2: estado com RLS e fechado para anon/authenticated.
  IF NOT COALESCE((SELECT relrowsecurity FROM pg_class WHERE oid = to_regclass('public.radar_score_estado')), false) THEN
    RAISE EXCEPTION 'P2 FALHOU: radar_score_estado ausente ou sem RLS';
  END IF;
  IF has_table_privilege('anon', 'public.radar_score_estado', 'SELECT')
     OR has_table_privilege('authenticated', 'public.radar_score_estado', 'SELECT') THEN
    RAISE EXCEPTION 'P2 FALHOU: radar_score_estado legível por anon/authenticated';
  END IF;
  -- P3: índices válidos.
  IF (SELECT count(*) FROM pg_index WHERE indisvalid AND indexrelid IN
        (to_regclass('public.idx_radar_empresas_ja_cliente'), to_regclass('public.idx_radar_empresas_updated_at'))) <> 2 THEN
    RAISE EXCEPTION 'P3 FALHOU: índices novos ausentes ou inválidos';
  END IF;
  -- P4: ACL preservado (CREATE OR REPLACE mantém): service_role executa; PUBLIC/anon/authenticated não.
  FOREACH f IN ARRAY ARRAY['public.radar_score_recalcular()', 'public.radar_recruzar_ja_cliente_tick()'] LOOP
    IF NOT has_function_privilege('service_role', f, 'EXECUTE')
       OR has_function_privilege('anon', f, 'EXECUTE')
       OR has_function_privilege('authenticated', f, 'EXECUTE')
       OR EXISTS (SELECT 1 FROM pg_proc p, aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) a
                   WHERE p.oid = to_regprocedure(f) AND a.grantee = 0 AND a.privilege_type = 'EXECUTE') THEN
      RAISE EXCEPTION 'P4 FALHOU: ACL de % mudou', f;
    END IF;
  END LOOP;
END
$post$;
