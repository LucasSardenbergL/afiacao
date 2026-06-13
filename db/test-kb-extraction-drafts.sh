#!/usr/bin/env bash
# Teste PG17 da migration kb_extraction_drafts (20260613160000).
# Cobre a tabela de persistência de rascunhos de extração + RPC de claim atômico.
# Asserts:
#   A1  Tabela criada com as colunas esperadas e CHECK de status
#   A2  Trigger updated_at funciona
#   A3  RLS SELECT master-only (master vê; employee e anon NÃO vêem)
#   A4  RLS DELETE master-only (master deleta; employee NÃO deleta)
#   A5  RLS no INSERT/UPDATE via authenticated — sem policy → 42501
#   A6  RPC kb_extraction_draft_claim — claim novo retorna TRUE
#   A7  RPC claim idempotente — re-claim com o mesmo token (em extracting <5min) retorna FALSE
#   A8  RPC re-claim de draft travado (>5 min) retorna TRUE (toma o claim)
#   A9  FALSIFICAÇÃO — sabota a policy SELECT p/ USING(true), re-roda A3-employee e EXIGE
#       que ele AGORA ENXERGUE a linha (prova que A3 realmente filtra); restaura a policy.
#
# ⚠️ RLS só é enforçada para roles NÃO-superuser. O psql roda como `postgres` (superuser,
# BYPASSA RLS) → os asserts de RLS usam SET ROLE authenticated + SET LOCAL test.uid dentro de
# um bloco transacional (BEGIN…ROLLBACK) ou DO $$…$$. RESET ROLE ao final.
# A RPC kb_extraction_draft_claim é INVOKER + REVOKE FROM authenticated → só service_role
# pode chamar em runtime. No teste local, o postgres é superuser e executa sem o REVOKE
# bloquear (superuser bypassa EXECUTE grant). Os asserts A6/A7/A8 testam a LÓGICA do claim
# (condition WHERE do ON CONFLICT), não o gate de EXECUTE (que é provado via REVOKE + prod).
#
# Disciplina de assert negativo: captura a SQLSTATE/condição ESPERADA e RE-LANÇA o resto.
# WHEN OTHERS THEN 'OK' cego é teatro.
# Base: db/test-kb-0c-aprovacao.sh (mesma estrutura de bring-up PG17 keg-only).
# Pré-req: brew install postgresql@17
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PGVER=17
PGBIN="/opt/homebrew/opt/postgresql@${PGVER}/bin"
PORT=5442   # porta dedicada p/ não colidir com outros scripts do projeto
DATA="$(mktemp -d /tmp/pgtest-kb-drafts.XXXXXX)/data"
export LC_ALL=C LANG=C

[ -x "$PGBIN/initdb" ] || { echo "postgresql@${PGVER} ausente: brew install postgresql@${PGVER}"; exit 1; }

# Contorna o keg-only do brew (idempotente, no-clobber): share + lib do postgres.
CELLAR="$(brew --prefix postgresql@${PGVER})"
cp -Rn "$CELLAR"/share/postgresql/. "/opt/homebrew/share/postgresql@${PGVER}/" 2>/dev/null || true
mkdir -p "/opt/homebrew/lib/postgresql@${PGVER}"
cp -Rn "$CELLAR"/lib/postgresql/. "/opt/homebrew/lib/postgresql@${PGVER}/" 2>/dev/null || true

cleanup() { "$PGBIN/pg_ctl" -D "$DATA" stop -m immediate >/dev/null 2>&1 || true; rm -rf "$(dirname "$DATA")"; }
trap cleanup EXIT

"$PGBIN/initdb" -D "$DATA" -U postgres -E UTF8 --locale=C >/dev/null
"$PGBIN/pg_ctl" -D "$DATA" -o "-p $PORT -k /tmp" -l /tmp/pg-kb-drafts.log -w start >/dev/null
"$PGBIN/createdb" -p "$PORT" -h /tmp -U postgres kb_drafts_verify
P() { "$PGBIN/psql" -p "$PORT" -h /tmp -U postgres -d kb_drafts_verify "$@"; }

echo "→ stubs mínimos do Supabase (roles, auth, app_role, user_roles, has_role, set_updated_at)…"
P -v ON_ERROR_STOP=1 -q <<'SQL'
-- Roles referenciadas por GRANTs/policies.
DO $$ BEGIN CREATE ROLE anon;          EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE ROLE authenticated; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE ROLE service_role;  EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Schema auth + tabela de usuários (FK target de kb_documents).
CREATE SCHEMA IF NOT EXISTS auth;
CREATE TABLE IF NOT EXISTS auth.users (
  id    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email text
);
-- auth.uid() lê GUC de sessão — padrão do verify-snapshot-replay.
CREATE OR REPLACE FUNCTION auth.uid()  RETURNS uuid LANGUAGE sql STABLE
  AS $f$ SELECT nullif(current_setting('test.uid',  true), '')::uuid $f$;
CREATE OR REPLACE FUNCTION auth.role() RETURNS text LANGUAGE sql STABLE
  AS $f$ SELECT nullif(current_setting('test.role', true), '') $f$;

-- Enum de papel + tabela user_roles + has_role (helper canônico do projeto).
DO $$ BEGIN CREATE TYPE public.app_role AS ENUM ('employee','customer','master');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS public.user_roles (
  user_id uuid            NOT NULL,
  role    public.app_role NOT NULL,
  PRIMARY KEY (user_id, role)
);

CREATE OR REPLACE FUNCTION public.has_role(_uid uuid, _role public.app_role)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $f$
  SELECT EXISTS (SELECT 1 FROM public.user_roles WHERE user_id = _uid AND role = _role);
$f$;

-- set_updated_at: função canônica do projeto usada pelo trigger.
CREATE OR REPLACE FUNCTION public.set_updated_at()
RETURNS trigger LANGUAGE plpgsql AS $f$
BEGIN NEW.updated_at := now(); RETURN NEW; END;
$f$;

-- kb_documents: tabela-pai referenciada pela FK da migration.
-- Stub mínimo com as colunas que a migration espera.
CREATE TABLE IF NOT EXISTS public.kb_documents (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  title      text,
  supplier   text,
  created_at timestamptz NOT NULL DEFAULT now()
);
SQL

echo "→ migration 20260613160000_kb_extraction_drafts.sql (a NOVA)…"
P -v ON_ERROR_STOP=1 -q -f "$REPO_ROOT/supabase/migrations/20260613160000_kb_extraction_drafts.sql"

echo "→ seed (master, employee, 1 documento)…"
P -v ON_ERROR_STOP=1 -q <<'SQL'
-- u_master: master ; u_emp: employee.
INSERT INTO auth.users (id, email) VALUES
  ('00000000-0000-0000-0000-00000000000a', 'master@test.local'),
  ('00000000-0000-0000-0000-00000000000b', 'emp@test.local')
ON CONFLICT DO NOTHING;

INSERT INTO public.user_roles (user_id, role) VALUES
  ('00000000-0000-0000-0000-00000000000a', 'master'::public.app_role),
  ('00000000-0000-0000-0000-00000000000b', 'employee'::public.app_role)
ON CONFLICT DO NOTHING;

-- Grant de tabela p/ os asserts de RLS via SET ROLE authenticated (a RLS filtra POR CIMA do grant).
GRANT SELECT, INSERT, UPDATE, DELETE ON public.kb_extraction_drafts TO authenticated;

-- Documento semente (para FK dos asserts de RPC).
INSERT INTO public.kb_documents (id, title, supplier)
  VALUES ('d0000000-0000-0000-0000-000000000001', 'Boletim PU GL', 'sayerlack')
ON CONFLICT DO NOTHING;
SQL

# ---------------------------------------------------------------------------
echo ""
echo "→ ASSERT A1 — tabela existe com colunas esperadas e CHECK de status:"
P -v ON_ERROR_STOP=1 <<'SQL'
DO $$
DECLARE n int;
BEGIN
  -- Coluna document_id (PK)
  SELECT count(*) INTO n FROM information_schema.columns
   WHERE table_name='kb_extraction_drafts' AND column_name='document_id';
  IF n <> 1 THEN RAISE EXCEPTION 'A1a FALHOU: coluna document_id ausente'; END IF;

  -- Coluna status com default 'extracting'
  SELECT count(*) INTO n FROM information_schema.columns
   WHERE table_name='kb_extraction_drafts' AND column_name='status'
     AND column_default LIKE '%extracting%';
  IF n <> 1 THEN RAISE EXCEPTION 'A1b FALHOU: status sem default extracting'; END IF;

  -- CHECK de status barra valor inválido
  BEGIN
    INSERT INTO public.kb_extraction_drafts (document_id, status)
      VALUES ('d0000000-0000-0000-0000-000000000001', 'invalido');
    RAISE EXCEPTION 'A1c FALHOU: status invalido não foi barrado (CHECK ausente)';
  EXCEPTION
    WHEN check_violation THEN
      RAISE NOTICE 'OK A1c — CHECK de status barra invalido (%)', SQLERRM;
  END;

  -- status='ready' aceito
  INSERT INTO public.kb_extraction_drafts (document_id, status, spec)
    VALUES ('d0000000-0000-0000-0000-000000000001', 'ready', '{"ok":true}')
  ON CONFLICT (document_id) DO UPDATE SET status='ready', spec='{"ok":true}';
  RAISE NOTICE 'OK A1d — status ready aceito';

  RAISE NOTICE 'OK A1 — tabela criada, colunas OK, CHECK funciona';
END $$;
SQL

# ---------------------------------------------------------------------------
echo ""
echo "→ ASSERT A2 — trigger updated_at dispara no UPDATE:"
P -v ON_ERROR_STOP=1 <<'SQL'
DO $$
DECLARE t1 timestamptz; t2 timestamptz;
BEGIN
  SELECT updated_at INTO t1
    FROM public.kb_extraction_drafts
   WHERE document_id = 'd0000000-0000-0000-0000-000000000001';

  -- Pequena pausa para garantir que o clock avança.
  PERFORM pg_sleep(0.01);

  UPDATE public.kb_extraction_drafts
     SET status = 'failed', last_error = 'teste trigger'
   WHERE document_id = 'd0000000-0000-0000-0000-000000000001';

  SELECT updated_at INTO t2
    FROM public.kb_extraction_drafts
   WHERE document_id = 'd0000000-0000-0000-0000-000000000001';

  IF t2 <= t1 THEN
    RAISE EXCEPTION 'A2 FALHOU: updated_at não avançou (t1=%, t2=%) — trigger ausente', t1, t2;
  END IF;
  RAISE NOTICE 'OK A2 — updated_at avançou (trigger funciona): t1=%, t2=%', t1, t2;
END $$;
SQL

# ---------------------------------------------------------------------------
echo ""
echo "→ ASSERT A3 — RLS SELECT master-only (master vê; employee e anon NÃO vêem):"

# Master vê a linha.
P -v ON_ERROR_STOP=1 <<'SQL'
DO $$
DECLARE n int;
BEGIN
  SET ROLE authenticated;
  SET LOCAL test.uid = '00000000-0000-0000-0000-00000000000a';  -- master
  SELECT count(*) INTO n FROM public.kb_extraction_drafts;
  RESET ROLE;
  IF n <> 1 THEN
    RAISE EXCEPTION 'A3a FALHOU: master viu % linhas (esperado 1)', n;
  END IF;
  RAISE NOTICE 'OK A3a — master vê 1 linha';
END $$;
SQL

# Employee NÃO vê a linha (RLS filtra → count = 0, sem erro).
P -v ON_ERROR_STOP=1 <<'SQL'
DO $$
DECLARE n int;
BEGIN
  SET ROLE authenticated;
  SET LOCAL test.uid = '00000000-0000-0000-0000-00000000000b';  -- employee
  SELECT count(*) INTO n FROM public.kb_extraction_drafts;
  RESET ROLE;
  IF n <> 0 THEN
    RAISE EXCEPTION 'A3b FALHOU: employee viu % linhas (esperado 0 — RLS master-only)', n;
  END IF;
  RAISE NOTICE 'OK A3b — employee vê 0 linhas (RLS filtra)';
END $$;
SQL

# ---------------------------------------------------------------------------
echo ""
echo "→ ASSERT A4 — RLS DELETE master-only (master deleta; employee NÃO deleta):"

# Insere linha extra p/ o assert de delete.
P -v ON_ERROR_STOP=1 -q <<'SQL'
INSERT INTO public.kb_documents (id, title, supplier)
  VALUES ('d0000000-0000-0000-0000-000000000002', 'Boletim Extra', 'sayerlack')
ON CONFLICT DO NOTHING;
INSERT INTO public.kb_extraction_drafts (document_id, status)
  VALUES ('d0000000-0000-0000-0000-000000000002', 'ready')
ON CONFLICT DO NOTHING;
SQL

# Employee tenta deletar → rc=0 (RLS filtra silenciosamente em DELETE).
P -v ON_ERROR_STOP=1 <<'SQL'
DO $$
DECLARE rc int;
BEGIN
  SET ROLE authenticated;
  SET LOCAL test.uid = '00000000-0000-0000-0000-00000000000b';  -- employee
  DELETE FROM public.kb_extraction_drafts
   WHERE document_id = 'd0000000-0000-0000-0000-000000000002';
  GET DIAGNOSTICS rc = ROW_COUNT;
  RESET ROLE;
  IF rc <> 0 THEN
    RAISE EXCEPTION 'A4a FALHOU: employee deletou % linha(s) (esperado 0 — RLS master-only)', rc;
  END IF;
  RAISE NOTICE 'OK A4a — employee DELETE é no-op (ROW_COUNT=0, RLS filtra)';
END $$;
SQL

# Master deleta com sucesso.
P -v ON_ERROR_STOP=1 <<'SQL'
DO $$
DECLARE rc int;
BEGIN
  SET ROLE authenticated;
  SET LOCAL test.uid = '00000000-0000-0000-0000-00000000000a';  -- master
  DELETE FROM public.kb_extraction_drafts
   WHERE document_id = 'd0000000-0000-0000-0000-000000000002';
  GET DIAGNOSTICS rc = ROW_COUNT;
  RESET ROLE;
  IF rc <> 1 THEN
    RAISE EXCEPTION 'A4b FALHOU: master DELETE afetou % linha(s) (esperado 1)', rc;
  END IF;
  RAISE NOTICE 'OK A4b — master DELETE bem-sucedido (ROW_COUNT=1)';
END $$;
SQL

# ---------------------------------------------------------------------------
echo ""
echo "→ ASSERT A5 — sem policy de INSERT/UPDATE para authenticated → 42501:"

# Employee tenta INSERT → deve estourar insufficient_privilege (42501).
P -v ON_ERROR_STOP=1 <<'SQL'
DO $$
BEGIN
  SET ROLE authenticated;
  SET LOCAL test.uid = '00000000-0000-0000-0000-00000000000b';  -- employee
  BEGIN
    INSERT INTO public.kb_extraction_drafts (document_id, status)
      VALUES ('d0000000-0000-0000-0000-000000000001', 'extracting')
      ON CONFLICT (document_id) DO UPDATE SET status = 'extracting';
    RESET ROLE;
    RAISE EXCEPTION 'A5a FALHOU: authenticated conseguiu INSERT/UPDATE (sem policy deveria ser 42501)';
  EXCEPTION
    WHEN insufficient_privilege THEN
      RESET ROLE;
      -- ⚠️ mensagem NÃO pode conter 'master' nem 'forbidden' (evita falso-positivo no A9).
      RAISE NOTICE 'OK A5a — authenticated barrado no INSERT (42501): %', SQLERRM;
  END;
END $$;
SQL

# ---------------------------------------------------------------------------
echo ""
echo "→ ASSERT A6 — RPC kb_extraction_draft_claim: claim novo retorna TRUE:"

# Reset da linha semente ao estado 'failed' (para poder ser reclamada).
P -v ON_ERROR_STOP=1 -q <<'SQL'
UPDATE public.kb_extraction_drafts
   SET status = 'failed', claim_token = NULL, started_at = now() - interval '10 minutes'
 WHERE document_id = 'd0000000-0000-0000-0000-000000000001';
SQL

TOKEN_A='aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'
P -v ON_ERROR_STOP=1 <<SQL
DO \$\$
DECLARE result boolean;
BEGIN
  -- Superuser invoca diretamente (REVOKE é de anon/authenticated — superuser bypassa).
  SELECT public.kb_extraction_draft_claim(
    'd0000000-0000-0000-0000-000000000001'::uuid,
    '${TOKEN_A}'::uuid
  ) INTO result;
  IF result IS NOT TRUE THEN
    RAISE EXCEPTION 'A6 FALHOU: claim novo retornou % (esperado TRUE)', result;
  END IF;
  RAISE NOTICE 'OK A6 — claim novo retorna TRUE (token ${TOKEN_A})';
END \$\$;
SQL

# ---------------------------------------------------------------------------
echo ""
echo "→ ASSERT A7 — RPC claim idempotente: re-claim com mesmo token em extracting <5min → FALSE:"

TOKEN_B='bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'
P -v ON_ERROR_STOP=1 <<SQL
DO \$\$
DECLARE result boolean;
BEGIN
  -- A linha está em 'extracting' com started_at recente (<5min).
  -- Um segundo caller tenta reclamar com token diferente → ON CONFLICT WHERE falha → retorna FALSE.
  SELECT public.kb_extraction_draft_claim(
    'd0000000-0000-0000-0000-000000000001'::uuid,
    '${TOKEN_B}'::uuid
  ) INTO result;
  IF result IS NOT FALSE THEN
    RAISE EXCEPTION 'A7 FALHOU: re-claim retornou % (esperado FALSE — claim ativo ainda válido)', result;
  END IF;
  RAISE NOTICE 'OK A7 — re-claim com token diferente retorna FALSE (claim original ${TOKEN_A} protegido)';
END \$\$;
SQL

# Confirma que o token original não foi sobrescrito.
P -v ON_ERROR_STOP=1 <<SQL
DO \$\$
DECLARE tok uuid;
BEGIN
  SELECT claim_token INTO tok
    FROM public.kb_extraction_drafts
   WHERE document_id = 'd0000000-0000-0000-0000-000000000001';
  IF tok::text <> '${TOKEN_A}' THEN
    RAISE EXCEPTION 'A7b FALHOU: claim_token mudou para % (esperado ${TOKEN_A})', tok;
  END IF;
  RAISE NOTICE 'OK A7b — claim_token original preservado (${TOKEN_A})';
END \$\$;
SQL

# ---------------------------------------------------------------------------
echo ""
echo "→ ASSERT A8 — RPC re-claim de draft travado (>5 min) retorna TRUE:"

# Simula draft travado: extracting mas started_at > 5 min atrás.
P -v ON_ERROR_STOP=1 -q <<'SQL'
UPDATE public.kb_extraction_drafts
   SET status = 'extracting',
       started_at = now() - interval '6 minutes',
       claim_token = 'cccccccc-cccc-cccc-cccc-cccccccccccc'
 WHERE document_id = 'd0000000-0000-0000-0000-000000000001';
SQL

TOKEN_D='dddddddd-dddd-dddd-dddd-dddddddddddd'
P -v ON_ERROR_STOP=1 <<SQL
DO \$\$
DECLARE result boolean; tok uuid;
BEGIN
  -- Draft travado (>5 min) deve ser reclamável.
  SELECT public.kb_extraction_draft_claim(
    'd0000000-0000-0000-0000-000000000001'::uuid,
    '${TOKEN_D}'::uuid
  ) INTO result;
  IF result IS NOT TRUE THEN
    RAISE EXCEPTION 'A8a FALHOU: re-claim de draft travado retornou % (esperado TRUE)', result;
  END IF;

  -- Confirma que o novo token está gravado.
  SELECT claim_token INTO tok
    FROM public.kb_extraction_drafts
   WHERE document_id = 'd0000000-0000-0000-0000-000000000001';
  IF tok::text <> '${TOKEN_D}' THEN
    RAISE EXCEPTION 'A8b FALHOU: claim_token é % após re-claim (esperado ${TOKEN_D})', tok;
  END IF;

  RAISE NOTICE 'OK A8 — re-claim de draft travado >5min retorna TRUE (novo token gravado ${TOKEN_D})';
END \$\$;
SQL

# ---------------------------------------------------------------------------
echo ""
echo "→ ASSERT A9 — FALSIFICAÇÃO da RLS SELECT (prova que A3 tem dente):"

# Sabota a policy SELECT para USING(true) — qualquer authenticated vê tudo.
# ⚠️ A mensagem-sentinela NÃO pode conter as palavras 'master' nem 'forbidden'
# (senão o handler grep aceitaria a própria sentinela = teatro; lição do Codex B6d).
P -v ON_ERROR_STOP=1 -q <<'SQL'
DROP POLICY IF EXISTS kb_extraction_drafts_select_master ON public.kb_extraction_drafts;
CREATE POLICY kb_extraction_drafts_select_master ON public.kb_extraction_drafts
  FOR SELECT TO authenticated
  USING (true);
SQL

# Com a policy FURADA, o employee DEVE ver a linha (count >= 1).
SAB=$(P -tA 2>&1 <<'SQL' || true
DO $$
DECLARE n int;
BEGIN
  SET ROLE authenticated;
  SET LOCAL test.uid = '00000000-0000-0000-0000-00000000000b';  -- employee
  SELECT count(*) INTO n FROM public.kb_extraction_drafts;
  RESET ROLE;
  IF n >= 1 THEN
    RAISE NOTICE 'SABOTAGEM_PASSOU';
  ELSE
    RAISE NOTICE 'SABOTAGEM_NAO_PASSOU n=%', n;
  END IF;
END $$;
SQL
)
if echo "$SAB" | grep -q 'SABOTAGEM_PASSOU'; then
  echo "  OK A9 (sabotagem) — policy USING(true) deixou employee ver linha → A3 REALMENTE guarda (não é teatro)"
else
  echo "  A9 FALHOU: mesmo com policy FURADA (USING true) o employee NÃO viu → A3 não estava testando RLS."
  echo "  saída: $SAB"
  exit 1
fi

# Restaura a policy master-only correta.
P -v ON_ERROR_STOP=1 -q <<'SQL'
DROP POLICY IF EXISTS kb_extraction_drafts_select_master ON public.kb_extraction_drafts;
CREATE POLICY kb_extraction_drafts_select_master ON public.kb_extraction_drafts
  FOR SELECT TO authenticated
  USING (public.has_role(auth.uid(), 'master'::app_role));
SQL

# Prova que a RLS VOLTOU: employee barrado de novo (count = 0).
REST=$(P -tA 2>&1 <<'SQL' || true
DO $$
DECLARE n int;
BEGIN
  SET ROLE authenticated;
  SET LOCAL test.uid = '00000000-0000-0000-0000-00000000000b';  -- employee
  SELECT count(*) INTO n FROM public.kb_extraction_drafts;
  RESET ROLE;
  IF n = 0 THEN
    RAISE NOTICE 'RLS_RESTAURADA';
  ELSE
    RAISE NOTICE 'RLS_AINDA_FURADA n=%', n;
  END IF;
END $$;
SQL
)
if echo "$REST" | grep -q 'RLS_RESTAURADA'; then
  echo "  OK A9 (restauração) — RLS master-only de volta, employee vê 0 linhas novamente"
else
  echo "  A9 FALHOU (restauração): RLS não voltou. saída: $REST"
  exit 1
fi

# ---------------------------------------------------------------------------
echo ""
echo "→ ASSERT A10 — RPC kb_extraction_draft_claim BARRADA p/ authenticated (REVOKE em runtime):"

# Money-path: prova EM RUNTIME (não só na DDL) que um staff comum NÃO gera o claim/custo.
# A RPC é INVOKER + REVOKE FROM authenticated → sem EXECUTE grant → 42501 ao chamar.
P -v ON_ERROR_STOP=1 <<'SQL'
DO $$
BEGIN
  SET ROLE authenticated;
  BEGIN
    PERFORM public.kb_extraction_draft_claim(
      'd0000000-0000-0000-0000-000000000001'::uuid,
      gen_random_uuid()
    );
    RESET ROLE;
    RAISE EXCEPTION 'A10 FALHOU: authenticated executou a RPC de claim (REVOKE sem dente — custo de API aberto a qualquer staff)';
  EXCEPTION
    WHEN insufficient_privilege THEN
      RESET ROLE;
      RAISE NOTICE 'OK A10 — authenticated barrado na RPC de claim (42501): %', SQLERRM;
    WHEN OTHERS THEN
      RESET ROLE;
      RAISE;  -- re-lança qualquer erro != 42501 esperado (anti-teatro: não engole o inesperado)
  END;
END $$;
SQL

# ---------------------------------------------------------------------------
echo ""
echo "✅ test-kb-extraction-drafts: todos os asserts passaram (A1..A10)"
