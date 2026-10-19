#!/usr/bin/env bash
# ╔══════════════════════════════════════════════════════════════════════════════════════════╗
# ║  HARNESS PG17 — Radar: CNPJ ALFANUMÉRICO (migration 20261019110000_radar_cnpj_alfanumerico)  ║
# ║   bash db/test-radar-cnpj-alfanumerico.sh                 (controle)                        ║
# ║   bash db/test-radar-cnpj-alfanumerico.sh --falsificar    (controle + sabotagens, cada uma   ║
# ║                                                            numa rodada própria do script)    ║
# ║                                                                                              ║
# ║  Mundo: stubs de prod + 20260610200000_radar_fundacao (função PREDECESSORA: a PRE da migration ║
# ║  exige md5(prosrc) = o de PROD, lido por psql-ro em 2026-10-19 — se o repo divergir de prod,  ║
# ║  a prova fica vermelha aqui, não na mão do founder) → a migration sob prova → asserts:        ║
# ║   A0a aplica · A0b re-aplicar é no-op (PRE aceita "este") · A0c CHECK vivo é o alfanumérico   ║
# ║   A1  CHECK: alfanumérico maiúsculo entra; minúscula, 13 posições, DV com letra → 23514        ║
# ║       (radar_empresas E radar_contatos)                                                       ║
# ║   A2  recruza: numérico com máscara / cru / com prefixo de letras (acervo) + alfanumérico      ║
# ║       minúsculo com máscara (profiles) + alfanumérico cru (omie) marcam; lead livre e          ║
# ║       "anotação + CPF" (AEG12345678909) não — letra nunca é apagada do documento              ║
# ║   A3  ACL: anon/authenticated/PUBLIC sem EXECUTE; service_role com                            ║
# ║  FALSIFICAÇÃO (idioma limpo do fiscal `falsificar-exige-assert-gate`: o vermelho que conta é   ║
# ║  o do assert DECLARADO em SABOTAGENS, nunca "a rodada saiu ≠0"), uma camada por vez:          ║
# ║   check_aceita_minuscula   CHECK afrouxado → A1b                                              ║
# ║   sem_upper                sem upper() no doc (régua de md5 neutralizada) → A2e               ║
# ║   alnum_so_digitos         caminho alnum vira só-dígitos (md5 neutralizado) → A2f             ║
# ║   corpo_sabotado_md5       corpo sabotado SEM neutralizar o md5 → A0a (a PÓS morde)           ║
# ║  A régua de md5 da PRE/PÓS é neutralizada (literal → md5 vivo) nas sabotagens SEMÂNTICAS,      ║
# ║  senão todo mutante morreria na PÓS sem exercitar o assert funcional.                          ║
# ╚══════════════════════════════════════════════════════════════════════════════════════════╝
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MIG="$REPO_ROOT/supabase/migrations/20261019110000_radar_cnpj_alfanumerico.sql"
FUND="$REPO_ROOT/supabase/migrations/20260610200000_radar_fundacao.sql"
MD5_PROD="27ccab8ed049e4403a9e4232507915a4"   # md5(prosrc) de radar_recruzar_ja_cliente() em PROD, psql-ro 2026-10-19

if [ "${1:-}" = "--falsificar" ]; then
  # <sabotagem>:<assert que TEM de acusá-la>
  SABOTAGENS="check_aceita_minuscula:A1b sem_upper:A2e alnum_so_digitos:A2f corpo_sabotado_md5:A0a"
  LOGDIR="$(mktemp -d "/tmp/falsifica-radar-alnum.XXXXXX")"
  echo "══ CONTROLE ══"
  if ! SABOTAGEM="" bash "$0" > "$LOGDIR/controle.log" 2>&1; then
    echo "❌ controle VERMELHO — falsificação abortada (log: $LOGDIR/controle.log)"; tail -15 "$LOGDIR/controle.log"; exit 1
  fi
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
    if grep -q "^FAIL $a " "$LOGDIR/$s.log"; then
      echo "✅ $s → $a vermelho: $(grep -m1 "^FAIL $a " "$LOGDIR/$s.log" | cut -c1-120)"
    else
      echo "❌ $s: vermelho, mas não no $a (log: $LOGDIR/$s.log)"; falhas=$((falhas+1))
    fi
  done
  echo "SABOTAGENS: $((n_sab - falhas)) vermelhas / $falhas falhas"   # recibo exigido por db/roda-nucleo-ci.sh
  [ "$falhas" -eq 0 ] && exit 0 || exit 1
fi

export PGVER=17
# shellcheck disable=SC1091  # caminho resolvido em runtime a partir de REPO_ROOT
. "$REPO_ROOT/db/lib/pg-harness.sh"
PORT="${PGPORT_TEST:-5499}"
TMPD="$(mktemp -d "/tmp/pgtest-radar-alnum.XXXXXX")"
DATA="$TMPD/data"
export LC_ALL=C LANG=C
MIG_USADA="$TMPD/mig.sql"
cleanup() { "$PGBIN/pg_ctl" -D "$DATA" stop -m immediate >/dev/null 2>&1 || true; rm -rf "$TMPD"; }
trap cleanup EXIT

[ -f "$MIG" ] || { echo "migration nao encontrada: $MIG"; exit 1; }
cp "$MIG" "$MIG_USADA"
sabotar() { # $1 = de, $2 = para (literal; troca TODAS as ocorrências)
  python3 -I - "$MIG_USADA" "$1" "$2" <<'PY'
import sys
p, de, para = sys.argv[1:]
s = open(p, encoding="utf-8").read()
if de not in s:
    sys.exit("padrao ausente: " + de)
open(p, "w", encoding="utf-8").write(s.replace(de, para))
PY
}
# A régua de md5 "este" da PRE/PÓS: o literal de 32 hex que aparece em `IS DISTINCT FROM '<md5>'`.
ESTE_MD5="$(grep -oE "IS DISTINCT FROM '[0-9a-f]{32}'" "$MIG" | grep -oE '[0-9a-f]{32}' | head -1)"
MD5_VIVO="(SELECT md5(q.prosrc) FROM pg_catalog.pg_proc q WHERE q.oid = to_regprocedure('public.radar_recruzar_ja_cliente()'))"
case "${SABOTAGEM:-}" in
  "") ;;
  check_aceita_minuscula) sabotar "cnpj ~ '^[0-9A-Z]{12}[0-9]{2}\$'" "cnpj ~ '^[0-9A-Za-z]{12}[0-9]{2}\$'"
                          sabotar "cnpj ~ ''^[0-9A-Z]{12}[0-9]{2}\$''" "cnpj ~ ''^[0-9A-Za-z]{12}[0-9]{2}\$''" ;;
  sem_upper)              sabotar "btrim(upper(bruto))" "btrim(bruto)"; sabotar "'$ESTE_MD5'" "$MD5_VIVO" ;;
  alnum_so_digitos)       sabotar "'[-./]'" "'[^0-9]'"; sabotar "'$ESTE_MD5'" "$MD5_VIVO" ;;
  corpo_sabotado_md5)     sabotar "btrim(upper(bruto))" "btrim(bruto)" ;;
  *) echo "sabotagem desconhecida: $SABOTAGEM"; exit 9 ;;
esac
[ -n "${SABOTAGEM:-}" ] && echo "⚠️  SABOTAGEM ATIVA: $SABOTAGEM"

"$PGBIN/initdb" -D "$DATA" -U postgres -A trust -E UTF8 --locale=C >/dev/null
"$PGBIN/pg_ctl" -D "$DATA" -o "-p $PORT -k /tmp" -l "$TMPD/pg.log" -w start >/dev/null
"$PGBIN/createdb" -p "$PORT" -h /tmp -U postgres prova
P()  { "$PGBIN/psql" -X -h /tmp -p "$PORT" -U postgres -d prova -v ON_ERROR_STOP=1 -q "$@"; }
Pq() { P -tA "$@"; }

PASS=0; FAIL=0
ok()  { PASS=$((PASS+1)); echo "  ✅ $1 $2"; }
bad() { FAIL=$((FAIL+1)); echo "FAIL $1 $2"; }
# eq ID descrição valor esperado
eq()  { if [ "$3" = "$4" ]; then ok "$1" "$2 (=$3)"; else bad "$1" "$2 — esperado [$4], veio [$3]"; fi; }
# Mensagem de erro de um INSERT que deve falhar (vazia se passou). O assert casa a constraint NOMEADA:
# "falhou com algo" (FK 23503, sintaxe) não prova o CHECK.
erro_de() { P -c "$1" 2>&1 >/dev/null | grep -oE 'violates check constraint "[a-z_]+"' | head -1 || true; }

P <<'SQL'
CREATE SCHEMA IF NOT EXISTS auth;
CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE
  AS $$ SELECT NULLIF(current_setting('test.uid', true), '')::uuid $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN CREATE ROLE authenticated NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='anon') THEN CREATE ROLE anon NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN CREATE ROLE service_role NOLOGIN BYPASSRLS; END IF;
END $$;
CREATE TABLE public.profiles (id uuid PRIMARY KEY, document text);
CREATE TABLE public.omie_clientes_nao_vinculados (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), cnpj_cpf text);
CREATE TABLE public.test_gestores (uid uuid PRIMARY KEY);
CREATE OR REPLACE FUNCTION public.pode_ver_carteira_completa(p uuid) RETURNS boolean
  LANGUAGE sql STABLE AS $$ SELECT EXISTS (SELECT 1 FROM public.test_gestores WHERE uid = p) $$;
GRANT USAGE ON SCHEMA public TO authenticated, anon, service_role;
SQL
P -f "$FUND" >/dev/null
P <<'SQL'
GRANT ALL ON ALL TABLES IN SCHEMA public TO authenticated, service_role;
-- Documentos de cliente como humanos/ERP os gravam:
INSERT INTO public.profiles VALUES
  ('00000000-0000-0000-0000-000000000001', '11.222.333/0001-81'),        -- numérico com máscara (acervo)
  ('00000000-0000-0000-0000-000000000002', 'CNPJ: 22.333.444/0001-81'),  -- numérico com PREFIXO de letras (acervo: só-dígitos casa)
  ('00000000-0000-0000-0000-000000000003', '12.abc.345/01de-35'),        -- alfanumérico MINÚSCULO com máscara (exemplo oficial RFB)
  ('00000000-0000-0000-0000-000000000004', 'aeg 123.456.789-09');       -- CPF com ANOTAÇÃO (contraexemplo Codex): NÃO pode virar chave AEG12345678909
INSERT INTO public.omie_clientes_nao_vinculados (cnpj_cpf) VALUES
  ('55666777000181'),   -- numérico cru (acervo)
  ('A1B2C3D4E5F668');   -- alfanumérico cru maiúsculo
SQL

echo "── A0 aplicação"
eq A0p "predecessor local = PROD (md5 prosrc)" "$(Pq -c "SELECT md5(prosrc) FROM pg_proc WHERE oid=to_regprocedure('public.radar_recruzar_ja_cliente()')")" "$MD5_PROD"
if P -f "$MIG_USADA" >"$TMPD/apply.log" 2>&1; then ok A0a "migration aplica"; else bad A0a "migration abortou: $(grep -m1 -E 'ERROR|ERRO' "$TMPD/apply.log" | cut -c1-160)"; fi
if P -f "$MIG_USADA" >"$TMPD/apply2.log" 2>&1; then ok A0b "re-aplicar é no-op (PRE aceita 'este')"; else bad A0b "re-aplicar abortou: $(grep -m1 -E 'ERROR|ERRO' "$TMPD/apply2.log" | cut -c1-160)"; fi
eq A0c "CHECK vivo de radar_empresas é o alfanumérico" "$(Pq -c "SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conrelid='public.radar_empresas'::regclass AND conname='radar_empresas_cnpj_check'")" "CHECK ((cnpj ~ '^[0-9A-Z]{12}[0-9]{2}\$'::text))"

echo "── A1 CHECK"
if P -c "INSERT INTO public.radar_empresas (cnpj, cnae_principal, ultimo_lote, razao_social) VALUES ('12ABC34501DE35','3101200','2026-10','ALNUM OK')" >/dev/null 2>&1; then ok A1a "alfanumérico maiúsculo entra"; else bad A1a "alfanumérico maiúsculo rejeitado"; fi
eq A1b "minúscula → check_violation do CHECK de empresas" "$(erro_de "INSERT INTO public.radar_empresas (cnpj, cnae_principal, ultimo_lote) VALUES ('12abc34501DE35','3101200','2026-10')")" 'violates check constraint "radar_empresas_cnpj_check"'
eq A1c "13 posições → check_violation" "$(erro_de "INSERT INTO public.radar_empresas (cnpj, cnae_principal, ultimo_lote) VALUES ('12ABC34501DE3','3101200','2026-10')")" 'violates check constraint "radar_empresas_cnpj_check"'
eq A1d "DV com letra → check_violation" "$(erro_de "INSERT INTO public.radar_empresas (cnpj, cnae_principal, ultimo_lote) VALUES ('12ABC34501DE3A','3101200','2026-10')")" 'violates check constraint "radar_empresas_cnpj_check"'
eq A1e "radar_contatos: minúscula → CHECK próprio (antes da FK)" "$(erro_de "INSERT INTO public.radar_contatos (cnpj, acao, criado_por) VALUES ('12abc34501DE35','a_contatar','00000000-0000-0000-0000-00000000aaaa')")" 'violates check constraint "radar_contatos_cnpj_check"'
if P -c "INSERT INTO public.radar_contatos (cnpj, acao, criado_por) VALUES ('12ABC34501DE35','a_contatar','00000000-0000-0000-0000-00000000aaaa')" >/dev/null 2>&1; then ok A1f "radar_contatos aceita alfanumérico do pai"; else bad A1f "radar_contatos rejeitou alfanumérico válido"; fi

echo "── A2 recruza"
P -c "INSERT INTO public.radar_empresas (cnpj, cnae_principal, ultimo_lote, razao_social) VALUES
  ('11222333000181','3101200','2026-10','NUM VIA PROFILE MASCARA'),
  ('22333444000181','3101200','2026-10','NUM VIA PROFILE COM PREFIXO'),
  ('55666777000181','3101200','2026-10','NUM VIA OMIE CRU'),
  ('A1B2C3D4E5F668','3101200','2026-10','ALNUM VIA OMIE CRU'),
  ('99888777000100','3101200','2026-10','LEAD LIVRE'),
  ('AEG12345678909','3101200','2026-10','LEAD QUE COINCIDE COM ANOTACAO+CPF')" >/dev/null
eq A2a "marcados (5 clientes; 12ABC34501DE35 já está no radar via A1)" "$(Pq -c "SELECT public.radar_recruzar_ja_cliente()")" "5"
eq A2b "numérico com máscara marcou" "$(Pq -c "SELECT ja_cliente FROM public.radar_empresas WHERE cnpj='11222333000181'")" "t"
eq A2c "numérico com prefixo de letras marcou (acervo intocado)" "$(Pq -c "SELECT ja_cliente FROM public.radar_empresas WHERE cnpj='22333444000181'")" "t"
eq A2d "numérico cru (omie) marcou" "$(Pq -c "SELECT ja_cliente FROM public.radar_empresas WHERE cnpj='55666777000181'")" "t"
eq A2e "alfanumérico MINÚSCULO com máscara (profile) marcou" "$(Pq -c "SELECT ja_cliente FROM public.radar_empresas WHERE cnpj='12ABC34501DE35'")" "t"
eq A2f "alfanumérico cru (omie) marcou" "$(Pq -c "SELECT ja_cliente FROM public.radar_empresas WHERE cnpj='A1B2C3D4E5F668'")" "t"
eq A2g "lead livre NÃO marcou" "$(Pq -c "SELECT ja_cliente FROM public.radar_empresas WHERE cnpj='99888777000100'")" "f"
eq A2h "anotação+CPF NÃO vira chave alfanumérica (letra nunca é apagada)" "$(Pq -c "SELECT ja_cliente FROM public.radar_empresas WHERE cnpj='AEG12345678909'")" "f"
eq A2i "2ª passada marca 0 (idempotente)" "$(Pq -c "SELECT public.radar_recruzar_ja_cliente()")" "0"

echo "── A3 ACL"
eq A3a "anon sem EXECUTE" "$(Pq -c "SELECT has_function_privilege('anon','public.radar_recruzar_ja_cliente()','EXECUTE')")" "f"
eq A3b "authenticated sem EXECUTE" "$(Pq -c "SELECT has_function_privilege('authenticated','public.radar_recruzar_ja_cliente()','EXECUTE')")" "f"
eq A3c "PUBLIC sem EXECUTE" "$(Pq -c "SELECT has_function_privilege('public','public.radar_recruzar_ja_cliente()','EXECUTE')")" "f"
eq A3d "service_role com EXECUTE" "$(Pq -c "SELECT has_function_privilege('service_role','public.radar_recruzar_ja_cliente()','EXECUTE')")" "t"

echo "PASS=$PASS  FAIL=$FAIL"
[ "$FAIL" -eq 0 ] && echo "✅ test-radar-cnpj-alfanumerico: todos os asserts passaram"
[ "$FAIL" -eq 0 ]
