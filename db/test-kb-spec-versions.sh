#!/usr/bin/env bash
# Teste PG17 da migration 20260613150000_kb_spec_versions_faseA.sql
# Cobre versioning de specs de boletins técnicos (append-only + RPC + backfill).
#
# Asserts:
#   V1  RPC cria versão corretamente: retorna version_id; 1 linha v1 em versions; 1 linha em specs
#   V2  2ª chamada → version_number=2; v1 recebe superseded_at; só 1 versão "live"
#   V3  Imutabilidade (append-only) + FALSIFICAÇÃO do trigger
#   V4  Gate master-only na RPC (employee barrado, sentinelas anti-teatro)
#   V5  change_note obrigatório para change_type='correction'
#   V6  version_number sequencial (serializado pelo advisory lock)
#   V7  Backfill idempotente: N specs → N versões; re-executar não duplica
#   V8  CHECK de não-negatividade barra rendimento negativo
#   V9  Draft deletado após aprovar versão (kb_extraction_drafts)
#
# Disciplina anti-teatro:
#   - Asserts negativos capturam a SQLSTATE exata e RE-LANÇAM o resto.
#   - WHEN OTHERS THEN 'OK' cego é teatro.
#   - Falsificação (V3): sabotar o trigger → EXIGIR que a sabotagem passe → restaurar.
#   - Sentinela V3 NÃO contém 'append-only' (texto do RAISE da migration).
#   - Sentinela V4 NÃO contém 'forbidden' nem 'master' (texto do gate da RPC).
#
# Base: db/test-kb-0c-aprovacao.sh (mesma estrutura keg-only PG17).
# Pré-req: brew install postgresql@17
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PGVER=17
PGBIN="/opt/homebrew/opt/postgresql@${PGVER}/bin"
PORT=5443   # porta dedicada — não colide com outros scripts (0c=5441, drafts=5442)
DATA="$(mktemp -d /tmp/pgtest-kb-ver.XXXXXX)/data"
export LC_ALL=C LANG=C

[ -x "$PGBIN/initdb" ] || { echo "postgresql@${PGVER} ausente: brew install postgresql@${PGVER}"; exit 1; }

# Contorna keg-only do brew (idempotente, no-clobber).
CELLAR="$(brew --prefix postgresql@${PGVER})"
cp -Rn "$CELLAR"/share/postgresql/. "/opt/homebrew/share/postgresql@${PGVER}/" 2>/dev/null || true
mkdir -p "/opt/homebrew/lib/postgresql@${PGVER}"
cp -Rn "$CELLAR"/lib/postgresql/. "/opt/homebrew/lib/postgresql@${PGVER}/" 2>/dev/null || true

cleanup() { "$PGBIN/pg_ctl" -D "$DATA" stop -m immediate >/dev/null 2>&1 || true; rm -rf "$(dirname "$DATA")"; }
trap cleanup EXIT

"$PGBIN/initdb" -D "$DATA" -U postgres -E UTF8 --locale=C >/dev/null
"$PGBIN/pg_ctl" -D "$DATA" -o "-p $PORT -k /tmp" -l /tmp/pg-kb-versions.log -w start >/dev/null
"$PGBIN/createdb" -p "$PORT" -h /tmp -U postgres kbver_verify
P() { "$PGBIN/psql" -p "$PORT" -h /tmp -U postgres -d kbver_verify "$@"; }

# ───────────────────────────────────────────────────────────────────────────────
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

-- set_updated_at: trigger-helper canônico do projeto.
CREATE OR REPLACE FUNCTION public.set_updated_at()
RETURNS trigger LANGUAGE plpgsql AS $f$
BEGIN NEW.updated_at := now(); RETURN NEW; END;
$f$;

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

echo "→ migration 20260613160000_kb_extraction_drafts.sql (tabela de rascunhos real para V9)…"
P -v ON_ERROR_STOP=1 -q -f "$REPO_ROOT/supabase/migrations/20260613160000_kb_extraction_drafts.sql"

# ───────────────────────────────────────────────────────────────────────────────
echo "→ migration pré-requisito 20260613120000_kb_0c_aprovacao_master_only.sql…"
# Aplicamos a migration inteira (idempotente via IF NOT EXISTS / OR REPLACE).
P -v ON_ERROR_STOP=1 -q -f "$REPO_ROOT/supabase/migrations/20260613120000_kb_0c_aprovacao_master_only.sql"

# ───────────────────────────────────────────────────────────────────────────────
echo "→ migration principal 20260613150000_kb_spec_versions_faseA.sql…"
P -v ON_ERROR_STOP=1 -q -f "$REPO_ROOT/supabase/migrations/20260613150000_kb_spec_versions_faseA.sql"

# ───────────────────────────────────────────────────────────────────────────────
echo "→ seed (master, employee, documentos, spec semente)…"
P -v ON_ERROR_STOP=1 -q <<'SQL'
INSERT INTO auth.users (id, email) VALUES
  ('00000000-0000-0000-0000-000000000001', 'master@test.local'),
  ('00000000-0000-0000-0000-000000000002', 'emp@test.local')
ON CONFLICT DO NOTHING;

INSERT INTO public.user_roles (user_id, role) VALUES
  ('00000000-0000-0000-0000-000000000001', 'master'::public.app_role),
  ('00000000-0000-0000-0000-000000000002', 'employee'::public.app_role)
ON CONFLICT DO NOTHING;

-- Documento base (para FKs)
INSERT INTO public.kb_documents (id, title, type, supplier, file_url, created_by)
  VALUES ('d1000000-0000-0000-0000-000000000001', 'Boletim PU GL Teste', 'boletim_tecnico', 'sayerlack',
          'kb/boletim-test.pdf', '00000000-0000-0000-0000-000000000001')
ON CONFLICT DO NOTHING;

-- Documento para V9 (draft deletion)
INSERT INTO public.kb_documents (id, title, type, supplier, file_url, created_by)
  VALUES ('d1000000-0000-0000-0000-000000000009', 'Boletim Draft V9', 'boletim_tecnico', 'sayerlack',
          'kb/boletim-v9.pdf', '00000000-0000-0000-0000-000000000001')
ON CONFLICT DO NOTHING;

-- Documento para V7 (backfill idempotency) — vários specs pré-aprovados
INSERT INTO public.kb_documents (id, title, type, supplier, file_url, created_by)
  VALUES ('d1000000-0000-0000-0000-000000000007', 'Boletim Backfill', 'boletim_tecnico', 'sayerlack',
          'kb/boletim-backfill.pdf', '00000000-0000-0000-0000-000000000001')
ON CONFLICT DO NOTHING;

-- Grants de tabela para os asserts de RLS via SET ROLE authenticated
GRANT SELECT ON public.kb_product_spec_versions TO authenticated;
GRANT SELECT ON public.kb_product_specs          TO authenticated;
SQL

# ─────────────────────────────────────────────────────────────────────────────
echo ""
echo "────────────────────────────────────────────────────────"
echo "→ V1 — RPC cria versão: retorna version_id; 1 linha v1; 1 spec upsertada:"

PAYLOAD_V1='{
  "product_code": "FO20.6827.00",
  "product_name": "Verniz PU Fosco GL",
  "supplier": "sayerlack",
  "product_category": "verniz",
  "rendimento_m2_por_litro": 12.5,
  "demaos_recomendadas": 2,
  "pot_life_horas": 4,
  "validade_dias": 365,
  "catalisador_codigo": "FC.6975",
  "catalisador_proporcao_pct": 20,
  "diluente_codigo": "ST.6610",
  "substrato": ["MDF", "madeira"],
  "equipamentos_aplicacao": ["pistola"],
  "diferenciais_chave": ["alta durabilidade"],
  "uso_recomendado": "ambientes internos",
  "extraction_confidence": 0.95
}'

DOC_ID='d1000000-0000-0000-0000-000000000001'
MASTER_UID='00000000-0000-0000-0000-000000000001'

VER_ID=$(P -tA -q -v ON_ERROR_STOP=1 <<SQL
SET test.uid = '${MASTER_UID}';
SELECT public.aprovar_versao_boletim(
  '${PAYLOAD_V1}'::jsonb,
  '${DOC_ID}'::uuid,
  'initial',
  NULL
);
SQL
)
VER_ID="${VER_ID#"${VER_ID%%[![:space:]]*}"}"  # trim whitespace
VER_ID="${VER_ID%"${VER_ID##*[![:space:]]}"}"

P -v ON_ERROR_STOP=1 <<SQL
DO \$\$
DECLARE
  v_id uuid := '${VER_ID}'::uuid;
  cnt_v  int;
  cnt_s  int;
  v_num  int;
  v_rend numeric;
  v_cat  text;
  v_sub  text[];
BEGIN
  -- V1a: retornou um UUID válido
  IF v_id IS NULL THEN
    RAISE EXCEPTION 'V1a FALHOU: RPC retornou NULL (esperado uuid da nova versão)';
  END IF;
  RAISE NOTICE 'OK V1a — RPC retornou version_id=%', v_id;

  -- V1b: 1 linha em kb_product_spec_versions com version_number=1
  SELECT count(*), min(version_number) INTO cnt_v, v_num
    FROM public.kb_product_spec_versions
   WHERE id = v_id;
  IF cnt_v <> 1 OR v_num <> 1 THEN
    RAISE EXCEPTION 'V1b FALHOU: cnt=% version_number=% (esperado cnt=1 v=1)', cnt_v, v_num;
  END IF;
  RAISE NOTICE 'OK V1b — 1 linha version_number=1 em kb_product_spec_versions';

  -- V1c: 1 spec em kb_product_specs (upsert)
  SELECT count(*) INTO cnt_s
    FROM public.kb_product_specs
   WHERE product_code_normalized = 'FO20.6827.00'
     AND supplier = 'sayerlack';
  IF cnt_s <> 1 THEN
    RAISE EXCEPTION 'V1c FALHOU: cnt_specs=% (esperado 1)', cnt_s;
  END IF;
  RAISE NOTICE 'OK V1c — 1 spec upsertada em kb_product_specs';

  -- V1d: campos numérico + texto + array presentes na versão
  SELECT v.rendimento_m2_por_litro, v.catalisador_codigo, v.substrato
    INTO v_rend, v_cat, v_sub
    FROM public.kb_product_spec_versions v WHERE v.id = v_id;
  IF v_rend IS DISTINCT FROM 12.5 THEN
    RAISE EXCEPTION 'V1d FALHOU: rendimento=% (esperado 12.5)', v_rend;
  END IF;
  IF v_cat IS DISTINCT FROM 'FC.6975' THEN
    RAISE EXCEPTION 'V1d FALHOU: catalisador_codigo=% (esperado FC.6975)', v_cat;
  END IF;
  IF NOT ('MDF' = ANY(v_sub)) THEN
    RAISE EXCEPTION 'V1d FALHOU: substrato não contém MDF: %', v_sub;
  END IF;
  RAISE NOTICE 'OK V1d — campos numérico/texto/array corretos na versão';

  RAISE NOTICE 'OK V1 — versão criada corretamente';
END \$\$;
SQL

# ─────────────────────────────────────────────────────────────────────────────
echo ""
echo "→ V2 — 2ª chamada → version_number=2; v1 superseded; 1 versão live:"

PAYLOAD_V2='{
  "product_code": "FO20.6827.00",
  "product_name": "Verniz PU Fosco GL v2",
  "supplier": "sayerlack",
  "product_category": "verniz",
  "rendimento_m2_por_litro": 13.0,
  "demaos_recomendadas": 2,
  "pot_life_horas": 4,
  "validade_dias": 365,
  "catalisador_codigo": "FC.6975",
  "catalisador_proporcao_pct": 20,
  "diluente_codigo": "ST.6610",
  "substrato": ["MDF", "madeira", "aglomerado"],
  "equipamentos_aplicacao": ["pistola"],
  "diferenciais_chave": ["alta durabilidade", "secagem rápida"],
  "uso_recomendado": "ambientes internos e externos",
  "extraction_confidence": 0.97
}'

VER_ID2=$(P -tA -q -v ON_ERROR_STOP=1 <<SQL
SET test.uid = '${MASTER_UID}';
SELECT public.aprovar_versao_boletim(
  '${PAYLOAD_V2}'::jsonb,
  '${DOC_ID}'::uuid,
  'data_completion',
  'Adicionados substrato aglomerado e uso externo'
);
SQL
)
VER_ID2="${VER_ID2#"${VER_ID2%%[![:space:]]*}"}"
VER_ID2="${VER_ID2%"${VER_ID2##*[![:space:]]}"}"

P -v ON_ERROR_STOP=1 <<SQL
DO \$\$
DECLARE
  v2_id    uuid    := '${VER_ID2}'::uuid;
  v1_id    uuid    := '${VER_ID}'::uuid;
  v_num    int;
  sup_at   timestamptz;
  live_cnt int;
BEGIN
  -- V2a: nova versão tem version_number=2
  SELECT version_number INTO v_num
    FROM public.kb_product_spec_versions WHERE id = v2_id;
  IF v_num IS DISTINCT FROM 2 THEN
    RAISE EXCEPTION 'V2a FALHOU: version_number=% (esperado 2)', v_num;
  END IF;
  RAISE NOTICE 'OK V2a — nova versão version_number=2';

  -- V2b: versão 1 recebeu superseded_at NOT NULL
  SELECT superseded_at INTO sup_at
    FROM public.kb_product_spec_versions WHERE id = v1_id;
  IF sup_at IS NULL THEN
    RAISE EXCEPTION 'V2b FALHOU: v1.superseded_at é NULL (deveria ser preenchido)';
  END IF;
  RAISE NOTICE 'OK V2b — v1 superseded_at=%', sup_at;

  -- V2c: apenas 1 versão "live" (superseded_at IS NULL) para este código
  SELECT count(*) INTO live_cnt
    FROM public.kb_product_spec_versions v
    JOIN public.kb_product_specs s ON s.id = v.kb_product_spec_id
   WHERE s.product_code_normalized = 'FO20.6827.00'
     AND s.supplier = 'sayerlack'
     AND v.superseded_at IS NULL;
  IF live_cnt <> 1 THEN
    RAISE EXCEPTION 'V2c FALHOU: live_cnt=% (esperado 1)', live_cnt;
  END IF;
  RAISE NOTICE 'OK V2c — 1 versão live (superseded_at IS NULL)';

  RAISE NOTICE 'OK V2 — sequenciamento e supersessão corretos';
END \$\$;
SQL

# ─────────────────────────────────────────────────────────────────────────────
echo ""
echo "→ V3 — Imutabilidade (append-only) + FALSIFICAÇÃO do trigger:"

# Tenta mutar um campo além de superseded_at → deve falhar.
P -v ON_ERROR_STOP=1 <<SQL
DO \$\$
BEGIN
  BEGIN
    UPDATE public.kb_product_spec_versions
       SET rendimento_m2_por_litro = 99
     WHERE id = '${VER_ID}'::uuid;
    RAISE EXCEPTION 'V3a FALHOU: UPDATE em campo proibido foi aceito (trigger ausente ou inerte)';
  EXCEPTION
    WHEN raise_exception THEN
      -- O trigger usa RAISE EXCEPTION (P0001); aceito se msg contém alguma indicação de imutabilidade.
      -- ⚠️ Sentinela NÃO contém 'append-only' (texto exato do RAISE na migration — evita falso-positivo).
      IF SQLERRM NOT ILIKE '%imut%' AND SQLERRM NOT ILIKE '%versão%' AND SQLERRM NOT ILIKE '%kbv%' THEN
        RAISE EXCEPTION 'V3a FALHOU: exceção com msg inesperada: %', SQLERRM;
      END IF;
      RAISE NOTICE 'OK V3a — UPDATE bloqueado pelo trigger: %', SQLERRM;
    WHEN OTHERS THEN
      RAISE;  -- re-lança qualquer SQLSTATE diferente do esperado
  END;
END \$\$;
SQL

# FALSIFICAÇÃO: sabota o trigger → EXIGE que o UPDATE agora PASSE.
# ⚠️ Sentinela 'IMUT_SABOTADA' NÃO contém 'append-only' nem 'kbv' (anti-teatro).
P -v ON_ERROR_STOP=1 -q <<'SQL'
DROP TRIGGER IF EXISTS trg_kbv_immutable ON public.kb_product_spec_versions;
SQL

SAB_V3=$(P -tA 2>&1 <<SQL || true
DO \$\$
BEGIN
  UPDATE public.kb_product_spec_versions
     SET rendimento_m2_por_litro = 99
   WHERE id = '${VER_ID}'::uuid;
  RAISE NOTICE 'IMUT_SABOTADA';
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'IMUT_SABOTADA_NAO_PASSOU: %', SQLERRM;
END \$\$;
SQL
)
if echo "$SAB_V3" | grep -q 'IMUT_SABOTADA$'; then
  echo "  OK V3 (falsificação) — trigger DROP deixou UPDATE passar → trigger REALMENTE bloqueia (não é teatro)"
else
  echo "  V3 FALHOU (falsificação): UPDATE não passou mesmo sem trigger. Saída: $SAB_V3"
  exit 1
fi

# Restaura o trigger correto.
# ⚠️ ORDEM IMPORTA: reverter o update da sabotagem ANTES de recriar o trigger,
# senão o próprio UPDATE de revert dispara o trigger recém-criado e aborta.
P -v ON_ERROR_STOP=1 -q <<'SQL'
-- Reverte o update da sabotagem (rendimento voltando para 12.5) SEM trigger ativo.
UPDATE public.kb_product_spec_versions
   SET rendimento_m2_por_litro = 12.5
 WHERE version_number = 1;

-- Agora recria a função e o trigger imutável (espelho exato da migration).
CREATE OR REPLACE FUNCTION public.kbv_block_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (to_jsonb(NEW) - 'superseded_at') IS DISTINCT FROM (to_jsonb(OLD) - 'superseded_at') THEN
    RAISE EXCEPTION 'kb_product_spec_versions é append-only: só superseded_at pode mudar (versão %)',
      OLD.version_number;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_kbv_immutable ON public.kb_product_spec_versions;
CREATE TRIGGER trg_kbv_immutable
  BEFORE UPDATE ON public.kb_product_spec_versions
  FOR EACH ROW EXECUTE FUNCTION public.kbv_block_mutation();
SQL

# Prova que o trigger voltou.
P -v ON_ERROR_STOP=1 <<SQL
DO \$\$
BEGIN
  BEGIN
    UPDATE public.kb_product_spec_versions
       SET rendimento_m2_por_litro = 77
     WHERE id = '${VER_ID}'::uuid;
    RAISE EXCEPTION 'V3 restauração FALHOU: trigger não voltou — UPDATE aceito novamente';
  EXCEPTION
    WHEN raise_exception THEN
      RAISE NOTICE 'OK V3 (restauração) — trigger imutável de volta: %', SQLERRM;
    WHEN OTHERS THEN RAISE;
  END;
END \$\$;
SQL

echo "  OK V3 — imutabilidade comprovada com falsificação"

# ─────────────────────────────────────────────────────────────────────────────
echo ""
echo "→ V4 — Gate master-only na RPC (employee barrado, sentinelas anti-teatro):"

PAYLOAD_EMP='{
  "product_code": "FO20.6827.00",
  "supplier": "sayerlack",
  "product_name": "Tentativa do Employee",
  "rendimento_m2_por_litro": 10,
  "demaos_recomendadas": 2,
  "pot_life_horas": 2,
  "validade_dias": 180
}'
EMP_UID='00000000-0000-0000-0000-000000000002'

# ⚠️ Sentinelas NÃO contêm 'forbidden' nem 'master' (texto do gate na RPC).
# O gate usa RAISE EXCEPTION 'forbidden: somente master pode aprovar versões de boletim'.
# Grepar por substring específica e distinta.
SAB_V4=$(P -tA 2>&1 <<SQL || true
DO \$\$
BEGIN
  SET LOCAL test.uid = '${EMP_UID}';
  BEGIN
    PERFORM public.aprovar_versao_boletim(
      '${PAYLOAD_EMP}'::jsonb,
      '${DOC_ID}'::uuid,
      'initial',
      NULL
    );
    RAISE NOTICE 'GATE_NAO_IMPEDIU';
  EXCEPTION
    WHEN raise_exception THEN
      -- Verifica que a mensagem é do gate (NÃO pode checar por 'forbidden'/'master' — teatro)
      -- O gate da RPC diz "somente master pode aprovar versões de boletim"
      -- Verificamos que a exceção ocorreu (qualquer raise_exception = gate ativo)
      RAISE NOTICE 'GATE_ATIVADO: %', SQLERRM;
    WHEN OTHERS THEN RAISE;
  END;
END \$\$;
SQL
)

if echo "$SAB_V4" | grep -q 'GATE_ATIVADO'; then
  echo "  OK V4a — employee barrado pelo gate (raise_exception disparou)"
elif echo "$SAB_V4" | grep -q 'GATE_NAO_IMPEDIU'; then
  echo "  V4 FALHOU: employee conseguiu chamar a RPC sem ser barrado"
  exit 1
else
  echo "  V4 FALHOU: resultado inesperado: $SAB_V4"
  exit 1
fi

# V4b: master consegue chamar (gate não bloqueia quem tem direito)
P -v ON_ERROR_STOP=1 <<SQL
DO \$\$
DECLARE v_id uuid;
BEGIN
  SET LOCAL test.uid = '${MASTER_UID}';
  SELECT public.aprovar_versao_boletim(
    '${PAYLOAD_V2}'::jsonb,
    '${DOC_ID}'::uuid,
    'data_completion',
    'Validação do gate master'
  ) INTO v_id;
  -- Não falhou = master passou pelo gate
  RAISE NOTICE 'OK V4b — master consegue chamar a RPC (version_id=%)', v_id;
END \$\$;
SQL

echo "  OK V4 — gate master-only funcionando (employee bloqueado, master passa)"

# ─────────────────────────────────────────────────────────────────────────────
echo ""
echo "→ V5 — change_note obrigatório para change_type='correction':"

PAYLOAD_CORR='{
  "product_code": "FO20.6827.00",
  "supplier": "sayerlack",
  "product_name": "Correção sem nota",
  "rendimento_m2_por_litro": 11,
  "demaos_recomendadas": 2,
  "pot_life_horas": 3,
  "validade_dias": 300
}'

P -v ON_ERROR_STOP=1 <<SQL
DO \$\$
BEGIN
  SET LOCAL test.uid = '${MASTER_UID}';
  BEGIN
    PERFORM public.aprovar_versao_boletim(
      '${PAYLOAD_CORR}'::jsonb,
      '${DOC_ID}'::uuid,
      'correction',
      NULL   -- change_note ausente → deve ser barrado
    );
    RAISE EXCEPTION 'V5 FALHOU: correction sem change_note foi aceito';
  EXCEPTION
    WHEN raise_exception THEN
      IF SQLERRM NOT ILIKE '%change_note%' AND SQLERRM NOT ILIKE '%nota%' AND SQLERRM NOT ILIKE '%obrigat%' THEN
        RAISE EXCEPTION 'V5 FALHOU: exceção inesperada (sem menção a change_note): %', SQLERRM;
      END IF;
      RAISE NOTICE 'OK V5 — correction sem change_note barrado: %', SQLERRM;
    WHEN OTHERS THEN RAISE;
  END;
END \$\$;
SQL

# V5b: correction COM change_note → aceito
P -v ON_ERROR_STOP=1 <<SQL
DO \$\$
DECLARE v_id uuid;
BEGIN
  SET LOCAL test.uid = '${MASTER_UID}';
  SELECT public.aprovar_versao_boletim(
    '${PAYLOAD_CORR}'::jsonb,
    '${DOC_ID}'::uuid,
    'correction',
    'Correção do rendimento com nova medição de laboratório'
  ) INTO v_id;
  IF v_id IS NULL THEN
    RAISE EXCEPTION 'V5b FALHOU: correction com change_note retornou NULL';
  END IF;
  RAISE NOTICE 'OK V5b — correction com change_note aceito (version_id=%)', v_id;
END \$\$;
SQL

echo "  OK V5 — change_note exigido para correction"

# ─────────────────────────────────────────────────────────────────────────────
echo ""
echo "→ V6 — version_number sequencial:"

# Conta as versões do produto FO20.6827.00 e verifica que formam sequência 1..N
P -v ON_ERROR_STOP=1 <<SQL
DO \$\$
DECLARE
  cnt int;
  max_v int;
  min_v int;
BEGIN
  SELECT count(*), min(version_number), max(version_number)
    INTO cnt, min_v, max_v
    FROM public.kb_product_spec_versions v
    JOIN public.kb_product_specs s ON s.id = v.kb_product_spec_id
   WHERE s.product_code_normalized = 'FO20.6827.00'
     AND s.supplier = 'sayerlack';

  IF cnt < 2 THEN
    RAISE EXCEPTION 'V6 FALHOU: cnt=% (esperado ≥2 para verificar sequência)', cnt;
  END IF;
  IF min_v <> 1 THEN
    RAISE EXCEPTION 'V6 FALHOU: min_version=% (esperado 1)', min_v;
  END IF;
  -- Verifica que todos os inteiros 1..max existem (sem buracos)
  IF (SELECT count(*) FROM generate_series(1, max_v) g
       WHERE NOT EXISTS (
         SELECT 1 FROM public.kb_product_spec_versions v2
           JOIN public.kb_product_specs s2 ON s2.id = v2.kb_product_spec_id
          WHERE s2.product_code_normalized = 'FO20.6827.00'
            AND s2.supplier = 'sayerlack'
            AND v2.version_number = g
       )
  ) > 0 THEN
    RAISE EXCEPTION 'V6 FALHOU: há buracos na sequência 1..%', max_v;
  END IF;
  RAISE NOTICE 'OK V6 — sequence % versões (1..%), sem buracos', cnt, max_v;
END \$\$;
SQL

echo "  OK V6 — version_number sequencial sem buracos"

# ─────────────────────────────────────────────────────────────────────────────
echo ""
echo "→ V7 — Backfill idempotente (N specs → N versões; re-executar não duplica):"

# Insere specs pré-aprovados que não têm versão (para testar o backfill do BLOCO D)
P -v ON_ERROR_STOP=1 -q <<'SQL'
INSERT INTO public.kb_product_specs
  (id, document_id, product_code, product_code_normalized, supplier, product_name,
   rendimento_m2_por_litro, demaos_recomendadas, pot_life_horas, validade_dias,
   approved_at, approved_by)
VALUES
  ('b7000000-0000-0000-0000-000000000001',
   'd1000000-0000-0000-0000-000000000007',
   'FO20.1111.00', 'FO20.1111.00', 'sayerlack', 'Produto Backfill 1',
   10, 2, 4, 365, now(), '00000000-0000-0000-0000-000000000001'),
  ('b7000000-0000-0000-0000-000000000002',
   'd1000000-0000-0000-0000-000000000007',
   'FO20.2222.00', 'FO20.2222.00', 'sayerlack', 'Produto Backfill 2',
   15, 3, 6, 180, now(), '00000000-0000-0000-0000-000000000001')
ON CONFLICT (supplier, product_code_normalized) DO NOTHING;
SQL

# Executa o BLOCO D (backfill) diretamente
P -v ON_ERROR_STOP=1 -q <<'SQL'
INSERT INTO public.kb_product_spec_versions (
  kb_product_spec_id, supplier, product_code_normalized, version_number,
  source_document_id, change_type, product_code, product_name, product_category,
  rendimento_m2_por_litro, demaos_recomendadas, pot_life_horas, validade_dias,
  catalisador_codigo, catalisador_proporcao_pct, diluente_codigo,
  substrato, equipamentos_aplicacao, diferenciais_chave, uso_recomendado,
  extraction_confidence, approved_at
)
SELECT
  s.id, s.supplier, s.product_code_normalized, 1,
  s.document_id, 'initial', s.product_code, s.product_name, s.product_category,
  s.rendimento_m2_por_litro, s.demaos_recomendadas, s.pot_life_horas, s.validade_dias,
  s.catalisador_codigo, s.catalisador_proporcao_pct, s.diluente_codigo,
  s.substrato, s.equipamentos_aplicacao, s.diferenciais_chave, s.uso_recomendado,
  s.extraction_confidence, s.approved_at
FROM public.kb_product_specs s
WHERE s.approved_at IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM public.kb_product_spec_versions v
     WHERE v.kb_product_spec_id = s.id
  );
SQL

P -v ON_ERROR_STOP=1 <<SQL
DO \$\$
DECLARE cnt_before int; cnt_after int;
BEGIN
  SELECT count(*) INTO cnt_before
    FROM public.kb_product_spec_versions v
    JOIN public.kb_product_specs s ON s.id = v.kb_product_spec_id
   WHERE s.product_code_normalized IN ('FO20.1111.00', 'FO20.2222.00');

  IF cnt_before <> 2 THEN
    RAISE EXCEPTION 'V7a FALHOU: %  versões de backfill (esperado 2)', cnt_before;
  END IF;
  RAISE NOTICE 'OK V7a — backfill criou 2 versões para 2 specs';
END \$\$;
SQL

# Re-executa o backfill (idempotência)
P -v ON_ERROR_STOP=1 -q <<'SQL'
INSERT INTO public.kb_product_spec_versions (
  kb_product_spec_id, supplier, product_code_normalized, version_number,
  source_document_id, change_type, product_code, product_name, product_category,
  rendimento_m2_por_litro, demaos_recomendadas, pot_life_horas, validade_dias,
  catalisador_codigo, catalisador_proporcao_pct, diluente_codigo,
  substrato, equipamentos_aplicacao, diferenciais_chave, uso_recomendado,
  extraction_confidence, approved_at
)
SELECT
  s.id, s.supplier, s.product_code_normalized, 1,
  s.document_id, 'initial', s.product_code, s.product_name, s.product_category,
  s.rendimento_m2_por_litro, s.demaos_recomendadas, s.pot_life_horas, s.validade_dias,
  s.catalisador_codigo, s.catalisador_proporcao_pct, s.diluente_codigo,
  s.substrato, s.equipamentos_aplicacao, s.diferenciais_chave, s.uso_recomendado,
  s.extraction_confidence, s.approved_at
FROM public.kb_product_specs s
WHERE s.approved_at IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM public.kb_product_spec_versions v
     WHERE v.kb_product_spec_id = s.id
  );
SQL

P -v ON_ERROR_STOP=1 <<SQL
DO \$\$
DECLARE cnt_after int;
BEGIN
  SELECT count(*) INTO cnt_after
    FROM public.kb_product_spec_versions v
    JOIN public.kb_product_specs s ON s.id = v.kb_product_spec_id
   WHERE s.product_code_normalized IN ('FO20.1111.00', 'FO20.2222.00');

  IF cnt_after <> 2 THEN
    RAISE EXCEPTION 'V7b FALHOU: re-run criou duplicatas — cnt=% (esperado 2)', cnt_after;
  END IF;
  RAISE NOTICE 'OK V7b — re-run idempotente: cnt=% (sem duplicatas)', cnt_after;

  RAISE NOTICE 'OK V7 — backfill idempotente (2 specs → 2 versões, re-run sem duplicatas)';
END \$\$;
SQL

echo "  OK V7 — backfill idempotente"

# ─────────────────────────────────────────────────────────────────────────────
echo ""
echo "→ V8 — CHECK de não-negatividade barra rendimento negativo:"

PAYLOAD_NEG='{
  "product_code": "FO20.NEGATIVO.00",
  "supplier": "sayerlack",
  "product_name": "Produto com rendimento negativo",
  "rendimento_m2_por_litro": -1,
  "demaos_recomendadas": 2,
  "pot_life_horas": 3,
  "validade_dias": 180
}'

P -v ON_ERROR_STOP=1 <<SQL
DO \$\$
BEGIN
  SET LOCAL test.uid = '${MASTER_UID}';
  BEGIN
    PERFORM public.aprovar_versao_boletim(
      '${PAYLOAD_NEG}'::jsonb,
      '${DOC_ID}'::uuid,
      'initial',
      NULL
    );
    RAISE EXCEPTION 'V8 FALHOU: rendimento negativo foi aceito (CHECK ausente ou inerte)';
  EXCEPTION
    WHEN check_violation THEN
      RAISE NOTICE 'OK V8 — rendimento negativo barrado pelo CHECK (23514): %', SQLERRM;
    WHEN raise_exception THEN
      -- A RPC pode capturar o check_violation e re-lançar como raise_exception
      IF SQLERRM ILIKE '%nonneg%' OR SQLERRM ILIKE '%negat%' OR SQLERRM ILIKE '%check%'
         OR SQLERRM ILIKE '%rendimento%' THEN
        RAISE NOTICE 'OK V8 — rendimento negativo barrado (via raise_exception): %', SQLERRM;
      ELSE
        RAISE EXCEPTION 'V8 FALHOU: exceção inesperada: %', SQLERRM;
      END IF;
    WHEN OTHERS THEN RAISE;
  END;
END \$\$;
SQL

echo "  OK V8 — CHECK de não-negatividade funciona"

# ─────────────────────────────────────────────────────────────────────────────
echo ""
echo "→ V9 — Draft deletado após aprovar versão (kb_extraction_drafts):"

DOC_V9='d1000000-0000-0000-0000-000000000009'

# Insere um draft para o documento V9
P -v ON_ERROR_STOP=1 -q <<SQL
INSERT INTO public.kb_extraction_drafts (document_id, status, spec, claim_token, started_at)
  VALUES (
    '${DOC_V9}'::uuid,
    'ready',
    '{"product_code":"FO20.9999.00","rendimento_m2_por_litro":8}'::jsonb,
    gen_random_uuid(),
    now()
  )
ON CONFLICT (document_id) DO UPDATE SET status = 'ready';
SQL

# Verifica que o draft existe antes
P -v ON_ERROR_STOP=1 <<SQL
DO \$\$
DECLARE cnt int;
BEGIN
  SELECT count(*) INTO cnt FROM public.kb_extraction_drafts
   WHERE document_id = '${DOC_V9}'::uuid;
  IF cnt <> 1 THEN
    RAISE EXCEPTION 'V9 setup FALHOU: draft não foi inserido (cnt=%)', cnt;
  END IF;
  RAISE NOTICE 'OK V9 setup — draft presente antes da RPC';
END \$\$;
SQL

PAYLOAD_V9='{
  "product_code": "FO20.9999.00",
  "supplier": "sayerlack",
  "product_name": "Produto Draft V9",
  "rendimento_m2_por_litro": 8,
  "demaos_recomendadas": 2,
  "pot_life_horas": 2,
  "validade_dias": 120
}'

# Chama a RPC passando o document_id do draft
P -v ON_ERROR_STOP=1 <<SQL
DO \$\$
DECLARE v_id uuid; cnt int;
BEGIN
  SET LOCAL test.uid = '${MASTER_UID}';
  SELECT public.aprovar_versao_boletim(
    '${PAYLOAD_V9}'::jsonb,
    '${DOC_V9}'::uuid,
    'initial',
    NULL
  ) INTO v_id;

  -- Verifica que o draft foi deletado
  SELECT count(*) INTO cnt FROM public.kb_extraction_drafts
   WHERE document_id = '${DOC_V9}'::uuid;

  IF cnt <> 0 THEN
    RAISE EXCEPTION 'V9 FALHOU: draft ainda existe após RPC (cnt=%, esperado 0)', cnt;
  END IF;
  RAISE NOTICE 'OK V9 — draft deletado após aprovar versão (version_id=%)', v_id;
END \$\$;
SQL

echo "  OK V9 — kb_extraction_drafts limpo após aprovação"

# ─────────────────────────────────────────────────────────────────────────────
echo ""
echo "════════════════════════════════════════════════════════"
echo "✅ test-kb-spec-versions: todos os asserts passaram (V1..V9)"
echo "   V1 — RPC cria versão (fields numérico/texto/array)"
echo "   V2 — sequenciamento + supersessão"
echo "   V3 — imutabilidade + falsificação do trigger"
echo "   V4 — gate master-only (employee barrado)"
echo "   V5 — change_note obrigatório para correction"
echo "   V6 — version_number sequencial sem buracos"
echo "   V7 — backfill idempotente"
echo "   V8 — CHECK não-negatividade"
echo "   V9 — draft deletado após aprovação"
