#!/usr/bin/env bash
# Prova PG17 da migration 20261109140000_radar_contato_contabil (sobre a cadeia do pacote E e a radar_lista do B2,
# como em PROD em 2026-11-07):
#   C1 telefone: 4+ grupos sem vínculo marca; 3 grupos só com corroboração; filial (mesma raiz) e sócio em comum
#      (nome + CPF mascarado) unem; homônimo (só nome) NÃO une; o 9º dígito junta; número lixo não conta;
#   C2 e-mail: endereço compartilhado, palavra forte, palavra fraca (motivo separado), domínio de serviço; CNAE 6920
#      não recebe marca;
#   C3 escritor: gate de impressão digital, recalcula quando o dado muda, MERGE apaga o que deixou de valer;
#   C4 efetivo e correção: o veredito prevalece, NULL volta ao automático, versão vista obrigatória, sobrevive à troca
#      telefone1↔telefone2, não passa para número novo, nunca calculado = NULL (não "não é"), autor = auth.uid();
#   C5 "visitar": todo contato utilizável marcado + endereço;
#   C6 fila: radar_lista(p_so_visitar) recorta no servidor, inclusive pela correção positiva;
#   C7 card e e-mail: lead "visitar" com endereço, sem prometer telefone; radar_email_vendedor_leads.visitar;
#   C8 ACL: tabelas sem acesso direto, internas fechadas, gate do Radar nas RPCs;
#   C9 re-aplicação e anti-deriva.
#
#   bash db/test-radar-contato-contabil.sh > /tmp/t.log 2>&1; echo "exit=$?"
#   LOCALE_TESTE=pt_BR.UTF-8 bash db/test-radar-contato-contabil.sh     # o 2º locale (asserts em ASCII, caixa fixa)
#   SABOTAGEM=<nome> bash db/test-radar-contato-contabil.sh             # tem de ficar VERMELHA
#   bash db/test-radar-contato-contabil.sh --falsificar                 # controle verde + cada sabotagem vermelha no assert dela
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MIG="$REPO_ROOT/supabase/migrations/20261106181000_radar_leads_ao_vendedor.sql"
MIG2="$REPO_ROOT/supabase/migrations/20261107140001_radar_email_semanal_toggle.sql"
MIGE="$REPO_ROOT/supabase/migrations/20261107230000_radar_distribuicao_pacote_e.sql"
MIGB2="$REPO_ROOT/supabase/migrations/20261106212329_radar_lista_meus_atendimentos.sql"
MIGC="$REPO_ROOT/supabase/migrations/20261109140000_radar_contato_contabil.sql"

if [ "${1:-}" = "--falsificar" ]; then
  # <sabotagem>:<assert que TEM de acusá-la>. `POST!P3_FALHOU` = a postcondição aborta o apply com a marca exata
  # (`_` vira espaço; grep -F). `_sem_post` cega a postcondição para provar que a suíte pega sozinha.
  SABOTAGENS="sem_v2:C1b sem_corroboracao:C1c socio_ignorado:C1d socio_so_nome:C1e filial_conta:C1f nove_digito:C1g
    palavra_fraca_forte:C2b cnae_ignorado:C2f gate_cego:C3b merge_sem_delete:C3c veredito_ignorado:C4a sem_versao:C4c
    correcao_herda:C4e ausente_vira_zero:C4f autor_do_cliente:C4g visitar_sem_endereco:C5c visitar_algum:C5b
    lista_sem_filtro:C6a lista_sem_correcao:C6b card_sem_marca:C7a email_promete_telefone:C7b email_sem_registro:C7c
    acl_aberta:POST!P3_FALHOU acl_aberta_sem_post:C8b pre_cega:C9b"
  falsificar_em() { # $1 = locale
    local loc="$1" logdir falhas=0 n_sab=0 s a marca modo
    logdir="$(mktemp -d "${TMPDIR:-/tmp}/falsifica-radar-contato-contabil.XXXXXX")"
    echo "══ CONTROLE ($loc) ══"
    if ! LOCALE_TESTE="$loc" SABOTAGEM="" bash "$0" > "$logdir/controle.log" 2>&1; then
      echo "❌ controle VERMELHO em $loc — falsificação abortada (log: $logdir/controle.log)"; tail -15 "$logdir/controle.log"; return 1
    fi
    if ! grep -q "^PASS=[1-9][0-9]* FAIL=0$" "$logdir/controle.log"; then
      echo "❌ controle sem recibo PASS=n FAIL=0 em $loc — a suíte não rodou"; return 1
    fi
    echo "✅ controle verde em $loc ($(grep '^PASS=' "$logdir/controle.log"))"
    for par in $SABOTAGENS; do
      s="${par%%:*}"; a="${par#*:}"; n_sab=$((n_sab+1))
      if LOCALE_TESTE="$loc" SABOTAGEM="$s" bash "$0" > "$logdir/$s.log" 2>&1; then
        echo "❌ $s: suíte ficou VERDE"; falhas=$((falhas+1)); continue
      fi
      if ! grep -q "SABOTAGEM ATIVA: $s" "$logdir/$s.log"; then
        echo "❌ $s: sabotagem NÃO aplicou"; falhas=$((falhas+1)); continue
      fi
      case "$a" in
        *!*) marca="${a#*!}"; marca="${marca//_/ }"; modo="-qF" ;;
        *)   marca="FAIL $a "; modo="-q" ;;
      esac
      if grep "$modo" -- "$marca" "$logdir/$s.log"; then
        echo "✅ $s → $a vermelho"
      else
        echo "❌ $s: vermelho, mas não no $a (log: $logdir/$s.log)"; falhas=$((falhas+1))
      fi
    done
    echo "SABOTAGENS ($loc): $((n_sab - falhas)) vermelhas / $falhas falhas"
    [ "$falhas" -eq 0 ]
  }
  total=0
  falsificar_em C || total=1
  falsificar_em pt_BR.UTF-8 || total=1
  if [ "$total" -eq 0 ]; then echo "SABOTAGENS: OK nos 2 locales"; exit 0; else echo "SABOTAGENS: FALHA"; exit 1; fi
fi

export PGVER=17
# shellcheck disable=SC1091  # caminho resolvido em runtime a partir de REPO_ROOT
. "$REPO_ROOT/db/lib/pg-harness.sh"
PORT="${PGPORT_TEST:-5497}"
DATA="$(mktemp -d "${TMPDIR:-/tmp}/pgtest-radar-contato-contabil.XXXXXX")/data"
export LC_ALL="${LOCALE_TESTE:-C}" LANG="${LOCALE_TESTE:-C}"
MIGC_USADA="$(dirname "$DATA")/migc.sql"
cleanup() { "$PGBIN/pg_ctl" -D "$DATA" stop -m immediate >/dev/null 2>&1 || true; rm -rf "$(dirname "$DATA")"; }
trap cleanup EXIT

cp "$MIGC" "$MIGC_USADA"
sabotar() { # $1 = de, $2 = para (literal; substitui TODAS as ocorrências) — na migration desta entrega
  python3 -I - "$MIGC_USADA" "$1" "$2" <<'PY'
import sys
p, de, para = sys.argv[1:]
s = open(p, encoding="utf-8").read()
if de not in s:
    sys.exit("padrao ausente: " + de)
open(p, "w", encoding="utf-8").write(s.replace(de, para))
PY
}
cegar_post() { sabotar "BEGIN
  -- P1: as funções vivas recriadas" "BEGIN
  RETURN;
  -- P1: as funções vivas recriadas"; }
case "${SABOTAGEM:-}" in
  "") ;;
  sem_v2)               sabotar "(t.grupos >= 4 OR t.corroborado)" "(t.grupos >= 3)" ;;
  sem_corroboracao)     sabotar "(t.grupos >= 4 OR t.corroborado)" "(t.grupos >= 4)" ;;
  socio_ignorado)       sabotar "JOIN public.radar_socios s ON s.raiz = m.raiz AND s.lote = v_socios" "JOIN public.radar_socios s ON s.raiz = m.raiz AND s.lote = 'nenhum'" ;;
  socio_so_nome)        sabotar "
                         AND b.cpf_mascarado = a.cpf_mascarado AND b.raiz <> a.raiz;" " AND b.raiz <> a.raiz;" ;;
  filial_conta)         sabotar "    SELECT e.cnpj, left(e.cnpj, 8) AS raiz," "    SELECT e.cnpj, e.cnpj AS raiz," ;;
  nove_digito)          sabotar "left(x.v, 2) || right(x.v, 8)" "x.v" ;;
  palavra_fraca_forte)  sabotar "CASE WHEN n ~ '(contab|contador)' THEN 'email_palavra' END" "CASE WHEN n ~ '(contab|contador|escritorio|assessoria)' THEN 'email_palavra' END" ;;
  cnae_ignorado)        sabotar "coalesce(starts_with(e.cnae_principal, '6920'), false) AS eh_contabil" "false AS eh_contabil" ;;
  gate_cego)            sabotar "AND v_imp_ant IS NOT DISTINCT FROM v_imp AND" "AND v_imp_ant IS NOT NULL AND" ;;
  merge_sem_delete)     sabotar "  DELETE FROM public.radar_contato_contabil c
   WHERE NOT EXISTS" "  PERFORM 1 FROM public.radar_contato_contabil c
   WHERE NOT EXISTS" ;;
  veredito_ignorado)    sabotar "CASE WHEN r.veredito IS NOT NULL THEN r.veredito" "CASE WHEN false THEN r.veredito" ;;
  sem_versao)           sabotar "IF v_ult IS DISTINCT FROM p_correcao_vista THEN" "IF false THEN" ;;
  correcao_herda)       sabotar "WHERE k.cnpj = p_cnpj AND k.tipo = c.tipo AND k.valor = c.valor" "WHERE k.cnpj = p_cnpj AND k.campo = c.campo" ;;
  ausente_vira_zero)    sabotar "WHEN est.calculado THEN false END" "ELSE false END" ;;
  autor_do_cliente)     sabotar "VALUES (p_cnpj, v_tipo, v_valor, p_campo, p_veredito, v_auto, v_ult, v_uid)" "VALUES (p_cnpj, v_tipo, v_valor, p_campo, p_veredito, v_auto, v_ult, '00000000-0000-0000-0000-000000000000')" ;;
  visitar_sem_endereco) sabotar "SELECT NULLIF(btrim(coalesce(p_logradouro, '')), '') IS NOT NULL AND count(*) > 0" "SELECT count(*) > 0" ;;
  visitar_algum)        sabotar "bool_and(a.efetivo IS TRUE)" "bool_or(a.efetivo IS TRUE)" ;;
  lista_sem_filtro)     sabotar "  IF COALESCE(p_so_visitar, false) THEN" "  IF false THEN" ;;
  lista_sem_correcao)   sabotar "
                                           UNION SELECT k.cnpj FROM public.radar_contato_contabil_correcoes k WHERE k.veredito)" ")" ;;
  card_sem_marca)       sabotar "'visitar', COALESCE(ct.visitar, false), 'endereco', ct.endereco)
                            ORDER BY x.posicao)" "'visitar', false, 'endereco', ct.endereco)
                            ORDER BY x.posicao)" ;;
  email_promete_telefone) sabotar "CASE WHEN l.visitar THEN '   VISITAR:" "CASE WHEN false THEN '   VISITAR:" ;;
  email_sem_registro)   sabotar "x.municipio_codigo, x.atribuido, x.visitar
          FROM jsonb_to_recordset" "x.municipio_codigo, x.atribuido, NULL
          FROM jsonb_to_recordset" ;;
  acl_aberta)           sabotar "REVOKE ALL ON FUNCTION private.radar_contato_contabil_avaliar(text, text, text, text) FROM PUBLIC, anon, authenticated;" "" ;;
  acl_aberta_sem_post)  sabotar "REVOKE ALL ON FUNCTION private.radar_contato_contabil_avaliar(text, text, text, text) FROM PUBLIC, anon, authenticated;" ""; cegar_post ;;
  pre_cega)             sabotar "      RAISE EXCEPTION 'PRE FALHOU: % vivo (md5 %) não é o predecessor revisado nem este — outra sessão mudou; refaça o pré-voo', r.alvo, r.vivo;" "      NULL;" ;;
  *) echo "sabotagem desconhecida: $SABOTAGEM"; exit 9 ;;
esac
[ -n "${SABOTAGEM:-}" ] && echo "⚠️  SABOTAGEM ATIVA: $SABOTAGEM"

"$PGBIN/initdb" -D "$DATA" -U postgres -E UTF8 --locale=C >/dev/null
"$PGBIN/pg_ctl" -D "$DATA" -o "-p $PORT -k /tmp" -l "$(dirname "$DATA")/pg.log" -w start >/dev/null
P()  { "$PGBIN/psql" -X -v ON_ERROR_STOP=1 -p "$PORT" -h /tmp -U postgres -d postgres "$@"; }
Pq() { P -qAt "$@"; }

# ── Esquema mínimo: o de db/test-radar-distribuicao-e.sh + as colunas e tabelas que esta migration lê, medidas em
#    PROD via psql-ro em 2026-11-07 (radar_empresas.logradouro/numero/bairro/cnae_principal/updated_at…,
#    radar_socios(lote, raiz, nome_normalizado, cpf_mascarado), radar_socios_lote(lote, status, publicado_em)) ──────
P -q <<'SQL'
CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN; CREATE ROLE service_role NOLOGIN BYPASSRLS;
CREATE SCHEMA auth; CREATE SCHEMA private; CREATE SCHEMA cron;
-- Pior caso: o JWT alcança os dois schemas; quem fecha é o ACL (é isso que a prova mede).
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
  telefone1 text, telefone2 text, email text, ultimo_lote text,
  logradouro text, numero text, bairro text, cep text, cnae_principal text, cnaes_secundarios text[],
  primeira_vista_em timestamptz, data_abertura date, capital_social numeric, omie_codigo_cliente text,
  updated_at timestamptz NOT NULL DEFAULT now());
CREATE INDEX idx_radar_muni ON public.radar_empresas (municipio_codigo) WHERE ja_cliente = false AND prospeccao_status <> 'descartado';
CREATE TABLE public.radar_ingest_state (mes_referencia text PRIMARY KEY, status text NOT NULL, iniciado_em timestamptz NOT NULL);
CREATE TABLE public.radar_socios (lote text NOT NULL, raiz text NOT NULL, nome_normalizado text NOT NULL, cpf_mascarado text,
  qualificacao text, data_entrada date, n_raizes_pais integer);
CREATE TABLE public.radar_socios_lote (lote text PRIMARY KEY, mes text, status text NOT NULL, publicado_em timestamptz);
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
RETURNS timestamptz LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS $$
  SELECT GREATEST(p_assumido_em, p_renovado_em) + interval '7 days' $$;
-- Corpo de PROD (2026-11-07): a radar_lista sanitiza a busca com ele.
CREATE FUNCTION private.padrao_like_contem(p_termo text) RETURNS text LANGUAGE sql IMMUTABLE PARALLEL SAFE STRICT
  SET search_path TO '' AS $$
  SELECT CASE
    WHEN btrim(translate(p_termo, '%_', ''), E' \t\r\n') = '' THEN NULL
    ELSE '%' || replace(replace(replace(p_termo, '\', '\\'), '%', '\%'), '_', '\_') || '%'
  END $$;
-- A radar_lista só lê cnpj/eh_meu daqui (filtro "Meus atendimentos"); o corpo real não importa para esta prova.
CREATE FUNCTION public.radar_atendimentos_ativos() RETURNS TABLE(cnpj text, eh_meu boolean) LANGUAGE sql STABLE
  SECURITY DEFINER SET search_path TO 'public' AS $$
  SELECT a.cnpj, a.dono_user_id = auth.uid() FROM public.radar_atendimentos a WHERE a.encerrado_em IS NULL $$;
SQL

V1=a0000000-0000-0000-0000-000000000011   # farmer dono de Divinópolis
V2=a0000000-0000-0000-0000-000000000012   # farmer (2º corretor)
C=a0000000-0000-0000-0000-000000000099    # customer: sem acesso ao Radar
export V1 V2 C
P -q -v v1="$V1" -v v2="$V2" -v c="$C" <<'SQL'
INSERT INTO public.user_roles (user_id, role) VALUES (:'v1','employee'), (:'v2','employee'), (:'c','customer');
INSERT INTO public.commercial_roles (user_id, commercial_role) VALUES (:'v1','farmer'), (:'v2','farmer');
INSERT INTO public.profiles (user_id, name, email) VALUES (:'v1','Regina Celia','regina@exemplo.com'), (:'v2','Outro','v2@exemplo.com');
INSERT INTO public.radar_municipios (codigo, nome, uf) VALUES ('3122306','DIVINÓPOLIS','MG'), ('3106200','BELO HORIZONTE','MG');
INSERT INTO public.radar_ingest_state VALUES ('2026-10','complete','2026-10-27 16:00+00');
INSERT INTO public.radar_socios_lote VALUES ('s-2026-10','2026-10','vigente','2026-10-28 10:00+00'), ('s-2026-09','2026-09','arquivado','2026-09-28 10:00+00');
DO $$
DECLARE i int; cli uuid;
BEGIN
  FOR i IN 1..3 LOOP
    cli := gen_random_uuid();
    INSERT INTO public.carteira_assignments (customer_user_id, owner_user_id, eligible) VALUES (cli, 'a0000000-0000-0000-0000-000000000011', true);
    INSERT INTO public.addresses (user_id, city, state, is_default) VALUES (cli, 'Divinopolis', 'MG', true);
  END LOOP;
END $$;

-- Leads (raiz = 8 primeiros dígitos). Divinópolis (território de V1) só os que o card/e-mail precisam; o resto em BH.
-- A  (37) 99111-0001 · 4 raízes sem vínculo (201-204); 204 usa a forma de 8 dígitos → o 9º dígito junta
-- B  (37) 3333-0001 · 3 raízes, sem corroboração (211-213)        C (37) 3333-0002 · 3 raízes, 223 com e-mail contábil
-- D  (37) 3333-0003 · 4 raízes, 231+232 com sócio em comum (nome + CPF) → 3 grupos, sem corroboração
-- E  (37) 3333-0004 · 4 raízes, 243+244 com sócio HOMÔNIMO (mesmo nome, CPF diferente) → 4 grupos
-- F  (37) 3333-0005 · 3 filiais da raiz 251 + a raiz 252 → 2 grupos
INSERT INTO public.radar_empresas (cnpj, razao_social, municipio_codigo, municipio_nome, uf, score, telefone1, telefone2, email,
                                   ultimo_lote, logradouro, numero, bairro, cnae_principal) VALUES
  ('20100000000101','Lead 201','3122306','Divinopolis','MG',95,'(37) 99111-0001',NULL,NULL,'2026-10','Rua A','10','Centro','3101200'),
  ('20200000000101','Lead 202','3122306','Divinopolis','MG',94,'(37) 99111-0001','(37) 3222-0202',NULL,'2026-10','Rua B','20','Centro','3101200'),
  ('20300000000101','Lead 203','3106200','Belo Horizonte','MG',60,'(37) 99111-0001',NULL,'joao.203@gmail.com','2026-10','Rua C','30','Savassi','3101200'),
  ('20400000000101','Lead 204','3106200','Belo Horizonte','MG',60,'3791110001',NULL,NULL,'2026-10',NULL,NULL,NULL,'3101200'),
  ('21100000000101','Lead 211','3106200','Belo Horizonte','MG',50,'(37) 3333-0001',NULL,NULL,'2026-10','Rua D','1',NULL,'3101200'),
  ('21200000000101','Lead 212','3106200','Belo Horizonte','MG',50,'(37) 3333-0001',NULL,NULL,'2026-10','Rua D','2',NULL,'3101200'),
  ('21300000000101','Lead 213','3106200','Belo Horizonte','MG',50,'(37) 3333-0001',NULL,NULL,'2026-10','Rua D','3',NULL,'3101200'),
  ('22100000000101','Lead 221','3106200','Belo Horizonte','MG',50,'(37) 3333-0002',NULL,NULL,'2026-10','Rua E','1',NULL,'3101200'),
  ('22200000000101','Lead 222','3106200','Belo Horizonte','MG',50,'(37) 3333-0002',NULL,NULL,'2026-10','Rua E','2',NULL,'3101200'),
  ('22300000000101','Lead 223','3106200','Belo Horizonte','MG',50,'(37) 3333-0002',NULL,'Fiscal@ContabilidadeX.com.br','2026-10','Rua E','3',NULL,'3101200'),
  ('23100000000101','Lead 231','3106200','Belo Horizonte','MG',50,'(37) 3333-0003',NULL,NULL,'2026-10','Rua F','1',NULL,'3101200'),
  ('23200000000101','Lead 232','3106200','Belo Horizonte','MG',50,'(37) 3333-0003',NULL,NULL,'2026-10','Rua F','2',NULL,'3101200'),
  ('23300000000101','Lead 233','3106200','Belo Horizonte','MG',50,'(37) 3333-0003',NULL,NULL,'2026-10','Rua F','3',NULL,'3101200'),
  ('23400000000101','Lead 234','3106200','Belo Horizonte','MG',50,'(37) 3333-0003',NULL,NULL,'2026-10','Rua F','4',NULL,'3101200'),
  ('24100000000101','Lead 241','3106200','Belo Horizonte','MG',50,'(37) 3333-0004',NULL,NULL,'2026-10','Rua G','1',NULL,'3101200'),
  ('24200000000101','Lead 242','3106200','Belo Horizonte','MG',50,'(37) 3333-0004',NULL,NULL,'2026-10','Rua G','2',NULL,'3101200'),
  ('24300000000101','Lead 243','3106200','Belo Horizonte','MG',50,'(37) 3333-0004',NULL,NULL,'2026-10','Rua G','3',NULL,'3101200'),
  ('24400000000101','Lead 244','3106200','Belo Horizonte','MG',50,'(37) 3333-0004',NULL,NULL,'2026-10','Rua G','4',NULL,'3101200'),
  ('25100000000101','Lead 251 matriz','3106200','Belo Horizonte','MG',50,'(37) 3333-0005',NULL,NULL,'2026-10','Rua H','1',NULL,'3101200'),
  ('25100000000202','Lead 251 filial','3106200','Belo Horizonte','MG',50,'(37) 3333-0005',NULL,NULL,'2026-10','Rua H','2',NULL,'3101200'),
  ('25100000000303','Lead 251 filial 2','3106200','Belo Horizonte','MG',50,'(37) 3333-0005',NULL,NULL,'2026-10','Rua H','3',NULL,'3101200'),
  ('25200000000101','Lead 252','3106200','Belo Horizonte','MG',50,'(37) 3333-0005',NULL,NULL,'2026-10','Rua H','4',NULL,'3101200'),
  -- e-mail: endereço compartilhado por 3 raízes (261-263), palavra fraca, domínio de serviço, CNAE 6920
  ('26100000000101','Lead 261','3106200','Belo Horizonte','MG',50,NULL,NULL,'contato@hubx.com.br','2026-10','Rua I','1',NULL,'3101200'),
  ('26200000000101','Lead 262','3106200','Belo Horizonte','MG',50,NULL,NULL,' CONTATO@hubx.com.br ','2026-10','Rua I','2',NULL,'3101200'),
  ('26300000000101','Lead 263','3106200','Belo Horizonte','MG',50,NULL,NULL,'contato@hubx.com.br','2026-10','Rua I','3',NULL,'3101200'),
  ('27100000000101','Lead 271','3106200','Belo Horizonte','MG',50,NULL,NULL,'escritorio.silva@uol.com.br','2026-10','Rua J','1',NULL,'3101200'),
  ('27200000000101','Lead 272','3106200','Belo Horizonte','MG',50,NULL,NULL,'cliente123@maismei.com.br','2026-10','Rua J','2',NULL,'3101200'),
  ('27300000000101','Lead 273','3106200','Belo Horizonte','MG',50,NULL,NULL,'atende@crcmg.org.br','2026-10','Rua J','3',NULL,'3101200'),
  ('27400000000101','Lead 274','3106200','Belo Horizonte','MG',50,NULL,NULL,'a@silva.cnt.br','2026-10','Rua J','4',NULL,'3101200'),
  ('27500000000101','Lead 275 é escritório','3106200','Belo Horizonte','MG',50,NULL,NULL,'contato@contabilidadey.com.br','2026-10','Rua J','5',NULL,'6920601'),
  ('27600000000101','Lead 276','3122306','Divinopolis','MG',93,NULL,NULL,'dp@contabilmais.com','2026-10','Rua K','6','Centro','3101200'),
  ('27700000000101','Lead 277 lixo','3106200','Belo Horizonte','MG',50,'(37) 0000-0000',NULL,NULL,'2026-10','Rua L','7',NULL,'3101200'),
  ('28100000000101','Lead 281 direto','3106200','Belo Horizonte','MG',40,'(31) 3555-0281',NULL,NULL,'2026-10','Rua M','8',NULL,'3101200');
-- Sócios (lote vigente): 231+232 dividem sócio (nome + CPF); 243+244 só o NOME (homônimo); o lote arquivado não conta.
INSERT INTO public.radar_socios (lote, raiz, nome_normalizado, cpf_mascarado) VALUES
  ('s-2026-10','23100000','MARIA DA SILVA','***111222**'), ('s-2026-10','23200000','MARIA DA SILVA','***111222**'),
  ('s-2026-10','24300000','JOSE DOS SANTOS','***333444**'), ('s-2026-10','24400000','JOSE DOS SANTOS','***555666**'),
  ('s-2026-09','24100000','ANA LIMA','***777888**'), ('s-2026-09','24200000','ANA LIMA','***777888**');
SQL

APPLY_LOG="$(dirname "$DATA")/apply.log"
for f in "$MIG" "$MIG2" "$MIGE"; do
  if ! P -q -f "$f" > "$APPLY_LOG" 2>&1; then cat "$APPLY_LOG"; echo "APLICAÇÃO DO PREDECESSOR FALHOU: $f"; exit 1; fi
done
# radar_lista de PROD = o CREATE do pacote B2 (o arquivo inteiro exige a predecessora de 21 args, que aqui não existe).
python3 -I - "$MIGB2" > "$(dirname "$DATA")/lista_b2.sql" <<'PY'
import sys
s = open(sys.argv[1], encoding="utf-8").read()
ini = s.index("CREATE OR REPLACE FUNCTION public.radar_lista(")
fim = s.index("-- PÓS", ini)
print(s[ini:fim])
PY
if ! P -q -f "$(dirname "$DATA")/lista_b2.sql" >> "$APPLY_LOG" 2>&1; then cat "$APPLY_LOG"; echo "RADAR_LISTA DO B2 FALHOU"; exit 1; fi
LISTA_B2_MD5="$(Pq -c "SELECT md5(prosrc) FROM pg_proc WHERE proname = 'radar_lista'")"
if [ "$LISTA_B2_MD5" != "c824ce104b6513307b6b027622c8fd50" ]; then echo "radar_lista do B2 com md5 $LISTA_B2_MD5 ≠ PROD"; exit 1; fi

if ! P -q -f "$MIGC_USADA" >> "$APPLY_LOG" 2>&1; then
  cat "$APPLY_LOG"; echo "APLICAÇÃO DA MIGRATION FALHOU"; exit 1
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
  printf '%s\n' "$out" | sed -n 's/^[A-Z]*:  \([0-9A-Z]\{5\}\): .*$/\1/p' | head -1
}
# marcas <tipo>: "cnpj3:motivos|grupos|corroborado;…" do que o escritor gravou
marcas() { Pq -c "SELECT COALESCE(string_agg(left(cnpj,3)||':'||array_to_string(motivos,'+')||'|'||COALESCE(grupos::text,'-')||'|'||COALESCE(corroborado::text,'-'), ';' ORDER BY cnpj, valor), '-') FROM public.radar_contato_contabil WHERE tipo = '$1'"; }
tem() { Pq -c "SELECT count(*) FROM public.radar_contato_contabil WHERE left(cnpj,3) = '$1' AND tipo = '$2'"; }
# efetivo <cnpj14>: "campo=automatico/veredito/efetivo,…" (t/f/-)
efetivo() { Pq -c "SELECT string_agg(a.campo||'='||COALESCE(a.automatico::text,'-')||'/'||COALESCE(a.veredito::text,'-')||'/'||COALESCE(a.efetivo::text,'-'), ',' ORDER BY a.campo) FROM public.radar_empresas e CROSS JOIN LATERAL private.radar_contato_contabil_avaliar(e.cnpj, e.telefone1, e.telefone2, e.email) a WHERE e.cnpj = '$1'"; }
visitar() { Pq -c "SELECT private.radar_contato_visitar(e.cnpj, e.telefone1, e.telefone2, e.email, e.logradouro) FROM public.radar_empresas e WHERE e.cnpj = '$1'"; }
corrigir() { como authenticated "$1" "SELECT public.radar_contato_contabil_corrigir('$2', '$3', $4, $5)::text"; }
ultima() { Pq -c "SELECT COALESCE(max(id)::text, 'NULL') FROM public.radar_contato_contabil_correcoes WHERE cnpj = '$1'"; }
lista_visitar() { como authenticated "$V1" "SELECT COALESCE(string_agg(left(cnpj,3), ',' ORDER BY cnpj), '-') FROM (SELECT cnpj FROM public.radar_lista(p_so_visitar => true, p_limit => 200) ORDER BY cnpj) x"; }

# ── C1 telefone ───────────────────────────────────────────────────────────────────────────────────────────────
eq "C1a telefone A em 4 raízes sem vínculo: marca 201-204 (4 grupos)" \
   "$(marcas telefone | tr ';' '\n' | grep -c '^20[1-4]:telefone_compartilhado|4|')" "4"
eq "C1b telefone B em 3 raízes sem corroboração NÃO marca (V2)" "$(tem 211 telefone)$(tem 212 telefone)$(tem 213 telefone)" "000"
eq "C1c telefone C em 3 raízes com corroboração (223 tem e-mail contábil) marca as 3" \
   "$(marcas telefone | tr ';' '\n' | grep -c '^22[123]:telefone_compartilhado|3|true$')" "3"
eq "C1d sócio em comum (nome + CPF, lote vigente) une 231+232: 3 grupos sem corroboração, não marca" \
   "$(tem 231 telefone)$(tem 233 telefone)" "00"
eq "C1e sócio só homônimo (CPF diferente) NÃO une; lote arquivado não conta: E segue com 4 grupos" \
   "$(marcas telefone | tr ';' '\n' | grep -c '^24[1-4]:telefone_compartilhado|4|')" "4"
eq "C1f filiais da mesma raiz (251) contam 1 grupo: F tem 2 grupos, não marca" "$(tem 251 telefone)$(tem 252 telefone)" "00"
eq "C1g o 9º dígito junta: 204 (3791110001) e 201 ((37) 99111-0001) estão no mesmo grupo; o valor estrito fica" \
   "$(Pq -c "SELECT string_agg(valor, ',' ORDER BY cnpj) FROM public.radar_contato_contabil WHERE cnpj IN ('20100000000101','20400000000101') AND tipo = 'telefone'")" \
   "37991110001,3791110001"
eq "C1h número lixo ((37) 0000-0000) não é utilizável; DDD+fixo válido é" \
   "$(Pq -c "SELECT COALESCE(private.radar_tel_valor('(37) 0000-0000'),'NULL')||','||private.radar_tel_valor('+55 (37) 3222-0202')")" \
   "NULL,3732220202"

# ── C2 e-mail ─────────────────────────────────────────────────────────────────────────────────────────────────
eq "C2a mesmo endereço (normalizado) em 3 raízes: email_compartilhado com 3 grupos" \
   "$(marcas email | tr ';' '\n' | grep -c '^26[123]:email_compartilhado|3|-$')" "3"
eq "C2b palavra fraca (escritorio) tem motivo próprio, separado da forte" \
   "$(marcas email | tr ';' '\n' | grep '^271:')" "271:email_palavra_fraca|-|-"
eq "C2c palavra forte (contab) em maiúsculas vira minúsculo: 223 email_palavra" \
   "$(marcas email | tr ';' '\n' | grep '^223:')" "223:email_palavra|-|-"
eq "C2d domínio de serviço: maismei, crcmg.org.br e .cnt.br" \
   "$(marcas email | tr ';' '\n' | grep -c '^27[234]:dominio_servico|-|-$')" "3"
eq "C2e e-mail pessoal (gmail) não marca" "$(tem 203 email)" "0"
eq "C2f lead que É escritório (CNAE 6920) não recebe marca automática" "$(tem 275 email)" "0"

# ── C3 escritor ───────────────────────────────────────────────────────────────────────────────────────────────
eq "C3a 2ª chamada sem mudança: o gate pula" \
   "$(Pq -c "SELECT public.radar_contato_contabil_recalcular() ->> 'pulado'")" "true"
# C sai de 3 para 2 raízes (221 troca de número): o dado mudou (updated_at), recalcula e apaga 222/223 do telefone C.
P -q -c "UPDATE public.radar_empresas SET telefone1 = '(37) 3333-9221', updated_at = now() + interval '1 second' WHERE cnpj = '22100000000101'"
eq "C3b dado mudou: não pula" "$(Pq -c "SELECT public.radar_contato_contabil_recalcular() ->> 'pulado'")" "false"
eq "C3c MERGE apaga o que deixou de valer (telefone C de 222 e 223), mantém o e-mail de 223" \
   "$(tem 222 telefone)$(tem 223 telefone)$(tem 223 email)" "001"
eq "C3d forçar recalcula mesmo sem mudança" "$(Pq -c "SELECT public.radar_contato_contabil_recalcular(true) ->> 'pulado'")" "false"

# ── C4 efetivo e correção ─────────────────────────────────────────────────────────────────────────────────────
eq "C4z antes de corrigir: telefone A de 201 é automático e efetivo" "$(efetivo 20100000000101)" "telefone1=true/-/true"
R1="$(corrigir "$V1" 20100000000101 telefone1 false NULL)"
eq "C4a 'não é da contabilidade' prevalece sobre o automático" "$(efetivo 20100000000101)" "telefone1=true/false/false"
ID1="$(ultima 20100000000101)"
eq "C4b a resposta diz o efetivo e grava o que o automático dizia" \
   "$(printf '%s' "$R1" | grep -o '"efetivo": false' | head -1)|$(Pq -c "SELECT automatico FROM public.radar_contato_contabil_correcoes WHERE id = $ID1")" \
   '"efetivo": false|t'
eq "C4c versão velha (NULL, quando já existe a $ID1) é recusada: desatualizado, nada gravado" \
   "$(corrigir "$V2" 20100000000101 telefone1 true NULL | grep -o '"motivo": "desatualizado"')|$(ultima 20100000000101)" \
   "\"motivo\": \"desatualizado\"|$ID1"
corrigir "$V2" 20100000000101 telefone1 NULL "$ID1" > /dev/null
eq "C4d NULL volta ao automático (com a versão certa)" "$(efetivo 20100000000101)" "telefone1=true/-/true"
# Troca telefone1↔telefone2: a correção é do CONTATO, não do campo.
corrigir "$V1" 20200000000101 telefone2 true NULL > /dev/null
P -q -c "UPDATE public.radar_empresas SET telefone1 = telefone2, telefone2 = telefone1 WHERE cnpj = '20200000000101'"
eq "C4e a correção acompanha o contato na troca de campo e não passa para o número novo" \
   "$(efetivo 20200000000101)" "telefone1=false/true/true,telefone2=true/-/true"
P -q -c "UPDATE public.radar_empresas SET telefone1 = '(37) 3222-0202', telefone2 = NULL WHERE cnpj = '20200000000101'"
P -q -c "UPDATE public.radar_empresas SET telefone2 = '(37) 3222-7777' WHERE cnpj = '20200000000101'"
eq "C4e2 número NOVO não herda veredito nem marca (automático false, sem veredito)" \
   "$(efetivo 20200000000101)" "telefone1=false/true/true,telefone2=false/-/false"
P -q -c "UPDATE public.radar_empresas SET telefone1 = '(37) 99111-0001', telefone2 = '(37) 3222-0202' WHERE cnpj = '20200000000101'"
ESTADO_SALVO="$(Pq -c "SELECT row_to_json(s)::text FROM public.radar_contato_contabil_estado s")"
P -q -c "DELETE FROM public.radar_contato_contabil_estado"
eq "C4f nunca calculado = NULL (não sei), nunca false; e 'visitar' não afirma" \
   "$(efetivo 28100000000101)|$(visitar 28100000000101)" "telefone1=-/-/-|f"
P -q -v e="$ESTADO_SALVO" <<'SQL'
INSERT INTO public.radar_contato_contabil_estado SELECT * FROM json_populate_record(NULL::public.radar_contato_contabil_estado, :'e'::json);
SQL
eq "C4g autor da correção = auth.uid() de quem corrigiu" \
   "$(Pq -c "SELECT string_agg(right(autor_user_id::text, 2), ',' ORDER BY id) FROM public.radar_contato_contabil_correcoes WHERE cnpj = '20100000000101'")" "11,12"

# ── C5 visitar ────────────────────────────────────────────────────────────────────────────────────────────────
eq "C5a só o telefone da contabilidade + endereço → visitar (201); só e-mail contábil → visitar (276)" \
   "$(visitar 20100000000101)$(visitar 27600000000101)" "tt"
eq "C5b um contato direto basta para não ser visitar: 203 (gmail); 202 com telefone2 direto sem correção" \
   "$(visitar 20300000000101)$(Pq -c "SELECT private.radar_contato_visitar(cnpj, telefone1, '(37) 3222-8888', email, logradouro) FROM public.radar_empresas WHERE cnpj = '20200000000101'")" "ff"
eq "C5c sem endereço não manda visitar (204)" "$(visitar 20400000000101)" "f"

# ── C6 fila ───────────────────────────────────────────────────────────────────────────────────────────────────
eq "C6a radar_lista(p_so_visitar) recorta no servidor; sem o parâmetro, a lista é a de antes" \
   "$(lista_visitar)|$(como authenticated "$V1" "SELECT count(*) FROM public.radar_lista(p_limit => 200)")" \
   "201,202,241,242,243,244,261,262,263,271,272,273,274,276|33"
corrigir "$V1" 28100000000101 telefone1 true NULL > /dev/null
eq "C6b correção positiva num lead SEM marca automática entra no recorte (281)" \
   "$(lista_visitar | tr ',' '\n' | grep -c '^281$')" "1"

# ── C7 card e e-mail ──────────────────────────────────────────────────────────────────────────────────────────
eq "C7a card: 201 e 276 vêm 'visitar' com endereço; 202 (telefone2 corrigido como contabilidade) também" \
   "$(como authenticated "$V1" "SELECT string_agg(left(l->>'cnpj',3)||':'||(l->>'visitar')||':'||COALESCE(l->>'endereco','-'), ';' ORDER BY (l->>'posicao')::int) FROM jsonb_array_elements(public.radar_prospectar_hoje(NULL, 5)->'leads') l")" \
   "201:true:Rua A 10, Centro, Divinopolis/MG;202:true:Rua B 20, Centro, Divinopolis/MG;276:true:Rua K 6, Centro, Divinopolis/MG"
P -q -c "INSERT INTO public.radar_email_vendedor_config (vendedor_user_id, ativo) VALUES ('$V1', true)"
P -q -c "UPDATE public.radar_empresas SET telefone2 = '(37) 3222-0277' WHERE cnpj = '27600000000101'"   # 276 ganha telefone direto
Pq -c "SELECT public.radar_avisar_vendedores('2026-11-16 11:00+00')" > /dev/null
MSG="$(Pq -c "SELECT mensagem FROM public.fornecedor_alerta ORDER BY id DESC LIMIT 1")"
eq "C7b e-mail: lead visitar sai com VISITAR + endereço, sem prometer telefone; o com contato direto, sem" \
   "$(printf '%s' "$MSG" | grep -c 'VISITAR: o telefone e o e-mail da Receita parecem ser da contabilidade da empresa')|$(printf '%s' "$MSG" | grep -c 'Rua A 10, Centro, Divinopolis/MG')|$(printf '%s' "$MSG" | grep -c 'Rua K 6')|$(printf '%s' "$MSG" | grep -c 'Nas marcadas VISITAR')" \
   "2|1|0|1"
eq "C7c radar_email_vendedor_leads guarda quem foi como visitar" \
   "$(Pq -c "SELECT string_agg(left(cnpj,3)||':'||COALESCE(visitar::text,'-'), ',' ORDER BY posicao) FROM public.radar_email_vendedor_leads")" \
   "201:true,202:true,276:false"

# ── C8 ACL ────────────────────────────────────────────────────────────────────────────────────────────────────
eq "C8a tabelas: authenticated e anon não leem direto (42501)" \
   "$(erro_como authenticated "$V1" "SELECT count(*) FROM public.radar_contato_contabil")$(erro_como anon "" "SELECT count(*) FROM public.radar_contato_contabil_correcoes")" "4250142501"
eq "C8b internas fechadas: authenticated não executa private.radar_contato_contabil_avaliar nem o escritor" \
   "$(erro_como authenticated "$V1" "SELECT count(*) FROM private.radar_contato_contabil_avaliar('20100000000101', NULL, NULL, NULL)")$(erro_como authenticated "$V1" "SELECT public.radar_contato_contabil_recalcular(true)")" "4250142501"
eq "C8c gate do Radar: customer recebe forbidden (42501) na ficha e na correção; vendedor lê" \
   "$(erro_como authenticated "$C" "SELECT count(*) FROM public.radar_contato_contabil_da_empresa('20100000000101')")$(erro_como authenticated "$C" "SELECT public.radar_contato_contabil_corrigir('20100000000101','telefone1',true,NULL)")|$(como authenticated "$V1" "SELECT string_agg(campo||':'||efetivo||':'||visitar, ',') FROM public.radar_contato_contabil_da_empresa('20100000000101')")" \
   "4250142501|telefone1:true:true"
eq "C8d anon não executa as RPCs do front (42501)" \
   "$(erro_como anon "" "SELECT count(*) FROM public.radar_contato_contabil_da_empresa('20100000000101')")" "42501"
eq "C8e campo sem contato utilizável e campo inválido gritam (22023)" \
   "$(erro_como authenticated "$V1" "SELECT public.radar_contato_contabil_corrigir('20100000000101','telefone2',true,NULL)")$(erro_como authenticated "$V1" "SELECT public.radar_contato_contabil_corrigir('20100000000101','fax',true,NULL)")" "2202322023"

# ── C9 re-aplicação e anti-deriva ─────────────────────────────────────────────────────────────────────────────
if P -q -f "$MIGC_USADA" >> "$APPLY_LOG" 2>&1; then REAP=ok; else REAP=falhou; tail -5 "$APPLY_LOG"; fi
eq "C9a re-aplicar a migration sobre ela mesma passa e não apaga correção" \
   "$REAP|$(Pq -c "SELECT count(*) FROM public.radar_contato_contabil_correcoes")" "ok|4"
P -q <<'SQL'
CREATE OR REPLACE FUNCTION public.radar_prospectar_hoje(p_vendedor uuid DEFAULT NULL, p_n integer DEFAULT 3)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $fn$ SELECT '{}'::jsonb $fn$;
SQL
DERIVA_OUT="$(P -q -f "$MIGC_USADA" 2>&1 || true)"
eq "C9b anti-deriva: corpo vivo que não é o predecessor nem este aborta a re-aplicação (e não apaga a outra sessão)" \
   "$(printf '%s' "$DERIVA_OUT" | grep -c 'PRE FALHOU: public.radar_prospectar_hoje')|$(Pq -c "SELECT prosrc LIKE '%{}%' FROM pg_proc WHERE oid = 'public.radar_prospectar_hoje(uuid,integer)'::regprocedure")" \
   "1|t"

echo "PASS=$PASS FAIL=$FAIL"
[ "$FAIL" -eq 0 ]
