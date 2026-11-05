-- Corpo VIVO de prod (psql-ro, 2026-11-05 ~14:30 UTC): predecessoras da migration 20261105150000.
-- md5(prosrc): radar_score_recalcular c31dfcacae0898868b6c120556043c88 · radar_recruzar_ja_cliente_tick 01f19eac2a57ce2dfaf6a677b73a6a0d
CREATE OR REPLACE FUNCTION public.radar_recruzar_ja_cliente()
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_marcados integer;
BEGIN
  DROP TABLE IF EXISTS tmp_docs_clientes;
  -- Duas normalizações por documento (humano digita com máscara, prefixo, minúscula):
  --   num:   só dígitos → o acervo numérico, exatamente como antes (prefixo/sufixo com letra segue casando);
  --   alnum: btrim + upper, e SÓ para documento CRU (14 posições) ou com a MÁSCARA nas posições exatas
  --          (00.000.000/0000-00); aí remove os separadores. Não apaga letra e não aceita separador fora
  --          do lugar: "aeg 123.456.789-09" e "aeg-123.456.789-09" (CPF com anotação) NÃO viram a chave
  --          AEG12345678909 por acaso (Codex, desenho + retroativo do PR #3175; precisão > recall).
  --   Os dois passam pelo formato RFB jul/2026 (12 alfanuméricos + 2 DVs numéricos = 14 posições).
  CREATE TEMP TABLE tmp_docs_clientes ON COMMIT DROP AS
    WITH brutos AS (
      SELECT document AS bruto FROM public.profiles WHERE document IS NOT NULL
      UNION ALL
      SELECT cnpj_cpf FROM public.omie_clientes_nao_vinculados WHERE cnpj_cpf IS NOT NULL
    ),
    alnum AS (
      SELECT regexp_replace(d, '[-./]', '', 'g') AS doc
      FROM (SELECT btrim(upper(bruto)) AS d FROM brutos) x
      WHERE d ~ '^[0-9A-Z]{12}[0-9]{2}$'
         OR d ~ '^[0-9A-Z]{2}[.][0-9A-Z]{3}[.][0-9A-Z]{3}/[0-9A-Z]{4}-[0-9]{2}$'
    ),
    candidatos AS (
      SELECT regexp_replace(bruto, '[^0-9]', '', 'g') AS doc FROM brutos
      UNION ALL
      SELECT doc FROM alnum
    )
    SELECT DISTINCT doc
    FROM candidatos
    WHERE doc ~ '^[0-9A-Z]{12}[0-9]{2}$';

  UPDATE public.radar_empresas re
  SET ja_cliente = true, updated_at = now()
  WHERE re.ja_cliente = false
    AND EXISTS (SELECT 1 FROM tmp_docs_clientes d WHERE d.doc = re.cnpj);

  GET DIAGNOSTICS v_marcados = ROW_COUNT;
  RETURN v_marcados;
END;
$function$
;
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
BEGIN
  -- Lote vigente: a foto mais nova que terminou. Sem ela, nada pontua (NULL honesto, nunca 0).
  SELECT s.mes_referencia, s.iniciado_em
    INTO v_vigente, v_vigente_inicio
    FROM public.radar_ingest_state s
   WHERE s.status = 'complete'
   ORDER BY s.mes_referencia DESC
   LIMIT 1;
  -- Referência de idade = 1º dia do mês do lote (dado), nunca o relógio da sessão (relogio-nu-da-sessao-gate).
  v_ref := CASE WHEN v_vigente IS NULL THEN NULL ELSE to_date(v_vigente || '-01', 'YYYY-MM-DD') END;

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
$function$
;
CREATE OR REPLACE FUNCTION public.radar_recruzar_ja_cliente_tick()
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_ini              timestamptz := clock_timestamp();
  v_marcados         integer;
  v_candidatos_antes bigint;
  v_ja_cliente_total bigint;
BEGIN
  -- Denominador ANTES do trabalho (fase-sem-sinal.md: contagem sem denominador não é sinal).
  SELECT count(*) INTO v_candidatos_antes FROM public.radar_empresas WHERE NOT ja_cliente;

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
         'candidatos_antes', v_candidatos_antes,
         'ja_cliente_total', v_ja_cliente_total));
  EXCEPTION WHEN OTHERS THEN
    NULL;
  END;

  RETURN v_marcados;
END;
$function$
;
