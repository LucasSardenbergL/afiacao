#!/usr/bin/env bash
# ╔══════════════════════════════════════════════════════════════════════════════╗
# ║  HARNESS PG17 — PROVA de migration money-path/auth com FALSIFICAÇÃO            ║
# ║  Copie p/ db/test-<slug>.sh, preencha as ZONAS [[...]], rode:                  ║
# ║      bash db/test-<slug>.sh > /tmp/t.log 2>&1; echo "exit=$?"                  ║
# ║  (NÃO pipe pra tail — engole o exit≠0; §2 do CLAUDE.md.)                       ║
# ║                                                                                ║
# ║  Lei de Ferro (skill prove-sql-money-path):                                    ║
# ║   1. Aplica a migration REAL (psql -f), não um stub da lógica.                 ║
# ║   2. Assert negativo captura a SQLSTATE esperada e RE-LANÇA o resto.           ║
# ║   3. Falsificação obrigatória: sabota a migração → exija VERMELHO → restaura.  ║
# ╚══════════════════════════════════════════════════════════════════════════════╝
set -euo pipefail

# ── arranque PG17 descartável (idêntico em todos os harnesses; contorna keg-only do brew) ──
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PGVER=17
PGBIN="/opt/homebrew/opt/postgresql@${PGVER}/bin"
PORT="${PGPORT_TEST:-5473}"     # mude se rodar em paralelo com outro harness (40 worktrees)
SLUG="separar-cap-carteira-escrever"
DATA="$(mktemp -d "/tmp/pgtest-${SLUG}.XXXXXX")/data"
export LC_ALL=C LANG=C          # sem isso o postmaster aborta ("became multithreaded during startup")

[ -x "$PGBIN/initdb" ] || { echo "postgresql@${PGVER} ausente: brew install postgresql@${PGVER} pgvector"; exit 1; }

# keg-only do brew: share/lib do postgresql@17 podem não estar linkados → initdb/server falham. Copia do Cellar (idempotente).
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
Pq() { P -tA "$@"; }   # tuples-only, unaligned (pra capturar 1 valor)

# ── base mínima do Supabase: roles, schema auth, auth.uid()/role() via GUC (impersonação de RLS) ──
P -q -f "$REPO_ROOT/db/stubs-supabase.sql"
P -q <<'SQL'
CREATE OR REPLACE FUNCTION auth.uid()  RETURNS uuid LANGUAGE sql STABLE AS $f$ SELECT nullif(current_setting('test.uid',  true), '')::uuid $f$;
CREATE OR REPLACE FUNCTION auth.role() RETURNS text LANGUAGE sql STABLE AS $f$ SELECT nullif(current_setting('test.role', true), '') $f$;
ALTER ROLE service_role BYPASSRLS;   -- espelha o admin role do Supabase (semear sem esbarrar em RLS)
SQL

# ── helpers de assert (pass/fail contados; exit 1 no fim se houve fail) ──
PASS=0; FAIL=0
ok()  { PASS=$((PASS+1)); echo "  ✅ $1"; }
bad() { FAIL=$((FAIL+1)); echo "  ❌ $1"; }
eq()  { if [ "$2" = "$3" ]; then ok "$1 (=$2)"; else bad "$1 — esperado [$3], veio [$2]"; fi; }
# exige que um comando SQL FALHE (caminho negativo grosso). Pra checar a SQLSTATE exata, use o
# padrão DO/EXCEPTION de references/assert-patterns.md (preferível — Lei #2).
must_fail() { if P -q -c "$1" >/dev/null 2>&1; then bad "$2 — devia ter falhado e PASSOU"; else ok "$2 (rejeitado)"; fi; }

echo "═══ setup pronto (PG17 :$PORT) ═══"

# ══════════════════════════════════════════════════════════════════════════════
# ZONA 1 — PRÉ-REQUISITOS DE SCHEMA (o que a migração LÊ/ALTERA mas não cria)
# ══════════════════════════════════════════════════════════════════════════════
# Opção (a) MÍNIMO — stub só das tabelas/colunas que a migração toca:
# P -q <<'SQL'
# CREATE TABLE IF NOT EXISTS public.user_roles (user_id uuid, role text);
# CREATE TABLE IF NOT EXISTS public.[[tabela_que_a_migracao_le]] ( ... colunas usadas ... );
# SQL
#
# Opção (b) FIEL — aplica o snapshot inteiro (pega dependências reais; mais lento):
# RR="$(mktemp /tmp/snap-rr.XXXXXX.sql)"
# sed -E 's/^(CREATE SCHEMA public;)/-- \1/' "$REPO_ROOT/supabase/schema-snapshot.sql" \
#   | grep -vE '^\\(un)?restrict ' > "$RR"
# P -q -f "$REPO_ROOT/supabase/schema-extensions-prelude.sql"
# P --single-transaction -q -f "$RR"; rm -f "$RR"
# ⚠️ snapshot pode estar STALE — se faltar coluna recente, ALTER TABLE ... ADD COLUMN IF NOT EXISTS antes.
#
P -q <<'SQL'
-- Recorte do desenho de prod que a função LÊ. `has_role` e as duas tabelas de papel são o
-- pré-requisito; a função sob teste é a REAL, aplicada da migration (Lei #1).
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname='app_role') THEN
    CREATE TYPE public.app_role AS ENUM ('customer','employee','master');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname='commercial_role') THEN
    -- os 8 valores medidos em prod, na ordem do enum
    CREATE TYPE public.commercial_role AS ENUM
      ('operacional','gerencial','estrategico','super_admin','farmer','hunter','closer','master');
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS public.user_roles (
  user_id uuid NOT NULL, role public.app_role NOT NULL, PRIMARY KEY (user_id, role));
CREATE TABLE IF NOT EXISTS public.commercial_roles (
  user_id uuid PRIMARY KEY, commercial_role public.commercial_role NOT NULL);

CREATE OR REPLACE FUNCTION public.has_role(_uid uuid, _role public.app_role)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS $f$
  SELECT EXISTS (SELECT 1 FROM public.user_roles ur WHERE ur.user_id=_uid AND ur.role=_role);
$f$;

CREATE SCHEMA IF NOT EXISTS private;

-- A LEITURA, com o corpo BYTE-A-BYTE de prod. Ela NÃO é tocada pela migration: o harness a cria
-- aqui para provar, no fim, que continua intacta (e que a assimetria é real, não um efeito de eu
-- ter reescrito as duas).
CREATE OR REPLACE FUNCTION private.cap_carteira_ler(_uid uuid)
 RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $function$
  SELECT COALESCE(
    _uid IS NOT NULL
    AND (
      public.has_role(_uid, 'master'::public.app_role)
      OR (
        public.has_role(_uid, 'employee'::public.app_role)
        AND EXISTS (
          SELECT 1 FROM public.commercial_roles cr
           WHERE cr.user_id = _uid
             AND cr.commercial_role IN ('gerencial','estrategico','super_admin')
        )
      )
    ), false);
$function$;

-- A ESCRITA no estado ANTERIOR (corpo idêntico ao da leitura) e com o ACL EXATO medido em prod:
-- PUBLIC revogado, EXECUTE explícito para authenticated e service_role. Reproduzir o ACL é o que
-- torna o assert de ACL uma prova e não uma suposição.
CREATE OR REPLACE FUNCTION private.cap_carteira_escrever(_uid uuid)
 RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $function$
  SELECT COALESCE(
    _uid IS NOT NULL
    AND (
      public.has_role(_uid, 'master'::public.app_role)
      OR (
        public.has_role(_uid, 'employee'::public.app_role)
        AND EXISTS (
          SELECT 1 FROM public.commercial_roles cr
           WHERE cr.user_id = _uid
             AND cr.commercial_role IN ('gerencial','estrategico','super_admin')
        )
      )
    ), false);
$function$;
REVOKE EXECUTE ON FUNCTION private.cap_carteira_escrever(uuid) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION private.cap_carteira_escrever(uuid) TO authenticated, service_role;
SQL



# ══════════════════════════════════════════════════════════════════════════════
# ZONA 2 — APLICAR A MIGRATION REAL (Lei #1: o .sql commitado, não um stub)
# ══════════════════════════════════════════════════════════════════════════════
MIG="$REPO_ROOT/supabase/migrations/20260828210836_separar_cap_carteira_escrever.sql"
P -q -f "$MIG"
echo "migration aplicada: $(basename "$MIG")"


# ══════════════════════════════════════════════════════════════════════════════
# ZONA 3 — SEED + GRANTs (semeie como postgres; conceda privilégio p/ os asserts de RLS)
# ══════════════════════════════════════════════════════════════════════════════
# Semeie como postgres (superuser ignora RLS e TEM privilégio). NÃO use SET ROLE service_role p/
# semear: BYPASSRLS ignora a RLS mas NÃO concede GRANT → "permission denied" na tabela.
# A migration do repo é --no-privileges (Supabase concede em runtime); aqui você concede p/ que os
# asserts de RLS (SET ROLE authenticated/anon) leiam — a RLS filtra por cima.
# ⚠️ a policy é avaliada com os privilégios do CALLER: se faz subselect noutra tabela (ex.: user_roles),
#    conceda SELECT nela TAMBÉM, senão a própria policy dá permission denied.
# P -q <<'SQL'
# INSERT INTO auth.users(id) VALUES ('11111111-1111-1111-1111-111111111111') ON CONFLICT DO NOTHING;
# INSERT INTO public.[[tabela]] (...) VALUES (...);
# GRANT SELECT ON public.[[tabela]], public.user_roles TO authenticated, anon;
# SQL
#
UM=11111111-1111-1111-1111-111111111111   # employee + gerencial   → lê e ESCREVE
UE=22222222-2222-2222-2222-222222222222   # employee + estrategico  → lê e NÃO escreve  ← o ponto
US=33333333-3333-3333-3333-333333333333   # employee + super_admin  → lê e ESCREVE
UF=44444444-4444-4444-4444-444444444444   # employee + farmer       → nem lê nem escreve
UM2=55555555-5555-5555-5555-555555555555  # master (app_role)       → lê e escreve
UN=66666666-6666-6666-6666-666666666666   # sem papel nenhum        → nada
P -q <<SQL
INSERT INTO public.user_roles(user_id,role) VALUES
  ('$UM','employee'),('$UE','employee'),('$US','employee'),('$UF','employee'),('$UM2','master');
INSERT INTO public.commercial_roles(user_id,commercial_role) VALUES
  ('$UM','gerencial'),('$UE','estrategico'),('$US','super_admin'),('$UF','farmer');
SQL
ler()  { Pq -c "SELECT private.cap_carteira_ler('$1'::uuid)::text;"; }
escr() { Pq -c "SELECT private.cap_carteira_escrever('$1'::uuid)::text;"; }



# ══════════════════════════════════════════════════════════════════════════════
# ZONA 4 — ASSERTS (positivo / negativo-com-SQLSTATE / RLS) — ver assert-patterns.md
# ══════════════════════════════════════════════════════════════════════════════
echo "── asserts ──"
# POSITIVO:
#   V=$(Pq -c "SELECT status FROM public.[[...]] WHERE id='...';"); eq "A1 efeito" "$V" "aprovado"
# NEGATIVO (gate/CHECK rejeita — captura a SQLSTATE esperada e re-lança o resto):
#   R=$(P -tA 2>&1 <<'SQL' ... SQL )  ← 2>&1 ESSENCIAL: o RAISE NOTICE da sentinela sai no STDERR
#   ver references/assert-patterns.md (bloco DO ... EXCEPTION WHEN <sqlstate> ... WHEN OTHERS THEN RAISE)
# RLS (own-scope / staff / anon-deny):
#   OWN=$(Pq -c "SET test.uid='11111111-1111-1111-1111-111111111111'; SET ROLE authenticated; SELECT count(*) FROM public.[[...]];" | tail -1)
#   eq "A2 own-scope" "$OWN" "1"
#
# ── o invariante CENTRAL: a assimetria ──
eq "A1 estrategico LÊ"                "$(ler  $UE)" "true"
eq "A2 estrategico NÃO ESCREVE  ← a separação" "$(escr $UE)" "false"

# ── quem não pode perder nada ──
eq "A3 gerencial lê"     "$(ler  $UM)" "true"
eq "A4 gerencial escreve" "$(escr $UM)" "true"
eq "A5 super_admin lê"     "$(ler  $US)" "true"
eq "A6 super_admin escreve" "$(escr $US)" "true"
eq "A7 master lê"     "$(ler  $UM2)" "true"
eq "A8 master escreve" "$(escr $UM2)" "true"

# ── negativos: quem nunca teve, segue sem ──
eq "A9  farmer não lê"      "$(ler  $UF)" "false"
eq "A10 farmer não escreve" "$(escr $UF)" "false"
eq "A11 sem papel não lê"      "$(ler  $UN)" "false"
eq "A12 sem papel não escreve" "$(escr $UN)" "false"
# NULL: o COALESCE tem de devolver false, nunca NULL — `Number(null)` do SQL é o mesmo perigo.
eq "A13 uid NULL não escreve (COALESCE, não NULL)" \
   "$(Pq -c "SELECT coalesce(private.cap_carteira_escrever(NULL)::text,'ERA_NULL');")" "false"

# ── a leitura NÃO foi tocada: o md5 do corpo dela tem de bater com o de PROD ──
LERMD5=$(Pq -c "SELECT md5(regexp_replace(btrim(prosrc),'\s+',' ','g')) FROM pg_proc p
                 JOIN pg_namespace n ON n.oid=p.pronamespace
                WHERE n.nspname='private' AND p.proname='cap_carteira_ler';")
eq "A14 cap_carteira_ler intacta (md5 == prod)" "$LERMD5" "836e8f46f863eefd75b3b46a49eba81a"

ESCMD5=$(Pq -c "SELECT md5(regexp_replace(btrim(prosrc),'\s+',' ','g')) FROM pg_proc p
                 JOIN pg_namespace n ON n.oid=p.pronamespace
                WHERE n.nspname='private' AND p.proname='cap_carteira_escrever';")
if [ "$ESCMD5" != "836e8f46f863eefd75b3b46a49eba81a" ]; then ok "A15 escrever DIVERGIU da leitura (era o mesmo md5)"
else bad "A15 escrever ainda tem o md5 da leitura — a migration não separou nada"; fi

# ── metadados que a policy depende: perdê-los quebra a autorização por BAIXO ──
META=$(Pq -c "SELECT p.prosecdef::text||'|'||coalesce(array_to_string(p.proconfig,','),'') FROM pg_proc p
               JOIN pg_namespace n ON n.oid=p.pronamespace
              WHERE n.nspname='private' AND p.proname='cap_carteira_escrever';")
eq "A16 SECDEF + search_path preservados" "$META" "true|search_path=public"

# ── ACL: a armadilha do DROP+CREATE (CLAUDE.md) ──
# Em prod o PUBLIC está REVOGADO. `CREATE OR REPLACE` preserva isso; `DROP`+`CREATE` reseta o ACL
# para o default do Postgres, que é EXECUTE para PUBLIC — ou seja, falha ABERTA: `anon` passaria a
# executar a capability. O assert ancora em `anon`, que é o que a regressão abriria.
eq "A17 authenticated mantém EXECUTE" \
   "$(Pq -c "SELECT has_function_privilege('authenticated','private.cap_carteira_escrever(uuid)','EXECUTE')::text;")" "true"
eq "A18 anon NÃO executa (PUBLIC segue revogado)" \
   "$(Pq -c "SELECT has_function_privilege('anon','private.cap_carteira_escrever(uuid)','EXECUTE')::text;")" "false"



# ══════════════════════════════════════════════════════════════════════════════
# ZONA 5 — FALSIFICAÇÃO (Lei #3: sabota a migração → exija VERMELHO → restaura)
# ══════════════════════════════════════════════════════════════════════════════
# Padrão (ver assert-patterns.md p/ a versão completa, incl. sentinela anti-teatro):
#   1. sabota:   recria a policy/trigger/função NA VERSÃO FURADA
#   2. re-roda:  o MESMO assert do passo 4
#   3. exige:    que ele agora FALHE (se passar → assert fraco → conserte)
#   4. restaura: a versão verdadeira (cirurgicamente, só o que sabotou)
#
echo "── falsificação (sabota → exige VERMELHO → restaura) ──"
falsificou() { if [ "$1" = "$2" ]; then bad "F$3 sabotagem NÃO foi pega — o assert é teatro"; else ok "F$3 $4"; fi; }

# F1 — devolve `estrategico` à lista: o assert A2 (a separação) TEM de mudar de valor.
P -q -c "CREATE OR REPLACE FUNCTION private.cap_carteira_escrever(_uid uuid)
 RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS \$f\$
  SELECT COALESCE(_uid IS NOT NULL AND (public.has_role(_uid,'master'::public.app_role)
    OR (public.has_role(_uid,'employee'::public.app_role) AND EXISTS (
      SELECT 1 FROM public.commercial_roles cr WHERE cr.user_id=_uid
        AND cr.commercial_role IN ('gerencial','estrategico','super_admin')))), false);
\$f\$;"
falsificou "$(escr $UE)" "false" 1 "reincluir 'estrategico' faz o estrategico ESCREVER de novo"
P -q -f "$MIG" >/dev/null   # restaura a versão verdadeira

# F2 — o jeito ERRADO de aplicar: DROP + CREATE. O corpo fica igual (A2 segue verde!), e o que
# quebra é o ACL — é por isso que o assert de ACL existe separado do assert de comportamento.
P -q -c "DROP FUNCTION private.cap_carteira_escrever(uuid);
 CREATE FUNCTION private.cap_carteira_escrever(_uid uuid)
 RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS \$f\$
  SELECT COALESCE(_uid IS NOT NULL AND (public.has_role(_uid,'master'::public.app_role)
    OR (public.has_role(_uid,'employee'::public.app_role) AND EXISTS (
      SELECT 1 FROM public.commercial_roles cr WHERE cr.user_id=_uid
        AND cr.commercial_role IN ('gerencial','super_admin')))), false);
\$f\$;"
eq "F2a controle: o COMPORTAMENTO não muda com DROP+CREATE" "$(escr $UE)" "false"
falsificou "$(Pq -c "SELECT has_function_privilege('anon','private.cap_carteira_escrever(uuid)','EXECUTE')::text;")" \
           "false" 2 "DROP+CREATE reseta o ACL e ABRE a função para anon/PUBLIC"
# restaura o estado verdadeiro: ACL de prod + corpo da migration
P -q -c "REVOKE EXECUTE ON FUNCTION private.cap_carteira_escrever(uuid) FROM PUBLIC;
         GRANT EXECUTE ON FUNCTION private.cap_carteira_escrever(uuid) TO authenticated, service_role;"
P -q -f "$MIG" >/dev/null
eq "F3 restaurado: anon volta a ser barrado" \
   "$(Pq -c "SELECT has_function_privilege('anon','private.cap_carteira_escrever(uuid)','EXECUTE')::text;")" "false"



# ── veredito ──
echo "──────────────────────────────"
echo "RESULTADO: $PASS ok / $FAIL fail"
[ "$FAIL" = "0" ] || { echo "❌ HARNESS VERMELHO"; exit 1; }
echo "✅ HARNESS VERDE"
