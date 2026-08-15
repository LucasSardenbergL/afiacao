-- ============================================================================================
-- Migration — Sentinela: desfaz DOIS validadores do contrato que reprovavam dado LEGÍTIMO
-- (2026-08-15 · money-path · corrige a 20260814222000, medido em prod no 1º tick do v2)
-- ============================================================================================
-- INCIDENTE (auto-infligido, detectado pelo próprio dead-man): a 20260814222000 foi aplicada
-- 2026-08-15 14:26 (SP). No PRIMEIRO tick do cron (14:30) o vigia registrou **7 dos 17 checks
-- falhos** e `last_success_at` NÃO avançou — fail-closed funcionando, mas contra dado BOM:
--
--   status=ok + severity=critical  → vendas_pedidos · omie_tipo_produto_oben ·
--                                    estoque_reposicao · pedidos_compra_sync
--   ok + age_seconds NULL          → reposicao_portal_pipeline · reposicao_portal_humano ·
--                                    tint_cobertura_bases
--
-- POR QUE OS DOIS ESTAVAM ERRADOS (medido no corpo vivo de `_data_health_compute`, não deduzido):
--   1. `severity` é LITERAL POR CHECK — `'critical'::text AS severity` sem CASE nenhum (8
--      ocorrências). Ela descreve "quão grave é ESTE check QUANDO degrada", não o estado atual.
--      Logo `ok` + `critical` é o estado NORMAL de um check crítico saudável, não contradição.
--   2. Os 3 de frescor derivam a idade de `min(atualizado_em)` sobre as linhas PENDENTES. Zero
--      pendente ⇒ `min` NULL ⇒ `EXTRACT` NULL ⇒ `age_seconds` NULL COM `status='ok'`. É a
--      forma de dizer "não há nada pendente, logo não há idade" — o caso SAUDÁVEL.
--
-- Custo real dos 30 min em que ficou no ar: os 7 checks NÃO eram avaliados (abortavam antes de
-- qualquer coisa), o que inclui 2 vigias de money-path (`reposicao_portal_humano`,
-- `pedidos_compra_sync`). Trocar silêncio-por-alerta-preso por silêncio-por-check-cego é pior
-- que o bug original: pelo menos o preso tinha uma linha em `fin_alertas`.
--
-- LIÇÃO (a regra do repo que eu quebrei): "MEÇA o dado antes de propor o CHECK". Os dois
-- validadores vieram de raciocínio do challenge Codex sobre combinações *teoricamente*
-- contraditórias e foram para produção sem uma única query contra a distribuição REAL. O
-- harness PG17 não pegou porque a mesa de controle foi semeada com a forma que eu ASSUMI — um
-- fixture que reproduz a premissa errada confirma a premissa errada. O oráculo aqui não era o
-- teste: era `pg_get_functiondef('_data_health_compute')` + um `SELECT` na distribuição.
--
-- O QUE FICA: todo o resto do contrato fail-closed permanece — status fora de
-- {ok,stale,broken,unknown} e severity fora de {critical,warning,info} seguem abortando o
-- check, sem resolver alerta ativo. Só os 2 predicados acima saem.
--
-- ⚠️ GUARD ANTI-DRIFT + marcador VERSIONADO: gerado do corpo VIVO de prod em 2026-08-15
-- (md5 75befeb5f7e6607d0743ea45fba5b4d3, que é a v1 aplicada). Marcador sobe para
-- 'data_health reemissao v2' — re-aplicar a 20260814222000 por cima desta ABORTA (o md5 não
-- bate e o marcador v1 não está mais lá), em vez de reintroduzir os validadores em silêncio.
--
-- PROVA PG17: db/test-data-health-watchdog-reemissao.sh (aplica as DUAS migrations em ordem;
-- K5/K6 invertidos para exigir que o dado legítimo seja ACEITO).
-- ============================================================================================

BEGIN;

DO $guard$
DECLARE
  v_def text;
  v_md5 text;
BEGIN
  IF to_regprocedure('public.data_health_watchdog()') IS NULL THEN
    RAISE EXCEPTION USING message =
      'PRE-FLIGHT ABORTOU: public.data_health_watchdog() não existe. Aplique antes a 20260814222000.';
  END IF;
  v_def := pg_get_functiondef('public.data_health_watchdog()'::regprocedure);
  v_md5 := md5(v_def);
  IF v_md5 <> '75befeb5f7e6607d0743ea45fba5b4d3' AND v_def NOT LIKE '%data_health reemissao v2%' THEN
    RAISE EXCEPTION USING message =
      'PRE-FLIGHT ABORTOU: data_health_watchdog vivo (md5 ' || v_md5 || ') não é a v1 esperada '
      || '(md5 75befeb5f7e6607d0743ea45fba5b4d3) nem já é esta v2. Outra migration recriou a '
      || 'função — rebasear sobre o pg_get_functiondef atual e re-gerar.';
  END IF;
END
$guard$;

CREATE OR REPLACE FUNCTION public.data_health_watchdog()
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
-- data_health reemissao v2 (mig 20260815153218) — MARCADOR do guard anti-rollback.
DECLARE
  -- ⚠️ estoque_reposicao: 18º check, adicionado DIRETO EM PROD (migration fora do repo, drift §5),
  --    promovido ao push (watchdog+heartbeat) lá. PRESERVADO aqui pra não revertê-lo do e-mail.
  -- ⚠️ tint_vinculo_omie fica FORA de propósito (dashboard-only, [VIGIA tint 2026-06-15]).
  -- Esta ARRAY é a fonte única: filtra o compute E define o esperado do dead-man. Duas listas
  -- separadas driftariam, e o dead-man passaria a medir a própria omissão como sucesso.
  v_sources text[] := ARRAY[
    'vendas_pedidos','estoque_inventario','estoque_reposicao','reposicao_sugestoes','carteira_scores',
    'custos_produtos','vendas_cadastros',
    'reposicao_disparo','reposicao_portal_pipeline','reposicao_portal_humano',
    'reposicao_sayerlack_fabricado','omie_tipo_produto_oben','vendas_familia_ausente',
    'tint_cobertura_bases',
    'custos_proxy_conf_alta','custos_product_cost_revivido','pedidos_compra_sync'];
  v_deadman_h int := 3;   -- cron é */30 ⇒ 3h = 6 rodadas completas perdidas
  r           record;
  v_rows      jsonb;
  v_n         int;
  v_ndist     int;
  v_esperado  int := array_length(v_sources, 1);
  v_completa  boolean;
  v_sev_fin   text;
  v_fp        text;
  v_msg_email text;
  v_falhos    int := 0;
  v_erros     text[] := '{}';
  v_last_ok   timestamptz;
  v_last_run  timestamptz;
  v_cego      boolean;
  v_msg_dm    text;
BEGIN
  -- ── DEAD-MAN (avalia o estado da rodada ANTERIOR, antes de sobrescrevê-lo) ────────────────
  SELECT last_success_at, last_run_at INTO v_last_ok, v_last_run
    FROM public.data_health_watchdog_estado WHERE id;

  -- ⚠️ O ramo `last_success_at IS NULL` é obrigatório (achado Codex A3): um vigia que NUNCA
  -- completou uma rodada tem marcador nulo, e ancorar só no marcador o deixaria calado
  -- exatamente no cenário pior — quebrado desde o primeiro dia.
  v_cego := (v_last_ok IS NOT NULL AND v_last_ok < clock_timestamp() - make_interval(hours => v_deadman_h))
         OR (v_last_ok IS NULL AND v_last_run IS NOT NULL
             AND v_last_run < clock_timestamp() - make_interval(hours => v_deadman_h));

  IF v_cego THEN
    v_msg_dm := 'Vigia de saúde de dados sem rodada COMPLETA desde '
             || COALESCE(to_char(v_last_ok AT TIME ZONE 'America/Sao_Paulo', 'DD/MM HH24:MI'), 'NUNCA')
             || ' — os checks estão sendo avaliados parcialmente e um incidente pode passar mudo.';
    -- Isolado: se o OUTBOX estiver fora, o meta-alerta não pode derrubar a avaliação dos 17
    -- checks. O sinal que sobrevive a um outbox morto é o marcador envelhecendo, não o e-mail.
    BEGIN
      PERFORM public._data_health_episodio(
        'oben', 'data_health_watchdog_degradado', 'broken', 'critico',
        '[Saúde de dados] vigia degradado', v_msg_dm, NULL,
        jsonb_build_object('last_success_at', v_last_ok, 'limite_horas', v_deadman_h),
        -- fingerprint ancorado no MINUTO do último sucesso: estável enquanto o vigia seguir cego
        -- (senão o próprio dead-man viraria a tempestade que ele existe para denunciar).
        md5('deadman|' || COALESCE(to_char(v_last_ok, 'YYYY-MM-DD"T"HH24:MI'), 'nunca')));
    EXCEPTION WHEN OTHERS THEN
      RAISE WARNING 'data_health_watchdog: dead-man nao pode ser enfileirado: % %', SQLSTATE, SQLERRM;
    END;
  ELSIF v_last_ok IS NOT NULL THEN
    UPDATE public.fin_alertas SET dismissed_at = now(), resolvido_em = now()
     WHERE company = 'oben' AND tipo = 'data_health_watchdog_degradado' AND dismissed_at IS NULL;
  END IF;

  INSERT INTO public.data_health_watchdog_estado (id, last_run_at, atualizado_em)
  VALUES (true, clock_timestamp(), clock_timestamp())
  ON CONFLICT (id) DO UPDATE SET last_run_at = clock_timestamp(), atualizado_em = clock_timestamp();

  -- Materializa UMA execução do compute (é caro; e duas execuções poderiam divergir entre a
  -- checagem de duplicata e o laço).
  -- ⚠️ ISOLADO, e o laço fica CONDICIONADO ao sucesso (achado Codex A3): o `BEGIN/EXCEPTION` do
  -- dead-man é subtransação, NÃO transação autônoma — um erro global DEPOIS dele (compute
  -- quebrado, fonte duplicada) abortava a transação inteira e desfazia o próprio alerta do
  -- dead-man, repetindo isso a cada 30 min sem deixar rastro nenhum.
  v_rows := NULL;
  BEGIN
    SELECT COALESCE(jsonb_agg(to_jsonb(t)), '[]'::jsonb) INTO v_rows
      FROM public._data_health_compute() t
     WHERE t.source = ANY (v_sources);
  EXCEPTION WHEN OTHERS THEN
    IF left(SQLSTATE, 2) IN ('40','53','57','58','XX') THEN
      RAISE;
    END IF;
    v_falhos := v_falhos + 1;
    v_erros  := v_erros || ('_data_health_compute: ' || SQLSTATE || ' ' || SQLERRM);
  END;

  IF v_rows IS NULL THEN
    v_n := 0; v_ndist := 0;
  ELSE
    SELECT count(*), count(DISTINCT x.source) INTO v_n, v_ndist
      FROM jsonb_to_recordset(v_rows) AS x(source text);

    -- Fonte DUPLICADA: o compute está quebrado. NÃO se avalia nada (nenhum alerta ativo pode ser
    -- resolvido com base em dado que não se pode julgar) — mas também NÃO se aborta a transação,
    -- senão o registro de estado e o meta-alerta iriam junto. Vira rodada incompleta, alta.
    IF v_n <> v_ndist THEN
      v_falhos := v_falhos + 1;
      v_erros  := v_erros || ('_data_health_compute: fonte duplicada (' || v_n || ' linhas, '
                              || v_ndist || ' fontes distintas) — laço NAO executado');
      v_rows   := NULL;
    END IF;
  END IF;

  v_completa := (v_rows IS NOT NULL AND v_n = v_esperado);

  FOR r IN
    SELECT * FROM jsonb_to_recordset(COALESCE(v_rows, '[]'::jsonb)) AS x(
      source text, "domain" text, status text, age_seconds bigint,
      expected_max_age_seconds bigint, freshness_basis text, message text,
      last_error text, probable_cause text, how_to_fix text, severity text)
  LOOP
    -- Isolamento por check: um erro em 1 não pode cegar os outros 16. O preço do isolamento é
    -- o silêncio — pago pelo dead-man + alerta dedicado abaixo.
    BEGIN
      IF r.status IS NULL OR r.status NOT IN ('ok','stale','broken','unknown') THEN
        RAISE EXCEPTION 'status desconhecido em %: %', r.source, COALESCE(r.status,'<NULL>')
          USING ERRCODE = '22023';
      END IF;
      IF r.severity IS NULL OR r.severity NOT IN ('critical','warning','info') THEN
        RAISE EXCEPTION 'severity desconhecida em %: %', r.source, COALESCE(r.severity,'<NULL>')
          USING ERRCODE = '22023';
      END IF;

      IF r.status = 'ok' THEN
        -- Resolução AUTOMÁTICA: só com 'ok' EXPLÍCITO. NULL/desconhecido nunca chega aqui.
        UPDATE public.fin_alertas SET dismissed_at = now(), resolvido_em = now()
         WHERE company = 'oben' AND tipo = 'data_health_' || r.source AND dismissed_at IS NULL;
      ELSE
        v_sev_fin := CASE r.severity WHEN 'critical' THEN 'critico'
                                     WHEN 'warning'  THEN 'aviso'
                                     ELSE 'info' END;

        -- FINGERPRINT: source|status|severity|message. Sem idade, sem timestamp, sem basis.
        v_fp := md5(r.source || '|' || r.status || '|' || r.severity || '|' || COALESCE(r.message, ''));

        -- DELTA [2026-07-08]: família-ausente e tint_cobertura_bases anexam a lista dos produtos
        -- ao corpo do e-mail. COALESCE p/ não anexar se vier NULL. A lista fica FORA do
        -- fingerprint de propósito (é volátil e enorme; a materialidade já está na contagem).
        v_msg_email := CASE
          WHEN r.source = 'vendas_familia_ausente'
            THEN r.message || COALESCE(E'\n\n' || public._vendas_familia_ausente_lista_email(50), '')
          WHEN r.source = 'tint_cobertura_bases'
            THEN r.message || COALESCE(E'\n\n' || public._tint_cobertura_bases_lista_email(50), '')
          ELSE r.message END;

        PERFORM public._data_health_episodio(
          'oben', 'data_health_' || r.source, r.status, v_sev_fin,
          '[Saúde de dados] ' || r.source, r.message, v_msg_email,
          jsonb_build_object('source', r.source, 'domain', r.domain, 'status', r.status,
                             'age_seconds', r.age_seconds, 'freshness_basis', r.freshness_basis),
          v_fp);
      END IF;
    EXCEPTION WHEN OTHERS THEN
      -- ⚠️ `WHEN OTHERS` ENGOLE falha SISTÊMICA (achado Codex F): permissão negada, tabela/coluna
      -- inexistente, deadlock, disco cheio, erro interno — nada disso é "problema daquele check",
      -- e engolir 17× troca um erro alto por 17 silêncios. Isolamento vale para falha LOCAL;
      -- classe 40 (rollback/serialização), 53 (recursos), 57 (intervenção), 58 (sistema) e XX
      -- (interno) são relançadas e derrubam a rodada inteira, alto e visível.
      IF left(SQLSTATE, 2) IN ('40','53','57','58','XX') THEN
        RAISE;
      END IF;
      v_falhos := v_falhos + 1;
      v_erros  := v_erros || (COALESCE(r.source,'<?>') || ': ' || SQLSTATE || ' ' || SQLERRM);
    END;
  END LOOP;

  -- ── Marcador de sucesso: só avança em rodada COMPLETA e SEM falha ─────────────────────────
  UPDATE public.data_health_watchdog_estado SET
      checks_avaliados = v_n,
      checks_falhos    = v_falhos,
      ultimo_erro      = CASE WHEN v_falhos = 0 AND v_completa THEN NULL
                              ELSE left(array_to_string(v_erros, ' || '), 4000) END,
      last_success_at  = CASE WHEN v_falhos = 0 AND v_completa THEN clock_timestamp()
                              ELSE last_success_at END,
      atualizado_em    = clock_timestamp()
   WHERE id;

  -- Falha BARULHENTA (não silenciosa): o isolamento por check só é aceitável com este alerta.
  IF v_falhos > 0 OR NOT v_completa THEN
    -- Isolado pelo mesmo motivo do dead-man: quando o próprio canal de e-mail é o que quebrou,
    -- este INSERT também quebra — e derrubar a transação aqui APAGARIA o UPDATE de estado
    -- acima, que é justamente a evidência durável de que a rodada foi ruim.
    BEGIN
      PERFORM public._data_health_episodio(
        'oben', 'data_health_watchdog_erro', 'broken', 'critico',
        '[Saúde de dados] vigia com check falhando',
        'Rodada incompleta do vigia: ' || v_n || ' de ' || v_esperado || ' fonte(s) presente(s), '
          || v_falhos || ' check(s) com erro. ' || COALESCE(left(array_to_string(v_erros, ' || '), 800), ''),
        NULL,
        jsonb_build_object('checks_avaliados', v_n, 'checks_esperados', v_esperado,
                           'checks_falhos', v_falhos, 'erros', to_jsonb(v_erros)),
        md5('vigia_erro|' || v_n::text || '|' || v_falhos::text || '|' || array_to_string(v_erros, '||')));
    EXCEPTION WHEN OTHERS THEN
      RAISE WARNING 'data_health_watchdog: alerta de erro nao pode ser enfileirado: % %', SQLSTATE, SQLERRM;
    END;
    RAISE WARNING 'data_health_watchdog: % check(s) falharam; % de % fontes presentes',
      v_falhos, v_n, v_esperado;
  ELSE
    UPDATE public.fin_alertas SET dismissed_at = now(), resolvido_em = now()
     WHERE company = 'oben' AND tipo = 'data_health_watchdog_erro' AND dismissed_at IS NULL;
  END IF;
END;
$function$;
COMMIT;
