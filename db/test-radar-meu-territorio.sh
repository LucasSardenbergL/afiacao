#!/usr/bin/env bash
# Prova PG17 do Radar pacote F (achado 2) — migration 20261107220000_radar_meu_territorio:
#   • public.radar_meu_territorio é FINA: devolve exatamente private.radar_territorio_do_vendedor do usuário logado
#     (a regra do território — carteira elegível, endereço padrão, um dono por município — é da migration
#     20261106181000 e é aplicada AQUI sem alteração, como base).
#   • gate com SQLSTATE: sem cap_radar_prospectar → 42501 (forbidden); território de OUTRO vendedor só para gestor;
#     anon não executa (ACL); p_top vai à privada (que o limita a [1,10]).
#   • PÓS da migration aborta o apply se o ACL abrir para PUBLIC/anon; re-aplicar é idempotente.
#
#   bash db/test-radar-meu-territorio.sh > /tmp/t.log 2>&1; echo "exit=$?"
#   SABOTAGEM=<nome> bash db/test-radar-meu-territorio.sh   # tem de ficar VERMELHA
#   bash db/test-radar-meu-territorio.sh --falsificar        # controle verde + cada sabotagem vermelha no assert dela
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MIG_D="$REPO_ROOT/supabase/migrations/20261106181000_radar_leads_ao_vendedor.sql"
MIG="$REPO_ROOT/supabase/migrations/20261107220000_radar_meu_territorio.sql"

if [ "${1:-}" = "--falsificar" ]; then
  # <sabotagem>:<assert que TEM de acusá-la>. `POST!texto_da_marca` = a PÓS aborta o apply com a marca (`_` = espaço).
  SABOTAGENS="sem_gate:A5 sem_gate_gestor:A3 alvo_ignorado:A4 acl_anon:POST!POS_FALHOU:_anon_executa acl_anon_sem_post:A6"
  LOGDIR="$(mktemp -d "${TMPDIR:-/tmp}/falsif-radar-meu-territorio.XXXXXX")"
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
  echo "SABOTAGENS: $((n_sab - falhas)) vermelhas / $falhas falhas"
  [ "$falhas" -eq 0 ] && exit 0 || exit 1
fi

export PGVER=17
# shellcheck disable=SC1091  # caminho resolvido em runtime a partir de REPO_ROOT
. "$REPO_ROOT/db/lib/pg-harness.sh"
PORT="${PGPORT_TEST:-5498}"
DATA="$(mktemp -d "${TMPDIR:-/tmp}/pgtest-radar-meu-territorio.XXXXXX")/data"
export LC_ALL=C LANG=C
MIG_USADA="$(dirname "$DATA")/mig.sql"
cleanup() { "$PGBIN/pg_ctl" -D "$DATA" stop -m immediate >/dev/null 2>&1 || true; rm -rf "$(dirname "$DATA")"; }
trap cleanup EXIT

# Sabotagem num ESPELHO em tmpdir — nunca em supabase/migrations/ (DR, hook de imutabilidade).
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
cegar_post() { sabotar "  v_fn oid := to_regprocedure('public.radar_meu_territorio(uuid,integer)');
BEGIN
" "  v_fn oid := to_regprocedure('public.radar_meu_territorio(uuid,integer)');
BEGIN
  RETURN;
"; }
case "${SABOTAGEM:-}" in
  "") ;;
  sem_gate)          sabotar "  IF NOT COALESCE(private.cap_radar_prospectar(v_uid), false) THEN" "  IF false THEN" ;;
  sem_gate_gestor)   sabotar "  IF v_alvo <> v_uid AND NOT COALESCE(private.pode_ver_carteira_completa(v_uid), false) THEN" "  IF false THEN" ;;
  alvo_ignorado)     sabotar "private.radar_territorio_do_vendedor(v_alvo," "private.radar_territorio_do_vendedor(v_uid," ;;
  acl_anon)          sabotar "REVOKE ALL ON FUNCTION public.radar_meu_territorio(uuid, integer) FROM PUBLIC, anon;" "REVOKE ALL ON FUNCTION public.radar_meu_territorio(uuid, integer) FROM PUBLIC;" ;;
  acl_anon_sem_post) sabotar "REVOKE ALL ON FUNCTION public.radar_meu_territorio(uuid, integer) FROM PUBLIC, anon;" "REVOKE ALL ON FUNCTION public.radar_meu_territorio(uuid, integer) FROM PUBLIC;"; cegar_post ;;
  *) echo "sabotagem desconhecida: $SABOTAGEM"; exit 9 ;;
esac
[ -n "${SABOTAGEM:-}" ] && echo "⚠️  SABOTAGEM ATIVA: $SABOTAGEM"

# ── Esquema mínimo e carteira: os MESMOS do harness do pacote D (db/test-radar-leads-vendedor.sh), que lê os corpos
#    de prod via psql-ro (2026-11-06). Território esperado (comentários de lá): V1 DIV 4 · NS 3 · CLA 2 · FOR 2;
#    V2 CAJ 3 · ITA 2 · PAR 2 · BH 1 (DIV fica com V1). G (gestor) e M (master) não têm território de vendedor.
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

APPLY_LOG="$(dirname "$DATA")/apply.log"
if ! P -q -f "$MIG_D" > "$APPLY_LOG" 2>&1; then
  cat "$APPLY_LOG"; echo "APLICAÇÃO DA MIGRATION BASE (pacote D) FALHOU"; exit 1
fi
if ! P -q -f "$MIG_USADA" >> "$APPLY_LOG" 2>&1; then
  cat "$APPLY_LOG"; echo "APLICAÇÃO DA MIGRATION FALHOU"; exit 1
fi
grep -qF "radar pacote F: radar_meu_territorio ok" "$APPLY_LOG" || [ "${SABOTAGEM:-}" = "acl_anon_sem_post" ] \
  || { cat "$APPLY_LOG"; echo "PÓS sem marcador positivo"; exit 1; }

PASS=0; FAIL=0
eq() { if [ "$2" = "$3" ]; then echo "PASS $1"; PASS=$((PASS+1)); else echo "FAIL $1 — obtido [$2] esperado [$3]"; FAIL=$((FAIL+1)); fi; }
# como <papel> <uid> <sql>: a chamada COMO o app (SET ROLE + JWT na mesma sessão, como o PostgREST). Erro sai com a
# SQLSTATE (VERBOSITY verbose) para o assert casar o RAMO, não "falhou de algum jeito".
como() {
  local claims='{}'; [ -n "$2" ] && claims="{\"sub\":\"$2\"}"
  P -qAt -v VERBOSITY=verbose -c "SET ROLE $1" -c "SET request.jwt.claims = '$claims'" -c "$3" 2>&1 | head -1 || true
}
cods() { # território como "codigo:clientes,..." na ordem devolvida
  como authenticated "$1" "SELECT string_agg(municipio_codigo || ':' || clientes, ',') FROM (SELECT * FROM public.radar_meu_territorio($2)) t"
}
FIRMA_PRIV="SELECT string_agg(municipio_codigo || ':' || clientes, ',' ORDER BY clientes DESC, municipio_codigo) FROM private.radar_territorio_do_vendedor"

# A1 — o próprio território = exatamente o da função privada (a RPC é FINA, não reescreve a regra).
eq A1 "$(cods "$V1" "")" "3122306:4,3145208:3,3116907:2"
eq A1b "$(cods "$V1" "")" "$(Pq -c "$FIRMA_PRIV('$V1', 3)")"
# A2 — outro vendedor: Divinópolis é de V1 (4 × 2), então V2 fica com Cajuru, Itaúna, Pará de Minas.
eq A2 "$(cods "$V2" "")" "3114402:3,3133808:2,3147105:2"
# A3 — vendedor pedindo o território de OUTRO: 42501 com a marca do gate de gestor.
r="$(como authenticated "$V1" "SELECT count(*) FROM public.radar_meu_territorio('$V2'::uuid)")"
case "$r" in *"42501"*"exige gestor"*) eq A3 ok ok ;; *) eq A3 "$r" "42501 exige gestor" ;; esac
# A4 — gestor vê o de um vendedor (lente "Ver como"): o do ALVO, não o dele (vazio).
eq A4 "$(cods "$G" "'$V1'::uuid")" "3122306:4,3145208:3,3116907:2"
# A5 — sem a capability (customer com cargo residual; JWT vazio): 42501 com a marca do gate do Radar.
r="$(como authenticated "$C" "SELECT count(*) FROM public.radar_meu_territorio()")"
case "$r" in *"42501"*"forbidden: radar_prospectar"*) eq A5 ok ok ;; *) eq A5 "$r" "42501 forbidden: radar_prospectar" ;; esac
r="$(como authenticated "" "SELECT count(*) FROM public.radar_meu_territorio()")"
case "$r" in *"42501"*"forbidden: radar_prospectar"*) eq A5b ok ok ;; *) eq A5b "$r" "42501 forbidden: radar_prospectar" ;; esac
# A6 — anon nem executa (ACL; a marca é do privilégio, não do gate).
r="$(como anon "$V1" "SELECT count(*) FROM public.radar_meu_territorio()")"
case "$r" in *"42501"*"permission denied for function radar_meu_territorio"*) eq A6 ok ok ;; *) eq A6 "$r" "42501 permission denied" ;; esac
# A7 — gestor sem carteira de vendedor: território VAZIO (0 linhas, sem erro) — o front mantém o default de antes.
eq A7 "$(como authenticated "$G" "SELECT count(*) FROM public.radar_meu_territorio()")" "0"
eq A7b "$(como authenticated "$M" "SELECT count(*) FROM public.radar_meu_territorio()")" "0"
# A8 — p_top=1 → só o 1º.
eq A8 "$(cods "$V1" "NULL, 1")" "3122306:4"
# A9 — p_top passa à privada, que limita a [1,10]: com 5 municípios (inclui o homônimo SP), devolve os 5.
eq A9 "$(cods "$V1" "NULL, 99")" "3122306:4,3145208:3,3116907:2,3126109:2,3500000:1"
eq A9b "$(como authenticated "$V1" "SELECT count(*) FROM public.radar_meu_territorio(NULL, 0)")" "1"
# A10 — ACL nas duas pontas, medido por has_function_privilege.
eq A10 "$(Pq -c "SELECT has_function_privilege('anon', 'public.radar_meu_territorio(uuid,integer)', 'EXECUTE')::text || ',' || has_function_privilege('authenticated', 'public.radar_meu_territorio(uuid,integer)', 'EXECUTE')::text")" "false,true"
# A11 — re-aplicar é idempotente (PÓS verde de novo, mesmo resultado).
if P -q -f "$MIG_USADA" >> "$APPLY_LOG" 2>&1; then eq A11 "$(cods "$V1" "")" "3122306:4,3145208:3,3116907:2"; else eq A11 reaplicar-falhou ok; fi

echo "PASS=$PASS FAIL=$FAIL"
[ "$FAIL" -eq 0 ]
