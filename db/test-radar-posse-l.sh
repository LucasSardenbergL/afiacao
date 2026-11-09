#!/usr/bin/env bash
# Prova PG17 do pacote L do Radar — migration 20261111130000_radar_posse_pacote_l, aplicada sobre a cadeia do pacote G
# (20261106181000 → 20261107140001 → 20261107230000 → fixture G → 20261111100000) e sobre as definições VIVAS da PROD de
# radar_definir_atendimento e desfazer_contato_radar (db/fixtures/radar-l-predecessora-prod-20261108.sql):
#   L1 registrar "em conversa"/"não atendeu" assume o lead livre, renova o próprio, nunca toma o de outro; já-cliente e
#      teto de 100 recusam sem perder o contato; clique repetido não mexe; desfazer o contato que criou a posse a fecha;
#   L2 vencimento por reconstrução cronológica: o retorno futuro protege no intervalo (o caso 1/11 → 2/11 com retorno
#      30/11 → 20/11), sem vencimento retroativo; contato de outro usuário não mexe na posse; contato tardio não
#      ressuscita; outro desfecho do dono troca o compromisso;
#   L3 ACL, re-aplicação e anti-deriva.
# O esquema mínimo é o de db/test-radar-acompanhamento-g.sh (copiado, não acoplado).
#
#   bash db/test-radar-posse-l.sh > /tmp/t.log 2>&1; echo "exit=$?"
#   SABOTAGEM=<nome> bash db/test-radar-posse-l.sh   # tem de ficar VERMELHA
#   bash db/test-radar-posse-l.sh --falsificar        # controle verde + cada sabotagem vermelha no assert dela
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MIG="$REPO_ROOT/supabase/migrations/20261106181000_radar_leads_ao_vendedor.sql"
MIG2="$REPO_ROOT/supabase/migrations/20261107140001_radar_email_semanal_toggle.sql"
MIGE="$REPO_ROOT/supabase/migrations/20261107230000_radar_distribuicao_pacote_e.sql"
FIX="$REPO_ROOT/db/fixtures/radar-g-predecessora-prod-20261108.sql"
MIGG="$REPO_ROOT/supabase/migrations/20261111100000_radar_acompanhamento_pacote_g.sql"
FIXL="$REPO_ROOT/db/fixtures/radar-l-predecessora-prod-20261108.sql"
MIGL="$REPO_ROOT/supabase/migrations/20261111130000_radar_posse_pacote_l.sql"

if [ "${1:-}" = "--falsificar" ]; then
  # <sabotagem>:<assert que TEM de acusá-la>. `POST!P2_FALHOU` = a postcondição aborta o apply com a marca exata.
  SABOTAGENS="sem_auto_assumir:L1a sem_origem:L1a dedupe_assume:L1f outro_mexe_posse:L2e sem_protecao_no_laco:L2b laco_sem_exit:L2d protecao_inicial_cega:L2f desfazer_nao_libera:L1h desfazer_ignora_posterior:L1i acl_aberta:POST!P2_FALHOU pre_cega:L3c"
  LOGDIR="$(mktemp -d "${TMPDIR:-/tmp}/falsifica-radar-posse-l.XXXXXX")"
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
PORT="${PGPORT_TEST:-5498}"
DATA="$(mktemp -d "${TMPDIR:-/tmp}/pgtest-radar-posse-l.XXXXXX")/data"
export LC_ALL="${LC_ALL_TESTE:-C}" LANG="${LC_ALL_TESTE:-C}"
MIGL_USADA="$(dirname "$DATA")/migl.sql"
cleanup() { "$PGBIN/pg_ctl" -D "$DATA" stop -m immediate >/dev/null 2>&1 || true; rm -rf "$(dirname "$DATA")"; }
trap cleanup EXIT

cp "$MIGL" "$MIGL_USADA"
sabotar() { # $1 = de, $2 = para (literal; substitui TODAS as ocorrências) — na migration do pacote L
  python3 -I - "$MIGL_USADA" "$1" "$2" <<'PY'
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
  sem_auto_assumir)          sabotar "  IF p_acao IN ('em_conversa', 'contatado_sem_resposta') THEN
    v_posse := public.radar_definir_atendimento(p_cnpj, 'assumir');" "  IF false THEN
    v_posse := public.radar_definir_atendimento(p_cnpj, 'assumir');" ;;
  sem_origem)                sabotar "SET contato_origem_id = v_id" "SET contato_origem_id = NULL" ;;
  dedupe_assume)             sabotar "    RETURN jsonb_build_object('id', v_existing, 'deduped', true, 'nota_gravada', true, 'retorno_em', v_existing_retorno,
                              'posse', NULL);" "    RETURN jsonb_build_object('id', v_existing, 'deduped', true, 'nota_gravada', true, 'retorno_em', v_existing_retorno,
                              'posse', public.radar_definir_atendimento(p_cnpj, 'assumir'));" ;;
  outro_mexe_posse)          sabotar "     WHERE x.cnpj = p_cnpj AND x.criado_por = p_dono AND x.created_at > v_inicio" "     WHERE x.cnpj = p_cnpj AND x.created_at > v_inicio" ;;
  sem_protecao_no_laco)      sabotar "    v_protege := CASE WHEN c.acao = 'em_conversa' AND c.retorno_em IS NOT NULL
                      THEN ((c.retorno_em + 3)::timestamp AT TIME ZONE 'America/Sao_Paulo') END;" "    NULL;" ;;
  laco_sem_exit)             sabotar "    EXIT WHEN c.created_at >= v_limite;" "    NULL;" ;;
  protecao_inicial_cega)     sabotar "   WHERE x.cnpj = p_cnpj AND x.criado_por = p_dono AND x.created_at <= v_inicio" "   WHERE false" ;;
  desfazer_nao_libera)       sabotar "AND a.contato_origem_id = p_id AND a.dono_user_id = v_uid" "AND false" ;;
  desfazer_ignora_posterior) sabotar "     AND NOT EXISTS (SELECT 1 FROM public.radar_contatos o
                      WHERE o.cnpj = v_cnpj AND o.criado_por = v_uid AND o.id <> p_id AND o.created_at >= v_criado);" ";" ;;
  acl_aberta)                sabotar "REVOKE ALL ON FUNCTION private.radar_atendimento_expira_em(text,uuid,timestamptz,timestamptz) FROM PUBLIC, anon, authenticated;" "GRANT EXECUTE ON FUNCTION private.radar_atendimento_expira_em(text,uuid,timestamptz,timestamptz) TO authenticated;" ;;
  pre_cega)                  sabotar "      RAISE EXCEPTION 'PRE FALHOU: % vivo (md5 %) não é o predecessor revisado nem este — outra sessão mudou; refaça o pré-voo', r.alvo, r.vivo;" "      NULL;" ;;
  *) echo "sabotagem desconhecida: $SABOTAGEM"; exit 9 ;;
esac
[ -n "${SABOTAGEM:-}" ] && echo "⚠️  SABOTAGEM ATIVA: $SABOTAGEM"

# ── Esquema mínimo (copiado de db/test-radar-acompanhamento-g.sh) e a cadeia até o pacote G ─────────────────────────
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

APPLY_LOG="$(dirname "$DATA")/apply.log"
if ! P -q -f "$FIX" >> "$APPLY_LOG" 2>&1; then cat "$APPLY_LOG"; echo "APLICAÇÃO DO FIXTURE DA PROD (G) FALHOU"; exit 1; fi
if ! P -q -1 -f "$MIGG" >> "$APPLY_LOG" 2>&1; then tail -20 "$APPLY_LOG"; echo "APLICAÇÃO DO PACOTE G FALHOU"; exit 1; fi
# O escritor da posse e o desfazer: as definições VIVAS da PROD (a de definir chama a public.pode_ver_carteira_completa).
P -q <<'SQL'
CREATE FUNCTION public.pode_ver_carteira_completa(_uid uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path TO 'public' AS $$ SELECT private.pode_ver_carteira_completa(_uid) $$;
SQL
if ! P -q -f "$FIXL" >> "$APPLY_LOG" 2>&1; then cat "$APPLY_LOG"; echo "APLICAÇÃO DO FIXTURE DA PROD (L) FALHOU"; exit 1; fi
# Paridade de ACL com a PROD (o default privilege do teste abre tudo; a PROD fecha o PUBLIC/anon das duas).
P -q -c "REVOKE ALL ON FUNCTION public.radar_definir_atendimento(text,text) FROM PUBLIC, anon" \
     -c "REVOKE ALL ON FUNCTION public.desfazer_contato_radar(uuid) FROM PUBLIC, anon"

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

# L0: os fixtures SÃO os predecessores que a PRE conhece (md5 dos corpos vivos da PROD de 2026-11-08).
eq "L0 predecessores no banco de teste = os md5 da PROD que a PRE aceita" \
   "$(Pq -c "SELECT string_agg(md5(prosrc), ',' ORDER BY oid::regprocedure::text) FROM pg_proc WHERE oid IN ('public.registrar_contato_radar(text,text,text,date)'::regprocedure, 'private.radar_atendimento_expira_em(text,uuid,timestamptz,timestamptz)'::regprocedure, 'public.desfazer_contato_radar(uuid)'::regprocedure, 'public.radar_definir_atendimento(text,text)'::regprocedure)")" \
   "b2f4de64f1110150c4c66905cfe3c542,0ded55f382a8c3d5aaa4ea8372912479,0b64fb7ec8d8700e2183af484675a7d7,6d7138c65159a00dd2066a4a15b6583b"

if ! P -q -1 -f "$MIGL_USADA" >> "$APPLY_LOG" 2>&1; then
  tail -20 "$APPLY_LOG"; echo "APLICAÇÃO DA MIGRATION DO PACOTE L FALHOU"; exit 1
fi
Pq -c "SELECT 'MD5_ESTE '||oid::regprocedure::text||' '||md5(prosrc) FROM pg_proc WHERE oid IN ('public.registrar_contato_radar(text,text,text,date)'::regprocedure, 'private.radar_atendimento_expira_em(text,uuid,timestamptz,timestamptz)'::regprocedure, 'public.desfazer_contato_radar(uuid)'::regprocedure) ORDER BY 1"

# ── Atores e dados ────────────────────────────────────────────────────────────────────────────────────────
V1=a0000000-0000-0000-0000-000000000011
V2=a0000000-0000-0000-0000-000000000012
V3=a0000000-0000-0000-0000-000000000013   # chega ao teto de 100 posses
P -q -v v1="$V1" -v v2="$V2" -v v3="$V3" <<'SQL'
INSERT INTO public.user_roles (user_id, role) VALUES (:'v1','employee'), (:'v2','employee'), (:'v3','employee');
INSERT INTO public.commercial_roles (user_id, commercial_role) VALUES (:'v1','farmer'), (:'v2','farmer'), (:'v3','farmer');
INSERT INTO public.profiles (user_id, name, email) VALUES
  (:'v1','Regina Celia','regina@exemplo.com'), (:'v2','Nilo Serrano','nilo@exemplo.com'), (:'v3','Teto Cheio','v3@exemplo.com');
INSERT INTO public.radar_empresas (cnpj, razao_social, municipio_codigo, municipio_nome, uf, score, ja_cliente)
SELECT c, 'Lead '||c, '3122306', 'DIVINOPOLIS', 'MG', 80, c = '30900000000101'
  FROM unnest(ARRAY['30100000000101','30200000000101','30300000000101','30400000000101','30500000000101',
                    '30600000000101','30700000000101','30800000000101','30900000000101','31000000000101',
                    '32000000000101','32100000000101','32200000000101','32300000000101','32400000000101']) c;
-- V3 já com 100 posses ativas (o teto do escritor).
INSERT INTO public.radar_empresas (cnpj, razao_social, score) SELECT '8'||lpad(i::text, 11, '0')||'01', 'Teto '||i, 50 FROM generate_series(1, 100) i;
INSERT INTO public.radar_atendimentos (cnpj, dono_user_id, assumido_em) SELECT '8'||lpad(i::text, 11, '0')||'01', :'v3', now() FROM generate_series(1, 100) i;
SQL

reg() {  # reg <uid> <cnpj> <acao> [nota] [retorno] → jsonb
  local args="p_cnpj => '$2', p_acao => '$3'"
  [ -n "${4:-}" ] && args="$args, p_nota => '$4'"
  [ -n "${5:-}" ] && args="$args, p_retorno => '$5'::date"
  como authenticated "$1" "SELECT public.registrar_contato_radar($args)" | tail -1
}
envelhecer() { P -q -c "UPDATE public.radar_contatos SET created_at = created_at - interval '${2:-3} minutes' WHERE cnpj = '$1'"; }
campo() { printf '%s' "$1" | python3 -I -c "import json,sys; d=json.load(sys.stdin)
for k in '$2'.split('.'):
    d = d.get(k) if isinstance(d, dict) else None
print('null' if d is None else (str(d).lower() if isinstance(d,bool) else d))"; }
posse() { Pq -c "SELECT COALESCE(string_agg(left(dono_user_id::text, 0)||CASE dono_user_id WHEN '$V1' THEN 'V1' WHEN '$V2' THEN 'V2' ELSE '?' END||':'||COALESCE(motivo_encerramento,'aberta'), ',' ORDER BY id), '-') FROM public.radar_atendimentos WHERE cnpj = '$1'"; }
expira() { Pq -c "SELECT (private.radar_atendimento_expira_em(a.cnpj, a.dono_user_id, a.assumido_em, a.renovado_em) AT TIME ZONE 'America/Sao_Paulo')::text FROM public.radar_atendimentos a WHERE a.cnpj = '$1' AND a.encerrado_em IS NULL"; }

# ── L1: o contato dá a posse ──────────────────────────────────────────────────────────────────────────────
R="$(reg "$V1" 30100000000101 em_conversa 'falei com o João')"
eq "L1a 'em conversa' num lead livre: o contato fica, a posse nasce para quem conversou e guarda o contato de origem" \
   "$(campo "$R" deduped):$(campo "$R" posse.ok):$(campo "$R" posse.renovado)|$(posse 30100000000101)|$(Pq -c "SELECT contato_origem_id::text = '$(campo "$R" id)' FROM public.radar_atendimentos WHERE cnpj = '30100000000101'")" \
   "false:true:false|V1:aberta|t"
envelhecer 30100000000101
P -q -c "UPDATE public.radar_atendimentos SET assumido_em = assumido_em - interval '3 minutes' WHERE cnpj = '30100000000101'"
R="$(reg "$V1" 30100000000101 contatado_sem_resposta)"
eq "L1b 'não atendeu' num lead que já é do próprio: renova (renovado_em = agora), não abre outra posse" \
   "$(campo "$R" posse.ok):$(campo "$R" posse.renovado)|$(posse 30100000000101)|$(Pq -c "SELECT renovado_em IS NOT NULL FROM public.radar_atendimentos WHERE cnpj = '30100000000101'")" \
   "true:true|V1:aberta|t"
ANTES="$(expira 30100000000101)"
R="$(reg "$V2" 30100000000101 em_conversa 'liguei também')"
eq "L1c colega registra contato no lead de V1: o contato é gravado, a posse NÃO muda de dono e o prazo de V1 não mexe" \
   "$(campo "$R" deduped):$(campo "$R" posse.ok):$(campo "$R" posse.motivo):$(campo "$R" posse.dono_nome)|$(posse 30100000000101)|$([ "$ANTES" = "$(expira 30100000000101)" ] && echo mesmo || echo mudou)|$(Pq -c "SELECT prospeccao_status FROM public.radar_empresas WHERE cnpj = '30100000000101'")" \
   "false:false:em_atendimento:Regina Celia|V1:aberta|mesmo|em_conversa"
R="$(reg "$V1" 30200000000101 descartado 'não usa')"
eq "L1d descartar num lead livre não cria posse (posse null)" \
   "$(campo "$R" posse)|$(posse 30200000000101)" "null|-"
R="$(reg "$V1" 30300000000101 contatado_sem_resposta)"
eq "L1e 'não atendeu' num lead livre também assume" \
   "$(campo "$R" posse.ok):$(campo "$R" posse.renovado)|$(posse 30300000000101)" "true:false|V1:aberta"
R="$(reg "$V1" 30300000000101 contatado_sem_resposta)"
eq "L1f clique repetido (mesmo conteúdo < 2 min) é deduped e não mexe na posse (posse null, sem renovação)" \
   "$(campo "$R" deduped):$(campo "$R" posse)|$(Pq -c "SELECT renovado_em IS NULL FROM public.radar_atendimentos WHERE cnpj = '30300000000101'")" \
   "true:null|t"
R="$(reg "$V1" 30900000000101 em_conversa)"
eq "L1g já-cliente: o contato é gravado e a posse é recusada (motivo ja_cliente)" \
   "$(campo "$R" deduped):$(campo "$R" posse.ok):$(campo "$R" posse.motivo)|$(posse 30900000000101)" "false:false:ja_cliente|-"
R="$(reg "$V3" 31000000000101 em_conversa)"
eq "L1g2 vendedor no teto de 100: o contato é gravado e a posse é recusada (motivo limite), sem erro" \
   "$(campo "$R" deduped):$(campo "$R" posse.ok):$(campo "$R" posse.motivo)|$(Pq -c "SELECT count(*) FROM public.radar_contatos WHERE cnpj = '31000000000101'")" "false:false:limite|1"
# Desfazer: a posse que o contato criou sai junto; com outro contato do dono depois, fica.
R="$(reg "$V1" 30400000000101 em_conversa 'clique errado')"
D="$(como authenticated "$V1" "SELECT public.desfazer_contato_radar('$(campo "$R" id)')" | tail -1)"
eq "L1h desfazer o contato que CRIOU a posse fecha a posse como 'liberado' (e diz posse_desfeita)" \
   "$(campo "$D" deleted):$(campo "$D" posse_desfeita)|$(posse 30400000000101)|$(Pq -c "SELECT encerrado_por = '$V1' FROM public.radar_atendimentos WHERE cnpj = '30400000000101'")" \
   "true:true|V1:liberado|t"
R1="$(reg "$V1" 30500000000101 em_conversa 'primeiro')"
R2="$(reg "$V1" 30500000000101 contatado_sem_resposta)"
D="$(como authenticated "$V1" "SELECT public.desfazer_contato_radar('$(campo "$R1" id)')" | tail -1)"
eq "L1i desfazer o contato de origem com outro contato do dono DEPOIS: a posse fica (o outro contato a sustenta)" \
   "$(campo "$D" deleted):$(campo "$D" posse_desfeita)|$(posse 30500000000101)" "true:false|V1:aberta"
D="$(como authenticated "$V2" "SELECT public.desfazer_contato_radar('$(Pq -c "SELECT id FROM public.radar_contatos WHERE cnpj = '30100000000101' AND criado_por = '$V2'")')" | tail -1)"
eq "L1j o colega desfaz o contato dele no lead de V1: a posse de V1 fica" \
   "$(campo "$D" deleted):$(campo "$D" posse_desfeita)|$(posse 30100000000101)" "true:false|V1:aberta"

# ── L2: vencimento por reconstrução cronológica ──────────────────────────────────────────────────────────
# O caso do Codex, em datas fixas: assume 1/11, conversa 2/11 com retorno 30/11, nova conversa 20/11 com retorno 27/11.
P -q -v v1="$V1" <<'SQL'
INSERT INTO public.radar_atendimentos (cnpj, dono_user_id, assumido_em) VALUES ('32000000000101', :'v1', '2026-11-01 12:00-03');
INSERT INTO public.radar_contatos (id, cnpj, acao, criado_por, created_at, retorno_em, retorno_origem) VALUES
  ('c0000000-0000-0000-0000-000000003201', '32000000000101', 'em_conversa', :'v1', '2026-11-02 12:00-03', '2026-11-30', 'vendedor');
SQL
ANTES_B="$(expira 32000000000101)"
P -q -c "INSERT INTO public.radar_contatos (id, cnpj, acao, criado_por, created_at, retorno_em, retorno_origem) VALUES ('c0000000-0000-0000-0000-000000003202', '32000000000101', 'em_conversa', '$V1', '2026-11-20 12:00-03', '2026-11-27', 'vendedor')"
eq "L2a só com a conversa de 2/11 (retorno 30/11): a posse vale até retorno+3 = 03/12 00:00 BRT (protegida entre 9/11 e 20/11)" \
   "$ANTES_B" "2026-12-03 00:00:00"
eq "L2b com a nova conversa de 20/11 (retorno 27/11): vale até 30/11 00:00 BRT — não 'venceu em 9/11' para trás" \
   "$(expira 32000000000101)" "2026-11-30 00:00:00"
eq "L2c invariante: o vencimento nunca cai antes do último contato feito com a posse viva (20/11)" \
   "$(Pq -c "SELECT private.radar_atendimento_expira_em(a.cnpj, a.dono_user_id, a.assumido_em, a.renovado_em) > '2026-11-20 12:00-03' FROM public.radar_atendimentos a WHERE a.cnpj = '32000000000101'")" "t"
# Contato tardio não ressuscita: assume 1/11, nada até 20/11 (venceu 8/11) → conversa 20/11 com retorno 30/11.
P -q -v v1="$V1" <<'SQL'
INSERT INTO public.radar_atendimentos (cnpj, dono_user_id, assumido_em) VALUES ('32100000000101', :'v1', '2026-11-01 12:00-03');
INSERT INTO public.radar_contatos (cnpj, acao, criado_por, created_at, retorno_em, retorno_origem) VALUES
  ('32100000000101', 'em_conversa', :'v1', '2026-11-20 12:00-03', '2026-11-30', 'vendedor');
SQL
eq "L2d contato feito com a posse já vencida não ressuscita (vence em assumido+7 = 08/11 12:00 BRT)" \
   "$(expira 32100000000101)" "2026-11-08 12:00:00"
# Contato de OUTRO usuário não mexe: o prazo de V1 é o mesmo antes e depois do "descartado" e da conversa de V2.
ANTES_OUTRO="$(expira 32000000000101)"
P -q -c "INSERT INTO public.radar_contatos (cnpj, acao, criado_por, created_at) VALUES ('32000000000101', 'descartado', '$V2', '2026-11-21 12:00-03'), ('32000000000101', 'em_conversa', '$V2', '2026-11-22 12:00-03')"
eq "L2e contato de outro usuário (descarte, conversa) não encurta nem estende a posse do dono" \
   "$ANTES_OUTRO|$(expira 32000000000101)" "2026-11-30 00:00:00|2026-11-30 00:00:00"
# Renovar não apaga o compromisso de antes: assume 1/11, conversa 2/11 retorno 30/11, renova 5/11 → segue 03/12.
P -q -v v1="$V1" <<'SQL'
INSERT INTO public.radar_atendimentos (cnpj, dono_user_id, assumido_em, renovado_em) VALUES ('32200000000101', :'v1', '2026-11-01 12:00-03', '2026-11-05 12:00-03');
INSERT INTO public.radar_contatos (cnpj, acao, criado_por, created_at, retorno_em, retorno_origem) VALUES
  ('32200000000101', 'em_conversa', :'v1', '2026-11-02 12:00-03', '2026-11-30', 'vendedor');
SQL
eq "L2f renovar depois da conversa não apaga o compromisso dela (segue 03/12 00:00 BRT)" \
   "$(expira 32200000000101)" "2026-12-03 00:00:00"
# Outro desfecho do DONO troca o compromisso: conversa 2/11 retorno 30/11, depois "não atendeu" 4/11 → 11/11 12:00.
P -q -v v1="$V1" <<'SQL'
INSERT INTO public.radar_atendimentos (cnpj, dono_user_id, assumido_em) VALUES ('32300000000101', :'v1', '2026-11-01 12:00-03');
INSERT INTO public.radar_contatos (cnpj, acao, criado_por, created_at, retorno_em, retorno_origem) VALUES
  ('32300000000101', 'em_conversa', :'v1', '2026-11-02 12:00-03', '2026-11-30', 'vendedor'),
  ('32300000000101', 'contatado_sem_resposta', :'v1', '2026-11-04 12:00-03', '2026-11-09', 'padrao');
SQL
eq "L2g 'não atendeu' do dono depois da conversa troca o compromisso: volta à regra do toque (04/11 + 7 = 11/11 12:00)" \
   "$(expira 32300000000101)" "2026-11-11 12:00:00"
# O tick concorda com a leitura: fecha a vencida no instante do vencimento e deixa a protegida aberta.
P -q -c "SELECT public.radar_posses_vencer_tick('2026-11-25 12:00-03')" >/dev/null
eq "L2h tick em 25/11: fecha a de 8/11 (expirado, no vencimento) e a de 11/11; a protegida até 30/11 segue aberta" \
   "$(Pq -c "SELECT string_agg(left(cnpj,3)||':'||COALESCE(motivo_encerramento,'aberta')||CASE WHEN encerrado_em IS NOT NULL THEN '@'||(encerrado_em AT TIME ZONE 'America/Sao_Paulo')::date::text ELSE '' END, ',' ORDER BY cnpj) FROM public.radar_atendimentos WHERE cnpj IN ('32000000000101','32100000000101','32300000000101')")" \
   "320:aberta,321:expirado@2026-11-08,323:expirado@2026-11-11"
# Pelo caminho real: o auto-assumir de agora + retorno do vendedor protege além dos 7 dias.
HOJE="$(Pq -c "SELECT (now() AT TIME ZONE 'America/Sao_Paulo')::date")"
R="$(reg "$V1" 32400000000101 em_conversa 'retorno longe' "$(Pq -c "SELECT '$HOJE'::date + 30")")"
eq "L2i 'em conversa' com retorno em 30 dias pela RPC: a posse criada vale até retorno+3 (não 7 dias)" \
   "$(expira 32400000000101)" "$(Pq -c "SELECT ('$HOJE'::date + 33)::timestamp::text")"

# ── L3: fronteira, re-aplicação, anti-deriva ──────────────────────────────────────────────────────────────
prefixo "L3a authenticated não executa o vencimento interno" \
   "$(erro_como authenticated "$V1" "SELECT private.radar_atendimento_expira_em('30100000000101', '$V1', now(), NULL)")" "42501 permission denied for function radar_atendimento_expira_em"
prefixo "L3b anon não executa o registro nem o desfazer" \
   "$(erro_como anon '' "SELECT public.desfazer_contato_radar(gen_random_uuid())")" "42501 permission denied for function desfazer_contato_radar"
if P -q -1 -f "$MIGL_USADA" >> "$APPLY_LOG" 2>&1; then REAP=ok; else REAP=falhou; tail -5 "$APPLY_LOG"; fi
P -q <<'SQL'
CREATE OR REPLACE FUNCTION public.desfazer_contato_radar(p_id uuid) RETURNS jsonb LANGUAGE sql SECURITY DEFINER
  SET search_path TO 'public' AS $fn$ SELECT '{}'::jsonb $fn$;
SQL
DERIVA_OUT="$(P -q -1 -f "$MIGL_USADA" 2>&1 || true)"
eq "L3c re-aplicar passa (PRE aceita 'este'); corpo vivo de outra sessão aborta a re-aplicação e fica intacto" \
   "$REAP|$(printf '%s' "$DERIVA_OUT" | grep -c 'PRE FALHOU: public.desfazer_contato_radar')|$(Pq -c "SELECT prosrc LIKE '%{}%' FROM pg_proc WHERE oid = 'public.desfazer_contato_radar(uuid)'::regprocedure")" \
   "ok|1|t"

echo "PASS=$PASS FAIL=$FAIL"
[ "$FAIL" -eq 0 ]
