#!/usr/bin/env bash
# ╔══════════════════════════════════════════════════════════════════════════════════════════════╗
# ║  HARNESS PG17 — Radar: o byte que o ESCRITOR grava é o byte que o recruzar MARCA               ║
# ║   bash db/test-radar-recruzar-origem-omie.sh                                                   ║
# ║   bash db/test-radar-recruzar-origem-omie.sh --falsificar                                      ║
# ║                                                                                                ║
# ║  Fecha o achado ALTO do Codex no #3175: o recruzar (migration 20261019110000) aceita letra,    ║
# ║  mas os escritores de `omie_clientes_nao_vinculados.cnpj_cpf` e `profiles.document` faziam     ║
# ║  `.replace(/\D/g,"")` ANTES de gravar — o CNPJ alfanumérico chegava ao banco sem as letras e   ║
# ║  nunca casava. O zero medido na TABELA (0 docs com letra) não provava zero na ORIGEM.          ║
# ║                                                                                                ║
# ║  Contrato de 2 pontas, com o MESMO literal nas duas:                                           ║
# ║   · Deno: `_shared/cnpj-alfanumerico_test.ts` prova que normalizarDocumento("12.ABC.345/01DE-35")║
# ║     emite `12ABC34501DE35` (e que o só-dígitos antigo emitia `123450135`, 9 dígitos).          ║
# ║   · SQL (este): semeia esses DOIS bytes em `omie_clientes_nao_vinculados.cnpj_cpf` e prova que ║
# ║     só o preservado marca o lead `12ABC34501DE35`; o mutilado não marca nada (B1 = o bug).     ║
# ║   Numérico (B3) segue marcando — o caminho byte-idêntico não mudou.                            ║
# ║                                                                                                ║
# ║  FALSIFICAÇÃO: cada sabotagem tem o assert que TEM de acusá-la; vermelho em outro = falha.     ║
# ╚══════════════════════════════════════════════════════════════════════════════════════════════╝
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MIG="$REPO_ROOT/supabase/migrations/20261019110000_radar_cnpj_alfanumerico.sql"
FUND="$REPO_ROOT/supabase/migrations/20260610200000_radar_fundacao.sql"
# O byte que o escritor emite para o exemplo OFICIAL da RFB (12.ABC.345/01DE-35) — fixado em
# `supabase/functions/_shared/cnpj-alfanumerico_test.ts`. O 2º é o que o `.replace(/\D/g,"")` antigo emitia.
DOC_PRESERVADO="12ABC34501DE35"
DOC_MUTILADO="123450135"

if [ "${1:-}" = "--falsificar" ]; then
  # <sabotagem>:<assert que TEM de acusá-la>
  SABOTAGENS="alnum_so_digitos:B2a sem_upper_nao_afeta_escritor:B2c"
  LOGDIR="$(mktemp -d "/tmp/falsifica-radar-origem.XXXXXX")"
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
PORT="${PGPORT_TEST:-5498}"
TMPD="$(mktemp -d "/tmp/pgtest-radar-origem.XXXXXX")"
DATA="$TMPD/data"
export LC_ALL=C LANG=C
MIG_USADA="$TMPD/mig.sql"
cleanup() { "$PGBIN/pg_ctl" -D "$DATA" stop -m immediate >/dev/null 2>&1 || true; rm -rf "$TMPD"; }
trap cleanup EXIT

[ -f "$MIG" ]  || { echo "migration nao encontrada: $MIG (o #3175 precisa estar na main)"; exit 1; }
[ -f "$FUND" ] || { echo "migration nao encontrada: $FUND"; exit 1; }
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
# A régua de md5 "este" da PRE/PÓS da migration: sabotar o corpo exige trocar o literal pelo md5 VIVO.
ESTE_MD5="$(grep -oE "IS DISTINCT FROM '[0-9a-f]{32}'" "$MIG" | grep -oE '[0-9a-f]{32}' | head -1)"
MD5_VIVO="(SELECT md5(q.prosrc) FROM pg_catalog.pg_proc q WHERE q.oid = to_regprocedure('public.radar_recruzar_ja_cliente()'))"
case "${SABOTAGEM:-}" in
  "") ;;
  # o recruzar volta a apagar letra na chave alnum → o byte preservado do escritor deixa de marcar (B2a)
  alnum_so_digitos)             sabotar "'[-./]'" "'[^0-9]'"; sabotar "'$ESTE_MD5'" "$MD5_VIVO" ;;
  # tira o upper() do recruzar: o escritor JÁ emite maiúsculo, então B2a continua verde — e é B2c
  # (minúsculo vindo de um humano no profile) que fica vermelho. Prova que o escritor não depende do upper.
  sem_upper_nao_afeta_escritor) sabotar "btrim(upper(bruto))" "btrim(bruto)"; sabotar "'$ESTE_MD5'" "$MD5_VIVO" ;;
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
eq()  { if [ "$3" = "$4" ]; then ok "$1" "$2 (=$3)"; else bad "$1" "$2 — esperado [$4], veio [$3]"; fi; }

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
P -f "$MIG_USADA" >/dev/null
P <<SQL
GRANT ALL ON ALL TABLES IN SCHEMA public TO authenticated, service_role;
-- Leads do Radar: o alfanumérico oficial, um numérico e um livre.
INSERT INTO public.radar_empresas (cnpj, cnae_principal, ultimo_lote, razao_social) VALUES
  ('$DOC_PRESERVADO', '3101200', '2026-10', 'LEAD ALFANUMERICO'),
  ('11222333000181', '3101200', '2026-10', 'LEAD NUMERICO'),
  ('99888777000100', '3101200', '2026-10', 'LEAD LIVRE');
SQL

echo "── B1 o bug: o byte MUTILADO do escritor antigo não marca ninguém"
P -c "INSERT INTO public.omie_clientes_nao_vinculados (cnpj_cpf) VALUES ('$DOC_MUTILADO')"
eq B1a "recruzar com só o mutilado marca 0" "$(Pq -c "SELECT public.radar_recruzar_ja_cliente()")" "0"
eq B1b "lead alfanumérico segue NÃO-cliente" "$(Pq -c "SELECT ja_cliente FROM public.radar_empresas WHERE cnpj='$DOC_PRESERVADO'")" "f"

echo "── B2 o conserto: o byte PRESERVADO (o que normalizarDocumento emite) marca o lead"
P -c "INSERT INTO public.omie_clientes_nao_vinculados (cnpj_cpf) VALUES ('$DOC_PRESERVADO')"
eq B2a "recruzar marca exatamente 1" "$(Pq -c "SELECT public.radar_recruzar_ja_cliente()")" "1"
eq B2b "lead alfanumérico virou cliente" "$(Pq -c "SELECT ja_cliente FROM public.radar_empresas WHERE cnpj='$DOC_PRESERVADO'")" "t"
# Humano no profile digita minúsculo com máscara: é o recruzar (upper) que absorve, não o escritor.
# A linha Omie preservada SAI antes (senão ela marca o lead e mascara o cenário — foi o que a
# falsificação acusou: sabotagem sem_upper ficava verde).
P -c "DELETE FROM public.omie_clientes_nao_vinculados WHERE cnpj_cpf = '$DOC_PRESERVADO'"
P -c "INSERT INTO public.profiles VALUES ('00000000-0000-0000-0000-000000000003', '12.abc.345/01de-35')"
P -c "UPDATE public.radar_empresas SET ja_cliente = false WHERE cnpj='$DOC_PRESERVADO'"
eq B2c "minúsculo com máscara (profile, humano) também marca" "$(Pq -c "SELECT public.radar_recruzar_ja_cliente(); SELECT ja_cliente FROM public.radar_empresas WHERE cnpj='$DOC_PRESERVADO'" | tail -1)" "t"

echo "── B3 numérico: caminho byte-idêntico, segue marcando"
P -c "INSERT INTO public.omie_clientes_nao_vinculados (cnpj_cpf) VALUES ('11222333000181')"
eq B3a "recruzar marca o numérico" "$(Pq -c "SELECT public.radar_recruzar_ja_cliente()")" "1"
eq B3b "lead numérico virou cliente" "$(Pq -c "SELECT ja_cliente FROM public.radar_empresas WHERE cnpj='11222333000181'")" "t"
eq B3c "lead livre NÃO marcou" "$(Pq -c "SELECT ja_cliente FROM public.radar_empresas WHERE cnpj='99888777000100'")" "f"
eq B3d "2ª passada marca 0 (idempotente)" "$(Pq -c "SELECT public.radar_recruzar_ja_cliente()")" "0"

echo "PASS=$PASS  FAIL=$FAIL"
[ "$FAIL" -eq 0 ] && echo "✅ test-radar-recruzar-origem-omie: todos os asserts passaram"
[ "$FAIL" -eq 0 ]
