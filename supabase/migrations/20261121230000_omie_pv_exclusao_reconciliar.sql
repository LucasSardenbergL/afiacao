-- ════════════════════════════════════════════════════════════════════════════════════════════════════════════════
-- 20261121230000 · omie_pv_exclusao_reconciliar — baixa automática de PV EXCLUÍDO direto no Omie   [money-path]
-- Prova: db/test-omie-pv-exclusao.sh (PG17: RPCs executadas, concorrência em 2 sessões, ACL, falsificação)
-- Edge:  supabase/functions/omie-pv-exclusao-reconciliar (cron de hora em hora, abaixo)
--
-- Incidente: PV 13693 (Oben, PID 12215613527, limpeza manual PR #4082) e mais 10 da Oben (recibo #1295): PV excluído
-- no Omie seguia no app contando nas vendas, e a reserva de estoque ficava 'ativa' para sempre — o app só espelhava o
-- CANCELAMENTO (etapa 80), e `private.atp_reconciliar_job` só libera com a canônica 'cancelado'.
--
-- Régua (decisões do founder + Codex de desenho, 2 rodadas — a 2ª reprovou e este é o redesenho):
--   · EXECUÇÃO: ≤ 1 por conta a cada 50 min (cron + staff juntos), presa à IDENTIDADE da credencial (hash da app_key,
--     fixado na 1ª execução; a outra conta não pode ter o mesmo) e só decide algo depois de CONFIRMAR a identidade
--     por um PID que o Omie listou e o banco conhece daquela conta (credencial trocada lista PIDs de outra empresa).
--   · RITMO (por conta): ListarPedidos ≤ 6 chamadas físicas em 60 min móveis (100 por página, sem retentativa);
--     ConsultarPedido ≤ 1 em 60 min móveis e ≤ 4 tentativas cobradas (tudo que não seja 'existe' ou 'nao_enviada')
--     em 24h móveis — o Omie bloqueia 30 min na 10ª requisição INCORRETA por IP+app_key+método.
--   · TRIAGEM nomeia, nunca decide: PIDs de uma janela de inclusão COMPLETA × banco na mesma janela. Presença é
--     registrada POR PÁGINA (mesmo em janela incompleta). Linha faturado/cancelado = contradição, nunca consultada.
--     Disjuntor: a janela é recusada (sem suspeito, com o motivo no log).
--   · BAIXA: 2 ausências afirmadas (2 log_id), a 2ª INICIADA ≥ 1h depois da RESPOSTA da 1ª, ambas posteriores à
--     última presença (triagem, consulta, ou omie_reconciliado_em). Na mesma transação da 2ª: trava a conta (tetos),
--     os locks do ATP, o gêmeo e TODAS as linhas do par (vivas e ocultas); revalida; libera as reservas com trilha e
--     marca deleted_at em todas as linhas vivas — status preservado, nunca DELETE.
--   · TETOS por conta em 24h móveis (Codex rodada 2): Oben 2 PVs · R$ 2.000/PV · R$ 2.700 somados · reserva ≤ 1 un
--     por SKU/PV, ≤ 3 SKUs/PV, ≤ 2 un por SKU em 24h; Colacor 2 PVs · R$ 750/PV · R$ 1.000 · reserva = revisão.
--   · DURABILIDADE: a baixa vence o rollback do front e a importação tardia da canônica; PID atribuído depois a uma
--     linha (write-back tardio) vira contradição. Desfazer é ato humano: limpar aplicado_em (SQL Editor) antes.
-- Nada aqui escreve no Omie.
-- ════════════════════════════════════════════════════════════════════════════════════════════════════════════════

-- ── 1. trilha do ATP: o valor novo da decisão ─────────────────────────────────────────────────────────────────────
-- Superconjunto EXATO do CHECK de prod (lido via psql-ro em 2026-11-21) + 'liberado_por_exclusao_omie'.
ALTER TABLE public.atp_decisoes DROP CONSTRAINT IF EXISTS atp_decisoes_decisao_check;
ALTER TABLE public.atp_decisoes ADD CONSTRAINT atp_decisoes_decisao_check CHECK (decisao = ANY (ARRAY[
  'reservado', 'bloqueado', 'backorder_autorizado', 'verificacao_indisponivel', 'liberado_por_cancelamento',
  'faturamento_observado', 'consumo_confirmado_manual', 'cancelamento_confirmado_manual', 'liberacao_forcada',
  'liberado_por_exclusao_omie']::text[]));

-- ── 2. tabelas ────────────────────────────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.omie_pv_conferencia (
  account                        text        NOT NULL CHECK (account IN ('oben', 'colacor')),
  omie_pedido_id                 bigint      NOT NULL CHECK (omie_pedido_id > 0),
  suspeito_desde                 timestamptz,
  ultima_suspeita_em             timestamptz,
  ultima_presenca_em             timestamptz,
  resolvido_em                   timestamptz,
  ultima_consulta_em             timestamptz,
  ultimo_resultado               text CHECK (ultimo_resultado IN ('existe', 'ausente', 'indeterminado', 'bloqueado', 'nao_enviada')),
  ausencias_afirmadas            integer     NOT NULL DEFAULT 0 CHECK (ausencias_afirmadas >= 0),
  primeira_ausencia_afirmada_em  timestamptz,
  ultima_ausencia_afirmada_em    timestamptz,
  ultima_ausencia_registrada_em  timestamptz,
  primeira_ausencia_log_id       bigint,
  status_local                   text,
  contradicao                    text,
  contradicao_em                 timestamptz,
  adiado_motivo                  text,
  aplicado_em                    timestamptz,
  valor_baixado                  numeric,
  prova                          jsonb,
  criado_em                      timestamptz NOT NULL DEFAULT now(),
  atualizado_em                  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (account, omie_pedido_id),
  CONSTRAINT omie_pv_conferencia_sequencia_coerente CHECK (
    (ausencias_afirmadas = 0) = (primeira_ausencia_afirmada_em IS NULL)
    AND (primeira_ausencia_afirmada_em IS NULL) = (ultima_ausencia_afirmada_em IS NULL)
    AND (primeira_ausencia_afirmada_em IS NULL) = (ultima_ausencia_registrada_em IS NULL)),
  CONSTRAINT omie_pv_conferencia_aplicado_com_prova CHECK (
    aplicado_em IS NULL OR (prova IS NOT NULL AND (ausencias_afirmadas >= 2 OR prova ? 'origem_historica')))
);
COMMENT ON TABLE public.omie_pv_conferencia IS
  'Ledger da reconciliação de PV excluído no Omie (edge omie-pv-exclusao-reconciliar). aplicado_em = baixa feita '
  '(deleted_at + reserva liberada), DURÁVEL (trigger em sales_orders). contradicao = revisão humana. Escrita só pelas RPCs.';

CREATE TABLE IF NOT EXISTS public.omie_pv_identidade (
  account     text PRIMARY KEY CHECK (account IN ('oben', 'colacor')),
  app_hash    text NOT NULL UNIQUE CHECK (app_hash ~ '^[0-9a-f]{32}$'),
  fixado_em   timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE public.omie_pv_identidade IS
  'Hash (sha-256, 32 hex) da app_key Omie de cada conta, fixado na 1ª execução. Trocar de credencial = apagar a linha à mão.';

CREATE TABLE IF NOT EXISTS public.omie_pv_execucao (
  id                     bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  account                text NOT NULL CHECK (account IN ('oben', 'colacor')),
  app_hash               text NOT NULL,
  iniciada_em            timestamptz NOT NULL DEFAULT now(),
  identidade_confirmada  boolean NOT NULL DEFAULT false,
  chamadas_listar        integer NOT NULL DEFAULT 0 CHECK (chamadas_listar >= 0),
  encerrada_em           timestamptz,
  resumo                 jsonb
);
CREATE INDEX IF NOT EXISTS omie_pv_execucao_conta_em ON public.omie_pv_execucao (account, iniciada_em DESC);

CREATE TABLE IF NOT EXISTS public.omie_pv_triagem_cursor (
  account        text PRIMARY KEY CHECK (account IN ('oben', 'colacor')),
  semana_cursor  date NOT NULL CHECK (extract(isodow FROM semana_cursor) = 1),
  atualizado_em  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.omie_pv_triagem_log (
  id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  execucao_id    bigint NOT NULL,
  account        text NOT NULL CHECK (account IN ('oben', 'colacor')),
  janela_de      date NOT NULL,
  janela_ate     date NOT NULL,
  tipo           text NOT NULL CHECK (tipo IN ('corrente', 'cursor')),
  n_omie         integer NOT NULL,
  n_banco        integer NOT NULL,
  n_suspeitos    integer NOT NULL,
  n_contradicoes integer NOT NULL,
  n_presentes    integer NOT NULL,
  recusa         text,
  registrado_em  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS omie_pv_triagem_log_conta_em ON public.omie_pv_triagem_log (account, registrado_em DESC);

CREATE TABLE IF NOT EXISTS public.omie_pv_consulta_log (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  execucao_id     bigint NOT NULL,
  account         text NOT NULL CHECK (account IN ('oben', 'colacor')),
  omie_pedido_id  bigint NOT NULL CHECK (omie_pedido_id > 0),
  reservada_em    timestamptz NOT NULL DEFAULT now(),
  resultado       text CHECK (resultado IN ('existe', 'ausente', 'indeterminado', 'bloqueado', 'nao_enviada')),
  efeito          text,
  detalhe         jsonb,
  registrada_em   timestamptz,
  CONSTRAINT omie_pv_consulta_log_registro_coerente CHECK ((resultado IS NULL) = (registrada_em IS NULL))
);
CREATE INDEX IF NOT EXISTS omie_pv_consulta_log_conta_em ON public.omie_pv_consulta_log (account, reservada_em DESC);
CREATE INDEX IF NOT EXISTS omie_pv_consulta_log_pid ON public.omie_pv_consulta_log (account, omie_pedido_id, reservada_em DESC);

-- Impacto IMUTÁVEL de cada baixa no estoque (Codex rodada 2, P0-5): o teto de unidades soma daqui.
CREATE TABLE IF NOT EXISTS public.omie_pv_baixa_reserva (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  account         text NOT NULL,
  omie_pedido_id  bigint NOT NULL,
  reserva_id      uuid NOT NULL UNIQUE,
  pool            text NOT NULL,
  sku             bigint NOT NULL,
  quantidade      numeric NOT NULL,
  aplicado_em     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS omie_pv_baixa_reserva_sku_em ON public.omie_pv_baixa_reserva (pool, sku, aplicado_em DESC);

-- RLS: staff lê; ninguém além das RPCs (SECURITY DEFINER) escreve. A identidade não é lida nem por staff.
DO $rls$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['omie_pv_conferencia', 'omie_pv_identidade', 'omie_pv_execucao', 'omie_pv_triagem_cursor',
                           'omie_pv_triagem_log', 'omie_pv_consulta_log', 'omie_pv_baixa_reserva'] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('REVOKE ALL ON TABLE public.%I FROM PUBLIC, anon, authenticated, service_role', t);
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', t || '_select_staff', t);
    IF t <> 'omie_pv_identidade' THEN
      EXECUTE format('GRANT SELECT ON TABLE public.%I TO authenticated, service_role', t);
      EXECUTE format('CREATE POLICY %I ON public.%I FOR SELECT TO authenticated USING ('
                     '(SELECT public.has_role(auth.uid(), ''employee''::public.app_role)) '
                     'OR (SELECT public.has_role(auth.uid(), ''master''::public.app_role)))', t || '_select_staff', t);
    END IF;
  END LOOP;
END
$rls$;

-- ── 3. execução: identidade, cadência e orçamento de listagem ─────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.omie_pv_execucao_iniciar(p_account text, p_app_hash text)
RETURNS TABLE (execucao_id bigint, motivo text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_fixo text;
  v_id   bigint;
BEGIN
  IF p_account IS NULL OR p_account NOT IN ('oben', 'colacor') OR p_app_hash IS NULL OR p_app_hash !~ '^[0-9a-f]{32}$' THEN
    RAISE EXCEPTION 'omie_pv_execucao_iniciar: conta/identidade inválida (%)', p_account USING ERRCODE = '22023';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('omie_pv_execucao', 0));
  IF EXISTS (SELECT 1 FROM public.omie_pv_identidade i WHERE i.app_hash = p_app_hash AND i.account <> p_account) THEN
    RETURN QUERY SELECT NULL::bigint, 'identidade_de_outra_conta'::text; RETURN;
  END IF;
  INSERT INTO public.omie_pv_identidade (account, app_hash) VALUES (p_account, p_app_hash) ON CONFLICT (account) DO NOTHING;
  SELECT i.app_hash INTO v_fixo FROM public.omie_pv_identidade i WHERE i.account = p_account;
  IF v_fixo IS DISTINCT FROM p_app_hash THEN
    RETURN QUERY SELECT NULL::bigint, 'identidade_divergente'::text; RETURN;
  END IF;
  IF EXISTS (SELECT 1 FROM public.omie_pv_execucao e WHERE e.account = p_account AND e.iniciada_em > now() - interval '50 minutes') THEN
    RETURN QUERY SELECT NULL::bigint, 'execucao_recente'::text; RETURN;
  END IF;
  INSERT INTO public.omie_pv_execucao (account, app_hash) VALUES (p_account, p_app_hash) RETURNING id INTO v_id;
  RETURN QUERY SELECT v_id, 'iniciada'::text;
END;
$$;

-- A execução vale por 15 min (a edge tem relógio de ~150 s; o resto é folga).
CREATE OR REPLACE FUNCTION private.omie_pv_execucao_viva(p_execucao_id bigint)
RETURNS public.omie_pv_execucao
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE v public.omie_pv_execucao%ROWTYPE;
BEGIN
  SELECT * INTO v FROM public.omie_pv_execucao e WHERE e.id = p_execucao_id;
  IF NOT FOUND OR v.encerrada_em IS NOT NULL OR v.iniciada_em < now() - interval '15 minutes' THEN
    RAISE EXCEPTION 'omie_pv: execução % inexistente, encerrada ou vencida', p_execucao_id USING ERRCODE = '22023';
  END IF;
  RETURN v;
END;
$$;

-- Uma chamada física de ListarPedidos: concedida se a conta não passou de 6 em 60 min móveis.
CREATE OR REPLACE FUNCTION public.omie_pv_listar_vez(p_execucao_id bigint)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE v public.omie_pv_execucao%ROWTYPE;
BEGIN
  v := private.omie_pv_execucao_viva(p_execucao_id);
  PERFORM pg_advisory_xact_lock(hashtextextended('omie_pv_listar:' || v.account, 0));
  IF (SELECT COALESCE(sum(e.chamadas_listar), 0) FROM public.omie_pv_execucao e
       WHERE e.account = v.account AND e.iniciada_em > now() - interval '60 minutes') >= 6 THEN
    RETURN false;
  END IF;
  UPDATE public.omie_pv_execucao e SET chamadas_listar = e.chamadas_listar + 1 WHERE e.id = p_execucao_id;
  RETURN true;
END;
$$;

CREATE OR REPLACE FUNCTION public.omie_pv_execucao_encerrar(p_execucao_id bigint, p_resumo jsonb)
RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  UPDATE public.omie_pv_execucao e SET encerrada_em = now(), resumo = p_resumo
   WHERE e.id = p_execucao_id AND e.encerrada_em IS NULL;
$$;

-- ── 4. presença (por página, mesmo em janela incompleta — Codex rodada 2, P0-2) ───────────────────────────────────
CREATE OR REPLACE FUNCTION private.omie_pv_marcar_presenca(p_account text, p_pids bigint[])
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE v_n integer;
BEGIN
  UPDATE public.omie_pv_conferencia c
     SET ultima_presenca_em = now(),
         resolvido_em = CASE WHEN c.suspeito_desde IS NOT NULL AND c.resolvido_em IS NULL THEN now() ELSE c.resolvido_em END,
         -- Baixa já aplicada guarda a sequência que a provou (a prova não se reescreve); vira contradição abaixo.
         ausencias_afirmadas = CASE WHEN c.aplicado_em IS NULL THEN 0 ELSE c.ausencias_afirmadas END,
         primeira_ausencia_afirmada_em = CASE WHEN c.aplicado_em IS NULL THEN NULL ELSE c.primeira_ausencia_afirmada_em END,
         ultima_ausencia_afirmada_em = CASE WHEN c.aplicado_em IS NULL THEN NULL ELSE c.ultima_ausencia_afirmada_em END,
         ultima_ausencia_registrada_em = CASE WHEN c.aplicado_em IS NULL THEN NULL ELSE c.ultima_ausencia_registrada_em END,
         primeira_ausencia_log_id = CASE WHEN c.aplicado_em IS NULL THEN NULL ELSE c.primeira_ausencia_log_id END,
         contradicao = CASE WHEN c.aplicado_em IS NOT NULL AND c.contradicao IS NULL THEN 'reapareceu_apos_baixa' ELSE c.contradicao END,
         contradicao_em = CASE WHEN c.aplicado_em IS NOT NULL AND c.contradicao IS NULL THEN now() ELSE c.contradicao_em END,
         atualizado_em = now()
   WHERE c.account = p_account AND c.omie_pedido_id = ANY (p_pids);
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN v_n;
END;
$$;

CREATE OR REPLACE FUNCTION public.omie_pv_presenca_registrar(p_execucao_id bigint, p_pids bigint[])
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v public.omie_pv_execucao%ROWTYPE;
  v_n integer;
  v_conhecido boolean;
BEGIN
  v := private.omie_pv_execucao_viva(p_execucao_id);
  IF p_pids IS NULL OR array_position(p_pids, NULL) IS NOT NULL OR EXISTS (SELECT 1 FROM unnest(p_pids) x WHERE x <= 0) THEN
    RAISE EXCEPTION 'omie_pv_presenca_registrar: conjunto inválido' USING ERRCODE = '22023';
  END IF;
  v_n := private.omie_pv_marcar_presenca(v.account, p_pids);
  -- Identidade: o Omie listou um PID que o banco conhece DESTA conta (credencial trocada lista PIDs de outra empresa).
  v_conhecido := EXISTS (SELECT 1 FROM public.sales_orders so WHERE so.account = v.account AND so.omie_pedido_id = ANY (p_pids));
  IF v_conhecido AND NOT v.identidade_confirmada THEN
    UPDATE public.omie_pv_execucao e SET identidade_confirmada = true WHERE e.id = p_execucao_id;
  END IF;
  RETURN jsonb_build_object('presencas', v_n, 'identidade_confirmada', v.identidade_confirmada OR v_conhecido);
END;
$$;

-- ── 5. janelas da triagem ─────────────────────────────────────────────────────────────────────────────────────────
-- Semana corrente (segunda → hoje, civil de São Paulo) + 1 semana do cursor, que anda para trás até 2024-01-01 e dá
-- a volta. O cursor só anda quando a janela 'cursor' é registrada COMPLETA.
CREATE OR REPLACE FUNCTION public.omie_pv_triagem_janelas(p_account text)
RETURNS TABLE (de date, ate date, tipo text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_hoje date := (now() AT TIME ZONE 'America/Sao_Paulo')::date;
  v_seg  date := date_trunc('week', (now() AT TIME ZONE 'America/Sao_Paulo')::date)::date;
  v_cur  date;
BEGIN
  IF p_account IS NULL OR p_account NOT IN ('oben', 'colacor') THEN
    RAISE EXCEPTION 'omie_pv_triagem_janelas: conta inválida (%)', p_account USING ERRCODE = '22023';
  END IF;
  INSERT INTO public.omie_pv_triagem_cursor (account, semana_cursor) VALUES (p_account, v_seg - 7)
  ON CONFLICT (account) DO NOTHING;
  SELECT c.semana_cursor INTO v_cur FROM public.omie_pv_triagem_cursor c WHERE c.account = p_account;
  IF v_cur < date '2024-01-01' OR v_cur >= v_seg THEN
    v_cur := v_seg - 7;
  END IF;
  RETURN QUERY VALUES (v_seg, v_hoje, 'corrente'::text), (v_cur, v_cur + 6, 'cursor'::text);
END;
$$;

-- Conjunto do banco numa janela de inclusão: PIDs com linha VIVA cuja data de inclusão cai na janela (canônica pelo
-- order_date_kpi = dInc; linha do app pela data da gêmea, senão a própria, senão a civil de created_at) + reservas
-- ATIVAS com par próprio (Codex P0-4: a linha pode já ter sumido e a reserva ficar presa). `recente` = carência de
-- visibilidade pelo instante em que o BANCO viu a linha (created_at da linha/reserva).
CREATE OR REPLACE FUNCTION private.omie_pv_banco_na_janela(p_account text, p_de date, p_ate date)
RETURNS TABLE (omie_pedido_id bigint, recente boolean)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  WITH linhas AS (
    SELECT so.omie_pedido_id AS pid, so.created_at
      FROM public.sales_orders so
      LEFT JOIN public.sales_orders g ON g.id = so.gemeo_importado_id
     WHERE so.account = p_account
       AND so.omie_pedido_id IS NOT NULL
       AND so.deleted_at IS NULL
       AND COALESCE(g.order_date_kpi, so.order_date_kpi, (so.created_at AT TIME ZONE 'America/Sao_Paulo')::date)
           BETWEEN p_de AND p_ate
    UNION ALL
    SELECT r.omie_pedido_id, r.created_at
      FROM public.estoque_reservas r
     WHERE r.omie_account = p_account
       AND r.omie_pedido_id IS NOT NULL
       AND r.status = 'ativa'
       AND (r.created_at AT TIME ZONE 'America/Sao_Paulo')::date BETWEEN p_de AND p_ate
  )
  SELECT l.pid, bool_or(l.created_at > now() - interval '2 hours')
    FROM linhas l
   GROUP BY l.pid;
$$;

-- ── 6. registro de uma janela COMPLETA ────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.omie_pv_triagem_registrar(
  p_execucao_id bigint, p_de date, p_ate date, p_tipo text, p_pids bigint[])
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v          public.omie_pv_execucao%ROWTYPE;
  v_seg      date := date_trunc('week', (now() AT TIME ZONE 'America/Sao_Paulo')::date)::date;
  v_cur      date;
  v_n_banco  integer;
  v_n_susp   integer;
  v_n_contr  integer;
  v_n_pres   integer;
  v_prox     date;
  v_recusa   text;
  v_susp     bigint[];
  v_term     bigint[];
BEGIN
  v := private.omie_pv_execucao_viva(p_execucao_id);
  IF p_tipo IS NULL OR p_tipo NOT IN ('corrente', 'cursor') OR p_de IS NULL OR p_ate IS NULL
     OR p_ate < p_de OR p_ate - p_de > 6 OR p_pids IS NULL OR array_position(p_pids, NULL) IS NOT NULL
     OR EXISTS (SELECT 1 FROM unnest(p_pids) x WHERE x <= 0) THEN
    RAISE EXCEPTION 'omie_pv_triagem_registrar: janela/conjunto inválido (% % % %)', p_tipo, p_de, p_ate, cardinality(p_pids)
      USING ERRCODE = '22023';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('omie_pv_triagem:' || v.account, 0));
  IF p_tipo = 'corrente' AND p_de <> v_seg THEN
    RAISE EXCEPTION 'omie_pv_triagem_registrar: janela corrente vencida (% ≠ %)', p_de, v_seg USING ERRCODE = '22023';
  END IF;
  IF p_tipo = 'cursor' THEN
    SELECT c.semana_cursor INTO v_cur FROM public.omie_pv_triagem_cursor c WHERE c.account = v.account FOR UPDATE;
    IF v_cur IS NULL OR v_cur < date '2024-01-01' OR v_cur >= v_seg THEN v_cur := v_seg - 7; END IF;
    IF p_de <> v_cur OR p_ate <> v_cur + 6 THEN
      RAISE EXCEPTION 'omie_pv_triagem_registrar: janela de cursor vencida (% ≠ %)', p_de, v_cur USING ERRCODE = '22023';
    END IF;
  END IF;

  -- Presença primeiro: vale mesmo se a janela for recusada abaixo.
  v_n_pres := private.omie_pv_marcar_presenca(v.account, p_pids);
  IF NOT v.identidade_confirmada
     AND EXISTS (SELECT 1 FROM public.sales_orders so WHERE so.account = v.account AND so.omie_pedido_id = ANY (p_pids)) THEN
    UPDATE public.omie_pv_execucao e SET identidade_confirmada = true WHERE e.id = p_execucao_id;
    v.identidade_confirmada := true;
  END IF;

  -- Sem tabela temporária: numa SECURITY DEFINER, um nome não-qualificado poderia ser sombreado pelo chamador.
  SELECT count(*),
         COALESCE(array_agg(x.pid ORDER BY x.pid) FILTER (WHERE NOT x.no_omie AND NOT x.recente AND NOT x.terminal), '{}'),
         COALESCE(array_agg(x.pid ORDER BY x.pid) FILTER (WHERE NOT x.no_omie AND NOT x.recente AND x.terminal), '{}')
    INTO v_n_banco, v_susp, v_term
    FROM (SELECT b.omie_pedido_id AS pid, b.omie_pedido_id = ANY (p_pids) AS no_omie, b.recente,
                 EXISTS (SELECT 1 FROM public.sales_orders t
                          WHERE t.account = v.account AND t.omie_pedido_id = b.omie_pedido_id
                            AND t.status IN ('faturado', 'cancelado')) AS terminal
            FROM private.omie_pv_banco_na_janela(v.account, p_de, p_ate) b) x;
  v_n_susp := cardinality(v_susp);
  v_n_contr := cardinality(v_term);

  -- Disjuntor (decisão do founder): listagem que contradiz o banco em massa é LISTAGEM errada. A janela é RECUSADA:
  -- nenhum suspeito, motivo no log, e o cursor segue (uma semana recusada não prende a volta — Codex P1).
  v_recusa := CASE
    WHEN v_n_susp + v_n_contr > 15 THEN 'disjuntor_suspeitos'
    WHEN cardinality(p_pids) = 0 AND v_n_banco > 3 THEN 'disjuntor_omie_vazio'
    WHEN v_n_susp + v_n_contr >= 3 AND v_n_susp + v_n_contr > (v_n_banco - v_n_susp - v_n_contr) THEN 'disjuntor_maioria_ausente'
    WHEN v_n_susp + v_n_contr > 0 AND NOT v.identidade_confirmada THEN 'identidade_nao_confirmada'
  END;

  IF v_recusa IS NULL THEN
    INSERT INTO public.omie_pv_conferencia AS c
           (account, omie_pedido_id, suspeito_desde, ultima_suspeita_em, status_local, contradicao, contradicao_em)
    SELECT v.account, t.pid, now(), now(),
           (SELECT string_agg(DISTINCT so.status, ',' ORDER BY so.status) FROM public.sales_orders so
             WHERE so.account = v.account AND so.omie_pedido_id = t.pid),
           CASE WHEN t.terminal THEN 'linha_terminal' END, CASE WHEN t.terminal THEN now() END
      FROM (SELECT u AS pid, false AS terminal FROM unnest(v_susp) u
            UNION ALL SELECT u, true FROM unnest(v_term) u) t
    ON CONFLICT (account, omie_pedido_id) DO UPDATE
       SET ultima_suspeita_em = now(),
           suspeito_desde = CASE WHEN c.suspeito_desde IS NULL OR c.resolvido_em IS NOT NULL THEN now() ELSE c.suspeito_desde END,
           resolvido_em = NULL,
           status_local = EXCLUDED.status_local,
           contradicao = COALESCE(c.contradicao, EXCLUDED.contradicao),
           contradicao_em = COALESCE(c.contradicao_em, EXCLUDED.contradicao_em),
           atualizado_em = now()
     WHERE c.aplicado_em IS NULL;
  END IF;

  INSERT INTO public.omie_pv_triagem_log (execucao_id, account, janela_de, janela_ate, tipo, n_omie, n_banco, n_suspeitos,
                                          n_contradicoes, n_presentes, recusa)
  VALUES (p_execucao_id, v.account, p_de, p_ate, p_tipo, cardinality(p_pids), v_n_banco, v_n_susp, v_n_contr, v_n_pres, v_recusa);

  IF p_tipo = 'cursor' AND v_recusa IS DISTINCT FROM 'identidade_nao_confirmada' THEN
    v_prox := p_de - 7;
    IF v_prox < date '2024-01-01' THEN v_prox := v_seg - 7; END IF;
    INSERT INTO public.omie_pv_triagem_cursor (account, semana_cursor, atualizado_em) VALUES (v.account, v_prox, now())
    ON CONFLICT (account) DO UPDATE SET semana_cursor = EXCLUDED.semana_cursor, atualizado_em = now();
  END IF;

  RETURN jsonb_build_object('janela_de', p_de, 'janela_ate', p_ate, 'tipo', p_tipo, 'n_omie', cardinality(p_pids),
                            'n_banco', v_n_banco, 'suspeitos', v_n_susp, 'contradicoes', v_n_contr, 'presentes', v_n_pres,
                            'recusa', v_recusa, 'proximo_cursor', v_prox);
END;
$$;

-- ── 7. a vez de UMA consulta ──────────────────────────────────────────────────────────────────────────────────────
-- Devolve (log_id, pid, 'concedida') ou (NULL, NULL, motivo). A vez é a linha do log, gravada ANTES do fetch: uma edge
-- que morre no meio GASTA a vez e a tentativa fica COBRADA no orçamento de erros (o Omie pode tê-la contado).
CREATE OR REPLACE FUNCTION public.omie_pv_proxima_consulta(p_execucao_id bigint)
RETURNS TABLE (log_id bigint, omie_pedido_id bigint, motivo text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v     public.omie_pv_execucao%ROWTYPE;
  v_pid bigint;
  v_id  bigint;
BEGIN
  v := private.omie_pv_execucao_viva(p_execucao_id);
  PERFORM pg_advisory_xact_lock(hashtextextended('omie_pv_consulta:' || v.account, 0));
  SELECT * INTO v FROM public.omie_pv_execucao e WHERE e.id = p_execucao_id;  -- releitura sob o lock
  IF NOT v.identidade_confirmada THEN
    RETURN QUERY SELECT NULL::bigint, NULL::bigint, 'identidade_nao_confirmada'::text; RETURN;
  END IF;
  IF EXISTS (SELECT 1 FROM public.omie_cota_metodo m
              WHERE m.conta = v.account AND m.metodo IN ('ConsultarPedido', 'ListarPedidos')
                AND m.bloqueado_ate > now()) THEN
    RETURN QUERY SELECT NULL::bigint, NULL::bigint, 'bloqueado'::text; RETURN;
  END IF;
  -- RITMO: ≤ 1 tentativa por hora por conta ('nao_enviada' = a chamada comprovadamente não saiu).
  IF EXISTS (SELECT 1 FROM public.omie_pv_consulta_log l
              WHERE l.account = v.account AND l.reservada_em > now() - interval '60 minutes'
                AND l.resultado IS DISTINCT FROM 'nao_enviada') THEN
    RETURN QUERY SELECT NULL::bigint, NULL::bigint, 'aguardando_vez'::text; RETURN;
  END IF;
  -- Orçamento de requisições potencialmente INCORRETAS: tudo que não provou sucesso (nem deixou de sair).
  IF (SELECT count(*) FROM public.omie_pv_consulta_log l
       WHERE l.account = v.account AND l.reservada_em > now() - interval '24 hours'
         AND l.resultado IS DISTINCT FROM 'existe' AND l.resultado IS DISTINCT FROM 'nao_enviada') >= 4 THEN
    RETURN QUERY SELECT NULL::bigint, NULL::bigint, 'teto_erros_24h'::text; RETURN;
  END IF;

  SELECT c.omie_pedido_id INTO v_pid
    FROM public.omie_pv_conferencia c
   WHERE c.account = v.account
     AND c.suspeito_desde IS NOT NULL AND c.resolvido_em IS NULL
     AND c.aplicado_em IS NULL AND c.contradicao IS NULL
     AND (c.ausencias_afirmadas = 0 OR c.ultima_ausencia_registrada_em <= now() - interval '1 hour')
     AND NOT EXISTS (SELECT 1 FROM public.sales_orders so
                      WHERE so.account = c.account AND so.omie_pedido_id = c.omie_pedido_id
                        AND so.envio_omie_reivindicado_em > now() - interval '10 minutes')
   ORDER BY (c.ausencias_afirmadas >= 1) DESC,
            (SELECT count(*) FROM public.omie_pv_consulta_log l
              WHERE l.account = c.account AND l.omie_pedido_id = c.omie_pedido_id
                AND l.reservada_em > now() - interval '24 hours'
                AND l.resultado IS DISTINCT FROM 'ausente' AND l.resultado IS DISTINCT FROM 'existe') ASC,
            EXISTS (SELECT 1 FROM public.estoque_reservas r
                     WHERE r.omie_account = c.account AND r.omie_pedido_id = c.omie_pedido_id AND r.status = 'ativa') DESC,
            c.ultima_consulta_em ASC NULLS FIRST,
            c.suspeito_desde ASC,
            c.omie_pedido_id ASC
   LIMIT 1;
  IF v_pid IS NULL THEN
    RETURN QUERY SELECT NULL::bigint, NULL::bigint, 'sem_suspeito'::text; RETURN;
  END IF;

  INSERT INTO public.omie_pv_consulta_log (execucao_id, account, omie_pedido_id) VALUES (p_execucao_id, v.account, v_pid)
  RETURNING id INTO v_id;
  UPDATE public.omie_pv_conferencia c SET ultima_consulta_em = now(), atualizado_em = now()
   WHERE c.account = v.account AND c.omie_pedido_id = v_pid;
  RETURN QUERY SELECT v_id, v_pid, 'concedida'::text;
END;
$$;

-- ── 8. a BAIXA (só de dentro de omie_pv_consulta_registrar, com a linha do ledger já travada) ─────────────────────
CREATE OR REPLACE FUNCTION private.omie_pv_aplicar_baixa(p_account text, p_pid bigint, p_log_ids bigint[])
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  -- Tetos por conta (24h móveis) — Codex de desenho rodada 2, seção 6.
  v_max_pvs   integer := CASE p_account WHEN 'oben' THEN 2 ELSE 2 END;
  v_max_pv    numeric := CASE p_account WHEN 'oben' THEN 2000 ELSE 750 END;
  v_max_soma  numeric := CASE p_account WHEN 'oben' THEN 2700 ELSE 1000 END;
  v_c         public.omie_pv_conferencia%ROWTYPE;
  v_ids       uuid[];
  v_res       uuid[];
  v_res2      uuid[];
  v_cks       uuid[];
  v_ck        uuid;
  v_lock      record;
  v_kpi       record;
  v_valor     numeric;
  v_veto      numeric;
  v_n_24h     integer;
  v_rs_24h    numeric;
  v_pres      timestamptz;
  v_n_res     integer;
  v_n_lin     integer;
  v_motivo    text;
  v_adiar     text;
BEGIN
  SELECT * INTO v_c FROM public.omie_pv_conferencia c WHERE c.account = p_account AND c.omie_pedido_id = p_pid;
  IF v_c.aplicado_em IS NOT NULL THEN
    RETURN jsonb_build_object('efeito', 'ja_aplicado');
  END IF;

  -- (0) Teto é por CONTA: duas baixas de PIDs diferentes não leem o mesmo saldo (Codex rodada 2, P0-5).
  PERFORM pg_advisory_xact_lock(hashtextextended('omie_pv_baixa:' || p_account, 0));

  -- (1) Locks na ORDEM do ATP (atp_confirmar_pv/reservar_estoque): checkouts → SKUs → gêmeo → linhas (todas, inclusive
  -- as ocultas). Um deadlock com outro escritor aborta a transação inteira; a edge repete com o MESMO log_id.
  SELECT array_agg(r.id ORDER BY r.id), array_agg(DISTINCT r.checkout_id ORDER BY r.checkout_id)
    INTO v_res, v_cks
    FROM public.estoque_reservas r
   WHERE r.status = 'ativa'
     AND ((r.omie_account = p_account AND r.omie_pedido_id = p_pid)
          OR r.sales_order_id IN (SELECT so.id FROM public.sales_orders so WHERE so.account = p_account AND so.omie_pedido_id = p_pid));
  FOREACH v_ck IN ARRAY COALESCE(v_cks, '{}'::uuid[]) LOOP
    PERFORM pg_advisory_xact_lock(hashtextextended('atp:checkout:' || v_ck::text, 0));
  END LOOP;
  FOR v_lock IN
    SELECT DISTINCT r.pool, r.omie_codigo_produto AS sku FROM public.estoque_reservas r
     WHERE r.id = ANY (COALESCE(v_res, '{}'::uuid[])) ORDER BY 2, 1
  LOOP
    PERFORM pg_advisory_xact_lock(hashtextextended('atp:sku:' || v_lock.pool || ':' || v_lock.sku::text, 0));
  END LOOP;
  PERFORM pg_advisory_xact_lock(hashtextextended('sales_orders.gemeo:' || p_account || ':' || p_pid, 0));
  SELECT array_agg(so.id ORDER BY so.id) INTO v_ids
    FROM public.sales_orders so WHERE so.account = p_account AND so.omie_pedido_id = p_pid;
  PERFORM 1 FROM public.sales_orders so WHERE so.id = ANY (COALESCE(v_ids, '{}'::uuid[])) ORDER BY so.id FOR UPDATE;

  -- (2) Revalidação SOB os locks.
  SELECT array_agg(r.id ORDER BY r.id) INTO v_res2
    FROM public.estoque_reservas r
   WHERE r.status = 'ativa'
     AND ((r.omie_account = p_account AND r.omie_pedido_id = p_pid) OR r.sales_order_id = ANY (COALESCE(v_ids, '{}'::uuid[])));
  IF v_res2 IS DISTINCT FROM v_res THEN
    v_adiar := 'reservas_mudaram';   -- o conjunto travado não é mais o conjunto: nada é liberado sem o lock certo
  END IF;
  SELECT max(so.omie_reconciliado_em) INTO v_pres FROM public.sales_orders so WHERE so.id = ANY (COALESCE(v_ids, '{}'::uuid[]));
  IF v_pres IS NOT NULL AND v_pres >= v_c.primeira_ausencia_afirmada_em THEN
    UPDATE public.omie_pv_conferencia c
       SET ultima_presenca_em = GREATEST(c.ultima_presenca_em, v_pres), resolvido_em = now(),
           ausencias_afirmadas = 0, primeira_ausencia_afirmada_em = NULL, ultima_ausencia_afirmada_em = NULL,
           ultima_ausencia_registrada_em = NULL, primeira_ausencia_log_id = NULL, atualizado_em = now()
     WHERE c.account = p_account AND c.omie_pedido_id = p_pid;
    RETURN jsonb_build_object('efeito', 'presenca_do_sync', 'relido_em', v_pres);
  END IF;
  IF v_adiar IS NULL AND EXISTS (SELECT 1 FROM public.sales_orders so WHERE so.id = ANY (COALESCE(v_ids, '{}'::uuid[]))
                AND so.envio_omie_reivindicado_em > now() - interval '10 minutes') THEN
    v_adiar := 'envio_em_curso';
  END IF;

  -- Contradições (revisão humana, nunca baixa).
  IF EXISTS (SELECT 1 FROM public.sales_orders so WHERE so.id = ANY (COALESCE(v_ids, '{}'::uuid[]))
                AND so.status IN ('faturado', 'cancelado')) THEN
    v_motivo := 'linha_terminal';
  ELSIF EXISTS (SELECT 1 FROM public.estoque_reservas r WHERE r.id = ANY (COALESCE(v_res2, '{}'::uuid[]))
                   AND ((r.omie_pedido_id IS NOT NULL AND (r.omie_account, r.omie_pedido_id) IS DISTINCT FROM (p_account, p_pid))
                        OR (r.sales_order_id IS NOT NULL AND NOT (r.sales_order_id = ANY (COALESCE(v_ids, '{}'::uuid[])))))) THEN
    v_motivo := 'reserva_divergente';   -- nos DOIS sentidos (Codex rodada 2, P0-4)
  ELSIF EXISTS (SELECT 1 FROM public.estoque_reservas r WHERE r.id = ANY (COALESCE(v_res2, '{}'::uuid[]))
                   AND r.faturamento_observado_em IS NOT NULL) THEN
    v_motivo := 'reserva_com_faturamento';
  ELSIF p_account <> 'oben' AND COALESCE(cardinality(v_res2), 0) > 0 THEN
    v_motivo := 'reserva_fora_do_pool';  -- a Colacor fica fora do pool do ATP: reserva dela é estado a revisar
  ELSIF (SELECT count(DISTINCT (r.pool, r.omie_codigo_produto)) FROM public.estoque_reservas r
          WHERE r.id = ANY (COALESCE(v_res2, '{}'::uuid[]))) > 3
     OR EXISTS (SELECT 1 FROM public.estoque_reservas r WHERE r.id = ANY (COALESCE(v_res2, '{}'::uuid[]))
                 GROUP BY r.pool, r.omie_codigo_produto HAVING sum(r.quantidade) > 1) THEN
    v_motivo := 'teto_unidades_pv';
  END IF;

  -- Valor: UMA vez, pela linha que entra no KPI (canônica primeiro). Veto individual também sobre linha já oculta.
  SELECT so.total, (so.total IS NULL) AS ilegivel INTO v_kpi
    FROM public.sales_orders so
   WHERE so.id = ANY (COALESCE(v_ids, '{}'::uuid[])) AND so.deleted_at IS NULL AND so.order_date_kpi IS NOT NULL
     AND so.status NOT IN ('cancelado', 'rascunho', 'pendente', 'orcamento')
   ORDER BY (so.hash_payload IS NOT NULL) DESC, so.id
   LIMIT 1;
  v_valor := COALESCE(v_kpi.total, 0);
  SELECT max(so.total) INTO v_veto FROM public.sales_orders so WHERE so.id = ANY (COALESCE(v_ids, '{}'::uuid[]));
  IF v_motivo IS NULL AND v_kpi.ilegivel IS TRUE THEN v_motivo := 'valor_ilegivel'; END IF;
  IF v_motivo IS NULL AND GREATEST(v_valor, COALESCE(v_veto, 0)) > v_max_pv THEN v_motivo := 'teto_valor_pv'; END IF;

  IF v_motivo IS NOT NULL THEN
    UPDATE public.omie_pv_conferencia c SET contradicao = v_motivo, contradicao_em = now(), atualizado_em = now()
     WHERE c.account = p_account AND c.omie_pedido_id = p_pid;
    RETURN jsonb_build_object('efeito', 'revisao', 'motivo', v_motivo);
  END IF;

  SELECT count(*), COALESCE(sum(c.valor_baixado), 0) INTO v_n_24h, v_rs_24h
    FROM public.omie_pv_conferencia c
   WHERE c.account = p_account AND c.aplicado_em > now() - interval '24 hours' AND NOT (c.prova ? 'origem_historica');
  IF v_adiar IS NULL AND v_n_24h >= v_max_pvs THEN v_adiar := 'teto_pvs_24h'; END IF;
  IF v_adiar IS NULL AND v_rs_24h + v_valor > v_max_soma THEN v_adiar := 'teto_valor_24h'; END IF;
  IF v_adiar IS NULL AND EXISTS (
       SELECT 1 FROM public.estoque_reservas r
        WHERE r.id = ANY (COALESCE(v_res2, '{}'::uuid[]))
        GROUP BY r.pool, r.omie_codigo_produto
       HAVING sum(r.quantidade) + COALESCE((SELECT sum(b.quantidade) FROM public.omie_pv_baixa_reserva b
                                             WHERE b.pool = r.pool AND b.sku = r.omie_codigo_produto
                                               AND b.aplicado_em > now() - interval '24 hours'), 0) > 2) THEN
    v_adiar := 'teto_unidades_24h';
  END IF;
  IF v_adiar IS NOT NULL THEN
    -- Adiado não é contradição: a sequência fica, e a próxima ausência (≥ 1h) tenta de novo.
    UPDATE public.omie_pv_conferencia c SET adiado_motivo = v_adiar, atualizado_em = now()
     WHERE c.account = p_account AND c.omie_pedido_id = p_pid;
    RETURN jsonb_build_object('efeito', 'adiado', 'motivo', v_adiar);
  END IF;

  -- (3) Reservas → 'liberada' (ANTES do deleted_at, na mesma transação), com trilha e impacto imutável.
  WITH upd AS (
    UPDATE public.estoque_reservas r
       SET status = 'liberada',
           motivo = 'reconciliacao: PV ' || p_pid || ' (' || p_account || ') excluído no Omie — 2 ausências afirmadas',
           atualizado_em = now()
     WHERE r.id = ANY (COALESCE(v_res2, '{}'::uuid[])) AND r.status = 'ativa'
    RETURNING r.id, r.sales_order_id, r.checkout_id, r.pool, r.omie_codigo_produto, r.quantidade
  ), impacto AS (
    INSERT INTO public.omie_pv_baixa_reserva (account, omie_pedido_id, reserva_id, pool, sku, quantidade)
    SELECT p_account, p_pid, u.id, u.pool, u.omie_codigo_produto, u.quantidade FROM upd u
    RETURNING 1
  ), trilha AS (
    INSERT INTO public.atp_decisoes (sales_order_id, checkout_id, pool, account, decisao, contexto, enforcement, actor_user_id)
    SELECT DISTINCT u.sales_order_id, u.checkout_id, u.pool, p_account, 'liberado_por_exclusao_omie', 'reconciliacao', true, NULL::uuid
      FROM upd u
    RETURNING 1
  )
  SELECT count(*) INTO v_n_res FROM upd;

  -- (4) deleted_at em TODAS as linhas vivas do (conta, PID); status preservado.
  UPDATE public.sales_orders so SET deleted_at = now()
   WHERE so.id = ANY (COALESCE(v_ids, '{}'::uuid[])) AND so.deleted_at IS NULL;
  GET DIAGNOSTICS v_n_lin = ROW_COUNT;

  UPDATE public.omie_pv_conferencia c
     SET aplicado_em = now(), valor_baixado = v_valor, adiado_motivo = NULL, atualizado_em = now(),
         prova = jsonb_build_object('consultas', p_log_ids, 'primeira_ausencia', c.primeira_ausencia_afirmada_em,
                                    'ultima_ausencia', c.ultima_ausencia_afirmada_em, 'linhas_ocultadas', v_n_lin,
                                    'linhas', to_jsonb(v_ids), 'reservas_liberadas', to_jsonb(v_res2), 'valor', v_valor)
   WHERE c.account = p_account AND c.omie_pedido_id = p_pid;
  RETURN jsonb_build_object('efeito', 'baixa', 'linhas', v_n_lin, 'reservas_liberadas', v_n_res, 'valor', v_valor);
END;
$$;

-- ── 9. registro do resultado de UMA consulta (idempotente pelo log_id) ────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.omie_pv_consulta_registrar(p_log_id bigint, p_resultado text, p_detalhe jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_l       public.omie_pv_consulta_log%ROWTYPE;
  v_c       public.omie_pv_conferencia%ROWTYPE;
  v_res     text := p_resultado;
  v_t       timestamptz;
  v_pres    timestamptz;
  v_efeito  jsonb;
  v_logs    bigint[];
BEGIN
  IF p_resultado IS NULL OR p_resultado NOT IN ('existe', 'ausente', 'indeterminado', 'bloqueado', 'nao_enviada') THEN
    RAISE EXCEPTION 'omie_pv_consulta_registrar: resultado inválido (%)', p_resultado USING ERRCODE = '22023';
  END IF;
  SELECT * INTO v_l FROM public.omie_pv_consulta_log l WHERE l.id = p_log_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'omie_pv_consulta_registrar: vez % não existe', p_log_id USING ERRCODE = '22023';
  END IF;
  IF v_l.registrada_em IS NOT NULL THEN
    RETURN jsonb_build_object('efeito', 'ja_registrada', 'resultado', v_l.resultado);
  END IF;
  -- Evidência vencida (a vez foi concedida há mais de 10 min): não decide nada.
  IF now() - v_l.reservada_em > interval '10 minutes' AND v_res IN ('existe', 'ausente') THEN
    v_res := 'indeterminado';
    p_detalhe := jsonb_build_object('vencida', true, 'original', p_resultado, 'detalhe', p_detalhe);
  END IF;

  SELECT * INTO v_c FROM public.omie_pv_conferencia c
   WHERE c.account = v_l.account AND c.omie_pedido_id = v_l.omie_pedido_id FOR UPDATE;
  v_efeito := jsonb_build_object('efeito', 'registrada');

  IF FOUND AND v_res = 'existe' THEN
    PERFORM private.omie_pv_marcar_presenca(v_l.account, ARRAY[v_l.omie_pedido_id]);
    UPDATE public.omie_pv_conferencia c SET ultimo_resultado = 'existe'
     WHERE c.account = v_l.account AND c.omie_pedido_id = v_l.omie_pedido_id;
    v_efeito := jsonb_build_object('efeito', 'presenca');
  ELSIF FOUND AND v_res = 'ausente' AND v_c.aplicado_em IS NULL AND v_c.contradicao IS NULL THEN
    v_t := v_l.reservada_em;  -- instante da ausência: o INÍCIO da consulta (o mais cedo possível — conservador)
    SELECT GREATEST(v_c.ultima_presenca_em, max(so.omie_reconciliado_em)) INTO v_pres
      FROM public.sales_orders so WHERE so.account = v_l.account AND so.omie_pedido_id = v_l.omie_pedido_id;
    IF v_pres IS NOT NULL AND v_pres >= v_t THEN
      -- Presença observada DEPOIS do início desta consulta: a ausência chegou fora de ordem — não conta.
      UPDATE public.omie_pv_conferencia c SET ultimo_resultado = 'ausente', atualizado_em = now()
       WHERE c.account = v_l.account AND c.omie_pedido_id = v_l.omie_pedido_id;
      v_efeito := jsonb_build_object('efeito', 'ausencia_fora_de_ordem');
    ELSIF v_c.ausencias_afirmadas = 0 OR (v_pres IS NOT NULL AND v_pres >= v_c.primeira_ausencia_afirmada_em) THEN
      UPDATE public.omie_pv_conferencia c
         SET ausencias_afirmadas = 1, primeira_ausencia_afirmada_em = v_t, ultima_ausencia_afirmada_em = v_t,
             ultima_ausencia_registrada_em = now(), primeira_ausencia_log_id = v_l.id,
             suspeito_desde = CASE WHEN c.resolvido_em IS NULL THEN COALESCE(c.suspeito_desde, v_t) ELSE v_t END,
             resolvido_em = NULL, ultimo_resultado = 'ausente', atualizado_em = now()
       WHERE c.account = v_l.account AND c.omie_pedido_id = v_l.omie_pedido_id;
      v_efeito := jsonb_build_object('efeito', 'ausencia', 'sequencia', 1);
    ELSIF v_t < v_c.ultima_ausencia_registrada_em + interval '1 hour' THEN
      -- A 2ª tem de ter SIDO INICIADA ≥ 1h depois da RESPOSTA da anterior (Codex rodada 2, P0-2).
      UPDATE public.omie_pv_conferencia c SET ultimo_resultado = 'ausente', atualizado_em = now()
       WHERE c.account = v_l.account AND c.omie_pedido_id = v_l.omie_pedido_id;
      v_efeito := jsonb_build_object('efeito', 'ausencia_cedo_demais');
    ELSE
      UPDATE public.omie_pv_conferencia c
         SET ausencias_afirmadas = c.ausencias_afirmadas + 1, ultima_ausencia_afirmada_em = v_t,
             ultima_ausencia_registrada_em = now(), ultimo_resultado = 'ausente', atualizado_em = now()
       WHERE c.account = v_l.account AND c.omie_pedido_id = v_l.omie_pedido_id
      RETURNING * INTO v_c;
      v_efeito := jsonb_build_object('efeito', 'ausencia', 'sequencia', v_c.ausencias_afirmadas);
      IF v_c.ausencias_afirmadas >= 2 THEN
        SELECT array_agg(l.id ORDER BY l.id) INTO v_logs FROM public.omie_pv_consulta_log l
         WHERE l.account = v_l.account AND l.omie_pedido_id = v_l.omie_pedido_id AND l.resultado = 'ausente'
           AND l.id >= v_c.primeira_ausencia_log_id;
        v_logs := array_append(COALESCE(v_logs, '{}'::bigint[]), v_l.id);
        v_efeito := private.omie_pv_aplicar_baixa(v_l.account, v_l.omie_pedido_id, v_logs);
      END IF;
    END IF;
  ELSIF FOUND THEN
    UPDATE public.omie_pv_conferencia c SET ultimo_resultado = v_res, atualizado_em = now()
     WHERE c.account = v_l.account AND c.omie_pedido_id = v_l.omie_pedido_id;
  END IF;

  UPDATE public.omie_pv_consulta_log l
     SET resultado = v_res, detalhe = p_detalhe, efeito = v_efeito->>'efeito', registrada_em = now()
   WHERE l.id = p_log_id;
  RETURN v_efeito || jsonb_build_object('resultado', v_res, 'omie_pedido_id', v_l.omie_pedido_id);
END;
$$;

-- ── 10. durabilidade da baixa em sales_orders ─────────────────────────────────────────────────────────────────────
-- Nome ordena DEPOIS de trg_sales_orders_gemeo_* (o BEFORE INSERT da importada já tem o lock do gêmeo, que a baixa
-- também toma: uma importação tardia espera a baixa e nasce oculta). Rollback do front (`deleted_at: null`) vira no-op.
-- PID ATRIBUÍDO depois a uma linha (write-back tardio do envio — Codex rodada 2, P0-4) não é escondido em silêncio:
-- vira contradição para revisão (o pedido pode ser venda real).
CREATE OR REPLACE FUNCTION public.sales_orders_pv_excluido_omie_duravel()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.omie_pv_conferencia c
                  WHERE c.account = NEW.account AND c.omie_pedido_id = NEW.omie_pedido_id AND c.aplicado_em IS NOT NULL) THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'INSERT' THEN
    NEW.deleted_at := now();
  ELSIF OLD.omie_pedido_id IS DISTINCT FROM NEW.omie_pedido_id OR OLD.account IS DISTINCT FROM NEW.account THEN
    UPDATE public.omie_pv_conferencia c
       SET contradicao = COALESCE(c.contradicao, 'pid_atribuido_apos_baixa'), contradicao_em = COALESCE(c.contradicao_em, now()),
           atualizado_em = now()
     WHERE c.account = NEW.account AND c.omie_pedido_id = NEW.omie_pedido_id;
  ELSE
    NEW.deleted_at := COALESCE(OLD.deleted_at, now());
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS trg_sales_orders_pv_excluido_omie ON public.sales_orders;
CREATE TRIGGER trg_sales_orders_pv_excluido_omie
  BEFORE INSERT OR UPDATE OF deleted_at, omie_pedido_id, account ON public.sales_orders
  FOR EACH ROW WHEN (NEW.deleted_at IS NULL AND NEW.omie_pedido_id IS NOT NULL)
  EXECUTE FUNCTION public.sales_orders_pv_excluido_omie_duravel();

-- ── 11. os 11 PVs já limpos à mão ganham a mesma durabilidade (Codex rodada 2, P1) ───────────────────────────────
-- Só se TODAS as linhas do PV estão ocultas (o estado que a limpeza deixou); prova = a origem real.
INSERT INTO public.omie_pv_conferencia (account, omie_pedido_id, aplicado_em, valor_baixado, prova, status_local)
SELECT 'oben', h.pid, min(so.deleted_at), NULL,
       jsonb_build_object('origem_historica', h.origem), string_agg(DISTINCT so.status, ',' ORDER BY so.status)
  FROM (VALUES (12215613527::bigint, 'limpeza manual PR #4082 (PV 13693)'),
               (12049288140, 'limpeza manual recibo #1295'), (12121835342, 'limpeza manual recibo #1295'),
               (12121839465, 'limpeza manual recibo #1295'), (12122021156, 'limpeza manual recibo #1295'),
               (12136268451, 'limpeza manual recibo #1295'), (12156020937, 'limpeza manual recibo #1295'),
               (12158135460, 'limpeza manual recibo #1295'), (12169921125, 'limpeza manual recibo #1295'),
               (12172563575, 'limpeza manual recibo #1295'), (12172847394, 'limpeza manual recibo #1295')) h(pid, origem)
  JOIN public.sales_orders so ON so.account = 'oben' AND so.omie_pedido_id = h.pid
 GROUP BY h.pid, h.origem
HAVING bool_and(so.deleted_at IS NOT NULL)
ON CONFLICT (account, omie_pedido_id) DO NOTHING;

-- ── 12. ACL: RPCs só service_role; helpers privados de ninguém ────────────────────────────────────────────────────
REVOKE ALL ON FUNCTION public.omie_pv_execucao_iniciar(text, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.omie_pv_listar_vez(bigint) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.omie_pv_execucao_encerrar(bigint, jsonb) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.omie_pv_presenca_registrar(bigint, bigint[]) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.omie_pv_triagem_janelas(text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.omie_pv_triagem_registrar(bigint, date, date, text, bigint[]) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.omie_pv_proxima_consulta(bigint) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.omie_pv_consulta_registrar(bigint, text, jsonb) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.sales_orders_pv_excluido_omie_duravel() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION private.omie_pv_execucao_viva(bigint) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION private.omie_pv_marcar_presenca(text, bigint[]) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION private.omie_pv_banco_na_janela(text, date, date) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION private.omie_pv_aplicar_baixa(text, bigint, bigint[]) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.omie_pv_execucao_iniciar(text, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.omie_pv_listar_vez(bigint) TO service_role;
GRANT EXECUTE ON FUNCTION public.omie_pv_execucao_encerrar(bigint, jsonb) TO service_role;
GRANT EXECUTE ON FUNCTION public.omie_pv_presenca_registrar(bigint, bigint[]) TO service_role;
GRANT EXECUTE ON FUNCTION public.omie_pv_triagem_janelas(text) TO service_role;
GRANT EXECUTE ON FUNCTION public.omie_pv_triagem_registrar(bigint, date, date, text, bigint[]) TO service_role;
GRANT EXECUTE ON FUNCTION public.omie_pv_proxima_consulta(bigint) TO service_role;
GRANT EXECUTE ON FUNCTION public.omie_pv_consulta_registrar(bigint, text, jsonb) TO service_role;

-- ── 13. cron de hora em hora (net.http_post com timeout explícito; minuto 17 = fora do pico dos outros crons) ─────
SELECT cron.schedule('omie-pv-exclusao-reconciliar', '17 * * * *', $cron$
  SELECT net.http_post(url:='https://fzvklzpomgnyikkfkzai.supabase.co/functions/v1/omie-pv-exclusao-reconciliar',
    headers:=jsonb_build_object('Content-Type','application/json','x-cron-secret',
      (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name='CRON_SECRET')),
    body:='{}'::jsonb, timeout_milliseconds:=150000);
$cron$);

-- ── 14. pós-condição ──────────────────────────────────────────────────────────────────────────────────────────────
DO $post$
DECLARE
  f text;
  t text;
  v_def text := pg_get_constraintdef((SELECT oid FROM pg_constraint WHERE conname = 'atp_decisoes_decisao_check'
                                       AND conrelid = 'public.atp_decisoes'::regclass));
BEGIN
  IF v_def IS NULL OR v_def NOT LIKE '%liberado_por_exclusao_omie%' OR v_def NOT LIKE '%liberacao_forcada%'
     OR v_def NOT LIKE '%reservado%' OR v_def NOT LIKE '%faturamento_observado%' THEN
    RAISE EXCEPTION 'A1 FALHOU: CHECK de atp_decisoes sem o valor novo (ou perdeu um antigo) — a baixa não grava trilha';
  END IF;
  FOREACH t IN ARRAY ARRAY['omie_pv_conferencia', 'omie_pv_identidade', 'omie_pv_execucao', 'omie_pv_triagem_cursor',
                           'omie_pv_triagem_log', 'omie_pv_consulta_log', 'omie_pv_baixa_reserva'] LOOP
    IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = ('public.' || t)::regclass) THEN
      RAISE EXCEPTION 'A2 FALHOU: % sem RLS', t;
    END IF;
    IF has_table_privilege('anon', 'public.' || t, 'SELECT')
       OR has_table_privilege('authenticated', 'public.' || t, 'INSERT')
       OR has_table_privilege('authenticated', 'public.' || t, 'UPDATE')
       OR has_table_privilege('authenticated', 'public.' || t, 'DELETE')
       OR has_table_privilege('service_role', 'public.' || t, 'INSERT')
       OR has_table_privilege('service_role', 'public.' || t, 'UPDATE') THEN
      RAISE EXCEPTION 'A3 FALHOU: % legível por anon ou gravável fora das RPCs', t;
    END IF;
  END LOOP;
  IF has_table_privilege('authenticated', 'public.omie_pv_identidade', 'SELECT') THEN
    RAISE EXCEPTION 'A3b FALHOU: omie_pv_identidade legível por authenticated';
  END IF;
  FOREACH f IN ARRAY ARRAY['public.omie_pv_execucao_iniciar(text,text)', 'public.omie_pv_listar_vez(bigint)',
                           'public.omie_pv_execucao_encerrar(bigint,jsonb)', 'public.omie_pv_presenca_registrar(bigint,bigint[])',
                           'public.omie_pv_triagem_janelas(text)', 'public.omie_pv_triagem_registrar(bigint,date,date,text,bigint[])',
                           'public.omie_pv_proxima_consulta(bigint)', 'public.omie_pv_consulta_registrar(bigint,text,jsonb)'] LOOP
    IF has_function_privilege('anon', f, 'EXECUTE') OR has_function_privilege('authenticated', f, 'EXECUTE')
       OR has_function_privilege('public', f, 'EXECUTE') THEN
      RAISE EXCEPTION 'A4 FALHOU: % executável por anon/authenticated/PUBLIC', f;
    END IF;
    IF NOT has_function_privilege('service_role', f, 'EXECUTE') THEN
      RAISE EXCEPTION 'A5 FALHOU: % sem EXECUTE para service_role — a edge não roda', f;
    END IF;
  END LOOP;
  FOREACH f IN ARRAY ARRAY['private.omie_pv_execucao_viva(bigint)', 'private.omie_pv_marcar_presenca(text,bigint[])',
                           'private.omie_pv_banco_na_janela(text,date,date)', 'private.omie_pv_aplicar_baixa(text,bigint,bigint[])',
                           'public.sales_orders_pv_excluido_omie_duravel()'] LOOP
    IF has_function_privilege('authenticated', f, 'EXECUTE') OR has_function_privilege('anon', f, 'EXECUTE')
       OR has_function_privilege('public', f, 'EXECUTE')
       OR (f LIKE 'private.%' AND has_function_privilege('service_role', f, 'EXECUTE')) THEN
      RAISE EXCEPTION 'A6 FALHOU: helper % executável de fora', f;
    END IF;
  END LOOP;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_sales_orders_pv_excluido_omie'
                  AND tgrelid = 'public.sales_orders'::regclass AND tgenabled <> 'D') THEN
    RAISE EXCEPTION 'A7 FALHOU: trigger de durabilidade ausente/desligado — o rollback do front ressuscita PV baixado';
  END IF;
  IF (SELECT count(*) FROM public.omie_pv_conferencia WHERE prova ? 'origem_historica') <> 11 THEN
    RAISE EXCEPTION 'A8 FALHOU: os 11 PVs limpos à mão não estão no ledger como aplicados (% de 11)',
      (SELECT count(*) FROM public.omie_pv_conferencia WHERE prova ? 'origem_historica');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'omie-pv-exclusao-reconciliar' AND active
                  AND command LIKE '%timeout_milliseconds:=150000%' AND command LIKE '%x-cron-secret%'
                  AND schedule = '17 * * * *' AND username = 'postgres') THEN
    RAISE EXCEPTION 'A9 FALHOU: cron omie-pv-exclusao-reconciliar ausente, inativo, sem timeout explícito ou com dono errado';
  END IF;
  RAISE NOTICE 'omie_pv_exclusao_reconciliar: CHECK + 7 tabelas com RLS + 8 RPCs só service_role + trigger + 11 históricos + cron OK';
END
$post$;
