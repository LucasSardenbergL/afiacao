#!/usr/bin/env bash
# ╔══════════════════════════════════════════════════════════════════════════════╗
# ║  PROVA: migration 20261102204836_rls_has_role_initplan_classe.sql            ║
# ║  has_role(auth.uid(), …) por linha → InitPlan nas 308 policies / 185 tabelas ║
# ║  da prod (fixture verbatim). Camadas:                                         ║
# ║   A1 matriz RLS REAL (SET ROLE + request.jwt.claims): o CONJUNTO de linhas    ║
# ║      que cada papel lê/insere/atualiza/apaga é o mesmo antes e depois         ║
# ║   A2 cada cláusula, ponto a ponto: (antiga) IS DISTINCT FROM (nova) = 0       ║
# ║   A3 catálogo: cmd/permissive/roles/presença de cláusula iguais               ║
# ║   A4 contagem: 308 policies reescritas, 872 chamadas, zero cru                ║
# ║   A5 InitPlan: has_role roda O(1) por consulta (antes: por linha)             ║
# ║   A6 idempotência: 2º apply não muda nada                                     ║
# ║  Falsifica (controle verde ANTES, na mesma invocação): F1 troca o papel no    ║
# ║  replace → P3 morde · F2 alarga TO → P1 morde · F3 pula uma tabela → P5 morde ║
# ║  · F4 policy sabotada depois → A1 e A2 mordem.                                ║
# ║  Rodar:  bash db/test-rls-has-role-initplan-classe.sh > /tmp/t.log 2>&1      ║
# ║  Locale: PROVA_LOCALE=pt_BR.UTF-8 bash db/test-rls-has-role-initplan-classe.sh║
# ╚══════════════════════════════════════════════════════════════════════════════╝
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PGVER=17
PGBIN="/opt/homebrew/opt/postgresql@${PGVER}/bin"
[ -x "$PGBIN/initdb" ] || PGBIN="$(dirname "$(command -v initdb 2>/dev/null || echo /usr/lib/postgresql/${PGVER}/bin/initdb)")"
PORT="${PGPORT_TEST:-5483}"
SLUG="rls-hr-classe"
LOC="${PROVA_LOCALE:-C}"
DATA="$(mktemp -d "/tmp/pgtest-${SLUG}.XXXXXX")/data"
export LC_ALL="$LOC" LANG="$LOC"

[ -x "$PGBIN/initdb" ] || { echo "postgresql@${PGVER} ausente"; exit 1; }
if command -v brew >/dev/null 2>&1 && brew --prefix "postgresql@${PGVER}" >/dev/null 2>&1; then
  CELLAR="$(brew --prefix "postgresql@${PGVER}")"
  cp -Rn "$CELLAR"/share/postgresql/. "/opt/homebrew/share/postgresql@${PGVER}/" 2>/dev/null || true
  mkdir -p "/opt/homebrew/lib/postgresql@${PGVER}" 2>/dev/null || true
  cp -Rn "$CELLAR"/lib/postgresql/. "/opt/homebrew/lib/postgresql@${PGVER}/" 2>/dev/null || true
fi

cleanup() { "$PGBIN/pg_ctl" -D "$DATA" stop -m immediate >/dev/null 2>&1 || true; rm -rf "$(dirname "$DATA")"; }
trap cleanup EXIT

"$PGBIN/initdb" -D "$DATA" -U postgres -E UTF8 --locale="$LOC" >/dev/null
"$PGBIN/pg_ctl" -D "$DATA" -o "-p $PORT -k /tmp" -l "/tmp/pg-${SLUG}.log" -w start >/dev/null
Pdb() { local db="$1"; shift; "$PGBIN/psql" -X -p "$PORT" -h /tmp -U postgres -d "$db" -v ON_ERROR_STOP=1 "$@"; }

MIG="$REPO_ROOT/supabase/migrations/20261102204836_rls_has_role_initplan_classe.sql"
FIX="$REPO_ROOT/db/fixtures/rls-has-role-classe-prod-2026-11-02.sql"

PASS=0; FAIL=0
ok()  { PASS=$((PASS+1)); echo "  ✅ $1"; }
bad() { FAIL=$((FAIL+1)); echo "  ❌ $1"; }
eq()  { if [ "$2" = "$3" ]; then ok "$1 (=$2)"; else bad "$1 — esperado [$3], veio [$2]"; fi; }

echo "═══ setup (PG17 :$PORT, locale $LOC) ═══"
"$PGBIN/createdb" -p "$PORT" -h /tmp -U postgres base

# ══════════════════════════════════════════════════════════════════════════════
# ZONA 1 — banco BASE = estado de PROD: dependências verbatim + fixture + seed
# ══════════════════════════════════════════════════════════════════════════════
Pdb base -q -f "$REPO_ROOT/db/stubs-supabase.sql"
Pdb base -q <<'SQL'
ALTER ROLE service_role BYPASSRLS;
CREATE TYPE public.app_role AS ENUM ('master','employee','customer');
-- has_role e private.is_super_admin VERBATIM da prod (pg_get_functiondef, 2026-11-02).
-- Vêm antes do fixture, porque CREATE POLICY valida a função; os corpos leem
-- user_roles e commercial_roles, que o fixture cria.
SET check_function_bodies = off;
CREATE OR REPLACE FUNCTION public.has_role(_user_id uuid, _role app_role)
 RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $function$ SELECT EXISTS (SELECT 1 FROM public.user_roles WHERE user_id = _user_id AND role = _role) $function$;
CREATE SCHEMA IF NOT EXISTS private;
CREATE OR REPLACE FUNCTION private.is_super_admin(_user_id uuid)
 RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $function$
  SELECT EXISTS (
    SELECT 1
    FROM public.commercial_roles
    WHERE user_id = _user_id
      AND commercial_role = 'super_admin'
  )
$function$;
SQL
Pdb base -q -f "$FIX"
Pdb base -q <<'SQL'
-- user_roles é tabela-alvo (o fixture a cria); aqui entram as colunas que has_role lê
ALTER TABLE public.user_roles ADD COLUMN IF NOT EXISTS user_id uuid, ADD COLUMN IF NOT EXISTS role public.app_role;

GRANT USAGE ON SCHEMA private TO authenticated, anon;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public, private TO authenticated, anon;

-- Chamadores. EMP e EMP2 são employee com papel comercial diferente; SUPER só tem
-- o comercial super_admin; NOROLE é autenticado sem papel nenhum.
CREATE SCHEMA _prova;
CREATE TABLE _prova.caller (nome text PRIMARY KEY, uid uuid, papel text);
INSERT INTO _prova.caller VALUES
  ('master', '11111111-1111-1111-1111-111111111111', 'authenticated'),
  ('emp',    '22222222-2222-2222-2222-222222222222', 'authenticated'),
  ('emp2',   '55555555-5555-5555-5555-555555555555', 'authenticated'),
  ('cust',   '33333333-3333-3333-3333-333333333333', 'authenticated'),
  ('super',  '66666666-6666-6666-6666-666666666666', 'authenticated'),
  ('norole', '44444444-4444-4444-4444-444444444444', 'authenticated'),
  ('semuid', NULL,                                   'authenticated'),
  ('anon',   NULL,                                   'anon');
INSERT INTO public.user_roles (user_id, role) VALUES
  ('11111111-1111-1111-1111-111111111111','master'),
  ('22222222-2222-2222-2222-222222222222','employee'),
  ('55555555-5555-5555-5555-555555555555','employee'),
  ('33333333-3333-3333-3333-333333333333','customer');

-- Toda tabela do fixture: RLS ligada, grants do Supabase.
DO $$ DECLARE t text; BEGIN
  FOR t IN SELECT tablename FROM pg_tables WHERE schemaname='public' LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('GRANT ALL ON public.%I TO authenticated, anon', t);
  END LOOP;
END $$;
GRANT USAGE ON ALL SEQUENCES IN SCHEMA public TO authenticated, anon;

-- Seed: produto cartesiano dos valores que importam por tipo de coluna (uids dos
-- chamadores + NULL; os literais de texto que as policies citam + 'outro' + NULL).
-- Tabela sem coluna citada: 3 linhas. commercial_roles: o diretório, à mão.
DO $$
DECLARE
  t text; cols text[]; fontes text[]; c record;
  vu text := '(VALUES (''11111111-1111-1111-1111-111111111111''::uuid),(''22222222-2222-2222-2222-222222222222''),(''55555555-5555-5555-5555-555555555555''),(''33333333-3333-3333-3333-333333333333''),(''66666666-6666-6666-6666-666666666666''),(''44444444-4444-4444-4444-444444444444''),(NULL))';
  vt text := '(VALUES (''manual''::text),(''published''),(''draft''),(''in_review''),(''ativa''),(''outro''),(NULL))';
  vc text := '(SELECT unnest(enum_range(NULL::public.commercial_role)) UNION ALL SELECT NULL)';
  i int;
BEGIN
  FOR t IN SELECT tablename FROM pg_tables WHERE schemaname='public' AND tablename NOT IN ('user_roles','commercial_roles') ORDER BY 1 LOOP
    cols := '{}'; fontes := '{}'; i := 0;
    FOR c IN SELECT column_name, udt_name FROM information_schema.columns
             WHERE table_schema='public' AND table_name=t AND column_name <> '_k' ORDER BY ordinal_position LOOP
      i := i + 1;
      cols := cols || quote_ident(c.column_name);
      fontes := fontes || format('%s AS s%s(v)', CASE c.udt_name WHEN 'uuid' THEN vu WHEN 'text' THEN vt
                                                          WHEN 'commercial_role' THEN vc
                                                          ELSE NULL END, i);
      IF fontes[i] IS NULL THEN RAISE EXCEPTION 'seed: tipo % de %.% sem conjunto de valores', c.udt_name, t, c.column_name; END IF;
    END LOOP;
    IF i = 0 THEN
      EXECUTE format('INSERT INTO public.%I DEFAULT VALUES', t);
      EXECUTE format('INSERT INTO public.%I DEFAULT VALUES', t);
      EXECUTE format('INSERT INTO public.%I DEFAULT VALUES', t);
    ELSE
      EXECUTE format('INSERT INTO public.%I (%s) SELECT %s FROM %s', t, array_to_string(cols, ','),
        (SELECT string_agg(format('s%s.v', g), ',') FROM generate_series(1, i) g), array_to_string(fontes, ' CROSS JOIN '));
    END IF;
  END LOOP;
END $$;
INSERT INTO public.commercial_roles (user_id, commercial_role) VALUES
  ('11111111-1111-1111-1111-111111111111','master'),
  ('22222222-2222-2222-2222-222222222222','gerencial'),
  ('55555555-5555-5555-5555-555555555555','estrategico'),
  ('66666666-6666-6666-6666-666666666666','super_admin'),
  (NULL,'estrategico');

-- Linhas extras nas duas tabelas de tela medidas, para o contador por linha.
INSERT INTO public.profiles SELECT FROM generate_series(1, 500);
INSERT INTO public.tint_importacoes SELECT FROM generate_series(1, 500);

-- ── sondas: o CONJUNTO de _k que cada chamador alcança, por comando ──
CREATE TABLE _prova.resultado (fase text, tabela text, caller text, cmd text, assinatura text,
                               PRIMARY KEY (fase, tabela, caller, cmd));
CREATE TABLE _prova.clausula (fase text, tabela text, policy text, cmd text, permissive text,
                              roles text, qual text, wc text, PRIMARY KEY (fase, tabela, policy));

CREATE FUNCTION _prova.foto_catalogo(p_fase text) RETURNS void LANGUAGE sql AS $f$
  INSERT INTO _prova.clausula
  SELECT p_fase, tablename, policyname, cmd, permissive, array_to_string(roles, ','), qual, with_check
  FROM pg_policies WHERE schemaname = 'public';
$f$;

-- Cada sonda roda num sub-bloco que termina em RAISE sentinela: o SET ROLE, o GUC e
-- a escrita voltam atrás. Só a sentinela e a negação de RLS (42501) são esperadas;
-- qualquer outro erro sobe e derruba a prova.
CREATE FUNCTION _prova.sondar(p_fase text) RETURNS void LANGUAGE plpgsql AS $f$
DECLARE
  t text; cl record; k int; ks int[]; sel text; upd text; del text; ins text; n int;
BEGIN
  FOR t IN SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY 1 LOOP
    FOR cl IN SELECT * FROM _prova.caller ORDER BY nome LOOP
      -- SELECT
      BEGIN
        EXECUTE format('SET ROLE %I', cl.papel);
        PERFORM set_config('request.jwt.claims', CASE WHEN cl.uid IS NULL THEN '' ELSE json_build_object('sub', cl.uid)::text END, true);
        EXECUTE format('SELECT coalesce(string_agg(_k::text, '','' ORDER BY _k), ''∅'') FROM public.%I', t) INTO sel;
        RAISE EXCEPTION USING ERRCODE = 'PV001';
      EXCEPTION WHEN SQLSTATE 'PV001' THEN NULL;
      END;
      -- DELETE (um statement, devolve o conjunto apagado)
      BEGIN
        EXECUTE format('SET ROLE %I', cl.papel);
        PERFORM set_config('request.jwt.claims', CASE WHEN cl.uid IS NULL THEN '' ELSE json_build_object('sub', cl.uid)::text END, true);
        EXECUTE format('WITH d AS (DELETE FROM public.%I RETURNING _k) SELECT coalesce(string_agg(_k::text, '','' ORDER BY _k), ''∅'') FROM d', t) INTO del;
        RAISE EXCEPTION USING ERRCODE = 'PV001';
      EXCEPTION WHEN SQLSTATE 'PV001' THEN NULL;
      END;
      -- UPDATE e INSERT, linha a linha (WITH CHECK nega a linha, não o conjunto)
      upd := ''; ins := '';
      FOR k IN EXECUTE format('SELECT _k FROM public.%I ORDER BY _k', t) LOOP
        BEGIN
          EXECUTE format('SET ROLE %I', cl.papel);
          PERFORM set_config('request.jwt.claims', CASE WHEN cl.uid IS NULL THEN '' ELSE json_build_object('sub', cl.uid)::text END, true);
          BEGIN
            EXECUTE format('UPDATE public.%I SET _k = _k WHERE _k = $1', t) USING k;
            GET DIAGNOSTICS n = ROW_COUNT;
            upd := upd || k || CASE WHEN n = 1 THEN 'u,' ELSE '-,' END;
          EXCEPTION WHEN insufficient_privilege THEN upd := upd || k || 'X,';
          END;
          RAISE EXCEPTION USING ERRCODE = 'PV001';
        EXCEPTION WHEN SQLSTATE 'PV001' THEN NULL;
        END;
        BEGIN
          EXECUTE format('CREATE TEMP TABLE IF NOT EXISTS _cp AS SELECT * FROM public.%I WHERE _k = %s', t, k);
          EXECUTE format('UPDATE _cp SET _k = _k + 1000000');
          EXECUTE 'GRANT SELECT ON _cp TO authenticated, anon';
          EXECUTE format('SET ROLE %I', cl.papel);
          PERFORM set_config('request.jwt.claims', CASE WHEN cl.uid IS NULL THEN '' ELSE json_build_object('sub', cl.uid)::text END, true);
          BEGIN
            EXECUTE format('INSERT INTO public.%I SELECT * FROM _cp', t);
            ins := ins || k || 'i,';
          EXCEPTION WHEN insufficient_privilege THEN ins := ins || k || 'X,';
          END;
          RAISE EXCEPTION USING ERRCODE = 'PV001';
        EXCEPTION WHEN SQLSTATE 'PV001' THEN NULL;
        END;
      END LOOP;
      INSERT INTO _prova.resultado VALUES
        (p_fase, t, cl.nome, 'SELECT', sel), (p_fase, t, cl.nome, 'DELETE', del),
        (p_fase, t, cl.nome, 'UPDATE', md5(upd)), (p_fase, t, cl.nome, 'INSERT', md5(ins));
    END LOOP;
  END LOOP;
END $f$;
SQL

# A sonda tem de DISTINGUIR papéis, senão a matriz igual é teatro (sempre-igual aprova tudo).
"$PGBIN/createdb" -p "$PORT" -h /tmp -U postgres -T base controle
Pdb controle -q -c "SELECT _prova.sondar('antes'); SELECT _prova.foto_catalogo('antes');" >/dev/null
DIST=$(Pdb controle -tA -c "SELECT count(DISTINCT assinatura) FROM _prova.resultado WHERE fase='antes' AND tabela='profiles' AND cmd='SELECT';")
eq "C0 a sonda separa papéis em profiles (master/emp veem tudo, cust/anon nada)" "$DIST" "2"
DIST=$(Pdb controle -tA -c "SELECT count(DISTINCT assinatura) FROM _prova.resultado WHERE fase='antes' AND tabela='order_messages' AND cmd IN ('SELECT','INSERT');")
[ "${DIST:-0}" -ge 4 ] && ok "C0 a sonda separa linhas em order_messages (dono × staff × sender) ($DIST assinaturas)" || bad "C0 order_messages sem variedade ($DIST)"
NPOL=$(Pdb controle -tA -c "SELECT count(*) FROM pg_policies WHERE schemaname='public' AND (coalesce(qual,'')||coalesce(with_check,'')) ~ 'has_role\(auth\.uid\(\)';")
eq "C0 fixture tem as 308 policies-alvo da prod" "$NPOL" "308"

# ══════════════════════════════════════════════════════════════════════════════
# ZONA 2 — A MIGRATION REAL (controle verde: tem de passar ANTES de qualquer sabotagem)
# ══════════════════════════════════════════════════════════════════════════════
contador_has_role() {  # $1=db  $2=tabela → chamadas de has_role num SELECT do master
  Pdb "$1" -q -tA <<SQL | tail -1
SET client_min_messages = warning;
CREATE SEQUENCE IF NOT EXISTS public._hr;
CREATE OR REPLACE FUNCTION public.has_role(_user_id uuid, _role app_role)
 RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
AS \$f\$ SELECT nextval('public._hr') IS NOT NULL AND EXISTS (SELECT 1 FROM public.user_roles WHERE user_id = _user_id AND role = _role) \$f\$;
GRANT USAGE ON SEQUENCE public._hr TO authenticated;
SELECT setval('public._hr', 1, false);
BEGIN; SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claims', '{"sub":"22222222-2222-2222-2222-222222222222"}', true);
SELECT count(*) FROM public.$2;
COMMIT;
CREATE OR REPLACE FUNCTION public.has_role(_user_id uuid, _role app_role)
 RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
AS \$f\$ SELECT EXISTS (SELECT 1 FROM public.user_roles WHERE user_id = _user_id AND role = _role) \$f\$;
SELECT last_value FROM public._hr;
SQL
}
K_PROF_ANTES=$(contador_has_role controle profiles)
K_TINT_ANTES=$(contador_has_role controle tint_importacoes)

if ! Pdb controle -q -1 -f "$MIG" > /tmp/${SLUG}-mig.log 2>&1; then
  cat /tmp/${SLUG}-mig.log; bad "CONTROLE: a migration real falhou — abortando antes das sabotagens"; echo "RESULTADO: $PASS ok / $FAIL fail"; exit 1
fi
ok "Z2 migration real aplicada (controle verde)"
Pdb controle -q -c "SELECT _prova.sondar('depois'); SELECT _prova.foto_catalogo('depois');" >/dev/null

echo "── A1 matriz RLS real: o mesmo CONJUNTO por tabela × chamador × comando ──"
TOT=$(Pdb controle -tA -c "SELECT count(*) FROM _prova.resultado WHERE fase='antes';")
eq "A1 sondas por fase (185 tabelas × 8 chamadores × 4 comandos)" "$TOT" "5920"
DIF=$(Pdb controle -tA -c "SELECT count(*) FROM _prova.resultado a FULL JOIN _prova.resultado d ON d.fase='depois' AND (d.tabela,d.caller,d.cmd)=(a.tabela,a.caller,a.cmd) WHERE a.fase='antes' AND a.assinatura IS DISTINCT FROM d.assinatura;")
eq "A1 sondas que mudaram" "$DIF" "0"

echo "── A2 cada cláusula, ponto a ponto, para cada chamador ──"
A2=$(Pdb controle -q -tA <<'SQL' | tail -1
DO $$ DECLARE r record; cl record; n int; tot int := 0; pares int := 0; BEGIN
  FOR r IN SELECT a.tabela, a.policy, x.antigo, x.novo FROM _prova.clausula a JOIN _prova.clausula d
             ON d.fase='depois' AND (d.tabela,d.policy)=(a.tabela,a.policy)
           CROSS JOIN LATERAL (VALUES (a.qual, d.qual), (a.wc, d.wc)) x(antigo, novo)
           WHERE a.fase='antes' AND x.antigo IS NOT NULL AND x.antigo IS DISTINCT FROM x.novo LOOP
    FOR cl IN SELECT * FROM _prova.caller LOOP
      PERFORM set_config('request.jwt.claims', CASE WHEN cl.uid IS NULL THEN '' ELSE json_build_object('sub', cl.uid)::text END, true);
      EXECUTE format('SELECT count(*) FROM public.%I WHERE (%s) IS DISTINCT FROM (%s)', r.tabela, r.antigo, r.novo) INTO n;
      tot := tot + n; pares := pares + 1;
    END LOOP;
  END LOOP;
  CREATE TEMP TABLE _a2 AS SELECT tot, pares;
END $$;
SELECT tot || '|' || pares FROM _a2;
SQL
)
eq "A2 linhas onde (antiga) ≠ (nova), somando todas as cláusulas × 8 chamadores" "${A2%%|*}" "0"
[ "${A2#*|}" -gt 0 ] && ok "A2 avaliou ${A2#*|} pares cláusula×chamador" || bad "A2 não avaliou nada"

echo "── A3 catálogo preservado ──"
A3=$(Pdb controle -tA -c "SELECT count(*) FROM _prova.clausula a FULL JOIN _prova.clausula d ON d.fase='depois' AND (d.tabela,d.policy)=(a.tabela,a.policy) WHERE a.fase='antes' AND (d.policy IS NULL OR (a.cmd,a.permissive,a.roles,a.qual IS NULL,a.wc IS NULL) IS DISTINCT FROM (d.cmd,d.permissive,d.roles,d.qual IS NULL,d.wc IS NULL));")
eq "A3 policies com cmd/permissive/roles/cláusula diferentes" "$A3" "0"
NOVAS=$(Pdb controle -tA -c "SELECT count(*) FROM _prova.clausula WHERE fase='depois'") ; VELHAS=$(Pdb controle -tA -c "SELECT count(*) FROM _prova.clausula WHERE fase='antes'")
eq "A3 mesmo número de policies" "$NOVAS" "$VELHAS"

echo "── A4 contagem ──"
eq "A4 policies reescritas" "$(Pdb controle -tA -c "SELECT count(*) FROM _prova.clausula a JOIN _prova.clausula d ON d.fase='depois' AND (d.tabela,d.policy)=(a.tabela,a.policy) WHERE a.fase='antes' AND (a.qual,a.wc) IS DISTINCT FROM (d.qual,d.wc);")" "308"
eq "A4 chamadas embrulhadas" "$(Pdb controle -tA -c "SELECT count(*) FROM _prova.clausula d, regexp_matches(coalesce(d.qual,'')||' '||coalesce(d.wc,''), '\( SELECT has_role\(auth\.uid\(\), ''[a-z_]+''::app_role\) AS has_role\)', 'g') WHERE d.fase='depois';")" "872"
eq "A4 has_role cru que sobrou" "$(Pdb controle -tA -c "SELECT count(*) FROM pg_policies WHERE schemaname='public' AND (coalesce(qual,'')||' '||coalesce(with_check,'')) ~ '(?<!SELECT )has_role\(auth\.uid\(\), ''[a-z_]+''::app_role\)';")" "0"

echo "── A5 InitPlan: has_role por consulta, não por linha ──"
K_PROF=$(contador_has_role controle profiles); K_TINT=$(contador_has_role controle tint_importacoes)
[ "${K_PROF_ANTES:-0}" -ge 500 ] && ok "A5 antes: profiles chamava has_role por linha (${K_PROF_ANTES}× p/ 503 linhas)" || bad "A5 antes: profiles só ${K_PROF_ANTES}× — o contador não mede"
[ "${K_TINT_ANTES:-0}" -ge 500 ] && ok "A5 antes: tint_importacoes por linha (${K_TINT_ANTES}×)" || bad "A5 antes: tint_importacoes só ${K_TINT_ANTES}×"
[ "${K_PROF:-99}" -le 4 ] && ok "A5 depois: profiles ${K_PROF}× por consulta" || bad "A5 depois: profiles ainda ${K_PROF}×"
[ "${K_TINT:-99}" -le 4 ] && ok "A5 depois: tint_importacoes ${K_TINT}× por consulta" || bad "A5 depois: tint_importacoes ainda ${K_TINT}×"

echo "── A6 idempotência ──"
if Pdb controle -q -1 -f "$MIG" > /tmp/${SLUG}-mig2.log 2>&1; then ok "A6 2º apply passa"; else bad "A6 2º apply falhou"; cat /tmp/${SLUG}-mig2.log; fi
grep -q "0 policies reescritas, 0 chamadas" /tmp/${SLUG}-mig2.log && ok "A6 2º apply não reescreve nada" || bad "A6 2º apply reescreveu algo: $(grep -o 'rls_has_role_initplan:.*' /tmp/${SLUG}-mig2.log | head -1)"
A6=$(Pdb controle -tA -c "SELECT count(*) FROM pg_policies p JOIN _prova.clausula d ON d.fase='depois' AND (d.tabela,d.policy)=(p.tablename,p.policyname) WHERE p.schemaname='public' AND (p.qual,p.with_check) IS DISTINCT FROM (d.qual,d.wc);")
eq "A6 policies alteradas pelo 2º apply" "$A6" "0"

# ══════════════════════════════════════════════════════════════════════════════
# ZONA 3 — FALSIFICAÇÃO. Cada sabotagem roda numa CÓPIA do banco base (ou numa
# cópia do arquivo), então não há o que restaurar. Exige vermelho com a marca do ramo.
# ══════════════════════════════════════════════════════════════════════════════
sabota_mig() {  # $1=rótulo $2=expressão sed $3=marca esperada
  local db="sab_$1" f="/tmp/${SLUG}-$1.sql"
  sed "$2" "$MIG" > "$f"
  if cmp -s "$f" "$MIG"; then bad "$1 o sed não mudou a migration (sabotagem vazia)"; return; fi
  "$PGBIN/createdb" -p "$PORT" -h /tmp -U postgres -T base "$db"
  if Pdb "$db" -q -1 -f "$f" > "/tmp/${SLUG}-$1.log" 2>&1; then
    bad "$1 migration sabotada PASSOU"
  elif grep -q "$3" "/tmp/${SLUG}-$1.log"; then
    ok "$1 morde com $3"
  else
    bad "$1 falhou, mas sem $3: $(grep -m1 -E 'ERRO|ERROR' "/tmp/${SLUG}-$1.log")"
  fi
  # o ROLLBACK é do executor: o banco sabotado tem de seguir com zero policy embrulhada
  local w; w=$(Pdb "$db" -tA -c "SELECT count(*) FROM pg_policies WHERE schemaname='public' AND (coalesce(qual,'')||coalesce(with_check,'')) ~ '\( SELECT has_role\(auth\.uid\(\), ';")
  eq "$1 nada ficou meio-aplicado" "$w" "0"
}
echo "── F1 replace troca o papel → P3 ──"
sabota_mig F1 "s/'(SELECT \\\\1)'/'(SELECT has_role(auth.uid(), ''master''::app_role))'/g" "P3 FALHOU"
echo "── F2 ALTER alarga para TO public → P1 ──"
sabota_mig F2 "s/format('ALTER POLICY %I ON public.%I', r.polname, r.tabela)/format('ALTER POLICY %I ON public.%I TO public', r.polname, r.tabela)/" "P1 FALHOU"
echo "── F3 pula uma tabela → P5 ──"
sabota_mig F3 "s/CONTINUE WHEN q_new IS NOT DISTINCT FROM r.qual/CONTINUE WHEN r.tabela = 'profiles' OR q_new IS NOT DISTINCT FROM r.qual/" "P5 FALHOU"

echo "── F4 policy sabotada depois do apply → A1 e A2 ──"
"$PGBIN/createdb" -p "$PORT" -h /tmp -U postgres -T controle sab_F4
Pdb sab_F4 -q -c "DELETE FROM _prova.resultado WHERE fase='depois'; DELETE FROM _prova.clausula WHERE fase='depois';
  ALTER POLICY \"Employees can view all profiles\" ON public.profiles USING ((SELECT has_role(auth.uid(), 'master'::app_role)));
  SELECT _prova.sondar('depois'); SELECT _prova.foto_catalogo('depois');" >/dev/null
F4=$(Pdb sab_F4 -tA -c "SELECT count(*) FROM _prova.resultado a JOIN _prova.resultado d ON d.fase='depois' AND (d.tabela,d.caller,d.cmd)=(a.tabela,a.caller,a.cmd) WHERE a.fase='antes' AND a.assinatura IS DISTINCT FROM d.assinatura;")
[ "${F4:-0}" -ge 1 ] && ok "F4 A1 morde ($F4 sondas mudaram: employee perdeu profiles)" || bad "F4 A1 não viu employee perder profiles"
F4b=$(Pdb sab_F4 -tA -c "SELECT set_config('request.jwt.claims','{\"sub\":\"22222222-2222-2222-2222-222222222222\"}',false) IS NULL; SELECT count(*) FROM public.profiles WHERE ((has_role(auth.uid(), 'master'::app_role) OR has_role(auth.uid(), 'employee'::app_role))) IS DISTINCT FROM (( SELECT has_role(auth.uid(), 'master'::app_role) AS has_role));" | tail -1)
[ "${F4b:-0}" -ge 1 ] && ok "F4 A2 morde ($F4b linhas divergem para o employee)" || bad "F4 A2 não viu a divergência"

echo "──────────────────────────────"
echo "RESULTADO: $PASS ok / $FAIL fail (locale $LOC)"
[ "$FAIL" = "0" ] || { echo "❌ HARNESS VERMELHO"; exit 1; }
echo "PROVA-RLS-HAS-ROLE-INITPLAN-OK"
