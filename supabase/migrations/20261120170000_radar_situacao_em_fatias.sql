-- =============================================================================
-- Radar: a foto da situação cadastral RFB passa a ser gravada em FATIAS por CNPJ, com cursor persistido
-- =============================================================================
-- Medido em prod (psql-ro, 2026-11-20; docs/historico/radar-situacao-timeout-fatias.md): o cron
-- radar-aplicar-situacao-diario levou 27m43s, de um teto de 30 min, em 17/11 06:05 UTC (porte Mini), ao aplicar o
-- lote 2026-11. O passo (a) do radar_aplicar_situacao regravou 573.026 linhas de radar_empresas num UPDATE só, e só
-- 9.924 delas mudaram de situação ou de data. As outras 563 mil mudam só o rótulo da foto (rfb_situacao_lote
-- 2026-10 → 2026-11, que a tela mostra no selo RFB) e o updated_at. Toda UPDATE ali é não-HOT (updated_at é
-- indexado, fillfactor 100) e mexe nos 25 índices (1,48 GB). Isso se repete a cada lote mensal, e no Mini a
-- escrita custa 3–6 ms por linha: o próximo lote passa do teto.
--
-- O QUE MUDA (só radar_aplicar_situacao_pendente; radar_aplicar_situacao fica INTACTA, sem DDL):
--   1. Uma "passada" grava o passo (a) de UM lote em fatias de CNPJs do próprio lote (radar_situacao_cadastral,
--      pelo PK (cnpj, lote), em ordem), com o MESMO SET e o MESMO predicado do passo (a) da função de prod (a
--      guarda de lote que nunca regride e o IS DISTINCT FROM). O cursor é o último CNPJ feito, e NÃO a posição
--      física: o score regrava ~500 mil linhas nas mesmas madrugadas (UPDATE não-HOT move a linha de página), e um
--      cursor por página perderia as linhas movidas para trás dele (Codex ALTO 5). Medido em prod: 5.000 CNPJs lidos
--      em 2,7 s a frio (nested loop nos dois PKs), ~0,55 ms/linha contra 3–6 ms da escrita. Fatia adaptativa (1.000
--      CNPJs no início, mira 1–4 s), orçamento de ~45 s por chamada com margem, cursor em radar_situacao_passada.
--   2. Quando o cursor chega ao fim, a chamada seguinte CONCLUI chamando a função de prod inteira, como antes:
--      o passo (a) dela vira a reconciliação (relê o join, 7,9 s em prod, e grava só a linha que entrou em
--      radar_empresas depois de o cursor passar pelo CNPJ dela). Depois vêm os descartes (b) e o alerta (c), sem
--      mudança nenhuma. A marca em radar_ingest_state e o ledger radar.aplicar_situacao só são gravados nessa
--      conclusão, com fotos_atualizadas = fatias + reconciliação. Os leitores da marca (radar_avisar_lote,
--      cliente_situacao_receita) não mudam.
--   3. A passada em curso TERMINA no lote dela, mesmo que um lote mais novo feche no meio (ele espera a próxima
--      chamada). Abandonar deixaria parte das empresas com a foto do lote velho e parte sem, um estado que a
--      predecessora nunca produz (Codex ALTO 1). Assim o resultado é o da predecessora rodada quando a passada
--      começou, e o lote novo é aplicado depois, como ela faria. Sem passada, a regra é a de antes: só o lote
--      complete MAIS NOVO é aplicado, o pendente mais velho é SUPERADO sem efeito. O "mais novo" é lido no MESMO
--      snapshot do FOR (Codex ALTO 2: lido antes, um lote que fechasse entre os dois comandos era marcado superado
--      por um mais velho, sem efeito). Passada cujo lote foi re-finalizado (outro finalizado_em) recomeça.
--   4. Chamada PARCIAL não marca nada e registra em OUTRA acao (radar.aplicar_situacao_parcial, fail-open).
--   5. Trava de linha: lock_timeout 5 s. Fatia (ou conclusão) que não pega a trava encerra a chamada com o que já
--      fez (subtransação), sem erro. A fatia que escreve abre subtransação com XID: no máximo 60 por chamada.
--   6. Trava da rodada: pg_try_advisory_xact_lock. Outra rodada em curso → `adiado`. A linha do lote da passada
--      travada por outra sessão (SKIP LOCKED) → `adiado`, passada intacta.
--   Tamanho da fatia e orçamento: GUCs de sessão opcionais radar.situacao_linhas_fatia (fixa, sem adaptar; 1 a
--   100.000) e radar.situacao_orcamento (operação e prova); sem elas, adaptativo e 45 s.
--
-- O resultado (fotos, descartes, contatos, alerta, marca) é o da função de prod. A diferença é de tempo: updated_at
-- é o p_agora de cada chamada, e no meio da passada as linhas já gravadas mostram a foto nova antes dos descartes,
-- que leem o estado do instante da conclusão (já-cliente, status), como a predecessora leria naquele instante.
--
-- Cron: radar-aplicar-situacao-diario passa de 06:05 para de 5 em 5 min, nos minutos 2, 7, …, 57, das 00 às 05 e
-- das 07 às 10 UTC (21:00–02:57 e 04:00–07:57 BRT). São as mesmas horas do radar-score-recalcular-continua, mas
-- 2 minutos depois dele, e cada chamada de fatias usa no máximo ~45 s. Comando com SET statement_timeout = '5min'.
-- Sem lote pendente, cada tick lê só radar_ingest_state (~50 ms, sem registro). ~120 chamadas por dia: um lote fecha
-- numa madrugada.
--
-- Recria função VIVA no molde TRAVA → PRE → CREATE → PÓS. A predecessora é o corpo de prod de 2026-11-20
-- (db/fixtures/radar-situacao-pendente-prod-20261120.sql, md5 a99fd7dbdd0c8590698546b162f1a68f). Arquivo para
-- `bun run db:aplicar` (sem BEGIN/COMMIT). Prova PG17: db/test-radar-situacao-fatias.sh.
-- ============================================================

-- TRAVA, antes de ler: ALTER sem efeito (a volatilidade VIVA) na função que a PRE guarda.
DO $trava$
BEGIN
  IF to_regprocedure('public.radar_aplicar_situacao_pendente(timestamptz)') IS NOT NULL THEN
    ALTER FUNCTION public.radar_aplicar_situacao_pendente(timestamptz) VOLATILE;
  END IF;
END
$trava$;

-- PRE: md5 EXATO dos corpos vivos. A conclusão depende do passo (a) da função de prod: ela tem de ser a revisada.
DO $pre$
DECLARE
  v_vivo text;
  v_base text;
BEGIN
  SELECT md5(p.prosrc) INTO v_vivo FROM pg_catalog.pg_proc p
   WHERE p.oid = to_regprocedure('public.radar_aplicar_situacao_pendente(timestamptz)');
  IF v_vivo IS NULL OR v_vivo NOT IN ('a99fd7dbdd0c8590698546b162f1a68f', '02af26b119ebda4f9bacfe32b42a3349') THEN
    RAISE EXCEPTION 'PRE FALHOU: radar_aplicar_situacao_pendente vivo (md5 %) não é o predecessor revisado nem este', v_vivo;
  END IF;
  SELECT md5(p.prosrc) INTO v_base FROM pg_catalog.pg_proc p
   WHERE p.oid = to_regprocedure('public.radar_aplicar_situacao(text,timestamptz)');
  IF v_base IS DISTINCT FROM '3b99d4ddd83b8b49b1a2965439d56002' THEN
    RAISE EXCEPTION 'PRE FALHOU: a função de aplicação do lote viva (md5 %) não é a revisada — o passo (a) das fatias a espelha', v_base;
  END IF;
  IF to_regclass('public.radar_ingest_state') IS NULL OR to_regclass('public.radar_situacao_cadastral') IS NULL THEN
    RAISE EXCEPTION 'PRE FALHOU: radar_ingest_state ou radar_situacao_cadastral ausente';
  END IF;
END
$pre$;

-- Passada em curso da foto RFB: 1 linha, 1 escritor (radar_aplicar_situacao_pendente, SECURITY DEFINER).
CREATE TABLE IF NOT EXISTS public.radar_situacao_passada (
  id                smallint PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  lote              text NOT NULL CHECK (lote ~ '^[0-9]{4}-[0-9]{2}$'),
  fechamento        timestamptz NOT NULL,
  iniciada_em       timestamptz NOT NULL,
  cursor_cnpj       text NOT NULL,
  fatias_concluidas boolean NOT NULL,
  rodadas           integer NOT NULL CHECK (rodadas >= 1),
  fotos             bigint NOT NULL CHECK (fotos >= 0)
);
ALTER TABLE public.radar_situacao_passada ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.radar_situacao_passada FROM PUBLIC, anon, authenticated;
COMMENT ON TABLE public.radar_situacao_passada IS
  'Passada em curso da foto RFB do Radar (radar_aplicar_situacao_pendente em fatias de CNPJs do lote): lote e fechamento (finalizado_em) da passada, cursor (último CNPJ feito) e fotos gravadas. Apagar a linha recomeça a passada do zero.';

CREATE OR REPLACE FUNCTION public.radar_aplicar_situacao_pendente(p_agora timestamp with time zone DEFAULT now())
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
 SET lock_timeout TO '5s'
AS $function$
DECLARE
  v_ini        timestamptz := clock_timestamp();
  r            record;
  v_res        jsonb;
  v_lotes      jsonb := '[]'::jsonb;
  v_aplicados  integer := 0;
  v_marcados   integer;
  v_adiado     text;
  -- Fatias (20261120170000): CNPJs do lote em ordem, a partir do cursor, por comando. ADAPTATIVA (começa em
  -- 1.000; mira 1–4 s por fatia) e orçamento por chamada com MARGEM: não abre fatia nova se o tempo gasto + 2× a
  -- última passar do orçamento. Um 57014 desfaria a chamada inteira (a função é uma transação só).
  -- GUC de sessão (operação e prova): radar.situacao_linhas_fatia fixa o tamanho (sem adaptar); radar.situacao_orcamento.
  c_linhas_guc  CONSTANT integer := LEAST(100000, GREATEST(1,
                  NULLIF(current_setting('radar.situacao_linhas_fatia', true), '')::integer));
  c_linhas_ini  CONSTANT integer := 1000;
  c_linhas_max  CONSTANT integer := 20000;
  c_orcamento   CONSTANT interval := COALESCE(
                  NULLIF(current_setting('radar.situacao_orcamento', true), '')::interval, interval '45 seconds');
  -- Fatia que ESCREVE abre subtransação com XID (o bloco EXCEPTION); acima de 64 na mesma transação o PGPROC
  -- transborda (suboverflow). Teto abaixo disso.
  c_max_fatias_escritas CONSTANT integer := 60;
  v_pas          public.radar_situacao_passada%ROWTYPE;
  v_tem_passada  boolean;
  v_parcial      jsonb;
  v_tam          integer;
  v_t0           timestamptz;
  v_ult          interval := interval '0';
  v_fatias       integer := 0;
  v_fatias_escritas integer := 0;
  v_interrompido text;
  f_lidos        bigint;
  f_ate          text;
  f_fotos        bigint;
  v_fotos_rod    bigint := 0;
BEGIN
  IF p_agora IS NULL THEN
    RAISE EXCEPTION 'radar_aplicar_situacao_pendente: p_agora não pode ser NULL' USING ERRCODE = '22023';
  END IF;
  -- Uma rodada por vez, sem esperar: outra em curso → esta não faz nada (o cron repete).
  IF NOT pg_try_advisory_xact_lock(20261027, 1) THEN
    RETURN jsonb_build_object('adiado', 'outra_rodada_em_andamento');
  END IF;

  -- Passada válida = o lote dela segue complete e pendente no MESMO fechamento. Senão perdeu o objeto.
  SELECT * INTO v_pas FROM public.radar_situacao_passada WHERE id = 1;
  v_tem_passada := FOUND;
  IF v_tem_passada AND NOT EXISTS (
       SELECT 1 FROM public.radar_ingest_state s
        WHERE s.mes_referencia = v_pas.lote AND s.status = 'complete' AND s.finalizado_em = v_pas.fechamento
          AND s.situacao_aplicada_fechamento IS DISTINCT FROM s.finalizado_em) THEN
    DELETE FROM public.radar_situacao_passada WHERE id = 1;
    v_tem_passada := false;
  END IF;

  FOR r IN
    SELECT i.mes_referencia, i.finalizado_em,
           -- o "mais novo" no MESMO snapshot das linhas pendentes (Codex ALTO 2)
           (SELECT max(m.mes_referencia) FROM public.radar_ingest_state m WHERE m.status = 'complete') AS mais_novo
      FROM public.radar_ingest_state i
     WHERE i.status = 'complete'
       AND i.finalizado_em IS NOT NULL
       AND i.situacao_aplicada_fechamento IS DISTINCT FROM i.finalizado_em
     ORDER BY i.mes_referencia
     FOR UPDATE OF i SKIP LOCKED
  LOOP
    IF v_tem_passada AND r.mes_referencia = v_pas.lote AND r.finalizado_em IS DISTINCT FROM v_pas.fechamento THEN
      -- Re-finalizado entre a leitura da passada e o FOR: a passada não vale; segue a regra sem passada.
      v_tem_passada := false;
    END IF;
    IF v_tem_passada AND r.mes_referencia > v_pas.lote THEN
      -- A linha do lote da passada está travada por outra sessão (SKIP LOCKED): espera a próxima chamada.
      v_adiado := 'lote_da_passada_travado';
      EXIT;
    END IF;

    IF (v_tem_passada AND r.mes_referencia = v_pas.lote) OR (NOT v_tem_passada AND r.mes_referencia = r.mais_novo) THEN
      IF NOT v_tem_passada THEN
        v_pas.id                := 1;
        v_pas.lote              := r.mes_referencia;
        v_pas.fechamento        := r.finalizado_em;
        v_pas.iniciada_em       := p_agora;
        v_pas.cursor_cnpj       := '';
        v_pas.fatias_concluidas := false;
        v_pas.rodadas           := 0;
        v_pas.fotos             := 0;
        v_tem_passada := true;
      END IF;
      v_pas.rodadas := v_pas.rodadas + 1;

      IF NOT v_pas.fatias_concluidas THEN
        v_tam := COALESCE(c_linhas_guc, c_linhas_ini);
        LOOP
          IF v_fatias > 0
             AND (clock_timestamp() - v_ini + 2 * v_ult > c_orcamento OR v_fatias_escritas >= c_max_fatias_escritas) THEN
            v_interrompido := 'orcamento';
            EXIT;
          END IF;
          v_t0 := clock_timestamp();
          BEGIN
            -- O passo (a) da função de prod, recortado nos próximos CNPJs do lote: mesmo SET, mesmo predicado.
            -- UM comando por fatia: a fatia, o UPDATE e o cursor partilham o MESMO snapshot.
            WITH fatia AS MATERIALIZED (
              SELECT s.cnpj, s.situacao, s.data_situacao, s.lote
                FROM public.radar_situacao_cadastral s
               WHERE s.lote = r.mes_referencia AND s.cnpj > v_pas.cursor_cnpj
               ORDER BY s.cnpj
               LIMIT v_tam
            ), foto AS (
              UPDATE public.radar_empresas re
                 SET rfb_situacao = s.situacao, rfb_situacao_data = s.data_situacao, rfb_situacao_lote = s.lote,
                     updated_at = p_agora
                FROM fatia s
               WHERE s.cnpj = re.cnpj
                 AND (re.rfb_situacao_lote IS NULL OR re.rfb_situacao_lote <= r.mes_referencia)
                 AND (re.rfb_situacao IS DISTINCT FROM s.situacao
                      OR re.rfb_situacao_data IS DISTINCT FROM s.data_situacao
                      OR re.rfb_situacao_lote IS DISTINCT FROM s.lote)
              RETURNING re.cnpj
            )
            SELECT count(*), max(f.cnpj), (SELECT count(*) FROM foto)
              INTO f_lidos, f_ate, f_fotos
              FROM fatia f;
          EXCEPTION WHEN lock_not_available OR deadlock_detected THEN
            -- Linha travada por outro escritor: a fatia volta atrás (subtransação) e a chamada encerra com o feito.
            v_interrompido := 'trava';
            EXIT;
          END;
          v_fatias := v_fatias + 1;
          IF f_lidos > 0 THEN
            v_pas.cursor_cnpj := f_ate;
          END IF;
          v_fotos_rod := v_fotos_rod + f_fotos;
          IF f_fotos > 0 THEN
            v_fatias_escritas := v_fatias_escritas + 1;
          END IF;
          IF f_lidos < v_tam THEN
            v_pas.fatias_concluidas := true;   -- o lote acabou nesta fatia
            EXIT;
          END IF;
          v_ult := clock_timestamp() - v_t0;
          IF c_linhas_guc IS NULL THEN
            IF v_ult > interval '4 seconds' THEN
              v_tam := GREATEST(100, v_tam / 2);
            ELSIF v_ult < interval '1 second' THEN
              v_tam := LEAST(c_linhas_max, v_tam + v_tam / 2);
            END IF;
          END IF;
        END LOOP;
        v_pas.fotos := v_pas.fotos + v_fotos_rod;
        v_parcial := jsonb_build_object(
          'lote', r.mes_referencia, 'parcial', true,
          'interrompido', CASE WHEN v_pas.fatias_concluidas THEN 'fatias_concluidas' ELSE v_interrompido END,
          'fotos_nesta_rodada', v_fotos_rod, 'fatias_nesta_rodada', v_fatias);
        -- A conclusão fica para a chamada seguinte: esta já gastou o orçamento das fatias.
        EXIT;
      END IF;

      -- CONCLUSÃO: a função de prod inteira. O passo (a) dela reconcilia o que as fatias não cobriram; (b) e (c)
      -- descartam e alertam como antes.
      BEGIN
        v_res := public.radar_aplicar_situacao(r.mes_referencia, p_agora);
      EXCEPTION WHEN lock_not_available OR deadlock_detected THEN
        v_parcial := jsonb_build_object('lote', r.mes_referencia, 'parcial', true, 'interrompido', 'trava_na_conclusao');
        EXIT;
      END;
      v_res := v_res || jsonb_build_object(
        'fotos_atualizadas', v_pas.fotos + (v_res->>'fotos_atualizadas')::bigint,
        'passada', jsonb_build_object('iniciada_em', v_pas.iniciada_em, 'rodadas', v_pas.rodadas,
                                      'fotos_nas_fatias', v_pas.fotos,
                                      'fotos_na_conclusao', (v_res->>'fotos_atualizadas')::bigint));
      DELETE FROM public.radar_situacao_passada WHERE id = 1;
      v_tem_passada := false;
      v_aplicados := v_aplicados + 1;
    ELSE
      -- Foto superada: aplicar descartaria/alertaria por situação que o lote mais novo já pode ter revertido.
      v_res := jsonb_build_object('lote', r.mes_referencia, 'superado_por', r.mais_novo);
    END IF;

    UPDATE public.radar_ingest_state
       SET situacao_aplicada_fechamento = r.finalizado_em, situacao_aplicada_em = p_agora,
           situacao_resultado = v_res
     WHERE mes_referencia = r.mes_referencia AND status = 'complete' AND finalizado_em = r.finalizado_em;
    GET DIAGNOSTICS v_marcados = ROW_COUNT;
    IF v_marcados <> 1 THEN
      RAISE EXCEPTION 'radar_aplicar_situacao_pendente: marcou % linha(s) para o lote % (esperado 1)', v_marcados, r.mes_referencia
        USING ERRCODE = '25000';
    END IF;
    v_lotes := v_lotes || v_res;
    IF v_aplicados > 0 THEN
      EXIT;   -- um lote aplicado por chamada: o seguinte (se houver) começa na próxima
    END IF;
  END LOOP;

  IF v_parcial IS NOT NULL THEN
    v_parcial := v_parcial || jsonb_build_object(
      'passada', jsonb_build_object('iniciada_em', v_pas.iniciada_em, 'rodadas', v_pas.rodadas,
                                    'cursor_cnpj', v_pas.cursor_cnpj, 'fotos', v_pas.fotos),
      'duracao_ms', round(extract(epoch FROM clock_timestamp() - v_ini) * 1000)::integer);
    INSERT INTO public.radar_situacao_passada AS t
           (id, lote, fechamento, iniciada_em, cursor_cnpj, fatias_concluidas, rodadas, fotos)
    VALUES (1, v_pas.lote, v_pas.fechamento, v_pas.iniciada_em, v_pas.cursor_cnpj, v_pas.fatias_concluidas,
            v_pas.rodadas, v_pas.fotos)
    ON CONFLICT (id) DO UPDATE
       SET lote = EXCLUDED.lote, fechamento = EXCLUDED.fechamento, iniciada_em = EXCLUDED.iniciada_em,
           cursor_cnpj = EXCLUDED.cursor_cnpj, fatias_concluidas = EXCLUDED.fatias_concluidas,
           rodadas = EXCLUDED.rodadas, fotos = EXCLUDED.fotos;
  END IF;

  IF jsonb_array_length(v_lotes) > 0 THEN
    INSERT INTO public.acoes_execucoes (acao, origem, iniciado_em, finalizado_em, status, detalhes)
    VALUES ('radar.aplicar_situacao', 'automatica', v_ini, clock_timestamp(), 'sucesso',
            jsonb_build_object('lotes', v_lotes, 'aplicados', v_aplicados, 'marcados', jsonb_array_length(v_lotes)));
  END IF;
  IF v_parcial IS NOT NULL THEN
    -- Observabilidade da passada em OUTRA acao (os leitores da aplicação veem só a conclusão); fail-open.
    BEGIN
      INSERT INTO public.acoes_execucoes (acao, origem, iniciado_em, finalizado_em, status, detalhes)
      VALUES ('radar.aplicar_situacao_parcial', 'automatica', v_ini, clock_timestamp(), 'sucesso', v_parcial);
    EXCEPTION WHEN OTHERS THEN
      NULL;
    END;
  END IF;

  RETURN jsonb_build_object('aplicados', v_aplicados, 'marcados', jsonb_array_length(v_lotes), 'lotes', v_lotes)
         || CASE WHEN v_parcial IS NULL THEN '{}'::jsonb ELSE jsonb_build_object('parcial', v_parcial) END
         || CASE WHEN v_adiado IS NULL THEN '{}'::jsonb ELSE jsonb_build_object('adiado', v_adiado) END;
END;
$function$;

-- Job: de 5 em 5 min nas horas do continua do score, 2 min depois dele.
DO $job$
DECLARE
  c_cmd CONSTANT text := 'SET statement_timeout = ''5min''; SELECT public.radar_aplicar_situacao_pendente();';
  v_id  bigint;
BEGIN
  SELECT jobid INTO v_id FROM cron.job WHERE jobname = 'radar-aplicar-situacao-diario';
  IF v_id IS NULL THEN
    RAISE EXCEPTION 'TRAVA: cron radar-aplicar-situacao-diario ausente — a 20261027010000 não está aplicada';
  END IF;
  PERFORM cron.alter_job(job_id := v_id, schedule := '2-59/5 0-5,7-10 * * *', command := c_cmd);
END
$job$;

-- PÓS
DO $post$
DECLARE
  c_cmd CONSTANT text := 'SET statement_timeout = ''5min''; SELECT public.radar_aplicar_situacao_pendente();';
  f     CONSTANT regprocedure := to_regprocedure('public.radar_aplicar_situacao_pendente(timestamptz)');
BEGIN
  -- P1: a função viva é ESTE arquivo (md5 exato do prosrc), SECURITY DEFINER com lock_timeout e search_path.
  IF (SELECT md5(prosrc) FROM pg_catalog.pg_proc WHERE oid = f) IS DISTINCT FROM '02af26b119ebda4f9bacfe32b42a3349' THEN
    RAISE EXCEPTION 'P1 FALHOU: radar_aplicar_situacao_pendente vivo não é o corpo deste arquivo';
  END IF;
  IF NOT COALESCE((SELECT prosecdef AND proconfig @> ARRAY['lock_timeout=5s', 'search_path=public, pg_temp']
                     FROM pg_catalog.pg_proc WHERE oid = f), false) THEN
    RAISE EXCEPTION 'P1 FALHOU: radar_aplicar_situacao_pendente sem SECURITY DEFINER, lock_timeout=5s ou search_path';
  END IF;
  -- P2: tabela da passada com RLS e fechada para anon/authenticated.
  IF NOT COALESCE((SELECT relrowsecurity FROM pg_class WHERE oid = to_regclass('public.radar_situacao_passada')), false) THEN
    RAISE EXCEPTION 'P2 FALHOU: radar_situacao_passada ausente ou sem RLS';
  END IF;
  IF has_table_privilege('anon', 'public.radar_situacao_passada', 'SELECT')
     OR has_table_privilege('authenticated', 'public.radar_situacao_passada', 'SELECT') THEN
    RAISE EXCEPTION 'P2 FALHOU: radar_situacao_passada legível por anon/authenticated';
  END IF;
  -- P3: ACL preservado (CREATE OR REPLACE mantém): PUBLIC, anon e authenticated não executam.
  IF has_function_privilege('anon', f, 'EXECUTE')
     OR has_function_privilege('authenticated', f, 'EXECUTE')
     OR EXISTS (SELECT 1 FROM pg_proc p, aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) a
                 WHERE p.oid = f AND a.grantee = 0 AND a.privilege_type = 'EXECUTE') THEN
    RAISE EXCEPTION 'P3 FALHOU: ACL de radar_aplicar_situacao_pendente abriu';
  END IF;
  -- P4: o job existe, ativo, no horário novo, com o comando novo, e roda como postgres; o relógio do cron é UTC.
  IF NOT EXISTS (SELECT 1 FROM cron.job
                  WHERE jobname = 'radar-aplicar-situacao-diario' AND active AND username = 'postgres'
                    AND schedule = '2-59/5 0-5,7-10 * * *' AND command = c_cmd) THEN
    RAISE EXCEPTION 'P4 FALHOU: cron radar-aplicar-situacao-diario ausente, inativo, divergente ou sem dono postgres';
  END IF;
  IF COALESCE(current_setting('cron.timezone', true), '') NOT IN ('', 'GMT', 'UTC') THEN
    RAISE EXCEPTION 'P4 FALHOU: cron.timezone=% — o horário deixaria de ser UTC', current_setting('cron.timezone', true);
  END IF;
END
$post$;
