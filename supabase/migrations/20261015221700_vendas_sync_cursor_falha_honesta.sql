-- ============================================================
-- vendas_sync_cursor — FALHA HONESTA: a janela só completa com a PROVA no banco de que nenhum pedido
-- ficou para trás, e falha persistente vira estado TERMINAL visível (e re-armável) em vez de
-- re-tentativa infinita.
--
-- APLICAR DEPOIS de 20261015221600 (fencing token): esta reescreve RPCs cercadas daquela.
--
-- Os defeitos (challenge Codex xhigh no #1518 em 2026-07-21; reabertos e endurecidos por dois
-- challenges xhigh em 2026-10-15 sobre esta própria entrega):
--  (1) COMPLETUDE FABRICADA. criar_pedidos_com_itens isola cada pedido numa subtransação e devolve
--      os que falharam em `failed[]` — o pedido falho NÃO existe no banco depois. A edge só logava e
--      a janela ganhava completed_at com pedido ausente. "Fim das páginas" ≠ "importação completa".
--  (2) A 1ª versão deste conserto guardava uma LISTA de falhos e confiava nela — e o 2º challenge
--      mostrou 3 furos: o re-arme apagava a lista (pedido que some da listagem completava ausente);
--      a lista só era escrita DEPOIS da RPC (morte entre as duas + listagem mudando de página perdia
--      a identidade); pedido curado seguia na lista (terminal falso).
--  (3) FALHA PERMANENTE SEM FIM. Página que sempre falha re-tentava a cada 6 min para sempre, e
--      como o cron pega a janela aberta MAIS ANTIGA por conta, travava as seguintes. Inclusive erro
--      permanente que a edge classifica como transitório.
--
-- O conserto — a prova é o BANCO, não a contabilidade (tudo em UPDATE único cercado pelo token):
--  • a edge PRÉ-REGISTRA na janela a identidade (hash) de cada pedido do lote ANTES de gravar (só os
--    que a RPC pode criar: ≥1 item com omie_codigo_produto, o G7) e depois registra os failed[] com
--    SQLSTATE. Sem confirmação do pré-registro ela LANÇA antes de gravar.
--  • `private.vendas_sync_falhos_pendentes` = a lista MENOS os pedidos cujo pai EXISTE em
--    sales_orders (account + hash_payload). Toda escrita da lista poda por ela; o finish só completa
--    com a poda VAZIA. O re-arme (automático 1×, ou do staff) NÃO apaga a lista.
--  • fim real com pendência: 1ª vez re-arma (o cron re-varre a janela); 2ª vez TERMINAL
--    ('pedidos_falhos'). 5 pausas http/error seguidas, ou 20 pausas com QUALQUER erro, sem avançar de
--    página → TERMINAL ('erro_persistente'). Avançar de página ou pausar por orçamento zera.
--  • terminal: cron e acquires pulam (não trava a conta); semear não a conta como "em andamento" e
--    devolve 'ja_falhou' para a mesma janela; vendas_sync_rearmar_janela (staff) é a única saída.
--  • finish/release ANTIGOS passam a exigir lease ativo (o zumbi da edge velha não rebobina — 1º
--    challenge, P1).
--
-- Custo declarado: pedido que o Omie deixar de listar de vez mantém a janela INCOMPLETA (terminal,
-- visível, re-armável) — precisão > recall. Fora do escopo: o modo incremental (cron 2h, sem cursor)
-- segue só logando failed[] (re-varre a janela rolante a cada 2h).
--
-- Idempotente. Sem BEGIN/COMMIT: aplicar com `bun run db:aplicar <este arquivo>`; no SQL Editor,
-- envolver em BEGIN; … COMMIT;.
-- Prova: db/test-vendas-sync-cursor-falha-honesta.sh. Validação: db/valida-vendas-sync-cursor-falha-honesta.sql.
-- ============================================================

ALTER TABLE public.vendas_sync_cursor ADD COLUMN IF NOT EXISTS pedidos_falhos      jsonb   NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE public.vendas_sync_cursor ADD COLUMN IF NOT EXISTS tentativas_falha    integer NOT NULL DEFAULT 0;
ALTER TABLE public.vendas_sync_cursor ADD COLUMN IF NOT EXISTS falhas_consecutivas integer NOT NULL DEFAULT 0;
ALTER TABLE public.vendas_sync_cursor ADD COLUMN IF NOT EXISTS falhou_em           timestamptz;
ALTER TABLE public.vendas_sync_cursor ADD COLUMN IF NOT EXISTS motivo_falha        text;

DO $chk$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'vendas_sync_cursor_motivo_falha_check') THEN
    ALTER TABLE public.vendas_sync_cursor ADD CONSTRAINT vendas_sync_cursor_motivo_falha_check
      CHECK (motivo_falha IS NULL OR motivo_falha IN ('pedidos_falhos', 'erro_persistente'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'vendas_sync_cursor_pedidos_falhos_array') THEN
    ALTER TABLE public.vendas_sync_cursor ADD CONSTRAINT vendas_sync_cursor_pedidos_falhos_array
      CHECK (jsonb_typeof(pedidos_falhos) = 'array');
  END IF;
END $chk$;

COMMENT ON COLUMN public.vendas_sync_cursor.falhou_em IS
  'Estado TERMINAL: a janela falhou de forma persistente (motivo_falha) e o cron/acquire a pulam. '
  'Sair dele só por vendas_sync_rearmar_janela (staff).';

ALTER TABLE public.vendas_sync_cursor ADD COLUMN IF NOT EXISTS pausas_sem_progresso integer NOT NULL DEFAULT 0;

-- ─────────────── a poda: lista MENOS o que o banco prova que existe ───────────────
-- Prova = o pai existe (account + hash) E tem ≥1 item. Só o pai não basta: um REPARO de pai órfão
-- (sem order_items) que falha desfaz os itens e deixa o pai — o pedido seguiria incompleto (3º
-- challenge Codex, P2). Entrada sem hash não é provável → fica (precisão > recall). O LIKE casa o
-- índice único parcial de sales_orders (account, hash_payload) WHERE hash_payload LIKE 'omie\_%'.
CREATE OR REPLACE FUNCTION private.vendas_sync_falhos_pendentes(p_account text, p_lista jsonb)
RETURNS jsonb
LANGUAGE sql
STABLE
SET search_path TO ''
AS $$
  SELECT coalesce(jsonb_agg(e.x ORDER BY e.o), '[]'::jsonb)
    FROM jsonb_array_elements(coalesce(p_lista, '[]'::jsonb)) WITH ORDINALITY AS e(x, o)
   WHERE NOT EXISTS (
     SELECT 1 FROM public.sales_orders so
      WHERE so.account = p_account
        AND so.hash_payload = e.x->>'hash'
        AND so.hash_payload LIKE 'omie\_%'
        AND EXISTS (SELECT 1 FROM public.order_items oi WHERE oi.sales_order_id = so.id)
   );
$$;
REVOKE ALL ON FUNCTION private.vendas_sync_falhos_pendentes(text, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION private.vendas_sync_falhos_pendentes(text, jsonb) TO service_role;

-- ─────────────── registrar (pré-registro E falhos): junta, dedup por identidade, PODA ───────────────
CREATE OR REPLACE FUNCTION public.vendas_sync_registrar_falhas_fenced(
  p_account text, p_date_from date, p_date_to date, p_lease_token uuid, p_falhas jsonb
) RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF p_falhas IS NULL OR jsonb_typeof(p_falhas) <> 'array' THEN
    RAISE EXCEPTION 'p_falhas deve ser array jsonb (veio %)', coalesce(jsonb_typeof(p_falhas), 'NULL')
      USING ERRCODE = '22023';
  END IF;
  UPDATE public.vendas_sync_cursor c
     SET pedidos_falhos = private.vendas_sync_falhos_pendentes(c.account, (
           SELECT coalesce(jsonb_agg(d.x ORDER BY d.o), '[]'::jsonb)
             FROM (SELECT DISTINCT ON (coalesce(e.x->>'hash', e.x->>'codigo_pedido', e.x::text)) e.x, e.o
                     FROM jsonb_array_elements(c.pedidos_falhos || p_falhas) WITH ORDINALITY AS e(x, o)
                    ORDER BY coalesce(e.x->>'hash', e.x->>'codigo_pedido', e.x::text), e.o DESC) d)),
         updated_at = now()
   WHERE c.account = p_account AND c.date_from = p_date_from AND c.date_to = p_date_to
     AND c.running_since IS NOT NULL
     AND c.lease_token = p_lease_token;
  RETURN FOUND;
END;
$$;

-- ─────────────── acquire cercado: pula terminal; roubar lease MORTO conta como pausa ───────────────
-- Worker que morre sem finish/release (limite de execução/memória) não passava por contador nenhum:
-- a janela podia ficar aberta para sempre, travando a conta (3º challenge Codex, P3). Roubar um lease
-- morto (running_since ainda setado) é a evidência dessa morte: conta em pausas_sem_progresso, e na
-- 20ª a janela vai a TERMINAL ali mesmo — sem entregar o lease (RETURNING devolve NULL).
CREATE OR REPLACE FUNCTION public.vendas_sync_lease_acquire_fenced(
  p_account text, p_date_from date, p_date_to date
) RETURNS jsonb
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  UPDATE public.vendas_sync_cursor
     SET running_since = CASE WHEN running_since IS NOT NULL AND pausas_sem_progresso + 1 >= 20 THEN NULL ELSE now() END,
         lease_token   = CASE WHEN running_since IS NOT NULL AND pausas_sem_progresso + 1 >= 20 THEN NULL ELSE gen_random_uuid() END,
         pausas_sem_progresso = CASE WHEN running_since IS NOT NULL THEN pausas_sem_progresso + 1 ELSE pausas_sem_progresso END,
         falhou_em     = CASE WHEN running_since IS NOT NULL AND pausas_sem_progresso + 1 >= 20 THEN now() ELSE falhou_em END,
         motivo_falha  = CASE WHEN running_since IS NOT NULL AND pausas_sem_progresso + 1 >= 20 THEN 'erro_persistente' ELSE motivo_falha END,
         heartbeat_at  = now(), updated_at = now()
   WHERE account = p_account AND date_from = p_date_from AND date_to = p_date_to
     AND completed_at IS NULL
     AND falhou_em IS NULL
     AND (running_since IS NULL OR heartbeat_at < now() - interval '3 minutes')
  RETURNING CASE WHEN falhou_em IS NULL
                 THEN jsonb_build_object('resume_page', COALESCE(next_page, 1), 'lease_token', lease_token) END;
$$;

-- ─────────────── heartbeat: avançar de página zera AS DUAS sequências ───────────────
CREATE OR REPLACE FUNCTION public.vendas_sync_heartbeat_fenced(
  p_account text, p_date_from date, p_date_to date, p_lease_token uuid, p_page integer
) RETURNS boolean
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  WITH u AS (
    UPDATE public.vendas_sync_cursor
       SET heartbeat_at = now(), next_page = p_page, updated_at = now(),
           falhas_consecutivas  = CASE WHEN p_page > COALESCE(next_page, 1) THEN 0 ELSE falhas_consecutivas END,
           pausas_sem_progresso = CASE WHEN p_page > COALESCE(next_page, 1) THEN 0 ELSE pausas_sem_progresso END
     WHERE account = p_account AND date_from = p_date_from AND date_to = p_date_to
       AND running_since IS NOT NULL
       AND lease_token = p_lease_token
    RETURNING 1
  )
  SELECT EXISTS (SELECT 1 FROM u);
$$;

-- ─────────────── finish: completa SÓ com a poda vazia; re-arma 1× SEM apagar a lista ───────────────
-- `pend` é a lista podada (o que o banco NÃO prova). No SET, as colunas à direita são os valores
-- ANTIGOS da linha. Um único UPDATE cercado — mesma garantia EPQ do fencing.
CREATE OR REPLACE FUNCTION public.vendas_sync_finish_fenced(
  p_account text, p_date_from date, p_date_to date, p_lease_token uuid,
  p_complete boolean, p_next_page integer, p_last_error_kind text
) RETURNS boolean
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  WITH u AS (
    UPDATE public.vendas_sync_cursor
       SET completed_at = CASE
             WHEN p_complete AND jsonb_array_length(private.vendas_sync_falhos_pendentes(account, pedidos_falhos)) = 0 THEN now()
             ELSE completed_at END,
           pedidos_falhos = private.vendas_sync_falhos_pendentes(account, pedidos_falhos),
           next_page = CASE WHEN p_complete THEN NULL ELSE p_next_page END,
           last_error_kind = CASE WHEN p_complete THEN NULL ELSE p_last_error_kind END,
           tentativas_falha = CASE
             WHEN p_complete AND jsonb_array_length(private.vendas_sync_falhos_pendentes(account, pedidos_falhos)) > 0
                  AND tentativas_falha < 1 THEN tentativas_falha + 1
             ELSE tentativas_falha END,
           falhas_consecutivas = CASE
             WHEN p_complete THEN 0
             WHEN p_last_error_kind IN ('http', 'error') THEN falhas_consecutivas + 1
             WHEN p_last_error_kind IS NULL THEN 0
             ELSE falhas_consecutivas END,
           pausas_sem_progresso = CASE
             WHEN p_complete OR p_last_error_kind IS NULL THEN 0
             ELSE pausas_sem_progresso + 1 END,
           falhou_em = CASE
             WHEN p_complete AND jsonb_array_length(private.vendas_sync_falhos_pendentes(account, pedidos_falhos)) > 0
                  AND tentativas_falha >= 1 THEN now()
             WHEN NOT p_complete AND p_last_error_kind IN ('http', 'error') AND falhas_consecutivas + 1 >= 5 THEN now()
             WHEN NOT p_complete AND p_last_error_kind IS NOT NULL AND pausas_sem_progresso + 1 >= 20 THEN now()
             ELSE falhou_em END,
           motivo_falha = CASE
             WHEN p_complete AND jsonb_array_length(private.vendas_sync_falhos_pendentes(account, pedidos_falhos)) > 0
                  AND tentativas_falha >= 1 THEN 'pedidos_falhos'
             WHEN NOT p_complete AND p_last_error_kind IN ('http', 'error') AND falhas_consecutivas + 1 >= 5 THEN 'erro_persistente'
             WHEN NOT p_complete AND p_last_error_kind IS NOT NULL AND pausas_sem_progresso + 1 >= 20 THEN 'erro_persistente'
             ELSE motivo_falha END,
           running_since = NULL,
           lease_token   = NULL,
           heartbeat_at  = now(),
           updated_at    = now()
     WHERE account = p_account AND date_from = p_date_from AND date_to = p_date_to
       AND running_since IS NOT NULL
       AND lease_token = p_lease_token
    RETURNING 1
  )
  SELECT EXISTS (SELECT 1 FROM u);
$$;

-- ─────────────── release: erro inesperado conta nas DUAS sequências ───────────────
CREATE OR REPLACE FUNCTION public.vendas_sync_release_fenced(
  p_account text, p_date_from date, p_date_to date, p_lease_token uuid, p_last_error_kind text
) RETURNS boolean
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  WITH u AS (
    UPDATE public.vendas_sync_cursor
       SET running_since = NULL, lease_token = NULL, last_error_kind = p_last_error_kind,
           falhas_consecutivas = CASE WHEN p_last_error_kind IN ('http', 'error') THEN falhas_consecutivas + 1
                                      ELSE falhas_consecutivas END,
           pausas_sem_progresso = CASE WHEN p_last_error_kind IS NOT NULL THEN pausas_sem_progresso + 1
                                       ELSE pausas_sem_progresso END,
           falhou_em = CASE
             WHEN p_last_error_kind IN ('http', 'error') AND falhas_consecutivas + 1 >= 5 THEN now()
             WHEN p_last_error_kind IS NOT NULL AND pausas_sem_progresso + 1 >= 20 THEN now()
             ELSE falhou_em END,
           motivo_falha = CASE
             WHEN p_last_error_kind IN ('http', 'error') AND falhas_consecutivas + 1 >= 5 THEN 'erro_persistente'
             WHEN p_last_error_kind IS NOT NULL AND pausas_sem_progresso + 1 >= 20 THEN 'erro_persistente'
             ELSE motivo_falha END,
           heartbeat_at = now(), updated_at = now()
     WHERE account = p_account AND date_from = p_date_from AND date_to = p_date_to
       AND running_since IS NOT NULL
       AND lease_token = p_lease_token
    RETURNING 1
  )
  SELECT EXISTS (SELECT 1 FROM u);
$$;

-- ─────────────── acquire ANTIGO: também pula janela terminal ───────────────
CREATE OR REPLACE FUNCTION public.vendas_sync_lease_acquire(
  p_account text, p_date_from date, p_date_to date
) RETURNS integer
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  UPDATE public.vendas_sync_cursor
     SET running_since = now(), heartbeat_at = now(), updated_at = now(),
         lease_token   = NULL
   WHERE account = p_account AND date_from = p_date_from AND date_to = p_date_to
     AND completed_at IS NULL
     AND falhou_em IS NULL
     AND (running_since IS NULL OR heartbeat_at < now() - interval '3 minutes')
  RETURNING COALESCE(next_page, 1);
$$;

-- ─────────────── finish/release ANTIGOS: exigem lease ATIVO (challenge Codex 2026-10-15, P1) ───────────────
-- A 20261015221600 só pôs `lease_token IS NULL`. Isso protege o lease cercado enquanto o token está
-- preenchido — mas o finish/release CERCADO limpa o token ao terminar. Cenário: A (edge velha) trava;
-- B (edge nova) rouba, avança e pausa com next_page=13 (token volta a NULL, running_since NULL); A
-- acorda e chama finish(false,3): `lease_token IS NULL` passava e rebobinava a janela para 3.
-- Com `running_since IS NOT NULL` o A só age enquanto ALGUÉM segura um lease antigo.
-- (Entre DOIS workers antigos o lease continua indistinguível — é o mundo de antes do fencing, que
-- só existe sob revert integral da edge; o caminho vigente é o cercado.)
CREATE OR REPLACE FUNCTION public.vendas_sync_finish(
  p_account text, p_date_from date, p_date_to date,
  p_complete boolean, p_next_page integer, p_last_error_kind text
) RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  UPDATE public.vendas_sync_cursor
     SET next_page       = CASE WHEN p_complete THEN NULL ELSE p_next_page END,
         completed_at     = CASE WHEN p_complete
                                   AND jsonb_array_length(private.vendas_sync_falhos_pendentes(account, pedidos_falhos)) = 0
                                 THEN now() ELSE completed_at END,
         last_error_kind  = CASE WHEN p_complete THEN NULL ELSE p_last_error_kind END,
         running_since    = NULL,
         heartbeat_at     = now(),
         updated_at       = now()
   WHERE account = p_account AND date_from = p_date_from AND date_to = p_date_to
     AND running_since IS NOT NULL
     AND lease_token IS NULL;
$$;

CREATE OR REPLACE FUNCTION public.vendas_sync_release(
  p_account text, p_date_from date, p_date_to date, p_last_error_kind text
) RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  UPDATE public.vendas_sync_cursor
     SET running_since = NULL, last_error_kind = p_last_error_kind,
         heartbeat_at = now(), updated_at = now()
   WHERE account = p_account AND date_from = p_date_from AND date_to = p_date_to
     AND running_since IS NOT NULL
     AND lease_token IS NULL;
$$;

-- ─────────────── semear_janela: terminal não é "outra em andamento"; mesma janela → ja_falhou ───────────────
-- Corpo VIVO de prod conferido em 2026-10-15 (md5 ab84897d…) = o de 20260726140000 já com o conserto da
-- 20260929001651 (futuro = dia de SÃO PAULO; VOLATILE — o default deste CREATE OR REPLACE). Mudam só o
-- filtro da "outra aberta" e o desfecho 'ja_falhou'. O gate staff e a guarda de SP ficam VERBATIM.
CREATE OR REPLACE FUNCTION public.vendas_sync_semear_janela(
  p_date_from date,
  p_date_to   date,
  p_accounts  text[] DEFAULT ARRAY['oben', 'colacor']
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $$
DECLARE
  v_uid         uuid := auth.uid();
  v_account     text;
  v_contas      jsonb := '[]'::jsonb;
  v_desfecho    text;
  v_next        integer;
  v_done        timestamptz;
  v_falhou      timestamptz;
  v_aberta_from date;
  v_aberta_to   date;
BEGIN
  -- Gate staff/master na fronteira (fail-closed: uid nulo NUNCA passa) —
  -- mesmo gate de public.request_customer_metrics_refresh.
  IF v_uid IS NULL
     OR NOT (COALESCE(public.has_role(v_uid, 'employee'::public.app_role), false)
          OR COALESCE(public.has_role(v_uid, 'master'::public.app_role),   false)) THEN
    RAISE EXCEPTION 'Acesso negado: requer perfil staff' USING ERRCODE = '42501';
  END IF;

  IF p_accounts IS NULL OR array_length(p_accounts, 1) IS NULL THEN
    RAISE EXCEPTION 'p_accounts vazio' USING ERRCODE = '22023';
  END IF;
  IF p_date_from IS NULL OR p_date_to IS NULL OR p_date_from > p_date_to THEN
    RAISE EXCEPTION 'janela invalida: date_from (%) deve ser <= date_to (%)', p_date_from, p_date_to
      USING ERRCODE = '22023';
  END IF;
  -- "Futuro" = depois do dia de SÃO PAULO (o cliente manda a data local de SP). `current_date` é o dia
  -- da SESSÃO (UTC em prod): das 21h às 23h59 BRT já é amanhã — o fuso fica escrito (classe ii do fuso).
  IF p_date_to > (now() AT TIME ZONE 'America/Sao_Paulo')::date THEN
    RAISE EXCEPTION 'janela invalida: date_to (%) no futuro', p_date_to
      USING ERRCODE = '22023';
  END IF;
  IF p_date_from < DATE '2015-01-01' THEN
    RAISE EXCEPTION 'janela invalida: date_from (%) anterior a 2015-01-01', p_date_from
      USING ERRCODE = '22023';
  END IF;

  FOR v_account IN SELECT DISTINCT a FROM unnest(p_accounts) AS a ORDER BY a
  LOOP
    IF v_account IS NULL OR v_account NOT IN ('oben', 'colacor') THEN
      RAISE EXCEPTION 'conta invalida: % (esperado oben|colacor)', COALESCE(v_account, 'NULL')
        USING ERRCODE = '22023';
    END IF;

    PERFORM pg_advisory_xact_lock(hashtext('vendas_sync_semear_' || v_account));

    -- "Outra em andamento" = aberta E não-terminal: a terminal o cron já pula, não trava a conta.
    SELECT c.date_from, c.date_to
      INTO v_aberta_from, v_aberta_to
      FROM public.vendas_sync_cursor c
     WHERE c.account = v_account
       AND c.completed_at IS NULL
       AND c.falhou_em IS NULL
       AND NOT (c.date_from = p_date_from AND c.date_to = p_date_to)
     ORDER BY c.date_from
     LIMIT 1;

    IF FOUND THEN
      v_desfecho := 'ja_pendente_outra';
      v_next := NULL;
      v_done := NULL;
    ELSE
      INSERT INTO public.vendas_sync_cursor (account, date_from, date_to)
      VALUES (v_account, p_date_from, p_date_to)
      ON CONFLICT (account, date_from, date_to) DO NOTHING;
      IF FOUND THEN
        v_desfecho := 'semeada';
      END IF;
      SELECT c.next_page, c.completed_at, c.falhou_em
        INTO v_next, v_done, v_falhou
        FROM public.vendas_sync_cursor c
       WHERE c.account = v_account AND c.date_from = p_date_from AND c.date_to = p_date_to;
      IF v_desfecho IS NULL THEN
        v_desfecho := CASE WHEN v_done IS NOT NULL THEN 'ja_concluida'
                           WHEN v_falhou IS NOT NULL THEN 'ja_falhou'
                           ELSE 'ja_pendente' END;
      END IF;
    END IF;

    v_contas := v_contas || jsonb_build_object(
      'account',           v_account,
      'desfecho',          v_desfecho,
      'next_page',         v_next,
      'completed_at',      v_done,
      'falhou_em',         v_falhou,
      'janela_aberta_de',  v_aberta_from,
      'janela_aberta_ate', v_aberta_to
    );

    v_desfecho := NULL; v_next := NULL; v_done := NULL; v_falhou := NULL;
    v_aberta_from := NULL; v_aberta_to := NULL;
  END LOOP;

  RETURN jsonb_build_object('date_from', p_date_from, 'date_to', p_date_to, 'contas', v_contas);
END;
$$;

-- ─────────────── rearmar: sai do terminal SEM apagar a pendência (P1) ───────────────
CREATE OR REPLACE FUNCTION public.vendas_sync_rearmar_janela(
  p_account text, p_date_from date, p_date_to date
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $$
DECLARE
  v_uid    uuid := auth.uid();
  v_outra  date;
  v_linhas integer;
BEGIN
  -- Gate staff/master na fronteira (fail-closed) — o MESMO de vendas_sync_semear_janela.
  IF v_uid IS NULL
     OR NOT (COALESCE(public.has_role(v_uid, 'employee'::public.app_role), false)
          OR COALESCE(public.has_role(v_uid, 'master'::public.app_role),   false)) THEN
    RAISE EXCEPTION 'Acesso negado: requer perfil staff' USING ERRCODE = '42501';
  END IF;
  IF p_account IS NULL OR p_account NOT IN ('oben', 'colacor') THEN
    RAISE EXCEPTION 'conta invalida: % (esperado oben|colacor)', COALESCE(p_account, 'NULL')
      USING ERRCODE = '22023';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtext('vendas_sync_semear_' || p_account));

  IF NOT EXISTS (SELECT 1 FROM public.vendas_sync_cursor c
                  WHERE c.account = p_account AND c.date_from = p_date_from AND c.date_to = p_date_to
                    AND c.falhou_em IS NOT NULL AND c.completed_at IS NULL AND c.running_since IS NULL) THEN
    RETURN jsonb_build_object('rearmada', false, 'motivo', 'nao_terminal');
  END IF;

  SELECT c.date_from INTO v_outra
    FROM public.vendas_sync_cursor c
   WHERE c.account = p_account AND c.completed_at IS NULL AND c.falhou_em IS NULL
     AND NOT (c.date_from = p_date_from AND c.date_to = p_date_to)
   ORDER BY c.date_from
   LIMIT 1;
  IF FOUND THEN
    RETURN jsonb_build_object('rearmada', false, 'motivo', 'ja_pendente_outra', 'janela_aberta_de', v_outra);
  END IF;

  -- pedidos_falhos FICA: só a poda (pedido provado em sales_orders) tira um pedido da pendência.
  UPDATE public.vendas_sync_cursor c
     SET falhou_em = NULL, motivo_falha = NULL,
         tentativas_falha = 0, falhas_consecutivas = 0, pausas_sem_progresso = 0,
         last_error_kind = NULL, next_page = NULL, updated_at = now()
   WHERE c.account = p_account AND c.date_from = p_date_from AND c.date_to = p_date_to
     AND c.falhou_em IS NOT NULL
     AND c.completed_at IS NULL
     AND c.running_since IS NULL;
  GET DIAGNOSTICS v_linhas = ROW_COUNT;

  RETURN jsonb_build_object('rearmada', v_linhas = 1,
                            'motivo', CASE WHEN v_linhas = 1 THEN NULL ELSE 'nao_terminal' END);
END;
$$;

-- Fronteiras. Funções NOVAS nascem com EXECUTE para anon/authenticated (default do Supabase).
REVOKE ALL ON FUNCTION public.vendas_sync_registrar_falhas_fenced(text, date, date, uuid, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.vendas_sync_registrar_falhas_fenced(text, date, date, uuid, jsonb) TO service_role;
REVOKE ALL ON FUNCTION public.vendas_sync_rearmar_janela(text, date, date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.vendas_sync_rearmar_janela(text, date, date) TO authenticated, service_role;
-- (As 5 recriadas por CREATE OR REPLACE mantêm o ACL que já tinham.)

-- ─────────────── cron 140: pula janela terminal (alter_job preserva jobid e agenda) ───────────────
DO $cron$
DECLARE
  v_jobid bigint;
BEGIN
  SELECT jobid INTO v_jobid FROM cron.job WHERE jobname = 'vendas-sync-continuacao-6min';
  IF v_jobid IS NULL THEN
    RAISE EXCEPTION 'cron vendas-sync-continuacao-6min ausente — a fundação 20260617133633 não está aplicada';
  END IF;
  PERFORM cron.alter_job(v_jobid, command := $cmd$
  DO $inner$
  DECLARE r record;
  BEGIN
    FOR r IN
      SELECT DISTINCT ON (account) account, date_from, date_to
        FROM public.vendas_sync_cursor
       WHERE completed_at IS NULL
         AND falhou_em IS NULL
       ORDER BY account, date_from
    LOOP
      PERFORM net.http_post(
        url := 'https://fzvklzpomgnyikkfkzai.supabase.co/functions/v1/omie-vendas-sync',
        headers := jsonb_build_object(
          'Content-Type', 'application/json',
          'x-cron-secret', (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'CRON_SECRET' LIMIT 1)
        ),
        body := jsonb_build_object(
          'action', 'sync_pedidos',
          'account', r.account,
          'date_from', to_char(r.date_from, 'DD/MM/YYYY'),
          'date_to',   to_char(r.date_to,   'DD/MM/YYYY'),
          'use_cursor', true,
          'max_pages', 10
        ),
        timeout_milliseconds := 150000
      );
    END LOOP;
  END $inner$;
  $cmd$);
END
$cron$;

NOTIFY pgrst, 'reload schema';

-- ─────────────────────────── Postcondição ───────────────────────────
-- Mesmos predicados de db/valida-vendas-sync-cursor-falha-honesta.sql. Lê catálogo; não invoca.
DO $pos$
DECLARE
  v_fn  text;
  v_src text;
BEGIN
  IF to_regprocedure('public.vendas_sync_lease_acquire_fenced(text,date,date)') IS NULL THEN
    RAISE EXCEPTION 'POS0 FALHOU: o fencing (20261015221600) não está aplicado — aplique-o ANTES desta';
  END IF;
  IF (SELECT count(*) FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'vendas_sync_cursor'
         AND column_name IN ('pedidos_falhos','tentativas_falha','falhas_consecutivas','pausas_sem_progresso','falhou_em','motivo_falha')) <> 6 THEN
    RAISE EXCEPTION 'POS1 FALHOU: faltam colunas de falha honesta em vendas_sync_cursor';
  END IF;
  IF to_regprocedure('private.vendas_sync_falhos_pendentes(text,jsonb)') IS NULL
     OR has_function_privilege('authenticated', 'private.vendas_sync_falhos_pendentes(text,jsonb)', 'EXECUTE')
     OR has_function_privilege('anon', 'private.vendas_sync_falhos_pendentes(text,jsonb)', 'EXECUTE') THEN
    RAISE EXCEPTION 'POS2 FALHOU: a poda private.vendas_sync_falhos_pendentes ausente ou aberta';
  END IF;

  v_fn := 'public.vendas_sync_registrar_falhas_fenced(text,date,date,uuid,jsonb)';
  IF to_regprocedure(v_fn) IS NULL
     OR NOT has_function_privilege('service_role', v_fn, 'EXECUTE')
     OR has_function_privilege('authenticated', v_fn, 'EXECUTE')
     OR has_function_privilege('anon', v_fn, 'EXECUTE') THEN
    RAISE EXCEPTION 'POS3 FALHOU: registrar_falhas_fenced ausente ou fora da fronteira service_role-only';
  END IF;
  v_fn := 'public.vendas_sync_rearmar_janela(text,date,date)';
  IF to_regprocedure(v_fn) IS NULL
     OR NOT has_function_privilege('authenticated', v_fn, 'EXECUTE')
     OR has_function_privilege('anon', v_fn, 'EXECUTE') THEN
    RAISE EXCEPTION 'POS4 FALHOU: rearmar_janela ausente, sem EXECUTE para authenticated ou aberto a anon';
  END IF;

  v_src := regexp_replace((SELECT prosrc FROM pg_proc WHERE oid = to_regprocedure('public.vendas_sync_finish_fenced(text,date,date,uuid,boolean,integer,text)')), '--[^\n]*', '', 'g');
  IF v_src !~ 'WHEN p_complete AND jsonb_array_length\(private\.vendas_sync_falhos_pendentes\(account, pedidos_falhos\)\) = 0 THEN now\(\)' THEN
    RAISE EXCEPTION 'POS5 FALHOU: finish completa sem a poda provada no banco';
  END IF;
  IF (SELECT prosrc FROM pg_proc WHERE oid = to_regprocedure('private.vendas_sync_falhos_pendentes(text,jsonb)')) !~ 'public\.order_items' THEN
    RAISE EXCEPTION 'POS15 FALHOU: a poda aceita pai sem itens como prova (reparo que falhou some da pendencia)';
  END IF;
  IF (SELECT prosrc FROM pg_proc WHERE oid = to_regprocedure('public.vendas_sync_finish(text,date,date,boolean,integer,text)'))
       !~ 'private\.vendas_sync_falhos_pendentes\(account, pedidos_falhos\)' THEN
    RAISE EXCEPTION 'POS16 FALHOU: o finish ANTIGO completa sem a poda (edge revertida completaria com pendencia)';
  END IF;
  IF (SELECT prosrc FROM pg_proc WHERE oid = to_regprocedure('public.vendas_sync_lease_acquire_fenced(text,date,date)'))
       !~ 'pausas_sem_progresso = CASE WHEN running_since IS NOT NULL THEN pausas_sem_progresso \+ 1' THEN
    RAISE EXCEPTION 'POS17 FALHOU: roubar lease morto nao conta — worker que morre sem finish prende a janela';
  END IF;

  FOREACH v_fn IN ARRAY ARRAY[
    'public.vendas_sync_heartbeat_fenced(text,date,date,uuid,integer)',
    'public.vendas_sync_finish_fenced(text,date,date,uuid,boolean,integer,text)',
    'public.vendas_sync_release_fenced(text,date,date,uuid,text)',
    'public.vendas_sync_registrar_falhas_fenced(text,date,date,uuid,jsonb)'
  ] LOOP
    v_src := regexp_replace((SELECT prosrc FROM pg_proc WHERE oid = to_regprocedure(v_fn)), '--[^\n]*', '', 'g');
    IF v_src !~ 'UPDATE public\.vendas_sync_cursor[^;]*AND (c\.)?lease_token = p_lease_token' THEN
      RAISE EXCEPTION 'POS6 FALHOU: % perdeu o fencing no UPDATE', v_fn;
    END IF;
  END LOOP;

  v_src := regexp_replace((SELECT prosrc FROM pg_proc WHERE oid = to_regprocedure('public.vendas_sync_registrar_falhas_fenced(text,date,date,uuid,jsonb)')), '--[^\n]*', '', 'g');
  IF v_src !~ 'private\.vendas_sync_falhos_pendentes\(c\.account' THEN
    RAISE EXCEPTION 'POS7 FALHOU: registrar não poda a lista pelo banco';
  END IF;

  v_src := regexp_replace((SELECT prosrc FROM pg_proc WHERE oid = to_regprocedure('public.vendas_sync_heartbeat_fenced(text,date,date,uuid,integer)')), '--[^\n]*', '', 'g');
  IF v_src !~ 'falhas_consecutivas\s*=\s*CASE WHEN p_page > COALESCE\(next_page, 1\) THEN 0'
     OR v_src !~ 'pausas_sem_progresso\s*=\s*CASE WHEN p_page > COALESCE\(next_page, 1\) THEN 0' THEN
    RAISE EXCEPTION 'POS8 FALHOU: heartbeat não zera as sequências ao avançar de página';
  END IF;

  FOREACH v_fn IN ARRAY ARRAY[
    'public.vendas_sync_finish(text,date,date,boolean,integer,text)',
    'public.vendas_sync_release(text,date,date,text)'
  ] LOOP
    IF (SELECT prosrc FROM pg_proc WHERE oid = to_regprocedure(v_fn)) !~ 'AND running_since IS NOT NULL\s+AND lease_token IS NULL' THEN
      RAISE EXCEPTION 'POS9 FALHOU: % (caminho antigo) age sem lease ativo — o zumbi da edge velha rebobina a janela', v_fn;
    END IF;
  END LOOP;

  FOREACH v_fn IN ARRAY ARRAY[
    'public.vendas_sync_lease_acquire_fenced(text,date,date)',
    'public.vendas_sync_lease_acquire(text,date,date)'
  ] LOOP
    IF (SELECT prosrc FROM pg_proc WHERE oid = to_regprocedure(v_fn)) !~ 'AND falhou_em IS NULL' THEN
      RAISE EXCEPTION 'POS10 FALHOU: % não pula janela terminal', v_fn;
    END IF;
  END LOOP;

  IF NOT EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'vendas-sync-continuacao-6min'
                   AND command ~ 'AND falhou_em IS NULL' AND active) THEN
    RAISE EXCEPTION 'POS11 FALHOU: cron 140 não pula janela terminal (ou ficou inativo)';
  END IF;

  FOREACH v_fn IN ARRAY ARRAY[
    'public.vendas_sync_semear_janela(date,date,text[])',
    'public.vendas_sync_rearmar_janela(text,date,date)'
  ] LOOP
    v_src := regexp_replace((SELECT prosrc FROM pg_proc WHERE oid = to_regprocedure(v_fn)), '--[^\n]*', '', 'g');
    IF v_src !~ 'IF v_uid IS NULL\s+OR NOT \(COALESCE\(public\.has_role\(v_uid, ''employee''::public\.app_role\), false\)\s+OR COALESCE\(public\.has_role\(v_uid, ''master''::public\.app_role\),\s+false\)\) THEN\s+RAISE EXCEPTION' THEN
      RAISE EXCEPTION 'POS12 FALHOU: % sem o gate staff bloqueante (IF … THEN RAISE)', v_fn;
    END IF;
  END LOOP;
  v_src := regexp_replace((SELECT prosrc FROM pg_proc WHERE oid = to_regprocedure('public.vendas_sync_semear_janela(date,date,text[])')), '--[^\n]*', '', 'g');
  IF v_src !~ 'AND c\.falhou_em IS NULL' THEN
    RAISE EXCEPTION 'POS13 FALHOU: semear ainda conta janela terminal como em andamento';
  END IF;
  v_src := regexp_replace((SELECT prosrc FROM pg_proc WHERE oid = to_regprocedure('public.vendas_sync_rearmar_janela(text,date,date)')), '--[^\n]*', '', 'g');
  IF v_src ~ 'pedidos_falhos\s*=' THEN
    RAISE EXCEPTION 'POS14 FALHOU: rearmar apaga a pendência — pedido nunca provado sairia da conta';
  END IF;
END
$pos$;
