#!/usr/bin/env bash
# ╔══════════════════════════════════════════════════════════════════════════════════╗
# ║  HARNESS PG17 — FU4-E hardening: `IS NOT TRUE` nas 3 RPCs de ESCRITA              ║
# ║   bash db/test-authz-is-not-true-escritas.sh > "$S/t.log" 2>&1; echo $?           ║
# ║                                                                                    ║
# ║  A mudança é INERTE com a capability atual (COALESCE ⇒ nunca NULL). O que este     ║
# ║  harness prova é o CONTRAFACTUAL: quando a capability devolve NULL, a forma        ║
# ║  `IF NOT cap(...)` é fail-OPEN e `IF cap(...) IS NOT TRUE` é fail-CLOSED.          ║
# ║  Sem esse par de asserts, a migration seria um no-op não-falsificável.             ║
# ║                                                                                    ║
# ║  Lei #1: migration REAL aplicada.  Lei #2: negativo por SQLSTATE + re-raise.       ║
# ║  Lei #3: ZONA 5 sabota e EXIGE vermelho.                                          ║
# ╚══════════════════════════════════════════════════════════════════════════════════╝
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PGVER=17
PGBIN="/opt/homebrew/opt/postgresql@${PGVER}/bin"
PORT="${PGPORT_TEST:-5495}"
SLUG="isnottrue"
DATA="$(mktemp -d "/tmp/pgtest-${SLUG}.XXXXXX")/data"
MIG="$REPO_ROOT/supabase/migrations/20260723160000_authz_fu4e_is_not_true_escritas.sql"
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
ALTER ROLE service_role BYPASSRLS;
SQL

PASS=0; FAIL=0
ok()  { PASS=$((PASS+1)); echo "  ✅ $1"; }
bad() { FAIL=$((FAIL+1)); echo "  ❌ $1"; }
eq()  { if [ "$2" = "$3" ]; then ok "$1 (=$2)"; else bad "$1 — esperado [$3], veio [$2]"; fi; }

MASTER="10000000-0000-0000-0000-000000000001"
ALVO="70000000-0000-0000-0000-000000000007"   # o uid para quem a capability sabotada devolve NULL

# ═══════════════════════════════════════════════════════════════════════════════════
# ZONA 1 — PRÉ-REQUISITOS (corpo das 3 RPCs VERBATIM de prod, psql-ro 2026-07-20)
# ═══════════════════════════════════════════════════════════════════════════════════
echo "── ZONA 1: pré-requisitos ──"
P -q <<'SQL'
CREATE SCHEMA IF NOT EXISTS private;
GRANT USAGE ON SCHEMA private TO authenticated, anon, service_role;
GRANT USAGE ON SCHEMA auth    TO authenticated, anon, service_role;

CREATE TYPE public.app_role AS ENUM ('customer','employee','master','admin');
CREATE TABLE public.user_roles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL, role public.app_role NOT NULL);

CREATE OR REPLACE FUNCTION public.has_role(_user_id uuid, _role public.app_role)
 RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $f$ SELECT EXISTS (SELECT 1 FROM public.user_roles WHERE user_id = _user_id AND role = _role) $f$;

-- a capability do #1462, corpo VERBATIM de prod (pg_get_functiondef, psql-ro 2026-07-20).
-- COALESCE ⇒ NUNCA devolve NULL — é o que torna `IF NOT` seguro HOJE, e é justamente essa
-- dependência de detalhe interno que a migration desta pasta remove.
-- ⚠️ Espaçamento e `;` final IDÊNTICOS a prod: o validador pós-apply compara o prosrc
-- NORMALIZADO com o canônico, então um stub "equivalente mas reescrito" faria a ZONA 6 acusar
-- divergência que não existe no banco real.
CREATE OR REPLACE FUNCTION private.cap_compras_escrever(_uid uuid)
 RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $f$
  SELECT COALESCE(_uid IS NOT NULL AND public.has_role(_uid, 'master'::public.app_role), false);
$f$;
-- ⚠️ o REVOKE do #1462 faz parte do estado de prod (medido: anon=false). Sem ele o objeto nasce
-- ABERTO (default privilege do Supabase concede EXECUTE a toda função nova) e o check de ACL do
-- validador reprovaria — não por defeito do validador, mas porque o stub estaria mais permissivo
-- que produção.
REVOKE ALL ON FUNCTION private.cap_compras_escrever(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION private.cap_compras_escrever(uuid) TO authenticated, service_role;

CREATE TABLE public.reposicao_param_pin (
  empresa text NOT NULL, sku_codigo_omie text NOT NULL,
  ponto_pedido_rejeitado numeric NOT NULL, estoque_maximo_rejeitado numeric NOT NULL,
  pinado_em timestamptz NOT NULL DEFAULT now(), pinado_por uuid,
  PRIMARY KEY (empresa, sku_codigo_omie));

-- as 3 RPCs no estado PÓS-#1462: gate novo, forma `IF NOT` (o que esta migration endurece).
-- ⚠️ argumentos DIFERENTES de propósito: 2 passam auth.uid(), 1 passa v_uid — é assim em prod, e
-- é o que o regex da migration tem de preservar.
CREATE OR REPLACE FUNCTION public.despinar_parametro(p_empresa text, p_sku text)
 RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public','pg_temp'
AS $function$
BEGIN
  IF NOT private.cap_compras_escrever(auth.uid()) THEN RAISE EXCEPTION 'sem permissão'; END IF;
  DELETE FROM public.reposicao_param_pin WHERE empresa=p_empresa AND sku_codigo_omie=p_sku;
  RETURN FOUND;
END;
$function$;

CREATE OR REPLACE FUNCTION public.reverter_parametro_auto(p_log_id uuid)
 RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public','pg_temp'
AS $function$
DECLARE v_uid uuid := auth.uid();
BEGIN
  IF NOT private.cap_compras_escrever(v_uid) THEN RAISE EXCEPTION 'sem permissão'; END IF;
  INSERT INTO public.reposicao_param_pin(empresa, sku_codigo_omie, ponto_pedido_rejeitado, estoque_maximo_rejeitado, pinado_por)
    VALUES ('oben','REV-'||left(p_log_id::text,4), 1, 1, v_uid)
    ON CONFLICT (empresa, sku_codigo_omie) DO NOTHING;
  RETURN 'revertido';
END;
$function$;

CREATE OR REPLACE FUNCTION public.reverter_run_auto(p_run_id uuid)
 RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public','pg_temp'
AS $function$
BEGIN
  IF NOT private.cap_compras_escrever(auth.uid()) THEN RAISE EXCEPTION 'sem permissão'; END IF;
  DELETE FROM public.reposicao_param_pin WHERE empresa='oben';
  RETURN 1;
END;
$function$;

GRANT EXECUTE ON FUNCTION public.despinar_parametro(text,text) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.reverter_parametro_auto(uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.reverter_run_auto(uuid)       TO authenticated, service_role;
SQL
echo "  pré-requisitos criados"

eq "S1 as 3 nascem na forma FRÁGIL (IF NOT cap(...))" \
   "$(Pq -c "SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
             WHERE n.nspname='public' AND p.proname IN ('despinar_parametro','reverter_parametro_auto','reverter_run_auto')
               AND pg_get_functiondef(p.oid) ~ 'IF\s+NOT\s+private\.cap_compras_escrever';")" "3"

# ═══════════════════════════════════════════════════════════════════════════════════
# ZONA 2 — APLICAR A MIGRATION REAL
# ═══════════════════════════════════════════════════════════════════════════════════
echo "── ZONA 2: aplicar migration real ──"
P -q -f "$MIG"
echo "  migration aplicada: $(basename "$MIG")"
if P -q -f "$MIG" >/dev/null 2>&1; then ok "P0a migration é IDEMPOTENTE (2ª aplicação passa)"
else bad "P0a re-aplicar a migration falhou"; fi

eq "P0b as 3 agora usam IS NOT TRUE" \
   "$(Pq -c "SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
             WHERE n.nspname='public' AND p.proname IN ('despinar_parametro','reverter_parametro_auto','reverter_run_auto')
               AND pg_get_functiondef(p.oid) ~ 'IS NOT TRUE\s+THEN';")" "3"
eq "P0c nenhuma sobrou na forma frágil" \
   "$(Pq -c "SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
             WHERE n.nspname='public' AND p.proname IN ('despinar_parametro','reverter_parametro_auto','reverter_run_auto')
               AND pg_get_functiondef(p.oid) ~ 'IF\s+NOT\s+private\.cap_compras_escrever';")" "0"
# o ARGUMENTO tinha de sobreviver: 2 com auth.uid(), 1 com v_uid.
eq "P0d o argumento v_uid foi PRESERVADO em reverter_parametro_auto" \
   "$(Pq -c "SELECT pg_get_functiondef('public.reverter_parametro_auto(uuid)'::regprocedure) ~ 'cap_compras_escrever\(v_uid\)\s+IS NOT TRUE';")" "t"
eq "P0e ...e auth.uid() nas outras 2" \
   "$(Pq -c "SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
             WHERE n.nspname='public' AND p.proname IN ('despinar_parametro','reverter_run_auto')
               AND pg_get_functiondef(p.oid) ~ 'cap_compras_escrever\(auth\.uid\(\)\)\s+IS NOT TRUE';")" "2"

# ═══════════════════════════════════════════════════════════════════════════════════
# ZONA 3 — SEEDS + helpers
# ═══════════════════════════════════════════════════════════════════════════════════
P -q <<SQL
INSERT INTO public.user_roles(user_id,role) VALUES ('$MASTER','master'), ('$ALVO','employee');
SQL
seed() { P -q -c "DELETE FROM public.reposicao_param_pin;" -c "INSERT INTO public.reposicao_param_pin(empresa,sku_codigo_omie,ponto_pedido_rejeitado,estoque_maximo_rejeitado) VALUES ('oben','9002',111,222);"; }
as_user() { P -tA -q <<SQL
SET test.uid = '$1';
SET ROLE authenticated;
$2
SQL
}
GUARD=$(as_user "$MASTER" "SELECT current_user;")
[ "$GUARD" = "authenticated" ] || { echo "❌ HARNESS INVÁLIDO: SET ROLE não pegou (current_user=$GUARD)"; exit 1; }
echo "  guard: asserts rodam como '$GUARD' (não superuser) ✅"

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
    case "$out" in *SENTINELA_NEGOU_P0001*) echo "DENIED" ;; *) echo "OK" ;; esac
  else echo "ERRO_INESPERADO: $out"; fi
}

# ═══════════════════════════════════════════════════════════════════════════════════
# ZONA 4 — COMPORTAMENTO NÃO MUDOU (a migration é inerte com a capability atual)
# ═══════════════════════════════════════════════════════════════════════════════════
echo ""
echo "── ZONA 4a: master preserva a escrita ──"
seed
eq "M1 master despina (retorna true)" "$(as_user "$MASTER" "SELECT public.despinar_parametro('oben','9002');")" "t"
eq "M1e ...e o pin SUMIU (efeito real)" \
   "$(Pq -c "SELECT count(*) FROM public.reposicao_param_pin WHERE sku_codigo_omie='9002';")" "0"
seed
eq "M2 master reverte run" "$(as_user "$MASTER" "SELECT public.reverter_run_auto('00000000-0000-0000-0000-0000000000aa');")" "1"

echo "── ZONA 4b: não-master segue negado ──"
seed
eq "N1 employee NÃO despina"     "$(call_rpc "$ALVO" "public.despinar_parametro('oben','9002')")"  "DENIED"
eq "N1e ...e o pin CONTINUA lá"  "$(Pq -c "SELECT count(*) FROM public.reposicao_param_pin WHERE sku_codigo_omie='9002';")" "1"
eq "N2 employee NÃO reverte run" "$(call_rpc "$ALVO" "public.reverter_run_auto('00000000-0000-0000-0000-0000000000aa')")" "DENIED"
eq "N3 uid NULO negado (fail-closed)" \
   "$(P -tA -q <<'SQL' 2>&1 | grep -c SENTINELA || true
SET ROLE authenticated;
DO $$ BEGIN PERFORM public.despinar_parametro('oben','9002');
EXCEPTION WHEN raise_exception THEN RAISE NOTICE 'SENTINELA'; WHEN OTHERS THEN RAISE; END $$;
SQL
)" "1"

# ═══════════════════════════════════════════════════════════════════════════════════
# ZONA 5 — FALSIFICAÇÃO: o CONTRAFACTUAL que justifica a migration
# ═══════════════════════════════════════════════════════════════════════════════════
echo ""
echo "── ZONA 5: capability devolvendo NULL (o cenário que a migration protege) ──"
# Sabota a capability para devolver NULL num uid específico — simula alguém retirando o COALESCE,
# acrescentando um ramo nulo, ou trocando a capability por outra função. É o estado em que o gate
# ANTERIOR (pode_ver_carteira_completa, tri-state) de fato vivia.
cap_null() { P -q <<'SQL'
CREATE OR REPLACE FUNCTION private.cap_compras_escrever(_uid uuid) RETURNS boolean
 LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $f$ SELECT CASE WHEN _uid = '70000000-0000-0000-0000-000000000007'::uuid THEN NULL
                   ELSE COALESCE(_uid IS NOT NULL AND public.has_role(_uid,'master'::public.app_role), false) END $f$;
SQL
}
cap_null
eq "F1 capability devolve NULL para o uid alvo (sanidade da sabotagem)" \
   "$(Pq -c "SELECT private.cap_compras_escrever('$ALVO') IS NULL;")" "t"

seed
eq "F2 com IS NOT TRUE, NULL é NEGADO (fail-closed) — é o ganho da migration" \
   "$(call_rpc "$ALVO" "public.despinar_parametro('oben','9002')")" "DENIED"
eq "F2e ...e o pin CONTINUA lá (a escrita não aconteceu)" \
   "$(Pq -c "SELECT count(*) FROM public.reposicao_param_pin WHERE sku_codigo_omie='9002';")" "1"

# ── o contrafactual: devolve a forma FRÁGIL e exige que o MESMO uid ESCREVA ──
# Sem este par, a migration seria um no-op não-falsificável: nada distinguiria `IF NOT` de
# `IS NOT TRUE` enquanto a capability nunca devolve NULL.
P -q <<'SQL'
CREATE OR REPLACE FUNCTION public.despinar_parametro(p_empresa text, p_sku text)
 RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public','pg_temp'
AS $function$
BEGIN
  IF NOT private.cap_compras_escrever(auth.uid()) THEN RAISE EXCEPTION 'sem permissão'; END IF;
  DELETE FROM public.reposicao_param_pin WHERE empresa=p_empresa AND sku_codigo_omie=p_sku;
  RETURN FOUND;
END;
$function$;
SQL
seed
if [ "$(call_rpc "$ALVO" "public.despinar_parametro('oben','9002')")" = "OK" ]; then
  ok "F3 forma FRÁGIL (IF NOT) + NULL ⇒ fail-OPEN: a escrita passa → F2 tem dente"
else
  bad "F3 restaurei IF NOT com capability NULL e seguiu negando — o contrafactual não existe, F2 é cego"
fi
eq "F3e ...e a escrita ACONTECEU de fato (o pin sumiu) — fail-open provado no dado" \
   "$(Pq -c "SELECT count(*) FROM public.reposicao_param_pin WHERE sku_codigo_omie='9002';")" "0"

# restaura a forma correta re-aplicando a migration REAL, e exige que feche de novo
P -q -f "$MIG"
seed
eq "F3r restaurado (IS NOT TRUE): o mesmo uid volta a ser NEGADO" \
   "$(call_rpc "$ALVO" "public.despinar_parametro('oben','9002')")" "DENIED"

# F4 — o guard de contagem tem dente? Injeta uma 2ª ocorrência e exige aborto.
P -q <<'SQL'
CREATE OR REPLACE FUNCTION public.despinar_parametro(p_empresa text, p_sku text)
 RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public','pg_temp'
AS $function$
BEGIN
  IF NOT private.cap_compras_escrever(auth.uid()) THEN RAISE EXCEPTION 'sem permissão'; END IF;
  IF NOT private.cap_compras_escrever(auth.uid()) THEN RAISE EXCEPTION 'sem permissão'; END IF;
  RETURN true;
END;
$function$;
SQL
if P -q -f "$MIG" >/dev/null 2>&1; then
  bad "F4 guard de contagem: migration aceitou 2 gates na forma antiga (deveria abortar)"
else
  ok "F4 guard aborta com 2 ocorrências → não reescreve corpo divergente"
fi

# ═══════════════════════════════════════════════════════════════════════════════════
# ZONA 6 — O VALIDADOR PÓS-APPLY TEM DENTE? (falsificar o instrumento, não só o alvo)
# ═══════════════════════════════════════════════════════════════════════════════════
# Nesta sessão um validador pós-apply deu FALSO NEGATIVO em produção (check sem escopo,
# #1490) e outro daria FALSO POSITIVO (dois regex soltos aceitavam uma capability permissiva).
# Validador é código de autorização como qualquer outro: se ninguém o falsifica, ele vira
# carimbo. Aqui ele é EXECUTADO contra um banco bom e contra um sabotado.
echo ""
echo "── ZONA 6: o validador pós-apply do FU4-E ──"
VALIDADOR="$REPO_ROOT/db/valida-fu4e-cap-compras-escrever.sql"
# restaura o mundo correto (a F4 deixou despinar_parametro sabotada com 2 gates)
P -q <<'SQL'
CREATE OR REPLACE FUNCTION private.cap_compras_escrever(_uid uuid) RETURNS boolean
 LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $f$ SELECT COALESCE(_uid IS NOT NULL AND public.has_role(_uid, 'master'::public.app_role), false); $f$;
CREATE OR REPLACE FUNCTION public.despinar_parametro(p_empresa text, p_sku text)
 RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public','pg_temp'
AS $function$
BEGIN
  IF NOT private.cap_compras_escrever(auth.uid()) THEN RAISE EXCEPTION 'sem permissão'; END IF;
  DELETE FROM public.reposicao_param_pin WHERE empresa=p_empresa AND sku_codigo_omie=p_sku;
  RETURN FOUND;
END;
$function$;
SQL
P -q -f "$MIG" >/dev/null 2>&1

# conta quantas linhas do validador vêm `f` (0 = tudo verde)
val_reprovas() { P -tA -q -f "$VALIDADOR" 2>/dev/null | grep -c '|f$' || true; }

eq "V1 validador passa 100% no banco CORRETO" "$(val_reprovas)" "0"

# sabota: a variante PERMISSIVA que a versão antiga do validador aceitava (AND → OR).
P -q <<'SQL'
CREATE OR REPLACE FUNCTION private.cap_compras_escrever(_uid uuid) RETURNS boolean
 LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $f$ SELECT COALESCE(_uid IS NOT NULL OR public.has_role(_uid, 'master'::public.app_role), false); $f$;
SQL
eq "V2 sanidade: a variante permissiva autoriza um uid QUALQUER (é mesmo perigosa)" \
   "$(Pq -c "SELECT private.cap_compras_escrever('$ALVO') IS TRUE;")" "t"
if [ "$(val_reprovas)" -gt 0 ]; then
  ok "V3 validador REPROVA a capability permissiva ($(val_reprovas) linha(s) f) → tem dente"
else
  bad "V3 capability permissiva passou no validador — o instrumento é CEGO (regex solto?)"
fi

# restaura e confirma que volta a passar (evita falso alarme por sabotagem residual)
P -q <<'SQL'
CREATE OR REPLACE FUNCTION private.cap_compras_escrever(_uid uuid) RETURNS boolean
 LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $f$ SELECT COALESCE(_uid IS NOT NULL AND public.has_role(_uid, 'master'::public.app_role), false); $f$;
SQL
eq "V3r restaurado: validador volta a passar 100%" "$(val_reprovas)" "0"

echo ""
echo "═══════════════════════════════════════════════════════"
echo "  PASS=$PASS  FAIL=$FAIL"
echo "═══════════════════════════════════════════════════════"
[ "$FAIL" -eq 0 ] || exit 1
