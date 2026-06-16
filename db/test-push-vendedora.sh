#!/usr/bin/env bash
# Testa a migration 20260610200000_push_vendedora.sql num Postgres 17 local descartável.
#
# Valida a LÓGICA dos 3 produtores de push (a entrega real é da edge `enviar-push`):
#   - whatsapp inbound: dona via wa_owner_efetivo (real, com cobertura), throttle 10min
#     por conversa, stop-keyword fora, sem-cliente/sem-dona fora, 'out' não dispara,
#     best-effort (vault sem secret → INSERT passa sem push).
#   - tarefa nova: push pro assigned_to, auto-atribuída fora, rajada 2min = 1 push.
#   - push_sla_tick: janela [limiar, limiar+20), agrega por dona, ignora amarelo.
#
# net.http_post é STUB que captura as chamadas em net._captura (pg_net não existe local);
# wa_is_stop_keyword/wa_owner_efetivo são as definições REAIS (verbatim da 20260604130000).
#
# Pré-requisitos: brew install postgresql@17   (mesmo boilerplate de db/verify-snapshot-replay.sh)
set -euo pipefail

PGVER=17
PGBIN="/opt/homebrew/opt/postgresql@${PGVER}/bin"
PORT=5441
DATA="$(mktemp -d /tmp/pgtest-push.XXXXXX)/data"
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
export LC_ALL=C LANG=C

[ -x "$PGBIN/initdb" ] || { echo "postgresql@${PGVER} ausente: brew install postgresql@${PGVER}"; exit 1; }
CELLAR="$(brew --prefix postgresql@${PGVER})"
cp -Rn "$CELLAR"/share/postgresql/. "/opt/homebrew/share/postgresql@${PGVER}/" 2>/dev/null || true
mkdir -p "/opt/homebrew/lib/postgresql@${PGVER}"
cp -Rn "$CELLAR"/lib/postgresql/. "/opt/homebrew/lib/postgresql@${PGVER}/" 2>/dev/null || true

cleanup() { "$PGBIN/pg_ctl" -D "$DATA" stop -m immediate >/dev/null 2>&1 || true; rm -rf "$(dirname "$DATA")"; }
trap cleanup EXIT

"$PGBIN/initdb" -D "$DATA" -U postgres -E UTF8 --locale=C >/dev/null
"$PGBIN/pg_ctl" -D "$DATA" -o "-p $PORT -k /tmp" -l /tmp/pg-push.log -w start >/dev/null
"$PGBIN/createdb" -p "$PORT" -h /tmp -U postgres push_test
P() { "$PGBIN/psql" -p "$PORT" -h /tmp -U postgres -d push_test "$@"; }

# ── 1) Stubs (roles, auth, vault, net com captura, cron) + schema mínimo ──
P -v ON_ERROR_STOP=1 -q <<'SQL'
DO $$ BEGIN CREATE ROLE anon;          EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE ROLE authenticated; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE ROLE service_role;  EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE SCHEMA auth;
CREATE TABLE auth.users (id uuid PRIMARY KEY DEFAULT gen_random_uuid());
-- auth.uid() controlável por GUC de sessão (padrão do Silver+ do replay) —
-- necessário pra testar as RPCs upsert/delete_push_subscription.
CREATE FUNCTION auth.uid()  RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT current_setting('test.uid', true)::uuid $$;
CREATE FUNCTION auth.role() RETURNS text LANGUAGE sql STABLE AS $$ SELECT NULL::text $$;

CREATE SCHEMA vault;
CREATE TABLE vault.decrypted_secrets (name text, decrypted_secret text);
INSERT INTO vault.decrypted_secrets VALUES ('CRON_SECRET', 'segredo-teste');

-- net.http_post STUB: mesma assinatura nomeada do pg_net; captura em vez de enviar.
CREATE SCHEMA net;
CREATE TABLE net._captura (
  id bigserial PRIMARY KEY,
  url text, headers jsonb, body jsonb, timeout_ms int, criado_em timestamptz DEFAULT now()
);
CREATE FUNCTION net.http_post(
  url text,
  body jsonb DEFAULT '{}'::jsonb,
  params jsonb DEFAULT '{}'::jsonb,
  headers jsonb DEFAULT '{}'::jsonb,
  timeout_milliseconds integer DEFAULT NULL
) RETURNS bigint LANGUAGE plpgsql AS $$
DECLARE v_id bigint;
BEGIN
  INSERT INTO net._captura(url, headers, body, timeout_ms)
  VALUES (url, headers, body, timeout_milliseconds) RETURNING id INTO v_id;
  RETURN v_id;
END $$;

CREATE SCHEMA cron;
CREATE TABLE cron.job (jobid bigserial PRIMARY KEY, jobname text, schedule text, command text);
CREATE FUNCTION cron.schedule(p_jobname text, p_schedule text, p_command text)
RETURNS bigint LANGUAGE plpgsql AS $$
DECLARE v bigint;
BEGIN
  DELETE FROM cron.job j WHERE j.jobname = p_jobname;
  INSERT INTO cron.job(jobname, schedule, command)
  VALUES (p_jobname, p_schedule, p_command) RETURNING jobid INTO v;
  RETURN v;
END $$;

-- Schema mínimo das tabelas que os produtores referenciam.
CREATE TABLE public.whatsapp_conversations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_user_id uuid,
  contact_name text,
  phone_e164 text,
  status text NOT NULL DEFAULT 'aberta'
);
CREATE TABLE public.whatsapp_messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id uuid NOT NULL,
  direction text NOT NULL,
  body text,
  sender_user_id uuid,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE public.tarefas (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  assigned_to uuid NOT NULL,
  created_by uuid NOT NULL,
  customer_user_id uuid NOT NULL,
  categoria text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE public.profiles (user_id uuid PRIMARY KEY, name text NOT NULL, razao_social text);
CREATE TABLE public.company_config (key text PRIMARY KEY, value text);
CREATE TABLE public.carteira_assignments (
  customer_user_id uuid, owner_user_id uuid, eligible boolean DEFAULT true,
  valid_from timestamptz DEFAULT now()
);
CREATE TABLE public.carteira_coverage (
  covered_user_id uuid, covering_user_id uuid, active boolean DEFAULT true,
  valid_from timestamptz DEFAULT now() - interval '1 day', valid_until timestamptz
);

-- Funções REAIS (verbatim da 20260604130000) que os produtores chamam.
create or replace function public.wa_is_stop_keyword(p_body text)
returns boolean language sql immutable as $$
  select case
    when p_body is null then false
    else trim(upper(regexp_replace(
           translate(p_body,
             'àáâãäåèéêëìíîïòóôõöùúûüçñÀÁÂÃÄÅÈÉÊËÌÍÎÏÒÓÔÕÖÙÚÛÜÇÑ',
             'aaaaaaeeeeiiiiooooouuuucnAAAAAAEEEEIIIIOOOOOUUUUCN'),
           '[^A-Za-z ]', '', 'g')))
         in ('PARAR','SAIR','STOP','CANCELAR','DESCADASTRAR')
  end;
$$;
create or replace function public.wa_owner_efetivo(p_customer uuid)
returns uuid language sql stable security definer set search_path = public as $$
  select coalesce(
    (select cc.covering_user_id from public.carteira_coverage cc
      where cc.covered_user_id = ca.owner_user_id and cc.active
        and now() >= cc.valid_from and (cc.valid_until is null or now() <= cc.valid_until)
      order by cc.valid_from desc limit 1),
    ca.owner_user_id)
  from public.carteira_assignments ca
  where ca.customer_user_id = p_customer and ca.eligible
  order by ca.valid_from desc limit 1;
$$;

-- v_whatsapp_sla FAKE sobre fixture: o tick só lê estas colunas; a view real
-- tem teste próprio (db/test-whatsapp-sla.sql).
CREATE TABLE public._sla_fixture (
  conversation_id uuid DEFAULT gen_random_uuid(),
  owner_user_id uuid,
  contact_name text,
  phone_e164 text,
  nivel text,
  minutos_uteis_aguardando int
);
CREATE VIEW public.v_whatsapp_sla AS
  SELECT conversation_id, owner_user_id, contact_name, phone_e164,
         nivel, minutos_uteis_aguardando
  FROM public._sla_fixture;
SQL

# ── 2) Aplica a migration REAL ──
P -v ON_ERROR_STOP=1 -q -f "$REPO_ROOT/supabase/migrations/20260610200000_push_vendedora.sql"
echo "OK: migration aplicou limpa"

# ── 3) Asserts ──
P -v ON_ERROR_STOP=1 -q <<'SQL'
-- Seeds: vendedoras A e B, cliente C1 (carteira de A), C2 (sem carteira), coberta C3.
DO $$
DECLARE
  va uuid := 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  vb uuid := 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  c1 uuid := '11111111-1111-4111-8111-111111111111';
  c2 uuid := '22222222-2222-4222-8222-222222222222';
  c3 uuid := '33333333-3333-4333-8333-333333333333';
  founder uuid := 'ffffffff-ffff-4fff-8fff-ffffffffffff';
  conv1 uuid; conv2 uuid; conv3 uuid; conv4 uuid;
  n int;
  cap record;
BEGIN
  INSERT INTO auth.users(id) VALUES (va), (vb), (c1), (c2), (c3), (founder);
  INSERT INTO public.carteira_assignments(customer_user_id, owner_user_id) VALUES (c1, va);
  INSERT INTO public.carteira_assignments(customer_user_id, owner_user_id) VALUES (c3, va);
  -- c3: A está de férias, B cobre.
  INSERT INTO public.carteira_coverage(covered_user_id, covering_user_id) VALUES (va, vb);
  INSERT INTO public.profiles(user_id, name, razao_social) VALUES (c1, 'Maria', 'ACME LTDA');

  INSERT INTO public.whatsapp_conversations(customer_user_id, contact_name, phone_e164)
  VALUES (c1, 'Maria', '+5531999990001') RETURNING id INTO conv1;
  INSERT INTO public.whatsapp_conversations(customer_user_id, contact_name, phone_e164)
  VALUES (NULL, 'Anônimo', '+5531999990002') RETURNING id INTO conv2;
  INSERT INTO public.whatsapp_conversations(customer_user_id, contact_name, phone_e164)
  VALUES (c2, 'Sem Dono', '+5531999990003') RETURNING id INTO conv3;
  INSERT INTO public.whatsapp_conversations(customer_user_id, contact_name, phone_e164)
  VALUES (c3, 'Coberta', '+5531999990004') RETURNING id INTO conv4;

  -- T1: inbound básico → 1 push pra dona (A, dona de c1... mas A está coberta por B!)
  -- wa_owner_efetivo(c1) = B (cobertura ativa). Valida cobertura de férias junto.
  INSERT INTO public.whatsapp_messages(conversation_id, direction, body) VALUES (conv1, 'in', 'oi, preciso de tinta');
  SELECT count(*) INTO n FROM net._captura;
  ASSERT n = 1, format('T1: esperava 1 captura, veio %s', n);
  SELECT * INTO cap FROM net._captura ORDER BY id DESC LIMIT 1;
  ASSERT cap.url LIKE '%/functions/v1/enviar-push', 'T1: url da edge errada';
  ASSERT cap.headers->>'x-cron-secret' = 'segredo-teste', 'T1: secret do Vault não foi no header';
  ASSERT cap.timeout_ms = 10000, 'T1: timeout_milliseconds não explicitado';
  ASSERT cap.body->'user_ids'->>0 = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    format('T1: push deveria ir pra COBERTORA (B), foi pra %s', cap.body->'user_ids');
  ASSERT cap.body->>'tag' = 'wa-' || conv1::text, 'T1: tag por conversa errada';
  ASSERT cap.body->>'corpo' LIKE 'Maria %', 'T1: corpo sem o nome do contato';
  ASSERT cap.body->>'corpo' NOT LIKE '%preciso de tinta%', 'T1: corpo NÃO pode ter o texto da msg (LGPD)';
  RAISE NOTICE 'T1 OK: inbound → push pra dona efetiva (cobertura), sem texto da msg';

  -- T2: 2ª msg <10min mesma conversa → throttle (segue 1)
  INSERT INTO public.whatsapp_messages(conversation_id, direction, body) VALUES (conv1, 'in', 'tem FC.6975?');
  SELECT count(*) INTO n FROM net._captura;
  ASSERT n = 1, format('T2: throttle falhou — %s capturas', n);
  RAISE NOTICE 'T2 OK: burst <10min = 1 push';

  -- T3: throttle expira → msgs antigas >10min não bloqueiam
  UPDATE public.whatsapp_messages SET created_at = now() - interval '11 minutes'
  WHERE conversation_id = conv1;
  INSERT INTO public.whatsapp_messages(conversation_id, direction, body) VALUES (conv1, 'in', 'e aí?');
  SELECT count(*) INTO n FROM net._captura;
  ASSERT n = 2, format('T3: esperava 2 capturas pós-janela, veio %s', n);
  RAISE NOTICE 'T3 OK: janela de 10min expira';

  -- T4: stop-keyword não vira push
  UPDATE public.whatsapp_messages SET created_at = now() - interval '11 minutes';
  INSERT INTO public.whatsapp_messages(conversation_id, direction, body) VALUES (conv1, 'in', 'PARAR');
  SELECT count(*) INTO n FROM net._captura;
  ASSERT n = 2, format('T4: PARAR não devia gerar push (veio %s)', n);
  RAISE NOTICE 'T4 OK: stop-keyword fora';

  -- T5: conversa sem cliente vinculado → sem push
  INSERT INTO public.whatsapp_messages(conversation_id, direction, body) VALUES (conv2, 'in', 'oi');
  SELECT count(*) INTO n FROM net._captura;
  ASSERT n = 2, 'T5: conversa sem cliente gerou push';
  RAISE NOTICE 'T5 OK: sem cliente = sem push';

  -- T6: cliente sem carteira (dona NULL) → sem push
  INSERT INTO public.whatsapp_messages(conversation_id, direction, body) VALUES (conv3, 'in', 'oi');
  SELECT count(*) INTO n FROM net._captura;
  ASSERT n = 2, 'T6: cliente sem dona gerou push';
  RAISE NOTICE 'T6 OK: sem dona = sem push';

  -- T7: direction out não dispara o trigger (WHEN clause)
  INSERT INTO public.whatsapp_messages(conversation_id, direction, body, sender_user_id)
  VALUES (conv1, 'out', 'resposta da vendedora', va);
  SELECT count(*) INTO n FROM net._captura;
  ASSERT n = 2, 'T7: out disparou push';
  RAISE NOTICE 'T7 OK: out não dispara';

  -- T8: tarefa atribuída → push pro assigned_to com categoria + razão social
  INSERT INTO public.tarefas(assigned_to, created_by, customer_user_id, categoria)
  VALUES (va, founder, c1, 'ligar');
  SELECT count(*) INTO n FROM net._captura;
  ASSERT n = 3, format('T8: esperava 3 capturas, veio %s', n);
  SELECT * INTO cap FROM net._captura ORDER BY id DESC LIMIT 1;
  ASSERT cap.body->'user_ids'->>0 = va::text, 'T8: push da tarefa não foi pro assigned_to';
  ASSERT cap.body->>'corpo' = 'Ligar — ACME LTDA', format('T8: corpo errado: %s', cap.body->>'corpo');
  ASSERT cap.body->>'url' = '/meu-dia', 'T8: url da tarefa devia ser /meu-dia';
  RAISE NOTICE 'T8 OK: tarefa nova → push';

  -- T9: rajada de criação em lote (<2min, mesmo assigned) → 1 push só
  INSERT INTO public.tarefas(assigned_to, created_by, customer_user_id, categoria)
  VALUES (va, founder, c1, 'oferecer');
  SELECT count(*) INTO n FROM net._captura;
  ASSERT n = 3, format('T9: rajada gerou push extra (%s)', n);
  RAISE NOTICE 'T9 OK: rajada = 1 push';

  -- T10: auto-atribuída (criou pra si) → sem push
  UPDATE public.tarefas SET created_at = now() - interval '3 minutes';
  INSERT INTO public.tarefas(assigned_to, created_by, customer_user_id, categoria)
  VALUES (vb, vb, c1, 'whatsapp');
  SELECT count(*) INTO n FROM net._captura;
  ASSERT n = 3, 'T10: auto-atribuída gerou push';
  RAISE NOTICE 'T10 OK: auto-atribuída fora';

  -- T11: SLA tick — A com 2 vermelhas na janela, B com 1 velha (55min) e 1 amarela.
  -- Config de expediente ABERTO agora (o gate é testado no T11b).
  INSERT INTO public.company_config(key, value) VALUES
    ('whatsapp_sla_hora_inicio', '00:00'),
    ('whatsapp_sla_hora_fim',    '23:59'),
    ('whatsapp_sla_dias',        '1,2,3,4,5,6,7');
  INSERT INTO public._sla_fixture(owner_user_id, contact_name, phone_e164, nivel, minutos_uteis_aguardando) VALUES
    (va, 'Maria',  '+551', 'vermelho', 32),
    (va, 'João',   '+552', 'vermelho', 45),
    (vb, 'Velha',  '+553', 'vermelho', 55),
    (vb, 'Amarela','+554', 'amarelo',  20);
  PERFORM public.push_sla_tick();
  SELECT count(*) INTO n FROM net._captura;
  ASSERT n = 4, format('T11: tick devia gerar SÓ 1 push agregado (A) — capturas=%s', n);
  SELECT * INTO cap FROM net._captura ORDER BY id DESC LIMIT 1;
  ASSERT cap.body->'user_ids'->>0 = va::text, 'T11: push do SLA não foi pra dona A';
  ASSERT cap.body->>'corpo' LIKE '2 clientes%', format('T11: corpo devia agregar 2 (%s)', cap.body->>'corpo');
  ASSERT cap.body->>'corpo' LIKE '%João%', 'T11: ordenação por minutos desc devia listar João primeiro';
  ASSERT cap.body->>'tag' = 'sla', 'T11: tag fixa sla (substitui no device)';
  RAISE NOTICE 'T11 OK: SLA agrega por dona, janela [30,50)';

  -- T11b: fora do expediente (dias sem hoje) → tick early-return, 0 push
  -- (mata o re-push overnight: minutos congelam fora do expediente).
  UPDATE public.company_config SET value =
    (SELECT CASE WHEN EXTRACT(isodow FROM now() AT TIME ZONE 'America/Sao_Paulo')::int = 1
                 THEN '2' ELSE '1' END)
  WHERE key = 'whatsapp_sla_dias';
  PERFORM public.push_sla_tick();
  SELECT count(*) INTO n FROM net._captura;
  ASSERT n = 4, format('T11b: tick fora do expediente enviou push (%s)', n);
  UPDATE public.company_config SET value = '1,2,3,4,5,6,7' WHERE key = 'whatsapp_sla_dias';
  RAISE NOTICE 'T11b OK: gate de expediente segura o re-push overnight';

  -- T11c: 'in' inserido por STAFF (sender_user_id preenchido) não dispara
  -- (anti-amplificação: inbound legítimo do webhook não tem sender humano).
  UPDATE public.whatsapp_messages SET created_at = now() - interval '11 minutes';
  INSERT INTO public.whatsapp_messages(conversation_id, direction, body, sender_user_id)
  VALUES (conv1, 'in', 'falso inbound', vb);
  SELECT count(*) INTO n FROM net._captura;
  ASSERT n = 4, 'T11c: in com sender_user_id disparou push';
  RAISE NOTICE 'T11c OK: in falso de staff não dispara';

  -- T11d: RPCs do device — endpoint REATRIBUI pro usuário logado (anti-vazamento
  -- em device compartilhado) e delete limpa por endpoint.
  PERFORM set_config('test.uid', va::text, false);
  PERFORM public.upsert_push_subscription('https://push.exemplo/endpoint-1234', '{"keys":{}}'::jsonb, 'UA');
  ASSERT (SELECT user_id FROM public.push_subscriptions WHERE endpoint='https://push.exemplo/endpoint-1234') = va,
    'T11d: insert inicial não gravou pra A';
  PERFORM set_config('test.uid', vb::text, false);
  PERFORM public.upsert_push_subscription('https://push.exemplo/endpoint-1234', '{"keys":{"p":"x"}}'::jsonb, 'UA2');
  ASSERT (SELECT user_id FROM public.push_subscriptions WHERE endpoint='https://push.exemplo/endpoint-1234') = vb,
    'T11d: endpoint NÃO reatribuiu pra B (vazamento de device compartilhado!)';
  ASSERT (SELECT count(*) FROM public.push_subscriptions) = 1, 'T11d: upsert duplicou linha';
  PERFORM public.delete_push_subscription('https://push.exemplo/endpoint-1234');
  ASSERT (SELECT count(*) FROM public.push_subscriptions) = 0, 'T11d: delete não limpou';
  PERFORM set_config('test.uid', '', false);
  RAISE NOTICE 'T11d OK: endpoint pertence a quem está logado; delete por endpoint';

  -- T12: best-effort — Vault sem secret → INSERT passa, sem push, sem erro
  DELETE FROM vault.decrypted_secrets;
  UPDATE public.whatsapp_messages SET created_at = now() - interval '11 minutes';
  INSERT INTO public.whatsapp_messages(conversation_id, direction, body) VALUES (conv1, 'in', 'sem secret');
  SELECT count(*) INTO n FROM net._captura;
  ASSERT n = 4, 'T12: push saiu sem secret?';
  RAISE NOTICE 'T12 OK: sem CRON_SECRET = warning, INSERT intacto';

  -- T13: cron agendado pela migration
  ASSERT (SELECT count(*) FROM cron.job WHERE jobname = 'push-sla-tick') = 1, 'T13: cron push-sla-tick não agendado';
  RAISE NOTICE 'T13 OK: cron push-sla-tick agendado';
END $$;
SQL

echo "✅ test-push-vendedora: todos os asserts passaram"
