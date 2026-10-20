-- ============================================================
-- Radar de Clientes — SCORE DETERMINÍSTICO e explicável por lead (bloco 3 do brainstorm do radar).
--
-- A fila de prospecção (/radar) ordenava por data de abertura ou capital — um eixo só, escolhido à mão.
-- Esta migration dá a cada empresa um score 0–100, recalculado 1×/dia em SQL puro, com os FATORES que
-- pontuaram escritos por extenso, para a fila ordenar por ele e o vendedor entender o porquê.
--
-- Entrega:
--   • Colunas dedicadas em `radar_empresas` (regra da casa: sinal money-path em coluna dedicada, 1 escritor):
--       score          smallint   NULL = não calculado / insuficiente — NUNCA 0 fabricado (ausente ≠ zero)
--       score_motivos  text[]     fatores que pontuaram ("capital R$ 100–500 mil", "município com 12 clientes")
--                                 ou o motivo do NULL ("fora da foto vigente", "já é cliente", "sem lote vigente")
--       score_em       timestamptz instante da última MUDANÇA de (score, motivos) — a frescura da AVALIAÇÃO
--                                 é o ledger (1 linha por rodada), não esta coluna: reescrever 550k tuplas
--                                 por dia só para carimbar a hora seria bloat sem informação.
--   • Índice parcial `idx_radar_lista_score` (score DESC NULLS LAST, cnpj) com o MESMO predicado dos índices
--     da fila (`ja_cliente = false AND prospeccao_status <> 'descartado'`) — é o ORDER BY da lista.
--   • `radar_score_recalcular()` — SECURITY DEFINER, ÚNICO escritor das 3 colunas, pesos num CTE `VALUES`
--     versionado por ESTA migration (o md5 do prosrc está na postcondição; mudar peso = nova migration no
--     molde TRAVA→PRE→CREATE→PÓS). Soma máxima = 100:
--       CNAE (tier da curadoria)   25 / 15 / 8      tier 1 = móveis, marmoraria, artefatos de madeira, restauração
--       porte (RFB)                10 / 8 / 3       '05' demais · '03' EPP · '01' ME ('00'/NULL = 0, sem motivo)
--       capital social             15/12/10/6/3     ≥1 mi · 500 mil–1 mi · 100–500 mil · 50–100 mil · 10–50 mil
--       idade da empresa           10/8/6/4         3–10 anos · 10+ · 1–3 · <1 — referência = 1º dia do mês do
--                                                   lote vigente (determinístico; nunca o relógio da sessão)
--       proximidade comercial      20/15/10/6 | 5   ja_cliente no MESMO município (≥30 · 10–29 · 3–9 · 1–2);
--                                                   senão UF com ≥100 clientes = 5
--       contato disponível         7 + 3            telefone · e-mail
--       inédito no lote vigente    10               primeira_vista_em ≥ iniciado_em do lote vigente
--     Lote vigente = max(mes_referencia) com status='complete' em `radar_ingest_state`.
--     ja_cliente ⇒ NULL {já é cliente} · ultimo_lote < vigente ⇒ NULL {fora da foto vigente} ·
--     sem lote complete ⇒ todos NULL {sem lote vigente}. Descartados pontuam normalmente (status é
--     workflow, não qualificação). Dado faltante num fator = 0 ponto e SEM motivo (nunca "capital baixo"
--     para capital NULL).
--     UPDATE só onde (score, motivos) IS DISTINCT FROM o atual. Grava 1 linha em `acoes_execucoes`
--     (slug `radar.score_recalcular`, origem `automatica`, detalhes com lote, contagens, nulos por motivo e
--     distribuição por faixa). Erro PROPAGA (job_run_details 'failed' com a mensagem real); só a GRAVAÇÃO
--     do ledger é fail-open — mesmo desenho do tick de recruzamento (20261019093000).
--   • Cron `radar-score-recalcular-diario` às 06:30 UTC = 03:30 BRT, 15 min depois do recruzamento
--     (jobid 213, 06:15, ~11 s). Job PRÓPRIO, não encadeado no 213: o pg_cron envia o comando como UMA
--     transação — uma falha no score desfaria o recruzamento e o ledger dele; jobs separados = falhas e
--     sensores independentes. Rodar antes do recruzamento custaria no máximo 1 dia de ja_cliente defasado.
--
-- DONO: aplicar como `postgres` (SQL Editor do Lovable ou conector MCP) — `claude_rw` NÃO tem USAGE em
-- `cron` e não é owner de `radar_empresas`. Idempotente: ADD COLUMN/CREATE INDEX IF NOT EXISTS +
-- CREATE OR REPLACE + REVOKE + cron.schedule por nome. Postcondição no fim.
-- Prova: db/test-radar-score.sh (PG17, migration REAL sobre esquema mínimo, --falsificar).
-- Codex: desenho = Caminho B (exit 79, cota 97% em 2026-10-19 — RÉGUA escrita e conferida na sessão).
-- ============================================================

BEGIN;

ALTER TABLE public.radar_empresas
  ADD COLUMN IF NOT EXISTS score smallint,
  ADD COLUMN IF NOT EXISTS score_motivos text[],
  ADD COLUMN IF NOT EXISTS score_em timestamptz;

COMMENT ON COLUMN public.radar_empresas.score IS
  'Score de lead 0–100 (radar_score_recalcular, único escritor). NULL = não calculado/insuficiente — nunca 0 fabricado.';
COMMENT ON COLUMN public.radar_empresas.score_motivos IS
  'Fatores que pontuaram (legíveis) ou o motivo do NULL. Escrito só por radar_score_recalcular.';
COMMENT ON COLUMN public.radar_empresas.score_em IS
  'Instante da última MUDANÇA de (score, score_motivos). A frescura da rodada está em acoes_execucoes (radar.score_recalcular).';

CREATE INDEX IF NOT EXISTS idx_radar_lista_score
  ON public.radar_empresas (score DESC NULLS LAST, cnpj)
  WHERE ja_cliente = false AND prospeccao_status <> 'descartado';

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
  v_alterados      integer;
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
      CASE
        WHEN v_vigente IS NULL          THEN 'sem lote vigente'
        WHEN e.ja_cliente               THEN 'já é cliente'
        WHEN e.ultimo_lote < v_vigente  THEN 'fora da foto vigente'
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
      -- idade na referência do lote (anos completos)
      CASE
        WHEN e.data_abertura IS NULL OR v_ref IS NULL THEN 0
        WHEN e.data_abertura > v_ref - interval '1 year'   THEN 4
        WHEN e.data_abertura > v_ref - interval '3 years'  THEN 6
        WHEN e.data_abertura > v_ref - interval '10 years' THEN 10
        ELSE 8
      END AS p_idade,
      CASE
        WHEN e.data_abertura IS NULL OR v_ref IS NULL THEN NULL
        WHEN e.data_abertura > v_ref - interval '1 year'   THEN 'empresa com menos de 1 ano'
        WHEN e.data_abertura > v_ref - interval '3 years'  THEN 'empresa com 1–3 anos'
        WHEN e.data_abertura > v_ref - interval '10 years' THEN 'empresa com 3–10 anos'
        ELSE 'empresa com 10+ anos'
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
      f.cnpj,
      CASE WHEN f.nulo_motivo IS NOT NULL THEN NULL
           ELSE (f.p_cnae + f.p_porte + f.p_capital + f.p_idade + f.p_prox + f.p_tel + f.p_email + f.p_inedito)::smallint
      END AS score_novo,
      CASE WHEN f.nulo_motivo IS NOT NULL THEN ARRAY[f.nulo_motivo]
           ELSE array_remove(ARRAY[f.m_cnae, f.m_porte, f.m_capital, f.m_idade, f.m_prox, f.m_tel, f.m_email, f.m_inedito], NULL)
      END AS motivos_novos
    FROM fatores f
  )
  UPDATE public.radar_empresas e
     SET score = c.score_novo,
         score_motivos = c.motivos_novos,
         score_em = v_ini
    FROM calc c
   WHERE c.cnpj = e.cnpj
     AND (c.score_novo, c.motivos_novos) IS DISTINCT FROM (e.score, e.score_motivos);
  GET DIAGNOSTICS v_alterados = ROW_COUNT;

  SELECT jsonb_build_object(
           'lote_vigente', v_vigente,
           'avaliados', count(*),
           'alterados', v_alterados,
           'com_score', count(e.score),
           'sem_score', jsonb_build_object(
             'ja_cliente',    count(*) FILTER (WHERE e.score IS NULL AND e.score_motivos = ARRAY['já é cliente']),
             'fora_da_foto',  count(*) FILTER (WHERE e.score IS NULL AND e.score_motivos = ARRAY['fora da foto vigente']),
             'sem_lote',      count(*) FILTER (WHERE e.score IS NULL AND e.score_motivos = ARRAY['sem lote vigente'])),
           'faixas', jsonb_build_object(
             '0-19',   count(*) FILTER (WHERE e.score BETWEEN  0 AND 19),
             '20-39',  count(*) FILTER (WHERE e.score BETWEEN 20 AND 39),
             '40-59',  count(*) FILTER (WHERE e.score BETWEEN 40 AND 59),
             '60-79',  count(*) FILTER (WHERE e.score BETWEEN 60 AND 79),
             '80-100', count(*) FILTER (WHERE e.score BETWEEN 80 AND 100)),
           'duracao_ms', round(extract(epoch FROM clock_timestamp() - v_ini) * 1000)::integer)
    INTO v_resumo
    FROM public.radar_empresas e;

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

-- Entrypoint de JOB: só o owner (postgres) e service_role executam — nomeando as roles (REPLACE preserva
-- ACL, mas a 1ª criação herda EXECUTE de PUBLIC). service_role explícito: a edge/sonda pode disparar o
-- recálculo fora do cron (ex.: depois do finalize de um lote) sem depender de default privilege.
REVOKE ALL ON FUNCTION public.radar_score_recalcular() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.radar_score_recalcular() TO service_role;

SELECT cron.schedule(
  'radar-score-recalcular-diario',
  '30 6 * * *',
  $$SELECT public.radar_score_recalcular();$$
);

DO $post$
DECLARE
  v_md5 text;
BEGIN
  IF (SELECT count(*) FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'radar_empresas'
         AND column_name IN ('score', 'score_motivos', 'score_em')) <> 3 THEN
    RAISE EXCEPTION 'A1 FALHOU: colunas score/score_motivos/score_em ausentes em radar_empresas — a função não teria onde escrever';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname = 'radar_score_recalcular' AND p.prosecdef
  ) THEN
    RAISE EXCEPTION 'A2 FALHOU: radar_score_recalcular ausente ou sem SECURITY DEFINER — o cron não teria o que chamar';
  END IF;
  IF has_function_privilege('anon', 'public.radar_score_recalcular()', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.radar_score_recalcular()', 'EXECUTE') THEN
    RAISE EXCEPTION 'A3 FALHOU: anon/authenticated executam radar_score_recalcular — qualquer sessão reescreveria o score da fila';
  END IF;
  -- O corpo VIVO é o deste arquivo (byte a byte): transcrição pelo MCP não pode ter perdido nada.
  SELECT md5(p.prosrc) INTO v_md5 FROM pg_proc p WHERE p.oid = to_regprocedure('public.radar_score_recalcular()');
  IF v_md5 IS DISTINCT FROM '02025c570310d1da858337c20c54e65c' THEN
    RAISE EXCEPTION 'A4 FALHOU: radar_score_recalcular vivo (md5 %) não é o corpo deste arquivo — colagem incompleta ou corpo divergente', v_md5;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
    WHERE c.relname = 'idx_radar_lista_score' AND i.indisvalid
  ) THEN
    RAISE EXCEPTION 'A5 FALHOU: idx_radar_lista_score ausente ou inválido — a fila ordenaria por score sem índice';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM cron.job
    WHERE jobname = 'radar-score-recalcular-diario'
      AND schedule = '30 6 * * *'
      AND command LIKE '%public.radar_score_recalcular()%'
      AND active
  ) THEN
    RAISE EXCEPTION 'A6 FALHOU: cron radar-score-recalcular-diario não agendado às 06:30 UTC — o score só existiria na 1ª rodada manual';
  END IF;
  RAISE NOTICE 'radar: colunas de score, função SECURITY DEFINER com ACL fechada, índice e cron diário 03:30 BRT provados';
END
$post$;

COMMIT;
