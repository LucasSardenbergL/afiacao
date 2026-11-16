#!/usr/bin/env bash
# Prova PG17 do achado b339bb5b — só o master escolhe o vendedor responsável (a dona da carteira).
# Migration sob teste: supabase/migrations/20261116090000_seg_b339_vendedor_so_master.sql.
#
# O que prova EXECUTANDO, sob SET ROLE + GUC de JWT (como o PostgREST):
#  A0  CONTROLE do furo, com a RPC e a policy de ANTES (corpo da migration 20260821192817): o employee
#      troca o vendedor pela RPC e por UPDATE direto. Sem este vermelho-de-antes, o verde de depois é teatro.
#  B1  employee pela RPC: admite o cliente (linha nova, código gravado), mas o vendedor que ele manda é
#      IGNORADO — linha nova fica sem vendedor e a existente mantém o atual
#  B2  master pela RPC troca o vendedor; B3 service_role troca; B4 sem JWT (cron/SQL Editor) troca
#  B5  customer pela RPC → 42501; anon sem EXECUTE → 42501
#  B6  employee direto na tabela: UPDATE do vendedor não pega linha (RLS) e INSERT → 42501; master direto troca
#  B7  leitura: employee segue lendo o mapa inteiro; customer só o seu
#  B8  ACL: RPC DEFINER com search_path vazio; TRUNCATE fora de anon/authenticated; escrita fora de anon
#  B9  re-apply idempotente (POST-OK de novo)
#  B10 ledger da carteira: o employee não exclui nem muda estado de membro (Codex P1); o master muda
#  B11 TTL: o employee não recoloca vínculo vencido na view fresca (Codex P1); o servidor revalida
#  B12 o employee não permuta o código Omie de vínculo existente (Codex P1, 3ª rodada); o master troca
#
#   bash db/test-seg-b339-vendedor-so-master.sh > /tmp/t.log 2>&1; echo "exit=$?"
#   LOCALE_TESTE=pt_BR.UTF-8 bash db/test-seg-b339-vendedor-so-master.sh
#   bash db/test-seg-b339-vendedor-so-master.sh --falsificar
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MIG="$REPO_ROOT/supabase/migrations/20261116090000_seg_b339_vendedor_so_master.sql"
MIG_ANTES="$REPO_ROOT/supabase/migrations/20260821192817_omie_identidade_a2_client_to_user.sql"

if [ "${1:-}" = "--falsificar" ]; then
  SABOTAGENS="employee_vira_master:B1a cliente_passa:B5 policy_employee_fica:POST!POST_FALHOU invoker:POST!POST_FALHOU truncate_fica:POST!POST_FALHOU master_perde_policy:B6 ledger_employee_fica:POST!POST_FALHOU ttl_sempre:B11a permuta_codigo:B12"
  LOGDIR="$(mktemp -d "${TMPDIR:-/tmp}/falsifica-b339.XXXXXX")"
  echo "══ CONTROLE ══"
  if ! SABOTAGEM="" bash "$0" > "$LOGDIR/controle.log" 2>&1; then
    echo "❌ controle VERMELHO — falsificação abortada (log: $LOGDIR/controle.log)"; tail -15 "$LOGDIR/controle.log"; exit 1
  fi
  grep -q "^FIM-OK seg-b339" "$LOGDIR/controle.log" || { echo "❌ controle sem marcador de fim"; exit 1; }
  grep -E "^PASS=[0-9]+ FAIL=0$" "$LOGDIR/controle.log" || { echo "❌ controle sem recibo PASS/FAIL"; exit 1; }
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
  echo "SABOTAGENS: $((n_sab - falhas)) vermelhas / $falhas falhas"
  [ "$falhas" -eq 0 ] && exit 0 || exit 1
fi

export PGVER=17
# shellcheck disable=SC1091
. "$REPO_ROOT/db/lib/pg-harness.sh"
PORT="${PGPORT_TEST:-5691}"
LOC="${LOCALE_TESTE:-C}"
export LC_ALL="$LOC" LANG="$LOC"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/pgtest-b339.XXXXXX")"
DATA="$WORK/data"
MIG_USADA="$WORK/mig.sql"
cleanup() { "$PGBIN/pg_ctl" -D "$DATA" stop -m immediate >/dev/null 2>&1 || true; rm -rf "$WORK"; }
trap cleanup EXIT
cp "$MIG" "$MIG_USADA"

sabotar() {
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
  '') ;;
  employee_vira_master) sabotar "  ELSIF v_uid IS NOT NULL AND public.has_role(v_uid, 'master'::public.app_role) THEN" "  ELSIF v_uid IS NOT NULL AND (public.has_role(v_uid, 'master'::public.app_role) OR public.has_role(v_uid, 'employee'::public.app_role)) THEN" ;;
  cliente_passa)        sabotar "    RAISE EXCEPTION 'register_carteira_member: exige equipe interna'
      USING ERRCODE = '42501';" "    NULL;" ;;
  policy_employee_fica) sabotar 'DROP POLICY IF EXISTS "Staff can manage account map" ON public.omie_customer_account_map;' "" ;;
  invoker)              sabotar "LANGUAGE plpgsql
SECURITY DEFINER" "LANGUAGE plpgsql
SECURITY INVOKER" ;;
  truncate_fica)        sabotar "REVOKE TRUNCATE ON TABLE" "GRANT TRUNCATE ON TABLE" ; sabotar "  FROM PUBLIC, anon, authenticated;
REVOKE INSERT" "  TO anon, authenticated;
REVOKE INSERT" ;;
  master_perde_policy)  sabotar 'CREATE POLICY "Master manage account map" ON public.omie_customer_account_map FOR ALL TO authenticated' 'CREATE POLICY "Master manage account map" ON public.omie_customer_account_map FOR ALL TO service_role' ;;
  ledger_employee_fica) sabotar 'DROP POLICY IF EXISTS "Staff can manage carteira membership ledger" ON public.carteira_membership_ledger;' "" ;;
  ttl_sempre)           sabotar "    updated_at           = CASE WHEN v_restrito THEN omie_customer_account_map.updated_at ELSE now() END
" "    updated_at           = now() -- WHEN v_restrito THEN omie_customer_account_map.updated_at
" ;;
  permuta_codigo)       sabotar "  WHERE NOT v_restrito
     OR omie_customer_account_map.omie_codigo_cliente = EXCLUDED.omie_codigo_cliente;" ";" ;;
  *) echo "sabotagem desconhecida: $SABOTAGEM"; exit 2 ;;
esac
[ -z "${SABOTAGEM:-}" ] || echo "SABOTAGEM ATIVA: $SABOTAGEM"

"$PGBIN/initdb" -D "$DATA" -U postgres -E UTF8 --locale="$LOC" >/dev/null
"$PGBIN/pg_ctl" -D "$DATA" -o "-p $PORT -k /tmp" -l "$WORK/pg.log" -w start >/dev/null
P()  { "$PGBIN/psql" -X -v ON_ERROR_STOP=1 -p "$PORT" -h /tmp -U postgres -d postgres "$@"; }
Pq() { P -qAt "$@"; }
estado() {
  local saida
  if saida="$(P -qAt -v VERBOSITY=verbose -c "$1" 2>&1)"; then echo "verde"; return; fi
  printf '%s\n' "$saida" | grep -oE '[A-Z]+: +[0-9A-Z]{5}:' | sed -n 1p | grep -oE '[0-9A-Z]{5}:$' | tr -d ':' || echo "sem-codigo"
}
# Como o PostgREST: papel + claims. auth.uid()/auth.role() leem as claims, como no Supabase.
como()   { printf "SET ROLE authenticated; SET request.jwt.claim.sub = '%s'; SET request.jwt.claim.role = 'authenticated'; %s" "$1" "$2"; }
como_sr() { printf "SET ROLE service_role; SET request.jwt.claim.role = 'service_role'; %s" "$1"; }
como_json() { printf "SET ROLE authenticated; SET request.jwt.claims = '{\"sub\":\"%s\",\"role\":\"authenticated\"}'; %s" "$1" "$2"; }
como_anon() { printf "SET ROLE anon; SET request.jwt.claim.role = 'anon'; %s" "$1"; }

E=00000000-0000-0000-0000-0000000000e1; M=00000000-0000-0000-0000-0000000000ee; CUST=00000000-0000-0000-0000-0000000000cc
C1=00000000-0000-0000-0000-000000000c01; C2=00000000-0000-0000-0000-000000000c02; C3=00000000-0000-0000-0000-000000000c03

P -q -f "$REPO_ROOT/db/stubs-supabase.sql"
P -q <<'SQL'
-- Como o Supabase: a claim avulsa OU o JSON de claims (o PostgREST atual manda o JSON).
CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS
  $$ SELECT coalesce(nullif(current_setting('request.jwt.claim.sub', true), ''),
                     (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub'))::uuid $$;
CREATE OR REPLACE FUNCTION auth.role() RETURNS text LANGUAGE sql STABLE AS
  $$ SELECT coalesce(nullif(current_setting('request.jwt.claim.role', true), ''),
                     (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role')) $$;
GRANT USAGE ON SCHEMA auth TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION auth.uid(), auth.role() TO anon, authenticated, service_role;

CREATE TYPE public.app_role AS ENUM ('employee', 'customer', 'master');
CREATE TABLE public.user_roles (user_id uuid NOT NULL, role public.app_role NOT NULL, PRIMARY KEY (user_id, role));
CREATE OR REPLACE FUNCTION public.has_role(_user_id uuid, _role public.app_role)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS
  $$ SELECT EXISTS (SELECT 1 FROM public.user_roles WHERE user_id = _user_id AND role = _role) $$;
GRANT EXECUTE ON FUNCTION public.has_role(uuid, public.app_role) TO anon, authenticated, service_role;

-- Estrutura e policies como na PROD (psql-ro, 2026-11-16), só as colunas que a RPC toca.
CREATE TABLE public.carteira_membership_ledger (
  user_id uuid PRIMARY KEY,
  identity_state text NOT NULL CHECK (identity_state IN ('verified','ambiguous','inactive','conflict')),
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  source text NOT NULL CHECK (source IN ('backfill','trigger','rpc','sync')),
  updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.carteira_membership_ledger ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Staff can manage carteira membership ledger" ON public.carteira_membership_ledger FOR ALL TO authenticated
  USING (public.has_role(auth.uid(),'master') OR public.has_role(auth.uid(),'employee'))
  WITH CHECK (public.has_role(auth.uid(),'master') OR public.has_role(auth.uid(),'employee'));

CREATE TABLE public.omie_customer_account_map (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  account text NOT NULL CONSTRAINT chk_ocam_account CHECK (account IN ('oben','colacor','colacor_sc')),
  omie_codigo_cliente bigint NOT NULL,
  omie_codigo_vendedor bigint,
  source text NOT NULL DEFAULT 'rpc' CONSTRAINT chk_ocam_source CHECK (source IN ('document','code','manual','rpc')),
  evidence_document_normalized text,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_ocam_user_account UNIQUE (user_id, account),
  CONSTRAINT uq_ocam_codigo_account UNIQUE (omie_codigo_cliente, account)
);
ALTER TABLE public.omie_customer_account_map ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Staff can manage account map" ON public.omie_customer_account_map FOR ALL TO authenticated
  USING ((SELECT public.has_role(auth.uid(),'master')) OR (SELECT public.has_role(auth.uid(),'employee')))
  WITH CHECK ((SELECT public.has_role(auth.uid(),'master')) OR (SELECT public.has_role(auth.uid(),'employee')));
CREATE POLICY "Users can view their own account map" ON public.omie_customer_account_map FOR SELECT TO authenticated
  USING (auth.uid() = user_id);

CREATE TABLE public.carteira_assignments (customer_user_id uuid PRIMARY KEY, owner_user_id uuid, eligible boolean DEFAULT true);
ALTER TABLE public.carteira_assignments ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Master manage carteira" ON public.carteira_assignments FOR ALL
  USING ((SELECT public.has_role(auth.uid(),'master'))) WITH CHECK ((SELECT public.has_role(auth.uid(),'master')));
CREATE TABLE public.omie_vendedor_map (omie_codigo_vendedor bigint PRIMARY KEY, user_id uuid);
ALTER TABLE public.omie_vendedor_map ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Master manage vendedor map" ON public.omie_vendedor_map FOR ALL
  USING ((SELECT public.has_role(auth.uid(),'master'))) WITH CHECK ((SELECT public.has_role(auth.uid(),'master')));

-- Grants como na PROD: tudo para os papéis de client (a RLS é quem barra), inclusive TRUNCATE.
GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;
GRANT ALL ON public.carteira_membership_ledger, public.omie_customer_account_map, public.carteira_assignments,
  public.omie_vendedor_map, public.user_roles TO anon, authenticated, service_role;
ALTER ROLE service_role BYPASSRLS;
SQL
P -q -c "INSERT INTO public.user_roles VALUES ('$E','employee'), ('$M','master'), ('$CUST','customer');"
# C1 já tem vínculo com o vendedor 10 (linha 'rpc'); C2 com o vendedor 20; C3 não tem vínculo.
P -q -c "INSERT INTO public.carteira_membership_ledger (user_id, identity_state, source) VALUES ('$C1','verified','rpc'), ('$C2','verified','rpc');"
P -q -c "INSERT INTO public.omie_customer_account_map (user_id, account, omie_codigo_cliente, omie_codigo_vendedor, source) VALUES ('$C1','oben',101,10,'rpc'), ('$C2','oben',102,20,'rpc'), ('$CUST','oben',199,30,'rpc');"

PASS=0; FAIL=0
eq() { if [ "$2" = "$3" ]; then echo "PASS $1"; PASS=$((PASS+1)); else echo "FAIL $1 — obtido [$2] esperado [$3]"; FAIL=$((FAIL+1)); fi; }
vend() { Pq -c "SELECT coalesce(omie_codigo_vendedor::text,'null') FROM public.omie_customer_account_map WHERE user_id='$1' AND account='oben'"; }
rpc() { printf "SELECT public.register_carteira_member('%s'::uuid, 'oben', %s, %s);" "$1" "$2" "$3"; }

# ── A0: o furo de ANTES (corpo real da migration 20260821192817 + o ACL de então) ──
sed -n '169,208p' "$MIG_ANTES" > "$WORK/rpc-antes.sql"
# shellcheck disable=SC2016  # o $ é literal: casa a linha que fecha o corpo da função ($function$;)
grep -q '^\$function\$;$' "$WORK/rpc-antes.sql" || { echo "recorte da RPC de antes saiu errado"; exit 1; }
P -q -f "$WORK/rpc-antes.sql"
P -q -c "REVOKE ALL ON FUNCTION public.register_carteira_member(uuid,text,bigint,bigint) FROM PUBLIC, anon; GRANT EXECUTE ON FUNCTION public.register_carteira_member(uuid,text,bigint,bigint) TO authenticated, service_role;"
P -q -c "$(como "$E" "$(rpc "$C1" 101 777)")"
P -q -c "$(como "$E" "UPDATE public.omie_customer_account_map SET omie_codigo_vendedor = 888 WHERE user_id='$C2'")"
eq "A0 controle: ANTES, o employee trocava o vendedor pela RPC e por UPDATE direto" "$(vend "$C1")|$(vend "$C2")" "777|888"
P -q -c "UPDATE public.omie_customer_account_map SET omie_codigo_vendedor = 10 WHERE user_id='$C1'; UPDATE public.omie_customer_account_map SET omie_codigo_vendedor = 20 WHERE user_id='$C2';"

# ── aplica a migration sob teste ──
if ! P -q -f "$MIG_USADA" > "$WORK/apply.log" 2>&1; then cat "$WORK/apply.log"; echo "APLICACAO FALHOU: POST FALHOU"; exit 1; fi
grep -q "POST-OK seg_b339_vendedor_so_master" "$WORK/apply.log" || { cat "$WORK/apply.log"; echo "APLICACAO FALHOU: POST FALHOU (sem POST-OK)"; exit 1; }

# B1 employee
eq "B1a employee pela RPC na linha existente: estado verde e vendedor MANTIDO (10)" "$(estado "$(como "$E" "$(rpc "$C1" 101 777)")")|$(vend "$C1")" "verde|10"
eq "B1b employee admite cliente novo: linha criada com o codigo, SEM vendedor; ledger verified" "$(estado "$(como "$E" "$(rpc "$C3" 103 777)")")|$(Pq -c "SELECT omie_codigo_cliente FROM public.omie_customer_account_map WHERE user_id='$C3'")|$(vend "$C3")|$(Pq -c "SELECT identity_state FROM public.carteira_membership_ledger WHERE user_id='$C3'")" "verde|103|null|verified"
eq "B1c employee com claims em JSON (request.jwt.claims): vendedor tambem ignorado" "$(estado "$(como_json "$E" "$(rpc "$C1" 101 778)")")|$(vend "$C1")" "verde|10"
# B2-B4 quem pode
P -q -c "$(como "$M" "$(rpc "$C1" 101 11)")"
eq "B2 master pela RPC troca o vendedor" "$(vend "$C1")" "11"
P -q -c "$(como_sr "$(rpc "$C1" 101 12)")"
eq "B3 service_role (edges/sync) pela RPC troca o vendedor" "$(vend "$C1")" "12"
P -q -c "$(rpc "$C1" 101 13)"
eq "B4 sem JWT (cron/SQL Editor) pela RPC troca o vendedor" "$(vend "$C1")" "13"
# B5 quem não pode
eq "B5 customer pela RPC -> 42501 e nada muda; anon sem EXECUTE -> 42501" "$(estado "$(como "$CUST" "$(rpc "$CUST" 199 777)")")|$(vend "$CUST")|$(estado "$(como_anon "$(rpc "$C1" 101 777)")")" "42501|30|42501"
# B6 escrita direta
P -q -c "$(como "$E" "UPDATE public.omie_customer_account_map SET omie_codigo_vendedor = 888 WHERE user_id='$C2'")"
eq "B6a employee: UPDATE direto do vendedor nao pega linha (20 mantido); INSERT direto -> 42501" "$(vend "$C2")|$(estado "$(como "$E" "INSERT INTO public.omie_customer_account_map (user_id, account, omie_codigo_cliente, omie_codigo_vendedor) VALUES (gen_random_uuid(), 'oben', 555, 1)")")" "20|42501"
P -q -c "$(como "$M" "UPDATE public.omie_customer_account_map SET omie_codigo_vendedor = 21 WHERE user_id='$C2'")"
eq "B6 master troca o vendedor direto na tabela" "$(vend "$C2")" "21"
# B7 leitura
eq "B7 employee le o mapa inteiro (4); customer so o seu (1)" "$(Pq -c "$(como "$E" "SELECT count(*) FROM public.omie_customer_account_map")")|$(Pq -c "$(como "$CUST" "SELECT count(*) FROM public.omie_customer_account_map")")" "4|1"
# B8 ACL
eq "B8a RPC: DEFINER, search_path vazio, anon sem EXECUTE, authenticated com" "$(Pq -c "SELECT prosecdef::text||'|'||array_to_string(proconfig,',')||'|'||has_function_privilege('anon',oid,'EXECUTE')::text||'|'||has_function_privilege('authenticated',oid,'EXECUTE')::text FROM pg_proc WHERE oid='public.register_carteira_member(uuid,text,bigint,bigint)'::regprocedure")" 'true|search_path=""|false|true'
eq "B8b TRUNCATE fora de anon/authenticated e escrita fora de anon nas 3 tabelas" "$(Pq -c "SELECT bool_or(has_table_privilege(r,'public.'||t,'TRUNCATE') OR (r='anon' AND (has_table_privilege(r,'public.'||t,'INSERT') OR has_table_privilege(r,'public.'||t,'UPDATE') OR has_table_privilege(r,'public.'||t,'DELETE'))))::text FROM unnest(array['omie_customer_account_map','carteira_assignments','omie_vendedor_map','carteira_membership_ledger']) t, unnest(array['anon','authenticated']) r")" "false"
eq "B8c employee TRUNCATE direto -> 42501" "$(estado "$(como "$E" "TRUNCATE public.omie_vendedor_map")")" "42501"
# B10 ledger: o employee não exclui nem muda o estado de membro (trocaria a dona pelo rebuild)
P -q -c "$(como "$E" "DELETE FROM public.carteira_membership_ledger WHERE user_id='$C2'")"
P -q -c "$(como "$E" "UPDATE public.carteira_membership_ledger SET identity_state='ambiguous' WHERE user_id='$C1'")"
eq "B10a employee: DELETE e UPDATE do ledger nao pegam linha; INSERT direto -> 42501; le o ledger" "$(Pq -c "SELECT count(*) FROM public.carteira_membership_ledger WHERE user_id='$C2'")|$(Pq -c "SELECT identity_state FROM public.carteira_membership_ledger WHERE user_id='$C1'")|$(estado "$(como "$E" "INSERT INTO public.carteira_membership_ledger (user_id, identity_state, source) VALUES (gen_random_uuid(),'verified','rpc')")")|$(Pq -c "$(como "$E" "SELECT count(*) FROM public.carteira_membership_ledger")")" "1|verified|42501|3"
P -q -c "$(como "$M" "UPDATE public.carteira_membership_ledger SET identity_state='inactive' WHERE user_id='$C2'")"
eq "B10b master muda o estado de membro direto" "$(Pq -c "SELECT identity_state FROM public.carteira_membership_ledger WHERE user_id='$C2'")" "inactive"
# B11 TTL: chamada sem vendedor não ressuscita vínculo vencido (a view fresca é updated_at >= now() - 7 dias)
P -q -c "UPDATE public.omie_customer_account_map SET updated_at = now() - interval '10 days' WHERE user_id='$C2';"
venc() { Pq -c "SELECT (updated_at < now() - interval '7 days')::text FROM public.omie_customer_account_map WHERE user_id='$C2'"; }
P -q -c "$(como "$E" "$(rpc "$C2" 102 999)")"
eq "B11a employee pela RPC (mesmo codigo, com ou sem vendedor): vinculo vencido CONTINUA vencido" "$(venc)|$(vend "$C2")" "true|21"
P -q -c "$(como_sr "$(rpc "$C2" 102 NULL)")"
eq "B11b servidor revalida sem vendedor: o TTL renova e o vendedor fica (revalidacao legitima)" "$(venc)|$(vend "$C2")" "false|21"
# B12 permutação de códigos (Codex, 3ª rodada): employee não troca o código de vínculo existente
eq "B12 employee troca codigo de vinculo existente -> 42501 e o codigo fica; master troca" "$(estado "$(como "$E" "$(rpc "$C1" 999 NULL)")")|$(Pq -c "SELECT omie_codigo_cliente FROM public.omie_customer_account_map WHERE user_id='$C1'")|$(estado "$(como "$M" "$(rpc "$C1" 998 NULL)")")|$(Pq -c "SELECT omie_codigo_cliente FROM public.omie_customer_account_map WHERE user_id='$C1'")" "42501|101|verde|998"
# B9 idempotente
eq "B9 re-apply idempotente (POST-OK de novo)" "$(P -q -f "$MIG_USADA" 2>&1 | grep -c "POST-OK seg_b339_vendedor_so_master")" "1"

echo "PASS=$PASS FAIL=$FAIL"
[ "$FAIL" -eq 0 ] || exit 1
echo "FIM-OK seg-b339"
