#!/usr/bin/env bash
# Prova PG17 da migration 20261103100000_radar_agregado_municipio (leitor 4 do Mini): as contagens do
# /radar (radar_kpis, radar_contagem_por_municipio, radar_penetracao_por_municipio) passam a ler
# radar_agregado_municipio, calculado por 1 escritor (radar_agregado_recalcular, cron :35). Parte do corpo
# VIVO de prod das 3 RPCs (fixture lida via psql-ro em 2026-11-03), aplica a migration REAL duas vezes
# (idempotência) e assevera:
#   A0  a fixture É o corpo de prod (md5 do prosrc das 3)
#   A1  EQUIVALÊNCIA: 17 chamadas de contagem, 4 de penetração e os KPIs devolvem o MESMO que a
#       predecessora (agregado, caminho vivo de CNAE/data/inéditos de outro lote, região, UF, status,
#       já-clientes, contato, inéditos do lote vigente, p_limit)
#   A2  KPIs ganham contagens_em (= calculado_em do agregado)
#   B1  lote novo sem recálculo → contagem e penetração RAISE 'agregado indisponível' (P0001), KPIs com
#       a_contatar NULL, nunca 0; o caminho vivo (CNAE) segue respondendo
#   B2  o cron (sem forçar) recalcula porque o lote mudou, e as contagens do lote novo batem com a tabela
#   B3  sem lote novo e antes do marco das 06:35 UTC o escritor sai SEM ler radar_empresas (0 scans)
#   B4  depois do marco do dia seguinte ele recalcula
#   C1  tabelas do agregado com RLS e sem GRANT: authenticated recebe 42501 ao ler; escritor 42501
#   C2  ACL das 3 RPCs preservado (authenticated/service_role sim; PUBLIC/anon não)
#   D1  cron radar-agregado-recalcular '35 * * * *' com o comando exato
#   E1  idx_radar_empresas_lote_vista existe e é válido
#   F1  PRE: corpo vivo divergente ABORTA a migration e deixa o vivo intacto
#
#   bash db/test-radar-agregado.sh > /tmp/t.log 2>&1; echo "exit=$?"
#   SABOTAGEM=<nome> bash db/test-radar-agregado.sh   # tem de ficar VERMELHA
#   bash db/test-radar-agregado.sh --falsificar        # controle verde + cada sabotagem vermelha no assert dela
#   LOCALE_TESTE=pt_BR.UTF-8 bash db/test-radar-agregado.sh   # mesma prova sob locale pt_BR
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MIG="$REPO_ROOT/supabase/migrations/20261103100000_radar_agregado_municipio.sql"
PRED="$REPO_ROOT/db/fixtures/radar-agregado-predecessoras-prod-20261103.sql"

if [ "${1:-}" = "--falsificar" ]; then
  # nome:VERMELHOS — asserts (unidos por ',') que TÊM de ficar vermelhos; ou `APPLY!MARCA` quando a
  # postcondição/PRE da própria migration TEM de abortar o apply com aquela marca (`_` vira espaço).
  SABOTAGENS="sem_contato:A1b,A1f sem_inedito:A1g sem_regiao:A1b,A1e uf_nao_vence:A1i status_ignorado:A1j,A1k ja_cliente_ignorado:A1l,A1m sem_validade:B1a,B1b,B1c penetracao_sem_validade:B1d ignora_marco:B4 sempre_recalcula:B3a,B3b nunca_recalcula:B2a,B4 kpis_zero:B1c tabela_aberta:APPLY!P2_FALHOU tabela_aberta_sem_post:C1a escritor_aberto:APPLY!P3_FALHOU cron_semanal:APPLY!P6_FALHOU pre_cega:F1a,F1b"
  LOGDIR="$(mktemp -d "${TMPDIR:-/tmp}/falsifica-radar-agregado.XXXXXX")"
  echo "══ CONTROLE ══"
  if ! SABOTAGEM="" bash "$0" > "$LOGDIR/controle.log" 2>&1; then
    echo "❌ controle VERMELHO — falsificação abortada (log: $LOGDIR/controle.log)"; tail -15 "$LOGDIR/controle.log"; exit 1
  fi
  grep -q "RADAR_AGREGADO_PROVA_OK" "$LOGDIR/controle.log" || { echo "❌ controle sem marcador de fim"; exit 1; }
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
PORT="${PGPORT_TEST:-5571}"
DATA="$(mktemp -d "${TMPDIR:-/tmp}/pgtest-radar-agregado.XXXXXX")/data"
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
# Sabotagem no CORPO de uma RPC muda o prosrc → a PÓS P1 e a PRE do 2º apply pegariam antes da suíte.
# Para provar que o assert da suíte tem dente sozinho: P1 vira NOTICE e o 2º apply não roda.
CORPO=0
cegar_md5() { CORPO=1; sabotar "    RAISE EXCEPTION 'P1 FALHOU" "    RAISE NOTICE 'P1 FALHOU"; }
case "${SABOTAGEM:-}" in
  "") ;;
  sem_contato)        cegar_md5; sabotar "         AND (NOT COALESCE(p_com_contato, false) OR a.tem_contato)" "" ;;
  sem_inedito)        cegar_md5; sabotar "         AND (p_primeira_vista_min IS NULL OR a.inedito)" "" ;;
  sem_regiao)         cegar_md5; sabotar "         AND (p_uf IS NOT NULL OR p_ufs IS NULL OR a.uf = ANY (p_ufs))" "" ;;
  uf_nao_vence)       cegar_md5; sabotar "         AND (p_uf IS NOT NULL OR p_ufs IS NULL OR a.uf = ANY (p_ufs))" "         AND (p_ufs IS NULL OR a.uf = ANY (p_ufs))" ;;
  status_ignorado)    cegar_md5; sabotar "         AND ((p_status IS NOT NULL AND a.prospeccao_status = p_status)
              OR (p_status IS NULL AND a.prospeccao_status <> 'descartado'))" "         AND a.prospeccao_status <> 'descartado'" ;;
  ja_cliente_ignorado) cegar_md5; sabotar "         AND (p_incluir_ja_clientes OR a.ja_cliente = false)" "         AND a.ja_cliente = false" ;;
  sem_validade)       cegar_md5; sabotar "    IF private.radar_agregado_valido() IS NULL THEN
      RAISE EXCEPTION 'agregado indisponível" "    IF false THEN
      RAISE EXCEPTION 'agregado indisponível"
                      sabotar "  v_contagens_em := private.radar_agregado_valido();" "  v_contagens_em := (SELECT calculado_em FROM public.radar_agregado_estado WHERE id = 1);" ;;
  penetracao_sem_validade) cegar_md5; sabotar "  IF private.radar_agregado_valido() IS NULL THEN
    RAISE EXCEPTION 'agregado indisponível" "  IF false THEN
    RAISE EXCEPTION 'agregado indisponível" ;;
  ignora_marco)       sabotar "     AND e.calculado_em >= v_marco THEN" "     THEN" ;;
  sempre_recalcula)   sabotar "     AND e.calculado_em >= v_marco THEN" "     AND e.calculado_em >= v_marco AND false THEN" ;;
  nunca_recalcula)    sabotar "  IF NOT COALESCE(p_forcar, false) AND v_tem_estado
     AND e.base_lote IS NOT DISTINCT FROM v_lote
     AND e.base_iniciado_em IS NOT DISTINCT FROM v_ini
     AND e.calculado_em >= v_marco THEN" "  IF NOT COALESCE(p_forcar, false) AND v_tem_estado THEN" ;;
  kpis_zero)          cegar_md5; sabotar "  SELECT count(*) INTO v_em_conversa FROM public.radar_empresas" "  v_a_contatar := COALESCE(v_a_contatar, 0);
  SELECT count(*) INTO v_em_conversa FROM public.radar_empresas" ;;
  tabela_aberta)      sabotar "REVOKE ALL ON TABLE public.radar_agregado_municipio FROM PUBLIC, anon, authenticated;" "GRANT SELECT ON TABLE public.radar_agregado_municipio TO authenticated;" ;;
  tabela_aberta_sem_post)
                      sabotar "REVOKE ALL ON TABLE public.radar_agregado_municipio FROM PUBLIC, anon, authenticated;" "GRANT SELECT ON TABLE public.radar_agregado_municipio TO authenticated;"
                      sabotar "      RAISE EXCEPTION 'P2 FALHOU: % legível" "      RAISE NOTICE 'P2 FALHOU: % legível" ;;
  escritor_aberto)    sabotar "REVOKE ALL ON FUNCTION public.radar_agregado_recalcular(boolean, timestamptz) FROM PUBLIC, anon, authenticated, service_role;" "" ;;
  cron_semanal)       sabotar "  '35 * * * *',
  \$\$SET" "  '35 6 * * 1',
  \$\$SET" ;;
  pre_cega)           sabotar "    IF r.vivo IS NULL OR r.vivo NOT IN (r.predecessor, r.este) THEN" "    IF false THEN" ;;
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
CREATE SCHEMA auth;
CREATE SCHEMA private;
-- Como o Supabase: o que o postgres cria em public nasce com GRANT a anon/authenticated/service_role.
-- Sem isto o REVOKE da migration não teria dente (PG puro não concede nada a esses papéis).
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON FUNCTIONS TO anon, authenticated, service_role;
CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT '00000000-0000-0000-0000-0000000000a1'::uuid $$;
CREATE FUNCTION private.cap_radar_prospectar(uuid) RETURNS boolean LANGUAGE sql STABLE AS $$ SELECT true $$;
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
  cnpj text PRIMARY KEY, cnae_principal text NOT NULL, data_abertura date,
  municipio_codigo text, municipio_nome text, uf text, telefone1 text, telefone2 text, email text,
  prospeccao_status text NOT NULL, ja_cliente boolean NOT NULL, ultimo_lote text NOT NULL,
  primeira_vista_em timestamptz NOT NULL, omie_codigo_cliente bigint, omie_cadastrado_em timestamptz);
ALTER TABLE public.radar_empresas ENABLE ROW LEVEL SECURITY;

INSERT INTO public.radar_ingest_state VALUES
  ('2026-08','complete','2026-10-19 16:31:08.593+00', 27466),
  ('2026-10','complete','2026-10-27 16:20:37.722+00', 8587);
-- 12 municípios em 4 UFs; M11 sem coordenada em radar_municipios (nome de reserva = o da RFB); M12 com
-- 2 grafias na RFB (o nome do IBGE as junta); código NULL e UF NULL também existem na RFB.
INSERT INTO public.radar_municipios
SELECT 'M'||lpad(i::text,2,'0'), 'CIDADE '||i, (ARRAY['MG','SP','SC','RJ'])[1 + i % 4], -20 - i, -45 - i
  FROM generate_series(1, 12) i WHERE i <> 11;
INSERT INTO public.radar_concorrentes_lote VALUES ('2026-10');
INSERT INTO public.radar_concorrentes_municipio VALUES ('2026-10','M01','SP',4), ('2026-10','M05','SP',2), ('2026-10','M99','MG',7);
-- 4.000 empresas determinísticas (hash do índice) cobrindo cada eixo do agregado.
INSERT INTO public.radar_empresas
SELECT lpad(i::text, 14, '0'),
       (ARRAY['3101200','3102100','4744001','1622699'])[1 + (h % 4)],
       date '2010-01-01' + (h % 5000),
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
       CASE WHEN (h / 13) % 7 = 6 THEN i END,
       CASE WHEN (h / 13) % 7 = 6 THEN now() END
  FROM (SELECT i, abs(hashtext('radar' || i)) AS h FROM generate_series(1, 4000) i) s;
INSERT INTO public.omie_cliente_confirmacoes
SELECT 'oben', cnpj, omie_codigo_cliente, CASE WHEN omie_codigo_cliente % 2 = 0 THEN 'incluir' ELSE 'lookup' END
  FROM public.radar_empresas WHERE omie_codigo_cliente IS NOT NULL;
SQL

# Predecessoras = o corpo VIVO de prod, com o ACL de prod (authenticated + service_role; sem PUBLIC/anon).
P -q -f "$PRED"
FKPIS="public.radar_kpis()"
FCONT="public.radar_contagem_por_municipio(text,text,text,text,boolean,date,date,integer,text,timestamptz,text[],boolean)"
FPEN="public.radar_penetracao_por_municipio(text,text,integer)"
for f in "$FKPIS" "$FCONT" "$FPEN"; do
  Pq -c "REVOKE ALL ON FUNCTION $f FROM PUBLIC, anon; GRANT EXECUTE ON FUNCTION $f TO authenticated, service_role;" >/dev/null
done
MD5_FIXTURE="$(Pq -c "SELECT string_agg(md5(prosrc), ' ' ORDER BY proname) FROM pg_proc WHERE proname IN ('radar_kpis','radar_contagem_por_municipio','radar_penetracao_por_municipio');")"

# Foto de uma chamada de contagem: "codigo|nome|uf|lat|total/tel/ac", na ORDEM devolvida, separados por ' ; '.
# ordena() a põe em ordem de texto: o caminho vivo de antes não desempatava (ORDER BY total DESC só).
foto() { Pq -c "SELECT coalesce(string_agg(coalesce(municipio_codigo,'∅')||'|'||coalesce(municipio_nome,'∅')||'|'||coalesce(uf,'∅')||'|'||coalesce(lat::text,'∅')||'|'||total||'/'||com_telefone||'/'||a_contatar, ' ; ' ORDER BY o), '(vazio)')
                  FROM public.radar_contagem_por_municipio($1) WITH ORDINALITY AS t(municipio_codigo, municipio_nome, uf, lat, lng, total, com_telefone, a_contatar, o);"; }
fotop() { Pq -c "SELECT coalesce(string_agg(coalesce(municipio_codigo,'∅')||'|'||coalesce(municipio_nome,'∅')||'|'||coalesce(uf,'∅')||'|'||coalesce(empresas_lote::text,'∅')||'/'||coalesce(clientes::text,'∅')||'/'||coalesce(penetracao::text,'∅')||'/'||coalesce(concorrentes::text,'∅'), ' ; ' ORDER BY o), '(vazio)')
                  FROM public.radar_penetracao_por_municipio($1) WITH ORDINALITY AS t(municipio_codigo, municipio_nome, uf, lat, lng, empresas_lote, clientes, penetracao, concorrentes, o);"; }
ordena() { printf '%s' "$1" | sed 's/ ; /\n/g' | LC_ALL=C sort | tr '\n' ';'; }
soma_total() { printf '%s' "$1" | sed 's/ ; /\n/g' | awk -F'|' '{split($5,a,"/"); s+=a[1]} END {print s+0}'; }
kpis() { Pq -c "SELECT (public.radar_kpis() - 'contagens_em')::text;"; }

INI="'2026-10-27 16:20:37.722+00'::timestamptz"
REG="p_ufs => ARRAY['MG','SP','RJ']"
declare -a CHAMADAS=(
  "a|"
  "b|p_lote => '2026-10', $REG, p_com_contato => true"
  "c|p_lote => '2026-10'"
  "d|p_lote => '2026-08'"
  "e|$REG"
  "f|p_com_contato => true"
  "g|p_lote => '2026-10', p_primeira_vista_min => $INI"
  "h|p_uf => 'MG'"
  "i|p_uf => 'SC', $REG"
  "j|p_status => 'em_conversa'"
  "k|p_status => 'descartado', p_lote => '2026-10'"
  "l|p_incluir_ja_clientes => true"
  "m|p_incluir_ja_clientes => true, p_lote => '2026-10', p_com_contato => true, $REG"
  "n|p_cnae_prefix => '31', p_lote => '2026-10'"
  "o|p_data_abertura_min => '2015-01-01', p_lote => '2026-10'"
  "p|p_primeira_vista_min => '2026-10-01 00:00+00', p_lote => '2026-10'"
  "q|p_limit => 3, p_lote => '2026-10'"
)
declare -a PENS=("a|'2026-10'" "b|'2026-08'" "c|'2026-10', 'MG'" "d|'2026-10', p_limit => 2")
# "antes" de cada chamada em arquivo (bash 3.2 do macOS não tem array associativo).
ANTES_DIR="$(dirname "$DATA")/antes"; mkdir -p "$ANTES_DIR"
antes() { cat "$ANTES_DIR/$1"; }
for c in "${CHAMADAS[@]}"; do foto "${c#*|}" > "$ANTES_DIR/c${c%%|*}"; done
for c in "${PENS[@]}"; do fotop "${c#*|}" > "$ANTES_DIR/p${c%%|*}"; done
ANTES_KPIS="$(kpis)"

# F1 precisa de um banco onde o corpo vivo DIVERGE da predecessora: clona ANTES de aplicar.
PD postgres -q -c "CREATE DATABASE divergente TEMPLATE base;"
PD divergente -q -c "CREATE OR REPLACE FUNCTION public.radar_penetracao_por_municipio(p_lote text, p_uf text DEFAULT NULL, p_limit integer DEFAULT 500)
 RETURNS TABLE(municipio_codigo text, municipio_nome text, uf text, lat double precision, lng double precision, empresas_lote bigint, clientes bigint, penetracao numeric, concorrentes bigint)
 LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS \$f\$ SELECT 'OUTRA'::text, 'SESSAO'::text, 'XX'::text, NULL::float8, NULL::float8, 1::bigint, 0::bigint, 0::numeric, 0::bigint \$f\$;"

P -q -f "$MIG_USADA" >/dev/null
if [ "$CORPO" -eq 0 ]; then
  P -q -f "$MIG_USADA" >/dev/null   # idempotente: o 2º apply passa a PRE pelo md5 "este"
fi

PASS=0; FAIL=0
eq() { if [ "$2" = "$3" ]; then echo "PASS $1"; PASS=$((PASS+1)); else echo "FAIL $1 — obtido [$2] esperado [$3]"; FAIL=$((FAIL+1)); fi; }
# Captura a SQLSTATE e a MARCA de uma chamada que tem de falhar; o resto re-lança.
falha() { Pq -c "DO \$t\$ BEGIN
  PERFORM * FROM $1;
  RAISE NOTICE 'R:ACEITOU';
EXCEPTION WHEN raise_exception THEN
  IF SQLERRM LIKE 'agregado indispon%' THEN RAISE NOTICE 'R:INDISPONIVEL'; ELSE RAISE; END IF;
END \$t\$;" 2>&1 | grep -o 'R:[A-Z]*' || true; }

eq "A0 a fixture é o corpo vivo de prod (md5 das 3)" "$MD5_FIXTURE" "290add620a05772ff66e3004a08e1c40 6c10810f6f2beab5dbb9bca1e92ed747 f52a86ce536d773eb5af88c0f4fb1c37"
eq "A0b o agregado leu as 4.000 empresas" "$(Pq -c "SELECT empresas FROM public.radar_agregado_estado")" "4000"

for c in "${CHAMADAS[@]}"; do
  id="${c%%|*}"
  eq "A1$id contagem($id) = predecessora" "$(ordena "$(foto "${c#*|}")")" "$(ordena "$(antes "c$id")")"
done
# Onde a ordem de antes era determinística (agregado: total DESC, código), ela também é a mesma.
eq "A1ob ordem do default = predecessora" "$(foto "p_lote => '2026-10', $REG, p_com_contato => true")" "$(antes cb)"
eq "A1oq ordem com p_limit = predecessora" "$(foto "p_limit => 3, p_lote => '2026-10'")" "$(antes cq)"
for c in "${PENS[@]}"; do
  id="${c%%|*}"
  eq "A1p$id penetração($id) = predecessora" "$(fotop "${c#*|}")" "$(antes "p$id")"
done
eq "A1z KPIs = predecessora" "$(kpis)" "$ANTES_KPIS"
eq "A1x âncora: o default não é vazio" "$( [ "$(antes cb)" != "(vazio)" ] && echo cheio)" "cheio"
eq "A2 KPIs trazem contagens_em = calculado_em" \
   "$(Pq -c "SELECT (public.radar_kpis()->>'contagens_em')::timestamptz = (SELECT calculado_em FROM public.radar_agregado_estado)")" "t"

# B — lote novo: 2026-11 complete; 300 empresas mudam de lote (a carga), sem recálculo ainda.
Pq -c "INSERT INTO public.radar_ingest_state VALUES ('2026-11','complete','2026-11-28 10:00+00', 300);
       UPDATE public.radar_empresas SET ultimo_lote = '2026-11', primeira_vista_em = CASE WHEN cnpj::bigint % 2 = 0 THEN '2026-11-28 11:00+00' ELSE primeira_vista_em END WHERE cnpj::bigint % 13 = 0;" >/dev/null
eq "B1a contagem default com agregado de outro lote = indisponível" \
   "$(falha "public.radar_contagem_por_municipio(p_lote => '2026-11', p_ufs => ARRAY['MG'], p_com_contato => true)")" "R:INDISPONIVEL"
eq "B1b roteirizador (sem lote) também indisponível" "$(falha "public.radar_contagem_por_municipio()")" "R:INDISPONIVEL"
eq "B1c KPIs: a_contatar NULL (não 0), contagens_em NULL" \
   "$(Pq -c "SELECT coalesce(jsonb_typeof(k->'a_contatar'),'ausente')||'/'||coalesce(jsonb_typeof(k->'contagens_em'),'ausente') FROM public.radar_kpis() k")" "null/null"
eq "B1d penetração indisponível" "$(falha "public.radar_penetracao_por_municipio('2026-11')")" "R:INDISPONIVEL"
eq "B1e caminho vivo (CNAE) segue respondendo" "$(falha "public.radar_contagem_por_municipio(p_cnae_prefix => '31')")" "R:ACEITOU"

# B2 — o cron (sem forçar) vê o lote novo e recalcula; as contagens do lote novo batem com a tabela.
eq "B2a recalcular() sem forçar recalcula no lote novo" \
   "$(Pq -c "SELECT public.radar_agregado_recalcular(false, '2026-11-28 12:35+00')->>'recalculou'")" "true"
eq "B2b total do lote novo = tabela" \
   "$(soma_total "$(foto "p_lote => '2026-11', p_incluir_ja_clientes => true, p_status => 'a_contatar'")")" \
   "$(Pq -c "SELECT count(*) FROM public.radar_empresas WHERE ultimo_lote = '2026-11' AND prospeccao_status = 'a_contatar'")"
eq "B2c inéditos do lote novo = tabela" \
   "$(soma_total "$(foto "p_lote => '2026-11', p_primeira_vista_min => '2026-11-28 10:00+00'")")" \
   "$(Pq -c "SELECT count(*) FROM public.radar_empresas WHERE ultimo_lote = '2026-11' AND primeira_vista_em >= '2026-11-28 10:00+00' AND ja_cliente = false AND prospeccao_status <> 'descartado'")"
eq "B2d KPI a_contatar do lote novo = tabela" \
   "$(Pq -c "SELECT public.radar_kpis()->>'a_contatar'")" \
   "$(Pq -c "SELECT count(*) FROM public.radar_empresas WHERE ultimo_lote = '2026-11' AND prospeccao_status = 'a_contatar' AND ja_cliente = false")"

# B3 — mesmo lote, antes do marco das 06:35 UTC do dia seguinte: sai sem ler radar_empresas.
leituras() { Pq -c "BEGIN;
  SELECT public.radar_agregado_recalcular(false, '$1')->>'recalculou';
  SELECT coalesce(sum(seq_scan + coalesce(idx_scan,0)),0) FROM pg_stat_xact_user_tables WHERE relname = 'radar_empresas';
ROLLBACK;" | tr '\n' ' ' | sed 's/ *$//'; }
eq "B3a 2026-11-29 06:34 UTC: não recalcula e 0 scans" "$(leituras '2026-11-29 06:34+00')" "false 0"
eq "B3b 2026-11-28 23:00 UTC: não recalcula" "$(leituras '2026-11-28 23:00+00' | cut -d' ' -f1)" "false"
# B4 — passou o marco do dia seguinte: recalcula (situação/recruzamento/score mudaram a foto).
# O contador tem dente: quando recalcula, o mesmo medidor vê o scan.
eq "B4 2026-11-29 06:35:01 UTC: recalcula (e o medidor vê 1 scan)" "$(leituras '2026-11-29 06:35:01+00')" "true 1"

# C1 — tabelas do agregado fechadas: authenticated recebe 42501 (GRANT), o escritor também.
# A SQLSTATE vem do prefixo do SERVIDOR (ERROR/ERRO em caixa alta, VERBOSITY verbose), nunca do texto.
estado_sob_auth() { local s; s="$(P -qAt -v VERBOSITY=verbose -c "SET ROLE authenticated; $1" 2>&1 | sed -nE 's/^(ERROR|ERRO): +([0-9A-Z]{5}):.*/\2/p' | head -1)"; printf '%s' "${s:-LEU}"; }
eq "C1a authenticated não lê radar_agregado_municipio (42501)" "$(estado_sob_auth "SELECT count(*) FROM public.radar_agregado_municipio")" "42501"
eq "C1b authenticated não lê radar_agregado_estado (42501)" "$(estado_sob_auth "SELECT count(*) FROM public.radar_agregado_estado")" "42501"
eq "C1c authenticated não executa o escritor (42501)" "$(estado_sob_auth "SELECT public.radar_agregado_recalcular(true)")" "42501"
eq "C1d RLS ligada nas 2 tabelas" "$(Pq -c "SELECT string_agg(relrowsecurity::text, ' ' ORDER BY relname) FROM pg_class WHERE relname IN ('radar_agregado_estado','radar_agregado_municipio')")" "true true"
eq "C2 ACL das 3 RPCs: public/anon/authenticated/service_role" \
   "$(Pq -c "SELECT string_agg(has_function_privilege(r, f, 'EXECUTE')::text, ' ' ORDER BY f, o)
             FROM unnest(ARRAY['$FKPIS','$FCONT','$FPEN']) f, unnest(ARRAY['public','anon','authenticated','service_role']) WITH ORDINALITY AS x(r, o);")" \
   "false false true true false false true true false false true true"
eq "C3 uma assinatura de contagem (12 args)" "$(Pq -c "SELECT count(*) FROM pg_proc WHERE proname = 'radar_contagem_por_municipio'")" "1"

eq "D1 cron :35 com o comando exato" \
   "$(Pq -c "SELECT schedule||' | '||command FROM cron.job WHERE jobname = 'radar-agregado-recalcular'")" \
   "35 * * * * | SET statement_timeout = '15min'; SELECT public.radar_agregado_recalcular();"
eq "E1 índice de inéditos válido" \
   "$(Pq -c "SELECT indisvalid FROM pg_index WHERE indexrelid = to_regclass('public.idx_radar_empresas_lote_vista')")" "t"

# F1 — PRE: com o corpo vivo divergente, a migration aborta e a função da outra sessão fica.
SAIDA_DIV="$(PD divergente -q -f "$MIG_USADA" 2>&1 || true)"
eq "F1a PRE aborta com corpo vivo divergente" "$(printf '%s' "$SAIDA_DIV" | grep -o 'PRE FALHOU: radar_penetracao_por_municipio' | head -1)" "PRE FALHOU: radar_penetracao_por_municipio"
eq "F1b o vivo divergente segue intacto e nada foi criado" \
   "$(PD divergente -qAt -c "SELECT (SELECT prosrc LIKE '%OUTRA%' FROM pg_proc WHERE proname = 'radar_penetracao_por_municipio')::text||'/'||(to_regclass('public.radar_agregado_municipio') IS NULL)::text")" "true/true"

echo "PASS=$PASS  FAIL=$FAIL"
[ "$FAIL" -eq 0 ] && echo "RADAR_AGREGADO_PROVA_OK"
