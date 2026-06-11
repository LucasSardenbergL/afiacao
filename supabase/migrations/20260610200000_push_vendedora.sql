-- ============================================================
-- Push da vendedora (Web Push) — assinaturas + 3 produtores
-- Objetivo: avisar a vendedora FORA do app (cliente respondeu no
-- WhatsApp, tarefa nova, SLA estourando). Best-effort por design:
-- nenhum produtor pode quebrar o caminho que o dispara.
-- Spec: docs/superpowers/specs/2026-06-10-push-vendedora-design.md
-- Consome a edge `enviar-push` (deploy via chat do Lovable) com
-- header x-cron-secret (Vault) + timeout_milliseconds explícito
-- (lição §5: o default de 5s do pg_net mata silencioso).
-- ============================================================

-- ─────────────────────────────────────────────────────────────
-- 1) Tabela de assinaturas (1 linha por device/navegador)
-- ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.push_subscriptions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  endpoint text NOT NULL UNIQUE,
  subscription jsonb NOT NULL,
  user_agent text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_push_subscriptions_user
  ON public.push_subscriptions(user_id);

ALTER TABLE public.push_subscriptions ENABLE ROW LEVEL SECURITY;

-- Own-only: cada um gerencia SÓ as próprias assinaturas (endpoint é
-- segredo de entrega — vazar = qualquer um com a VAPID privada empurra push).
DROP POLICY IF EXISTS "push_subscriptions_own" ON public.push_subscriptions;
CREATE POLICY "push_subscriptions_own"
  ON public.push_subscriptions
  FOR ALL TO authenticated
  USING (user_id = (SELECT auth.uid()))
  WITH CHECK (user_id = (SELECT auth.uid()));

-- Edge `enviar-push` lê/limpa com service_role (bypassa RLS no Supabase;
-- policy explícita por clareza/defesa em profundidade).
DROP POLICY IF EXISTS "push_subscriptions_service" ON public.push_subscriptions;
CREATE POLICY "push_subscriptions_service"
  ON public.push_subscriptions
  FOR ALL
  USING (auth.role() = 'service_role');

-- ─────────────────────────────────────────────────────────────
-- 1b) RPCs de escrita do device (SECURITY DEFINER de propósito):
--     o ENDPOINT pertence a QUEM ESTÁ LOGADO NO DEVICE AGORA. Em device
--     compartilhado (balcão), a vendedora B loga depois da A — o upsert
--     own-only de B falharia na RLS (linha é de A) e o push de A continuaria
--     chegando no device de B (vazamento de carteira, P1 da revisão
--     adversarial). O definer reatribui o endpoint pro auth.uid() atual.
-- ─────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.upsert_push_subscription(
  p_endpoint text,
  p_subscription jsonb,
  p_user_agent text DEFAULT NULL
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'apenas usuários autenticados';
  END IF;
  IF p_endpoint IS NULL OR length(trim(p_endpoint)) < 16 THEN
    RAISE EXCEPTION 'endpoint inválido';
  END IF;
  INSERT INTO public.push_subscriptions (user_id, endpoint, subscription, user_agent)
  VALUES (auth.uid(), p_endpoint, p_subscription, left(p_user_agent, 256))
  ON CONFLICT (endpoint) DO UPDATE
    SET user_id = auth.uid(),
        subscription = EXCLUDED.subscription,
        user_agent = EXCLUDED.user_agent;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.upsert_push_subscription(text, jsonb, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.upsert_push_subscription(text, jsonb, text) TO authenticated;

-- Limpeza no logout: o device é a autoridade sobre o próprio endpoint —
-- deletar por endpoint (sem filtro de user) é seguro e necessário quando
-- quem está deslogando não é mais o dono da linha.
CREATE OR REPLACE FUNCTION public.delete_push_subscription(p_endpoint text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'apenas usuários autenticados';
  END IF;
  DELETE FROM public.push_subscriptions WHERE endpoint = p_endpoint;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.delete_push_subscription(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.delete_push_subscription(text) TO authenticated;

-- ─────────────────────────────────────────────────────────────
-- 2) Helper interno: dispara a edge enviar-push via pg_net.
--    SECURITY DEFINER: triggers rodam no role da sessão (service_role
--    no webhook do 360dialog) que pode não ter grant no schema net/vault
--    — o definer (postgres) tem. REVOKE de todo mundo: só os triggers
--    e o tick (também definer) chamam.
-- ─────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public._push_enviar(
  p_user_ids uuid[],
  p_titulo text,
  p_corpo text,
  p_url text,
  p_tag text
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_secret text;
BEGIN
  IF p_user_ids IS NULL OR array_length(p_user_ids, 1) IS NULL THEN
    RETURN;
  END IF;

  SELECT decrypted_secret INTO v_secret
  FROM vault.decrypted_secrets WHERE name = 'CRON_SECRET' LIMIT 1;
  IF v_secret IS NULL THEN
    RAISE WARNING '[push] CRON_SECRET ausente no Vault — push não enviado';
    RETURN;
  END IF;

  -- pg_net é assíncrono (enfileira e retorna) — não segura o caller.
  PERFORM net.http_post(
    url := 'https://fzvklzpomgnyikkfkzai.supabase.co/functions/v1/enviar-push',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-cron-secret', v_secret
    ),
    body := jsonb_build_object(
      'user_ids', to_jsonb(p_user_ids),
      'titulo', p_titulo,
      'corpo', p_corpo,
      'url', p_url,
      'tag', p_tag
    ),
    timeout_milliseconds := 10000
  );
END;
$$;

REVOKE EXECUTE ON FUNCTION public._push_enviar(uuid[], text, text, text, text)
  FROM PUBLIC, anon, authenticated;

-- ─────────────────────────────────────────────────────────────
-- 3) Produtor: WhatsApp inbound → push pra dona da conversa
--    Throttle sem tabela nova: pula se já houve msg 'in' da MESMA
--    conversa nos últimos 10min (burst = 1 push; o tag agrupa no device).
--    Best-effort blindado: EXCEPTION → WARNING (NUNCA quebra o webhook).
-- ─────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.push_whatsapp_inbound()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_conv record;
  v_dona uuid;
  v_nome text;
BEGIN
  -- Opt-out (PARAR/SAIR/CANCELAR) não é "cliente respondeu" — o SLA também exclui.
  IF public.wa_is_stop_keyword(NEW.body) THEN
    RETURN NEW;
  END IF;

  -- Throttle 10min por conversa (id <> NEW.id: a própria linha já está visível no AFTER).
  IF EXISTS (
    SELECT 1 FROM public.whatsapp_messages m
    WHERE m.conversation_id = NEW.conversation_id
      AND m.direction = 'in'
      AND m.id <> NEW.id
      AND m.created_at > now() - interval '10 minutes'
  ) THEN
    RETURN NEW;
  END IF;

  SELECT c.customer_user_id, c.contact_name, c.phone_e164
    INTO v_conv
  FROM public.whatsapp_conversations c
  WHERE c.id = NEW.conversation_id;

  IF v_conv IS NULL OR v_conv.customer_user_id IS NULL THEN
    RETURN NEW; -- sem cliente vinculado → sem dona → sem push (founder tem o painel)
  END IF;

  v_dona := public.wa_owner_efetivo(v_conv.customer_user_id);
  IF v_dona IS NULL THEN
    RETURN NEW;
  END IF;

  v_nome := COALESCE(NULLIF(trim(v_conv.contact_name), ''), v_conv.phone_e164, 'Cliente');

  -- Corpo SEM o texto da mensagem (LGPD lock screen).
  PERFORM public._push_enviar(
    ARRAY[v_dona],
    'Nova mensagem no WhatsApp',
    v_nome || ' respondeu — toque para abrir a conversa',
    '/whatsapp',
    'wa-' || NEW.conversation_id::text
  );
  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING '[push] falha no push de whatsapp inbound (msg %): %', NEW.id, SQLERRM;
  RETURN NEW;
END;
$$;

-- sender_user_id IS NULL: inbound legítimo (webhook 360dialog) não tem sender
-- humano — barra staff inserindo 'in' falso só pra fazer o celular do colega
-- apitar (amplificação de privilégio, P2.5 da revisão adversarial).
DROP TRIGGER IF EXISTS trg_push_whatsapp_inbound ON public.whatsapp_messages;
CREATE TRIGGER trg_push_whatsapp_inbound
  AFTER INSERT ON public.whatsapp_messages
  FOR EACH ROW
  WHEN (NEW.direction = 'in' AND NEW.sender_user_id IS NULL)
  EXECUTE FUNCTION public.push_whatsapp_inbound();

-- ─────────────────────────────────────────────────────────────
-- 4) Produtor: tarefa nova → push pro responsável
--    Pula auto-atribuição (criou pra si = já está no app) e rajada
--    de criação em lote (throttle 2min por responsável = 1 push).
-- ─────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.push_tarefa_nova()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_cliente text;
BEGIN
  IF NEW.assigned_to = NEW.created_by THEN
    RETURN NEW;
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.tarefas t
    WHERE t.assigned_to = NEW.assigned_to
      AND t.id <> NEW.id
      AND t.created_at > now() - interval '2 minutes'
  ) THEN
    RETURN NEW;
  END IF;

  SELECT COALESCE(NULLIF(trim(p.razao_social), ''), p.name)
    INTO v_cliente
  FROM public.profiles p
  WHERE p.user_id = NEW.customer_user_id
  LIMIT 1;

  PERFORM public._push_enviar(
    ARRAY[NEW.assigned_to],
    'Nova tarefa pra você',
    initcap(NEW.categoria) || COALESCE(' — ' || v_cliente, ''),
    '/meu-dia',
    'tarefa-' || NEW.id::text
  );
  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING '[push] falha no push de tarefa nova (%): %', NEW.id, SQLERRM;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_push_tarefa_nova ON public.tarefas;
CREATE TRIGGER trg_push_tarefa_nova
  AFTER INSERT ON public.tarefas
  FOR EACH ROW
  EXECUTE FUNCTION public.push_tarefa_nova();

-- ─────────────────────────────────────────────────────────────
-- 5) Produtor: SLA estourado → push agregado por vendedora
--    Janela [limiar, limiar+20): com cron */15, cada conversa entra
--    ~1 tick; se entrar 2×, o tag 'sla' SUBSTITUI a notificação no
--    device (não duplica visível). 1 push por dona com a contagem.
--    REVOKE de anon/authenticated (lição do digest #587: senão
--    qualquer logado dispara/spamma).
-- ─────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.push_sla_tick()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_limiar int;
  v_agora_sp timestamp;
  v_ini time;
  v_fim time;
  v_dias int[];
  r record;
BEGIN
  -- Gate de EXPEDIENTE (mesma config da view): fora dele os minutos úteis
  -- CONGELAM → a conversa ficaria presa na janela e o cron 24/7 re-enviaria
  -- a noite/fim de semana inteiros (P2.1 da revisão adversarial — sexta
  -- 17h→segunda 7h30 seriam ~248 envios da mesma conversa).
  SELECT
    COALESCE((SELECT value::int  FROM public.company_config WHERE key='whatsapp_sla_atrasado_min'), 30),
    COALESCE((SELECT value::time FROM public.company_config WHERE key='whatsapp_sla_hora_inicio'), '07:30'),
    COALESCE((SELECT value::time FROM public.company_config WHERE key='whatsapp_sla_hora_fim'),    '17:30'),
    COALESCE((SELECT string_to_array(value, ',')::int[] FROM public.company_config WHERE key='whatsapp_sla_dias'),
             ARRAY[1,2,3,4,5])
    INTO v_limiar, v_ini, v_fim, v_dias;

  v_agora_sp := now() AT TIME ZONE 'America/Sao_Paulo';
  IF NOT (EXTRACT(isodow FROM v_agora_sp)::int = ANY(v_dias)
          AND v_agora_sp::time >= v_ini AND v_agora_sp::time < v_fim) THEN
    RETURN;
  END IF;

  FOR r IN
    SELECT s.owner_user_id,
           count(*) AS qtd,
           string_agg(COALESCE(NULLIF(trim(s.contact_name), ''), s.phone_e164), ', '
                      ORDER BY s.minutos_uteis_aguardando DESC) AS nomes
    FROM public.v_whatsapp_sla s
    WHERE s.nivel = 'vermelho'
      AND s.owner_user_id IS NOT NULL
      AND s.minutos_uteis_aguardando >= v_limiar
      AND s.minutos_uteis_aguardando <  v_limiar + 20
    GROUP BY s.owner_user_id
  LOOP
    -- Best-effort POR DONA: uma falha (pg_net off, etc.) não pode derrubar
    -- o tick das demais nem falhar o cron (P2.4 da revisão adversarial).
    BEGIN
      PERFORM public._push_enviar(
        ARRAY[r.owner_user_id],
        'Cliente aguardando resposta',
        CASE WHEN r.qtd = 1
          THEN left(r.nomes, 160) || ' está sem resposta há ' || v_limiar || '+ min'
          ELSE r.qtd || ' clientes sem resposta há ' || v_limiar || '+ min: ' || left(r.nomes, 140)
        END,
        '/whatsapp',
        'sla'
      );
    EXCEPTION WHEN OTHERS THEN
      RAISE WARNING '[push] falha no push de SLA pra dona %: %', r.owner_user_id, SQLERRM;
    END;
  END LOOP;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.push_sla_tick()
  FROM PUBLIC, anon, authenticated;

-- Cron SQL local (sem net.http_post aqui — o http vive dentro do _push_enviar).
SELECT cron.schedule(
  'push-sla-tick',
  '*/15 * * * *',
  $$ SELECT public.push_sla_tick(); $$
);

-- Validação (rodar após o Run):
-- SELECT 'PUSH VENDEDORA OK' AS status,
--   (SELECT count(*) FROM information_schema.tables  WHERE table_schema='public' AND table_name='push_subscriptions')                    AS tabela,
--   (SELECT count(*) FROM pg_policies WHERE schemaname='public' AND tablename='push_subscriptions')                                      AS policies_2,
--   (SELECT count(*) FROM pg_trigger WHERE tgname='trg_push_whatsapp_inbound')                                                           AS trg_whatsapp,
--   (SELECT count(*) FROM pg_trigger WHERE tgname='trg_push_tarefa_nova')                                                                AS trg_tarefa,
--   (SELECT count(*) FROM pg_proc WHERE proname IN ('_push_enviar','push_whatsapp_inbound','push_tarefa_nova','push_sla_tick','upsert_push_subscription','delete_push_subscription')) AS funcoes_6,
--   (SELECT count(*) FROM cron.job WHERE jobname='push-sla-tick')                                                                        AS cron_1;
