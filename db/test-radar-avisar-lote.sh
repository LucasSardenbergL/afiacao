#!/usr/bin/env bash
# Prova PG17 do AVISO AO GESTOR por lote do Radar — migration 20261020143000_radar_avisar_lote:
# `radar_avisar_lote(p_agora)` (entrypoint do cron 06:45 UTC) abre UM fornecedor_alerta por lote
# `complete` fechado há ≥ 15 min, com denominador em cada número (inéditos N de T · saíram S de T_ant ·
# baixas K de M · score P de N), nunca repete o aviso do mesmo lote (avisado_em), ignora lote `running`,
# diz "score pendente" quando o score ainda não rodou após o fechamento (nunca "0 de N"), grava o ledger
# (radar.avisar_lote) e PROPAGA erro sem deixar meio-estado. Relógio controlado por `p_agora`.
# Backfill da migration: lote antigo já fechado NÃO ganha e-mail retroativo (só o mais recente).
# `radar_docs_clientes()` vem da migration 20261019200000 (imutável) — extraída como a prova vizinha faz.
#
#   bash db/test-radar-avisar-lote.sh > /tmp/t.log 2>&1; echo "exit=$?"
#   SABOTAGEM=<nome> bash db/test-radar-avisar-lote.sh   # tem de ficar VERMELHA
#   bash db/test-radar-avisar-lote.sh --falsificar        # controle verde + cada sabotagem vermelha no assert dela
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MIG="$REPO_ROOT/supabase/migrations/20261020143000_radar_avisar_lote.sql"
MIG_SIT="$REPO_ROOT/supabase/migrations/20261019200000_radar_situacao_cadastral.sql"

if [ "${1:-}" = "--falsificar" ]; then
  # <sabotagem>:<assert que TEM de acusá-la> — `post:A3` = a POSTCONDIÇÃO da própria migration (DO $post$)
  # aborta o apply antes de qualquer assert; `guarda:<regex>` = a GUARDA interna da função (RAISE) acusa
  # antes do assert; `_sem_post`/`_sem_guarda` cegam essa camada para provar que o assert da suíte pega
  # sozinho (uma camada por vez: a que fica verde é redundante ou inalcançada).
  SABOTAGENS="corpo_divergente:post:A7 reapply_apaga_pendencia:A14c score_rodada_errada:A4c sairam_acumula:A9 repete_aviso:guarda:avisado_em.marcou.0 repete_aviso_sem_guarda:A2 nao_marca_avisado:A6 sem_espera:A2 running_avisa:A8 score_zero:A4c sem_denominador:A4a sairam_conta_descartado:A4b baixas_zero_de_zero:A10c sem_ledger:A11 retroativo:post:A5 retroativo_sem_post:A1 acl_aberta:post:A3 acl_aberta_sem_post:A13"
  LOGDIR="$(mktemp -d "${TMPDIR:-/tmp}/falsifica-radar-avisar.XXXXXX")"
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
      post:*)   padrao="${a#post:} FALHOU" ;;
      guarda:*) padrao="ERROR:.*${a#guarda:}" ;;
      *)        padrao="^FAIL $a " ;;
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
DATA="$(mktemp -d "${TMPDIR:-/tmp}/pgtest-radar-avisar.XXXXXX")/data"
export LC_ALL=C LANG=C
MIG_USADA="$(dirname "$DATA")/mig.sql"
FN_DOCS="$(dirname "$DATA")/fn-docs.sql"
cleanup() { "$PGBIN/pg_ctl" -D "$DATA" stop -m immediate >/dev/null 2>&1 || true; rm -rf "$(dirname "$DATA")"; }
trap cleanup EXIT

cp "$MIG" "$MIG_USADA"
awk '/^CREATE OR REPLACE FUNCTION public.radar_docs_clientes\(\)/{p=1} p{print} p && /^\$\$;$/{exit}' "$MIG_SIT" > "$FN_DOCS"
grep -q "omie_clientes_nao_vinculados" "$FN_DOCS" || { echo "não extraí radar_docs_clientes de $MIG_SIT"; exit 9; }

sabotar() { # $1 = de, $2 = para (literal; substitui TODAS as ocorrências)
  python3 -I - "$MIG_USADA" "$1" "$2" <<'PY'
import sys
p, de, para = sys.argv[1:]
s = open(p, encoding="utf-8").read()
if de not in s:
    sys.exit("padrao ausente: " + de)
open(p, "w", encoding="utf-8").write(s.replace(de, para))
PY
}
# Sabotagem no CORPO da função muda o prosrc → a postcondição A7 (md5) pegaria antes da suíte; cada sabotagem
# de corpo cega o A7 (uma camada por vez) e `corpo_divergente` prova que o A7 pega sozinho.
cegar_md5() { sabotar "  IF v_md5 IS DISTINCT FROM '" "  IF false AND v_md5 IS DISTINCT FROM '"; }
case "${SABOTAGEM:-}" in
  "") ;;
  corpo_divergente) sabotar "c_top         constant integer  := 10;" "c_top         constant integer  := 11;" ;;
  repete_aviso) cegar_md5;     sabotar "       AND avisado_em IS NULL
       AND finalizado_em IS NOT NULL" "       AND finalizado_em IS NOT NULL" ;;
  repete_aviso_sem_guarda) cegar_md5; sabotar "       AND avisado_em IS NULL
       AND finalizado_em IS NOT NULL" "       AND finalizado_em IS NOT NULL"
                    sabotar "     WHERE mes_referencia = r.mes_referencia AND avisado_em IS NULL;" "     WHERE mes_referencia = r.mes_referencia;" ;;
  nao_marca_avisado) cegar_md5; sabotar "       SET avisado_em = p_agora
     WHERE mes_referencia = r.mes_referencia AND avisado_em IS NULL;" "       SET avisado_em = NULL
     WHERE mes_referencia = r.mes_referencia AND avisado_em IS NULL;" ;;
  sem_espera) cegar_md5;       sabotar "c_espera      constant interval := interval '15 minutes';" "c_espera      constant interval := interval '0 minutes';" ;;
  running_avisa) cegar_md5;    sabotar "     WHERE status = 'complete'
       AND avisado_em IS NULL" "     WHERE status IN ('complete', 'running')
       AND avisado_em IS NULL" ;;
  score_zero) cegar_md5;       sabotar "    IF v_score_lote = r.mes_referencia THEN" "    IF true THEN" ;;
  sem_denominador) cegar_md5;  sabotar "      || ' inéditos de ' || replace(to_char(r.total_recebido, c_fmt), ',', '.');" "      || ' inéditos';" ;;
  sairam_conta_descartado) cegar_md5; sabotar "       WHERE ultimo_lote = v_lote_ant
         AND prospeccao_status NOT IN ('descartado', 'virou_cliente');" "       WHERE ultimo_lote = v_lote_ant;" ;;
  baixas_zero_de_zero) cegar_md5; sabotar "    IF v_verificados = 0 THEN" "    IF false THEN" ;;
  sem_ledger) cegar_md5;       sabotar "  IF jsonb_array_length(v_lotes) > 0 THEN
    INSERT INTO public.acoes_execucoes" "  IF false THEN
    INSERT INTO public.acoes_execucoes" ;;
  retroativo)       sabotar "     AND mes_referencia < (SELECT max(mes_referencia) FROM public.radar_ingest_state WHERE status = 'complete');
  SELECT count(*) INTO v_pend" "     AND false;
  SELECT count(*) INTO v_pend" ;;
  retroativo_sem_post) sabotar "     AND mes_referencia < (SELECT max(mes_referencia) FROM public.radar_ingest_state WHERE status = 'complete');
  SELECT count(*) INTO v_pend" "     AND false;
  SELECT count(*) INTO v_pend"
                    sabotar "  IF v_pend <> 0 THEN" "  IF false THEN" ;;
  reapply_apaga_pendencia) sabotar "    RAISE NOTICE 'radar_ingest_state.avisado_em já existe — bootstrap pulado (pendências preservadas)';
    RETURN;" "    RAISE NOTICE 'bootstrap repetido';"
                    sabotar "  ALTER TABLE public.radar_ingest_state ADD COLUMN avisado_em timestamptz;" "  ALTER TABLE public.radar_ingest_state ADD COLUMN IF NOT EXISTS avisado_em timestamptz;" ;;
  score_rodada_errada) cegar_md5; sabotar "    IF v_score_lote = r.mes_referencia THEN" "    IF v_score_lote IS NOT NULL THEN" ;;
  sairam_acumula)   cegar_md5; sabotar "       WHERE ultimo_lote = v_lote_ant
         AND prospeccao_status NOT IN ('descartado', 'virou_cliente');" "       WHERE ultimo_lote < r.mes_referencia
         AND prospeccao_status NOT IN ('descartado', 'virou_cliente');" ;;
  acl_aberta)       sabotar "REVOKE ALL ON FUNCTION public.radar_avisar_lote(timestamptz) FROM PUBLIC, anon, authenticated;" "REVOKE ALL ON FUNCTION public.radar_avisar_lote(timestamptz) FROM anon;" ;;
  acl_aberta_sem_post) sabotar "REVOKE ALL ON FUNCTION public.radar_avisar_lote(timestamptz) FROM PUBLIC, anon, authenticated;" "REVOKE ALL ON FUNCTION public.radar_avisar_lote(timestamptz) FROM anon;"
                    sabotar "  IF has_function_privilege('anon', f, 'EXECUTE')
     OR has_function_privilege('authenticated', f, 'EXECUTE')
     OR has_function_privilege('public', f, 'EXECUTE') THEN" "  IF false THEN" ;;
  *) echo "sabotagem desconhecida: $SABOTAGEM"; exit 9 ;;
esac
[ -n "${SABOTAGEM:-}" ] && echo "⚠️  SABOTAGEM ATIVA: $SABOTAGEM"

"$PGBIN/initdb" -D "$DATA" -U postgres -E UTF8 --locale=C >/dev/null
"$PGBIN/pg_ctl" -D "$DATA" -o "-p $PORT -k /tmp" -l "$(dirname "$DATA")/pg.log" -w start >/dev/null
P()  { "$PGBIN/psql" -X -v ON_ERROR_STOP=1 -p "$PORT" -h /tmp -U postgres -d postgres "$@"; }
Pq() { P -qAt "$@"; }

# ── Esquema mínimo com os MESMOS CHECKs de prod ─────────────────────────────────────────────────────
P -q <<'SQL'
CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN; CREATE ROLE service_role NOLOGIN BYPASSRLS;
GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;
-- Espelha o default privilege do Supabase: relação e função novas NASCEM abertas (database.md §4/§5).
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON TABLES TO anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO anon, authenticated, service_role;
CREATE SCHEMA cron;
CREATE TABLE cron.job (jobid bigint PRIMARY KEY, jobname text, schedule text, command text, active boolean DEFAULT true,
  username text DEFAULT 'postgres', database text DEFAULT current_database());
CREATE FUNCTION cron.schedule(p_jobname text, p_schedule text, p_command text) RETURNS bigint LANGUAGE plpgsql AS $$
DECLARE v bigint;
BEGIN
  SELECT jobid INTO v FROM cron.job WHERE jobname = p_jobname;
  IF v IS NULL THEN
    SELECT COALESCE(max(jobid),0)+1 INTO v FROM cron.job;
    INSERT INTO cron.job (jobid, jobname, schedule, command, active) VALUES (v, p_jobname, p_schedule, p_command, true);
  ELSE
    UPDATE cron.job SET schedule = p_schedule, command = p_command WHERE jobid = v;
  END IF;
  RETURN v;
END $$;
CREATE TABLE public.radar_ingest_state (
  mes_referencia text PRIMARY KEY CHECK (mes_referencia ~ '^[0-9]{4}-[0-9]{2}$'),
  status text NOT NULL DEFAULT 'running',
  total_recebido integer NOT NULL DEFAULT 0,
  novos integer,
  iniciado_em timestamptz NOT NULL DEFAULT now(),
  finalizado_em timestamptz,
  erro text);
CREATE TABLE public.radar_empresas (
  cnpj text PRIMARY KEY CHECK (cnpj ~ '^[0-9A-Z]{12}[0-9]{2}$'),
  razao_social text,
  municipio_nome text,
  uf text,
  ultimo_lote text NOT NULL,
  ja_cliente boolean NOT NULL DEFAULT false,
  prospeccao_status text NOT NULL DEFAULT 'a_contatar'
    CHECK (prospeccao_status IN ('a_contatar','contatado_sem_resposta','em_conversa','descartado','virou_cliente')),
  primeira_vista_em timestamptz NOT NULL DEFAULT now(),
  score smallint,
  score_motivos text[],
  score_em timestamptz);
CREATE TABLE public.radar_situacao_cadastral (
  cnpj text NOT NULL CHECK (cnpj ~ '^[0-9A-Z]{12}[0-9]{2}$'),
  lote text NOT NULL,
  situacao text NOT NULL CHECK (situacao IN ('01','02','03','04','08')),
  data_situacao date, motivo_codigo text, motivo_descricao text,
  observado_em timestamptz NOT NULL DEFAULT now(), alertado_em timestamptz,
  PRIMARY KEY (cnpj, lote));
CREATE TABLE public.profiles (id uuid DEFAULT gen_random_uuid(), user_id uuid DEFAULT gen_random_uuid(), document text, name text, razao_social text);
CREATE TABLE public.omie_clientes_nao_vinculados (codigo text, cnpj_cpf text, razao_social text, nome_fantasia text);
CREATE TABLE public.fornecedor_alerta (
  id bigserial PRIMARY KEY,
  empresa text NOT NULL,
  tipo text NOT NULL CHECK (tipo IN ('promocao_suspensa','aumento_anunciado','promocao_nova','polling_erro','mapeamento_pendente','oportunidade','outro')),
  severidade text NOT NULL DEFAULT 'info' CHECK (severidade IN ('info','atencao','urgente')),
  titulo text NOT NULL,
  mensagem text,
  status text NOT NULL DEFAULT 'pendente_notificacao' CHECK (status IN ('pendente_notificacao','notificado','falha_notificacao','ignorado')),
  metadata jsonb,
  criado_em timestamptz NOT NULL DEFAULT now());
CREATE TABLE public.acoes_execucoes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  acao text NOT NULL,
  origem text NOT NULL DEFAULT 'manual' CHECK (origem IN ('manual','automatica')),
  executado_por uuid, executado_por_nome text,
  iniciado_em timestamptz NOT NULL DEFAULT now(),
  finalizado_em timestamptz,
  status text NOT NULL DEFAULT 'executando' CHECK (status IN ('executando','sucesso','erro')),
  detalhes jsonb);
SQL
P -q -f "$FN_DOCS"

# ── Seed ANTES do apply: o backfill da migration precisa encontrar lote antigo ───────────────────
# 2026-05 fechado há meses (nunca avisado) · 2026-08 fechado 19/10 16:40 (o 1º aviso real; novos=8 persistido)
# 2026-09 running mas com finalizado_em de uma rodada anterior (lote reaberto) — só o STATUS o protege.
P -q <<'SQL'
INSERT INTO public.radar_ingest_state (mes_referencia, status, total_recebido, novos, iniciado_em, finalizado_em) VALUES
  ('2026-05', 'complete', 90,  90,   '2026-06-12 01:05+00', '2026-06-13 11:52+00'),
  ('2026-08', 'complete', 100, 8,    '2026-10-19 16:31+00', '2026-10-19 16:40+00'),
  ('2026-09', 'running',  5,   NULL, '2026-10-20 03:00+00', '2026-10-20 03:30+00');
-- Rodada do score que ATRAVESSOU o fechamento de 2026-08 (começou com 2026-05 vigente, terminou depois):
-- NÃO conta como "score calculado" para 2026-08 (Codex P1 #4).
INSERT INTO public.acoes_execucoes (acao, origem, iniciado_em, finalizado_em, status, detalhes)
  VALUES ('radar.score_recalcular', 'automatica', '2026-10-19 16:38+00', '2026-10-19 16:41+00', 'sucesso', '{"lote_vigente":"2026-05"}'::jsonb);
-- Inéditos de 2026-08 (8): 6 leads na fila, 1 já cliente, 1 descartado — score ainda NÃO calculado.
INSERT INTO public.radar_empresas (cnpj, razao_social, municipio_nome, uf, ultimo_lote, ja_cliente, prospeccao_status, primeira_vista_em) VALUES
  ('11111111000101', 'Inedita Um',   'Belo Horizonte', 'MG', '2026-08', false, 'a_contatar', '2026-10-19 16:35+00'),
  ('11111111000102', 'Inedita Dois', 'Contagem',       'MG', '2026-08', false, 'a_contatar', '2026-10-19 16:35+00'),
  ('11111111000103', 'Inedita Tres', 'Betim',          'MG', '2026-08', false, 'a_contatar', '2026-10-19 16:35+00'),
  ('11111111000104', 'Inedita Qua',  'Ipatinga',       'MG', '2026-08', false, 'a_contatar', '2026-10-19 16:36+00'),
  ('11111111000105', 'Inedita Cin',  'Uberaba',        'MG', '2026-08', false, 'em_conversa', '2026-10-19 16:36+00'),
  ('11111111000106', 'Inedita Seis', 'Pompeu',         'MG', '2026-08', false, 'a_contatar', '2026-10-19 16:37+00'),
  ('11111111000107', 'Inedita Cli',  'Claudio',        'MG', '2026-08', true,  'a_contatar', '2026-10-19 16:37+00'),
  ('11111111000108', 'Inedita Desc', 'Divinopolis',    'MG', '2026-08', false, 'descartado', '2026-10-19 16:38+00');
-- Vigentes antigas em 2026-08 (não inéditas): vistas em 2026-06.
INSERT INTO public.radar_empresas (cnpj, razao_social, municipio_nome, uf, ultimo_lote, primeira_vista_em) VALUES
  ('22222222000101', 'Antiga Um',  'Juiz de Fora', 'MG', '2026-08', '2026-06-12 02:00+00'),
  ('22222222000102', 'Antiga Dois','Montes Claros','MG', '2026-08', '2026-06-12 02:00+00'),
  ('22222222000103', 'Antiga Tres','Uberlandia',   'MG', '2026-08', '2026-06-12 02:00+00');
-- Saíram do dump (ultimo_lote 2026-05): 3 seguem na base, 1 descartada (não conta), 1 delas é cliente (conta).
INSERT INTO public.radar_empresas (cnpj, razao_social, municipio_nome, uf, ultimo_lote, ja_cliente, prospeccao_status, primeira_vista_em) VALUES
  ('33333333000101', 'Sumida Um',   'Sete Lagoas', 'MG', '2026-05', false, 'a_contatar', '2026-06-12 02:00+00'),
  ('33333333000102', 'Sumida Dois', 'Lavras',      'MG', '2026-05', true,  'a_contatar', '2026-06-12 02:00+00'),
  ('33333333000103', 'Sumida Tres', 'Varginha',    'MG', '2026-05', false, 'em_conversa', '2026-06-12 02:00+00'),
  ('33333333000104', 'Sumida Desc', 'Pocos',       'MG', '2026-05', false, 'descartado', '2026-06-12 02:00+00');
-- Situação cadastral do lote 2026-08: cliente do radar baixado (08), cliente Omie FORA do radar ativo (02),
-- lead inapto (04) — lead não entra no "K de M" (só clientes).
INSERT INTO public.omie_clientes_nao_vinculados (codigo, cnpj_cpf, razao_social) VALUES ('c1', '44.444.444/0001-01', 'Cliente Omie');
INSERT INTO public.radar_situacao_cadastral (cnpj, lote, situacao) VALUES
  ('33333333000102', '2026-08', '08'),
  ('44444444000101', '2026-08', '02'),
  ('33333333000101', '2026-08', '04');
SQL

# ── Apply da migration (postcondição DO $post$ roda aqui) ──────────────────────────────────────
P -q -f "$MIG_USADA"

PASS=0; FAIL=0
eq() { if [ "$2" = "$3" ]; then echo "PASS $1"; PASS=$((PASS+1)); else echo "FAIL $1 — obtido [$2] esperado [$3]"; FAIL=$((FAIL+1)); fi; }
contem() { case "$1" in *"$2"*) echo "sim";; *) echo "NAO";; esac; }

# ── Backfill: lote antigo marcado, o mais recente livre, running intocado ─────────────────────────
eq "A1 backfill: 2026-05 avisado_em=finalizado_em · 2026-08 NULL · 2026-09 NULL" \
   "$(Pq -c "SELECT string_agg(mes_referencia||'='||COALESCE((avisado_em = finalizado_em)::text, 'null'), ' ' ORDER BY mes_referencia) FROM public.radar_ingest_state;")" \
   "2026-05=true 2026-08=null 2026-09=null"

# ── Espera de 15 min: fechado há 10 min → nada ───────────────────────────────────────────────────
eq "A2 lote fechado há 10 min: zero avisos, avisado_em segue NULL" \
   "$(Pq -c "SELECT ((public.radar_avisar_lote('2026-10-19 16:50+00'))->>'avisados') || ' ' || (SELECT count(*) FROM public.fornecedor_alerta) || ' ' || (SELECT count(*) FROM public.radar_ingest_state WHERE mes_referencia='2026-08' AND avisado_em IS NULL);")" \
   "0 0 1"

# ── Erro PROPAGA e nada fica pela metade (alerta + avisado_em + ledger numa transação) ───────────
Pq -c "CREATE FUNCTION public.t_boom() RETURNS trigger LANGUAGE plpgsql AS \$\$ BEGIN RAISE EXCEPTION 'boom simulado' USING ERRCODE='P0001'; END \$\$;
       CREATE TRIGGER t_boom BEFORE INSERT ON public.fornecedor_alerta FOR EACH ROW EXECUTE FUNCTION public.t_boom();" >/dev/null
if SAIDA="$(Pq -c "SELECT public.radar_avisar_lote('2026-10-19 17:00+00');" 2>&1)"; then RC="verde"; else RC="vermelho"; fi
case "$SAIDA" in *"boom simulado"*) M="P0001";; *) M="outro:$SAIDA";; esac
eq "A3 fornecedor_alerta falhando: a função fica VERMELHA com o erro original" "$RC $M" "vermelho P0001"
eq "A3b … e não deixa meio-estado (0 alertas, avisado_em NULL, 0 ledger)" \
   "$(Pq -c "SELECT (SELECT count(*) FROM public.fornecedor_alerta)||' '||(SELECT count(*) FROM public.radar_ingest_state WHERE mes_referencia='2026-08' AND avisado_em IS NULL)||' '||(SELECT count(*) FROM public.acoes_execucoes WHERE acao='radar.avisar_lote');")" \
   "0 1 0"
Pq -c "DROP TRIGGER t_boom ON public.fornecedor_alerta; DROP FUNCTION public.t_boom();" >/dev/null

# ── 1º aviso real: lote 2026-08 fechado há 20 min, score AINDA não rodou ─────────────────────────
R1="$(Pq -c "SELECT public.radar_avisar_lote('2026-10-19 17:00+00');")"
eq "A4 retorno: 1 lote avisado, com os números" \
   "$(printf '%s' "$R1" | python3 -I -c "import json,sys; d=json.load(sys.stdin); l=d['lotes'][0]; print(d['avisados'], l['lote'], l['ineditos'], l['ineditos_foto'], l['ineditos_fila'], l['total'], l['sairam'], l['lote_anterior'], l['total_anterior'], l['clientes_baixa'], l['clientes_verificados'], l['score'], l['score_lote'], l['score_alvo'])")" \
   "1 2026-08 8 8 6 100 3 2026-05 90 1 2 pendente 2026-05 None"
TIT="$(Pq -c "SELECT titulo FROM public.fornecedor_alerta ORDER BY id DESC LIMIT 1;")"
eq "A4a título com denominador" "$TIT" "[Radar] lote 2026-08: 8 inéditos de 100"
CORPO="$(Pq -c "SELECT mensagem FROM public.fornecedor_alerta ORDER BY id DESC LIMIT 1;")"
eq "A4b corpo: inéditos 8 de 100 (6 na fila) · saíram 3 de 90 (2026-05) · baixas 1 de 2 com link" \
   "$(contem "$CORPO" "Inéditos: 8 de 100 empresas recebidas (6 na fila") $(contem "$CORPO" "Saíram do dump: 3 de 90 empresas do lote anterior (2026-05)") $(contem "$CORPO" "suspensão: 1 de 2 clientes verificados neste lote → https://steu.lovable.app/radar")" \
   "sim sim sim"
eq "A4c score pendente: texto diz pendente e NUNCA '0 de 8'" \
   "$(contem "$CORPO" "Score: pendente") $(contem "$CORPO" "0 de 8") $(contem "$CORPO" "Top 10")" \
   "sim NAO NAO"
eq "A5 alerta no canal do gestor: oben/outro/info/pendente_notificacao + metadata.origem" \
   "$(Pq -c "SELECT empresa||' '||tipo||' '||severidade||' '||status||' '||(metadata->>'origem')||' '||(metadata->>'lote') FROM public.fornecedor_alerta ORDER BY id DESC LIMIT 1;")" \
   "oben outro info pendente_notificacao radar_avisar_lote 2026-08"
eq "A5b avisado_em = p_agora do lote 2026-08" \
   "$(Pq -c "SELECT avisado_em = '2026-10-19 17:00+00' FROM public.radar_ingest_state WHERE mes_referencia='2026-08';")" "t"

# ── Não repete: 2ª rodada (mesmo dia e dias depois) → zero ───────────────────────────────────────
eq "A6 2ª rodada: zero avisos, 1 alerta no total, avisado_em intacto" \
   "$(Pq -c "SELECT ((public.radar_avisar_lote('2026-10-19 17:30+00'))->>'avisados') || ' ' || ((public.radar_avisar_lote('2026-10-25 06:45+00'))->>'avisados') || ' ' || (SELECT count(*) FROM public.fornecedor_alerta) || ' ' || (SELECT (avisado_em AT TIME ZONE 'UTC')::text FROM public.radar_ingest_state WHERE mes_referencia='2026-08');")" \
   "0 0 1 2026-10-19 17:00:00"

# ── Lote running (mesmo com finalizado_em antigo) → nada ──────────────────────────────────────────
eq "A8 lote 2026-09 running: zero avisos dias depois" \
   "$(Pq -c "SELECT ((public.radar_avisar_lote('2026-10-30 06:45+00'))->>'avisados') || ' ' || (SELECT count(*) FROM public.fornecedor_alerta WHERE metadata->>'lote'='2026-09');")" \
   "0 0"

# ── Lote 2026-09 fecha; score roda DEPOIS (ledger) → ranking + P de N; sem foto RFB → "não verificada" ─
P -q <<'SQL'
UPDATE public.radar_ingest_state SET status='complete', total_recebido=50, finalizado_em='2026-10-26 09:00+00' WHERE mes_referencia='2026-09';
INSERT INTO public.radar_empresas (cnpj, razao_social, municipio_nome, uf, ultimo_lote, ja_cliente, prospeccao_status, primeira_vista_em, score, score_motivos, score_em) VALUES
  ('55555555000101', 'Nova Alta',   'Claudio',  'MG', '2026-09', false, 'a_contatar', '2026-10-26 08:00+00', 83, ARRAY['CNAE prioritário','porte ME','capital alto'], '2026-10-27 06:31+00'),
  ('55555555000102', 'Nova Media',  'Pompeu',   'MG', '2026-09', false, 'a_contatar', '2026-10-26 08:00+00', 70, ARRAY['porte ME'], '2026-10-27 06:31+00'),
  ('55555555000103', 'Nova Baixa',  'Betim',    'MG', '2026-09', false, 'a_contatar', '2026-10-26 08:00+00', 40, ARRAY['porte MEI','sem telefone'], '2026-10-27 06:31+00'),
  ('55555555000104', 'Nova Null',   'Ipatinga', 'MG', '2026-09', false, 'a_contatar', '2026-10-26 08:00+00', NULL, ARRAY['dado insuficiente'], '2026-10-27 06:31+00'),
  ('55555555000105', 'Nova Cliente','Uberaba',  'MG', '2026-09', true,  'a_contatar', '2026-10-26 08:00+00', NULL, ARRAY['já cliente'], '2026-10-27 06:31+00');
-- Saíram em 2026-09 = vigentes EXATAMENTE em 2026-08 (8 inéditas + 3 antigas, 1 descartada → 10); as 3 de 2026-05 NÃO somam (Codex P1 #3).
INSERT INTO public.acoes_execucoes (acao, origem, iniciado_em, finalizado_em, status, detalhes)
  VALUES ('radar.score_recalcular', 'automatica', '2026-10-27 06:30+00', '2026-10-27 06:31:40+00', 'sucesso', '{"lote_vigente":"2026-09"}'::jsonb);
SQL
R2="$(Pq -c "SELECT public.radar_avisar_lote('2026-10-27 06:45+00');")"
eq "A9 lote 2026-09 (novos NULL → foto): 5 inéditos (4 na fila) de 50 · saíram 10 de 100 · score calculado: 2 ≥ 70 · 2 sem score (lead sem dado + cliente)" \
   "$(printf '%s' "$R2" | python3 -I -c "import json,sys; d=json.load(sys.stdin); l=d['lotes'][0]; print(d['avisados'], l['lote'], l['ineditos'], l['ineditos_fila'], l['sairam'], l['total_anterior'], l['clientes_verificados'], l['score'], l['score_lote'], l['score_alvo'], l['sem_score'])")" \
   "1 2026-09 5 4 10 100 0 calculado 2026-09 2 2"
CORPO2="$(Pq -c "SELECT mensagem FROM public.fornecedor_alerta WHERE metadata->>'lote'='2026-09';")"
eq "A10 corpo: 'Score ≥ 70: 2 de 5 inéditos (2 sem score' e Top 10 presente" \
   "$(contem "$CORPO2" "Score ≥ 70: 2 de 5 inéditos (2 sem score") $(contem "$CORPO2" "Top 10 inéditos por score:") $(contem "$CORPO2" "pendente")" \
   "sim sim NAO"
eq "A10b top: ordem por score desc, razão social (município/UF), 2 motivos no máximo, cliente e sem-score fora" \
   "$(printf '%s' "$CORPO2" | grep -E '^ *[0-9]+\. ' | sed -E 's/ +/ /g' | tr '\n' '|')" \
   " 1. Nova Alta (Claudio/MG) — score 83 — CNAE prioritário; porte ME| 2. Nova Media (Pompeu/MG) — score 70 — porte ME| 3. Nova Baixa (Betim/MG) — score 40 — porte MEI; sem telefone|"
eq "A10c sem cliente na foto RFB do lote: 'nenhum cliente … verificada', nunca '0 de 0'" \
   "$(contem "$CORPO2" "nenhum cliente com situação cadastral verificada neste lote") $(contem "$CORPO2" "0 de 0")" \
   "sim NAO"

# ── Ledger: 1 linha por rodada que avisou (2), nenhuma nas rodadas vazias ─────────────────────────
eq "A11 ledger radar.avisar_lote: 2 linhas automatica/sucesso, detalhes com lote e alerta_id" \
   "$(Pq -c "SELECT count(*)||' '||string_agg(origem||'/'||status, ',')||' '||string_agg(detalhes->'lotes'->0->>'lote', ',' ORDER BY iniciado_em)||' '||bool_and((detalhes->'lotes'->0->>'alerta_id') IS NOT NULL) FROM public.acoes_execucoes WHERE acao='radar.avisar_lote';")" \
   "2 automatica/sucesso,automatica/sucesso 2026-08,2026-09 true"

# ── Entrada inválida, ACL, cron ───────────────────────────────────────────────────────────────────
if SAIDA="$(Pq -c "SELECT public.radar_avisar_lote(NULL);" 2>&1)"; then RC="verde"; else RC="vermelho"; fi
case "$SAIDA" in *"p_agora"*) M="22023";; *) M="outro";; esac
eq "A12 p_agora NULL falha alto" "$RC $M" "vermelho 22023"
eq "A13 anon/authenticated/PUBLIC sem EXECUTE; service_role com" \
   "$(Pq -c "SELECT has_function_privilege('anon', 'public.radar_avisar_lote(timestamptz)', 'EXECUTE')::text||has_function_privilege('authenticated', 'public.radar_avisar_lote(timestamptz)', 'EXECUTE')::text||has_function_privilege('public', 'public.radar_avisar_lote(timestamptz)', 'EXECUTE')::text||has_function_privilege('service_role', 'public.radar_avisar_lote(timestamptz)', 'EXECUTE')::text;")" \
   "falsefalsefalsetrue"
if SAIDA="$(Pq -c "SET ROLE authenticated; SELECT public.radar_avisar_lote();" 2>&1)"; then RC="verde"; else RC="vermelho"; fi
case "$SAIDA" in *"permission denied"*) M="42501";; *) M="outro:$SAIDA";; esac
eq "A13b authenticated executando: permission denied (42501)" "$RC $M" "vermelho 42501"
eq "A14 cron radar-avisar-lote-diario 45 6 * * * chamando a função, ativo; re-apply não duplica" \
   "$(P -q -f "$MIG_USADA" >/dev/null 2>&1; Pq -c "SELECT count(*)||' '||min(schedule)||' '||min(command)||' '||bool_and(active)||' '||min(username)||' '||bool_and(database=current_database()) FROM cron.job WHERE jobname='radar-avisar-lote-diario';")" \
   "1 45 6 * * * SELECT public.radar_avisar_lote(); true postgres true"
P -q <<'SQL'
INSERT INTO public.radar_ingest_state (mes_referencia, status, total_recebido, novos, iniciado_em, finalizado_em) VALUES
  ('2026-10', 'complete', 7, 0, '2026-11-16 06:00+00', '2026-11-16 08:00+00'),
  ('2026-11', 'complete', 7, 0, '2026-12-14 06:00+00', '2026-12-14 08:00+00');
SQL
eq "A14c re-apply com 2 lotes pendentes (2026-10 fechou antes de 2026-11): nenhum é apagado pelo bootstrap" \
   "$(P -q -f "$MIG_USADA" >/dev/null 2>&1; Pq -c "SELECT count(*) FROM public.radar_ingest_state WHERE avisado_em IS NULL;")" \
   "2"
Pq -c "DELETE FROM public.radar_ingest_state WHERE mes_referencia IN ('2026-10','2026-11');" >/dev/null
eq "A14b re-apply da migration não reabre aviso nem duplica alerta" \
   "$(Pq -c "SELECT (SELECT count(*) FROM public.fornecedor_alerta)||' '||(SELECT count(*) FROM public.radar_ingest_state WHERE avisado_em IS NULL);")" \
   "2 0"

echo "PASS=$PASS FAIL=$FAIL"
[ "$FAIL" -eq 0 ]
