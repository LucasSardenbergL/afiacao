#!/usr/bin/env bash
# Prova PG17 do núcleo HSM (migration 20260713010000_whatsapp_templates_hsm):
# - positivo: seed do catálogo + INSERT de envio com FK real;
# - dedupe: 2º INSERT com a MESMA dedupe_key → unique_violation (23505), capturada
#   ESPECIFICAMENTE (nunca WHEN OTHERS — teatro);
# - CHECKs: categoria/status inválidos → check_violation (23514);
# - RLS sob SET ROLE authenticated + GUC request.jwt.claims (psql cru é superuser
#   e bypassaria): staff lê, não-staff não lê, authenticated NÃO escreve no log;
# - FALSIFICAÇÃO: derruba a UNIQUE e exige que o assert de dedupe fique VERMELHO
#   (prova que o teste morde; equivale a sabotar a migration nesse invariante).
#
# Base: db/test-city-norm-paridade.sh. Pré-req: brew install postgresql@17.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
export LC_ALL=en_US.UTF-8 LANG=en_US.UTF-8
PGVER=17
PGBIN="/opt/homebrew/opt/postgresql@${PGVER}/bin"
PORT=5443
DATA="$(mktemp -d /tmp/pgtest-hsm.XXXXXX)/data"

[ -x "$PGBIN/initdb" ] || { echo "postgresql@${PGVER} ausente: brew install postgresql@${PGVER}"; exit 1; }

CELLAR="$(brew --prefix postgresql@${PGVER})"
cp -Rn "$CELLAR"/share/postgresql/. "/opt/homebrew/share/postgresql@${PGVER}/" 2>/dev/null || true
mkdir -p "/opt/homebrew/lib/postgresql@${PGVER}"
cp -Rn "$CELLAR"/lib/postgresql/. "/opt/homebrew/lib/postgresql@${PGVER}/" 2>/dev/null || true

cleanup() { "$PGBIN/pg_ctl" -D "$DATA" stop -m immediate >/dev/null 2>&1 || true; rm -rf "$(dirname "$DATA")"; rm -f "${RR:-}"; }
trap cleanup EXIT

"$PGBIN/initdb" -D "$DATA" -U postgres -E UTF8 --locale=en_US.UTF-8 >/dev/null
"$PGBIN/pg_ctl" -D "$DATA" -o "-p $PORT -k /tmp" -l /tmp/pg-hsm.log -w start >/dev/null
"$PGBIN/createdb" -p "$PORT" -h /tmp -U postgres hsm_verify
P() { "$PGBIN/psql" -p "$PORT" -h /tmp -U postgres -d hsm_verify "$@"; }

RR="$(mktemp "${TMPDIR:-/tmp}/snap-hsm.XXXXXX")"
sed -E 's/^(CREATE SCHEMA public;)/-- \1/' "$REPO_ROOT/supabase/schema-snapshot.sql" \
  | grep -vE '^\\(un)?restrict ' > "$RR"

echo "→ stubs + prelude + snapshot…"
P -v ON_ERROR_STOP=1 -q -f "$REPO_ROOT/db/stubs-supabase.sql"
P -v ON_ERROR_STOP=1 -q -f "$REPO_ROOT/supabase/schema-extensions-prelude.sql"
P --single-transaction -v ON_ERROR_STOP=1 -q -f "$RR"
rm -f "$RR"

echo "→ migration 20260713010000 (catálogo + log HSM)…"
P -v ON_ERROR_STOP=1 -q -f "$REPO_ROOT/supabase/migrations/20260713010000_whatsapp_templates_hsm.sql" >/dev/null

echo "→ asserts positivos + negativos (SQLSTATE específica)…"
P -v ON_ERROR_STOP=1 -q <<'SQL'
-- seed presente?
DO $$ DECLARE n int; BEGIN
  SELECT count(*) INTO n FROM public.whatsapp_templates WHERE nome IN ('colacor_proposta_recompra','colacor_status_pedido');
  IF n <> 2 THEN RAISE EXCEPTION 'FALHA: seed do catálogo ausente (n=%)', n; END IF;
END $$;

-- conversa de teste (FK real)
INSERT INTO public.whatsapp_conversations (id, phone_key, phone_e164, status)
VALUES ('00000000-0000-0000-0000-00000000c0f1', '37999990000', '5537999990000', 'aberta');

-- envio ok
INSERT INTO public.whatsapp_template_sends (template_nome, conversation_id, phone_e164, body_params, dedupe_key, origem)
VALUES ('colacor_status_pedido', '00000000-0000-0000-0000-00000000c0f1', '5537999990000', '["Ana","42","sai amanhã"]'::jsonb, 'k1', 'status_pedido');

-- dedupe: duplicata → 23505 (capturar ESPECÍFICO; re-lança qualquer outro erro)
DO $$ BEGIN
  INSERT INTO public.whatsapp_template_sends (template_nome, phone_e164, dedupe_key)
  VALUES ('colacor_status_pedido', '5537999990000', 'k1');
  RAISE EXCEPTION 'FALHA: duplicata de dedupe_key foi ACEITA';
EXCEPTION WHEN unique_violation THEN RAISE NOTICE 'ok: dedupe 23505'; END $$;

-- categoria inválida → 23514
DO $$ BEGIN
  INSERT INTO public.whatsapp_templates (nome, categoria, corpo_referencia) VALUES ('x_invalido', 'promo', 'x');
  RAISE EXCEPTION 'FALHA: categoria inválida ACEITA';
EXCEPTION WHEN check_violation THEN RAISE NOTICE 'ok: categoria 23514'; END $$;

-- status inválido → 23514
DO $$ BEGIN
  INSERT INTO public.whatsapp_template_sends (template_nome, phone_e164, dedupe_key, status)
  VALUES ('colacor_status_pedido', '5537999990000', 'k2', 'zumbi');
  RAISE EXCEPTION 'FALHA: status inválido ACEITO';
EXCEPTION WHEN check_violation THEN RAISE NOTICE 'ok: status 23514'; END $$;

-- template FK: envio de template inexistente → 23503
DO $$ BEGIN
  INSERT INTO public.whatsapp_template_sends (template_nome, phone_e164, dedupe_key)
  VALUES ('nao_existe', '5537999990000', 'k3');
  RAISE EXCEPTION 'FALHA: template inexistente ACEITO';
EXCEPTION WHEN foreign_key_violation THEN RAISE NOTICE 'ok: FK 23503'; END $$;
SQL

echo "→ RLS sob SET ROLE authenticated (psql cru bypassaria)…"
P -v ON_ERROR_STOP=1 -q <<'SQL'
-- identidades: staff (employee) e não-staff
INSERT INTO auth.users (id) VALUES
  ('00000000-0000-0000-0000-0000000aaaa1'),
  ('00000000-0000-0000-0000-0000000bbbb2')
ON CONFLICT (id) DO NOTHING;
INSERT INTO public.user_roles (user_id, role) VALUES ('00000000-0000-0000-0000-0000000aaaa1', 'employee');

-- staff vê o catálogo
BEGIN;
SET LOCAL ROLE authenticated;
SET LOCAL request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000aaaa1","role":"authenticated"}';
DO $$ DECLARE n int; BEGIN
  SELECT count(*) INTO n FROM public.whatsapp_templates;
  IF n < 2 THEN RAISE EXCEPTION 'FALHA RLS: staff deveria ver o catálogo (n=%)', n; END IF;
  SELECT count(*) INTO n FROM public.whatsapp_template_sends;
  IF n < 1 THEN RAISE EXCEPTION 'FALHA RLS: staff deveria ver o log (n=%)', n; END IF;
END $$;
ROLLBACK;

-- não-staff NÃO vê nada
BEGIN;
SET LOCAL ROLE authenticated;
SET LOCAL request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000bbbb2","role":"authenticated"}';
DO $$ DECLARE n int; BEGIN
  SELECT count(*) INTO n FROM public.whatsapp_templates;
  IF n <> 0 THEN RAISE EXCEPTION 'FALHA RLS: não-staff vê o catálogo (n=%)', n; END IF;
  SELECT count(*) INTO n FROM public.whatsapp_template_sends;
  IF n <> 0 THEN RAISE EXCEPTION 'FALHA RLS: não-staff vê o log (n=%)', n; END IF;
END $$;
ROLLBACK;

-- authenticated (mesmo staff) NÃO escreve no log — escrita é da edge (service_role)
BEGIN;
SET LOCAL ROLE authenticated;
SET LOCAL request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000aaaa1","role":"authenticated"}';
DO $$ BEGIN
  INSERT INTO public.whatsapp_template_sends (template_nome, phone_e164, dedupe_key)
  VALUES ('colacor_status_pedido', 'x', 'k-rls');
  RAISE EXCEPTION 'FALHA RLS: authenticated conseguiu ESCREVER no log';
EXCEPTION WHEN insufficient_privilege THEN RAISE NOTICE 'ok: escrita negada 42501'; END $$;
ROLLBACK;
SQL

echo "→ FALSIFICAÇÃO: derrubar a UNIQUE e exigir o assert VERMELHO…"
P -q -c "ALTER TABLE public.whatsapp_template_sends DROP CONSTRAINT whatsapp_template_sends_dedupe_key_key;"
if P -v ON_ERROR_STOP=1 -q >/dev/null 2>&1 <<'SQL'
DO $$ BEGIN
  INSERT INTO public.whatsapp_template_sends (template_nome, phone_e164, dedupe_key)
  VALUES ('colacor_status_pedido', '5537999990000', 'k1');
  RAISE EXCEPTION 'DUPLICATA ACEITA (esperado sem a UNIQUE)';
EXCEPTION WHEN unique_violation THEN NULL; END $$;
SQL
then
  echo "✗ FALSIFICAÇÃO FALHOU: assert de dedupe continuou verde SEM a constraint (teste não morde)"; exit 1
else
  echo "ok: sem a UNIQUE o assert fica vermelho — o teste morde"
fi

echo "✅ prova PG17 do núcleo HSM: verde (dedupe, CHECKs, FK, RLS, falsificação)"
