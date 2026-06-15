#!/usr/bin/env bash
# Teste PG17 LOCAL com FALSIFICAÇÃO das 2 migrations de hardening de segurança:
#   1) 20260613170000_fix_auto_assign_master_escalation.sql
#        — remove o ramo que concedia 'master' por NEW.document == company_config.master_cnpj
#          (privilege escalation app-wide via a policy de self-insert de profiles).
#   2) 20260613180000_kb_hardening_codex.sql
#        A: GRANT EXECUTE kb_extraction_draft_claim → service_role (a edge voltou a executar pós-REVOKE).
#        C: aprovar_versao_boletim — ON CONFLICT pela identidade COMPOSTA (supplier, product_code_normalized).
#        D: REVOKE INSERT/UPDATE/DELETE/TRUNCATE em kb_product_specs FROM authenticated (escrita só via RPC).
#        E: índice "1 viva" + trigger append-only de verdade (BEFORE UPDATE OR DELETE; rejeita DELETE/reviver).
#
# Asserts (com FALSIFICAÇÃO — disciplina anti-teatro do projeto):
#   B1  fix aplicado → self-insert com document == master_cnpj NÃO vira master (cai em customer).
#   B2  FALSIFICAÇÃO → recria o trigger ANTIGO (com o ramo master) → o MESMO insert vira master
#       → PROVA o dente do B1 → re-aplica a migration e confirma que volta a NÃO conceder master.
#   A   service_role executa kb_extraction_draft_claim (prova GRANT); authenticated → 42501 (REVOKE intacto).
#   C1  re-aprovar o mesmo produto com caixa/espaço (normaliza igual) → UPDATE da mesma linha + v2 (sem 23505).
#   C2  aprovar supplier DIFERENTE mas mesmo product_code textual → 23505 (UNIQUE global product_code).
#   D   authenticated (master) → INSERT/UPDATE/DELETE em kb_product_specs = 42501; SELECT OK (REVOKE de tabela).
#   E1  2 versões superseded_at NULL p/ a mesma identidade → 2ª dá 23505 (kbv_uma_viva).
#   E2  DELETE numa kb_product_spec_versions → RAISE (append-only) + FALSIFICAÇÃO do trigger.
#   E3  UPDATE superseded_at de NOT NULL → NULL → RAISE (não reviver).
#
# Disciplina:
#   - Asserts negativos capturam a SQLSTATE/mensagem esperada e RE-LANÇAM o resto (WHEN OTHERS → RAISE).
#   - WHEN OTHERS THEN 'OK' cego é teatro.
#   - RLS/grants só são enforçados p/ roles NÃO-superuser → asserts de RLS/REVOKE usam SET ROLE + GUC test.uid.
#   - service_role recebe BYPASSRLS (espelha o admin role do Supabase) p/ o claim INVOKER inserir sem policy.
#
# Base: db/test-kb-spec-versions.sh + db/test-kb-0c-aprovacao.sh (mesma estrutura keg-only PG17).
# Pré-req: brew install postgresql@17 pgvector.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PGVER=17
PGBIN="/opt/homebrew/opt/postgresql@${PGVER}/bin"
PORT=5448   # porta dedicada — não colide com outros scripts (até 5447 em uso)
DATA="$(mktemp -d /tmp/pgtest-kb-hard.XXXXXX)/data"
# ⚠️ en_US.UTF-8 no cluster E no processo (NÃO LC_ALL=C): casa o locale de prod do Supabase.
export LC_ALL=en_US.UTF-8 LANG=en_US.UTF-8

[ -x "$PGBIN/initdb" ] || { echo "postgresql@${PGVER} ausente: brew install postgresql@${PGVER} pgvector"; exit 1; }

# Contorna keg-only do brew (idempotente, no-clobber): share + lib do postgres.
CELLAR="$(brew --prefix postgresql@${PGVER})"
cp -Rn "$CELLAR"/share/postgresql/. "/opt/homebrew/share/postgresql@${PGVER}/" 2>/dev/null || true
mkdir -p "/opt/homebrew/lib/postgresql@${PGVER}"
cp -Rn "$CELLAR"/lib/postgresql/. "/opt/homebrew/lib/postgresql@${PGVER}/" 2>/dev/null || true

# pgvector: o dylib + extensão do brew não ficam linkados no pg17 — copia (no-clobber).
PGVEC="$(brew --prefix pgvector 2>/dev/null || true)"
if [ -n "$PGVEC" ]; then
  cp -n "$PGVEC"/lib/postgresql@${PGVER}/vector.dylib "/opt/homebrew/lib/postgresql@${PGVER}/" 2>/dev/null || true
  cp -Rn "$PGVEC"/share/postgresql@${PGVER}/extension/. "/opt/homebrew/share/postgresql@${PGVER}/extension/" 2>/dev/null || true
fi

cleanup() { "$PGBIN/pg_ctl" -D "$DATA" stop -m immediate >/dev/null 2>&1 || true; rm -rf "$(dirname "$DATA")"; }
trap cleanup EXIT

"$PGBIN/initdb" -D "$DATA" -U postgres -E UTF8 --locale=en_US.UTF-8 >/dev/null
"$PGBIN/pg_ctl" -D "$DATA" -o "-p $PORT -k /tmp" -l /tmp/pg-kb-hard.log -w start >/dev/null
"$PGBIN/createdb" -p "$PORT" -h /tmp -U postgres kbhard_verify
P() { "$PGBIN/psql" -p "$PORT" -h /tmp -U postgres -d kbhard_verify "$@"; }

# ───────────────────────────────────────────────────────────────────────────────
echo "→ stubs do Supabase (roles, auth, app_role, user_roles, has_role, storage, omie_products)…"
P -v ON_ERROR_STOP=1 -q <<'SQL'
-- Roles referenciadas por GRANTs/policies. service_role com BYPASSRLS (= admin role do Supabase).
DO $$ BEGIN CREATE ROLE anon          NOLOGIN;            EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE ROLE authenticated NOLOGIN;            EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE ROLE service_role  NOLOGIN BYPASSRLS;  EXCEPTION WHEN duplicate_object THEN NULL; END $$;
ALTER ROLE service_role BYPASSRLS;  -- idempotente: garante o atributo mesmo se a role já existia

-- Schema auth + tabela de usuários (FK target de kb_documents/specs/links/profiles).
CREATE SCHEMA IF NOT EXISTS auth;
CREATE TABLE IF NOT EXISTS auth.users (
  id    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email text
);
-- auth.uid() lê um GUC de sessão (impersonação de teste) — padrão do verify-snapshot-replay.
CREATE OR REPLACE FUNCTION auth.uid()  RETURNS uuid LANGUAGE sql STABLE AS $f$ SELECT nullif(current_setting('test.uid',  true), '')::uuid $f$;
CREATE OR REPLACE FUNCTION auth.role() RETURNS text LANGUAGE sql STABLE AS $f$ SELECT nullif(current_setting('test.role', true), '') $f$;

-- Enum de papel + tabela user_roles + has_role (helper anti-recursão do projeto).
DO $$ BEGIN CREATE TYPE public.app_role AS ENUM ('employee','customer','master'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
CREATE TABLE IF NOT EXISTS public.user_roles (
  user_id uuid NOT NULL,
  role    public.app_role NOT NULL,
  PRIMARY KEY (user_id, role)
);
CREATE OR REPLACE FUNCTION public.has_role(_uid uuid, _role public.app_role)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $f$
  SELECT EXISTS (SELECT 1 FROM public.user_roles WHERE user_id = _uid AND role = _role);
$f$;

-- Schema storage + buckets/objects (kb_foundation cria bucket + policies de storage).
CREATE SCHEMA IF NOT EXISTS storage;
CREATE TABLE IF NOT EXISTS storage.buckets (
  id text PRIMARY KEY, name text, public boolean
);
CREATE TABLE IF NOT EXISTS storage.objects (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  bucket_id text,
  name text
);
ALTER TABLE storage.objects ENABLE ROW LEVEL SECURITY;

-- set_updated_at: trigger-helper canônico do projeto (kb_extraction_drafts usa).
CREATE OR REPLACE FUNCTION public.set_updated_at()
RETURNS trigger LANGUAGE plpgsql AS $f$
BEGIN NEW.updated_at := now(); RETURN NEW; END;
$f$;

-- omie_products (stub mínimo: confirmar_vinculo (P2-a) lê).
CREATE TABLE IF NOT EXISTS public.omie_products (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account             text NOT NULL,
  omie_codigo_produto bigint NOT NULL,
  codigo              text,
  descricao           text,
  ativo               boolean DEFAULT true
);
SQL

# ───────────────────────────────────────────────────────────────────────────────
echo "→ stubs do furo MASTER (profiles, company_config, auto_assign_user_role + trigger)…"
# Espelho do corpo VIVO de prod (20260612120000_auto_assign_role_omie_import_guard.sql):
# o trigger AINDA concede master por CNPJ aqui — a migration 1 (20260613170000) o remove.
P -v ON_ERROR_STOP=1 -q <<'SQL'
CREATE TABLE IF NOT EXISTS public.company_config (
  key   text PRIMARY KEY,
  value text
);
INSERT INTO public.company_config (key, value)
  VALUES ('master_cnpj', '12345678000199')
ON CONFLICT (key) DO UPDATE SET value = excluded.value;

CREATE TABLE IF NOT EXISTS public.profiles (
  user_id        uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  document       text,
  is_employee    boolean DEFAULT false,
  prospect_source text
);

-- Corpo VIVO (com o ramo master por CNPJ) — VERBATIM da 20260612120000.
CREATE OR REPLACE FUNCTION public.auto_assign_user_role() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE
  master_cnpj_value TEXT;
  profile_doc TEXT;
  existing_role app_role;
BEGIN
  IF TG_OP = 'UPDATE' THEN RETURN NEW; END IF;
  SELECT role INTO existing_role FROM public.user_roles WHERE user_id = NEW.user_id LIMIT 1;
  IF existing_role IS NOT NULL THEN RETURN NEW; END IF;
  SELECT value INTO master_cnpj_value FROM public.company_config WHERE key = 'master_cnpj';
  profile_doc := REGEXP_REPLACE(NEW.document, '\D', '', 'g');
  IF profile_doc = master_cnpj_value AND COALESCE(NEW.prospect_source, '') <> 'omie_import' THEN
    INSERT INTO public.user_roles (user_id, role) VALUES (NEW.user_id, 'master') ON CONFLICT (user_id, role) DO NOTHING;
  ELSIF NEW.is_employee = true THEN
    INSERT INTO public.user_roles (user_id, role) VALUES (NEW.user_id, 'employee') ON CONFLICT (user_id, role) DO NOTHING;
  ELSE
    INSERT INTO public.user_roles (user_id, role) VALUES (NEW.user_id, 'customer') ON CONFLICT (user_id, role) DO NOTHING;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_auto_assign_user_role ON public.profiles;
CREATE TRIGGER trg_auto_assign_user_role
  AFTER INSERT ON public.profiles
  FOR EACH ROW EXECUTE FUNCTION public.auto_assign_user_role();
SQL

echo "→ pgvector (kb_chunks usa vector(1536))…"
P -v ON_ERROR_STOP=1 -q -c "CREATE EXTENSION IF NOT EXISTS vector;"

echo "→ migrations de fundação do KB (170000, 180000, 0a, drafts, 0c, versions)…"
P -v ON_ERROR_STOP=1 -q -f "$REPO_ROOT/supabase/migrations/20260517170000_kb_foundation.sql"
P -v ON_ERROR_STOP=1 -q -f "$REPO_ROOT/supabase/migrations/20260517180000_kb_specs_and_competitors.sql"
P -v ON_ERROR_STOP=1 -q -f "$REPO_ROOT/supabase/migrations/20260611140000_kb_fundacao_casamento.sql"
P -v ON_ERROR_STOP=1 -q -f "$REPO_ROOT/supabase/migrations/20260613160000_kb_extraction_drafts.sql"
P -v ON_ERROR_STOP=1 -q -f "$REPO_ROOT/supabase/migrations/20260613120000_kb_0c_aprovacao_master_only.sql"
P -v ON_ERROR_STOP=1 -q -f "$REPO_ROOT/supabase/migrations/20260613150000_kb_spec_versions_faseA.sql"

echo "→ seed (master, employee, grants de tabela p/ authenticated, 1 sku omie, documentos)…"
P -v ON_ERROR_STOP=1 -q <<'SQL'
INSERT INTO auth.users (id, email) VALUES
  ('00000000-0000-0000-0000-00000000000a', 'master@test.local'),
  ('00000000-0000-0000-0000-00000000000b', 'emp@test.local')
ON CONFLICT DO NOTHING;

INSERT INTO public.user_roles (user_id, role) VALUES
  ('00000000-0000-0000-0000-00000000000a', 'master'::public.app_role),
  ('00000000-0000-0000-0000-00000000000b', 'employee'::public.app_role)
ON CONFLICT DO NOTHING;

-- Grants de tabela p/ os asserts de RLS via SET ROLE authenticated.
-- ⚠️ ANTES da migration 2 (BLOCO D), authenticated TEM INSERT/UPDATE/DELETE (a RLS 0c master-only filtra por cima).
-- A migration 2 REVOGA esses 3 → o assert D prova que vira 42501 de TABELA (antes da RLS).
GRANT SELECT, INSERT, UPDATE, DELETE ON public.kb_product_specs TO authenticated;
GRANT SELECT ON public.kb_product_spec_versions TO authenticated;

-- service_role no Supabase recebe ALL nas tabelas do schema public (admin role) → espelha isso.
-- A claim RPC é INVOKER e INSERTa em kb_extraction_drafts; o BUG que a migration 2 corrige é que o
-- EXECUTE da FUNÇÃO foi REVOKE'd de public (a edge não conseguia CHAMAR) — o acesso de TABELA do
-- service_role sempre existiu em prod. Sem este grant, o assert A pegaria um gap do HARNESS, não da migration.
GRANT ALL ON public.kb_extraction_drafts        TO service_role;
GRANT ALL ON public.kb_product_specs            TO service_role;
GRANT ALL ON public.kb_product_spec_versions    TO service_role;

-- SKU Omie p/ o vínculo (não usado nos asserts desta migration, mas confirmar_vinculo (0c) valida contra ele).
INSERT INTO public.omie_products (omie_codigo_produto, codigo, descricao, account, ativo)
  VALUES (8001, 'PRD8001', 'VERNIZ PU XX01.0001.00GL', 'oben', true) ON CONFLICT DO NOTHING;

-- Documentos base (FKs de source_document_id / kb_extraction_drafts).
INSERT INTO public.kb_documents (id, title, type, supplier, file_url, created_by) VALUES
  ('d1000000-0000-0000-0000-000000000001', 'Boletim C', 'boletim_tecnico', 'sayerlack', 'kb/c.pdf', '00000000-0000-0000-0000-00000000000a'),
  ('d1000000-0000-0000-0000-000000000002', 'Boletim C2-outro', 'boletim_tecnico', 'outrofornecedor', 'kb/c2.pdf', '00000000-0000-0000-0000-00000000000a'),
  ('d1000000-0000-0000-0000-0000000000e1', 'Boletim E1', 'boletim_tecnico', 'sayerlack', 'kb/e1.pdf', '00000000-0000-0000-0000-00000000000a'),
  ('d1000000-0000-0000-0000-0000000000aa', 'Boletim A claim', 'boletim_tecnico', 'sayerlack', 'kb/aa.pdf', '00000000-0000-0000-0000-00000000000a')
ON CONFLICT DO NOTHING;
SQL

# ═══════════════════════════════════════════════════════════════════════════════
# Aplica as 2 migrations NOVAS de hardening.
# ═══════════════════════════════════════════════════════════════════════════════
echo ""
echo "→ migration 1 NOVA: 20260613170000_fix_auto_assign_master_escalation.sql…"
P -v ON_ERROR_STOP=1 -q -f "$REPO_ROOT/supabase/migrations/20260613170000_fix_auto_assign_master_escalation.sql"

echo "→ migration 2 NOVA: 20260613180000_kb_hardening_codex.sql…"
P -v ON_ERROR_STOP=1 -q -f "$REPO_ROOT/supabase/migrations/20260613180000_kb_hardening_codex.sql"

MASTER_UID='00000000-0000-0000-0000-00000000000a'
EMP_UID='00000000-0000-0000-0000-00000000000b'
DOC_C='d1000000-0000-0000-0000-000000000001'
DOC_C2='d1000000-0000-0000-0000-000000000002'
DOC_E1='d1000000-0000-0000-0000-0000000000e1'
DOC_AA='d1000000-0000-0000-0000-0000000000aa'

# ─────────────────────────────────────────────────────────────────────────────
echo ""
echo "════════════════════════════════════════════════════════"
echo "→ B1 — fix aplicado: self-insert com document == master_cnpj (formatado) NÃO vira master:"
# document '12.345.678/0001-99' → REGEXP_REPLACE(...,'\D','','g') = '12345678000199' == master_cnpj.
# is_employee=false + prospect_source=NULL → com o fix, cai em 'customer' (sem ramo master).
P -v ON_ERROR_STOP=1 <<SQL
DO \$\$
DECLARE
  u uuid := gen_random_uuid();
  n_master int; n_customer int;
BEGIN
  INSERT INTO auth.users (id, email) VALUES (u, 'b1@test.local');
  INSERT INTO public.profiles (user_id, document, is_employee, prospect_source)
    VALUES (u, '12.345.678/0001-99', false, NULL);

  SELECT count(*) INTO n_master   FROM public.user_roles WHERE user_id = u AND role = 'master';
  SELECT count(*) INTO n_customer FROM public.user_roles WHERE user_id = u AND role = 'customer';

  IF n_master <> 0 THEN
    RAISE EXCEPTION 'B1 FALHOU: trigger concedeu master por CNPJ (n_master=% — o fix não removeu o ramo)', n_master;
  END IF;
  IF n_customer <> 1 THEN
    RAISE EXCEPTION 'B1 FALHOU: esperado customer=1, obteve % (ramo customer quebrado pelo fix)', n_customer;
  END IF;
  RAISE NOTICE 'OK B1 — sem master (n_master=0), caiu em customer (n_customer=1)';
END \$\$;
SQL
echo "  OK B1 — privilege escalation por CNPJ fechado"

# ─────────────────────────────────────────────────────────────────────────────
echo ""
echo "→ B2 — FALSIFICAÇÃO: trigger ANTIGO (com ramo master) → o MESMO insert vira master:"
# Recria o corpo ANTIGO (com o ramo master). Se B1 só passou porque o insert "não casa o CNPJ",
# então mesmo com o ramo de volta NÃO viraria master → o teste cairia (B1 seria teatro).
P -v ON_ERROR_STOP=1 -q <<'SQL'
CREATE OR REPLACE FUNCTION public.auto_assign_user_role() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE
  master_cnpj_value TEXT;
  profile_doc TEXT;
  existing_role app_role;
BEGIN
  IF TG_OP = 'UPDATE' THEN RETURN NEW; END IF;
  SELECT role INTO existing_role FROM public.user_roles WHERE user_id = NEW.user_id LIMIT 1;
  IF existing_role IS NOT NULL THEN RETURN NEW; END IF;
  SELECT value INTO master_cnpj_value FROM public.company_config WHERE key = 'master_cnpj';
  profile_doc := REGEXP_REPLACE(NEW.document, '\D', '', 'g');
  IF profile_doc = master_cnpj_value AND COALESCE(NEW.prospect_source, '') <> 'omie_import' THEN
    INSERT INTO public.user_roles (user_id, role) VALUES (NEW.user_id, 'master') ON CONFLICT (user_id, role) DO NOTHING;
  ELSIF NEW.is_employee = true THEN
    INSERT INTO public.user_roles (user_id, role) VALUES (NEW.user_id, 'employee') ON CONFLICT (user_id, role) DO NOTHING;
  ELSE
    INSERT INTO public.user_roles (user_id, role) VALUES (NEW.user_id, 'customer') ON CONFLICT (user_id, role) DO NOTHING;
  END IF;
  RETURN NEW;
END;
$$;
SQL

SAB_B2=$(P -tA 2>&1 <<SQL || true
DO \$\$
DECLARE u uuid := gen_random_uuid(); n int;
BEGIN
  INSERT INTO auth.users (id, email) VALUES (u, 'b2sab@test.local');
  INSERT INTO public.profiles (user_id, document, is_employee, prospect_source)
    VALUES (u, '12.345.678/0001-99', false, NULL);
  SELECT count(*) INTO n FROM public.user_roles WHERE user_id = u AND role = 'master';
  IF n = 1 THEN RAISE NOTICE 'SABOTAGEM_VIROU_MASTER';
  ELSE RAISE NOTICE 'SABOTAGEM_NAO_VIROU_MASTER n=%', n; END IF;
END \$\$;
SQL
)
if echo "$SAB_B2" | grep -q 'SABOTAGEM_VIROU_MASTER'; then
  echo "  OK B2 (falsificação) — trigger ANTIGO concedeu master pelo MESMO insert → o assert B1 REALMENTE guarda (não é teatro)"
else
  echo "  B2 FALHOU (falsificação): trigger antigo NÃO concedeu master pelo mesmo insert → o B1 não testa a escalada."
  echo "  saída: $SAB_B2"
  exit 1
fi

echo "→ B2 — re-aplicando a migration 1 (restaura o fix) e confirmando que volta a NÃO conceder master…"
P -v ON_ERROR_STOP=1 -q -f "$REPO_ROOT/supabase/migrations/20260613170000_fix_auto_assign_master_escalation.sql"
REST_B2=$(P -tA 2>&1 <<SQL || true
DO \$\$
DECLARE u uuid := gen_random_uuid(); n int;
BEGIN
  INSERT INTO auth.users (id, email) VALUES (u, 'b2rest@test.local');
  INSERT INTO public.profiles (user_id, document, is_employee, prospect_source)
    VALUES (u, '12.345.678/0001-99', false, NULL);
  SELECT count(*) INTO n FROM public.user_roles WHERE user_id = u AND role = 'master';
  IF n = 0 THEN RAISE NOTICE 'FIX_RESTAURADO';
  ELSE RAISE NOTICE 'FIX_NAO_RESTAURADO n=%', n; END IF;
END \$\$;
SQL
)
if echo "$REST_B2" | grep -q 'FIX_RESTAURADO'; then
  echo "  OK B2 (restauração) — fix de volta, insert não concede master (n_master=0)"
else
  echo "  B2 FALHOU (restauração): re-aplicar a migration 1 não restaurou o fix. saída: $REST_B2"
  exit 1
fi

# ─────────────────────────────────────────────────────────────────────────────
echo ""
echo "→ A — GRANT service_role na kb_extraction_draft_claim + REVOKE de authenticated:"
# (a) service_role executa sem erro (prova o GRANT do BLOCO A). BYPASSRLS → o INSERT do claim passa.
P -v ON_ERROR_STOP=1 <<SQL
DO \$\$
DECLARE ok boolean;
BEGIN
  SET ROLE service_role;
  SELECT public.kb_extraction_draft_claim('${DOC_AA}'::uuid, gen_random_uuid()) INTO ok;
  RESET ROLE;
  IF ok IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'Aa FALHOU: claim retornou % (esperado true p/ doc fresco)', ok;
  END IF;
  RAISE NOTICE 'OK Aa — service_role executou kb_extraction_draft_claim (GRANT presente, retorno=true)';
END \$\$;
SQL
# (b) authenticated → 42501 permission denied for function (REVOKE FROM anon,authenticated,public intacto).
P -v ON_ERROR_STOP=1 <<SQL
DO \$\$
BEGIN
  SET ROLE authenticated;
  SET LOCAL test.uid = '${MASTER_UID}';  -- até master, como authenticated, não tem EXECUTE
  BEGIN
    PERFORM public.kb_extraction_draft_claim('${DOC_AA}'::uuid, gen_random_uuid());
    RESET ROLE;
    RAISE EXCEPTION 'Ab FALHOU: authenticated executou a RPC (REVOKE ausente)';
  EXCEPTION
    WHEN insufficient_privilege THEN
      RESET ROLE;
      IF SQLERRM NOT ILIKE '%permission denied for function%' THEN
        RAISE EXCEPTION 'Ab2 FALHOU: 42501 mas msg inesperada "%"', SQLERRM;
      END IF;
      RAISE NOTICE 'OK Ab — authenticated barrado (42501 permission denied for function): %', SQLERRM;
    WHEN OTHERS THEN
      RESET ROLE; RAISE;  -- re-lança qualquer SQLSTATE diferente
  END;
END \$\$;
SQL
echo "  OK A — GRANT service_role funciona; REVOKE de authenticated intacto"

# ─────────────────────────────────────────────────────────────────────────────
echo ""
echo "→ C1 — re-aprovar mesmo produto com caixa/espaço → UPDATE da mesma linha + v2 (ON CONFLICT composta):"
PAYLOAD_C1A='{
  "product_code": "FO20.6827.00GL",
  "product_name": "Verniz PU GL",
  "supplier": "sayerlack",
  "product_category": "verniz",
  "rendimento_m2_por_litro": 12.5,
  "catalisador_codigo": "FC.6975"
}'
# Variação caixa/espaço: 'fo20.6827.00 gl' → normalize(NFKC)→upper→strip espaços = 'FO20.6827.00GL' (idêntica).
PAYLOAD_C1B='{
  "product_code": "fo20.6827.00 gl",
  "product_name": "Verniz PU GL v2",
  "supplier": "sayerlack",
  "product_category": "verniz",
  "rendimento_m2_por_litro": 13.0,
  "catalisador_codigo": "FC.6975"
}'
VER_C1A=$(P -tA -q -v ON_ERROR_STOP=1 <<SQL
SET test.uid = '${MASTER_UID}';
SELECT public.aprovar_versao_boletim('${PAYLOAD_C1A}'::jsonb, '${DOC_C}'::uuid, 'initial', NULL);
SQL
)
VER_C1A="${VER_C1A//[[:space:]]/}"
echo "  v1 criada: $VER_C1A"

# 2ª aprovação com a variação — DEVE fazer UPDATE da mesma linha (sem 23505) e criar v2.
P -v ON_ERROR_STOP=1 <<SQL
DO \$\$
DECLARE v2 uuid; spec_cnt int; spec_code text; vmax int; live int;
BEGIN
  SET LOCAL test.uid = '${MASTER_UID}';
  -- Se o ON CONFLICT fosse pelo product_code textual, 'fo20.6827.00 gl' != 'FO20.6827.00GL' → INSERT →
  -- violaria a UNIQUE composta (supplier, product_code_normalized) → 23505. O BLOCO C corrige p/ a composta.
  SELECT public.aprovar_versao_boletim('${PAYLOAD_C1B}'::jsonb, '${DOC_C}'::uuid, 'bulletin_revision', NULL) INTO v2;
  IF v2 IS NULL THEN RAISE EXCEPTION 'C1 FALHOU: 2ª aprovação retornou NULL'; END IF;

  -- 1 única linha em kb_product_specs p/ a identidade composta, com product_code atualizado p/ a variação.
  SELECT count(*), max(product_code) INTO spec_cnt, spec_code
    FROM public.kb_product_specs
   WHERE supplier = 'sayerlack' AND product_code_normalized = 'FO20.6827.00GL';
  IF spec_cnt <> 1 THEN RAISE EXCEPTION 'C1 FALHOU: % linhas em kb_product_specs (esperado 1 — UPDATE, não INSERT)', spec_cnt; END IF;
  IF spec_code IS DISTINCT FROM 'fo20.6827.00 gl' THEN
    RAISE EXCEPTION 'C1 FALHOU: product_code da linha = % (esperado a variação fo20.6827.00 gl = prova do UPDATE)', spec_code;
  END IF;

  -- version_number chegou a 2 e há 1 só versão viva.
  SELECT max(version_number) INTO vmax
    FROM public.kb_product_spec_versions
   WHERE supplier='sayerlack' AND product_code_normalized='FO20.6827.00GL';
  IF vmax <> 2 THEN RAISE EXCEPTION 'C1 FALHOU: max version_number=% (esperado 2)', vmax; END IF;

  SELECT count(*) INTO live
    FROM public.kb_product_spec_versions
   WHERE supplier='sayerlack' AND product_code_normalized='FO20.6827.00GL' AND superseded_at IS NULL;
  IF live <> 1 THEN RAISE EXCEPTION 'C1 FALHOU: % versões vivas (esperado 1)', live; END IF;

  RAISE NOTICE 'OK C1 — variação caixa/espaço fez UPDATE da mesma linha (product_code=%) + v2 (1 viva)', spec_code;
END \$\$;
SQL
echo "  OK C1 — ON CONFLICT pela identidade composta (sem unique_violation)"

# ─────────────────────────────────────────────────────────────────────────────
echo ""
echo "→ C2 — supplier DIFERENTE mas mesmo product_code TEXTUAL → 23505 (UNIQUE global product_code):"
# ⚠️ A UNIQUE(product_code) global (20260517180000) é sobre o TEXTO CRU (case/espaço-sensível), NÃO o
# normalizado. C1 mutou o texto p/ 'fo20.6827.00 gl' → reusá-lo NÃO colide com 'FO20.6827.00GL' (textos
# diferentes). Por isso C2 usa um produto DEDICADO com product_code TEXTUALMENTE idêntico:
#   1) master aprova 'C2.SAME.00' / sayerlack  → cria a linha + a UNIQUE global do texto 'C2.SAME.00'.
#   2) aprovar 'C2.SAME.00' / outrofornecedor → ON CONFLICT composta NÃO casa (supplier difere) → INSERT
#      → colide na UNIQUE GLOBAL kb_product_specs_product_code_key (23505), SEM sobrescrever a linha 1.
PAYLOAD_C2_SEED='{
  "product_code": "C2.SAME.00",
  "product_name": "C2 base sayerlack",
  "supplier": "sayerlack",
  "product_category": "verniz",
  "rendimento_m2_por_litro": 7.0
}'
PAYLOAD_C2='{
  "product_code": "C2.SAME.00",
  "product_name": "Tentativa cross-fornecedor",
  "supplier": "outrofornecedor",
  "product_category": "verniz",
  "rendimento_m2_por_litro": 9.9
}'
# 1) cria a linha base (sayerlack) que detém o texto 'C2.SAME.00'.
P -tA -q -v ON_ERROR_STOP=1 <<SQL >/dev/null
SET test.uid = '${MASTER_UID}';
SELECT public.aprovar_versao_boletim('${PAYLOAD_C2_SEED}'::jsonb, '${DOC_C}'::uuid, 'initial', NULL);
SQL
# 2) cross-fornecedor com o MESMO texto → deve dar 23505 na UNIQUE global, sem sobrescrever.
P -v ON_ERROR_STOP=1 <<SQL
DO \$\$
DECLARE cnt_before int; cnt_after int; rend_after numeric;
BEGIN
  SET LOCAL test.uid = '${MASTER_UID}';
  SELECT count(*) INTO cnt_before FROM public.kb_product_specs;

  BEGIN
    PERFORM public.aprovar_versao_boletim('${PAYLOAD_C2}'::jsonb, '${DOC_C2}'::uuid, 'initial', NULL);
    RAISE EXCEPTION 'C2 FALHOU: cross-fornecedor com mesmo product_code textual NÃO deu erro (sobrescreveu/criou indevido)';
  EXCEPTION
    WHEN unique_violation THEN
      -- esperado: colide na UNIQUE global kb_product_specs_product_code_key (23505).
      IF SQLERRM NOT ILIKE '%product_code%' THEN
        RAISE EXCEPTION 'C2b FALHOU: unique_violation mas constraint inesperada "%"', SQLERRM;
      END IF;
      RAISE NOTICE 'OK C2 — cross-fornecedor barrado por unique_violation global (23505): %', SQLERRM;
    WHEN OTHERS THEN RAISE;  -- re-lança qualquer outra SQLSTATE
  END;

  -- Prova de não-sobrescrita: a linha base (rendimento 7.0, fornecedor sayerlack) está intacta; nada criado.
  SELECT count(*) INTO cnt_after FROM public.kb_product_specs;
  IF cnt_after <> cnt_before THEN
    RAISE EXCEPTION 'C2 FALHOU: contagem de specs mudou de % p/ % (criou linha indevida)', cnt_before, cnt_after;
  END IF;
  SELECT rendimento_m2_por_litro INTO rend_after
    FROM public.kb_product_specs
   WHERE supplier='sayerlack' AND product_code_normalized='C2.SAME.00';
  IF rend_after IS DISTINCT FROM 7.0 THEN
    RAISE EXCEPTION 'C2 FALHOU: linha base foi adulterada (rendimento=% — esperado 7.0)', rend_after;
  END IF;
  RAISE NOTICE 'OK C2 — linha base intacta (rendimento 7.0), nada criado';
END \$\$;
SQL
echo "  OK C2 — UNIQUE global product_code preservada (sobrescrita cross-fornecedor barrada)"

# ─────────────────────────────────────────────────────────────────────────────
echo ""
echo "→ D — REVOKE escrita direta em kb_product_specs (authenticated/master): INSERT/UPDATE/DELETE = 42501; SELECT OK:"
# Pega o id da linha de C1 p/ tentar UPDATE/DELETE.
SPEC_D=$(P -tA -q -c "SELECT id FROM public.kb_product_specs WHERE supplier='sayerlack' AND product_code_normalized='FO20.6827.00GL' LIMIT 1;")
SPEC_D="${SPEC_D//[[:space:]]/}"
echo "  spec alvo do D: $SPEC_D"
# (a) INSERT direto → 42501 permission denied for table (REVOKE de tabela barra ANTES da RLS).
P -v ON_ERROR_STOP=1 <<SQL
DO \$\$
BEGIN
  SET ROLE authenticated;
  SET LOCAL test.uid = '${MASTER_UID}';  -- até master (a RLS deixaria; mas o REVOKE de TABELA barra antes)
  BEGIN
    INSERT INTO public.kb_product_specs (product_code, product_name, supplier)
      VALUES ('D.0001.00', 'tentativa direta', 'sayerlack');
    RESET ROLE;
    RAISE EXCEPTION 'Da FALHOU: INSERT direto passou (REVOKE de tabela ausente)';
  EXCEPTION
    WHEN insufficient_privilege THEN
      RESET ROLE;
      IF SQLERRM NOT ILIKE '%permission denied for table%' THEN
        RAISE EXCEPTION 'Da2 FALHOU: 42501 mas msg inesperada "%"', SQLERRM;
      END IF;
      RAISE NOTICE 'OK Da — INSERT direto barrado (42501 table): %', SQLERRM;
    WHEN OTHERS THEN RESET ROLE; RAISE;
  END;
END \$\$;
SQL
# (b) UPDATE direto → 42501.
P -v ON_ERROR_STOP=1 <<SQL
DO \$\$
BEGIN
  SET ROLE authenticated;
  SET LOCAL test.uid = '${MASTER_UID}';
  BEGIN
    UPDATE public.kb_product_specs SET rendimento_m2_por_litro = 1 WHERE id = '${SPEC_D}';
    RESET ROLE;
    RAISE EXCEPTION 'Db FALHOU: UPDATE direto passou (REVOKE de tabela ausente)';
  EXCEPTION
    WHEN insufficient_privilege THEN
      RESET ROLE;
      IF SQLERRM NOT ILIKE '%permission denied for table%' THEN
        RAISE EXCEPTION 'Db2 FALHOU: 42501 mas msg inesperada "%"', SQLERRM;
      END IF;
      RAISE NOTICE 'OK Db — UPDATE direto barrado (42501 table): %', SQLERRM;
    WHEN OTHERS THEN RESET ROLE; RAISE;
  END;
END \$\$;
SQL
# (c) DELETE direto → 42501.
P -v ON_ERROR_STOP=1 <<SQL
DO \$\$
BEGIN
  SET ROLE authenticated;
  SET LOCAL test.uid = '${MASTER_UID}';
  BEGIN
    DELETE FROM public.kb_product_specs WHERE id = '${SPEC_D}';
    RESET ROLE;
    RAISE EXCEPTION 'Dc FALHOU: DELETE direto passou (REVOKE de tabela ausente)';
  EXCEPTION
    WHEN insufficient_privilege THEN
      RESET ROLE;
      IF SQLERRM NOT ILIKE '%permission denied for table%' THEN
        RAISE EXCEPTION 'Dc2 FALHOU: 42501 mas msg inesperada "%"', SQLERRM;
      END IF;
      RAISE NOTICE 'OK Dc — DELETE direto barrado (42501 table): %', SQLERRM;
    WHEN OTHERS THEN RESET ROLE; RAISE;
  END;
END \$\$;
SQL
# (d) SELECT direto → OK (SELECT NÃO foi revogado; staff lê a base).
P -v ON_ERROR_STOP=1 <<SQL
DO \$\$
DECLARE c int;
BEGIN
  SET ROLE authenticated;
  SET LOCAL test.uid = '${EMP_UID}';   -- employee: a RLS de SELECT é staff (employee/master)
  SELECT count(*) INTO c FROM public.kb_product_specs WHERE id = '${SPEC_D}';
  RESET ROLE;
  IF c <> 1 THEN RAISE EXCEPTION 'Dd FALHOU: SELECT não enxergou a linha (c=% — SELECT foi revogado/quebrado)', c; END IF;
  RAISE NOTICE 'OK Dd — SELECT segue permitido (staff lê): c=1';
END \$\$;
SQL
echo "  OK D — escrita direta revogada (INSERT/UPDATE/DELETE 42501), SELECT preservado"

# ─────────────────────────────────────────────────────────────────────────────
echo ""
echo "→ E1 — kbv_uma_viva: 2ª versão com superseded_at NULL p/ mesma identidade → 23505:"
# Insere (como service_role, BYPASSRLS) 2 linhas vivas (superseded_at NULL) p/ a mesma identidade.
# A 1ª passa; a 2ª colide no índice parcial UNIQUE kbv_uma_viva (do BLOCO E).
P -v ON_ERROR_STOP=1 <<SQL
DO \$\$
BEGIN
  SET ROLE service_role;
  INSERT INTO public.kb_product_spec_versions
    (supplier, product_code_normalized, product_code, version_number, change_type, source_document_id, superseded_at)
  VALUES ('sayerlack', 'E1.0001.00', 'E1.0001.00', 1, 'initial', '${DOC_E1}'::uuid, NULL);

  BEGIN
    INSERT INTO public.kb_product_spec_versions
      (supplier, product_code_normalized, product_code, version_number, change_type, source_document_id, superseded_at)
    VALUES ('sayerlack', 'E1.0001.00', 'E1.0001.00', 2, 'bulletin_revision', '${DOC_E1}'::uuid, NULL);
    RESET ROLE;
    RAISE EXCEPTION 'E1 FALHOU: 2 versões vivas p/ a mesma identidade foram aceitas (índice kbv_uma_viva ausente)';
  EXCEPTION
    WHEN unique_violation THEN
      RESET ROLE;
      IF SQLERRM NOT ILIKE '%kbv_uma_viva%' THEN
        RAISE EXCEPTION 'E1b FALHOU: unique_violation mas índice inesperado "%"', SQLERRM;
      END IF;
      RAISE NOTICE 'OK E1 — 2ª versão viva barrada (23505 kbv_uma_viva): %', SQLERRM;
    WHEN OTHERS THEN RESET ROLE; RAISE;
  END;
END \$\$;
SQL
echo "  OK E1 — índice 'uma viva' impõe ≤1 versão não-supersedida"

# ─────────────────────────────────────────────────────────────────────────────
echo ""
echo "→ E2 — DELETE numa kb_product_spec_versions → RAISE (append-only) + FALSIFICAÇÃO do trigger:"
# A versão viva E1 (version_number=1) é o alvo. Trigger novo (BEFORE UPDATE OR DELETE) bloqueia o DELETE.
P -v ON_ERROR_STOP=1 <<SQL
DO \$\$
BEGIN
  SET ROLE service_role;  -- até quem bypassa RLS é barrado pelo TRIGGER
  BEGIN
    DELETE FROM public.kb_product_spec_versions
     WHERE supplier='sayerlack' AND product_code_normalized='E1.0001.00';
    RESET ROLE;
    RAISE EXCEPTION 'E2a FALHOU: DELETE foi aceito (trigger não bloqueia DELETE — BEFORE UPDATE OR DELETE ausente)';
  EXCEPTION
    WHEN raise_exception THEN
      RESET ROLE;
      -- mensagem do trigger menciona 'append-only' + 'DELETE proibido'; sentinela tolerante mas distinta.
      IF SQLERRM NOT ILIKE '%append-only%' AND SQLERRM NOT ILIKE '%DELETE proibido%' THEN
        RAISE EXCEPTION 'E2a2 FALHOU: exceção com msg inesperada: %', SQLERRM;
      END IF;
      RAISE NOTICE 'OK E2a — DELETE bloqueado pelo trigger: %', SQLERRM;
    WHEN OTHERS THEN RESET ROLE; RAISE;
  END;
END \$\$;
SQL

# FALSIFICAÇÃO: dropa o trigger → EXIGE que o DELETE agora PASSE (prova que o trigger guardava de verdade).
P -v ON_ERROR_STOP=1 -q <<'SQL'
DROP TRIGGER IF EXISTS trg_kbv_immutable ON public.kb_product_spec_versions;
SQL
SAB_E2=$(P -tA 2>&1 <<SQL || true
DO \$\$
DECLARE rc int;
BEGIN
  SET ROLE service_role;
  DELETE FROM public.kb_product_spec_versions
   WHERE supplier='sayerlack' AND product_code_normalized='E1.0001.00';
  GET DIAGNOSTICS rc = ROW_COUNT;
  RESET ROLE;
  IF rc >= 1 THEN RAISE NOTICE 'DELETE_SABOTADO_PASSOU rc=%', rc;
  ELSE RAISE NOTICE 'DELETE_SABOTADO_NAO_PASSOU rc=%', rc; END IF;
END \$\$;
SQL
)
if echo "$SAB_E2" | grep -q 'DELETE_SABOTADO_PASSOU'; then
  echo "  OK E2 (falsificação) — sem o trigger o DELETE passou → o trigger REALMENTE bloqueia (não é teatro)"
else
  echo "  E2 FALHOU (falsificação): DELETE não passou mesmo sem o trigger. saída: $SAB_E2"
  exit 1
fi
# Restaura o trigger correto (espelho da migration: BEFORE UPDATE OR DELETE).
P -v ON_ERROR_STOP=1 -q -f "$REPO_ROOT/supabase/migrations/20260613180000_kb_hardening_codex.sql" >/dev/null
echo "  OK E2 — append-only de DELETE comprovado com falsificação (trigger restaurado via re-apply da migration)"

# ─────────────────────────────────────────────────────────────────────────────
echo ""
echo "→ E3 — reviver versão supersedida (superseded_at NOT NULL → NULL) → RAISE:"
# Cria uma identidade limpa com v1(superseded) + v2(viva), depois tenta reviver a v1.
P -v ON_ERROR_STOP=1 <<SQL
DO \$\$
DECLARE v1 uuid;
BEGIN
  SET ROLE service_role;
  INSERT INTO public.kb_product_spec_versions
    (supplier, product_code_normalized, product_code, version_number, change_type, source_document_id, superseded_at)
  VALUES ('sayerlack', 'E3.0001.00', 'E3.0001.00', 1, 'initial', '${DOC_E1}'::uuid, now())
  RETURNING id INTO v1;
  INSERT INTO public.kb_product_spec_versions
    (supplier, product_code_normalized, product_code, version_number, change_type, source_document_id, superseded_at)
  VALUES ('sayerlack', 'E3.0001.00', 'E3.0001.00', 2, 'bulletin_revision', '${DOC_E1}'::uuid, NULL);

  -- Tenta reviver a v1 (superseded_at NOT NULL → NULL). O trigger tem ramo dedicado anti-reviver.
  BEGIN
    UPDATE public.kb_product_spec_versions SET superseded_at = NULL WHERE id = v1;
    RESET ROLE;
    RAISE EXCEPTION 'E3 FALHOU: reviver versão supersedida foi aceito (ramo anti-reviver ausente)';
  EXCEPTION
    WHEN raise_exception THEN
      RESET ROLE;
      IF SQLERRM NOT ILIKE '%reviver%' AND SQLERRM NOT ILIKE '%supersedida%' THEN
        RAISE EXCEPTION 'E3b FALHOU: exceção com msg inesperada: %', SQLERRM;
      END IF;
      RAISE NOTICE 'OK E3 — reviver supersedida bloqueado: %', SQLERRM;
    WHEN OTHERS THEN RESET ROLE; RAISE;
  END;
END \$\$;
SQL
echo "  OK E3 — não é permitido reviver versão supersedida"

# ─────────────────────────────────────────────────────────────────────────────
echo ""
echo "════════════════════════════════════════════════════════"
echo "✅ test-kb-hardening-codex: todos os asserts passaram"
echo "   B1 — fix: self-insert com document==master_cnpj NÃO vira master (customer)"
echo "   B2 — FALSIFICAÇÃO: trigger antigo concede master → B1 tem dente; re-apply restaura o fix"
echo "   A  — GRANT service_role na claim (executa); authenticated → 42501 (REVOKE intacto)"
echo "   C1 — ON CONFLICT composta: variação caixa/espaço vira UPDATE+v2 (sem 23505)"
echo "   C2 — UNIQUE global product_code: cross-fornecedor → 23505 (não sobrescreve)"
echo "   D  — REVOKE de tabela: INSERT/UPDATE/DELETE diretos = 42501; SELECT OK"
echo "   E1 — kbv_uma_viva: 2ª versão viva por identidade → 23505"
echo "   E2 — append-only: DELETE → RAISE + FALSIFICAÇÃO do trigger"
echo "   E3 — não reviver: superseded_at NOT NULL→NULL → RAISE"
