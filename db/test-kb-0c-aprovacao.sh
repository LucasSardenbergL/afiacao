#!/usr/bin/env bash
# Teste PG17 do KB 0c — caminho A: aprovação de spec MASTER-ONLY. Money-path.
# Caminho LEVE (sem snapshot completo): stubs mínimos do Supabase (auth/app_role/
# has_role/storage/omie_products) + as 3 migrations de fundação do KB
# (20260517170000 + 20260517180000 + 20260611140000) + a migration NOVA
# (20260613120000_kb_0c_aprovacao_master_only.sql) e EXECUTA 7 asserts:
#   B1 RLS INSERT master-only (employee barrado 42501; master OK)
#   B2 RLS UPDATE master-only — o FURO do P1 (employee dono não enxerga a linha → ROW_COUNT=0)
#   B3 FALSIFICAÇÃO — re-cria a policy ANTIGA furada e EXIGE que B2 vire ROW_COUNT=1, depois restaura
#   B4 confirmar_vinculo valida SKU em omie_products (P2-a; inexistente/caixa-errada → RAISE)
#   B5 contador ROW_COUNT real (P3; re-confirmar do mesmo dono retorna 0, não 1)
#   B6 desvincular_boletim (stale-delete=0; reatribuição; gate master)
#   B7 CHECK não-negatividade (rendimento -1 → check_violation; 0 e NULL OK)
# ⚠️ RLS só é enforçada para roles NÃO-superuser. O psql roda como `postgres` (superuser,
# BYPASSA RLS) → os asserts de RLS usam SET ROLE authenticated + SET LOCAL test.uid dentro de
# um bloco transacional (BEGIN…ROLLBACK), e RESET ROLE ao final. has_role é SECURITY DEFINER
# (lê user_roles como owner) → funciona sob SET ROLE. As RPCs são SECURITY DEFINER e o gate é
# INTERNO (has_role(auth.uid())) → os asserts de RPC só setam SET LOCAL test.uid, sem SET ROLE.
# Disciplina de assert negativo (igual test-kb-fundacao-casamento.sh): captura a SQLSTATE/mensagem
# esperada e RE-LANÇA o resto — `WHEN OTHERS THEN 'OK'` cego é teatro.
# Base: db/test-kb-fundacao-casamento.sh (bring-up PG17 keg-only).
# Pré-req: brew install postgresql@17 pgvector.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PGVER=17
PGBIN="/opt/homebrew/opt/postgresql@${PGVER}/bin"
PORT=5441   # porta dedicada p/ não colidir com outros scripts (5433/5436/5439)
DATA="$(mktemp -d /tmp/pgtest-kb0c.XXXXXX)/data"
export LC_ALL=C LANG=C

[ -x "$PGBIN/initdb" ] || { echo "postgresql@${PGVER} ausente: brew install postgresql@${PGVER} pgvector"; exit 1; }

# Contorna o keg-only do brew (idempotente, no-clobber): share + lib do postgres.
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

"$PGBIN/initdb" -D "$DATA" -U postgres -E UTF8 --locale=C >/dev/null
"$PGBIN/pg_ctl" -D "$DATA" -o "-p $PORT -k /tmp" -l /tmp/pg-kb0c.log -w start >/dev/null
"$PGBIN/createdb" -p "$PORT" -h /tmp -U postgres kb0c_verify
P() { "$PGBIN/psql" -p "$PORT" -h /tmp -U postgres -d kb0c_verify "$@"; }

echo "→ stubs mínimos do Supabase (roles, auth, app_role, user_roles, has_role, storage, omie_products)…"
P -v ON_ERROR_STOP=1 -q <<'SQL'
-- Roles referenciadas por GRANTs/policies.
DO $$ BEGIN CREATE ROLE anon;          EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE ROLE authenticated; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE ROLE service_role;  EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Schema auth + tabela de usuários (FK target de kb_documents/specs/links).
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

-- omie_products (stub mínimo: o que buscar_skus_candidatos + confirmar_vinculo (P2-a) leem).
CREATE TABLE IF NOT EXISTS public.omie_products (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account             text NOT NULL,
  omie_codigo_produto bigint NOT NULL,
  codigo              text,
  descricao           text,
  ativo               boolean DEFAULT true
);
SQL

echo "→ pgvector (kb_chunks usa vector(1536))…"
P -v ON_ERROR_STOP=1 -q -c "CREATE EXTENSION IF NOT EXISTS vector;"

echo "→ migration 20260517170000_kb_foundation.sql…"
P -v ON_ERROR_STOP=1 -q -f "$REPO_ROOT/supabase/migrations/20260517170000_kb_foundation.sql"

echo "→ migration 20260517180000_kb_specs_and_competitors.sql…"
P -v ON_ERROR_STOP=1 -q -f "$REPO_ROOT/supabase/migrations/20260517180000_kb_specs_and_competitors.sql"

echo "→ migration 20260611140000_kb_fundacao_casamento.sql (fundação 0a)…"
P -v ON_ERROR_STOP=1 -q -f "$REPO_ROOT/supabase/migrations/20260611140000_kb_fundacao_casamento.sql"

echo "→ migration 20260613120000_kb_0c_aprovacao_master_only.sql (a NOVA)…"
P -v ON_ERROR_STOP=1 -q -f "$REPO_ROOT/supabase/migrations/20260613120000_kb_0c_aprovacao_master_only.sql"

echo "→ seed (master, employee, grant na kb_product_specs p/ authenticated, 1 sku omie)…"
P -v ON_ERROR_STOP=1 -q <<'SQL'
-- u_master: master ; u_emp: employee ; (anon = uid NULL).
INSERT INTO auth.users (id, email) VALUES
  ('00000000-0000-0000-0000-00000000000a', 'master@test.local'),
  ('00000000-0000-0000-0000-00000000000b', 'emp@test.local')
ON CONFLICT DO NOTHING;

INSERT INTO public.user_roles (user_id, role) VALUES
  ('00000000-0000-0000-0000-00000000000a', 'master'::public.app_role),
  ('00000000-0000-0000-0000-00000000000b', 'employee'::public.app_role)
ON CONFLICT DO NOTHING;

-- Grant de tabela p/ os asserts de RLS via SET ROLE authenticated (a RLS filtra POR CIMA do grant).
GRANT SELECT, INSERT, UPDATE, DELETE ON public.kb_product_specs TO authenticated;

-- SKU Omie p/ os asserts de vínculo (P2-a casa account+codigo).
INSERT INTO public.omie_products (omie_codigo_produto, codigo, descricao, account, ativo)
  VALUES (8001, 'PRD8001', 'VERNIZ PU XX01.0001.00GL', 'oben', true) ON CONFLICT DO NOTHING;
SQL

echo ""
echo "→ ASSERT B1 — RLS INSERT master-only (employee 42501; master OK):"
# Master insere via SET ROLE authenticated + GUC → OK.
P -v ON_ERROR_STOP=1 <<'SQL'
BEGIN;
SET ROLE authenticated;
SET LOCAL test.uid = '00000000-0000-0000-0000-00000000000a';  -- master
INSERT INTO public.kb_product_specs (product_code, product_name, supplier)
  VALUES ('B1.0001.00', 'm', 'sayerlack');
RESET ROLE;
COMMIT;
SELECT 'OK B1a — master INSERT permitido' AS status;
SQL
# Employee insere o mesmo shape → DEVE estourar insufficient_privilege (42501, "row-level security").
P -v ON_ERROR_STOP=1 <<'SQL'
DO $$
BEGIN
  SET ROLE authenticated;
  SET LOCAL test.uid = '00000000-0000-0000-0000-00000000000b';  -- employee
  BEGIN
    INSERT INTO public.kb_product_specs (product_code, product_name, supplier)
      VALUES ('B1.0002.00', 'e', 'sayerlack');
    RESET ROLE;
    RAISE EXCEPTION 'B1 FALHOU: employee NÃO foi barrado no INSERT (RLS master-only ausente)';
  EXCEPTION
    WHEN insufficient_privilege THEN
      RESET ROLE;
      IF SQLERRM NOT ILIKE '%row-level security%' THEN
        RAISE EXCEPTION 'B1b FALHOU: 42501 mas mensagem inesperada "%"', SQLERRM;
      END IF;
      RAISE NOTICE 'OK B1b — employee barrado no INSERT (42501 row-level security): %', SQLERRM;
  END;
END $$;
SQL

echo ""
echo "→ ASSERT B2 — RLS UPDATE master-only (o FURO do P1: employee dono não enxerga a linha):"
# Seed (como postgres/superuser) de 1 spec com extracted_by=employee, approved, rendimento NULL.
# ⚠️ CTE (WITH ... INSERT RETURNING) + -q: top-level vira SELECT → psql NÃO cola o tag 'INSERT 0 1'
# na saída (com -tA cru o tag entrava no $SPEC2 e corrompia o uuid).
SPEC2=$(P -tA -q -c "WITH ins AS (INSERT INTO public.kb_product_specs (product_code, product_name, supplier, extracted_by, approved_at, rendimento_m2_por_litro) VALUES ('B2.0001.00','seed','sayerlack','00000000-0000-0000-0000-00000000000b', now(), NULL) RETURNING id) SELECT id FROM ins;")
echo "  seed spec B2: $SPEC2"
# Employee (dono = extracted_by) tenta adulterar rendimento → ROW_COUNT=0 (USING master-only não vê a linha; sem erro).
# ⚠️ heredoc UNQUOTED (<<SQL) p/ interpolar $SPEC2 do shell; $$ do plpgsql vira \$\$ (psql NÃO substitui
# :'var' DENTRO de string dollar-quoted → embuti o id direto, como em B3).
P -v ON_ERROR_STOP=1 <<SQL
DO \$\$
DECLARE rc int;
BEGIN
  SET ROLE authenticated;
  SET LOCAL test.uid = '00000000-0000-0000-0000-00000000000b';  -- employee (é o extracted_by)
  UPDATE public.kb_product_specs SET rendimento_m2_por_litro = 999 WHERE id = '$SPEC2';
  GET DIAGNOSTICS rc = ROW_COUNT;
  RESET ROLE;
  IF rc <> 0 THEN RAISE EXCEPTION 'B2a FALHOU: employee adulterou % linha(s) (esperado 0 — RLS master-only)', rc; END IF;
  RAISE NOTICE 'OK B2a — employee UPDATE é no-op (ROW_COUNT=0, sem erro)';
END \$\$;
SQL
# Confirma (como postgres) que rendimento continua NULL.
P -v ON_ERROR_STOP=1 <<SQL
DO \$\$
DECLARE v numeric;
BEGIN
  SELECT rendimento_m2_por_litro INTO v FROM public.kb_product_specs WHERE id = '$SPEC2';
  IF v IS NOT NULL THEN RAISE EXCEPTION 'B2b FALHOU: rendimento mudou pra % (esperado NULL — UPDATE do employee era no-op)', v; END IF;
  RAISE NOTICE 'OK B2b — rendimento continua NULL (employee não conseguiu gravar)';
END \$\$;
SQL
# Master adultera → ROW_COUNT=1 e valor gravado.
P -v ON_ERROR_STOP=1 <<SQL
DO \$\$
DECLARE rc int; v numeric;
BEGIN
  SET ROLE authenticated;
  SET LOCAL test.uid = '00000000-0000-0000-0000-00000000000a';  -- master
  UPDATE public.kb_product_specs SET rendimento_m2_por_litro = 12 WHERE id = '$SPEC2';
  GET DIAGNOSTICS rc = ROW_COUNT;
  RESET ROLE;
  IF rc <> 1 THEN RAISE EXCEPTION 'B2c FALHOU: master UPDATE afetou % linha(s) (esperado 1)', rc; END IF;
  SELECT rendimento_m2_por_litro INTO v FROM public.kb_product_specs WHERE id = '$SPEC2';
  IF v <> 12 THEN RAISE EXCEPTION 'B2d FALHOU: master não gravou (rendimento=%)', v; END IF;
  RAISE NOTICE 'OK B2c — master UPDATE grava (ROW_COUNT=1, rendimento=12)';
END \$\$;
SQL

echo ""
echo "→ ASSERT B3 — FALSIFICAÇÃO da RLS (prova que B2 tem dente):"
# Re-cria a policy ANTIGA furada (master OR extracted_by = auth.uid()).
P -v ON_ERROR_STOP=1 -q <<'SQL'
DROP POLICY IF EXISTS "kb_product_specs_update_master" ON public.kb_product_specs;
CREATE POLICY "kb_product_specs_update_master" ON public.kb_product_specs
  FOR UPDATE
  USING (public.has_role(auth.uid(), 'master'::app_role) OR extracted_by = auth.uid())
  WITH CHECK (public.has_role(auth.uid(), 'master'::app_role) OR extracted_by = auth.uid());
SQL
# Com a policy FURADA, o employee-DONO agora consegue → ROW_COUNT=1.
SAB=$(P -tA 2>&1 <<SQL || true
DO \$\$
DECLARE rc int;
BEGIN
  SET ROLE authenticated;
  SET LOCAL test.uid = '00000000-0000-0000-0000-00000000000b';  -- employee = extracted_by do seed
  UPDATE public.kb_product_specs SET rendimento_m2_por_litro = 555 WHERE id = '$SPEC2';
  GET DIAGNOSTICS rc = ROW_COUNT;
  RESET ROLE;
  IF rc = 1 THEN RAISE NOTICE 'SABOTAGEM_PASSOU';
  ELSE RAISE NOTICE 'SABOTAGEM_NAO_PASSOU rc=%', rc; END IF;
END \$\$;
SQL
)
if echo "$SAB" | grep -q 'SABOTAGEM_PASSOU'; then
  echo "  OK B3 — policy furada deixou o employee-dono adulterar (ROW_COUNT=1) → o assert B2 REALMENTE guarda (não é teatro)"
else
  echo "  B3 FALHOU: mesmo com a policy FURADA o employee NÃO conseguiu o UPDATE — o assert B2 NÃO está testando a RLS."
  echo "  saída: $SAB"
  exit 1
fi
echo "→ B3 — restaurando a policy master-only correta (drop+recreate só da update_master)…"
# Restauro CIRURGICAMENTE só a update_master (a sabotagem só furou ela) — mais claro que re-aplicar o
# arquivo inteiro no meio do teste. A migration É idempotente (BLOCO A dropa as policies NOVAS antes de
# criar); o re-apply completo do arquivo é provado no B8 ao final. SQL VERBATIM do BLOCO A (master-only).
P -v ON_ERROR_STOP=1 -q -c "UPDATE public.kb_product_specs SET rendimento_m2_por_litro = NULL WHERE id = '$SPEC2';"
P -v ON_ERROR_STOP=1 -q <<'SQL'
DROP POLICY IF EXISTS "kb_product_specs_update_master" ON public.kb_product_specs;
CREATE POLICY "kb_product_specs_update_master" ON public.kb_product_specs
  FOR UPDATE
  USING (public.has_role(auth.uid(), 'master'::app_role))
  WITH CHECK (public.has_role(auth.uid(), 'master'::app_role));
SQL
# Prova que a RLS VOLTOU: employee-dono barrado de novo (ROW_COUNT=0).
REST=$(P -tA 2>&1 <<SQL || true
DO \$\$
DECLARE rc int;
BEGIN
  SET ROLE authenticated;
  SET LOCAL test.uid = '00000000-0000-0000-0000-00000000000b';
  UPDATE public.kb_product_specs SET rendimento_m2_por_litro = 777 WHERE id = '$SPEC2';
  GET DIAGNOSTICS rc = ROW_COUNT;
  RESET ROLE;
  IF rc = 0 THEN RAISE NOTICE 'RLS_RESTAURADA';
  ELSE RAISE NOTICE 'RLS_AINDA_FURADA rc=%', rc; END IF;
END \$\$;
SQL
)
if echo "$REST" | grep -q 'RLS_RESTAURADA'; then
  echo "  OK B3 (restauração) — RLS master-only de volta, employee-dono barrado novamente (ROW_COUNT=0)"
else
  echo "  B3 FALHOU (restauração): RLS não voltou. saída: $REST"
  exit 1
fi

echo ""
echo "→ ASSERT B4 — confirmar_vinculo valida SKU em omie_products (P2-a, master):"
# RPC é SECURITY DEFINER, gate interno → só SET LOCAL test.uid (sem SET ROLE).
P -v ON_ERROR_STOP=1 <<'SQL'
DO $$
DECLARE spec uuid; n int;
BEGIN
  SET LOCAL test.uid = '00000000-0000-0000-0000-00000000000a';  -- master
  INSERT INTO public.kb_product_specs (product_code, product_name, supplier)
    VALUES ('B4.0001.00', 'spec B4', 'sayerlack') RETURNING id INTO spec;

  -- (a) SKU existente (oben,8001) → retorna 1
  SELECT public.confirmar_vinculo_boletim(spec, '[{"account":"oben","omie_codigo_produto":8001}]'::jsonb) INTO n;
  IF n <> 1 THEN RAISE EXCEPTION 'B4a FALHOU: confirmar retornou % (esperado 1) p/ SKU existente', n; END IF;
  RAISE NOTICE 'OK B4a — SKU existente (oben,8001) confirmado (retorno 1)';

  -- (b) SKU inexistente (oben,999999) → RAISE "inexistente em omie_products"
  BEGIN
    PERFORM public.confirmar_vinculo_boletim(spec, '[{"account":"oben","omie_codigo_produto":999999}]'::jsonb);
    RAISE EXCEPTION 'B4b FALHOU: SKU inexistente NÃO foi barrado (vínculo-fantasma)';
  EXCEPTION
    WHEN raise_exception THEN
      IF SQLERRM NOT ILIKE '%inexistente em omie_products%' THEN
        RAISE EXCEPTION 'B4b2 FALHOU: mensagem inesperada "%"', SQLERRM;
      END IF;
      RAISE NOTICE 'OK B4b — SKU inexistente barrado: %', SQLERRM;
  END;

  -- (c) caixa errada do account ('OBEN' maiúsculo) → RAISE "inexistente" (sem coerção)
  BEGIN
    PERFORM public.confirmar_vinculo_boletim(spec, '[{"account":"OBEN","omie_codigo_produto":8001}]'::jsonb);
    RAISE EXCEPTION 'B4c FALHOU: account com caixa errada NÃO foi barrado (coerção indevida)';
  EXCEPTION
    WHEN raise_exception THEN
      IF SQLERRM NOT ILIKE '%inexistente em omie_products%' THEN
        RAISE EXCEPTION 'B4c2 FALHOU: mensagem inesperada "%"', SQLERRM;
      END IF;
      RAISE NOTICE 'OK B4c — account caixa-errada barrado (sem coerção): %', SQLERRM;
  END;

  -- limpeza: libera o SKU (oben,8001) que (a) confirmou, pros asserts seguintes (B5/B6 reusam ele).
  DELETE FROM public.omie_product_spec_links WHERE account='oben' AND omie_codigo_produto=8001;
END $$;
SQL

echo ""
echo "→ ASSERT B4d — gate master do confirmar_vinculo SOBREVIVE ao CREATE OR REPLACE (employee → forbidden):"
# Eu reescrevi confirmar_vinculo_boletim (BLOCO C) — re-provo que o gate master continua de pé.
# RPC é SECURITY DEFINER, gate interno → só GUC (sem SET ROLE).
# ⚠️ a sentinela NÃO pode conter 'forbidden' (senão o handler ILIKE '%forbidden%' aceitaria a própria
# sentinela = teatro; é o furo que o Codex pegou no B6d).
P -v ON_ERROR_STOP=1 <<'SQL'
DO $$
DECLARE spec uuid;
BEGIN
  SELECT id INTO spec FROM public.kb_product_specs WHERE product_code = 'B4.0001.00';
  SET LOCAL test.uid = '00000000-0000-0000-0000-00000000000b';  -- employee
  BEGIN
    PERFORM public.confirmar_vinculo_boletim(spec, '[{"account":"oben","omie_codigo_produto":8001}]'::jsonb);
    RAISE EXCEPTION 'B4d FALHOU: employee passou no confirmar (gate ausente)';
  EXCEPTION
    WHEN raise_exception THEN
      IF SQLERRM NOT ILIKE '%forbidden%' THEN
        RAISE EXCEPTION 'B4d2 FALHOU: mensagem inesperada "%"', SQLERRM;
      END IF;
      RAISE NOTICE 'OK B4d — employee barrado no confirmar (gate master sobreviveu): %', SQLERRM;
  END;
END $$;
SQL

echo ""
echo "→ ASSERT B5 — contador ROW_COUNT real (P3; re-confirmar do mesmo dono retorna 0):"
P -v ON_ERROR_STOP=1 <<'SQL'
DO $$
DECLARE spec uuid; n1 int; n2 int; c int;
BEGIN
  SET LOCAL test.uid = '00000000-0000-0000-0000-00000000000a';  -- master
  INSERT INTO public.kb_product_specs (product_code, product_name, supplier)
    VALUES ('B5.0001.00', 'spec B5', 'sayerlack') RETURNING id INTO spec;

  -- 1ª confirmação (oben,8001)→spec → retorna 1
  SELECT public.confirmar_vinculo_boletim(spec, '[{"account":"oben","omie_codigo_produto":8001}]'::jsonb) INTO n1;
  IF n1 <> 1 THEN RAISE EXCEPTION 'B5a FALHOU: 1ª confirmação retornou % (esperado 1)', n1; END IF;

  -- 2ª confirmação IDÊNTICA (mesmo dono) → ON CONFLICT DO NOTHING → ROW_COUNT=0 → retorna 0 (NÃO 1)
  SELECT public.confirmar_vinculo_boletim(spec, '[{"account":"oben","omie_codigo_produto":8001}]'::jsonb) INTO n2;
  IF n2 <> 0 THEN RAISE EXCEPTION 'B5b FALHOU: 2ª confirmação (no-op) retornou % (esperado 0 — contador devia ser ROW_COUNT)', n2; END IF;
  RAISE NOTICE 'OK B5 — contador real: 1ª=1, 2ª (DO NOTHING)=0';

  -- count confirmed para (oben,8001) = 1 (não duplicou)
  SELECT count(*) INTO c FROM public.omie_product_spec_links
   WHERE account='oben' AND omie_codigo_produto=8001 AND status='confirmed';
  IF c <> 1 THEN RAISE EXCEPTION 'B5c FALHOU: % linhas confirmed (esperado 1)', c; END IF;
  RAISE NOTICE 'OK B5c — 1 linha confirmed (sem duplicata)';

  -- limpeza p/ liberar o SKU 8001 pro B6
  DELETE FROM public.omie_product_spec_links WHERE account='oben' AND omie_codigo_produto=8001;
END $$;
SQL

echo ""
echo "→ ASSERT B6 — desvincular_boletim (stale-delete=0; reatribuição; gate master):"
P -v ON_ERROR_STOP=1 <<'SQL'
DO $$
DECLARE specA uuid; specB uuid; d int; c int;
BEGIN
  SET LOCAL test.uid = '00000000-0000-0000-0000-00000000000a';  -- master
  INSERT INTO public.kb_product_specs (product_code, product_name, supplier)
    VALUES ('B6.000A.00', 'spec B6A', 'sayerlack') RETURNING id INTO specA;
  INSERT INTO public.kb_product_specs (product_code, product_name, supplier)
    VALUES ('B6.000B.00', 'spec B6B', 'sayerlack') RETURNING id INTO specB;

  -- master confirma (oben,8001)→specA
  PERFORM public.confirmar_vinculo_boletim(specA, '[{"account":"oben","omie_codigo_produto":8001}]'::jsonb);

  -- (a) desvincular com id ERRADO (stale UI) → retorna 0; count confirmed = 1 (nada apagado)
  SELECT public.desvincular_boletim('oben', 8001, '00000000-0000-0000-0000-0000000000ff') INTO d;
  IF d <> 0 THEN RAISE EXCEPTION 'B6a FALHOU: desvincular com id errado apagou % (esperado 0 — stale-delete)', d; END IF;
  SELECT count(*) INTO c FROM public.omie_product_spec_links
   WHERE account='oben' AND omie_codigo_produto=8001 AND status='confirmed';
  IF c <> 1 THEN RAISE EXCEPTION 'B6a2 FALHOU: % confirmed após stale-delete (esperado 1)', c; END IF;
  RAISE NOTICE 'OK B6a — id errado não apaga (retorno 0, 1 confirmed intacto)';

  -- (b) desvincular com o id CERTO → retorna 1; count confirmed = 0
  SELECT public.desvincular_boletim('oben', 8001, specA) INTO d;
  IF d <> 1 THEN RAISE EXCEPTION 'B6b FALHOU: desvincular com id certo retornou % (esperado 1)', d; END IF;
  SELECT count(*) INTO c FROM public.omie_product_spec_links
   WHERE account='oben' AND omie_codigo_produto=8001 AND status='confirmed';
  IF c <> 0 THEN RAISE EXCEPTION 'B6b2 FALHOU: % confirmed após desvincular certo (esperado 0)', c; END IF;
  RAISE NOTICE 'OK B6b — id certo desvincula (retorno 1, 0 confirmed)';

  -- (c) reatribuir: agora (oben,8001)→specB é aceito (SKU livre)
  SELECT public.confirmar_vinculo_boletim(specB, '[{"account":"oben","omie_codigo_produto":8001}]'::jsonb) INTO d;
  IF d <> 1 THEN RAISE EXCEPTION 'B6c FALHOU: reatribuição p/ specB retornou % (esperado 1)', d; END IF;
  RAISE NOTICE 'OK B6c — reatribuição (oben,8001)→specB aceita após desvincular';
END $$;
SQL
# (d) gate: employee chamando desvincular → forbidden. RPC é SECURITY DEFINER, gate interno → só GUC.
P -v ON_ERROR_STOP=1 <<'SQL'
DO $$
BEGIN
  SET LOCAL test.uid = '00000000-0000-0000-0000-00000000000b';  -- employee
  BEGIN
    PERFORM public.desvincular_boletim('oben', 8001, '00000000-0000-0000-0000-0000000000ff');
    -- ⚠️ sentinela SEM 'forbidden'/'master' (senão o handler ILIKE aceitaria a própria sentinela = teatro; Codex P2).
    RAISE EXCEPTION 'B6d FALHOU: employee passou no desvincular (gate ausente)';
  EXCEPTION
    WHEN raise_exception THEN
      IF SQLERRM NOT ILIKE '%forbidden%' THEN
        RAISE EXCEPTION 'B6d2 FALHOU: mensagem inesperada "%"', SQLERRM;
      END IF;
      RAISE NOTICE 'OK B6d — employee barrado no desvincular (gate master): %', SQLERRM;
  END;
END $$;
SQL

echo ""
echo "→ ASSERT B7 — CHECK não-negatividade (rendimento -1 → check_violation; 0 e NULL OK):"
P -v ON_ERROR_STOP=1 <<'SQL'
DO $$
DECLARE id0 uuid; idN uuid;
BEGIN
  -- CHECK é enforçado p/ TODOS (inclusive postgres) → insere direto como master via GUC + SET ROLE.
  SET ROLE authenticated;
  SET LOCAL test.uid = '00000000-0000-0000-0000-00000000000a';  -- master (passa a RLS de INSERT)

  -- (a) rendimento -1 → check_violation (constraint kb_spec_rendimento_nonneg)
  BEGIN
    INSERT INTO public.kb_product_specs (product_code, product_name, supplier, rendimento_m2_por_litro)
      VALUES ('B7.NEG.00', 'neg', 'sayerlack', -1);
    RESET ROLE;
    RAISE EXCEPTION 'B7a FALHOU: rendimento -1 NÃO foi barrado (CHECK ausente)';
  EXCEPTION
    WHEN check_violation THEN
      IF SQLERRM NOT ILIKE '%rendimento_nonneg%' THEN
        RAISE EXCEPTION 'B7a2 FALHOU: check_violation mas constraint inesperada "%"', SQLERRM;
      END IF;
      RAISE NOTICE 'OK B7a — rendimento -1 barrado (kb_spec_rendimento_nonneg): %', SQLERRM;
  END;

  -- (a2) catalisador_proporcao_pct -5 → check_violation (kb_spec_catalisador_pct_nonneg) — Codex P3: cobrir o CHECK que mais importa.
  BEGIN
    INSERT INTO public.kb_product_specs (product_code, product_name, supplier, catalisador_proporcao_pct)
      VALUES ('B7.CAT.00', 'cat', 'sayerlack', -5);
    RESET ROLE;
    RAISE EXCEPTION 'B7a3 FALHOU: catalisador_proporcao_pct -5 NÃO foi barrado (CHECK ausente)';
  EXCEPTION
    WHEN check_violation THEN
      IF SQLERRM NOT ILIKE '%catalisador_pct_nonneg%' THEN
        RAISE EXCEPTION 'B7a4 FALHOU: check_violation mas constraint inesperada "%"', SQLERRM;
      END IF;
      RAISE NOTICE 'OK B7a2 — catalisador_proporcao_pct -5 barrado (kb_spec_catalisador_pct_nonneg): %', SQLERRM;
  END;

  -- (b) rendimento 0 → OK
  INSERT INTO public.kb_product_specs (product_code, product_name, supplier, rendimento_m2_por_litro)
    VALUES ('B7.ZERO.00', 'zero', 'sayerlack', 0) RETURNING id INTO id0;
  RAISE NOTICE 'OK B7b — rendimento 0 aceito';

  -- (c) rendimento NULL → OK
  INSERT INTO public.kb_product_specs (product_code, product_name, supplier, rendimento_m2_por_litro)
    VALUES ('B7.NULL.00', 'nulo', 'sayerlack', NULL) RETURNING id INTO idN;
  RAISE NOTICE 'OK B7c — rendimento NULL aceito';

  RESET ROLE;
END $$;
SQL

echo ""
echo "→ ASSERT B8 — idempotência do apply manual (founder cola 2× no SQL Editor → roda limpo):"
# Re-aplica a migration INTEIRA por cima do estado já mutado pelos asserts. BLOCO A dropa as policies
# (antigas E novas) antes de criar; BLOCO B dropa+readiciona os CHECKs (re-valida as linhas semeadas,
# todas válidas); C/D são CREATE OR REPLACE. Qualquer erro → ON_ERROR_STOP + pipefail derrubam o script.
P -v ON_ERROR_STOP=1 -q -f "$REPO_ROOT/supabase/migrations/20260613120000_kb_0c_aprovacao_master_only.sql"
echo "  OK B8 — migration re-aplicada sem erro (idempotente; colar 2× é seguro)"

echo ""
echo "✅ test-kb-0c-aprovacao: todos os asserts passaram (B1..B8)"
