#!/usr/bin/env bash
# Prova PG17 da migration 20261106175800_radar_mapa_regiao_cidade_telefone (Radar, pacote C):
#   C1  radar_penetracao_por_municipio ganha p_ufs (a região da tela; UF escolhida vence)
#   C2  radar_lista ganha p_municipio_codigo (cidade EXATA pelo código; o nome tem homônimos em outras UFs)
#   C3  radar_contagem_por_municipio ganha p_com_telefone ("só com telefone" também no ranking/mapa)
# Parte do estado de PROD (predecessoras + 20261103100000 + 20261103223300 + 20261103131500 + 20261104153351),
# aplica a migration REAL duas vezes (idempotência) e assevera:
#   A0  o estado de partida É o de prod (md5 de penetração, contagem e lista)
#   E   as chamadas de antes (sem os parâmetros novos) devolvem o MESMO — penetração, contagem e lista
#   R   penetração com região = oráculo (SQL direto); concorrente fora da região some; UF vence a região
#   T   contagem com telefone = oráculo nos 4 caminhos (agregado, fino, secundário coberto, vivo); agregado
#       continua sem ler radar_empresas
#   M   lista pela cidade exata = oráculo; o nome sozinho traz a homônima de outra UF (controle do defeito)
#   V   região vazia/mal formada e código de município mal formado gritam com SQLSTATE 22023
#   C   ACL das assinaturas novas (authenticated sim, anon 42501); as antigas sumiram
#   F1  PRE: corpo vivo divergente ABORTA a migration e nada é dropado
#
#   bash db/test-radar-mapa-regiao-cidade.sh > /tmp/t.log 2>&1; echo "exit=$?"
#   SABOTAGEM=<nome> bash db/test-radar-mapa-regiao-cidade.sh   # tem de ficar VERMELHA
#   bash db/test-radar-mapa-regiao-cidade.sh --falsificar        # controle verde + cada sabotagem vermelha no assert dela
#   LOCALE_TESTE=pt_BR.UTF-8 bash db/test-radar-mapa-regiao-cidade.sh
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MIG="$REPO_ROOT/supabase/migrations/20261106175800_radar_mapa_regiao_cidade_telefone.sql"
MIG_P2="$REPO_ROOT/supabase/migrations/20261103100000_radar_agregado_municipio.sql"
MIG_P4="$REPO_ROOT/supabase/migrations/20261103223300_radar_agregado_cnae.sql"
MIG_LISTA="$REPO_ROOT/supabase/migrations/20261103131500_radar_lista_rpc.sql"
MIG_SEC="$REPO_ROOT/supabase/migrations/20261104153351_radar_cnae_secundario.sql"
PRED="$REPO_ROOT/db/fixtures/radar-agregado-predecessoras-prod-20261103.sql"

if [ "${1:-}" = "--falsificar" ]; then
  # nome:VERMELHOS — asserts (unidos por ',') que TÊM de ficar vermelhos; ou `APPLY!MARCA` quando a
  # postcondição/PRE da própria migration TEM de abortar o apply com aquela marca (`_` vira espaço).
  SABOTAGENS="pen_sem_regiao:R1 conc_sem_regiao:R1,R2 pen_regiao_vence_uf:R3 pen_sem_validacao:V1,V2 tel_agg_ignorado:T1,T5 tel_fino_sec_ignorado:T2,T3 tel_vivo_ignorado:T4 mun_ignorado:M1,M2 mun_sem_validacao:V3,V4 pen_anon:APPLY!P2_FALHOU pen_anon_sem_post:C2 sem_drop_antiga:APPLY!P1_FALHOU:_sobrou pre_cega:F1a,F1b"
  LOGDIR="$(mktemp -d "${TMPDIR:-/tmp}/falsifica-radar-mapa.XXXXXX")"
  echo "══ CONTROLE ══"
  if ! SABOTAGEM="" bash "$0" > "$LOGDIR/controle.log" 2>&1; then
    echo "❌ controle VERMELHO — falsificação abortada (log: $LOGDIR/controle.log)"; tail -15 "$LOGDIR/controle.log"; exit 1
  fi
  grep -q "RADAR_MAPA_REGIAO_CIDADE_PROVA_OK" "$LOGDIR/controle.log" || { echo "❌ controle sem marcador de fim"; exit 1; }
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
PORT="${PGPORT_TEST:-5581}"
DATA="$(mktemp -d "${TMPDIR:-/tmp}/pgtest-radar-mapa.XXXXXX")/data"
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
# shellcheck disable=SC2016  # os trechos sabotados são SQL literal ($20, $w$…), não expansão do shell
case "${SABOTAGEM:-}" in
  "") ;;
  pen_sem_regiao)     cegar_md5; sabotar "       AND (p_uf IS NOT NULL OR p_ufs IS NULL OR a.uf = ANY (p_ufs))
     GROUP BY a.municipio_codigo
" "     GROUP BY a.municipio_codigo
" ;;
  conc_sem_regiao)    cegar_md5; sabotar "       AND (p_uf IS NOT NULL OR p_ufs IS NULL OR cm.uf = ANY (p_ufs))
" "" ;;
  pen_regiao_vence_uf) cegar_md5; sabotar "       AND (p_uf IS NOT NULL OR p_ufs IS NULL OR a.uf = ANY (p_ufs))
     GROUP BY a.municipio_codigo
" "       AND (p_ufs IS NULL OR a.uf = ANY (p_ufs))
     GROUP BY a.municipio_codigo
" ;;
  pen_sem_validacao)  cegar_md5; sabotar "  -- UF escolhida vence a região, como na contagem e na lista.
  IF p_ufs IS NOT NULL AND" "  -- UF escolhida vence a região, como na contagem e na lista.
  IF false AND" ;;
  tel_agg_ignorado)   cegar_md5; sabotar "         AND (NOT COALESCE(p_com_telefone, false) OR a.tem_telefone)
" "" ;;
  tel_fino_sec_ignorado) cegar_md5; sabotar "           AND (NOT COALESCE(p_com_telefone, false) OR a.tem_telefone)
" "" ;;
  tel_vivo_ignorado)  cegar_md5; sabotar "     AND (NOT COALESCE(p_com_telefone, false) OR re.telefone1 IS NOT NULL OR re.telefone2 IS NOT NULL)
" "" ;;
  mun_ignorado)       cegar_md5; sabotar '    v_w := array_append(v_w, $w$e.municipio_codigo = $20$w$);' '    NULL;' ;;
  mun_sem_validacao)  cegar_md5; sabotar "  IF p_municipio_codigo IS NOT NULL AND" "  IF false AND" ;;
  pen_anon)           sabotar "GRANT EXECUTE ON FUNCTION public.radar_penetracao_por_municipio(text,text,integer,text[]) TO authenticated, service_role;" \
                              "GRANT EXECUTE ON FUNCTION public.radar_penetracao_por_municipio(text,text,integer,text[]) TO anon, authenticated, service_role;" ;;
  pen_anon_sem_post)  sabotar "GRANT EXECUTE ON FUNCTION public.radar_penetracao_por_municipio(text,text,integer,text[]) TO authenticated, service_role;" \
                              "GRANT EXECUTE ON FUNCTION public.radar_penetracao_por_municipio(text,text,integer,text[]) TO anon, authenticated, service_role;"
                      sabotar "    RAISE EXCEPTION 'P2 FALHOU: ACL errado" "    RAISE NOTICE 'P2 FALHOU: ACL errado" ;;
  sem_drop_antiga)    sabotar "DROP FUNCTION IF EXISTS public.radar_penetracao_por_municipio(text,text,integer);" "" ;;
  pre_cega)           sabotar "    IF r.sobrecargas <> 1
       OR NOT" "    IF false AND NOT" ;;
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
GRANT USAGE ON SCHEMA public, auth, private TO anon, authenticated;
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
-- Códigos de município como os da RFB: 4 dígitos. UF por código: k % 4 → 1 SP, 2 SC, 3 RJ, 0 MG.
INSERT INTO public.radar_municipios
SELECT lpad(i::text, 4, '0'), 'CIDADE '||i, (ARRAY['MG','SP','SC','RJ'])[1 + i % 4], -20 - i, -45 - i
  FROM generate_series(1, 12) i WHERE i <> 11;
-- Homônimas em UFs diferentes (como SANTA LUZIA/MG e SANTA LUZIA/BA): 0001 é SP, 0002 é SC.
UPDATE public.radar_municipios SET nome = 'SANTA LUZIA' WHERE codigo IN ('0001', '0002');
INSERT INTO public.radar_empresas
SELECT lpad(i::text, 14, '0'), 'EMPRESA '||i, NULL,
       (ARRAY['3101200','3102100','4744001','1622699'])[1 + (h % 4)],
       CASE WHEN h % 29 = 0 THEN NULL
            WHEN h % 5 = 0 THEN ARRAY[]::text[]
            ELSE ARRAY[(ARRAY['3102100','1622699','3101200','2391503','4330404'])[1 + (h / 3) % 5],
                       (ARRAY['2391503','3101200','4330404','3102100','1622699'])[1 + (h / 31) % 5]] END,
       CASE WHEN h % 53 = 0 THEN NULL ELSE date '2010-01-01' + (h % 5000) END,
       CASE WHEN h % 97 = 0 THEN NULL ELSE lpad((1 + (h / 7) % 12)::text, 4, '0') END,
       CASE WHEN h % 97 = 0 THEN NULL
            WHEN (1 + (h / 7) % 12) IN (1, 2) THEN 'SANTA LUZIA'
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
-- Concorrentes publicados no lote vigente, incluindo um município só de concorrente (0013, PR) e um de SC (0002).
INSERT INTO public.radar_concorrentes_lote VALUES ('2026-10');
INSERT INTO public.radar_concorrentes_municipio VALUES
  ('2026-10', '0004', 'MG', 7), ('2026-10', '0001', 'SP', 3), ('2026-10', '0002', 'SC', 5),
  ('2026-10', '0013', 'PR', 9), ('2026-08', '0004', 'MG', 99);
SQL

# Estado de PROD: predecessoras com o ACL de prod; parte 2, parte 4, a lista e o CNAE secundário por cima.
P -q -f "$PRED"
FPEN_ANT="public.radar_penetracao_por_municipio(text,text,integer)"
FPEN="public.radar_penetracao_por_municipio(text,text,integer,text[])"
FCONT_ANT="public.radar_contagem_por_municipio(text,text,text,text,boolean,date,date,integer,text,timestamptz,text[],boolean,text)"
FCONT="public.radar_contagem_por_municipio(text,text,text,text,boolean,date,date,integer,text,timestamptz,text[],boolean,text,boolean)"
FLISTA_ANT="public.radar_lista(text,text,text,text[],text,text,text,boolean,text,timestamptz,text,numeric,boolean,boolean,date,date,text,integer,integer,text)"
FLISTA="public.radar_lista(text,text,text,text[],text,text,text,boolean,text,timestamptz,text,numeric,boolean,boolean,date,date,text,integer,integer,text,text)"
for f in "public.radar_kpis()" "public.radar_contagem_por_municipio(text,text,text,text,boolean,date,date,integer,text,timestamptz,text[],boolean)" "$FPEN_ANT"; do
  Pq -c "REVOKE ALL ON FUNCTION $f FROM PUBLIC, anon; GRANT EXECUTE ON FUNCTION $f TO authenticated, service_role;" >/dev/null
done
P -q -f "$MIG_P2" >/dev/null 2>&1
P -q -f "$MIG_P4" >/dev/null 2>&1
P -q -f "$MIG_LISTA" >/dev/null 2>&1
P -q -f "$MIG_SEC" >/dev/null 2>&1
Pq -c "ANALYZE public.radar_empresas;" >/dev/null
md5f() { Pq -c "SELECT md5(prosrc) FROM pg_proc WHERE oid = to_regprocedure('$1')"; }
MD5_PARTIDA="$(md5f "$FPEN_ANT")/$(md5f "$FCONT_ANT")/$(md5f "$FLISTA_ANT")"

# Penetração: "codigo|empresas|clientes|concorrentes", separados por ' ; '.
pen() { Pq -c "SELECT coalesce(string_agg(coalesce(municipio_codigo,'-')||'|'||coalesce(empresas_lote::text,'-')||'|'||coalesce(clientes::text,'-')||'|'||coalesce(concorrentes::text,'-'), ' ; ' ORDER BY o), '(vazio)')
                 FROM public.radar_penetracao_por_municipio($1) WITH ORDINALITY AS t(municipio_codigo, municipio_nome, uf, lat, lng, empresas_lote, clientes, penetracao, concorrentes, o);"; }
# Oráculo da penetração: o mercado (todas as situações, lote 2026-10) e os concorrentes contados direto, com o
# recorte de UF ($1) escrito à mão.
pen_oraculo() { Pq -c "WITH me AS (SELECT municipio_codigo AS mc, count(*) AS t, count(*) FILTER (WHERE ja_cliente) AS c
                                       FROM public.radar_empresas WHERE ultimo_lote = '2026-10' AND $1 GROUP BY municipio_codigo),
                            co AS (SELECT municipio_codigo AS mc, sum(quantidade) AS q
                                       FROM public.radar_concorrentes_municipio WHERE lote = '2026-10' AND $1 GROUP BY municipio_codigo)
  SELECT coalesce(string_agg(coalesce(coalesce(me.mc, co.mc),'-')||'|'||coalesce(me.t::text,'-')||'|'||coalesce(me.c::text,'-')||'|'||coalesce(co.q, 0), ' ; '), '(vazio)')
    FROM me FULL JOIN co ON co.mc = me.mc"; }
# Contagem: "codigo|nome|uf|total/tel/ac".
foto() { Pq -c "SELECT coalesce(string_agg(coalesce(municipio_codigo,'-')||'|'||coalesce(municipio_nome,'-')||'|'||coalesce(uf,'-')||'|'||total||'/'||com_telefone||'/'||a_contatar, ' ; ' ORDER BY o), '(vazio)')
                  FROM public.radar_contagem_por_municipio($1) WITH ORDINALITY AS t(municipio_codigo, municipio_nome, uf, lat, lng, total, com_telefone, a_contatar, o);"; }
oraculo() { Pq -c "SELECT coalesce(string_agg(x, ' ; '), '(vazio)') FROM (
  SELECT coalesce(re.municipio_codigo,'-')||'|'||coalesce(COALESCE(m.nome, re.municipio_nome),'-')||'|'||coalesce(re.uf,'-')||'|'
         ||count(*)||'/'||count(*) FILTER (WHERE re.telefone1 IS NOT NULL OR re.telefone2 IS NOT NULL)||'/'||count(*) FILTER (WHERE re.prospeccao_status = 'a_contatar') AS x
    FROM public.radar_empresas re LEFT JOIN public.radar_municipios m ON m.codigo = re.municipio_codigo
   WHERE $1
   GROUP BY re.municipio_codigo, COALESCE(m.nome, re.municipio_nome), re.uf, m.lat, m.lng) s"; }
ordena() { printf '%s' "$1" | sed 's/ ; /\n/g' | LC_ALL=C sort | tr '\n' ';'; }
# Lista: os CNPJs na ordem devolvida.
lista() { Pq -c "SELECT coalesce(string_agg(t.cnpj, ',' ORDER BY t.ordinality), '(vazio)') FROM public.radar_lista($1) WITH ORDINALITY AS t"; }
lista_oraculo() { Pq -c "SELECT coalesce(string_agg(cnpj, ',' ORDER BY score DESC NULLS LAST, cnpj), '(vazio)') FROM (
  SELECT cnpj, score FROM public.radar_empresas WHERE $1 ORDER BY score DESC NULLS LAST, cnpj LIMIT 200) s"; }
# Cidades (código) que a lista devolve. (A UF da linha pode ser NULL na fixture, como na RFB; o código é a identidade.)
cidades_da_lista() { Pq -c "SELECT coalesce(string_agg(DISTINCT coalesce(municipio_codigo,'-'), ',' ORDER BY coalesce(municipio_codigo,'-')), '(vazio)') FROM public.radar_lista($1)"; }

REG="p_ufs => ARRAY['MG','SP','RJ']"
REG_SQL="uf IN ('MG','SP','RJ')"
BASE="prospeccao_status <> 'descartado' AND ja_cliente = false"
declare -a PENS=( "a|p_lote => '2026-10'" "b|p_lote => '2026-10', p_uf => 'MG'" "c|p_lote => '2026-10', p_uf => 'SC', p_limit => 3" )
declare -a CHAMADAS=(
  "a|p_lote => '2026-10', $REG, p_com_contato => true"
  "b|p_cnae_exato => '3101200', p_lote => '2026-10'"
  "c|p_cnae_secundario => '3102100', p_lote => '2026-10'"
  "d|p_data_abertura_min => '2015-01-01', p_cnae_prefix => '31'"
)
declare -a LISTAS=(
  "a|p_municipio => 'SANTA LUZIA'"
  "b|p_cnae_prefixo => '31', p_uf => 'MG', p_com_telefone => true"
)
ANTES_DIR="$(dirname "$DATA")/antes"; mkdir -p "$ANTES_DIR"
antes() { cat "$ANTES_DIR/$1"; }
for c in "${PENS[@]}"; do pen "${c#*|}" > "$ANTES_DIR/p${c%%|*}"; done
for c in "${CHAMADAS[@]}"; do foto "${c#*|}" > "$ANTES_DIR/c${c%%|*}"; done
for c in "${LISTAS[@]}"; do lista "${c#*|}" > "$ANTES_DIR/l${c%%|*}"; done

# F1 precisa de um banco onde o corpo vivo DIVERGE da predecessora: clona ANTES de aplicar.
PD postgres -q -c "CREATE DATABASE divergente TEMPLATE base;"
PD divergente -q -c "CREATE OR REPLACE FUNCTION public.radar_penetracao_por_municipio(p_lote text, p_uf text DEFAULT NULL::text, p_limit integer DEFAULT 500)
 RETURNS TABLE(municipio_codigo text, municipio_nome text, uf text, lat double precision, lng double precision, empresas_lote bigint, clientes bigint, penetracao numeric, concorrentes bigint)
 LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS \$f\$ SELECT 'OUTRA'::text, NULL::text, NULL::text, NULL::float8, NULL::float8, NULL::bigint, NULL::bigint, NULL::numeric, NULL::bigint \$f\$;"

P -q -f "$MIG_USADA" >/dev/null
if [ "$CORPO" -eq 0 ]; then
  P -q -f "$MIG_USADA" >/dev/null   # idempotente: o 2º apply passa a PRE pela assinatura nova com "este"
fi

PASS=0; FAIL=0
eq() { if [ "$2" = "$3" ]; then echo "PASS $1"; PASS=$((PASS+1)); else echo "FAIL $1 — obtido [$2] esperado [$3]"; FAIL=$((FAIL+1)); fi; }
# Negativo: casa a SQLSTATE esperada (22023) E a mensagem do ramo; qualquer outro erro é RE-LANÇADO (vermelho).
invalido() { Pq -c "DO \$t\$ BEGIN
  PERFORM * FROM $1;
  RAISE NOTICE 'R:ACEITOU';
EXCEPTION WHEN invalid_parameter_value THEN
  IF SQLERRM LIKE 'ufs inv%' THEN RAISE NOTICE 'R:UFS_INVALIDO';
  ELSIF SQLERRM LIKE 'municipio_codigo inv%' THEN RAISE NOTICE 'R:MUNICIPIO_INVALIDO';
  ELSE RAISE; END IF;
END \$t\$;" 2>&1 | grep -oE 'R:[A-Z_]{2,}' || true; }
# Leituras de radar_empresas (seq + índice) dentro de UMA chamada.
leituras() { Pq -c "BEGIN;
  SELECT count(*) FROM public.radar_contagem_por_municipio($1);
  SELECT coalesce(sum(seq_scan + coalesce(idx_scan,0)),0) FROM pg_stat_xact_user_tables WHERE relname = 'radar_empresas';
ROLLBACK;" | tail -1; }

eq "A0 partida = prod (md5 penetração/contagem/lista)" "$MD5_PARTIDA" \
   "08af5a0ccc6ef4448d31b48a91ffad3f/a9cdbac06dfb9046ef53d0837687cb0e/7bd1029e7037db846863df850cf958af"

# E — o que já existia não muda.
for c in "${PENS[@]}"; do
  id="${c%%|*}"
  eq "Ep$id penetração($id) = antes" "$(pen "${c#*|}")" "$(antes "p$id")"
done
for c in "${CHAMADAS[@]}"; do
  id="${c%%|*}"
  eq "Ec$id contagem($id) = antes" "$(ordena "$(foto "${c#*|}")")" "$(ordena "$(antes "c$id")")"
done
for c in "${LISTAS[@]}"; do
  id="${c%%|*}"
  eq "El$id lista($id) = antes" "$(lista "${c#*|}")" "$(antes "l$id")"
done

# R — C1: penetração com a região.
PEN_REG="$(pen "p_lote => '2026-10', $REG")"
eq "R1 penetração com região = oráculo" "$(ordena "$PEN_REG")" "$(ordena "$(pen_oraculo "$REG_SQL")")"
eq "R0 âncora: sem região o Brasil é maior (a região recorta algo)" \
   "$( [ "$(ordena "$(pen "p_lote => '2026-10'")")" != "$(ordena "$PEN_REG")" ] && echo recorta)" "recorta"
eq "R2 concorrente só de PR (0013) some com a região, aparece sem ela" \
   "$(printf '%s' "$PEN_REG" | grep -c '0013|' || true)/$(pen "p_lote => '2026-10'" | grep -c '0013|' || true)" "0/1"
eq "R3 UF escolhida vence a região" "$(pen "p_lote => '2026-10', p_uf => 'SC', p_ufs => ARRAY['MG']")" "$(pen "p_lote => '2026-10', p_uf => 'SC'")"
eq "R4 âncora: SC tem mercado e concorrente (R3 não é vazio)" "$(pen "p_lote => '2026-10', p_uf => 'SC'" | grep -c '0002|' || true)" "1"

# T — C3: contagem com "só com telefone" = oráculo nos 4 caminhos.
TEL="(telefone1 IS NOT NULL OR telefone2 IS NOT NULL)"
declare -a TELS=(
  "1|p_lote => '2026-10', $REG, p_com_contato => true, p_com_telefone => true|ultimo_lote = '2026-10' AND re.$REG_SQL AND (telefone1 IS NOT NULL OR telefone2 IS NOT NULL OR email IS NOT NULL) AND $TEL AND $BASE"
  "2|p_cnae_exato => '3101200', p_lote => '2026-10', p_com_telefone => true|cnae_principal = '3101200' AND ultimo_lote = '2026-10' AND $TEL AND $BASE"
  "3|p_cnae_secundario => '3102100', p_lote => '2026-10', p_com_telefone => true|cnaes_secundarios @> '{3102100}' AND ultimo_lote = '2026-10' AND $TEL AND $BASE"
  "4|p_data_abertura_min => '2015-01-01', p_cnae_prefix => '31', p_com_telefone => true|data_abertura >= '2015-01-01' AND cnae_principal LIKE '31%' AND $TEL AND $BASE"
)
TVAZ=""
for c in "${TELS[@]}"; do
  id="${c%%|*}"; resto="${c#*|}"; args="${resto%%|*}"; onde="${resto#*|}"
  obtido="$(foto "$args")"
  eq "T$id contagem com telefone($id) = oráculo" "$(ordena "$obtido")" "$(ordena "$(oraculo "$onde")")"
  [ "$obtido" = "(vazio)" ] && TVAZ="$TVAZ $id"
done
eq "T0 âncora: nenhuma contagem com telefone é vazia" "${TVAZ:-nenhuma}" "nenhuma"
eq "T5 com telefone: total = com_telefone em toda cidade" \
   "$(Pq -c "SELECT count(*) FILTER (WHERE total <> com_telefone)||'/'||(count(*) > 0) FROM public.radar_contagem_por_municipio(p_lote => '2026-10', p_com_telefone => true)")" "0/true"
eq "T6 com telefone no default ainda lê o agregado (0 leituras de radar_empresas)" \
   "$(leituras "p_lote => '2026-10', $REG, p_com_contato => true, p_com_telefone => true")" "0"

# M — C2: a cidade exata pelo código.
eq "M0 controle do defeito: o nome traz a homônima de outra UF (0001/SP e 0002/SC)" "$(cidades_da_lista "p_municipio => 'SANTA LUZIA', p_limit => 200")" "0001,0002"
eq "M1 lista pela cidade exata = oráculo" "$(lista "p_municipio_codigo => '0001', p_limit => 200")" \
   "$(lista_oraculo "municipio_codigo = '0001' AND $BASE")"
eq "M2 lista pela cidade exata só traz a cidade" "$(cidades_da_lista "p_municipio_codigo => '0001', p_limit => 200")" "0001"
eq "M3 cidade exata combina com a região (E): fora dela, vazio" "$(lista "p_municipio_codigo => '0002', p_ufs => ARRAY['MG','SP']")" "(vazio)"

# V — entrada mal formada grita (SQLSTATE 22023 + a mensagem do ramo).
eq "V1 penetração: região vazia grita" "$(invalido "public.radar_penetracao_por_municipio(p_lote => '2026-10', p_ufs => ARRAY[]::text[])")" "R:UFS_INVALIDO"
eq "V2 penetração: UF mal formada na região grita" "$(invalido "public.radar_penetracao_por_municipio(p_lote => '2026-10', p_ufs => ARRAY['mg'])")" "R:UFS_INVALIDO"
eq "V3 lista: código de município com nome grita" "$(invalido "public.radar_lista(p_municipio_codigo => 'SANTA')")" "R:MUNICIPIO_INVALIDO"
eq "V4 lista: código com curinga grita" "$(invalido "public.radar_lista(p_municipio_codigo => '31%')")" "R:MUNICIPIO_INVALIDO"
eq "V5 controle: código bem formado é aceito" "$(invalido "public.radar_lista(p_municipio_codigo => '0003')")" "R:ACEITOU"

# C — ACL das assinaturas novas; as antigas sumiram.
estado_sob() { local s; s="$(P -qAt -v VERBOSITY=verbose -c "SET ROLE $1; $2" 2>&1 | sed -nE 's/^(ERROR|ERRO): +([0-9A-Z]{5}):.*/\2/p' | head -1)"; printf '%s' "${s:-LEU}"; }
eq "C1 authenticated chama as 3 RPCs novas" \
   "$(estado_sob authenticated "SELECT count(*) FROM public.radar_penetracao_por_municipio(p_lote => '2026-10', $REG); SELECT count(*) FROM public.radar_contagem_por_municipio(p_com_telefone => true); SELECT count(*) FROM public.radar_lista(p_municipio_codigo => '0001')")" "LEU"
eq "C2 anon não chama a penetração nova (42501)" "$(estado_sob anon "SELECT count(*) FROM public.radar_penetracao_por_municipio(p_lote => '2026-10')")" "42501"
eq "C3 ACL: as 3 p/ authenticated e não anon" \
   "$(Pq -c "SELECT string_agg(has_function_privilege('authenticated', f, 'EXECUTE')||'/'||has_function_privilege('anon', f, 'EXECUTE'), ',' ORDER BY f) FROM unnest(ARRAY['$FPEN','$FCONT','$FLISTA']) AS f")" \
   "true/false,true/false,true/false"
eq "C4 assinaturas antigas sumiram (uma sobrecarga só de cada)" \
   "$(Pq -c "SELECT (to_regprocedure('$FPEN_ANT') IS NULL)::text||'/'||(to_regprocedure('$FCONT_ANT') IS NULL)::text||'/'||(to_regprocedure('$FLISTA_ANT') IS NULL)::text||'/'||count(*) FROM pg_proc WHERE proname IN ('radar_penetracao_por_municipio','radar_contagem_por_municipio','radar_lista')")" \
   "true/true/true/3"

# F1 — PRE: com o corpo vivo divergente, a migration aborta ANTES de qualquer DROP.
SAIDA_DIV="$(PD divergente -q -f "$MIG_USADA" 2>&1 || true)"
eq "F1a PRE aborta com corpo vivo divergente" "$(printf '%s' "$SAIDA_DIV" | grep -o 'PRE FALHOU: radar_penetracao_por_municipio' | head -1)" "PRE FALHOU: radar_penetracao_por_municipio"
eq "F1b o vivo divergente segue intacto e nada foi dropado nem criado" \
   "$(PD divergente -qAt -c "SELECT (SELECT prosrc LIKE '%OUTRA%' FROM pg_proc WHERE oid = to_regprocedure('$FPEN_ANT'))::text||'/'||(to_regprocedure('$FLISTA_ANT') IS NOT NULL)::text||'/'||(to_regprocedure('$FLISTA') IS NULL)::text||'/'||(to_regprocedure('$FPEN') IS NULL)::text")" "true/true/true/true"

echo "PASS=$PASS  FAIL=$FAIL"
[ "$FAIL" -eq 0 ] && echo "RADAR_MAPA_REGIAO_CIDADE_PROVA_OK"
