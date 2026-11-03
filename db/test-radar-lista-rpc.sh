#!/usr/bin/env bash
# Prova PG17 de supabase/migrations/20261103131500_radar_lista_rpc.sql — a lista do /radar pela RPC
# SECURITY DEFINER `radar_lista`, medida SOB `SET ROLE authenticated` (o papel do app, com RLS).
#
# Por que sob authenticated: a parte 2 (20261103100100) foi provada como dono e a 2ª testemunha como
# claude_ro (rolbypassrls) — os dois ignoram RLS e aprovaram o trigrama que o app nunca recebe (sob RLS o
# ILIKE, não-leakproof, não vira condição de índice). Aqui todo número sai do papel do app.
#
#   A0  o md5 cravado na PRE/PÓS é o do corpo do arquivo
#   A1  aplica (transação única, como o db:aplicar) e reaplica (idempotente)
#   E*  equivalência: a RPC devolve as MESMAS linhas, na MESMA ordem, que a consulta que o useRadarLista
#       mandava ao PostgREST (rodada sob RLS como authenticated) — 19 recortes, nenhum vazio
#   I0  controle: essa consulta, sob RLS, faz seq scan na busca rara e não lê o trigrama (o defeito)
#   I1  a busca rara pela RPC lê o trigrama e não faz seq scan; I2 idem município; I3 a lista sem termo
#   G*  gate (sem cap → 42501) e ACL (anon/PUBLIC sem EXECUTE)
#   V*  entrada mal formada → 22023 (ordem fora da lista, paginação, CNAE)
#   W*  termo só de espaço = sem filtro; curinga do termo é LITERAL (escape)
#   PRE corpo vivo divergente aborta o apply
#
#   bash db/test-radar-lista-rpc.sh               # a prova
#   bash db/test-radar-lista-rpc.sh --falsificar  # sabota a migration e EXIGE vermelho
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MIG="$REPO_ROOT/supabase/migrations/20261103131500_radar_lista_rpc.sql"

if [ "${1:-}" = "--falsificar" ]; then
  # nome:VERMELHOS — asserts (unidos por ',') que TÊM de ficar vermelhos; ou `APPLY!MARCA` quando a
  # postcondição/PRE da própria migration TEM de abortar o apply com aquela marca (`_` vira espaço).
  SABOTAGENS="sem_indice:I1 sem_ja_cliente:E01,E02 sem_gate:G1 sem_escape:W2 uf_nao_vence:E08 sugeridos_sem_score:E14 pvm_ignorado:E13 data_ignorada:E16 municipio_ignorado:E05 status_ignorado:E11 cnae_prefixo_ignorado:E10 contato_ignorado:E01,E02 pre_aceita_tudo:PRE1 revoke_sem_anon:APPLY!P2_FALHOU sem_definer:APPLY!P1_FALHOU"
  LOGDIR="$(mktemp -d "${TMPDIR:-/tmp}/falsifica-radar-lista.XXXXXX")"
  echo "══ CONTROLE ══"
  if ! SABOTAGEM="" bash "$0" > "$LOGDIR/controle.log" 2>&1; then
    echo "❌ controle VERMELHO — falsificação abortada (log: $LOGDIR/controle.log)"; tail -15 "$LOGDIR/controle.log"; exit 1
  fi
  grep -q "RADAR_LISTA_PROVA_OK" "$LOGDIR/controle.log" || { echo "❌ controle sem marcador de fim"; exit 1; }
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
        IFS=',' read -r -a alvos <<< "$verm"
        for a in "${alvos[@]}"; do
          grep -q "^FAIL $a " "$log" || faltou="$faltou $a"
        done
        if [ -z "$faltou" ]; then
          SAB_V=$((SAB_V+1)); echo "✅ $s → vermelho em $verm"
        else
          SAB_F=$((SAB_F+1)); echo "❌ $s: vermelho, mas não em:$faltou (log: $log)"
        fi ;;
    esac
  done
  echo "SABOTAGENS: $SAB_V vermelhas / $SAB_F falhas"   # recibo exigido por db/roda-nucleo-ci.sh
  [ "$SAB_F" -eq 0 ]
  exit $?
fi

. "$REPO_ROOT/db/lib/pg-harness.sh"
PORT="${PGPORT_TEST:-5573}"
DATA="$(mktemp -d "${TMPDIR:-/tmp}/pgtest-radar-lista.XXXXXX")/data"
LOCALE_TESTE="${LOCALE_TESTE:-C}"
export LC_ALL="$LOCALE_TESTE" LANG="$LOCALE_TESTE"
MIG_USADA="$(dirname "$DATA")/mig.sql"
cleanup() { "$PGBIN/pg_ctl" -D "$DATA" stop -m immediate >/dev/null 2>&1 || true; rm -rf "$(dirname "$DATA")"; }
trap cleanup EXIT

cp "$MIG" "$MIG_USADA"
sabotar() { # $1 = de, $2 = para (literal; troca TODAS as ocorrências; exige que exista)
  python3 -I - "$MIG_USADA" "$1" "$2" <<'PY'
import sys
p, de, para = sys.argv[1], sys.argv[2], sys.argv[3]
s = open(p, encoding='utf-8').read()
if de not in s:
    sys.exit('sabotagem: trecho não encontrado: ' + de)
open(p, 'w', encoding='utf-8').write(s.replace(de, para))
PY
}
# md5 do corpo (prosrc = o texto entre `AS $function$` e `$function$;`, byte a byte).
md5_corpo() {
  python3 -I - "$1" <<'PY'
import sys, hashlib
s = open(sys.argv[1], encoding='utf-8').read()
i = s.index('AS $function$') + len('AS $function$')
j = s.index('$function$;', i)
print(hashlib.md5(s[i:j].encode('utf-8')).hexdigest())
PY
}
MD5_CRAVADO="$(grep -o "v_md5 <> '[0-9a-f]\{32\}'" "$MIG" | grep -o '[0-9a-f]\{32\}')"

case "${SABOTAGEM:-}" in
  "") ;;
  sem_indice) sabotar "e.razao_social ILIKE private" "(e.razao_social || '') ILIKE private" ;;
  sem_ja_cliente) sabotar '      v_w := array_append(v_w, $w$e.ja_cliente = false$w$);' '      NULL;' ;;
  sem_gate) sabotar 'IF NOT (COALESCE(private.cap_radar_prospectar((SELECT auth.uid())), false)) THEN' 'IF false THEN' ;;
  sem_escape) sabotar 'private.padrao_like_contem($1)' "('%' || \$1 || '%')" ;;
  uf_nao_vence) sabotar '  ELSIF p_ufs IS NOT NULL THEN' '  END IF;
  IF p_ufs IS NOT NULL THEN' ;;
  sugeridos_sem_score) sabotar ' AND e.score >= $12$w$);' '$w$);' ;;
  pvm_ignorado) sabotar '    v_w := array_append(v_w, $w$e.primeira_vista_em >= $10$w$);' '    NULL;' ;;
  data_ignorada) sabotar '    v_w := array_append(v_w, $w$e.data_abertura <= $16$w$);' '    NULL;' ;;
  municipio_ignorado) sabotar "    v_w := array_append(v_w, \$w\$e.municipio_nome ILIKE private.padrao_like_contem(\$2) ESCAPE '\\'\$w\$);" '    NULL;' ;;
  status_ignorado) sabotar '      v_w := array_append(v_w, $w$e.prospeccao_status = $7$w$);' '      NULL;' ;;
  cnae_prefixo_ignorado) sabotar '    v_w := array_append(v_w, $w$starts_with(e.cnae_principal, $6)$w$);' '    NULL;' ;;
  contato_ignorado) sabotar '    v_w := array_append(v_w, $w$(e.telefone1 IS NOT NULL OR e.telefone2 IS NOT NULL OR e.email IS NOT NULL)$w$);' '    NULL;' ;;
  pre_aceita_tudo) sabotar 'IF v_md5 IS NOT NULL AND v_md5 <>' 'IF false AND v_md5 <>' ;;
  revoke_sem_anon) sabotar 'FROM PUBLIC, anon;' 'FROM PUBLIC;' ;;
  sem_definer) sabotar ' STABLE SECURITY DEFINER' ' STABLE SECURITY INVOKER' ;;
  *) echo "sabotagem desconhecida: $SABOTAGEM"; exit 9 ;;
esac
if [ -n "${SABOTAGEM:-}" ]; then
  echo "⚠️  SABOTAGEM ATIVA: $SABOTAGEM"
  # O corpo sabotado tem outro md5: recrava-o, senão a PRE/P1 abortariam TODA sabotagem e o vermelho
  # não diria nada sobre o assert-alvo.
  sabotar "$MD5_CRAVADO" "$(md5_corpo "$MIG_USADA")"
fi

"$PGBIN/initdb" -D "$DATA" -U postgres -E UTF8 --locale="$LOCALE_TESTE" >/dev/null
"$PGBIN/pg_ctl" -D "$DATA" -o "-p $PORT -k /tmp" -l "$(dirname "$DATA")/pg.log" -w start >/dev/null
PD() { local db="$1"; shift; "$PGBIN/psql" -X -v ON_ERROR_STOP=1 -p "$PORT" -h /tmp -U postgres -d "$db" "$@"; }
P()  { PD base "$@"; }
Pq() { P -qAt "$@"; }

PD postgres -q -c "CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN; CREATE ROLE service_role NOLOGIN;" -c "CREATE DATABASE base;"

USER_CAP='11111111-1111-1111-1111-111111111111'
USER_SEM='22222222-2222-2222-2222-222222222222'

P -q <<SQL
CREATE EXTENSION pg_trgm;
CREATE SCHEMA auth; CREATE SCHEMA private;
GRANT USAGE ON SCHEMA auth, private TO anon, authenticated;
-- Supabase: o default privilege dá EXECUTE de função nova em public a anon/authenticated (o REVOKE tem de pegar).
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO anon, authenticated, service_role;
CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE
  AS \$\$ SELECT nullif(current_setting('request.jwt.claim.sub', true), '')::uuid \$\$;
CREATE FUNCTION private.cap_radar_prospectar(p uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER
  AS \$\$ SELECT p = '$USER_CAP'::uuid \$\$;
-- corpo de prod (psql-ro, 2026-11-03)
CREATE FUNCTION private.padrao_like_contem(p_termo text) RETURNS text LANGUAGE sql IMMUTABLE PARALLEL SAFE STRICT
  SET search_path TO ''
AS \$function\$
  SELECT CASE
    WHEN btrim(translate(p_termo, '%_', ''), E' \t\r\n') = '' THEN NULL
    ELSE '%' || replace(replace(replace(p_termo, '\', '\\'), '%', '\%'), '_', '\_') || '%'
  END
\$function\$;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA auth, private TO anon, authenticated;

CREATE TABLE public.radar_empresas (
  cnpj text PRIMARY KEY, razao_social text, nome_fantasia text, municipio_codigo text, municipio_nome text,
  uf text, cnae_principal text, prospeccao_status text NOT NULL, ja_cliente boolean NOT NULL DEFAULT false,
  ultimo_lote text, primeira_vista_em timestamptz, telefone1 text, telefone2 text, email text,
  data_abertura date, capital_social numeric, score smallint, omie_codigo_cliente text, rfb_situacao text, pad text);
SELECT setseed(0.42);
INSERT INTO public.radar_empresas
SELECT CASE WHEN g % 997 = 0 THEN 'X' || lpad(g::text, 13, '0') ELSE lpad(g::text, 14, '0') END,
       CASE WHEN g % 40000 = 7 THEN 'MARCENARIA XQZWKJ ' || g ELSE 'EMPRESA ' || md5(g::text) END,
       CASE WHEN g % 5 = 0 THEN NULL ELSE 'FANT ' || md5((g * 7)::text) END,
       (g % 300)::text,
       (ARRAY['POMERODE','BLUMENAU','GASPAR','UBERLANDIA','SAO PAULO','CURITIBA'])[1 + g % 6] || ' ' || (g % 50),
       (ARRAY['SC','MG','SP','PR','RJ'])[1 + g % 5],
       (ARRAY['3101200','3102100','4744001','3101201','1622699'])[1 + g % 5],
       (ARRAY['a_contatar','a_contatar','a_contatar','em_conversa','descartado','virou_cliente'])[1 + g % 6],
       g % 10 = 0,
       CASE WHEN g % 4 = 0 THEN '2026-09' ELSE '2026-10' END,
       timestamptz '2026-10-01 06:00+00' + (g % 60) * interval '1 day' - interval '30 days',
       CASE WHEN g % 3 = 0 THEN NULL ELSE '47' || lpad((g % 100000)::text, 8, '0') END,
       CASE WHEN g % 7 = 0 THEN '48' || lpad(g::text, 8, '0') END,
       CASE WHEN g % 11 = 0 THEN 'c' || g || '@x.com' END,
       CASE WHEN g % 13 = 0 THEN NULL ELSE date '2000-01-01' + (g % 9000) END,
       CASE WHEN g % 17 = 0 THEN NULL ELSE (g % 5000) * 100 END,
       CASE WHEN g % 19 = 0 THEN NULL ELSE (g * 31 % 101)::smallint END,
       CASE WHEN g % 50 = 0 THEN 'OM' || g END,
       (ARRAY[NULL,'02','02','08'])[1 + g % 4],
       repeat('x', 300)
  FROM generate_series(1, 200000) g
 ORDER BY random();
CREATE INDEX idx_radar_empresas_busca_trgm ON public.radar_empresas
  USING gin (razao_social gin_trgm_ops, nome_fantasia gin_trgm_ops, municipio_nome gin_trgm_ops);
CREATE INDEX idx_radar_lista_score ON public.radar_empresas (score DESC NULLS LAST, cnpj) WHERE ja_cliente = false AND prospeccao_status <> 'descartado';
CREATE INDEX idx_radar_lista_estab ON public.radar_empresas (capital_social DESC, cnpj) WHERE ja_cliente = false AND prospeccao_status <> 'descartado';
CREATE INDEX idx_radar_lista_novas ON public.radar_empresas (data_abertura DESC, cnpj) WHERE ja_cliente = false AND prospeccao_status <> 'descartado';
CREATE INDEX idx_radar_empresas_cnae ON public.radar_empresas (cnae_principal);
CREATE INDEX idx_radar_empresas_lote_vista ON public.radar_empresas (ultimo_lote, primeira_vista_em);
CREATE INDEX idx_radar_empresas_fila ON public.radar_empresas (prospeccao_status);
-- RLS como em prod (radar_empresas_select_gestor)
ALTER TABLE public.radar_empresas ENABLE ROW LEVEL SECURITY;
CREATE POLICY radar_empresas_select_gestor ON public.radar_empresas FOR SELECT TO authenticated
  USING ((SELECT private.cap_radar_prospectar((SELECT auth.uid()))));
GRANT SELECT ON public.radar_empresas TO authenticated;
ANALYZE public.radar_empresas;
SQL

PASS=0; FAIL=0
eq() { if [ "$2" = "$3" ]; then echo "PASS $1"; PASS=$((PASS+1)); else echo "FAIL $1 — obtido [$2] esperado [$3]"; FAIL=$((FAIL+1)); fi; }

aplicar() { P -q -1 -v ON_ERROR_STOP=1 -c "SET LOCAL statement_timeout = '300s'" -f "$MIG_USADA"; }

if [ -z "${SABOTAGEM:-}" ]; then
  eq A0 "$(md5_corpo "$MIG")" "$MD5_CRAVADO"
fi
aplicar
aplicar
eq A1 "$(Pq -c "SELECT count(*) FROM pg_proc WHERE proname = 'radar_lista'")" "1"

# Como o app: authenticated, JWT do usuário com cap, sem paralelismo (contagem de scans determinística).
COMO_APP="SET ROLE authenticated; SET request.jwt.claim.sub = '$USER_CAP'; SET max_parallel_workers_per_gather = 0;"
lista_rpc() { Pq -c "$COMO_APP" -c "SELECT coalesce(string_agg(r.cnpj, ',' ORDER BY r.ordinality), '') FROM public.radar_lista($1) WITH ORDINALITY AS r"; }
lista_ref() { Pq -c "$COMO_APP" -c "SELECT coalesce(string_agg(cnpj, ',' ORDER BY rn), '') FROM (SELECT cnpj, row_number() OVER (ORDER BY $2 DESC NULLS LAST, cnpj) rn FROM public.radar_empresas WHERE $1 ORDER BY $2 DESC NULLS LAST, cnpj LIMIT 50 OFFSET ${3:-0}) s"; }
# E: RPC == a consulta de antes (sob RLS), e a referência não pode ser vazia (igualdade vazia é teatro).
cmp_lista() { # nome, args da RPC, WHERE de referência, coluna de ordem, offset
  local rpc ref
  rpc="$(lista_rpc "$2")"; ref="$(lista_ref "$3" "${4:-score}" "${5:-0}")"
  if [ -z "$ref" ]; then echo "FAIL $1 — referência VAZIA (recorte não exercita nada)"; FAIL=$((FAIL+1)); return; fi
  eq "$1" "$rpc" "$ref"
}
BASE="prospeccao_status <> 'descartado' AND ja_cliente = false"
LOTE="ultimo_lote = '2026-10'"
CONT="(telefone1 IS NOT NULL OR telefone2 IS NOT NULL OR email IS NOT NULL)"
PADRAO="p_ultimo_lote => '2026-10', p_com_contato => true"

cmp_lista E01 "$PADRAO" "$BASE AND $LOTE AND $CONT"
cmp_lista E02 "$PADRAO, p_offset => 50" "$BASE AND $LOTE AND $CONT" score 50
cmp_lista E03 "$PADRAO, p_busca => 'ab1'" "(razao_social ILIKE '%ab1%' OR nome_fantasia ILIKE '%ab1%') AND $BASE AND $LOTE AND $CONT"
cmp_lista E04 "p_busca => 'xqzwkj', p_ultimo_lote => '2026-10'" "(razao_social ILIKE '%xqzwkj%' OR nome_fantasia ILIKE '%xqzwkj%') AND $BASE AND $LOTE"
cmp_lista E05 "$PADRAO, p_municipio => 'pomerode 1'" "municipio_nome ILIKE '%pomerode 1%' AND $BASE AND $LOTE AND $CONT"
cmp_lista E06 "$PADRAO, p_uf => 'SC'" "uf = 'SC' AND $BASE AND $LOTE AND $CONT"
cmp_lista E07 "$PADRAO, p_ufs => ARRAY['MG','PR']" "uf IN ('MG','PR') AND $BASE AND $LOTE AND $CONT"
cmp_lista E08 "$PADRAO, p_uf => 'SP', p_ufs => ARRAY['MG']" "uf = 'SP' AND $BASE AND $LOTE AND $CONT"
cmp_lista E09 "$PADRAO, p_cnae_exato => '3101200'" "cnae_principal = '3101200' AND $BASE AND $LOTE AND $CONT"
cmp_lista E10 "$PADRAO, p_cnae_prefixo => '3101'" "cnae_principal LIKE '3101%' AND $BASE AND $LOTE AND $CONT"
cmp_lista E11 "$PADRAO, p_status => 'em_conversa'" "prospeccao_status = 'em_conversa' AND ja_cliente = false AND $LOTE AND $CONT"
cmp_lista E12 "$PADRAO, p_incluir_ja_clientes => true" "prospeccao_status <> 'descartado' AND $LOTE AND $CONT"
cmp_lista E13 "$PADRAO, p_primeira_vista_min => '2026-10-20 06:00+00'" "$BASE AND $LOTE AND primeira_vista_em >= '2026-10-20 06:00+00' AND $CONT"
cmp_lista E14 "p_sugeridos_lote => '2026-10', p_sugeridos_score_min => 70, p_com_contato => true" \
  "ultimo_lote = '2026-10' AND prospeccao_status = 'em_conversa' AND ja_cliente = false AND omie_codigo_cliente IS NULL AND (rfb_situacao IS NULL OR rfb_situacao = '02') AND cnpj ~ '^[0-9A-Z]{12}[0-9]{2}\$' AND score >= 70 AND $CONT"
cmp_lista E15 "p_ultimo_lote => '2026-10', p_com_telefone => true" "$BASE AND $LOTE AND (telefone1 IS NOT NULL OR telefone2 IS NOT NULL)"
cmp_lista E16 "$PADRAO, p_data_abertura_min => '2010-01-01', p_data_abertura_max => '2015-06-30'" "$BASE AND $LOTE AND $CONT AND data_abertura >= '2010-01-01' AND data_abertura <= '2015-06-30'"
cmp_lista E17 "$PADRAO, p_ordem => 'capital_social'" "$BASE AND $LOTE AND $CONT" capital_social
cmp_lista E18 "$PADRAO, p_ordem => 'data_abertura', p_offset => 100" "$BASE AND $LOTE AND $CONT" data_abertura 100
cmp_lista E19 "$PADRAO, p_busca => '   '" "$BASE AND $LOTE AND $CONT"

# I: scans DENTRO da transação (pg_stat_xact), como o app.
scans() { # $1 = SELECT a medir → "seq=<n> trgm=<n>"
  Pq -c "BEGIN" -c "$COMO_APP" -c "SELECT count(*) FROM ($1) s" -c "SELECT 'seq=' || COALESCE((SELECT seq_scan FROM pg_stat_xact_user_tables WHERE relname = 'radar_empresas'), 0) || ' trgm=' || (pg_stat_get_xact_numscans('public.idx_radar_empresas_busca_trgm'::regclass) > 0)" -c "ROLLBACK" | tail -1
}
eq I0 "$(scans "SELECT * FROM public.radar_empresas WHERE (razao_social ILIKE '%xqzwkj%' OR nome_fantasia ILIKE '%xqzwkj%') AND $BASE AND $LOTE ORDER BY score DESC NULLS LAST, cnpj LIMIT 50")" "seq=1 trgm=false"
eq I1 "$(scans "SELECT * FROM public.radar_lista(p_busca => 'xqzwkj', p_ultimo_lote => '2026-10')")" "seq=0 trgm=true"
eq I2 "$(scans "SELECT * FROM public.radar_lista(p_municipio => 'pomerode 17', p_ultimo_lote => '2026-10')")" "seq=0 trgm=true"
eq I3 "$(scans "SELECT * FROM public.radar_lista($PADRAO)")" "seq=0 trgm=false"

sqlstate() { # $1 = prelúdio (papel/JWT), $2 = chamada → SQLSTATE exato (ou OK)
  P -qAt -c "$1" -c "DO \$t\$ BEGIN PERFORM * FROM ($2) s; RAISE NOTICE 'ESTADO=OK'; EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'ESTADO=%', SQLSTATE; END \$t\$" 2>&1 | grep -o 'ESTADO=[0-9A-Z]*' | head -1 || true
}
eq G1 "$(sqlstate "SET ROLE authenticated; SET request.jwt.claim.sub = '$USER_SEM'" "SELECT * FROM public.radar_lista()")" "ESTADO=42501"
eq G1b "$(sqlstate "SET ROLE authenticated; SET request.jwt.claim.sub = '$USER_CAP'" "SELECT * FROM public.radar_lista()")" "ESTADO=OK"
OID="'public.radar_lista(text,text,text,text[],text,text,text,boolean,text,timestamptz,text,numeric,boolean,boolean,date,date,text,integer,integer)'::regprocedure"
eq G2 "$(Pq -c "SELECT has_function_privilege('anon', $OID, 'EXECUTE')")" "f"
eq G3 "$(Pq -c "SELECT count(*) FROM pg_proc p, aclexplode(p.proacl) a WHERE p.oid = $OID AND a.grantee = 0")" "0"
eq V1 "$(sqlstate "$COMO_APP" "SELECT * FROM public.radar_lista(p_ordem => 'score DESC; SELECT 1')")" "ESTADO=22023"
eq V2 "$(sqlstate "$COMO_APP" "SELECT * FROM public.radar_lista(p_limit => 500)")" "ESTADO=22023"
eq V3 "$(sqlstate "$COMO_APP" "SELECT * FROM public.radar_lista(p_cnae_prefixo => '31%')")" "ESTADO=22023"
# W2: chamada direta com curinga — casa LITERAL (nenhuma razão tem 'a%b'); sem escape casaria milhares.
eq W2 "$(Pq -c "$COMO_APP" -c "SELECT count(*) FROM public.radar_lista(p_busca => 'a%b', p_limit => 200)")" "0"

# PRE: corpo vivo que derivou (outra sessão recriou) → o apply aborta em vez de apagá-lo.
Pq -c "DO \$d\$ BEGIN EXECUTE replace(pg_get_functiondef($OID), 'DECLARE', 'DECLARE -- deriva'); END \$d\$" >/dev/null
if aplicar > "$(dirname "$DATA")/pre.log" 2>&1; then
  eq PRE1 "apply passou" "apply abortado"
else
  eq PRE1 "$(grep -c 'PRE FALHOU' "$(dirname "$DATA")/pre.log")" "1"
fi

echo "PASS=$PASS  FAIL=$FAIL"
[ "$FAIL" -eq 0 ]
echo "RADAR_LISTA_PROVA_OK"
