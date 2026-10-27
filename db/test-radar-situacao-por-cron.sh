#!/usr/bin/env bash
# Prova PG17 da SITUAÇÃO CADASTRAL aplicada por JOB — migration 20261027010000_radar_situacao_por_cron:
# `radar_aplicar_situacao_pendente(p_agora)` (entrypoint do cron 06:05 UTC) aplica a situação RFB do lote
# `complete` pendente UMA vez (re-rodar = no-op), re-aplica quando o lote é re-finalizado (chave =
# finalizado_em, nunca comparação de relógios), só aplica o lote MAIS NOVO (pendente mais velho = superado,
# sem descartar lead que o lote novo diz ativo), propaga erro sem marcar; `radar_avisar_lote` não avisa antes
# da aplicação e, 30 h sem ela, avisa com severidade 'atencao' dizendo que NÃO foi aplicada.
# Aplica as 3 migrations INTEIRAS em ordem (20261019200000 → 20261020143000 → esta), com suas postcondições.
# Relógio controlado por `p_agora`. Esquema mínimo com os CHECKs de prod.
#
#   bash db/test-radar-situacao-por-cron.sh > /tmp/t.log 2>&1; echo "exit=$?"
#   SABOTAGEM=<nome> bash db/test-radar-situacao-por-cron.sh   # tem de ficar VERMELHA
#   bash db/test-radar-situacao-por-cron.sh --falsificar        # controle verde + cada sabotagem vermelha no assert dela
#   LOCALE_TESTE=pt_BR.UTF-8 bash db/test-radar-situacao-por-cron.sh   # mesma prova sob locale pt_BR (CLAUDE.md: os DOIS)
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MIG="$REPO_ROOT/supabase/migrations/20261027010000_radar_situacao_por_cron.sql"
MIG_SIT="$REPO_ROOT/supabase/migrations/20261019200000_radar_situacao_cadastral.sql"
MIG_AVISO="$REPO_ROOT/supabase/migrations/20261020143000_radar_avisar_lote.sql"

if [ "${1:-}" = "--falsificar" ]; then
  # <sabotagem>:<assert que TEM de acusá-la> — `POST!P3_FALHOU` = a POSTCONDIÇÃO da própria migration
  # (DO $post$/$boot$) aborta o apply com a marca exata (`_` vira espaço; grep -F). `_sem_post` cega essa
  # camada para provar que o assert da suíte pega sozinho (uma camada por vez).
  SABOTAGENS="corpo_divergente:POST!P5_FALHOU aplica_superado:C9a sem_chave:C8a repete:C6a engole_erro:C11a aviso_antes:C4 aviso_mudo:C10b aviso_sem_alarme:C10c bootstrap_falta:POST!B1_FALHOU bootstrap_falta_sem_post:C1 acl_aberta:POST!P3_FALHOU acl_aberta_sem_post:C12 cron_sem_timeout:POST!P7_FALHOU cron_sem_timeout_sem_post:C13"
  LOGDIR="$(mktemp -d "${TMPDIR:-/tmp}/falsifica-radar-sit-cron.XXXXXX")"
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
      *!*) marca="${a#*!}"; marca="${marca//_/ }"; modo="-qF" ;;
      *)   marca="FAIL $a "; modo="-q" ;;
    esac
    if grep "$modo" -- "$marca" "$LOGDIR/$s.log"; then
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
PORT="${PGPORT_TEST:-5494}"
DATA="$(mktemp -d "${TMPDIR:-/tmp}/pgtest-radar-sit-cron.XXXXXX")/data"
LOCALE_TESTE="${LOCALE_TESTE:-C}"
export LC_ALL="$LOCALE_TESTE" LANG="$LOCALE_TESTE"
MIG_USADA="$(dirname "$DATA")/mig.sql"
cleanup() { "$PGBIN/pg_ctl" -D "$DATA" stop -m immediate >/dev/null 2>&1 || true; rm -rf "$(dirname "$DATA")"; }
trap cleanup EXIT

cp "$MIG" "$MIG_USADA"
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
# Sabotagem no CORPO de função muda o prosrc → P5/P6 (md5) pegariam antes da suíte; cada sabotagem de corpo
# cega os dois (uma camada por vez) e `corpo_divergente` prova que o md5 pega sozinho.
cegar_md5() { sabotar "  IF v_md5 IS DISTINCT FROM '" "  IF false AND v_md5 IS DISTINCT FROM '"; }
CRON_OK="\$\$SET statement_timeout = '30min'; SELECT public.radar_aplicar_situacao_pendente();\$\$"
CRON_RUIM="\$\$SELECT public.radar_aplicar_situacao_pendente();\$\$"
case "${SABOTAGEM:-}" in
  "") ;;
  corpo_divergente) sabotar "  v_aplicados  integer := 0;" "  v_aplicados  integer := 00;" ;;
  aplica_superado) cegar_md5; sabotar "    IF r.mes_referencia = v_mais_novo THEN" "    IF true THEN" ;;
  sem_chave)       cegar_md5; sabotar "       AND situacao_aplicada_fechamento IS DISTINCT FROM finalizado_em
     ORDER BY mes_referencia" "       AND situacao_aplicada_em IS NULL
     ORDER BY mes_referencia" ;;
  repete)          cegar_md5; sabotar "       SET situacao_aplicada_fechamento = r.finalizado_em, situacao_aplicada_em = p_agora," "       SET situacao_aplicada_fechamento = NULL, situacao_aplicada_em = p_agora," ;;
  engole_erro)     cegar_md5; sabotar "      v_res := public.radar_aplicar_situacao(r.mes_referencia, p_agora);" "      BEGIN
        v_res := public.radar_aplicar_situacao(r.mes_referencia, p_agora);
      EXCEPTION WHEN OTHERS THEN
        v_res := jsonb_build_object('erro', SQLERRM);
      END;" ;;
  aviso_antes)     cegar_md5; sabotar "       AND (situacao_aplicada_fechamento = finalizado_em OR finalizado_em <= p_agora - c_espera_sit)
" "" ;;
  aviso_mudo)      cegar_md5; sabotar "OR finalizado_em <= p_agora - c_espera_sit)" "OR false)" ;;
  aviso_sem_alarme) cegar_md5; sabotar "CASE WHEN v_sit_aplicada THEN 'info' ELSE 'atencao' END" "'info'" ;;
  bootstrap_falta) sabotar "   WHERE status = 'complete' AND finalizado_em IS NOT NULL;
  SELECT count(*) INTO v_pend" "   WHERE false;
  SELECT count(*) INTO v_pend" ;;
  bootstrap_falta_sem_post) sabotar "   WHERE status = 'complete' AND finalizado_em IS NOT NULL;
  SELECT count(*) INTO v_pend" "   WHERE false;
  SELECT count(*) INTO v_pend"
                   sabotar "  IF v_pend IS DISTINCT FROM 0 THEN" "  IF false THEN" ;;
  acl_aberta)      sabotar "FROM PUBLIC, anon, authenticated, service_role;" "FROM anon;" ;;
  acl_aberta_sem_post) sabotar "FROM PUBLIC, anon, authenticated, service_role;" "FROM anon;"
                   sabotar "  IF has_function_privilege('anon', f_pend, 'EXECUTE')" "  IF false AND has_function_privilege('anon', f_pend, 'EXECUTE')" ;;
  cron_sem_timeout) sabotar "$CRON_OK" "$CRON_RUIM" ;;
  cron_sem_timeout_sem_post) sabotar "$CRON_OK" "$CRON_RUIM"
                   sabotar "  IF NOT EXISTS (SELECT 1 FROM cron.job
                  WHERE jobname = 'radar-aplicar-situacao-diario'" "  IF false AND NOT EXISTS (SELECT 1 FROM cron.job
                  WHERE jobname = 'radar-aplicar-situacao-diario'" ;;
  *) echo "sabotagem desconhecida: $SABOTAGEM"; exit 9 ;;
esac
[ -n "${SABOTAGEM:-}" ] && echo "⚠️  SABOTAGEM ATIVA: $SABOTAGEM"

"$PGBIN/initdb" -D "$DATA" -U postgres -E UTF8 --locale="$LOCALE_TESTE" >/dev/null
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
CREATE SCHEMA auth;
CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE
  AS $$ SELECT NULLIF(current_setting('test.uid', true), '')::uuid $$;
CREATE FUNCTION public.pode_ver_carteira_completa(p uuid) RETURNS boolean
  LANGUAGE sql STABLE SECURITY DEFINER AS $$ SELECT false $$;
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
  cnae_principal text NOT NULL DEFAULT '2071100',
  ultimo_lote text NOT NULL DEFAULT '2026-09',
  ja_cliente boolean NOT NULL DEFAULT false,
  prospeccao_status text NOT NULL DEFAULT 'a_contatar'
    CHECK (prospeccao_status IN ('a_contatar','contatado_sem_resposta','em_conversa','descartado','virou_cliente')),
  prospeccao_atualizado_em timestamptz,
  descarte_motivo text,
  primeira_vista_em timestamptz NOT NULL DEFAULT '2026-06-12 02:00+00',
  score smallint,
  score_motivos text[],
  updated_at timestamptz NOT NULL DEFAULT '2026-09-01 00:00+00');
CREATE TABLE public.radar_contatos (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  cnpj text NOT NULL REFERENCES public.radar_empresas(cnpj) ON DELETE CASCADE CHECK (cnpj ~ '^[0-9A-Z]{12}[0-9]{2}$'),
  acao text NOT NULL CHECK (acao IN ('contatado_sem_resposta','em_conversa','descartado','virou_cliente','a_contatar')),
  nota text,
  criado_por uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  status_anterior text);
CREATE TABLE public.profiles (id uuid DEFAULT gen_random_uuid(), user_id uuid DEFAULT gen_random_uuid(), document text, name text, razao_social text);
CREATE TABLE public.omie_clientes_nao_vinculados (codigo text, cnpj_cpf text, razao_social text, nome_fantasia text);
CREATE TABLE public.fornecedor_alerta (
  id bigserial PRIMARY KEY,
  empresa text NOT NULL,
  tipo text NOT NULL CHECK (tipo IN ('promocao_suspensa','aumento_anunciado','promocao_nova','polling_erro','mapeamento_pendente','oportunidade_calculada','tarefa_atrasada','whatsapp_sla','erro_app','outro','param_auto_resumo','reposicao_pedido_minimo')),
  severidade text NOT NULL DEFAULT 'info' CHECK (severidade IN ('info','atencao','urgente')),
  titulo text NOT NULL,
  mensagem text,
  status text DEFAULT 'pendente_notificacao' CHECK (status IN ('pendente_notificacao','notificado','falha_notificacao','ignorado')),
  metadata jsonb,
  criado_em timestamptz DEFAULT now());
CREATE TABLE public.acoes_execucoes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  acao text NOT NULL,
  origem text NOT NULL DEFAULT 'manual' CHECK (origem IN ('manual','automatica')),
  executado_por uuid, executado_por_nome text,
  iniciado_em timestamptz NOT NULL DEFAULT now(),
  finalizado_em timestamptz,
  status text NOT NULL DEFAULT 'executando' CHECK (status IN ('executando','sucesso','erro')),
  detalhes jsonb);
ALTER TABLE public.radar_empresas ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.radar_contatos ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.fornecedor_alerta ENABLE ROW LEVEL SECURITY;
SQL

# ── Estado de prod antes do apply: 2026-08 e 2026-09 complete (09 aplicado à mão, já avisado) ─────────
P -q <<'SQL'
INSERT INTO public.radar_ingest_state (mes_referencia, status, total_recebido, novos, iniciado_em, finalizado_em) VALUES
  ('2026-08', 'complete', 100, 8,  '2026-10-19 16:31+00', '2026-10-19 16:40+00'),
  ('2026-09', 'complete', 100, 10, '2026-10-21 16:09+00', '2026-10-21 17:10+00');
SQL
P -q -f "$MIG_SIT" >/dev/null
P -q -f "$MIG_AVISO" >/dev/null
Pq -c "UPDATE public.radar_ingest_state SET avisado_em = '2026-10-22 06:45+00' WHERE mes_referencia = '2026-09';" >/dev/null

# ── Apply desta migration (bootstrap + postcondição) e re-apply (idempotente) ─────────────────────────
P -q -f "$MIG_USADA" >/dev/null
P -q -f "$MIG_USADA" >/dev/null

PASS=0; FAIL=0
eq() { if [ "$2" = "$3" ]; then echo "PASS $1"; PASS=$((PASS+1)); else echo "FAIL $1 — obtido [$2] esperado [$3]"; FAIL=$((FAIL+1)); fi; }
job()   { Pq -c "SELECT public.radar_aplicar_situacao_pendente('$1'::timestamptz);"; }
avisar(){ Pq -c "SELECT (public.radar_avisar_lote('$1'::timestamptz))->>'avisados';"; }
estado(){ Pq -c "SELECT prospeccao_status||'|'||coalesce(rfb_situacao,'-')||'|'||coalesce(rfb_situacao_lote,'-') FROM public.radar_empresas WHERE cnpj='$1';"; }
marca() { Pq -c "SELECT coalesce((situacao_aplicada_fechamento = finalizado_em)::text,'null') FROM public.radar_ingest_state WHERE mes_referencia='$1';"; }
n_alertas(){ Pq -c "SELECT count(*) FROM public.fornecedor_alerta WHERE metadata->>'origem' = '$1';"; }
n_ledger() { Pq -c "SELECT count(*) FROM public.acoes_execucoes WHERE acao = 'radar.aplicar_situacao';"; }

# C1 — bootstrap: os lotes já fechados nascem marcados (nenhum é reaplicado pelo 1º job).
eq "C1 bootstrap marca 2026-08 e 2026-09 (chave = finalizado_em, resultado bootstrap)" \
   "$(Pq -c "SELECT string_agg(mes_referencia||':'||coalesce((situacao_aplicada_fechamento = finalizado_em)::text,'null')||':'||coalesce(situacao_resultado->>'bootstrap','-'), ',' ORDER BY mes_referencia) FROM public.radar_ingest_state;")" \
   "2026-08:true:true,2026-09:true:true"
eq "C2 job sem pendência = 0 aplicados, 0 marcados, sem ledger" "$(job '2026-10-26 06:05+00')" '{"lotes": [], "marcados": 0, "aplicados": 0}'
eq "C2b sem pendência não grava ledger" "$(n_ledger)" "0"

# ── Lote 2026-10: chunks entram (running) ──────────────────────────────────────────────────────────
# L1 lead baixado (08) · L2 lead ativo (02) · C cliente Omie fora do radar inapto (04) · K cliente do radar ativo
P -q <<'SQL'
INSERT INTO public.radar_ingest_state (mes_referencia, status, iniciado_em) VALUES ('2026-10', 'running', '2026-10-26 06:00+00');
INSERT INTO public.radar_empresas (cnpj, razao_social, ultimo_lote) VALUES
  ('11111111000101', 'Lead Baixado', '2026-10'),
  ('11111111000102', 'Lead Ativo',   '2026-10'),
  ('11111111000103', 'Cliente Radar','2026-10');
UPDATE public.radar_empresas SET ja_cliente = true WHERE cnpj = '11111111000103';
INSERT INTO public.omie_clientes_nao_vinculados (codigo, cnpj_cpf, razao_social) VALUES ('c1', '44.444.444/0001-01', 'Cliente Omie');
INSERT INTO public.radar_situacao_cadastral (cnpj, lote, situacao, data_situacao) VALUES
  ('11111111000101', '2026-10', '08', '2026-09-30'),
  ('11111111000102', '2026-10', '02', NULL),
  ('11111111000103', '2026-10', '02', NULL),
  ('44444444000101', '2026-10', '04', '2026-09-15');
SQL
eq "C3 lote running não é aplicado" "$(job '2026-10-26 07:00+00' | python3 -I -c 'import json,sys;print(json.load(sys.stdin)["marcados"])')" "0"
eq "C3b lead baixado segue na fila enquanto o lote está running" "$(estado 11111111000101)" "a_contatar|-|-"

# finalize da edge v1.3: complete + finalizado_em, SEM aplicar.
Pq -c "UPDATE public.radar_ingest_state SET status='complete', total_recebido=3, novos=3, finalizado_em='2026-10-26 10:00+00' WHERE mes_referencia='2026-10';" >/dev/null
eq "C4 aviso NÃO sai antes da aplicação (26/10 11:00, 1 h após o fechamento)" "$(avisar '2026-10-26 11:00+00')" "0"
eq "C4b marca do 2026-10 ainda pendente" "$(marca 2026-10)" "null"

# Job da manhã seguinte.
R="$(job '2026-10-27 06:05+00')"
eq "C5 job aplica o lote pendente (1 aplicado, 1 marcado)" "$(printf '%s' "$R" | python3 -I -c 'import json,sys;d=json.load(sys.stdin);print(d["aplicados"],d["marcados"],d["lotes"][0]["lote"],d["lotes"][0]["leads_descartados"],d["lotes"][0]["clientes_alertados_novos"])')" "1 1 2026-10 1 1"
eq "C5a lead 08 descartado com a foto do lote" "$(estado 11111111000101)" "descartado|08|2026-10"
eq "C5b lead 02 intocado (só a foto)" "$(estado 11111111000102)" "a_contatar|02|2026-10"
eq "C5c 1 alerta de cliente irregular (cliente Omie fora do radar)" "$(n_alertas radar_situacao_cadastral)" "1"
eq "C5d marca = finalizado_em e resultado gravado" "$(Pq -c "SELECT (situacao_aplicada_fechamento = finalizado_em)::text||'|'||(situacao_aplicada_em = '2026-10-27 06:05+00')::text||'|'||(situacao_resultado->>'leads_descartados') FROM public.radar_ingest_state WHERE mes_referencia='2026-10';")" "true|true|1"
eq "C5e 1 linha de ledger radar.aplicar_situacao (automatica/sucesso)" "$(Pq -c "SELECT count(*)||'|'||min(origem)||'|'||min(status) FROM public.acoes_execucoes WHERE acao='radar.aplicar_situacao';")" "1|automatica|sucesso"

# C6 — re-rodar = no-op: nada aplicado, nada novo em contatos/alertas/ledger.
R="$(job '2026-10-27 07:05+00')"
eq "C6a re-rodar o job = 0 aplicados, 0 marcados" "$(printf '%s' "$R" | python3 -I -c 'import json,sys;d=json.load(sys.stdin);print(d["aplicados"],d["marcados"])')" "0 0"
eq "C6b re-rodar não duplica contato de sistema nem alerta nem ledger" "$(Pq -c "SELECT (SELECT count(*) FROM public.radar_contatos)||'|'||(SELECT count(*) FROM public.fornecedor_alerta WHERE metadata->>'origem'='radar_situacao_cadastral')||'|'||(SELECT count(*) FROM public.acoes_execucoes WHERE acao='radar.aplicar_situacao');")" "1|1|1"

# C7 — aviso das 06:45: sai depois da aplicação, info, sem a linha de ATENÇÃO.
eq "C7 aviso sai depois da aplicação" "$(avisar '2026-10-27 06:45+00')" "1"
eq "C7a aviso info, situacao_aplicada=true, sem ATENÇÃO, com a linha de baixas" \
   "$(Pq -c "SELECT severidade||'|'||(metadata->>'situacao_aplicada')||'|'||(position('NÃO foi aplicada' in mensagem) > 0)::text||'|'||(position('Clientes com baixa/inaptidão/suspensão: 1 de 2 clientes' in mensagem) > 0)::text FROM public.fornecedor_alerta WHERE metadata->>'origem'='radar_avisar_lote' AND metadata->>'lote'='2026-10';")" \
   "info|true|false|true"

# C8 — lote re-finalizado (re-carga): a chave muda → o job reaplica (idempotente: 0 leads, 0 alertas novos).
Pq -c "UPDATE public.radar_ingest_state SET finalizado_em='2026-10-27 09:00+00' WHERE mes_referencia='2026-10';" >/dev/null
R="$(job '2026-10-28 06:05+00')"
eq "C8a re-finalize é reaplicado (1 aplicado; 0 leads e 0 alertas novos)" "$(printf '%s' "$R" | python3 -I -c 'import json,sys;d=json.load(sys.stdin);print(d["aplicados"],d["lotes"][0]["leads_descartados"],d["lotes"][0]["clientes_alertados_novos"])')" "1 0 0"
eq "C8b marca acompanha o novo fechamento" "$(marca 2026-10)" "true"
eq "C8c sem alerta de cliente repetido" "$(n_alertas radar_situacao_cadastral)" "1"

# ── 2026-11 fecha e o job NÃO roda (falhou/desativado) ───────────────────────────────────────────────
# L2 fica 08 em novembro (e volta a 02 em dezembro) · C2 cliente Omie 04 em novembro, 02 em dezembro.
P -q <<'SQL'
INSERT INTO public.omie_clientes_nao_vinculados (codigo, cnpj_cpf, razao_social) VALUES ('c2', '55555555000101', 'Cliente Dois');
INSERT INTO public.radar_ingest_state (mes_referencia, status, total_recebido, novos, iniciado_em, finalizado_em) VALUES
  ('2026-11', 'complete', 3, 0, '2026-11-02 06:00+00', '2026-11-02 10:00+00');
UPDATE public.radar_empresas SET ultimo_lote = '2026-11';
INSERT INTO public.radar_situacao_cadastral (cnpj, lote, situacao, data_situacao) VALUES
  ('11111111000102', '2026-11', '08', '2026-10-20'),
  ('55555555000101', '2026-11', '04', '2026-10-20');
SQL
eq "C10a sem aplicação, o aviso espera (20,75 h após o fechamento)" "$(avisar '2026-11-03 06:45+00')" "0"
eq "C10b 30 h sem aplicação: o aviso sai assim mesmo" "$(avisar '2026-11-04 06:45+00')" "1"
eq "C10c aviso sem aplicação = atencao, situacao_aplicada=false, diz que NÃO foi aplicada" \
   "$(Pq -c "SELECT severidade||'|'||(metadata->>'situacao_aplicada')||'|'||(position('a situação cadastral RFB deste lote NÃO foi aplicada' in mensagem) > 0)::text FROM public.fornecedor_alerta WHERE metadata->>'origem'='radar_avisar_lote' AND metadata->>'lote'='2026-11';")" \
   "atencao|false|true"

# ── 2026-12 fecha com 2026-11 ainda pendente: só o mais novo é aplicado ──────────────────────────────
P -q <<'SQL'
INSERT INTO public.radar_ingest_state (mes_referencia, status, total_recebido, novos, iniciado_em, finalizado_em) VALUES
  ('2026-12', 'complete', 3, 0, '2026-12-07 06:00+00', '2026-12-07 10:00+00');
UPDATE public.radar_empresas SET ultimo_lote = '2026-12';
INSERT INTO public.radar_situacao_cadastral (cnpj, lote, situacao) VALUES
  ('11111111000102', '2026-12', '02'),
  ('55555555000101', '2026-12', '02');
SQL
R="$(job '2026-12-08 06:05+00')"
eq "C9 job com 2 pendentes: 1 aplicado (o mais novo), 2 marcados" "$(printf '%s' "$R" | python3 -I -c 'import json,sys;d=json.load(sys.stdin);print(d["aplicados"],d["marcados"])')" "1 2"
eq "C9a lead que novembro dizia baixado e dezembro diz ativo NÃO é descartado" "$(estado 11111111000102)" "a_contatar|02|2026-12"
eq "C9b nenhum alerta pela situação superada de novembro" "$(n_alertas radar_situacao_cadastral)" "1"
eq "C9c novembro marcado superado por dezembro" "$(Pq -c "SELECT (situacao_aplicada_fechamento = finalizado_em)::text||'|'||coalesce(situacao_resultado->>'superado_por','-') FROM public.radar_ingest_state WHERE mes_referencia='2026-11';")" "true|2026-12"

# C11 — erro em radar_aplicar_situacao PROPAGA (cron 'failed', retenta amanhã) e nada é marcado.
P -q <<'SQL'
INSERT INTO public.radar_ingest_state (mes_referencia, status, total_recebido, novos, iniciado_em, finalizado_em) VALUES
  ('2027-01', 'complete', 3, 0, '2027-01-04 06:00+00', '2027-01-04 10:00+00');
CREATE OR REPLACE FUNCTION public.radar_aplicar_situacao(p_lote text, p_agora timestamptz DEFAULT now())
RETURNS jsonb LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'aplicar quebrou (prova)' USING ERRCODE = 'XX001'; END $$;
SQL
C11="$(Pq -c "DO \$t\$
DECLARE v_estado text;
BEGIN
  BEGIN
    PERFORM public.radar_aplicar_situacao_pendente('2027-01-05 06:05+00');
    RAISE NOTICE 'C11 SEM_ERRO';
    RETURN;
  EXCEPTION WHEN SQLSTATE 'XX001' THEN
    IF SQLERRM <> 'aplicar quebrou (prova)' THEN RAISE; END IF;
  END;
  SELECT coalesce(situacao_aplicada_fechamento::text, 'null') INTO v_estado FROM public.radar_ingest_state WHERE mes_referencia = '2027-01';
  RAISE NOTICE 'C11 PROPAGOU marca=%', v_estado;
END \$t\$;" 2>&1 | sed -n 's/.*NOTICE:  //p')"
eq "C11a erro propaga com a marca do ramo e o lote fica pendente" "$C11" "C11 PROPAGOU marca=null"
eq "C11b ledger não ganha linha de sucesso falsa" "$(n_ledger)" "3"

# C12/C13 — ACL só do owner; cron com timeout explícito, horário antes do recruzar/score/aviso.
eq "C12 anon/authenticated/service_role sem EXECUTE no job" \
   "$(Pq -c "SELECT has_function_privilege('anon','public.radar_aplicar_situacao_pendente(timestamptz)','EXECUTE')::text||has_function_privilege('authenticated','public.radar_aplicar_situacao_pendente(timestamptz)','EXECUTE')::text||has_function_privilege('service_role','public.radar_aplicar_situacao_pendente(timestamptz)','EXECUTE')::text;")" \
   "falsefalsefalse"
eq "C13 cron 06:05 UTC com statement_timeout explícito" \
   "$(Pq -c "SELECT schedule||'|'||command||'|'||active::text FROM cron.job WHERE jobname='radar-aplicar-situacao-diario';")" \
   "5 6 * * *|SET statement_timeout = '30min'; SELECT public.radar_aplicar_situacao_pendente();|true"

echo "PASS=$PASS FAIL=$FAIL (locale $LOCALE_TESTE)"
[ "$FAIL" -eq 0 ]
