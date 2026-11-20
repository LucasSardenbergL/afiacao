#!/usr/bin/env bash
# Prova PG17 da migration 20261120170000_radar_situacao_em_fatias (medido em 2026-11-20: o cron
# radar-aplicar-situacao-diario levou 27m43s de 30 min no Mini em 17/11, regravando 573 mil linhas de radar_empresas
# num UPDATE só). Parte dos corpos VIVOS de prod (fixture lida via psql-ro em 2026-11-20), aplica a migration REAL
# duas vezes e assevera:
#   A0  a fixture É o corpo de prod (md5 do prosrc das 3 funções)
#   A1  EQUIVALÊNCIA: a passada em fatias (10 páginas por chamada, orçamento 0) + conclusão dá o MESMO estado que a
#       predecessora numa chamada só — fotos, descartes, contatos, alerta, alertado_em, marca e resultado
#   A2  1ª chamada PARCIAL (cursor = 10, interrompida por orçamento); parcial registra em
#       radar.aplicar_situacao_parcial e a conclusão em radar.aplicar_situacao (1 linha); o cursor anda (≤ N chamadas)
#   A3  chamada parcial não marca radar_ingest_state
#   A4  depois de aplicado, nova chamada é no-op (nada gravado, nenhum registro, sem passada)
#   A5  a conclusão reconcilia a linha que as faixas não cobriram (inserida depois do fim das faixas)
#   B7  lote novo no meio da passada → o velho vira SUPERADO e a passada recomeça do zero com o novo
#   B9  outra rodada com a trava → adiado (não espera)
#   B10 linha travada por outro escritor → `trava`, faixas anteriores gravadas, sem erro
#   B11 linha travada na conclusão → parcial `trava_na_conclusao`, sem marca; depois conclui
#   B13 linha do lote travada em radar_ingest_state (SKIP LOCKED) → a passada dele NÃO é descartada
#   C1  job: horário, comando com SET statement_timeout, ativo, dono postgres
#   D1  radar_situacao_passada com RLS e fechada (authenticated → 42501) · D2 ACL e proconfig da função
#   E1  a faixa desce por Tid Range Scan (auto_explain dentro da função)
#   F1  PRE: corpo vivo divergente da pendente ABORTA · F2 corpo vivo divergente da função de aplicação ABORTA
#
#   bash db/test-radar-situacao-fatias.sh > /tmp/t.log 2>&1; echo "exit=$?"
#   SABOTAGEM=<nome> bash db/test-radar-situacao-fatias.sh   # tem de ficar VERMELHA
#   bash db/test-radar-situacao-fatias.sh --falsificar        # controle verde + cada sabotagem vermelha no assert dela
#   LOCALE_TESTE=pt_BR.UTF-8 bash db/test-radar-situacao-fatias.sh
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MIG="$REPO_ROOT/supabase/migrations/20261120170000_radar_situacao_em_fatias.sql"
PRED="$REPO_ROOT/db/fixtures/radar-situacao-pendente-prod-20261120.sql"

if [ "${1:-}" = "--falsificar" ]; then
  SABOTAGENS="marca_parcial:A3 sem_cursor:A2c sem_orcamento:A2a sem_guarda_lote:A1a sem_distinct:A1a,A1e passada_nao_reinicia:B7b trava_espera:B9 sem_tratar_trava:B10a conclusao_sem_tratar_trava:B11a apaga_passada_travada:B13 parcial_no_ledger:A2b conclusao_sem_funcao:A5 passada_aberta:D1 janela_errada:C1"
  LOGDIR="$(mktemp -d "${TMPDIR:-/tmp}/falsifica-radar-sit-fatias.XXXXXX")"
  total_sab=$(( $(printf '%s\n' "$SABOTAGENS" | wc -w) ))
  sab_de=1; sab_ate=$total_sab
  if [ -n "${NUCLEO_FAIXA:-}" ]; then
    if ! printf '%s' "$NUCLEO_FAIXA" | grep -qE '^[1-9]/[2-9]$' || [ "${NUCLEO_FAIXA%/*}" -gt "${NUCLEO_FAIXA#*/}" ]; then
      echo "❌ NUCLEO_FAIXA inválida: '$NUCLEO_FAIXA' (i/k, 1 ≤ i ≤ k, 2 ≤ k ≤ 9)"; exit 1
    fi
    f_i="${NUCLEO_FAIXA%/*}"; f_k="${NUCLEO_FAIXA#*/}"
    sab_de=$(( (f_i - 1) * total_sab / f_k + 1 )); sab_ate=$(( f_i * total_sab / f_k ))
  fi
  echo "══ CONTROLE ══"
  if ! SABOTAGEM="" bash "$0" > "$LOGDIR/controle.log" 2>&1; then
    echo "❌ controle VERMELHO — falsificação abortada (log: $LOGDIR/controle.log)"; tail -15 "$LOGDIR/controle.log"; exit 1
  fi
  grep -q "RADAR_SITUACAO_FATIAS_PROVA_OK" "$LOGDIR/controle.log" || { echo "❌ controle sem marcador de fim"; exit 1; }
  echo "✅ controle verde ($(grep -c '^PASS ' "$LOGDIR/controle.log") PASS)"
  SAB_V=0; SAB_F=0; i_sab=0
  for par in $SABOTAGENS; do
    i_sab=$((i_sab+1))
    [ "$i_sab" -ge "$sab_de" ] && [ "$i_sab" -le "$sab_ate" ] || continue
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
  [ -z "${NUCLEO_FAIXA:-}" ] || echo "FAIXA: $NUCLEO_FAIXA sabotagens $sab_de-$sab_ate de $total_sab"   # conferida por db/roda-nucleo-ci.sh
  echo "SABOTAGENS: $SAB_V vermelhas / $SAB_F falhas"   # recibo exigido por db/roda-nucleo-ci.sh
  [ "$SAB_F" -eq 0 ] && exit 0 || exit 1
fi

# shellcheck disable=SC1091  # caminho resolvido em runtime a partir de REPO_ROOT
. "$REPO_ROOT/db/lib/pg-harness.sh"
PORT="${PGPORT_TEST:-5586}"
DATA="$(mktemp -d "${TMPDIR:-/tmp}/pgtest-radar-sit-fatias.XXXXXX")/data"
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
# Sabotagem no CORPO muda o prosrc → a PÓS P1 e a PRE do 2º apply pegariam antes da suíte. Para provar que o assert
# da suíte tem dente sozinho: P1 vira NOTICE e o 2º apply não roda (uma camada por vez).
CORPO=0
cegar_md5() { CORPO=1; sabotar "    RAISE EXCEPTION 'P1 FALHOU: radar_aplicar_situacao_pendente vivo não é" "    RAISE NOTICE 'P1 FALHOU: radar_aplicar_situacao_pendente vivo não é"; }
case "${SABOTAGEM:-}" in
  "") ;;
  marca_parcial)        cegar_md5; sabotar "        -- A conclusão fica para a chamada seguinte: esta já gastou o orçamento das faixas.
        CONTINUE;" "        NULL;" ;;
  sem_cursor)           cegar_md5; sabotar "        v_pag := v_pas.proxima_pagina;" "        v_pag := 0;" ;;
  sem_orcamento)        cegar_md5; sabotar "          IF v_fatias > 0
             AND (clock_timestamp()" "          IF false
             AND (clock_timestamp()" ;;
  sem_guarda_lote)      cegar_md5; sabotar "               AND (re.rfb_situacao_lote IS NULL OR re.rfb_situacao_lote <= r.mes_referencia)
" "" ;;
  sem_distinct)         cegar_md5; sabotar "               AND (re.rfb_situacao IS DISTINCT FROM s.situacao
                    OR re.rfb_situacao_data" "               AND (true OR re.rfb_situacao IS DISTINCT FROM s.situacao
                    OR re.rfb_situacao_data" ;;
  passada_nao_reinicia) cegar_md5; sabotar "      IF v_tem_passada
         AND (v_pas.lote IS DISTINCT FROM r.mes_referencia" "      IF false AND v_tem_passada
         AND (v_pas.lote IS DISTINCT FROM r.mes_referencia" ;;
  trava_espera)         cegar_md5; sabotar "  IF NOT pg_try_advisory_xact_lock(20261027, 1) THEN" "  PERFORM pg_advisory_xact_lock(20261027, 1);
  IF false THEN" ;;
  sem_tratar_trava)     cegar_md5; sabotar "          EXCEPTION WHEN lock_not_available OR deadlock_detected THEN
            -- Linha travada" "          EXCEPTION WHEN division_by_zero THEN
            -- Linha travada" ;;
  conclusao_sem_tratar_trava) cegar_md5; sabotar "      EXCEPTION WHEN lock_not_available OR deadlock_detected THEN
        v_parcial := jsonb_build_object(" "      EXCEPTION WHEN division_by_zero THEN
        v_parcial := jsonb_build_object(" ;;
  apaga_passada_travada) cegar_md5; sabotar "       AND NOT EXISTS (SELECT 1 FROM public.radar_ingest_state s" "       AND true OR NOT EXISTS (SELECT 1 FROM public.radar_ingest_state s" ;;
  parcial_no_ledger)    cegar_md5; sabotar "      VALUES ('radar.aplicar_situacao_parcial'," "      VALUES ('radar.aplicar_situacao'," ;;
  conclusao_sem_funcao) cegar_md5; sabotar "        v_res := public.radar_aplicar_situacao(r.mes_referencia, p_agora);" "        v_res := jsonb_build_object('lote', r.mes_referencia, 'fotos_atualizadas', 0);" ;;
  passada_aberta)       sabotar "REVOKE ALL ON TABLE public.radar_situacao_passada FROM PUBLIC, anon, authenticated;" "GRANT SELECT ON TABLE public.radar_situacao_passada TO authenticated;"
                        sabotar "    RAISE EXCEPTION 'P2 FALHOU: radar_situacao_passada legível" "    RAISE NOTICE 'P2 FALHOU: radar_situacao_passada legível" ;;
  janela_errada)        sabotar "'2-59/5 0-5,7-10 * * *'" "'5 6 * * *'" ;;
  *) echo "sabotagem desconhecida: $SABOTAGEM"; exit 2 ;;
esac
[ -n "${SABOTAGEM:-}" ] && echo "SABOTAGEM ATIVA: $SABOTAGEM"

"$PGBIN/initdb" -D "$DATA" -U postgres -E UTF8 --locale="$LOCALE_TESTE" >/dev/null
"$PGBIN/pg_ctl" -D "$DATA" -o "-p $PORT -k /tmp" -l "$PGLOG" -w start >/dev/null
PD() { local db="$1"; shift; "$PGBIN/psql" -X -v ON_ERROR_STOP=1 -p "$PORT" -h /tmp -U postgres -d "$db" "$@"; }
PDq() { local db="$1"; shift; PD "$db" -qAt "$@"; }
PD postgres -qc "CREATE DATABASE base"

PASS=0; FAIL=0
eq() { if [ "$2" = "$3" ]; then echo "PASS $1"; PASS=$((PASS+1)); else echo "FAIL $1 — obtido [$2] esperado [$3]"; FAIL=$((FAIL+1)); fi; }
J() { PDq base -c "SELECT (\$j\$$1\$j\$::jsonb) #>> '{$2}'"; }          # campo (caminho) do json

# ── Esquema mínimo com os CHECKs de prod (colunas que as 2 funções leem/gravam) ─────────────────────────────
PD base -q <<'SQL'
CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN; CREATE ROLE service_role NOLOGIN;
-- Como o Supabase: o que o postgres cria em public nasce com GRANT a anon/authenticated/service_role.
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON FUNCTIONS TO anon, authenticated, service_role;
GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;
CREATE TABLE public.radar_ingest_state (
  mes_referencia text PRIMARY KEY CHECK (mes_referencia ~ '^[0-9]{4}-[0-9]{2}$'),
  status text NOT NULL DEFAULT 'running' CHECK (status = ANY (ARRAY['running','complete','error'])),
  iniciado_em timestamptz NOT NULL DEFAULT now(), finalizado_em timestamptz,
  situacao_aplicada_fechamento timestamptz, situacao_aplicada_em timestamptz, situacao_resultado jsonb);
CREATE TABLE public.acoes_execucoes (id bigserial PRIMARY KEY, acao text NOT NULL,
  origem text CHECK (origem = ANY (ARRAY['manual','automatica'])), iniciado_em timestamptz, finalizado_em timestamptz,
  status text CHECK (status = ANY (ARRAY['executando','sucesso','erro'])), detalhes jsonb);
CREATE TABLE public.radar_empresas (
  cnpj text PRIMARY KEY CHECK (cnpj ~ '^[0-9A-Z]{12}[0-9]{2}$'), razao_social text,
  ja_cliente boolean NOT NULL DEFAULT false,
  prospeccao_status text NOT NULL DEFAULT 'a_contatar'
    CHECK (prospeccao_status = ANY (ARRAY['a_contatar','contatado_sem_resposta','em_conversa','descartado','virou_cliente'])),
  descarte_motivo text, prospeccao_atualizado_em timestamptz,
  rfb_situacao text CHECK (rfb_situacao IS NULL OR rfb_situacao = ANY (ARRAY['01','02','03','04','08'])),
  rfb_situacao_data date, rfb_situacao_lote text,
  updated_at timestamptz NOT NULL DEFAULT now(),
  pad text);   -- ~10 linhas por página: a passada tem dezenas de faixas
ALTER TABLE public.radar_empresas ENABLE ROW LEVEL SECURITY;
-- Como a prod: updated_at indexado (o UPDATE da foto é não-HOT e a versão nova pode mudar de página).
CREATE INDEX idx_radar_empresas_updated_at ON public.radar_empresas (updated_at);
CREATE INDEX idx_radar_lista ON public.radar_empresas (cnpj) WHERE NOT ja_cliente AND prospeccao_status <> 'descartado';
CREATE TABLE public.radar_situacao_cadastral (
  cnpj text NOT NULL CHECK (cnpj ~ '^[0-9A-Z]{12}[0-9]{2}$'), lote text NOT NULL CHECK (lote ~ '^[0-9]{4}-[0-9]{2}$'),
  situacao text NOT NULL CHECK (situacao = ANY (ARRAY['01','02','03','04','08'])), data_situacao date,
  motivo_codigo text, motivo_descricao text, observado_em timestamptz NOT NULL DEFAULT now(), alertado_em timestamptz,
  PRIMARY KEY (cnpj, lote));
CREATE INDEX idx_radar_situacao_lote_sit ON public.radar_situacao_cadastral (lote, situacao);
CREATE INDEX idx_radar_situacao_cnpj_alertado ON public.radar_situacao_cadastral (cnpj, situacao) WHERE alertado_em IS NOT NULL;
CREATE TABLE public.radar_contatos (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), cnpj text NOT NULL CHECK (cnpj ~ '^[0-9A-Z]{12}[0-9]{2}$'),
  acao text NOT NULL CHECK (acao = ANY (ARRAY['contatado_sem_resposta','em_conversa','descartado','virou_cliente','a_contatar'])),
  nota text, criado_por uuid NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), status_anterior text);
CREATE TABLE public.fornecedor_alerta (
  id bigserial PRIMARY KEY, empresa text NOT NULL, tipo text NOT NULL,
  severidade text NOT NULL DEFAULT 'info' CHECK (severidade = ANY (ARRAY['info','atencao','urgente'])),
  titulo text NOT NULL, mensagem text,
  status text CHECK (status = ANY (ARRAY['pendente_notificacao','notificado','falha_notificacao','ignorado'])), metadata jsonb);
-- radar_docs_clientes(): stub controlado pela prova (prod: documentos das fontes de clientes).
CREATE TABLE public._t_docs (doc text, nome text);
CREATE FUNCTION public.radar_docs_clientes() RETURNS TABLE (doc text, nome text)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public', 'pg_temp' AS $$ SELECT doc, nome FROM public._t_docs $$;
-- pg_cron mínimo (alter_job com a assinatura do 1.6).
CREATE SCHEMA cron;
CREATE TABLE cron.job (jobid bigserial PRIMARY KEY, jobname text UNIQUE, schedule text NOT NULL, command text NOT NULL,
  active boolean NOT NULL DEFAULT true, username text NOT NULL DEFAULT current_user, database text NOT NULL DEFAULT current_database());
CREATE FUNCTION cron.alter_job(job_id bigint, schedule text DEFAULT NULL, command text DEFAULT NULL, database text DEFAULT NULL,
  username text DEFAULT NULL, active boolean DEFAULT NULL) RETURNS void LANGUAGE sql AS $$
  UPDATE cron.job SET schedule = COALESCE(alter_job.schedule, job.schedule), command = COALESCE(alter_job.command, job.command),
         active = COALESCE(alter_job.active, job.active) WHERE jobid = job_id $$;
INSERT INTO cron.job (jobname, schedule, command)
VALUES ('radar-aplicar-situacao-diario', '5 6 * * *', 'SET statement_timeout = ''30min''; SELECT public.radar_aplicar_situacao_pendente();');
SQL

# Predecessora: os 3 corpos de prod + a ACL de prod das 2 funções do job (postgres e o sandbox; nunca anon/authenticated).
PD base -q -f "$PRED" >/dev/null
PD base -q <<'SQL'
REVOKE ALL ON FUNCTION public.radar_aplicar_situacao_pendente(timestamptz) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.radar_aplicar_situacao(text, timestamptz) FROM PUBLIC, anon, authenticated;
SQL
eq "A0 a fixture é o corpo de prod (md5 das 3 funções)" \
  "$(PDq base -c "SELECT string_agg(proname||'='||md5(prosrc), ' ' ORDER BY proname) FROM pg_proc WHERE proname IN ('radar_rfb_descricao','radar_aplicar_situacao','radar_aplicar_situacao_pendente')")" \
  "radar_aplicar_situacao=3b99d4ddd83b8b49b1a2965439d56002 radar_aplicar_situacao_pendente=a99fd7dbdd0c8590698546b162f1a68f radar_rfb_descricao=ec7507207ea2717a3aa07d513ae8b9e5"

# ── Dados: 1.200 empresas; lote 2026-10 aplicado, 2026-11 pendente ───────────────────────────────────────
#   i%10=0 fora do lote · i%7 BAIXADA · i%29 INAPTA · i%11 muda só a data · i%13 já tem foto de 2026-12 (não regride)
#   · i%17 sem foto · i%19 já tem a foto 2026-11 (não regrava) · i%21 já-cliente · i%5 em_conversa · i%23 descartado
#   · _t_docs: 3 leads irregulares que são clientes pelo documento + 2 fora do radar · i%42 já alertado em 2026-09.
PD base -q <<'SQL'
INSERT INTO public.radar_empresas (cnpj, razao_social, ja_cliente, prospeccao_status, rfb_situacao, rfb_situacao_data,
                                   rfb_situacao_lote, updated_at, pad)
SELECT lpad(i::text, 12, '0') || '00', 'Empresa ' || i, (i % 21 = 0),
       CASE WHEN i % 23 = 0 THEN 'descartado' WHEN i % 5 = 0 THEN 'em_conversa' ELSE 'a_contatar' END,
       CASE WHEN i % 17 = 0 THEN NULL WHEN i % 13 = 0 THEN '04' ELSE '02' END,
       CASE WHEN i % 17 = 0 THEN NULL WHEN i % 13 = 0 THEN date '2026-11-20' ELSE date '2000-01-01' END,
       CASE WHEN i % 17 = 0 THEN NULL WHEN i % 13 = 0 THEN '2026-12' WHEN i % 19 = 0 THEN '2026-11' ELSE '2026-10' END,
       timestamptz '2026-11-09 12:00+00', repeat('x', 700)
  FROM generate_series(1, 1200) i;
INSERT INTO public.radar_situacao_cadastral (cnpj, lote, situacao, data_situacao)
SELECT lpad(i::text, 12, '0') || '00', '2026-10', '02', date '2000-01-01' FROM generate_series(1, 1200) i;
INSERT INTO public.radar_situacao_cadastral (cnpj, lote, situacao, data_situacao, motivo_codigo, motivo_descricao, alertado_em)
SELECT lpad(i::text, 12, '0') || '00', '2026-09', '08', date '2026-01-01', '01', 'EXTINCAO', timestamptz '2026-10-21 17:10+00'
  FROM generate_series(42, 1200, 42) i;
INSERT INTO public.radar_situacao_cadastral (cnpj, lote, situacao, data_situacao, motivo_codigo, motivo_descricao)
SELECT lpad(i::text, 12, '0') || '00', '2026-11',
       CASE WHEN i % 7 = 0 THEN '08' WHEN i % 29 = 0 THEN '04' ELSE '02' END,
       CASE WHEN i % 7 = 0 THEN date '2026-10-15' WHEN i % 29 = 0 THEN date '2026-09-01'
            WHEN i % 11 = 0 THEN date '2020-05-05' ELSE date '2000-01-01' END,
       CASE WHEN i % 7 = 0 THEN '01' END, CASE WHEN i % 7 = 0 THEN 'EXTINCAO POR ENCERRAMENTO' END
  FROM generate_series(1, 1200) i WHERE i % 10 <> 0
UNION ALL
SELECT lpad(i::text, 12, '0') || '00', '2026-11', '08', date '2026-10-01', '01', 'EXTINCAO'
  FROM generate_series(5001, 5003) i
UNION ALL
-- a linha que entra DEPOIS das faixas (A5): o lote já a traz; radar_empresas a recebe no meio da passada
SELECT '00000000999900', '2026-11', '04', date '2026-08-01', '63', 'OMISSAO DE DECLARACOES';
-- i%19 com a foto 2026-11 já gravada: os valores do lote (onde coincide) — os que não coincidem regravam.
UPDATE public.radar_empresas re SET rfb_situacao = s.situacao, rfb_situacao_data = s.data_situacao
  FROM public.radar_situacao_cadastral s
 WHERE s.cnpj = re.cnpj AND s.lote = '2026-11' AND re.rfb_situacao_lote = '2026-11' AND (substr(re.cnpj, 1, 12)::int % 7) <> 0;
INSERT INTO public._t_docs VALUES ('00000000001400', 'Cliente Doc 14'), ('00000000002800', 'Cliente Doc 28'),
  ('00000000003500', 'Cliente Doc 35'), ('00000000500100', 'Fora do Radar 5001'), ('00000000500200', 'Fora do Radar 5002');
INSERT INTO public.radar_ingest_state (mes_referencia, status, iniciado_em, finalizado_em, situacao_aplicada_fechamento,
                                       situacao_aplicada_em, situacao_resultado)
VALUES ('2026-10', 'complete', '2026-11-09 10:00+00', '2026-11-09 15:01+00', '2026-11-09 15:01+00', '2026-11-10 06:05+00', '{"lote": "2026-10"}'),
       ('2026-11', 'complete', '2026-11-16 10:00+00', '2026-11-16 21:30+00', NULL, NULL, NULL);
VACUUM ANALYZE;
SQL

AGORA="2026-11-17 06:05:00+00"
NOVO="00000000999900"
INSERE_NOVO="INSERT INTO public.radar_empresas (cnpj, razao_social, prospeccao_status, rfb_situacao, rfb_situacao_data, rfb_situacao_lote, updated_at, pad) VALUES ('$NOVO', 'Empresa Nova', 'a_contatar', '02', date '2000-01-01', '2026-10', timestamptz '2026-11-09 12:00+00', repeat('x', 700))"

# Cópia ANTES da migration: a predecessora numa chamada só (a linha nova já existe) e a prova da PRE.
PD postgres -qc "CREATE DATABASE pred TEMPLATE base"
PD postgres -qc "CREATE DATABASE fpre TEMPLATE base"
PDq pred -c "$INSERE_NOVO" >/dev/null
J_PRED="$(PDq pred -c "SELECT public.radar_aplicar_situacao_pendente(timestamptz '$AGORA')::text")"
eq "A1' a predecessora aplicou o lote 2026-11 (sanidade do dado)" \
  "$(J "$J_PRED" aplicados)/$( [ "$(J "$J_PRED" 'lotes,0,fotos_atualizadas')" -gt 900 ] && echo muitas || echo poucas)/$( [ "$(J "$J_PRED" 'lotes,0,leads_descartados')" -gt 10 ] && echo descartou || echo nao)/$( [ "$(J "$J_PRED" 'lotes,0,clientes_alertados_novos')" -gt 3 ] && echo alertou || echo nao)" \
  "1/muitas/descartou/alertou"

# ── Migration (2×: idempotente) ─────────────────────────────────────────────────────────────────────────
PD base -q -f "$MIG_USADA" >/dev/null
if [ "$CORPO" = 0 ]; then PD base -q -f "$MIG_USADA" >/dev/null; fi
PD postgres -qc "CREATE DATABASE nova TEMPLATE base"
PD postgres -qc "CREATE DATABASE nb TEMPLATE base"

# Uma chamada em <db> com faixa ($2 páginas) e orçamento ($3).
T() { PDq "$1" -c "SET radar.situacao_paginas_fatia = '$2'; SET radar.situacao_orcamento = '$3'; SELECT public.radar_aplicar_situacao_pendente(timestamptz '$AGORA')::text"; }
PAGINAS="$(PDq nova -c "SELECT pg_relation_size('public.radar_empresas') / current_setting('block_size')::int")"
LIMITE=$(( PAGINAS / 10 + 3 ))

# ── A: passada inteira em "nova" ─────────────────────────────────────────────────────────────────────────
J1="$(T nova 10 0)"
eq "A2a 1ª chamada parcial por orçamento, cursor = 10 páginas" \
  "$(J "$J1" parcial,parcial)/$(J "$J1" parcial,interrompido)/$(PDq nova -c "SELECT proxima_pagina FROM public.radar_situacao_passada")" "true/orcamento/10"
eq "A3 chamada parcial não marca o lote" \
  "$(PDq nova -c "SELECT coalesce(situacao_aplicada_fechamento::text, 'pendente') FROM public.radar_ingest_state WHERE mes_referencia = '2026-11'")" "pendente"
n=1; JT="$J1"
while [ "$(J "$JT" parcial,interrompido)" != "faixas_concluidas" ] && [ "$(J "$JT" aplicados)" != "1" ] && [ "$n" -lt "$LIMITE" ]; do
  JT="$(T nova 10 0)"; n=$((n+1))
done
eq "A2c o cursor anda: as faixas terminam em ≤ páginas/10 + 1 chamadas" \
  "$( [ "$(J "$JT" parcial,interrompido)" = "faixas_concluidas" ] && [ "$n" -le $(( PAGINAS / 10 + 1 )) ] && echo sim || echo "nao(n=$n,ultimo=$(J "$JT" parcial,interrompido))")" "sim"
# A linha nova entra DEPOIS das faixas (atrás do cursor ou além das páginas do início): só a conclusão a vê.
PDq nova -c "$INSERE_NOVO" >/dev/null
JC="$(T nova 10 0)"; n=$((n+1))
eq "A5 a conclusão aplicou o lote e reconciliou a linha que as faixas não cobriram" \
  "$(J "$JC" aplicados)/$(J "$JC" 'lotes,0,passada,fotos_na_conclusao')/$(PDq nova -c "SELECT rfb_situacao||'|'||rfb_situacao_lote||'|'||prospeccao_status FROM public.radar_empresas WHERE cnpj = '$NOVO'")" \
  "1/1/04|2026-11|descartado"

# A1: estado inteiro, componente por componente (pred = predecessora numa chamada; nova = fatias + conclusão).
empresas() { PDq "$1" -c "SELECT md5(string_agg(concat_ws('|', cnpj, rfb_situacao, rfb_situacao_data, rfb_situacao_lote, updated_at, prospeccao_status, descarte_motivo, prospeccao_atualizado_em), ',' ORDER BY cnpj)) FROM public.radar_empresas"; }
contatos() { PDq "$1" -c "SELECT count(*)||':'||md5(string_agg(concat_ws('|', cnpj, acao, nota, criado_por, status_anterior, created_at), ',' ORDER BY cnpj, acao)) FROM public.radar_contatos"; }
alerta()   { PDq "$1" -c "SELECT count(*)||':'||md5(string_agg(concat_ws('|', id, empresa, tipo, severidade, titulo, mensagem, status, metadata::text), ',' ORDER BY id)) FROM public.fornecedor_alerta"; }
alertado() { PDq "$1" -c "SELECT md5(string_agg(concat_ws('|', cnpj, lote, alertado_em), ',' ORDER BY cnpj, lote)) FROM public.radar_situacao_cadastral"; }
marca()    { PDq "$1" -c "SELECT string_agg(concat_ws('|', mes_referencia, situacao_aplicada_fechamento, situacao_aplicada_em, (situacao_resultado - 'passada')::text), ' ; ' ORDER BY mes_referencia) FROM public.radar_ingest_state"; }
eq "A1a radar_empresas igual à predecessora (foto, rótulo, updated_at, descarte)" "$(empresas nova)" "$(empresas pred)"
eq "A1b radar_contatos igual (descartes por CNPJ)" "$(contatos nova)" "$(contatos pred)"
eq "A1c fornecedor_alerta igual (o aviso do gestor)" "$(alerta nova)" "$(alerta pred)"
eq "A1d alertado_em igual (dedupe)" "$(alertado nova)" "$(alertado pred)"
eq "A1e marca e resultado iguais (fotos_atualizadas = faixas + conclusão)" "$(marca nova)" "$(marca pred)"
eq "A2b ledger: 1 conclusão em radar.aplicar_situacao (= a da predecessora) e $((n-1)) parciais em radar.aplicar_situacao_parcial" \
  "$(PDq nova -c "SELECT (SELECT count(*) FROM public.acoes_execucoes WHERE acao = 'radar.aplicar_situacao')||'/'||(SELECT count(*) FROM public.acoes_execucoes WHERE acao = 'radar.aplicar_situacao_parcial')||'/'||(SELECT (detalhes #- '{lotes,0,passada}')::text FROM public.acoes_execucoes WHERE acao = 'radar.aplicar_situacao' ORDER BY id DESC LIMIT 1)")" \
  "1/$((n-1))/$(PDq pred -c "SELECT detalhes::text FROM public.acoes_execucoes WHERE acao = 'radar.aplicar_situacao'")"
ANTES="$(empresas nova)/$(PDq nova -c "SELECT count(*) FROM public.acoes_execucoes")"
J4="$(T nova 10 0)"
eq "A4 depois de aplicado: no-op (nada gravado, nenhum registro, sem passada)" \
  "$(J "$J4" aplicados)/$(J "$J4" marcados)/$(J "$J4" parcial)/$(empresas nova)/$(PDq nova -c "SELECT count(*) FROM public.acoes_execucoes")/$(PDq nova -c "SELECT count(*) FROM public.radar_situacao_passada")" \
  "0/0//$ANTES/0"

# ── B: concorrência, lote novo e conclusão travada em "nb" ──────────────────────────────────────────────
# E1: a faixa desce por Tid Range Scan (plano real dentro da função, via auto_explain).
: > "$PGLOG"
PDq nb -c "LOAD 'auto_explain'; SET auto_explain.log_min_duration = 0; SET auto_explain.log_nested_statements = on; SET radar.situacao_paginas_fatia = '10'; SET radar.situacao_orcamento = '0'; SELECT public.radar_aplicar_situacao_pendente(timestamptz '$AGORA') IS NOT NULL" >/dev/null
sleep 0.5
eq "E1 a faixa usa Tid Range Scan em radar_empresas" \
  "$( grep -q 'Tid Range Scan on radar_empresas' "$PGLOG" && echo sim || echo nao)" "sim"

# B9: outra rodada com a trava → adiado, sem esperar.
( PDq nb -c "BEGIN; SELECT pg_advisory_xact_lock(20261027, 1); SELECT pg_sleep(4); COMMIT;" >/dev/null 2>&1 ) &
B9_PID=$!
until [ "$(PDq nb -c "SELECT count(*) FROM pg_locks WHERE locktype = 'advisory' AND granted AND classid = 20261027 AND objid = 1")" = "1" ]; do sleep 0.1; done
T0=$(date +%s)
J9="$(PDq nb -c "SET statement_timeout = '3s'; SELECT public.radar_aplicar_situacao_pendente(timestamptz '$AGORA')::text" 2>&1 || true)"
T9=$(( $(date +%s) - T0 ))
eq "B9 trava da rodada ocupada → adiado em < 3 s" \
  "$(PDq nb -c "SELECT CASE WHEN pg_input_is_valid(\$j\$$J9\$j\$, 'jsonb') THEN (\$j\$$J9\$j\$::jsonb)->>'adiado' ELSE 'erro' END")/$([ "$T9" -lt 3 ] && echo rapido || echo esperou)" \
  "outra_rodada_em_andamento/rapido"
wait "$B9_PID" || true

# B10: linha travada na faixa 20–29 → a chamada (orçamento folgado) grava 10–19 e encerra em `trava` na 20.
ALVO10="$(PDq nb -c "SELECT re.cnpj FROM public.radar_empresas re JOIN public.radar_situacao_cadastral s ON s.cnpj = re.cnpj AND s.lote = '2026-11' WHERE (re.ctid::text::point)[0] BETWEEN 20 AND 29 AND re.rfb_situacao_lote = '2026-10' ORDER BY re.cnpj LIMIT 1")"
eq "B10' alvo da prova existe" "$([ -n "$ALVO10" ] && echo sim || echo nao)" "sim"
( PDq nb -c "BEGIN; SELECT 1 FROM public.radar_empresas WHERE cnpj = '$ALVO10' FOR UPDATE; SELECT pg_sleep(9); COMMIT;" >/dev/null 2>&1 ) &
B10_PID=$!
until [ "$(PDq nb -c "SELECT count(*) FROM pg_stat_activity WHERE query LIKE '%pg_sleep(9)%' AND state = 'active' AND pid <> pg_backend_pid()")" = "1" ]; do sleep 0.1; done
sleep 0.3
J10="$(PDq nb -c "SET radar.situacao_paginas_fatia = '10'; SET radar.situacao_orcamento = '1 hour'; SELECT public.radar_aplicar_situacao_pendente(timestamptz '$AGORA')::text" 2>&1 || true)"
if [ "$(PDq nb -c "SELECT pg_input_is_valid(\$j\$$J10\$j\$, 'jsonb')")" = "t" ]; then
  eq "B10a linha travada → parcial em 'trava' (não erro)" "$(J "$J10" parcial,interrompido)" "trava"
  eq "B10b a faixa anterior ficou gravada, o cursor parou na faixa travada" \
    "$(PDq nb -c "SELECT proxima_pagina FROM public.radar_situacao_passada")" "20"
else
  eq "B10a linha travada → parcial em 'trava' (não erro)" "$(echo "$J10" | grep -o 'ERRO.*\|ERROR.*' | head -1 | cut -c1-60)" "json"
fi
wait "$B10_PID" || true

# B13: a linha do lote em radar_ingest_state travada por outra sessão (SKIP LOCKED) → a passada dele fica.
CUR13="$(PDq nb -c "SELECT proxima_pagina FROM public.radar_situacao_passada")"
( PDq nb -c "BEGIN; SELECT 1 FROM public.radar_ingest_state WHERE mes_referencia = '2026-11' FOR UPDATE; SELECT pg_sleep(4); COMMIT;" >/dev/null 2>&1 ) &
B13_PID=$!
until [ "$(PDq nb -c "SELECT count(*) FROM pg_stat_activity WHERE query LIKE '%pg_sleep(4)%' AND state = 'active' AND pid <> pg_backend_pid()")" = "1" ]; do sleep 0.1; done
J13="$(T nb 10 0)"
eq "B13 lote travado (SKIP LOCKED) → nada aplicado e a passada dele NÃO é descartada" \
  "$(J "$J13" aplicados)/$(PDq nb -c "SELECT lote||'|'||proxima_pagina FROM public.radar_situacao_passada")" "0/2026-11|$CUR13"
wait "$B13_PID" || true

# B7: lote 2026-12 fecha no meio da passada do 2026-11 → o 2026-11 vira SUPERADO e a passada recomeça com o 2026-12.
PDq nb -c "INSERT INTO public.radar_situacao_cadastral (cnpj, lote, situacao, data_situacao, motivo_codigo, motivo_descricao) SELECT cnpj, '2026-12', situacao, data_situacao, motivo_codigo, motivo_descricao FROM public.radar_situacao_cadastral WHERE lote = '2026-11'; INSERT INTO public.radar_ingest_state (mes_referencia, status, iniciado_em, finalizado_em) VALUES ('2026-12', 'complete', '2026-12-14 10:00+00', '2026-12-14 21:00+00')" >/dev/null
J7="$(T nb 10 0)"
eq "B7a o lote velho vira superado (marcado sem efeito)" \
  "$(J "$J7" 'lotes,0,lote')/$(J "$J7" 'lotes,0,superado_por')" "2026-11/2026-12"
eq "B7b a passada recomeça do zero com o lote novo" \
  "$(PDq nb -c "SELECT lote||'|'||proxima_pagina||'|'||rodadas FROM public.radar_situacao_passada")" "2026-12|10|1"

# B11: lead do lote travado na conclusão → parcial `trava_na_conclusao`, sem marca; depois da trava, conclui.
n=0; JT="$J7"
while [ "$(J "$JT" parcial,interrompido)" != "faixas_concluidas" ] && [ "$n" -lt "$LIMITE" ]; do JT="$(T nb 10 0)"; n=$((n+1)); done
ALVO11="$(PDq nb -c "SELECT re.cnpj FROM public.radar_empresas re JOIN public.radar_situacao_cadastral s ON s.cnpj = re.cnpj AND s.lote = '2026-12' WHERE s.situacao = '08' AND NOT re.ja_cliente AND re.prospeccao_status = 'a_contatar' AND NOT EXISTS (SELECT 1 FROM public._t_docs d WHERE d.doc = re.cnpj) ORDER BY re.cnpj LIMIT 1")"
eq "B11' alvo da prova existe e as faixas do lote novo terminaram" \
  "$([ -n "$ALVO11" ] && echo sim || echo nao)/$(J "$JT" parcial,interrompido)" "sim/faixas_concluidas"
( PDq nb -c "BEGIN; SELECT 1 FROM public.radar_empresas WHERE cnpj = '$ALVO11' FOR UPDATE; SELECT pg_sleep(8); COMMIT;" >/dev/null 2>&1 ) &
B11_PID=$!
until [ "$(PDq nb -c "SELECT count(*) FROM pg_stat_activity WHERE query LIKE '%pg_sleep(8)%' AND state = 'active' AND pid <> pg_backend_pid()")" = "1" ]; do sleep 0.1; done
sleep 0.3
ERR11="$(dirname "$DATA")/b11.err"
J11="$(T nb 10 0 2>"$ERR11" || true)"   # stderr à parte: o DROP TABLE IF EXISTS da função emite NOTICE
if [ "$(PDq nb -c "SELECT pg_input_is_valid(\$j\$$J11\$j\$, 'jsonb')")" = "t" ]; then
  eq "B11a trava na conclusão → parcial 'trava_na_conclusao' e o lote segue pendente" \
    "$(J "$J11" parcial,interrompido)/$(PDq nb -c "SELECT coalesce(situacao_aplicada_fechamento::text, 'pendente') FROM public.radar_ingest_state WHERE mes_referencia = '2026-12'")" \
    "trava_na_conclusao/pendente"
else
  eq "B11a trava na conclusão → parcial 'trava_na_conclusao' e o lote segue pendente" "$(grep -o 'ERRO.*\|ERROR.*' "$ERR11" | head -1 | cut -c1-60)" "json"
fi
wait "$B11_PID" || true
J11b="$(T nb 10 0)"
eq "B11b depois da trava a conclusão aplica e marca o lote novo" \
  "$(J "$J11b" aplicados)/$(PDq nb -c "SELECT (situacao_aplicada_fechamento = finalizado_em)::text FROM public.radar_ingest_state WHERE mes_referencia = '2026-12'")/$(PDq nb -c "SELECT prospeccao_status FROM public.radar_empresas WHERE cnpj = '$ALVO11'")" \
  "1/true/descartado"

# ── C/D: job, fronteira, ACL ────────────────────────────────────────────────────────────────────────────
eq "C1 job: de 5 em 5 min nas horas do score (00–05, 07–10 UTC), comando com SET statement_timeout, ativo, dono postgres" \
  "$(PDq base -c "SELECT schedule||'|'||command||'|'||active||'|'||username FROM cron.job WHERE jobname = 'radar-aplicar-situacao-diario'")" \
  "2-59/5 0-5,7-10 * * *|SET statement_timeout = '5min'; SELECT public.radar_aplicar_situacao_pendente();|true|postgres"
D1="$(PD base -qAt 2>&1 <<'SQL' || true
SET ROLE authenticated;
DO $d1$ BEGIN
  PERFORM count(*) FROM public.radar_situacao_passada;
  RAISE NOTICE 'D1_LEU';
EXCEPTION WHEN insufficient_privilege THEN
  RAISE NOTICE 'D1_NEGADO_42501';
END $d1$;
SQL
)"
eq "D1 authenticated não lê radar_situacao_passada (42501)" "$(echo "$D1" | grep -o 'D1_[A-Z0-9_]*' | head -1)" "D1_NEGADO_42501"
eq "D2 ACL preservado (anon/authenticated/service_role não executam) e proconfig com lock_timeout e search_path" \
  "$(PDq base -c "SELECT has_function_privilege('anon', f, 'EXECUTE')::text || has_function_privilege('authenticated', f, 'EXECUTE')::text || has_function_privilege('service_role', f, 'EXECUTE')::text || '/' || array_to_string(proconfig, ',') || '/' || prosecdef FROM pg_proc, (SELECT 'public.radar_aplicar_situacao_pendente(timestamptz)'::regprocedure AS f) x WHERE oid = x.f")" \
  "falsefalsefalse/search_path=public, pg_temp,lock_timeout=5s/true"

# ── F: PRE ──────────────────────────────────────────────────────────────────────────────────────────────
PDq fpre -c "CREATE OR REPLACE FUNCTION public.radar_aplicar_situacao_pendente(p_agora timestamptz DEFAULT now()) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public', 'pg_temp' AS \$f\$ BEGIN RETURN '{}'::jsonb; END \$f\$" >/dev/null
F1="$(PD fpre -q -f "$MIG_USADA" 2>&1 || true)"
eq "F1 PRE: pendente viva divergente ABORTA e fica intacta" \
  "$(echo "$F1" | grep -o 'PRE FALHOU: radar_aplicar_situacao_pendente vivo' | head -1)/$(PDq fpre -c "SELECT md5(prosrc) = md5(' BEGIN RETURN ''{}''::jsonb; END ') FROM pg_proc WHERE proname = 'radar_aplicar_situacao_pendente'")/$(PDq fpre -c "SELECT to_regclass('public.radar_situacao_passada') IS NULL")" \
  "PRE FALHOU: radar_aplicar_situacao_pendente vivo/t/t"
PD postgres -qc "DROP DATABASE fpre" >/dev/null
PD postgres -qc "CREATE DATABASE fpre2 TEMPLATE pred" >/dev/null
PDq fpre2 -c "CREATE OR REPLACE FUNCTION public.radar_aplicar_situacao(p_lote text, p_agora timestamptz DEFAULT now()) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public', 'pg_temp' AS \$f\$ BEGIN RETURN '{}'::jsonb; END \$f\$" >/dev/null
F2="$(PD fpre2 -q -f "$MIG_USADA" 2>&1 || true)"
eq "F2 PRE: função de aplicação viva divergente ABORTA" \
  "$(echo "$F2" | grep -o 'PRE FALHOU: a fun' | head -1)/$(PDq fpre2 -c "SELECT to_regclass('public.radar_situacao_passada') IS NULL")" \
  "PRE FALHOU: a fun/t"

echo "──"
echo "PASS=$PASS FAIL=$FAIL"
[ "$FAIL" -eq 0 ] || exit 1
echo "RADAR_SITUACAO_FATIAS_PROVA_OK"
