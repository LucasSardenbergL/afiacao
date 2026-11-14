#!/usr/bin/env bash
# Teste PG17 da migration 20261113120000_seg_scanner_politicas_select_abertas.sql.
# Auto-contido: stubs auth.uid()/has_role() por GUC, tabelas mínimas com as políticas ABERTAS de
# prod, storage.objects mínimo; aplica a migration real DUAS vezes (idempotência) e assere, sob
# SET ROLE authenticated/anon, o que cada persona LÊ (contagem de linhas visíveis).
# Falsificação: MIGRATION=<cópia sabotada> bash db/test-seg-scanner-politicas.sh  → tem de dar vermelho.
# Pré-req: brew install postgresql@17.
set -euo pipefail
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MIGRATION="${MIGRATION:-$REPO_ROOT/supabase/migrations/20261113120000_seg_scanner_politicas_select_abertas.sql}"
export PGVER=17
PORT="${PGPORT_TEST:-${PORT:-5447}}"
DATA="$(mktemp -d /tmp/pgtest-segscan.XXXXXX)/data"
export LC_ALL="${LC_ALL:-C}" LANG="${LANG:-C}"
# shellcheck disable=SC1091  # o gate roda sem -x; o helper é versionado ao lado, em db/lib/
. "$REPO_ROOT/db/lib/pg-harness.sh"
cleanup() { "$PGBIN/pg_ctl" -D "$DATA" stop -m immediate >/dev/null 2>&1 || true; rm -rf "$(dirname "$DATA")"; }
trap cleanup EXIT
"$PGBIN/initdb" -D "$DATA" -U postgres -E UTF8 --locale=C >/dev/null
"$PGBIN/pg_ctl" -D "$DATA" -o "-p $PORT -k /tmp" -l "$(dirname "$DATA")/pg.log" -w start >/dev/null
"$PGBIN/createdb" -p "$PORT" -h /tmp -U postgres segscan
P() { "$PGBIN/psql" -X -p "$PORT" -h /tmp -U postgres -d segscan -v ON_ERROR_STOP=1 "$@"; }

echo "→ fundação (stubs + tabelas com as políticas abertas de prod)…"
P -q <<'SQL'
CREATE SCHEMA auth;
CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS
  $f$ SELECT nullif(current_setting('test.uid', true), '')::uuid $f$;
CREATE FUNCTION auth.role() RETURNS text LANGUAGE sql STABLE AS
  $f$ SELECT current_user::text $f$;
CREATE TYPE public.app_role AS ENUM ('master','employee','customer');
CREATE FUNCTION public.has_role(_uid uuid, _role public.app_role) RETURNS boolean
  LANGUAGE sql STABLE AS $f$ SELECT current_setting('test.role', true) = _role::text $f$;
CREATE ROLE authenticated; CREATE ROLE anon;
GRANT USAGE ON SCHEMA auth, public TO authenticated, anon;

CREATE TABLE public.profiles (user_id uuid PRIMARY KEY, is_approved boolean NOT NULL DEFAULT false);
ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users can view their own profile" ON public.profiles FOR SELECT USING (auth.uid() = user_id);
INSERT INTO public.profiles VALUES
  ('00000000-0000-0000-0000-00000000000a', true),   -- customer aprovado
  ('00000000-0000-0000-0000-00000000000b', false);  -- recém-cadastrado

DO $t$
DECLARE r record;
BEGIN
  FOR r IN SELECT * FROM (VALUES
    ('tint_corantes','Authenticated can view tint_corantes','authenticated','true'),
    ('tint_bases','Authenticated can view tint_bases','authenticated','true'),
    ('tint_produtos','Authenticated can view tint_produtos','authenticated','true'),
    ('tint_embalagens','Authenticated can view tint_embalagens','authenticated','true'),
    ('tint_colecoes','Authenticated can view tint_colecoes','authenticated','true'),
    ('tint_subcolecoes','Authenticated can view tint_subcolecoes','authenticated','true'),
    ('warehouses','Authenticated users can view warehouses','authenticated','true'),
    ('category_mappings','Anyone can view category mappings','public','true'),
    ('cep_geo','cep_geo_sel','authenticated','true'),
    ('municipio_geo','municipio_geo_sel','authenticated','true'),
    ('company_cnpjs','company_cnpjs_select_authenticated','public','auth.role() = ''authenticated'''),
    ('default_prices','Anyone can view default prices','public','true'),
    ('omie_servicos','Anyone can view omie services mapping','public','true'),
    ('tool_specifications','Anyone can read tool specifications','public','true'),
    ('training_modules','Anyone can view active training modules','public','true'),
    ('tool_categories','Anyone can view tool categories','public','true')
  ) v(tab, pol, rol, q) LOOP
    EXECUTE format('CREATE TABLE public.%I (id int PRIMARY KEY, is_active boolean NOT NULL DEFAULT true)', r.tab);
    EXECUTE format('INSERT INTO public.%I VALUES (1, true), (2, false)', r.tab);
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', r.tab);
    EXECUTE format('CREATE POLICY %I ON public.%I FOR SELECT TO %s USING (%s)', r.pol, r.tab, r.rol, r.q);
    EXECUTE format('GRANT SELECT ON public.%I TO authenticated, anon', r.tab);
  END LOOP;
END $t$;
GRANT SELECT ON public.profiles TO authenticated;

CREATE SCHEMA storage;
CREATE FUNCTION storage.foldername(name text) RETURNS text[] LANGUAGE sql IMMUTABLE AS
  $f$ SELECT string_to_array(name, '/') $f$;
CREATE TABLE storage.objects (id int PRIMARY KEY, bucket_id text, name text);
ALTER TABLE storage.objects ENABLE ROW LEVEL SECURITY;
INSERT INTO storage.objects VALUES
  (1,'avatars','00000000-0000-0000-0000-00000000000a/a.png'),
  (2,'avatars','00000000-0000-0000-0000-00000000000b/b.png');
CREATE POLICY "Public can view avatars" ON storage.objects FOR SELECT USING (bucket_id = 'avatars');
CREATE POLICY "Owners can list their avatars" ON storage.objects FOR SELECT TO authenticated
  USING (bucket_id = 'avatars' AND (auth.uid())::text = (storage.foldername(name))[1]);
GRANT USAGE ON SCHEMA storage TO authenticated, anon;
GRANT SELECT ON storage.objects TO authenticated, anon;
SQL

echo "→ aplica a migration (1ª vez)…"
P -q -f "$MIGRATION" | grep -q 'OK seg_scanner_politicas_select_abertas' \
  || { echo "FALHOU: 1º apply sem o marcador de fim"; exit 1; }
echo "→ aplica a migration (2ª vez — idempotência)…"
P -q -f "$MIGRATION" | grep -q 'OK seg_scanner_politicas_select_abertas' \
  || { echo "FALHOU: 2º apply sem o marcador de fim"; exit 1; }

# conta(role, test.role, uid, tabela) → nº de linhas visíveis
conta() {
  P -tA -q -c "SET ROLE $1; SELECT set_config('test.role','$2',false), set_config('test.uid','$3',false);" \
            -c "SET ROLE $1; SELECT count(*) FROM $4" | tail -1
}
FALHAS=0
PASSOU=0
espera() {  # espera <descricao> <esperado> <obtido>
  if [ "$2" = "$3" ]; then echo "  OK  $1 = $3"; PASSOU=$((PASSOU+1)); else echo "  FALHOU $1: esperado $2, obtido $3"; FALHAS=$((FALHAS+1)); fi
}
U_A=00000000-0000-0000-0000-00000000000a
U_B=00000000-0000-0000-0000-00000000000b
U_S=00000000-0000-0000-0000-00000000000c

STAFF_ONLY="tint_corantes tint_bases tint_produtos tint_embalagens tint_colecoes tint_subcolecoes warehouses category_mappings cep_geo municipio_geo company_cnpjs"
APROVADOS="default_prices omie_servicos tool_specifications"

echo "→ staff-only…"
for t in $STAFF_ONLY; do
  espera "employee lê $t"              2 "$(conta authenticated employee "$U_S" "public.$t")"
  espera "master lê $t"                2 "$(conta authenticated master   "$U_S" "public.$t")"
  espera "customer aprovado NÃO lê $t" 0 "$(conta authenticated customer "$U_A" "public.$t")"
  espera "anon NÃO lê $t"              0 "$(conta anon '' '' "public.$t")"
done
echo "→ staff ou aprovado…"
for t in $APROVADOS; do
  espera "employee lê $t"                 2 "$(conta authenticated employee "$U_S" "public.$t")"
  espera "customer aprovado lê $t"        2 "$(conta authenticated customer "$U_A" "public.$t")"
  espera "customer NÃO aprovado NÃO lê $t" 0 "$(conta authenticated customer "$U_B" "public.$t")"
  espera "anon NÃO lê $t"                 0 "$(conta anon '' '' "public.$t")"
done
espera "customer aprovado lê só módulo ATIVO"   1 "$(conta authenticated customer "$U_A" public.training_modules)"
espera "não aprovado NÃO lê training_modules"   0 "$(conta authenticated customer "$U_B" public.training_modules)"
espera "anon NÃO lê training_modules"           0 "$(conta anon '' '' public.training_modules)"
echo "→ exceção declarada e avatars…"
espera "anon segue lendo tool_categories (cadastro pré-login)" 2 "$(conta anon '' '' public.tool_categories)"
espera "anon NÃO lista avatars"                 0 "$(conta anon '' '' storage.objects)"
espera "dono vê só o próprio avatar"            1 "$(conta authenticated customer "$U_A" storage.objects)"

echo "RESULTADO: $PASSOU ok / $FALHAS fail"
if [ "$FALHAS" -ne 0 ]; then echo "✗ db/test-seg-scanner-politicas.sh — $FALHAS falha(s)"; exit 1; fi
echo "✓ db/test-seg-scanner-politicas.sh — PASSOU"
