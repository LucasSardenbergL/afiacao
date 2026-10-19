#!/usr/bin/env bash
# Prova PG17 do recruzamento DIÁRIO de `ja_cliente` do Radar (migration 20261019093000):
# `radar_recruzar_ja_cliente_tick()` chama a função original, grava UMA linha no ledger
# `acoes_execucoes` (slug radar.recruzar_ja_cliente, origem automatica, com denominador) e
# o cron `radar-recruzar-ja-cliente-diario` fica agendado às 06:15 UTC (03:15 BRT).
# Aplica a migration REAL sobre um esquema mínimo (radar_empresas, profiles,
# omie_clientes_nao_vinculados, acoes_execucoes, cron.job/cron.schedule de mentira) e a função
# ORIGINAL extraída da migration da fundação (20260610200000) — a que o cron vai chamar em prod.
# A sessão é LIMPA (sem GUC de JWT/role): é o único jeito de reproduzir o pg_cron.
#
#   bash db/test-radar-recruzamento-diario.sh > /tmp/t.log 2>&1; echo "exit=$?"
#   SABOTAGEM=<nome> bash db/test-radar-recruzamento-diario.sh   # tem de ficar VERMELHA
#   bash db/test-radar-recruzamento-diario.sh --falsificar        # controle verde + cada sabotagem vermelha no assert dela
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MIG="$REPO_ROOT/supabase/migrations/20261019093000_radar_recruzamento_diario_cron.sql"
MIG_FUNDACAO="$REPO_ROOT/supabase/migrations/20260610200000_radar_fundacao.sql"

if [ "${1:-}" = "--falsificar" ]; then
  # <sabotagem>:<assert que TEM de acusá-la>
  # <sabotagem>:<assert que TEM de acusá-la> — `post:A2` = a POSTCONDIÇÃO da própria migration (DO $post$)
  # aborta o apply antes de qualquer assert; a variante `_sem_post` cega essa camada para provar que o
  # assert da suíte pega sozinho (uma camada por vez: a que fica verde é redundante ou inalcançada).
  SABOTAGENS="engole_erro:A9 acl_aberta:post:A2 acl_aberta_sem_post:A7 sem_ledger:A4a origem_manual:A4b cron_semanal:post:A3 cron_semanal_sem_post:A8 ledger_derruba:A10"
  LOGDIR="$(mktemp -d "/tmp/falsifica-radar-recruzamento.XXXXXX")"
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
PORT="${PGPORT_TEST:-5491}"
DATA="$(mktemp -d "/tmp/pgtest-radar-recruzamento.XXXXXX")/data"
export LC_ALL=C LANG=C
MIG_USADA="$(dirname "$DATA")/mig.sql"
FN_ORIGINAL="$(dirname "$DATA")/fn-original.sql"
cleanup() { "$PGBIN/pg_ctl" -D "$DATA" stop -m immediate >/dev/null 2>&1 || true; rm -rf "$(dirname "$DATA")"; }
trap cleanup EXIT

cp "$MIG" "$MIG_USADA"
# A função ORIGINAL vem da migration da fundação (imutável): só o bloco CREATE … $$; — nada das tabelas/policies.
awk '/^CREATE OR REPLACE FUNCTION public.radar_recruzar_ja_cliente\(\)/{p=1} p{print} p && /^\$\$;$/{exit}' "$MIG_FUNDACAO" > "$FN_ORIGINAL"
grep -q "GET DIAGNOSTICS v_marcados = ROW_COUNT" "$FN_ORIGINAL" || { echo "não extraí a função original de $MIG_FUNDACAO"; exit 9; }

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
case "${SABOTAGEM:-}" in
  "") ;;
  engole_erro)    sabotar "  v_marcados := public.radar_recruzar_ja_cliente();" "  BEGIN
    v_marcados := public.radar_recruzar_ja_cliente();
  EXCEPTION WHEN OTHERS THEN
    v_marcados := 0;
  END;" ;;
  acl_aberta)     sabotar "FROM PUBLIC, anon, authenticated;" "FROM anon;" ;;
  sem_ledger)     sabotar "INSERT INTO public.acoes_execucoes" "INSERT INTO public.acoes_execucoes_sumiu" ;;
  origem_manual)  sabotar "'automatica', v_ini" "'manual', v_ini" ;;
  cron_semanal)   sabotar "'15 6 * * *'," "'15 6 * * 1'," ;;
  acl_aberta_sem_post)   sabotar "FROM PUBLIC, anon, authenticated;" "FROM anon;"
                         sabotar "  IF has_function_privilege('anon', 'public.radar_recruzar_ja_cliente_tick()', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.radar_recruzar_ja_cliente_tick()', 'EXECUTE') THEN" "  IF false THEN" ;;
  cron_semanal_sem_post) sabotar "'15 6 * * *'," "'15 6 * * 1',"
                         sabotar "      AND schedule = '15 6 * * *'
" "" ;;
  ledger_derruba) sabotar "  EXCEPTION WHEN OTHERS THEN
    NULL;
  END;" "  EXCEPTION WHEN division_by_zero THEN
    NULL;
  END;" ;;
  *) echo "sabotagem desconhecida: $SABOTAGEM"; exit 9 ;;
esac
[ -n "${SABOTAGEM:-}" ] && echo "⚠️  SABOTAGEM ATIVA: $SABOTAGEM"

"$PGBIN/initdb" -D "$DATA" -U postgres -E UTF8 --locale=C >/dev/null
"$PGBIN/pg_ctl" -D "$DATA" -o "-p $PORT -k /tmp" -l "$(dirname "$DATA")/pg.log" -w start >/dev/null
P()  { "$PGBIN/psql" -X -v ON_ERROR_STOP=1 -p "$PORT" -h /tmp -U postgres -d postgres "$@"; }
Pq() { P -qAt "$@"; }

P -q <<'SQL'
CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN; CREATE ROLE service_role NOLOGIN;
-- Esquema mínimo: só as colunas que as duas funções tocam/leem.
CREATE TABLE public.radar_empresas (
  cnpj text PRIMARY KEY CHECK (cnpj ~ '^[0-9]{14}$'),
  cnae_principal text NOT NULL DEFAULT '2071100',
  ultimo_lote text NOT NULL DEFAULT '2026-05',
  ja_cliente boolean NOT NULL DEFAULT false,
  prospeccao_status text NOT NULL DEFAULT 'a_contatar',
  primeira_vista_em timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE public.profiles (user_id uuid DEFAULT gen_random_uuid(), document text);
CREATE TABLE public.omie_clientes_nao_vinculados (codigo text, cnpj_cpf text);
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
ALTER TABLE public.acoes_execucoes ENABLE ROW LEVEL SECURITY;  -- como em prod: o tick (DEFINER, owner) grava mesmo assim
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
P -q -f "$FN_ORIGINAL" >/dev/null
Pq -c "REVOKE ALL ON FUNCTION public.radar_recruzar_ja_cliente() FROM PUBLIC, anon, authenticated;" >/dev/null

P -q -f "$MIG_USADA" >/dev/null
P -q -f "$MIG_USADA" >/dev/null   # idempotente

PASS=0; FAIL=0
eq() { if [ "$2" = "$3" ]; then echo "PASS $1"; PASS=$((PASS+1)); else echo "FAIL $1 — obtido [$2] esperado [$3]"; FAIL=$((FAIL+1)); fi; }
tick() { Pq -c "SELECT public.radar_recruzar_ja_cliente_tick();"; }
estados() { Pq -c "SELECT string_agg(cnpj||'='||ja_cliente::text, ' ' ORDER BY cnpj) FROM public.radar_empresas;"; }
n_ledger() { Pq -c "SELECT count(*) FROM public.acoes_execucoes WHERE acao='radar.recruzar_ja_cliente';"; }

# Sessão limpa = o que o pg_cron vê: sem claims de JWT nem role trocada.
eq "A0 sessão sem JWT (reproduz o pg_cron)" \
   "$(Pq -c "SELECT (current_setting('request.jwt.claims', true) IS NULL)::text||' '||current_user;")" "true postgres"

# 4 empresas: 1 em profiles (documento FORMATADO), 2 só no Omie não-vinculado, 3 em lugar nenhum,
# 4 já cliente (também em profiles — não pode ser contada de novo).
Pq -c "INSERT INTO public.radar_empresas (cnpj, ja_cliente, updated_at) VALUES
  ('11111111000191', false, '2026-06-15 00:00+00'),
  ('22222222000192', false, '2026-06-15 00:00+00'),
  ('33333333000193', false, '2026-06-15 00:00+00'),
  ('44444444000194', true,  '2026-06-15 00:00+00');
INSERT INTO public.profiles (document) VALUES ('11.111.111/0001-91'), ('44.444.444/0001-94'), ('123.456.789-00');
INSERT INTO public.omie_clientes_nao_vinculados (codigo, cnpj_cpf) VALUES ('c2', '22222222000192'), ('c5', '55555555000195');" >/dev/null

eq "A1 tick retorna os marcados nesta rodada" "$(tick)" "2"
eq "A2 marca quem está em profiles OU no Omie; não toca quem não está" "$(estados)" \
   "11111111000191=true 22222222000192=true 33333333000193=false 44444444000194=true"
eq "A3 updated_at avança só nos marcados" \
   "$(Pq -c "SELECT string_agg(cnpj, ' ' ORDER BY cnpj) FROM public.radar_empresas WHERE updated_at > '2026-06-15 00:00+00';")" \
   "11111111000191 22222222000192"

LEDGER="$(Pq -c "SELECT origem||'|'||status||'|'||(detalhes->>'marcados')||'|'||(detalhes->>'candidatos_antes')||'|'||(detalhes->>'ja_cliente_total')||'|'||(finalizado_em >= iniciado_em)::text||'|'||coalesce(executado_por::text,'-')
  FROM public.acoes_execucoes WHERE acao='radar.recruzar_ja_cliente';")"
eq "A4a ledger: 1 linha do slug radar.recruzar_ja_cliente" "$(n_ledger)" "1"
eq "A4b ledger: automatica/sucesso, marcados=2 com denominador (3 candidatos antes, 3 ja_cliente depois), sem executado_por" \
   "$LEDGER" "automatica|sucesso|2|3|3|true|-"

eq "A5 2ª rodada: nada novo a marcar, mais uma linha no ledger, estados preservados" \
   "$(tick) $(n_ledger) $(estados)" \
   "0 2 11111111000191=true 22222222000192=true 33333333000193=false 44444444000194=true"
eq "A5b 2ª linha registra marcados=0 com o denominador atualizado" \
   "$(Pq -c "SELECT (detalhes->>'marcados')||'|'||(detalhes->>'candidatos_antes') FROM public.acoes_execucoes WHERE acao='radar.recruzar_ja_cliente' ORDER BY iniciado_em DESC LIMIT 1;")" "0|1"

# Nunca desmarca: o documento some de profiles e a empresa continua cliente.
Pq -c "DELETE FROM public.profiles WHERE document = '11.111.111/0001-91';" >/dev/null
eq "A6 nunca desmarca (documento sumiu de profiles → continua ja_cliente)" "$(tick) $(estados)" \
   "0 11111111000191=true 22222222000192=true 33333333000193=false 44444444000194=true"

eq "A7 anon e authenticated não executam o tick (nem a função original)" \
   "$(Pq -c "SELECT has_function_privilege('authenticated','public.radar_recruzar_ja_cliente_tick()','EXECUTE')::text
     ||' '||has_function_privilege('anon','public.radar_recruzar_ja_cliente_tick()','EXECUTE')::text
     ||' '||has_function_privilege('authenticated','public.radar_recruzar_ja_cliente()','EXECUTE')::text;")" "false false false"

eq "A8 cron diário agendado às 06:15 UTC (03:15 BRT) apontando para o tick" \
   "$(Pq -c "SELECT schedule||'|'||command||'|'||active::text FROM cron.job WHERE jobname='radar-recruzar-ja-cliente-diario';")" \
   "15 6 * * *|SELECT public.radar_recruzar_ja_cliente_tick();|true"

# Erro da função original PROPAGA (job_run_details 'failed' com a mensagem real) e o ledger NÃO ganha linha.
Pq -c "CREATE OR REPLACE FUNCTION public.radar_recruzar_ja_cliente() RETURNS integer LANGUAGE plpgsql SECURITY DEFINER AS \$f\$
  BEGIN RAISE EXCEPTION 'profiles sumiu' USING ERRCODE = '42P01'; END \$f\$;" >/dev/null
ANTES="$(n_ledger)"
if SAIDA="$(Pq -c "SELECT public.radar_recruzar_ja_cliente_tick();" 2>&1)"; then RC9="verde"; else RC9="vermelho"; fi
case "$SAIDA" in *"profiles sumiu"*) MSG9="mensagem-real";; *) MSG9="mensagem-perdida";; esac
eq "A9 erro da função original propaga com a mensagem real e sem linha no ledger" \
   "$RC9 $MSG9 $(( $(n_ledger) - ANTES ))" "vermelho mensagem-real 0"
P -q -f "$FN_ORIGINAL" >/dev/null   # restaura

# Ledger indisponível: o recruzamento acontece mesmo assim (fail-open só na observabilidade).
Pq -c "ALTER TABLE public.acoes_execucoes RENAME TO acoes_execucoes_fora;
       INSERT INTO public.omie_clientes_nao_vinculados (codigo, cnpj_cpf) VALUES ('c3', '33333333000193');" >/dev/null
eq "A10 ledger indisponível não derruba o recruzamento" "$(tick) $(estados)" \
   "1 11111111000191=true 22222222000192=true 33333333000193=true 44444444000194=true"
Pq -c "ALTER TABLE public.acoes_execucoes_fora RENAME TO acoes_execucoes;" >/dev/null

echo "PASS=$PASS  FAIL=$FAIL"
[ "$FAIL" -eq 0 ] && echo "RADAR_RECRUZAMENTO_DIARIO_PROVA_OK"
[ "$FAIL" -eq 0 ]
