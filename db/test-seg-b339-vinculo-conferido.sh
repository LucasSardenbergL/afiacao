#!/usr/bin/env bash
# Prova PG17 do risco residual do b339bb5b — o vínculo NOVO do employee só vale com o código conferido
# na Omie pelo servidor. Migration sob teste: supabase/migrations/20261116180000_seg_b339_vinculo_conferido.sql
# (aplicada por cima da 20261116090000, que é o estado da PROD).
#
# O que prova EXECUTANDO, sob SET ROLE + GUC de JWT (como o PostgREST):
#  A0  CONTROLE do furo, com a RPC do #3912: o employee cria vínculo novo com o código de OUTRO cliente.
#  B1  employee pela RPC, vínculo novo → 42501 e nada gravado (claims avulsas e em JSON)
#  B2  employee pela RPC, mesmo código → verde SEM escrita (source, evidência e TTL intactos; Codex)
#  B3  employee pela RPC, código diferente do vínculo existente → 42501
#  B4  master e servidor pela RPC seguem gravando vínculo novo
#  B5  admitir_vinculo_conferido: employee e anon sem EXECUTE → 42501
#  B6  servidor admite com o documento da Omie igual ao do cadastro (máscara diferente) → 'admitido',
#      sem vendedor, com a evidência conferida, ledger verified
#  B7  documento da Omie de OUTRO cliente → VC001, nada gravado
#  B8  outro cadastro com o mesmo documento → VC002
#  B9  cadastro sem documento → VC003; Omie sem documento → VC003
#  B10 código já vinculado a outro cadastro → 23505 e a linha dele intacta
#  B11 mesma admissão de novo → 'ja_vinculado' sem renovar o TTL
#  B12 cadastro já vinculado a outro código → 42501
#  B13 sem JWT (SQL Editor) admite; ACL e re-apply idempotente
#
#   bash db/test-seg-b339-vinculo-conferido.sh > /tmp/t.log 2>&1; echo "exit=$?"
#   LOCALE_TESTE=pt_BR.UTF-8 bash db/test-seg-b339-vinculo-conferido.sh
#   bash db/test-seg-b339-vinculo-conferido.sh --falsificar
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MIG="$REPO_ROOT/supabase/migrations/20261116180000_seg_b339_vinculo_conferido.sql"
MIG_ANTES="$REPO_ROOT/supabase/migrations/20261116090000_seg_b339_vendedor_so_master.sql"
MIG_DOC="$REPO_ROOT/supabase/migrations/20261019140000_omie_identidade_cnpj_alfanumerico.sql"

if [ "${1:-}" = "--falsificar" ]; then
  SABOTAGENS="employee_grava_novo:B1a employee_mesmo_codigo_escreve:B2 employee_troca_codigo:B3 doc_diverge_passa:B7 duplicado_passa:B8 omie_sem_doc_passa:B9b colisao_vira_ja_vinculado:B10 outro_codigo_passa:B12 authenticated_executa:POST!POST_FALHOU"
  LOGDIR="$(mktemp -d "${TMPDIR:-/tmp}/falsifica-b339vc.XXXXXX")"
  echo "══ CONTROLE ══"
  if ! SABOTAGEM="" bash "$0" > "$LOGDIR/controle.log" 2>&1; then
    echo "❌ controle VERMELHO — falsificação abortada (log: $LOGDIR/controle.log)"; tail -15 "$LOGDIR/controle.log"; exit 1
  fi
  grep -q "^FIM-OK seg-b339-vinculo-conferido" "$LOGDIR/controle.log" || { echo "❌ controle sem marcador de fim"; exit 1; }
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
PORT="${PGPORT_TEST:-5692}"
LOC="${LOCALE_TESTE:-C}"
export LC_ALL="$LOC" LANG="$LOC"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/pgtest-b339vc.XXXXXX")"
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
open(p, "w", encoding="utf-8").write(s.replace(de, para, 1))
PY
}
# Cada sabotagem abre UMA camada e mantém a postcondição de pé (os marcadores de texto continuam no
# corpo), para que o vermelho venha do COMPORTAMENTO — exceto authenticated_executa, que é a do ACL.
# employee_grava_novo abre DUAS travas: sabotar só o `IF NOT FOUND` fica VERDE (medido), porque o
# `IS DISTINCT FROM` com código atual NULL também barra o vínculo novo com 42501 — 2ª camada, redundante.
case "${SABOTAGEM:-}" in
  '') ;;
  employee_grava_novo)       sabotar "    IF NOT FOUND THEN
      RAISE EXCEPTION 'register_carteira_member: vínculo novo do employee" "    IF false THEN
      RAISE EXCEPTION 'register_carteira_member: vínculo novo do employee" ; sabotar "    ELSIF v_codigo_atual IS DISTINCT FROM p_omie_codigo_cliente THEN" "    ELSIF v_codigo_atual <> p_omie_codigo_cliente THEN" ; sabotar "    RETURN;  -- employee: mesmo código, sem escrita" "    IF FOUND THEN RETURN; END IF;  -- RETURN;  -- employee: mesmo código, sem escrita" ;;
  employee_mesmo_codigo_escreve) sabotar "    RETURN;  -- employee: mesmo código, sem escrita" "    NULL;  -- RETURN;  -- employee: mesmo código, sem escrita" ;;
  employee_troca_codigo)     sabotar "    ELSIF v_codigo_atual IS DISTINCT FROM p_omie_codigo_cliente THEN" "    ELSIF false THEN" ;;
  doc_diverge_passa)         sabotar "  IF v_doc_local <> v_doc_omie THEN" "  IF false THEN" ;;
  duplicado_passa)           sabotar "  IF EXISTS (SELECT 1 FROM public.profiles p" "  IF false AND EXISTS (SELECT 1 FROM public.profiles p" ;;
  omie_sem_doc_passa)        sabotar "  IF v_doc_omie IS NULL OR length(v_doc_omie) < 11 THEN" "  IF false THEN" ;;
  colisao_vira_ja_vinculado) sabotar "  EXCEPTION WHEN unique_violation THEN" "  EXCEPTION WHEN unique_violation THEN
    RETURN 'ja_vinculado';" ;;
  outro_codigo_passa)        sabotar "  IF FOUND THEN
    IF v_codigo_atual = p_omie_codigo_cliente THEN" "  IF FOUND AND v_codigo_atual = p_omie_codigo_cliente THEN
    IF true THEN" ;;
  authenticated_executa)     sabotar "GRANT EXECUTE ON FUNCTION public.admitir_vinculo_conferido(uuid, text, bigint, text) TO service_role;" "GRANT EXECUTE ON FUNCTION public.admitir_vinculo_conferido(uuid, text, bigint, text) TO service_role, authenticated;" ;;
  *) echo "sabotagem desconhecida: $SABOTAGEM"; exit 2 ;;
esac
[ -z "${SABOTAGEM:-}" ] || echo "SABOTAGEM ATIVA: $SABOTAGEM"

"$PGBIN/initdb" -D "$DATA" -U postgres -E UTF8 --locale="$LOC" >/dev/null
"$PGBIN/pg_ctl" -D "$DATA" -o "-p $PORT -k /tmp" -l "$WORK/pg.log" -w start >/dev/null
P()  { "$PGBIN/psql" -X -v ON_ERROR_STOP=1 -p "$PORT" -h /tmp -U postgres -d postgres "$@"; }
Pq() { P -qAt "$@"; }
estado() {
  local saida
  if saida="$(P -qAt -v VERBOSITY=verbose -c "$1" 2>&1)"; then printf '%s\n' "$saida" | tail -1; return; fi
  printf '%s\n' "$saida" | grep -oE '[A-Z]+: +[0-9A-Z]{5}:' | sed -n 1p | grep -oE '[0-9A-Z]{5}:$' | tr -d ':' || echo "sem-codigo"
}
como()      { printf "SET ROLE authenticated; SET request.jwt.claim.sub = '%s'; SET request.jwt.claim.role = 'authenticated'; %s" "$1" "$2"; }
como_json() { printf "SET ROLE authenticated; SET request.jwt.claims = '{\"sub\":\"%s\",\"role\":\"authenticated\"}'; %s" "$1" "$2"; }
como_sr()   { printf "SET ROLE service_role; SET request.jwt.claim.role = 'service_role'; %s" "$1"; }
como_anon() { printf "SET ROLE anon; SET request.jwt.claim.role = 'anon'; %s" "$1"; }

E=00000000-0000-0000-0000-0000000000e1; M=00000000-0000-0000-0000-0000000000ee
V=00000000-0000-0000-0000-000000000c0a   # cliente com dona: código 500 na Omie, doc 11.222.333/0001-81
U=00000000-0000-0000-0000-000000000c0b   # cliente novo: doc 22.333.444/0001-90
W=00000000-0000-0000-0000-000000000c0c   # cliente com vínculo e evidência: código 600
S=00000000-0000-0000-0000-000000000c0d   # cadastro sem documento
D1=00000000-0000-0000-0000-000000000c0e; D2=00000000-0000-0000-0000-000000000c0f  # mesmo documento, máscaras diferentes
N=00000000-0000-0000-0000-000000000c10   # outro cliente novo (para o master/servidor)

P -q -f "$REPO_ROOT/db/stubs-supabase.sql"
P -q <<'SQL'
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

CREATE TABLE public.profiles (user_id uuid PRIMARY KEY, document text, created_at timestamptz NOT NULL DEFAULT now());

-- Estrutura como na PROD (psql-ro, 2026-11-16), só as colunas que as funções tocam.
CREATE TABLE public.carteira_membership_ledger (
  user_id uuid PRIMARY KEY,
  identity_state text NOT NULL CHECK (identity_state IN ('verified','ambiguous','inactive','conflict')),
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  source text NOT NULL CHECK (source IN ('backfill','trigger','rpc','sync')),
  updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.carteira_membership_ledger ENABLE ROW LEVEL SECURITY;
CREATE TABLE public.omie_customer_account_map (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  account text NOT NULL CONSTRAINT chk_ocam_account CHECK (account IN ('oben','colacor','colacor_sc')),
  omie_codigo_cliente bigint NOT NULL,
  omie_codigo_vendedor bigint,
  source text NOT NULL DEFAULT 'rpc' CONSTRAINT chk_ocam_source CHECK (source IN ('document','code','manual','rpc')),
  evidence_document_normalized text CONSTRAINT ocam_evidence_document_normalizado_chk
    CHECK (evidence_document_normalized IS NULL OR evidence_document_normalized ~ '^([0-9]{11,}|[0-9A-Z]{12}[0-9]{2})$'),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_ocam_user_account UNIQUE (user_id, account),
  CONSTRAINT uq_ocam_codigo_account UNIQUE (omie_codigo_cliente, account)
);
ALTER TABLE public.omie_customer_account_map ENABLE ROW LEVEL SECURITY;
CREATE TABLE public.carteira_assignments (customer_user_id uuid PRIMARY KEY, owner_user_id uuid);
CREATE TABLE public.omie_vendedor_map (omie_codigo_vendedor bigint PRIMARY KEY, user_id uuid);
GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;
GRANT ALL ON public.carteira_membership_ledger, public.omie_customer_account_map, public.carteira_assignments,
  public.omie_vendedor_map, public.user_roles, public.profiles TO anon, authenticated, service_role;
ALTER ROLE service_role BYPASSRLS;
SQL
# normalizar_documento e cnpj_alfanumerico_valido: o corpo real da migration que os criou.
sed -n '/^CREATE OR REPLACE FUNCTION public.cnpj_alfanumerico_valido/,/^GRANT  EXECUTE ON FUNCTION public.normalizar_documento/p' "$MIG_DOC" > "$WORK/doc.sql"
grep -q 'FUNCTION public.normalizar_documento' "$WORK/doc.sql" || { echo "recorte de normalizar_documento saiu errado"; exit 1; }
P -q -f "$WORK/doc.sql"
# Estado da PROD: a migration do #3912.
P -q -f "$MIG_ANTES" > "$WORK/antes.log" 2>&1 || { cat "$WORK/antes.log"; echo "migration de antes falhou"; exit 1; }
grep -q "POST-OK seg_b339_vendedor_so_master" "$WORK/antes.log" || { cat "$WORK/antes.log"; exit 1; }

P -q -c "INSERT INTO public.user_roles VALUES ('$E','employee'), ('$M','master');"
P -q -c "INSERT INTO public.profiles (user_id, document) VALUES ('$V','11.222.333/0001-81'), ('$U','22.333.444/0001-90'), ('$W','33444555000172'), ('$S',NULL), ('$D1','44.555.666/0001-01'), ('$D2','44555666000101'), ('$N','55666777000188');"
P -q -c "INSERT INTO public.carteira_membership_ledger (user_id, identity_state, source) VALUES ('$V','verified','rpc'), ('$W','verified','sync');"
# V tem dona (vendedor 10) na conta oben, num código antigo; o código que a Omie usa hoje para V é 500.
P -q -c "INSERT INTO public.omie_customer_account_map (user_id, account, omie_codigo_cliente, omie_codigo_vendedor, source, evidence_document_normalized, updated_at) VALUES ('$V','oben',499,10,'document','11222333000181', now() - interval '1 day'), ('$W','oben',600,20,'document','33444555000172', now() - interval '2 days');"

PASS=0; FAIL=0
eq() { if [ "$2" = "$3" ]; then echo "PASS $1"; PASS=$((PASS+1)); else echo "FAIL $1 — obtido [$2] esperado [$3]"; FAIL=$((FAIL+1)); fi; }
rpc() { printf "SELECT public.register_carteira_member('%s'::uuid, 'oben', %s, NULL);" "$1" "$2"; }
adm() { printf "SELECT public.admitir_vinculo_conferido('%s'::uuid, 'oben', %s, %s);" "$1" "$2" "$3"; }
linha() { Pq -c "SELECT coalesce(string_agg(omie_codigo_cliente||'/'||coalesce(omie_codigo_vendedor::text,'null')||'/'||source||'/'||coalesce(evidence_document_normalized,'null'), ','),'nenhuma') FROM public.omie_customer_account_map WHERE user_id='$1' AND account='oben'"; }

# ── A0: o furo de ANTES (a RPC do #3912, que é a da PROD) ──
eq "A0 controle: ANTES, o employee criava vinculo novo com o codigo de OUTRO cliente (500 = V na Omie)" "$(estado "$(como "$E" "$(rpc "$U" 500)")")|$(linha "$U")" "|500/null/rpc/null"
P -q -c "DELETE FROM public.omie_customer_account_map WHERE user_id='$U'; DELETE FROM public.carteira_membership_ledger WHERE user_id='$U';"

# ── aplica a migration sob teste ──
if ! P -q -f "$MIG_USADA" > "$WORK/apply.log" 2>&1; then cat "$WORK/apply.log"; echo "APLICACAO FALHOU: POST FALHOU"; exit 1; fi
grep -q "POST-OK seg_b339_vinculo_conferido" "$WORK/apply.log" || { cat "$WORK/apply.log"; echo "APLICACAO FALHOU: POST FALHOU (sem POST-OK)"; exit 1; }

eq "B1a employee pela RPC, vinculo novo -> 42501 e nada gravado (mapa e ledger)" "$(estado "$(como "$E" "$(rpc "$U" 500)")")|$(linha "$U")|$(Pq -c "SELECT count(*) FROM public.carteira_membership_ledger WHERE user_id='$U'")" "42501|nenhuma|0"
eq "B1b employee com claims em JSON, vinculo novo -> 42501" "$(estado "$(como_json "$E" "$(rpc "$U" 501)")")|$(linha "$U")" "42501|nenhuma"
TTL_W="$(Pq -c "SELECT updated_at FROM public.omie_customer_account_map WHERE user_id='$W'")"
eq "B2 employee pela RPC, mesmo codigo -> verde SEM escrita (source/evidencia/TTL intactos)" "[$(estado "$(como "$E" "$(rpc "$W" 600)")")]|$(linha "$W")|$(Pq -c "SELECT (updated_at = '$TTL_W'::timestamptz)::text FROM public.omie_customer_account_map WHERE user_id='$W'")" "[]|600/20/document/33444555000172|true"
eq "B3 employee pela RPC, codigo diferente do vinculo existente -> 42501 e o codigo fica" "$(estado "$(como "$E" "$(rpc "$W" 601)")")|$(linha "$W")" "42501|600/20/document/33444555000172"
P -q -c "$(como "$M" "$(rpc "$N" 700)")"
P -q -c "$(como_sr "SELECT public.register_carteira_member('$N'::uuid, 'colacor', 701, NULL);")"
eq "B4 master e servidor pela RPC seguem gravando vinculo novo" "$(linha "$N")|$(Pq -c "SELECT omie_codigo_cliente FROM public.omie_customer_account_map WHERE user_id='$N' AND account='colacor'")" "700/null/rpc/null|701"
eq "B5 admitir_vinculo_conferido: employee e anon sem EXECUTE -> 42501" "$(estado "$(como "$E" "$(adm "$U" 800 "'22333444000190'")")")|$(estado "$(como_anon "$(adm "$U" 800 "'22333444000190'")")")|$(linha "$U")" "42501|42501|nenhuma"
eq "B7 Omie diz que o codigo 500 e de OUTRO documento (o de V) -> VC001, nada gravado" "$(estado "$(como_sr "$(adm "$U" 500 "'11222333000181'")")")|$(linha "$U")|$(linha "$V")" "VC001|nenhuma|499/10/document/11222333000181"
eq "B6 servidor admite com o documento da Omie = cadastro (mascara diferente) -> admitido, sem vendedor, com evidencia, ledger verified" "$(estado "$(como_sr "$(adm "$U" 800 "'22333444000190'")")")|$(linha "$U")|$(Pq -c "SELECT identity_state||'/'||source FROM public.carteira_membership_ledger WHERE user_id='$U'")" "admitido|800/null/rpc/22333444000190|verified/rpc"
eq "B8 outro cadastro com o mesmo documento (outra mascara) -> VC002" "$(estado "$(como_sr "$(adm "$D1" 900 "'44555666000101'")")")|$(linha "$D1")" "VC002|nenhuma"
eq "B9a cadastro sem documento -> VC003" "$(estado "$(como_sr "$(adm "$S" 901 "'55666777000188'")")")|$(linha "$S")" "VC003|nenhuma"
eq "B9b Omie sem documento para o codigo -> VC003" "$(estado "$(como_sr "$(adm "$N" 902 "NULL")")")|$(estado "$(como_sr "SELECT public.admitir_vinculo_conferido('$S'::uuid, 'colacor_sc', 903, '');")")|$(linha "$S")" "VC003|VC003|nenhuma"
P -q -c "INSERT INTO public.profiles (user_id, document) VALUES ('00000000-0000-0000-0000-000000000c11','66777888000140');"
eq "B10 codigo ja vinculado a OUTRO cadastro (600 = W) -> 23505 e a linha de W intacta" "$(estado "$(como_sr "SELECT public.admitir_vinculo_conferido('00000000-0000-0000-0000-000000000c11'::uuid, 'oben', 600, '66777888000140');")")|$(linha "$W")" "23505|600/20/document/33444555000172"
P -q -c "UPDATE public.omie_customer_account_map SET updated_at = now() - interval '3 days' WHERE user_id='$U' AND account='oben';"
TTL_U="$(Pq -c "SELECT updated_at FROM public.omie_customer_account_map WHERE user_id='$U' AND account='oben'")"
eq "B11 mesma admissao de novo -> ja_vinculado sem renovar o TTL" "$(estado "$(como_sr "$(adm "$U" 800 "'22.333.444/0001-90'")")")|$(Pq -c "SELECT (updated_at = '$TTL_U'::timestamptz)::text FROM public.omie_customer_account_map WHERE user_id='$U' AND account='oben'")" "ja_vinculado|true"
eq "B12 cadastro ja vinculado a outro codigo -> 42501 e o codigo fica" "$(estado "$(como_sr "$(adm "$U" 801 "'22333444000190'")")")|$(linha "$U")" "42501|800/null/rpc/22333444000190"
eq "B13a sem JWT (SQL Editor) admite" "$(estado "SELECT public.admitir_vinculo_conferido('$W'::uuid, 'colacor_sc', 1000, '33444555000172');")" "admitido"
eq "B13b ACL: admitir DEFINER, search_path vazio, so service_role executa" "$(Pq -c "SELECT prosecdef::text||'|'||array_to_string(proconfig,',')||'|'||has_function_privilege('anon',oid,'EXECUTE')::text||'|'||has_function_privilege('authenticated',oid,'EXECUTE')::text||'|'||has_function_privilege('service_role',oid,'EXECUTE')::text FROM pg_proc WHERE oid='public.admitir_vinculo_conferido(uuid,text,bigint,text)'::regprocedure")" 'true|search_path=""|false|false|true'
eq "B13c re-apply idempotente (POST-OK de novo)" "$(P -q -f "$MIG_USADA" 2>&1 | grep -c "POST-OK seg_b339_vinculo_conferido")" "1"

echo "PASS=$PASS FAIL=$FAIL"
[ "$FAIL" -eq 0 ] || exit 1
echo "FIM-OK seg-b339-vinculo-conferido"
