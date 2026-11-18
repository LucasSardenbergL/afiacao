#!/usr/bin/env bash
# PROVA PG17 — ledger do ajuste de lote mínimo Sayerlack (20261119130000_pedido_portal_ajuste_qtde.sql)
#
#   I  a migration aplica com a postcondição OK (I0) e re-aplicar é seguro (I1)
#   L  service_role (a edge) grava o ajuste (L1); 2ª linha do mesmo item → 23505 (L2); o upsert
#      ON CONFLICT DO NOTHING da edge (retentativa) não duplica nem erra (L3); lote ≤ necessária → 23514 (L4);
#      lançada ≠ lote → 23514 (L5); status fora do vocabulário → 23514 (L6); pedido inexistente → 23503 (L7)
#   R  staff lê (R1); authenticated sem papel não vê (R2); authenticated não escreve → 42501 (R3);
#      anon não lê → 42501 (R4)
#
# Uso: bash db/test-pedido-portal-ajuste-qtde.sh               # suíte
#      bash db/test-pedido-portal-ajuste-qtde.sh --falsificar  # controle + cada sabotagem tem de ficar vermelha
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
export PGVER=17
PORT="${PGPORT_TEST:-5891}"
HARNESS_LC="${HARNESS_LC:-C}"
export LC_ALL=C LANG=C
MIG="$REPO_ROOT/supabase/migrations/20261119130000_pedido_portal_ajuste_qtde.sql"
TOTAL_ESPERADO=13

# ── --falsificar: controle VERDE na mesma invocação, depois cada sabotagem (uma camada por vez) tem de acusar.
# Formato <nome>:<VERMELHOS>[:<VERDES>]; `ID!MARCA` exige a marca do motivo no vermelho.
SABOTAGENS="pc_sem_rls:I0!A1 pc_sem_unique:I0!A2 pc_authenticated_escreve:I0!A3
            sem_check_lote:L4:L1 sem_check_status:L6:L1 policy_aberta:R2:R1 sem_fk:L7:L1"
if [ "${1:-}" = "--falsificar" ]; then
  falhas=0
  rodar() {  # <nome> <porta> → as linhas de veredito do filho
    PGPORT_TEST="$2" SABOTAGEM="$1" bash "$0" 2>&1 | grep -E '^(RESUMO|VERDE|VERMELHO|ERRO)' || true
  }
  ctl="$(rodar "" 5892)"
  if ! grep -q "^RESUMO verdes=$TOTAL_ESPERADO vermelhos=0$" <<<"$ctl"; then
    echo "CONTROLE NÃO VERDE — falsificação inválida:"; printf '%s\n' "$ctl"; exit 1
  fi
  echo "controle: $TOTAL_ESPERADO/$TOTAL_ESPERADO verdes"
  porta=5893
  for item in $SABOTAGENS; do
    sab="${item%%:*}"; resto="${item#*:}"
    verm="${resto%%:*}"; verdes=""
    [ "$resto" = "$verm" ] || verdes="${resto#*:}"
    out="$(rodar "$sab" "$porta")"; porta=$((porta + 1))
    motivo=""
    grep -q '^RESUMO ' <<<"$out" || motivo="$motivo o filho não chegou ao RESUMO (abortou antes de provar);"
    for decl in ${verm//,/ }; do
      id="${decl%%!*}"; marca=""
      [ "$id" = "$decl" ] || marca="${decl#*!}"
      linha_v="$(printf '%s\n' "$out" | grep -m1 "^VERMELHO $id " || true)"
      if [ -z "$linha_v" ]; then motivo="$motivo $id deveria ficar VERMELHO;"
      elif [ -n "$marca" ] && ! grep -qF "$marca" <<<"$linha_v"; then motivo="$motivo $id vermelho sem a marca [$marca];"
      fi
    done
    for id in ${verdes//,/ }; do
      grep -q "^VERDE $id\$" <<<"$out" || motivo="$motivo $id deveria seguir VERDE (linha VERDE ausente);"
    done
    if [ -z "$motivo" ]; then echo "sabotagem $sab: tem dente ($verm)"; else falhas=$((falhas + 1)); echo "sabotagem $sab:$motivo"; printf '%s\n' "$out"; fi
  done
  total="$(wc -w <<<"$SABOTAGENS" | tr -d ' ')"
  echo "SABOTAGENS: $((total - falhas)) vermelhas / $falhas falhas"
  if [ "$falhas" -eq 0 ]; then echo "FALSIFICACAO-OK"; exit 0; fi
  echo "FALSIFICACAO REPROVOU: $falhas sabotagem(ns) sem dente"; exit 1
fi
SABOTAGEM="${SABOTAGEM:-}"

# shellcheck disable=SC1091  # helper versionado ao lado, em db/lib/
. "$REPO_ROOT/db/lib/pg-harness.sh"
TMPD="$(mktemp -d "${TMPDIR:-/tmp}/pgtest-ajuste-qtde.XXXXXX")"
DATA="$TMPD/data"
cleanup() { "$PGBIN/pg_ctl" -D "$DATA" stop -m immediate >/dev/null 2>&1 || true; rm -rf "$TMPD"; }
trap cleanup EXIT
"$PGBIN/initdb" -D "$DATA" -U postgres -E UTF8 --locale=C >/dev/null
"$PGBIN/pg_ctl" -D "$DATA" -o "-p $PORT -k /tmp" -l "$TMPD/pg.log" -w start >/dev/null
Pdb() { "$PGBIN/psql" -X -p "$PORT" -h /tmp -U postgres -d prove -v ON_ERROR_STOP=1 "$@"; }
Q() { Pdb -At -q -c "$1" 2>&1 | tail -n 1; }

trocar() {  # <entrada> <saída> <de> <para> — o padrão tem de ocorrer EXATAMENTE 1x (troca que não pegou é erro)
  python3 - "$@" <<'PY'
import sys
src, dst, de, para = sys.argv[1:5]
s = open(src, encoding='utf-8').read()
if s.count(de) != 1:
    sys.exit('padrao ocorre %dx (esperado 1): %r' % (s.count(de), de))
open(dst, 'w', encoding='utf-8').write(s.replace(de, para))
PY
}

"$PGBIN/createdb" -p "$PORT" -h /tmp -U postgres prove
"$PGBIN/psql" -X -p "$PORT" -h /tmp -U postgres -d postgres -q -c "ALTER DATABASE prove SET lc_messages='$HARNESS_LC';"
Pdb -q -f "$REPO_ROOT/db/stubs-supabase.sql"
Pdb -q <<'SQL'
CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $f$ SELECT nullif(current_setting('test.uid', true), '')::uuid $f$;
GRANT USAGE ON SCHEMA auth TO anon, authenticated, service_role;
-- Em prod (psql-ro, 2026-11-18): service_role tem BYPASSRLS — é por isso que a migration não tem policy de escrita.
ALTER ROLE service_role BYPASSRLS;
DO $$ BEGIN CREATE TYPE public.app_role AS ENUM ('master','employee','customer'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
CREATE TABLE IF NOT EXISTS public.user_roles (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL, role public.app_role NOT NULL);
CREATE OR REPLACE FUNCTION public.has_role(_user_id uuid, _role public.app_role) RETURNS boolean
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
  AS $$ SELECT EXISTS (SELECT 1 FROM public.user_roles WHERE user_id = _user_id AND role = _role) $$;
GRANT EXECUTE ON FUNCTION public.has_role(uuid, public.app_role) TO anon, authenticated, service_role;
-- só o que a FK lê (o pré-voo psql-ro confere id bigint na PROD)
CREATE TABLE IF NOT EXISTS public.pedido_compra_sugerido (id bigint PRIMARY KEY);
INSERT INTO public.pedido_compra_sugerido (id) VALUES (4505);
CREATE OR REPLACE FUNCTION public._prova(p_sql text) RETURNS text LANGUAGE plpgsql AS $f$
DECLARE v text;
BEGIN
  EXECUTE p_sql INTO v;
  RETURN coalesce(v, 'NULL');
EXCEPTION WHEN OTHERS THEN
  RETURN 'SQLSTATE:' || SQLSTATE;
END $f$;
GRANT EXECUTE ON FUNCTION public._prova(text) TO anon, authenticated, service_role;
-- O Supabase concede tudo em tabela nova a anon/authenticated por default: a migration tem de REVOGAR.
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO anon, authenticated, service_role;
GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;
INSERT INTO public.user_roles (user_id, role) VALUES ('a0000000-0000-4000-8000-000000000001', 'employee');
SQL

verdes=0; vermelhos=0
ok() {  # <id> <esperado> <obtido>
  if [ "$2" = "$3" ]; then verdes=$((verdes + 1)); echo "VERDE $1"; else vermelhos=$((vermelhos + 1)); echo "VERMELHO $1 esperado=[$2] obtido=[$3]"; fi
}

# ── I — a migration (real ou sabotada) aplica e re-aplica ──
MIG_USADA="$MIG"
case "$SABOTAGEM" in
  pc_sem_rls) trocar "$MIG" "$TMPD/m.sql" 'ALTER TABLE public.pedido_portal_ajuste_qtde ENABLE ROW LEVEL SECURITY;' '' ;;
  pc_sem_unique) trocar "$MIG" "$TMPD/m.sql" ',
  CONSTRAINT pedido_portal_ajuste_qtde_item_uniq UNIQUE (pedido_id, pedido_item_id)' '' ;;
  pc_authenticated_escreve) trocar "$MIG" "$TMPD/m.sql" 'REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON public.pedido_portal_ajuste_qtde FROM authenticated;' '' ;;
esac
[ -f "$TMPD/m.sql" ] && MIG_USADA="$TMPD/m.sql"
if Pdb -q -f "$MIG_USADA" >"$TMPD/i0.log" 2>&1 && grep -q "pedido_portal_ajuste_qtde OK" "$TMPD/i0.log"; then ok I0 aplicou aplicou; else ok I0 aplicou "falhou: $(grep -m1 -E 'ERRO|ERROR|EXCEPTION' "$TMPD/i0.log" | cut -c1-400)"; fi
if [ "$MIG_USADA" != "$MIG" ]; then  # sabotagem de postcondição: só o I0 importa
  echo "RESUMO verdes=$verdes vermelhos=$vermelhos"; exit 0
fi
if Pdb -q -f "$MIG" >"$TMPD/i1.log" 2>&1; then ok I1 reaplicou reaplicou; else ok I1 reaplicou falhou; fi

# ── sabotagens de COMPORTAMENTO, aplicadas no banco depois da migration real ──
case "$SABOTAGEM" in
  sem_check_lote) Pdb -q -c "ALTER TABLE public.pedido_portal_ajuste_qtde DROP CONSTRAINT pedido_portal_ajuste_qtde_lote_coerente;" ;;
  sem_check_status) Pdb -q -c "ALTER TABLE public.pedido_portal_ajuste_qtde DROP CONSTRAINT pedido_portal_ajuste_qtde_status_check;" ;;
  policy_aberta) Pdb -q -c "DROP POLICY pedido_portal_ajuste_qtde_select_staff ON public.pedido_portal_ajuste_qtde; CREATE POLICY pedido_portal_ajuste_qtde_select_staff ON public.pedido_portal_ajuste_qtde FOR SELECT TO authenticated USING (true);" ;;
  sem_fk) Pdb -q -c "ALTER TABLE public.pedido_portal_ajuste_qtde DROP CONSTRAINT pedido_portal_ajuste_qtde_pedido_id_fkey;" ;;
  "") ;;
  *) echo "ERRO sabotagem desconhecida: $SABOTAGEM"; exit 1 ;;
esac

COLS="pedido_id, pedido_item_id, empresa, sku_portal, sku_codigo_omie, qtde_omie, qtde_portal_necessaria, qtde_portal_lancada, lote_minimo, portal_protocolo, status_envio"
como() {  # <role> <uid|''> <sql> → resultado do _prova sob a role
  Pdb -At -q -c "SET ROLE $1; SELECT set_config('test.uid', '$2', false); SELECT public._prova(\$q\$$3\$q\$);" 2>&1 | tail -n 1
}
SR=service_role
# L1 — o caso do 4505: 1 balde necessário, lote 20 lançado
ok L1 1 "$(como $SR '' "WITH i AS (INSERT INTO public.pedido_portal_ajuste_qtde ($COLS) VALUES (4505, 9001, 'OBEN', 'YO20.1464.00BB', 'SKU1', 1, 1, 20, 20, '123456', 'sucesso_portal') RETURNING 1) SELECT count(*)::text FROM i")"
ok L2 SQLSTATE:23505 "$(como $SR '' "INSERT INTO public.pedido_portal_ajuste_qtde ($COLS) VALUES (4505, 9001, 'OBEN', 'YO20.1464.00BB', 'SKU1', 1, 1, 20, 20, '123456', 'sucesso_portal') RETURNING 'inseriu'")"
ok L3 1 "$(como $SR '' "WITH i AS (INSERT INTO public.pedido_portal_ajuste_qtde ($COLS) VALUES (4505, 9001, 'OBEN', 'YO20.1464.00BB', 'SKU1', 1, 1, 20, 20, '123456', 'sucesso_portal') ON CONFLICT (pedido_id, pedido_item_id) DO NOTHING RETURNING 1) SELECT (SELECT count(*) FROM public.pedido_portal_ajuste_qtde WHERE pedido_id = 4505)::text")"
ok L4 SQLSTATE:23514 "$(como $SR '' "INSERT INTO public.pedido_portal_ajuste_qtde ($COLS) VALUES (4505, 9002, 'OBEN', 'X', 'SKU2', 20, 20, 20, 20, null, 'sucesso_portal') RETURNING 'inseriu'")"
ok L5 SQLSTATE:23514 "$(como $SR '' "INSERT INTO public.pedido_portal_ajuste_qtde ($COLS) VALUES (4505, 9003, 'OBEN', 'X', 'SKU3', 1, 1, 1, 20, null, 'sucesso_portal') RETURNING 'inseriu'")"
ok L6 SQLSTATE:23514 "$(como $SR '' "INSERT INTO public.pedido_portal_ajuste_qtde ($COLS, status) VALUES (4505, 9004, 'OBEN', 'X', 'SKU4', 1, 1, 20, 20, null, 'sucesso_portal', 'qualquer') RETURNING 'inseriu'")"
ok L7 SQLSTATE:23503 "$(como $SR '' "INSERT INTO public.pedido_portal_ajuste_qtde ($COLS) VALUES (999999, 9005, 'OBEN', 'X', 'SKU5', 1, 1, 20, 20, null, 'sucesso_portal') RETURNING 'inseriu'")"

STAFF=a0000000-0000-4000-8000-000000000001
NINGUEM=b0000000-0000-4000-8000-000000000002
ok R1 1 "$(como authenticated $STAFF "SELECT count(*)::text FROM public.pedido_portal_ajuste_qtde")"
ok R2 0 "$(como authenticated $NINGUEM "SELECT count(*)::text FROM public.pedido_portal_ajuste_qtde")"
ok R3 SQLSTATE:42501 "$(como authenticated $STAFF "INSERT INTO public.pedido_portal_ajuste_qtde ($COLS) VALUES (4505, 9006, 'OBEN', 'X', 'SKU6', 1, 1, 20, 20, null, 'sucesso_portal') RETURNING 'inseriu'")"
ok R4 SQLSTATE:42501 "$(como anon '' "SELECT count(*)::text FROM public.pedido_portal_ajuste_qtde")"

echo "RESUMO verdes=$verdes vermelhos=$vermelhos"
[ "$vermelhos" -eq 0 ] && [ "$verdes" -eq "$TOTAL_ESPERADO" ]
