#!/usr/bin/env bash
# Prova PG17 da migration 20261104153351_radar_cnae_secundario: o /radar filtra por CNAE secundário,
# combinado (E) com o principal. radar_contagem_por_municipio e radar_lista ganham p_cnae_secundario;
# o ranking lê radar_agregado_cnae_sec (secundário COBERTO = CNAE principal da base), a lista usa o GIN.
# Parte do estado de PROD (predecessoras da parte 2 + 20261103100000 + 20261103223300 + 20261103131500),
# aplica a migration REAL duas vezes (idempotência) e assevera:
#   A0  o estado de partida É o de prod (md5 de recalcular, contagem e lista)
#   E   as chamadas de antes (sem secundário) devolvem o MESMO — contagem e lista; fino e agregado iguais
#   S   contagem com secundário = oráculo (SQL direto na tabela): coberto só, com principal, prefixo,
#       estabelecidas (corte e corte + 1), região, inéditos, contato, status; NÃO coberto (vivo)
#   D1  código repetido no array da RFB conta a empresa 1 vez
#   I   secundário coberto lê 0 vezes radar_empresas; não coberto lê (controle)
#   L   lista com secundário = oráculo; com seqscan desligado usa o GIN
#   V   código mal formado grita nas duas RPCs
#   B   lote novo sem recálculo → secundário coberto INDISPONÍVEL; recálculo bate com a tabela
#   C   authenticated não lê radar_agregado_cnae_sec (42501); ACL das assinaturas novas; antigas sumiram
#   K2  cobertura gravada = CNAEs principais da base
#   F1  PRE: corpo vivo divergente ABORTA a migration e deixa o vivo intacto
#
#   bash db/test-radar-cnae-secundario.sh > /tmp/t.log 2>&1; echo "exit=$?"
#   SABOTAGEM=<nome> bash db/test-radar-cnae-secundario.sh   # tem de ficar VERMELHA
#   bash db/test-radar-cnae-secundario.sh --falsificar        # controle verde + cada sabotagem vermelha no assert dela
#   LOCALE_TESTE=pt_BR.UTF-8 bash db/test-radar-cnae-secundario.sh
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MIG="$REPO_ROOT/supabase/migrations/20261104153351_radar_cnae_secundario.sql"
MIG_P2="$REPO_ROOT/supabase/migrations/20261103100000_radar_agregado_municipio.sql"
MIG_P4="$REPO_ROOT/supabase/migrations/20261103223300_radar_agregado_cnae.sql"
MIG_LISTA="$REPO_ROOT/supabase/migrations/20261103131500_radar_lista_rpc.sql"
PRED="$REPO_ROOT/db/fixtures/radar-agregado-predecessoras-prod-20261103.sql"

if [ "${1:-}" = "--falsificar" ]; then
  # nome:VERMELHOS — asserts (unidos por ',') que TÊM de ficar vermelhos; ou `APPLY!MARCA` quando a
  # postcondição/PRE da própria migration TEM de abortar o apply com aquela marca (`_` vira espaço).
  SABOTAGENS="sec_ignorado_agg:S1,S2 sec_principal_ignorado:S2 sec_sem_distinct:D1,S1 sec_sem_cobertura:S7,S8 sec_vivo_ignorado:S7,S8 agg_padrao_com_sec:S1,S7 fino_com_sec:S2,S3 sec_nunca:I5 sec_sem_validade:B1d lista_ignorada:L1,L2,L3 lista_sem_indice:L4 cobertura_errada:APPLY!P5_FALHOU:_cobertura tabela_sec_aberta:APPLY!P2_FALHOU tabela_sec_aberta_sem_post:C1a lista_anon:APPLY!P3_FALHOU sem_gin:APPLY!P4_FALHOU pre_cega:F1a,F1b"
  LOGDIR="$(mktemp -d "${TMPDIR:-/tmp}/falsifica-radar-cnae-sec.XXXXXX")"
  echo "══ CONTROLE ══"
  if ! SABOTAGEM="" bash "$0" > "$LOGDIR/controle.log" 2>&1; then
    echo "❌ controle VERMELHO — falsificação abortada (log: $LOGDIR/controle.log)"; tail -15 "$LOGDIR/controle.log"; exit 1
  fi
  grep -q "RADAR_CNAE_SECUNDARIO_PROVA_OK" "$LOGDIR/controle.log" || { echo "❌ controle sem marcador de fim"; exit 1; }
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
PORT="${PGPORT_TEST:-5576}"
DATA="$(mktemp -d "${TMPDIR:-/tmp}/pgtest-radar-cnae-sec.XXXXXX")/data"
LOCALE_TESTE="${LOCALE_TESTE:-C}"
export LC_ALL="$LOCALE_TESTE" LANG="$LOCALE_TESTE"
MIG_USADA="$(dirname "$DATA")/mig.sql"
cleanup() { "$PGBIN/pg_ctl" -D "$DATA" stop -m immediate >/dev/null 2>&1 || true; rm -rf "$(dirname "$DATA")"; }
trap cleanup EXIT

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
# Sabotagem no CORPO de uma função muda o prosrc → a PÓS P1 e a PRE do 2º apply pegariam antes da suíte.
# Para provar que o assert da suíte tem dente sozinho: P1 vira NOTICE e o 2º apply não roda.
CORPO=0
cegar_md5() { CORPO=1; sabotar "    RAISE EXCEPTION 'P1 FALHOU: as funções vivas" "    RAISE NOTICE 'P1 FALHOU: as funções vivas"; }
# shellcheck disable=SC2016  # os trechos sabotados são SQL literal ($19, $w$…), não expansão do shell
case "${SABOTAGEM:-}" in
  "") ;;
  sec_ignorado_agg)   cegar_md5; sabotar "         WHERE a.cnae_secundario = p_cnae_secundario
" "         WHERE true
" ;;
  sec_principal_ignorado) cegar_md5; sabotar "         WHERE a.cnae_secundario = p_cnae_secundario
           AND (p_uf IS NULL OR a.uf = p_uf)
           AND (p_uf IS NOT NULL OR p_ufs IS NULL OR a.uf = ANY (p_ufs))
           AND (p_cnae_exato  IS NULL OR a.cnae_principal = p_cnae_exato)
" "         WHERE a.cnae_secundario = p_cnae_secundario
           AND (p_uf IS NULL OR a.uf = p_uf)
           AND (p_uf IS NOT NULL OR p_ufs IS NULL OR a.uf = ANY (p_ufs))
" ;;
  sec_sem_distinct)   cegar_md5; sabotar "SELECT DISTINCT x.cs FROM unnest" "SELECT x.cs FROM unnest" ;;
  sec_sem_cobertura)  cegar_md5; sabotar "
       AND EXISTS (SELECT 1 FROM public.radar_agregado_estado e
                    WHERE e.id = 1 AND p_cnae_secundario = ANY (e.cnaes_secundarios_cobertos)) THEN" " THEN" ;;
  sec_vivo_ignorado)  cegar_md5; sabotar "     AND (p_cnae_secundario IS NULL OR re.cnaes_secundarios @> ARRAY[p_cnae_secundario])
" "" ;;
  agg_padrao_com_sec) cegar_md5; sabotar "IF p_cnae_prefix IS NULL AND p_cnae_exato IS NULL AND p_cnae_secundario IS NULL" "IF p_cnae_prefix IS NULL AND p_cnae_exato IS NULL" ;;
  fino_com_sec)       cegar_md5; sabotar "    IF v_estab IS DISTINCT FROM 'vivo' AND p_cnae_secundario IS NULL THEN" "    IF v_estab IS DISTINCT FROM 'vivo' THEN" ;;
  sec_nunca)          cegar_md5; sabotar "    IF v_estab IS DISTINCT FROM 'vivo' AND p_cnae_secundario IS NOT NULL" "    IF false AND p_cnae_secundario IS NOT NULL" ;;
  sec_sem_validade)   cegar_md5; sabotar "(e.cnaes_secundarios_cobertos)) THEN
      IF private.radar_agregado_valido() IS NULL THEN" "(e.cnaes_secundarios_cobertos)) THEN
      IF false THEN" ;;
  lista_ignorada)     cegar_md5; sabotar '    v_w := array_append(v_w, $w$e.cnaes_secundarios @> ARRAY[$19]$w$);' '    NULL;' ;;
  lista_sem_indice)   cegar_md5; sabotar 'e.cnaes_secundarios @> ARRAY[$19]$w$' '$19 = ANY (e.cnaes_secundarios)$w$' ;;
  cobertura_errada)   cegar_md5; sabotar "    SELECT min(cnae_principal) FROM public.radar_empresas
" "    SELECT min(cnae_principal) FROM public.radar_empresas WHERE cnae_principal > '2'
" ;;
  tabela_sec_aberta)  sabotar "REVOKE ALL ON TABLE public.radar_agregado_cnae_sec FROM PUBLIC, anon, authenticated;" "GRANT SELECT ON TABLE public.radar_agregado_cnae_sec TO authenticated;" ;;
  tabela_sec_aberta_sem_post)
                      sabotar "REVOKE ALL ON TABLE public.radar_agregado_cnae_sec FROM PUBLIC, anon, authenticated;" "GRANT SELECT ON TABLE public.radar_agregado_cnae_sec TO authenticated;"
                      sabotar "    RAISE EXCEPTION 'P2 FALHOU: radar_agregado_cnae_sec legível" "    RAISE NOTICE 'P2 FALHOU: radar_agregado_cnae_sec legível" ;;
  lista_anon)         sabotar "date,date,text,integer,integer,text) TO authenticated, service_role;" "date,date,text,integer,integer,text) TO anon, authenticated, service_role;" ;;
  sem_gin)            sabotar "CREATE INDEX IF NOT EXISTS idx_radar_empresas_cnaes_sec ON public.radar_empresas USING gin (cnaes_secundarios);" "" ;;
  pre_cega)           sabotar "    IF v_rec IS NULL OR v_rec NOT IN" "    IF false AND v_rec NOT IN" ;;
  *) echo "sabotagem desconhecida: $SABOTAGEM"; exit 9 ;;
esac
[ -n "${SABOTAGEM:-}" ] && echo "⚠️  SABOTAGEM ATIVA: $SABOTAGEM"

"$PGBIN/initdb" -D "$DATA" -U postgres -E UTF8 --locale="$LOCALE_TESTE" >/dev/null
"$PGBIN/pg_ctl" -D "$DATA" -o "-p $PORT -k /tmp" -l "$(dirname "$DATA")/pg.log" -w start >/dev/null
PD() { local db="$1"; shift; "$PGBIN/psql" -X -v ON_ERROR_STOP=1 -p "$PORT" -h /tmp -U postgres -d "$db" "$@"; }
P()  { PD base "$@"; }
Pq() { P -qAt "$@"; }

PD postgres -q -c "CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN; CREATE ROLE service_role NOLOGIN;" -c "CREATE DATABASE base;"

P -q <<'SQL'
CREATE EXTENSION pg_trgm;
CREATE SCHEMA auth;
CREATE SCHEMA private;
-- Como o Supabase: o que o postgres cria em public nasce com GRANT a anon/authenticated/service_role.
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON FUNCTIONS TO anon, authenticated, service_role;
CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT '00000000-0000-0000-0000-0000000000a1'::uuid $$;
CREATE FUNCTION private.cap_radar_prospectar(uuid) RETURNS boolean LANGUAGE sql STABLE AS $$ SELECT true $$;
-- corpo de prod (psql-ro, 2026-11-03)
CREATE FUNCTION private.padrao_like_contem(p_termo text) RETURNS text LANGUAGE sql IMMUTABLE PARALLEL SAFE STRICT
  SET search_path TO ''
AS $function$
  SELECT CASE
    WHEN btrim(translate(p_termo, '%_', ''), E' \t\r\n') = '' THEN NULL
    ELSE '%' || replace(replace(replace(p_termo, '\', '\\'), '%', '\%'), '_', '\_') || '%'
  END
$function$;
CREATE SCHEMA cron;
CREATE TABLE cron.job (jobid bigint PRIMARY KEY, jobname text, schedule text, command text, active boolean DEFAULT true,
  username text DEFAULT current_user, database text DEFAULT current_database());
CREATE FUNCTION cron.schedule(p_jobname text, p_schedule text, p_command text) RETURNS bigint LANGUAGE plpgsql AS $$
DECLARE v bigint;
BEGIN
  SELECT jobid INTO v FROM cron.job WHERE jobname = p_jobname;
  IF v IS NULL THEN
    SELECT COALESCE(max(jobid),0)+1 INTO v FROM cron.job;
    INSERT INTO cron.job (jobid, jobname, schedule, command) VALUES (v, p_jobname, p_schedule, p_command);
  ELSE
    UPDATE cron.job SET schedule = p_schedule, command = p_command WHERE jobid = v;
  END IF;
  RETURN v;
END $$;
CREATE TABLE public.radar_ingest_state (mes_referencia text PRIMARY KEY, status text NOT NULL, iniciado_em timestamptz, novos integer);
CREATE TABLE public.radar_municipios (codigo text PRIMARY KEY, nome text, uf text, lat double precision, lng double precision);
CREATE TABLE public.omie_cliente_confirmacoes (account text, documento text, codigo_cliente bigint, origem text);
CREATE TABLE public.radar_concorrentes_lote (lote text PRIMARY KEY);
CREATE TABLE public.radar_concorrentes_municipio (lote text, municipio_codigo text, uf text, quantidade integer);
CREATE TABLE public.radar_empresas (
  cnpj text PRIMARY KEY, razao_social text, nome_fantasia text, cnae_principal text NOT NULL, cnaes_secundarios text[],
  data_abertura date, municipio_codigo text, municipio_nome text, uf text, telefone1 text, telefone2 text, email text,
  prospeccao_status text NOT NULL, ja_cliente boolean NOT NULL, ultimo_lote text NOT NULL,
  primeira_vista_em timestamptz NOT NULL, omie_codigo_cliente bigint, omie_cadastrado_em timestamptz,
  capital_social numeric, score smallint, rfb_situacao text);
ALTER TABLE public.radar_empresas ENABLE ROW LEVEL SECURITY;
CREATE INDEX idx_radar_empresas_busca_trgm ON public.radar_empresas USING gin (razao_social gin_trgm_ops);

INSERT INTO public.radar_ingest_state VALUES
  ('2026-08','complete','2026-10-19 16:31:08.593+00', 27466),
  ('2026-10','complete','2026-10-27 16:20:37.722+00', 8587);
INSERT INTO public.radar_municipios
SELECT 'M'||lpad(i::text,2,'0'), 'CIDADE '||i, (ARRAY['MG','SP','SC','RJ'])[1 + i % 4], -20 - i, -45 - i
  FROM generate_series(1, 12) i WHERE i <> 11;
-- 4.000 empresas determinísticas (hash do índice) cobrindo cada eixo do agregado; abertura 2010–2023.
-- Secundários: cobertos (3101200, 3102100, 1622699 — principais da base) e não cobertos (2391503 marmoraria,
-- 4330404); array vazio, NULL e o mesmo código repetido (3102100 2×, como a RFB às vezes traz).
INSERT INTO public.radar_empresas
SELECT lpad(i::text, 14, '0'), 'EMPRESA '||i, NULL,
       (ARRAY['3101200','3102100','4744001','1622699'])[1 + (h % 4)],
       CASE WHEN h % 29 = 0 THEN NULL
            WHEN h % 5 = 0 THEN ARRAY[]::text[]
            ELSE ARRAY[(ARRAY['3102100','1622699','3101200','2391503','4330404'])[1 + (h / 3) % 5],
                       (ARRAY['2391503','3101200','4330404','3102100','1622699'])[1 + (h / 31) % 5]]
                 || CASE WHEN h % 11 = 0 THEN ARRAY['3102100','3102100'] ELSE ARRAY[]::text[] END END,
       CASE WHEN h % 53 = 0 THEN NULL ELSE date '2010-01-01' + (h % 5000) END,
       CASE WHEN h % 97 = 0 THEN NULL ELSE 'M'||lpad((1 + (h / 7) % 12)::text, 2, '0') END,
       CASE WHEN h % 97 = 0 THEN NULL
            WHEN (1 + (h / 7) % 12) = 12 AND h % 2 = 0 THEN 'CIDADE DOZE'
            ELSE 'CIDADE RFB '||(1 + (h / 7) % 12) END,
       CASE WHEN h % 89 = 0 THEN NULL ELSE (ARRAY['MG','SP','SC','RJ'])[1 + ((1 + (h / 7) % 12) % 4)] END,
       CASE WHEN h % 3 = 0 THEN '31'||lpad((h % 100000000)::text, 8, '0') END,
       CASE WHEN h % 11 = 0 THEN '11'||lpad((h % 100000000)::text, 8, '0') END,
       CASE WHEN h % 5 = 0 THEN 'x'||i||'@ex.com' END,
       (ARRAY['a_contatar','a_contatar','a_contatar','a_contatar','descartado','em_conversa','virou_cliente'])[1 + (h / 13) % 7],
       (h / 17) % 9 = 0,
       CASE WHEN (h / 19) % 6 = 0 THEN '2026-08' ELSE '2026-10' END,
       CASE WHEN (h / 23) % 4 = 0 THEN timestamptz '2026-10-28 03:00+00' ELSE timestamptz '2026-06-12 01:10+00' END,
       NULL, NULL,
       (h % 1000) * 100, CASE WHEN h % 37 = 0 THEN NULL ELSE (h / 41) % 100 END, '02'
  FROM (SELECT i, abs(hashtext('radar' || i)) AS h FROM generate_series(1, 4000) i) s;
-- Bordas do corte (data de São Paulo de HOJE − 5 anos): 30 abertas no corte e 30 no corte + 1 dia.
UPDATE public.radar_empresas
   SET data_abertura = ((now() AT TIME ZONE 'America/Sao_Paulo')::date - interval '5 years')::date
                       + (cnpj::bigint % 2)::integer
 WHERE cnpj::bigint % 67 = 0;
SQL

# Estado de PROD: predecessoras da parte 2 com o ACL de prod; parte 2, parte 4 e a lista por cima.
P -q -f "$PRED"
FCONT_ANT="public.radar_contagem_por_municipio(text,text,text,text,boolean,date,date,integer,text,timestamptz,text[],boolean)"
FCONT="public.radar_contagem_por_municipio(text,text,text,text,boolean,date,date,integer,text,timestamptz,text[],boolean,text)"
FLISTA_ANT="public.radar_lista(text,text,text,text[],text,text,text,boolean,text,timestamptz,text,numeric,boolean,boolean,date,date,text,integer,integer)"
FLISTA="public.radar_lista(text,text,text,text[],text,text,text,boolean,text,timestamptz,text,numeric,boolean,boolean,date,date,text,integer,integer,text)"
FREC="public.radar_agregado_recalcular(boolean,timestamptz)"
for f in "public.radar_kpis()" "$FCONT_ANT" "public.radar_penetracao_por_municipio(text,text,integer)"; do
  Pq -c "REVOKE ALL ON FUNCTION $f FROM PUBLIC, anon; GRANT EXECUTE ON FUNCTION $f TO authenticated, service_role;" >/dev/null
done
P -q -f "$MIG_P2" >/dev/null 2>&1
P -q -f "$MIG_P4" >/dev/null 2>&1
P -q -f "$MIG_LISTA" >/dev/null 2>&1
Pq -c "ANALYZE public.radar_empresas;" >/dev/null
md5f() { Pq -c "SELECT md5(prosrc) FROM pg_proc WHERE oid = to_regprocedure('$1')"; }
MD5_PARTIDA="$(md5f "$FREC")/$(md5f "$FCONT_ANT")/$(md5f "$FLISTA_ANT")"

# Foto de uma chamada de contagem: "codigo|nome|uf|lat|total/tel/ac", separados por ' ; '.
foto() { Pq -c "SELECT coalesce(string_agg(coalesce(municipio_codigo,'∅')||'|'||coalesce(municipio_nome,'∅')||'|'||coalesce(uf,'∅')||'|'||coalesce(lat::text,'∅')||'|'||total||'/'||com_telefone||'/'||a_contatar, ' ; ' ORDER BY o), '(vazio)')
                  FROM public.radar_contagem_por_municipio($1) WITH ORDINALITY AS t(municipio_codigo, municipio_nome, uf, lat, lng, total, com_telefone, a_contatar, o);"; }
# Oráculo: a mesma foto contada direto na tabela, com o recorte escrito à mão.
oraculo() { Pq -c "SELECT coalesce(string_agg(x, ' ; '), '(vazio)') FROM (
  SELECT coalesce(re.municipio_codigo,'∅')||'|'||coalesce(COALESCE(m.nome, re.municipio_nome),'∅')||'|'||coalesce(re.uf,'∅')||'|'||coalesce(m.lat::text,'∅')||'|'
         ||count(*)||'/'||count(*) FILTER (WHERE re.telefone1 IS NOT NULL OR re.telefone2 IS NOT NULL)||'/'||count(*) FILTER (WHERE re.prospeccao_status = 'a_contatar') AS x
    FROM public.radar_empresas re LEFT JOIN public.radar_municipios m ON m.codigo = re.municipio_codigo
   WHERE $1
   GROUP BY re.municipio_codigo, COALESCE(m.nome, re.municipio_nome), re.uf, m.lat, m.lng) s"; }
ordena() { printf '%s' "$1" | sed 's/ ; /\n/g' | LC_ALL=C sort | tr '\n' ';'; }
soma_total() { printf '%s' "$1" | sed 's/ ; /\n/g' | awk -F'|' '{split($5,a,"/"); s+=a[1]} END {print s+0}'; }
tabela_md5() { Pq -c "SELECT md5(coalesce(string_agg(t::text, ',' ORDER BY t::text), '')) || ':' || count(*) FROM public.$1 t"; }
# Lista: os CNPJs na ordem devolvida.
lista() { Pq -c "SELECT coalesce(string_agg(t.cnpj, ',' ORDER BY t.ordinality), '(vazio)') FROM public.radar_lista($1) WITH ORDINALITY AS t"; }
lista_oraculo() { Pq -c "SELECT coalesce(string_agg(cnpj, ',' ORDER BY score DESC NULLS LAST, cnpj), '(vazio)') FROM (
  SELECT cnpj, score FROM public.radar_empresas WHERE $1 ORDER BY score DESC NULLS LAST, cnpj LIMIT 50) s"; }

CORTE="$(Pq -c "SELECT ((now() AT TIME ZONE 'America/Sao_Paulo')::date - interval '5 years')::date")"
CORTE1="$(Pq -c "SELECT '$CORTE'::date + 1")"
INI="'2026-10-27 16:20:37.722+00'::timestamptz"
REG="p_ufs => ARRAY['MG','SP','RJ']"
BASE="prospeccao_status <> 'descartado' AND ja_cliente = false"
declare -a CHAMADAS=(
  "a|p_cnae_exato => '3101200', p_lote => '2026-10'"
  "b|p_cnae_prefix => '31', p_lote => '2026-10', $REG, p_com_contato => true"
  "d|p_cnae_exato => '1622699', p_uf => 'MG', p_incluir_ja_clientes => true"
  "g|p_data_abertura_max => '$CORTE', p_lote => '2026-10', $REG, p_com_contato => true"
  "h|p_data_abertura_max => '$CORTE1', p_lote => '2026-10'"
  "k|p_data_abertura_max => '2015-06-01', p_lote => '2026-10'"
  "l|p_data_abertura_min => '2015-01-01', p_cnae_prefix => '31'"
  "m|p_lote => '2026-10', $REG, p_com_contato => true"
  "o|p_cnae_prefix => '31', p_lote => '2026-10', p_primeira_vista_min => '2026-06-01 00:00+00'"
)
declare -a LISTAS=(
  "a|p_cnae_exato => '3101200'"
  "b|p_cnae_prefixo => '31', p_uf => 'MG', p_com_contato => true"
  "c|p_ordem => 'data_abertura', p_ultimo_lote => '2026-10'"
)
ANTES_DIR="$(dirname "$DATA")/antes"; mkdir -p "$ANTES_DIR"
antes() { cat "$ANTES_DIR/$1"; }
for c in "${CHAMADAS[@]}"; do foto "${c#*|}" > "$ANTES_DIR/c${c%%|*}"; done
for c in "${LISTAS[@]}"; do lista "${c#*|}" > "$ANTES_DIR/l${c%%|*}"; done
AGG_ANTES="$(tabela_md5 radar_agregado_municipio)"
FINO_ANTES="$(tabela_md5 radar_agregado_cnae)"

# F1 precisa de um banco onde o corpo vivo DIVERGE da predecessora: clona ANTES de aplicar.
PD postgres -q -c "CREATE DATABASE divergente TEMPLATE base;"
PD divergente -q -c "CREATE OR REPLACE FUNCTION public.radar_agregado_recalcular(p_forcar boolean DEFAULT false, p_agora timestamptz DEFAULT now())
 RETURNS jsonb LANGUAGE sql SECURITY DEFINER SET search_path TO 'public' AS \$f\$ SELECT '{\"OUTRA\":\"SESSAO\"}'::jsonb \$f\$;"

P -q -f "$MIG_USADA" >/dev/null
if [ "$CORPO" -eq 0 ]; then
  P -q -f "$MIG_USADA" >/dev/null   # idempotente: o 2º apply passa a PRE pela assinatura nova com "este"
fi

PASS=0; FAIL=0
eq() { if [ "$2" = "$3" ]; then echo "PASS $1"; PASS=$((PASS+1)); else echo "FAIL $1 — obtido [$2] esperado [$3]"; FAIL=$((FAIL+1)); fi; }
falha() { Pq -c "DO \$t\$ BEGIN
  PERFORM * FROM $1;
  RAISE NOTICE 'R:ACEITOU';
EXCEPTION WHEN raise_exception THEN
  IF SQLERRM LIKE 'agregado indispon%' THEN RAISE NOTICE 'R:INDISPONIVEL';
  ELSIF SQLERRM LIKE 'cnae_secundario inv%' THEN RAISE NOTICE 'R:INVALIDO'; ELSE RAISE; END IF;
WHEN invalid_parameter_value THEN
  IF SQLERRM LIKE 'cnae_secundario inv%' THEN RAISE NOTICE 'R:INVALIDO'; ELSE RAISE; END IF;
END \$t\$;" 2>&1 | grep -oE 'R:[A-Z]{2,}' || true; }
# Leituras de radar_empresas (seq + índice) dentro de UMA chamada.
leituras() { Pq -c "BEGIN;
  SELECT count(*) FROM public.radar_contagem_por_municipio($1);
  SELECT coalesce(sum(seq_scan + coalesce(idx_scan,0)),0) FROM pg_stat_xact_user_tables WHERE relname = 'radar_empresas';
ROLLBACK;" | tail -1; }

eq "A0 partida = prod (md5 recalcular/contagem/lista)" "$MD5_PARTIDA" \
   "f2302e3237f0bf804727d3587b08619b/78fc43862dbe903f2966a69aac9dbaf6/3da72da3d39522f93c00caf2db270998"

# E — o que já existia não muda.
for c in "${CHAMADAS[@]}"; do
  id="${c%%|*}"
  eq "Ec$id contagem($id) = antes" "$(ordena "$(foto "${c#*|}")")" "$(ordena "$(antes "c$id")")"
done
for c in "${LISTAS[@]}"; do
  id="${c%%|*}"
  eq "El$id lista($id) = antes" "$(lista "${c#*|}")" "$(antes "l$id")"
done
eq "E1 agregado por município = o de antes" "$(tabela_md5 radar_agregado_municipio)" "$AGG_ANTES"
eq "E2 agregado fino = o de antes" "$(tabela_md5 radar_agregado_cnae)" "$FINO_ANTES"
eq "K2 cobertura = CNAEs principais da base" "$(Pq -c "SELECT cnaes_secundarios_cobertos::text FROM public.radar_agregado_estado")" "{1622699,3101200,3102100,4744001}"

# S — contagem com secundário = oráculo.
declare -a SEC=(
  "1|p_cnae_secundario => '3102100', p_lote => '2026-10'|cnaes_secundarios @> '{3102100}' AND ultimo_lote = '2026-10' AND $BASE"
  "2|p_cnae_exato => '3101200', p_cnae_secundario => '3102100'|cnae_principal = '3101200' AND cnaes_secundarios @> '{3102100}' AND $BASE"
  "3|p_cnae_prefix => '31', p_cnae_secundario => '1622699', p_data_abertura_max => '$CORTE', $REG|cnae_principal LIKE '31%' AND cnaes_secundarios @> '{1622699}' AND data_abertura <= '$CORTE' AND re.uf IN ('MG','SP','RJ') AND $BASE"
  "4|p_cnae_secundario => '3101200', p_data_abertura_max => '$CORTE1', p_lote => '2026-10'|cnaes_secundarios @> '{3101200}' AND data_abertura <= '$CORTE1' AND ultimo_lote = '2026-10' AND $BASE"
  "5|p_cnae_secundario => '3102100', p_lote => '2026-10', p_primeira_vista_min => $INI, p_com_contato => true|cnaes_secundarios @> '{3102100}' AND ultimo_lote = '2026-10' AND primeira_vista_em >= $INI AND (telefone1 IS NOT NULL OR telefone2 IS NOT NULL OR email IS NOT NULL) AND $BASE"
  "6|p_cnae_secundario => '3101200', p_status => 'em_conversa', p_incluir_ja_clientes => true, p_uf => 'SP'|cnaes_secundarios @> '{3101200}' AND prospeccao_status = 'em_conversa' AND re.uf = 'SP'"
  "7|p_cnae_secundario => '2391503', p_lote => '2026-10'|cnaes_secundarios @> '{2391503}' AND ultimo_lote = '2026-10' AND $BASE"
  "8|p_cnae_exato => '3101200', p_cnae_secundario => '2391503', p_data_abertura_max => '$CORTE'|cnae_principal = '3101200' AND cnaes_secundarios @> '{2391503}' AND data_abertura <= '$CORTE' AND $BASE"
)
VAZIAS=""
for c in "${SEC[@]}"; do
  id="${c%%|*}"; resto="${c#*|}"; args="${resto%%|*}"; onde="${resto#*|}"
  obtido="$(foto "$args")"
  eq "S$id secundário($id) = oráculo" "$(ordena "$obtido")" "$(ordena "$(oraculo "$onde")")"
  [ "$obtido" = "(vazio)" ] && VAZIAS="$VAZIAS $id"
done
eq "S0 âncora: nenhuma chamada com secundário é vazia" "${VAZIAS:-nenhuma}" "nenhuma"
eq "D0 âncora: a fixture tem código repetido no array" "$(Pq -c "SELECT count(*) > 0 FROM public.radar_empresas WHERE cardinality(cnaes_secundarios) > (SELECT count(DISTINCT x) FROM unnest(cnaes_secundarios) x)")" "t"
eq "D1 repetido conta 1 vez (agregado secundário = empresas com o código)" \
   "$(Pq -c "SELECT sum(n) FROM public.radar_agregado_cnae_sec WHERE cnae_secundario = '3102100'")" \
   "$(Pq -c "SELECT count(*) FROM public.radar_empresas WHERE cnaes_secundarios @> '{3102100}'")"

eq "I5 secundário coberto: 0 leituras de radar_empresas" "$(leituras "p_cnae_exato => '3101200', p_cnae_secundario => '3102100', p_lote => '2026-10'")" "0"
eq "I6 controle: secundário não coberto lê a tabela" "$( [ "$(leituras "p_cnae_secundario => '2391503'")" -gt 0 ] && echo le)" "le"

# L — lista com secundário.
LVAZ=""
declare -a LSEC=(
  "1|p_cnae_secundario => '3102100'|cnaes_secundarios @> '{3102100}' AND $BASE"
  "2|p_cnae_exato => '3101200', p_cnae_secundario => '2391503'|cnae_principal = '3101200' AND cnaes_secundarios @> '{2391503}' AND $BASE"
  "3|p_cnae_secundario => '4330404', p_uf => 'SP'|cnaes_secundarios @> '{4330404}' AND uf = 'SP' AND $BASE"
)
for c in "${LSEC[@]}"; do
  id="${c%%|*}"; resto="${c#*|}"; args="${resto%%|*}"; onde="${resto#*|}"
  obtido="$(lista "$args")"
  eq "L$id lista com secundário($id) = oráculo" "$obtido" "$(lista_oraculo "$onde")"
  [ "$obtido" = "(vazio)" ] && LVAZ="$LVAZ $id"
done
eq "L0 âncora: nenhuma lista com secundário é vazia" "${LVAZ:-nenhuma}" "nenhuma"
eq "L4 lista com secundário usa o GIN (seqscan desligado)" "$(Pq -c "BEGIN; SET LOCAL enable_seqscan = off;
  SELECT count(*) FROM public.radar_lista(p_cnae_secundario => '2391503', p_limit => 200);
  SELECT pg_stat_get_xact_numscans('public.idx_radar_empresas_cnaes_sec'::regclass) > 0;
ROLLBACK;" | tail -1)" "t"

eq "V1 contagem: código mal formado grita" "$(falha "public.radar_contagem_por_municipio(p_cnae_secundario => '31')")" "R:INVALIDO"
eq "V2 lista: código mal formado grita" "$(falha "public.radar_lista(p_cnae_secundario => '3101-2')")" "R:INVALIDO"

# B — lote novo: 2026-11 complete; 300 empresas mudam de lote (a carga), sem recálculo ainda.
Pq -c "INSERT INTO public.radar_ingest_state VALUES ('2026-11','complete','2026-11-28 10:00+00', 300);
       UPDATE public.radar_empresas SET ultimo_lote = '2026-11' WHERE cnpj::bigint % 13 = 0;" >/dev/null
eq "B1d secundário coberto com agregado de outro lote = indisponível" "$(falha "public.radar_contagem_por_municipio(p_cnae_secundario => '3102100', p_lote => '2026-11')")" "R:INDISPONIVEL"
eq "B1e secundário não coberto (vivo) segue respondendo" "$(falha "public.radar_contagem_por_municipio(p_cnae_secundario => '2391503')")" "R:ACEITOU"
eq "B2a recálculo no lote novo" "$(Pq -c "SELECT public.radar_agregado_recalcular(false, now())->>'recalculou'")" "true"
eq "B2d secundário do lote novo = tabela" \
   "$(soma_total "$(foto "p_cnae_secundario => '1622699', p_lote => '2026-11', p_incluir_ja_clientes => true, p_status => 'a_contatar'")")" \
   "$(Pq -c "SELECT count(*) FROM public.radar_empresas WHERE ultimo_lote = '2026-11' AND prospeccao_status = 'a_contatar' AND cnaes_secundarios @> '{1622699}'")"

# C — fechado e com o ACL certo.
estado_sob_auth() { local s; s="$(P -qAt -v VERBOSITY=verbose -c "SET ROLE authenticated; $1" 2>&1 | sed -nE 's/^(ERROR|ERRO): +([0-9A-Z]{5}):.*/\2/p' | head -1)"; printf '%s' "${s:-LEU}"; }
eq "C1a authenticated não lê radar_agregado_cnae_sec (42501)" "$(estado_sob_auth "SELECT count(*) FROM public.radar_agregado_cnae_sec")" "42501"
eq "C1b RLS ligada no secundário" "$(Pq -c "SELECT relrowsecurity FROM pg_class WHERE relname = 'radar_agregado_cnae_sec'")" "t"
eq "C2 ACL: contagem e lista p/ authenticated e não anon; recalcular só owner" \
   "$(Pq -c "SELECT has_function_privilege('authenticated', '$FCONT', 'EXECUTE')||'/'||has_function_privilege('anon', '$FCONT', 'EXECUTE')||'/'||has_function_privilege('authenticated', '$FLISTA', 'EXECUTE')||'/'||has_function_privilege('anon', '$FLISTA', 'EXECUTE')||'/'||has_function_privilege('authenticated', '$FREC', 'EXECUTE')")" \
   "true/false/true/false/false"
eq "C3 assinaturas antigas sumiram (uma sobrecarga só)" \
   "$(Pq -c "SELECT (to_regprocedure('$FCONT_ANT') IS NULL)::text||'/'||(to_regprocedure('$FLISTA_ANT') IS NULL)::text||'/'||count(*) FROM pg_proc WHERE proname IN ('radar_contagem_por_municipio','radar_lista')")" \
   "true/true/2"

# F1 — PRE: com o corpo vivo divergente, a migration aborta e a função da outra sessão fica.
SAIDA_DIV="$(PD divergente -q -f "$MIG_USADA" 2>&1 || true)"
eq "F1a PRE aborta com corpo vivo divergente" "$(printf '%s' "$SAIDA_DIV" | grep -o 'PRE FALHOU: radar_agregado_recalcular' | head -1)" "PRE FALHOU: radar_agregado_recalcular"
eq "F1b o vivo divergente segue intacto e nada foi criado" \
   "$(PD divergente -qAt -c "SELECT (SELECT prosrc LIKE '%OUTRA%' FROM pg_proc WHERE proname = 'radar_agregado_recalcular')::text||'/'||(to_regclass('public.radar_agregado_cnae_sec') IS NULL)::text")" "true/true"

echo "PASS=$PASS  FAIL=$FAIL"
[ "$FAIL" -eq 0 ] && echo "RADAR_CNAE_SECUNDARIO_PROVA_OK"
