#!/usr/bin/env bash
# Prova PG17 do pacote E do Radar — migration 20261107230000_radar_distribuicao_pacote_e (aplicada sobre a
# 20261106181000_radar_leads_ao_vendedor e a 20261107140001_radar_email_semanal_toggle, como em PROD):
#   E1 só lead da foto vigente (lote `complete` mais novo; sem lote completo não recorta) e com contato;
#   E2 "não repetir" conta e-mail ENTREGUE (notificado), não o registro; falha não queima lead nem consome a semana
#      (tentativa 2); o card segue a mesma janela, e os leads da semana corrente continuam nele;
#   E3 posse que o próprio vendedor assumiu sai; E4 lead atribuído pelo gestor entra primeiro, mesmo fora do território;
#   E5 erro de um vendedor não derruba os outros e vai para o ledger (status erro);
#   E6 fallback de território (compartilhado), dono processado antes, motivo do território vazio;
#   E7 URL do link vem de company_config.app_url_publica; valor inválido não manda e-mail.
#
#   bash db/test-radar-distribuicao-e.sh > /tmp/t.log 2>&1; echo "exit=$?"
#   SABOTAGEM=<nome> bash db/test-radar-distribuicao-e.sh   # tem de ficar VERMELHA
#   bash db/test-radar-distribuicao-e.sh --falsificar        # controle verde + cada sabotagem vermelha no assert dela
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MIG="$REPO_ROOT/supabase/migrations/20261106181000_radar_leads_ao_vendedor.sql"
MIG2="$REPO_ROOT/supabase/migrations/20261107140001_radar_email_semanal_toggle.sql"
MIGE="$REPO_ROOT/supabase/migrations/20261107230000_radar_distribuicao_pacote_e.sql"

if [ "${1:-}" = "--falsificar" ]; then
  # <sabotagem>:<assert que TEM de acusá-la>. `POST!P2_FALHOU` = a postcondição aborta o apply com a marca exata
  # (`_` vira espaço; grep -F). `_sem_post` cega a postcondição para provar que a suíte pega sozinha.
  SABOTAGENS="sem_lote:E1a lote_qualquer_status:E1a sem_contato:E1b sem_lote_completo_recorta:E1c queima_registro:E2a falha_consome_semana:E2b semana_corrente_queima:E2d pendente_nao_bloqueia:E2e sem_janela:E2g teste_queima:E2h posse_propria_fica:E3 sem_atribuido:E4a atribuido_sem_prioridade:E4a atribuido_expirado:E4b sem_isolamento:E5a ledger_sucesso:E5b sem_fallback:E6a fallback_com_dono:E6b dono_depois:E6c outro_vendedor_repete:E6c sem_motivo:E6e url_fixa:E7b url_sem_validar:E7c acl_aberta:POST!P2_FALHOU acl_aberta_sem_post:E8a card_volatil:POST!P3_FALHOU card_volatil_sem_post:E8c unique_velha:POST!P4_FALHOU unique_velha_sem_post:E2b pre_cega:E9b"
  LOGDIR="$(mktemp -d "${TMPDIR:-/tmp}/falsifica-radar-distribuicao-e.XXXXXX")"
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
DATA="$(mktemp -d "${TMPDIR:-/tmp}/pgtest-radar-distribuicao-e.XXXXXX")/data"
export LC_ALL=C LANG=C
MIGE_USADA="$(dirname "$DATA")/mige.sql"
cleanup() { "$PGBIN/pg_ctl" -D "$DATA" stop -m immediate >/dev/null 2>&1 || true; rm -rf "$(dirname "$DATA")"; }
trap cleanup EXIT

cp "$MIGE" "$MIGE_USADA"
sabotar() { # $1 = de, $2 = para (literal; substitui TODAS as ocorrências) — na migration do pacote E
  python3 -I - "$MIGE_USADA" "$1" "$2" <<'PY'
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
LOTE_RAMO="       AND (par.lote IS NULL OR re.ultimo_lote = par.lote)
"
CONTATO_RAMO="       AND (NULLIF(btrim(re.telefone1), '') IS NOT NULL OR NULLIF(btrim(re.telefone2), '') IS NOT NULL
            OR NULLIF(btrim(re.email), '') IS NOT NULL)
"
case "${SABOTAGEM:-}" in
  "") ;;
  sem_lote)                 sabotar "$LOTE_RAMO" "" ;;
  lote_qualquer_status)     sabotar "             WHERE s.status = 'complete' ORDER BY s.mes_referencia DESC LIMIT 1) AS lote" "             ORDER BY s.mes_referencia DESC LIMIT 1) AS lote" ;;
  sem_contato)              sabotar "$CONTATO_RAMO" "" ;;
  sem_lote_completo_recorta) sabotar "(par.lote IS NULL OR re.ultimo_lote = par.lote)" "(re.ultimo_lote = par.lote)" ;;
  queima_registro)          sabotar "AND fa.status = 'notificado' AND e.semana < par.semana)" "AND e.semana < par.semana)" ;;
  falha_consome_semana)     sabotar "                    AND fa.status IS DISTINCT FROM 'falha_notificacao') THEN" "                    ) THEN" ;;
  semana_corrente_queima)   sabotar "AND fa.status = 'notificado' AND e.semana < par.semana)" "AND fa.status = 'notificado')" ;;
  pendente_nao_bloqueia)    sabotar "                    AND fa.status IS DISTINCT FROM 'falha_notificacao') THEN" "                    AND fa.status = 'notificado') THEN" ;;
  sem_janela)               sabotar "                AND e.criado_em >= par.desde
" "" ;;
  teste_queima)             sabotar "                AND e.eh_teste = false
                AND e.criado_em >= par.desde" "                AND e.criado_em >= par.desde" ;;
  posse_propria_fica)       sabotar "                     OR (a.dono_user_id = p_vendedor AND a.atribuido_por IS NULL))" "                     )" ;;
  sem_atribuido)            sabotar "      JOIN public.radar_empresas re ON re.cnpj = ab.cnpj" "      JOIN public.radar_empresas re ON re.cnpj = ab.cnpj AND false" ;;
  atribuido_sem_prioridade) sabotar "OVER (ORDER BY u.atribuido DESC, u.score DESC" "OVER (ORDER BY u.score DESC" && \
                            sabotar "   ORDER BY u.atribuido DESC, u.score DESC, u.clientes DESC, u.cnpj
   LIMIT" "   ORDER BY u.score DESC, u.clientes DESC, u.cnpj
   LIMIT" ;;
  atribuido_expirado)       sabotar "       AND a.atribuido_por IS NOT NULL
       AND a.encerrado_em IS NULL
       AND private.radar_atendimento_expira_em(a.cnpj, a.dono_user_id, a.assumido_em, a.renovado_em) > p_agora
  )," "       AND a.atribuido_por IS NOT NULL
       AND a.encerrado_em IS NULL
  )," ;;
  sem_isolamento)           sabotar "      GET STACKED DIAGNOSTICS v_estado = RETURNED_SQLSTATE, v_msg = MESSAGE_TEXT;" "      RAISE;" ;;
  ledger_sucesso)           sabotar "            CASE WHEN jsonb_array_length(v_erros) = 0 THEN 'sucesso' ELSE 'erro' END," "            'sucesso'," ;;
  sem_fallback)             sabotar "       AND NOT EXISTS (SELECT 1 FROM proprio)" "       AND false" ;;
  fallback_com_dono)        sabotar "       AND NOT EXISTS (SELECT 1 FROM proprio)" "       AND NOT EXISTS (SELECT 1 FROM proprio p2 WHERE p2.codigo = pm.codigo)" ;;
  dono_depois)              sabotar "     ORDER BY NOT EXISTS (SELECT 1 FROM private.radar_territorio_do_vendedor(c.vendedor_user_id, 3) t
                           WHERE NOT t.compartilhado),
              c.vendedor_user_id" "     ORDER BY c.vendedor_user_id" ;;
  outro_vendedor_repete)    sabotar "                     OR (e.vendedor_user_id <> p_vendedor AND NOT u.atribuido
                         AND fa.status IN ('notificado', 'pendente_notificacao'))))" "                     ))" ;;
  sem_motivo)               sabotar "                                                     'causa', private.radar_territorio_motivo(r.vendedor));" "                                                     'causa', NULL);" ;;
  url_fixa)                 sabotar "  SELECT NULLIF(btrim(cc.value), '') INTO v_app FROM public.company_config cc WHERE cc.key = 'app_url_publica';" "  v_app := NULL;" ;;
  url_sem_validar)          sabotar "  IF v_app !~ c_url_ok THEN" "  IF false THEN" ;;
  acl_aberta)               sabotar "REVOKE ALL ON FUNCTION private.radar_leads_do_vendedor(uuid, integer, timestamptz) FROM PUBLIC, anon, authenticated;" "REVOKE ALL ON FUNCTION private.radar_leads_do_vendedor(uuid, integer, timestamptz) FROM anon;" ;;
  acl_aberta_sem_post)      sabotar "REVOKE ALL ON FUNCTION private.radar_leads_do_vendedor(uuid, integer, timestamptz) FROM PUBLIC, anon, authenticated;" "REVOKE ALL ON FUNCTION private.radar_leads_do_vendedor(uuid, integer, timestamptz) FROM anon;"; cegar_post ;;
  card_volatil)             sabotar "RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS \$fn\$
DECLARE
  v_uid    uuid" "RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = ''
AS \$fn\$
DECLARE
  v_uid    uuid" ;;
  card_volatil_sem_post)    sabotar "RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS \$fn\$
DECLARE
  v_uid    uuid" "RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = ''
AS \$fn\$
DECLARE
  v_uid    uuid"; cegar_post ;;
  unique_velha)             sabotar "    ALTER TABLE public.radar_email_vendedor_envios
      DROP CONSTRAINT radar_email_vendedor_envios_vendedor_user_id_semana_eh_test_key;" "    NULL;" ;;
  unique_velha_sem_post)    sabotar "    ALTER TABLE public.radar_email_vendedor_envios
      DROP CONSTRAINT radar_email_vendedor_envios_vendedor_user_id_semana_eh_test_key;" "    NULL;"; cegar_post ;;
  pre_cega)                 sabotar "      RAISE EXCEPTION 'PRE FALHOU: % vivo (md5 %) não é o predecessor revisado nem este — outra sessão mudou; refaça o pré-voo', r.alvo, r.vivo;" "      NULL;" ;;
  *) echo "sabotagem desconhecida: $SABOTAGEM"; exit 9 ;;
esac
[ -n "${SABOTAGEM:-}" ] && echo "⚠️  SABOTAGEM ATIVA: $SABOTAGEM"

"$PGBIN/initdb" -D "$DATA" -U postgres -E UTF8 --locale=C >/dev/null
"$PGBIN/pg_ctl" -D "$DATA" -o "-p $PORT -k /tmp" -l "$(dirname "$DATA")/pg.log" -w start >/dev/null
P()  { "$PGBIN/psql" -X -v ON_ERROR_STOP=1 -p "$PORT" -h /tmp -U postgres -d postgres "$@"; }
Pq() { P -qAt "$@"; }

# ── Esquema mínimo (o de db/test-radar-leads-vendedor.sh + as colunas e tabelas vivas que o pacote E lê, medidas
#    em PROD via psql-ro em 2026-11-07: radar_empresas.telefone1/telefone2/email/ultimo_lote, radar_ingest_state,
#    radar_atendimentos.atribuido_por, company_config com UNIQUE (key)) ─────────────────────────────────────────
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
  rfb_situacao text, score smallint, score_motivos text[],
  telefone1 text, telefone2 text, email text, ultimo_lote text);
CREATE INDEX idx_radar_muni ON public.radar_empresas (municipio_codigo) WHERE ja_cliente = false AND prospeccao_status <> 'descartado';
CREATE TABLE public.radar_ingest_state (mes_referencia text PRIMARY KEY, status text NOT NULL, iniciado_em timestamptz NOT NULL);
CREATE TABLE public.radar_contatos (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), cnpj text, criado_por uuid,
  created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE public.radar_atendimentos (id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, cnpj text NOT NULL,
  dono_user_id uuid NOT NULL, assumido_em timestamptz NOT NULL, renovado_em timestamptz, encerrado_em timestamptz,
  atribuido_por uuid);
CREATE UNIQUE INDEX radar_atendimentos_aberto_uniq ON public.radar_atendimentos (cnpj) WHERE encerrado_em IS NULL;
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
CREATE FUNCTION private.radar_atendimento_expira_em(p_cnpj text, p_dono uuid, p_assumido_em timestamptz, p_renovado_em timestamptz)
RETURNS timestamptz LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE
  v_inicio timestamptz := GREATEST(p_assumido_em, p_renovado_em);
  v_expira timestamptz := v_inicio + interval '7 days';
  v_toque timestamptz;
BEGIN
  FOR v_toque IN SELECT c.created_at FROM public.radar_contatos c
     WHERE c.cnpj = p_cnpj AND c.criado_por = p_dono AND c.created_at > v_inicio ORDER BY c.created_at
  LOOP
    EXIT WHEN v_toque >= v_expira;
    v_expira := GREATEST(v_expira, v_toque + interval '7 days');
  END LOOP;
  RETURN v_expira;
END $$;
SQL

# ── Atores ────────────────────────────────────────────────────────────────────────────────────────────────
# V4 tem o MENOR uuid de propósito: por uuid ele iria antes do dono (V1) e levaria os leads dele.
V1=a0000000-0000-0000-0000-000000000011   # farmer dono: DIV 4 · NS 3 · CLA 2
V2=a0000000-0000-0000-0000-000000000012   # farmer dono de CAJ (+1 cliente em DIV); o envio dele QUEBRA (gatilho de teste) → E5
V3=a0000000-0000-0000-0000-000000000013   # farmer sem carteira → sem_carteira
V4=a0000000-0000-0000-0000-000000000004   # farmer 2º em tudo: DIV 2 · NS 1 → território compartilhado
V5=a0000000-0000-0000-0000-000000000015   # farmer com carteira só em cidade fora do Radar → carteira_sem_municipio
G=a0000000-0000-0000-0000-000000000008    # gestor (employee + gerencial): atribui; sem papel de vendedor
M=a0000000-0000-0000-0000-000000000009    # master
export V1 V2 V3 V4 V5 G M

P -q -v v1="$V1" -v v2="$V2" -v v3="$V3" -v v4="$V4" -v v5="$V5" -v g="$G" -v m="$M" <<'SQL'
INSERT INTO public.user_roles (user_id, role) VALUES
  (:'v1','employee'), (:'v2','employee'), (:'v3','employee'), (:'v4','employee'), (:'v5','employee'), (:'g','employee'), (:'m','master');
INSERT INTO public.commercial_roles (user_id, commercial_role) VALUES
  (:'v1','farmer'), (:'v2','farmer'), (:'v3','farmer'), (:'v4','farmer'), (:'v5','farmer'), (:'g','gerencial');
INSERT INTO public.profiles (user_id, name, email) VALUES
  (:'v1','Regina Celia','regina@exemplo.com'), (:'v2','Quebra Sempre','quebra@exemplo.com'), (:'v3','Sem Carteira','v3@exemplo.com'),
  (:'v4','Segunda Sempre','v4@exemplo.com'), (:'v5','Fora do Mapa','v5@exemplo.com'), (:'g','Gestor','gestor@exemplo.com'),
  (:'m','Founder','founder@exemplo.com');
INSERT INTO public.radar_municipios (codigo, nome, uf) VALUES
  ('3122306','DIVINÓPOLIS','MG'), ('3145208','NOVA SERRANA','MG'), ('3116907','CLÁUDIO','MG'),
  ('3114402','CARMO DO CAJURU','MG'), ('3106200','BELO HORIZONTE','MG');
INSERT INTO public.radar_ingest_state VALUES
  ('2026-09','complete','2026-10-21 16:00+00'), ('2026-10','complete','2026-10-27 16:00+00'),
  ('2026-11','running','2026-11-05 16:00+00');   -- lote em voo NÃO é a foto
CREATE TEMP TABLE semente (dono uuid, cidade text, uf text, n int);
INSERT INTO semente VALUES
  (:'v1','Divinopolis','MG',4), (:'v1','Nova Serrana','MG',3), (:'v1','Claudio','MG',2),
  (:'v2','Carmo do Cajuru','MG',3), (:'v2','Divinopolis','MG',1),   -- V2 tem 1 cliente em DIV (dono é V1): fica fora
  (:'v4','Divinopolis','MG',2), (:'v4','Nova Serrana','MG',1),
  (:'v5','Cidade Que Nao Existe','MG',2);
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
-- Gatilho DE TESTE: o envio de V2 sempre quebra (o mundo real: um dado ruim de um vendedor).
CREATE FUNCTION public._quebra_v2() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.vendedor_user_id = 'a0000000-0000-0000-0000-000000000012' THEN RAISE EXCEPTION 'dado ruim do V2'; END IF;
  RETURN NEW;
END $$;
SQL

# ── Leads (todos da foto 2026-10 com telefone, salvo onde dito) ───────────────────────────────────────────
# DIV: 101 95 · 102 99 saiu do dump (lote 2026-09) · 103 98 sem contato · 104 97 só e-mail · 105 96 posse do PRÓPRIO V1
#      · 106 94 posse ativa de V2 · 107 93 · NS: 111 91 · 112 80 · CLA: 113 85 · 114 70 · CAJ (V2): 130 60
# BH (fora do território de V1): 120 50 atribuído a V1 pelo gestor (ativo) · 121 60 atribuído mas vencido
P -q <<'SQL'
INSERT INTO public.radar_empresas (cnpj, razao_social, municipio_codigo, municipio_nome, uf, score, score_motivos, telefone1, telefone2, email, ultimo_lote) VALUES
  ('10100000000001','Lead 101','3122306','Divinopolis','MG',95,ARRAY['CNAE 3101'],'3732220001',NULL,NULL,'2026-10'),
  ('10200000000001','Lead 102','3122306','Divinopolis','MG',99,NULL,'3732220002',NULL,NULL,'2026-09'),
  ('10300000000001','Lead 103','3122306','Divinopolis','MG',98,NULL,'  ','',NULL,'2026-10'),
  ('10400000000001','Lead 104','3122306','Divinopolis','MG',97,NULL,NULL,NULL,'contato@l104.com','2026-10'),
  ('10500000000001','Lead 105','3122306','Divinopolis','MG',96,NULL,'3732220005',NULL,NULL,'2026-10'),
  ('10600000000001','Lead 106','3122306','Divinopolis','MG',94,NULL,'3732220006',NULL,NULL,'2026-10'),
  ('10700000000001','Lead 107','3122306','Divinopolis','MG',93,NULL,NULL,'3732220007',NULL,'2026-10'),
  ('11100000000001','Lead 111','3145208','Nova Serrana','MG',91,NULL,'3732220011',NULL,NULL,'2026-10'),
  ('11200000000001','Lead 112','3145208','Nova Serrana','MG',80,NULL,'3732220012',NULL,NULL,'2026-10'),
  ('11300000000001','Lead 113','3116907','Claudio','MG',85,NULL,'3732220013',NULL,NULL,'2026-10'),
  ('11400000000001','Lead 114','3116907','Claudio','MG',70,NULL,'3732220014',NULL,NULL,'2026-10'),
  ('12000000000001','Lead 120','3106200','Belo Horizonte','MG',50,NULL,'3132220020',NULL,NULL,'2026-10'),
  ('12100000000001','Lead 121','3106200','Belo Horizonte','MG',60,NULL,'3132220021',NULL,NULL,'2026-10'),
  ('13000000000001','Lead 130','3114402','Carmo do Cajuru','MG',60,NULL,'3732220030',NULL,NULL,'2026-10');
SQL
# Posses com relógio FIXO (expiram em 2026-11-29: cobrem as semanas de 16/11 e 23/11; em 2027 já venceram).
P -q -v v1="$V1" -v v2="$V2" -v g="$G" <<'SQL'
INSERT INTO public.radar_atendimentos (cnpj, dono_user_id, assumido_em, renovado_em, atribuido_por) VALUES
  ('10500000000001', :'v1', '2026-11-15 12:00+00', '2026-11-22 12:00+00', NULL),
  ('10600000000001', :'v2', '2026-11-15 12:00+00', '2026-11-22 12:00+00', NULL),
  ('12000000000001', :'v1', '2026-11-15 12:00+00', '2026-11-22 12:00+00', :'g'),
  ('12100000000001', :'v1', '2026-10-01 12:00+00', NULL, :'g');
SQL

APPLY_LOG="$(dirname "$DATA")/apply.log"
for f in "$MIG" "$MIG2"; do
  if ! P -q -f "$f" > "$APPLY_LOG" 2>&1; then cat "$APPLY_LOG"; echo "APLICAÇÃO DO PREDECESSOR FALHOU: $f"; exit 1; fi
done
P -q -c "CREATE TRIGGER _quebra_v2 BEFORE INSERT ON public.radar_email_vendedor_envios FOR EACH ROW EXECUTE FUNCTION public._quebra_v2()"
if ! P -q -f "$MIGE_USADA" >> "$APPLY_LOG" 2>&1; then
  cat "$APPLY_LOG"; echo "APLICAÇÃO DA MIGRATION DO PACOTE E FALHOU"; exit 1
fi

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
# leads <vendedor> <p_agora>: "cnpj3[*=atribuído],…|elegíveis"
leads() { Pq -c "SELECT COALESCE(string_agg(left(cnpj,3)||CASE WHEN atribuido THEN '*' ELSE '' END, ',' ORDER BY posicao), '-')||'|'||COALESCE(max(elegiveis)::text, '0') FROM private.radar_leads_do_vendedor('$1', 5, '$2')"; }
terr() { Pq -c "SELECT COALESCE(string_agg(right(municipio_codigo,3)||':'||clientes||CASE WHEN compartilhado THEN '~' ELSE '' END, ',' ORDER BY clientes DESC, municipio_codigo), '-') FROM private.radar_territorio_do_vendedor('$1', 3)"; }
envio_leads() { Pq -c "SELECT COALESCE(string_agg(left(l.cnpj,3)||CASE WHEN l.atribuido THEN '*' ELSE '' END, ',' ORDER BY l.posicao), '-') FROM public.radar_email_vendedor_leads l JOIN public.radar_email_vendedor_envios e ON e.id = l.envio_id WHERE e.vendedor_user_id = '$1' AND e.semana = '$2' AND e.tentativa = ${3:-1}"; }
SEM_A=2026-11-16

# ── E1/E3/E4: a escolha ───────────────────────────────────────────────────────────────────────────────────
eq "E1a fora quem saiu do dump (102, lote 2026-09) e o lote em voo (2026-11 running) não vira a foto" \
   "$(leads "$V1" "$SEM_A 11:00+00" | grep -o '10[12]' | tr '\n' ' ')" "101 "
eq "E1b fora quem não tem contato (103: telefone em branco, sem e-mail); só e-mail (104) basta" \
   "$(leads "$V1" "$SEM_A 11:00+00" | grep -o '103\|104' | tr '\n' ' ')" "104 "
eq "E3 fora a posse que o PRÓPRIO V1 assumiu (105); a de outro vendedor (106) segue fora" \
   "$(leads "$V1" "$SEM_A 11:00+00" | grep -o '10[567]' | tr '\n' ' ')" "107 "
eq "E4a top de V1: o atribuído pelo gestor (120, BH, fora do território) em 1º; depois score; elegíveis = 8" \
   "$(leads "$V1" "$SEM_A 11:00+00")" "120*,104,101,107,111|8"
eq "E4b atribuído com posse vencida (121) não entra" \
   "$(leads "$V1" "$SEM_A 11:00+00" | grep -o '12[01]' | tr '\n' ' ')" "120 "

# ── E6: território ────────────────────────────────────────────────────────────────────────────────────────
eq "E6a território: V1 dono (DIV, NS, CLA); V4, 2º em tudo, recebe os dele marcados compartilhado (~)" \
   "$(terr "$V1")|$(terr "$V4")" "306:4,208:3,907:2|306:2~,208:1~"
eq "E6b o fallback não tira nada do dono e não entra para quem já é dono de algum município (V2: só CAJ)" \
   "$(terr "$V2")" "402:3"
eq "E6d motivo do território vazio: V3 sem carteira · V5 carteira fora do Radar · G não é vendedor · V1 nenhum" \
   "$(Pq -c "SELECT COALESCE(private.radar_territorio_motivo('$V3'),'-')||','||COALESCE(private.radar_territorio_motivo('$V5'),'-')||','||COALESCE(private.radar_territorio_motivo('$G'),'-')||','||COALESCE(private.radar_territorio_motivo('$V1'),'-')")" \
   "sem_carteira,carteira_sem_municipio,nao_e_vendedor,-"

# ── E5/E6/E7: e-mail da semana A ──────────────────────────────────────────────────────────────────────────
P -q -v v1="$V1" -v v2="$V2" -v v3="$V3" -v v4="$V4" -v v5="$V5" <<'SQL'
INSERT INTO public.radar_email_vendedor_config (vendedor_user_id, ativo) VALUES
  (:'v1', true), (:'v2', true), (:'v3', true), (:'v4', true), (:'v5', true);
SQL
RA="$(Pq -c "SELECT public.radar_avisar_vendedores('$SEM_A 11:00+00')" 2>&1 || true)"
eq "E5a o erro de V2 não derruba os outros: V1 e V4 avisados, V2 em erros (com SQLSTATE), sem alerta órfão de V2" \
   "$(printf '%s' "$RA" | python3 -I -c "import json,sys; d=json.load(sys.stdin); print(','.join(sorted(a['vendedor'][-2:] for a in d['avisados']))+'|'+','.join(e['vendedor'][-2:]+':'+e['sqlstate'] for e in d['erros']))")|$(Pq -c "SELECT count(*) FROM public.fornecedor_alerta")" \
   "04,11|12:P0001|2"
eq "E5b ledger escrito mesmo com erro, e com status erro (1 linha, 2 avisados, 2 pulados, 1 erro)" \
   "$(Pq -c "SELECT count(*)||':'||max(status)||':'||max(jsonb_array_length(detalhes->'avisados'))||':'||max(jsonb_array_length(detalhes->'pulados'))||':'||max(jsonb_array_length(detalhes->'erros')) FROM public.acoes_execucoes WHERE acao = 'radar.avisar_vendedores'")" \
   "1:erro:2:2:1"
eq "E6c dono primeiro: V1 leva os 5 dele; V4 (compartilhado, uuid menor) não repete o e-mail do dono e fica com o 112" \
   "$(envio_leads "$V1" "$SEM_A")|$(envio_leads "$V4" "$SEM_A")|$(Pq -c "SELECT territorio->0->>'compartilhado' FROM public.radar_email_vendedor_envios WHERE vendedor_user_id = '$V4'")" \
   "120*,104,101,107,111|112|true"
eq "E6e pulados com a causa do território vazio" \
   "$(printf '%s' "$RA" | python3 -I -c "import json,sys; d=json.load(sys.stdin); print(','.join(sorted(p['vendedor'][-2:]+':'+p['motivo']+':'+str(p.get('causa')) for p in d['pulados'])))")" \
   "13:sem_territorio:sem_carteira,15:sem_territorio:carteira_sem_municipio"
ENV_V1="$(Pq -c "SELECT id FROM public.radar_email_vendedor_envios WHERE vendedor_user_id = '$V1'")"
eq "E7a link do e-mail com a URL semeada em company_config; corpo diz o atribuído e a regra nova" \
   "$(Pq -c "SELECT (a.mensagem LIKE '%https://steu.lovable.app/radar/abrir/$ENV_V1/12000000000001%')||':'||(a.mensagem LIKE '%1 delas foi passada a você pelo gestor.%')||':'||(a.mensagem LIKE '%sem telefone nem e-mail%')||':'||(a.mensagem LIKE '%leads que você já assumiu%') FROM public.fornecedor_alerta a WHERE a.id = (SELECT alerta_id FROM public.radar_email_vendedor_envios WHERE id = '$ENV_V1')")" \
   "true:true:true:true"

# ── E2: entregue × registro ───────────────────────────────────────────────────────────────────────────────
P -q -c "UPDATE public.fornecedor_alerta SET status = 'falha_notificacao' WHERE id = (SELECT alerta_id FROM public.radar_email_vendedor_envios WHERE id = '$ENV_V1')"
eq "E2a e-mail que FALHOU não queima: na semana seguinte V1 recebe os mesmos 5" \
   "$(leads "$V1" "2026-11-23 11:00+00")" "120*,104,101,107,111|7"
RB="$(Pq -c "SELECT public.radar_avisar_vendedores('2026-11-18 11:00+00')" 2>&1 || true)"
eq "E2b e-mail que falhou não consome a semana: V1 ganha a tentativa 2 com os mesmos leads" \
   "$(Pq -c "SELECT string_agg(tentativa::text, ',' ORDER BY tentativa) FROM public.radar_email_vendedor_envios WHERE vendedor_user_id = '$V1' AND semana = '$SEM_A'")|$(envio_leads "$V1" "$SEM_A" 2)" \
   "1,2|120*,104,101,107,111"
eq "E2e na fila (V4, pendente) bloqueia a semana: sem tentativa 2" \
   "$(Pq -c "SELECT count(*) FROM public.radar_email_vendedor_envios WHERE vendedor_user_id = '$V4'")|$(printf '%s' "$RB" | python3 -I -c "import json,sys; d=json.load(sys.stdin); print(sum(1 for p in d['pulados'] if p['vendedor'].endswith('04') and p['motivo'] == 'ja_enviado_na_semana'))")" \
   "1|1"
P -q -c "UPDATE public.fornecedor_alerta SET status = 'notificado' WHERE status = 'pendente_notificacao'"
eq "E2c entregue queima: na semana seguinte V1 não revê os 5 (e o 112, entregue a V4, também fica fora)" \
   "$(leads "$V1" "2026-11-23 11:00+00")" "113,114|2"
eq "E2d o card desta semana continua com os leads do e-mail desta semana (só semana ANTERIOR queima)" \
   "$(leads "$V1" "2026-11-20 15:00+00")" "120*,104,101,107,111|7"
Pq -c "SELECT public.radar_avisar_vendedores('2026-11-19 11:00+00')" >/dev/null
eq "E2f entregue na semana: re-rodar não gera tentativa 3" \
   "$(Pq -c "SELECT count(*) FROM public.radar_email_vendedor_envios WHERE vendedor_user_id = '$V1'")" "2"
eq "E2g janela de 90 dias: em março o que foi entregue em novembro volta (e as posses venceram: 105 e 106 também)" \
   "$(leads "$V1" "2027-03-01 11:00+00")" "104,105,101,106,107|9"
P -q -v v1="$V1" <<'SQL'
UPDATE public.radar_email_vendedor_config SET email_teste = 'founder@exemplo.com' WHERE vendedor_user_id = :'v1';
SQL
Pq -c "SELECT public.radar_avisar_vendedores('2026-11-23 11:00+00')" >/dev/null
P -q -c "UPDATE public.fornecedor_alerta SET status = 'notificado' WHERE status = 'pendente_notificacao'"
eq "E2h envio de TESTE entregue não queima: a semana do teste (113, 114) volta para V1 na seguinte (com 105 e 106, posses vencidas em 29/11)" \
   "$(envio_leads "$V1" "2026-11-23")|$(leads "$V1" "2026-11-30 11:00+00")" "113,114|105,106,113,114|4"

# ── E7: URL configurável ──────────────────────────────────────────────────────────────────────────────────
P -q -v v1="$V1" <<'SQL'
UPDATE public.radar_email_vendedor_config SET email_teste = NULL WHERE vendedor_user_id = :'v1';
UPDATE public.company_config SET value = ' https://app.exemplo.com.br/ ' WHERE key = 'app_url_publica';
SQL
Pq -c "SELECT public.radar_avisar_vendedores('2026-11-30 11:00+00')" >/dev/null
ENV_V1C="$(Pq -c "SELECT id FROM public.radar_email_vendedor_envios WHERE vendedor_user_id = '$V1' AND semana = '2026-11-30'")"
eq "E7b trocar company_config.app_url_publica troca o link (aparado, sem barra dupla)" \
   "$(Pq -c "SELECT (a.mensagem LIKE '%https://app.exemplo.com.br/radar/abrir/$ENV_V1C/%')||':'||(a.mensagem LIKE '%steu.lovable.app%') FROM public.fornecedor_alerta a JOIN public.radar_email_vendedor_envios e ON e.alerta_id = a.id WHERE e.id = '$ENV_V1C'")" \
   "true:false"
P -q -c "UPDATE public.company_config SET value = 'javascript:alert(1)' WHERE key = 'app_url_publica'"
ANTES_E7="$(Pq -c "SELECT count(*) FROM public.fornecedor_alerta")"
R7="$(Pq -c "SELECT public.radar_avisar_vendedores('2026-12-07 11:00+00')->>'erro'")"
eq "E7c URL fora do formato: nenhum e-mail, ledger com status erro" \
   "$R7|$(Pq -c "SELECT count(*) FROM public.fornecedor_alerta")|$(Pq -c "SELECT status FROM public.acoes_execucoes WHERE acao = 'radar.avisar_vendedores' ORDER BY iniciado_em DESC LIMIT 1")" \
   "app_url_publica_invalida|$ANTES_E7|erro"
P -q -c "UPDATE public.company_config SET value = 'https://steu.lovable.app' WHERE key = 'app_url_publica'"

# ── E8: card, painel e fronteira ──────────────────────────────────────────────────────────────────────────
eq "E8b card de V1: chaves novas (atribuido, compartilhado, territorio_motivo nulo) e nada fora da foto/sem contato" \
   "$(como authenticated "$V1" "SELECT jsonb_typeof(x->'leads'->0->'atribuido')||':'||(x->'territorio'->0->>'compartilhado')||':'||jsonb_typeof(x->'territorio_motivo')||':'||(x::text NOT LIKE '%10200000000001%' AND x::text NOT LIKE '%10300000000001%') FROM public.radar_prospectar_hoje() x" | tail -1)" \
   "boolean:false:null:true"
eq "E8d card do gestor (sem papel de vendedor): território vazio com o motivo" \
   "$(como authenticated "$G" "SELECT jsonb_array_length(x->'territorio')||':'||(x->>'territorio_motivo') FROM public.radar_prospectar_hoje() x" | tail -1)" \
   "0:nao_e_vendedor"
eq "E8e painel do master: compartilhado no território e o motivo do vazio" \
   "$(como authenticated "$M" "SELECT string_agg(right(u->>'user_id',2)||':'||COALESCE(u->>'territorio_motivo','-')||':'||COALESCE(u->'territorio'->0->>'compartilhado','-'), ',' ORDER BY u->>'user_id') FROM jsonb_array_elements((SELECT public.radar_email_semanal_painel())->'usuarios') u WHERE u->>'user_id' IN ('$V1','$V4','$V5')" | tail -1)" \
   "04:-:true,11:-:false,15:carteira_sem_municipio:-"
prefixo "E8a authenticated não executa a escolha private (DROP + CREATE reseta ACL; o REVOKE tem de pegar)" \
   "$(erro_como authenticated "$V1" "SELECT * FROM private.radar_leads_do_vendedor('$V4', 5, now())")" "42501 permission denied for function radar_leads_do_vendedor"
prefixo "E8a2 authenticated não executa o território nem o motivo" \
   "$(erro_como authenticated "$V1" "SELECT private.radar_territorio_motivo('$V4')")" "42501 permission denied for function radar_territorio_motivo"
prefixo "E8a3 anon não executa o card" \
   "$(erro_como anon '' "SELECT public.radar_prospectar_hoje()")" "42501 permission denied for function radar_prospectar_hoje"
eq "E8c card e painel seguem leitura PURA (STABLE: allowlist da lente)" \
   "$(Pq -c "SELECT string_agg(provolatile::text, ',' ORDER BY oid::regprocedure::text) FROM pg_proc WHERE oid IN ('public.radar_prospectar_hoje(uuid,integer)'::regprocedure, 'public.radar_email_semanal_painel()'::regprocedure)")" \
   "s,s"

# ── E1c: sem lote completo, não recorta (como a fila) ─────────────────────────────────────────────────────
P -q -c "UPDATE public.radar_ingest_state SET status = 'error'"
eq "E1c sem lote completo não há foto: o 102 (lote velho) volta, nunca 'zero leads'" \
   "$(leads "$V1" "2027-03-01 11:00+00" | cut -d, -f1)" "102"
P -q -c "UPDATE public.radar_ingest_state SET status = 'complete' WHERE mes_referencia IN ('2026-09','2026-10')"

# ── E9: re-aplicação e anti-deriva ────────────────────────────────────────────────────────────────────────
P -q -c "UPDATE public.company_config SET value = 'https://outro.exemplo.com' WHERE key = 'app_url_publica'"
if ! P -q -f "$MIGE_USADA" >> "$APPLY_LOG" 2>&1; then tail -5 "$APPLY_LOG"; echo "RE-APLICAÇÃO FALHOU"; fi
eq "E9a re-aplicar: idempotente, não sobrescreve a URL do founder nem apaga envio" \
   "$(Pq -c "SELECT value FROM public.company_config WHERE key = 'app_url_publica'")|$(Pq -c "SELECT count(*) FROM public.radar_email_vendedor_envios")" \
   "https://outro.exemplo.com|5"
P -q <<'SQL'
CREATE OR REPLACE FUNCTION public.radar_prospectar_hoje(p_vendedor uuid DEFAULT NULL, p_n integer DEFAULT 3)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $fn$ SELECT '{}'::jsonb $fn$;
SQL
DERIVA_OUT="$(P -q -f "$MIGE_USADA" 2>&1 || true)"
eq "E9b anti-deriva: corpo vivo que não é o predecessor nem este aborta a re-aplicação (e não apaga a outra sessão)" \
   "$(printf '%s' "$DERIVA_OUT" | grep -c 'PRE FALHOU: public.radar_prospectar_hoje')|$(Pq -c "SELECT prosrc LIKE '%{}%' FROM pg_proc WHERE oid = 'public.radar_prospectar_hoje(uuid,integer)'::regprocedure")" \
   "1|t"

echo "PASS=$PASS FAIL=$FAIL"
[ "$FAIL" -eq 0 ]
