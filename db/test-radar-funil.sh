#!/usr/bin/env bash
# Prova PG17 do pacote H do Radar (medir o funil do lead empurrado) — migration 20261107230000_radar_funil_painel,
# aplicada por cima da REAL do pacote D (20261106181000), como em prod:
#   • public.radar_funil: só master/gestor (42501 para farmer e anônimo); e-mail em coorte pela semana do envio,
#     só e-mail REAL (teste fora), clique só do destinatário e só de e-mail ENTREGUE; ficha = 2º momento; card,
#     contato (toque humano válido) e cadastro na semana do fato; "empurrado" = chegou por e-mail entregue ou foi
#     aberto pelo card antes do fato; fora da cobertura do sensor a célula é NULL (ausente ≠ zero), dentro é 0.
#   • sensores: estado ok | falhou | parcial | sem_dado_no_periodo | sem_registro, falhas com motivo (e-mail falho,
#     pendente > 2h, clique perdido, contato/cadastro sem evento no ledger, falha vista pelo cliente).
#   • public.radar_registrar_ficha_entregue: gates com SQLSTATE; marca o clique do dia; sem clique cria a linha com
#     clique_registrado = false; idempotente.
#   • public.radar_registrar_falha_sensor: só staff; contador por (sensor, motivo, usuário, dia); motivo saneado.
#   • ACL nas duas pontas (PUBLIC e anon), tabelas fechadas ao JWT, radar_funil STABLE (a lente libera).
#
#   bash db/test-radar-funil.sh > /tmp/t.log 2>&1; echo "exit=$?"
#   SABOTAGEM=<nome> bash db/test-radar-funil.sh   # tem de ficar VERMELHA
#   bash db/test-radar-funil.sh --falsificar        # controle verde + cada sabotagem vermelha no assert dela
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MIG_D="$REPO_ROOT/supabase/migrations/20261106181000_radar_leads_ao_vendedor.sql"
MIG="$REPO_ROOT/supabase/migrations/20261107230000_radar_funil_painel.sql"

if [ "${1:-}" = "--falsificar" ]; then
  # <sabotagem>:<assert que TEM de acusá-la>. `POST!H2_FALHOU` = a postcondição aborta o apply com a marca exata
  # (`_` vira espaço; grep -F). `_sem_post` cega a postcondição para provar que a suíte pega sozinha.
  SABOTAGENS="gate_funil:A1a teste_conta:A5 clique_de_terceiro:A3d clique_em_falho:A4c cobertura_ignorada:A10a ausente_vira_zero:A7a descarte_conta:A8a contato_morto_conta:A8a empurrado_sempre:A8b ficha_duplica:A15a falha_sem_staff:A11c falha_sem_contador:A11a pendente_nao_e_falha:A6b clique_perdido_some:A11g acl_aberta:POST!H2_FALHOU acl_aberta_sem_post:A2a funil_volatil:POST!H3_FALHOU tabela_aberta:POST!H4_FALHOU tabela_aberta_sem_post:A2c ficha_sem_cap:A12a link_sem_validar:A12c"
  LOGDIR="$(mktemp -d "${TMPDIR:-/tmp}/falsifica-radar-funil.XXXXXX")"
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
DATA="$(mktemp -d "${TMPDIR:-/tmp}/pgtest-radar-funil.XXXXXX")/data"
export LC_ALL="${LC_ALL_TESTE:-C}" LANG="${LC_ALL_TESTE:-C}"
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
cegar_post() { sabotar "  f text;
  t text;
BEGIN
" "  f text;
  t text;
BEGIN
  RETURN;
"; }
case "${SABOTAGEM:-}" in
  "") ;;
  gate_funil)          sabotar "  IF v_uid IS NULL OR NOT COALESCE(private.pode_ver_carteira_completa(v_uid), false) THEN" "  IF false THEN" ;;
  teste_conta)         sabotar "     WHERE NOT e.eh_teste" "     WHERE true" ;;
  clique_de_terceiro)  sabotar "AND a.origem = 'email' AND a.do_destinatario
" "AND a.origem = 'email'
" ;;
  clique_em_falho)     sabotar "     WHERE env.semana >= v_ini AND env.status = 'notificado'
     GROUP BY env.semana, env.uid" "     WHERE env.semana >= v_ini
     GROUP BY env.semana, env.uid" ;;
  cobertura_ignorada)  sabotar "CASE WHEN c.desde IS NULL OR c.desde >= sem.fim THEN 'ausente'" "CASE WHEN false THEN 'ausente'" ;;
  ausente_vira_zero)   sabotar "CASE WHEN cw.ficha_card     <> 'ausente' THEN COALESCE(cc.fichas, 0)          END" "COALESCE(cc.fichas, 0)" ;;
  descarte_conta)      sabotar "        OR (ev.acao IN ('contatado_sem_resposta', 'em_conversa')" "        OR (true" ;;
  contato_morto_conta) sabotar "            AND EXISTS (SELECT 1 FROM public.radar_contatos c WHERE c.id = ev.contato_id))" "            AND true)" ;;
  empurrado_sempre)    sabotar "             AS empurrado" "             OR true AS empurrado" ;;
  ficha_duplica)       sabotar "  IF v_id IS NOT NULL THEN
    IF v_ja THEN" "  IF false THEN
    IF v_ja THEN" ;;
  falha_sem_staff)     sabotar "  IF v_uid IS NULL OR NOT (COALESCE(public.has_role(v_uid, 'employee'::public.app_role), false)" "  IF v_uid IS NULL OR false AND NOT (COALESCE(public.has_role(v_uid, 'employee'::public.app_role), false)" ;;
  falha_sem_contador)  sabotar "DO UPDATE SET n = public.radar_sensor_falhas.n + 1, ultimo_em = now();" "DO UPDATE SET ultimo_em = now();" ;;
  pendente_nao_e_falha) sabotar "                   AND env.criado_em < now() - interval '2 hours'" "                   AND false" ;;
  clique_perdido_some) sabotar "  VALUES (p_origem, p_envio, p_cnpj, v_uid, v_dono = v_uid, v_dia, now(), false)" "  VALUES (p_origem, p_envio, p_cnpj, v_uid, v_dono = v_uid, v_dia, now(), true)" ;;
  acl_aberta)          sabotar "REVOKE ALL ON FUNCTION public.radar_funil(integer) FROM PUBLIC, anon;" "REVOKE ALL ON FUNCTION public.radar_funil(integer) FROM PUBLIC;" ;;
  acl_aberta_sem_post) sabotar "REVOKE ALL ON FUNCTION public.radar_funil(integer) FROM PUBLIC, anon;" "REVOKE ALL ON FUNCTION public.radar_funil(integer) FROM PUBLIC;"; cegar_post ;;
  funil_volatil)       sabotar "RETURNS jsonb
LANGUAGE plpgsql
STABLE" "RETURNS jsonb
LANGUAGE plpgsql
VOLATILE" ;;
  tabela_aberta)       sabotar "REVOKE ALL ON public.radar_sensor_falhas, public.radar_funil_sensores FROM PUBLIC, anon, authenticated;" "REVOKE ALL ON public.radar_sensor_falhas, public.radar_funil_sensores FROM anon;" ;;
  tabela_aberta_sem_post) sabotar "REVOKE ALL ON public.radar_sensor_falhas, public.radar_funil_sensores FROM PUBLIC, anon, authenticated;" "REVOKE ALL ON public.radar_sensor_falhas, public.radar_funil_sensores FROM anon;"; cegar_post ;;
  ficha_sem_cap)       sabotar "  -- Mesmos gates de radar_registrar_abertura_empurrada (20261106181000).
  IF NOT COALESCE(private.cap_radar_prospectar(v_uid), false) THEN" "  -- Mesmos gates de radar_registrar_abertura_empurrada (20261106181000).
  IF false THEN" ;;
  link_sem_validar)    sabotar "      JOIN public.radar_email_vendedor_leads l ON l.envio_id = e.id AND l.cnpj = p_cnpj
" "" ;;
  *) echo "sabotagem desconhecida: $SABOTAGEM"; exit 9 ;;
esac
[ -n "${SABOTAGEM:-}" ] && echo "⚠️  SABOTAGEM ATIVA: $SABOTAGEM"

"$PGBIN/initdb" -D "$DATA" -U postgres -E UTF8 --locale=C >/dev/null
"$PGBIN/pg_ctl" -D "$DATA" -o "-p $PORT -k /tmp" -l "$(dirname "$DATA")/pg.log" -w start >/dev/null
P()  { "$PGBIN/psql" -X -v ON_ERROR_STOP=1 -p "$PORT" -h /tmp -U postgres -d postgres "$@"; }
Pq() { P -qAt "$@"; }

# ── Esquema mínimo (o mesmo de db/test-radar-leads-vendedor.sh, que reproduz prod; + o que o pacote H lê) ──────
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

CREATE TABLE cron.job (jobid bigint PRIMARY KEY, jobname text, schedule text, command text, active boolean DEFAULT true);
CREATE FUNCTION cron.schedule(p_jobname text, p_schedule text, p_command text) RETURNS bigint LANGUAGE plpgsql AS $$
DECLARE v bigint;
BEGIN
  SELECT jobid INTO v FROM cron.job WHERE jobname = p_jobname;
  IF v IS NULL THEN
    SELECT COALESCE(max(jobid), 0) + 1 INTO v FROM cron.job;
    INSERT INTO cron.job (jobid, jobname, schedule, command, active) VALUES (v, p_jobname, p_schedule, p_command, true);
  ELSE
    UPDATE cron.job SET schedule = p_schedule, command = p_command, active = true WHERE jobid = v;
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
  rfb_situacao text, score smallint, score_motivos text[], omie_cadastrado_em timestamptz);
CREATE TABLE public.radar_contatos (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), cnpj text, acao text, criado_por uuid,
  created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE public.radar_atendimentos (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), cnpj text NOT NULL, dono_user_id uuid NOT NULL,
  assumido_em timestamptz NOT NULL, renovado_em timestamptz, encerrado_em timestamptz);
CREATE TABLE public.fornecedor_alerta (
  id bigserial PRIMARY KEY, empresa text NOT NULL,
  tipo text NOT NULL CHECK (tipo IN ('promocao_suspensa','aumento_anunciado','promocao_nova','polling_erro','mapeamento_pendente',
    'oportunidade_calculada','tarefa_atrasada','whatsapp_sla','erro_app','outro','param_auto_resumo','reposicao_pedido_minimo')),
  severidade text NOT NULL DEFAULT 'info' CHECK (severidade IN ('info','atencao','urgente')),
  titulo text NOT NULL, mensagem text,
  status text NOT NULL DEFAULT 'pendente_notificacao' CHECK (status IN ('pendente_notificacao','notificado','falha_notificacao','ignorado')),
  metadata jsonb, criado_em timestamptz NOT NULL DEFAULT now(), notificado_em timestamptz);
CREATE TABLE public.acoes_execucoes (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), acao text NOT NULL,
  origem text NOT NULL DEFAULT 'manual' CHECK (origem IN ('manual','automatica')), executado_por uuid, executado_por_nome text,
  iniciado_em timestamptz NOT NULL DEFAULT now(), finalizado_em timestamptz,
  status text NOT NULL DEFAULT 'executando' CHECK (status IN ('executando','sucesso','erro')), detalhes jsonb);
-- Ledger de eventos (forma de prod, 20261029150100; os triggers que o escrevem não entram: a prova grava o fato direto).
CREATE TABLE public.radar_eventos (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  evento text NOT NULL CHECK (evento IN ('abriu', 'contato', 'contato_desfeito', 'cadastrou')),
  origem text NOT NULL CHECK (origem IN ('humano', 'automatica')),
  ocorrido_em timestamptz NOT NULL, gravado_em timestamptz NOT NULL DEFAULT clock_timestamp(),
  user_id uuid, cnpj text, contato_id uuid, acao text, fonte_id text NOT NULL UNIQUE);
CREATE INDEX ON public.radar_eventos (evento, ocorrido_em);

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
CREATE FUNCTION private.radar_atendimento_expira_em(p_cnpj text, p_dono uuid, p_assumido_em timestamptz, p_renovado_em timestamptz)
RETURNS timestamptz LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS $$
  SELECT GREATEST(p_assumido_em, p_renovado_em) + interval '7 days' $$;
SQL

# ── Atores ────────────────────────────────────────────────────────────────────────────────────────────────
V1=a0000000-0000-0000-0000-000000000001   # farmer com e-mail ligado
V2=a0000000-0000-0000-0000-000000000002   # farmer com e-mail pendente
G=a0000000-0000-0000-0000-000000000008    # gestor (employee + gerencial)
M=a0000000-0000-0000-0000-000000000009    # master
C=a0000000-0000-0000-0000-000000000007    # customer
X=a0000000-0000-0000-0000-00000000000e    # employee sem cargo comercial: staff, sem acesso ao Radar
SIS=00000000-0000-0000-0000-00000000ad0f  # Radar · RFB (contato automático)
P -q -v v1="$V1" -v v2="$V2" -v g="$G" -v m="$M" -v c="$C" -v x="$X" <<'SQL'
INSERT INTO public.user_roles (user_id, role) VALUES
  (:'v1','employee'), (:'v2','employee'), (:'g','employee'), (:'m','master'), (:'c','customer'), (:'x','employee');
INSERT INTO public.commercial_roles (user_id, commercial_role) VALUES (:'v1','farmer'), (:'v2','farmer'), (:'g','gerencial');
INSERT INTO public.profiles (user_id, name, email) VALUES
  (:'v1','Regina','regina@exemplo.com'), (:'v2','Tatyana','taty@exemplo.com'), (:'g','Gestor','g@exemplo.com');
SQL

if ! P -q -f "$MIG_D" > "$(dirname "$DATA")/apply.log" 2>&1; then
  cat "$(dirname "$DATA")/apply.log"; echo "APLICAÇÃO DA MIGRATION DO PACOTE D FALHOU"; exit 1
fi
if ! P -q -f "$MIG_USADA" >> "$(dirname "$DATA")/apply.log" 2>&1; then
  cat "$(dirname "$DATA")/apply.log"; echo "APLICAÇÃO DA MIGRATION FALHOU"; exit 1
fi
grep -q "POSTCONDICAO RADAR FUNIL OK" "$(dirname "$DATA")/apply.log" || [ -n "${SABOTAGEM:-}" ] || {
  echo "APLICAÇÃO SEM O MARCADOR DA POSTCONDIÇÃO"; exit 1; }

PASS=0; FAIL=0
eq() { if [ "$2" = "$3" ]; then echo "PASS $1"; PASS=$((PASS+1)); else echo "FAIL $1 — obtido [$2] esperado [$3]"; FAIL=$((FAIL+1)); fi; }
# como <papel> <uid> <sql>: a chamada COMO o app (SET ROLE + JWT na mesma sessão, como o PostgREST)
como() {
  local claims='{}'; [ -n "$2" ] && claims="{\"sub\":\"$2\"}"
  P -qAt -c "SET ROLE $1" -c "SET request.jwt.claims = '$claims'" -c "$3" 2>&1
}
# erro_como <papel> <uid> <sql>: "<SQLSTATE> <mensagem>" do erro (ou SEM_ERRO); casa-se o prefixo ASCII de caixa fixa
erro_como() {
  local claims='{}'; [ -n "$2" ] && claims="{\"sub\":\"$2\"}"
  local out
  if out="$(P -qAt -v VERBOSITY=verbose -c "SET ROLE $1" -c "SET request.jwt.claims = '$claims'" -c "$3" 2>&1)"; then
    echo "SEM_ERRO"; return 0
  fi
  printf '%s\n' "$out" | sed -n 's/^ERROR:  \([0-9A-Z]\{5\}\): \(.*\)$/\1 \2/p' | head -1
}
prefixo() { case "$2" in "$3"*) eq "$1" "ok" "ok" ;; *) eq "$1" "$2" "$3…" ;; esac; }
# funil <campo da linha> <vendedor> <semana: 0 = corrente, 1 = anterior> — lido COMO o gestor
funil() {
  como authenticated "$G" "SELECT COALESCE(l ->> '$1', 'NULL') FROM jsonb_array_elements(public.radar_funil(8) -> 'linhas') l
    WHERE l ->> 'vendedor_user_id' = '$2'
      AND (l ->> 'semana')::date = date_trunc('week', now() AT TIME ZONE 'America/Sao_Paulo')::date - 7 * $3"
}
sensor() { # sensor <nome> <campo>
  como authenticated "$G" "SELECT s ->> '$2' FROM jsonb_array_elements(public.radar_funil(8) -> 'sensores') s WHERE s ->> 'sensor' = '$1'"
}
falha_n() { # falha_n <sensor> <motivo>
  como authenticated "$G" "SELECT COALESCE((SELECT f ->> 'n' FROM jsonb_array_elements(s -> 'falhas') f WHERE f ->> 'motivo' = '$2'), '0')
    FROM jsonb_array_elements(public.radar_funil(8) -> 'sensores') s WHERE s ->> 'sensor' = '$1'"
}

# Cobertura sob controle da prova (a de prod é a data real do Publish): os sensores instalados há 60 dias; os sem
# declaração (ficha_*) contam do 1º registro.
P -q -c "UPDATE public.radar_funil_sensores SET instalado_em = now() - interval '60 days' WHERE instalado_em IS NOT NULL"

# ── ACL ───────────────────────────────────────────────────────────────────────────────────────────────────
eq "A2a anon não executa radar_funil" \
   "$(Pq -c "SELECT has_function_privilege('anon', 'public.radar_funil(integer)', 'EXECUTE')")" "f"
eq "A2b anon não executa os registradores" \
   "$(Pq -c "SELECT has_function_privilege('anon', 'public.radar_registrar_ficha_entregue(text,text,uuid)', 'EXECUTE')
              OR has_function_privilege('anon', 'public.radar_registrar_falha_sensor(text,text)', 'EXECUTE')")" "f"
eq "A2c tabelas novas fechadas ao JWT (authenticated não lê)" \
   "$(Pq -c "SELECT has_table_privilege('authenticated', 'public.radar_sensor_falhas', 'SELECT')
              OR has_table_privilege('authenticated', 'public.radar_funil_sensores', 'SELECT')")" "f"

# ── Gate do painel ────────────────────────────────────────────────────────────────────────────────────────
prefixo "A1a farmer não lê o funil (42501)" "$(erro_como authenticated "$V1" "SELECT public.radar_funil(8)")" "42501 forbidden: funil"
prefixo "A1b anônimo não lê o funil (42501)" "$(erro_como authenticated "" "SELECT public.radar_funil(8)")" "42501 forbidden: funil"
eq "A1c gestor lê" "$(como authenticated "$G" "SELECT public.radar_funil(8) ? 'linhas'")" "t"
eq "A1d master lê" "$(como authenticated "$M" "SELECT public.radar_funil(8) ? 'linhas'")" "t"
eq "A16 p_semanas limitado a 1..26 (100 → 26, NULL → 8)" \
   "$(como authenticated "$G" "SELECT (public.radar_funil(100) ->> 'semanas_pedidas') || ',' || (public.radar_funil(NULL) ->> 'semanas_pedidas') || ',' || jsonb_array_length(public.radar_funil(3) -> 'semanas')")" "26,8,3"

# ── Cenário: e-mails ──────────────────────────────────────────────────────────────────────────────────────
# Leads: L1..L3 no e-mail REAL de V1 desta semana (entregue); L5 no de V1 da semana passada (FALHOU); L1 também no
# e-mail de TESTE de V1; L6 no e-mail de V2 desta semana (pendente há 3 h).
L1=10000000000001; L2=10000000000002; L3=10000000000003; L4=10000000000004; L5=10000000000005; L6=10000000000006
L9=10000000000009; L8=10000000000008
P -q -v v1="$V1" -v v2="$V2" <<'SQL'
CREATE TEMP TABLE w AS SELECT date_trunc('week', now() AT TIME ZONE 'America/Sao_Paulo')::date AS w0;
INSERT INTO public.fornecedor_alerta (id, empresa, tipo, titulo, status, notificado_em) VALUES
  (1, 'oben', 'outro', 'v1 w0', 'notificado', now() - interval '50 minutes'),
  (2, 'oben', 'outro', 'v1 w1', 'falha_notificacao', NULL),
  (3, 'oben', 'outro', 'v1 teste', 'notificado', now() - interval '50 minutes'),
  (4, 'oben', 'outro', 'v2 w0', 'pendente_notificacao', NULL);
INSERT INTO public.radar_email_vendedor_envios (id, vendedor_user_id, semana, destinatario_email, eh_teste, alerta_id, territorio, n_leads, elegiveis, criado_em)
SELECT '11111111-0000-0000-0000-000000000001'::uuid, :'v1'::uuid, w0, 'regina@exemplo.com', false, 1, '[]'::jsonb, 4, 30, now() - interval '1 hour' FROM w
UNION ALL SELECT '11111111-0000-0000-0000-000000000002', :'v1', w0 - 7, 'regina@exemplo.com', false, 2, '[]', 2, 30, now() - interval '7 days' FROM w
UNION ALL SELECT '11111111-0000-0000-0000-000000000003', :'v1', w0, 'master@exemplo.com', true, 3, '[]', 1, 30, now() - interval '1 hour' FROM w
UNION ALL SELECT '11111111-0000-0000-0000-000000000004', :'v2', w0, 'taty@exemplo.com', false, 4, '[]', 1, 9, now() - interval '3 hours' FROM w;
INSERT INTO public.radar_email_vendedor_leads (envio_id, posicao, cnpj, score, municipio_codigo) VALUES
  ('11111111-0000-0000-0000-000000000001', 1, '10000000000001', 90, '1'),
  ('11111111-0000-0000-0000-000000000001', 2, '10000000000002', 80, '1'),
  ('11111111-0000-0000-0000-000000000001', 3, '10000000000003', 70, '1'),
  ('11111111-0000-0000-0000-000000000001', 4, '10000000000008', 65, '1'),
  ('11111111-0000-0000-0000-000000000002', 1, '10000000000005', 90, '1'),
  ('11111111-0000-0000-0000-000000000002', 2, '10000000000007', 85, '1'),
  ('11111111-0000-0000-0000-000000000003', 1, '10000000000001', 90, '1'),
  ('11111111-0000-0000-0000-000000000004', 1, '10000000000006', 60, '1');
SQL
E1=11111111-0000-0000-0000-000000000001; E2=11111111-0000-0000-0000-000000000002
E3=11111111-0000-0000-0000-000000000003

# V1: L1 clique + ficha; L8 só clique (a ficha não chegou); L3 só ficha (o clique se perdeu); L5 clique no e-mail
# FALHO. L2 só o master clicou (link de V1: não é o destinatário); o master também clica no e-mail de TESTE (L1).
como authenticated "$V1" "SELECT public.radar_registrar_abertura_empurrada('email', '$L1', '$E1')" >/dev/null
R15="$(como authenticated "$V1" "SELECT (r ->> 'registrado') || ',' || (r ->> 'clique_registrado') FROM public.radar_registrar_ficha_entregue('email', '$L1', '$E1') r")"
eq "A15a ficha depois do clique marca o MESMO clique (registrado, clique_registrado)" "$R15" "true,true"
eq "A15b marcar de novo não muda nada (registrado = false)" \
   "$(como authenticated "$V1" "SELECT r ->> 'registrado' FROM public.radar_registrar_ficha_entregue('email', '$L1', '$E1') r")" "false"
eq "A15c uma linha só para L1 de V1, com ficha >= clique" \
   "$(Pq -c "SELECT count(*) || ',' || bool_and(ficha_entregue_em >= aberto_em) FROM public.radar_lead_aberturas WHERE cnpj = '$L1' AND user_id = '$V1'")" "1,true"
como authenticated "$V1" "SELECT public.radar_registrar_abertura_empurrada('email', '$L8', '$E1')" >/dev/null
como authenticated "$V1" "SELECT public.radar_registrar_ficha_entregue('email', '$L3', '$E1')" >/dev/null
eq "A11b ficha sem clique cria a linha marcada clique_registrado = false" \
   "$(Pq -c "SELECT clique_registrado FROM public.radar_lead_aberturas WHERE cnpj = '$L3' AND user_id = '$V1'")" "f"
como authenticated "$V1" "SELECT public.radar_registrar_abertura_empurrada('email', '$L5', '$E2')" >/dev/null
como authenticated "$M" "SELECT public.radar_registrar_abertura_empurrada('email', '$L2', '$E1')" >/dev/null
como authenticated "$M" "SELECT public.radar_registrar_abertura_empurrada('email', '$L1', '$E3')" >/dev/null

# Gates da ficha
prefixo "A12a ficha sem acesso ao Radar (42501)" \
  "$(erro_como authenticated "$X" "SELECT public.radar_registrar_ficha_entregue('card', '$L4')")" "42501 forbidden: radar_prospectar"
prefixo "A12b card com envio (22023)" \
  "$(erro_como authenticated "$V1" "SELECT public.radar_registrar_ficha_entregue('card', '$L4', '$E1')")" "22023 envio obrigatorio"
eq "A12c lead fora do e-mail = link_desconhecido (não grava)" \
   "$(como authenticated "$V1" "SELECT (r ->> 'ok') || ',' || (r ->> 'motivo') FROM public.radar_registrar_ficha_entregue('email', '$L9', '$E1') r")" "false,link_desconhecido"

eq "A3a V1 semana corrente: 1 e-mail gerado, 1 entregue, 0 falho" \
   "$(funil email_enviados "$V1" 0),$(funil email_entregues "$V1" 0),$(funil email_falhos "$V1" 0)" "1,1,0"
eq "A3b V1 semana corrente: 4 leads entregues" "$(funil email_leads_entregues "$V1" 0)" "4"
eq "A3c V1 semana corrente: 3 leads clicados (o clique perdido conta: a ficha prova o clique)" "$(funil email_leads_clicados "$V1" 0)" "3"
eq "A3d clique do master no link de V1 não conta para V1 (só o destinatário)" "$(funil email_leads_clicados "$V1" 0)" "3"
eq "A3e V1 semana corrente: 2 fichas entregues (L1 e L3; L8 é clique sem ficha)" "$(funil email_fichas "$V1" 0)" "2"
eq "A4a V1 semana anterior: 1 gerado, 0 entregue, 1 falho" \
   "$(funil email_enviados "$V1" 1),$(funil email_entregues "$V1" 1),$(funil email_falhos "$V1" 1)" "1,0,1"
eq "A4b V1 semana anterior: 0 lead entregue" "$(funil email_leads_entregues "$V1" 1)" "0"
eq "A4c clique em e-mail que FALHOU não vira clique do funil (numerador ⊂ denominador)" "$(funil email_leads_clicados "$V1" 1)" "0"
eq "A5 e-mail de teste não conta (total de gerados no período = 3)" \
   "$(como authenticated "$G" "SELECT sum((l ->> 'email_enviados')::int) FROM jsonb_array_elements(public.radar_funil(8) -> 'linhas') l")" "3"
eq "A6a V2 semana corrente: 1 gerado, 1 pendente" "$(funil email_enviados "$V2" 0),$(funil email_pendentes "$V2" 0)" "1,1"
eq "A6b sensor de entrega acusa o pendente há mais de 2 h e o falho" \
   "$(falha_n email_entrega pendente_ha_mais_de_2h),$(falha_n email_entrega falha_notificacao),$(sensor email_entrega estado)" "1,1,falhou"
eq "A11g clique perdido aparece como falha do sensor de clique" "$(falha_n abertura_email clique_perdido)" "1"

# ── Card ──────────────────────────────────────────────────────────────────────────────────────────────────
como authenticated "$V1" "SELECT public.radar_registrar_card_servido(3)" >/dev/null
como authenticated "$V1" "SELECT public.radar_registrar_abertura_empurrada('card', '$L4')" >/dev/null
eq "A7a sem nenhum registro de ficha do card, a coluna é AUSENTE (NULL), não 0" "$(funil card_fichas "$V1" 0)" "NULL"
eq "A7b sensor da ficha do card: sem_registro" "$(sensor ficha_card estado)" "sem_registro"
eq "A7c V1 card: 1 dia servido, 3 leads, 1 clique" \
   "$(funil card_dias "$V1" 0),$(funil card_leads_servidos "$V1" 0),$(funil card_leads_clicados "$V1" 0)" "1,3,1"
eq "A13 V2 sem card na semana coberta = 0 (fato), não NULL" "$(funil card_dias "$V2" 0)" "0"
como authenticated "$V1" "SELECT public.radar_registrar_ficha_entregue('card', '$L4')" >/dev/null
eq "A7d depois do 1º registro, a ficha do card conta (1)" "$(funil card_fichas "$V1" 0)" "1"

# ── Contato e cadastro (o ledger grava o fato; aqui direto) ───────────────────────────────────────────────
P -q -v v1="$V1" -v v2="$V2" -v sis="$SIS" <<'SQL'
INSERT INTO public.radar_contatos (id, cnpj, acao, criado_por, created_at) VALUES
  ('c0000000-0000-0000-0000-000000000001', '10000000000001', 'em_conversa', :'v1', now()),
  ('c0000000-0000-0000-0000-000000000009', '10000000000009', 'contatado_sem_resposta', :'v1', now()),
  ('c0000000-0000-0000-0000-000000000002', '10000000000002', 'descartado', :'v1', now()),
  ('c0000000-0000-0000-0000-00000000000a', '10000000000006', 'contatado_sem_resposta', :'sis', now()),
  ('c0000000-0000-0000-0000-00000000000b', '10000000000006', 'contatado_sem_resposta', :'v2', now());  -- sem evento
INSERT INTO public.radar_eventos (evento, origem, ocorrido_em, user_id, cnpj, contato_id, acao, fonte_id) VALUES
  ('contato', 'humano', now(), :'v1', '10000000000001', 'c0000000-0000-0000-0000-000000000001', 'em_conversa', 'contato:c1'),
  ('contato', 'humano', now(), :'v1', '10000000000009', 'c0000000-0000-0000-0000-000000000009', 'contatado_sem_resposta', 'contato:c9'),
  ('contato', 'humano', now(), :'v1', '10000000000002', 'c0000000-0000-0000-0000-000000000002', 'descartado', 'contato:c2'),
  -- contato desfeito: o evento ficou, a linha não existe mais (não é contato válido)
  ('contato', 'humano', now(), :'v1', '10000000000003', 'c0000000-0000-0000-0000-0000000000ff', 'em_conversa', 'contato:cff'),
  ('contato', 'automatica', now(), :'sis', '10000000000006', 'c0000000-0000-0000-0000-00000000000a', 'contatado_sem_resposta', 'contato:ca'),
  ('cadastrou', 'humano', now(), :'v1', '10000000000001', NULL, 'incluir', 'cadastro:10000000000001'),
  ('cadastrou', 'humano', now(), :'v1', '10000000000009', NULL, 'lookup', 'cadastro:10000000000009');
-- A reconciliação casa 'contato:' || id: os ids acima são encurtados, então reescreve o fonte_id para o id real.
UPDATE public.radar_eventos SET fonte_id = 'contato:' || contato_id WHERE evento = 'contato';
INSERT INTO public.radar_empresas (cnpj, omie_cadastrado_em) VALUES
  ('10000000000001', now()), ('10000000000009', now()), ('10000000000077', now());  -- 77: cadastro sem evento
SQL
eq "A8a V1 contatos = 2 (toque humano válido; descarte, desfeito e automático fora)" "$(funil contatos "$V1" 0)" "2"
eq "A8b V1 contatos em lead empurrado = 1 (L1 veio no e-mail entregue; L9 não)" "$(funil contatos_empurrados "$V1" 0)" "1"
eq "A9 V1 cadastros: 1 cliente novo (empurrado) e 1 vínculo com cliente existente" \
   "$(funil cadastros_novos "$V1" 0),$(funil cadastros_novos_empurrados "$V1" 0),$(funil cadastros_vinculo "$V1" 0)" "1,1,1"
eq "A11d reconciliação: contato humano sem evento e cadastro sem evento acusados" \
   "$(falha_n contato contato_sem_evento),$(falha_n cadastro cadastro_sem_evento)" "1,1"

# ── Falha vista pelo cliente ──────────────────────────────────────────────────────────────────────────────
como authenticated "$V1" "SELECT public.radar_registrar_falha_sensor('ficha_email', 'lead_nao_encontrado')" >/dev/null
como authenticated "$V1" "SELECT public.radar_registrar_falha_sensor('ficha_email', 'lead_nao_encontrado')" >/dev/null
eq "A11a contador por (sensor, motivo, usuário, dia): 2 e o sensor fica 'falhou'" \
   "$(falha_n ficha_email lead_nao_encontrado),$(sensor ficha_email estado)" "2,falhou"
eq "A11e motivo saneado ('Erro de Rede!' → erro_de_rede)" \
   "$(como authenticated "$X" "SELECT r ->> 'motivo' FROM public.radar_registrar_falha_sensor('abertura_card', 'Erro de Rede!') r")" "erro_de_rede"
prefixo "A11c customer não grava falha (42501)" \
  "$(erro_como authenticated "$C" "SELECT public.radar_registrar_falha_sensor('card_servido', 'x')")" "42501 forbidden: falha"
prefixo "A11f sensor fora do vocabulário (22023)" \
  "$(erro_como authenticated "$V1" "SELECT public.radar_registrar_falha_sensor('outro', 'x')")" "22023 sensor invalido"

# ── Cobertura (ausente ≠ zero) ────────────────────────────────────────────────────────────────────────────
eq "A10b com o sensor instalado há 60 dias, a semana anterior está coberta (completa)" \
   "$(como authenticated "$G" "SELECT s -> 'cobertura' ->> 'abertura_email' FROM jsonb_array_elements(public.radar_funil(8) -> 'semanas') s WHERE NOT (s ->> 'corrente')::boolean ORDER BY s ->> 'semana' DESC LIMIT 1")" "completa"
P -q -c "UPDATE public.radar_funil_sensores SET instalado_em = now() - interval '1 second' WHERE sensor = 'abertura_email';
         UPDATE public.radar_lead_aberturas SET aberto_em = now(), ficha_entregue_em = GREATEST(ficha_entregue_em, now()) WHERE origem = 'email';"
eq "A10a semana anterior à instalação: clique AUSENTE (NULL), não 0" "$(funil email_leads_clicados "$V1" 1)" "NULL"
eq "A10c falha vence parcial no estado do sensor (o clique perdido segue acusado)" "$(sensor abertura_email estado)" "falhou"
eq "A10d a cobertura da semana corrente é parcial" \
   "$(como authenticated "$G" "SELECT s -> 'cobertura' ->> 'abertura_email' FROM jsonb_array_elements(public.radar_funil(8) -> 'semanas') s WHERE (s ->> 'corrente')::boolean")" "parcial"

echo "PASS=$PASS FAIL=$FAIL"
[ "$FAIL" -eq 0 ]
