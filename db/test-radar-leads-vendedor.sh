#!/usr/bin/env bash
# Prova PG17 do pacote D do Radar (levar o lead até o vendedor) — migration 20261106181000_radar_leads_ao_vendedor:
#   • private.radar_territorio_do_vendedor: municípios onde o vendedor tem mais clientes da carteira ELEGÍVEL; cada
#     município tem UM dono (quem tem mais clientes nele); só vendedor de verdade (employee + farmer/hunter/closer).
#   • private.radar_leads_do_vendedor: top-N por score; fora ja_cliente, status ≠ a_contatar, sem score (nunca vira 0),
#     RFB 03/04/08, dono temporário ATIVO de outro vendedor com acesso; não repete lead já enviado (90 dias, teste não
#     conta); `elegiveis` = denominador.
#   • public.radar_avisar_vendedores (cron): só config ativa; 1 e-mail por vendedor e semana; destinatário de teste
#     desvia e não conta; pulados com motivo no ledger; semana sem config ativa não suja o ledger.
#   • public.radar_prospectar_hoje (card D2) e public.radar_registrar_abertura_empurrada (sensor): gates com SQLSTATE.
#   • cron nasce DESLIGADO; re-aplicar não religa nem desliga; tabelas fechadas ao JWT; ACL nas duas pontas.
#
#   bash db/test-radar-leads-vendedor.sh > /tmp/t.log 2>&1; echo "exit=$?"
#   SABOTAGEM=<nome> bash db/test-radar-leads-vendedor.sh   # tem de ficar VERMELHA
#   bash db/test-radar-leads-vendedor.sh --falsificar        # controle verde + cada sabotagem vermelha no assert dela
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MIG="$REPO_ROOT/supabase/migrations/20261106181000_radar_leads_ao_vendedor.sql"

if [ "${1:-}" = "--falsificar" ]; then
  # <sabotagem>:<assert que TEM de acusá-la>. `POST!A3_FALHOU` = a postcondição da migration aborta o apply com a
  # marca exata (`_` vira espaço; grep -F). `_sem_post` cega a postcondição para provar que a suíte pega sozinha.
  SABOTAGENS="sem_ja_cliente:A3 status_qualquer:A3 score_nulo:A3 rfb_baixada:A3 atendimento_ignorado:A3 atendimento_nao_expira:A3 dono_proprio_bloqueia:A3 dono_sem_acesso_bloqueia:A3 territorio_disputado:A2 carteira_inelegivel:A1 vendedor_sem_employee:A2 endereco_nao_default:A1 repete_lead:A13a teste_queima_lead:A13b sem_dedupe_semana:A12 teste_conta:A10b sem_ledger:A10d ledger_sujo:A9 gate_cap:A6b gestor_livre:A6c servido_duplica:A6f servido_sem_faixa:A6g link_sem_validar:A14d acl_aberta:POST!A3_FALHOU acl_aberta_sem_post:A16 tabela_aberta:POST!A2_FALHOU tabela_aberta_sem_post:A17 cron_ligado:A8a cron_religa:A18 sem_dedupe_raiz:A3 repete_filial:A13a"
  LOGDIR="$(mktemp -d "${TMPDIR:-/tmp}/falsifica-radar-leads-vendedor.XXXXXX")"
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
DATA="$(mktemp -d "${TMPDIR:-/tmp}/pgtest-radar-leads-vendedor.XXXXXX")/data"
export LC_ALL=C LANG=C
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
cegar_post() { sabotar "  t text;
  f text;
BEGIN
" "  t text;
  f text;
BEGIN
  RETURN;
"; }
case "${SABOTAGEM:-}" in
  "") ;;
  sem_ja_cliente)        sabotar "     WHERE re.ja_cliente = false
       AND re.prospeccao_status" "     WHERE true
       AND re.prospeccao_status" ;;
  status_qualquer)       sabotar "AND re.prospeccao_status = 'a_contatar'" "AND re.prospeccao_status <> 'descartado'" ;;
  score_nulo)            sabotar "       AND re.score IS NOT NULL
" "" ;;
  rfb_baixada)           sabotar "AND (re.rfb_situacao IS NULL OR re.rfb_situacao NOT IN ('03', '04', '08'))" "" ;;
  atendimento_ignorado)  sabotar "                AND a.encerrado_em IS NULL
                AND a.dono_user_id <> p_vendedor" "                AND false" ;;
  atendimento_nao_expira) sabotar "AND private.radar_atendimento_expira_em(a.cnpj, a.dono_user_id, a.assumido_em, a.renovado_em) > p_agora" "" ;;
  dono_proprio_bloqueia) sabotar "                AND a.dono_user_id <> p_vendedor
" "" ;;
  dono_sem_acesso_bloqueia) sabotar "                AND private.cap_radar_prospectar(a.dono_user_id))" "                )" ;;
  territorio_disputado)  sabotar "    JOIN dono_do_mun d ON d.codigo = pm.codigo AND d.dono = pm.dono" "" ;;
  carteira_inelegivel)   sabotar "     WHERE a.eligible IS TRUE
" "     WHERE true
" ;;
  vendedor_sem_employee) sabotar "       AND EXISTS (SELECT 1 FROM public.user_roles ur
                    WHERE ur.user_id = cr.user_id AND ur.role = 'employee')" "" ;;
  endereco_nao_default)  sabotar "ad.is_default DESC NULLS LAST, ad.created_at DESC, ad.id" "ad.is_default ASC, ad.created_at DESC, ad.id" ;;
  repete_lead)           sabotar "       AND (p_nao_repetir_desde IS NULL OR NOT EXISTS (" "       AND (true OR NOT EXISTS (" ;;
  teste_queima_lead)     sabotar "                AND e.eh_teste = false
" "" ;;
  sem_dedupe_semana)     sabotar "    IF EXISTS (SELECT 1 FROM public.radar_email_vendedor_envios e
                WHERE e.vendedor_user_id = r.vendedor AND e.semana = v_semana AND e.eh_teste = v_teste) THEN" "    IF false THEN" ;;
  teste_conta)           sabotar "    v_teste := r.email_teste IS NOT NULL;" "    v_teste := false;" ;;
  sem_ledger)            sabotar "  IF jsonb_array_length(v_avisados) + jsonb_array_length(v_pulados) > 0 THEN" "  IF false THEN" ;;
  ledger_sujo)           sabotar "  IF jsonb_array_length(v_avisados) + jsonb_array_length(v_pulados) > 0 THEN" "  IF true THEN" ;;
  gate_cap)              sabotar "  IF NOT COALESCE(private.cap_radar_prospectar(v_uid), false) THEN
    RAISE EXCEPTION 'forbidden: radar_prospectar' USING ERRCODE = '42501';
  END IF;
  v_alvo" "  v_alvo" ;;
  gestor_livre)          sabotar "  IF v_alvo <> v_uid AND NOT COALESCE(private.pode_ver_carteira_completa(v_uid), false) THEN" "  IF false THEN" ;;
  servido_sem_faixa)     sabotar "  IF p_n_leads IS NULL OR p_n_leads NOT BETWEEN 1 AND 5 THEN" "  IF p_n_leads IS NULL THEN" ;;
  servido_duplica)       sabotar "  ON CONFLICT (user_id, dia) DO NOTHING;" "  ON CONFLICT (user_id, dia) DO UPDATE SET n_leads = EXCLUDED.n_leads, servido_em = clock_timestamp();" ;;
  link_sem_validar)      sabotar "      JOIN public.radar_email_vendedor_leads l ON l.envio_id = e.id AND l.cnpj = p_cnpj" "" ;;
  acl_aberta)            sabotar "REVOKE ALL ON FUNCTION public.radar_avisar_vendedores(timestamptz) FROM PUBLIC, anon, authenticated;" "REVOKE ALL ON FUNCTION public.radar_avisar_vendedores(timestamptz) FROM anon;" ;;
  acl_aberta_sem_post)   sabotar "REVOKE ALL ON FUNCTION public.radar_avisar_vendedores(timestamptz) FROM PUBLIC, anon, authenticated;" "REVOKE ALL ON FUNCTION public.radar_avisar_vendedores(timestamptz) FROM anon;"; cegar_post ;;
  tabela_aberta)         sabotar "              public.radar_lead_aberturas, public.radar_prospectar_hoje_servido FROM PUBLIC, anon, authenticated;" "              public.radar_lead_aberturas, public.radar_prospectar_hoje_servido FROM anon;" ;;
  tabela_aberta_sem_post) sabotar "              public.radar_lead_aberturas, public.radar_prospectar_hoje_servido FROM PUBLIC, anon, authenticated;" "              public.radar_lead_aberturas, public.radar_prospectar_hoje_servido FROM anon;"; cegar_post ;;
  cron_ligado)           sabotar "    PERFORM cron.alter_job(job_id := v_job, active := false);" "" ;;
  cron_religa)           sabotar "  IF NOT EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'radar-avisar-vendedores-semanal') THEN" "  IF true THEN" ;;
  sem_dedupe_raiz)       sabotar "    SELECT DISTINCT ON (u.raiz) u.*" "    SELECT u.*" ;;
  repete_filial)         sabotar "WHERE left(l.cnpj, 8) = left(re.cnpj, 8)" "WHERE l.cnpj = re.cnpj" ;;
  *) echo "sabotagem desconhecida: $SABOTAGEM"; exit 9 ;;
esac
[ -n "${SABOTAGEM:-}" ] && echo "⚠️  SABOTAGEM ATIVA: $SABOTAGEM"

"$PGBIN/initdb" -D "$DATA" -U postgres -E UTF8 --locale=C >/dev/null
"$PGBIN/pg_ctl" -D "$DATA" -o "-p $PORT -k /tmp" -l "$(dirname "$DATA")/pg.log" -w start >/dev/null
P()  { "$PGBIN/psql" -X -v ON_ERROR_STOP=1 -p "$PORT" -h /tmp -U postgres -d postgres "$@"; }
Pq() { P -qAt "$@"; }

# ── Esquema mínimo (corpos de prod lidos via psql-ro em 2026-11-06 para as funções que a migration chama) ──
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
  rfb_situacao text, score smallint, score_motivos text[]);
CREATE TABLE public.radar_contatos (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), cnpj text, criado_por uuid,
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
V1=a0000000-0000-0000-0000-000000000001   # farmer (Regina): DIV 4 · NS 3 · CLA 2 · FOR 1
V2=a0000000-0000-0000-0000-000000000002   # farmer (Tatyana): DIV 2 (perde para V1) · CAJ 3 · ITA 2 · PAR 2 · BH 1
V3=a0000000-0000-0000-0000-000000000003   # farmer sem e-mail
G=a0000000-0000-0000-0000-000000000008    # gestor (employee + gerencial)
C=a0000000-0000-0000-0000-000000000007    # customer com cargo farmer residual: NÃO é vendedor
M=a0000000-0000-0000-0000-000000000009    # master: carteira grande, NÃO é vendedor
export V1 V2 V3 G C M

P -q -v v1="$V1" -v v2="$V2" -v v3="$V3" -v g="$G" -v c="$C" -v m="$M" <<'SQL'
INSERT INTO public.user_roles (user_id, role) VALUES
  (:'v1','employee'), (:'v2','employee'), (:'v3','employee'), (:'g','employee'), (:'c','customer'), (:'m','master');
INSERT INTO public.commercial_roles (user_id, commercial_role) VALUES
  (:'v1','farmer'), (:'v2','farmer'), (:'v3','farmer'), (:'g','gerencial'), (:'c','farmer');
INSERT INTO public.profiles (user_id, name, email) VALUES
  (:'v1','Regina Celia de Castro','regina@exemplo.com'), (:'v2','Tatyana Martins','taty@exemplo.com'),
  (:'v3','Sem Email', NULL), (:'g','Gestor','gestor@exemplo.com');
INSERT INTO public.radar_municipios (codigo, nome, uf) VALUES
  ('3122306','DIVINÓPOLIS','MG'), ('3145208','NOVA SERRANA','MG'), ('3116907','CLÁUDIO','MG'), ('3126109','FORMIGA','MG'),
  ('3114402','CARMO DO CAJURU','MG'), ('3133808','ITAÚNA','MG'), ('3147105','PARÁ DE MINAS','MG'), ('3106200','BELO HORIZONTE','MG'),
  ('3500000','DIVINÓPOLIS','SP');  -- homônimo em outra UF: casar só pelo nome contaria errado

-- Carteira: gera clientes com endereço. (dono, código-do-município-por-nome-escrito-como-no-Omie, qtd, elegível)
CREATE TEMP TABLE semente (dono uuid, cidade text, uf text, n int, eleg boolean);
INSERT INTO semente VALUES
  (:'v1','Divinopolis','MG',4,true), (:'v1','NOVA SERRANA (MG)','mg',3,true), (:'v1','  Cláudio ','MG',2,true), (:'v1','Formiga','MG',1,true),
  (:'v2','DIVINÓPOLIS','MG',2,true), (:'v2','Carmo do Cajuru','MG',3,true), (:'v2','Itauna','MG',2,true), (:'v2','Pará de Minas','MG',2,true),
  (:'v2','Belo Horizonte','MG',1,true),
  (:'v2','Nova Serrana','MG',5,false),     -- inelegível: se contasse, V2 tomaria Nova Serrana de V1
  (:'c','Carmo do Cajuru','MG',9,true),    -- não-vendedor: se contasse, tomaria Carmo do Cajuru de V2
  (:'m','Formiga','MG',20,true),           -- master: idem com Formiga
  (:'v1','Divinopolis','SP',1,true);       -- homônimo SP: não pode somar em Divinópolis/MG (seria 5 × 4)
DO $$
DECLARE s record; i int; cli uuid;
BEGIN
  FOR s IN SELECT * FROM semente LOOP
    FOR i IN 1..s.n LOOP
      cli := gen_random_uuid();
      INSERT INTO public.carteira_assignments (customer_user_id, owner_user_id, eligible) VALUES (cli, s.dono, s.eleg);
      INSERT INTO public.addresses (user_id, city, state, is_default) VALUES (cli, s.cidade, s.uf, true);
    END LOOP;
  END LOOP;
END $$;
-- Cliente de V1 com 2 endereços: o padrão em Formiga, o não-padrão (mais novo) em Cláudio. Vale o padrão:
-- V1 fica com Formiga 2 (fora do top 3) e Cláudio 2 — se valesse o não-padrão, Cláudio iria a 3 e empataria NS.
CREATE TEMP TABLE dois_end AS SELECT gen_random_uuid() AS cli;
INSERT INTO public.carteira_assignments (customer_user_id, owner_user_id, eligible) SELECT cli, :'v1', true FROM dois_end;
INSERT INTO public.addresses (user_id, city, state, is_default, created_at)
  SELECT cli, 'Formiga', 'MG', true, now() - interval '1 year' FROM dois_end
  UNION ALL SELECT cli, 'Claudio', 'MG', false, now() FROM dois_end;
SQL

# ── Leads ─────────────────────────────────────────────────────────────────────────────────────────────────
# Divinópolis (V1): L01 95 ok · L02 ja_cliente · L03 descartado · L04 em_conversa · L05 sem score · L06 RFB 08 ·
# L07 dono ativo V2 · L08 dono ativo do PRÓPRIO V1 (fica) · L09 dono V2 expirado (fica) · L10 dono ativo sem acesso (fica)
# Nova Serrana: L11 91, L12 80 · Cláudio: L13 85, L14 70 · Formiga (fora do top 3 de V1): L15 100
# V2: Carmo do Cajuru L20 60 · Itaúna L21 75 · Pará de Minas L22 50 · Belo Horizonte (4º, fora) L23 99
P -q <<'SQL'
INSERT INTO public.radar_empresas (cnpj, razao_social, nome_fantasia, municipio_codigo, municipio_nome, uf, ja_cliente, prospeccao_status, rfb_situacao, score, score_motivos) VALUES
  ('10100000000001','Lead Um Ltda','Marcenaria Um','3122306','Divinopolis','MG',false,'a_contatar',NULL,95,ARRAY['CNAE 3101','porte EPP','extra']),
  ('10100000000102','Lead Um Filial','Marcenaria Um Filial','3122306','Divinopolis','MG',false,'a_contatar',NULL,94,NULL),
  ('10200000000001','Lead Dois','','3122306','Divinopolis','MG',true,'a_contatar',NULL,99,NULL),
  ('10300000000001','Lead Tres',NULL,'3122306','Divinopolis','MG',false,'descartado',NULL,99,NULL),
  ('10400000000001','Lead Quatro',NULL,'3122306','Divinopolis','MG',false,'em_conversa',NULL,99,NULL),
  ('10500000000001','Lead Cinco',NULL,'3122306','Divinopolis','MG',false,'a_contatar',NULL,NULL,NULL),
  ('10600000000001','Lead Seis',NULL,'3122306','Divinopolis','MG',false,'a_contatar','08',99,NULL),
  ('10700000000001','Lead Sete',NULL,'3122306','Divinopolis','MG',false,'a_contatar','02',98,NULL),
  ('10800000000001','Lead Oito',NULL,'3122306','Divinopolis','MG',false,'a_contatar',NULL,94,NULL),
  ('10900000000001','Lead Nove',NULL,'3122306','Divinopolis','MG',false,'a_contatar',NULL,93,NULL),
  ('11000000000001','Lead Dez',NULL,'3122306','Divinopolis','MG',false,'a_contatar',NULL,92,NULL),
  ('11100000000001','Lead Onze',NULL,'3145208','Nova Serrana','MG',false,'a_contatar',NULL,91,NULL),
  ('11200000000001','Lead Doze',NULL,'3145208','Nova Serrana','MG',false,'a_contatar',NULL,80,NULL),
  ('11300000000001','Lead Treze',NULL,'3116907','Claudio','MG',false,'a_contatar',NULL,85,NULL),
  ('11400000000001','Lead Catorze',NULL,'3116907','Claudio','MG',false,'a_contatar',NULL,70,NULL),
  ('11500000000001','Lead Quinze',NULL,'3126109','Formiga','MG',false,'a_contatar',NULL,100,NULL),
  ('12000000000001','Lead Vinte',NULL,'3114402','Carmo do Cajuru','MG',false,'a_contatar',NULL,60,NULL),
  ('12100000000001','Lead Vinte e Um',NULL,'3133808','Itauna','MG',false,'a_contatar',NULL,75,NULL),
  ('12200000000001','Lead Vinte e Dois',NULL,'3147105','Para de Minas','MG',false,'a_contatar',NULL,50,NULL),
  ('12300000000001','Lead Vinte e Tres',NULL,'3106200','Belo Horizonte','MG',false,'a_contatar',NULL,99,NULL);
SQL
P -q -v v1="$V1" -v v2="$V2" -v c="$C" <<'SQL'
INSERT INTO public.radar_atendimentos (cnpj, dono_user_id, assumido_em) VALUES
  ('10700000000001', :'v2', now() - interval '1 day'),
  ('10800000000001', :'v1', now() - interval '1 day'),
  ('10900000000001', :'v2', now() - interval '30 days'),
  ('11000000000001', :'c',  now() - interval '1 day');
SQL

APPLY_LOG="$(dirname "$DATA")/apply.log"
if ! P -q -f "$MIG_USADA" > "$APPLY_LOG" 2>&1; then
  cat "$APPLY_LOG"; echo "APLICAÇÃO DA MIGRATION FALHOU"; exit 1
fi

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

# ── Território ────────────────────────────────────────────────────────────────────────────────────────────
eq "A1 território de V1 = os 3 municípios com mais clientes ELEGÍVEIS (endereço padrão, norm_cidade + UF)" \
   "$(Pq -c "SELECT string_agg(municipio_codigo||':'||clientes, ',' ORDER BY clientes DESC, municipio_codigo) FROM private.radar_territorio_do_vendedor('$V1', 3)")" \
   "3122306:4,3145208:3,3116907:2"
eq "A2 território de V2 = sem Divinópolis (dono é V1, 4 × 2); não-vendedor e master não disputam" \
   "$(Pq -c "SELECT string_agg(municipio_codigo||':'||clientes, ',' ORDER BY clientes DESC, municipio_codigo) FROM private.radar_territorio_do_vendedor('$V2', 3)")" \
   "3114402:3,3133808:2,3147105:2"

# ── Leads ─────────────────────────────────────────────────────────────────────────────────────────────────
eq "A3 top-5 de V1 por score, 1 por raiz de CNPJ (a filial 94 do 101 sai do top e do denominador): fora ja_cliente/descartado/em_conversa/sem score/RFB 08/dono ativo de outro; elegíveis = 8" \
   "$(Pq -c "SELECT string_agg(left(cnpj,3), ',' ORDER BY posicao)||'|'||max(elegiveis) FROM private.radar_leads_do_vendedor('$V1', 5, NULL, now())")" \
   "101,108,109,110,111|8"
eq "A4 top de V2 (3 elegíveis no território, Belo Horizonte é o 4º município e fica fora)" \
   "$(Pq -c "SELECT string_agg(left(cnpj,3), ',' ORDER BY posicao)||'|'||max(elegiveis) FROM private.radar_leads_do_vendedor('$V2', 5, NULL, now())")" \
   "121,120,122|3"
eq "A5 p_n é limitado a 5 e a posição é 1..n" \
   "$(Pq -c "SELECT count(*)||':'||min(posicao)||'-'||max(posicao) FROM private.radar_leads_do_vendedor('$V1', 50, NULL, now())")" \
   "5:1-5"

# ── Card D2: radar_prospectar_hoje ────────────────────────────────────────────────────────────────────────
prefixo "A6a anon não executa radar_prospectar_hoje (ACL)" \
   "$(erro_como anon '' "SELECT public.radar_prospectar_hoje()")" "42501 permission denied for function radar_prospectar_hoje"
prefixo "A6b customer com cargo residual: 42501 forbidden: radar_prospectar" \
   "$(erro_como authenticated "$C" "SELECT public.radar_prospectar_hoje()")" "42501 forbidden: radar_prospectar"
prefixo "A6c vendedor não lê os leads de OUTRO vendedor: 42501" \
   "$(erro_como authenticated "$V1" "SELECT public.radar_prospectar_hoje('$V2')")" "42501 forbidden: leads de outro vendedor exigem gestor"
eq "A6d o próprio vendedor recebe 3 leads e o território" \
   "$(como authenticated "$V1" "SELECT (SELECT string_agg(left(l->>'cnpj',3), ',' ORDER BY (l->>'posicao')::int) FROM jsonb_array_elements(x->'leads') l)||'|'||jsonb_array_length(x->'territorio') FROM public.radar_prospectar_hoje() x" | tail -1)" \
   "101,108,109|3"
eq "A6e leitura é PURA (cabe na allowlist da lente): nem o vendedor nem o gestor gravam 'servido' ao ler" \
   "$(como authenticated "$G" "SELECT jsonb_array_length(x->'leads') FROM public.radar_prospectar_hoje('$V2') x" | tail -1)|$(Pq -c "SELECT count(*) FROM public.radar_prospectar_hoje_servido")|$(Pq -c "SELECT provolatile FROM pg_proc WHERE oid = 'public.radar_prospectar_hoje(uuid,integer)'::regprocedure")" \
   "3|0|s"
eq "A6f 'servido' do card: 1 por vendedor e dia; a 2ª chamada não duplica nem reescreve" \
   "$(como authenticated "$V1" "SELECT public.radar_registrar_card_servido(3)" | tail -1)|$(como authenticated "$V1" "SELECT public.radar_registrar_card_servido(2)" | tail -1)|$(Pq -c "SELECT count(*)||':'||max(n_leads) FROM public.radar_prospectar_hoje_servido")" \
   '{"ok": true, "registrado": true}|{"ok": true, "registrado": false}|1:3'
prefixo "A6g 'servido' com n fora de 1..5: 22023" \
   "$(erro_como authenticated "$V1" "SELECT public.radar_registrar_card_servido(0)")" "22023 n_leads fora de 1..5"
prefixo "A6h customer com cargo residual não grava 'servido': 42501" \
   "$(erro_como authenticated "$C" "SELECT public.radar_registrar_card_servido(3)")" "42501 forbidden: radar_prospectar"
eq "A6i gestor sem carteira (próprio card): 0 leads, 0 território" \
   "$(como authenticated "$G" "SELECT jsonb_array_length(x->'leads')||':'||jsonb_array_length(x->'territorio') FROM public.radar_prospectar_hoje() x" | tail -1)" \
   "0:0"

# ── Cron e e-mail semanal ─────────────────────────────────────────────────────────────────────────────────
eq "A8a cron nasce DESLIGADO, segunda 11:00 UTC, comando exato" \
   "$(Pq -c "SELECT active||'|'||schedule||'|'||command FROM cron.job WHERE jobname = 'radar-avisar-vendedores-semanal'")" \
   "false|0 11 * * 1|SELECT public.radar_avisar_vendedores();"
eq "A9 sem vendedor ligado: nada avisado, nenhum alerta, ledger limpo" \
   "$(Pq -c "SELECT jsonb_array_length(public.radar_avisar_vendedores('2026-11-09 11:00+00')->'avisados')")|$(Pq -c "SELECT (SELECT count(*) FROM public.fornecedor_alerta)||':'||(SELECT count(*) FROM public.acoes_execucoes)")" \
   "0|0:0"

P -q -v v1="$V1" -v v2="$V2" -v v3="$V3" -v g="$G" <<'SQL'
INSERT INTO public.radar_email_vendedor_config (vendedor_user_id, ativo, email_teste) VALUES
  (:'v1', true, NULL), (:'v2', true, 'founder@exemplo.com'), (:'v3', true, NULL), (:'g', false, NULL);
SQL
R1="$(Pq -c "SELECT public.radar_avisar_vendedores('2026-11-09 11:00+00')")"
eq "A10a 1ª semana: V1 real (5 de 8) e V2 desviado para o teste (3 de 3); V3 pulado sem e-mail; G desligado fica fora" \
   "$(Pq -c "SELECT string_agg(left(vendedor_user_id::text,1)||right(vendedor_user_id::text,1)||':'||destinatario_email||':'||n_leads||'/'||elegiveis||':'||semana, ' ' ORDER BY vendedor_user_id) FROM public.radar_email_vendedor_envios")|$(printf '%s' "$R1" | grep -o '"motivo": "[a-z_]*"' | tr '\n' ' ')" \
   "a1:regina@exemplo.com:5/8:2026-11-09 a2:founder@exemplo.com:3/3:2026-11-09|\"motivo\": \"sem_email\" "
eq "A10b envio com destinatário de teste é marcado teste (fora do denominador); o real não" \
   "$(Pq -c "SELECT string_agg(right(vendedor_user_id::text,1)||':'||eh_teste, ',' ORDER BY vendedor_user_id) FROM public.radar_email_vendedor_envios")" \
   "1:false,2:true"
eq "A10c cada envio tem 1 alerta pendente para o dispatch e os leads gravados na ordem" \
   "$(Pq -c "SELECT (SELECT count(*) FROM public.fornecedor_alerta WHERE status = 'pendente_notificacao' AND tipo = 'outro')||'|'||(SELECT string_agg(left(l.cnpj,3), ',' ORDER BY l.posicao) FROM public.radar_email_vendedor_leads l JOIN public.radar_email_vendedor_envios e ON e.id = l.envio_id WHERE e.vendedor_user_id = '$V1')")" \
   "2|101,108,109,110,111"
eq "A10d ledger: 1 linha radar.avisar_vendedores automatica com 2 avisados e 1 pulado" \
   "$(Pq -c "SELECT count(*)||':'||max(jsonb_array_length(detalhes->'avisados'))||':'||max(jsonb_array_length(detalhes->'pulados')) FROM public.acoes_execucoes WHERE acao = 'radar.avisar_vendedores' AND origem = 'automatica' AND status = 'sucesso'")" \
   "1:2:1"
ENVIO1="$(Pq -c "SELECT id FROM public.radar_email_vendedor_envios WHERE vendedor_user_id = '$V1'")"
eq "A11 corpo do e-mail: link direto por lead, denominador e regra; título com os municípios" \
   "$(Pq -c "SELECT (a.mensagem LIKE '%https://steu.lovable.app/radar/abrir/$ENVIO1/10100000000001%')||':'||(a.mensagem LIKE '%entre 8 empresas a contatar%')||':'||(a.mensagem LIKE 'Olá, Regina!%')||':'||(a.titulo = 'Radar: 5 empresas para prospectar esta semana (DIVINÓPOLIS, NOVA SERRANA, CLÁUDIO)')||':'||(a.mensagem LIKE '%[TESTE]%') FROM public.fornecedor_alerta a JOIN public.radar_email_vendedor_envios e ON e.alerta_id = a.id WHERE e.vendedor_user_id = '$V1'")" \
   "true:true:true:true:false"

R2="$(Pq -c "SELECT public.radar_avisar_vendedores('2026-11-12 11:00+00')" 2>&1 || true)"
eq "A12 mesma semana (quinta): nenhum e-mail novo, V1 e V2 pulados por já enviado" \
   "$(Pq -c "SELECT count(*) FROM public.fornecedor_alerta")|$(printf '%s' "$R2" | grep -o 'ja_enviado_na_semana' | wc -l | tr -d ' ')" \
   "2|2"

Pq -c "SELECT public.radar_avisar_vendedores('2026-11-16 11:00+00')" >/dev/null
eq "A13a semana seguinte: V1 não recebe de novo os 5 da semana anterior; o 107 volta porque a posse de V2 expirou no relógio de p_agora" \
   "$(Pq -c "SELECT string_agg(left(l.cnpj,3), ',' ORDER BY l.posicao)||'|'||max(e.elegiveis) FROM public.radar_email_vendedor_leads l JOIN public.radar_email_vendedor_envios e ON e.id = l.envio_id WHERE e.vendedor_user_id = '$V1' AND e.semana = '2026-11-16'")" \
   "107,113,112,114|4"
eq "A13b envio de TESTE não queima lead: V2 recebe os mesmos 3 de novo" \
   "$(Pq -c "SELECT string_agg(left(l.cnpj,3), ',' ORDER BY l.posicao) FROM public.radar_email_vendedor_leads l JOIN public.radar_email_vendedor_envios e ON e.id = l.envio_id WHERE e.vendedor_user_id = '$V2' AND e.semana = '2026-11-16'")" \
   "121,120,122"

# ── Sensor de abertura ────────────────────────────────────────────────────────────────────────────────────
eq "A14a V1 abre o lead do PRÓPRIO e-mail: registrado e do destinatário" \
   "$(como authenticated "$V1" "SELECT public.radar_registrar_abertura_empurrada('email', '10100000000001', '$ENVIO1')" | tail -1)" \
   '{"ok": true, "registrado": true, "do_destinatario": true}'
eq "A14b 2ª abertura no mesmo dia não infla" \
   "$(como authenticated "$V1" "SELECT public.radar_registrar_abertura_empurrada('email', '10100000000001', '$ENVIO1')" | tail -1)" \
   '{"ok": true, "registrado": false, "do_destinatario": true}'
eq "A14c gestor abrindo o link de V1 fica registrado como NÃO destinatário" \
   "$(como authenticated "$G" "SELECT public.radar_registrar_abertura_empurrada('email', '10100000000001', '$ENVIO1')" | tail -1)" \
   '{"ok": true, "registrado": true, "do_destinatario": false}'
eq "A14d cnpj que não estava no envio: link desconhecido, nada gravado" \
   "$(como authenticated "$V1" "SELECT public.radar_registrar_abertura_empurrada('email', '11500000000001', '$ENVIO1')" | tail -1)|$(Pq -c "SELECT count(*) FROM public.radar_lead_aberturas")" \
   '{"ok": false, "motivo": "link_desconhecido"}|2'
prefixo "A14e origem fora da lista: 22023" \
   "$(erro_como authenticated "$V1" "SELECT public.radar_registrar_abertura_empurrada('whatsapp', '10100000000001')")" "22023 origem invalida"
prefixo "A14f card com envio: 22023" \
   "$(erro_como authenticated "$V1" "SELECT public.radar_registrar_abertura_empurrada('card', '10100000000001', '$ENVIO1')")" "22023 envio obrigatorio so na origem email"
prefixo "A14g customer com cargo residual não registra: 42501" \
   "$(erro_como authenticated "$C" "SELECT public.radar_registrar_abertura_empurrada('card', '10100000000001')")" "42501 forbidden: radar_prospectar"
prefixo "A14h anon não executa (ACL)" \
   "$(erro_como anon '' "SELECT public.radar_registrar_abertura_empurrada('card', '10100000000001')")" "42501 permission denied for function radar_registrar_abertura_empurrada"
eq "A15 placar do sensor (query do doc): aberturas do destinatário / e-mails reais notificados" \
   "$(Pq -c "UPDATE public.fornecedor_alerta SET status = 'notificado'; SELECT count(DISTINCT ab.envio_id) FILTER (WHERE ab.do_destinatario)||' de '||count(DISTINCT e.id) FROM public.radar_email_vendedor_envios e JOIN public.fornecedor_alerta a ON a.id = e.alerta_id AND a.status = 'notificado' LEFT JOIN public.radar_lead_aberturas ab ON ab.envio_id = e.id WHERE NOT e.eh_teste" | tail -1)" \
   "1 de 2"

# ── Fronteira: funções internas e tabelas fechadas ao JWT ─────────────────────────────────────────────────
prefixo "A16 authenticated não executa o entrypoint do cron" \
   "$(erro_como authenticated "$G" "SELECT public.radar_avisar_vendedores()")" "42501 permission denied for function radar_avisar_vendedores"
prefixo "A16b authenticated não executa o núcleo private" \
   "$(erro_como authenticated "$V1" "SELECT * FROM private.radar_leads_do_vendedor('$V2', 5, NULL, now())")" "42501 permission denied for function radar_leads_do_vendedor"
prefixo "A17 authenticated não lê a tabela de envios (destinatários)" \
   "$(erro_como authenticated "$G" "SELECT count(*) FROM public.radar_email_vendedor_envios")" "42501 permission denied for table radar_email_vendedor_envios"
prefixo "A17b authenticated não escreve na config (não liga e-mail para si)" \
   "$(erro_como authenticated "$V1" "INSERT INTO public.radar_email_vendedor_config (vendedor_user_id, ativo) VALUES ('$V1', true)")" "42501 permission denied for table radar_email_vendedor_config"

# ── Re-aplicação ──────────────────────────────────────────────────────────────────────────────────────────
Pq -c "UPDATE cron.job SET active = true WHERE jobname = 'radar-avisar-vendedores-semanal'" >/dev/null
if ! P -q -f "$MIG_USADA" >> "$APPLY_LOG" 2>&1; then tail -5 "$APPLY_LOG"; echo "RE-APLICAÇÃO FALHOU"; fi
eq "A18 re-aplicar não desliga o cron que o founder ligou, não duplica job nem apaga envio" \
   "$(Pq -c "SELECT (SELECT string_agg(active::text, ',') FROM cron.job WHERE jobname = 'radar-avisar-vendedores-semanal')||'|'||(SELECT count(*) FROM public.radar_email_vendedor_envios)")" \
   "true|4"
P -q -c "DELETE FROM public.user_roles WHERE user_id = '$V1'" >/dev/null
eq "A19 vendedor que perdeu o acesso é pulado com o motivo (não recebe lead)" \
   "$(Pq -c "SELECT public.radar_avisar_vendedores('2026-11-23 11:00+00')->'pulados'" | grep -o 'sem_acesso_ao_radar' | wc -l | tr -d ' ')" \
   "1"

echo "PASS=$PASS FAIL=$FAIL"
[ "$FAIL" -eq 0 ]
