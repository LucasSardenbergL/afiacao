-- ============================================================
-- Watchdog do sync Omie — iteração 4: "janela de graça no e-mail" do sync_stale
-- ============================================================
-- Dor (investigação 2026-05-30): outage TRANSITÓRIO do Omie (SOAP broken response)
-- em 28/05, ANTES do retry do #420 chegar em prod, fez toda passada de contas_receber
-- abortar → >18h sem 'complete' → a seção 1 (sync_stale) disparou 3 e-mails urgentes
-- "[Sync parado]" (CR colacor+oben, CP colacor_sc) ao founder. Com o retry ativo,
-- estabilizou e o watchdog AUTO-DISMISSOU em horas (todos os fin_alertas com
-- dismissed_at preenchido; dado de CR fresco). O founder tomou susto por um evento
-- já curado — e-mail não some da caixa sozinho; o alerta no banco sim.
--
-- Decisão (founder + codex consult): NÃO afrouxar o backstop. A seção 1 é o vigia de
-- "realmente parado" e foi ELA que pegou o incidente. Mexer só no RUÍDO DE E-MAIL:
-- o alerta INTERNO em fin_alertas continua sendo gravado na 1ª detecção (dashboard/
-- badge inalterado; backstop de 18h INTACTO), mas o E-MAIL [Sync parado] só é
-- enfileirado se o alerta PERSISTIR >= v_grace_mins (40 min ≈ sobreviveu a >=1 tick
-- do cron */30 sem auto-dismiss). Outage transitório que cura em <1 tick não vira
-- e-mail; parada real (>=40 min) avisa, com atraso de no máximo ~1 tick. Não mascara
-- outage real (o e-mail SAI depois da janela) e não enfraquece o backstop (o
-- fin_alertas grava na hora). Filosofia §5 preservada: vigiar EFEITO NO DADO.
--
-- Mecânica (codex): gate atômico por COLUNA + UPDATE...RETURNING (não SELECT+UPDATE).
--   fin_alertas.email_enfileirado_em IS NULL → ainda não notificado neste episódio.
--   O UPDATE ... WHERE email_enfileirado_em IS NULL AND criado_em <= now()-40min
--   marca a linha e, via IF FOUND, enfileira o e-mail UMA vez por episódio — e em
--   ticks sobrepostos só uma vence a corrida (a outra não acha linha p/ atualizar).
--   E-mail montado com v_msg FRESCO da tick que notifica (não a lista congelada da
--   1ª detecção → evita "3 recursos parados" quando só 1 ainda está).
--   Episódio que cura e volta 1h depois: novo INSERT (email_enfileirado_em NULL de
--   novo, criado_em novo) → nova janela de graça. Desejado.
--
-- CREATE OR REPLACE de UMA função, partindo VERBATIM da versão vigente
-- (20260528000000, tail-failing): seções 0 (varredura de órfãs), 2 (sync_error
-- tail-failing) e 3 (cursor travado) INALTERADAS; só a seção 1 muda. Sem objeto novo
-- além da coluna; sem mudar cron (fin-sync-watchdog já chama a função por nome).
-- fin_sync_heartbeat inalterado. Trigger trg_audit (AFTER UPDATE em fin_alertas) já
-- tolera UPDATE de dismissed_at em prod → UPDATE de email_enfileirado_em é seguro.

-- ------------------------------------------------------------
-- 1) Coluna de gate (idempotente). NULL = e-mail ainda não enfileirado p/ o episódio.
-- ------------------------------------------------------------
-- Coluna de gate + backfill de CUTOVER atômico (codex challenge). O backfill SÓ roda
-- no 1º deploy real (quando a coluna ACABOU de nascer), detectado lendo
-- information_schema ANTES do ALTER. Por quê: um sync_stale ATIVO no momento do deploy
-- foi criado pela lógica ANTIGA, que já enfileirou o e-mail na 1ª detecção. A coluna
-- nasce NULL nessas linhas → sem backfill, o 1º tick pós-deploy veria NULL+>40min e
-- RE-enfileiraria o e-mail (spam no mesmo episódio). Marca TODOS os ativos como
-- já-notificados (todos já mandaram e-mail). NÃO uso filtro temporal (>40min) porque
-- um ativo criado há <40min pela lógica antiga TAMBÉM já mandou e-mail e duplicaria.
-- Gate "1ª-criação": em RERUN a coluna já existe → backfill não roda → um alerta NOVO
-- legítimo da lógica nova (ainda na janela de graça, email_enfileirado_em NULL) NÃO é
-- suprimido por engano. Tudo num DO atômico, idempotente.
DO $cutover$
DECLARE
  v_col_existed boolean;
BEGIN
  SELECT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'fin_alertas'
      AND column_name = 'email_enfileirado_em'
  ) INTO v_col_existed;

  ALTER TABLE public.fin_alertas
    ADD COLUMN IF NOT EXISTS email_enfileirado_em timestamptz;

  COMMENT ON COLUMN public.fin_alertas.email_enfileirado_em IS
    'Quando o e-mail deste episódio de alerta foi enfileirado em fornecedor_alerta (gate "uma vez por episódio" + janela de graça do sync_stale). NULL = ainda não notificado. Recriado NULL a cada novo episódio (após dismiss + novo INSERT).';

  IF NOT v_col_existed THEN
    -- 1º deploy real: todo sync_stale ativo veio da lógica antiga (já notificado).
    UPDATE public.fin_alertas
    SET email_enfileirado_em = criado_em
    WHERE tipo = 'sync_stale' AND dismissed_at IS NULL;
  END IF;
END $cutover$;

-- ------------------------------------------------------------
-- 2) Função recriada (só a seção 1 mudou vs. iteração 3).
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.fin_sync_watchdog_check()
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE
  v_companies text[] := ARRAY['oben','colacor','colacor_sc'];
  v_resources text[] := ARRAY['contas_pagar','contas_receber','movimentacoes'];
  v_stale_hours  int := 18;
  v_error_hours  int := 6;
  v_cursor_hours int := 2;
  v_grace_mins   int := 40;  -- janela de graça do e-mail (>=1 tick do cron */30)
  c text;
  v_stale text[];
  v_errs  text[];
  v_stuck text[];
  v_msg text;
BEGIN
  -- 0) VARREDURA DE ÓRFÃS: pass 'running' que nunca finalizou (ver cabeçalho).
  --    Marca 'error'; o sinal sync_error abaixo paginará se o rabo do par estiver
  --    falhando (run mais recente em erro, >=2 consecutivos).
  UPDATE fin_sync_log
  SET status        = 'error',
      error_message = 'orphaned_running_timeout',
      completed_at  = CASE WHEN started_at > now() - make_interval(hours => v_error_hours)
                           THEN now() ELSE started_at END
  WHERE status = 'running'
    AND action LIKE 'sync_%'
    AND started_at < now() - interval '30 minutes';

  FOREACH c IN ARRAY v_companies LOOP
    -- 1) FRESCOR: par ATIVO (complete em 7d) sem complete na janela.
    --    O alerta INTERNO (fin_alertas) grava na 1ª detecção, igual sempre — backstop
    --    e dashboard/badge inalterados. O E-MAIL só sai se o alerta PERSISTIR
    --    >= v_grace_mins (gate atômico via email_enfileirado_em), de-noisando outage
    --    transitório do Omie que se auto-cura em <1 tick. v_msg do e-mail é FRESCO.
    SELECT array_agg(r ORDER BY r) INTO v_stale
    FROM unnest(v_resources) AS r
    WHERE EXISTS (
      SELECT 1 FROM fin_sync_log l
      WHERE l.status='complete' AND l.action='sync_'||r AND c = ANY(l.companies)
        AND l.completed_at > now() - interval '7 days')
      AND NOT EXISTS (
      SELECT 1 FROM fin_sync_log l
      WHERE l.status='complete' AND l.action='sync_'||r AND c = ANY(l.companies)
        AND l.completed_at > now() - make_interval(hours => v_stale_hours));
    IF v_stale IS NOT NULL THEN
      v_msg := 'Sync sem conclusão há >'||v_stale_hours||'h: '||array_to_string(v_stale, ', ');
      -- Alerta interno na hora (inalterado).
      INSERT INTO fin_alertas (company, tipo, severidade, mensagem, contexto)
      VALUES (c, 'sync_stale', 'critico', v_msg,
              jsonb_build_object('recursos', v_stale, 'janela_horas', v_stale_hours))
      ON CONFLICT (company, tipo) WHERE dismissed_at IS NULL DO NOTHING;
      -- Gate de e-mail: só enfileira se o episódio persiste >= v_grace_mins e ainda
      -- não foi notificado. UPDATE...RETURNING atômico → "uma vez por episódio" +
      -- à prova de ticks sobrepostos.
      UPDATE fin_alertas
      SET email_enfileirado_em = now()
      WHERE company = c AND tipo = 'sync_stale'
        AND dismissed_at IS NULL
        AND email_enfileirado_em IS NULL
        AND criado_em <= now() - make_interval(mins => v_grace_mins);
      IF FOUND THEN
        INSERT INTO fornecedor_alerta (empresa, tipo, severidade, titulo, mensagem, status)
        VALUES (c, 'outro', 'urgente', '[Sync parado] '||upper(c), v_msg, 'pendente_notificacao');
      END IF;
    ELSE
      UPDATE fin_alertas SET dismissed_at = now()
      WHERE company = c AND tipo = 'sync_stale' AND dismissed_at IS NULL;
    END IF;

    -- 2) ERRO EXPLÍCITO (refinado — TAIL-FAILING): só alerta quando o RABO do par
    --    (company, action) está falhando AGORA — a run terminal mais recente é
    --    'error', dentro de 3h, com >=2 erros consecutivos (sem 'complete' entre eles
    --    nem depois). Só 'complete' resolve; 'running' não conta como recuperação.
    --    Substitui "qualquer erro em 6h" (ficava permanentemente acesa c/ Omie flaky).
    --    1 alerta por empresa (tipo 'sync_error'), actions falhando em contexto.actions.
    WITH terminal AS (
      SELECT l.action, l.status, l.started_at
      FROM fin_sync_log l
      WHERE l.action LIKE 'sync_%'
        AND c = ANY(l.companies)
        AND l.status IN ('complete','error')
        AND l.started_at > now() - interval '24 hours'
    ),
    latest AS (
      SELECT DISTINCT ON (action) action, status, started_at
      FROM terminal
      ORDER BY action, started_at DESC
    )
    SELECT array_agg(lt.action ORDER BY lt.action) INTO v_errs
    FROM latest lt
    WHERE lt.status = 'error'
      AND lt.started_at > now() - interval '3 hours'
      AND (
        SELECT count(*) FROM terminal t
        WHERE t.action = lt.action
          AND t.status = 'error'
          AND t.started_at <= lt.started_at
          AND NOT EXISTS (
            SELECT 1 FROM terminal cpl
            WHERE cpl.action = lt.action
              AND cpl.status = 'complete'
              AND cpl.started_at > t.started_at
              AND cpl.started_at <= lt.started_at
          )
      ) >= 2;
    IF v_errs IS NOT NULL THEN
      v_msg := 'Sync falhando agora (run mais recente em erro, >=2 consecutivos): '||array_to_string(v_errs, ', ');
      INSERT INTO fin_alertas (company, tipo, severidade, mensagem, contexto)
      VALUES (c, 'sync_error', 'critico', v_msg, jsonb_build_object('actions', v_errs))
      ON CONFLICT (company, tipo) WHERE dismissed_at IS NULL DO NOTHING;
      IF FOUND THEN
        INSERT INTO fornecedor_alerta (empresa, tipo, severidade, titulo, mensagem, status)
        VALUES (c, 'outro', 'urgente', '[Sync erro] '||upper(c), v_msg, 'pendente_notificacao');
      END IF;
    ELSE
      UPDATE fin_alertas SET dismissed_at = now()
      WHERE company = c AND tipo = 'sync_error' AND dismissed_at IS NULL;
    END IF;

    -- 3) CURSOR TRAVADO: next_page pendente velho
    SELECT array_agg(resource ORDER BY resource) INTO v_stuck
    FROM fin_sync_cursor
    WHERE company = c AND next_page IS NOT NULL
      AND updated_at < now() - make_interval(hours => v_cursor_hours);
    IF v_stuck IS NOT NULL THEN
      v_msg := 'Cursor de continuação travado há >'||v_cursor_hours||'h: '||array_to_string(v_stuck, ', ');
      INSERT INTO fin_alertas (company, tipo, severidade, mensagem, contexto)
      VALUES (c, 'sync_cursor_stuck', 'aviso', v_msg, jsonb_build_object('recursos', v_stuck))
      ON CONFLICT (company, tipo) WHERE dismissed_at IS NULL DO NOTHING;
      IF FOUND THEN
        INSERT INTO fornecedor_alerta (empresa, tipo, severidade, titulo, mensagem, status)
        VALUES (c, 'outro', 'atencao', '[Sync cursor] '||upper(c), v_msg, 'pendente_notificacao');
      END IF;
    ELSE
      UPDATE fin_alertas SET dismissed_at = now()
      WHERE company = c AND tipo = 'sync_cursor_stuck' AND dismissed_at IS NULL;
    END IF;
  END LOOP;
END;
$$;
