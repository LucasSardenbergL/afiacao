-- ============================================================
-- seg_lote2_nvoip_optout_template — lote 2 do rescan do scanner Lovable Security (2026-11-14)
--
-- Três achados, conferidos na PROD via psql-ro antes de escrever:
--
-- (A) Tokens OAuth da Nvoip em company_config. A edge nvoip-calls guardava o access_token e o
--     refresh_token em company_config, e a policy company_config_staff_select deixa QUALQUER
--     employee ler a tabela inteira pelo PostgREST (anon/authenticated têm SELECT). Na PROD havia
--     as 3 linhas (nvoip_access_token, nvoip_refresh_token, nvoip_token_expires_at). O cache vai
--     para public.nvoip_oauth_cache, sem policy e sem GRANT para anon/authenticated (só
--     service_role). As linhas velhas saem, e uma CHECK impede que uma edge antiga as recrie.
--     O cache se regenera sozinho pela credencial do env (NVOIP_USER_TOKEN) no próximo uso.
--
-- (B) Opt-out do WhatsApp desfeito por staff. A policy wa_conv_staff_all dá ALL ao staff em
--     whatsapp_conversations, então um employee podia trocar opt_in_status de 'opt_out' para
--     'opt_in' — ou apagar a conversa (a próxima vira 'unknown'), ou mudar o phone_key dela (o
--     próximo envio cria conversa nova para o telefone) — e burlar o descadastro (LGPD). O
--     trigger abaixo deixa só os papéis de servidor (service_role: a edge whatsapp-inbound, onde
--     o próprio cliente manda PARAR/VOLTAR) mexer no consentimento. O staff segue editando o
--     resto da conversa (status, operador).
--
-- (C) Retry e teto de template pago. A edge whatsapp-send-template lia a reserva 'failed' e
--     depois a regravava 'queued' em duas idas separadas: dois retries concorrentes postavam o
--     mesmo template pago DUAS vezes. E não havia teto diário. A reserva agora é UMA função SQL:
--     idempotência pela dedupe_key (INSERT ... ON CONFLICT DO NOTHING, e o retry de 'failed' é um
--     UPDATE ... WHERE status = 'failed', que em READ COMMITTED só um ganha) e o teto é um
--     contador por dia (America/Sao_Paulo) incrementado no mesmo comando que o confere. Se o teto
--     estoura, o savepoint desfaz a reserva. Toda tentativa conta, inclusive o retry: o teto
--     limita tentativas pagáveis, e falha do provedor não devolve vaga (conservador).
--     Parecer Codex (desenho, 2026-11-14, APROVA COM AJUSTES) incorporado: retry só de recusa
--     PROVADA (retry_seguro, ligado pela edge só em HTTP 4xx), token por tentativa para a
--     finalização, destinatário/template/origem amarrados à chave (conflito_payload),
--     search_path = pg_catalog, pg_temp e dia contábil por clock_timestamp().
--     Teto: company_config 'whatsapp_template_teto_diario' (master ajusta); ausente = 200
--     (default declarado aqui); valor inválido = erro (fail-closed, nada é enviado).
--
-- Caminho: SQL Editor (DDL + DELETE → founder). Idempotente. Teste: db/test-seg-lote2.sh.
-- ============================================================
BEGIN;

-- ---------- (A) cache OAuth da Nvoip fora de company_config ----------
CREATE TABLE IF NOT EXISTS public.nvoip_oauth_cache (
  key        text PRIMARY KEY
             CHECK (key IN ('nvoip_access_token', 'nvoip_refresh_token', 'nvoip_token_expires_at')),
  value      text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.nvoip_oauth_cache ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.nvoip_oauth_cache FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.nvoip_oauth_cache TO service_role;
COMMENT ON TABLE public.nvoip_oauth_cache IS
  'Cache do OAuth da Nvoip (edge nvoip-calls). SEGREDO: só service_role; sem policy de propósito. '
  'Saiu de company_config (legível por staff) em 20261114210026 — não devolver.';

DELETE FROM public.company_config
 WHERE key IN ('nvoip_access_token', 'nvoip_refresh_token', 'nvoip_token_expires_at');

ALTER TABLE public.company_config DROP CONSTRAINT IF EXISTS company_config_sem_token_nvoip;
ALTER TABLE public.company_config ADD CONSTRAINT company_config_sem_token_nvoip
  CHECK (key NOT IN ('nvoip_access_token', 'nvoip_refresh_token', 'nvoip_token_expires_at'));

-- ---------- (B) consentimento do WhatsApp só pelo servidor ----------
CREATE OR REPLACE FUNCTION public.whatsapp_conversations_guarda_opt_in()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $fn$
BEGIN
  -- Allowlist (fail-closed): só os papéis de servidor mexem no consentimento. A edge
  -- whatsapp-inbound grava como service_role; o SQL Editor do founder, como postgres.
  IF current_user IN ('service_role', 'postgres', 'supabase_admin') THEN
    RETURN COALESCE(NEW, OLD);
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF NEW.opt_in_status IS DISTINCT FROM 'unknown' THEN
      RAISE EXCEPTION 'opt_in_status só muda pelo próprio cliente (inbound do WhatsApp)'
        USING ERRCODE = '42501';
    END IF;
    RETURN NEW;
  END IF;

  IF TG_OP = 'UPDATE' THEN
    IF NEW.opt_in_status IS DISTINCT FROM OLD.opt_in_status THEN
      RAISE EXCEPTION 'opt_in_status só muda pelo próprio cliente (inbound do WhatsApp)'
        USING ERRCODE = '42501';
    END IF;
    IF OLD.opt_in_status = 'opt_out'
       AND (NEW.phone_key IS DISTINCT FROM OLD.phone_key
            OR NEW.phone_e164 IS DISTINCT FROM OLD.phone_e164) THEN
      RAISE EXCEPTION 'conversa com opt_out não troca de telefone pelo client'
        USING ERRCODE = '42501';
    END IF;
    RETURN NEW;
  END IF;

  -- DELETE
  IF OLD.opt_in_status = 'opt_out' THEN
    RAISE EXCEPTION 'conversa com opt_out não se apaga pelo client (o descadastro iria junto)'
      USING ERRCODE = '42501';
  END IF;
  RETURN OLD;
END
$fn$;

DROP TRIGGER IF EXISTS trg_whatsapp_conversations_guarda_opt_in ON public.whatsapp_conversations;
CREATE TRIGGER trg_whatsapp_conversations_guarda_opt_in
  BEFORE INSERT OR UPDATE OR DELETE ON public.whatsapp_conversations
  FOR EACH ROW EXECUTE FUNCTION public.whatsapp_conversations_guarda_opt_in();

REVOKE ALL ON FUNCTION public.whatsapp_conversations_guarda_opt_in() FROM PUBLIC, anon, authenticated;

-- ---------- (C) reserva atômica do template pago ----------
-- Colunas novas da reserva (0 linhas na PROD hoje; defaults bastam):
--   tentativa_id: token da tentativa corrente. A edge só finaliza (sent/failed) a linha cujo token
--                 ainda é o dela — uma tentativa atrasada não sobrescreve a seguinte.
--   retry_seguro: só a edge liga, e só quando o provedor RECUSOU com prova (HTTP 4xx). Timeout,
--                 5xx, resposta ilegível ou morte da edge deixam false: "não sei se enviou" não
--                 se reenvia (parecer Codex 2026-11-14). A linha fica bloqueada para conciliação.
--   reservado_em: instante da reserva (clock_timestamp), para achar reserva presa.
ALTER TABLE public.whatsapp_template_sends
  ADD COLUMN IF NOT EXISTS tentativa_id uuid NOT NULL DEFAULT gen_random_uuid(),
  ADD COLUMN IF NOT EXISTS retry_seguro boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS reservado_em timestamptz NOT NULL DEFAULT clock_timestamp();

CREATE TABLE IF NOT EXISTS public.whatsapp_template_teto_diario (
  dia      date PRIMARY KEY,
  reservas integer NOT NULL DEFAULT 0 CHECK (reservas >= 0)
);
ALTER TABLE public.whatsapp_template_teto_diario ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.whatsapp_template_teto_diario FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.whatsapp_template_teto_diario TO service_role;
COMMENT ON TABLE public.whatsapp_template_teto_diario IS
  'Contador diário (America/Sao_Paulo) de RESERVAS de template pago — limita tentativas, não '
  'cobrança: reserva de 23h59 pode postar 00h00. Escrita só por whatsapp_template_reservar '
  '(SECURITY DEFINER). 20261114210026.';

CREATE OR REPLACE FUNCTION public.whatsapp_template_reservar(
  p_dedupe_key      text,
  p_template_nome   text,
  p_conversation_id uuid,
  p_phone_e164      text,
  p_body_params     jsonb,
  p_origem          text,
  p_disparado_por   uuid
)
RETURNS TABLE (resultado text, send_id uuid, status_existente text, claim_token uuid)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $fn$
DECLARE
  v_cfg      text;
  v_teto     integer;
  v_token    uuid := pg_catalog.gen_random_uuid();
  v_id       uuid;
  v_n        integer;
  v_instante timestamptz;
  v_ex       public.whatsapp_template_sends%ROWTYPE;
BEGIN
  IF p_dedupe_key IS NULL OR pg_catalog.btrim(p_dedupe_key) = '' THEN
    RAISE EXCEPTION 'dedupe_key obrigatória' USING ERRCODE = '22023';
  END IF;

  -- Teto: ausente = 200 (default declarado). Presente e NULL, vazio, não-inteiro, zero ou
  -- grande demais = erro: nada é reservado, nada é enviado.
  SELECT c.value INTO v_cfg FROM public.company_config c WHERE c.key = 'whatsapp_template_teto_diario';
  IF NOT FOUND THEN
    v_teto := 200;
  ELSIF v_cfg IS NULL OR pg_catalog.btrim(v_cfg) !~ '^[0-9]{1,6}$'
        OR pg_catalog.btrim(v_cfg)::integer <= 0 THEN
    RAISE EXCEPTION 'whatsapp_template_teto_diario inválido em company_config' USING ERRCODE = '22023';
  ELSE
    v_teto := pg_catalog.btrim(v_cfg)::integer;
  END IF;

  BEGIN
    INSERT INTO public.whatsapp_template_sends AS s
      (template_nome, conversation_id, phone_e164, body_params, dedupe_key, status, origem,
       disparado_por, tentativa_id, retry_seguro)
    VALUES
      (p_template_nome, p_conversation_id, p_phone_e164, COALESCE(p_body_params, '[]'::jsonb),
       p_dedupe_key, 'queued', p_origem, p_disparado_por, v_token, false)
    ON CONFLICT (dedupe_key) DO NOTHING
    RETURNING s.id INTO v_id;

    IF v_id IS NULL THEN
      -- Retry só de recusa PROVADA, como compare-and-set: o 2º retry concorrente espera o lock da
      -- linha, reavalia o WHERE (já 'queued') e não pega nada. Destinatário, template e origem
      -- são da chave: diferente → conflito_payload. Os body_params podem mudar (recotação).
      UPDATE public.whatsapp_template_sends AS s
         SET status = 'queued', erro = NULL, tentativa_id = v_token, retry_seguro = false,
             body_params = COALESCE(p_body_params, '[]'::jsonb), disparado_por = p_disparado_por
       WHERE s.dedupe_key = p_dedupe_key
         AND s.status = 'failed' AND s.retry_seguro AND s.wa_message_id IS NULL
         AND s.template_nome = p_template_nome
         AND s.phone_e164 = p_phone_e164
         AND s.conversation_id IS NOT DISTINCT FROM p_conversation_id
         AND s.origem = p_origem
      RETURNING s.id INTO v_id;

      IF v_id IS NULL THEN
        SELECT s.* INTO v_ex FROM public.whatsapp_template_sends s WHERE s.dedupe_key = p_dedupe_key;
        IF NOT FOUND THEN
          RAISE EXCEPTION 'reserva sumiu no meio da chamada; nenhum envio autorizado' USING ERRCODE = '40001';
        END IF;
        IF v_ex.template_nome IS DISTINCT FROM p_template_nome
           OR v_ex.phone_e164 IS DISTINCT FROM p_phone_e164
           OR v_ex.conversation_id IS DISTINCT FROM p_conversation_id
           OR v_ex.origem IS DISTINCT FROM p_origem THEN
          RETURN QUERY SELECT 'conflito_payload'::text, v_ex.id, v_ex.status, NULL::uuid;
        ELSE
          RETURN QUERY SELECT 'duplicata'::text, v_ex.id, v_ex.status, NULL::uuid;
        END IF;
        RETURN;
      END IF;
    END IF;

    -- O dia contábil é o do instante da reserva, depois do claim (não o início da transação).
    v_instante := pg_catalog.clock_timestamp();
    UPDATE public.whatsapp_template_sends AS s SET reservado_em = v_instante WHERE s.id = v_id;

    INSERT INTO public.whatsapp_template_teto_diario AS t (dia, reservas)
    VALUES ((v_instante AT TIME ZONE 'America/Sao_Paulo')::date, 1)
    ON CONFLICT (dia) DO UPDATE SET reservas = t.reservas + 1
     WHERE t.reservas < v_teto
    RETURNING t.reservas INTO v_n;

    IF v_n IS NULL THEN  -- o WHERE do upsert recusou: o contador já está no teto
      RAISE EXCEPTION 'teto diário de template atingido' USING ERRCODE = 'WT429';
    END IF;
  EXCEPTION WHEN SQLSTATE 'WT429' THEN
    -- o savepoint do bloco desfez a reserva (INSERT novo ou claim do 'failed', com token e erro)
    RETURN QUERY SELECT 'teto_excedido'::text, NULL::uuid, NULL::text, NULL::uuid;
    RETURN;
  END;

  RETURN QUERY SELECT 'reservado'::text, v_id, 'queued'::text, v_token;
END
$fn$;

REVOKE ALL ON FUNCTION public.whatsapp_template_reservar(text, text, uuid, text, jsonb, text, uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.whatsapp_template_reservar(text, text, uuid, text, jsonb, text, uuid)
  TO service_role;

-- ---------- postcondição ----------
DO $post$
DECLARE
  r text;
  p text;
BEGIN
  FOREACH r IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    FOREACH p IN ARRAY ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE'] LOOP
      IF has_table_privilege(r, 'public.nvoip_oauth_cache', p) THEN
        RAISE EXCEPTION 'A1 FALHOU: % tem % em nvoip_oauth_cache — token Nvoip legível pelo PostgREST', r, p;
      END IF;
      IF has_table_privilege(r, 'public.whatsapp_template_teto_diario', p) THEN
        RAISE EXCEPTION 'C1 FALHOU: % tem % em whatsapp_template_teto_diario — teto burlável', r, p;
      END IF;
    END LOOP;
    IF has_function_privilege(r, 'public.whatsapp_template_reservar(text, text, uuid, text, jsonb, text, uuid)', 'EXECUTE') THEN
      RAISE EXCEPTION 'C2 FALHOU: % executa whatsapp_template_reservar — reserva paga pelo client', r;
    END IF;
  END LOOP;

  IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.nvoip_oauth_cache'::regclass) THEN
    RAISE EXCEPTION 'A2 FALHOU: nvoip_oauth_cache sem RLS';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'nvoip_oauth_cache') THEN
    RAISE EXCEPTION 'A3 FALHOU: nvoip_oauth_cache ganhou policy — é segredo só do servidor';
  END IF;
  IF EXISTS (SELECT 1 FROM public.company_config
              WHERE key IN ('nvoip_access_token', 'nvoip_refresh_token', 'nvoip_token_expires_at')) THEN
    RAISE EXCEPTION 'A4 FALHOU: token Nvoip segue em company_config';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conrelid = 'public.company_config'::regclass
                    AND conname = 'company_config_sem_token_nvoip' AND convalidated) THEN
    RAISE EXCEPTION 'A5 FALHOU: CHECK company_config_sem_token_nvoip ausente ou não validada';
  END IF;
  IF NOT has_table_privilege('service_role', 'public.nvoip_oauth_cache', 'INSERT') THEN
    RAISE EXCEPTION 'A6 FALHOU: service_role sem INSERT em nvoip_oauth_cache — nvoip-calls não cacheia';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_trigger
                  WHERE tgrelid = 'public.whatsapp_conversations'::regclass
                    AND tgname = 'trg_whatsapp_conversations_guarda_opt_in' AND tgenabled = 'O') THEN
    RAISE EXCEPTION 'B1 FALHOU: trigger de guarda do opt-out ausente ou desabilitado';
  END IF;

  IF NOT (SELECT prosecdef FROM pg_proc
           WHERE oid = 'public.whatsapp_template_reservar(text, text, uuid, text, jsonb, text, uuid)'::regprocedure) THEN
    RAISE EXCEPTION 'C3 FALHOU: whatsapp_template_reservar não é SECURITY DEFINER';
  END IF;
  IF NOT has_function_privilege('service_role', 'public.whatsapp_template_reservar(text, text, uuid, text, jsonb, text, uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'C4 FALHOU: service_role não executa whatsapp_template_reservar — envio de template para';
  END IF;
  IF (SELECT count(*) FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'whatsapp_template_sends'
         AND column_name IN ('tentativa_id', 'retry_seguro', 'reservado_em')) <> 3 THEN
    RAISE EXCEPTION 'C5 FALHOU: whatsapp_template_sends sem tentativa_id/retry_seguro/reservado_em';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_proc
                  WHERE oid = 'public.whatsapp_template_reservar(text, text, uuid, text, jsonb, text, uuid)'::regprocedure
                    AND proconfig @> ARRAY['search_path=pg_catalog, pg_temp']) THEN
    RAISE EXCEPTION 'C6 FALHOU: whatsapp_template_reservar sem search_path travado em pg_catalog, pg_temp';
  END IF;
END
$post$;

COMMIT;
SELECT 'OK seg_lote2_nvoip_optout_template' AS fim;
