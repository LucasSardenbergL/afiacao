#!/usr/bin/env bash
# ╔══════════════════════════════════════════════════════════════════════════════╗
# ║  PROVA: migration 20261104192942_carteira_visibilidade_por_conjunto.sql        ║
# ║  private.carteira_visivel_para(customer_user_id, uid) POR LINHA → conjunto 1×  ║
# ║  (hashed SubPlan) nas 8 policies da carteira. Corpos e textos VERBATIM da prod ║
# ║  (psql-ro, 2026-11-04). RLS REAL: SET ROLE + request.jwt.claims (auth.uid()    ║
# ║  com o corpo da prod, de db/stubs-supabase.sql). Camadas:                      ║
# ║   C0 a sonda distingue chamadores (valores absolutos, antes da migration)      ║
# ║   A1 CONJUNTO de linhas lidas (7 tabelas + carteira_assignments) e a matriz de ║
# ║      INSERT de visitas_agendadas (WITH CHECK): igual antes e depois, para      ║
# ║      master, dono, cobertura ativa / expirada / inativa / sem validade, gestor ║
# ║      (cap), employee sem carteira, customer, uid nulo e anon                   ║
# ║   A2 cada cláusula ponto a ponto: (antiga IS TRUE) IS DISTINCT FROM (nova)     ║
# ║   A3 catálogo: função SETOF STABLE SECDEF, ACL = a da antiga, sem PUBLIC/anon; ║
# ║      cmd/roles/permissive intactos; zero policy chamando a antiga              ║
# ║   A4 plano: hashed SubPlan · A5 contador: 1 chamada por consulta (antes: N)    ║
# ║   A6 idempotente · A7 deriva → PRE e nada aplicado · A8/A8b plano genérico     ║
# ║   A9 lock_timeout: leitor segurando a tabela → 55P03 e nada aplicado           ║
# ║  Falsifica (controle verde ANTES, na mesma invocação):                         ║
# ║   S1 conjunto sem `eligible` → A1 · S2 cobertura sem validade → A1 ·           ║
# ║   S3 sem o termo master → A1 e A2 · S4 WITH CHECK sem o conjunto → A1 (INSERT) ·    ║
# ║   S5 EXECUTE para anon → A3 · S6 policy volta à função por linha → A4 e A5 ·   ║
# ║   M1 migration sem REVOKE PUBLIC → P7 · M2 termo novo fora da forma do PG → P3 ║
# ║   M3 isolamento REPEATABLE READ → P0 · S7 SubPlan sem hash → A4 ·              ║
# ║   M4 corpo vivo da ANTIGA mudou → PRE · M5 nova já existe com outro corpo →    ║
# ║   PRE · M6 reapply com GRANT OPTION → P7 · M7 atraso sem lock → P8 (orçamento) ║
# ║   · M8 reconferência final dos corpos (P9) com md5 trocado → P9               ║
# ║  Rodar:  bash db/test-rls-carteira-visibilidade-conjunto.sh > /tmp/t.log 2>&1  ║
# ║  Locale: PROVA_LOCALE=pt_BR.UTF-8 bash db/test-rls-carteira-visibilidade-…     ║
# ╚══════════════════════════════════════════════════════════════════════════════╝
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
export PGVER=17   # consumido pelo db/lib/pg-harness.sh via source
# shellcheck disable=SC1091  # o gate roda sem -x; o helper e versionado ao lado, em db/lib/
. "$REPO_ROOT/db/lib/pg-harness.sh"   # exporta PGBIN — fail-CLOSED, confere a major POSITIVAMENTE
PORT="${PGPORT_TEST:-5487}"
SLUG="rls-carteira-conj"
LOC="${PROVA_LOCALE:-C}"
TMPD="$(mktemp -d "/tmp/pgtest-${SLUG}.XXXXXX")"
DATA="$TMPD/data"
export LC_ALL="$LOC" LANG="$LOC"

cleanup() { "$PGBIN/pg_ctl" -D "$DATA" stop -m immediate >/dev/null 2>&1 || true; rm -rf "$TMPD"; }
trap cleanup EXIT

"$PGBIN/initdb" -D "$DATA" -U postgres -E UTF8 --locale="$LOC" >/dev/null
"$PGBIN/pg_ctl" -D "$DATA" -o "-p $PORT -k /tmp" -l "$TMPD/pg.log" -w start >/dev/null
Pdb() { local db="$1"; shift; "$PGBIN/psql" -X -p "$PORT" -h /tmp -U postgres -d "$db" -v ON_ERROR_STOP=1 "$@"; }
Q()   { local db="$1"; shift; Pdb "$db" -tA -c "$*"; }
copia() { "$PGBIN/createdb" -p "$PORT" -h /tmp -U postgres -T "$1" "$2"; }

MIG="$REPO_ROOT/supabase/migrations/20261104192942_carteira_visibilidade_por_conjunto.sql"
[ -s "$MIG" ] || { echo "migration ausente: $MIG"; exit 1; }

# Aplica um arquivo como o db:aplicar: UMA transação, ON_ERROR_STOP, e exige o marcador
# positivo de fim. Devolve 0 só com o marcador; o log fica em $TMPD/apply-<db>.log.
aplica() {
  local db="$1" arq="$2" log="$TMPD/apply-$1.log"
  set +e
  "$PGBIN/psql" -X -p "$PORT" -h /tmp -U postgres -d "$db" -v ON_ERROR_STOP=1 -v VERBOSITY=verbose \
    -1 -f "$arq" -c "SELECT 'MARCADOR-FIM-APLICADO'" >"$log" 2>&1
  local rc=$?
  set -e
  [ "$rc" -eq 0 ] && grep -q 'MARCADOR-FIM-APLICADO' "$log"
}

PASS=0; FAIL=0; VERM=0; FALHAS_S=0
ok()  { PASS=$((PASS+1)); echo "  ✅ $1"; }
bad() { FAIL=$((FAIL+1)); echo "  ❌ $1"; }
eq()  { if [ "$2" = "$3" ]; then ok "$1 (=$2)"; else bad "$1 — esperado [$3], veio [$2]"; fi; }
# sabotagem: o assert TEM de ficar vermelho (valor ≠ verde)
morde() { if [ "$2" != "$3" ]; then VERM=$((VERM+1)); ok "$1 morde (veio [$2])"; else FALHAS_S=$((FALHAS_S+1)); bad "$1 NÃO mordeu (ficou [$2])"; fi; }

echo "═══ setup (PG17 :$PORT, locale $LOC) ═══"
"$PGBIN/createdb" -p "$PORT" -h /tmp -U postgres base

# ══════════════════════════════════════════════════════════════════════════════
# ZONA 1 — banco BASE = estado da PROD (2026-11-04): funções e policies verbatim
# ══════════════════════════════════════════════════════════════════════════════
Pdb base -q -f "$REPO_ROOT/db/stubs-supabase.sql"
Pdb base -q <<'SQL'
ALTER ROLE service_role BYPASSRLS;
-- sandbox_exec* como na prod (pg_roles, 2026-11-04): BYPASSRLS, sem USAGE em private, 'ar' nas tabelas.
CREATE ROLE sandbox_exec NOLOGIN BYPASSRLS;
CREATE ROLE sandbox_exec_fzvklzpomgnyikkfkzai NOLOGIN BYPASSRLS;
CREATE TYPE public.app_role AS ENUM ('master','employee','customer');
CREATE SCHEMA IF NOT EXISTS private;
-- ACL do schema como na prod
GRANT USAGE ON SCHEMA private TO authenticated, anon, service_role;
GRANT USAGE ON SCHEMA auth TO authenticated, anon, service_role;

CREATE TABLE public.user_roles (user_id uuid NOT NULL, role public.app_role NOT NULL);
CREATE TABLE public.commercial_roles (user_id uuid NOT NULL UNIQUE, commercial_role text NOT NULL);

-- Tabelas: só as colunas que as policies citam (tipo e nulidade da prod) + rotulo da prova.
CREATE TABLE public.carteira_assignments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), rotulo text,
  customer_user_id uuid NOT NULL UNIQUE, owner_user_id uuid NOT NULL, eligible boolean NOT NULL);
CREATE TABLE public.carteira_coverage (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  covering_user_id uuid NOT NULL, covered_user_id uuid NOT NULL,
  active boolean NOT NULL, valid_until timestamptz);
CREATE TABLE public.customer_visit_scores (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), rotulo text, customer_user_id uuid NOT NULL, farmer_id uuid NOT NULL);
CREATE TABLE public.farmer_client_scores (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), rotulo text, customer_user_id uuid NOT NULL, farmer_id uuid NOT NULL);
CREATE TABLE public.farmer_recommendations (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), rotulo text, customer_user_id uuid NOT NULL, farmer_id uuid NOT NULL);
CREATE TABLE public.farmer_bundle_recommendations (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), rotulo text, customer_user_id uuid NOT NULL, farmer_id uuid NOT NULL);
CREATE TABLE public.farmer_calls (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), rotulo text, customer_user_id uuid, farmer_id uuid NOT NULL);
CREATE TABLE public.route_visits (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), rotulo text, customer_user_id uuid NOT NULL, visited_by uuid NOT NULL);
CREATE TABLE public.visitas_agendadas (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), customer_user_id uuid NOT NULL,
  scheduled_by uuid NOT NULL, status text NOT NULL, route_visit_id uuid);

-- Funções VERBATIM da prod (pg_get_functiondef, 2026-11-04).
CREATE OR REPLACE FUNCTION public.has_role(_user_id uuid, _role app_role)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$ SELECT EXISTS (SELECT 1 FROM public.user_roles WHERE user_id = _user_id AND role = _role) $function$;

CREATE OR REPLACE FUNCTION private.cap_carteira_ler(_uid uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
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

CREATE OR REPLACE FUNCTION private.carteira_visivel_para(_customer_user_id uuid, _uid uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT _uid IS NOT NULL
    AND (
      COALESCE(public.has_role(_uid, 'master'::app_role), false)
      OR EXISTS (
        SELECT 1 FROM public.carteira_assignments a
        WHERE a.customer_user_id = _customer_user_id
          AND a.owner_user_id = _uid
          AND a.eligible IS TRUE
      )
      OR EXISTS (
        SELECT 1 FROM public.carteira_assignments a
        JOIN public.carteira_coverage c ON c.covered_user_id = a.owner_user_id
        WHERE a.customer_user_id = _customer_user_id
          AND a.eligible IS TRUE
          AND c.covering_user_id = _uid
          AND c.active
          AND (c.valid_until IS NULL OR c.valid_until > now())
      )
    );
$function$;

-- ACL das funções como na prod: sem PUBLIC e sem anon.
REVOKE ALL ON FUNCTION public.has_role(uuid, app_role), private.cap_carteira_ler(uuid),
                       private.carteira_visivel_para(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.has_role(uuid, app_role) TO authenticated, service_role, sandbox_exec_fzvklzpomgnyikkfkzai;
GRANT EXECUTE ON FUNCTION private.cap_carteira_ler(uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION private.carteira_visivel_para(uuid, uuid)
  TO authenticated, service_role, sandbox_exec_fzvklzpomgnyikkfkzai, sandbox_exec;

-- Grants de tabela como na prod (has_table_privilege, 2026-11-04). farmer_client_scores
-- tem grant por COLUNA desde #3072; visitas_agendadas não abre para anon.
GRANT ALL ON public.carteira_assignments, public.carteira_coverage, public.customer_visit_scores,
             public.farmer_recommendations, public.farmer_bundle_recommendations, public.farmer_calls,
             public.route_visits TO anon, authenticated, service_role;
GRANT SELECT (id, rotulo, customer_user_id, farmer_id) ON public.farmer_client_scores TO authenticated;
GRANT ALL ON public.farmer_client_scores TO service_role;
GRANT SELECT, INSERT ON public.visitas_agendadas TO authenticated;
GRANT ALL ON public.visitas_agendadas TO service_role;
GRANT SELECT, INSERT ON public.carteira_assignments, public.carteira_coverage, public.customer_visit_scores, public.farmer_client_scores,
  public.farmer_recommendations, public.farmer_bundle_recommendations, public.farmer_calls, public.route_visits, public.visitas_agendadas
  TO sandbox_exec, sandbox_exec_fzvklzpomgnyikkfkzai;

ALTER TABLE public.carteira_assignments ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.carteira_coverage ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.customer_visit_scores ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.farmer_client_scores ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.farmer_recommendations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.farmer_bundle_recommendations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.farmer_calls ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.route_visits ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.visitas_agendadas ENABLE ROW LEVEL SECURITY;

-- As 8 policies, texto VERBATIM de pg_get_expr na prod; cmd e roles também.
CREATE POLICY "View carteira por visibilidade" ON public.carteira_assignments FOR SELECT
  USING (private.carteira_visivel_para(customer_user_id, auth.uid()));
CREATE POLICY vag_insert_own_carteira ON public.visitas_agendadas FOR INSERT TO authenticated
  WITH CHECK (((scheduled_by = ( SELECT auth.uid() AS uid)) AND private.carteira_visivel_para(customer_user_id, ( SELECT auth.uid() AS uid)) AND (status = 'pendente'::text) AND (route_visit_id IS NULL)));
CREATE POLICY cvs_select_carteira ON public.customer_visit_scores FOR SELECT
  USING ((( SELECT private.cap_carteira_ler(( SELECT auth.uid() AS uid)) AS cap_carteira_ler) OR private.carteira_visivel_para(customer_user_id, ( SELECT auth.uid() AS uid))));
CREATE POLICY fcs_select_carteira ON public.farmer_client_scores FOR SELECT
  USING ((( SELECT private.cap_carteira_ler(( SELECT auth.uid() AS uid)) AS cap_carteira_ler) OR private.carteira_visivel_para(customer_user_id, ( SELECT auth.uid() AS uid))));
CREATE POLICY frec_select_carteira ON public.farmer_recommendations FOR SELECT TO authenticated
  USING ((( SELECT private.cap_carteira_ler(( SELECT auth.uid() AS uid)) AS cap_carteira_ler) OR (farmer_id = ( SELECT auth.uid() AS uid)) OR private.carteira_visivel_para(customer_user_id, ( SELECT auth.uid() AS uid))));
CREATE POLICY fcall_select_carteira ON public.farmer_calls FOR SELECT TO authenticated
  USING ((( SELECT private.cap_carteira_ler(( SELECT auth.uid() AS uid)) AS cap_carteira_ler) OR (farmer_id = ( SELECT auth.uid() AS uid)) OR private.carteira_visivel_para(customer_user_id, ( SELECT auth.uid() AS uid))));
CREATE POLICY fbrec_select_carteira ON public.farmer_bundle_recommendations FOR SELECT TO authenticated
  USING ((( SELECT private.cap_carteira_ler(( SELECT auth.uid() AS uid)) AS cap_carteira_ler) OR (farmer_id = ( SELECT auth.uid() AS uid)) OR private.carteira_visivel_para(customer_user_id, ( SELECT auth.uid() AS uid))));
CREATE POLICY rvis_select_carteira ON public.route_visits FOR SELECT TO authenticated
  USING ((( SELECT private.cap_carteira_ler(( SELECT auth.uid() AS uid)) AS cap_carteira_ler) OR (visited_by = ( SELECT auth.uid() AS uid)) OR private.carteira_visivel_para(customer_user_id, ( SELECT auth.uid() AS uid))));
SQL

# ── Seed. Chamadores: M master · F1 dono (c1 elegível, c2 NÃO elegível) · F2 dono de c3/c4
#    (c4 não elegível) · F3 dono de c5 · FC cobre F2 ativa e vigente · FX cobre F2 EXPIRADA ·
#    FI cobre F2 INATIVA · FN cobre F3 sem valid_until · G gestor (cap_carteira_ler) ·
#    E0 employee sem carteira · CU customer · NUL authenticated sem sub · ANON anon.
#    c6 é de M; c7 não está em carteira_assignments; farmer_calls tem linhas com cliente NULL.
Pdb base -q <<'SQL'
CREATE SCHEMA _prova;
CREATE TABLE _prova.caller (nome text PRIMARY KEY, uid uuid, papel text NOT NULL);
INSERT INTO _prova.caller VALUES
 ('M',  '00000000-0000-0000-0000-0000000000a1', 'authenticated'),
 ('F1', '00000000-0000-0000-0000-0000000000a2', 'authenticated'),
 ('F2', '00000000-0000-0000-0000-0000000000a3', 'authenticated'),
 ('F3', '00000000-0000-0000-0000-0000000000a4', 'authenticated'),
 ('FC', '00000000-0000-0000-0000-0000000000a5', 'authenticated'),
 ('FX', '00000000-0000-0000-0000-0000000000a6', 'authenticated'),
 ('FI', '00000000-0000-0000-0000-0000000000a7', 'authenticated'),
 ('FN', '00000000-0000-0000-0000-0000000000a8', 'authenticated'),
 ('G',  '00000000-0000-0000-0000-0000000000a9', 'authenticated'),
 ('E0', '00000000-0000-0000-0000-0000000000ab', 'authenticated'),
 ('CU', '00000000-0000-0000-0000-0000000000aa', 'authenticated'),
 ('NUL', NULL, 'authenticated'),
 ('SBX', '00000000-0000-0000-0000-0000000000a2', 'sandbox_exec'),
 ('SBF', '00000000-0000-0000-0000-0000000000a2', 'sandbox_exec_fzvklzpomgnyikkfkzai'),
 ('ANON', NULL, 'anon');
CREATE FUNCTION _prova.u(text) RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT uid FROM _prova.caller WHERE nome = $1 $$;
CREATE FUNCTION _prova.c(int) RETURNS uuid LANGUAGE sql IMMUTABLE AS $$ SELECT ('00000000-0000-0000-0000-0000000000c' || $1)::uuid $$;

INSERT INTO public.user_roles VALUES
 (_prova.u('M'),'master'), (_prova.u('M'),'employee'),
 (_prova.u('F1'),'employee'), (_prova.u('F2'),'employee'), (_prova.u('F3'),'employee'),
 (_prova.u('FC'),'employee'), (_prova.u('FX'),'employee'), (_prova.u('FI'),'employee'),
 (_prova.u('FN'),'employee'), (_prova.u('G'),'employee'), (_prova.u('E0'),'employee'),
 (_prova.u('CU'),'customer');
INSERT INTO public.commercial_roles VALUES (_prova.u('G'),'gerencial'), (_prova.u('F1'),'operacional');

INSERT INTO public.carteira_assignments (rotulo, customer_user_id, owner_user_id, eligible) VALUES
 ('c1', _prova.c(1), _prova.u('F1'), true),
 ('c2', _prova.c(2), _prova.u('F1'), false),
 ('c3', _prova.c(3), _prova.u('F2'), true),
 ('c4', _prova.c(4), _prova.u('F2'), false),
 ('c5', _prova.c(5), _prova.u('F3'), true),
 ('c6', _prova.c(6), _prova.u('M'),  true);
INSERT INTO public.carteira_coverage (covering_user_id, covered_user_id, active, valid_until) VALUES
 (_prova.u('FC'), _prova.u('F2'), true,  now() + interval '1 day'),
 (_prova.u('FX'), _prova.u('F2'), true,  now() - interval '1 day'),
 (_prova.u('FI'), _prova.u('F2'), false, now() + interval '1 day'),
 (_prova.u('FN'), _prova.u('F3'), true,  NULL);

-- Uma linha por cliente c1..c7 em cada tabela; farmer_id/visited_by variados para o termo próprio.
DO $seed$
DECLARE i int; f uuid;
BEGIN
  FOR i IN 1..7 LOOP
    f := CASE i WHEN 2 THEN _prova.u('F1') WHEN 3 THEN _prova.u('F1') WHEN 4 THEN _prova.u('F3') ELSE _prova.u('F2') END;
    INSERT INTO public.customer_visit_scores (rotulo, customer_user_id, farmer_id) VALUES ('c'||i, _prova.c(i), f);
    INSERT INTO public.farmer_client_scores (rotulo, customer_user_id, farmer_id) VALUES ('c'||i, _prova.c(i), f);
    INSERT INTO public.farmer_recommendations (rotulo, customer_user_id, farmer_id) VALUES ('c'||i, _prova.c(i), f);
    INSERT INTO public.farmer_bundle_recommendations (rotulo, customer_user_id, farmer_id) VALUES ('c'||i, _prova.c(i), f);
    INSERT INTO public.farmer_calls (rotulo, customer_user_id, farmer_id) VALUES ('c'||i, _prova.c(i), f);
    INSERT INTO public.route_visits (rotulo, customer_user_id, visited_by) VALUES ('c'||i, _prova.c(i), f);
  END LOOP;
  INSERT INTO public.farmer_calls (rotulo, customer_user_id, farmer_id) VALUES
    ('n1', NULL, _prova.u('F2')), ('n2', NULL, _prova.u('F1'));
END
$seed$;

-- Candidatos de INSERT em visitas_agendadas: cliente × (scheduled_by próprio|outro) × status.
CREATE TABLE _prova.cand_vag (rotulo text PRIMARY KEY, customer_user_id uuid NOT NULL, proprio boolean, status text, route_visit_id uuid);
INSERT INTO _prova.cand_vag
SELECT format('c%s-%s-%s', i, CASE WHEN p THEN 'eu' ELSE 'outro' END, s), _prova.c(i), p, s, NULL
  FROM generate_series(1,7) i, (VALUES (true),(false)) p(p), (VALUES ('pendente'),('feita')) s(s);
INSERT INTO _prova.cand_vag VALUES ('c1-eu-pendente-comrota', _prova.c(1), true, 'pendente', gen_random_uuid());

-- Sonda: o que o chamador VÊ em cada tabela e o que ele consegue INSERIR. Roda o executor
-- de verdade (SET ROLE + GUC). Só 42501 vira resultado ('ERR:42501'); o resto relança.
CREATE TABLE _prova.foto (fase text, caller text, chave text, resultado text, PRIMARY KEY (fase, caller, chave));
CREATE FUNCTION _prova.sonda(p_fase text, p_caller text) RETURNS void LANGUAGE plpgsql AS $f$
DECLARE
  cl _prova.caller;
  t text;
  res text;
  cand _prova.cand_vag;
  cands _prova.cand_vag[];
  outro uuid := '00000000-0000-0000-0000-0000000000ff';
  out_keys text[] := '{}';
  out_vals text[] := '{}';
BEGIN
  SELECT * INTO cl FROM _prova.caller WHERE nome = p_caller;
  cands := ARRAY(SELECT c FROM _prova.cand_vag c ORDER BY c.rotulo);   -- lido ANTES do SET ROLE
  PERFORM set_config('request.jwt.claims',
    CASE WHEN cl.uid IS NULL THEN '' ELSE json_build_object('sub', cl.uid, 'role', cl.papel)::text END, true);
  EXECUTE format('SET LOCAL ROLE %I', cl.papel);
  FOREACH t IN ARRAY ARRAY['carteira_assignments','customer_visit_scores','farmer_client_scores','farmer_recommendations',
                           'farmer_bundle_recommendations','farmer_calls','route_visits'] LOOP
    BEGIN
      EXECUTE format('SELECT coalesce(string_agg(rotulo, '','' ORDER BY rotulo), ''-'') FROM public.%I', t) INTO res;
    EXCEPTION WHEN insufficient_privilege THEN res := 'ERR:42501';
    END;
    out_keys := out_keys || ('sel:' || t); out_vals := out_vals || res;
  END LOOP;
  FOREACH cand IN ARRAY cands LOOP
    BEGIN
      INSERT INTO public.visitas_agendadas (customer_user_id, scheduled_by, status, route_visit_id)
      VALUES (cand.customer_user_id, CASE WHEN cand.proprio THEN coalesce(cl.uid, outro) ELSE outro END,
              cand.status, cand.route_visit_id);
      RAISE EXCEPTION USING ERRCODE = 'XP001';      -- desfaz o INSERT que passou
    EXCEPTION
      WHEN SQLSTATE 'XP001' THEN res := 'ok';
      WHEN insufficient_privilege THEN res := 'neg';
    END;
    out_keys := out_keys || ('ins:' || cand.rotulo); out_vals := out_vals || res;
  END LOOP;
  RESET ROLE;
  INSERT INTO _prova.foto SELECT p_fase, p_caller, k, v FROM unnest(out_keys, out_vals) AS x(k, v);
END
$f$;
CREATE FUNCTION _prova.sondar(p_fase text) RETURNS int LANGUAGE plpgsql AS $f$
DECLARE c text;
BEGIN
  DELETE FROM _prova.foto WHERE fase = p_fase;
  FOR c IN SELECT nome FROM _prova.caller ORDER BY nome LOOP PERFORM _prova.sonda(p_fase, c); END LOOP;
  RETURN (SELECT count(*) FROM _prova.foto WHERE fase = p_fase);
END
$f$;
-- A1: sondas que diferem entre antes e depois (0 = mesmo conjunto em tudo).
CREATE FUNCTION _prova.a1() RETURNS text LANGUAGE sql AS $f$
  SELECT CASE WHEN count(*) FILTER (WHERE a.resultado IS DISTINCT FROM d.resultado) = 0
               AND count(*) = (SELECT count(*) FROM _prova.foto WHERE fase = 'antes')
              THEN 'verde'
              ELSE 'vermelho:' || string_agg(CASE WHEN a.resultado IS DISTINCT FROM d.resultado
                     THEN coalesce(a.caller, d.caller) || '/' || coalesce(a.chave, d.chave) || ' ' || coalesce(a.resultado,'∅') || '→' || coalesce(d.resultado,'∅') END, '; ') END
    FROM (SELECT * FROM _prova.foto WHERE fase = 'antes') a
    FULL JOIN (SELECT * FROM _prova.foto WHERE fase = 'depois') d USING (caller, chave)
$f$;

-- Texto e metadados das 8 policies ANTES (para A2/A3).
CREATE TABLE _prova.pol_antes AS
SELECT c.relname AS tabela, pol.polname AS policy, pol.polcmd, pol.polpermissive, pol.polroles,
       pg_get_expr(pol.polqual, pol.polrelid) AS q, pg_get_expr(pol.polwithcheck, pol.polrelid) AS w
  FROM pg_policy pol JOIN pg_class c ON c.oid = pol.polrelid
 WHERE c.relnamespace = 'public'::regnamespace;

-- A2: cada cláusula, ponto a ponto, para cada chamador com e sem uid:
-- (antiga IS TRUE) IS DISTINCT FROM (nova IS TRUE). Devolve 'verde' ou o 1º par que diverge.
-- Conta também quantos pares deram TRUE dos dois lados (comparação não-vazia).
CREATE FUNCTION _prova.a2() RETURNS text LANGUAGE plpgsql AS $f$
DECLARE
  cl record; p record; fonte text; n int; tt int; difs int := 0; verdadeiros int := 0; pares int := 0; detalhe text := '';
BEGIN
  FOR cl IN SELECT * FROM _prova.caller WHERE papel = 'authenticated' ORDER BY nome LOOP
    PERFORM set_config('request.jwt.claims',
      CASE WHEN cl.uid IS NULL THEN '' ELSE json_build_object('sub', cl.uid, 'role', 'authenticated')::text END, true);
    FOR p IN SELECT a.*, pg_get_expr(CASE WHEN a.w IS NOT NULL THEN pol.polwithcheck ELSE pol.polqual END, pol.polrelid) AS nova
               FROM _prova.pol_antes a
               JOIN pg_policy pol ON pol.polrelid = format('public.%I', a.tabela)::regclass AND pol.polname = a.policy
              ORDER BY a.tabela LOOP
      fonte := CASE WHEN p.tabela = 'visitas_agendadas'
        THEN format('(SELECT c.customer_user_id, CASE WHEN c.proprio THEN coalesce(%L::uuid, %L::uuid) ELSE %L::uuid END AS scheduled_by, c.status, c.route_visit_id FROM _prova.cand_vag c) s',
                    cl.uid, '00000000-0000-0000-0000-0000000000ff', '00000000-0000-0000-0000-0000000000ff')
        ELSE format('public.%I', p.tabela) END;
      EXECUTE format('SELECT count(*) FILTER (WHERE ((%s) IS TRUE) IS DISTINCT FROM ((%s) IS TRUE)), count(*) FILTER (WHERE (%s) IS TRUE AND (%s) IS TRUE), count(*) FROM %s',
                     coalesce(p.w, p.q), p.nova, coalesce(p.w, p.q), p.nova, fonte)
        INTO n, tt, pares;
      difs := difs + n;
      verdadeiros := verdadeiros + tt;
      IF n > 0 AND detalhe = '' THEN detalhe := cl.nome || '/' || p.tabela; END IF;
    END LOOP;
  END LOOP;
  RETURN CASE WHEN difs = 0 THEN 'verde' ELSE 'vermelho:' || difs || ' pares, 1º ' || detalhe END
         || ' (true/true=' || verdadeiros || ')';
END
$f$;

-- A3: catálogo depois da migration.
CREATE FUNCTION _prova.a3() RETURNS text LANGUAGE plpgsql AS $f$
DECLARE erros text[] := '{}'; f oid; acl_v text[]; acl_n text[];
BEGIN
  SELECT array_agg(x.grantee::regrole::text || ':' || x.is_grantable ORDER BY x.grantee::regrole::text || ':' || x.is_grantable) INTO acl_v FROM pg_proc p, aclexplode(p.proacl) x
   WHERE p.oid = 'private.carteira_visivel_para(uuid,uuid)'::regprocedure AND x.privilege_type = 'EXECUTE';
  FOREACH f IN ARRAY ARRAY[to_regprocedure('private.carteira_ve_tudo()'), to_regprocedure('private.carteira_clientes_visiveis()')] LOOP
  IF f IS NULL THEN RETURN 'vermelho:função ausente'; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_proc WHERE oid = f AND prosecdef AND provolatile = 's'
                  AND proretset = (f = to_regprocedure('private.carteira_clientes_visiveis()'))
                  AND proowner = 'postgres'::regrole AND pronargs = 0
                  AND proconfig = ARRAY['search_path=public']) THEN erros := erros || ('atributos ' || f::regprocedure::text); END IF;
  IF has_function_privilege('anon', f, 'EXECUTE') THEN erros := erros || 'anon executa'::text; END IF;
  IF EXISTS (SELECT 1 FROM pg_proc p, aclexplode(p.proacl) x WHERE p.oid = f AND x.grantee = 0) THEN erros := erros || 'PUBLIC executa'::text; END IF;
  IF NOT has_function_privilege('authenticated', f, 'EXECUTE') THEN erros := erros || 'authenticated sem EXECUTE'::text; END IF;
  SELECT array_agg(x.grantee::regrole::text || ':' || x.is_grantable ORDER BY x.grantee::regrole::text || ':' || x.is_grantable) INTO acl_n FROM pg_proc p, aclexplode(p.proacl) x
   WHERE p.oid = f AND x.privilege_type = 'EXECUTE';
  IF acl_v IS DISTINCT FROM acl_n THEN erros := erros || ('ACL ' || acl_n::text || ' <> ' || acl_v::text); END IF;
  END LOOP;
  IF to_regprocedure('private.carteira_visivel_para(uuid,uuid)') IS NULL THEN erros := erros || 'antiga sumiu (9 chamadores)'::text; END IF;
  IF EXISTS (SELECT 1 FROM pg_policy WHERE coalesce(pg_get_expr(polqual, polrelid),'') || coalesce(pg_get_expr(polwithcheck, polrelid),'') LIKE '%carteira_visivel_para%')
    THEN erros := erros || 'policy por linha'::text; END IF;
  IF (SELECT count(*) FROM pg_policy WHERE coalesce(pg_get_expr(polqual, polrelid),'') || coalesce(pg_get_expr(polwithcheck, polrelid),'') LIKE '%carteira_clientes_visiveis%') <> 8
    THEN erros := erros || 'não são 8 por conjunto'::text; END IF;
  IF EXISTS (SELECT 1 FROM _prova.pol_antes a JOIN pg_policy pol ON pol.polrelid = format('public.%I', a.tabela)::regclass AND pol.polname = a.policy
              WHERE (pol.polcmd, pol.polpermissive, pol.polroles) IS DISTINCT FROM (a.polcmd, a.polpermissive, a.polroles)
                 OR (a.q IS NULL) <> (pol.polqual IS NULL) OR (a.w IS NULL) <> (pol.polwithcheck IS NULL))
    THEN erros := erros || 'cmd/roles/cláusula mudou'::text; END IF;
  IF (SELECT count(*) FROM pg_policy pol JOIN pg_class c ON c.oid = pol.polrelid WHERE c.relnamespace = 'public'::regnamespace)
     <> (SELECT count(*) FROM _prova.pol_antes) THEN erros := erros || 'nº de policies mudou'::text; END IF;
  RETURN CASE WHEN cardinality(erros) = 0 THEN 'verde' ELSE 'vermelho:' || array_to_string(erros, ', ') END;
END
$f$;

-- Contador (A5): chamadas da função de visibilidade numa leitura do farmer dono.
CREATE FUNCTION _prova.chamadas(p_tabela text) RETURNS text LANGUAGE plpgsql AS $f$
DECLARE n int; v bigint; c bigint;
BEGIN
  SET LOCAL track_functions = 'all';
  PERFORM set_config('request.jwt.claims', json_build_object('sub', _prova.u('F1'), 'role', 'authenticated')::text, true);
  SET LOCAL ROLE authenticated;
  EXECUTE format('SELECT count(*) FROM public.%I', p_tabela) INTO n;
  RESET ROLE;
  v := coalesce(pg_stat_get_xact_function_calls('private.carteira_visivel_para(uuid,uuid)'::regprocedure), 0);
  c := coalesce(pg_stat_get_xact_function_calls(to_regprocedure('private.carteira_clientes_visiveis()')), 0);
  RETURN format('linhas=%s,visivel_para=%s,clientes_visiveis=%s', n, v, c);
END
$f$;
SQL

TOTAL_SONDAS=$(Q base "SELECT _prova.sondar('antes')")
echo "  (sondas antes: $TOTAL_SONDAS)"

# ══════════════════════════════════════════════════════════════════════════════
echo "── C0: a sonda distingue chamadores (valores absolutos, policies da PROD) ──"
# ══════════════════════════════════════════════════════════════════════════════
f() { Q base "SELECT resultado FROM _prova.foto WHERE fase='antes' AND caller='$1' AND chave='$2'"; }
eq "C0 F1 dono vê só o elegível dele (fcs)"                "$(f F1 sel:farmer_client_scores)"   "c1"
eq "C0 F1 em farmer_calls: c1 + farmer_id próprio"         "$(f F1 sel:farmer_calls)"           "c1,c2,c3,n2"
eq "C0 master vê tudo, inclusive cliente NULL (calls)"     "$(f M sel:farmer_calls)"            "c1,c2,c3,c4,c5,c6,c7,n1,n2"
eq "C0 master em carteira_assignments (sem cap)"           "$(f M sel:carteira_assignments)"    "c1,c2,c3,c4,c5,c6"
eq "C0 cobertura ativa vigente vê o elegível do coberto"   "$(f FC sel:carteira_assignments)"   "c3"
eq "C0 cobertura expirada não vê"                          "$(f FX sel:farmer_client_scores)"   "-"
eq "C0 cobertura inativa não vê"                           "$(f FI sel:farmer_client_scores)"   "-"
eq "C0 cobertura sem valid_until vê"                       "$(f FN sel:farmer_client_scores)"   "c5"
eq "C0 gestor (cap) vê tudo em fcs"                        "$(f G sel:farmer_client_scores)"    "c1,c2,c3,c4,c5,c6,c7"
eq "C0 gestor sem termo cap em carteira_assignments"       "$(f G sel:carteira_assignments)"    "-"
eq "C0 customer não vê"                                    "$(f CU sel:farmer_client_scores)"   "-"
eq "C0 uid nulo não vê"                                    "$(f NUL sel:carteira_assignments)"  "-"
eq "C0 anon: 42501 em carteira_assignments"                "$(f ANON sel:carteira_assignments)" "ERR:42501"
eq "C0 INSERT: F1 agenda c1 elegível dele"                 "$(f F1 ins:c1-eu-pendente)"         "ok"
eq "C0 INSERT: F1 não agenda c2 (não elegível)"            "$(f F1 ins:c2-eu-pendente)"         "neg"
eq "C0 INSERT: master agenda c7 (fora da carteira)"        "$(f M ins:c7-eu-pendente)"          "ok"
eq "C0 INSERT: FC agenda c3 pela cobertura"                "$(f FC ins:c3-eu-pendente)"         "ok"
eq "C0 INSERT: FX (expirada) não agenda c3"                "$(f FX ins:c3-eu-pendente)"         "neg"
eq "C0 INSERT: com route_visit_id é negado"                "$(f F1 ins:c1-eu-pendente-comrota)" "neg"
eq "C0 contador ANTES: 1 chamada por linha"                "$(Q base "SELECT _prova.chamadas('farmer_client_scores')")" "linhas=1,visivel_para=7,clientes_visiveis=0"

# Controle das sabotagens: banco com a migration REAL aplicada (verde) é a base de S1–S6.
copia base real
# ══════════════════════════════════════════════════════════════════════════════
echo "── apply da migration real ──"
# ══════════════════════════════════════════════════════════════════════════════
if aplica real "$MIG"; then ok "migration aplicou (marcador de fim presente)"; else bad "migration falhou:"; sed -n '1,40p' "$TMPD/apply-real.log"; fi
eq "NOTICE: 8 reescritas"  "$(grep -c 'carteira por conjunto: 8 policies reescritas, 0' "$TMPD/apply-real.log")" "1"

Q real "SELECT _prova.sondar('depois')" >/dev/null
A1_REAL=$(Q real "SELECT _prova.a1()")
eq "A1 CONJUNTO igual antes/depois ($TOTAL_SONDAS sondas: 15 chamadores × (7 SELECT + 29 INSERT))" "$A1_REAL" "verde"
A2_REAL=$(Q real "SELECT _prova.a2()")
eq "A2 cláusula ponto a ponto" "${A2_REAL%% (*}" "verde"
echo "     ${A2_REAL}"
A2_TT="${A2_REAL##*true/true=}"; A2_TT="${A2_TT%)}"
if [ "${A2_TT:-0}" -ge 50 ]; then ok "A2 não-vazia ($A2_TT pares TRUE dos dois lados)"; else bad "A2 vazia demais ($A2_TT)"; fi
eq "A3 catálogo" "$(Q real "SELECT _prova.a3()")" "verde"

PLANO=$(Pdb real -tA <<'SQL'
BEGIN;
SELECT set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000a2","role":"authenticated"}', true) IS NULL;
SET LOCAL ROLE authenticated;
EXPLAIN (COSTS OFF) SELECT rotulo FROM public.farmer_client_scores;
ROLLBACK;
SQL
)
if grep -q 'hashed SubPlan' <<<"$PLANO"; then ok "A4 plano tem hashed SubPlan"; else bad "A4 sem hashed SubPlan:"; printf '%s\n' "$PLANO"; fi
if grep -q 'carteira_visivel_para' <<<"$PLANO"; then bad "A4 plano ainda chama carteira_visivel_para"; else ok "A4 plano sem carteira_visivel_para"; fi
eq "A5 contador DEPOIS: 1 chamada por consulta" "$(Q real "SELECT _prova.chamadas('farmer_client_scores')")" "linhas=1,visivel_para=0,clientes_visiveis=1"
eq "A5 contador DEPOIS (carteira_assignments)" "$(Q real "SELECT _prova.chamadas('carteira_assignments')")" "linhas=1,visivel_para=0,clientes_visiveis=1"

# A6 — idempotência: 2º apply é no-op e o resultado não muda.
copia real idem
if aplica idem "$MIG"; then ok "A6 2º apply passou"; else bad "A6 2º apply falhou"; sed -n '1,20p' "$TMPD/apply-idem.log"; fi
eq "A6 NOTICE: 0 reescritas, 8 já novas" "$(grep -c 'carteira por conjunto: 0 policies reescritas, 8' "$TMPD/apply-idem.log")" "1"
Q idem "SELECT _prova.sondar('depois')" >/dev/null
eq "A6 A1 continua verde" "$(Q idem "SELECT _prova.a1()")" "verde"
eq "A6 A3 continua verde" "$(Q idem "SELECT _prova.a3()")" "verde"

# A7 — deriva: policy mudou desde o pré-voo → PRE e NADA aplicado (nem a função).
copia base deriva
Q deriva "ALTER POLICY rvis_select_carteira ON public.route_visits USING ((visited_by = ( SELECT auth.uid() AS uid)) OR private.carteira_visivel_para(customer_user_id, ( SELECT auth.uid() AS uid)))" >/dev/null
if aplica deriva "$MIG"; then bad "A7 aplicou sobre policy derivada"; else
  eq "A7 abortou no PRE" "$(grep -c 'PRE FALHOU: route_visits.rvis_select_carteira' "$TMPD/apply-deriva.log")" "1"
fi
eq "A7 nada aplicado (função ausente, 8 por linha)" \
   "$(Q deriva "SELECT (to_regprocedure('private.carteira_clientes_visiveis()') IS NULL AND to_regprocedure('private.carteira_ve_tudo()') IS NULL)::text || ',' || count(*) FROM pg_policy WHERE coalesce(pg_get_expr(polqual, polrelid),'') || coalesce(pg_get_expr(polwithcheck, polrelid),'') LIKE '%carteira_visivel_para%'")" \
   "true,8"

# A8 — plano genérico alternando usuário: o uid entra por InitPlan, o plano em cache não fixa ninguém.
A8=$(Pdb real -tAq <<'SQL'
SET plan_cache_mode = force_generic_plan;
SET ROLE authenticated;
PREPARE p AS SELECT coalesce(string_agg(rotulo, ',' ORDER BY rotulo), '-') FROM public.farmer_recommendations;
SELECT set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000a2"}', false) IS NULL; EXECUTE p;
SELECT set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000a5"}', false) IS NULL; EXECUTE p;
SELECT set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000a2"}', false) IS NULL; EXECUTE p;
SELECT set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000a6"}', false) IS NULL; EXECUTE p;
SELECT set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000a1"}', false) IS NULL; EXECUTE p;
SELECT set_config('request.jwt.claims', '', false) IS NULL; EXECUTE p;
SQL
)
eq "A8 plano genérico: F1, FC, F1, FX, M, nulo" "$(printf '%s' "$A8" | grep -v '^f$' | tr '\n' ' ')" "c1,c2,c3 c3 c1,c2,c3 - c1,c2,c3,c4,c5,c6,c7 - "
# A8b — o termo master SEM cap para mascará-lo (carteira_assignments): M, F1, nulo, M.
A8B=$(Pdb real -tAq <<'SQL'
SET plan_cache_mode = force_generic_plan;
SET ROLE authenticated;
PREPARE q AS SELECT coalesce(string_agg(rotulo, ',' ORDER BY rotulo), '-') FROM public.carteira_assignments;
SELECT set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000a1"}', false) IS NULL; EXECUTE q;
SELECT set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000a2"}', false) IS NULL; EXECUTE q;
SELECT set_config('request.jwt.claims', '', false) IS NULL; EXECUTE q;
SELECT set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000a1"}', false) IS NULL; EXECUTE q;
SQL
)
eq "A8b plano genérico sem cap: M, F1, nulo, M" "$(printf '%s' "$A8B" | grep -v '^f$' | tr '\n' ' ')" "c1,c2,c3,c4,c5,c6 c1 - c1,c2,c3,c4,c5,c6 "

# A9 — lock_timeout: um leitor segurando farmer_calls → 55P03, nada aplicado.
copia base trava
"$PGBIN/psql" -X -p "$PORT" -h /tmp -U postgres -d trava -q \
  -c "BEGIN; LOCK TABLE public.farmer_calls IN ACCESS SHARE MODE; SELECT pg_sleep(30); COMMIT;" >/dev/null 2>&1 &
BG=$!
for _ in $(seq 1 50); do
  [ "$(Q trava "SELECT count(*) FROM pg_locks l JOIN pg_class c ON c.oid = l.relation WHERE c.relname = 'farmer_calls' AND l.granted AND l.pid <> pg_backend_pid()")" -ge 1 ] && break
  sleep 0.1
done
if aplica trava "$MIG"; then bad "A9 aplicou com a tabela travada"; else
  eq "A9 lock_timeout (55P03)" "$(grep -c '55P03' "$TMPD/apply-trava.log")" "1"
fi
Q trava "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = 'trava' AND pid <> pg_backend_pid()" >/dev/null
wait "$BG" 2>/dev/null || true
eq "A9 nada aplicado" "$(Q trava "SELECT (to_regprocedure('private.carteira_clientes_visiveis()') IS NULL)::text")" "true"

# ══════════════════════════════════════════════════════════════════════════════
echo "── FALSIFICAÇÃO: os asserts têm dente (controle verde acima, mesma invocação) ──"
# ══════════════════════════════════════════════════════════════════════════════
[ "$A1_REAL" = "verde" ] || { bad "controle A1 não está verde — falsificação não vale"; }
# Corpo da função de conjunto, com um trecho trocado (a sabotagem precisa MUDAR o texto).
sabota_funcao() {
  local db="$1" de="$2" para="$3"
  local corpo; corpo=$(Q "$db" "SELECT pg_get_functiondef('private.carteira_clientes_visiveis()'::regprocedure)")
  local novo; novo=$(printf '%s' "$corpo" | DE="$de" PARA="$para" perl -0777 -pe 's/\Q$ENV{DE}\E/$ENV{PARA}/')
  [ "$novo" != "$corpo" ] || { echo "sabotagem não mudou o corpo ($de)"; exit 1; }
  printf '%s;\n' "$novo" | Pdb "$db" -q >/dev/null
}
resonda() { Q "$1" "SELECT _prova.sondar('depois')" >/dev/null; }

copia real s1; sabota_funcao s1 "AND a.eligible IS TRUE
  UNION" "UNION"; resonda s1
morde "S1 conjunto sem eligible (dono) → A1" "$(Q s1 "SELECT _prova.a1()")" "verde"

copia real s2; sabota_funcao s2 "(c.valid_until IS NULL OR c.valid_until > now())" "true"; resonda s2
morde "S2 cobertura sem validade → A1" "$(Q s2 "SELECT _prova.a1()")" "verde"

copia real s3
Q s3 "ALTER POLICY \"View carteira por visibilidade\" ON public.carteira_assignments USING (customer_user_id IN ( SELECT private.carteira_clientes_visiveis() AS carteira_clientes_visiveis))" >/dev/null
resonda s3
morde "S3 sem o termo master → A1" "$(Q s3 "SELECT _prova.a1()")" "verde"
A2_S3=$(Q s3 "SELECT _prova.a2()")
morde "S3 sem o termo master → A2" "${A2_S3%% (*}" "verde"

copia real s4
Q s4 "ALTER POLICY vag_insert_own_carteira ON public.visitas_agendadas WITH CHECK (((scheduled_by = ( SELECT auth.uid() AS uid)) AND ( SELECT private.carteira_ve_tudo() AS carteira_ve_tudo) AND (status = 'pendente'::text) AND (route_visit_id IS NULL)))" >/dev/null
resonda s4
S4=$(Q s4 "SELECT _prova.a1()")
morde "S4 WITH CHECK sem o conjunto → A1" "$S4" "verde"
if grep -q 'F1/ins:c1-eu-pendente ok' <<<"$S4"; then ok "S4 vermelho CERTO (F1 perdeu o INSERT de c1)"; else bad "S4 vermelho por outro motivo: $S4"; fi

copia real s5
Q s5 "GRANT EXECUTE ON FUNCTION private.carteira_clientes_visiveis() TO anon" >/dev/null
morde "S5 EXECUTE para anon → A3" "$(Q s5 "SELECT _prova.a3()")" "verde"

copia real s6
Q s6 "ALTER POLICY fcs_select_carteira ON public.farmer_client_scores USING ((( SELECT private.cap_carteira_ler(( SELECT auth.uid() AS uid)) AS cap_carteira_ler) OR private.carteira_visivel_para(customer_user_id, ( SELECT auth.uid() AS uid))))" >/dev/null
morde "S6 policy por linha → A5" "$(Q s6 "SELECT _prova.chamadas('farmer_client_scores')")" "linhas=1,visivel_para=0,clientes_visiveis=1"
PLANO6=$(Pdb s6 -tA <<'SQL'
BEGIN;
SELECT set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000a2","role":"authenticated"}', true) IS NULL;
SET LOCAL ROLE authenticated;
EXPLAIN (COSTS OFF) SELECT rotulo FROM public.farmer_client_scores;
ROLLBACK;
SQL
)
morde "S6 policy por linha → A4" "$(printf '%s' "$PLANO6" | grep -c 'carteira_visivel_para' || true)" "0"

# Camada 2: as pós-condições da PRÓPRIA migration (arquivo sabotado, banco base).
# Controle: a cópia INTACTA pelo mesmo caminho aplica (verde) — senão a sabotagem não prova nada.
cp "$MIG" "$TMPD/mig-controle.sql"
copia base m0
if aplica m0 "$TMPD/mig-controle.sql"; then ok "M0 controle: cópia intacta aplica"; else bad "M0 controle falhou"; fi
sabota_arquivo() {
  local nome="$1" de="$2" para="$3"
  local alvo="$TMPD/mig-$nome.sql"
  DE="$de" PARA="$para" awk 'BEGIN{de=ENVIRON["DE"]; para=ENVIRON["PARA"]} { i=index($0, de); if (i>0 && !feito) { $0=substr($0,1,i-1) para substr($0,i+length(de)); feito=1 } print }' "$MIG" > "$alvo"
  cmp -s "$MIG" "$alvo" && { echo "sabotagem $nome não mudou o arquivo"; exit 1; }
  copia base "$nome"
  if aplica "$nome" "$alvo"; then echo "APLICOU"; else echo "ABORTOU"; fi
}
R=$(sabota_arquivo m1 "REVOKE ALL ON FUNCTION private.carteira_ve_tudo(), private.carteira_clientes_visiveis() FROM PUBLIC;" "SELECT 1;")
eq "M1 sem REVOKE PUBLIC → migration aborta" "$R" "ABORTOU"
eq "M1 vermelho certo (P7)" "$(grep -c 'P7 FALHOU' "$TMPD/apply-m1.log")" "1"
R=$(sabota_arquivo m2 "( SELECT private.carteira_ve_tudo() AS carteira_ve_tudo)" "( SELECT private.carteira_ve_tudo())")
eq "M2 termo fora da forma do PG → migration aborta" "$R" "ABORTOU"
eq "M2 vermelho certo (P3)" "$(grep -c 'P3 FALHOU' "$TMPD/apply-m2.log")" "1"
R=$(sabota_arquivo m3 "SET LOCAL lock_timeout = '500ms';" "SET TRANSACTION ISOLATION LEVEL REPEATABLE READ; SET LOCAL lock_timeout = '500ms';")
eq "M3 REPEATABLE READ → migration aborta" "$R" "ABORTOU"
eq "M3 vermelho certo (P0)" "$(grep -c 'P0 FALHOU' "$TMPD/apply-m3.log")" "1"

# S7 — o hash: com a estimativa da SRF inflada, o planejador desiste do hashed SubPlan.
HASH_REAL=$(printf '%s' "$PLANO" | grep -c 'hashed SubPlan' || true)
copia real s7
Q s7 "ALTER FUNCTION private.carteira_clientes_visiveis() ROWS 1000000000" >/dev/null
PLANO7=$(Pdb s7 -tA <<'SQL'
BEGIN;
SELECT set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000a2","role":"authenticated"}', true) IS NULL;
SET LOCAL ROLE authenticated;
EXPLAIN (COSTS OFF) SELECT rotulo FROM public.farmer_client_scores;
ROLLBACK;
SQL
)
morde "S7 SubPlan sem hash → A4" "$(printf '%s' "$PLANO7" | grep -c 'hashed SubPlan' || true)" "$HASH_REAL"

# M4 — o corpo vivo da ANTIGA mudou (policies intactas): a regra copiada divergiria → PRE.
copia base m4
Q m4 "CREATE OR REPLACE FUNCTION private.carteira_visivel_para(_customer_user_id uuid, _uid uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS \$function\$ SELECT false \$function\$" >/dev/null
if aplica m4 "$MIG"; then R=APLICOU; else R=ABORTOU; fi
eq "M4 antiga endurecida → migration aborta" "$R" "ABORTOU"
eq "M4 vermelho certo (PRE do corpo vivo)" "$(grep -c 'PRE FALHOU: o corpo vivo de private.carteira_visivel_para' "$TMPD/apply-m4.log")" "1"

# M5 — a função nova já existe com OUTRO corpo: não sobrescreve.
copia base m5
Q m5 "CREATE FUNCTION private.carteira_clientes_visiveis() RETURNS SETOF uuid LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS \$function\$ SELECT NULL::uuid WHERE false \$function\$" >/dev/null
if aplica m5 "$MIG"; then R=APLICOU; else R=ABORTOU; fi
eq "M5 nova com outro corpo → migration aborta" "$R" "ABORTOU"
eq "M5 vermelho certo (PRE da nova)" "$(grep -c 'PRE FALHOU: private.carteira_clientes_visiveis()' "$TMPD/apply-m5.log")" "1"

# M6 — reapply sobre ACL com GRANT OPTION (delegável): P7 compara is_grantable.
copia real m6
Q m6 "GRANT EXECUTE ON FUNCTION private.carteira_ve_tudo() TO authenticated WITH GRANT OPTION" >/dev/null
if aplica m6 "$MIG"; then R=APLICOU; else R=ABORTOU; fi
eq "M6 grant option → reapply aborta" "$R" "ABORTOU"
eq "M6 vermelho certo (P7 ACL)" "$(grep -c 'P7 FALHOU: ACL de EXECUTE de private.carteira_ve_tudo()' "$TMPD/apply-m6.log")" "1"

# M7 — orçamento: atraso sem contenção de lock (0,5 s por policy) → P8.
R=$(sabota_arquivo m7 "    n_alter := n_alter + 1;" "    n_alter := n_alter + 1; PERFORM pg_sleep(0.5);")
eq "M7 atraso → migration aborta" "$R" "ABORTOU"
eq "M7 vermelho certo (P8)" "$(grep -c 'P8 FALHOU' "$TMPD/apply-m7.log")" "1"

# M8 — P9 tem dente: a reconferência final com um md5 que não bate aborta (não é decoração).
R=$(sabota_arquivo m8 "'private.carteira_ve_tudo()'::regprocedure) <> '133d950a" "'private.carteira_ve_tudo()'::regprocedure) <> '033d950a")
eq "M8 P9 com md5 trocado → migration aborta" "$R" "ABORTOU"
eq "M8 vermelho certo (P9)" "$(grep -c 'P9 FALHOU' "$TMPD/apply-m8.log")" "1"

echo "──────────────────────────────"
echo "Sabotagens S1-S7: $VERM vermelhas / $FALHAS_S sem dente"
echo "RESULTADO: $PASS ok / $FAIL fail (locale $LOC)"
[ "$FAIL" = "0" ] || { echo "❌ HARNESS VERMELHO"; exit 1; }
echo "PROVA-RLS-CARTEIRA-CONJUNTO-OK"
