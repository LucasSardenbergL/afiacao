-- ============================================================
-- telemetria_probes — torna a CENSURA de telemetria mensurável (par imune × censurável)
--
-- Contexto: `us.i.posthog.com` está em EasyPrivacy/uBlock (#1984). Cliente
-- bloqueado e cliente que não usou produzem o MESMO zero no PostHog. O gatilho
-- montado sobre `dashboard_visits` (#2010) era CEGO e o #2016 registrou por quê:
-- "linha sem evento" mede captura client-side ausente, não bloqueador — e
-- `dashboard_visits` NÃO TEM COLUNA DE APARELHO, então um evento do celular
-- "explica" uma visita bloqueada no desktop.
--
-- O desenho (ritual Codex, docs/agent/analytics.md §6): um `attempt_id` gerado no
-- boot AUTENTICADO, gravado aqui pelo PostgREST (domínio do app — imune à lista) e
-- emitido como propriedade de um evento PostHog. `attempt_id` sem par após atraso
-- fixo = tentativa que não atravessou. Dois sem par, em sessões DISTINTAS do MESMO
-- aparelho, tornam censura persistente a explicação plausível. Um só não conclui.
--
-- Por que tabela DEDICADA e não coluna em `dashboard_visits`:
--   1. MOMENTO — `dashboard_visits` só ganha linha ao SAIR do dashboard após ≥5min
--      (`MIN_SESSION_MS`); o probe roda no boot, em qualquer rota. Acoplar perderia
--      toda sessão curta — as do primeiro customer externo, as mais informativas.
--   2. ESCRITOR ÚNICO — `useRegistrarVisitaDashboard` é o único escritor daquela
--      tabela, por desenho. Um segundo escritor com outra semântica é a receita do
--      upsert destrutivo (CLAUDE.md, money-path).
--   3. CARDINALIDADE — 1 probe por boot × 1 visita por sessão-de-dashboard; a UNIQUE
--      (user_id, visited_at) de lá colidiria, e persona/session_minutes seriam NULL.
--   4. RETENÇÃO — probe é diagnóstico descartável; visita é histórico de uso.
--
-- ⚠️ Isto é tratamento de dado pessoal (fingerprint de aparelho por usuário).
-- Finalidade e prazo estão no COMMENT ON TABLE, de propósito: a §6 cobra
-- "finalidade escrita" do Session Replay e a mesma régua vale aqui.
-- ============================================================

CREATE TABLE IF NOT EXISTS public.telemetria_probes (
  -- Chave de JUNÇÃO com o PostHog. Text porque embute o aparelho por construção
  -- (`<device_id>.<random>`): quando viaja sozinho como propriedade do evento, o
  -- aparelho vai junto — sem depender de `identify()` (a sonda do #1984 não tinha).
  attempt_id text PRIMARY KEY,
  -- O eixo que faltava. Sem ele o pareamento é por USUÁRIO e um evento do celular
  -- "explica" uma tentativa bloqueada no desktop — a cegueira que motivou este trabalho.
  device_id uuid NOT NULL,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  criado_em timestamptz NOT NULL DEFAULT now(),
  -- Correlaciona censura com adoção de build (o assunto da §6) — de graça, no insert.
  build_id text,
  CONSTRAINT telemetria_probes_attempt_id_formato
    CHECK (length(attempt_id) BETWEEN 10 AND 128)
);

-- O eixo da reconciliação: "sessões distintas do MESMO aparelho".
CREATE INDEX IF NOT EXISTS idx_telemetria_probes_device_recente
  ON public.telemetria_probes (device_id, criado_em DESC);

-- A janela de carência ("probes com mais de N minutos") varre por tempo.
CREATE INDEX IF NOT EXISTS idx_telemetria_probes_criado_em
  ON public.telemetria_probes (criado_em DESC);

COMMENT ON TABLE public.telemetria_probes IS
  'Probe de censura de telemetria (#1984/#2016). Finalidade: distinguir "cliente '
  'bloqueou o PostHog" de "cliente não usou" — os dois produzem o mesmo zero. '
  'Retenção: 90 dias (diagnóstico, não histórico de uso). Sem retenção escrita, '
  'esta tabela vira coleta sem finalidade — que é o defeito que desligou o Session Replay.';

COMMENT ON COLUMN public.telemetria_probes.attempt_id IS
  'Formato `<device_id>.<uuid>`. Embute o aparelho para que a propriedade do evento '
  'PostHog carregue o eixo de aparelho sozinha.';

ALTER TABLE public.telemetria_probes ENABLE ROW LEVEL SECURITY;

-- User insere o próprio. O guard de janela em `criado_em` impede que um cliente
-- envie data futura/antiga e desloque a carência da reconciliação — o DEFAULT
-- `now()` passa sempre, então isto só morde payload adulterado.
DROP POLICY IF EXISTS "telemetria_probes_user_insert" ON public.telemetria_probes;
CREATE POLICY "telemetria_probes_user_insert"
  ON public.telemetria_probes
  FOR INSERT
  WITH CHECK (
    auth.uid() = user_id
    AND criado_em > now() - interval '10 minutes'
    AND criado_em <= now() + interval '1 minute'
  );

-- User lê o próprio.
DROP POLICY IF EXISTS "telemetria_probes_user_read" ON public.telemetria_probes;
CREATE POLICY "telemetria_probes_user_read"
  ON public.telemetria_probes
  FOR SELECT
  USING (auth.uid() = user_id);

-- Master lê todos.
DROP POLICY IF EXISTS "telemetria_probes_master_read" ON public.telemetria_probes;
CREATE POLICY "telemetria_probes_master_read"
  ON public.telemetria_probes
  FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM public.user_roles
      WHERE user_id = auth.uid() AND role = 'master'::public.app_role
    )
  );

-- Service role bypass (edge/cron — expurgo de retenção).
DROP POLICY IF EXISTS "telemetria_probes_service_all" ON public.telemetria_probes;
CREATE POLICY "telemetria_probes_service_all"
  ON public.telemetria_probes
  FOR ALL
  USING (auth.role() = 'service_role');

-- SEM policy de UPDATE/DELETE para o usuário: o probe é append-only de propósito.
-- Quem pode apagar a própria linha pode apagar a evidência de que foi censurado.
