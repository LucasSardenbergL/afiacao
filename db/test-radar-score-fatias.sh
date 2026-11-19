#!/usr/bin/env bash
# Prova PG17 da migration 20261120140000_radar_score_em_fatias (incidente 2026-11-17..19: o score do Radar
# estourou o statement_timeout de 120 s 3 dias seguidos ao regravar ~514k linhas do lote 2026-11). Parte do
# corpo VIVO de prod (fixture lida via psql-ro em 2026-11-19), aplica a migration REAL duas vezes e assevera:
#   A0  a fixture É o corpo de prod (md5 do prosrc)
#   A1  EQUIVALÊNCIA numa chamada só: (score, motivos, versão) = predecessora; completa e grava a marca
#   A2  EQUIVALÊNCIA em fatias (5 páginas, orçamento 0): mesma foto, avaliados = nº de linhas (sem dupla
#       contagem) e a passada termina em ≤ páginas/5 + 1 chamadas (o cursor anda)
#   A3  chamada PARCIAL: parcial=true, lote_em_calculo, SEM lote_vigente, cursor gravado, marca intocada
#   B4  "nada mudou" registra no máximo 1× em 20 h
#   B6  escrita no meio da passada → a marca leva a impressão do INÍCIO e a rodada seguinte recalcula
#   B7  lote novo no meio da passada → a passada recomeça do zero com o lote novo
#   B8  publicação em andamento → adiado, passada intocada
#   B9  outra rodada com a trava → adiado (não espera)
#   B3  passada com pulado (guarda de versão) NÃO grava a marca
#   B10 linha travada por outro escritor → a chamada encerra em `trava` com as faixas anteriores gravadas
#   G1  linha com score_em ≥ início da passada não é recalculada nem contada (o filtro anti-dupla-contagem)
#   C1  os 2 jobs: horário, comando com SET statement_timeout e dono postgres
#   D1  radar_score_passada com RLS e fechada: authenticated recebe 42501 · D2 ACL da função preservado
#   E1  a faixa desce por Tid Range Scan (auto_explain dentro da função)
#   F1  PRE: corpo vivo divergente ABORTA a migration e deixa o vivo intacto
#
#   bash db/test-radar-score-fatias.sh > /tmp/t.log 2>&1; echo "exit=$?"
#   SABOTAGEM=<nome> bash db/test-radar-score-fatias.sh   # tem de ficar VERMELHA
#   bash db/test-radar-score-fatias.sh --falsificar        # controle verde + cada sabotagem vermelha no assert dela
#   LOCALE_TESTE=pt_BR.UTF-8 bash db/test-radar-score-fatias.sh
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MIG="$REPO_ROOT/supabase/migrations/20261120140000_radar_score_em_fatias.sql"
PRED="$REPO_ROOT/db/fixtures/radar-score-predecessora-prod-20261119.sql"

if [ "${1:-}" = "--falsificar" ]; then
  SABOTAGENS="sem_filtro_passada:G1a,G1b carimba_parcial:A3b sem_orcamento:A3a marca_impressao_fim:B6 sem_cursor:A2c passada_nao_reinicia:B7a noop_sem_throttle:B4a grava_com_pulados:B3 trava_espera:B9 sem_tratar_trava:B10a passada_aberta:D1"
  LOGDIR="$(mktemp -d "${TMPDIR:-/tmp}/falsifica-radar-score-fatias.XXXXXX")"
  echo "══ CONTROLE ══"
  if ! SABOTAGEM="" bash "$0" > "$LOGDIR/controle.log" 2>&1; then
    echo "❌ controle VERMELHO — falsificação abortada (log: $LOGDIR/controle.log)"; tail -15 "$LOGDIR/controle.log"; exit 1
  fi
  grep -q "RADAR_SCORE_FATIAS_PROVA_OK" "$LOGDIR/controle.log" || { echo "❌ controle sem marcador de fim"; exit 1; }
  echo "✅ controle verde ($(grep -c '^PASS ' "$LOGDIR/controle.log") PASS)"
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
    faltou=""
    for id in ${verm//,/ }; do
      grep -q "^FAIL $id " "$log" || faltou="$faltou $id"
    done
    if [ -z "$faltou" ]; then
      SAB_V=$((SAB_V+1)); echo "✅ $s → {$verm} vermelho"
    else
      SAB_F=$((SAB_F+1)); echo "❌ $s: declarado {$verm}, faltou:$faltou (log: $log)"
    fi
  done
  echo "SABOTAGENS: $SAB_V vermelhas / $SAB_F falhas"   # recibo exigido por db/roda-nucleo-ci.sh
  [ "$SAB_F" -eq 0 ] && exit 0 || exit 1
fi

# shellcheck disable=SC1091  # caminho resolvido em runtime a partir de REPO_ROOT
. "$REPO_ROOT/db/lib/pg-harness.sh"
PORT="${PGPORT_TEST:-5584}"
DATA="$(mktemp -d "${TMPDIR:-/tmp}/pgtest-radar-score-fatias.XXXXXX")/data"
LOCALE_TESTE="${LOCALE_TESTE:-C}"
export LC_ALL="$LOCALE_TESTE" LANG="$LOCALE_TESTE"
MIG_USADA="$(dirname "$DATA")/mig.sql"
PGLOG="$(dirname "$DATA")/pg.log"
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
# Sabotagem no CORPO muda o prosrc → a PÓS P1 e a PRE do 2º apply pegariam antes da suíte. Para provar
# que o assert da suíte tem dente sozinho: P1 vira NOTICE e o 2º apply não roda.
CORPO=0
cegar_md5() { CORPO=1; sabotar "    RAISE EXCEPTION 'P1 FALHOU: radar_score_recalcular vivo" "    RAISE NOTICE 'P1 FALHOU: radar_score_recalcular vivo"; }
case "${SABOTAGEM:-}" in
  "") ;;
  sem_filtro_passada)   cegar_md5; sabotar "          AND (e.score_em IS NULL OR e.score_em < v_pas.iniciada_em)" "" ;;
  carimba_parcial)      cegar_md5; sabotar "             'lote_em_calculo', v_vigente," "             'lote_vigente', v_vigente," ;;
  sem_orcamento)        cegar_md5; sabotar "    IF v_fatias > 0 AND clock_timestamp() - v_ini > c_orcamento THEN" "    IF false THEN" ;;
  marca_impressao_fim)  cegar_md5; sabotar "      VALUES (1, v_pas.lote, v_pas.lote_iniciado_em, v_pas.versao_formula, v_pas.max_updated_at, v_pas.ja_cliente_n,
              v_pas.iniciada_em)" "      VALUES (1, v_pas.lote, v_pas.lote_iniciado_em, v_pas.versao_formula, v_fp_upd, v_fp_jc,
              v_pas.iniciada_em)" ;;
  sem_cursor)           cegar_md5; sabotar "  v_pag := v_pas.proxima_pagina;" "  v_pag := 0;" ;;
  passada_nao_reinicia) cegar_md5; sabotar "     AND (v_pas.lote IS DISTINCT FROM v_vigente" "     AND (false" ;;
  noop_sem_throttle)    cegar_md5; sabotar "    IF NOT EXISTS (SELECT 1 FROM public.acoes_execucoes e" "    IF true OR NOT EXISTS (SELECT 1 FROM public.acoes_execucoes e" ;;
  grava_com_pulados)    cegar_md5; sabotar "    IF t_a_alterar - t_alterados = 0 THEN" "    IF true THEN" ;;
  trava_espera)         cegar_md5; sabotar "  IF NOT pg_try_advisory_xact_lock(20261105, 1) THEN" "  PERFORM pg_advisory_xact_lock(20261105, 1);
  IF false THEN" ;;
  sem_tratar_trava)     cegar_md5; sabotar "    EXCEPTION WHEN lock_not_available OR deadlock_detected THEN" "    EXCEPTION WHEN division_by_zero THEN" ;;
  passada_aberta)       sabotar "REVOKE ALL ON TABLE public.radar_score_passada FROM PUBLIC, anon, authenticated;" "GRANT SELECT ON TABLE public.radar_score_passada TO authenticated;"
                        sabotar "    RAISE EXCEPTION 'P2 FALHOU: radar_score_passada legível" "    RAISE NOTICE 'P2 FALHOU: radar_score_passada legível" ;;
  *) echo "sabotagem desconhecida: $SABOTAGEM"; exit 2 ;;
esac
[ -n "${SABOTAGEM:-}" ] && echo "SABOTAGEM ATIVA: $SABOTAGEM"

"$PGBIN/initdb" -D "$DATA" -U postgres -E UTF8 --locale="$LOCALE_TESTE" >/dev/null
"$PGBIN/pg_ctl" -D "$DATA" -o "-p $PORT -k /tmp" -l "$PGLOG" -w start >/dev/null
PD() { local db="$1"; shift; "$PGBIN/psql" -X -v ON_ERROR_STOP=1 -p "$PORT" -h /tmp -U postgres -d "$db" "$@"; }
P()  { PD base "$@"; }
Pq() { P -qAt "$@"; }
PD postgres -qc "CREATE DATABASE base"

P -q <<'SQL'
CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN; CREATE ROLE service_role NOLOGIN;
-- Como o Supabase: o que o postgres cria em public nasce com GRANT a anon/authenticated/service_role.
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON FUNCTIONS TO anon, authenticated, service_role;
GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;
CREATE TABLE public.radar_ingest_state (mes_referencia text PRIMARY KEY, status text NOT NULL, iniciado_em timestamptz);
CREATE TABLE public.acoes_execucoes (id bigserial PRIMARY KEY, acao text NOT NULL, origem text, iniciado_em timestamptz,
  finalizado_em timestamptz, status text, detalhes jsonb);
CREATE INDEX ON public.acoes_execucoes (acao, iniciado_em DESC);
CREATE TABLE public.radar_empresas (
  cnpj text PRIMARY KEY, cnae_principal text NOT NULL, cnaes_secundarios text[], porte text, capital_social numeric,
  data_abertura date, municipio_codigo text, uf text, telefone1 text, telefone2 text, email text,
  ja_cliente boolean NOT NULL DEFAULT false, ultimo_lote text NOT NULL, primeira_vista_em timestamptz NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  score smallint, score_motivos text[], score_versao text, score_em timestamptz);
ALTER TABLE public.radar_empresas ENABLE ROW LEVEL SECURITY;
-- Como a prod: score indexado (UPDATE do score é não-HOT e move a linha) e os 2 índices do gate.
CREATE INDEX idx_radar_lista_score ON public.radar_empresas (score DESC NULLS LAST, cnpj) WHERE NOT ja_cliente;
CREATE INDEX idx_radar_empresas_ja_cliente ON public.radar_empresas (municipio_codigo, uf) WHERE ja_cliente;
CREATE INDEX idx_radar_empresas_updated_at ON public.radar_empresas (updated_at);
-- Estado do gate: DDL da 20261105150000 (vivo em prod).
CREATE TABLE public.radar_score_estado (
  id smallint PRIMARY KEY DEFAULT 1 CHECK (id = 1), lote text, lote_iniciado_em timestamptz, versao_formula text,
  max_updated_at timestamptz, ja_cliente_n bigint, calculado_em timestamptz NOT NULL);
ALTER TABLE public.radar_score_estado ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.radar_score_estado FROM PUBLIC, anon, authenticated;
-- radar_lote_publicando(): stub controlado pela prova.
CREATE TABLE public._t_publicando (lote text);
CREATE FUNCTION public.radar_lote_publicando() RETURNS text LANGUAGE sql STABLE AS $$ SELECT max(lote) FROM public._t_publicando $$;
-- pg_cron mínimo (alter_job/schedule com a assinatura do 1.6).
CREATE SCHEMA cron;
CREATE TABLE cron.job (jobid bigserial PRIMARY KEY, jobname text UNIQUE, schedule text NOT NULL, command text NOT NULL,
  active boolean NOT NULL DEFAULT true, username text NOT NULL DEFAULT current_user, database text NOT NULL DEFAULT current_database());
CREATE FUNCTION cron.schedule(job_name text, schedule text, command text) RETURNS bigint LANGUAGE sql AS $$
  INSERT INTO cron.job (jobname, schedule, command) VALUES (job_name, schedule, command)
  ON CONFLICT (jobname) DO UPDATE SET schedule = EXCLUDED.schedule, command = EXCLUDED.command RETURNING jobid $$;
CREATE FUNCTION cron.alter_job(job_id bigint, schedule text DEFAULT NULL, command text DEFAULT NULL, database text DEFAULT NULL,
  username text DEFAULT NULL, active boolean DEFAULT NULL) RETURNS void LANGUAGE sql AS $$
  UPDATE cron.job SET schedule = COALESCE(alter_job.schedule, job.schedule), command = COALESCE(alter_job.command, job.command),
         active = COALESCE(alter_job.active, job.active) WHERE jobid = job_id $$;
SELECT FROM cron.schedule('radar-score-recalcular-diario', '30 6 * * *', 'SELECT public.radar_score_recalcular();');

INSERT INTO public.radar_ingest_state VALUES
  ('2026-08','complete','2026-08-19 16:31+00'), ('2026-10','complete','2026-10-27 16:20+00');
-- 4.000 empresas determinísticas cobrindo cada fator do score; ~2% já-clientes espalhados nos municípios.
INSERT INTO public.radar_empresas (cnpj, cnae_principal, cnaes_secundarios, porte, capital_social, data_abertura,
  municipio_codigo, uf, telefone1, telefone2, email, ja_cliente, ultimo_lote, primeira_vista_em, updated_at)
SELECT lpad(i::text, 14, '0'),
       (ARRAY['3101200','1622699','2542000','4744001'])[1 + (h % 4)],
       CASE WHEN h % 3 = 0 THEN ARRAY['3101200','9999999'] WHEN h % 3 = 1 THEN ARRAY['8888888'] END,
       (ARRAY['01','03','05',NULL])[1 + (h / 4) % 4],
       (ARRAY[5000,20000,70000,200000,700000,2000000,NULL]::numeric[])[1 + (h / 16) % 7],
       date '2026-10-01' - ((h % 6000) || ' days')::interval,
       CASE WHEN h % 97 = 0 THEN NULL ELSE 'M'||lpad((1 + (h / 7) % 12)::text, 2, '0') END,
       CASE WHEN h % 89 = 0 THEN NULL ELSE (ARRAY['MG','SP','SC','RJ'])[1 + ((1 + (h / 7) % 12) % 4)] END,
       CASE WHEN h % 3 = 0 THEN '31'||lpad((h % 100000000)::text, 8, '0') END,
       CASE WHEN h % 11 = 0 THEN '11'||lpad((h % 100000000)::text, 8, '0') END,
       CASE WHEN h % 5 = 0 THEN 'x'||i||'@ex.com' END,
       (h % 50 = 0),
       CASE WHEN h % 13 = 0 THEN '2026-08' ELSE '2026-10' END,
       CASE WHEN h % 4 = 0 THEN timestamptz '2026-10-28 00:00+00' ELSE timestamptz '2026-08-20 00:00+00' END,
       timestamptz '2026-10-27 17:00+00' + (i || ' seconds')::interval
  FROM (SELECT i, abs(hashtext('re' || i)) AS h FROM generate_series(1, 4000) i) s;
SQL

P -q -f "$PRED"
P -q <<'SQL'
REVOKE ALL ON FUNCTION public.radar_score_recalcular() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.radar_score_recalcular() TO service_role;
VACUUM ANALYZE public.radar_empresas;
SQL

PASS=0; FAIL=0
eq() { if [ "$2" = "$3" ]; then echo "PASS $1"; PASS=$((PASS+1)); else echo "FAIL $1 — obtido [$2] esperado [$3]"; FAIL=$((FAIL+1)); fi; }
foto() { Pq -c "SELECT md5(string_agg(cnpj||'|'||coalesce(score::text,'∅')||'|'||coalesce(array_to_string(score_motivos,';'),'∅')||'|'||coalesce(score_versao,'∅'), ',' ORDER BY cnpj)) FROM public.radar_empresas"; }
# Uma chamada com faixa ($1 páginas) e orçamento ($2); vazio = padrão da função.
R() {
  local sets=""
  [ -n "${1:-}" ] && sets="$sets SET radar.score_paginas_fatia = '$1';"
  [ -n "${2:-}" ] && sets="$sets SET radar.score_orcamento = '$2';"
  Pq -c "$sets SELECT public.radar_score_recalcular()::text"
}
J() { Pq -c "SELECT (\$j\$$1\$j\$::jsonb) #>> '{$2}'"; }          # campo (caminho) do json
TEM() { Pq -c "SELECT (\$j\$$1\$j\$::jsonb) ? '$2'"; }
# Chama até a passada completar (json com lote_vigente); imprime "K|json" ou "K|NAO_COMPLETOU".
ate_completar() {
  local k=0 j
  while [ "$k" -lt "$3" ]; do
    k=$((k+1)); j="$(R "$1" "$2")"
    if [ "$(TEM "$j" lote_vigente)" = "t" ]; then echo "$k|$j"; return; fi
  done
  echo "$k|NAO_COMPLETOU"
}
reset_score() {
  Pq -c "UPDATE public.radar_empresas SET score = NULL, score_motivos = NULL, score_versao = NULL, score_em = NULL" >/dev/null
  Pq -c "VACUUM public.radar_empresas" >/dev/null
}
N_TOTAL=4000

eq "A0 a fixture é o corpo vivo de prod (md5)" \
  "$(Pq -c "SELECT md5(prosrc) FROM pg_proc WHERE oid = to_regprocedure('public.radar_score_recalcular()')")" \
  "49c21fef6ab031b2ffe0d0367f86560e"

# Predecessora: cálculo de referência; depois o score volta a NULL (sem bump de updated_at) e o log sai.
Pq -c "SELECT public.radar_score_recalcular()" >/dev/null
FOTO_PRED="$(foto)"
eq "A0b a predecessora pontuou empresas" "$(Pq -c "SELECT count(score) > 1000 FROM public.radar_empresas")" "t"
reset_score
Pq -c "DELETE FROM public.acoes_execucoes; DELETE FROM public.radar_score_estado;" >/dev/null

# F1 antes do apply real: corpo vivo divergente aborta na PRE e o vivo fica intacto.
Pq -c "ALTER FUNCTION public.radar_score_recalcular() RENAME TO radar_score_recalcular_orig" >/dev/null
Pq -c "CREATE FUNCTION public.radar_score_recalcular() RETURNS jsonb LANGUAGE sql AS \$\$ SELECT '{}'::jsonb \$\$" >/dev/null
if P -q -f "$MIG_USADA" > "$(dirname "$DATA")/f1.log" 2>&1; then F1="aplicou"; else F1="$(grep -o 'PRE FALHOU' "$(dirname "$DATA")/f1.log" | sed -n 1p)"; fi
eq "F1a corpo divergente → PRE aborta" "$F1" "PRE FALHOU"
eq "F1b o vivo divergente ficou intacto" "$(Pq -c "SELECT prosrc FROM pg_proc WHERE oid = to_regprocedure('public.radar_score_recalcular()')")" " SELECT '{}'::jsonb "
eq "F1c nada do arquivo ficou (sem passada, job intocado)" \
  "$(Pq -c "SELECT (to_regclass('public.radar_score_passada') IS NULL)::text || '/' || (SELECT schedule FROM cron.job WHERE jobname = 'radar-score-recalcular-diario')")" "true/30 6 * * *"
Pq -c "DROP FUNCTION public.radar_score_recalcular()" >/dev/null
Pq -c "ALTER FUNCTION public.radar_score_recalcular_orig() RENAME TO radar_score_recalcular" >/dev/null

# Apply real, 2× (idempotência) — o 2º só quando o corpo é o do arquivo.
P -q -f "$MIG_USADA"
[ "$CORPO" = 0 ] && P -q -f "$MIG_USADA"
Pq -c "ANALYZE public.radar_empresas" >/dev/null

# A1: chamada única (padrão: 1.000 páginas, 50 s) — a tabela inteira cabe numa faixa.
J1="$(R)"
eq "A1a chamada única completa" "$(J "$J1" recalculou)/$(TEM "$J1" lote_vigente)/$(TEM "$J1" parcial)" "true/t/f"
eq "A1b EQUIVALÊNCIA: score/motivos/versão = predecessora" "$(foto)" "$FOTO_PRED"
eq "A1c avaliados = linhas, pulados 0, marca gravada" \
  "$(J "$J1" avaliados)/$(J "$J1" pulados)/$(Pq -c "SELECT lote FROM public.radar_score_estado")/$(Pq -c "SELECT count(*) FROM public.radar_score_passada")" \
  "$N_TOTAL/0/2026-10/0"

# A2/A3: em fatias de 5 páginas, 1 faixa por chamada.
reset_score
Pq -c "DELETE FROM public.radar_score_estado" >/dev/null
J3="$(R 5 0)"
eq "A3a 1ª chamada é PARCIAL (orçamento) e grava o cursor" \
  "$(J "$J3" parcial)/$(J "$J3" interrompido)/$(Pq -c "SELECT proxima_pagina||'/'||rodadas FROM public.radar_score_passada")" "true/orcamento/5/1"
eq "A3b parcial: lote_em_calculo, SEM lote_vigente (leitores não veem lote pontuado)" \
  "$(J "$J3" lote_em_calculo)/$(TEM "$J3" lote_vigente)" "2026-10/f"
eq "A3c parcial não grava a marca e registra sucesso/automatica" \
  "$(Pq -c "SELECT count(*) FROM public.radar_score_estado")/$(Pq -c "SELECT status||'/'||origem||'/'||(detalhes->>'parcial') FROM public.acoes_execucoes WHERE acao='radar.score_recalcular' ORDER BY id DESC LIMIT 1")" \
  "0/sucesso/automatica/true"
RA2="$(ate_completar 5 0 600)"; K2="${RA2%%|*}"; JA2="${RA2#*|}"
if [ "$JA2" = "NAO_COMPLETOU" ]; then
  eq "A2c a passada em fatias completa" "NAO_COMPLETOU depois de $K2 chamadas" "completa"
  eq "A2a EQUIVALÊNCIA em fatias" "sem passada completa" "foto"
else
  PAG2="$(J "$JA2" passada,paginas)"; ROD2="$(J "$JA2" passada,rodadas)"
  eq "A2a EQUIVALÊNCIA em fatias: score/motivos/versão = predecessora" "$(foto)" "$FOTO_PRED"
  eq "A2b avaliados = linhas (sem dupla contagem), pulados 0, marca gravada" \
    "$(J "$JA2" avaliados)/$(J "$JA2" pulados)/$(Pq -c "SELECT count(*) FROM public.radar_score_estado")" "$N_TOTAL/0/1"
  eq "A2c o cursor anda: rodadas ≤ páginas/5 + 1 e > 1" \
    "$(Pq -c "SELECT ($ROD2 <= ceil($PAG2 / 5.0) + 1 AND $ROD2 > 1)::text")" "true"
  eq "A2d a marca leva o início da passada" \
    "$(Pq -c "SELECT (calculado_em = '$(J "$JA2" passada,iniciada_em)'::timestamptz)::text FROM public.radar_score_estado")" "true"
fi

# B4: nada mudou → 1 registro por 20 h.
N0="$(Pq -c "SELECT count(*) FROM public.acoes_execucoes WHERE acao='radar.score_recalcular'")"
JB="$(R)"
eq "B4a nada mudou → não recalcula e não registra (já há registro < 20 h)" \
  "$(J "$JB" recalculou)/$(Pq -c "SELECT count(*) - $N0 FROM public.acoes_execucoes WHERE acao='radar.score_recalcular'")" "false/0"
Pq -c "UPDATE public.acoes_execucoes SET iniciado_em = iniciado_em - interval '21 hours' WHERE acao='radar.score_recalcular'" >/dev/null
JB="$(R)"
eq "B4b sem registro há 21 h → registra 1 (sucesso, lote_vigente, recalculou=false)" \
  "$(Pq -c "SELECT count(*) - $N0 FROM public.acoes_execucoes WHERE acao='radar.score_recalcular'")/$(Pq -c "SELECT status||'/'||(detalhes->>'lote_vigente')||'/'||(detalhes->>'recalculou') FROM public.acoes_execucoes WHERE acao='radar.score_recalcular' ORDER BY id DESC LIMIT 1")" \
  "1/sucesso/2026-10/false"

# B6: escrita numa faixa JÁ feita, no meio da passada → a marca leva a impressão do início → recalcula depois.
Pq -c "DELETE FROM public.radar_score_estado" >/dev/null
R 5 0 >/dev/null
ALVO6="$(Pq -c "SELECT cnpj FROM public.radar_empresas WHERE ctid < '(5,0)'::tid AND NOT ja_cliente AND ultimo_lote = '2026-10' AND telefone1 IS NULL AND telefone2 IS NULL ORDER BY cnpj LIMIT 1")"
eq "ALVO6' alvo da prova existe" "$([ -n "$ALVO6" ] && echo sim || echo nao)" "sim"
Pq -c "UPDATE public.radar_empresas SET telefone1 = '3133334444', updated_at = clock_timestamp() WHERE cnpj = '$ALVO6'" >/dev/null
R6="$(ate_completar 5 0 600)"
eq "B6' a passada com escrita no meio completa" "$( [ "${R6#*|}" = NAO_COMPLETOU ] && echo nao || echo sim)" "sim"
J6="$(R)"
eq "B6 marca = impressão do INÍCIO → a rodada seguinte recalcula" "$(J "$J6" recalculou)" "true"
eq "B6b e a linha escrita ganhou 'telefone disponível'" \
  "$(Pq -c "SELECT 'telefone disponível' = ANY (score_motivos) FROM public.radar_empresas WHERE cnpj = '$ALVO6'")" "t"

# B7: lote novo no meio da passada → recomeça do zero com o lote novo.
Pq -c "DELETE FROM public.radar_score_estado" >/dev/null
R 5 0 >/dev/null
INI7="$(Pq -c "SELECT iniciada_em FROM public.radar_score_passada")"
Pq -c "INSERT INTO public.radar_ingest_state VALUES ('2026-11','complete','2026-11-16 18:07+00')" >/dev/null
# Como a publicação: a foto nova troca o rótulo (e bumpa updated_at) das que continuam no dump.
Pq -c "UPDATE public.radar_empresas SET ultimo_lote = '2026-11', updated_at = clock_timestamp() WHERE ultimo_lote = '2026-10'" >/dev/null
J7="$(R 5 0)"
eq "B7a lote novo → passada recomeça (lote novo, rodada 1, cursor na 1ª faixa, início novo)" \
  "$(Pq -c "SELECT lote||'/'||rodadas||'/'||proxima_pagina||'/'||(iniciada_em > '$INI7'::timestamptz) FROM public.radar_score_passada")" "2026-11/1/5/true"

# B8: publicação em andamento → adiado e a passada fica intocada.
P8="$(Pq -c "SELECT proxima_pagina||'/'||rodadas FROM public.radar_score_passada")"
Pq -c "INSERT INTO public._t_publicando VALUES ('2026-12')" >/dev/null
J8="$(R 5 0)"
eq "B8 publicação em andamento → adiado, passada intocada" \
  "$(J "$J8" adiado)/$(Pq -c "SELECT proxima_pagina||'/'||rodadas FROM public.radar_score_passada")" "publicacao_em_andamento/$P8"
Pq -c "DELETE FROM public._t_publicando" >/dev/null

# B9: outra rodada com a trava → adiado, sem esperar.
( P -qAt -c "BEGIN; SELECT pg_advisory_xact_lock(20261105, 1); SELECT pg_sleep(4); COMMIT;" >/dev/null 2>&1 ) &
B9_PID=$!
until [ "$(Pq -c "SELECT count(*) FROM pg_locks WHERE locktype = 'advisory' AND granted AND classid = 20261105 AND objid = 1")" = "1" ]; do sleep 0.1; done
T0=$(date +%s)
J9="$(R 5 0)"
T9=$(( $(date +%s) - T0 ))
eq "B9 trava da rodada ocupada → adiado em < 3 s" "$(J "$J9" adiado)/$([ "$T9" -lt 3 ] && echo rapido || echo esperou)" "outra_rodada_em_andamento/rapido"
wait "$B9_PID" || true

# Completa a passada do lote 2026-11.
R7="$(ate_completar 5 0 600)"
eq "B7b a passada do lote novo completa e a marca é do lote novo" \
  "$( [ "${R7#*|}" = NAO_COMPLETOU ] && echo nao || echo sim)/$(Pq -c "SELECT lote FROM public.radar_score_estado")" "sim/2026-11"

# B3: pulado pela guarda de versão (trigger cancela 1 UPDATE de score) → marca apagada.
ALVO3="$(Pq -c "SELECT cnpj FROM public.radar_empresas WHERE NOT ja_cliente AND ultimo_lote = '2026-11' ORDER BY cnpj LIMIT 1 OFFSET 7")"
eq "ALVO3' alvo da prova existe" "$([ -n "$ALVO3" ] && echo sim || echo nao)" "sim"
P -q <<SQL
CREATE FUNCTION public._t_pula() RETURNS trigger LANGUAGE plpgsql AS \$\$ BEGIN RETURN NULL; END \$\$;
CREATE TRIGGER _t_pula BEFORE UPDATE OF score ON public.radar_empresas FOR EACH ROW
  WHEN (new.cnpj = '$ALVO3' AND new.score IS DISTINCT FROM old.score) EXECUTE FUNCTION public._t_pula();
UPDATE public.radar_empresas SET ultimo_lote = '2026-08', updated_at = clock_timestamp() WHERE cnpj = '$ALVO3';
SQL
J3B="$(R)"
eq "B3a a passada teve 1 pulado" "$(J "$J3B" pulados)" "1"
eq "B3 passada com pulados NÃO grava a marca (e a passada se encerra)" \
  "$(Pq -c "SELECT count(*) FROM public.radar_score_estado")/$(Pq -c "SELECT count(*) FROM public.radar_score_passada")" "0/0"
Pq -c "DROP TRIGGER _t_pula ON public.radar_empresas" >/dev/null

# B10: linha travada por outro escritor → a chamada encerra em `trava`; as faixas anteriores ficam gravadas.
ALVO10="$(Pq -c "SELECT cnpj FROM public.radar_empresas WHERE NOT ja_cliente AND ultimo_lote = '2026-11' AND telefone1 IS NULL AND telefone2 IS NULL ORDER BY cnpj DESC LIMIT 1")"
eq "ALVO10' alvo da prova existe" "$([ -n "$ALVO10" ] && echo sim || echo nao)" "sim"
Pq -c "UPDATE public.radar_empresas SET telefone2 = '1144445555', updated_at = clock_timestamp() WHERE cnpj = '$ALVO10'" >/dev/null
BLK10="$(Pq -c "SELECT (ctid::text::point)[0]::int FROM public.radar_empresas WHERE cnpj = '$ALVO10'")"
( P -qAt -c "BEGIN; SELECT 1 FROM public.radar_empresas WHERE cnpj = '$ALVO10' FOR UPDATE; SELECT pg_sleep(9); COMMIT;" >/dev/null 2>&1 ) &
B10_PID=$!
until [ "$(Pq -c "SELECT count(*) FROM pg_stat_activity WHERE query LIKE '%pg_sleep(9)%' AND state = 'active' AND pid <> pg_backend_pid()")" = "1" ]; do sleep 0.1; done
sleep 0.3
J10="$(P -qAt -c "SET radar.score_paginas_fatia = '5'; SET radar.score_orcamento = '1 hour'; SELECT public.radar_score_recalcular()::text" 2>&1 || true)"
if [ "$(Pq -c "SELECT pg_input_is_valid(\$j\$$J10\$j\$, 'jsonb')")" = "t" ]; then
  eq "B10a linha travada → parcial em 'trava' (não erro)" "$(J "$J10" parcial)/$(J "$J10" interrompido)" "true/trava"
  eq "B10b as faixas antes da linha travada ficaram gravadas (cursor na faixa dela)" \
    "$(Pq -c "SELECT proxima_pagina FROM public.radar_score_passada")" "$(( BLK10 / 5 * 5 ))"
else
  eq "B10a linha travada → parcial em 'trava' (não erro)" "$(echo "$J10" | grep -o 'ERRO.*\|ERROR.*' | head -1 | cut -c1-60)" "json"
fi
wait "$B10_PID" || true
R10="$(ate_completar 5 0 600)"
eq "B10c depois da trava a passada completa" "$( [ "${R10#*|}" = NAO_COMPLETOU ] && echo nao || echo sim)" "sim"

# G1: linha com score_em ≥ início da passada não é recalculada nem contada.
Pq -c "DELETE FROM public.radar_score_estado" >/dev/null
R 5 0 >/dev/null
ALVOG="$(Pq -c "SELECT cnpj FROM public.radar_empresas WHERE ctid >= '(20,0)'::tid AND NOT ja_cliente AND ultimo_lote = '2026-11' AND email IS NULL ORDER BY cnpj LIMIT 1")"
eq "ALVOG' alvo da prova existe" "$([ -n "$ALVOG" ] && echo sim || echo nao)" "sim"
Pq -c "UPDATE public.radar_empresas SET email = 'g1@ex.com', score_em = timestamptz '2100-01-01', updated_at = clock_timestamp() WHERE cnpj = '$ALVOG'" >/dev/null
RG="$(ate_completar 5 0 600)"; JG="${RG#*|}"
eq "G1a linha já pontuada na passada não é recalculada" \
  "$(Pq -c "SELECT coalesce('e-mail disponível' = ANY (score_motivos), false) FROM public.radar_empresas WHERE cnpj = '$ALVOG'")" "f"
eq "G1b e não entra na contagem (avaliados = linhas − 1)" "$(J "$JG" avaliados)" "$(( N_TOTAL - 1 ))"
Pq -c "UPDATE public.radar_empresas SET score_em = NULL WHERE cnpj = '$ALVOG'" >/dev/null

# C1: jobs.
eq "C1 jobs: horário, comando novo, ativos, dono postgres" \
  "$(Pq -c "SELECT string_agg(jobname||'|'||schedule||'|'||command||'|'||active||'|'||username, ' ; ' ORDER BY jobname) FROM cron.job WHERE jobname LIKE 'radar-score-%'")" \
  "radar-score-recalcular-continua|*/5 7-8 * * *|SET statement_timeout = '3min'; SELECT public.radar_score_recalcular();|true|postgres ; radar-score-recalcular-diario|30,35,40,45,50,55 6 * * *|SET statement_timeout = '3min'; SELECT public.radar_score_recalcular();|true|postgres"

# D1/D2: fronteira. SQLSTATE por marcador ASCII (a mensagem muda com o locale); outro erro propaga.
D1="$(P -qAt 2>&1 <<'SQL' || true
SET ROLE authenticated;
DO $d1$ BEGIN
  PERFORM count(*) FROM public.radar_score_passada;
  RAISE NOTICE 'D1_LEU';
EXCEPTION WHEN insufficient_privilege THEN
  RAISE NOTICE 'D1_NEGADO_42501';
END $d1$;
SQL
)"
eq "D1 authenticated não lê radar_score_passada (42501)" "$(echo "$D1" | grep -o 'D1_[A-Z0-9_]*' | head -1)" "D1_NEGADO_42501"
eq "D2 ACL: service_role executa; anon/authenticated não; lock_timeout=5s no proconfig" \
  "$(Pq -c "SELECT has_function_privilege('service_role','public.radar_score_recalcular()','EXECUTE')::text||has_function_privilege('anon','public.radar_score_recalcular()','EXECUTE')::text||has_function_privilege('authenticated','public.radar_score_recalcular()','EXECUTE')::text||'/'||(proconfig @> ARRAY['lock_timeout=5s'])::text FROM pg_proc WHERE oid = to_regprocedure('public.radar_score_recalcular()')")" \
  "truefalsefalse/true"

# E1: a faixa desce por Tid Range Scan (plano real dentro da função, via auto_explain).
Pq -c "DELETE FROM public.radar_score_estado" >/dev/null
: > "$PGLOG.e1"
P -qAt -c "LOAD 'auto_explain'; SET auto_explain.log_min_duration = 0; SET auto_explain.log_nested_statements = on; SET radar.score_paginas_fatia = '5'; SET radar.score_orcamento = '0'; SELECT public.radar_score_recalcular() IS NOT NULL;" >/dev/null
sleep 0.5
eq "E1 o cálculo da faixa usa Tid Range Scan em radar_empresas" \
  "$( [ "$(grep -c 'Tid Range Scan on radar_empresas' "$PGLOG")" -ge 2 ] && echo sim || echo nao)" "sim"

echo "──"
echo "PASS=$PASS FAIL=$FAIL"
[ "$FAIL" -eq 0 ] || exit 1
echo "RADAR_SCORE_FATIAS_PROVA_OK"
