#!/usr/bin/env bash
# ╔══════════════════════════════════════════════════════════════════════════════╗
# ║  PROVA PG17 — v_grupo_contatos migra o JOIN p/ a view fresca account-correta   ║
# ║  (P0-B-bis PR-4 #10). Prova: vendedor da conta OBEN, staleness 7d corta,       ║
# ║  não-multiplicação, empresa_omie honesto, security_invoker preservado.         ║
# ║  Falsificação: (F1) sem account=oben → multiplica; (F2) base sem TTL → stale.  ║
# ║  Rodar:  bash db/test-v_grupo_contatos_fresca.sh > /tmp/t.log 2>&1; echo $?    ║
# ╚══════════════════════════════════════════════════════════════════════════════╝
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PGVER=17
PGBIN="/opt/homebrew/opt/postgresql@${PGVER}/bin"
PORT="${PGPORT_TEST:-5462}"     # porta própria (evita colisão com harnesses paralelos)
SLUG="vgrupocontatos"
DATA="$(mktemp -d "/tmp/pgtest-${SLUG}.XXXXXX")/data"
export LC_ALL=C LANG=C

[ -x "$PGBIN/initdb" ] || { echo "postgresql@${PGVER} ausente: brew install postgresql@${PGVER} pgvector"; exit 1; }

CELLAR="$(brew --prefix "postgresql@${PGVER}")"
cp -Rn "$CELLAR"/share/postgresql/. "/opt/homebrew/share/postgresql@${PGVER}/" 2>/dev/null || true
mkdir -p "/opt/homebrew/lib/postgresql@${PGVER}"
cp -Rn "$CELLAR"/lib/postgresql/. "/opt/homebrew/lib/postgresql@${PGVER}/" 2>/dev/null || true

cleanup() { "$PGBIN/pg_ctl" -D "$DATA" stop -m immediate >/dev/null 2>&1 || true; rm -rf "$(dirname "$DATA")"; }
trap cleanup EXIT

"$PGBIN/initdb" -D "$DATA" -U postgres -E UTF8 --locale=C >/dev/null
"$PGBIN/pg_ctl" -D "$DATA" -o "-p $PORT -k /tmp" -l "/tmp/pg-${SLUG}.log" -w start >/dev/null
"$PGBIN/createdb" -p "$PORT" -h /tmp -U postgres prove
P()  { "$PGBIN/psql" -p "$PORT" -h /tmp -U postgres -d prove -v ON_ERROR_STOP=1 "$@"; }
Pq() { P -tA "$@"; }

P -q -f "$REPO_ROOT/db/stubs-supabase.sql"
P -q <<'SQL'
CREATE OR REPLACE FUNCTION auth.uid()  RETURNS uuid LANGUAGE sql STABLE AS $f$ SELECT nullif(current_setting('test.uid',  true), '')::uuid $f$;
CREATE OR REPLACE FUNCTION auth.role() RETURNS text LANGUAGE sql STABLE AS $f$ SELECT nullif(current_setting('test.role', true), '') $f$;
ALTER ROLE service_role BYPASSRLS;
SQL

PASS=0; FAIL=0
ok()  { PASS=$((PASS+1)); echo "  ✅ $1"; }
bad() { FAIL=$((FAIL+1)); echo "  ❌ $1"; }
eq()  { if [ "$2" = "$3" ]; then ok "$1 (=$2)"; else bad "$1 — esperado [$3], veio [$2]"; fi; }

echo "═══ setup pronto (PG17 :$PORT) ═══"

# ══════════════════════════════════════════════════════════════════════════════
# ZONA 1 — PRÉ-REQUISITOS: tabelas que a view LÊ + a view fresca (dependência do #10)
# ══════════════════════════════════════════════════════════════════════════════
P -q <<'SQL'
CREATE TABLE public.cliente_grupo_membros (grupo_id uuid, documento text);
CREATE TABLE public.profiles (
  user_id uuid, cnpj text, document text, razao_social text, name text, phone text, email text
);
CREATE TABLE public.addresses (
  user_id uuid, street text, number text, complement text, neighborhood text,
  city text, state text, zip_code text, is_default boolean
);
CREATE TABLE public.omie_customer_account_map (
  id uuid PRIMARY KEY,
  user_id uuid, account text, omie_codigo_cliente bigint, omie_codigo_vendedor bigint,
  source text, created_at timestamptz DEFAULT now(), updated_at timestamptz DEFAULT now(),
  CONSTRAINT uq_ocam_user_account UNIQUE (user_id, account)
);
-- A view fresca account-correta (o #10 faz JOIN nela). Réplica FIEL da def de prod (psql-ro): security_invoker
-- propaga a RLS/privilégio ao CALLER (relevante p/ o A7).
CREATE OR REPLACE VIEW public.omie_customer_account_map_fresco WITH (security_invoker = true) AS
  SELECT id, user_id, account, omie_codigo_cliente, omie_codigo_vendedor, source, created_at, updated_at
  FROM public.omie_customer_account_map
  WHERE updated_at >= (now() - '7 days'::interval);
SQL

# ══════════════════════════════════════════════════════════════════════════════
# ZONA 2 — APLICAR A MIGRATION REAL (Lei #1)
# ══════════════════════════════════════════════════════════════════════════════
MIG="$REPO_ROOT/supabase/migrations/20260711145000_v_grupo_contatos_fresca.sql"
P -q -f "$MIG"
echo "migration aplicada: $(basename "$MIG")"

# ══════════════════════════════════════════════════════════════════════════════
# ZONA 3 — SEED (4 cenários) + GRANT p/ os asserts de RLS
# ══════════════════════════════════════════════════════════════════════════════
# G1  = grupo. U1 oben-fresco(vend 100)+colacor_sc-fresco(vend 200) | U2 só colacor_sc(vend 300)
#            | U3 oben STALE >7d (vend 400) | (documentos = 14 dígitos, já normalizados)
P -q <<'SQL'
INSERT INTO auth.users(id) VALUES
  ('11111111-1111-1111-1111-111111111111'),
  ('22222222-2222-2222-2222-222222222222'),
  ('33333333-3333-3333-3333-333333333333') ON CONFLICT DO NOTHING;

INSERT INTO public.cliente_grupo_membros (grupo_id, documento) VALUES
  ('99999999-9999-9999-9999-999999999999','11111111111111'),
  ('99999999-9999-9999-9999-999999999999','22222222222222'),
  ('99999999-9999-9999-9999-999999999999','33333333333333');

INSERT INTO public.profiles (user_id, document, razao_social, name, phone, email) VALUES
  ('11111111-1111-1111-1111-111111111111','11111111111111','Cliente Um','Um','111','u1@x'),
  ('22222222-2222-2222-2222-222222222222','22222222222222','Cliente Dois','Dois','222','u2@x'),
  ('33333333-3333-3333-3333-333333333333','33333333333333','Cliente Tres','Tres','333','u3@x');

-- U1: DUAS contas frescas (oben vend 100 + colacor_sc vend 200) → o JOIN deve pegar SÓ a oben, 1 linha.
-- U2: só colacor_sc fresca (vend 300)   → sem oben → vendedor NULL honesto (não vaza colacor_sc).
-- U3: oben mas updated_at 10d atrás      → a view fresca (TTL 7d) o CORTA → vendedor NULL.
INSERT INTO public.omie_customer_account_map (id, user_id, account, omie_codigo_cliente, omie_codigo_vendedor, updated_at) VALUES
  ('a0000000-0000-0000-0000-000000000001','11111111-1111-1111-1111-111111111111','oben',       1001, 100, now()),
  ('a0000000-0000-0000-0000-000000000002','11111111-1111-1111-1111-111111111111','colacor_sc', 1002, 200, now()),
  ('a0000000-0000-0000-0000-000000000003','22222222-2222-2222-2222-222222222222','colacor_sc', 2002, 300, now()),
  ('a0000000-0000-0000-0000-000000000004','33333333-3333-3333-3333-333333333333','oben',       3001, 400, now() - interval '10 days');

-- security_invoker propaga ao caller: conceda em TODA a cadeia (a view fresca É security_invoker → precisa
-- da base também). Espelha o prod (relacl: anon/authenticated têm SELECT na cadeia toda; a RLS filtra por cima).
GRANT SELECT ON public.v_grupo_contatos, public.cliente_grupo_membros, public.profiles, public.addresses,
                public.omie_customer_account_map, public.omie_customer_account_map_fresco TO authenticated, anon;
SQL

# ══════════════════════════════════════════════════════════════════════════════
# ZONA 4 — ASSERTS
# ══════════════════════════════════════════════════════════════════════════════
echo "── asserts ──"

# A1 POSITIVO: U1 → vendedor da conta OBEN (100), NÃO o de colacor_sc (200)
V=$(Pq -c "SELECT omie_codigo_vendedor FROM public.v_grupo_contatos WHERE user_id='11111111-1111-1111-1111-111111111111';")
eq "A1 vendedor vem da conta oben (não colacor_sc)" "$V" "100"

# A2 HONESTO: U2 (só colacor_sc) → vendedor NULL (não vaza o vendedor de outra conta)
V=$(Pq -c "SELECT coalesce(omie_codigo_vendedor::text,'NULL') FROM public.v_grupo_contatos WHERE user_id='22222222-2222-2222-2222-222222222222';")
eq "A2 cliente sem oben → vendedor honesto NULL" "$V" "NULL"

# A3 STALENESS: U3 (oben com updated_at >7d) → cortado pela view fresca → vendedor NULL
V=$(Pq -c "SELECT coalesce(omie_codigo_vendedor::text,'NULL') FROM public.v_grupo_contatos WHERE user_id='33333333-3333-3333-3333-333333333333';")
eq "A3 oben stale >7d → cortado pela view fresca (TTL)" "$V" "NULL"

# A4 empresa_omie = account 'oben' (badge honesto), não o 'colacor' fabricado do espelho
V=$(Pq -c "SELECT empresa_omie FROM public.v_grupo_contatos WHERE user_id='11111111-1111-1111-1111-111111111111';")
eq "A4 empresa_omie = conta oben (badge honesto)" "$V" "oben"

# A5 NÃO-MULTIPLICA: U1 aparece 1x no grupo apesar de ter oben+colacor_sc (UNIQUE(user,account)+filtro oben)
V=$(Pq -c "SELECT count(*) FROM public.v_grupo_contatos WHERE grupo_id='99999999-9999-9999-9999-999999999999' AND user_id='11111111-1111-1111-1111-111111111111';")
eq "A5 não multiplica linhas do grupo" "$V" "1"

# A6 RLS: security_invoker preservado (a view NÃO virou security_definer → não bypassa a RLS de profiles)
V=$(Pq -c "SELECT (coalesce(array_to_string(reloptions,','),'') LIKE '%security_invoker=true%') FROM pg_class WHERE relname='v_grupo_contatos';")
eq "A6 security_invoker preservado" "$V" "t"

# A7 RLS own-scope: authenticated (U1) vê só o próprio profile via a view → 1 linha (prova que a view
# respeita a RLS de profiles em vez de bypassar). Habilita RLS mínima em profiles (own-scope).
P -q <<'SQL'
ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;
CREATE POLICY p_own ON public.profiles FOR SELECT TO authenticated USING (user_id = auth.uid());
SQL
OWN=$(Pq -c "SET test.uid='11111111-1111-1111-1111-111111111111'; SET ROLE authenticated; SELECT count(*) FROM public.v_grupo_contatos;" | tail -1)
eq "A7 RLS own-scope (security_invoker filtra profiles pelo caller)" "$OWN" "1"
ANON=$(Pq -c "SET ROLE anon; SELECT count(*) FROM public.v_grupo_contatos;" | tail -1)
eq "A8 anon não vê nada (RLS de profiles nega)" "$ANON" "0"
# restaura profiles sem RLS p/ não interferir na falsificação (que semeia como postgres)
P -q -c "DROP POLICY p_own ON public.profiles; ALTER TABLE public.profiles DISABLE ROW LEVEL SECURITY;" >/dev/null

# ══════════════════════════════════════════════════════════════════════════════
# ZONA 5 — FALSIFICAÇÃO (sabota → exige VERMELHO → restaura)
# ══════════════════════════════════════════════════════════════════════════════
echo "── falsificação ──"

# F1: remove o filtro account='oben' do JOIN → U1 casa oben E colacor_sc → MULTIPLICA (A5 tem dente)
P -q <<'SQL'
create or replace view public.v_grupo_contatos with (security_invoker=true) as
select m.grupo_id, m.documento, p.user_id, coalesce(p.razao_social,p.name) as nome, p.phone, p.email,
       a.city as cidade, a.state as uf,
       nullif(trim(coalesce(a.street,'')||' '||coalesce(a.number,'')),'') as endereco,
       oc.omie_codigo_vendedor, oc.account as empresa_omie
from public.cliente_grupo_membros m
join public.profiles p on regexp_replace(coalesce(p.cnpj,p.document,''),'\D','','g')=m.documento
left join public.addresses a on a.user_id=p.user_id and a.is_default=true
left join public.omie_customer_account_map_fresco oc on oc.user_id=p.user_id;  -- SABOTADO: sem account='oben'
SQL
V=$(Pq -c "SELECT count(*) FROM public.v_grupo_contatos WHERE grupo_id='99999999-9999-9999-9999-999999999999' AND user_id='11111111-1111-1111-1111-111111111111';")
if [ "$V" != "1" ]; then ok "F1 sem o filtro account=oben, U1 multiplica ($V linhas) → A5 tem dente"; else bad "F1 sabotei o filtro e U1 NÃO multiplicou → A5 é fraco"; fi

# F2: troca a view fresca pela BASE (sem TTL) → U3 stale reaparece com vendedor 400 (A3 tem dente)
P -q <<'SQL'
create or replace view public.v_grupo_contatos with (security_invoker=true) as
select m.grupo_id, m.documento, p.user_id, coalesce(p.razao_social,p.name) as nome, p.phone, p.email,
       a.city as cidade, a.state as uf,
       nullif(trim(coalesce(a.street,'')||' '||coalesce(a.number,'')),'') as endereco,
       oc.omie_codigo_vendedor, oc.account as empresa_omie
from public.cliente_grupo_membros m
join public.profiles p on regexp_replace(coalesce(p.cnpj,p.document,''),'\D','','g')=m.documento
left join public.addresses a on a.user_id=p.user_id and a.is_default=true
left join public.omie_customer_account_map oc on oc.user_id=p.user_id and oc.account='oben';  -- SABOTADO: base, não fresca
SQL
V=$(Pq -c "SELECT coalesce(omie_codigo_vendedor::text,'NULL') FROM public.v_grupo_contatos WHERE user_id='33333333-3333-3333-3333-333333333333';")
if [ "$V" = "400" ]; then ok "F2 com a BASE (sem TTL), U3 stale reaparece (vend 400) → A3 tem dente"; else bad "F2 troquei fresca→base e U3 stale NÃO reapareceu → A3 é fraco"; fi

# restaura a versão verdadeira
P -q -f "$MIG"

echo "──────────────────────────────"
echo "RESULTADO: $PASS ok / $FAIL fail"
[ "$FAIL" = "0" ] || { echo "❌ HARNESS VERMELHO"; exit 1; }
echo "✅ HARNESS VERDE"
