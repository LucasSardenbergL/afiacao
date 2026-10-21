#!/usr/bin/env bash
# Prova PG17 da TRILHA da edge `process-nfe` — migration 20261021175441_nfe_recebimento_manual_trilha
# (plano de melhoria v3, item 1). A tabela é o registro durável de cada recebimento manual concluído
# no Omie; o desenho é "só a edge escreve, staff lê, ninguém edita".
#
# O que prova EXECUTANDO, com o default privileges do Supabase reproduzido (ALL para anon/authenticated
# em tabela nova — é o que torna o REVOKE necessário):
#  T1  service_role insere um evento (é a edge)
#  T2  staff (master e employee) lê; customer lê 0 linhas
#  T3  anon não lê (42501, ACL)
#  T4  authenticated não insere — nem staff (42501, ACL)
#  T5  UPDATE, DELETE e TRUNCATE recusados até para o service_role (42501 sem grant; P0001 do trigger como owner)
#  T6  domínio fechado: resultado/passo/conta fora da lista → 23514
#  T7  re-apply idempotente (a migration roda duas vezes sem erro)
#  T8  privilégio por CATÁLOGO (has_table_privilege), as duas pontas: anon e authenticated
#
#   bash db/test-nfe-recebimento-manual-trilha.sh > "$TMPDIR/t.log" 2>&1; echo "exit=$?"
#   LOCALE_TESTE=pt_BR.UTF-8 bash db/test-nfe-recebimento-manual-trilha.sh   # mesma prova no outro locale
#   SABOTAGEM=<nome> bash db/test-nfe-recebimento-manual-trilha.sh           # tem de ficar VERMELHA
#   bash db/test-nfe-recebimento-manual-trilha.sh --falsificar               # controle verde + cada sabotagem vermelha no assert dela
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MIG="$REPO_ROOT/supabase/migrations/20261021175441_nfe_recebimento_manual_trilha.sql"

if [ "${1:-}" = "--falsificar" ]; then
  # <sabotagem>:<assert que TEM de acusá-la>; `POST!<marca>` = a postcondição da migration aborta com a marca exata.
  SABOTAGENS="policy_aberta:T2 sem_revoke:POST!A2_FALHOU sem_trigger:POST!A4_FALHOU trigger_so_update:T5 resultado_livre:T6 sem_grant_service:POST!A3_FALHOU service_edita:POST!A6_FALHOU sem_trigger_truncate:POST!A4_FALHOU"
  LOGDIR="$(mktemp -d "${TMPDIR:-/tmp}/falsifica-nfe-trilha.XXXXXX")"
  echo "══ CONTROLE ══"
  if ! SABOTAGEM="" bash "$0" > "$LOGDIR/controle.log" 2>&1; then
    echo "❌ controle VERMELHO — falsificação abortada (log: $LOGDIR/controle.log)"; tail -15 "$LOGDIR/controle.log"; exit 1
  fi
  grep -q "^FIM-OK nfe-recebimento-manual-trilha" "$LOGDIR/controle.log" || { echo "❌ controle sem marcador de fim"; exit 1; }
  echo "✅ controle verde"
  falhas=0; n_sab=0
  for par in $SABOTAGENS; do
    s="${par%%:*}"; a="${par#*:}"; n_sab=$((n_sab+1))
    if SABOTAGEM="$s" bash "$0" > "$LOGDIR/$s.log" 2>&1; then
      echo "❌ $s: suíte ficou VERDE"; falhas=$((falhas+1)); continue
    fi
    if ! grep -q "SABOTAGEM ATIVA: $s" "$LOGDIR/$s.log"; then
      echo "❌ $s: sabotagem NÃO aplicou"; falhas=$((falhas+1)); continue
    fi
    case "$a" in
      *!*) marca="${a#*!}"; marca="${marca//_/ }" ;;
      *)   marca="FAIL $a " ;;
    esac
    if grep -qF -- "$marca" "$LOGDIR/$s.log"; then
      echo "✅ $s: vermelha em [$marca]"
    else
      echo "❌ $s: vermelha, mas NÃO no assert esperado [$marca] (log: $LOGDIR/$s.log)"; falhas=$((falhas+1))
    fi
  done
  echo "SABOTAGENS: $((n_sab - falhas)) vermelhas / $falhas falhas"   # recibo exigido por db/roda-nucleo-ci.sh
  [ "$falhas" -eq 0 ] && exit 0 || exit 1
fi

export PGVER=17
# shellcheck disable=SC1091  # caminho resolvido em runtime a partir de REPO_ROOT
. "$REPO_ROOT/db/lib/pg-harness.sh"
PORT="${PGPORT_TEST:-5671}"
LOC="${LOCALE_TESTE:-C}"
export LC_ALL="$LOC" LANG="$LOC"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/pgtest-nfe-trilha.XXXXXX")"
DATA="$WORK/data"
MIG_USADA="$WORK/mig.sql"
cleanup() { "$PGBIN/pg_ctl" -D "$DATA" stop -m immediate >/dev/null 2>&1 || true; rm -rf "$WORK"; }
trap cleanup EXIT

cp "$MIG" "$MIG_USADA"
sabotar() { # $1 = de, $2 = para (literal; substitui TODAS as ocorrências; padrão ausente = erro)
  python3 -I - "$MIG_USADA" "$1" "$2" <<'PY'
import sys
p, de, para = sys.argv[1:]
s = open(p, encoding="utf-8").read()
if de not in s:
    sys.exit("padrao ausente: " + de)
open(p, "w", encoding="utf-8").write(s.replace(de, para))
PY
}
case "${SABOTAGEM:-}" in
  "") ;;
  policy_aberta)     sabotar "  USING (public.has_role(auth.uid(), 'master'::public.app_role)
      OR public.has_role(auth.uid(), 'employee'::public.app_role));" "  USING (true);" ;;
  sem_revoke)        sabotar "REVOKE ALL ON public.nfe_recebimento_manual_trilha FROM PUBLIC, anon, authenticated;" "" ;;
  sem_trigger)       sabotar "CREATE TRIGGER trg_nfe_receb_manual_trilha_append_only" "CREATE TRIGGER trg_desligado" ;;
  trigger_so_update) sabotar "BEFORE UPDATE OR DELETE ON" "BEFORE UPDATE ON" ;;
  resultado_livre)   sabotar "'ok', 'aviso', 'erro', 'indeterminado', 'recusado', 'intencao', 'pulado'" \
                             "'ok', 'aviso', 'erro', 'indeterminado', 'recusado', 'intencao', 'pulado', 'qualquer'" ;;
  service_edita)     sabotar "REVOKE UPDATE, DELETE, TRUNCATE ON public.nfe_recebimento_manual_trilha FROM service_role;" "" ;;
  sem_trigger_truncate) sabotar "CREATE TRIGGER trg_nfe_receb_manual_trilha_sem_truncate" "CREATE TRIGGER trg_truncate_desligado" ;;
  sem_grant_service) sabotar "GRANT SELECT, INSERT ON public.nfe_recebimento_manual_trilha TO service_role;" \
                             "REVOKE ALL ON public.nfe_recebimento_manual_trilha FROM service_role;" ;;
  *) echo "sabotagem desconhecida: $SABOTAGEM"; exit 9 ;;
esac
if [ -n "${SABOTAGEM:-}" ]; then echo "⚠️  SABOTAGEM ATIVA: $SABOTAGEM"; fi

"$PGBIN/initdb" -D "$DATA" -U postgres -E UTF8 --locale="$LOC" >/dev/null
"$PGBIN/pg_ctl" -D "$DATA" -o "-p $PORT -k /tmp" -l "$WORK/pg.log" -w start >/dev/null
P()  { "$PGBIN/psql" -X -v ON_ERROR_STOP=1 -p "$PORT" -h /tmp -U postgres -d postgres "$@"; }
Pq() { P -qAt "$@"; }
# SQLSTATE de um comando que TEM de falhar: "verde" se passou; senão o código de 5 chars (VERBOSITY verbose).
estado() {
  local saida
  if saida="$(P -qAt -v VERBOSITY=verbose -c "$1" 2>&1)"; then echo "verde"; return; fi
  printf '%s\n' "$saida" | grep -oE '[A-Z]+: +[0-9A-Z]{5}:' | head -1 | grep -oE '[0-9A-Z]{5}:$' | tr -d ':' || echo "sem-codigo"
}

PASS=0; FAIL=0
ok()  { PASS=$((PASS+1)); echo "  ok   $1"; }
bad() { FAIL=$((FAIL+1)); echo "  FAIL $1 — esperado [$3], veio [$2]"; }
eq()  { if [ "$2" = "$3" ]; then ok "$1 (=$2)"; else bad "$1 " "$2" "$3"; fi; }

M=00000000-0000-0000-0000-0000000000ee; E=00000000-0000-0000-0000-0000000000e1; C=00000000-0000-0000-0000-0000000000c1
como() { # $1 = uid, $2 = SQL — executa como authenticated com o sub do JWT
  printf "SET ROLE authenticated; SET request.jwt.claim.sub = '%s'; %s" "$1" "$2"
}

# ── ZONA 1: o que a PROD já tem (stubs, enum, user_roles, has_role, default privileges) ──
P -q -f "$REPO_ROOT/db/stubs-supabase.sql"
P -q <<SQL
ALTER ROLE service_role BYPASSRLS;   -- espelha prod (rolbypassrls=t)
-- default privileges do schema public em prod (pg_default_acl, medido 2026-10-21): ALL para anon e
-- authenticated em toda tabela nova. Sem isto a prova do REVOKE seria verde por ausência de grant.
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO anon, authenticated, service_role;
GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;
DO \$\$ BEGIN CREATE TYPE public.app_role AS ENUM ('master','employee','customer'); EXCEPTION WHEN duplicate_object THEN NULL; END \$\$;
CREATE TABLE IF NOT EXISTS public.user_roles (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL, role public.app_role NOT NULL);
CREATE OR REPLACE FUNCTION public.has_role(_user_id uuid, _role public.app_role)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER AS \$f\$
  SELECT EXISTS (SELECT 1 FROM public.user_roles WHERE user_id = _user_id AND role = _role)
\$f\$;
INSERT INTO public.user_roles (user_id, role) VALUES ('$M', 'master'), ('$E', 'employee'), ('$C', 'customer');
SQL

# ── ZONA 2: a migration REAL (ou a cópia sabotada) — a postcondição embutida roda aqui ──
P -q -f "$MIG_USADA"

echo "═══ asserts ═══"
linha() { # $1 = passo, $2 = resultado, $3 = conta
  printf "INSERT INTO public.nfe_recebimento_manual_trilha (execucao_id, executado_por, conta, nf_numero, passo, resultado, versao)
  VALUES (gen_random_uuid(), '%s', '%s', '955811', '%s', '%s', 'teste')" "$M" "$3" "$1" "$2"
}
LINHA="$(linha inicio intencao oben)"

eq "T1 service_role insere" "$(estado "SET ROLE service_role; $LINHA")" "verde"
eq "T2 master le" "$(Pq -c "$(como "$M" "SELECT count(*) FROM public.nfe_recebimento_manual_trilha;")")" "1"
eq "T2 employee le" "$(Pq -c "$(como "$E" "SELECT count(*) FROM public.nfe_recebimento_manual_trilha;")")" "1"
eq "T2 customer le 0" "$(Pq -c "$(como "$C" "SELECT count(*) FROM public.nfe_recebimento_manual_trilha;")")" "0"
eq "T3 anon select" "$(estado "SET ROLE anon; SELECT count(*) FROM public.nfe_recebimento_manual_trilha;")" "42501"
eq "T4 master insere" "$(estado "$(como "$M" "$LINHA;")")" "42501"
eq "T4 customer insere" "$(estado "$(como "$C" "$LINHA;")")" "42501"
eq "T5 service_role update" "$(estado "SET ROLE service_role; UPDATE public.nfe_recebimento_manual_trilha SET resultado = 'ok';")" "42501"
eq "T5 service_role delete" "$(estado "SET ROLE service_role; DELETE FROM public.nfe_recebimento_manual_trilha;")" "42501"
eq "T5 service_role truncate" "$(estado "SET ROLE service_role; TRUNCATE public.nfe_recebimento_manual_trilha;")" "42501"
# O trigger é a 2ª camada: vale até para o OWNER (postgres), que tem todos os grants.
eq "T5 owner update" "$(estado "UPDATE public.nfe_recebimento_manual_trilha SET resultado = 'ok';")" "P0001"
eq "T5 owner delete" "$(estado "DELETE FROM public.nfe_recebimento_manual_trilha;")" "P0001"
eq "T5 owner truncate" "$(estado "TRUNCATE public.nfe_recebimento_manual_trilha;")" "P0001"
eq "T5 linha intacta" "$(Pq -c "SELECT count(*) || ':' || min(resultado) FROM public.nfe_recebimento_manual_trilha;")" "1:intencao"
eq "T6 resultado fora" "$(estado "SET ROLE service_role; $(linha inicio qualquer oben);")" "23514"
eq "T6 passo fora" "$(estado "SET ROLE service_role; $(linha outro intencao oben);")" "23514"
eq "T6 conta fora" "$(estado "SET ROLE service_role; $(linha inicio intencao xyz);")" "23514"
eq "T7 re-apply" "$(if P -q -f "$MIG_USADA" >/dev/null 2>&1; then echo verde; else echo vermelho; fi)" "verde"
eq "T8 catalogo" "$(Pq -c "SELECT has_table_privilege('anon','public.nfe_recebimento_manual_trilha','SELECT')::text
  || has_table_privilege('authenticated','public.nfe_recebimento_manual_trilha','INSERT')::text
  || has_table_privilege('authenticated','public.nfe_recebimento_manual_trilha','SELECT')::text
  || has_table_privilege('service_role','public.nfe_recebimento_manual_trilha','INSERT')::text;")" "falsefalsetruetrue"

echo ""
echo "═══ resultado: $PASS ok · $FAIL FAIL ═══"
[ "$FAIL" -eq 0 ] || exit 1
echo "FIM-OK nfe-recebimento-manual-trilha"
