#!/usr/bin/env bash
# Prova PG17 da migration 20261030071150: radar_contagem_por_municipio ganha p_ufs (região de atuação)
# e p_com_contato (esconde quem não tem telefone NEM e-mail) para o ranking de cidades e o mapa do
# /radar contarem o MESMO universo da fila (PR #3413). Parte do corpo VIVO de prod (fixture lida via
# psql-ro em 2026-10-30), aplica a migration REAL duas vezes (idempotência) e assevera:
#   A0  a fixture É o corpo de prod (md5 do prosrc)
#   A1  sem p_ufs/p_com_contato = a predecessora, byte a byte (fast sem lote, fast com lote, slow)
#   A2  p_ufs no fast path com lote
#   A3  p_com_contato no fast path com lote (e-mail sozinho conta como contato)
#   A4  p_ufs + p_com_contato juntos
#   A5  p_ufs sem lote NÃO pega o atalho do índice (o atalho ignoraria a região)
#   A6  slow path com p_ufs e com p_com_contato
#   A7  p_uf vence p_ufs (UF escolhida vence a região, como na fila)
#   A8  p_ufs vazio / minúsculo / com NULL → RAISE 'ufs inválido' (ausente ≠ zero), SQLSTATE casada
#   A9  uma assinatura só (12 args) — sem overload ambíguo para o PostgREST
#   A10 ACL: PUBLIC/anon sem EXECUTE; authenticated/service_role com
#   A11 PRE: corpo vivo divergente da predecessora ABORTA a migration e deixa a velha intacta
#
#   bash db/test-radar-contagem-regiao.sh > /tmp/t.log 2>&1; echo "exit=$?"
#   SABOTAGEM=<nome> bash db/test-radar-contagem-regiao.sh   # tem de ficar VERMELHA
#   bash db/test-radar-contagem-regiao.sh --falsificar        # controle verde + cada sabotagem vermelha no assert dela
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MIG="$REPO_ROOT/supabase/migrations/20261030071150_radar_contagem_municipio_regiao_contato.sql"
PRED="$REPO_ROOT/db/fixtures/radar-contagem-por-municipio-predecessora-prod-20261030.sql"

if [ "${1:-}" = "--falsificar" ]; then
  # nome:VERMELHOS — os asserts (unidos por ',') que TÊM de ficar vermelhos; ou `APPLY!MARCA` quando a
  # postcondição/PRE da própria migration TEM de abortar o apply com aquela marca (`_` vira espaço).
  SABOTAGENS="fast_sem_ufs:A2,A4,A5 fast_sem_contato:A3,A4 slow_sem_ufs:A6a slow_sem_contato:A6b uf_nao_vence:A7 atalho_ignora_regiao:A5 sem_validacao_ufs:A8a,A8b,A8c mantem_velha:APPLY!P1_FALHOU mantem_velha_sem_post:A9 acl_aberta:APPLY!P5_FALHOU acl_aberta_sem_post:A10 pre_cega:A11a,A11b"
  LOGDIR="$(mktemp -d "/tmp/falsifica-radar-contagem-regiao.XXXXXX")"
  echo "══ CONTROLE ══"
  if ! SABOTAGEM="" bash "$0" > "$LOGDIR/controle.log" 2>&1; then
    echo "❌ controle VERMELHO — falsificação abortada (log: $LOGDIR/controle.log)"; tail -15 "$LOGDIR/controle.log"; exit 1
  fi
  echo "✅ controle verde"
  SAB_V=0; SAB_F=0
  for par in $SABOTAGENS; do
    s="${par%%:*}"; verm="${par#*:}"
    log="$LOGDIR/$s.log"
    if SABOTAGEM="$s" bash "$0" > "$log" 2>&1; then
      echo "❌ $s: suíte ficou VERDE"; SAB_F=$((SAB_F+1)); continue
    fi
    if ! grep -q "SABOTAGEM ATIVA: $s" "$log"; then
      echo "❌ $s: sabotagem NÃO aplicou"; SAB_F=$((SAB_F+1)); continue
    fi
    case "$verm" in
      APPLY!*)
        marca="${verm#APPLY!}"; marca="${marca//_/ }"
        if grep -qF "$marca" "$log"; then
          SAB_V=$((SAB_V+1)); echo "✅ $s → apply abortou com '$marca'"
        else
          SAB_F=$((SAB_F+1)); echo "❌ $s: vermelho, mas o apply não abortou com '$marca' (log: $log)"
        fi ;;
      *)
        faltou=""
        for id in ${verm//,/ }; do
          grep -q "^FAIL $id " "$log" || faltou="$faltou $id"
        done
        if [ -z "$faltou" ]; then
          SAB_V=$((SAB_V+1)); echo "✅ $s → {$verm} vermelho"
        else
          SAB_F=$((SAB_F+1)); echo "❌ $s: declarado {$verm}, faltou:$faltou (log: $log)"
        fi ;;
    esac
  done
  echo "SABOTAGENS: $SAB_V vermelhas / $SAB_F falhas"   # recibo exigido por db/roda-nucleo-ci.sh
  [ "$SAB_F" -eq 0 ] && exit 0 || exit 1
fi

export PGVER=17
# shellcheck disable=SC1091  # caminho resolvido em runtime a partir de REPO_ROOT
. "$REPO_ROOT/db/lib/pg-harness.sh"
PORT="${PGPORT_TEST:-5564}"
DATA="$(mktemp -d "/tmp/pgtest-radar-contagem-regiao.XXXXXX")/data"
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
SIG_VELHA="public.radar_contagem_por_municipio(text,text,text,text,boolean,date,date,integer,text,timestamptz)"
case "${SABOTAGEM:-}" in
  "") ;;
  fast_sem_ufs)     cegar_md5; sabotar $'\n         AND (p_ufs IS NULL OR re.uf = ANY (p_ufs))' "" ;;
  fast_sem_contato) cegar_md5; sabotar $'\n         AND (NOT COALESCE(p_com_contato, false) OR re.telefone1 IS NOT NULL OR re.telefone2 IS NOT NULL OR re.email IS NOT NULL)' "" ;;
  slow_sem_ufs)     cegar_md5; sabotar $'\n     AND (p_uf IS NOT NULL OR p_ufs IS NULL OR re.uf = ANY (p_ufs))' "" ;;
  slow_sem_contato) cegar_md5; sabotar $'\n     AND (NOT COALESCE(p_com_contato, false) OR re.telefone1 IS NOT NULL OR re.telefone2 IS NOT NULL OR re.email IS NOT NULL)\n   GROUP BY' $'\n   GROUP BY' ;;
  uf_nao_vence)     cegar_md5; sabotar "     AND (p_uf IS NOT NULL OR p_ufs IS NULL OR re.uf = ANY (p_ufs))" "     AND (p_ufs IS NULL OR re.uf = ANY (p_ufs))" ;;
  atalho_ignora_regiao) cegar_md5; sabotar " AND p_ufs IS NULL AND NOT COALESCE(p_com_contato, false) THEN" " THEN" ;;
  sem_validacao_ufs) cegar_md5; sabotar "    RAISE EXCEPTION 'ufs inválido';" "    NULL;" ;;
  mantem_velha)     sabotar "DROP FUNCTION IF EXISTS $SIG_VELHA;" "" ;;
  mantem_velha_sem_post)
                    sabotar "DROP FUNCTION IF EXISTS $SIG_VELHA;" ""
                    sabotar "  IF to_regprocedure('$SIG_VELHA') IS NOT NULL THEN
    RAISE EXCEPTION 'P1 FALHOU" "  IF false THEN
    RAISE EXCEPTION 'P1 FALHOU" ;;
  acl_aberta)       sabotar "FROM PUBLIC, anon;" "FROM anon;" ;;
  acl_aberta_sem_post)
                    sabotar "FROM PUBLIC, anon;" "FROM anon;"
                    sabotar "  IF has_function_privilege('public', v_oid, 'EXECUTE') OR has_function_privilege('anon', v_oid, 'EXECUTE') THEN" "  IF false THEN" ;;
  pre_cega)         sabotar "  IF v_velha IS NOT NULL AND v_velha <> '" "  IF false AND v_velha <> '" ;;
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
CREATE SCHEMA private;
CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT '00000000-0000-0000-0000-0000000000a1'::uuid $$;
CREATE FUNCTION private.cap_radar_prospectar(uuid) RETURNS boolean LANGUAGE sql STABLE AS $$ SELECT true $$;
CREATE TABLE public.radar_municipios (codigo text PRIMARY KEY, nome text, uf text, lat double precision, lng double precision);
CREATE TABLE public.radar_empresas (
  cnpj text PRIMARY KEY, cnae_principal text NOT NULL DEFAULT '3101200', data_abertura date DEFAULT '2021-03-01',
  municipio_codigo text, municipio_nome text, uf text, telefone1 text, telefone2 text, email text,
  prospeccao_status text NOT NULL DEFAULT 'a_contatar', ja_cliente boolean NOT NULL DEFAULT false,
  ultimo_lote text NOT NULL DEFAULT '2026-08', primeira_vista_em timestamptz NOT NULL DEFAULT '2026-06-12 01:10+00');
INSERT INTO public.radar_municipios VALUES
  ('M1','CIDADE SC','SC',-27.1,-48.6), ('M2','CIDADE MG','MG',-19.9,-43.9), ('M4','CIDADE SP','SP',-23.5,-46.6);
-- M1 (SC, FORA da região): 3 com telefone — no Brasil é a 2ª; na região some.
-- M2 (MG): tel · nada · só e-mail · um que saiu do dump (2026-05, sem contato).
-- M4 (SP): tel · nada.
INSERT INTO public.radar_empresas (cnpj, municipio_codigo, municipio_nome, uf, telefone1, email, ultimo_lote) VALUES
  ('M1A','M1','CIDADE SC','SC','4733330001',NULL,'2026-08'),
  ('M1B','M1','CIDADE SC','SC','4733330002',NULL,'2026-08'),
  ('M1C','M1','CIDADE SC','SC','4733330003',NULL,'2026-08'),
  ('M2A','M2','CIDADE MG','MG','3133330001',NULL,'2026-08'),
  ('M2B','M2','CIDADE MG','MG',NULL,NULL,'2026-08'),
  ('M2C','M2','CIDADE MG','MG',NULL,'contato@m2c.com.br','2026-08'),
  ('M2S','M2','CIDADE MG','MG',NULL,NULL,'2026-05'),
  ('M4A','M4','CIDADE SP','SP','1133330001',NULL,'2026-08'),
  ('M4B','M4','CIDADE SP','SP',NULL,NULL,'2026-08');
SQL

# Predecessora = o corpo VIVO de prod, com o ACL de prod (authenticated + service_role; sem PUBLIC/anon).
P -q -f "$PRED"
Pq -c "REVOKE ALL ON FUNCTION $SIG_VELHA FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION $SIG_VELHA TO authenticated, service_role;" >/dev/null
MD5_FIXTURE="$(Pq -c "SELECT md5(prosrc) FROM pg_proc WHERE oid = to_regprocedure('$SIG_VELHA');")"

# Foto de uma chamada: "codigo=total/com_telefone/a_contatar" na ordem devolvida.
foto() { Pq -c "SELECT coalesce(string_agg(municipio_codigo||'='||total||'/'||com_telefone||'/'||a_contatar, ' ' ORDER BY o), '(vazio)')
                  FROM public.radar_contagem_por_municipio($1) WITH ORDINALITY AS t(municipio_codigo, municipio_nome, uf, lat, lng, total, com_telefone, a_contatar, o);"; }
ANTES_FAST="$(foto "")"
ANTES_LOTE="$(foto "p_lote => '2026-08'")"
ANTES_SLOW="$(foto "p_uf => 'MG'")"
ANTES_LIMIT="$(foto "p_limit => 1")"

# A11 precisa de um banco onde o corpo vivo DIVERGE da predecessora: clona ANTES de aplicar.
PD postgres -q -c "CREATE DATABASE divergente TEMPLATE base;"
PD divergente -q -c "CREATE OR REPLACE FUNCTION public.radar_contagem_por_municipio(p_uf text DEFAULT NULL, p_cnae_prefix text DEFAULT NULL, p_cnae_exato text DEFAULT NULL, p_status text DEFAULT NULL, p_incluir_ja_clientes boolean DEFAULT false, p_data_abertura_min date DEFAULT NULL, p_data_abertura_max date DEFAULT NULL, p_limit integer DEFAULT 500, p_lote text DEFAULT NULL, p_primeira_vista_min timestamptz DEFAULT NULL)
 RETURNS TABLE(municipio_codigo text, municipio_nome text, uf text, lat double precision, lng double precision, total bigint, com_telefone bigint, a_contatar bigint)
 LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS \$f\$ SELECT 'OUTRA'::text, 'SESSAO'::text, 'XX'::text, NULL::float8, NULL::float8, 1::bigint, 0::bigint, 0::bigint \$f\$;"

P -q -f "$MIG_USADA" >/dev/null
P -q -f "$MIG_USADA" >/dev/null   # idempotente: o 2º apply passa a PRE pelo md5 "este"

PASS=0; FAIL=0
eq() { if [ "$2" = "$3" ]; then echo "PASS $1"; PASS=$((PASS+1)); else echo "FAIL $1 — obtido [$2] esperado [$3]"; FAIL=$((FAIL+1)); fi; }
REG="p_ufs => ARRAY['MG','SP']"

eq "A0 a fixture é o corpo vivo de prod (md5)" "$MD5_FIXTURE" "85dbce2b7d578f858e1239a5fbebcd43"

# A1 — sem os parâmetros novos é a predecessora (o roteirizador não muda).
eq "A1a fast sem lote = predecessora"  "$(foto "")"                   "$ANTES_FAST"
eq "A1b fast com lote = predecessora"  "$(foto "p_lote => '2026-08'")" "$ANTES_LOTE"
eq "A1c slow = predecessora"           "$(foto "p_uf => 'MG'")"        "$ANTES_SLOW"
eq "A1d p_limit = predecessora"        "$(foto "p_limit => 1")"        "$ANTES_LIMIT"
eq "A1e âncora: o Brasil conta SC"     "$ANTES_FAST" "M2=4/1/4 M1=3/3/3 M4=2/1/2"

# A2..A5 — região e contato no fast path.
eq "A2 região, fast com lote"          "$(foto "p_lote => '2026-08', $REG")"                          "M2=3/1/3 M4=2/1/2"
eq "A3 contato, fast com lote"         "$(foto "p_lote => '2026-08', p_com_contato => true")"         "M1=3/3/3 M2=2/1/2 M4=1/1/1"
eq "A4 região + contato, fast com lote" "$(foto "p_lote => '2026-08', $REG, p_com_contato => true")"  "M2=2/1/2 M4=1/1/1"
eq "A5 região sem lote não pega o atalho" "$(foto "$REG")"                                            "M2=4/1/4 M4=2/1/2"

# A6 — slow path (p_status força o caminho com filtros).
eq "A6a região, slow"   "$(foto "p_status => 'a_contatar', $REG")"                       "M2=4/1/4 M4=2/1/2"
eq "A6b contato, slow"  "$(foto "p_status => 'a_contatar', p_com_contato => true")"      "M1=3/3/3 M2=2/1/2 M4=1/1/1"

# A7 — UF escolhida vence a região (SC está fora dela).
eq "A7 p_uf vence p_ufs" "$(foto "p_uf => 'SC', $REG")" "M1=3/3/3"

# A8 — região inválida grita (casa a SQLSTATE e a MARCA; o resto re-lança).
a8() { Pq -c "DO \$t\$ BEGIN
  PERFORM * FROM public.radar_contagem_por_municipio(p_ufs => $1);
  RAISE NOTICE 'A8:ACEITOU';
EXCEPTION WHEN raise_exception THEN
  IF SQLERRM = 'ufs inválido' THEN RAISE NOTICE 'A8:RECUSOU'; ELSE RAISE; END IF;
END \$t\$;" 2>&1 | grep -o 'A8:[A-Z]*' || true; }
eq "A8a região vazia recusada"      "$(a8 "ARRAY[]::text[]")"         "A8:RECUSOU"
eq "A8b UF minúscula recusada"      "$(a8 "ARRAY['mg']")"             "A8:RECUSOU"
eq "A8c UF NULL recusada"           "$(a8 "ARRAY['MG',NULL]")"        "A8:RECUSOU"
eq "A8d região válida aceita"       "$(a8 "ARRAY['MG','SP']")"        "A8:ACEITOU"

# A9 — uma assinatura só.
eq "A9 uma assinatura (12 args)" \
   "$(Pq -c "SELECT string_agg(pg_get_function_identity_arguments(oid), ' | ') FROM pg_proc WHERE proname='radar_contagem_por_municipio';" | grep -o 'p_[a-z_]*' | tr '\n' ' ')" \
   "p_uf p_cnae_prefix p_cnae_exato p_status p_incluir_ja_clientes p_data_abertura_min p_data_abertura_max p_limit p_lote p_primeira_vista_min p_ufs p_com_contato "

# A10 — ACL fechado como em prod.
eq "A10 ACL public/anon/authenticated/service_role" \
   "$(Pq -c "SELECT string_agg(has_function_privilege(r, 'public.radar_contagem_por_municipio(text,text,text,text,boolean,date,date,integer,text,timestamptz,text[],boolean)', 'EXECUTE')::text, ' ' ORDER BY o)
             FROM unnest(ARRAY['public','anon','authenticated','service_role']) WITH ORDINALITY AS x(r, o);")" \
   "false false true true"

# A11 — PRE: com o corpo vivo divergente, a migration aborta e a velha (da outra sessão) fica.
SAIDA_DIV="$(PD divergente -q -f "$MIG_USADA" 2>&1 || true)"
eq "A11a PRE aborta com corpo vivo divergente" "$(printf '%s' "$SAIDA_DIV" | grep -o 'PRE FALHOU: corpo vivo da assinatura velha' | head -1)" "PRE FALHOU: corpo vivo da assinatura velha"
eq "A11b a velha divergente segue intacta" \
   "$(PD divergente -qAt -c "SELECT count(*) FILTER (WHERE pronargs = 10)||'/'||count(*) FROM pg_proc WHERE proname='radar_contagem_por_municipio';")" "1/1"

echo "PASS=$PASS  FAIL=$FAIL"
[ "$FAIL" -eq 0 ] && echo "RADAR_CONTAGEM_REGIAO_PROVA_OK"
[ "$FAIL" -eq 0 ]
