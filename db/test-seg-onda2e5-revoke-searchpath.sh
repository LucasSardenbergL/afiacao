#!/usr/bin/env bash
# ╔══════════════════════════════════════════════════════════════════════════════╗
# ║  HARNESS PG17 — Ondas 2+5 (revoke SECDEF p/ anon + storage policies +          ║
# ║  search_path). Prova: anon perde EXECUTE (exceto allowlist), authenticated     ║
# ║  mantém, trigger SECDEF perde authenticated; storage avatars público + delete  ║
# ║  master-only de comprovação; search_path fixado em invoker. + FALSIFICAÇÃO.    ║
# ╚══════════════════════════════════════════════════════════════════════════════╝
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PGVER=17
PGBIN="/opt/homebrew/opt/postgresql@${PGVER}/bin"
PORT="${PGPORT_TEST:-5462}"
SLUG="seg-onda2e5"
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
GRANT USAGE ON SCHEMA auth TO anon, authenticated;  -- prod: policies chamam auth.uid()
SQL

PASS=0; FAIL=0
ok()  { PASS=$((PASS+1)); echo "  ✅ $1"; }
bad() { FAIL=$((FAIL+1)); echo "  ❌ $1"; }
eq()  { if [ "$2" = "$3" ]; then ok "$1 (=$2)"; else bad "$1 — esperado [$3], veio [$2]"; fi; }
deny() { local out; if out=$(P -q -c "$1" 2>&1); then bad "$2 — devia NEGAR e passou"; \
         elif echo "$out" | grep -q "permission denied"; then ok "$2 (permission denied)"; \
         else bad "$2 — erro inesperado: $(echo "$out" | tail -1)"; fi; }

echo "═══ setup PG17 :$PORT ═══"

# ══ ZONA 1 — estado de PROD antes das migrações ══════════════════════════════
P -q <<'SQL'
CREATE TYPE public.app_role AS ENUM ('employee','master','customer');
CREATE FUNCTION public.has_role(_uid uuid, _role public.app_role) RETURNS boolean
  LANGUAGE sql STABLE AS $$ SELECT current_setting('test.is_master', true) = 'on' AND _role = 'master'::public.app_role $$;

-- SECDEF stubs (espelham as funções reais). CREATE concede EXECUTE a PUBLIC por default;
-- + grant explícito a anon/authenticated (como no Supabase).
CREATE FUNCTION public.minha_carteira()                       RETURNS int SECURITY DEFINER LANGUAGE sql AS $$ SELECT 1 $$;
CREATE FUNCTION public.get_public_tool_history(p_tool_id text) RETURNS int SECURITY DEFINER LANGUAGE sql AS $$ SELECT 1 $$;  -- ALLOWLIST
CREATE FUNCTION public.my_trigger_fn()                         RETURNS trigger SECURITY DEFINER LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END $$;
GRANT EXECUTE ON FUNCTION public.minha_carteira(), public.get_public_tool_history(text) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.my_trigger_fn() TO anon, authenticated;

-- função INVOKER sem search_path (alvo da Onda 5)
CREATE FUNCTION public.foo_invoker() RETURNS int LANGUAGE sql AS $$ SELECT 42 $$;
-- função SEM search_path mas owned por OUTRO role (não o que aplica) — simula o caso
-- pgvector/l2_norm: a migração deve PULÁ-la (deptype='e' em prod; aqui via backstop de privilégio).

-- storage (stub mínimo p/ as policies)
CREATE SCHEMA IF NOT EXISTS storage;
GRANT USAGE ON SCHEMA storage TO anon, authenticated;
CREATE TABLE storage.objects (id uuid DEFAULT gen_random_uuid() PRIMARY KEY, bucket_id text, name text, owner uuid);
ALTER TABLE storage.objects ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE, DELETE ON storage.objects TO anon, authenticated;
-- policy SELECT de comprovação que JÁ existe em prod (own OU gestor/master via
-- pode_ver_carteira_completa). Sem ela, DELETE não "vê" a linha → não deleta.
CREATE POLICY tcomprov_select_own_master ON storage.objects FOR SELECT TO authenticated
  USING (bucket_id='tarefa-comprovacoes' AND (owner=(SELECT auth.uid()) OR public.has_role((SELECT auth.uid()),'master'::public.app_role)));
SQL

# ══ ZONA 2 — aplicar as migrações REAIS (ordem: 2 depois 5) ═══════════════════
# extensão real em public: cria funções owned pela extensão (deptype='e') SEM search_path —
# espelha pgvector/l2_norm. A Onda 5b DEVE pulá-las (em prod, alterá-las dá 42501 "must be owner").
P -q -c "CREATE EXTENSION IF NOT EXISTS pg_trgm SCHEMA public;" >/dev/null 2>&1 && HAS_EXT=1 || HAS_EXT=0
echo "pg_trgm disponivel: $HAS_EXT"
P -q -f "$REPO_ROOT/supabase/migrations/20260627180200_seg_onda2_revoke_secdef_storage.sql"
P -q -f "$REPO_ROOT/supabase/migrations/20260627180500_seg_onda5b_search_path_fix.sql"   # 5b (corrigida)
echo "migrações 2 e 5b aplicadas"

# ══ ZONA 3 — seed ════════════════════════════════════════════════════════════
P -q <<'SQL'
INSERT INTO storage.objects (bucket_id, name) VALUES ('avatars','u1/avatar.png');
INSERT INTO storage.objects (bucket_id, name, owner) VALUES ('tarefa-comprovacoes','u1/t1/123.jpg','33333333-3333-3333-3333-333333333333');
SQL

# ══ ZONA 4 — ASSERTS ═════════════════════════════════════════════════════════
echo "── asserts Onda 2 (revoke SECDEF) ──"
# allowlist: anon AINDA executa get_public_tool_history
V=$(Pq -c "SET ROLE anon; SELECT public.get_public_tool_history('x');" | tail -1)
eq "B1 anon executa get_public_tool_history (allowlist)" "$V" "1"
# anon NÃO executa minha_carteira (revogado anon+PUBLIC)
deny "SET ROLE anon; SELECT public.minha_carteira();" "B2 anon NAO executa minha_carteira"
# authenticated MANTÉM minha_carteira (grant explícito intacto)
V=$(Pq -c "SET ROLE authenticated; SELECT public.minha_carteira();" | tail -1)
eq "B3 authenticated mantem minha_carteira" "$V" "1"
# trigger SECDEF: authenticated revogado também
deny "SET ROLE authenticated; SELECT public.my_trigger_fn();" "B4 authenticated NAO executa trigger SECDEF"

echo "── asserts Onda 2 (storage) ──"
# avatars: anon lê (policy pública criada)
V=$(Pq -c "SET ROLE anon; SELECT count(*) FROM storage.objects WHERE bucket_id='avatars';" | tail -1)
eq "B5 anon le avatars (policy publica)" "$V" "1"
# comprovação: master deleta (vê via select master + delete master)
P -q -c "SET test.is_master='on'; SET ROLE authenticated; DELETE FROM storage.objects WHERE bucket_id='tarefa-comprovacoes';"
V=$(Pq -c "SELECT count(*) FROM storage.objects WHERE bucket_id='tarefa-comprovacoes';" | tail -1)
eq "B6 master deleta comprovacao" "$V" "0"
# re-semeia (dono = 3333...) p/ testar o próprio dono não-master
P -q -c "INSERT INTO storage.objects (bucket_id,name,owner) VALUES ('tarefa-comprovacoes','u1/t1/456.jpg','33333333-3333-3333-3333-333333333333');"
# o DONO (não-master) VÊ a própria comprovação (select own) mas a delete policy é master-only → 0 deletado
P -q -c "SET test.is_master='off'; SET test.uid='33333333-3333-3333-3333-333333333333'; SET ROLE authenticated; DELETE FROM storage.objects WHERE bucket_id='tarefa-comprovacoes';"
V=$(Pq -c "SELECT count(*) FROM storage.objects WHERE bucket_id='tarefa-comprovacoes';" | tail -1)
eq "B7 dono nao-master NAO deleta (delete e master-only)" "$V" "1"

echo "── asserts Onda 5 (search_path) ──"
# foo_invoker passou a ter search_path=public
V=$(Pq -c "SELECT EXISTS(SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname='foo_invoker' AND p.proconfig::text LIKE '%search_path=public%');")
eq "C1 foo_invoker tem search_path=public" "$V" "t"
# e continua executando
V=$(Pq -c "SELECT public.foo_invoker();" | tail -1)
eq "C2 foo_invoker ainda executa" "$V" "42"
# nenhuma função DA APP (não-extensão) ficou sem search_path
V=$(Pq -c "SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.prokind='f' AND (p.proconfig IS NULL OR NOT EXISTS(SELECT 1 FROM unnest(p.proconfig) c WHERE c LIKE 'search_path=%')) AND NOT EXISTS(SELECT 1 FROM pg_depend d WHERE d.objid=p.oid AND d.deptype='e');")
eq "C3 zero funcoes da app sem search_path" "$V" "0"
# C4: funções de EXTENSÃO foram PULADAS (não recebem search_path) — o ponto do fix (em prod = 42501)
if [ "${HAS_EXT:-0}" = "1" ]; then
  V=$(Pq -c "SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.prokind='f' AND EXISTS(SELECT 1 FROM pg_depend d WHERE d.objid=p.oid AND d.deptype='e') AND p.proconfig::text LIKE '%search_path%';")
  eq "C4 NENHUMA funcao de extensao foi alterada (pulada pelo filtro)" "$V" "0"
else
  echo "  ⏭️  C4 pulado (pg_trgm indisponivel no harness)"
fi

# ══ ZONA 5 — FALSIFICAÇÃO ════════════════════════════════════════════════════
echo "── falsificacao ──"
# F1: re-grant anon em minha_carteira → anon volta a executar → B2 tem dente
P -q -c "GRANT EXECUTE ON FUNCTION public.minha_carteira() TO anon;"
if P -q -c "SET ROLE anon; SELECT public.minha_carteira();" >/dev/null 2>&1; then
  ok "F1 sabotado (re-grant) anon executa minha_carteira -> B2 tem dente"
else
  bad "F1 anon barrado mesmo com grant -> B2 SEM dente"
fi
P -q -c "REVOKE EXECUTE ON FUNCTION public.minha_carteira() FROM anon, PUBLIC;"

# F2: DROP policy avatars → anon deixa de ler → B5 tem dente
P -q -c "DROP POLICY \"Public can view avatars\" ON storage.objects;"
V=$(Pq -c "SET ROLE anon; SELECT count(*) FROM storage.objects WHERE bucket_id='avatars';" | tail -1)
if [ "$V" = "0" ]; then ok "F2 sabotado (drop policy) anon nao le avatars -> B5 tem dente"; else bad "F2 anon ainda le sem policy -> B5 SEM dente"; fi
P -q -c "CREATE POLICY \"Public can view avatars\" ON storage.objects FOR SELECT TO public USING (bucket_id='avatars');"

# F3: RESET search_path em foo_invoker → volta a mutável → C1 tem dente
P -q -c "ALTER FUNCTION public.foo_invoker() RESET search_path;"
V=$(Pq -c "SELECT EXISTS(SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname='foo_invoker' AND p.proconfig::text LIKE '%search_path=public%');")
if [ "$V" = "f" ]; then ok "F3 sabotado (reset) foo_invoker volta a mutavel -> C1 tem dente"; else bad "F3 search_path persistiu apos reset -> C1 SEM dente"; fi
P -q -c "ALTER FUNCTION public.foo_invoker() SET search_path = public;"

# F4: a func de extensão ERA alterável manualmente (no harness sou owner) → prova que foi o
# FILTRO deptype='e' que a deixou intacta na 5b, não falta de permissão. Em prod NÃO somos owner
# → o filtro é o que evita o 42501 que abortou a Onda 5 original.
if [ "${HAS_EXT:-0}" = "1" ]; then
  EXTFN=$(Pq -c "SELECT p.oid::regprocedure FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace JOIN pg_depend d ON d.objid=p.oid AND d.deptype='e' WHERE n.nspname='public' AND p.prokind='f' AND (p.proconfig IS NULL OR NOT EXISTS(SELECT 1 FROM unnest(p.proconfig) c WHERE c LIKE 'search_path=%')) LIMIT 1;" | tail -1)
  P -q -c "ALTER FUNCTION $EXTFN SET search_path = public;"
  V=$(Pq -c "SELECT (proconfig::text LIKE '%search_path%') FROM pg_proc WHERE oid='$EXTFN'::regprocedure;" | tail -1)
  if [ "$V" = "t" ]; then ok "F4 func de extensao ERA alteravel ($EXTFN) -> foi o filtro deptype=e que a protegeu, nao ownership"; else bad "F4 nao alterou func de extensao -> teste do filtro sem dente"; fi
else
  echo "  ⏭️  F4 pulado (pg_trgm indisponivel)"
fi

echo "──────────────────────────────"
echo "RESULTADO: $PASS ok / $FAIL fail"
[ "$FAIL" = "0" ] || { echo "❌ HARNESS VERMELHO"; exit 1; }
echo "✅ HARNESS VERDE"
