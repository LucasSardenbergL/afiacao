#!/usr/bin/env bash
# Prova PG17 da migration 20261020120200: radar_contagem_por_municipio ganha p_lote (foto vigente)
# e p_primeira_vista_min (só inéditos) para o ranking de cidades e o mapa do /radar contarem o MESMO
# universo da fila (PR #3216). Parte do corpo VIVO de prod (fixture lida via psql-ro em 2026-10-20),
# aplica a migration REAL duas vezes (idempotência) e assevera:
#   A1  sem p_lote = a predecessora, byte a byte (fast path e slow path) — o roteirizador não muda
#   A2  p_lote vigente, fast path: só ultimo_lote = vigente; cidade só-de-quem-saiu some; ordem vira
#   A3  p_lote vigente, slow path (p_uf)
#   A4  p_lote + p_primeira_vista_min, fast path = só inéditos
#   A5  idem no slow path
#   A6  lote mal formado → RAISE 'lote inválido' (ausente ≠ zero), SQLSTATE P0001 casada
#   A7  uma assinatura só (10 args) — sem overload ambíguo para o PostgREST
#   A8  ACL: PUBLIC/anon sem EXECUTE; authenticated/service_role com
#   A9  PRE: corpo vivo divergente da predecessora ABORTA a migration e deixa a velha intacta
#
#   bash db/test-radar-contagem-lote.sh > /tmp/t.log 2>&1; echo "exit=$?"
#   SABOTAGEM=<nome> bash db/test-radar-contagem-lote.sh   # tem de ficar VERMELHA
#   bash db/test-radar-contagem-lote.sh --falsificar        # controle verde + cada sabotagem vermelha no assert dela
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MIG="$REPO_ROOT/supabase/migrations/20261020120200_radar_contagem_municipio_lote_vigente.sql"
PRED="$REPO_ROOT/db/fixtures/radar-contagem-por-municipio-predecessora-prod-20261020.sql"

if [ "${1:-}" = "--falsificar" ]; then
  # <sabotagem>:<assert que TEM de acusá-la>. `post:<texto>` = a postcondição/PRE da própria migration
  # abortou o apply com aquele texto; a variante `_sem_post` cega essa camada para provar que o
  # assert da suíte pega sozinho (uma camada por vez).
  SABOTAGENS="fast_sem_lote:A2 slow_sem_lote:A3 fast_sem_vista:A4 slow_sem_vista:A5 sem_validacao_lote:A6a default_mudou:A1a mantem_velha:post:assinatura_velha mantem_velha_sem_post:A7 acl_aberta:post:PUBLIC/anon acl_aberta_sem_post:A8 pre_cega:A9a corpo_divergente:post:corpo_da_nova"
  LOGDIR="$(mktemp -d "/tmp/falsifica-radar-contagem-lote.XXXXXX")"
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
    case "$a" in
      post:*) padrao="POS FALHOU: $(printf '%s' "${a#post:}" | tr '_' ' ')" ;;
      *)      padrao="^FAIL $a " ;;
    esac
    if grep -q "$padrao" "$LOGDIR/$s.log"; then
      echo "✅ $s → $a vermelho"
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
PORT="${PGPORT_TEST:-5563}"
DATA="$(mktemp -d "/tmp/pgtest-radar-contagem-lote.XXXXXX")/data"
export LC_ALL=C LANG=C
MIG_USADA="$(dirname "$DATA")/mig.sql"
cleanup() { "$PGBIN/pg_ctl" -D "$DATA" stop -m immediate >/dev/null 2>&1 || true; rm -rf "$(dirname "$DATA")"; }
trap cleanup EXIT

cp "$MIG" "$MIG_USADA"

sabotar() { # $1 = de, $2 = para (literal)
  python3 -I - "$MIG_USADA" "$1" "$2" <<'PY'
import sys
p, de, para = sys.argv[1:]
s = open(p, encoding="utf-8").read()
if de not in s:
    sys.exit("padrao ausente: " + de)
open(p, "w", encoding="utf-8").write(s.replace(de, para))
PY
}
# Sabotagem no CORPO muda o prosrc → o md5 da PÓS (e o da PRE, no 2º apply) pegaria antes da suíte.
# Para provar que o assert da suíte tem dente sozinho, cega os dois md5 junto.
cegar_md5() {
  sabotar "  IF v_nova IS NOT NULL AND v_nova <> '" "  IF false AND v_nova <> '"
  sabotar "  IF (SELECT md5(prosrc) FROM pg_catalog.pg_proc WHERE oid = v_oid) <> '" "  IF false AND (SELECT md5(prosrc) FROM pg_catalog.pg_proc WHERE oid = v_oid) <> '"
}
case "${SABOTAGEM:-}" in
  "") ;;
  fast_sem_lote)   cegar_md5; sabotar $'\n         AND (p_lote IS NULL OR re.ultimo_lote = p_lote)' "" ;;
  slow_sem_lote)   cegar_md5; sabotar $'\n     AND (p_lote IS NULL OR re.ultimo_lote = p_lote)' "" ;;
  fast_sem_vista)  cegar_md5; sabotar $'\n         AND (p_primeira_vista_min IS NULL OR re.primeira_vista_em >= p_primeira_vista_min)' "" ;;
  slow_sem_vista)  cegar_md5; sabotar $'\n     AND (p_primeira_vista_min IS NULL OR re.primeira_vista_em >= p_primeira_vista_min)' "" ;;
  sem_validacao_lote) cegar_md5; sabotar "THEN RAISE EXCEPTION 'lote inválido'; END IF;" "THEN NULL; END IF;" ;;
  default_mudou)   cegar_md5; sabotar "       ORDER BY sum(a.t) DESC, a.mc" "       ORDER BY sum(a.t) ASC, a.mc" ;;
  mantem_velha)    sabotar "DROP FUNCTION IF EXISTS public.radar_contagem_por_municipio(text,text,text,text,boolean,date,date,integer);" "" ;;
  mantem_velha_sem_post)
                   sabotar "DROP FUNCTION IF EXISTS public.radar_contagem_por_municipio(text,text,text,text,boolean,date,date,integer);" ""
                   sabotar "  IF to_regprocedure('public.radar_contagem_por_municipio(text,text,text,text,boolean,date,date,integer)') IS NOT NULL THEN
    RAISE EXCEPTION 'POS FALHOU: assinatura velha" "  IF false THEN
    RAISE EXCEPTION 'POS FALHOU: assinatura velha" ;;
  acl_aberta)      sabotar "FROM PUBLIC, anon;" "FROM anon;" ;;
  acl_aberta_sem_post)
                   sabotar "FROM PUBLIC, anon;" "FROM anon;"
                   sabotar "  IF has_function_privilege('public', v_oid, 'EXECUTE') OR has_function_privilege('anon', v_oid, 'EXECUTE') THEN" "  IF false THEN" ;;
  pre_cega)        sabotar "  IF v_velha IS NOT NULL AND v_velha <> '" "  IF false AND v_velha <> '" ;;
  corpo_divergente) sabotar "  -- Lote mal formado contaria ZERO" "  -- Lote mal  formado contaria ZERO" ;;
  *) echo "sabotagem desconhecida: $SABOTAGEM"; exit 9 ;;
esac
[ -n "${SABOTAGEM:-}" ] && echo "⚠️  SABOTAGEM ATIVA: $SABOTAGEM"

"$PGBIN/initdb" -D "$DATA" -U postgres -E UTF8 --locale=C >/dev/null
"$PGBIN/pg_ctl" -D "$DATA" -o "-p $PORT -k /tmp" -l "$(dirname "$DATA")/pg.log" -w start >/dev/null
PD() { local db="$1"; shift; "$PGBIN/psql" -X -v ON_ERROR_STOP=1 -p "$PORT" -h /tmp -U postgres -d "$db" "$@"; }
P()  { PD base "$@"; }
Pq() { P -qAt "$@"; }

PD postgres -q -c "CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN; CREATE ROLE service_role NOLOGIN;" -c "CREATE DATABASE base;"

P -q <<'SQL'
CREATE SCHEMA auth;
CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT '00000000-0000-0000-0000-0000000000a1'::uuid $$;
CREATE FUNCTION public.pode_ver_carteira_completa(uuid) RETURNS boolean LANGUAGE sql STABLE AS $$ SELECT true $$;
CREATE TABLE public.radar_municipios (codigo text PRIMARY KEY, nome text, uf text, lat double precision, lng double precision);
CREATE TABLE public.radar_empresas (
  cnpj text PRIMARY KEY, cnae_principal text NOT NULL DEFAULT '2542000', data_abertura date DEFAULT '2021-03-01',
  municipio_codigo text, municipio_nome text, uf text, telefone1 text, telefone2 text,
  prospeccao_status text NOT NULL DEFAULT 'a_contatar', ja_cliente boolean NOT NULL DEFAULT false,
  ultimo_lote text NOT NULL, primeira_vista_em timestamptz NOT NULL DEFAULT '2026-06-12 01:10+00');
INSERT INTO public.radar_municipios VALUES
  ('M1','CIDADE UM','SC',-27.1,-48.6), ('M2','CIDADE DOIS','MG',-19.9,-43.9), ('M3','CIDADE TRES','SC',-26.3,-48.8);
-- M1: 5 vigentes (2 inéditos: vistos depois do início do lote 2026-08), 3 que saíram do dump,
--     + 1 descartado e 1 já-cliente vigentes (fora de qualquer contagem default).
-- M2: 2 vigentes, 8 que saíram → no "tudo" M2 (10) passa M1 (8); na foto vigente M1 (5) passa M2 (2).
-- M3: só quem saiu (3) → existe no "tudo", some na foto vigente.
INSERT INTO public.radar_empresas (cnpj, municipio_codigo, municipio_nome, uf, telefone1, prospeccao_status, ja_cliente, ultimo_lote, primeira_vista_em) VALUES
  ('M1V1','M1','CIDADE UM','SC','4733330001','a_contatar',false,'2026-08','2026-06-12 01:10+00'),
  ('M1V2','M1','CIDADE UM','SC',NULL,        'a_contatar',false,'2026-08','2026-06-12 01:10+00'),
  ('M1V3','M1','CIDADE UM','SC','4733330003','contatado', false,'2026-08','2026-06-12 01:10+00'),
  ('M1I1','M1','CIDADE UM','SC','4733330004','a_contatar',false,'2026-08','2026-10-19 17:00+00'),
  ('M1I2','M1','CIDADE UM','SC',NULL,        'a_contatar',false,'2026-08','2026-10-20 03:00+00'),
  ('M1S1','M1','CIDADE UM','SC','4733330006','a_contatar',false,'2026-05','2026-06-12 01:10+00'),
  ('M1S2','M1','CIDADE UM','SC',NULL,        'a_contatar',false,'2026-05','2026-06-12 01:10+00'),
  ('M1S3','M1','CIDADE UM','SC',NULL,        'contatado', false,'2026-05','2026-06-12 01:10+00'),
  ('M1DX','M1','CIDADE UM','SC',NULL,        'descartado',false,'2026-08','2026-10-19 17:00+00'),
  ('M1JC','M1','CIDADE UM','SC',NULL,        'a_contatar',true, '2026-08','2026-10-19 17:00+00'),
  ('M2V1','M2','CIDADE DOIS','MG','3133330001','a_contatar',false,'2026-08','2026-06-12 01:10+00'),
  ('M2I1','M2','CIDADE DOIS','MG',NULL,        'a_contatar',false,'2026-08','2026-10-19 18:00+00'),
  ('M3S1','M3','CIDADE TRES','SC',NULL,'a_contatar',false,'2026-05','2026-06-12 01:10+00'),
  ('M3S2','M3','CIDADE TRES','SC',NULL,'a_contatar',false,'2026-05','2026-06-12 01:10+00'),
  ('M3S3','M3','CIDADE TRES','SC',NULL,'a_contatar',false,'2026-05','2026-06-12 01:10+00');
INSERT INTO public.radar_empresas (cnpj, municipio_codigo, municipio_nome, uf, ultimo_lote)
  SELECT 'M2S' || g, 'M2', 'CIDADE DOIS', 'MG', '2026-05' FROM generate_series(1, 8) g;
SQL

# Predecessora = o corpo VIVO de prod, com o ACL de prod (authenticated + service_role; sem PUBLIC/anon).
P -q -f "$PRED"
Pq -c "REVOKE ALL ON FUNCTION public.radar_contagem_por_municipio(text,text,text,text,boolean,date,date,integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.radar_contagem_por_municipio(text,text,text,text,boolean,date,date,integer) TO authenticated, service_role;" >/dev/null

# Foto de uma chamada: "codigo=total/com_telefone/a_contatar" na ordem devolvida.
foto() { Pq -c "SELECT coalesce(string_agg(municipio_codigo||'='||total||'/'||com_telefone||'/'||a_contatar, ' ' ORDER BY o), '(vazio)')
                  FROM public.radar_contagem_por_municipio($1) WITH ORDINALITY AS t(municipio_codigo, municipio_nome, uf, lat, lng, total, com_telefone, a_contatar, o);"; }
ANTES_FAST="$(foto "")"
ANTES_SLOW="$(foto "p_uf => 'SC'")"
ANTES_LIMIT="$(foto "p_limit => 1")"

# A9 precisa de um banco onde o corpo vivo DIVERGE da predecessora: clona ANTES de aplicar.
PD postgres -q -c "CREATE DATABASE divergente TEMPLATE base;"
PD divergente -q -c "CREATE OR REPLACE FUNCTION public.radar_contagem_por_municipio(p_uf text DEFAULT NULL, p_cnae_prefix text DEFAULT NULL, p_cnae_exato text DEFAULT NULL, p_status text DEFAULT NULL, p_incluir_ja_clientes boolean DEFAULT false, p_data_abertura_min date DEFAULT NULL, p_data_abertura_max date DEFAULT NULL, p_limit integer DEFAULT 500)
 RETURNS TABLE(municipio_codigo text, municipio_nome text, uf text, lat double precision, lng double precision, total bigint, com_telefone bigint, a_contatar bigint)
 LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS \$f\$ SELECT 'OUTRA'::text, 'SESSAO'::text, 'XX'::text, NULL::float8, NULL::float8, 1::bigint, 0::bigint, 0::bigint \$f\$;"

P -q -f "$MIG_USADA" >/dev/null
P -q -f "$MIG_USADA" >/dev/null   # idempotente: o 2º apply passa a PRE pelo md5 "este"

PASS=0; FAIL=0
eq() { if [ "$2" = "$3" ]; then echo "PASS $1"; PASS=$((PASS+1)); else echo "FAIL $1 — obtido [$2] esperado [$3]"; FAIL=$((FAIL+1)); fi; }

# A1 — sem p_lote é a predecessora (o roteirizador e o toggle "incluir quem saiu" não mudam).
eq "A1a sem p_lote, fast path = predecessora"  "$(foto "")"              "$ANTES_FAST"
eq "A1b sem p_lote, slow path = predecessora"  "$(foto "p_uf => 'SC'")"  "$ANTES_SLOW"
eq "A1c sem p_lote, p_limit = predecessora"    "$(foto "p_limit => 1")"  "$ANTES_LIMIT"
eq "A1d a predecessora contava quem saiu (âncora do cenário)" "$ANTES_FAST" "M2=10/1/10 M1=8/4/6 M3=3/0/3"

# A2/A3 — foto vigente.
eq "A2 p_lote vigente, fast path"              "$(foto "p_lote => '2026-08'")"                "M1=5/3/4 M2=2/1/2"
eq "A3 p_lote vigente, slow path (p_uf=MG)"    "$(foto "p_uf => 'MG', p_lote => '2026-08'")" "M2=2/1/2"
eq "A3b p_lote do lote antigo, slow path (MG)" "$(foto "p_uf => 'MG', p_lote => '2026-05'")" "M2=8/0/8"

# A4/A5 — só inéditos (primeira vista >= início do lote vigente, 2026-10-19 16:31:08 UTC).
eq "A4 inéditos, fast path" "$(foto "p_lote => '2026-08', p_primeira_vista_min => '2026-10-19 16:31:08+00'")" "M1=2/1/2 M2=1/0/1"
eq "A5 inéditos, slow path" "$(foto "p_uf => 'SC', p_lote => '2026-08', p_primeira_vista_min => '2026-10-19 16:31:08+00'")" "M1=2/1/2"

# A6 — lote mal formado grita (casa a SQLSTATE e a MARCA; o resto re-lança).
a6() { Pq -c "DO \$t\$ BEGIN
  PERFORM * FROM public.radar_contagem_por_municipio(p_lote => '$1');
  RAISE NOTICE 'A6:ACEITOU';
EXCEPTION WHEN raise_exception THEN
  IF SQLERRM = 'lote inválido' THEN RAISE NOTICE 'A6:RECUSOU'; ELSE RAISE; END IF;
END \$t\$;" 2>&1 | grep -o 'A6:[A-Z]*' || true; }
eq "A6a lote '2026-8' recusado"   "$(a6 '2026-8')"   "A6:RECUSOU"
eq "A6b lote '' recusado"         "$(a6 '')"         "A6:RECUSOU"
eq "A6c lote '2026-08' aceito"    "$(a6 '2026-08')"  "A6:ACEITOU"

# A7 — uma assinatura só.
eq "A7 uma assinatura (10 args)" \
   "$(Pq -c "SELECT string_agg(pg_get_function_identity_arguments(oid), ' | ') FROM pg_proc WHERE proname='radar_contagem_por_municipio';" | grep -o 'p_[a-z_]*' | tr '\n' ' ')" \
   "p_uf p_cnae_prefix p_cnae_exato p_status p_incluir_ja_clientes p_data_abertura_min p_data_abertura_max p_limit p_lote p_primeira_vista_min "

# A8 — ACL fechado como em prod.
eq "A8 ACL public/anon/authenticated/service_role" \
   "$(Pq -c "SELECT string_agg(has_function_privilege(r, 'public.radar_contagem_por_municipio(text,text,text,text,boolean,date,date,integer,text,timestamptz)', 'EXECUTE')::text, ' ' ORDER BY o)
             FROM unnest(ARRAY['public','anon','authenticated','service_role']) WITH ORDINALITY AS x(r, o);")" \
   "false false true true"

# A9 — PRE: com o corpo vivo divergente, a migration aborta e a velha (da outra sessão) fica.
SAIDA_DIV="$(PD divergente -q -f "$MIG_USADA" 2>&1 || true)"
eq "A9a PRE aborta com corpo vivo divergente" "$(printf '%s' "$SAIDA_DIV" | grep -o 'PRE FALHOU: corpo vivo da assinatura velha' | head -1)" "PRE FALHOU: corpo vivo da assinatura velha"
eq "A9b a velha divergente segue intacta" \
   "$(PD divergente -qAt -c "SELECT count(*) FILTER (WHERE pronargs = 8)||'/'||count(*) FROM pg_proc WHERE proname='radar_contagem_por_municipio';")" "1/1"

echo "PASS=$PASS  FAIL=$FAIL"
[ "$FAIL" -eq 0 ] && echo "RADAR_CONTAGEM_LOTE_PROVA_OK"
[ "$FAIL" -eq 0 ]
