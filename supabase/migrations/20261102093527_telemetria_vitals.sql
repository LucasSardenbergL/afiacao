-- ============================================================
-- telemetria_vitals — web-vitals (RUM) pelo NOSSO banco, o 2º cano do `app.vitals`
--
-- Contexto: o lote 0 do plano v4 (#3507) mede LCP/INP/CLS/FCP/TTFB por rota e
-- manda `app.vitals` ao PostHog. Medido em 2026-11-02 (7 dias): o aparelho mais
-- usado (`1aedeba2…`, 103 de 155 boots) tem 103 linhas em `telemetria_probes` e
-- ZERO `telemetria.probe` no PostHog — o domínio está bloqueado nele. Só pelo
-- PostHog, a linha de base de velocidade sairia da MINORIA do uso. Esta tabela é
-- gravada pelo PostgREST (domínio do app, imune à lista), como o probe.
--
-- EXCEÇÃO AUTORIZADA à regra de máquina meta: sensor aprovado pelo founder em
-- 2026-11-01 (plano v4, PR #3502, item C0); o 2º cano aprovado em 2026-11-02.
--
-- Por que tabela DEDICADA e não o `analytics_ledger`: o ledger deduplica por
-- chave/titular/DIA — uma linha por dia não dá p75 de valores.
--
-- Cardinalidade: 1 linha por INSTÂNCIA de métrica (`metrica_id` da lib
-- web-vitals, único por carga de página). INP e CLS podem sair 2× na mesma carga
-- (a aba esconde, volta, piora): o cliente faz UPSERT e a linha fica com o
-- ÚLTIMO valor — a mesma regra do `argMax(valor, timestamp)` da query do PostHog.
--
-- Escritor único: o `iniciarVitals()` (`src/lib/analytics-vitals.ts`). Leitura é
-- por psql-ro; o SELECT próprio existe porque o UPSERT (ON CONFLICT DO UPDATE)
-- exige que a linha existente passe a policy de SELECT — provado em
-- `db/test-telemetria-vitals.sh`.
--
-- Rota é SEMPRE a canônica (`canonicalizarRota` — id/e-mail viram `:id`, sem
-- querystring); nenhuma coluna carrega id de negócio.
-- ============================================================

CREATE TABLE IF NOT EXISTS public.telemetria_vitals (
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  -- Id da instância da métrica (`v5-<ts>-<rand>`), gerado pela lib no aparelho.
  metrica_id text NOT NULL,
  metrica text NOT NULL,
  -- ms inteiros; CLS é adimensional (4 casas).
  valor numeric(12,4) NOT NULL,
  classificacao text NOT NULL,
  rota text NOT NULL,
  navegacao text NOT NULL,
  -- `effectiveType` (Chrome/Android); NULL onde o navegador não expõe.
  conexao text,
  -- O mesmo aparelho do `telemetria_probes.device_id` — é o eixo que separa o
  -- aparelho que o PostHog não vê. NULL se o localStorage não respondeu.
  device_id uuid,
  -- Adoção de build: a linha de base filtra por ele.
  build_id text,
  criado_em timestamptz NOT NULL DEFAULT now(),
  atualizado_em timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT telemetria_vitals_pkey PRIMARY KEY (user_id, metrica_id),
  CONSTRAINT telemetria_vitals_metrica_id_tamanho CHECK (length(metrica_id) BETWEEN 1 AND 100),
  CONSTRAINT telemetria_vitals_metrica_vocab CHECK (metrica IN ('lcp', 'inp', 'cls', 'fcp', 'ttfb')),
  CONSTRAINT telemetria_vitals_valor_nao_negativo CHECK (valor >= 0),
  CONSTRAINT telemetria_vitals_classificacao_vocab CHECK (classificacao IN ('bom', 'melhorar', 'ruim')),
  CONSTRAINT telemetria_vitals_navegacao_vocab CHECK (
    navegacao IN ('navegacao', 'recarga', 'voltar_avancar', 'bfcache', 'prerender', 'restauracao')
  ),
  CONSTRAINT telemetria_vitals_rota_tamanho CHECK (length(rota) BETWEEN 1 AND 200),
  CONSTRAINT telemetria_vitals_conexao_tamanho CHECK (conexao IS NULL OR length(conexao) <= 20),
  CONSTRAINT telemetria_vitals_build_id_tamanho CHECK (build_id IS NULL OR length(build_id) <= 100)
);

CREATE INDEX IF NOT EXISTS idx_telemetria_vitals_criado_em
  ON public.telemetria_vitals (criado_em DESC);

COMMENT ON TABLE public.telemetria_vitals IS
  'Web-vitals (RUM) por rota canônica — 2º cano do evento app.vitals (plano v4, lote 0). '
  'Finalidade: linha de base de velocidade dos lotes de app, inclusive do aparelho que '
  'bloqueia o PostHog. Retenção: 180 dias (diagnóstico de desempenho, não histórico de uso).';

-- O UPSERT reescreve a linha: `criado_em` é do 1º envio e não muda; `atualizado_em`
-- marca o último valor. Sem isto o cliente poderia mover `criado_em` para dentro da
-- janela de qualquer consulta.
CREATE OR REPLACE FUNCTION public.telemetria_vitals_carimbar()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $f$
BEGIN
  NEW.criado_em := OLD.criado_em;
  NEW.atualizado_em := now();
  RETURN NEW;
END
$f$;

DROP TRIGGER IF EXISTS trg_telemetria_vitals_carimbar ON public.telemetria_vitals;
CREATE TRIGGER trg_telemetria_vitals_carimbar
  BEFORE UPDATE ON public.telemetria_vitals
  FOR EACH ROW EXECUTE FUNCTION public.telemetria_vitals_carimbar();

-- RLS (obrigatória). O ALTER DEFAULT PRIVILEGES de public dá tudo a authenticated/anon:
-- a ÚNICA defesa desta tabela é a RLS.
ALTER TABLE public.telemetria_vitals ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "telemetria_vitals_user_insert" ON public.telemetria_vitals;
CREATE POLICY "telemetria_vitals_user_insert"
  ON public.telemetria_vitals
  FOR INSERT
  WITH CHECK (
    auth.uid() = user_id
    AND criado_em > now() - interval '10 minutes'
    AND criado_em <= now() + interval '1 minute'
  );

DROP POLICY IF EXISTS "telemetria_vitals_user_update" ON public.telemetria_vitals;
CREATE POLICY "telemetria_vitals_user_update"
  ON public.telemetria_vitals
  FOR UPDATE
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS "telemetria_vitals_user_read" ON public.telemetria_vitals;
CREATE POLICY "telemetria_vitals_user_read"
  ON public.telemetria_vitals
  FOR SELECT
  USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "telemetria_vitals_service_all" ON public.telemetria_vitals;
CREATE POLICY "telemetria_vitals_service_all"
  ON public.telemetria_vitals
  FOR ALL
  USING (auth.role() = 'service_role');

-- Postcondição: a tabela existe com RLS LIGADA, as 4 policies e o trigger.
DO $post$
DECLARE
  v_rls boolean;
  v_policies int;
BEGIN
  SELECT c.relrowsecurity INTO v_rls
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'public' AND c.relname = 'telemetria_vitals';
  IF v_rls IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'A1 FALHOU: public.telemetria_vitals ausente ou sem RLS — authenticated/anon escreveriam qualquer linha';
  END IF;

  SELECT count(*) INTO v_policies
    FROM pg_policies
   WHERE schemaname = 'public' AND tablename = 'telemetria_vitals'
     AND policyname IN ('telemetria_vitals_user_insert', 'telemetria_vitals_user_update',
                        'telemetria_vitals_user_read', 'telemetria_vitals_service_all');
  IF v_policies <> 4 THEN
    RAISE EXCEPTION 'A2 FALHOU: % de 4 policies em telemetria_vitals — o upsert do cliente quebra ou a tabela fica aberta', v_policies;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
     WHERE tgrelid = 'public.telemetria_vitals'::regclass
       AND tgname = 'trg_telemetria_vitals_carimbar' AND NOT tgisinternal
  ) THEN
    RAISE EXCEPTION 'A3 FALHOU: trigger trg_telemetria_vitals_carimbar ausente — o upsert pode mover criado_em';
  END IF;

  RAISE NOTICE 'telemetria_vitals OK: RLS ligada, 4 policies, trigger de carimbo';
END
$post$;
