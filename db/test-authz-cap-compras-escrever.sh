#!/usr/bin/env bash
# ╔══════════════════════════════════════════════════════════════════════════════════╗
# ║  HARNESS PG17 — FU4-E: capability de ESCRITA em compras                           ║
# ║   bash db/test-authz-cap-compras-escrever.sh > "$SCRATCH/t.log" 2>&1; echo $?     ║
# ║                                                                                    ║
# ║  Aplica a migration REAL 20260719120000_authz_cap_compras_escrever_fu4e.sql e     ║
# ║  prova que as 3 RPCs de escrita em compras passaram do gate `gerencial` para      ║
# ║  `private.cap_compras_escrever` (master-only) SEM mudar comportamento algum.      ║
# ║                                                                                    ║
# ║  Lei #1: plpgsql é late-bound — as RPCs são CHAMADAS de verdade e o EFEITO no     ║
# ║  dado é conferido. "Criou sem erro" não prova nada.                               ║
# ║  Lei #2: assert negativo captura a SQLSTATE esperada (P0001) e RE-LANÇA o resto.  ║
# ║  Lei #3: ZONA 5 sabota de propósito e EXIGE vermelho.                             ║
# ║                                                                                    ║
# ║  Os stubs ESPELHAM PROD (medido via psql-ro 2026-07-19), não o design:            ║
# ║  `sku_parametros.sku_codigo_omie` é bigint enquanto o log é text (daí o ::text    ║
# ║  do código); `param_pin` tem PK COMPOSTA (empresa, sku) — é ela que serve o       ║
# ║  ON CONFLICT; `param_auto_log.run_id` é NOT NULL com FK para param_auto_run.      ║
# ╚══════════════════════════════════════════════════════════════════════════════════╝
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PGVER=17
PGBIN="/opt/homebrew/opt/postgresql@${PGVER}/bin"
PORT="${PGPORT_TEST:-5487}"
SLUG="capcompras"
DATA="$(mktemp -d "/tmp/pgtest-${SLUG}.XXXXXX")/data"
MIG="$REPO_ROOT/supabase/migrations/20260719120000_authz_cap_compras_escrever_fu4e.sql"
export LC_ALL=C LANG=C

[ -x "$PGBIN/initdb" ] || { echo "postgresql@${PGVER} ausente: brew install postgresql@${PGVER}"; exit 1; }
[ -f "$MIG" ] || { echo "migration nao encontrada: $MIG"; exit 1; }

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

MASTER="10000000-0000-0000-0000-000000000001"
GERENCIAL="20000000-0000-0000-0000-000000000002"
FARMER="40000000-0000-0000-0000-000000000004"
EMPL_SEM_CR="50000000-0000-0000-0000-000000000005"   # employee SEM linha em commercial_roles (o TRI-STATE)

# ═══════════════════════════════════════════════════════════════════════════════════
# ZONA 1 — PRÉ-REQUISITOS (stubs espelhando PROD, medido 2026-07-19)
# ═══════════════════════════════════════════════════════════════════════════════════
echo "── ZONA 1: pré-requisitos ──"
P -q <<'SQL'
CREATE SCHEMA IF NOT EXISTS private;
GRANT USAGE ON SCHEMA private TO authenticated, anon, service_role;
GRANT USAGE ON SCHEMA auth    TO authenticated, anon, service_role;

CREATE TYPE public.app_role        AS ENUM ('customer','employee','master','admin');
CREATE TYPE public.commercial_role AS ENUM ('operacional','gerencial','estrategico','super_admin','farmer','hunter','closer','master');

CREATE TABLE public.user_roles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL, role public.app_role NOT NULL
);
CREATE TABLE public.commercial_roles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL UNIQUE,
  commercial_role public.commercial_role NOT NULL
);

-- has_role: cópia verbatim de prod (pg_get_functiondef)
CREATE OR REPLACE FUNCTION public.has_role(_user_id uuid, _role public.app_role)
 RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $f$ SELECT EXISTS (SELECT 1 FROM public.user_roles WHERE user_id = _user_id AND role = _role) $f$;

-- get_commercial_role: cópia verbatim de prod (pg_get_functiondef). É a fonte do TRI-STATE —
-- sem linha em commercial_roles, a subquery escalar devolve NULL (não false).
CREATE OR REPLACE FUNCTION public.get_commercial_role(_user_id uuid)
 RETURNS public.commercial_role LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $f$
  SELECT commercial_role
  FROM public.commercial_roles
  WHERE user_id = _user_id
  LIMIT 1
$f$;

-- O gate ANTIGO precisa existir: é o que a migration procura e troca.
-- Em PROD ele vive nas DUAS formas (impl em private pelo #1427 + wrapper em public); as 3 RPCs
-- alvo chamam a de `public`, então é essa que o stub precisa ter para o regex casar.
--
-- ⚠️ TRI-STATE — `get_commercial_role(...) IN (...)`, VERBATIM de prod, e NÃO um `EXISTS(...)`.
-- A distinção é a razão de ser deste harness. Para um `employee` SEM linha em commercial_roles:
--   ·  com get_commercial_role:  false OR (true AND (NULL IN (...)))  =  false OR NULL  =  NULL
--   ·  com EXISTS (o que estava aqui): false OR (true AND false)      =  false
-- As 3 RPCs alvo gateiam com `IF NOT gate(...)`, e `NOT NULL` = NULL ⇒ o IF NÃO ENTRA e a
-- SECURITY DEFINER ESCREVE. Esse era o bypass real que o FU4-E fechou. Com o EXISTS o stub
-- devolvia `false`, o `NOT false` negava, e o harness ficava CEGO para o bypass que existe
-- justamente para provar. Trocar de volta reabre o ponto cego (a falsificação F5 exige vermelho).
CREATE OR REPLACE FUNCTION public.pode_ver_carteira_completa(_uid uuid)
 RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $f$
  SELECT public.has_role(_uid,'master'::public.app_role)
      OR (public.has_role(_uid,'employee'::public.app_role)
          AND public.get_commercial_role(_uid) IN (
            'gerencial'::public.commercial_role,
            'estrategico'::public.commercial_role,
            'super_admin'::public.commercial_role
          ));
$f$;
GRANT EXECUTE ON FUNCTION public.pode_ver_carteira_completa(uuid) TO authenticated, service_role;

-- ── tabelas de compras (colunas/constraints ESPELHANDO prod) ──
CREATE TABLE public.reposicao_param_auto_run (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  empresa text NOT NULL,
  data_negocio_brt date NOT NULL,
  status text NOT NULL DEFAULT 'rodando',
  criado_em timestamptz NOT NULL DEFAULT now()
);

-- ⚠️ sku_codigo_omie é TEXT aqui e BIGINT em sku_parametros (medido) — a assimetria é real e é
-- por isso que o código faz `sp.sku_codigo_omie::text = r.sku_codigo_omie`. Igualar os tipos no
-- stub deixaria o harness verde provando um mundo que não existe.
CREATE TABLE public.reposicao_param_auto_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id uuid NOT NULL REFERENCES public.reposicao_param_auto_run(id),
  empresa text NOT NULL,
  sku_codigo_omie text NOT NULL,
  status text NOT NULL CHECK (status = ANY (ARRAY['aplicado','segurado','pinado','bloqueado_validacao'])),
  ponto_pedido_antes numeric,       ponto_pedido_depois numeric,
  estoque_minimo_antes numeric,     estoque_minimo_depois numeric,
  estoque_maximo_antes numeric,     estoque_maximo_depois numeric,
  estoque_seguranca_antes numeric,  estoque_seguranca_depois numeric,
  cobertura_antes numeric,          cobertura_depois numeric,
  revertido_em timestamptz, revertido_por uuid,
  criado_em timestamptz NOT NULL DEFAULT now()
);

-- PK COMPOSTA (não UNIQUE avulso) — é ela que serve o ON CONFLICT (empresa, sku_codigo_omie).
CREATE TABLE public.reposicao_param_pin (
  empresa text NOT NULL,
  sku_codigo_omie text NOT NULL,
  ponto_pedido_rejeitado numeric NOT NULL,
  estoque_maximo_rejeitado numeric NOT NULL,
  pinado_em timestamptz NOT NULL DEFAULT now(),
  pinado_por uuid,
  PRIMARY KEY (empresa, sku_codigo_omie)
);

CREATE TABLE public.sku_parametros (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  empresa text NOT NULL,
  sku_codigo_omie bigint NOT NULL,
  ponto_pedido numeric, estoque_minimo numeric, estoque_maximo numeric,
  estoque_seguranca numeric, cobertura_alvo_dias integer,
  ultima_atualizacao_calculo timestamptz,
  UNIQUE (empresa, sku_codigo_omie)
);

-- ── as 3 RPCs alvo: corpo VERBATIM de prod (pg_get_functiondef, psql-ro 2026-07-19) ──
-- É o corpo real que a migration vai reescrever. Um stub "equivalente mas reescrito" provaria
-- que o regex casa no texto que EU escrevi, não no que existe em produção.
CREATE OR REPLACE FUNCTION public.despinar_parametro(p_empresa text, p_sku text)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  IF NOT public.pode_ver_carteira_completa(auth.uid()) THEN RAISE EXCEPTION 'sem permissão'; END IF;
  DELETE FROM public.reposicao_param_pin WHERE empresa=p_empresa AND sku_codigo_omie=p_sku;
  RETURN FOUND;
END;
$function$;

CREATE OR REPLACE FUNCTION public.reverter_parametro_auto(p_log_id uuid)
 RETURNS text
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE r record; v_uid uuid := auth.uid();
BEGIN
  IF NOT public.pode_ver_carteira_completa(v_uid) THEN RAISE EXCEPTION 'sem permissão'; END IF;
  SELECT * INTO r FROM public.reposicao_param_auto_log
    WHERE id=p_log_id AND status='aplicado' AND revertido_em IS NULL;
  IF NOT FOUND THEN RETURN 'nao_encontrado'; END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.sku_parametros sp
    WHERE sp.empresa=r.empresa AND sp.sku_codigo_omie::text=r.sku_codigo_omie
      AND round(COALESCE(sp.ponto_pedido,-1))      = round(COALESCE(r.ponto_pedido_depois,-1))
      AND round(COALESCE(sp.estoque_maximo,-1))    = round(COALESCE(r.estoque_maximo_depois,-1))
      AND round(COALESCE(sp.estoque_minimo,-1))    = round(COALESCE(r.estoque_minimo_depois,-1))
      AND round(COALESCE(sp.estoque_seguranca,-1)) = round(COALESCE(r.estoque_seguranca_depois,-1))
      AND round(COALESCE(sp.cobertura_alvo_dias,-1))= round(COALESCE(r.cobertura_depois,-1))
  ) THEN RETURN 'conflito'; END IF;
  UPDATE public.sku_parametros sp SET
    ponto_pedido=r.ponto_pedido_antes, estoque_minimo=r.estoque_minimo_antes,
    estoque_maximo=r.estoque_maximo_antes, estoque_seguranca=r.estoque_seguranca_antes,
    cobertura_alvo_dias=r.cobertura_antes, ultima_atualizacao_calculo=now()
  WHERE sp.empresa=r.empresa AND sp.sku_codigo_omie::text=r.sku_codigo_omie;
  INSERT INTO public.reposicao_param_pin (empresa, sku_codigo_omie, ponto_pedido_rejeitado, estoque_maximo_rejeitado, pinado_por)
    VALUES (r.empresa, r.sku_codigo_omie, round(r.ponto_pedido_depois), round(r.estoque_maximo_depois), v_uid)
    ON CONFLICT (empresa, sku_codigo_omie) DO UPDATE
      SET ponto_pedido_rejeitado=excluded.ponto_pedido_rejeitado,
          estoque_maximo_rejeitado=excluded.estoque_maximo_rejeitado, pinado_em=now(), pinado_por=v_uid;
  UPDATE public.reposicao_param_auto_log SET revertido_em=now(), revertido_por=v_uid WHERE id=p_log_id;
  RETURN 'revertido';
END;
$function$;

CREATE OR REPLACE FUNCTION public.reverter_run_auto(p_run_id uuid)
 RETURNS TABLE(revertidos integer, conflitos integer)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE r record; v_rev int := 0; v_conf int := 0; res text;
BEGIN
  IF NOT public.pode_ver_carteira_completa(auth.uid()) THEN RAISE EXCEPTION 'sem permissão'; END IF;
  FOR r IN SELECT id FROM public.reposicao_param_auto_log
           WHERE run_id=p_run_id AND status='aplicado' AND revertido_em IS NULL LOOP
    res := public.reverter_parametro_auto(r.id);
    IF res='revertido' THEN v_rev := v_rev+1; ELSIF res='conflito' THEN v_conf := v_conf+1; END IF;
  END LOOP;
  revertidos := v_rev; conflitos := v_conf; RETURN NEXT;
END;
$function$;

GRANT EXECUTE ON FUNCTION public.despinar_parametro(text,text)  TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.reverter_parametro_auto(uuid)  TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.reverter_run_auto(uuid)        TO authenticated, service_role;
SQL
echo "  pré-requisitos criados"

# guard do próprio stub: o corpo tem de conter o gate ANTIGO, senão a migration não teria o que
# trocar e TODA a prova seria vacuosa (verde por ausência de trabalho).
eq "S1 stub das 3 RPCs nasce com o gate ANTIGO" \
   "$(Pq -c "SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
             WHERE n.nspname='public' AND p.proname IN ('despinar_parametro','reverter_parametro_auto','reverter_run_auto')
               AND pg_get_functiondef(p.oid) ~ 'public\.pode_ver_carteira_completa\s*\(';")" "3"

# ═══════════════════════════════════════════════════════════════════════════════════
# ZONA 2 — APLICAR A MIGRATION REAL (Lei #1)
# ═══════════════════════════════════════════════════════════════════════════════════
echo "── ZONA 2: aplicar migration real ──"

# AUTONOMIA (a propriedade que sustenta a decisão de estrutura do spec §3): a migration tem de
# aplicar SEM `private.cap_compras_ler` existir. Se um dia alguém a fizer depender do #1434,
# este assert fica vermelho.
eq "A0 cap_compras_ler NÃO existe neste banco (prova a autonomia)" \
   "$(Pq -c "SELECT to_regprocedure('private.cap_compras_ler(uuid)') IS NULL;")" "t"

P -q -f "$MIG"
echo "  migration aplicada: $(basename "$MIG")"

# IDEMPOTÊNCIA: o dono cola à mão; uma queda de rede no meio não pode travar a 2ª tentativa.
# Na 2ª passada o padrão de busca já não existe — o bloco tem de seguir pelo CONTINUE, não abortar.
if P -q -f "$MIG" >/dev/null 2>&1; then
  ok "P0a migration é IDEMPOTENTE (2ª aplicação passa)"
else
  bad "P0a re-aplicar a migration falhou — não é idempotente"
fi
eq "P0b as 3 RPCs seguem com o gate novo após re-aplicar" \
   "$(Pq -c "SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
             WHERE n.nspname='public' AND p.proname IN ('despinar_parametro','reverter_parametro_auto','reverter_run_auto')
               AND pg_get_functiondef(p.oid) ~ 'private\.cap_compras_escrever\s*\(';")" "3"

# ═══════════════════════════════════════════════════════════════════════════════════
# ZONA 3 — SEEDS
# ═══════════════════════════════════════════════════════════════════════════════════
echo "── ZONA 3: seeds ──"
P -q <<SQL
INSERT INTO public.user_roles(user_id,role) VALUES
  ('$MASTER','master'), ('$GERENCIAL','employee'), ('$FARMER','employee'), ('$EMPL_SEM_CR','employee');
INSERT INTO public.commercial_roles(user_id,commercial_role) VALUES
  ('$GERENCIAL','gerencial'), ('$FARMER','farmer');
-- EMPL_SEM_CR fica SEM linha de propósito: é o que faz o gate ANTIGO devolver NULL.
SQL
echo "  seeds inseridos"

# ── sanidade do STUB: ele reproduz mesmo o tri-state de prod? ──
# Sem isto, uma regressão silenciosa do stub para `EXISTS(...)` (bi-state) deixaria o harness
# verde e CEGO — foi exatamente o defeito que este arquivo teve até 2026-07-20.
eq "T1 gate ANTIGO é TRI-STATE: employee sem commercial_role ⇒ NULL (não false)" \
   "$(Pq -c "SELECT public.pode_ver_carteira_completa('$EMPL_SEM_CR') IS NULL;")" "t"
eq "T1b ...e o mesmo gate devolve false (não NULL) p/ quem tem papel comercial comum" \
   "$(Pq -c "SELECT public.pode_ver_carteira_completa('$FARMER') IS FALSE;")" "t"
eq "T1c ...e true para gerencial (o tri-state não quebrou o caminho positivo)" \
   "$(Pq -c "SELECT public.pode_ver_carteira_completa('$GERENCIAL') IS TRUE;")" "t"
# a capability NOVA nunca devolve NULL — é o que torna `IF NOT cap(...)` seguro nas 3 RPCs.
eq "T2 capability NOVA é BI-STATE p/ o mesmo uid (COALESCE ⇒ false, nunca NULL)" \
   "$(Pq -c "SELECT private.cap_compras_escrever('$EMPL_SEM_CR') IS FALSE;")" "t"

# helper: roda SQL como `authenticated` com um uid.
# ⚠️ `SET` e NÃO `SET LOCAL`: cada invocação do psql é sessão nova em autocommit, onde SET LOCAL
# não pega — e sem o SET ROLE o assert rodaria como `postgres`, que bypassa RLS e pinta tudo de
# verde falsamente.
as_user() { # $1=uid  $2=sql
  P -tA -q <<SQL
SET test.uid = '$1';
SET ROLE authenticated;
$2
SQL
}
# sanidade do próprio harness: se o SET ROLE não pegar, TODO assert é teatro.
GUARD=$(as_user "$MASTER" "SELECT current_user;")
[ "$GUARD" = "authenticated" ] || { echo "❌ HARNESS INVÁLIDO: SET ROLE não pegou (current_user=$GUARD)"; exit 1; }
echo "  guard: asserts rodam como '$GUARD' (não superuser) ✅"

# re-semeia o cenário de reversão (chamado antes de cada teste que consome estado)
seed_cenario() {
  P -q <<SQL
DELETE FROM public.reposicao_param_auto_log;
DELETE FROM public.reposicao_param_auto_run;
DELETE FROM public.reposicao_param_pin;
DELETE FROM public.sku_parametros;

INSERT INTO public.reposicao_param_auto_run(id, empresa, data_negocio_brt)
  VALUES ('99999999-0000-0000-0000-00000000aaaa','oben', CURRENT_DATE);
-- sku_parametros com os valores "DEPOIS" (é o que o código exige para não retornar 'conflito')
INSERT INTO public.sku_parametros(empresa, sku_codigo_omie, ponto_pedido, estoque_minimo,
                                  estoque_maximo, estoque_seguranca, cobertura_alvo_dias)
  VALUES ('oben', 7001, 200, 60, 500, 30, 21);
INSERT INTO public.reposicao_param_auto_log(id, run_id, empresa, sku_codigo_omie, status,
    ponto_pedido_antes, ponto_pedido_depois, estoque_minimo_antes, estoque_minimo_depois,
    estoque_maximo_antes, estoque_maximo_depois, estoque_seguranca_antes, estoque_seguranca_depois,
    cobertura_antes, cobertura_depois)
  VALUES ('99999999-0000-0000-0000-00000000bbbb','99999999-0000-0000-0000-00000000aaaa',
          'oben','7001','aplicado', 100, 200, 50, 60, 400, 500, 25, 30, 14, 21);
-- pin independente, alvo do despinar_parametro
INSERT INTO public.reposicao_param_pin(empresa, sku_codigo_omie, ponto_pedido_rejeitado, estoque_maximo_rejeitado)
  VALUES ('oben','9002', 111, 222);
SQL
}
LOG_ID="99999999-0000-0000-0000-00000000bbbb"
RUN_ID="99999999-0000-0000-0000-00000000aaaa"

# helper: chama uma RPC e ecoa OK/DENIED/ERRO. O negativo é classificado pela SQLSTATE (P0001,
# o RAISE EXCEPTION sem errcode das 3), NUNCA pelo texto da mensagem — casar 'sem permissão'
# seria teatro de ILIKE: a sentinela do teste não pode conter o texto que o código emite.
call_rpc() { # $1=uid $2=sql
  local out
  if out=$(P -tA -q <<SQL 2>&1
SET test.uid = '$1';
SET ROLE authenticated;
DO \$\$ BEGIN
  PERFORM $2;
EXCEPTION
  WHEN raise_exception THEN RAISE NOTICE 'SENTINELA_NEGOU_P0001';
  WHEN OTHERS THEN RAISE;
END \$\$;
SQL
  ); then
    case "$out" in
      *SENTINELA_NEGOU_P0001*) echo "DENIED" ;;
      *) echo "OK" ;;
    esac
  else
    echo "ERRO_INESPERADO: $out"
  fi
}

# ═══════════════════════════════════════════════════════════════════════════════════
# ZONA 4 — ASSERTS
# ═══════════════════════════════════════════════════════════════════════════════════
echo ""
echo "── ZONA 4a: o furo que o FU4-E fecha (gerencial PERDE a escrita) ──"

seed_cenario
eq "N1 gerencial NÃO despina parâmetro" \
   "$(call_rpc "$GERENCIAL" "public.despinar_parametro('oben','9002')")" "DENIED"
eq "N1e ...e o pin CONTINUA lá (efeito no dado, não só a exceção)" \
   "$(Pq -c "SELECT count(*) FROM public.reposicao_param_pin WHERE empresa='oben' AND sku_codigo_omie='9002';")" "1"

eq "N2 gerencial NÃO reverte parâmetro" \
   "$(call_rpc "$GERENCIAL" "public.reverter_parametro_auto('$LOG_ID')")" "DENIED"
eq "N2e ...e o log segue NÃO revertido" \
   "$(Pq -c "SELECT count(*) FROM public.reposicao_param_auto_log WHERE id='$LOG_ID' AND revertido_em IS NULL;")" "1"
eq "N2p ...e sku_parametros segue no valor DEPOIS (nada foi revertido)" \
   "$(Pq -c "SELECT ponto_pedido::int FROM public.sku_parametros WHERE empresa='oben' AND sku_codigo_omie=7001;")" "200"

eq "N3 gerencial NÃO reverte run inteiro" \
   "$(call_rpc "$GERENCIAL" "public.reverter_run_auto('$RUN_ID')")" "DENIED"

echo "── ZONA 4b: farmer (papel comercial comum) também negado ──"
eq "N4 farmer NÃO despina"        "$(call_rpc "$FARMER" "public.despinar_parametro('oben','9002')")" "DENIED"
eq "N5 farmer NÃO reverte run"    "$(call_rpc "$FARMER" "public.reverter_run_auto('$RUN_ID')")"      "DENIED"

echo "── ZONA 4b2: o BYPASS TRI-STATE que o FU4-E fechou (employee sem commercial_role) ──"
# No gate ANTIGO este uid produzia NULL, `NOT NULL` = NULL, o IF não entrava e a escrita PASSAVA.
# Sob o gate NOVO (COALESCE ⇒ false) ele é negado. A falsificação F5 prova que este par de asserts
# tem dente: com o corpo antigo restaurado, o mesmo uid volta a ESCREVER.
seed_cenario
eq "N7 employee sem commercial_role NÃO despina (tri-state fechado)" \
   "$(call_rpc "$EMPL_SEM_CR" "public.despinar_parametro('oben','9002')")" "DENIED"
eq "N7e ...e o pin CONTINUA lá (efeito no dado)" \
   "$(Pq -c "SELECT count(*) FROM public.reposicao_param_pin WHERE empresa='oben' AND sku_codigo_omie='9002';")" "1"
eq "N8 employee sem commercial_role NÃO reverte run" \
   "$(call_rpc "$EMPL_SEM_CR" "public.reverter_run_auto('$RUN_ID')")" "DENIED"
eq "N8e ...e o log segue NÃO revertido" \
   "$(Pq -c "SELECT count(*) FROM public.reposicao_param_auto_log WHERE id='$LOG_ID' AND revertido_em IS NULL;")" "1"

echo "── ZONA 4c: anônimo (uid NULO) negado — fail-closed ──"
eq "N6 uid NULO não despina" \
   "$(P -tA -q <<'SQL' 2>&1 | grep -c SENTINELA_NEGOU || true
SET ROLE authenticated;
DO $$ BEGIN
  PERFORM public.despinar_parametro('oben','9002');
EXCEPTION WHEN raise_exception THEN RAISE NOTICE 'SENTINELA_NEGOU';
          WHEN OTHERS THEN RAISE;
END $$;
SQL
)" "1"
eq "N6b cap_compras_escrever(NULL) é FALSE (não NULL)" \
   "$(Pq -c "SELECT private.cap_compras_escrever(NULL) IS FALSE;")" "t"

echo "── ZONA 4d: master preserva TUDO (ninguém perdeu acesso) ──"
seed_cenario
eq "M1 master despina (retorna true)" \
   "$(as_user "$MASTER" "SELECT public.despinar_parametro('oben','9002');")" "t"
eq "M1e ...e o pin SUMIU (efeito real)" \
   "$(Pq -c "SELECT count(*) FROM public.reposicao_param_pin WHERE empresa='oben' AND sku_codigo_omie='9002';")" "0"

seed_cenario
eq "M2 master reverte parâmetro (retorna 'revertido')" \
   "$(as_user "$MASTER" "SELECT public.reverter_parametro_auto('$LOG_ID');")" "revertido"
eq "M2e ...e sku_parametros voltou ao valor ANTES" \
   "$(Pq -c "SELECT ponto_pedido::int FROM public.sku_parametros WHERE empresa='oben' AND sku_codigo_omie=7001;")" "100"
eq "M2l ...e o log ficou marcado como revertido pelo master" \
   "$(Pq -c "SELECT revertido_por::text FROM public.reposicao_param_auto_log WHERE id='$LOG_ID';")" "$MASTER"

seed_cenario
eq "M3 master reverte run inteiro (1 revertido, 0 conflitos)" \
   "$(as_user "$MASTER" "SELECT revertidos||'/'||conflitos FROM public.reverter_run_auto('$RUN_ID');")" "1/0"

echo "── ZONA 4e: a troca NÃO mudou comportamento algum ──"
seed_cenario
eq "C1 despinar de sku inexistente segue retornando false" \
   "$(as_user "$MASTER" "SELECT public.despinar_parametro('oben','NAO-EXISTE');")" "f"
eq "C2 reverter log inexistente segue 'nao_encontrado'" \
   "$(as_user "$MASTER" "SELECT public.reverter_parametro_auto('00000000-0000-0000-0000-0000000000ff');")" "nao_encontrado"
P -q -c "UPDATE public.sku_parametros SET ponto_pedido=999 WHERE empresa='oben' AND sku_codigo_omie=7001;"
eq "C3 divergência de parâmetro segue devolvendo 'conflito'" \
   "$(as_user "$MASTER" "SELECT public.reverter_parametro_auto('$LOG_ID');")" "conflito"

echo "── ZONA 4f: catálogo — a reescrita preservou os atributos ──"
eq "K1 as 3 seguem SECURITY DEFINER" \
   "$(Pq -c "SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
             WHERE n.nspname='public' AND p.proname IN ('despinar_parametro','reverter_parametro_auto','reverter_run_auto')
               AND p.prosecdef;")" "3"
eq "K2 as 3 seguem com search_path pinado" \
   "$(Pq -c "SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
             WHERE n.nspname='public' AND p.proname IN ('despinar_parametro','reverter_parametro_auto','reverter_run_auto')
               AND array_to_string(p.proconfig,',') LIKE '%search_path%';")" "3"
eq "K3 nenhuma das 3 referencia o gate ANTIGO" \
   "$(Pq -c "SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
             WHERE n.nspname='public' AND p.proname IN ('despinar_parametro','reverter_parametro_auto','reverter_run_auto')
               AND pg_get_functiondef(p.oid) ~ '(public\.|private\.)?pode_ver_carteira_completa\s*\(';")" "0"
eq "K4 authenticated segue com EXECUTE nas 3 (ACL preservado)" \
   "$(Pq -c "SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
             WHERE n.nspname='public' AND p.proname IN ('despinar_parametro','reverter_parametro_auto','reverter_run_auto')
               AND has_function_privilege('authenticated', p.oid, 'EXECUTE');")" "3"
eq "K5 o ARGUMENTO foi preservado (reverter_parametro_auto segue passando v_uid)" \
   "$(Pq -c "SELECT pg_get_functiondef('public.reverter_parametro_auto(uuid)'::regprocedure) ~ 'cap_compras_escrever\(v_uid\)';")" "t"
eq "K6 anon NÃO executa a capability" \
   "$(Pq -c "SELECT has_function_privilege('anon','private.cap_compras_escrever(uuid)','EXECUTE');")" "f"

# ═══════════════════════════════════════════════════════════════════════════════════
# ZONA 5 — FALSIFICAÇÃO (Lei #3): sabota e EXIGE vermelho
# ═══════════════════════════════════════════════════════════════════════════════════
echo ""
echo "── ZONA 5: falsificação (sabotar → exigir vermelho) ──"
seed_cenario

# F1 — a capability passa a aceitar o gate antigo. N1/N2/N3 devem QUEBRAR.
P -q <<'SQL'
CREATE OR REPLACE FUNCTION private.cap_compras_escrever(_uid uuid) RETURNS boolean
 LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $f$ SELECT COALESCE(public.pode_ver_carteira_completa(_uid), false) $f$;  -- SABOTADO
SQL
if [ "$(call_rpc "$GERENCIAL" "public.despinar_parametro('oben','9002')")" = "OK" ]; then
  ok "F1 sabotagem REABRIU o furo no despinar → N1 tem dente"
else
  bad "F1 sabotei a capability e N1 seguiu negando — assert FRACO"
fi
if [ "$(call_rpc "$GERENCIAL" "public.reverter_run_auto('$RUN_ID')")" = "OK" ]; then
  ok "F2 sabotagem REABRIU o furo no reverter_run → N3 tem dente"
else
  bad "F2 sabotei a capability e N3 seguiu negando — assert FRACO"
fi
# o efeito de escrita também tem de vazar (não basta a exceção sumir)
eq "F2e sabotado, o gerencial REVERTEU de fato (efeito vazou)" \
   "$(Pq -c "SELECT count(*) FROM public.reposicao_param_auto_log WHERE id='$LOG_ID' AND revertido_por='$GERENCIAL';")" "1"

# Restaura CIRURGICAMENTE (só a função sabotada). Re-aplicar a migration inteira aqui NÃO
# funcionaria: a precondição dela aborta de propósito porque já semeamos um papel gerencial.
P -q <<'SQL'
CREATE OR REPLACE FUNCTION private.cap_compras_escrever(_uid uuid) RETURNS boolean
 LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $f$ SELECT COALESCE(_uid IS NOT NULL AND public.has_role(_uid, 'master'::public.app_role), false) $f$;
SQL
seed_cenario
eq "F1r restaurado: gerencial volta a ser negado" \
   "$(call_rpc "$GERENCIAL" "public.despinar_parametro('oben','9002')")" "DENIED"

# F3 — a precondição de "papel gerencial vivo" tem dente? Já há um gerencial semeado (ZONA 3),
# então re-aplicar a migration DEVE abortar.
if P -q -f "$MIG" >/dev/null 2>&1; then
  bad "F3 precondição: migration aplicou COM papel gerencial vivo (deveria abortar)"
else
  ok "F3 precondição aborta com papel gerencial vivo → o guard tem dente"
fi

# F4 — o guard de "1 ocorrência do gate antigo" tem dente? Injeta uma 2ª chamada e exige aborto.
P -q -c "DELETE FROM public.commercial_roles WHERE commercial_role IN ('gerencial','estrategico','super_admin');"
P -q <<'SQL'
CREATE OR REPLACE FUNCTION public.despinar_parametro(p_empresa text, p_sku text)
 RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  IF NOT public.pode_ver_carteira_completa(auth.uid()) THEN RAISE EXCEPTION 'sem permissão'; END IF;
  IF NOT public.pode_ver_carteira_completa(auth.uid()) THEN RAISE EXCEPTION 'sem permissão'; END IF;
  DELETE FROM public.reposicao_param_pin WHERE empresa=p_empresa AND sku_codigo_omie=p_sku;
  RETURN FOUND;
END;
$function$;
SQL
if P -q -f "$MIG" >/dev/null 2>&1; then
  bad "F4 guard de contagem: migration aceitou 2 ocorrências do gate antigo (deveria abortar)"
else
  ok "F4 guard aborta com 2 ocorrências do gate antigo → não reescreve corpo divergente"
fi

# ── F5 — O BYPASS TRI-STATE, DEMONSTRADO (a falsificação que dá dente ao N7) ──────────────────
# Restaura o corpo PRÉ-#1462 (gate ANTIGO + `IF NOT`, verbatim) e exige que o employee sem
# commercial_role VOLTE A ESCREVER. Se este bloco não conseguir reabrir o bypass, então o stub
# do gate antigo não é tri-state e o N7 estava passando por acidente — que foi exatamente o
# defeito deste harness até 2026-07-20 (stub com `EXISTS(...)`, bi-state).
# ⚠️ Esta é a única falsificação do arquivo que testa o STUB, não a migration: ela prova que o
# mundo que o harness simula é o mundo que existe em produção.
P -q <<'SQL'
CREATE OR REPLACE FUNCTION public.despinar_parametro(p_empresa text, p_sku text)
 RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  IF NOT public.pode_ver_carteira_completa(auth.uid()) THEN RAISE EXCEPTION 'sem permissão'; END IF;
  DELETE FROM public.reposicao_param_pin WHERE empresa=p_empresa AND sku_codigo_omie=p_sku;
  RETURN FOUND;
END;
$function$;
SQL
seed_cenario
if [ "$(call_rpc "$EMPL_SEM_CR" "public.despinar_parametro('oben','9002')")" = "OK" ]; then
  ok "F5 gate ANTIGO reabre o bypass p/ employee sem commercial_role → N7 tem dente"
else
  bad "F5 restaurei o gate ANTIGO e o employee sem commercial_role seguiu NEGADO — o stub NÃO é tri-state (regressão para EXISTS?), N7 é cego"
fi
eq "F5e ...e o bypass ESCREVEU de fato: o pin sumiu (efeito, não só ausência de exceção)" \
   "$(Pq -c "SELECT count(*) FROM public.reposicao_param_pin WHERE empresa='oben' AND sku_codigo_omie='9002';")" "0"
# contraste: no MESMO corpo antigo, o farmer (papel comercial comum ⇒ false, não NULL) segue negado.
# Prova que o vazamento vem do NULL e não de o gate antigo liberar geral.
eq "F5c ...mas o farmer segue negado no gate antigo (o furo é o NULL, não o gate inteiro)" \
   "$(call_rpc "$FARMER" "public.despinar_parametro('oben','9002')")" "DENIED"

# restaura o gate NOVO e exige que o bypass feche de novo
P -q <<'SQL'
CREATE OR REPLACE FUNCTION public.despinar_parametro(p_empresa text, p_sku text)
 RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  IF NOT private.cap_compras_escrever(auth.uid()) THEN RAISE EXCEPTION 'sem permissão'; END IF;
  DELETE FROM public.reposicao_param_pin WHERE empresa=p_empresa AND sku_codigo_omie=p_sku;
  RETURN FOUND;
END;
$function$;
SQL
seed_cenario
eq "F5r restaurado: employee sem commercial_role volta a ser negado" \
   "$(call_rpc "$EMPL_SEM_CR" "public.despinar_parametro('oben','9002')")" "DENIED"

echo ""
echo "═══════════════════════════════════════════════════════"
echo "  PASS=$PASS  FAIL=$FAIL"
echo "═══════════════════════════════════════════════════════"
[ "$FAIL" -eq 0 ] || exit 1
