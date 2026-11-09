#!/usr/bin/env bash
# Prova de CUSTO (PG17) da publicação em passos da carga mensal do Radar — migration 20261111120000.
#
# A prova de correção (db/test-radar-publicacao-curta.sh) roda com dezenas de linhas e 1 índice; o incidente
# de 2026-11-08 foi de CUSTO (503.929 linhas × os índices reais numa transação = > 30 min, Realtime travado).
# Aqui: a DDL REAL de radar_empresas lida da prod (db/fixtures/radar-empresas-ddl-prod-20261108.sql: 43 colunas,
# CHECKs, 24 índices — 4 GIN incl. trigram, expressões com regexp) e a distribuição real de rótulos
# (503.929 em 2026-10, 50.251 em 2026-05, 10.385 em 2026-08, 8.456 em 2026-09). A carga 2026-11 é um MÊS NOVO
# (o pior caso: todo mundo que fica troca de rótulo): 494k que ficam (5% com cadastro mudado), 9,9k que saem,
# 10k novas e 2k que voltam ao dump. Mede, com o CALL real:
#   K1  a publicação termina (publicada, foto = esperado)
#   K2  a MAIOR transação do CALL (amostrada a cada 100 ms em pg_stat_activity.xact_start) < TETO_XACT_S
#   K3  a maior espera de um "vendedor" concorrente (UPDATE de 1 linha da foto, 20/s) < TETO_VENDEDOR_S
#   K4  durante toda a publicação a foto vigente seguiu com 503.929 (amostrada a cada 2 s)
# e registra tempo total, WAL gerado e crescimento da tabela/índices (para docs/historico).
#
# Pesado (~5–10 min na M2): NÃO está no núcleo do CI — roda à mão antes de mexer na publicação.
#   heavy bash db/test-radar-publicacao-curta-custo.sh > /tmp/custo.log 2>&1; echo "exit=$?"
#   N_FOTO=50000 bash db/test-radar-publicacao-curta-custo.sh   # ensaio rápido em escala 1/10
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DDL="$REPO_ROOT/db/fixtures/radar-empresas-ddl-prod-20261108.sql"
MIG_BASE="$REPO_ROOT/supabase/migrations/20261110130000_radar_carga_publicacao_atomica.sql"
MIG="$REPO_ROOT/supabase/migrations/20261111120000_radar_carga_publicacao_curta.sql"
MIG_RECRUZAR="$REPO_ROOT/supabase/migrations/20261019150000_radar_recruzar_mascara_exata.sql"
N_FOTO="${N_FOTO:-503929}"
TETO_XACT_S="${TETO_XACT_S:-3}"
TETO_VENDEDOR_S="${TETO_VENDEDOR_S:-3}"

export PGVER=17
# shellcheck disable=SC1091  # caminho resolvido em runtime a partir de REPO_ROOT
. "$REPO_ROOT/db/lib/pg-harness.sh"
PORT="${PGPORT_TEST:-5499}"
TMPD="$(mktemp -d "${TMPDIR:-/tmp}/pgtest-radar-custo.XXXXXX")"
DATA="$TMPD/data"
export LC_ALL=C LANG=C
cleanup() { "$PGBIN/pg_ctl" -D "$DATA" stop -m immediate >/dev/null 2>&1 || true; rm -rf "$TMPD"; }
trap cleanup EXIT

"$PGBIN/initdb" -D "$DATA" -U postgres -E UTF8 --locale=C >/dev/null
# Memória perto do plano da prod (não do default minúsculo do initdb), WAL sem fsync só para não medir o disco do Mac.
"$PGBIN/pg_ctl" -D "$DATA" -o "-p $PORT -k /tmp -c shared_buffers=512MB -c work_mem=16MB -c maintenance_work_mem=256MB -c max_wal_size=4GB -c fsync=off -c synchronous_commit=off" \
  -l "$TMPD/pg.log" -w start >/dev/null
P()  { "$PGBIN/psql" -X -v ON_ERROR_STOP=1 -p "$PORT" -h /tmp -U postgres -d postgres "$@"; }
Pq() { P -qAt "$@"; }
PASS=0; FAIL=0
ok()  { if [ "$2" = "t" ]; then echo "PASS $1"; PASS=$((PASS+1)); else echo "FAIL $1 — $3"; FAIL=$((FAIL+1)); fi; }

echo "=== esquema (DDL de prod) ==="
P -q <<'SQL'
CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN; CREATE ROLE service_role NOLOGIN BYPASSRLS;
CREATE SCHEMA extensions; CREATE EXTENSION pg_trgm SCHEMA extensions;
CREATE SCHEMA cron;
CREATE TABLE cron.job (jobid bigint PRIMARY KEY, jobname text, schedule text, command text, active boolean DEFAULT true,
  username text DEFAULT 'postgres', database text DEFAULT current_database());
CREATE FUNCTION cron.schedule(p_jobname text, p_schedule text, p_command text) RETURNS bigint LANGUAGE sql AS $$
  INSERT INTO cron.job (jobid, jobname, schedule, command) VALUES (1, p_jobname, p_schedule, p_command) RETURNING jobid $$;
CREATE FUNCTION cron.alter_job(job_id bigint, schedule text DEFAULT NULL, command text DEFAULT NULL,
  database text DEFAULT NULL, username text DEFAULT NULL, active boolean DEFAULT NULL) RETURNS void LANGUAGE sql AS $$
  UPDATE cron.job j SET schedule = COALESCE(alter_job.schedule, j.schedule), command = COALESCE(alter_job.command, j.command),
         active = COALESCE(alter_job.active, j.active) WHERE j.jobid = alter_job.job_id $$;
CREATE TABLE public.radar_ingest_state (
  mes_referencia text PRIMARY KEY CHECK (mes_referencia ~ '^[0-9]{4}-[0-9]{2}$'),
  status text NOT NULL DEFAULT 'running' CHECK (status = ANY (ARRAY['running','complete','error'])),
  total_recebido integer NOT NULL DEFAULT 0, novos integer, iniciado_em timestamptz NOT NULL DEFAULT now(),
  finalizado_em timestamptz, erro text, avisado_em timestamptz, situacao_aplicada_fechamento timestamptz,
  situacao_aplicada_em timestamptz, situacao_resultado jsonb);
CREATE TABLE public.profiles (id uuid DEFAULT gen_random_uuid(), document text);
CREATE TABLE public.omie_clientes_nao_vinculados (codigo text, cnpj_cpf text);
CREATE TABLE public.acoes_execucoes (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), acao text NOT NULL, origem text NOT NULL,
  iniciado_em timestamptz NOT NULL DEFAULT now(), finalizado_em timestamptz, status text NOT NULL, detalhes jsonb);
CREATE SCHEMA auth; CREATE SCHEMA private;
CREATE TABLE public.radar_agregado_estado (id int PRIMARY KEY);
CREATE TABLE public.radar_score_estado (id int PRIMARY KEY);
SQL
P -q -f "$DDL"
ok "K0 DDL de prod: 24 índices em radar_empresas" \
   "$(Pq -c "SELECT count(*) = 24 FROM pg_indexes WHERE tablename = 'radar_empresas';")" "índices ≠ 24"
python3 -I - "$MIG_RECRUZAR" > "$TMPD/recruzar.sql" <<'PY'
import sys
s = open(sys.argv[1], encoding="utf-8").read()
print(s[s.index("CREATE OR REPLACE FUNCTION public.radar_recruzar_ja_cliente()"):s.index("REVOKE ALL ON FUNCTION public.radar_recruzar_ja_cliente()")])
PY
P -q -f "$TMPD/recruzar.sql"
P -q -f "$MIG_BASE" >/dev/null
P -q -f "$MIG" >/dev/null

echo "=== dados: foto 2026-10 com $N_FOTO + saíram do dump (escala de prod) ==="
T0=$(date +%s)
P -q -v n="$N_FOTO" <<'SQL'
INSERT INTO public.radar_ingest_state (mes_referencia, status, total_recebido, iniciado_em, finalizado_em) VALUES
  ('2026-05', 'complete', 526176, '2026-06-12', '2026-06-12'), ('2026-08', 'complete', 501380, '2026-10-19', '2026-10-19'),
  ('2026-09', 'complete', 502779, '2026-10-21', '2026-10-21'), ('2026-10', 'complete', :n, '2026-10-27', '2026-10-27');
-- Cadastro com a largura de prod (razão/fantasia/município alimentam o GIN trigram; sócios o GIN de array).
INSERT INTO public.radar_empresas (cnpj, razao_social, nome_fantasia, cnae_principal, cnae_descricao, cnaes_secundarios,
  data_abertura, porte, capital_social, logradouro, numero, complemento, bairro, municipio_codigo, municipio_nome, uf, cep,
  telefone1, telefone2, email, socios_nomes, ultimo_lote, primeira_vista_em, prospeccao_status, score)
SELECT lpad(g::text, 12, '0') || lpad((g % 97)::text, 2, '0'),
       'EMPRESA ' || upper(substr(md5(g::text), 1, 10)) || ' COMERCIO DE TINTAS LTDA',
       CASE WHEN g % 3 = 0 THEN NULL ELSE 'FANTASIA ' || substr(md5((g * 7)::text), 1, 8) END,
       (ARRAY['4744001','4744005','4741500','4679699','2071100'])[1 + g % 5], 'Comércio varejista de tintas',
       ARRAY(SELECT (4700000 + ((g * k) % 9000))::text FROM generate_series(1, 1 + g % 5) k),
       date '1990-01-01' + (g % 12000), (ARRAY['ME','EPP','DEMAIS'])[1 + g % 3], (g % 500) * 1000,
       'RUA ' || substr(md5((g * 3)::text), 1, 12), (g % 2000)::text, CASE WHEN g % 4 = 0 THEN 'SALA 2' END,
       'BAIRRO ' || (g % 300), lpad((g % 5570)::text, 4, '0'), 'MUNICIPIO ' || (g % 5570), (ARRAY['SC','PR','RS','SP','MG'])[1 + g % 5],
       lpad((g % 99999999)::text, 8, '0'),
       CASE WHEN g % 5 <> 0 THEN '47' || lpad((g % 99999999)::text, 8, '0') END,
       CASE WHEN g % 7 = 0 THEN '11' || lpad((g % 99999999)::text, 8, '0') END,
       CASE WHEN g % 2 = 0 THEN 'contato' || g || '@exemplo.com.br' END,
       'SOCIO ' || substr(md5((g * 11)::text), 1, 6) || '; SOCIA ' || substr(md5((g * 13)::text), 1, 6),
       CASE WHEN g <= :n THEN '2026-10' WHEN g <= :n + 50251 THEN '2026-05' WHEN g <= :n + 60636 THEN '2026-08' ELSE '2026-09' END,
       '2026-06-12', CASE WHEN g % 50 = 0 THEN 'em_conversa' ELSE 'a_contatar' END, (g % 100)::smallint
  FROM generate_series(1, :n + 69092) g;
SQL
echo "dados em $(( $(date +%s) - T0 ))s"

echo "=== staging 2026-11 (mês novo) ==="
T0=$(date +%s)
P -q -v n="$N_FOTO" <<'SQL'
INSERT INTO public.radar_ingest_state (mes_referencia, status, iniciado_em, carga_fase, carga_iniciada_em)
VALUES ('2026-11', 'running', now(), 'recebendo', now());
-- Ficam: a foto toda menos ~2% (saem); 5% com telefone novo. Voltam: 2.000 de 2026-05. Novas: 10.000.
INSERT INTO public.radar_empresas_carga (lote, cnpj, razao_social, nome_fantasia, cnae_principal, cnae_descricao,
  cnaes_secundarios, data_abertura, porte, capital_social, logradouro, numero, complemento, bairro, municipio_codigo,
  municipio_nome, uf, cep, telefone1, telefone2, email, socios_nomes)
SELECT '2026-11', e.cnpj, e.razao_social, e.nome_fantasia, e.cnae_principal, e.cnae_descricao, e.cnaes_secundarios,
       e.data_abertura, e.porte, e.capital_social, e.logradouro, e.numero, e.complemento, e.bairro, e.municipio_codigo,
       e.municipio_nome, e.uf, e.cep,
       CASE WHEN right(e.cnpj, 4)::int % 20 = 0 THEN '4899' || right(e.cnpj, 6) ELSE e.telefone1 END,
       e.telefone2, e.email, e.socios_nomes
  FROM public.radar_empresas e
 WHERE (e.ultimo_lote = '2026-10' AND left(e.cnpj, 12)::bigint % 51 <> 0)
    OR (e.ultimo_lote = '2026-05' AND left(e.cnpj, 12)::bigint <= :n + 2000);
INSERT INTO public.radar_empresas_carga (lote, cnpj, razao_social, cnae_principal, cnaes_secundarios, uf, municipio_codigo,
  municipio_nome, telefone1)
SELECT '2026-11', lpad((9000000 + g)::text, 12, '0') || '00', 'NOVA ' || g || ' TINTAS LTDA', '4744001', '{4789099}', 'SC',
       '8105', 'JOINVILLE', '47' || lpad(g::text, 8, '0')
  FROM generate_series(1, 10000) g;
UPDATE public.radar_ingest_state SET carga_fase = 'validada', carga_esperado = (SELECT count(*) FROM public.radar_empresas_carga),
       carga_validada_em = now() WHERE mes_referencia = '2026-11';
VACUUM ANALYZE public.radar_empresas;
VACUUM ANALYZE public.radar_empresas_carga;
CHECKPOINT;
-- Amostras: idade da transação do CALL, espera do vendedor, foto vigente (cada amostra comitada à parte).
CREATE TABLE public._amostra_xact (t timestamptz, idade_s numeric, xid text, xact_start timestamptz, etapa text);
CREATE TABLE public._amostra_vendedor (t timestamptz, espera_s numeric, erro text);
CREATE TABLE public._amostra_foto (t timestamptz, n bigint);
CREATE PROCEDURE public._amostrar_xact() LANGUAGE plpgsql AS $$
BEGIN
  LOOP
    PERFORM pg_stat_clear_snapshot();
    INSERT INTO public._amostra_xact
    SELECT clock_timestamp(), extract(epoch FROM clock_timestamp() - a.xact_start), a.backend_xid::text, a.xact_start,
           (SELECT CASE WHEN s.carga_publicacao_iniciada_em IS NULL THEN 'reivindicar' WHEN s.carga_varrida_em IS NULL THEN 'lote'
                        WHEN s.carga_recruzada_em IS NULL THEN 'recruzar' ELSE 'virar' END
              FROM public.radar_ingest_state s WHERE s.mes_referencia = '2026-11')
      FROM pg_stat_activity a WHERE a.query LIKE 'CALL public.radar_carga_publicar(%' AND a.xact_start IS NOT NULL;
    COMMIT;
    EXIT WHEN EXISTS (SELECT 1 FROM public.radar_ingest_state WHERE mes_referencia = '2026-11' AND carga_fase <> 'validada');
    PERFORM pg_sleep(0.1);
  END LOOP;
END $$;
CREATE PROCEDURE public._vendedor() LANGUAGE plpgsql AS $$
DECLARE t0 timestamptz; v_cnpj text; v_i int := 0;
BEGIN
  LOOP
    v_i := v_i + 1;
    -- Uma linha da foto por vez, espalhada pelo espaço de CNPJ (o passo anda em ordem de CNPJ).
    v_cnpj := lpad((1 + (v_i * 7919) % 500000)::text, 12, '0') || lpad(((1 + (v_i * 7919) % 500000) % 97)::text, 2, '0');
    t0 := clock_timestamp();
    BEGIN
      PERFORM set_config('lock_timeout', '8s', true);
      UPDATE public.radar_empresas SET prospeccao_atualizado_em = clock_timestamp() WHERE cnpj = v_cnpj;
      INSERT INTO public._amostra_vendedor VALUES (clock_timestamp(), extract(epoch FROM clock_timestamp() - t0), NULL);
    EXCEPTION WHEN OTHERS THEN
      INSERT INTO public._amostra_vendedor VALUES (clock_timestamp(), extract(epoch FROM clock_timestamp() - t0), SQLSTATE);
    END;
    COMMIT;
    EXIT WHEN EXISTS (SELECT 1 FROM public.radar_ingest_state WHERE mes_referencia = '2026-11' AND carga_fase <> 'validada');
    PERFORM pg_sleep(0.05);
  END LOOP;
END $$;
CREATE PROCEDURE public._amostrar_foto() LANGUAGE plpgsql AS $$
BEGIN
  LOOP
    INSERT INTO public._amostra_foto
    SELECT clock_timestamp(), count(*) FROM public.radar_lista_foto_contagem();
    COMMIT;
    EXIT WHEN EXISTS (SELECT 1 FROM public.radar_ingest_state WHERE mes_referencia = '2026-11' AND carga_fase <> 'validada');
    PERFORM pg_sleep(2);
  END LOOP;
END $$;
-- O predicado dos leitores (o mesmo de radar_lista), lido num snapshot só.
CREATE FUNCTION public.radar_lista_foto_contagem() RETURNS SETOF text LANGUAGE sql STABLE AS $$
  SELECT e.cnpj FROM public.radar_empresas e
   WHERE e.ultimo_lote = ANY (ARRAY['2026-10', public.radar_lote_publicando()])
     AND (e.ultimo_lote = '2026-10' OR e.lote_anterior = '2026-10') $$;
SQL
ESPERADO="$(Pq -c "SELECT carga_esperado FROM public.radar_ingest_state WHERE mes_referencia = '2026-11';")"
FOTO_A="$(Pq -c "SELECT count(*) FROM public.radar_empresas WHERE ultimo_lote = '2026-10';")"
echo "staging em $(( $(date +%s) - T0 ))s: esperado=$ESPERADO foto_A=$FOTO_A"
TAM0="$(Pq -c "SELECT pg_total_relation_size('public.radar_empresas');")"
LSN0="$(Pq -c "SELECT pg_current_wal_lsn();")"

echo "=== publicação (CALL real, com vendedor e amostradores em paralelo) ==="
P -q -c "CALL public._amostrar_xact();" > "$TMPD/amx.log" 2>&1 &
PID_X=$!
P -q -c "CALL public._vendedor();" > "$TMPD/vend.log" 2>&1 &
PID_V=$!
P -q -c "CALL public._amostrar_foto();" > "$TMPD/foto.log" 2>&1 &
PID_F=$!
T0=$(date +%s)
ticks=0
while [ "$(Pq -c "SELECT carga_fase FROM public.radar_ingest_state WHERE mes_referencia = '2026-11';")" = "validada" ]; do
  ticks=$((ticks + 1))
  [ "$ticks" -le 20 ] || { echo "FAIL K1 publicação não terminou em 20 ticks"; FAIL=$((FAIL+1)); break; }
  P -q -c "CALL public.radar_carga_publicar();"
done
DUR=$(( $(date +%s) - T0 ))
wait "$PID_X" "$PID_V" "$PID_F" || true

ok "K1 publicação terminou: publicada, foto 2026-11 = esperado ($ESPERADO)" \
   "$(Pq -c "SELECT carga_fase = 'publicada' AND (SELECT count(*) FROM public.radar_empresas WHERE ultimo_lote = '2026-11') = $ESPERADO FROM public.radar_ingest_state WHERE mes_referencia = '2026-11';")" \
   "$(Pq -c "SELECT carga_fase||' '||coalesce(carga_erro,'') FROM public.radar_ingest_state WHERE mes_referencia = '2026-11';")"
N_X="$(Pq -c "SELECT count(*) FROM public._amostra_xact;")"
# Com xid: do xact_start (≥ o momento em que o xid nasceu) até a última amostra que viu o MESMO xid — teto do
# tempo em que o Realtime (ShareLock sobre o xid) e as linhas travadas esperam.
MAX_XID="$(Pq -c "SELECT coalesce(round(max(d), 2), -1) FROM (SELECT max(t) - min(xact_start) AS dd, extract(epoch FROM max(t) - min(xact_start)) AS d FROM public._amostra_xact WHERE xid IS NOT NULL GROUP BY xid) x;")"
ok "K2 maior transação COM xid (lock de linha / Realtime) ≤ ${MAX_XID}s (< ${TETO_XACT_S}s; $N_X amostras)" \
   "$(Pq -c "SELECT count(*) > 20 AND coalesce((SELECT max(extract(epoch FROM t2 - s2)) FROM (SELECT max(t) t2, min(xact_start) s2 FROM public._amostra_xact WHERE xid IS NOT NULL GROUP BY xid) y), 0) < $TETO_XACT_S FROM public._amostra_xact;")" "amostras=$N_X max_xid=$MAX_XID"
echo "maior transação (inclui leitura sem xid), por etapa:"
Pq -c "SELECT 'xid mais longos: '||string_agg(round(d, 2)::text, ' ' ORDER BY d DESC)||' | xids > 1,5 s: '||(SELECT count(*) FROM (SELECT max(t) - min(xact_start) dd FROM public._amostra_xact WHERE xid IS NOT NULL GROUP BY xid) z WHERE extract(epoch FROM dd) > 1.5)||' de '||(SELECT count(DISTINCT xid) FROM public._amostra_xact WHERE xid IS NOT NULL) FROM (SELECT extract(epoch FROM max(t) - min(xact_start)) d FROM public._amostra_xact WHERE xid IS NOT NULL GROUP BY xid ORDER BY 1 DESC LIMIT 5) w;"
Pq -c "SELECT etapa||': '||round(max(idade_s), 2)||'s ('||count(*)||' amostras; com xid: '||coalesce(round(max(idade_s) FILTER (WHERE xid IS NOT NULL), 2)::text, '-')||'s)' FROM public._amostra_xact GROUP BY etapa ORDER BY 1;"
VEND="$(Pq -c "SELECT count(*)||' updates, p50='||round(percentile_cont(0.5) WITHIN GROUP (ORDER BY espera_s)::numeric, 3)||'s p99='||round(percentile_cont(0.99) WITHIN GROUP (ORDER BY espera_s)::numeric, 3)||'s max='||round(max(espera_s), 3)||'s erros='||count(erro) FROM public._amostra_vendedor;")"
ok "K3 vendedor concorrente: $VEND (max < ${TETO_VENDEDOR_S}s, zero erro)" \
   "$(Pq -c "SELECT count(*) > 20 AND max(espera_s) < $TETO_VENDEDOR_S AND count(erro) = 0 FROM public._amostra_vendedor;")" "$VEND"
# Só as amostras ANTES da virada (as de depois leem a foto 2026-10 já trocada, como devem); ≥ 1 DEPOIS de reivindicar.
ANTES="WHERE t < (SELECT carga_publicada_em FROM public.radar_ingest_state WHERE mes_referencia = '2026-11')"
MEIO="AND t > (SELECT carga_publicacao_iniciada_em FROM public.radar_ingest_state WHERE mes_referencia = '2026-11')"
FOTOS="$(Pq -c "SELECT count(*)||' amostras antes da virada ('||count(*) FILTER (WHERE true $MEIO)||' no meio), min='||coalesce(min(n),-1)||' max='||coalesce(max(n),-1) FROM public._amostra_foto $ANTES;")"
ok "K4 foto vigente intacta durante a publicação: $FOTOS (= $FOTO_A)" \
   "$(Pq -c "SELECT count(*) FILTER (WHERE true $MEIO) >= 1 AND min(n) = $FOTO_A AND max(n) = $FOTO_A FROM public._amostra_foto $ANTES;")" "$FOTOS"

echo "--- números para o histórico ---"
Pq -c "SELECT 'marcos: validada='||to_char(carga_validada_em,'HH24:MI:SS.MS')||' reivindicada='||to_char(carga_publicacao_iniciada_em,'HH24:MI:SS.MS')||' publicada='||to_char(carga_publicada_em,'HH24:MI:SS.MS') FROM public.radar_ingest_state WHERE mes_referencia = '2026-11';"
Pq -c "SELECT 'foto '||to_char(t,'HH24:MI:SS.MS')||' = '||n FROM public._amostra_foto ORDER BY t;"
echo "N_FOTO=$N_FOTO esperado=$ESPERADO duração=${DUR}s ticks=$ticks"
Pq -c "SELECT 'gravadas='||carga_gravadas||' examinadas='||carga_examinadas||' novos='||novos FROM public.radar_ingest_state WHERE mes_referencia = '2026-11';"
Pq -c "SELECT 'WAL='||pg_size_pretty(pg_wal_lsn_diff(pg_current_wal_lsn(), '$LSN0')::bigint)||' tabela+índices: '||pg_size_pretty($TAM0::bigint)||' → '||pg_size_pretty(pg_total_relation_size('public.radar_empresas'));"
echo "PASS=$PASS FAIL=$FAIL"
[ "$FAIL" -eq 0 ] && echo "RADAR_PUBLICACAO_CURTA_CUSTO_OK"
[ "$FAIL" -eq 0 ]
