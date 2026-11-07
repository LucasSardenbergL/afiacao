#!/usr/bin/env bash
# Prova PG17 da migration 20261106212329_radar_lista_meus_atendimentos (Radar, pacote B2):
#   radar_lista ganha p_so_meus (22º arg): só os leads com atendimento ABERTO e NÃO EXPIRADO do auth.uid(),
#   filtrados NO SERVIDOR antes da paginação (recortar os 50 carregados no front dá falso vazio).
# Parte do estado de PROD (predecessoras + 20261103100000 + 20261103223300 + 20261103131500 + 20261104153351 +
# o pacote C 20261106175800 + a tabela e as 2 funções de atendimento EXTRAÍDAS LITERALMENTE de 20261029201200),
# aplica a migration REAL duas vezes (idempotência) e assevera:
#   A0  o estado de partida É o de prod (md5 da lista do C, de radar_atendimentos_ativos e da expiração)
#   E   p_so_meus omitido ou false devolve o MESMO de antes, em 4 recortes
#   M   o dono vê só os seus ativos (= oráculo escrito à mão a partir da fixture); o renovado por contato fica;
#       o expirado, o encerrado, o de outro dono e o de dono sem acesso somem; o outro dono vê só os dele
#   P   paginação: os meus estão FORA dos 50 primeiros da fila (âncora) e a visão os traz todos na 1ª página;
#       páginas de 2 em 2 somam o conjunto sem repetir
#   N   filtros combinam (E): sem p_incluir_ja_clientes o já-cliente some (por isso o front passa true)
#   C   ACL da assinatura nova (authenticated sim, anon 42501); a antiga sumiu, uma sobrecarga só
#   F1  PRE: corpo vivo divergente ABORTA a migration e nada é dropado
#   F2  PRE: sem radar_atendimentos_ativos() a migration aborta (late-bound: o CREATE passaria)
#
#   bash db/test-radar-meus-atendimentos.sh > /tmp/t.log 2>&1; echo "exit=$?"
#   SABOTAGEM=<nome> bash db/test-radar-meus-atendimentos.sh   # tem de ficar VERMELHA
#   bash db/test-radar-meus-atendimentos.sh --falsificar        # controle verde + cada sabotagem vermelha no assert dela
#   LOCALE_TESTE=pt_BR.UTF-8 bash db/test-radar-meus-atendimentos.sh
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MIG="$REPO_ROOT/supabase/migrations/20261106212329_radar_lista_meus_atendimentos.sql"
MIG_C="$REPO_ROOT/supabase/migrations/20261106175800_radar_mapa_regiao_cidade_telefone.sql"
MIG_AC="$REPO_ROOT/supabase/migrations/20261029201200_radar_acesso_vendedor.sql"
MIG_P2="$REPO_ROOT/supabase/migrations/20261103100000_radar_agregado_municipio.sql"
MIG_P4="$REPO_ROOT/supabase/migrations/20261103223300_radar_agregado_cnae.sql"
MIG_LISTA="$REPO_ROOT/supabase/migrations/20261103131500_radar_lista_rpc.sql"
MIG_SEC="$REPO_ROOT/supabase/migrations/20261104153351_radar_cnae_secundario.sql"
PRED="$REPO_ROOT/db/fixtures/radar-agregado-predecessoras-prod-20261103.sql"

if [ "${1:-}" = "--falsificar" ]; then
  # nome:VERMELHOS — asserts (unidos por ',') que TÊM de ficar vermelhos; ou `APPLY!MARCA` quando a
  # postcondição/PRE da própria migration TEM de abortar o apply com aquela marca (`_` vira espaço).
  SABOTAGENS="so_meus_ignorado:M1,M2,M3,P1 sem_eh_meu:M1,M4,M6 tabela_crua:M1,M2 default_true:E1o,E2o,E3o,E4o lista_anon:APPLY!P2_FALHOU lista_anon_sem_post:C2 sem_drop_antiga:APPLY!P1_FALHOU:_sobrou pre_cega:F1a,F1b pre_sem_ativos:F2"
  LOGDIR="$(mktemp -d "${TMPDIR:-/tmp}/falsifica-radar-meus.XXXXXX")"
  echo "══ CONTROLE ══"
  if ! SABOTAGEM="" bash "$0" > "$LOGDIR/controle.log" 2>&1; then
    echo "❌ controle VERMELHO — falsificação abortada (log: $LOGDIR/controle.log)"; tail -15 "$LOGDIR/controle.log"; exit 1
  fi
  grep -q "RADAR_MEUS_ATENDIMENTOS_PROVA_OK" "$LOGDIR/controle.log" || { echo "❌ controle sem marcador de fim"; exit 1; }
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
  echo "SABOTAGENS: $SAB_V vermelhas / $SAB_F falhas"
  [ "$SAB_F" -eq 0 ] && exit 0 || exit 1
fi

export PGVER=17
# shellcheck disable=SC1091  # caminho resolvido em runtime a partir de REPO_ROOT
. "$REPO_ROOT/db/lib/pg-harness.sh"
PORT="${PGPORT_TEST:-5583}"
DATA="$(mktemp -d "${TMPDIR:-/tmp}/pgtest-radar-meus.XXXXXX")/data"
LOCALE_TESTE="${LOCALE_TESTE:-C}"
export LC_ALL="$LOCALE_TESTE" LANG="$LOCALE_TESTE"
MIG_USADA="$(dirname "$DATA")/mig.sql"
ATEND_SQL="$(dirname "$DATA")/atendimentos.sql"
cleanup() { "$PGBIN/pg_ctl" -D "$DATA" stop -m immediate >/dev/null 2>&1 || true; rm -rf "$(dirname "$DATA")"; }
trap cleanup EXIT

cp "$MIG" "$MIG_USADA"

# As peças de atendimento vêm LITERAIS de 20261029201200 (tabela, expiração, leitura dos ativos): o A0 confere
# que o md5 extraído é o de prod — copiar à mão deixaria a prova sobre uma regra de prazo que não é a viva.
python3 -I - "$MIG_AC" "$ATEND_SQL" <<'PY'
import sys
src, dst = sys.argv[1:]
s = open(src, encoding="utf-8").read()
def trecho(ini, fim):
    i = s.index(ini); j = s.index(fim, i) + len(fim)
    return s[i:j]
partes = [
  trecho("CREATE TABLE IF NOT EXISTS public.radar_atendimentos (", "GRANT SELECT ON TABLE public.radar_atendimentos TO service_role;"),
  trecho("CREATE OR REPLACE FUNCTION private.radar_atendimento_expira_em(", "FROM PUBLIC, anon, authenticated;"),
  trecho("CREATE OR REPLACE FUNCTION public.radar_atendimentos_ativos()", "GRANT EXECUTE ON FUNCTION public.radar_atendimentos_ativos() TO authenticated, service_role;"),
]
open(dst, "w", encoding="utf-8").write("\n\n".join(partes) + "\n")
PY

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
# Sabotagem no CORPO muda o prosrc → a PÓS P1 e a PRE do 2º apply pegariam antes da suíte. Para provar que o
# assert da suíte tem dente sozinho: P1 vira NOTICE e o 2º apply não roda.
CORPO=0
cegar_md5() { CORPO=1; sabotar "    RAISE EXCEPTION 'P1 FALHOU: a radar_lista viva" "    RAISE NOTICE 'P1 FALHOU: a radar_lista viva"; }
# shellcheck disable=SC2016  # os trechos sabotados são SQL literal ($w$…), não expansão do shell
case "${SABOTAGEM:-}" in
  "") ;;
  so_meus_ignorado)   cegar_md5; sabotar '    v_w := array_append(v_w, $w$e.cnpj IN (SELECT a.cnpj FROM public.radar_atendimentos_ativos() a WHERE a.eh_meu)$w$);' '    NULL;' ;;
  sem_eh_meu)         cegar_md5; sabotar 'FROM public.radar_atendimentos_ativos() a WHERE a.eh_meu)$w$' 'FROM public.radar_atendimentos_ativos() a)$w$' ;;
  tabela_crua)        cegar_md5; sabotar 'FROM public.radar_atendimentos_ativos() a WHERE a.eh_meu)$w$' 'FROM public.radar_atendimentos a WHERE a.encerrado_em IS NULL AND a.dono_user_id = (SELECT auth.uid()))$w$' ;;
  default_true)       sabotar "  p_so_meus boolean DEFAULT false)" "  p_so_meus boolean DEFAULT true)" ;;
  lista_anon)         sabotar "GRANT EXECUTE ON FUNCTION public.radar_lista(text,text,text,text[],text,text,text,boolean,text,timestamptz,text,numeric,boolean,boolean,date,date,text,integer,integer,text,text,boolean) TO authenticated, service_role;" \
                              "GRANT EXECUTE ON FUNCTION public.radar_lista(text,text,text,text[],text,text,text,boolean,text,timestamptz,text,numeric,boolean,boolean,date,date,text,integer,integer,text,text,boolean) TO anon, authenticated, service_role;" ;;
  lista_anon_sem_post) sabotar "GRANT EXECUTE ON FUNCTION public.radar_lista(text,text,text,text[],text,text,text,boolean,text,timestamptz,text,numeric,boolean,boolean,date,date,text,integer,integer,text,text,boolean) TO authenticated, service_role;" \
                              "GRANT EXECUTE ON FUNCTION public.radar_lista(text,text,text,text[],text,text,text,boolean,text,timestamptz,text,numeric,boolean,boolean,date,date,text,integer,integer,text,text,boolean) TO anon, authenticated, service_role;"
                      sabotar "    RAISE EXCEPTION 'P2 FALHOU: ACL errado" "    RAISE NOTICE 'P2 FALHOU: ACL errado" ;;
  sem_drop_antiga)    sabotar "DROP FUNCTION IF EXISTS public.radar_lista(text,text,text,text[],text,text,text,boolean,text,timestamptz,text,numeric,boolean,boolean,date,date,text,integer,integer,text,text);" "" ;;
  pre_cega)           sabotar "  IF v_sobrecargas <> 1
     OR NOT" "  IF false AND NOT" ;;
  pre_sem_ativos)     sabotar "  IF to_regprocedure('public.radar_atendimentos_ativos()') IS NULL THEN" "  IF false THEN" ;;
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
-- auth.uid() pelo GUC prova.uid (como o JWT do PostgREST): sem GUC, o vendedor A1, como no harness do pacote C.
CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE
  AS $$ SELECT COALESCE(NULLIF(current_setting('prova.uid', true), ''), '00000000-0000-0000-0000-0000000000a1')::uuid $$;
-- Capability: todo mundo passa, menos B9 (o dono que perdeu o acesso).
CREATE FUNCTION private.cap_radar_prospectar(uuid) RETURNS boolean LANGUAGE sql STABLE
  AS $$ SELECT $1 IS DISTINCT FROM '00000000-0000-0000-0000-0000000000b9'::uuid $$;
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
-- O que a expiração (radar_contatos) e o nome do dono (profiles) leem, nas colunas que as funções usam.
CREATE TABLE public.radar_contatos (id bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY, cnpj text NOT NULL, acao text,
  criado_por uuid, created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE public.profiles (user_id uuid PRIMARY KEY, name text);
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
P -q -f "$MIG_C" >/dev/null 2>&1
P -q -f "$ATEND_SQL" >/dev/null
Pq -c "ANALYZE public.radar_empresas;" >/dev/null

FLISTA_ANT="public.radar_lista(text,text,text,text[],text,text,text,boolean,text,timestamptz,text,numeric,boolean,boolean,date,date,text,integer,integer,text,text)"
FLISTA="public.radar_lista(text,text,text,text[],text,text,text,boolean,text,timestamptz,text,numeric,boolean,boolean,date,date,text,integer,integer,text,text,boolean)"
md5f() { Pq -c "SELECT md5(prosrc) FROM pg_proc WHERE oid = to_regprocedure('$1')"; }
MD5_PARTIDA="$(md5f "$FLISTA_ANT")/$(md5f "public.radar_atendimentos_ativos()")/$(md5f "private.radar_atendimento_expira_em(text,uuid,timestamptz,timestamptz)")"

U_A1="00000000-0000-0000-0000-0000000000a1"
U_A2="00000000-0000-0000-0000-0000000000a2"
U_B9="00000000-0000-0000-0000-0000000000b9"
# Os leads do A1 são os de MENOR score da fila neutra: ficam fora dos 50 primeiros (o falso vazio do front).
# Escolha determinística: score não nulo, não descartados, por score ASC, cnpj.
Pq <<SQL >/dev/null
INSERT INTO public.profiles VALUES ('$U_A1', 'Vendedor A1'), ('$U_A2', 'Vendedor A2'), ('$U_B9', 'Sem acesso');
CREATE TABLE prova_papel (cnpj text PRIMARY KEY, papel text NOT NULL);
INSERT INTO prova_papel
SELECT cnpj, (ARRAY['a1_ativo','a1_ativo','a1_ativo','a1_renovado','a1_expirado','a1_encerrado','a2_ativo','a2_ativo','b9_ativo'])[rn]
  FROM (SELECT cnpj, row_number() OVER (ORDER BY score ASC, cnpj) AS rn
          FROM public.radar_empresas
         WHERE prospeccao_status <> 'descartado' AND ja_cliente = false AND score IS NOT NULL) s
 WHERE rn <= 9;
-- Um ativo do A1 que é JÁ-CLIENTE (o filtro neutro inclui já-clientes).
INSERT INTO prova_papel
SELECT cnpj, 'a1_ativo_cliente' FROM public.radar_empresas
 WHERE prospeccao_status <> 'descartado' AND ja_cliente = true AND score IS NOT NULL ORDER BY score ASC, cnpj LIMIT 1;
INSERT INTO public.radar_atendimentos (cnpj, dono_user_id, assumido_em, encerrado_em, motivo_encerramento)
SELECT cnpj,
       CASE WHEN papel LIKE 'a1%' THEN '$U_A1'::uuid WHEN papel LIKE 'a2%' THEN '$U_A2'::uuid ELSE '$U_B9'::uuid END,
       CASE WHEN papel IN ('a1_renovado', 'a1_expirado') THEN now() - interval '10 days' ELSE now() - interval '1 day' END,
       CASE WHEN papel = 'a1_encerrado' THEN now() - interval '1 hour' END,
       CASE WHEN papel = 'a1_encerrado' THEN 'liberado' END
  FROM prova_papel;
-- Renovado: contato do dono ANTES de expirar (assumido+7d = now()-3d) empurra para now()+2d.
INSERT INTO public.radar_contatos (cnpj, acao, criado_por, created_at)
SELECT cnpj, 'ligacao', '$U_A1', now() - interval '5 days' FROM prova_papel WHERE papel = 'a1_renovado';
SQL

# Lista: os CNPJs na ordem devolvida (sob o uid $1).
lista_de() { local uid="$1"; shift; Pq -c "SET prova.uid = '$uid'; SELECT coalesce(string_agg(t.cnpj, ',' ORDER BY t.ordinality), '(vazio)') FROM public.radar_lista($1) WITH ORDINALITY AS t" | tail -1; }
lista() { lista_de "$U_A1" "$@"; }
# Oráculo: os CNPJs dos papéis pedidos, na ordem da RPC (score DESC NULLS LAST, cnpj) — escrito SEM ler radar_atendimentos.
oraculo() { Pq -c "SELECT coalesce(string_agg(e.cnpj, ',' ORDER BY e.score DESC NULLS LAST, e.cnpj), '(vazio)')
                     FROM public.radar_empresas e JOIN prova_papel p USING (cnpj) WHERE p.papel IN ($1)"; }
papel_cnpj() { Pq -c "SELECT string_agg(cnpj, ',' ORDER BY cnpj) FROM prova_papel WHERE papel = '$1'"; }
contem() { case ",$1," in *",$2,"*) echo sim ;; *) echo nao ;; esac; }
NEUTRO="p_incluir_ja_clientes => true, p_com_contato => false"

declare -a LISTAS=(
  "1|p_busca => NULL"
  "2|p_uf => 'MG', p_com_telefone => true"
  "3|p_incluir_ja_clientes => true, p_ordem => 'capital_social', p_limit => 200"
  "4|p_municipio_codigo => '0001', p_offset => 10, p_limit => 20"
)
ANTES_DIR="$(dirname "$DATA")/antes"; mkdir -p "$ANTES_DIR"
for c in "${LISTAS[@]}"; do lista "${c#*|}" > "$ANTES_DIR/l${c%%|*}"; done

# F1 precisa de um banco onde o corpo vivo DIVERGE da predecessora; F2, de um sem radar_atendimentos_ativos.
PD postgres -q -c "CREATE DATABASE divergente TEMPLATE base;" -c "CREATE DATABASE sem_ativos TEMPLATE base;"
PD divergente -q -c "CREATE OR REPLACE FUNCTION public.radar_lista(p_busca text DEFAULT NULL, p_municipio text DEFAULT NULL, p_uf text DEFAULT NULL, p_ufs text[] DEFAULT NULL, p_cnae_exato text DEFAULT NULL, p_cnae_prefixo text DEFAULT NULL, p_status text DEFAULT NULL, p_incluir_ja_clientes boolean DEFAULT false, p_ultimo_lote text DEFAULT NULL, p_primeira_vista_min timestamptz DEFAULT NULL, p_sugeridos_lote text DEFAULT NULL, p_sugeridos_score_min numeric DEFAULT NULL, p_com_telefone boolean DEFAULT false, p_com_contato boolean DEFAULT false, p_data_abertura_min date DEFAULT NULL, p_data_abertura_max date DEFAULT NULL, p_ordem text DEFAULT 'score', p_offset integer DEFAULT 0, p_limit integer DEFAULT 50, p_cnae_secundario text DEFAULT NULL, p_municipio_codigo text DEFAULT NULL) RETURNS SETOF public.radar_empresas LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS \$f\$ SELECT * FROM public.radar_empresas WHERE cnpj = 'OUTRA' \$f\$;"
PD sem_ativos -q -c "DROP FUNCTION public.radar_atendimentos_ativos();"

P -q -f "$MIG_USADA" >/dev/null
if [ "$CORPO" -eq 0 ]; then
  P -q -f "$MIG_USADA" >/dev/null   # idempotente: o 2º apply passa a PRE pela assinatura nova com "este"
fi

PASS=0; FAIL=0
eq() { if [ "$2" = "$3" ]; then echo "PASS $1"; PASS=$((PASS+1)); else echo "FAIL $1 — obtido [$2] esperado [$3]"; FAIL=$((FAIL+1)); fi; }

eq "A0 partida = prod (md5 lista do C / atendimentos_ativos / expira_em)" "$MD5_PARTIDA" \
   "2cb7ad507c9079b27ff43176da438212/0b25e447552423f8c82cc93192c534d5/fefd503925f5feaa33057895894f8b3c"
eq "A1 âncora: a fixture tem 1 de cada papel (e 3 ativos simples do A1, 2 do A2)" \
   "$(Pq -c "SELECT string_agg(papel||'='||n, ',' ORDER BY papel) FROM (SELECT papel, count(*) n FROM prova_papel GROUP BY papel) s")" \
   "a1_ativo=3,a1_ativo_cliente=1,a1_encerrado=1,a1_expirado=1,a1_renovado=1,a2_ativo=2,b9_ativo=1"

# E — sem o parâmetro (omitido) e com false explícito: o MESMO de antes.
for c in "${LISTAS[@]}"; do
  id="${c%%|*}"
  eq "E${id}o lista($id) sem p_so_meus = antes" "$(lista "${c#*|}")" "$(cat "$ANTES_DIR/l$id")"
  eq "E${id}f lista($id) com p_so_meus => false = antes" "$(lista "${c#*|}, p_so_meus => false")" "$(cat "$ANTES_DIR/l$id")"
done

# M — a visão "Meus atendimentos".
MEUS="$(lista "$NEUTRO, p_limit => 50, p_so_meus => true")"
eq "M1 o dono vê exatamente os seus ativos (= oráculo, na ordem da RPC)" "$MEUS" \
   "$(oraculo "'a1_ativo','a1_ativo_cliente','a1_renovado'")"
eq "M2 o expirado some (e o renovado por contato fica)" \
   "$(contem "$MEUS" "$(papel_cnpj a1_expirado)")/$(contem "$MEUS" "$(papel_cnpj a1_renovado)")" "nao/sim"
eq "M3 o encerrado some" "$(contem "$MEUS" "$(papel_cnpj a1_encerrado)")" "nao"
OUTRO="$(papel_cnpj a2_ativo)"
eq "M4 o lead de outro dono não aparece" "$(contem "$MEUS" "${OUTRO%%,*}")/$(contem "$MEUS" "${OUTRO##*,}")/$(contem "$MEUS" "$(papel_cnpj b9_ativo)")" "nao/nao/nao"
eq "M5 o outro dono vê só os dele" "$(lista_de "$U_A2" "$NEUTRO, p_limit => 50, p_so_meus => true")" "$(oraculo "'a2_ativo'")"
eq "M6 vendedor sem atendimento vê vazio (não a fila)" "$(lista_de "00000000-0000-0000-0000-0000000000c3" "$NEUTRO, p_limit => 50, p_so_meus => true")" "(vazio)"

# P — filtro ANTES da paginação.
FILA50="$(lista "$NEUTRO, p_limit => 50")"
FORA=0; for x in ${MEUS//,/ }; do [ "$(contem "$FILA50" "$x")" = nao ] && FORA=$((FORA+1)); done
eq "P0 âncora: nenhum dos meus está nos 50 primeiros da fila (filtrar no front daria vazio)" "$FORA" "5"
eq "P1 a 1ª página da visão traz os 5" "$(printf '%s' "$MEUS" | tr ',' '\n' | grep -c . || true)" "5"
PAG="$(lista "$NEUTRO, p_so_meus => true, p_limit => 2, p_offset => 0"),$(lista "$NEUTRO, p_so_meus => true, p_limit => 2, p_offset => 2"),$(lista "$NEUTRO, p_so_meus => true, p_limit => 2, p_offset => 4")"
eq "P2 páginas de 2 somam o conjunto, na ordem, sem repetir" "$PAG" "$MEUS"

# N — combina com os outros filtros (E).
eq "N1 sem p_incluir_ja_clientes o já-cliente some (o front passa true)" \
   "$(lista "p_so_meus => true, p_limit => 50")" "$(oraculo "'a1_ativo','a1_renovado'")"

# C — ACL da assinatura nova; a antiga sumiu.
estado_sob() { local s; s="$(P -qAt -v VERBOSITY=verbose -c "SET ROLE $1; $2" 2>&1 | sed -nE 's/^(ERROR|ERRO): +([0-9A-Z]{5}):.*/\2/p' | head -1)"; printf '%s' "${s:-LEU}"; }
eq "C1 authenticated chama a visão" "$(estado_sob authenticated "SELECT count(*) FROM public.radar_lista(p_so_meus => true)")" "LEU"
eq "C2 anon não chama a lista nova (42501)" "$(estado_sob anon "SELECT count(*) FROM public.radar_lista(p_so_meus => true)")" "42501"
eq "C3 ACL: authenticated sim, anon não" \
   "$(Pq -c "SELECT has_function_privilege('authenticated', '$FLISTA', 'EXECUTE')||'/'||has_function_privilege('anon', '$FLISTA', 'EXECUTE')")" "true/false"
eq "C4 a assinatura antiga sumiu (uma sobrecarga só)" \
   "$(Pq -c "SELECT (to_regprocedure('$FLISTA_ANT') IS NULL)::text||'/'||count(*) FROM pg_proc WHERE proname = 'radar_lista'")" "true/1"

# F — PRE.
SAIDA_DIV="$(PD divergente -q -f "$MIG_USADA" 2>&1 || true)"
eq "F1a PRE aborta com corpo vivo divergente" "$(printf '%s' "$SAIDA_DIV" | grep -o 'PRE FALHOU: radar_lista vivo' | head -1)" "PRE FALHOU: radar_lista vivo"
eq "F1b o vivo divergente segue intacto e nada foi dropado nem criado" \
   "$(PD divergente -qAt -c "SELECT (SELECT prosrc LIKE '%OUTRA%' FROM pg_proc WHERE oid = to_regprocedure('$FLISTA_ANT'))::text||'/'||(to_regprocedure('$FLISTA') IS NULL)::text")" "true/true"
SAIDA_SEM="$(PD sem_ativos -q -f "$MIG_USADA" 2>&1 || true)"
eq "F2 PRE aborta sem radar_atendimentos_ativos() e não cria a assinatura nova" \
   "$(printf '%s' "$SAIDA_SEM" | grep -o 'PRE FALHOU: public.radar_atendimentos_ativos() ausente' | head -1)/$(PD sem_ativos -qAt -c "SELECT (to_regprocedure('$FLISTA') IS NULL)::text")" \
   "PRE FALHOU: public.radar_atendimentos_ativos() ausente/true"

echo "MD5_ESTE=$(md5f "$FLISTA")"
echo "PASS=$PASS  FAIL=$FAIL"
[ "$FAIL" -eq 0 ] && echo "RADAR_MEUS_ATENDIMENTOS_PROVA_OK"
