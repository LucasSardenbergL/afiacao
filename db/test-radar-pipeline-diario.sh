#!/usr/bin/env bash
# Prova PG17 da migration 20261105150000_radar_pipeline_diario_sem_releitura (Mini, 2026-11-05): o pipeline
# diário do Radar (recruzar 06:15 + score 06:30) deixa de reler radar_empresas quando nada mudou. Parte do
# corpo VIVO de prod (fixture lida via psql-ro em 2026-11-05), aplica a migration REAL duas vezes e assevera:
#   A0  a fixture É o corpo de prod (md5 do prosrc de score e tick)
#   A1  EQUIVALÊNCIA: o 1º cálculo do score novo dá o MESMO (score, motivos, versão) da predecessora
#   B1  sem mudança → recalculou=false e 0 seq scans de radar_empresas na rodada
#   B2  muda → recalcula: (a) linha com updated_at novo, (b) já-cliente sem bump de updated_at,
#       (c) lote novo, (d) último cálculo com 7 dias
#   B3  rodada com linha pulada pela guarda de versão NÃO grava o estado (a próxima recalcula)
#   B4  a rodada pulada REGISTRA em acoes_execucoes (sucesso, automatica, lote_vigente)
#   C1  tick: denominadores pelo índice parcial (antes + marcados = total), sem candidatos_antes
#   D1  radar_score_estado com RLS e fechado: authenticated recebe 42501
#   D2  ACL das 2 funções preservado (service_role sim; PUBLIC/anon/authenticated não)
#   E1  os 2 contadores do gate descem pelos índices novos (EXPLAIN), nunca Seq Scan
#   F1  PRE: corpo vivo divergente ABORTA a migration e deixa o vivo intacto
#
#   bash db/test-radar-pipeline-diario.sh > /tmp/t.log 2>&1; echo "exit=$?"
#   SABOTAGEM=<nome> bash db/test-radar-pipeline-diario.sh   # tem de ficar VERMELHA
#   bash db/test-radar-pipeline-diario.sh --falsificar        # controle verde + cada sabotagem vermelha no assert dela
#   LOCALE_TESTE=pt_BR.UTF-8 bash db/test-radar-pipeline-diario.sh
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MIG="$REPO_ROOT/supabase/migrations/20261105150000_radar_pipeline_diario_sem_releitura.sql"
PRED="$REPO_ROOT/db/fixtures/radar-pipeline-predecessoras-prod-20261105.sql"

if [ "${1:-}" = "--falsificar" ]; then
  SABOTAGENS="sem_gate:B1a,B1b gate_cego_upd:B2a gate_cego_jc:B2b gate_cego_lote:B2c sem_validade:B2d grava_com_pulados:B3 pulada_sem_registro:B4a,B4b tick_denominador_errado:C1a estado_aberto:D1 escritor_aberto:D2 semente_cega:S2 semente_aceita_pulada:S3"
  LOGDIR="$(mktemp -d "${TMPDIR:-/tmp}/falsifica-radar-pipeline.XXXXXX")"
  echo "══ CONTROLE ══"
  if ! SABOTAGEM="" bash "$0" > "$LOGDIR/controle.log" 2>&1; then
    echo "❌ controle VERMELHO — falsificação abortada (log: $LOGDIR/controle.log)"; tail -15 "$LOGDIR/controle.log"; exit 1
  fi
  grep -q "RADAR_PIPELINE_PROVA_OK" "$LOGDIR/controle.log" || { echo "❌ controle sem marcador de fim"; exit 1; }
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
PORT="${PGPORT_TEST:-5583}"
DATA="$(mktemp -d "${TMPDIR:-/tmp}/pgtest-radar-pipeline.XXXXXX")/data"
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
# Sabotagem no CORPO muda o prosrc → a PÓS P1 e a PRE do 2º apply pegariam antes da suíte. Para provar
# que o assert da suíte tem dente sozinho: P1 vira NOTICE e o 2º apply não roda.
CORPO=0
cegar_md5() { CORPO=1; sabotar "    RAISE EXCEPTION 'P1 FALHOU" "    RAISE NOTICE 'P1 FALHOU"; }
case "${SABOTAGEM:-}" in
  "") ;;
  sem_gate)            cegar_md5; sabotar "     AND v_est.calculado_em > v_ini - c_validade THEN" "     AND false THEN" ;;
  gate_cego_upd)       cegar_md5; sabotar "     AND v_est.max_updated_at IS NOT DISTINCT FROM v_fp_upd
" "" ;;
  gate_cego_jc)        cegar_md5; sabotar "     AND v_est.ja_cliente_n IS NOT DISTINCT FROM v_fp_jc
" "" ;;
  gate_cego_lote)      cegar_md5; sabotar "     AND v_est.lote IS NOT DISTINCT FROM v_vigente
     AND v_est.lote_iniciado_em IS NOT DISTINCT FROM v_vigente_inicio
" "" ;;
  sem_validade)        cegar_md5; sabotar "     AND v_est.calculado_em > v_ini - c_validade THEN" "     THEN" ;;
  grava_com_pulados)   cegar_md5; sabotar "  IF (v_resumo->>'pulados')::bigint = 0 THEN" "  IF true THEN" ;;
  pulada_sem_registro) cegar_md5; sabotar "    -- O registro diário continua (data_health e radar_avisar_lote leem lote_vigente da última rodada).
    BEGIN" "    BEGIN
      RETURN v_resumo;" ;;
  tick_denominador_errado) cegar_md5; sabotar "  SELECT count(*) INTO v_ja_cliente_antes FROM public.radar_empresas WHERE ja_cliente;" "  SELECT count(*) INTO v_ja_cliente_antes FROM public.radar_empresas WHERE NOT ja_cliente;" ;;
  estado_aberto)       sabotar "REVOKE ALL ON TABLE public.radar_score_estado FROM PUBLIC, anon, authenticated;" "GRANT SELECT ON TABLE public.radar_score_estado TO authenticated;"
                       sabotar "    RAISE EXCEPTION 'P2 FALHOU: radar_score_estado legível" "    RAISE NOTICE 'P2 FALHOU: radar_score_estado legível" ;;
  escritor_aberto)     sabotar "-- PÓS" "GRANT EXECUTE ON FUNCTION public.radar_score_recalcular() TO authenticated;
-- PÓS"
                       sabotar "      RAISE EXCEPTION 'P4 FALHOU" "      RAISE NOTICE 'P4 FALHOU" ;;
  semente_cega)        sabotar "     AND v_upd < r_ini THEN" "     THEN" ;;
  semente_aceita_pulada) sabotar "     AND (r_det->>'pulados') = '0'
" "" ;;
  *) echo "sabotagem desconhecida: $SABOTAGEM"; exit 2 ;;
esac
[ -n "${SABOTAGEM:-}" ] && echo "SABOTAGEM ATIVA: $SABOTAGEM"

"$PGBIN/initdb" -D "$DATA" -U postgres -E UTF8 --locale="$LOCALE_TESTE" >/dev/null
"$PGBIN/pg_ctl" -D "$DATA" -o "-p $PORT -k /tmp" -l "$(dirname "$DATA")/pg.log" -w start >/dev/null
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
CREATE TABLE public.profiles (id bigserial PRIMARY KEY, document text);
CREATE TABLE public.omie_clientes_nao_vinculados (id bigserial PRIMARY KEY, cnpj_cpf text);
CREATE TABLE public.radar_empresas (
  cnpj text PRIMARY KEY, cnae_principal text NOT NULL, cnaes_secundarios text[], porte text, capital_social numeric,
  data_abertura date, municipio_codigo text, uf text, telefone1 text, telefone2 text, email text,
  ja_cliente boolean NOT NULL DEFAULT false, ultimo_lote text NOT NULL, primeira_vista_em timestamptz NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  score smallint, score_motivos text[], score_versao text, score_em timestamptz);
ALTER TABLE public.radar_empresas ENABLE ROW LEVEL SECURITY;

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
REVOKE ALL ON FUNCTION public.radar_recruzar_ja_cliente_tick() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.radar_recruzar_ja_cliente() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.radar_score_recalcular() TO service_role;
GRANT EXECUTE ON FUNCTION public.radar_recruzar_ja_cliente_tick() TO service_role;
VACUUM ANALYZE public.radar_empresas;
SQL

PASS=0; FAIL=0
eq() { if [ "$2" = "$3" ]; then echo "PASS $1"; PASS=$((PASS+1)); else echo "FAIL $1 — obtido [$2] esperado [$3]"; FAIL=$((FAIL+1)); fi; }
foto() { Pq -c "SELECT md5(string_agg(cnpj||'|'||coalesce(score::text,'∅')||'|'||coalesce(array_to_string(score_motivos,';'),'∅')||'|'||coalesce(score_versao,'∅'), ',' ORDER BY cnpj)) FROM public.radar_empresas"; }
# Uma rodada do score numa transação: imprime recalculou e os seq scans de radar_empresas DELA.
rodada() { Pq <<'SQL' | tr '\n' ' ' | sed 's/ $//'
BEGIN;
SELECT public.radar_score_recalcular()->>'recalculou';
SELECT seq_scan FROM pg_stat_xact_user_tables WHERE relname = 'radar_empresas';
COMMIT;
SQL
}

eq "A0 a fixture é o corpo vivo de prod (md5 de score e tick)" \
  "$(Pq -c "SELECT md5(prosrc) FROM pg_proc WHERE oid IN (to_regprocedure('public.radar_score_recalcular()'), to_regprocedure('public.radar_recruzar_ja_cliente_tick()')) ORDER BY proname")" \
  "$(printf '01f19eac2a57ce2dfaf6a677b73a6a0d\nc31dfcacae0898868b6c120556043c88')"

# Predecessora: cálculo de referência, depois o score volta a NULL para o novo recalcular do zero.
Pq -c "SELECT public.radar_score_recalcular()" >/dev/null
FOTO_PRED="$(foto)"
eq "A0b a predecessora pontuou empresas" "$(Pq -c "SELECT count(score) > 1000 FROM public.radar_empresas")" "t"
Pq -c "UPDATE public.radar_empresas SET score = NULL, score_motivos = NULL, score_versao = NULL, score_em = NULL" >/dev/null
# O reset acima é escrita SEM bump de updated_at (artefato do teste): o log da predecessora sai, senão a semente
# da migration tomaria a rodada dela como cálculo consistente (é o que S1 prova de propósito, mais abaixo).
Pq -c "DELETE FROM public.acoes_execucoes" >/dev/null

# F1 antes do apply real: corpo vivo divergente aborta na PRE e o vivo fica intacto.
Pq -c "ALTER FUNCTION public.radar_score_recalcular() RENAME TO radar_score_recalcular_orig" >/dev/null
Pq -c "CREATE FUNCTION public.radar_score_recalcular() RETURNS jsonb LANGUAGE sql AS \$\$ SELECT '{}'::jsonb \$\$" >/dev/null
if P -q -f "$MIG_USADA" > "$(dirname "$DATA")/f1.log" 2>&1; then F1="aplicou"; else F1="$(grep -o 'PRE FALHOU' "$(dirname "$DATA")/f1.log" | sed -n 1p)"; fi
eq "F1a corpo divergente → PRE aborta" "$F1" "PRE FALHOU"
eq "F1b o vivo divergente ficou intacto" "$(Pq -c "SELECT prosrc FROM pg_proc WHERE oid = to_regprocedure('public.radar_score_recalcular()')")" " SELECT '{}'::jsonb "
eq "F1c nada do arquivo ficou (sem estado)" "$(Pq -c "SELECT to_regclass('public.radar_score_estado') IS NULL")" "t"
Pq -c "DROP FUNCTION public.radar_score_recalcular()" >/dev/null
Pq -c "ALTER FUNCTION public.radar_score_recalcular_orig() RENAME TO radar_score_recalcular" >/dev/null

# Apply real, 2× (idempotência) — o 2º só quando o corpo é o do arquivo.
P -q -f "$MIG_USADA"
[ "$CORPO" = 0 ] && P -q -f "$MIG_USADA"
Pq -c "ANALYZE public.radar_empresas" >/dev/null

eq "A1a 1º cálculo do score novo recalcula" "$(rodada | cut -d' ' -f1)" "true"
eq "A1b EQUIVALÊNCIA: score/motivos/versão = predecessora" "$(foto)" "$FOTO_PRED"

N_REG0="$(Pq -c "SELECT count(*) FROM public.acoes_execucoes WHERE acao='radar.score_recalcular'")"
R="$(rodada)"
eq "B1a sem mudança → não recalcula" "$(echo "$R" | cut -d' ' -f1)" "false"
eq "B1b sem mudança → 0 seq scans de radar_empresas" "$(echo "$R" | cut -d' ' -f2)" "0"

ULT="$(Pq -c "SELECT detalhes::text FROM public.acoes_execucoes WHERE acao='radar.score_recalcular' ORDER BY id DESC LIMIT 1")"
eq "B4a rodada pulada acrescenta 1 registro sucesso/automatica" "$(Pq -c "SELECT count(*) - $N_REG0 || '/' || (SELECT status||'/'||origem FROM public.acoes_execucoes WHERE acao='radar.score_recalcular' ORDER BY id DESC LIMIT 1) FROM public.acoes_execucoes WHERE acao='radar.score_recalcular'")" "1/sucesso/automatica"
eq "B4b o registro da pulada traz lote_vigente e recalculou=false" "$(Pq -c "SELECT (d->>'lote_vigente')||'/'||(d->>'recalculou') FROM (SELECT '$ULT'::jsonb d) x")" "2026-10/false"

# B2a: linha muda com updated_at novo (ingestão/recruzamento bumpam) → recalcula e a linha reflete.
ALVO="$(Pq -c "SELECT cnpj FROM public.radar_empresas WHERE NOT ja_cliente AND ultimo_lote='2026-10' AND telefone1 IS NULL AND telefone2 IS NULL ORDER BY cnpj LIMIT 1")"
Pq -c "UPDATE public.radar_empresas SET telefone1 = '3133334444', updated_at = now() WHERE cnpj = '$ALVO'" >/dev/null
eq "B2a updated_at novo → recalcula" "$(rodada | cut -d' ' -f1)" "true"
eq "B2a' a linha mudada ganhou 'telefone disponível'" "$(Pq -c "SELECT 'telefone disponível' = ANY (score_motivos) FROM public.radar_empresas WHERE cnpj = '$ALVO'")" "t"
eq "B2a'' depois dela, nada mudou → não recalcula" "$(rodada | cut -d' ' -f1)" "false"

# B2b: já-cliente marcado SEM bump de updated_at (o nº de já-clientes é a 2ª testemunha).
Pq -c "UPDATE public.radar_empresas SET ja_cliente = true WHERE cnpj = (SELECT cnpj FROM public.radar_empresas WHERE NOT ja_cliente AND cnpj <> '$ALVO' ORDER BY cnpj DESC LIMIT 1)" >/dev/null
eq "B2b já-cliente novo sem updated_at → recalcula" "$(rodada | cut -d' ' -f1)" "true"

# B2c: lote novo completo → recalcula.
Pq -c "INSERT INTO public.radar_ingest_state VALUES ('2026-11','complete','2026-11-05 03:00+00')" >/dev/null
eq "B2c lote novo → recalcula" "$(rodada | cut -d' ' -f1)" "true"
eq "B2c' e o estado guarda o lote novo" "$(Pq -c "SELECT lote FROM public.radar_score_estado")" "2026-11"

# B2d: último cálculo completo com 7 dias → recalcula mesmo sem mudança.
Pq -c "UPDATE public.radar_score_estado SET calculado_em = now() - interval '7 days 1 minute'" >/dev/null
eq "B2d último cálculo com 7 dias → recalcula" "$(rodada | cut -d' ' -f1)" "true"

# B3: linha pulada pela guarda de versão (simulada por trigger que cancela 1 UPDATE de score) → estado apagado.
P -q <<SQL
CREATE FUNCTION public._t_pula() RETURNS trigger LANGUAGE plpgsql AS \$\$ BEGIN RETURN NULL; END \$\$;
CREATE TRIGGER _t_pula BEFORE UPDATE OF score ON public.radar_empresas FOR EACH ROW
  WHEN (new.cnpj = '$ALVO' AND new.score IS DISTINCT FROM old.score) EXECUTE FUNCTION public._t_pula();
UPDATE public.radar_empresas SET ultimo_lote = '2026-11', updated_at = now() WHERE cnpj = '$ALVO';
SQL
B3R="$(Pq -c "SELECT public.radar_score_recalcular()::text")"
eq "B3a a rodada teve 1 pulado" "$(Pq -c "SELECT '$B3R'::jsonb->>'pulados'")" "1"
eq "B3 rodada com pulados NÃO grava o estado" "$(Pq -c "SELECT count(*) FROM public.radar_score_estado")" "0"
Pq -c "DROP TRIGGER _t_pula ON public.radar_empresas" >/dev/null

# C1: tick — denominadores pelo índice parcial.
NOVO="$(Pq -c "SELECT cnpj FROM public.radar_empresas WHERE NOT ja_cliente ORDER BY cnpj LIMIT 1 OFFSET 5")"
Pq -c "INSERT INTO public.profiles (document) VALUES ('${NOVO:0:2}.${NOVO:2:3}.${NOVO:5:3}/${NOVO:8:4}-${NOVO:12:2}')" >/dev/null
JC0="$(Pq -c "SELECT count(*) FROM public.radar_empresas WHERE ja_cliente")"
eq "C1 tick marca o documento novo" "$(Pq -c "SELECT public.radar_recruzar_ja_cliente_tick()")" "1"
DT="$(Pq -c "SELECT detalhes::text FROM public.acoes_execucoes WHERE acao='radar.recruzar_ja_cliente' ORDER BY id DESC LIMIT 1")"
eq "C1a ja_cliente_antes = já-clientes antes" "$(Pq -c "SELECT d->>'ja_cliente_antes' FROM (SELECT '$DT'::jsonb d) x")" "$JC0"
eq "C1b antes + marcados = total" "$(Pq -c "SELECT ((d->>'ja_cliente_antes')::int + (d->>'marcados')::int = (d->>'ja_cliente_total')::int) FROM (SELECT '$DT'::jsonb d) x")" "t"
eq "C1c sem candidatos_antes (era o seq scan)" "$(Pq -c "SELECT '$DT'::jsonb ? 'candidatos_antes'")" "f"

# S: semente do estado no apply (só com o corpo do arquivo — o re-apply passa pela PRE).
if [ "$CORPO" = 0 ]; then
  Pq -c "DELETE FROM public.radar_score_estado" >/dev/null
  eq "S0 sem estado → rodada completa" "$(rodada | cut -d' ' -f1)" "true"
  Pq -c "DELETE FROM public.radar_score_estado" >/dev/null
  P -q -f "$MIG_USADA" 2>/dev/null
  eq "S1a semente = a última rodada limpa" "$(Pq -c "SELECT calculado_em = (SELECT max(iniciado_em) FROM public.acoes_execucoes WHERE acao='radar.score_recalcular') FROM public.radar_score_estado")" "t"
  eq "S1b depois da semente, a rodada pula" "$(rodada | cut -d' ' -f1)" "false"
  Pq -c "DELETE FROM public.radar_score_estado" >/dev/null
  eq "S2' rodada completa (a última passa a ser limpa)" "$(rodada | cut -d' ' -f1)" "true"
  Pq -c "DELETE FROM public.radar_score_estado" >/dev/null
  Pq -c "SELECT pg_sleep(0.01); UPDATE public.radar_empresas SET updated_at = clock_timestamp() WHERE cnpj = '$ALVO'" >/dev/null
  P -q -f "$MIG_USADA" 2>/dev/null
  eq "S2 escrita depois da última rodada → sem semente" "$(Pq -c "SELECT count(*) FROM public.radar_score_estado")" "0"
  eq "S3' rodada completa" "$(rodada | cut -d' ' -f1)" "true"
  eq "S3'' rodada pulada" "$(rodada | cut -d' ' -f1)" "false"
  Pq -c "DELETE FROM public.radar_score_estado" >/dev/null
  P -q -f "$MIG_USADA" 2>/dev/null
  eq "S3 última rodada foi pulada (sem 'pulados') → sem semente" "$(Pq -c "SELECT count(*) FROM public.radar_score_estado")" "0"
fi

# D1/D2: fronteira.
# SQLSTATE por marcador ASCII (a mensagem muda com o locale); outro erro propaga e o marcador não sai.
D1="$(P -qAt 2>&1 <<'SQL' || true
SET ROLE authenticated;
DO $d1$ BEGIN
  PERFORM count(*) FROM public.radar_score_estado;
  RAISE NOTICE 'D1_LEU';
EXCEPTION WHEN insufficient_privilege THEN
  RAISE NOTICE 'D1_NEGADO_42501';
END $d1$;
SQL
)"
eq "D1 authenticated não lê radar_score_estado (42501)" "$(echo "$D1" | grep -o 'D1_[A-Z0-9_]*' | head -1)" "D1_NEGADO_42501"
eq "D2 ACL: service_role executa; anon/authenticated/PUBLIC não" \
  "$(Pq -c "SELECT string_agg(f||':'||has_function_privilege('service_role',f,'EXECUTE')||has_function_privilege('anon',f,'EXECUTE')||has_function_privilege('authenticated',f,'EXECUTE'), ' ' ORDER BY f) FROM unnest(ARRAY['public.radar_recruzar_ja_cliente_tick()','public.radar_score_recalcular()']) f")" \
  "public.radar_recruzar_ja_cliente_tick():truefalsefalse public.radar_score_recalcular():truefalsefalse"

# E1: os contadores do gate descem pelos índices novos.
Pq -c "VACUUM ANALYZE public.radar_empresas" >/dev/null
E1a="$(Pq -c "EXPLAIN SELECT count(*) FROM public.radar_empresas WHERE ja_cliente")"
E1b="$(Pq -c "EXPLAIN SELECT max(updated_at) FROM public.radar_empresas")"
eq "E1a count de já-clientes pelo índice parcial" "$(echo "$E1a" | grep -c 'idx_radar_empresas_ja_cliente')/$(echo "$E1a" | grep -c 'Seq Scan')" "1/0"
eq "E1b max(updated_at) pelo índice" "$(echo "$E1b" | grep -c 'idx_radar_empresas_updated_at')/$(echo "$E1b" | grep -c 'Seq Scan')" "1/0"

echo "──"
echo "PASS=$PASS FAIL=$FAIL"
[ "$FAIL" -eq 0 ] || exit 1
echo "RADAR_PIPELINE_PROVA_OK"
