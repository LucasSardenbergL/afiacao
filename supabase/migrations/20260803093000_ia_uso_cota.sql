-- ============================================================================
-- Cota de IA por usuário — throttle persistente nas edges que chamam a Anthropic
--
-- Achado P1 do challenge /codex sobre a fase 4 da migração do gateway Lovable →
-- Anthropic (#1640). PRÉ-EXISTENTE, não regressão: `identify-tool` e
-- `analyze-services` sempre exigiram só JWT válido — qualquer usuário
-- autenticado, inclusive `customer` — e nunca tiveram limite de consumo.
--
-- Ficou mais caro agora que o orçamento é da Anthropic e os limites dela são
-- ORGANIZACIONAIS, não por usuário da aplicação: um cliente repetindo chamadas
-- com imagem de até 8 MB (identify-tool) ou 100 ferramentas (analyze-services)
-- até bater 429/402 derruba a IA de TODOS os usuários e de TODAS as edges.
--
-- O gate "customer pode usar" está CORRETO para o produto (identificação por
-- foto e pedido falado são features do cliente). O que faltava era a cota.
--
-- SUPERFÍCIE, medida em prod via psql-ro em 2026-07-31:
--   5.664 contas com role 'customer' … e 3 usuários que já logaram alguma vez.
--   2 clientes com ferramenta cadastrada (média 2, p95 2).
-- Ou seja: blindagem ANTES da abertura. Não há uso legítimo para quebrar, e
-- também não há histórico para calibrar — os números saem de uso plausível de
-- balcão, não de percentil observado.
--
-- Não havia precedente no repo: os hits de "rate limit" são backoff da API do
-- OMIE (_shared/omie-paginacao.ts), não quota de usuário. Em prod, as únicas
-- tabelas que casam cota|quota|limit|rate|uso|consum são prime_beneficio_uso
-- (benefício comercial do Prime) e fin_custo_rateio — nenhuma reaproveitável.
--
-- ── Por que LOG DE EVENTO e não bucket agregado por janela ───────────────────
--
-- Bucket (uma linha por usuário/função/hora, contador incrementado) é mais
-- barato e menor, mas a janela vira TUMBLING: 20 chamadas às 10:59 mais 20 às
-- 11:00 são 40 em dois minutos, todas dentro de um limite nominal de 20/hora.
-- O log de evento dá janela DESLIZANTE de verdade e, de brinde, responde "quem
-- gastou" quando o orçamento apertar. O volume é uso humano de balcão — a
-- purga de 7 dias mantém a tabela pequena.
--
-- ── Por que o advisory lock (o núcleo da correção) ───────────────────────────
--
-- Sem serialização, duas requisições simultâneas do mesmo usuário leem o MESMO
-- contador e AMBAS passam. A quota vazaria exatamente sob o padrão de uso que
-- ela existe para conter: repetição rápida. `pg_advisory_xact_lock` por
-- (usuário, função) fecha isso sem serializar usuários distintos; o lock cai no
-- COMMIT/ROLLBACK, então não há vazamento de lock em erro.
-- ============================================================================

-- ── 1) Eventos de consumo ───────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.ia_uso_evento (
  id        bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id   uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  funcao    text NOT NULL,
  criado_em timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ia_uso_evento_funcao_nao_vazia CHECK (btrim(funcao) <> '')
);

-- Serve a contagem por janela: igualdade em (user_id, funcao) e range/ordenação
-- em criado_em.
CREATE INDEX IF NOT EXISTS ia_uso_evento_janela_idx
  ON public.ia_uso_evento (user_id, funcao, criado_em DESC);

-- ── 2) Limites, configuráveis sem redeploy ──────────────────────────────────
--
-- Deploy de edge no Lovable é MANUAL (chat, verbatim). Número hardcoded na edge
-- transformaria "afrouxar um limite apertado demais" num evento de deploy no
-- meio do expediente. Aqui é um UPDATE no SQL Editor.
CREATE TABLE IF NOT EXISTS public.ia_uso_limite (
  funcao        text PRIMARY KEY,
  limite_hora   integer NOT NULL,
  limite_dia    integer NOT NULL,
  atualizado_em timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ia_uso_limite_funcao_nao_vazia CHECK (btrim(funcao) <> ''),
  CONSTRAINT ia_uso_limite_positivos CHECK (limite_hora > 0 AND limite_dia >= limite_hora)
);

-- ON CONFLICT DO NOTHING de propósito: re-colar a migration NÃO pode desfazer
-- um ajuste que o founder tenha feito à mão. O seed é piso inicial, não verdade
-- perpétua.
--
-- Custo ≈ US$ 0,03–0,04 por chamada em Sonnet. Teto por usuário/dia:
--   identify-tool    60 × $0,03 ≈ $1,80   (p95 real: 2 ferramentas/cliente)
--   analyze-services 50 × $0,04 ≈ $2,00   (~15/dia já é uso pesado de verdade)
--   copilot-analyze  2.500 × $0,03 ≈ $75  (ver nota abaixo)
--
-- copilot-analyze é STAFF-ONLY e dispara a cada 8s enquanto a transcrição muda
-- (ANALYSIS_INTERVAL_MS em useCopilotEngine) ⇒ ~450 chamadas por HORA de ligação
-- real. O risco ali não é abuso, é LOOP ACIDENTAL: aba esquecida aberta a noite
-- toda dá 10.800 chamadas em 24h. O teto folgado não toca ligação real e corta
-- o loop pela metade do dia.
INSERT INTO public.ia_uso_limite (funcao, limite_hora, limite_dia) VALUES
  ('identify-tool',     20,   60),
  ('analyze-services',  20,   50),
  ('copilot-analyze',  600, 2500)
ON CONFLICT (funcao) DO NOTHING;

-- ── 3) Autorização ──────────────────────────────────────────────────────────
--
-- RLS habilitada e SEM POLICY NENHUMA = nega tudo para anon/authenticated. Só a
-- RPC (SECURITY DEFINER, roda como owner) toca as tabelas.
--
-- FORCE ROW LEVEL SECURITY fica FORA de propósito: com FORCE a RLS valeria
-- também para o owner e a própria RPC seria barrada no INSERT.
--
-- REVOKE nominal porque `REVOKE FROM PUBLIC` NÃO tira anon/authenticated — eles
-- têm grant explícito no Supabase (CLAUDE.md / docs/agent/database.md).
ALTER TABLE public.ia_uso_evento ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ia_uso_limite ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.ia_uso_evento FROM PUBLIC;
REVOKE ALL ON TABLE public.ia_uso_limite FROM PUBLIC;
REVOKE ALL ON TABLE public.ia_uso_evento FROM anon, authenticated;
REVOKE ALL ON TABLE public.ia_uso_limite FROM anon, authenticated;

-- ── 4) Consumo atômico ──────────────────────────────────────────────────────
--
-- DECIDE E REGISTRA na mesma transação. Separar em "consultar" + "registrar"
-- reabriria a corrida que o lock fecha.
CREATE OR REPLACE FUNCTION public.ia_consumir_cota(
  p_user_id uuid,
  p_funcao  text
)
RETURNS TABLE (
  permitido          boolean,
  motivo             text,
  usado_hora         integer,
  limite_hora        integer,
  usado_dia          integer,
  limite_dia         integer,
  libera_em_segundos integer
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_limite_hora integer;
  v_limite_dia  integer;
  v_usado_hora  integer;
  v_usado_dia   integer;
  v_libera      integer;
BEGIN
  IF p_user_id IS NULL OR p_funcao IS NULL OR btrim(p_funcao) = '' THEN
    RAISE EXCEPTION 'ia_consumir_cota: p_user_id e p_funcao são obrigatórios'
      USING ERRCODE = '22023';
  END IF;

  -- Serializa por (usuário, função). Cai sozinho no fim da transação.
  PERFORM pg_advisory_xact_lock(hashtextextended(p_user_id::text || ':' || p_funcao, 0));

  SELECT l.limite_hora, l.limite_dia
    INTO v_limite_hora, v_limite_dia
    FROM public.ia_uso_limite l
   WHERE l.funcao = p_funcao;

  -- FAIL-CLOSED: função sem limite configurado não gasta orçamento. Edge nova
  -- que esqueça o seed é negada com motivo próprio, em vez de ganhar acesso
  -- irrestrito por omissão.
  IF NOT FOUND THEN
    RETURN QUERY SELECT false, 'sem_limite'::text, 0, 0, 0, 0, 0;
    RETURN;
  END IF;

  -- Uma varredura só resolve as duas janelas: o filtro externo de 24h delimita,
  -- o FILTER interno recorta a hora.
  SELECT
      count(*) FILTER (WHERE e.criado_em > now() - interval '1 hour')::integer,
      count(*)::integer
    INTO v_usado_hora, v_usado_dia
    FROM public.ia_uso_evento e
   WHERE e.user_id = p_user_id
     AND e.funcao  = p_funcao
     AND e.criado_em > now() - interval '24 hours';

  IF v_usado_hora >= v_limite_hora THEN
    -- Com janela deslizante, a vaga abre quando a `limite`-ésima chamada mais
    -- recente sai da janela: as mais recentes que ela são limite-1, e todas as
    -- mais antigas já saíram (criado_em é monotônico com a posição). Vale
    -- inclusive se o limite foi REDUZIDO a quente e usado > limite.
    SELECT GREATEST(1, ceil(extract(epoch FROM (x.criado_em + interval '1 hour' - now()))))::integer
      INTO v_libera
      FROM (
        SELECT e.criado_em
          FROM public.ia_uso_evento e
         WHERE e.user_id = p_user_id
           AND e.funcao  = p_funcao
           AND e.criado_em > now() - interval '1 hour'
         ORDER BY e.criado_em DESC
        OFFSET (v_limite_hora - 1) LIMIT 1
      ) x;

    RETURN QUERY SELECT false, 'hora'::text, v_usado_hora, v_limite_hora,
                        v_usado_dia, v_limite_dia, COALESCE(v_libera, 1);
    RETURN;
  END IF;

  IF v_usado_dia >= v_limite_dia THEN
    SELECT GREATEST(1, ceil(extract(epoch FROM (x.criado_em + interval '24 hours' - now()))))::integer
      INTO v_libera
      FROM (
        SELECT e.criado_em
          FROM public.ia_uso_evento e
         WHERE e.user_id = p_user_id
           AND e.funcao  = p_funcao
           AND e.criado_em > now() - interval '24 hours'
         ORDER BY e.criado_em DESC
        OFFSET (v_limite_dia - 1) LIMIT 1
      ) x;

    RETURN QUERY SELECT false, 'dia'::text, v_usado_hora, v_limite_hora,
                        v_usado_dia, v_limite_dia, COALESCE(v_libera, 1);
    RETURN;
  END IF;

  INSERT INTO public.ia_uso_evento (user_id, funcao) VALUES (p_user_id, p_funcao);

  -- Contadores JÁ incluem esta chamada: é o que a edge precisa para dizer
  -- "você usou 18 de 20" sem uma segunda consulta.
  RETURN QUERY SELECT true, 'ok'::text, v_usado_hora + 1, v_limite_hora,
                      v_usado_dia + 1, v_limite_dia, 0;
END;
$$;

-- Só service_role executa. Se `authenticated` pudesse, um cliente chamaria a
-- RPC com o user_id de OUTRO e queimaria a cota alheia — a função aceita o
-- user_id como parâmetro justamente porque quem a chama é a edge, que já
-- autenticou o JWT e sabe de quem é.
REVOKE ALL ON FUNCTION public.ia_consumir_cota(uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.ia_consumir_cota(uuid, text) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.ia_consumir_cota(uuid, text) TO service_role;

COMMENT ON FUNCTION public.ia_consumir_cota(uuid, text) IS
  'Cota de IA por usuário: decide e registra o consumo numa transação só. '
  'Fail-closed — função sem linha em ia_uso_limite é negada com motivo sem_limite. '
  'Chamada apenas pelas edges (service_role).';

-- ── 5) Purga ────────────────────────────────────────────────────────────────
--
-- 7 dias: a janela mais longa da cota é 24h, o resto é margem para auditoria
-- ("quem gastou nesta semana"). DELETE puro, sem net.http_post — o alerta de
-- timeout_milliseconds do CLAUDE.md não se aplica aqui.
--
-- Idempotente: unschedule antes de reagendar (cron.schedule já é upsert por
-- nome; o unschedule limpa estado zumbi). Re-colar = no-op.
DO $do$
BEGIN
  PERFORM cron.unschedule('ia-uso-evento-purga');
EXCEPTION WHEN OTHERS THEN NULL;  -- idempotente: ignora se o job ainda não existe
END
$do$;

SELECT cron.schedule(
  'ia-uso-evento-purga',
  '23 4 * * *',
  $job$ DELETE FROM public.ia_uso_evento WHERE criado_em < now() - interval '7 days' $job$
);
