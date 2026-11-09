#!/usr/bin/env bash
# Prova PG17 do CET PERSISTIDO — migration 20261031220000_fin_funding_cet_oben
# (plano Oben PME/PMR, Frente B, PR3; spec docs/superpowers/specs/2026-10-31-oben-frente-b-pedido-cobranca-cet-design.md §4).
#
#  F1  colunas novas; oben = 0,025 com fonte e data; colacor/colacor_sc ficam NULL (ausente ≠ zero)
#  F2  re-apply idempotente NÃO sobrescreve ajuste posterior (0,03 fica 0,03)
#  F3  CHECK da faixa: 0, 0,5, NaN e negativo rejeitados (23514); 0,2 aceito
#  F4  o upsert do Funding (só company+funding_inputs) NÃO apaga o CET (coluna, não chave do jsonb)
#  F5  RPC: master lê as 3 linhas; master com fin_permissoes só oben lê 1; employee/customer/anon → 42501
#  F6  ACL da RPC (anon/PUBLIC fechadas; authenticated aberta); gate em função SECDEF
#
#   bash db/test-fin-funding-cet.sh > /tmp/t.log 2>&1; echo "exit=$?"
#   bash db/test-fin-funding-cet.sh --falsificar
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MIG="$REPO_ROOT/supabase/migrations/20261031220000_fin_funding_cet_oben.sql"

if [ "${1:-}" = "--falsificar" ]; then
  SABOTAGENS="sobrescreve_ajuste:F2a sem_gate_master:F5c sem_filtro_empresa:F5b check_fora:POST!P2_FALHOU revoke_fora:POST!P5_FALHOU"
  LOGDIR="$(mktemp -d "${TMPDIR:-/tmp}/falsifica-fin-funding-cet.XXXXXX")"
  echo "══ CONTROLE ══"
  if ! SABOTAGEM="" bash "$0" > "$LOGDIR/controle.log" 2>&1; then
    echo "❌ controle VERMELHO — falsificação abortada (log: $LOGDIR/controle.log)"; tail -15 "$LOGDIR/controle.log"; exit 1
  fi
  grep -q "^FIM-OK fin-funding-cet" "$LOGDIR/controle.log" || { echo "❌ controle sem marcador de fim"; exit 1; }
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
PORT="${PGPORT_TEST:-5675}"
LOC="${LOCALE_TESTE:-C}"
export LC_ALL="$LOC" LANG="$LOC"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/pgtest-fin-funding-cet.XXXXXX")"
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
  sobrescreve_ajuste) sabotar " WHERE company = 'oben' AND custo_capital_mensal IS NULL;" " WHERE company = 'oben';" ;;
  sem_gate_master)    sabotar "  PERFORM public._fin_ciclo_gate_master();" "" ;;
  sem_filtro_empresa) sabotar "     WHERE public.fin_user_can_access(f.company)" "" ;;
  check_fora)         sabotar "ALTER TABLE public.fin_funding_inputs ADD CONSTRAINT fin_funding_inputs_custo_capital_faixa" "ALTER TABLE public.fin_funding_inputs ADD CONSTRAINT fin_funding_inputs_custo_capital_faixa_x" ;;
  revoke_fora)        sabotar "REVOKE ALL ON FUNCTION public.fin_ciclo_custo_capital() FROM PUBLIC, anon;" "" ;;
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
  printf '%s\n' "$saida" | grep -oE '[A-Z]+: +[0-9A-Z]{5}:' | head -1 | grep -oE '[0-9A-Z]{5}:$' | tr -d ':' || echo "sem-codigo"
}
M=00000000-0000-0000-0000-0000000000ee; MO=00000000-0000-0000-0000-0000000000e1; E=00000000-0000-0000-0000-0000000000a1; CUST=00000000-0000-0000-0000-0000000000cc
como() { printf "SET ROLE authenticated; SET request.jwt.claim.sub = '%s'; %s" "$1" "$2"; }

P -q <<SQL
CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN; CREATE ROLE service_role NOLOGIN BYPASSRLS;
GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON TABLES TO anon, authenticated, service_role;
CREATE SCHEMA auth; GRANT USAGE ON SCHEMA auth TO anon, authenticated, service_role;
CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS \$\$ SELECT NULLIF(current_setting('request.jwt.claim.sub', true), '')::uuid \$\$;
CREATE TYPE public.app_role AS ENUM ('employee', 'customer', 'master');
CREATE TABLE public.user_roles (user_id uuid, role public.app_role);
CREATE TABLE public.fin_permissoes_stub (user_id uuid, empresas text[]);
-- Gate e filtro como em prod (20261015003200 + fin_user_can_access): master-only; empresa pela permissão.
CREATE FUNCTION public._fin_ciclo_gate_master() RETURNS void LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS \$\$
BEGIN
  IF auth.uid() IS NULL OR NOT EXISTS (SELECT 1 FROM public.user_roles WHERE user_id = auth.uid() AND role = 'master') THEN
    RAISE EXCEPTION 'CICLO_SO_MASTER' USING ERRCODE = '42501';
  END IF;
END \$\$;
REVOKE ALL ON FUNCTION public._fin_ciclo_gate_master() FROM PUBLIC, anon, authenticated;
CREATE FUNCTION public.fin_user_can_access(check_company text) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS \$\$
  SELECT EXISTS (SELECT 1 FROM public.fin_permissoes_stub p WHERE p.user_id = auth.uid() AND check_company = ANY (p.empresas))
      OR (EXISTS (SELECT 1 FROM public.user_roles r WHERE r.user_id = auth.uid() AND r.role IN ('master','employee'))
          AND NOT EXISTS (SELECT 1 FROM public.fin_permissoes_stub p WHERE p.user_id = auth.uid()))
\$\$;
-- fin_funding_inputs como em prod (20260526100000): PK company, jsonb, master-only por RLS.
CREATE TABLE public.fin_funding_inputs (company text PRIMARY KEY, funding_inputs jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid);
ALTER TABLE public.fin_funding_inputs ENABLE ROW LEVEL SECURITY;
CREATE POLICY fin_funding_inputs_select_master ON public.fin_funding_inputs FOR SELECT
  USING (EXISTS (SELECT 1 FROM public.user_roles WHERE user_id = auth.uid() AND role = 'master'));
CREATE POLICY fin_funding_inputs_write_master ON public.fin_funding_inputs FOR ALL
  USING (EXISTS (SELECT 1 FROM public.user_roles WHERE user_id = auth.uid() AND role = 'master'))
  WITH CHECK (EXISTS (SELECT 1 FROM public.user_roles WHERE user_id = auth.uid() AND role = 'master'));
INSERT INTO public.fin_funding_inputs (company) VALUES ('colacor'), ('oben'), ('colacor_sc');
INSERT INTO public.user_roles VALUES ('$M','master'), ('$MO','master'), ('$E','employee'), ('$CUST','customer');
INSERT INTO public.fin_permissoes_stub VALUES ('$MO', ARRAY['oben']);
SQL

if ! P -q -f "$MIG_USADA" > "$WORK/apply.log" 2>&1; then cat "$WORK/apply.log"; echo "APLICACAO FALHOU"; exit 1; fi

PASS=0; FAIL=0
eq() { if [ "$2" = "$3" ]; then echo "PASS $1"; PASS=$((PASS+1)); else echo "FAIL $1 — obtido [$2] esperado [$3]"; FAIL=$((FAIL+1)); fi; }

eq "F1a oben = 0.025 com fonte e data" "$(Pq -c "SELECT custo_capital_mensal || '|' || (custo_capital_fonte IS NOT NULL) || '|' || (custo_capital_em IS NOT NULL) FROM public.fin_funding_inputs WHERE company='oben'")" "0.025|true|true"
eq "F1b colacor e colacor_sc ficam NULL (ausente, nao zero)" "$(Pq -c "SELECT string_agg(company || ':' || coalesce(custo_capital_mensal::text,'NULO'), ' ' ORDER BY company) FROM public.fin_funding_inputs WHERE company <> 'oben'")" "colacor:NULO colacor_sc:NULO"
eq "F1c funding_inputs (jsonb) intacto" "$(Pq -c "SELECT string_agg(funding_inputs::text, ' ') FROM public.fin_funding_inputs")" "{} {} {}"

P -q -c "UPDATE public.fin_funding_inputs SET custo_capital_mensal = 0.03 WHERE company='oben';"
eq "F2a re-apply nao sobrescreve o ajuste (0.03 fica)" "$(if P -q -f "$MIG_USADA" >/dev/null 2>&1; then Pq -c "SELECT custo_capital_mensal FROM public.fin_funding_inputs WHERE company='oben'"; else echo "re-apply falhou"; fi)" "0.03"
P -q -c "UPDATE public.fin_funding_inputs SET custo_capital_mensal = 0.025 WHERE company='oben';"

eq "F3a CHECK rejeita 0, 0.5, NaN, negativo (23514)" "$(estado "UPDATE public.fin_funding_inputs SET custo_capital_mensal = 0 WHERE company='colacor';")|$(estado "UPDATE public.fin_funding_inputs SET custo_capital_mensal = 0.5 WHERE company='colacor';")|$(estado "UPDATE public.fin_funding_inputs SET custo_capital_mensal = 'NaN' WHERE company='colacor';")|$(estado "UPDATE public.fin_funding_inputs SET custo_capital_mensal = -0.01 WHERE company='colacor';")" "23514|23514|23514|23514"
eq "F3b CHECK aceita 0.2 (teto) e NULL" "$(estado "UPDATE public.fin_funding_inputs SET custo_capital_mensal = 0.2 WHERE company='colacor';")|$(estado "UPDATE public.fin_funding_inputs SET custo_capital_mensal = NULL WHERE company='colacor';")" "verde|verde"

# F4 o upsert do hook do Funding regrava company+funding_inputs+updated_at: a coluna do CET sobrevive
P -q -c "$(como "$M" "INSERT INTO public.fin_funding_inputs (company, funding_inputs, updated_at) VALUES ('oben', '{\"cg_cet_perc\": 24}', now()) ON CONFLICT (company) DO UPDATE SET funding_inputs = EXCLUDED.funding_inputs, updated_at = EXCLUDED.updated_at;")"
eq "F4 upsert do Funding preserva o CET da coluna" "$(Pq -c "SELECT custo_capital_mensal || '|' || (funding_inputs->>'cg_cet_perc') FROM public.fin_funding_inputs WHERE company='oben'")" "0.025|24"

# F5 RPC
eq "F5a master le as 3 (oben com valor, outras NULL)" "$(Pq -c "$(como "$M" "SELECT string_agg(company || ':' || coalesce(custo_capital_mensal::text,'NULO'), ' ' ORDER BY company) FROM public.fin_ciclo_custo_capital()")")" "colacor:NULO colacor_sc:NULO oben:0.025"
eq "F5b master com permissao so oben le 1" "$(Pq -c "$(como "$MO" "SELECT string_agg(company, ' ') FROM public.fin_ciclo_custo_capital()")")" "oben"
eq "F5c employee -> 42501 (gate master)" "$(estado "$(como "$E" "SELECT * FROM public.fin_ciclo_custo_capital();")")" "42501"
eq "F5d customer e sem sessao -> 42501" "$(estado "$(como "$CUST" "SELECT * FROM public.fin_ciclo_custo_capital();")")|$(estado "$(como "" "SELECT * FROM public.fin_ciclo_custo_capital();")")" "42501|42501"
eq "F5e anon -> 42501" "$(estado "SET ROLE anon; SELECT * FROM public.fin_ciclo_custo_capital();")" "42501"

eq "F6 ACL: anon/PUBLIC sem EXECUTE, authenticated com" "$(Pq -c "SELECT has_function_privilege('anon','public.fin_ciclo_custo_capital()','EXECUTE')::text || has_function_privilege('public','public.fin_ciclo_custo_capital()','EXECUTE')::text || has_function_privilege('authenticated','public.fin_ciclo_custo_capital()','EXECUTE')::text")" "falsefalsetrue"

echo "PASS=$PASS FAIL=$FAIL"
[ "$FAIL" -eq 0 ] || exit 1
echo "FIM-OK fin-funding-cet"
