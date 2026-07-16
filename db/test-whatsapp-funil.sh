#!/usr/bin/env bash
# Prova PG17 do PR-3 (migration 20260713030000_whatsapp_funil):
# - aplica as 3 migrations do programa EM ORDEM (010000 → 020000 → 030000) — a
#   mesma ordem do deploy manual do founder;
# - asserts do funil: enviados/entregues/lidos/falhas; "respondeu" só com inbound
#   ≤24h APÓS o send (resposta anterior NÃO conta; >24h NÃO conta); proposta/pedido
#   SÓ com elo explícito (pedido de telefone NÃO conta); período respeitado; receita
#   sum() null-safe;
# - RLS sob SET ROLE: staff vê números; não-staff vê tudo 0 (fail-closed); anon 42501;
# - FALSIFICAÇÃO: recria a RPC SEM exigir o elo (o erro de atribuição que o parecer
#   do Codex alerta) → o assert de pedidos_omie TEM de ficar vermelho.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
export LC_ALL=en_US.UTF-8 LANG=en_US.UTF-8
PGVER=17
PGBIN="/opt/homebrew/opt/postgresql@${PGVER}/bin"
PORT=5445
DATA="$(mktemp -d /tmp/pgtest-wafunil.XXXXXX)/data"

[ -x "$PGBIN/initdb" ] || { echo "postgresql@${PGVER} ausente: brew install postgresql@${PGVER}"; exit 1; }

CELLAR="$(brew --prefix postgresql@${PGVER})"
cp -Rn "$CELLAR"/share/postgresql/. "/opt/homebrew/share/postgresql@${PGVER}/" 2>/dev/null || true
mkdir -p "/opt/homebrew/lib/postgresql@${PGVER}"
cp -Rn "$CELLAR"/lib/postgresql/. "/opt/homebrew/lib/postgresql@${PGVER}/" 2>/dev/null || true

cleanup() { "$PGBIN/pg_ctl" -D "$DATA" stop -m immediate >/dev/null 2>&1 || true; rm -rf "$(dirname "$DATA")"; rm -f "${RR:-}"; }
trap cleanup EXIT

"$PGBIN/initdb" -D "$DATA" -U postgres -E UTF8 --locale=en_US.UTF-8 >/dev/null
"$PGBIN/pg_ctl" -D "$DATA" -o "-p $PORT -k /tmp" -l /tmp/pg-wafunil.log -w start >/dev/null
"$PGBIN/createdb" -p "$PORT" -h /tmp -U postgres wafunil_verify
P() { "$PGBIN/psql" -p "$PORT" -h /tmp -U postgres -d wafunil_verify "$@"; }

RR="$(mktemp "${TMPDIR:-/tmp}/snap-wafunil.XXXXXX")"
sed -E 's/^(CREATE SCHEMA public;)/-- \1/' "$REPO_ROOT/supabase/schema-snapshot.sql" \
  | grep -vE '^\\(un)?restrict ' > "$RR"

echo "→ stubs + prelude + snapshot…"
P -v ON_ERROR_STOP=1 -q -f "$REPO_ROOT/db/stubs-supabase.sql"
P -v ON_ERROR_STOP=1 -q -f "$REPO_ROOT/supabase/schema-extensions-prelude.sql"
P --single-transaction -v ON_ERROR_STOP=1 -q -f "$RR"
rm -f "$RR"

echo "→ grants de prod + auth.uid() fiel…"
P -v ON_ERROR_STOP=1 -q <<'SQL'
GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;
GRANT ALL ON ALL TABLES IN SCHEMA public TO anon, authenticated, service_role;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO anon, authenticated, service_role;
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

echo "→ migrations do programa EM ORDEM (010000 HSM → 020000 pendentes → 030000 funil)…"
P -v ON_ERROR_STOP=1 -q -f "$REPO_ROOT/supabase/migrations/20260713010000_whatsapp_templates_hsm.sql" >/dev/null
P -v ON_ERROR_STOP=1 -q -f "$REPO_ROOT/supabase/migrations/20260713020000_whatsapp_pendentes_rpc.sql" >/dev/null
P -v ON_ERROR_STOP=1 -q -f "$REPO_ROOT/supabase/migrations/20260713030000_whatsapp_funil.sql" >/dev/null

echo "→ seed (1 conversa por cenário; sends com created_at explícito)…"
P -v ON_ERROR_STOP=1 -q <<'SQL'
INSERT INTO auth.users (id) VALUES
  ('00000000-0000-0000-0000-0000000aaaa1'),
  ('00000000-0000-0000-0000-0000000bbbb2'),
  ('00000000-0000-0000-0000-0000000dddd4')
ON CONFLICT (id) DO NOTHING;
INSERT INTO public.user_roles (user_id, role) VALUES
  ('00000000-0000-0000-0000-0000000aaaa1', 'employee');

INSERT INTO public.whatsapp_conversations (id, phone_key, status) VALUES
  ('00000000-0000-0000-0000-00000000c001', 'c1', 'aberta'),
  ('00000000-0000-0000-0000-00000000c002', 'c2', 'aberta'),
  ('00000000-0000-0000-0000-00000000c003', 'c3', 'aberta'),
  ('00000000-0000-0000-0000-00000000c004', 'c4', 'aberta');

-- sends (template do seed da 010000):
--   s1 sent cv1 (sem resposta) · s2 delivered cv2 (in +1h ⇒ respondido)
--   s3 read cv3 (in +30h ⇒ fora da janela) · s4 failed cv1 · s5 delivered cv4
--   (in ANTERIOR ao send ⇒ não conta) · s6 queued cv2 (reserva, não é envio)
INSERT INTO public.whatsapp_template_sends (template_nome, conversation_id, phone_e164, dedupe_key, status, created_at) VALUES
  ('colacor_proposta_recompra', '00000000-0000-0000-0000-00000000c001', '5537000000001', 'k1', 'sent',      now() - interval '2 days'),
  ('colacor_proposta_recompra', '00000000-0000-0000-0000-00000000c002', '5537000000002', 'k2', 'delivered', now() - interval '2 days'),
  ('colacor_proposta_recompra', '00000000-0000-0000-0000-00000000c003', '5537000000003', 'k3', 'read',      now() - interval '3 days'),
  ('colacor_proposta_recompra', '00000000-0000-0000-0000-00000000c001', '5537000000001', 'k4', 'failed',    now() - interval '2 days'),
  ('colacor_proposta_recompra', '00000000-0000-0000-0000-00000000c004', '5537000000004', 'k5', 'delivered', now() - interval '1 day'),
  ('colacor_proposta_recompra', '00000000-0000-0000-0000-00000000c002', '5537000000002', 'k6', 'queued',    now() - interval '1 day');

INSERT INTO public.whatsapp_messages (conversation_id, direction, body, created_at) VALUES
  ('00000000-0000-0000-0000-00000000c002', 'in', 'quero sim',  now() - interval '2 days' + interval '1 hour'),
  ('00000000-0000-0000-0000-00000000c003', 'in', 'tarde demais', now() - interval '3 days' + interval '30 hours'),
  ('00000000-0000-0000-0000-00000000c004', 'in', 'antes do envio', now() - interval '1 day' - interval '1 hour');

-- orders: o1 elo+omie+total(1000) · o2 elo sem omie · o3 SEM elo com omie (telefone!)
--         o4 elo+omie mas 60d atrás (fora do período de 30d)
INSERT INTO public.sales_orders (customer_user_id, created_by, total, status, omie_pedido_id, whatsapp_conversation_id, created_at) VALUES
  ('00000000-0000-0000-0000-0000000dddd4', '00000000-0000-0000-0000-0000000aaaa1', 1000, 'confirmado', 111, '00000000-0000-0000-0000-00000000c002', now() - interval '1 day'),
  ('00000000-0000-0000-0000-0000000dddd4', '00000000-0000-0000-0000-0000000aaaa1', 500,  'orcamento',  NULL, '00000000-0000-0000-0000-00000000c003', now() - interval '1 day'),
  ('00000000-0000-0000-0000-0000000dddd4', '00000000-0000-0000-0000-0000000aaaa1', 900,  'confirmado', 222, NULL,                                    now() - interval '1 day'),
  ('00000000-0000-0000-0000-0000000dddd4', '00000000-0000-0000-0000-0000000aaaa1', 700,  'confirmado', 333, '00000000-0000-0000-0000-00000000c001', now() - interval '60 days');
SQL

echo "→ asserts do funil sob SET ROLE authenticated (staff)…"
P -v ON_ERROR_STOP=1 -q <<'SQL'
BEGIN;
SET LOCAL ROLE authenticated;
SET LOCAL request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000aaaa1","role":"authenticated"}';
DO $$ DECLARE r record; BEGIN
  SELECT * INTO r FROM public.get_whatsapp_funil(30);
  IF r.enviados     <> 4 THEN RAISE EXCEPTION 'FALHA enviados: esperava 4 (s1,s2,s3,s5 — queued fora), veio %', r.enviados; END IF;
  IF r.entregues    <> 3 THEN RAISE EXCEPTION 'FALHA entregues: esperava 3 (s2,s3,s5), veio %', r.entregues; END IF;
  IF r.lidos        <> 1 THEN RAISE EXCEPTION 'FALHA lidos: esperava 1 (s3), veio %', r.lidos; END IF;
  IF r.falhas       <> 1 THEN RAISE EXCEPTION 'FALHA falhas: esperava 1 (s4), veio %', r.falhas; END IF;
  IF r.respondidos  <> 1 THEN RAISE EXCEPTION 'FALHA respondidos: esperava 1 (só s2 — anterior/30h não contam), veio %', r.respondidos; END IF;
  IF r.propostas    <> 2 THEN RAISE EXCEPTION 'FALHA propostas: esperava 2 (o1,o2 — sem elo/fora do período não contam), veio %', r.propostas; END IF;
  IF r.pedidos_omie <> 1 THEN RAISE EXCEPTION 'FALHA pedidos_omie: esperava 1 (o1 — o3 sem elo é TELEFONE), veio %', r.pedidos_omie; END IF;
  IF r.receita_omie IS DISTINCT FROM 1000 THEN RAISE EXCEPTION 'FALHA receita: esperava 1000 (só o1), veio %', r.receita_omie; END IF;
END $$;
ROLLBACK;

-- período curto (p_dias=1... sends de 2-3d ficam fora; s5/s6 de 1d: borda now()-1d NÃO > inicio)
BEGIN;
SET LOCAL ROLE authenticated;
SET LOCAL request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000aaaa1","role":"authenticated"}';
DO $$ DECLARE r record; BEGIN
  SELECT * INTO r FROM public.get_whatsapp_funil(2);
  IF r.enviados <> 1 THEN RAISE EXCEPTION 'FALHA período: p_dias=2 esperava 1 enviado (s5), veio %', r.enviados; END IF;
END $$;
ROLLBACK;

-- não-staff: RLS fail-closed → tudo 0 (sends/messages staff-only; sem orders próprios)
BEGIN;
SET LOCAL ROLE authenticated;
SET LOCAL request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000bbbb2","role":"authenticated"}';
DO $$ DECLARE r record; BEGIN
  SELECT * INTO r FROM public.get_whatsapp_funil(30);
  IF r.enviados <> 0 OR r.respondidos <> 0 OR r.propostas <> 0
    THEN RAISE EXCEPTION 'FALHA RLS: não-staff viu enviados=% respondidos=% propostas=%', r.enviados, r.respondidos, r.propostas; END IF;
END $$;
ROLLBACK;

-- anon: EXECUTE revogado por nome → 42501
BEGIN;
SET LOCAL ROLE anon;
DO $$ DECLARE n bigint; BEGIN
  SELECT enviados INTO n FROM public.get_whatsapp_funil(30);
  RAISE EXCEPTION 'FALHA: anon EXECUTOU a RPC do funil';
EXCEPTION WHEN insufficient_privilege THEN RAISE NOTICE 'ok: anon negado 42501'; END $$;
ROLLBACK;
SQL

echo "→ FALSIFICAÇÃO: RPC sabotada SEM exigir o elo (atribuição por junk) → assert TEM de ficar vermelho…"
P -v ON_ERROR_STOP=1 -q <<'SQL'
CREATE OR REPLACE FUNCTION public.get_whatsapp_funil(p_dias int DEFAULT 30)
RETURNS TABLE (enviados bigint, entregues bigint, lidos bigint, falhas bigint,
               respondidos bigint, propostas bigint, pedidos_omie bigint, receita_omie numeric)
LANGUAGE sql STABLE SECURITY INVOKER SET search_path TO 'public'
AS $$
  SELECT 4::bigint, 3::bigint, 1::bigint, 1::bigint, 1::bigint,
         count(*),
         count(*) FILTER (WHERE o.omie_pedido_id IS NOT NULL),
         sum(o.total) FILTER (WHERE o.omie_pedido_id IS NOT NULL)
    FROM public.sales_orders o
   WHERE o.created_at >= now() - make_interval(days => p_dias);  -- SABOTADO: sem exigir o elo
$$;
SQL
if P -v ON_ERROR_STOP=1 -q >/dev/null 2>&1 <<'SQL'
BEGIN;
SET LOCAL ROLE authenticated;
SET LOCAL request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000aaaa1","role":"authenticated"}';
DO $$ DECLARE r record; BEGIN
  SELECT * INTO r FROM public.get_whatsapp_funil(30);
  IF r.pedidos_omie <> 1 THEN RAISE EXCEPTION 'sabotagem detectada (pedidos=%)' , r.pedidos_omie; END IF;
END $$;
ROLLBACK;
SQL
then
  echo "✗ FALSIFICAÇÃO FALHOU: RPC sem elo passou no assert (pedido de TELEFONE contaria como WhatsApp)"; exit 1
else
  echo "ok: sem o elo o assert fica vermelho — a atribuição conservadora morde"
fi
P -v ON_ERROR_STOP=1 -q -f "$REPO_ROOT/supabase/migrations/20260713030000_whatsapp_funil.sql" >/dev/null

echo "✅ prova PG17 do PR-3 funil: verde (estágios, janela 24h, elo explícito, período, RLS, falsificação)"
