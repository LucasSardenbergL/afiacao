#!/usr/bin/env bash
# Teste PG17 do motor de casamento boletim↔item-de-venda (PR-0a). Money-path.
# Caminho LEVE (sem snapshot completo): aplica stubs mínimos do Supabase (auth/app_role/
# has_role/storage) + as 2 migrations de fundação do KB (20260517170000 + 20260517180000)
# + a migration nova (20260611140000) e EXECUTA 8 asserts:
#   A1 identidade composta pega dup de caixa/espaço que a UNIQUE textual global perde
#   A2 trigger espelha o helper (product_code_normalized + supplier lower)
#   A3 índice "one-confirmed" + múltiplos rejected
#   A4 view dupla-trava (confirmed + approved_at)
#   A5 confirmar_vinculo_boletim anti-roubo ("já vinculado")
#   A6 gate (employee barrado no confirmar; anon barrado no buscar)
#   A7 buscar_skus_candidatos (pré-filtro reverso)
#   A8 FALSIFICAÇÃO — sabota o gate master e EXIGE A6 ficar vermelho, depois restaura
# Disciplina de assert negativo (igual test-melhorias-rpcs.sh): captura a SQLSTATE/mensagem
# esperada e RE-LANÇA o resto — `WHEN OTHERS THEN 'OK'` cego é teatro.
# Base: db/verify-snapshot-replay.sh (bring-up PG17 keg-only) + db/test-melhorias-rpcs.sh.
# Pré-req: brew install postgresql@17 pgvector.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PGVER=17
PGBIN="/opt/homebrew/opt/postgresql@${PGVER}/bin"
PORT=5439   # porta dedicada p/ não colidir com outros scripts (5433/5436)
DATA="$(mktemp -d /tmp/pgtest-kb.XXXXXX)/data"
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
"$PGBIN/pg_ctl" -D "$DATA" -o "-p $PORT -k /tmp" -l /tmp/pg-kb.log -w start >/dev/null
"$PGBIN/createdb" -p "$PORT" -h /tmp -U postgres kb_verify
P() { "$PGBIN/psql" -p "$PORT" -h /tmp -U postgres -d kb_verify "$@"; }

echo "→ stubs mínimos do Supabase (roles, auth, app_role, user_roles, has_role, storage)…"
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

-- omie_products (stub mínimo: o que buscar_skus_candidatos lê).
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

echo "→ migration 20260611140000_kb_fundacao_casamento.sql (a NOVA)…"
P -v ON_ERROR_STOP=1 -q -f "$REPO_ROOT/supabase/migrations/20260611140000_kb_fundacao_casamento.sql"

echo "→ seed (master, employee, 1 sku omie)…"
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

-- SKU Omie: descricao traz o código FO20.6827.00GL (pra A7 casar por '6827').
INSERT INTO public.omie_products (omie_codigo_produto, codigo, descricao, account, ativo) VALUES
  (5001, 'PRD5001', 'VERNIZ PU FO20.6827.00GL', 'oben', true)
ON CONFLICT DO NOTHING;

-- Grant p/ os testes de gate via SET ROLE (RLS/REVOKE filtram por cima).
GRANT SELECT ON public.omie_product_spec_links TO authenticated, anon;
SQL

echo ""
echo "→ ASSERT A1 — identidade composta pega dup de caixa/espaço (que a UNIQUE textual global perde):"
P -v ON_ERROR_STOP=1 <<'SQL'
DO $$
BEGIN
  -- Spec 1: forma canônica.
  INSERT INTO public.kb_product_specs (supplier, product_code, product_name)
  VALUES ('sayerlack', 'FO20.6827.00', 'Verniz A');

  -- Spec 2: MESMA identidade após normalização (Sayerlack→sayerlack, ' fo20.6827.00 '→FO20.6827.00).
  -- A UNIQUE(product_code) global NÃO pega (textos diferentes: 'FO20.6827.00' vs ' fo20.6827.00 ');
  -- a composta UNIQUE(supplier, product_code_normalized) DEVE pegar.
  BEGIN
    INSERT INTO public.kb_product_specs (supplier, product_code, product_name)
    VALUES ('Sayerlack', ' fo20.6827.00 ', 'Verniz B');
    RAISE EXCEPTION 'A1 FALHOU: dup de caixa/espaço NÃO foi barrada pela identidade composta';
  EXCEPTION
    WHEN unique_violation THEN
      IF SQLERRM NOT ILIKE '%supplier_code_norm%' THEN
        RAISE EXCEPTION 'A1b FALHOU: violou outra constraint que não a composta: %', SQLERRM;
      END IF;
      RAISE NOTICE 'OK A1 — identidade composta barrou a dup (constraint kb_product_specs_supplier_code_norm_key)';
  END;
END $$;
SQL

echo ""
echo "→ ASSERT A2 — trigger espelha o helper (product_code_normalized + supplier lower):"
P -v ON_ERROR_STOP=1 <<'SQL'
DO $$
DECLARE
  v_norm text;
  v_sup  text;
  v_id   uuid;
BEGIN
  INSERT INTO public.kb_product_specs (supplier, product_code, product_name)
  VALUES ('SAYERLACK', 'fo20.6827.00gl', 'Verniz GL')
  RETURNING id, product_code_normalized, supplier INTO v_id, v_norm, v_sup;

  IF v_norm <> 'FO20.6827.00GL' THEN
    RAISE EXCEPTION 'A2 FALHOU: product_code_normalized=% (esperado FO20.6827.00GL)', v_norm;
  END IF;
  IF v_sup <> 'sayerlack' THEN
    RAISE EXCEPTION 'A2b FALHOU: supplier=% (esperado sayerlack lower)', v_sup;
  END IF;
  RAISE NOTICE 'OK A2 — normalized=FO20.6827.00GL, supplier=sayerlack';

  -- Limpeza p/ não poluir os asserts seguintes de vínculo (sobra só "Verniz A" + esta).
  DELETE FROM public.kb_product_specs WHERE id = v_id;
END $$;
SQL

echo ""
echo "→ ASSERT A3 — índice one-confirmed + múltiplos rejected:"
P -v ON_ERROR_STOP=1 <<'SQL'
DO $$
DECLARE
  spec_a uuid;
  spec_b uuid;
BEGIN
  SELECT id INTO spec_a FROM public.kb_product_specs WHERE product_name = 'Verniz A';
  INSERT INTO public.kb_product_specs (supplier, product_code, product_name)
  VALUES ('sayerlack', 'XX99.0001.00', 'Verniz C') RETURNING id INTO spec_b;

  -- 1º confirmed p/ (oben, 9001) → OK
  INSERT INTO public.omie_product_spec_links (account, omie_codigo_produto, kb_product_spec_id, status)
  VALUES ('oben', 9001, spec_a, 'confirmed');

  -- 2º confirmed p/ o MESMO (oben, 9001) com outro spec → barrado (one-confirmed parcial)
  BEGIN
    INSERT INTO public.omie_product_spec_links (account, omie_codigo_produto, kb_product_spec_id, status)
    VALUES ('oben', 9001, spec_b, 'confirmed');
    RAISE EXCEPTION 'A3 FALHOU: 2º confirmed pro mesmo SKU NÃO foi barrado';
  EXCEPTION
    WHEN unique_violation THEN
      IF SQLERRM NOT ILIKE '%one_confirmed%' THEN
        RAISE EXCEPTION 'A3b FALHOU: violou outra constraint: %', SQLERRM;
      END IF;
      RAISE NOTICE 'OK A3a — 2º confirmed pro mesmo SKU barrado (one-confirmed)';
  END;

  -- 2 rejected p/ o MESMO (oben, 9002) com specs DIFERENTES → ambos OK (índice parcial só sobre confirmed)
  INSERT INTO public.omie_product_spec_links (account, omie_codigo_produto, kb_product_spec_id, status)
  VALUES ('oben', 9002, spec_a, 'rejected');
  INSERT INTO public.omie_product_spec_links (account, omie_codigo_produto, kb_product_spec_id, status)
  VALUES ('oben', 9002, spec_b, 'rejected');
  RAISE NOTICE 'OK A3b — 2 rejected (specs distintos) pro mesmo SKU permitidos';
END $$;
SQL

echo ""
echo "→ ASSERT A4 — view dupla-trava (confirmed + approved_at):"
P -v ON_ERROR_STOP=1 <<'SQL'
DO $$
DECLARE
  spec_v uuid;
  n int;
BEGIN
  -- SKU/spec próprios pra A4 (isolado dos de A3).
  INSERT INTO public.kb_product_specs (supplier, product_code, product_name, approved_at)
  VALUES ('sayerlack', 'V001.1234.00', 'Verniz View', now()) RETURNING id INTO spec_v;

  INSERT INTO public.omie_product_spec_links (account, omie_codigo_produto, kb_product_spec_id, status)
  VALUES ('oben', 7777, spec_v, 'confirmed');

  -- confirmed + approved_at != null → 1 linha
  SELECT count(*) INTO n FROM public.v_omie_product_current_spec
   WHERE account='oben' AND omie_codigo_produto=7777;
  IF n <> 1 THEN RAISE EXCEPTION 'A4a FALHOU: view deveria ter 1 linha (confirmed+approved), tem %', n; END IF;
  RAISE NOTICE 'OK A4a — view mostra 1 (confirmed + approved_at)';

  -- approved_at = NULL → 0 linhas
  UPDATE public.kb_product_specs SET approved_at = NULL WHERE id = spec_v;
  SELECT count(*) INTO n FROM public.v_omie_product_current_spec
   WHERE account='oben' AND omie_codigo_produto=7777;
  IF n <> 0 THEN RAISE EXCEPTION 'A4b FALHOU: spec não-aprovado deveria sumir da view, tem %', n; END IF;
  RAISE NOTICE 'OK A4b — spec sem approved_at some da view';

  -- restaura approved + vira link rejected → 0 linhas
  UPDATE public.kb_product_specs SET approved_at = now() WHERE id = spec_v;
  UPDATE public.omie_product_spec_links SET status='rejected'
   WHERE account='oben' AND omie_codigo_produto=7777 AND kb_product_spec_id=spec_v;
  SELECT count(*) INTO n FROM public.v_omie_product_current_spec
   WHERE account='oben' AND omie_codigo_produto=7777;
  IF n <> 0 THEN RAISE EXCEPTION 'A4c FALHOU: link rejected deveria sumir da view, tem %', n; END IF;
  RAISE NOTICE 'OK A4c — link rejected some da view';

  -- limpeza
  DELETE FROM public.omie_product_spec_links WHERE account='oben' AND omie_codigo_produto=7777;
  DELETE FROM public.kb_product_specs WHERE id = spec_v;
END $$;
SQL

echo ""
echo "→ ASSERT A5 — confirmar_vinculo_boletim anti-roubo (master):"
P -v ON_ERROR_STOP=1 <<'SQL'
DO $$
DECLARE
  spec1 uuid;
  spec2 uuid;
  n int;
BEGIN
  SET LOCAL test.uid = '00000000-0000-0000-0000-00000000000a';  -- master

  INSERT INTO public.kb_product_specs (supplier, product_code, product_name)
  VALUES ('sayerlack', 'A5SP.0001.00', 'Spec1 A5') RETURNING id INTO spec1;
  INSERT INTO public.kb_product_specs (supplier, product_code, product_name)
  VALUES ('sayerlack', 'A5SP.0002.00', 'Spec2 A5') RETURNING id INTO spec2;

  -- master confirma (oben, 6001) → spec1, via RPC. Retorna 1.
  SELECT public.confirmar_vinculo_boletim(spec1, '[{"account":"oben","omie_codigo_produto":6001}]'::jsonb) INTO n;
  IF n <> 1 THEN RAISE EXCEPTION 'A5a FALHOU: confirmar retornou % (esperado 1)', n; END IF;
  RAISE NOTICE 'OK A5a — master confirmou (oben,6001)→spec1';

  -- tentar confirmar o MESMO SKU pra spec2 → RAISE "já vinculado"
  BEGIN
    PERFORM public.confirmar_vinculo_boletim(spec2, '[{"account":"oben","omie_codigo_produto":6001}]'::jsonb);
    RAISE EXCEPTION 'A5b FALHOU: roubo de SKU já vinculado NÃO foi bloqueado';
  EXCEPTION
    WHEN raise_exception THEN
      IF SQLERRM NOT ILIKE '%já vinculado%' THEN
        RAISE EXCEPTION 'A5c FALHOU: mensagem inesperada "%"', SQLERRM;
      END IF;
      RAISE NOTICE 'OK A5b — anti-roubo barrou: %', SQLERRM;
  END;

  -- idempotência: re-confirmar (oben,6001)→spec1 (mesmo dono) → não estoura, retorna 1, sem dup
  SELECT public.confirmar_vinculo_boletim(spec1, '[{"account":"oben","omie_codigo_produto":6001}]'::jsonb) INTO n;
  SELECT count(*) INTO n FROM public.omie_product_spec_links
   WHERE account='oben' AND omie_codigo_produto=6001 AND status='confirmed';
  IF n <> 1 THEN RAISE EXCEPTION 'A5d FALHOU: re-confirmar duplicou (% linhas confirmed)', n; END IF;
  RAISE NOTICE 'OK A5d — re-confirmar do mesmo dono é idempotente (1 linha)';
END $$;
SQL

echo ""
echo "→ ASSERT A6 — gate (employee barrado no confirmar; anon barrado no buscar):"
P -v ON_ERROR_STOP=1 <<'SQL'
DO $$
DECLARE
  spec uuid;
BEGIN
  SELECT id INTO spec FROM public.kb_product_specs WHERE product_name = 'Verniz A';

  -- A6a: employee (não-master) chama confirmar_vinculo_boletim → forbidden
  SET LOCAL test.uid = '00000000-0000-0000-0000-00000000000b';  -- employee
  BEGIN
    PERFORM public.confirmar_vinculo_boletim(spec, '[{"account":"oben","omie_codigo_produto":6002}]'::jsonb);
    RAISE EXCEPTION 'A6a FALHOU: employee NÃO foi barrado no confirmar (gate master ausente)';
  EXCEPTION
    WHEN raise_exception THEN
      IF SQLERRM NOT ILIKE '%forbidden%' AND SQLERRM NOT ILIKE '%master%' THEN
        RAISE EXCEPTION 'A6b FALHOU: mensagem inesperada "%"', SQLERRM;
      END IF;
      RAISE NOTICE 'OK A6a — employee barrado no confirmar: %', SQLERRM;
  END;

  -- A6c: anon (uid NULL) chama buscar_skus_candidatos → forbidden
  SET LOCAL test.uid = '';  -- anon
  BEGIN
    PERFORM public.buscar_skus_candidatos(ARRAY['6827']);
    RAISE EXCEPTION 'A6c FALHOU: anon NÃO foi barrado no buscar (gate staff ausente)';
  EXCEPTION
    WHEN raise_exception THEN
      IF SQLERRM NOT ILIKE '%forbidden%' THEN
        RAISE EXCEPTION 'A6d FALHOU: mensagem inesperada "%"', SQLERRM;
      END IF;
      RAISE NOTICE 'OK A6c — anon barrado no buscar: %', SQLERRM;
  END;
END $$;
SQL

echo ""
echo "→ ASSERT A7 — buscar_skus_candidatos (pré-filtro reverso, employee):"
P -v ON_ERROR_STOP=1 <<'SQL'
DO $$
DECLARE
  n_hit int;
  n_miss int;
BEGIN
  SET LOCAL test.uid = '00000000-0000-0000-0000-00000000000b';  -- employee (staff)

  -- termo '6827' casa a descrição 'VERNIZ PU FO20.6827.00GL'
  SELECT count(*) INTO n_hit FROM public.buscar_skus_candidatos(ARRAY['6827'])
   WHERE omie_codigo_produto = 5001;
  IF n_hit <> 1 THEN RAISE EXCEPTION 'A7a FALHOU: termo 6827 deveria casar o SKU 5001, casou %', n_hit; END IF;
  RAISE NOTICE 'OK A7a — termo 6827 casa o SKU 5001';

  -- termo '9999' não casa nada
  SELECT count(*) INTO n_miss FROM public.buscar_skus_candidatos(ARRAY['9999']);
  IF n_miss <> 0 THEN RAISE EXCEPTION 'A7b FALHOU: termo 9999 não deveria casar nada, casou %', n_miss; END IF;
  RAISE NOTICE 'OK A7b — termo 9999 não casa nada';
END $$;
SQL

echo ""
echo "→ ASSERT A8 — FALSIFICAÇÃO do gate master (prova que A6a realmente guarda):"
# Sabota: troca o gate master de confirmar_vinculo_boletim por 'IF false THEN' (sempre passa).
# Com o gate neutralizado, a checagem do A6a (employee deveria ser barrado) TEM que FALHAR.
# Se NÃO falhar, o assert A6a é teatro → o script todo falha. Depois RESTAURA o gate original.
P -v ON_ERROR_STOP=1 -q <<'SQL'
-- Versão SABOTADA: gate master neutralizado (IF false THEN ... = nunca barra).
CREATE OR REPLACE FUNCTION public.confirmar_vinculo_boletim(
  p_kb_product_spec_id uuid, p_skus jsonb
) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $f$
DECLARE
  v_uid uuid := auth.uid();
  v_item jsonb; v_account text; v_cod bigint; v_count integer := 0; v_dono uuid;
BEGIN
  IF false THEN  -- SABOTADO (era: IF NOT public.has_role(v_uid,'master'::app_role) THEN)
    RAISE EXCEPTION 'forbidden: somente master';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.kb_product_specs WHERE id = p_kb_product_spec_id) THEN
    RAISE EXCEPTION 'spec inexistente';
  END IF;
  FOR v_item IN SELECT * FROM jsonb_array_elements(p_skus) LOOP
    v_account := v_item->>'account';
    v_cod := (v_item->>'omie_codigo_produto')::bigint;
    SELECT kb_product_spec_id INTO v_dono FROM public.omie_product_spec_links
      WHERE account = v_account AND omie_codigo_produto = v_cod AND status = 'confirmed';
    IF v_dono IS NOT NULL AND v_dono <> p_kb_product_spec_id THEN
      RAISE EXCEPTION 'SKU %/% já vinculado a outro boletim', v_account, v_cod;
    END IF;
    INSERT INTO public.omie_product_spec_links
      (account, omie_codigo_produto, kb_product_spec_id, status, confirmed_by)
    VALUES (v_account, v_cod, p_kb_product_spec_id, 'confirmed', v_uid)
    ON CONFLICT (account, omie_codigo_produto, kb_product_spec_id, status) DO NOTHING;
    v_count := v_count + 1;
  END LOOP;
  RETURN v_count;
END;
$f$;
SQL

# Re-roda a CHECAGEM do A6a contra a função sabotada e EXIGE que ela passe (= employee NÃO barrado).
# Sucesso aqui = a sabotagem foi detectada = o assert A6a tem dente.
# ⚠️ 2>&1 vai NA LINHA do heredoc (antes do <<) — psql manda NOTICE pra stderr; pôr o
# redirect DEPOIS do terminador 'SQL' atacaria o comando seguinte, não o psql (mordeu 1×).
A8=$(P -tA 2>&1 <<'SQL' || true
DO $$
DECLARE spec uuid;
BEGIN
  SELECT id INTO spec FROM public.kb_product_specs WHERE product_name = 'Verniz A';
  SET LOCAL test.uid = '00000000-0000-0000-0000-00000000000b';  -- employee
  -- com o gate sabotado, isto NÃO deve estourar 'forbidden'; deve INSERIR (employee passou)
  PERFORM public.confirmar_vinculo_boletim(spec, '[{"account":"oben","omie_codigo_produto":6099}]'::jsonb);
  RAISE NOTICE 'SABOTAGEM_PASSOU';  -- employee conseguiu confirmar (gate furado, como esperado da sabotagem)
END $$;
SQL
)
if echo "$A8" | grep -q 'SABOTAGEM_PASSOU'; then
  echo "  OK A8 — gate sabotado deixou o employee confirmar → o assert A6a REALMENTE guarda (não é teatro)"
else
  echo "  A8 FALHOU: mesmo com o gate sabotado o employee foi barrado — o assert A6a NÃO está testando o gate."
  echo "  saída: $A8"
  exit 1
fi

echo "→ A8 — restaurando o gate master original (re-aplica a migration; CREATE OR REPLACE)…"
# Limpa a linha que a sabotagem inseriu (senão poluiria) e restaura a função verdadeira.
P -v ON_ERROR_STOP=1 -q -c "DELETE FROM public.omie_product_spec_links WHERE account='oben' AND omie_codigo_produto=6099;"
# Restaura SÓ a função (re-roda o BLOCO E da migration via re-aplicação idempotente da migration inteira).
P -v ON_ERROR_STOP=1 -q -f "$REPO_ROOT/supabase/migrations/20260611140000_kb_fundacao_casamento.sql"

# Prova que o gate VOLTOU: employee barrado de novo.
A8R=$(P -tA 2>&1 <<'SQL' || true
DO $$
DECLARE spec uuid;
BEGIN
  SELECT id INTO spec FROM public.kb_product_specs WHERE product_name = 'Verniz A';
  SET LOCAL test.uid = '00000000-0000-0000-0000-00000000000b';
  BEGIN
    PERFORM public.confirmar_vinculo_boletim(spec, '[{"account":"oben","omie_codigo_produto":6098}]'::jsonb);
    RAISE NOTICE 'GATE_AINDA_FURADO';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM ILIKE '%forbidden%' OR SQLERRM ILIKE '%master%' THEN
      RAISE NOTICE 'GATE_RESTAURADO';
    ELSE
      RAISE NOTICE 'GATE_ERRO_INESPERADO: %', SQLERRM;
    END IF;
  END;
END $$;
SQL
)
if echo "$A8R" | grep -q 'GATE_RESTAURADO'; then
  echo "  OK A8 (restauração) — gate master de volta, employee barrado novamente"
else
  echo "  A8 FALHOU (restauração): gate não voltou. saída: $A8R"
  exit 1
fi

echo ""
echo "→ ASSERT A9 — NFKC: ligadura ﬀ (U+FB00) é expandida pra 'ff' antes de upper:"
P -v ON_ERROR_STOP=1 <<'SQL'
DO $$
DECLARE
  v_norm text;
  v_id   uuid;
BEGIN
  -- U+FB00 (ﬀ) é uma ligadura "ff"; normalize(…, NFKC) expande pra 'ff'; upper → 'FF'.
  -- Sem o NFKC, a ligadura sobreviveria ao upper e o normalized seria algo diferente de 'FF20.6827.00'.
  INSERT INTO public.kb_product_specs (supplier, product_code, product_name)
  VALUES ('sayerlack', E'ﬀ20.6827.00', 'nfkc')
  RETURNING id, product_code_normalized INTO v_id, v_norm;

  IF v_norm <> 'FF20.6827.00' THEN
    RAISE EXCEPTION 'A9 FALHOU: normalized=% (esperado FF20.6827.00 — NFKC expandiu ﬀ→ff)', v_norm;
  END IF;
  RAISE NOTICE 'OK A9 — NFKC expandiu ligadura ﬀ→FF: normalized=%', v_norm;

  DELETE FROM public.kb_product_specs WHERE id = v_id;
END $$;
SQL

echo ""
echo "→ ASSERT A10 — LIKE-escape: termo '%' literal NÃO casa nenhum produto (sem escape casaria tudo):"
P -v ON_ERROR_STOP=1 <<'SQL'
DO $$
DECLARE
  n int;
BEGIN
  SET LOCAL test.uid = '00000000-0000-0000-0000-00000000000b';  -- employee (staff)

  -- Garantia: nenhum omie_products semeado contém '%' literal na descrição.
  -- O buscar_skus_candidatos deve escapar '%' → '\%' (literal), casando 0 linhas.
  -- Sem o escape, LIKE '%\%%' ainda casaria todas as linhas (qualquer string).
  SELECT count(*) INTO n FROM public.buscar_skus_candidatos(ARRAY['%']);
  IF n <> 0 THEN
    RAISE EXCEPTION 'A10 FALHOU: termo %% casou % linhas (esperado 0 — LIKE-escape ausente)', n;
  END IF;
  RAISE NOTICE 'OK A10 — termo %% escapado corretamente (0 linhas)';
END $$;
SQL

echo ""
echo "✅ test-kb-fundacao-casamento: todos os asserts passaram (A1..A10)"
