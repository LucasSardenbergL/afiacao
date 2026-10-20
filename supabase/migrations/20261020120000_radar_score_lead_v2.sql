-- ============================================================
-- Radar de Clientes — score de lead v2: achados do Codex adversarial no #3214 (parecer gpt-6-astra · max ·
-- 538 s · 178.416 tokens). A v1 (20261019180000) está APLICADA em prod — esta recria a função VIVA no
-- molde TRAVA → PRE → CREATE → PÓS (sql-house-style, "Recriar objeto VIVO"). Colunas, índice e cron ficam.
--
-- O que muda em `radar_score_recalcular()`:
--   • ALTO 1 — pertencimento EXATO ao lote vigente: `ultimo_lote > vigente` (chunks de um lote `running`
--     já gravados pela edge) pontuava com "inédito no lote <anterior>". Agora: NULL {lote em ingestão}.
--   • ALTO 2 — guarda de VERSÃO no UPDATE: em READ COMMITTED o `UPDATE … FROM calc` espera o row-lock do
--     recruzamento/ingestão e, ao soltar, reavalia só a linha-alvo (EvalPlanQual) com o `calc` do snapshot
--     velho — gravaria 21 numa empresa que virou cliente, ou o score do capital antigo. Agora o WHERE exige
--     `updated_at`/`ja_cliente` iguais aos lidos (os dois escritores bumpam updated_at): linha que mudou sob
--     os pés é PULADA (`pulados` no ledger) e recalculada na rodada seguinte — nunca score velho.
--   • MÉDIO 3 — ledger do MESMO snapshot: resumo e UPDATE num único comando (CTE modificadora); `avaliados`,
--     faixas e `sem_score` vêm de `calc`, `alterados` do RETURNING. Antes, um chunk inserido entre o UPDATE
--     e o SELECT entrava em `avaliados` sem ter sido lido.
--   • BAIXO 6 — o motivo de idade cita a referência ("empresa com 3–10 anos (ref. 2026-08)"): a ficha mostra
--     a idade de hoje e o motivo era calculado no mês do lote — duas idades sem reconciliação.
--   • Pesos, fatores e NULLs continuam os da v1 (MÉDIO 5 virou prova: escada de capital nas bordas das faixas).
--
-- DONO: aplicar como `postgres` (SQL Editor do Lovable ou conector MCP). Idempotente (PRE aceita o corpo da
-- v1 ou este). Prova: db/test-radar-score.sh (aplica v1 → v2, como prod; --falsificar; prova de concorrência
-- com duas sessões).
-- ============================================================

BEGIN;

-- TRAVA, antes de ler: ALTER sem efeito (volatilidade VIVA = VOLATILE) prende a função até o COMMIT.
DO $trava$
BEGIN
  IF to_regprocedure('public.radar_score_recalcular()') IS NOT NULL THEN
    ALTER FUNCTION public.radar_score_recalcular() VOLATILE;
  END IF;
END
$trava$;

-- PRE: o corpo vivo é a v1 revisada (20261019180000) ou este. Ausente/outro ABORTA.
DO $pre$
DECLARE
  v_vivo text;
BEGIN
  SELECT md5(p.prosrc) INTO v_vivo FROM pg_proc p WHERE p.oid = to_regprocedure('public.radar_score_recalcular()');
  IF v_vivo IS NULL OR v_vivo NOT IN ('02025c570310d1da858337c20c54e65c', '5413669a9a67105b6c0a7e5037e2a80d') THEN
    RAISE EXCEPTION 'PRE FALHOU: radar_score_recalcular vivo (md5 %) não é a v1 revisada nem esta v2 — outra sessão mexeu; não sobrescrever', v_vivo;
  END IF;
END
$pre$;

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
        WHEN 2 THEN 'CNAE secundário (' || pc.rotulo || ')'
        WHEN 3 THEN 'CNAE de apoio (' || pc.rotulo || ')'
      END AS m_cnae,
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
    LEFT JOIN pesos_cnae pc ON pc.cnae = e.cnae_principal
    LEFT JOIN muni m ON m.municipio_codigo = e.municipio_codigo
    LEFT JOIN ufs  u ON u.uf = e.uf
  ),
  calc AS (
    SELECT
      f.cnpj, f.score_atual, f.motivos_atuais, f.versao, f.ja_cliente_lido,
      CASE WHEN f.nulo_motivo IS NOT NULL THEN NULL
           ELSE (f.p_cnae + f.p_porte + f.p_capital + f.p_idade + f.p_prox + f.p_tel + f.p_email + f.p_inedito)::smallint
      END AS score_novo,
      CASE WHEN f.nulo_motivo IS NOT NULL THEN ARRAY[f.nulo_motivo]
           ELSE array_remove(ARRAY[f.m_cnae, f.m_porte, f.m_capital, f.m_idade, f.m_prox, f.m_tel, f.m_email, f.m_inedito], NULL)
      END AS motivos_novos
    FROM fatores f
  ),
  upd AS (
    UPDATE public.radar_empresas e
       SET score = c.score_novo,
           score_motivos = c.motivos_novos,
           score_em = v_ini
      FROM calc c
     WHERE c.cnpj = e.cnpj
       AND (c.score_novo, c.motivos_novos) IS DISTINCT FROM (c.score_atual, c.motivos_atuais)
       -- Guarda de VERSÃO (Codex ALTO 2): se a linha mudou depois do snapshot (EvalPlanQual reavalia só a
       -- linha-alvo), não grava score velho — pula e deixa para a próxima rodada.
       AND e.updated_at IS NOT DISTINCT FROM c.versao
       AND e.ja_cliente = c.ja_cliente_lido
    RETURNING e.cnpj
  )
  SELECT jsonb_build_object(
           'lote_vigente', v_vigente,
           'avaliados', count(*),
           'a_alterar', count(*) FILTER (WHERE (c.score_novo, c.motivos_novos) IS DISTINCT FROM (c.score_atual, c.motivos_atuais)),
           'alterados', (SELECT count(*) FROM upd),
           'pulados', count(*) FILTER (WHERE (c.score_novo, c.motivos_novos) IS DISTINCT FROM (c.score_atual, c.motivos_atuais)) - (SELECT count(*) FROM upd),
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
$function$;

-- REPLACE preserva o ACL; reemitido nomeando as roles para a prova e para quem colar fora de ordem.
REVOKE ALL ON FUNCTION public.radar_score_recalcular() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.radar_score_recalcular() TO service_role;

DO $post$
DECLARE
  v_md5 text;
BEGIN
  SELECT md5(p.prosrc) INTO v_md5 FROM pg_proc p WHERE p.oid = to_regprocedure('public.radar_score_recalcular()');
  IF v_md5 IS DISTINCT FROM '5413669a9a67105b6c0a7e5037e2a80d' THEN
    RAISE EXCEPTION 'A4 FALHOU: radar_score_recalcular vivo (md5 %) não é o corpo desta v2 — colagem incompleta ou corpo divergente', v_md5;
  END IF;
  IF has_function_privilege('anon', 'public.radar_score_recalcular()', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.radar_score_recalcular()', 'EXECUTE') THEN
    RAISE EXCEPTION 'A3 FALHOU: anon/authenticated executam radar_score_recalcular — qualquer sessão reescreveria o score da fila';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM cron.job
    WHERE jobname = 'radar-score-recalcular-diario'
      AND schedule = '30 6 * * *'
      AND command LIKE '%public.radar_score_recalcular()%'
      AND active
  ) THEN
    RAISE EXCEPTION 'A6 FALHOU: cron radar-score-recalcular-diario sumiu — aplique a 20261019180000 antes desta';
  END IF;
  RAISE NOTICE 'radar: score v2 (lote exato, guarda de versão, ledger do mesmo snapshot) provado';
END
$post$;

COMMIT;
