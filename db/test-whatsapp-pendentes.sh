#!/usr/bin/env bash
# Prova PG17 do PR-2 (migration 20260713020000_whatsapp_pendentes_rpc):
# - seed ANTES da migration → prova que o BACKFILL preenche last_outbound_at do histórico;
# - trigger 1-writer: out avança, out atrasado NÃO regride (greatest), in não toca;
# - RPC get_whatsapp_pendentes sob SET ROLE authenticated + GUC:
#     staff vê pendentes na janela (sem dono ou seu), NÃO vê respondida/velha/fechada/de outro dono;
#     não-staff → 0 rows (RLS fail-closed); anon → EXECUTE negado (42501);
# - FALSIFICAÇÃO ×2: (a) DROP do trigger → assert de avanço fica vermelho;
#     (b) grant de EXECUTE a anon simulado NÃO — em vez disso, sabota o WHERE? não:
#     derruba o REVOKE (GRANT a anon) e exige que o assert 42501 fique vermelho.
#
# Base: db/test-whatsapp-hsm.sh. Pré-req: brew install postgresql@17.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
export LC_ALL=en_US.UTF-8 LANG=en_US.UTF-8
PGVER=17
PGBIN="/opt/homebrew/opt/postgresql@${PGVER}/bin"
PORT=5444
DATA="$(mktemp -d /tmp/pgtest-wapend.XXXXXX)/data"

[ -x "$PGBIN/initdb" ] || { echo "postgresql@${PGVER} ausente: brew install postgresql@${PGVER}"; exit 1; }

CELLAR="$(brew --prefix postgresql@${PGVER})"
cp -Rn "$CELLAR"/share/postgresql/. "/opt/homebrew/share/postgresql@${PGVER}/" 2>/dev/null || true
mkdir -p "/opt/homebrew/lib/postgresql@${PGVER}"
cp -Rn "$CELLAR"/lib/postgresql/. "/opt/homebrew/lib/postgresql@${PGVER}/" 2>/dev/null || true

cleanup() { "$PGBIN/pg_ctl" -D "$DATA" stop -m immediate >/dev/null 2>&1 || true; rm -rf "$(dirname "$DATA")"; rm -f "${RR:-}"; }
trap cleanup EXIT

"$PGBIN/initdb" -D "$DATA" -U postgres -E UTF8 --locale=en_US.UTF-8 >/dev/null
"$PGBIN/pg_ctl" -D "$DATA" -o "-p $PORT -k /tmp" -l /tmp/pg-wapend.log -w start >/dev/null
"$PGBIN/createdb" -p "$PORT" -h /tmp -U postgres wapend_verify
P() { "$PGBIN/psql" -p "$PORT" -h /tmp -U postgres -d wapend_verify "$@"; }

RR="$(mktemp "${TMPDIR:-/tmp}/snap-wapend.XXXXXX")"
sed -E 's/^(CREATE SCHEMA public;)/-- \1/' "$REPO_ROOT/supabase/schema-snapshot.sql" \
  | grep -vE '^\\(un)?restrict ' > "$RR"

echo "→ stubs + prelude + snapshot…"
P -v ON_ERROR_STOP=1 -q -f "$REPO_ROOT/db/stubs-supabase.sql"
P -v ON_ERROR_STOP=1 -q -f "$REPO_ROOT/supabase/schema-extensions-prelude.sql"
P --single-transaction -v ON_ERROR_STOP=1 -q -f "$RR"
rm -f "$RR"

echo "→ grants de prod (Supabase dá ALL nas existentes; default privileges nas novas) + auth.uid() fiel…"
P -v ON_ERROR_STOP=1 -q <<'SQL'
GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;
GRANT ALL ON ALL TABLES IN SCHEMA public TO anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON TABLES TO anon, authenticated, service_role;
CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $f$
  SELECT coalesce(
    nullif(current_setting('request.jwt.claim.sub', true), ''),
    nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub'
  )::uuid
$f$;
GRANT USAGE ON SCHEMA auth TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION auth.uid() TO anon, authenticated, service_role;
SQL

echo "→ seed PRÉ-migration (histórico que o backfill deve cobrir)…"
P -v ON_ERROR_STOP=1 -q <<'SQL'
-- identidades: staff1 (employee), staff2 (employee), não-staff
INSERT INTO auth.users (id) VALUES
  ('00000000-0000-0000-0000-0000000aaaa1'),
  ('00000000-0000-0000-0000-0000000cccc3'),
  ('00000000-0000-0000-0000-0000000bbbb2')
ON CONFLICT (id) DO NOTHING;
INSERT INTO public.user_roles (user_id, role) VALUES
  ('00000000-0000-0000-0000-0000000aaaa1', 'employee'),
  ('00000000-0000-0000-0000-0000000cccc3', 'employee');

-- Conversas (last_inbound_at é da edge — o teste seta direto; last_outbound_at fica do backfill/trigger):
-- A pendente sem outbound · B outbound ANTIGO < inbound (pendente) · C respondida (out > in)
-- D inbound velho >24h · E fechada · F dono staff2 · G dono staff1
INSERT INTO public.whatsapp_conversations (id, phone_key, phone_e164, contact_name, status, last_inbound_at) VALUES
  ('00000000-0000-0000-0000-00000000aa0a', 'a', '5537000000001', 'A pendente',   'aberta',  now() - interval '2 hours'),
  ('00000000-0000-0000-0000-00000000bb0b', 'b', '5537000000002', 'B out antigo', 'aberta',  now() - interval '1 hour'),
  ('00000000-0000-0000-0000-00000000cc0c', 'c', '5537000000003', 'C respondida', 'aguardando_cliente', now() - interval '3 hours'),
  ('00000000-0000-0000-0000-00000000dd0d', 'd', '5537000000004', 'D velha',      'aberta',  now() - interval '30 hours'),
  ('00000000-0000-0000-0000-00000000ee0e', 'e', '5537000000005', 'E fechada',    'fechada', now() - interval '1 hour');
INSERT INTO public.whatsapp_conversations (id, phone_key, phone_e164, contact_name, status, last_inbound_at, assigned_operator_id) VALUES
  ('00000000-0000-0000-0000-00000000ff0f', 'f', '5537000000006', 'F de staff2',  'aberta',  now() - interval '1 hour', '00000000-0000-0000-0000-0000000cccc3'),
  ('00000000-0000-0000-0000-00000000aa1a', 'g', '5537000000007', 'G de staff1',  'aberta',  now() - interval '1 hour', '00000000-0000-0000-0000-0000000aaaa1');

-- Mensagens históricas (backfill deve derivar: B ← out de 5h atrás; C ← out de 1h atrás)
INSERT INTO public.whatsapp_messages (conversation_id, direction, body, created_at) VALUES
  ('00000000-0000-0000-0000-00000000bb0b', 'out', 'oi',      now() - interval '5 hours'),
  ('00000000-0000-0000-0000-00000000cc0c', 'out', 'respondi', now() - interval '1 hour'),
  ('00000000-0000-0000-0000-00000000cc0c', 'in',  'pergunta', now() - interval '3 hours');
SQL

echo "→ migration 20260713020000 (coluna + trigger + backfill + RPC)…"
P -v ON_ERROR_STOP=1 -q -f "$REPO_ROOT/supabase/migrations/20260713020000_whatsapp_pendentes_rpc.sql" >/dev/null

echo "→ asserts: backfill + trigger (avança, não regride, in não toca)…"
P -v ON_ERROR_STOP=1 -q <<'SQL'
-- backfill cobriu o histórico
DO $$ DECLARE t timestamptz; BEGIN
  SELECT last_outbound_at INTO t FROM public.whatsapp_conversations WHERE id='00000000-0000-0000-0000-00000000bb0b';
  IF t IS NULL OR abs(extract(epoch FROM (t - (now() - interval '5 hours')))) > 60
    THEN RAISE EXCEPTION 'FALHA backfill: B esperava out de ~5h atrás, veio %', t; END IF;
  SELECT last_outbound_at INTO t FROM public.whatsapp_conversations WHERE id='00000000-0000-0000-0000-00000000aa0a';
  IF t IS NOT NULL THEN RAISE EXCEPTION 'FALHA backfill: A nunca teve out, veio %', t; END IF;
END $$;

-- trigger avança com out novo
INSERT INTO public.whatsapp_messages (conversation_id, direction, body, created_at)
VALUES ('00000000-0000-0000-0000-00000000bb0b', 'out', 'resposta agora', now());
DO $$ DECLARE t timestamptz; BEGIN
  SELECT last_outbound_at INTO t FROM public.whatsapp_conversations WHERE id='00000000-0000-0000-0000-00000000bb0b';
  IF t IS NULL OR t < now() - interval '60 seconds'
    THEN RAISE EXCEPTION 'FALHA trigger: out novo não avançou last_outbound_at (%)' , t; END IF;
END $$;

-- out ATRASADO (reprocesso/retry) não regride
INSERT INTO public.whatsapp_messages (conversation_id, direction, body, created_at)
VALUES ('00000000-0000-0000-0000-00000000bb0b', 'out', 'retry atrasado', now() - interval '10 hours');
DO $$ DECLARE t timestamptz; BEGIN
  SELECT last_outbound_at INTO t FROM public.whatsapp_conversations WHERE id='00000000-0000-0000-0000-00000000bb0b';
  IF t < now() - interval '60 seconds'
    THEN RAISE EXCEPTION 'FALHA trigger: out atrasado REGREDIU o marcador (%)' , t; END IF;
END $$;

-- in NÃO toca o marcador
DO $$ DECLARE antes timestamptz; depois timestamptz; BEGIN
  SELECT last_outbound_at INTO antes FROM public.whatsapp_conversations WHERE id='00000000-0000-0000-0000-00000000aa0a';
  INSERT INTO public.whatsapp_messages (conversation_id, direction, body, created_at)
  VALUES ('00000000-0000-0000-0000-00000000aa0a', 'in', 'cliente de novo', now());
  SELECT last_outbound_at INTO depois FROM public.whatsapp_conversations WHERE id='00000000-0000-0000-0000-00000000aa0a';
  IF depois IS DISTINCT FROM antes THEN RAISE EXCEPTION 'FALHA trigger: IN mexeu em last_outbound_at (% → %)', antes, depois; END IF;
END $$;
SQL

echo "→ RPC sob SET ROLE authenticated (staff vê o certo; não-staff 0; anon 42501)…"
P -v ON_ERROR_STOP=1 -q <<'SQL'
-- staff1: vê A, G (ordem por last_inbound_at ASC ⇒ A primeiro) e NÃO vê B/C/D/E/F.
-- B tinha out ANTIGO (pendente pós-backfill) mas o assert do trigger acabou de responder
-- nela — "resposta enviada → sai da fila" é exatamente o efeito que a coluna real compra.
BEGIN;
SET LOCAL ROLE authenticated;
SET LOCAL request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000aaaa1","role":"authenticated"}';
DO $$ DECLARE ids uuid[]; BEGIN
  SELECT array_agg(conversation_id ORDER BY last_inbound_at ASC) INTO ids FROM public.get_whatsapp_pendentes();
  IF ids IS NULL OR array_length(ids,1) <> 2
    THEN RAISE EXCEPTION 'FALHA RPC staff1: esperava 2 pendentes (A,G), veio %', coalesce(array_length(ids,1),0); END IF;
  IF ids[1] <> '00000000-0000-0000-0000-00000000aa0a'
    THEN RAISE EXCEPTION 'FALHA RPC: mais antigo (A) deveria vir primeiro, veio %', ids[1]; END IF;
  IF '00000000-0000-0000-0000-00000000bb0b' = ANY(ids)
    THEN RAISE EXCEPTION 'FALHA RPC: B foi RESPONDIDA (trigger) e continua na fila'; END IF;
  IF '00000000-0000-0000-0000-00000000ff0f' = ANY(ids)
    THEN RAISE EXCEPTION 'FALHA RPC: conversa de OUTRO dono (F) vazou pra staff1'; END IF;
END $$;
ROLLBACK;

-- staff2: vê A, B, F (G é do staff1)
BEGIN;
SET LOCAL ROLE authenticated;
SET LOCAL request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000cccc3","role":"authenticated"}';
DO $$ DECLARE n int; BEGIN
  SELECT count(*) INTO n FROM public.get_whatsapp_pendentes()
   WHERE conversation_id = '00000000-0000-0000-0000-00000000ff0f';
  IF n <> 1 THEN RAISE EXCEPTION 'FALHA RPC staff2: deveria ver a própria conversa F'; END IF;
END $$;
ROLLBACK;

-- não-staff: RLS fail-closed → 0 rows
BEGIN;
SET LOCAL ROLE authenticated;
SET LOCAL request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000bbbb2","role":"authenticated"}';
DO $$ DECLARE n int; BEGIN
  SELECT count(*) INTO n FROM public.get_whatsapp_pendentes();
  IF n <> 0 THEN RAISE EXCEPTION 'FALHA RPC: não-staff vê % pendentes', n; END IF;
END $$;
ROLLBACK;

-- anon: EXECUTE revogado por nome → 42501 (capturar ESPECÍFICO)
BEGIN;
SET LOCAL ROLE anon;
DO $$ DECLARE n int; BEGIN
  SELECT count(*) INTO n FROM public.get_whatsapp_pendentes();
  RAISE EXCEPTION 'FALHA: anon EXECUTOU a RPC (n=%)', n;
EXCEPTION WHEN insufficient_privilege THEN RAISE NOTICE 'ok: anon negado 42501'; END $$;
ROLLBACK;
SQL

echo "→ FALSIFICAÇÃO 1: derrubar o trigger e exigir o assert de avanço VERMELHO…"
P -q -c "DROP TRIGGER trg_wa_msg_last_outbound ON public.whatsapp_messages;"
if P -v ON_ERROR_STOP=1 -q >/dev/null 2>&1 <<'SQL'
INSERT INTO public.whatsapp_conversations (id, phone_key, status, last_inbound_at)
VALUES ('00000000-0000-0000-0000-00000000fa15', 'falsif', 'aberta', now());
INSERT INTO public.whatsapp_messages (conversation_id, direction, body, created_at)
VALUES ('00000000-0000-0000-0000-00000000fa15', 'out', 'x', now());
DO $$ DECLARE t timestamptz; BEGIN
  SELECT last_outbound_at INTO t FROM public.whatsapp_conversations WHERE id='00000000-0000-0000-0000-00000000fa15';
  IF t IS NULL THEN RAISE EXCEPTION 'esperado: sem trigger não atualiza'; END IF;
END $$;
SQL
then
  echo "✗ FALSIFICAÇÃO 1 FALHOU: marcador atualizou SEM o trigger (teste não morde)"; exit 1
else
  echo "ok: sem o trigger o assert fica vermelho — o teste morde"
fi
P -v ON_ERROR_STOP=1 -q -c "CREATE TRIGGER trg_wa_msg_last_outbound AFTER INSERT ON public.whatsapp_messages FOR EACH ROW WHEN (NEW.direction = 'out') EXECUTE FUNCTION public.wa_msg_touch_last_outbound();"

echo "→ FALSIFICAÇÃO 2: devolver EXECUTE a anon e exigir o assert 42501 VERMELHO…"
P -q -c "GRANT EXECUTE ON FUNCTION public.get_whatsapp_pendentes() TO anon;"
if P -v ON_ERROR_STOP=1 -q >/dev/null 2>&1 <<'SQL'
BEGIN;
SET LOCAL ROLE anon;
DO $$ DECLARE n int; BEGIN
  SELECT count(*) INTO n FROM public.get_whatsapp_pendentes();
  RAISE EXCEPTION 'anon executou (esperado com o GRANT sabotado)';
EXCEPTION WHEN insufficient_privilege THEN NULL; END $$;
ROLLBACK;
SQL
then
  echo "✗ FALSIFICAÇÃO 2 FALHOU: assert 42501 continuou verde COM o grant sabotado (teste não morde)"; exit 1
else
  echo "ok: com EXECUTE devolvido a anon o assert fica vermelho — o teste morde"
fi

echo "✅ prova PG17 do PR-2 pendentes: verde (backfill, trigger monotônico, RPC/RLS, falsificação ×2)"
