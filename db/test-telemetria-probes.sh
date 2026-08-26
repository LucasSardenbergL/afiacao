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
SLUG="telemetria-probes"
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
-- A migration referencia public.user_roles + o enum public.app_role no policy de master.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'app_role') THEN
    CREATE TYPE public.app_role AS ENUM ('employee','customer','master');
  END IF;
END $$;
CREATE TABLE IF NOT EXISTS public.user_roles (
  user_id uuid NOT NULL,
  role public.app_role NOT NULL
);
SQL


# ══════════════════════════════════════════════════════════════════════════════
# ZONA 2 — APLICAR A MIGRATION REAL (Lei #1: o .sql commitado, não um stub)
# ══════════════════════════════════════════════════════════════════════════════
MIG="$REPO_ROOT/supabase/migrations/20260826002244_telemetria_probes.sql"
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
UID_A="11111111-1111-1111-1111-111111111111"
UID_B="22222222-2222-2222-2222-222222222222"
DEV_A="aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"
P -q <<SQL
INSERT INTO auth.users (id) VALUES ('$UID_A'), ('$UID_B') ON CONFLICT DO NOTHING;
-- FIEL A PROD: o ALTER DEFAULT PRIVILEGES de public dá arwdDxtm a authenticated/anon.
-- Logo a ÚNICA defesa desta tabela é a RLS — é isso que este harness prova.
GRANT ALL ON public.telemetria_probes TO authenticated, anon;
GRANT SELECT ON public.user_roles TO authenticated, anon;
SQL


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
# Helper: exige que a operação seja BARRADA com a SQLSTATE esperada, rodando como
# `authenticated` com o GUC de impersonação. A sentinela ZZ_NAO_BARROU não aparece em
# lugar nenhum do código sob teste — anti-teatro: nada do próprio código pode casá-la.
neg() { # neg <desc> <sqlstate> <uid> <sql>
  local desc="$1" state="$2" uid="$3" sql="$4"
  if P -q -c "SET test.uid='$uid'; SET test.role='authenticated'; SET ROLE authenticated;
DO \$t\$ BEGIN
  $sql
  RAISE EXCEPTION 'ZZ_NAO_BARROU';
EXCEPTION
  WHEN $state THEN NULL;
  WHEN OTHERS THEN RAISE;
END \$t\$;" >/dev/null 2>&1
  then ok "$desc (barrado com $state)"; else bad "$desc — NÃO barrou com $state"; fi
}

ins() { # ins <uid> <attempt> <extra-cols> <extra-vals>
  echo "INSERT INTO public.telemetria_probes (attempt_id, device_id, user_id$3)
        VALUES ('$2', '$DEV_A', '$1'$4);"
}

echo "── POSITIVOS ──"
# P1 é A ASSERÇÃO QUE EU TINHA RACIOCINADO MAS NÃO PROVADO: o DEFAULT now() de
# `criado_em` é avaliado ANTES do WITH CHECK que testa a janela? Se não fosse, todo
# INSERT do cliente seria rejeitado e o probe nasceria morto e silencioso.
P -q -c "SET test.uid='$UID_A'; SET test.role='authenticated'; SET ROLE authenticated;
         $(ins "$UID_A" "$DEV_A.p1" "" "")" >/dev/null 2>&1
V=$(Pq -c "SELECT count(*) FROM public.telemetria_probes WHERE attempt_id='$DEV_A.p1';")
eq "P1 INSERT próprio SEM criado_em (DEFAULT passa pelo WITH CHECK)" "$V" "1"

P -q -c "SET test.uid='$UID_A'; SET test.role='authenticated'; SET ROLE authenticated;
         $(ins "$UID_A" "$DEV_A.p2" ", criado_em" ", now()")" >/dev/null 2>&1
V=$(Pq -c "SELECT count(*) FROM public.telemetria_probes WHERE attempt_id='$DEV_A.p2';")
eq "P2 INSERT com criado_em explícito dentro da janela" "$V" "1"

V=$(Pq -c "SELECT criado_em IS NOT NULL FROM public.telemetria_probes WHERE attempt_id='$DEV_A.p1';")
eq "P3 criado_em preenchido pelo DEFAULT" "$V" "t"

echo "── NEGATIVOS (a defesa morde) ──"
neg "N1 INSERT com user_id de OUTRO usuário" "insufficient_privilege" "$UID_A" \
    "$(ins "$UID_B" "$DEV_A.n1" "" "")"
neg "N2 criado_em no PASSADO fora da janela" "insufficient_privilege" "$UID_A" \
    "$(ins "$UID_A" "$DEV_A.n2" ", criado_em" ", now() - interval '2 hours'")"
neg "N3 criado_em no FUTURO fora da janela" "insufficient_privilege" "$UID_A" \
    "$(ins "$UID_A" "$DEV_A.n3" ", criado_em" ", now() + interval '2 hours'")"
neg "N6 attempt_id curto demais viola o CHECK" "check_violation" "$UID_A" \
    "$(ins "$UID_A" "curto" "" "")"

# N4/N5: sem policy de UPDATE/DELETE o Postgres não ERRA — ele simplesmente não
# enxerga linha nenhuma. O assert certo é "0 linhas afetadas", não "lançou".
V=$(Pq -c "SET test.uid='$UID_A'; SET test.role='authenticated'; SET ROLE authenticated;
  WITH u AS (UPDATE public.telemetria_probes SET build_id='hackeado'
             WHERE attempt_id='$DEV_A.p1' RETURNING 1) SELECT count(*) FROM u;" | tail -1)
eq "N4 UPDATE da própria linha não afeta nada (append-only)" "$V" "0"

V=$(Pq -c "SET test.uid='$UID_A'; SET test.role='authenticated'; SET ROLE authenticated;
  WITH d AS (DELETE FROM public.telemetria_probes
             WHERE attempt_id='$DEV_A.p1' RETURNING 1) SELECT count(*) FROM d;" | tail -1)
eq "N5 DELETE da própria linha não apaga nada (evidência é imutável)" "$V" "0"

V=$(Pq -c "SET test.uid='$UID_B'; SET test.role='authenticated'; SET ROLE authenticated;
  SELECT count(*) FROM public.telemetria_probes;" | tail -1)
eq "N7 usuário B não LÊ as linhas de A" "$V" "0"

V=$(Pq -c "SET test.uid='$UID_A'; SET test.role='authenticated'; SET ROLE authenticated;
  SELECT count(*) FROM public.telemetria_probes;" | tail -1)
eq "N8 usuário A LÊ as próprias (controle positivo do N7)" "$V" "2"



# ══════════════════════════════════════════════════════════════════════════════
# ZONA 5 — FALSIFICAÇÃO (Lei #3: sabota a migração → exija VERMELHO → restaura)
# ══════════════════════════════════════════════════════════════════════════════
# Padrão (ver assert-patterns.md p/ a versão completa, incl. sentinela anti-teatro):
#   1. sabota:   recria a policy/trigger/função NA VERSÃO FURADA
#   2. re-roda:  o MESMO assert do passo 4
#   3. exige:    que ele agora FALHE (se passar → assert fraco → conserte)
#   4. restaura: a versão verdadeira (cirurgicamente, só o que sabotou)
#
# Cada sabotagem tem de deixar VERMELHO o assert que a cobre. Se seguir verde, o
# assert não tem dente. Contamos os fails ANTES e DEPOIS: a diferença é a prova.
sabota_e_exige_vermelho() { # <desc> <sql-sabotagem> <assert-fn>
  local desc="$1" sql="$2"; shift 2
  local antes=$FAIL
  P -q -c "$sql" >/dev/null 2>&1
  "$@" >/dev/null 2>&1
  if [ "$FAIL" -gt "$antes" ]; then
    PASS=$((PASS+1)); FAIL=$antes; echo "  ✅ falsificação: $desc → assert ficou VERMELHO"
  else
    FAIL=$((antes+1)); echo "  ❌ falsificação: $desc → assert seguiu VERDE (sem dente)"
  fi
}

# F1 — guard de janela removido do WITH CHECK: N2 (passado distante) tem de passar a
# NÃO ser barrado, e portanto o assert N2 fica vermelho.
f1_check() { neg "F1" "insufficient_privilege" "$UID_A" \
  "$(ins "$UID_A" "$DEV_A.f1" ", criado_em" ", now() - interval '2 hours'")"; }
sabota_e_exige_vermelho "WITH CHECK sem o guard de janela" \
"DROP POLICY IF EXISTS \"telemetria_probes_user_insert\" ON public.telemetria_probes;
 CREATE POLICY \"telemetria_probes_user_insert\" ON public.telemetria_probes
   FOR INSERT WITH CHECK (auth.uid() = user_id);" f1_check
P -q -c "DROP POLICY IF EXISTS \"telemetria_probes_user_insert\" ON public.telemetria_probes;
 CREATE POLICY \"telemetria_probes_user_insert\" ON public.telemetria_probes
   FOR INSERT WITH CHECK (auth.uid() = user_id
     AND criado_em > now() - interval '10 minutes'
     AND criado_em <= now() + interval '1 minute');" >/dev/null

# F2 — abrir UPDATE: o append-only cai e N4 passa a afetar 1 linha.
f2_check() { local V; V=$(Pq -c "SET test.uid='$UID_A'; SET test.role='authenticated'; SET ROLE authenticated;
  WITH u AS (UPDATE public.telemetria_probes SET build_id='hackeado'
             WHERE attempt_id='$DEV_A.p1' RETURNING 1) SELECT count(*) FROM u;" | tail -1)
  eq "F2" "$V" "0"; }
sabota_e_exige_vermelho "policy de UPDATE aberta (append-only cai)" \
"CREATE POLICY \"zz_sabotagem_update\" ON public.telemetria_probes
   FOR UPDATE USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);" f2_check
P -q -c "DROP POLICY IF EXISTS \"zz_sabotagem_update\" ON public.telemetria_probes;" >/dev/null

# F3 — CHECK de tamanho removido: attempt_id curto deixa de ser barrado.
f3_check() { neg "F3" "check_violation" "$UID_A" "$(ins "$UID_A" "curt2" "" "")"; }
sabota_e_exige_vermelho "CHECK de tamanho do attempt_id removido" \
"ALTER TABLE public.telemetria_probes DROP CONSTRAINT telemetria_probes_attempt_id_formato;" f3_check
P -q -c "ALTER TABLE public.telemetria_probes ADD CONSTRAINT telemetria_probes_attempt_id_formato
   CHECK (length(attempt_id) BETWEEN 10 AND 128);" >/dev/null



# ── veredito ──
echo "──────────────────────────────"
echo "RESULTADO: $PASS ok / $FAIL fail"
[ "$FAIL" = "0" ] || { echo "❌ HARNESS VERMELHO"; exit 1; }
echo "✅ HARNESS VERDE"
