-- =============================================================================
-- Radar: a fatia da foto RFB volta a ser ADAPTATIVA sem a GUC (correção da 20261120170000)
-- =============================================================================
-- Medido em prod em 2026-11-20 12:53 UTC, logo depois da 20261120170000 (recibo db:aplicar #1224), pelo
-- db/2026-11-20-radar-situacao-tick-medido.sql em ensaio (ROLLBACK): cada chamada fez 40.578 fatias de 1 CNPJ em 45 s.
-- A causa é a trava da GUC radar.situacao_linhas_fatia (Codex BAIXO 10): LEAST(100000, GREATEST(1, NULL)) dá 1,
-- porque GREATEST e LEAST ignoram NULL. Sem a GUC (o cron nunca a define), o tamanho ficava fixo em 1 e não adaptava:
-- ~40 mil linhas por chamada em vez de dezenas de milhares por fatia, e um lote de 585 mil CNPJs levaria ~15 chamadas
-- SÓ de leitura, mais a escrita a 1 linha por comando. A prova da 20261120170000 sempre definia a GUC: o caminho
-- de prod ficou fora dela. Nenhum lote pendente entre as duas (o 2026-11 foi aplicado em 17/11): nenhum efeito.
--
-- O que muda: só a linha da GUC (CASE: ausente → NULL → adaptativo, 1.000 CNPJs no início). O resto do corpo é o
-- da 20261120170000, byte a byte. Prova: db/test-radar-situacao-fatias.sh (G1: sem GUC, a 1ª fatia tem 1.000 CNPJs).
-- Recria função VIVA no molde TRAVA → PRE → CREATE → PÓS. Arquivo para `bun run db:aplicar` (sem BEGIN/COMMIT).
-- ============================================================

-- TRAVA, antes de ler: ALTER sem efeito (a volatilidade VIVA) na função que a PRE guarda.
DO $trava$
BEGIN
  IF to_regprocedure('public.radar_aplicar_situacao_pendente(timestamptz)') IS NOT NULL THEN
    ALTER FUNCTION public.radar_aplicar_situacao_pendente(timestamptz) VOLATILE;
  END IF;
END
$trava$;

-- PRE: o corpo vivo é o da 20261120170000 ou este; a função de aplicação é a revisada; a passada existe.
DO $pre$
DECLARE
  v_vivo text;
BEGIN
  SELECT md5(p.prosrc) INTO v_vivo FROM pg_catalog.pg_proc p
   WHERE p.oid = to_regprocedure('public.radar_aplicar_situacao_pendente(timestamptz)');
  IF v_vivo IS NULL OR v_vivo NOT IN ('02af26b119ebda4f9bacfe32b42a3349', '6f0c36ab95c70c6b1c1c70f74c1daf90') THEN
    RAISE EXCEPTION 'PRE FALHOU: radar_aplicar_situacao_pendente vivo (md5 %) não é o da 20261120170000 nem este', v_vivo;
  END IF;
  IF (SELECT md5(p.prosrc) FROM pg_catalog.pg_proc p
       WHERE p.oid = to_regprocedure('public.radar_aplicar_situacao(text,timestamptz)'))
     IS DISTINCT FROM '3b99d4ddd83b8b49b1a2965439d56002' THEN
    RAISE EXCEPTION 'PRE FALHOU: a função de aplicação do lote viva não é a revisada';
  END IF;
  IF to_regclass('public.radar_situacao_passada') IS NULL THEN
    RAISE EXCEPTION 'PRE FALHOU: radar_situacao_passada ausente — a 20261120170000 não está aplicada';
  END IF;
END
$pre$;

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
  -- GUC ausente → NULL (adaptativo). GREATEST/LEAST IGNORAM NULL: sem o CASE, a GUC ausente virava 1 CNPJ por fatia
  -- (20261120180000: medido em prod, 40.578 fatias de 1 linha em 45 s).
  c_linhas_guc  CONSTANT integer := CASE WHEN NULLIF(current_setting('radar.situacao_linhas_fatia', true), '') IS NULL THEN NULL
                  ELSE LEAST(100000, GREATEST(1, current_setting('radar.situacao_linhas_fatia', true)::integer)) END;
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

-- PÓS
DO $post$
DECLARE
  f CONSTANT regprocedure := to_regprocedure('public.radar_aplicar_situacao_pendente(timestamptz)');
BEGIN
  IF (SELECT md5(prosrc) FROM pg_catalog.pg_proc WHERE oid = f) IS DISTINCT FROM '6f0c36ab95c70c6b1c1c70f74c1daf90' THEN
    RAISE EXCEPTION 'P1 FALHOU: radar_aplicar_situacao_pendente vivo não é o corpo deste arquivo';
  END IF;
  IF NOT COALESCE((SELECT prosecdef AND proconfig @> ARRAY['lock_timeout=5s', 'search_path=public, pg_temp']
                     FROM pg_catalog.pg_proc WHERE oid = f), false) THEN
    RAISE EXCEPTION 'P1 FALHOU: radar_aplicar_situacao_pendente sem SECURITY DEFINER, lock_timeout=5s ou search_path';
  END IF;
  IF has_function_privilege('anon', f, 'EXECUTE')
     OR has_function_privilege('authenticated', f, 'EXECUTE')
     OR EXISTS (SELECT 1 FROM pg_proc p, aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) a
                 WHERE p.oid = f AND a.grantee = 0 AND a.privilege_type = 'EXECUTE') THEN
    RAISE EXCEPTION 'P3 FALHOU: ACL de radar_aplicar_situacao_pendente abriu';
  END IF;
END
$post$;
