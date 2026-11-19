-- =============================================================================
-- Radar: o score do lead passa a ser recalculado em FATIAS de páginas, com cursor persistido
-- =============================================================================
-- Incidente (2026-11-17..19, docs/historico/radar-score-timeout-fatias.md): o cron radar-score-recalcular-diario
-- falhou 3 dias seguidos com 57014 (statement_timeout de 120 s, o default do servidor — nenhum papel o
-- sobrescreve) e o score parou no lote 2026-10. Causa: o lote 2026-11 entrou em 16/11, e a 1ª rodada sobre
-- ele precisa regravar 514.024 das 584.587 linhas (o motivo de idade cita "ref. <lote>"; só 53.598 mudam de
-- NOTA). O cálculo em si custa 5,3 s (EXPLAIN ANALYZE só-leitura em prod, 86.737 páginas, sem temp); o custo é
-- a ESCRITA — quase toda UPDATE não-HOT (score é coluna indexada; fillfactor 100) mexe nos 26 índices de
-- radar_empresas (1,48 GB com índices). No Small, em outubro, ~500k linhas regravadas levaram 101 s e 115 s
-- (a 4 % do teto); no Mini a mesma ordem de escrita levou 27m43s no radar_aplicar_situacao de 17/11.
-- Como a rodada é UM comando, ela nunca grava nada, nunca grava a marca, e repete o mesmo cálculo todo dia.
--
-- O QUE MUDA (só radar_score_recalcular; fórmula, pesos e versão 'v3' IDÊNTICOS — prova de equivalência A1):
--   1. Uma "passada" percorre radar_empresas por faixas FÍSICAS de 1.000 páginas (TID Range Scan: leitura
--      sequencial; a faixa por CNPJ via índice seriam ~584k leituras aleatórias). Cada chamada processa faixas
--      até ~50 s de orçamento e grava o cursor em radar_score_passada; a próxima chamada continua dali.
--      A passada nasce com a impressão digital do INÍCIO (lote, fórmula, max(updated_at), nº de já-clientes,
--      filenode e nº de páginas). Lote/fórmula/arquivo físico diferente → passada recomeça do zero.
--   2. A marca (radar_score_estado) só é gravada quando a passada TERMINA com 0 pulados, e com a impressão do
--      INÍCIO dela: o que mudou durante a passada deixa max(updated_at) > marca e a rodada seguinte recalcula.
--   3. Linha já pontuada NESTA passada (score_em >= início) é pulada: o UPDATE não-HOT move a versão nova
--      para página adiante, e sem isso ela seria contada duas vezes no resumo.
--   4. Rodada PARCIAL registra `parcial: true` e `lote_em_calculo` — NUNCA `lote_vigente`. Os leitores
--      (radar_avisar_lote, useRadarSugeridos) tratam o lote como "score calculado" pelo `lote_vigente` da última
--      rodada `sucesso`: carimbar lote parcial fabricaria cobertura.
--   5. Trava de linha: lock_timeout 5 s; faixa que não pega a trava (lock_not_available/deadlock) encerra a
--      chamada com o que já fez (subtransação por faixa) — nunca espera até o statement_timeout.
--   6. Trava da rodada: pg_try_advisory_xact_lock (antes: espera). Outra rodada em curso → `adiado`.
--   7. A rodada "nada mudou" só registra em acoes_execucoes se não houver registro nas últimas 20 h (o cron
--      agora repete): continua 1 registro por dia, e a fila (useRadarLista, que reinicia pelo id da última
--      rodada) não reinicia a cada 5 min.
--   8. muni/uf (nº de já-clientes) lidos 1× por chamada, logo depois da impressão digital, num jsonb.
--   Tamanho da faixa e orçamento: GUCs de sessão opcionais radar.score_paginas_fatia / radar.score_orcamento
--   (operação e prova); sem elas, 1.000 páginas e 50 s.
--   Cron: o radar-score-recalcular-diario passa a rodar de 5 em 5 min das 06:30 às 06:55 UTC (mantém a ordem
--   do pipeline: depois do aplicar-situacao 06:05 e do recruzar 06:15), e o NOVO radar-score-recalcular-continua
--   de 5 em 5 min das 07:00 às 08:55. Comando com SET statement_timeout = '3min' (margem; o orçamento é 50 s).
--   Sem passada pendente, cada tick é o gate (~0,5 s, pelos índices).
--
-- Recria função VIVA no molde TRAVA → PRE → CREATE → PÓS (predecessora = corpo de prod de 2026-11-19,
-- md5 49c21fef6ab031b2ffe0d0367f86560e, db/fixtures/radar-score-predecessora-prod-20261119.sql). Arquivo para
-- `bun run db:aplicar` (sem BEGIN/COMMIT). Prova PG17: db/test-radar-score-fatias.sh.
-- ============================================================

-- TRAVA, antes de ler: ALTER sem efeito (a volatilidade VIVA) na função que a PRE guarda.
DO $trava$
BEGIN
  IF to_regprocedure('public.radar_score_recalcular()') IS NOT NULL THEN
    ALTER FUNCTION public.radar_score_recalcular() VOLATILE;
  END IF;
END
$trava$;

-- PRE: md5 EXATO do corpo vivo ∈ {predecessor de prod, este}. Ausente ABORTA.
DO $pre$
DECLARE
  v_vivo text;
BEGIN
  SELECT md5(p.prosrc) INTO v_vivo FROM pg_catalog.pg_proc p WHERE p.oid = to_regprocedure('public.radar_score_recalcular()');
  IF v_vivo IS NULL OR v_vivo NOT IN ('49c21fef6ab031b2ffe0d0367f86560e', 'e59283a5aee6da2c26245e840f5e0ada') THEN
    RAISE EXCEPTION 'PRE FALHOU: radar_score_recalcular vivo (md5 %) não é o predecessor revisado nem este', v_vivo;
  END IF;
  IF to_regclass('public.radar_score_estado') IS NULL THEN
    RAISE EXCEPTION 'PRE FALHOU: radar_score_estado ausente — a 20261105150000 não está aplicada';
  END IF;
END
$pre$;

-- Passada em curso do score: 1 linha, 1 escritor (radar_score_recalcular, SECURITY DEFINER).
CREATE TABLE IF NOT EXISTS public.radar_score_passada (
  id               smallint PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  lote             text,
  lote_iniciado_em timestamptz,
  versao_formula   text NOT NULL,
  max_updated_at   timestamptz,
  ja_cliente_n     bigint,
  iniciada_em      timestamptz NOT NULL,
  filenode         oid NOT NULL,
  paginas          integer NOT NULL CHECK (paginas >= 0),
  proxima_pagina   integer NOT NULL CHECK (proxima_pagina >= 0),
  rodadas          integer NOT NULL CHECK (rodadas >= 1),
  contagens        jsonb NOT NULL
);
ALTER TABLE public.radar_score_passada ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.radar_score_passada FROM PUBLIC, anon, authenticated;
COMMENT ON TABLE public.radar_score_passada IS
  'Passada em curso do score do Radar (radar_score_recalcular em fatias de páginas): impressão digital do INÍCIO, cursor (proxima_pagina) e contagens acumuladas. Apagar a linha recomeça a passada do zero.';

CREATE OR REPLACE FUNCTION public.radar_score_recalcular()
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
 SET lock_timeout TO '5s'
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
  -- Fatias (20261120140000): faixa física de páginas por comando e orçamento por chamada. 1.000 páginas ≈ 6 mil
  -- linhas; no pior caso medido no Mini (2,9 ms por linha regravada, aplicar_situacao de 17/11) ≈ 18 s por
  -- faixa → a chamada fica em ~70 s, abaixo dos 120 s do servidor. GUC de sessão sobrepõe (operação e prova).
  c_paginas_fatia  CONSTANT integer := GREATEST(1, COALESCE(
                     NULLIF(current_setting('radar.score_paginas_fatia', true), '')::integer, 1000));
  c_orcamento      CONSTANT interval := COALESCE(
                     NULLIF(current_setting('radar.score_orcamento', true), '')::interval, interval '50 seconds');
  -- A rodada "nada mudou" registra no máximo 1× nesta janela (o cron repete de 5 em 5 min de manhã).
  c_registro_noop  CONSTANT interval := interval '20 hours';
  v_est            public.radar_score_estado%ROWTYPE;
  v_tem_estado     boolean;
  v_fp_upd         timestamptz;
  v_fp_jc          bigint;
  v_pas            public.radar_score_passada%ROWTYPE;
  v_tem_passada    boolean;
  v_filenode       oid;
  v_muni           jsonb;
  v_ufs            jsonb;
  v_pag            integer;
  v_ate            integer;
  v_de_tid         tid;
  v_ate_tid        tid;
  v_interrompido   text;
  v_fatias         integer := 0;
  v_alterados_rod  bigint := 0;
  -- contagens da faixa
  f_avaliados bigint; f_a_alterar bigint; f_alterados bigint; f_com_score bigint;
  f_jc bigint; f_fora bigint; f_ingest bigint; f_sem_lote bigint;
  f_0 bigint; f_20 bigint; f_40 bigint; f_60 bigint; f_80 bigint;
  -- contagens acumuladas da passada (persistidas em radar_score_passada.contagens)
  t_avaliados bigint; t_a_alterar bigint; t_alterados bigint; t_com_score bigint;
  t_jc bigint; t_fora bigint; t_ingest bigint; t_sem_lote bigint;
  t_0 bigint; t_20 bigint; t_40 bigint; t_60 bigint; t_80 bigint;
BEGIN
  -- Um cálculo por vez: o estado do gate e a passada são lidos e gravados sob a mesma trava. Sem esperar:
  -- outra rodada em curso → esta não faz nada (o cron repete).
  IF NOT pg_try_advisory_xact_lock(20261105, 1) THEN
    RETURN jsonb_build_object('adiado', 'outra_rodada_em_andamento');
  END IF;
  -- Publicação em passos em andamento (20261111120000): os rótulos físicos misturam a foto velha e a nova
  -- — pontuar agora classificaria o rótulo novo como "lote em ingestão". A rodada seguinte pontua.
  IF public.radar_lote_publicando() IS NOT NULL THEN
    RETURN jsonb_build_object('adiado', 'publicacao_em_andamento', 'lote_em_publicacao', public.radar_lote_publicando());
  END IF;

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
    -- Nada a fazer: passada que tenha sobrado perdeu o objeto.
    DELETE FROM public.radar_score_passada WHERE id = 1;
    v_resumo := jsonb_build_object(
      'lote_vigente', v_vigente,
      'versao_formula', c_versao,
      'recalculou', false,
      'motivo', 'nada mudou desde o último cálculo completo',
      'ultimo_calculo_em', v_est.calculado_em,
      'duracao_ms', round(extract(epoch FROM clock_timestamp() - v_ini) * 1000)::integer);
    -- O registro diário continua (data_health e radar_avisar_lote leem lote_vigente da última rodada), mas
    -- 1× por janela: o cron repete de manhã e cada registro novo reinicia a fila da tela (useRadarLista).
    IF NOT EXISTS (SELECT 1 FROM public.acoes_execucoes e
                    WHERE e.acao = 'radar.score_recalcular' AND e.iniciado_em > v_ini - c_registro_noop) THEN
      BEGIN
        INSERT INTO public.acoes_execucoes
          (acao, origem, iniciado_em, finalizado_em, status, detalhes)
        VALUES
          ('radar.score_recalcular', 'automatica', v_ini, clock_timestamp(), 'sucesso', v_resumo);
      EXCEPTION WHEN OTHERS THEN
        NULL;
      END;
    END IF;
    RETURN v_resumo;
  END IF;

  -- PASSADA: continua a que está em curso, ou abre uma nova com a impressão digital de AGORA.
  v_filenode := pg_relation_filenode('public.radar_empresas'::regclass);
  SELECT * INTO v_pas FROM public.radar_score_passada WHERE id = 1;
  v_tem_passada := FOUND;
  IF v_tem_passada
     AND (v_pas.lote IS DISTINCT FROM v_vigente
          OR v_pas.lote_iniciado_em IS DISTINCT FROM v_vigente_inicio
          OR v_pas.versao_formula IS DISTINCT FROM c_versao
          OR v_pas.filenode IS DISTINCT FROM v_filenode) THEN
    -- Foto, fórmula ou arquivo físico (VACUUM FULL/CLUSTER) mudou: as faixas feitas não valem mais.
    v_tem_passada := false;
  END IF;
  IF NOT v_tem_passada THEN
    v_pas.id               := 1;
    v_pas.lote             := v_vigente;
    v_pas.lote_iniciado_em := v_vigente_inicio;
    v_pas.versao_formula   := c_versao;
    v_pas.max_updated_at   := v_fp_upd;
    v_pas.ja_cliente_n     := v_fp_jc;
    v_pas.iniciada_em      := v_ini;
    v_pas.filenode         := v_filenode;
    -- Páginas existentes no início: versão de linha que nascer além delas é de linha já pontuada nesta
    -- passada (UPDATE não-HOT) ou de escrita posterior ao início (bumpa updated_at → próxima passada).
    v_pas.paginas          := (pg_relation_size('public.radar_empresas'::regclass)
                               / current_setting('block_size')::bigint)::integer;
    v_pas.proxima_pagina   := 0;
    v_pas.rodadas          := 0;
    v_pas.contagens        := '{}'::jsonb;
  END IF;
  v_pas.rodadas := v_pas.rodadas + 1;

  t_avaliados := COALESCE((v_pas.contagens->>'avaliados')::bigint, 0);
  t_a_alterar := COALESCE((v_pas.contagens->>'a_alterar')::bigint, 0);
  t_alterados := COALESCE((v_pas.contagens->>'alterados')::bigint, 0);
  t_com_score := COALESCE((v_pas.contagens->>'com_score')::bigint, 0);
  t_jc        := COALESCE((v_pas.contagens->>'ja_cliente')::bigint, 0);
  t_fora      := COALESCE((v_pas.contagens->>'fora_da_foto')::bigint, 0);
  t_ingest    := COALESCE((v_pas.contagens->>'lote_em_ingestao')::bigint, 0);
  t_sem_lote  := COALESCE((v_pas.contagens->>'sem_lote')::bigint, 0);
  t_0         := COALESCE((v_pas.contagens->>'0-19')::bigint, 0);
  t_20        := COALESCE((v_pas.contagens->>'20-39')::bigint, 0);
  t_40        := COALESCE((v_pas.contagens->>'40-59')::bigint, 0);
  t_60        := COALESCE((v_pas.contagens->>'60-79')::bigint, 0);
  t_80        := COALESCE((v_pas.contagens->>'80-100')::bigint, 0);

  -- Proximidade comercial: nº de já-clientes por município e UF, 1× por chamada (índice parcial).
  SELECT COALESCE(jsonb_object_agg(x.municipio_codigo, x.n), '{}'::jsonb) INTO v_muni
    FROM (SELECT e.municipio_codigo, count(*)::integer AS n
            FROM public.radar_empresas e
           WHERE e.ja_cliente AND e.municipio_codigo IS NOT NULL
           GROUP BY e.municipio_codigo) x;
  SELECT COALESCE(jsonb_object_agg(x.uf, x.n), '{}'::jsonb) INTO v_ufs
    FROM (SELECT e.uf, count(*)::integer AS n
            FROM public.radar_empresas e
           WHERE e.ja_cliente AND e.uf IS NOT NULL
           GROUP BY e.uf) x;

  v_pag := v_pas.proxima_pagina;
  WHILE v_pag < v_pas.paginas LOOP
    IF v_fatias > 0 AND clock_timestamp() - v_ini > c_orcamento THEN
      v_interrompido := 'orcamento';
      EXIT;
    END IF;
    v_ate     := LEAST(v_pag + c_paginas_fatia, v_pas.paginas);
    v_de_tid  := format('(%s,0)', v_pag)::tid;
    v_ate_tid := format('(%s,0)', v_ate)::tid;
    BEGIN
      -- UM comando por faixa: cálculo, UPDATE e contagens partilham o MESMO snapshot (Codex MÉDIO 3).
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
        SELECT j.k AS municipio_codigo, j.v::integer AS n FROM jsonb_each_text(v_muni) AS j(k, v)
      ),
      ufs AS (
        SELECT j.k AS uf, j.v::integer AS n FROM jsonb_each_text(v_ufs) AS j(k, v)
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
        WHERE e.ctid >= v_de_tid AND e.ctid < v_ate_tid
          -- já pontuada NESTA passada (a versão nova de um UPDATE não-HOT cai numa página adiante)
          AND (e.score_em IS NULL OR e.score_em < v_pas.iniciada_em)
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
         WHERE e.ctid >= v_de_tid AND e.ctid < v_ate_tid
           AND c.cnpj = e.cnpj
           AND (c.score_novo, c.motivos_novos, c.versao_formula_nova) IS DISTINCT FROM (c.score_atual, c.motivos_atuais, c.versao_formula_atual)
           -- Guarda de VERSÃO (Codex ALTO 2): se a linha mudou depois do snapshot (EvalPlanQual reavalia só a
           -- linha-alvo), não grava score velho — pula e deixa para a próxima rodada.
           AND e.updated_at IS NOT DISTINCT FROM c.versao
           AND e.ja_cliente = c.ja_cliente_lido
        RETURNING e.cnpj
      )
      SELECT count(*),
             count(*) FILTER (WHERE (c.score_novo, c.motivos_novos, c.versao_formula_nova) IS DISTINCT FROM (c.score_atual, c.motivos_atuais, c.versao_formula_atual)),
             (SELECT count(*) FROM upd),
             count(c.score_novo),
             count(*) FILTER (WHERE c.score_novo IS NULL AND c.motivos_novos = ARRAY['já é cliente']),
             count(*) FILTER (WHERE c.score_novo IS NULL AND c.motivos_novos = ARRAY['fora da foto vigente']),
             count(*) FILTER (WHERE c.score_novo IS NULL AND c.motivos_novos = ARRAY['lote em ingestão']),
             count(*) FILTER (WHERE c.score_novo IS NULL AND c.motivos_novos = ARRAY['sem lote vigente']),
             count(*) FILTER (WHERE c.score_novo BETWEEN  0 AND 19),
             count(*) FILTER (WHERE c.score_novo BETWEEN 20 AND 39),
             count(*) FILTER (WHERE c.score_novo BETWEEN 40 AND 59),
             count(*) FILTER (WHERE c.score_novo BETWEEN 60 AND 79),
             count(*) FILTER (WHERE c.score_novo BETWEEN 80 AND 100)
        INTO f_avaliados, f_a_alterar, f_alterados, f_com_score, f_jc, f_fora, f_ingest, f_sem_lote,
             f_0, f_20, f_40, f_60, f_80
        FROM calc c;
    EXCEPTION WHEN lock_not_available OR deadlock_detected THEN
      -- Linha travada por outro escritor: a faixa volta atrás (subtransação) e a chamada encerra com o feito.
      v_interrompido := 'trava';
      EXIT;
    END;
    t_avaliados := t_avaliados + f_avaliados;  t_a_alterar := t_a_alterar + f_a_alterar;
    t_alterados := t_alterados + f_alterados;  t_com_score := t_com_score + f_com_score;
    t_jc := t_jc + f_jc;  t_fora := t_fora + f_fora;  t_ingest := t_ingest + f_ingest;  t_sem_lote := t_sem_lote + f_sem_lote;
    t_0 := t_0 + f_0;  t_20 := t_20 + f_20;  t_40 := t_40 + f_40;  t_60 := t_60 + f_60;  t_80 := t_80 + f_80;
    v_alterados_rod := v_alterados_rod + f_alterados;
    v_fatias := v_fatias + 1;
    v_pag := v_ate;
  END LOOP;

  IF v_interrompido IS NULL THEN
    -- Passada COMPLETA: resumo da passada inteira, marca com a impressão do INÍCIO dela.
    v_resumo := jsonb_build_object(
             'lote_vigente', v_vigente,
             'versao_formula', c_versao,
             'recalculou', true,
             'avaliados', t_avaliados,
             'a_alterar', t_a_alterar,
             'alterados', t_alterados,
             'pulados', t_a_alterar - t_alterados,
             'com_score', t_com_score,
             'sem_score', jsonb_build_object(
               'ja_cliente', t_jc, 'fora_da_foto', t_fora, 'lote_em_ingestao', t_ingest, 'sem_lote', t_sem_lote),
             'faixas', jsonb_build_object(
               '0-19', t_0, '20-39', t_20, '40-59', t_40, '60-79', t_60, '80-100', t_80),
             'passada', jsonb_build_object(
               'iniciada_em', v_pas.iniciada_em, 'rodadas', v_pas.rodadas, 'paginas', v_pas.paginas,
               'alterados_nesta_rodada', v_alterados_rod),
             'duracao_ms', round(extract(epoch FROM clock_timestamp() - v_ini) * 1000)::integer);

    -- Grava a impressão digital SÓ com passada limpa: linha pulada pela guarda de versão (mudou depois do
    -- snapshot) apaga o estado, e a próxima rodada recalcula.
    IF t_a_alterar - t_alterados = 0 THEN
      INSERT INTO public.radar_score_estado AS t
             (id, lote, lote_iniciado_em, versao_formula, max_updated_at, ja_cliente_n, calculado_em)
      VALUES (1, v_pas.lote, v_pas.lote_iniciado_em, v_pas.versao_formula, v_pas.max_updated_at, v_pas.ja_cliente_n,
              v_pas.iniciada_em)
      ON CONFLICT (id) DO UPDATE
         SET lote = EXCLUDED.lote, lote_iniciado_em = EXCLUDED.lote_iniciado_em,
             versao_formula = EXCLUDED.versao_formula, max_updated_at = EXCLUDED.max_updated_at,
             ja_cliente_n = EXCLUDED.ja_cliente_n, calculado_em = EXCLUDED.calculado_em;
    ELSE
      DELETE FROM public.radar_score_estado WHERE id = 1;
    END IF;
    DELETE FROM public.radar_score_passada WHERE id = 1;
  ELSE
    -- Passada PARCIAL: guarda o cursor e as contagens; a próxima chamada continua. Sem `lote_vigente`: os
    -- leitores tomam a última rodada `sucesso` com lote_vigente como "este lote está pontuado".
    v_resumo := jsonb_build_object(
             'lote_em_calculo', v_vigente,
             'versao_formula', c_versao,
             'recalculou', true,
             'parcial', true,
             'interrompido', v_interrompido,
             'alterados', v_alterados_rod,
             'passada', jsonb_build_object(
               'iniciada_em', v_pas.iniciada_em, 'rodadas', v_pas.rodadas, 'paginas', v_pas.paginas,
               'proxima_pagina', v_pag),
             'duracao_ms', round(extract(epoch FROM clock_timestamp() - v_ini) * 1000)::integer);
    v_pas.proxima_pagina := v_pag;
    v_pas.contagens := jsonb_build_object(
      'avaliados', t_avaliados, 'a_alterar', t_a_alterar, 'alterados', t_alterados, 'com_score', t_com_score,
      'ja_cliente', t_jc, 'fora_da_foto', t_fora, 'lote_em_ingestao', t_ingest, 'sem_lote', t_sem_lote,
      '0-19', t_0, '20-39', t_20, '40-59', t_40, '60-79', t_60, '80-100', t_80);
    INSERT INTO public.radar_score_passada AS t
           (id, lote, lote_iniciado_em, versao_formula, max_updated_at, ja_cliente_n, iniciada_em, filenode,
            paginas, proxima_pagina, rodadas, contagens)
    VALUES (1, v_pas.lote, v_pas.lote_iniciado_em, v_pas.versao_formula, v_pas.max_updated_at, v_pas.ja_cliente_n,
            v_pas.iniciada_em, v_pas.filenode, v_pas.paginas, v_pas.proxima_pagina, v_pas.rodadas, v_pas.contagens)
    ON CONFLICT (id) DO UPDATE
       SET lote = EXCLUDED.lote, lote_iniciado_em = EXCLUDED.lote_iniciado_em,
           versao_formula = EXCLUDED.versao_formula, max_updated_at = EXCLUDED.max_updated_at,
           ja_cliente_n = EXCLUDED.ja_cliente_n, iniciada_em = EXCLUDED.iniciada_em,
           filenode = EXCLUDED.filenode, paginas = EXCLUDED.paginas, proxima_pagina = EXCLUDED.proxima_pagina,
           rodadas = EXCLUDED.rodadas, contagens = EXCLUDED.contagens;
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

-- Jobs: o diário repete de 5 em 5 min até 06:55 (depois do aplicar-situacao 06:05 e do recruzar 06:15) e o
-- de continuação cobre 07:00–08:55. Passada que não terminar continua no dia seguinte (o cursor é durável).
DO $job$
DECLARE
  c_cmd CONSTANT text := 'SET statement_timeout = ''3min''; SELECT public.radar_score_recalcular();';
  v_id  bigint;
BEGIN
  SELECT jobid INTO v_id FROM cron.job WHERE jobname = 'radar-score-recalcular-diario';
  IF v_id IS NULL THEN
    RAISE EXCEPTION 'TRAVA: cron radar-score-recalcular-diario ausente — a 20261019180000 não está aplicada';
  END IF;
  PERFORM cron.alter_job(job_id := v_id, schedule := '30,35,40,45,50,55 6 * * *', command := c_cmd);

  v_id := NULL;
  SELECT jobid INTO v_id FROM cron.job WHERE jobname = 'radar-score-recalcular-continua';
  IF v_id IS NULL THEN
    PERFORM cron.schedule('radar-score-recalcular-continua', '*/5 7-8 * * *', c_cmd);
  ELSE
    PERFORM cron.alter_job(job_id := v_id, schedule := '*/5 7-8 * * *', command := c_cmd);
  END IF;
END
$job$;

-- PÓS
DO $post$
DECLARE
  c_cmd CONSTANT text := 'SET statement_timeout = ''3min''; SELECT public.radar_score_recalcular();';
BEGIN
  -- P1: a função viva é ESTE arquivo (md5 exato do prosrc) e leva o lock_timeout próprio.
  IF (SELECT md5(prosrc) FROM pg_catalog.pg_proc WHERE oid = to_regprocedure('public.radar_score_recalcular()'))
     IS DISTINCT FROM 'e59283a5aee6da2c26245e840f5e0ada' THEN
    RAISE EXCEPTION 'P1 FALHOU: radar_score_recalcular vivo não é o corpo deste arquivo';
  END IF;
  IF NOT COALESCE((SELECT proconfig @> ARRAY['lock_timeout=5s'] AND prosecdef
                     FROM pg_catalog.pg_proc WHERE oid = to_regprocedure('public.radar_score_recalcular()')), false) THEN
    RAISE EXCEPTION 'P1 FALHOU: radar_score_recalcular sem lock_timeout=5s ou sem SECURITY DEFINER';
  END IF;
  -- P2: tabela da passada com RLS e fechada para anon/authenticated.
  IF NOT COALESCE((SELECT relrowsecurity FROM pg_class WHERE oid = to_regclass('public.radar_score_passada')), false) THEN
    RAISE EXCEPTION 'P2 FALHOU: radar_score_passada ausente ou sem RLS';
  END IF;
  IF has_table_privilege('anon', 'public.radar_score_passada', 'SELECT')
     OR has_table_privilege('authenticated', 'public.radar_score_passada', 'SELECT') THEN
    RAISE EXCEPTION 'P2 FALHOU: radar_score_passada legível por anon/authenticated';
  END IF;
  -- P3: ACL preservado (CREATE OR REPLACE mantém): service_role executa; PUBLIC/anon/authenticated não.
  IF NOT has_function_privilege('service_role', 'public.radar_score_recalcular()', 'EXECUTE')
     OR has_function_privilege('anon', 'public.radar_score_recalcular()', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.radar_score_recalcular()', 'EXECUTE')
     OR EXISTS (SELECT 1 FROM pg_proc p, aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) a
                 WHERE p.oid = to_regprocedure('public.radar_score_recalcular()')
                   AND a.grantee = 0 AND a.privilege_type = 'EXECUTE') THEN
    RAISE EXCEPTION 'P3 FALHOU: ACL de radar_score_recalcular mudou';
  END IF;
  -- P4: os 2 jobs existem, ativos, no horário, com o comando novo, e rodam como postgres.
  IF (SELECT count(*) FROM cron.job
       WHERE active AND username = 'postgres' AND command = c_cmd
         AND ((jobname = 'radar-score-recalcular-diario'   AND schedule = '30,35,40,45,50,55 6 * * *')
           OR (jobname = 'radar-score-recalcular-continua' AND schedule = '*/5 7-8 * * *'))) <> 2 THEN
    RAISE EXCEPTION 'P4 FALHOU: jobs do score ausentes, inativos, divergentes ou sem dono postgres';
  END IF;
END
$post$;
