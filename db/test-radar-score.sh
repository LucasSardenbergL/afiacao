#!/usr/bin/env bash
# Prova PG17 do SCORE de lead do Radar (migration 20261019180000):
# `radar_score_recalcular()` escreve score/score_motivos/score_em (único escritor), determinístico,
# monotônico por fator, NULL honesto (fora da foto, já cliente, sem lote), ledger `acoes_execucoes`
# (slug radar.score_recalcular, origem automatica, contagens), ACL fechada e cron às 06:30 UTC.
# Aplica a migration REAL sobre um esquema mínimo (radar_empresas, radar_ingest_state, acoes_execucoes,
# cron.job/cron.schedule de mentira). Sessão LIMPA (sem GUC de JWT/role) — o que o pg_cron vê.
#
#   bash db/test-radar-score.sh > /tmp/t.log 2>&1; echo "exit=$?"
#   SABOTAGEM=<nome> bash db/test-radar-score.sh      # tem de ficar VERMELHA
#   bash db/test-radar-score.sh --falsificar           # controle verde + cada sabotagem vermelha no assert dela
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MIG="$REPO_ROOT/supabase/migrations/20261019180000_radar_score_lead.sql"

if [ "${1:-}" = "--falsificar" ]; then
  # <sabotagem>:<assert que TEM de acusá-la> — `post:A3` = a POSTCONDIÇÃO da própria migration (DO $post$)
  # aborta o apply antes de qualquer assert; a variante `_sem_post` cega essa camada para provar que o
  # assert da suíte pega sozinho (uma camada por vez: a que fica verde é redundante ou inalcançada).
  # O md5 do prosrc (post:A4) pega TODA sabotagem no corpo da função — por isso cada sabotagem de corpo
  # também cega o A4 (`cegar_md5`), senão a prova só veria a postcondição e nunca o assert da suíte;
  # `corpo_divergente` é a que prova o A4 sozinho.
  SABOTAGENS="peso_capital_zero:A6 null_vira_zero:A4 ja_cliente_pontua:A4 relogio_sessao:A10 nao_deterministico:A5 sem_ledger:A7a engole_erro:A13 acl_aberta:post:A3 acl_aberta_sem_post:A8 cron_semanal:post:A6 cron_semanal_sem_post:A9 corpo_divergente:post:A4"
  LOGDIR="$(mktemp -d "/tmp/falsifica-radar-score.XXXXXX")"
  echo "══ CONTROLE ══"
  if ! SABOTAGEM="" bash "$0" > "$LOGDIR/controle.log" 2>&1; then
    echo "❌ controle VERMELHO — falsificação abortada (log: $LOGDIR/controle.log)"; tail -15 "$LOGDIR/controle.log"; exit 1
  fi
  echo "✅ controle verde"
  falhas=0; n_sab=0
  for par in $SABOTAGENS; do
    s="${par%%:*}"; a="${par#*:}"; n_sab=$((n_sab+1))
    if SABOTAGEM="$s" bash "$0" > "$LOGDIR/$s.log" 2>&1; then
      echo "❌ $s: suíte ficou VERDE"; falhas=$((falhas+1)); continue
    fi
    if ! grep -q "SABOTAGEM ATIVA: $s" "$LOGDIR/$s.log"; then
      echo "❌ $s: sabotagem NÃO aplicou"; falhas=$((falhas+1)); continue
    fi
    case "$a" in
      post:*) padrao="${a#post:} FALHOU" ;;
      *)      padrao="^FAIL $a " ;;
    esac
    if grep -q "$padrao" "$LOGDIR/$s.log"; then
      echo "✅ $s → $a vermelho"
    else
      echo "❌ $s: vermelho, mas não no $a (log: $LOGDIR/$s.log)"; falhas=$((falhas+1))
    fi
  done
  echo "SABOTAGENS: $((n_sab - falhas)) vermelhas / $falhas falhas"   # recibo exigido por db/roda-nucleo-ci.sh
  [ "$falhas" -eq 0 ] && exit 0 || exit 1
fi

export PGVER=17
# shellcheck disable=SC1091  # caminho resolvido em runtime a partir de REPO_ROOT
. "$REPO_ROOT/db/lib/pg-harness.sh"
PORT="${PGPORT_TEST:-5493}"
DATA="$(mktemp -d "/tmp/pgtest-radar-score.XXXXXX")/data"
export LC_ALL=C LANG=C
MIG_USADA="$(dirname "$DATA")/mig.sql"
cleanup() { "$PGBIN/pg_ctl" -D "$DATA" stop -m immediate >/dev/null 2>&1 || true; rm -rf "$(dirname "$DATA")"; }
trap cleanup EXIT

cp "$MIG" "$MIG_USADA"

sabotar() { # $1 = de, $2 = para (literal)
  python3 -I - "$MIG_USADA" "$1" "$2" <<'PY'
import sys
p, de, para = sys.argv[1:]
s = open(p, encoding="utf-8").read()
if de not in s:
    sys.exit("padrao ausente: " + de)
open(p, "w", encoding="utf-8").write(s.replace(de, para))
PY
}
# Sabotagem no CORPO da função muda o prosrc → a postcondição A4 (md5) pegaria antes da suíte.
# Para provar que o assert da suíte tem dente sozinho, cega o A4 junto.
cegar_md5() { sabotar "  IF v_md5 IS DISTINCT FROM '" "  IF false AND v_md5 IS DISTINCT FROM '"; }
case "${SABOTAGEM:-}" in
  "") ;;
  peso_capital_zero)   cegar_md5; sabotar "        WHEN e.capital_social >=  100000 THEN 10" "        WHEN e.capital_social >=  100000 THEN 0" ;;
  null_vira_zero)      cegar_md5; sabotar "        WHEN e.ultimo_lote < v_vigente  THEN 'fora da foto vigente'" "        WHEN false THEN 'fora da foto vigente'" ;;
  ja_cliente_pontua)   cegar_md5; sabotar "        WHEN e.ja_cliente               THEN 'já é cliente'" "        WHEN false THEN 'já é cliente'" ;;
  relogio_sessao)      cegar_md5; sabotar "  v_ref := CASE WHEN v_vigente IS NULL THEN NULL ELSE to_date(v_vigente || '-01', 'YYYY-MM-DD') END;" "  v_ref := current_date;" ;;
  nao_deterministico)  cegar_md5; sabotar "     AND (c.score_novo, c.motivos_novos) IS DISTINCT FROM (e.score, e.score_motivos);" ";" ;;
  sem_ledger)          cegar_md5; sabotar "INSERT INTO public.acoes_execucoes" "INSERT INTO public.acoes_execucoes_sumiu" ;;
  engole_erro)         cegar_md5; sabotar "  SELECT s.mes_referencia, s.iniciado_em
    INTO v_vigente, v_vigente_inicio
    FROM public.radar_ingest_state s
   WHERE s.status = 'complete'
   ORDER BY s.mes_referencia DESC
   LIMIT 1;" "  BEGIN
  SELECT s.mes_referencia, s.iniciado_em
    INTO v_vigente, v_vigente_inicio
    FROM public.radar_ingest_state s
   WHERE s.status = 'complete'
   ORDER BY s.mes_referencia DESC
   LIMIT 1;
  EXCEPTION WHEN OTHERS THEN
    v_vigente := NULL; v_vigente_inicio := NULL;
  END;" ;;
  acl_aberta)          sabotar "FROM PUBLIC, anon, authenticated;" "FROM anon;" ;;
  acl_aberta_sem_post) sabotar "FROM PUBLIC, anon, authenticated;" "FROM anon;"
                       sabotar "  IF has_function_privilege('anon', 'public.radar_score_recalcular()', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.radar_score_recalcular()', 'EXECUTE') THEN" "  IF false THEN" ;;
  cron_semanal)        sabotar "  '30 6 * * *'," "  '30 6 * * 1'," ;;
  cron_semanal_sem_post) sabotar "  '30 6 * * *'," "  '30 6 * * 1',"
                       sabotar "      AND schedule = '30 6 * * *'
" "" ;;
  corpo_divergente)    sabotar "      CASE WHEN e.email IS NOT NULL THEN 3 ELSE 0 END AS p_email," "      CASE WHEN e.email IS NOT NULL THEN 3  ELSE 0 END AS p_email," ;;
  *) echo "sabotagem desconhecida: $SABOTAGEM"; exit 9 ;;
esac
[ -n "${SABOTAGEM:-}" ] && echo "⚠️  SABOTAGEM ATIVA: $SABOTAGEM"

"$PGBIN/initdb" -D "$DATA" -U postgres -E UTF8 --locale=C >/dev/null
"$PGBIN/pg_ctl" -D "$DATA" -o "-p $PORT -k /tmp" -l "$(dirname "$DATA")/pg.log" -w start >/dev/null
P()  { "$PGBIN/psql" -X -v ON_ERROR_STOP=1 -p "$PORT" -h /tmp -U postgres -d postgres "$@"; }
Pq() { P -qAt "$@"; }

P -q <<'SQL'
CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN; CREATE ROLE service_role NOLOGIN;
-- Esquema mínimo: só as colunas que a função lê/escreve (+ updated_at, que ela NÃO pode tocar).
CREATE TABLE public.radar_empresas (
  cnpj text PRIMARY KEY CHECK (cnpj ~ '^[0-9A-Z]{12}[0-9]{2}$'),
  cnae_principal text NOT NULL DEFAULT '2542000',
  data_abertura date DEFAULT '2021-03-01',
  porte text DEFAULT '01',
  capital_social numeric DEFAULT 5000,
  municipio_codigo text DEFAULT 'M1',
  uf text DEFAULT 'SC',
  telefone1 text, telefone2 text, email text,
  primeira_vista_em timestamptz NOT NULL DEFAULT '2026-06-12 00:00+00',
  ultimo_lote text NOT NULL DEFAULT '2026-08',
  ja_cliente boolean NOT NULL DEFAULT false,
  prospeccao_status text NOT NULL DEFAULT 'a_contatar',
  updated_at timestamptz NOT NULL DEFAULT '2026-06-15 00:00+00');
CREATE TABLE public.radar_ingest_state (
  mes_referencia text PRIMARY KEY, status text NOT NULL DEFAULT 'running',
  iniciado_em timestamptz NOT NULL DEFAULT now());
-- Ledger com os MESMOS CHECKs da tabela real (20260722100000): origem e status são vocabulário fechado.
CREATE TABLE public.acoes_execucoes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  acao text NOT NULL,
  origem text NOT NULL DEFAULT 'manual' CHECK (origem IN ('manual','automatica')),
  executado_por uuid, executado_por_nome text,
  iniciado_em timestamptz NOT NULL DEFAULT now(),
  finalizado_em timestamptz,
  status text NOT NULL DEFAULT 'executando' CHECK (status IN ('executando','sucesso','erro')),
  detalhes jsonb);
ALTER TABLE public.acoes_execucoes ENABLE ROW LEVEL SECURITY;  -- como em prod: o DEFINER (owner) grava mesmo assim
CREATE SCHEMA cron;
CREATE TABLE cron.job (jobid bigint PRIMARY KEY, jobname text, schedule text, command text, active boolean DEFAULT true);
CREATE FUNCTION cron.schedule(p_jobname text, p_schedule text, p_command text) RETURNS bigint LANGUAGE plpgsql AS $$
DECLARE v bigint;
BEGIN
  SELECT jobid INTO v FROM cron.job WHERE jobname = p_jobname;
  IF v IS NULL THEN
    SELECT COALESCE(max(jobid),0)+1 INTO v FROM cron.job;
    INSERT INTO cron.job VALUES (v, p_jobname, p_schedule, p_command, true);
  ELSE
    UPDATE cron.job SET schedule = p_schedule, command = p_command WHERE jobid = v;
  END IF;
  RETURN v;
END $$;
SQL

P -q -f "$MIG_USADA" >/dev/null
P -q -f "$MIG_USADA" >/dev/null   # idempotente

PASS=0; FAIL=0
eq() { if [ "$2" = "$3" ]; then echo "PASS $1"; PASS=$((PASS+1)); else echo "FAIL $1 — obtido [$2] esperado [$3]"; FAIL=$((FAIL+1)); fi; }
rodar() { Pq -c "SELECT public.radar_score_recalcular();"; }
campo() { Pq -c "SELECT (\$j\$$1\$j\$::jsonb) #>> '{$2}';"; }   # $1 = jsonb do resumo, $2 = caminho 'a,b'
score_de() { Pq -c "SELECT coalesce(score::text,'(null)') FROM public.radar_empresas WHERE cnpj='$1';"; }
motivos_de() { Pq -c "SELECT coalesce(array_to_string(score_motivos, ' | '),'(null)') FROM public.radar_empresas WHERE cnpj='$1';"; }
foto() { Pq -c "SELECT string_agg(cnpj||'='||coalesce(score::text,'null')||'@'||score_em::text, ' ' ORDER BY cnpj) FROM public.radar_empresas;"; }
n_ledger() { Pq -c "SELECT count(*) FROM public.acoes_execucoes WHERE acao='radar.score_recalcular';"; }

# Sessão limpa = o que o pg_cron vê: sem claims de JWT nem role trocada.
eq "A0 sessão sem JWT (reproduz o pg_cron)" \
   "$(Pq -c "SELECT (current_setting('request.jwt.claims', true) IS NULL)::text||' '||current_user;")" "true postgres"

# Lotes: 2026-05 (antigo) e 2026-08 (vigente, iniciado 2026-10-19 16:31 UTC — como em prod).
# Município M2: 12 já-clientes (MG). Município M9: 100 já-clientes (MG) → a UF MG fica com ≥100.
Pq -c "INSERT INTO public.radar_ingest_state VALUES ('2026-05','complete','2026-06-12 01:05+00'), ('2026-08','complete','2026-10-19 16:31:08+00');
INSERT INTO public.radar_empresas (cnpj, municipio_codigo, uf, ja_cliente)
  SELECT 'JC' || lpad(g::text, 10, '0') || '01', 'M2', 'MG', true FROM generate_series(1, 12) g;
INSERT INTO public.radar_empresas (cnpj, municipio_codigo, uf, ja_cliente)
  SELECT 'JX' || lpad(g::text, 10, '0') || '01', 'M9', 'MG', true FROM generate_series(1, 100) g;
-- L01 base: serralheria (8) + ME (3) + capital 5k (0) + 5 anos em 2026-08 (10) + M1 sem cliente/SC (0) + sem contato (0) + visto em jun (0) = 21
INSERT INTO public.radar_empresas (cnpj) VALUES ('L0100000000001');
INSERT INTO public.radar_empresas (cnpj, capital_social) VALUES ('L0200000000002', 150000);              -- +10 capital → 31
INSERT INTO public.radar_empresas (cnpj, porte) VALUES ('L0300000000003', '05');                         -- +7 porte → 28
INSERT INTO public.radar_empresas (cnpj, telefone1, email) VALUES ('L0400000000004', '31999990000', 'a@b.c'); -- +10 contato → 31
INSERT INTO public.radar_empresas (cnpj, municipio_codigo, uf) VALUES ('L0500000000005', 'M2', 'MG');   -- +15 município (12) → 36
INSERT INTO public.radar_empresas (cnpj, municipio_codigo, uf) VALUES ('L0600000000006', 'M3', 'MG');   -- +5 UF (112) → 26
INSERT INTO public.radar_empresas (cnpj, primeira_vista_em) VALUES ('L0700000000007', '2026-10-20 00:00+00'); -- +10 inédito → 31
INSERT INTO public.radar_empresas (cnpj, cnae_principal) VALUES ('L0800000000008', '3101200');           -- +17 CNAE tier 1 → 38
INSERT INTO public.radar_empresas (cnpj, ultimo_lote) VALUES ('L0900000000009', '2026-05');              -- fora da foto → NULL
INSERT INTO public.radar_empresas (cnpj, ja_cliente, municipio_codigo) VALUES ('L1000000000010', true, 'M0'); -- já cliente → NULL (M0: não contamina M1)
INSERT INTO public.radar_empresas (cnpj, cnae_principal, porte, capital_social, data_abertura, municipio_codigo, uf, telefone2, email, primeira_vista_em)
  VALUES ('L1100000000011', '3101200', '05', 2000000, '2020-01-01', 'M9', 'MG', '3133330000', 'x@y.z', '2026-10-20 00:00+00'); -- tudo no máximo → 100
INSERT INTO public.radar_empresas (cnpj, data_abertura) VALUES ('L1200000000012', '2026-08-15');          -- <1 ano (4) → 15
INSERT INTO public.radar_empresas (cnpj, data_abertura) VALUES ('L1300000000013', '2010-01-01');          -- 10+ anos (8) → 19
INSERT INTO public.radar_empresas (cnpj, data_abertura) VALUES ('L1400000000014', '2024-01-01');          -- 1–3 anos (6) → 17
INSERT INTO public.radar_empresas (cnpj, prospeccao_status) VALUES ('L1500000000015', 'descartado');     -- descartado pontua → 21
INSERT INTO public.radar_empresas (cnpj, capital_social) VALUES ('L1600000000016', NULL);                -- capital ausente: 0 ponto, sem motivo → 21
INSERT INTO public.radar_empresas (cnpj, data_abertura) VALUES ('L1700000000017', '2025-09-01');          -- 0 anos em 2026-08 (4) → 15; 1 ano pelo relógio da sessão (6)
INSERT INTO public.radar_empresas (cnpj, cnae_principal) VALUES ('L1800000000018', '9999999');           -- CNAE fora da curadoria: 0, sem motivo → 13" >/dev/null

R1="$(rodar)"
eq "A1 1ª rodada: resumo cita o lote vigente, 130 avaliados, 130 alterados, 16 com score" \
   "$(campo "$R1" lote_vigente)|$(campo "$R1" avaliados)|$(campo "$R1" alterados)|$(campo "$R1" com_score)" \
   "2026-08|130|130|16"
eq "A2 scores por fator (base 21; capital/porte/contato/município/UF/inédito/CNAE/idade; máximo 100)" \
   "$(Pq -c "SELECT string_agg(cnpj||'='||coalesce(score::text,'null'), ' ' ORDER BY cnpj) FROM public.radar_empresas WHERE cnpj LIKE 'L%';")" \
   "L0100000000001=21 L0200000000002=31 L0300000000003=28 L0400000000004=31 L0500000000005=36 L0600000000006=26 L0700000000007=31 L0800000000008=38 L0900000000009=null L1000000000010=null L1100000000011=100 L1200000000012=15 L1300000000013=19 L1400000000014=17 L1500000000015=21 L1600000000016=21 L1700000000017=15 L1800000000018=13"
eq "A3 motivos legíveis do lead máximo (um por fator, na ordem dos fatores)" "$(motivos_de L1100000000011)" \
   "CNAE prioritário (móveis de madeira) | porte demais (médio/grande) | capital ≥ R\$ 1 mi | empresa com 3–10 anos | município com 100 clientes | telefone disponível | e-mail disponível | inédito no lote 2026-08"
eq "A4 NULL honesto: fora da foto e já cliente ficam NULL com o motivo; capital ausente não ganha motivo" \
   "$(score_de L0900000000009) [$(motivos_de L0900000000009)] $(score_de L1000000000010) [$(motivos_de L1000000000010)] [$(motivos_de L1600000000016)]" \
   "(null) [fora da foto vigente] (null) [já é cliente] [CNAE de apoio (serralheria) | porte ME | empresa com 3–10 anos]"

ANTES="$(foto)"
R2="$(rodar)"
eq "A5 determinismo: 2ª rodada = mesmos scores/motivos, 0 alterados, score_em intocado" \
   "$(campo "$R2" alterados) $([ "$ANTES" = "$(foto)" ] && echo igual || echo diferente)" "0 igual"

eq "A6 monotonia: cada fator a mais sobe o score (capital, porte, contato, município, UF, inédito, CNAE) e 10+ anos > 1–3 > <1" \
   "$(Pq -c "SELECT bool_and(ok)::text FROM (VALUES
      ((SELECT score FROM public.radar_empresas WHERE cnpj='L0200000000002') > (SELECT score FROM public.radar_empresas WHERE cnpj='L0100000000001')),
      ((SELECT score FROM public.radar_empresas WHERE cnpj='L0300000000003') > (SELECT score FROM public.radar_empresas WHERE cnpj='L0100000000001')),
      ((SELECT score FROM public.radar_empresas WHERE cnpj='L0400000000004') > (SELECT score FROM public.radar_empresas WHERE cnpj='L0100000000001')),
      ((SELECT score FROM public.radar_empresas WHERE cnpj='L0500000000005') > (SELECT score FROM public.radar_empresas WHERE cnpj='L0600000000006')),
      ((SELECT score FROM public.radar_empresas WHERE cnpj='L0600000000006') > (SELECT score FROM public.radar_empresas WHERE cnpj='L0100000000001')),
      ((SELECT score FROM public.radar_empresas WHERE cnpj='L0700000000007') > (SELECT score FROM public.radar_empresas WHERE cnpj='L0100000000001')),
      ((SELECT score FROM public.radar_empresas WHERE cnpj='L0800000000008') > (SELECT score FROM public.radar_empresas WHERE cnpj='L0100000000001')),
      ((SELECT score FROM public.radar_empresas WHERE cnpj='L1300000000013') > (SELECT score FROM public.radar_empresas WHERE cnpj='L1400000000014')),
      ((SELECT score FROM public.radar_empresas WHERE cnpj='L1400000000014') > (SELECT score FROM public.radar_empresas WHERE cnpj='L1200000000012')),
      ((SELECT max(score) FROM public.radar_empresas) = 100 AND (SELECT min(score) FROM public.radar_empresas) >= 0)
    ) v(ok);")" "true"

LEDGER="$(Pq -c "SELECT origem||'|'||status||'|'||(detalhes->>'lote_vigente')||'|'||(detalhes->>'alterados')||'|'||(detalhes->'sem_score'->>'ja_cliente')||'|'||(detalhes->'sem_score'->>'fora_da_foto')||'|'||(detalhes->'faixas'->>'0-19')||'|'||(detalhes->'faixas'->>'20-39')||'|'||(detalhes->'faixas'->>'80-100')||'|'||(finalizado_em >= iniciado_em)::text||'|'||coalesce(executado_por::text,'-')
  FROM public.acoes_execucoes WHERE acao='radar.score_recalcular' ORDER BY iniciado_em LIMIT 1;")"
eq "A7a ledger: 2 linhas do slug radar.score_recalcular (uma por rodada)" "$(n_ledger)" "2"
eq "A7b ledger: automatica/sucesso, lote, alterados=130, nulos por motivo (113 já-clientes, 1 fora da foto), faixas (5·10·1), sem executado_por" \
   "$LEDGER" "automatica|sucesso|2026-08|130|113|1|5|10|1|true|-"

eq "A8 anon e authenticated não executam radar_score_recalcular (service_role sim)" \
   "$(Pq -c "SELECT has_function_privilege('authenticated','public.radar_score_recalcular()','EXECUTE')::text
     ||' '||has_function_privilege('anon','public.radar_score_recalcular()','EXECUTE')::text
     ||' '||has_function_privilege('service_role','public.radar_score_recalcular()','EXECUTE')::text;")" "false false true"

eq "A9 cron diário agendado às 06:30 UTC (03:30 BRT) apontando para a função" \
   "$(Pq -c "SELECT schedule||'|'||command||'|'||active::text FROM cron.job WHERE jobname='radar-score-recalcular-diario';")" \
   "30 6 * * *|SELECT public.radar_score_recalcular();|true"

# Idade pela referência do LOTE (2026-08-01): aberta em 2025-09-01 tem 0 anos. Pelo relógio da sessão
# (≥ 2026-10) teria ≥ 1 ano e ganharia 6 em vez de 4 — e o score mudaria sozinho com o calendário.
eq "A10 idade é relativa ao mês do lote vigente, não ao relógio da sessão" \
   "$(score_de L1700000000017) [$(motivos_de L1700000000017)]" \
   "15 [CNAE de apoio (serralheria) | porte ME | empresa com menos de 1 ano]"

eq "A11 updated_at da empresa não é tocado pelo score (é da ingestão/recruzamento)" \
   "$(Pq -c "SELECT count(*) FROM public.radar_empresas WHERE updated_at <> '2026-06-15 00:00+00';")" "0"

# Mudança de estado: L02 vira cliente (em M0, sem contaminar M1) → NULL; L10 muda para M2/MG → 13 no município (L05) e 113 na UF (L06).
Pq -c "UPDATE public.radar_empresas SET ja_cliente = true, municipio_codigo = 'M0' WHERE cnpj = 'L0200000000002';
       UPDATE public.radar_empresas SET municipio_codigo = 'M2', uf = 'MG' WHERE cnpj = 'L1000000000010';" >/dev/null
R3="$(rodar)"
eq "A12 recruzamento reflete na rodada seguinte: já-cliente novo vira NULL; município (13) e UF (113) são recontados (3 alterados)" \
   "$(score_de L0200000000002) [$(motivos_de L0200000000002)] $(score_de L0500000000005) [$(Pq -c "SELECT score_motivos[4] FROM public.radar_empresas WHERE cnpj='L0500000000005';")] [$(Pq -c "SELECT score_motivos[4] FROM public.radar_empresas WHERE cnpj='L0600000000006';")] $(campo "$R3" alterados)" \
   "(null) [já é cliente] 36 [município com 13 clientes] [UF com 113 clientes] 3"

# Erro de verdade PROPAGA (job_run_details 'failed' com a mensagem real) e o ledger NÃO ganha linha.
Pq -c "ALTER TABLE public.radar_ingest_state RENAME TO radar_ingest_state_fora;" >/dev/null
ANTES_N="$(n_ledger)"
if SAIDA="$(Pq -c "SELECT public.radar_score_recalcular();" 2>&1)"; then RC13="verde"; else RC13="vermelho"; fi
case "$SAIDA" in *"radar_ingest_state"*) MSG13="mensagem-real";; *) MSG13="mensagem-perdida";; esac
eq "A13 erro propaga com a mensagem real, sem linha no ledger e sem tocar os scores" \
   "$RC13 $MSG13 $(( $(n_ledger) - ANTES_N )) $(score_de L0500000000005)" "vermelho mensagem-real 0 36"
Pq -c "ALTER TABLE public.radar_ingest_state_fora RENAME TO radar_ingest_state;" >/dev/null

# Lote novo: quem ficou no 2026-08 sai da foto (NULL), e o inédito de ontem deixa de ser inédito.
Pq -c "INSERT INTO public.radar_ingest_state VALUES ('2026-09','complete','2026-11-10 03:00+00');
       UPDATE public.radar_empresas SET ultimo_lote = '2026-09' WHERE cnpj IN ('L0700000000007','L1100000000011');" >/dev/null
rodar >/dev/null
eq "A14 lote novo: ultimo_lote velho ⇒ NULL 'fora da foto vigente'; quem seguiu no dump perde o bônus de inédito (31→21, 100→90)" \
   "$(score_de L0100000000001) [$(motivos_de L0100000000001)] $(score_de L0700000000007) $(score_de L1100000000011) [$(Pq -c "SELECT (score_motivos[8] IS NULL)::text FROM public.radar_empresas WHERE cnpj='L1100000000011';")]" \
   "(null) [fora da foto vigente] 21 90 [true]"

# Sem lote vigente nenhum: tudo NULL com motivo, nada de 0 fabricado.
Pq -c "UPDATE public.radar_ingest_state SET status = 'running';" >/dev/null
rodar >/dev/null
eq "A15 sem lote complete: todos NULL com 'sem lote vigente' (nunca 0)" \
   "$(Pq -c "SELECT count(*) FILTER (WHERE score IS NULL AND score_motivos = ARRAY['sem lote vigente'])||'/'||count(*) FROM public.radar_empresas;")" "130/130"
Pq -c "UPDATE public.radar_ingest_state SET status = 'complete';" >/dev/null

# Ledger indisponível: o recálculo acontece mesmo assim (fail-open só na observabilidade).
Pq -c "ALTER TABLE public.acoes_execucoes RENAME TO acoes_execucoes_fora;" >/dev/null
R16="$(rodar)"
eq "A16 ledger indisponível não derruba o recálculo (2 na foto 2026-09 voltam a pontuar)" "$(campo "$R16" com_score) $(score_de L0700000000007)" "2 21"
Pq -c "ALTER TABLE public.acoes_execucoes_fora RENAME TO acoes_execucoes;" >/dev/null

echo "PASS=$PASS  FAIL=$FAIL"
[ "$FAIL" -eq 0 ] && echo "RADAR_SCORE_PROVA_OK"
[ "$FAIL" -eq 0 ]
