#!/usr/bin/env bash
# Prova PG17 da migration 20261103223300_radar_agregado_cnae (leitor 4 do Mini, parte 4): CNAE e o preset
# "estabelecidas" de radar_contagem_por_municipio passam a ler radar_agregado_cnae (o grão do agregado +
# CNAE + estabelecida), calculado pelo mesmo escritor, que deriva radar_agregado_municipio do fino.
# Parte do estado de PROD (fixture das predecessoras da parte 2 + a migration 20261103100000), aplica a
# migration REAL duas vezes (idempotência) e assevera:
#   A0  o estado de partida É o de prod (md5 do recalcular e da contagem)
#   E   EQUIVALÊNCIA: 16 chamadas devolvem o MESMO que a contagem de antes (CNAE exato/prefixo, região,
#       UF, status, já-clientes, contato, inéditos do lote vigente e de outra data, estabelecidas no corte
#       e no corte + 1, data fora do corte, data mínima, p_limit) — e nenhuma volta vazia
#   R1  o agregado por município (agora soma do fino) é o MESMO de antes
#   I   CNAE e estabelecidas leem 0 vezes radar_empresas; data fora do corte segue lendo (controle)
#   B1  lote novo sem recálculo → CNAE/estabelecidas INDISPONÍVEL (P0001), nunca a foto velha; o vivo responde
#   B2  recálculo no lote novo: o fino bate com a tabela
#   C1  authenticated não lê radar_agregado_cnae (42501); RLS ligada
#   K1  corte gravado = data de São Paulo do cálculo − 5 anos
#   F1  PRE: corpo vivo divergente ABORTA a migration e deixa o vivo intacto
#
#   bash db/test-radar-agregado-cnae.sh > /tmp/t.log 2>&1; echo "exit=$?"
#   SABOTAGEM=<nome> bash db/test-radar-agregado-cnae.sh   # tem de ficar VERMELHA
#   bash db/test-radar-agregado-cnae.sh --falsificar        # controle verde + cada sabotagem vermelha no assert dela
#   LOCALE_TESTE=pt_BR.UTF-8 bash db/test-radar-agregado-cnae.sh
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MIG="$REPO_ROOT/supabase/migrations/20261103223300_radar_agregado_cnae.sql"
MIG2="$REPO_ROOT/supabase/migrations/20261103100000_radar_agregado_municipio.sql"
PRED="$REPO_ROOT/db/fixtures/radar-agregado-predecessoras-prod-20261103.sql"

if [ "${1:-}" = "--falsificar" ]; then
  # nome:VERMELHOS — asserts (unidos por ',') que TÊM de ficar vermelhos; ou `APPLY!MARCA` quando a
  # postcondição/PRE da própria migration TEM de abortar o apply com aquela marca (`_` vira espaço).
  SABOTAGENS="sem_cnae_exato:Ea,Ed,Ef sem_prefixo:Eb,Ec,Ee,Ei,Ej estab_ignorado:Eg,Eh,Ei d1_troca:Eh d1_sem_mais_um:Eh inedito_outro_lote_no_fino:Eo data_min_no_fino:El sem_validade_fino:B1a,B1b fino_nunca:I1,I2,I3 corte_4anos:APPLY!P4_FALHOU:_corte rollup_errado:APPLY!P4_FALHOU:_fino tabela_aberta:APPLY!P2_FALHOU tabela_aberta_sem_post:C1a pre_cega:F1a,F1b"
  LOGDIR="$(mktemp -d "${TMPDIR:-/tmp}/falsifica-radar-agregado-cnae.XXXXXX")"
  echo "══ CONTROLE ══"
  if ! SABOTAGEM="" bash "$0" > "$LOGDIR/controle.log" 2>&1; then
    echo "❌ controle VERMELHO — falsificação abortada (log: $LOGDIR/controle.log)"; tail -15 "$LOGDIR/controle.log"; exit 1
  fi
  grep -q "RADAR_AGREGADO_CNAE_PROVA_OK" "$LOGDIR/controle.log" || { echo "❌ controle sem marcador de fim"; exit 1; }
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
PORT="${PGPORT_TEST:-5574}"
DATA="$(mktemp -d "${TMPDIR:-/tmp}/pgtest-radar-agregado-cnae.XXXXXX")/data"
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
cegar_md5() { CORPO=1; sabotar "    RAISE EXCEPTION 'P1 FALHOU" "    RAISE NOTICE 'P1 FALHOU"; }
case "${SABOTAGEM:-}" in
  "") ;;
  sem_cnae_exato)     cegar_md5; sabotar "           AND (p_cnae_exato  IS NULL OR a.cnae_principal = p_cnae_exato)" "" ;;
  sem_prefixo)        cegar_md5; sabotar "           AND (p_cnae_prefix IS NULL OR starts_with(a.cnae_principal, p_cnae_prefix))" "" ;;
  estab_ignorado)     cegar_md5; sabotar "           AND (v_estab IS NULL OR (v_estab = 'd0' AND a.estabelecida) OR (v_estab = 'd1' AND a.estabelecida_d1))" "" ;;
  d1_troca)           cegar_md5; sabotar "(v_estab = 'd1' AND a.estabelecida_d1)" "(v_estab = 'd1' AND a.estabelecida)" ;;
  d1_sem_mais_um)     cegar_md5; sabotar "         COALESCE(re.data_abertura <= v_corte + 1, false)," "         COALESCE(re.data_abertura <= v_corte, false)," ;;
  inedito_outro_lote_no_fino) cegar_md5; sabotar "  IF p_data_abertura_min IS NULL AND v_inedito_ok THEN" "  IF p_data_abertura_min IS NULL THEN" ;;
  data_min_no_fino)   cegar_md5; sabotar "  IF p_data_abertura_min IS NULL AND v_inedito_ok THEN" "  IF v_inedito_ok THEN" ;;
  sem_validade_fino)  cegar_md5; sabotar "      IF private.radar_agregado_valido() IS NULL THEN
        RAISE EXCEPTION 'agregado indisponível" "      IF false THEN
        RAISE EXCEPTION 'agregado indisponível" ;;
  fino_nunca)         cegar_md5; sabotar "    IF v_estab IS DISTINCT FROM 'vivo' THEN" "    IF false THEN" ;;
  corte_4anos)        cegar_md5; sabotar "  v_corte date := ((p_agora AT TIME ZONE 'America/Sao_Paulo')::date - interval '5 years')::date;" "  v_corte date := ((p_agora AT TIME ZONE 'America/Sao_Paulo')::date - interval '4 years')::date;" ;;
  rollup_errado)      cegar_md5; sabotar "    FROM public.radar_agregado_cnae c
   GROUP BY" "    FROM public.radar_agregado_cnae c WHERE c.estabelecida
   GROUP BY" ;;
  tabela_aberta)      sabotar "REVOKE ALL ON TABLE public.radar_agregado_cnae FROM PUBLIC, anon, authenticated;" "GRANT SELECT ON TABLE public.radar_agregado_cnae TO authenticated;" ;;
  tabela_aberta_sem_post)
                      sabotar "REVOKE ALL ON TABLE public.radar_agregado_cnae FROM PUBLIC, anon, authenticated;" "GRANT SELECT ON TABLE public.radar_agregado_cnae TO authenticated;"
                      sabotar "    RAISE EXCEPTION 'P2 FALHOU: radar_agregado_cnae legível" "    RAISE NOTICE 'P2 FALHOU: radar_agregado_cnae legível" ;;
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
INSERT INTO public.radar_municipios
SELECT 'M'||lpad(i::text,2,'0'), 'CIDADE '||i, (ARRAY['MG','SP','SC','RJ'])[1 + i % 4], -20 - i, -45 - i
  FROM generate_series(1, 12) i WHERE i <> 11;
-- 4.000 empresas determinísticas (hash do índice) cobrindo cada eixo do agregado; abertura 2010–2023.
INSERT INTO public.radar_empresas
SELECT lpad(i::text, 14, '0'),
       (ARRAY['3101200','3102100','4744001','1622699'])[1 + (h % 4)],
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
       NULL, NULL
  FROM (SELECT i, abs(hashtext('radar' || i)) AS h FROM generate_series(1, 4000) i) s;
-- Bordas do corte (data de São Paulo de HOJE − 5 anos): 30 abertas no corte e 30 no corte + 1 dia, para
-- "estabelecidas" no corte e no corte + 1 (madrugada) diferirem.
UPDATE public.radar_empresas
   SET data_abertura = ((now() AT TIME ZONE 'America/Sao_Paulo')::date - interval '5 years')::date
                       + (cnpj::bigint % 2)::integer
 WHERE cnpj::bigint % 67 = 0;
SQL

# Estado de PROD: predecessoras da parte 2 com o ACL de prod, e a migration da parte 2 por cima.
P -q -f "$PRED"
FCONT="public.radar_contagem_por_municipio(text,text,text,text,boolean,date,date,integer,text,timestamptz,text[],boolean)"
FREC="public.radar_agregado_recalcular(boolean,timestamptz)"
for f in "public.radar_kpis()" "$FCONT" "public.radar_penetracao_por_municipio(text,text,integer)"; do
  Pq -c "REVOKE ALL ON FUNCTION $f FROM PUBLIC, anon; GRANT EXECUTE ON FUNCTION $f TO authenticated, service_role;" >/dev/null
done
P -q -f "$MIG2" >/dev/null 2>&1
MD5_PARTIDA="$(Pq -c "SELECT md5(prosrc) FROM pg_proc WHERE oid = '$FREC'::regprocedure")/$(Pq -c "SELECT md5(prosrc) FROM pg_proc WHERE oid = '$FCONT'::regprocedure")"

# Foto de uma chamada de contagem: "codigo|nome|uf|lat|total/tel/ac", na ORDEM devolvida, separados por ' ; '.
foto() { Pq -c "SELECT coalesce(string_agg(coalesce(municipio_codigo,'∅')||'|'||coalesce(municipio_nome,'∅')||'|'||coalesce(uf,'∅')||'|'||coalesce(lat::text,'∅')||'|'||total||'/'||com_telefone||'/'||a_contatar, ' ; ' ORDER BY o), '(vazio)')
                  FROM public.radar_contagem_por_municipio($1) WITH ORDINALITY AS t(municipio_codigo, municipio_nome, uf, lat, lng, total, com_telefone, a_contatar, o);"; }
# Em ordem de texto: o caminho vivo de antes não desempatava (ORDER BY total DESC só).
ordena() { printf '%s' "$1" | sed 's/ ; /\n/g' | LC_ALL=C sort | tr '\n' ';'; }
soma_total() { printf '%s' "$1" | sed 's/ ; /\n/g' | awk -F'|' '{split($5,a,"/"); s+=a[1]} END {print s+0}'; }
agregado_mun() { Pq -c "SELECT md5(coalesce(string_agg(t::text, ',' ORDER BY t::text), '')) || ':' || count(*) FROM public.radar_agregado_municipio t"; }

CORTE="$(Pq -c "SELECT ((now() AT TIME ZONE 'America/Sao_Paulo')::date - interval '5 years')::date")"
CORTE1="$(Pq -c "SELECT '$CORTE'::date + 1")"
INI="'2026-10-27 16:20:37.722+00'::timestamptz"
REG="p_ufs => ARRAY['MG','SP','RJ']"
declare -a CHAMADAS=(
  "a|p_cnae_exato => '3101200', p_lote => '2026-10'"
  "b|p_cnae_prefix => '31', p_lote => '2026-10', $REG, p_com_contato => true"
  "c|p_cnae_prefix => '3'"
  "d|p_cnae_exato => '1622699', p_uf => 'MG', p_incluir_ja_clientes => true"
  "e|p_cnae_prefix => '4744', p_status => 'em_conversa'"
  "f|p_cnae_exato => '3102100', p_lote => '2026-10', p_primeira_vista_min => $INI"
  "g|p_data_abertura_max => '$CORTE', p_lote => '2026-10', $REG, p_com_contato => true"
  "h|p_data_abertura_max => '$CORTE1', p_lote => '2026-10'"
  "i|p_data_abertura_max => '$CORTE', p_cnae_prefix => '31', p_uf => 'SP'"
  "j|p_limit => 3, p_cnae_prefix => '31'"
  "k|p_data_abertura_max => '2015-06-01', p_lote => '2026-10'"
  "l|p_data_abertura_min => '2015-01-01', p_cnae_prefix => '31'"
  "m|p_lote => '2026-10', $REG, p_com_contato => true"
  "n|p_cnae_prefix => '1', p_lote => '2026-08', p_incluir_ja_clientes => true"
  "o|p_cnae_prefix => '31', p_lote => '2026-10', p_primeira_vista_min => '2026-10-01 00:00+00'"
  "p|p_cnae_exato => '4744001', p_status => 'descartado', p_data_abertura_max => '$CORTE'"
)
ANTES_DIR="$(dirname "$DATA")/antes"; mkdir -p "$ANTES_DIR"
antes() { cat "$ANTES_DIR/$1"; }
for c in "${CHAMADAS[@]}"; do foto "${c#*|}" > "$ANTES_DIR/c${c%%|*}"; done
AGG_ANTES="$(agregado_mun)"

# F1 precisa de um banco onde o corpo vivo DIVERGE da predecessora: clona ANTES de aplicar.
PD postgres -q -c "CREATE DATABASE divergente TEMPLATE base;"
PD divergente -q -c "CREATE OR REPLACE FUNCTION public.radar_agregado_recalcular(p_forcar boolean DEFAULT false, p_agora timestamptz DEFAULT now())
 RETURNS jsonb LANGUAGE sql SECURITY DEFINER SET search_path TO 'public' AS \$f\$ SELECT '{\"OUTRA\":\"SESSAO\"}'::jsonb \$f\$;"

P -q -f "$MIG_USADA" >/dev/null
if [ "$CORPO" -eq 0 ]; then
  P -q -f "$MIG_USADA" >/dev/null   # idempotente: o 2º apply passa a PRE pelo md5 "este"
fi

PASS=0; FAIL=0
eq() { if [ "$2" = "$3" ]; then echo "PASS $1"; PASS=$((PASS+1)); else echo "FAIL $1 — obtido [$2] esperado [$3]"; FAIL=$((FAIL+1)); fi; }
falha() { Pq -c "DO \$t\$ BEGIN
  PERFORM * FROM $1;
  RAISE NOTICE 'R:ACEITOU';
EXCEPTION WHEN raise_exception THEN
  IF SQLERRM LIKE 'agregado indispon%' THEN RAISE NOTICE 'R:INDISPONIVEL'; ELSE RAISE; END IF;
END \$t\$;" 2>&1 | grep -o 'R:[A-Z]*' || true; }
# Leituras de radar_empresas (seq + índice) dentro de UMA chamada.
leituras() { Pq -c "BEGIN;
  SELECT count(*) FROM public.radar_contagem_por_municipio($1);
  SELECT coalesce(sum(seq_scan + coalesce(idx_scan,0)),0) FROM pg_stat_xact_user_tables WHERE relname = 'radar_empresas';
ROLLBACK;" | tail -1; }

eq "A0 partida = prod (md5 recalcular/contagem)" "$MD5_PARTIDA" "d1ae9348b0208a57e03c7f388b75eaa7/1ffd4e5bd206bf83862b503a6a78a25a"
eq "A0b corte da prova = o gravado" "$(Pq -c "SELECT corte_estabelecida FROM public.radar_agregado_estado")" "$CORTE"

VAZIAS=""
for c in "${CHAMADAS[@]}"; do
  id="${c%%|*}"
  eq "E$id contagem($id) = antes" "$(ordena "$(foto "${c#*|}")")" "$(ordena "$(antes "c$id")")"
  [ "$(antes "c$id")" = "(vazio)" ] && VAZIAS="$VAZIAS $id"
done
eq "E0 âncora: nenhuma chamada de antes é vazia" "${VAZIAS:-nenhuma}" "nenhuma"
eq "Ex o corte separa: corte ≠ corte + 1" "$( [ "$(antes ch)" != "$(foto "p_data_abertura_max => '$CORTE', p_lote => '2026-10'")" ] && echo difere)" "difere"
eq "Ey ordem determinística no fino (CNAE + região) = antes" "$(foto "p_cnae_prefix => '31', p_lote => '2026-10', $REG, p_com_contato => true")" "$(antes cb)"
eq "R1 agregado por município (soma do fino) = o de antes" "$(agregado_mun)" "$AGG_ANTES"
eq "R2 fino soma as 4.000 empresas" "$(Pq -c "SELECT sum(n) FROM public.radar_agregado_cnae")" "4000"

eq "I1 CNAE exato: 0 leituras de radar_empresas" "$(leituras "p_cnae_exato => '3101200', p_lote => '2026-10'")" "0"
eq "I2 estabelecidas no corte: 0 leituras" "$(leituras "p_data_abertura_max => '$CORTE', p_lote => '2026-10', $REG")" "0"
eq "I3 estabelecidas no corte + 1: 0 leituras" "$(leituras "p_data_abertura_max => '$CORTE1', p_cnae_prefix => '31'")" "0"
eq "I4 controle: data fora do corte lê a tabela" "$(leituras "p_data_abertura_max => '2015-06-01'")" "1"

# B — lote novo: 2026-11 complete; 300 empresas mudam de lote (a carga), sem recálculo ainda.
Pq -c "INSERT INTO public.radar_ingest_state VALUES ('2026-11','complete','2026-11-28 10:00+00', 300);
       UPDATE public.radar_empresas SET ultimo_lote = '2026-11' WHERE cnpj::bigint % 13 = 0;" >/dev/null
eq "B1a CNAE com agregado de outro lote = indisponível" "$(falha "public.radar_contagem_por_municipio(p_cnae_prefix => '31', p_lote => '2026-11')")" "R:INDISPONIVEL"
eq "B1b estabelecidas com agregado de outro lote = indisponível" "$(falha "public.radar_contagem_por_municipio(p_data_abertura_max => '$CORTE')")" "R:INDISPONIVEL"
eq "B1c data fora do corte (vivo) segue respondendo" "$(falha "public.radar_contagem_por_municipio(p_data_abertura_max => '2015-06-01')")" "R:ACEITOU"
eq "B2a recálculo no lote novo" "$(Pq -c "SELECT public.radar_agregado_recalcular(false, now())->>'recalculou'")" "true"
eq "B2b CNAE do lote novo = tabela" \
   "$(soma_total "$(foto "p_cnae_prefix => '31', p_lote => '2026-11', p_incluir_ja_clientes => true, p_status => 'a_contatar'")")" \
   "$(Pq -c "SELECT count(*) FROM public.radar_empresas WHERE ultimo_lote = '2026-11' AND prospeccao_status = 'a_contatar' AND cnae_principal LIKE '31%'")"
eq "B2c estabelecidas do lote novo = tabela" \
   "$(soma_total "$(foto "p_data_abertura_max => '$CORTE', p_lote => '2026-11'")")" \
   "$(Pq -c "SELECT count(*) FROM public.radar_empresas WHERE ultimo_lote = '2026-11' AND data_abertura <= '$CORTE' AND ja_cliente = false AND prospeccao_status <> 'descartado'")"

# C1 — o fino fechado: authenticated recebe 42501 (GRANT). SQLSTATE do prefixo do SERVIDOR.
estado_sob_auth() { local s; s="$(P -qAt -v VERBOSITY=verbose -c "SET ROLE authenticated; $1" 2>&1 | sed -nE 's/^(ERROR|ERRO): +([0-9A-Z]{5}):.*/\2/p' | head -1)"; printf '%s' "${s:-LEU}"; }
eq "C1a authenticated não lê radar_agregado_cnae (42501)" "$(estado_sob_auth "SELECT count(*) FROM public.radar_agregado_cnae")" "42501"
eq "C1b RLS ligada no fino" "$(Pq -c "SELECT relrowsecurity FROM pg_class WHERE relname = 'radar_agregado_cnae'")" "t"
eq "C2 ACL: contagem p/ authenticated e não anon; recalcular só owner" \
   "$(Pq -c "SELECT has_function_privilege('authenticated', '$FCONT', 'EXECUTE')||'/'||has_function_privilege('anon', '$FCONT', 'EXECUTE')||'/'||has_function_privilege('authenticated', '$FREC', 'EXECUTE')||'/'||has_function_privilege('service_role', '$FREC', 'EXECUTE')")" \
   "true/false/false/false"
eq "K1 corte = data de São Paulo do cálculo − 5 anos (p_agora fixo)" \
   "$(Pq -c "SELECT public.radar_agregado_recalcular(true, '2026-11-29 02:00+00')->>'corte_estabelecida'")" "2021-11-28"

# F1 — PRE: com o corpo vivo divergente, a migration aborta e a função da outra sessão fica.
SAIDA_DIV="$(PD divergente -q -f "$MIG_USADA" 2>&1 || true)"
eq "F1a PRE aborta com corpo vivo divergente" "$(printf '%s' "$SAIDA_DIV" | grep -o 'PRE FALHOU: radar_agregado_recalcular' | head -1)" "PRE FALHOU: radar_agregado_recalcular"
eq "F1b o vivo divergente segue intacto e nada foi criado" \
   "$(PD divergente -qAt -c "SELECT (SELECT prosrc LIKE '%OUTRA%' FROM pg_proc WHERE proname = 'radar_agregado_recalcular')::text||'/'||(to_regclass('public.radar_agregado_cnae') IS NULL)::text")" "true/true"

echo "PASS=$PASS  FAIL=$FAIL"
[ "$FAIL" -eq 0 ] && echo "RADAR_AGREGADO_CNAE_PROVA_OK"
