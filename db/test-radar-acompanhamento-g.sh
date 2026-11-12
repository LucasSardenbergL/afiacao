#!/usr/bin/env bash
# Prova PG17 do pacote G do Radar — migration 20261111100000_radar_acompanhamento_pacote_g, aplicada sobre a cadeia do
# pacote E (20261106181000 → 20261107140001 → 20261107230000) e sobre as definições VIVAS da PROD
# (db/fixtures/radar-g-predecessora-prod-20261108.sql, pg_get_functiondef de 2026-11-08):
#   G1 retorno do "em conversa" (data do vendedor ou padrão; RD008 fora da faixa);
#   G2 "não atendeu" sai por 3/7/30 dias e volta a quem ligou; a raiz em acompanhamento sai dos leads novos; o
#      acompanhamento órfão volta à distribuição; retornos são fila própria;
#   G3 posse protegida pelo compromisso vigente; posses vencendo/vencidas; tick que fecha a vencida; e-mail com o bloco
#      de acompanhamento (e só com ele);
#   G4 dedupe por conteúdo (nota/data diferente = registro novo);
#   G5 ACL, assinatura única, re-aplicação e anti-deriva; a medição (db/medir-radar-acompanhamento.sql) roda.
#
#   bash db/test-radar-acompanhamento-g.sh > /tmp/t.log 2>&1; echo "exit=$?"
#   SABOTAGEM=<nome> bash db/test-radar-acompanhamento-g.sh   # tem de ficar VERMELHA
#   bash db/test-radar-acompanhamento-g.sh --falsificar        # controle verde + cada sabotagem vermelha no assert dela
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MIG="$REPO_ROOT/supabase/migrations/20261106181000_radar_leads_ao_vendedor.sql"
MIG2="$REPO_ROOT/supabase/migrations/20261107140001_radar_email_semanal_toggle.sql"
MIGE="$REPO_ROOT/supabase/migrations/20261107230000_radar_distribuicao_pacote_e.sql"
FIX="$REPO_ROOT/db/fixtures/radar-g-predecessora-prod-20261108.sql"
MIGG="$REPO_ROOT/supabase/migrations/20261111100000_radar_acompanhamento_pacote_g.sql"
MEDIR="$REPO_ROOT/db/medir-radar-acompanhamento.sql"

if [ "${1:-}" = "--falsificar" ]; then
  # <sabotagem>:<assert que TEM de acusá-la>. `POST!P2_FALHOU` = a postcondição aborta o apply com a marca exata.
  SABOTAGENS="retorno_qualquer_acao:G1c retorno_sem_faixa:G1d escalada_fixa:G2a sem_dia_util:G2d sem_raiz_bloqueio:G2f orfao_fica:G2h posse_outro_ignora:G2i sem_protecao:G3a protecao_ressuscita:G3b protecao_fica:G3c tick_nao_fecha:G3e email_sem_bloco:G3g email_pula_sem_leads:G3h dedupe_cego:G4b dedupe_retorno_cego:G4d acl_aberta:POST!P2_FALHOU acl_aberta_sem_post:G5a pre_cega:G5f"
  LOGDIR="$(mktemp -d "${TMPDIR:-/tmp}/falsifica-radar-acompanhamento-g.XXXXXX")"
  echo "══ CONTROLE ══"
  if ! SABOTAGEM="" bash "$0" > "$LOGDIR/controle.log" 2>&1; then
    echo "❌ controle VERMELHO — falsificação abortada (log: $LOGDIR/controle.log)"; tail -15 "$LOGDIR/controle.log"; exit 1
  fi
  if ! grep -q "^PASS=[1-9][0-9]* FAIL=0$" "$LOGDIR/controle.log"; then
    echo "❌ controle sem recibo PASS=n FAIL=0 — a suíte não rodou"; exit 1
  fi
  echo "✅ controle verde ($(grep '^PASS=' "$LOGDIR/controle.log"))"
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
PORT="${PGPORT_TEST:-5497}"
DATA="$(mktemp -d "${TMPDIR:-/tmp}/pgtest-radar-acompanhamento-g.XXXXXX")/data"
export LC_ALL="${LC_ALL_TESTE:-C}" LANG="${LC_ALL_TESTE:-C}"
MIGG_USADA="$(dirname "$DATA")/migg.sql"
cleanup() { "$PGBIN/pg_ctl" -D "$DATA" stop -m immediate >/dev/null 2>&1 || true; rm -rf "$(dirname "$DATA")"; }
trap cleanup EXIT

cp "$MIGG" "$MIGG_USADA"
sabotar() { # $1 = de, $2 = para (literal; substitui TODAS as ocorrências) — na migration do pacote G
  python3 -I - "$MIGG_USADA" "$1" "$2" <<'PY'
import sys
p, de, para = sys.argv[1:]
s = open(p, encoding="utf-8").read()
if de not in s:
    sys.exit("padrao ausente: " + de)
open(p, "w", encoding="utf-8").write(s.replace(de, para))
PY
}
cegar_post() { sabotar "  f text;
BEGIN
  -- P1:" "  f text;
BEGIN
  RETURN;
  -- P1:"; }
case "${SABOTAGEM:-}" in
  "") ;;
  retorno_qualquer_acao) sabotar "  IF p_retorno IS NOT NULL AND p_acao <> 'em_conversa' THEN" "  IF false THEN" ;;
  retorno_sem_faixa)     sabotar "  IF p_retorno IS NOT NULL AND (p_retorno < v_hoje OR p_retorno > v_hoje + 60) THEN" "  IF false THEN" ;;
  escalada_fixa)         sabotar "CASE v_tentativa WHEN 1 THEN 3 WHEN 2 THEN 7 ELSE 30 END" "3" ;;
  sem_dia_util)          sabotar "  SELECT CASE extract(isodow FROM p_dia) WHEN 6 THEN p_dia + 2 WHEN 7 THEN p_dia + 1 ELSE p_dia END" "  SELECT p_dia" ;;
  sem_raiz_bloqueio)     sabotar "             SELECT 1 FROM acomp ac WHERE ac.raiz = u.raiz AND ac.responsavel IS NOT NULL)" "             SELECT 1 WHERE false)" ;;
  orfao_fica)            sabotar "     WHERE o.responsavel IS NULL
       AND o.retorno_em <= par.hoje" "     WHERE false" ;;
  posse_outro_ignora)    sabotar "         COALESCE(pa.dono, CASE WHEN" "         COALESCE(NULL::uuid, CASE WHEN" ;;
  sem_protecao)          sabotar "  RETURN GREATEST(v_expira, v_protege);" "  RETURN v_expira;" ;;
  protecao_ressuscita)   sabotar "     AND c.criado_por = p_dono AND c.retorno_em IS NOT NULL AND c.created_at < v_expira;" "     AND c.criado_por = p_dono AND c.retorno_em IS NOT NULL;" ;;
  protecao_fica)         sabotar "   WHERE e.cnpj = p_cnpj AND e.prospeccao_status = 'em_conversa' AND c.acao = 'em_conversa'" "   WHERE e.cnpj = p_cnpj AND c.acao IS NOT NULL" && \
                         sabotar "    JOIN public.radar_contatos c ON c.id = e.prospeccao_contato_id AND c.cnpj = e.cnpj
   WHERE e.cnpj = p_cnpj" "    JOIN public.radar_contatos c ON c.cnpj = e.cnpj AND c.acao = 'em_conversa'
   WHERE e.cnpj = p_cnpj" ;;
  tick_nao_fecha)        sabotar "      UPDATE public.radar_atendimentos a SET encerrado_em = v_exp, motivo_encerramento = 'expirado'
       WHERE a.id = r.id AND a.encerrado_em IS NULL;" "      NULL;" ;;
  email_sem_bloco)       sabotar "          || CASE WHEN v_bloco <> '' THEN E'\n\n' || 'Seu acompanhamento' || E'\n\n' || rtrim(v_bloco, E'\n') ELSE '' END;" "          ;" ;;
  email_pula_sem_leads)  sabotar "      IF v_qtd = 0 AND jsonb_array_length(v_ret) + jsonb_array_length(v_pos) + jsonb_array_length(v_venc) = 0 THEN" "      IF v_qtd = 0 THEN" ;;
  dedupe_cego)           sabotar "     AND (v_nota IS NULL OR NULLIF(btrim(c.nota), '') IS NOT DISTINCT FROM v_nota)
" "" ;;
  dedupe_retorno_cego)   sabotar "     AND (p_retorno IS NULL OR c.retorno_em IS NOT DISTINCT FROM p_retorno);" "     ;" ;;
  acl_aberta)            sabotar "REVOKE ALL ON FUNCTION private.radar_acompanhamentos(timestamptz) FROM PUBLIC, anon, authenticated;" "REVOKE ALL ON FUNCTION private.radar_acompanhamentos(timestamptz) FROM anon;" ;;
  acl_aberta_sem_post)   sabotar "REVOKE ALL ON FUNCTION private.radar_acompanhamentos(timestamptz) FROM PUBLIC, anon, authenticated;" "REVOKE ALL ON FUNCTION private.radar_acompanhamentos(timestamptz) FROM anon;"; cegar_post ;;
  pre_cega)              sabotar "      RAISE EXCEPTION 'PRE FALHOU: % vivo (md5 %) não é o predecessor revisado nem este — outra sessão mudou; refaça o pré-voo', r.alvo, r.vivo;" "      NULL;" ;;
  *) echo "sabotagem desconhecida: $SABOTAGEM"; exit 9 ;;
esac
[ -n "${SABOTAGEM:-}" ] && echo "⚠️  SABOTAGEM ATIVA: $SABOTAGEM"

"$PGBIN/initdb" -D "$DATA" -U postgres -E UTF8 --locale=C >/dev/null
"$PGBIN/pg_ctl" -D "$DATA" -o "-p $PORT -k /tmp -c timezone=UTC" -l "$(dirname "$DATA")/pg.log" -w start >/dev/null
P()  { "$PGBIN/psql" -X -v ON_ERROR_STOP=1 -p "$PORT" -h /tmp -U postgres -d postgres "$@"; }
Pq() { P -qAt "$@"; }

# ── Esquema mínimo (o do db/test-radar-distribuicao-e.sh + as colunas vivas que o registro e o desfazer usam, medidas
#    em PROD via psql-ro em 2026-11-08: radar_contatos completo, radar_empresas.prospeccao_*, omie_cliente_confirmacoes,
#    radar_atendimentos com motivo) ─────────────────────────────────────────────────────────────────────────────
P -q <<'SQL'
CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN; CREATE ROLE service_role NOLOGIN BYPASSRLS;
CREATE SCHEMA auth; CREATE SCHEMA private; CREATE SCHEMA cron;
-- Pior caso: o JWT alcança os dois schemas; quem fecha é o ACL da função (é isso que a prova mede).
GRANT USAGE ON SCHEMA public, private, auth TO anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON TABLES TO anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA private GRANT EXECUTE ON FUNCTIONS TO anon, authenticated, service_role;
CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$
  SELECT NULLIF(current_setting('request.jwt.claims', true)::jsonb ->> 'sub', '')::uuid $$;

CREATE TABLE cron.job (jobid bigint PRIMARY KEY, jobname text, schedule text, command text, active boolean DEFAULT true,
  username text NOT NULL DEFAULT current_user);
CREATE FUNCTION cron.schedule(p_jobname text, p_schedule text, p_command text) RETURNS bigint LANGUAGE plpgsql AS $$
DECLARE v bigint;
BEGIN
  SELECT jobid INTO v FROM cron.job WHERE jobname = p_jobname;
  IF v IS NULL THEN
    SELECT COALESCE(max(jobid), 0) + 1 INTO v FROM cron.job;
    INSERT INTO cron.job (jobid, jobname, schedule, command, active) VALUES (v, p_jobname, p_schedule, p_command, true);
  ELSE
    UPDATE cron.job SET schedule = p_schedule, command = p_command WHERE jobid = v;
  END IF;
  RETURN v;
END $$;
CREATE FUNCTION cron.alter_job(job_id bigint, schedule text DEFAULT NULL, command text DEFAULT NULL, database text DEFAULT NULL,
                               username text DEFAULT NULL, active boolean DEFAULT NULL) RETURNS void LANGUAGE sql AS $$
  UPDATE cron.job j SET active = COALESCE(alter_job.active, j.active) WHERE j.jobid = alter_job.job_id $$;

CREATE TYPE public.app_role AS ENUM ('master', 'employee', 'customer');
CREATE TYPE public.commercial_role AS ENUM ('farmer', 'hunter', 'closer', 'gerencial', 'estrategico', 'super_admin', 'operacional');
CREATE TABLE public.user_roles (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL, role public.app_role NOT NULL);
CREATE TABLE public.commercial_roles (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL UNIQUE,
  commercial_role public.commercial_role NOT NULL);
CREATE TABLE public.profiles (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid, name text, email text,
  created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE public.carteira_assignments (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), customer_user_id uuid NOT NULL,
  owner_user_id uuid NOT NULL, eligible boolean);
CREATE TABLE public.addresses (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL, city text NOT NULL,
  state text NOT NULL, is_default boolean NOT NULL DEFAULT false, created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE public.radar_municipios (codigo text PRIMARY KEY, nome text NOT NULL, uf text NOT NULL);
CREATE TABLE public.radar_empresas (
  cnpj text PRIMARY KEY, razao_social text, nome_fantasia text, municipio_codigo text, municipio_nome text, uf text,
  ja_cliente boolean NOT NULL DEFAULT false,
  prospeccao_status text NOT NULL DEFAULT 'a_contatar'
    CHECK (prospeccao_status IN ('a_contatar','contatado_sem_resposta','em_conversa','descartado','virou_cliente')),
  prospeccao_atualizado_em timestamptz, prospeccao_contato_id uuid, descarte_motivo text, omie_codigo_cliente text,
  updated_at timestamptz,
  rfb_situacao text, score smallint, score_motivos text[],
  telefone1 text, telefone2 text, email text, ultimo_lote text);
CREATE INDEX idx_radar_muni ON public.radar_empresas (municipio_codigo) WHERE ja_cliente = false AND prospeccao_status <> 'descartado';
CREATE TABLE public.radar_ingest_state (mes_referencia text PRIMARY KEY, status text NOT NULL, iniciado_em timestamptz NOT NULL);
CREATE TABLE public.radar_contatos (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  cnpj text NOT NULL REFERENCES public.radar_empresas(cnpj) ON DELETE CASCADE,
  acao text NOT NULL CHECK (acao IN ('contatado_sem_resposta','em_conversa','descartado','virou_cliente','a_contatar')),
  nota text, criado_por uuid NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
  status_anterior text, contato_anterior_id uuid, descarte_motivo_anterior text, atualizado_anterior timestamptz);
CREATE TABLE public.radar_atendimentos (id bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY, cnpj text NOT NULL,
  dono_user_id uuid NOT NULL, assumido_em timestamptz NOT NULL, renovado_em timestamptz, encerrado_em timestamptz,
  encerrado_por uuid, motivo_encerramento text, atribuido_por uuid,
  CONSTRAINT radar_atendimentos_motivo_chk
    CHECK (motivo_encerramento IN ('liberado', 'expirado', 'gestor_liberou', 'dono_sem_acesso', 'reatribuido')),
  CONSTRAINT radar_atendimentos_encerramento_chk CHECK ((encerrado_em IS NULL) = (motivo_encerramento IS NULL)),
  CONSTRAINT radar_atendimentos_ordem_chk CHECK (encerrado_em IS NULL OR encerrado_em >= assumido_em));
CREATE UNIQUE INDEX radar_atendimentos_aberto_uniq ON public.radar_atendimentos (cnpj) WHERE encerrado_em IS NULL;
CREATE TABLE public.omie_cliente_confirmacoes (id bigserial PRIMARY KEY, account text, documento text, codigo_cliente text);
CREATE TABLE public.company_config (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), key text NOT NULL UNIQUE, value text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE public.fornecedor_alerta (
  id bigserial PRIMARY KEY, empresa text NOT NULL,
  tipo text NOT NULL CHECK (tipo IN ('promocao_suspensa','aumento_anunciado','promocao_nova','polling_erro','mapeamento_pendente',
    'oportunidade_calculada','tarefa_atrasada','whatsapp_sla','erro_app','outro','param_auto_resumo','reposicao_pedido_minimo')),
  severidade text NOT NULL DEFAULT 'info' CHECK (severidade IN ('info','atencao','urgente')),
  titulo text NOT NULL, mensagem text,
  status text NOT NULL DEFAULT 'pendente_notificacao' CHECK (status IN ('pendente_notificacao','notificado','falha_notificacao','ignorado')),
  metadata jsonb, criado_em timestamptz NOT NULL DEFAULT now());
CREATE TABLE public.acoes_execucoes (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), acao text NOT NULL,
  origem text NOT NULL DEFAULT 'manual' CHECK (origem IN ('manual','automatica')), executado_por uuid, executado_por_nome text,
  iniciado_em timestamptz NOT NULL DEFAULT now(), finalizado_em timestamptz,
  status text NOT NULL DEFAULT 'executando' CHECK (status IN ('executando','sucesso','erro')), detalhes jsonb);

CREATE FUNCTION public.has_role(_user_id uuid, _role public.app_role) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = public AS $$ SELECT EXISTS (SELECT 1 FROM public.user_roles WHERE user_id = _user_id AND role = _role) $$;
CREATE FUNCTION public.get_commercial_role(_uid uuid) RETURNS public.commercial_role LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = public AS $$ SELECT commercial_role FROM public.commercial_roles WHERE user_id = _uid $$;
CREATE FUNCTION public.norm_cidade(t text) RETURNS text LANGUAGE sql IMMUTABLE SET search_path TO 'public' AS $$
  SELECT lower(btrim(translate(COALESCE(t,''),
    'ÁÀÂÃÄÉÈÊËÍÌÎÏÓÒÔÕÖÚÙÛÜÇÑáàâãäéèêëíìîïóòôõöúùûüçñ', 'AAAAAEEEEIIIIOOOOOUUUUCNaaaaaeeeeiiiiooooouuuucn'))) $$;
CREATE FUNCTION private.cap_radar_prospectar(_uid uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS $$
  SELECT COALESCE(_uid IS NOT NULL AND (public.has_role(_uid, 'master'::public.app_role) OR (
    public.has_role(_uid, 'employee'::public.app_role) AND EXISTS (SELECT 1 FROM public.commercial_roles cr WHERE cr.user_id = _uid
      AND cr.commercial_role IN ('gerencial','estrategico','super_admin','farmer','hunter','closer')))), false) $$;
CREATE FUNCTION private.pode_ver_carteira_completa(_uid uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS $$
  SELECT has_role(_uid, 'master'::app_role) OR (has_role(_uid, 'employee'::app_role)
    AND get_commercial_role(_uid) IN ('gerencial'::commercial_role, 'estrategico'::commercial_role, 'super_admin'::commercial_role)) $$;
CREATE FUNCTION private.cap_carteira_ler(_uid uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS $$
  SELECT private.pode_ver_carteira_completa(_uid) $$;
CREATE FUNCTION private.radar_atendimento_expira_em(p_cnpj text, p_dono uuid, p_assumido_em timestamptz, p_renovado_em timestamptz)
RETURNS timestamptz LANGUAGE sql STABLE AS $$ SELECT GREATEST(p_assumido_em, p_renovado_em) + interval '7 days' $$;
SQL

APPLY_LOG="$(dirname "$DATA")/apply.log"
for f in "$MIG" "$MIG2" "$MIGE"; do
  if ! P -q -f "$f" > "$APPLY_LOG" 2>&1; then cat "$APPLY_LOG"; echo "APLICAÇÃO DO PREDECESSOR FALHOU: $f"; exit 1; fi
done
# O contato contábil (20261109140000) entra como stub: o pacote G só lê as duas colunas dele.
P -q <<'SQL'
CREATE FUNCTION private.radar_contato_do_lead(p_cnpj text) RETURNS TABLE(visitar boolean, endereco text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$ SELECT false, NULL::text $$;
ALTER TABLE public.radar_email_vendedor_leads ADD COLUMN visitar boolean;  -- como na PROD (20261109140000)
SQL
# As definições VIVAS da PROD por cima (o predecessor exato da PRE).
if ! P -q -f "$FIX" >> "$APPLY_LOG" 2>&1; then cat "$APPLY_LOG"; echo "APLICAÇÃO DO FIXTURE DA PROD FALHOU"; exit 1; fi

PASS=0; FAIL=0
eq() { if [ "$2" = "$3" ]; then echo "PASS $1"; PASS=$((PASS+1)); else echo "FAIL $1 — obtido [$2] esperado [$3]"; FAIL=$((FAIL+1)); fi; }
como() {
  local claims='{}'; [ -n "$2" ] && claims="{\"sub\":\"$2\"}"
  P -qAt -c "SET ROLE $1" -c "SET request.jwt.claims = '$claims'" -c "$3" 2>&1
}
erro_como() {
  local claims='{}'; [ -n "$2" ] && claims="{\"sub\":\"$2\"}"
  local out
  if out="$(P -qAt -v VERBOSITY=verbose -c "SET ROLE $1" -c "SET request.jwt.claims = '$claims'" -c "$3" 2>&1)"; then
    echo "SEM_ERRO"; return 0
  fi
  printf '%s\n' "$out" | sed -n 's/^ERROR:  \([0-9A-Z]\{5\}\): \(.*\)$/\1 \2/p' | head -1
}
prefixo() { case "$2" in "$3"*) eq "$1" "ok" "ok" ;; *) eq "$1" "$2" "$3…" ;; esac; }

# G0: o fixture É o predecessor que a PRE conhece (md5 do corpo vivo da PROD de 2026-11-08).
eq "G0 o fixture carrega exatamente os corpos da PROD que a PRE da migration aceita como predecessor" \
   "$(Pq -c "SELECT string_agg(md5(prosrc), ',' ORDER BY oid::regprocedure::text) FROM pg_proc WHERE oid IN ('public.registrar_contato_radar(text,text,text)'::regprocedure, 'private.radar_atendimento_expira_em(text,uuid,timestamptz,timestamptz)'::regprocedure, 'private.radar_leads_do_vendedor(uuid,integer,timestamptz)'::regprocedure, 'public.radar_prospectar_hoje(uuid,integer)'::regprocedure, 'public.radar_avisar_vendedores(timestamptz)'::regprocedure)")" \
   "fefd503925f5feaa33057895894f8b3c,09a18fe233086578bea5ce92a82999c3,6c5c9fd0423301f9e835008cb621019f,d35f8f19e9b3612de3454c306f77a52d,26c486a156b0fd90d5187bfa377daae5"

# -1: uma transação só, como o `db:aplicar` (que abre a dele; o arquivo não leva BEGIN/COMMIT).
if ! P -q -1 -f "$MIGG_USADA" >> "$APPLY_LOG" 2>&1; then
  tail -20 "$APPLY_LOG"; echo "APLICAÇÃO DA MIGRATION DO PACOTE G FALHOU"; exit 1
fi
# Recibo dos corpos aplicados (o 'este' da PRE): diagnóstico quando a re-aplicação (G5e) acusar deriva.
Pq -c "SELECT 'MD5_ESTE '||oid::regprocedure::text||' '||md5(prosrc) FROM pg_proc WHERE oid IN ('public.registrar_contato_radar(text,text,text,date)'::regprocedure, 'private.radar_atendimento_expira_em(text,uuid,timestamptz,timestamptz)'::regprocedure, 'private.radar_leads_do_vendedor(uuid,integer,timestamptz)'::regprocedure, 'public.radar_prospectar_hoje(uuid,integer)'::regprocedure, 'public.radar_avisar_vendedores(timestamptz)'::regprocedure) ORDER BY 1"

# ── Atores e dados ────────────────────────────────────────────────────────────────────────────────────────
V1=a0000000-0000-0000-0000-000000000011   # farmer dono de DIV (4 clientes)
V2=a0000000-0000-0000-0000-000000000012   # farmer dono de NS (3 clientes)
V3=a0000000-0000-0000-0000-000000000013   # farmer sem carteira: só acompanhamento
X=a0000000-0000-0000-0000-000000000014    # ex-vendedor: employee SEM papel comercial (sem acesso ao Radar)
G=a0000000-0000-0000-0000-000000000008    # gestor
export V1 V2 V3 X G
P -q -v v1="$V1" -v v2="$V2" -v v3="$V3" -v x="$X" -v g="$G" <<'SQL'
INSERT INTO public.user_roles (user_id, role) VALUES (:'v1','employee'), (:'v2','employee'), (:'v3','employee'), (:'x','employee'), (:'g','employee');
INSERT INTO public.commercial_roles (user_id, commercial_role) VALUES (:'v1','farmer'), (:'v2','farmer'), (:'v3','farmer'), (:'g','gerencial');
INSERT INTO public.profiles (user_id, name, email) VALUES
  (:'v1','Regina Celia','regina@exemplo.com'), (:'v2','Nilo Serrano','nilo@exemplo.com'), (:'v3','Sem Carteira','v3@exemplo.com'),
  (:'x','Ex Vendedor','x@exemplo.com'), (:'g','Gestor','gestor@exemplo.com');
INSERT INTO public.radar_municipios (codigo, nome, uf) VALUES ('3122306','DIVINÓPOLIS','MG'), ('3145208','NOVA SERRANA','MG');
INSERT INTO public.radar_ingest_state VALUES ('2026-10','complete','2026-10-27 16:00+00');
CREATE TEMP TABLE semente (dono uuid, cidade text, uf text, n int);
INSERT INTO semente VALUES (:'v1','Divinopolis','MG',4), (:'v2','Nova Serrana','MG',3);
DO $$
DECLARE s record; i int; cli uuid;
BEGIN
  FOR s IN SELECT * FROM semente LOOP
    FOR i IN 1..s.n LOOP
      cli := gen_random_uuid();
      INSERT INTO public.carteira_assignments (customer_user_id, owner_user_id, eligible) VALUES (cli, s.dono, true);
      INSERT INTO public.addresses (user_id, city, state, is_default) VALUES (cli, s.cidade, s.uf, true);
    END LOOP;
  END LOOP;
END $$;
-- DIV: raiz 10100000 com DUAS filiais (A 95, B 94) · 103 90 · 104 85 · 105 80 · 106 75 · 107 70 (ex-vendedor) · 108 65
-- NS:  211 88 · 212 60
INSERT INTO public.radar_empresas (cnpj, razao_social, municipio_codigo, municipio_nome, uf, score, telefone1, ultimo_lote) VALUES
  ('10100000000101','Metal A','3122306','DIVINOPOLIS','MG',95,'3732220001','2026-10'),
  ('10100000000202','Metal B','3122306','DIVINOPOLIS','MG',94,'3732220002','2026-10'),
  ('10300000000101','Lead 103','3122306','DIVINOPOLIS','MG',90,'3732220003','2026-10'),
  ('10400000000101','Lead 104','3122306','DIVINOPOLIS','MG',85,'3732220004','2026-10'),
  ('10500000000101','Lead 105','3122306','DIVINOPOLIS','MG',80,'3732220005','2026-10'),
  ('10600000000101','Lead 106','3122306','DIVINOPOLIS','MG',75,'3732220006','2026-10'),
  ('10700000000101','Lead 107','3122306','DIVINOPOLIS','MG',70,'3732220007','2026-10'),
  ('10800000000101','Lead 108','3122306','DIVINOPOLIS','MG',65,'3732220008','2026-10'),
  ('21100000000101','Lead 211','3145208','NOVA SERRANA','MG',88,'3732220011','2026-10'),
  ('21200000000101','Lead 212','3145208','NOVA SERRANA','MG',60,'3732220012','2026-10');
INSERT INTO public.radar_email_vendedor_config (vendedor_user_id, ativo) VALUES (:'v1', true), (:'v3', true);
SQL

HOJE="$(Pq -c "SELECT (now() AT TIME ZONE 'America/Sao_Paulo')::date")"
reg() {  # reg <uid> <cnpj> <acao> [nota] [retorno] → jsonb (chamada nomeada, como o PostgREST)
  local args="p_cnpj => '$2', p_acao => '$3'"
  [ -n "${4:-}" ] && args="$args, p_nota => '$4'"
  [ -n "${5:-}" ] && args="$args, p_retorno => '$5'::date"
  como authenticated "$1" "SELECT public.registrar_contato_radar($args)" | tail -1
}
envelhecer() {  # empurra os contatos do CNPJ N minutos para trás (sai da janela de 2 min da dedupe)
  P -q -c "UPDATE public.radar_contatos SET created_at = created_at - interval '${2:-3} minutes' WHERE cnpj = '$1'"
}
campo() { printf '%s' "$1" | python3 -I -c "import json,sys; v=json.load(sys.stdin).get('$2'); print('null' if v is None else (str(v).lower() if isinstance(v,bool) else v))"; }
leads() { Pq -c "SELECT COALESCE(string_agg(cnpj, ',' ORDER BY posicao), '-') FROM private.radar_leads_do_vendedor('$1', 5, now())"; }
retornos() { Pq -c "SELECT COALESCE(string_agg(left(cnpj,3)||':'||retorno_tipo||CASE WHEN atrasado THEN '!' ELSE '' END, ',' ORDER BY retorno_em, cnpj), '-') FROM private.radar_retornos_do_vendedor('$1', '${2:-$HOJE}'::date, now())"; }

# ── G1: retorno do "em conversa" ──────────────────────────────────────────────────────────────────────────
R="$(reg "$V1" 10300000000101 em_conversa 'falei com o João')"
eq "G1a app velho (sem p_retorno, chamada nomeada de 3 args): padrão hoje+7 em dia útil, origem padrao, resposta com nota_gravada" \
   "$(campo "$R" deduped):$(campo "$R" nota_gravada):$(campo "$R" retorno_em)|$(Pq -c "SELECT retorno_origem FROM public.radar_contatos WHERE cnpj = '10300000000101'")" \
   "false:true:$(Pq -c "SELECT private.radar_dia_util('$HOJE'::date + 7)")|padrao"
envelhecer 10300000000101
R="$(reg "$V1" 10300000000101 em_conversa 'quer orçamento' "$(Pq -c "SELECT '$HOJE'::date + 10")")"
eq "G1b data escolhida pelo vendedor é gravada como está (origem vendedor)" \
   "$(campo "$R" retorno_em)|$(Pq -c "SELECT retorno_origem FROM public.radar_contatos WHERE id = '$(campo "$R" id)'")" \
   "$(Pq -c "SELECT '$HOJE'::date + 10")|vendedor"
prefixo "G1c data de retorno em 'não atendeu' é recusada com RD008" \
   "$(erro_como authenticated "$V1" "SELECT public.registrar_contato_radar('10400000000101', 'contatado_sem_resposta', NULL, '$HOJE'::date + 3)")" "RD008 RADAR_RETORNO_INVALIDO"
prefixo "G1d retorno no passado (ontem) é recusado com RD008" \
   "$(erro_como authenticated "$V1" "SELECT public.registrar_contato_radar('10400000000101', 'em_conversa', NULL, '$HOJE'::date - 1)")" "RD008 RADAR_RETORNO_INVALIDO"
prefixo "G1d2 retorno além de 60 dias é recusado com RD008" \
   "$(erro_como authenticated "$V1" "SELECT public.registrar_contato_radar('10400000000101', 'em_conversa', NULL, '$HOJE'::date + 61)")" "RD008 RADAR_RETORNO_INVALIDO"
eq "G1e retorno para HOJE é aceito (cliente pediu 'liga hoje à tarde')" \
   "$(campo "$(reg "$V1" 10400000000101 em_conversa '' "$HOJE")" retorno_em)" "$HOJE"

# ── G2: não atendeu, raiz, órfão, responsável ─────────────────────────────────────────────────────────────
R1="$(reg "$V1" 10500000000101 contatado_sem_resposta)"; envelhecer 10500000000101
R2="$(reg "$V1" 10500000000101 contatado_sem_resposta)"; envelhecer 10500000000101
R3="$(reg "$V1" 10500000000101 contatado_sem_resposta)"
eq "G2a não atendeu seguido: 3, 7 e 30 dias (dia útil), decididos pela cadeia do status" \
   "$(campo "$R1" retorno_em),$(campo "$R2" retorno_em),$(campo "$R3" retorno_em)" \
   "$(Pq -c "SELECT private.radar_dia_util('$HOJE'::date + 3)||','||private.radar_dia_util('$HOJE'::date + 7)||','||private.radar_dia_util('$HOJE'::date + 30)")"
como authenticated "$V1" "SELECT public.desfazer_contato_radar('$(campo "$R3" id)')" >/dev/null
eq "G2b desfazer a 3ª tentativa restaura o contato dono anterior e o retorno DELE (7 dias)" \
   "$(Pq -c "SELECT c.retorno_em FROM public.radar_empresas e JOIN public.radar_contatos c ON c.id = e.prospeccao_contato_id WHERE e.cnpj = '10500000000101'")" \
   "$(campo "$R2" retorno_em)"
envelhecer 10500000000101
reg "$V1" 10500000000101 em_conversa >/dev/null; envelhecer 10500000000101
eq "G2c 'não atendeu' depois de um 'em conversa' recomeça a contagem (3 dias)" \
   "$(campo "$(reg "$V1" 10500000000101 contatado_sem_resposta)" retorno_em)" "$(Pq -c "SELECT private.radar_dia_util('$HOJE'::date + 3)")"
eq "G2d dia útil: sábado e domingo vão para a segunda; sexta fica" \
   "$(Pq -c "SELECT private.radar_dia_util('2026-11-14')||','||private.radar_dia_util('2026-11-15')||','||private.radar_dia_util('2026-11-13')")" \
   "2026-11-16,2026-11-16,2026-11-13"
eq "G2e o 'não atendeu' com retorno futuro não está nos retornos de hoje (sai por um prazo)" \
   "$(retornos "$V1" | grep -c '105' || true)" "0"
# Filial A da raiz 10100000 em conversa com V1: a filial B NÃO pode entrar como lead novo (nem para V1).
reg "$V1" 10100000000101 em_conversa 'filial A' >/dev/null
eq "G2f raiz em acompanhamento: a outra filial (B) não 'reaparece' como lead novo" \
   "$(leads "$V1" | grep -c '10100000000202' || true)" "0"
P -q -c "UPDATE public.radar_contatos SET retorno_em = '$HOJE'::date - 2 WHERE cnpj = '10100000000101' AND acao = 'em_conversa'"
eq "G2g retorno vencido entra nos retornos de V1 (atrasado), a raiz continua fora dos leads novos, e o top de leads não é tomado" \
   "$(retornos "$V1" | grep -o '101:conversa!' || true)|$(leads "$V1" | grep -c '10100000000' || true)|$(leads "$V1" | tr ',' '\n' | wc -l | tr -d ' ')" \
   "101:conversa!|0|3"
# Órfão: o ex-vendedor (sem acesso) deixou o 107 em conversa. Com o retorno futuro, nada; vencido, volta à distribuição.
P -q -v x="$X" <<'SQL'
INSERT INTO public.radar_contatos (id, cnpj, acao, criado_por, created_at, retorno_em, retorno_origem)
VALUES ('c0000000-0000-0000-0000-000000000107', '10700000000101', 'em_conversa', :'x', now() - interval '20 days',
        (now() AT TIME ZONE 'America/Sao_Paulo')::date + 5, 'vendedor');
UPDATE public.radar_empresas SET prospeccao_status = 'em_conversa', prospeccao_contato_id = 'c0000000-0000-0000-0000-000000000107'
 WHERE cnpj = '10700000000101';
SQL
ANTES_ORFAO="$(leads "$V1" | grep -c '10700000000101' || true)"
P -q -c "UPDATE public.radar_contatos SET retorno_em = '$HOJE'::date - 1 WHERE id = 'c0000000-0000-0000-0000-000000000107'"
eq "G2h acompanhamento órfão (autor sem acesso): retorno futuro fica parado; vencido, volta à distribuição do território" \
   "$ANTES_ORFAO|$(leads "$V1" | grep -c '10700000000101' || true)" "0|1"
# Posse de outro vence o autor: V2 recebe do gestor a posse do 101 (A), onde o retorno é de V1.
P -q -c "INSERT INTO public.radar_atendimentos (cnpj, dono_user_id, assumido_em, atribuido_por) VALUES ('10100000000101', '$V2', now(), '$G')"
eq "G2i com posse ativa de V2, o retorno do 101 é de V2 (responsável), não de V1 (autor)" \
   "$(retornos "$V1" | grep -c '101' || true)|$(retornos "$V2" | grep -c '101' || true)" "0|1"
P -q -c "DELETE FROM public.radar_atendimentos WHERE cnpj = '10100000000101'"

# ── G3: posse protegida, vencendo, tick, e-mail ───────────────────────────────────────────────────────────
# 104: em conversa de V1 com retorno HOJE (G1e). V1 assumiu há 10 dias e renovou há 1 dia (renovar não apaga a proteção);
# o contato foi há 9 dias. Pela cadeia de toques, venceria amanhã; a proteção leva a hoje+3 (meia-noite BRT).
P -q -v v1="$V1" <<'SQL'
UPDATE public.radar_contatos SET created_at = now() - interval '9 days' WHERE cnpj = '10400000000101';
UPDATE public.radar_contatos SET retorno_em = (now() AT TIME ZONE 'America/Sao_Paulo')::date + 5 WHERE cnpj = '10400000000101' AND acao = 'em_conversa';
INSERT INTO public.radar_atendimentos (cnpj, dono_user_id, assumido_em, renovado_em) VALUES
  ('10400000000101', :'v1', now() - interval '10 days', now() - interval '1 day');
SQL
eq "G3a posse protegida pelo compromisso vigente: vence em retorno+3 (meia-noite BRT), não pela cadeia de toques" \
   "$(Pq -c "SELECT (private.radar_atendimento_expira_em(a.cnpj, a.dono_user_id, a.assumido_em, a.renovado_em) AT TIME ZONE 'America/Sao_Paulo')::text FROM public.radar_atendimentos a WHERE a.cnpj = '10400000000101'")" \
   "$(Pq -c "SELECT ('$HOJE'::date + 8)::timestamp::text")"
# 106: V1 assumiu há 9 dias (venceu há 2); um em conversa de V1 há 1 dia (depois do vencimento) NÃO ressuscita.
P -q -v v1="$V1" <<'SQL'
INSERT INTO public.radar_contatos (id, cnpj, acao, criado_por, created_at, retorno_em, retorno_origem)
VALUES ('c0000000-0000-0000-0000-000000000106', '10600000000101', 'em_conversa', :'v1', now() - interval '1 day',
        (now() AT TIME ZONE 'America/Sao_Paulo')::date + 20, 'vendedor');
UPDATE public.radar_empresas SET prospeccao_status = 'em_conversa', prospeccao_contato_id = 'c0000000-0000-0000-0000-000000000106'
 WHERE cnpj = '10600000000101';
INSERT INTO public.radar_atendimentos (cnpj, dono_user_id, assumido_em) VALUES ('10600000000101', :'v1', now() - interval '9 days');
SQL
eq "G3b contato feito com a posse já vencida não ressuscita a posse (vence em assumido+7, no passado)" \
   "$(Pq -c "SELECT private.radar_atendimento_expira_em(a.cnpj, a.dono_user_id, a.assumido_em, a.renovado_em) < now() FROM public.radar_atendimentos a WHERE a.cnpj = '10600000000101'")" "t"
# 108: V1 assumiu há 3 dias, em conversa há 2 dias com retorno +20, depois "não atendeu" há 1 dia: a proteção sai.
P -q -v v1="$V1" <<'SQL'
INSERT INTO public.radar_atendimentos (cnpj, dono_user_id, assumido_em) VALUES ('10800000000101', :'v1', now() - interval '3 days');
INSERT INTO public.radar_contatos (id, cnpj, acao, criado_por, created_at, retorno_em, retorno_origem) VALUES
  ('c0000000-0000-0000-0000-000000000801', '10800000000101', 'em_conversa', :'v1', now() - interval '2 days',
   (now() AT TIME ZONE 'America/Sao_Paulo')::date + 20, 'vendedor'),
  ('c0000000-0000-0000-0000-000000000802', '10800000000101', 'contatado_sem_resposta', :'v1', now() - interval '1 day',
   (now() AT TIME ZONE 'America/Sao_Paulo')::date + 2, 'padrao');
UPDATE public.radar_empresas SET prospeccao_status = 'contatado_sem_resposta', prospeccao_contato_id = 'c0000000-0000-0000-0000-000000000802'
 WHERE cnpj = '10800000000101';
SQL
eq "G3c outro desfecho depois do 'em conversa' retira a proteção: a posse volta à regra do último toque (+7 dias)" \
   "$(Pq -c "SELECT abs(extract(epoch FROM private.radar_atendimento_expira_em(a.cnpj, a.dono_user_id, a.assumido_em, a.renovado_em) - (now() + interval '6 days'))) < 60 FROM public.radar_atendimentos a WHERE a.cnpj = '10800000000101'")" "t"
# Card de V1: o 108 vence em 6 dias (fora das 48 h); o 106 venceu (aberta, o tick ainda não rodou).
CARD="$(como authenticated "$V1" "SELECT public.radar_prospectar_hoje()" | tail -1)"
eq "G3d card: retornos com total, posses vencidas_7d conta a aberta já vencida, e as chaves de antes seguem lá" \
   "$(printf '%s' "$CARD" | python3 -I -c "import json,sys; d=json.load(sys.stdin); print(d['retornos']['total'], d['posses']['vencidas_7d'], len(d['posses']['vencendo']), len(d['leads']), sorted(d.keys()))")" \
   "1 1 0 1 ['leads', 'posses', 'retornos', 'territorio', 'territorio_motivo']"

# ── O3b (revisão 2026-11-11, item 8; migration 20261113110100): radar_meus_retornos EXECUTADA sobre a MESMA agenda ──
# Só a função nova sai do arquivo (o resto do O3b é do pacote M, que este fixture não carrega): o CREATE e o ACL.
MIG_O3B="$REPO_ROOT/supabase/migrations/20261113110100_radar_retornos_paginados_intencao_email.sql"
awk '/^CREATE OR REPLACE FUNCTION public.radar_meus_retornos/{f=1} f{print} f&&/^GRANT EXECUTE ON FUNCTION public.radar_meus_retornos/{exit}' \
  "$MIG_O3B" > "$(dirname "$DATA")/o3b-retornos.sql"
P -q -1 -f "$(dirname "$DATA")/o3b-retornos.sql" >/dev/null
TODOS="$(como authenticated "$V1" "SELECT public.radar_meus_retornos(NULL, 0, 50)" | tail -1)"
eq "R1 radar_meus_retornos = a agenda do card: mesmo total e mesmos itens, na mesma ordem" \
   "$(printf '%s' "$TODOS" | python3 -I -c "import json,sys; d=json.load(sys.stdin); print(d['total'], [i['cnpj'] for i in d['itens']])")" \
   "$(printf '%s' "$CARD" | python3 -I -c "import json,sys; d=json.load(sys.stdin)['retornos']; print(d['total'], [i['cnpj'] for i in d['itens']])")"
eq "R2 página além do fim: itens vazios e o total de sempre" \
   "$(como authenticated "$V1" "SELECT (r->>'total') || ':' || jsonb_array_length(r->'itens') FROM (SELECT public.radar_meus_retornos(NULL, 50, 50) AS r) x" | tail -1)" "1:0"
eq "R3 limite fora da faixa é contido (0 → 1 item; offset negativo → 0)" \
   "$(como authenticated "$V1" "SELECT jsonb_array_length(public.radar_meus_retornos(NULL, -5, 0)->'itens')" | tail -1)" "1"
prefixo "R4 vendedor pedindo os retornos de OUTRO vendedor: 42501" \
   "$(erro_como authenticated "$V1" "SELECT public.radar_meus_retornos('$V2', 0, 10)")" "42501"
eq "R5 anon não executa" "$(Pq -c "SELECT has_function_privilege('anon', 'public.radar_meus_retornos(uuid,integer,integer)', 'execute')")" "f"
TICK="$(Pq -c "SELECT public.radar_posses_vencer_tick()")"
eq "G3e tick fecha a posse vencida (106) como 'expirado' no instante do vencimento e deixa as vivas abertas" \
   "$(campo "$TICK" fechadas)|$(Pq -c "SELECT string_agg(left(cnpj,3)||':'||COALESCE(motivo_encerramento,'aberta'), ',' ORDER BY cnpj) FROM public.radar_atendimentos")|$(Pq -c "SELECT encerrado_em = assumido_em + interval '7 days' FROM public.radar_atendimentos WHERE cnpj = '10600000000101'")" \
   "1|104:aberta,106:expirado,108:aberta|t"
eq "G3f tick de novo não fecha nada; a vencida segue contada no card (fechada como expirado)" \
   "$(campo "$(Pq -c "SELECT public.radar_posses_vencer_tick()")" fechadas)|$(como authenticated "$V1" "SELECT (public.radar_prospectar_hoje())->'posses'->>'vencidas_7d'" | tail -1)" \
   "0|1"
# E-mail: V1 (com leads) recebe o bloco; V3 (sem território) tem só um retorno vencido e recebe o e-mail mesmo assim.
P -q -v v3="$V3" <<'SQL'
INSERT INTO public.radar_contatos (id, cnpj, acao, criado_por, created_at, retorno_em, retorno_origem)
VALUES ('c0000000-0000-0000-0000-000000000212', '21200000000101', 'em_conversa', :'v3', now() - interval '8 days',
        (now() AT TIME ZONE 'America/Sao_Paulo')::date - 1, 'vendedor');
UPDATE public.radar_empresas SET prospeccao_status = 'em_conversa', prospeccao_contato_id = 'c0000000-0000-0000-0000-000000000212'
 WHERE cnpj = '21200000000101';
SQL
RE="$(Pq -c "SELECT public.radar_avisar_vendedores(now())")"
echo "AVISAR=$RE" | cut -c1-600
eq "G3g e-mail de V1: corpo com 'Seu acompanhamento', link direto da ficha do retorno, e o que avisou gravado no envio" \
   "$(Pq -c "SELECT (a.mensagem LIKE '%Seu acompanhamento%')||':'||(a.mensagem LIKE '%/radar?cnpj=10100000000101%')||':'||jsonb_array_length(e.acompanhamento->'retornos')||':'||jsonb_array_length(e.acompanhamento->'posses_vencendo')||':'||jsonb_array_length(e.acompanhamento->'posses_vencidas') FROM public.radar_email_vendedor_envios e JOIN public.fornecedor_alerta a ON a.id = e.alerta_id WHERE e.vendedor_user_id = '$V1'")" \
   "true:true:$(Pq -c "SELECT count(*) FROM private.radar_retornos_do_vendedor('$V1', date_trunc('week', now() AT TIME ZONE 'America/Sao_Paulo')::date + 6, now())"):2:1"
eq "G3h V3 sem território e só com acompanhamento: e-mail sai (n_leads 0) com o título de retornos" \
   "$(Pq -c "SELECT e.n_leads||':'||a.titulo FROM public.radar_email_vendedor_envios e JOIN public.fornecedor_alerta a ON a.id = e.alerta_id WHERE e.vendedor_user_id = '$V3'")" \
   "0:Radar: seus retornos e atendimentos da semana"

# ── G4: dedupe por conteúdo ───────────────────────────────────────────────────────────────────────────────
A1="$(reg "$V2" 21100000000101 em_conversa 'nota A')"
A2="$(reg "$V2" 21100000000101 em_conversa 'nota A')"
eq "G4a repetir o MESMO conteúdo em < 2 min é a mesma operação: deduped, nota_gravada, mesmo id" \
   "$(campo "$A2" deduped):$(campo "$A2" nota_gravada):$([ "$(campo "$A1" id)" = "$(campo "$A2" id)" ] && echo mesmo || echo outro)" "true:true:mesmo"
A3="$(reg "$V2" 21100000000101 em_conversa 'nota B')"
eq "G4b nota DIFERENTE em < 2 min é registro novo: as duas notas ficam gravadas" \
   "$(campo "$A3" deduped)|$(Pq -c "SELECT string_agg(nota, ',' ORDER BY created_at) FROM public.radar_contatos WHERE cnpj = '21100000000101'")" \
   "false|nota A,nota B"
A4="$(reg "$V2" 21100000000101 em_conversa)"
eq "G4c repetir sem nota e sem data (app velho) preserva o que está gravado: deduped, retorno de antes" \
   "$(campo "$A4" deduped):$(campo "$A4" retorno_em)" "true:$(campo "$A3" retorno_em)"
A5="$(reg "$V2" 21100000000101 em_conversa 'nota B' "$(Pq -c "SELECT '$HOJE'::date + 20")")"
eq "G4d data DIFERENTE é registro novo (a data anterior fica no histórico)" \
   "$(campo "$A5" deduped):$(campo "$A5" retorno_em)|$(Pq -c "SELECT count(DISTINCT retorno_em) FROM public.radar_contatos WHERE cnpj = '21100000000101'")" \
   "false:$(Pq -c "SELECT '$HOJE'::date + 20")|2"

# ── G5: fronteira, re-aplicação, medição ──────────────────────────────────────────────────────────────────
prefixo "G5a authenticated não executa as leituras private do acompanhamento" \
   "$(erro_como authenticated "$V1" "SELECT * FROM private.radar_acompanhamentos(now())")" "42501 permission denied for function radar_acompanhamentos"
prefixo "G5b anon não executa o registro (DROP + CREATE resetou o ACL; o REVOKE tem de pegar)" \
   "$(erro_como anon '' "SELECT public.registrar_contato_radar('10300000000101', 'em_conversa')")" "42501 permission denied for function registrar_contato_radar"
prefixo "G5c authenticated não roda o tick nem o e-mail" \
   "$(erro_como authenticated "$V1" "SELECT public.radar_posses_vencer_tick()")" "42501 permission denied for function radar_posses_vencer_tick"
eq "G5d uma só assinatura do registro (a de 3 args sumiu) e o cron do tick ativo" \
   "$(Pq -c "SELECT count(*) FROM pg_proc WHERE proname = 'registrar_contato_radar'")|$(Pq -c "SELECT schedule||':'||active FROM cron.job WHERE jobname = 'radar-posses-vencer-diario'")" \
   "1|0 9 * * *:true"
if P -q -1 -f "$MIGG_USADA" >> "$APPLY_LOG" 2>&1; then REAP=ok; else REAP=falhou; tail -5 "$APPLY_LOG"; fi
eq "G5e re-aplicar a migration sobre ela mesma passa (PRE aceita o corpo 'este') e não apaga contato nem envio" \
   "$REAP|$(Pq -c "SELECT count(*) > 0 FROM public.radar_contatos WHERE retorno_em IS NOT NULL")|$(Pq -c "SELECT count(*) FROM public.radar_email_vendedor_envios")" \
   "ok|t|2"
MED="$(P -qAt -v ON_ERROR_STOP=1 -v desde="'2000-01-01'" -f "$MEDIR" 2>&1 || echo MEDIR_FALHOU)"
eq "G5g a medição roda e separa retornos (agendados por origem) e posses (vencidas, avisadas)" \
   "$(printf '%s\n' "$MED" | grep -c '^retornos|' || true):$(printf '%s\n' "$MED" | grep -c '^posses|' || true):$(printf '%s' "$MED" | grep -c MEDIR_FALHOU || true)" \
   "1:1:0"
P -q <<'SQL'
CREATE OR REPLACE FUNCTION public.radar_prospectar_hoje(p_vendedor uuid DEFAULT NULL, p_n integer DEFAULT 3)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $fn$ SELECT '{}'::jsonb $fn$;
SQL
DERIVA_OUT="$(P -q -1 -f "$MIGG_USADA" 2>&1 || true)"
eq "G5f anti-deriva: corpo vivo que não é o predecessor nem este aborta a re-aplicação (e não apaga a outra sessão)" \
   "$(printf '%s' "$DERIVA_OUT" | grep -c 'PRE FALHOU: public.radar_prospectar_hoje')|$(Pq -c "SELECT prosrc LIKE '%{}%' FROM pg_proc WHERE oid = 'public.radar_prospectar_hoje(uuid,integer)'::regprocedure")" \
   "1|t"

echo "PASS=$PASS FAIL=$FAIL"
[ "$FAIL" -eq 0 ]
