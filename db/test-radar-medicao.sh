#!/usr/bin/env bash
# Prova PG17 do pacote M do Radar (medir a adoção com denominador) — migration 20261111134500_radar_medicao_pacote_m,
# aplicada por cima das REAIS do pacote D (20261106181000) e H (20261107233000), com os corpos do ledger de eventos
# (20261029150100) extraídos do próprio arquivo, como em prod:
#   • M1 universo: radar_funil lista todo elegível agora (cap_radar_prospectar), inclusive o sem atividade, com zero
#     explícito; staff sem cargo comercial e customer ficam fora; `adocao` por vendedor (exposto, 1ª ação, dias).
#   • M2 reposição do card: radar_registrar_card_exibido grava cada CNPJ (idempotente por dia); o clique conta só em
#     CNPJ exibido no mesmo dia (numerador ⊂ denominador); antes da 1ª exibição a célula é NULL (ausente ≠ zero).
#   • M3 intenção: radar_registrar_intencao grava 1 por vendedor, CNPJ, canal e dia; gates com SQLSTATE; a forma do
#     evento é constraint do ledger.
#   • M4 radar_placar_uso some; o contato automático não vira evento (o humano sim, com nota); o experimento
#     (coorte + faixa) sai por radar_funil_experimento, só master/gestor.
#   • M5 retenção: expurgo em lote dos automáticos, 400 dias para abriu/intencao/aberturas/exibições, 180 para as
#     falhas, contato humano nunca; o JWT não executa o expurgo; cron agendado.
#   • PRE anti-deriva: corpo vivo diferente do predecessor revisado aborta o apply.
#
#   bash db/test-radar-medicao.sh > /tmp/t.log 2>&1; echo "exit=$?"
#   SABOTAGEM=<nome> bash db/test-radar-medicao.sh   # tem de ficar VERMELHA
#   bash db/test-radar-medicao.sh --falsificar        # controle verde + cada sabotagem vermelha no assert dela
#   IMPRIMIR_MD5=1 bash db/test-radar-medicao.sh      # imprime o md5(prosrc) das funções deste arquivo (para a PRE/PÓS)
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MIG_EV="$REPO_ROOT/supabase/migrations/20261029150100_radar_eventos_placar.sql"
MIG_EV2="$REPO_ROOT/supabase/migrations/20261106132259_radar_abriu_ficha_com_cnpj.sql"   # recria o placar
MIG_D="$REPO_ROOT/supabase/migrations/20261106181000_radar_leads_ao_vendedor.sql"
MIG_H="$REPO_ROOT/supabase/migrations/20261107233000_radar_funil_painel.sql"
MIG="$REPO_ROOT/supabase/migrations/20261111134500_radar_medicao_pacote_m.sql"

if [ "${1:-}" = "--falsificar" ]; then
  # <sabotagem>:<assert que TEM de acusá-la>. `POST!M2_FALHOU` = a postcondição aborta o apply com a marca exata.
  SABOTAGENS="universo_some:A1a atribuido_conta:A4d exibido_sem_subset:A2f automatico_grava:A5a intencao_sem_dedup:A3b intencao_sem_cap:A3d experimento_sem_gate:A6a expurgo_humano:A7d expurgo_aberto:POST!M2_FALHOU pre_cega:A8a"
  LOGDIR="$(mktemp -d "${TMPDIR:-/tmp}/falsifica-radar-medicao.XXXXXX")"
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
DATA="$(mktemp -d "${TMPDIR:-/tmp}/pgtest-radar-medicao.XXXXXX")/data"
# Matriz: HARNESS_LC=C|pt_BR.UTF-8 (lc_messages do servidor) · HARNESS_TZ=UTC|America/Sao_Paulo (TimeZone do servidor).
export LC_ALL=C LANG=C
HARNESS_LC="${HARNESS_LC:-C}"; HARNESS_TZ="${HARNESS_TZ:-UTC}"
TMPD="$(dirname "$DATA")"
MIG_USADA="$TMPD/mig.sql"
cleanup() { "$PGBIN/pg_ctl" -D "$DATA" stop -m immediate >/dev/null 2>&1 || true; rm -rf "$TMPD"; }
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
cegar_post() { sabotar "  r record;
  f text;
BEGIN
  -- P1" "  r record;
  f text;
BEGIN
  RETURN;
  -- P1"; }
# A sabotagem muda o corpo: a régua md5 da PRE/PÓS deixaria de bater e mascararia o assert funcional. Com sabotagem
# de corpo, a PÓS P1 vira aviso (o resto da PÓS segue valendo); a PRE é provada à parte (A8).
APLICAR_VEZES=2
pos_md5_aviso() { APLICAR_VEZES=1; sabotar "      RAISE EXCEPTION 'M1 FALHOU: % vivo (md5 %) não é este', r.alvo, r.vivo;" \
                          "      RAISE NOTICE 'MD5 % %', r.alvo, r.vivo;"; }
case "${SABOTAGEM:-}" in
  "") ;;
  universo_some)       sabotar "    SELECT elig.uid FROM elig
    UNION SELECT env.uid FROM env WHERE env.semana >= v_ini" "    SELECT env.uid FROM env WHERE env.semana >= v_ini"; pos_md5_aviso ;;
  atribuido_conta)     sabotar "WHERE t.assumido_em >= v_ini_ts AND t.atribuido_por IS NULL" "WHERE t.assumido_em >= v_ini_ts"; pos_md5_aviso ;;
  exibido_sem_subset)  sabotar "AND a.cnpj = exib.cnpj AND a.dia = exib.dia" ""; pos_md5_aviso ;;
  automatico_grava)    sabotar "  IF TG_OP = 'INSERT' AND NEW.criado_por = c_sistema THEN RETURN NEW; END IF;
" ""; pos_md5_aviso ;;
  intencao_sem_dedup)  sabotar "p_canal || ':' || v_dia)" "p_canal || ':' || clock_timestamp())"; pos_md5_aviso ;;
  intencao_sem_cap)    sabotar "  v_n    integer;
BEGIN
  IF NOT COALESCE(private.cap_radar_prospectar(v_uid), false) THEN" "  v_n    integer;
BEGIN
  IF false THEN"; pos_md5_aviso ;;
  experimento_sem_gate) sabotar "    RAISE EXCEPTION 'forbidden: experimento do radar exige master ou gestor comercial' USING ERRCODE = '42501';" "    NULL;"; pos_md5_aviso ;;
  expurgo_humano)      sabotar "   WHERE e.origem = 'humano' AND e.evento IN ('abriu', 'intencao') AND e.ocorrido_em" "   WHERE e.origem = 'humano' AND e.ocorrido_em"; pos_md5_aviso ;;
  expurgo_aberto)      sabotar "REVOKE ALL ON FUNCTION private.radar_expurgar_medicao(integer) FROM PUBLIC, anon, authenticated;" "REVOKE ALL ON FUNCTION private.radar_expurgar_medicao(integer) FROM PUBLIC, anon;" ;;
  pre_cega)            sabotar "    ELSIF r.vivo IS DISTINCT FROM r.predecessor AND r.vivo IS DISTINCT FROM r.este THEN" "    ELSIF false THEN" ;;
  *) echo "sabotagem desconhecida: $SABOTAGEM"; exit 9 ;;
esac
[ -n "${IMPRIMIR_MD5:-}" ] && pos_md5_aviso
[ -n "${SABOTAGEM:-}" ] && echo "⚠️  SABOTAGEM ATIVA: $SABOTAGEM"

"$PGBIN/initdb" -D "$DATA" -U postgres -E UTF8 --locale=C >/dev/null
"$PGBIN/pg_ctl" -D "$DATA" -o "-p $PORT -k /tmp" -l "$TMPD/pg.log" -w start >/dev/null
P()  { "$PGBIN/psql" -X -v ON_ERROR_STOP=1 -p "$PORT" -h /tmp -U postgres -d postgres "$@"; }
Pq() { P -qAt "$@"; }
# jit = off como em PROD (o radar_funil compila caro com LLVM; ver db/test-radar-funil.sh).
P -q -c "ALTER DATABASE postgres SET jit = off" -c "ALTER DATABASE postgres SET lc_messages = '$HARNESS_LC'" -c "ALTER DATABASE postgres SET timezone = '$HARNESS_TZ'" \
  || { echo "INFRA: lc_messages='$HARNESS_LC'/timezone='$HARNESS_TZ' indisponivel"; exit 1; }
echo "═══ PG17 :$PORT · lc_messages=$HARNESS_LC · TimeZone=$HARNESS_TZ ═══"

# ── Esquema mínimo (o de db/test-radar-funil.sh + a forma de PROD do ledger e da coorte) ────────────────────────
P -q <<'SQL'
CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN; CREATE ROLE service_role NOLOGIN BYPASSRLS;
CREATE ROLE claude_ro NOLOGIN;
CREATE SCHEMA auth; CREATE SCHEMA private; CREATE SCHEMA cron;
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
  rfb_situacao text, score smallint, score_motivos text[], score_versao text, score_em timestamptz,
  omie_cadastrado_em timestamptz);
CREATE TABLE public.radar_contatos (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), cnpj text, acao text, criado_por uuid,
  created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE public.radar_atendimentos (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), cnpj text NOT NULL, dono_user_id uuid NOT NULL,
  assumido_em timestamptz NOT NULL, renovado_em timestamptz, encerrado_em timestamptz, atribuido_por uuid);
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
CREATE TABLE public.analytics_outbox (event_id uuid PRIMARY KEY DEFAULT gen_random_uuid(), evento text, props jsonb, user_id uuid);
-- Ledger e coorte na forma de PROD (20261029150100; a constraint do evento com o nome que prod tem).
CREATE TABLE public.radar_eventos (
  id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  evento         text NOT NULL CONSTRAINT radar_eventos_evento_check CHECK (evento IN ('abriu', 'contato', 'contato_desfeito', 'cadastrou')),
  origem         text NOT NULL CHECK (origem IN ('humano', 'automatica')),
  ocorrido_em    timestamptz NOT NULL,
  gravado_em     timestamptz NOT NULL DEFAULT clock_timestamp(),
  user_id        uuid, cnpj text, contato_id uuid, acao text,
  nota_capturada boolean NOT NULL DEFAULT false,
  score smallint, score_versao text, score_em timestamptz,
  retroativo     boolean NOT NULL DEFAULT false,
  fonte_id       text NOT NULL UNIQUE,
  CONSTRAINT radar_eventos_nota_so_capturada CHECK (nota_capturada OR (score IS NULL AND score_versao IS NULL AND score_em IS NULL)),
  CONSTRAINT radar_eventos_captura_so_no_contato_vivo CHECK (NOT nota_capturada OR (evento = 'contato' AND NOT retroativo)),
  CONSTRAINT radar_eventos_humano_tem_titular CHECK (origem = 'automatica' OR user_id IS NOT NULL));
CREATE INDEX ON public.radar_eventos (evento, ocorrido_em);
CREATE TABLE public.radar_coorte_controle (
  sorteio text NOT NULL, grupo text NOT NULL CHECK (grupo IN ('topo', 'amostra')), cnpj text NOT NULL, lote text NOT NULL,
  posicao integer NOT NULL CHECK (posicao >= 1), score_no_sorteio smallint NOT NULL, score_versao text NOT NULL,
  sorteada_em timestamptz NOT NULL, PRIMARY KEY (sorteio, cnpj), UNIQUE (sorteio, grupo, posicao));
ALTER TABLE public.radar_eventos ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.radar_eventos FROM PUBLIC, anon, authenticated;

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

# Os corpos do ledger, EXTRAÍDOS das migrations (a ÚLTIMA definição de cada um vence, como em prod; a A9 confere o
# md5 contra a PROD).
python3 -I - "$MIG_EV" "$MIG_EV2" > "$TMPD/ledger.sql" <<'PY'
import re, sys
textos = [open(f, encoding="utf-8").read() for f in sys.argv[1:]]
for nome in ("private.radar_evento_contato", "public.radar_placar_uso", "public.radar_coorte_resultado",
             "public.radar_conversao_por_faixa"):
    achado = None
    for s in textos:
        for m in re.finditer(r"CREATE OR REPLACE FUNCTION " + re.escape(nome) + r"\(.*?\n\$function\$;\n", s, re.S):
            achado = m.group(0)
    if not achado:
        sys.exit("corpo ausente: " + nome)
    print(achado)
PY
P -q -f "$TMPD/ledger.sql"
P -q <<'SQL'
CREATE TRIGGER trg_radar_evento_contato_ins AFTER INSERT ON public.radar_contatos
  FOR EACH ROW EXECUTE FUNCTION private.radar_evento_contato();
CREATE TRIGGER trg_radar_evento_contato_del AFTER DELETE ON public.radar_contatos
  FOR EACH ROW EXECUTE FUNCTION private.radar_evento_contato();
SQL

# ── Atores ────────────────────────────────────────────────────────────────────────────────────────────────
V1=a0000000-0000-0000-0000-000000000001   # farmer que usa
V2=a0000000-0000-0000-0000-000000000002   # farmer elegível SEM atividade (o que sumia do painel)
G=a0000000-0000-0000-0000-000000000008    # gestor (employee + gerencial): elegível e lê o painel
M=a0000000-0000-0000-0000-000000000009    # master
C=a0000000-0000-0000-0000-000000000007    # customer
X=a0000000-0000-0000-0000-00000000000e    # employee sem cargo comercial: staff, sem acesso ao Radar
SIS=00000000-0000-0000-0000-00000000ad0f  # Radar · RFB (contato automático)
L1=11111111000101; L2=11111111000202; L3=11111111000303; L4=11111111000404; L9=11111111000909
P -q -v v1="$V1" -v v2="$V2" -v g="$G" -v m="$M" -v c="$C" -v x="$X" <<'SQL'
INSERT INTO public.user_roles (user_id, role) VALUES
  (:'v1','employee'), (:'v2','employee'), (:'g','employee'), (:'m','master'), (:'c','customer'), (:'x','employee');
INSERT INTO public.commercial_roles (user_id, commercial_role) VALUES (:'v1','farmer'), (:'v2','farmer'), (:'g','gerencial');
INSERT INTO public.profiles (user_id, name, email) VALUES
  (:'v1','Regina','regina@exemplo.com'), (:'v2','Tatyana','taty@exemplo.com'), (:'g','Gestor','g@exemplo.com');
INSERT INTO public.radar_empresas (cnpj, razao_social, score) VALUES
  ('11111111000101','L1',80), ('11111111000202','L2',75), ('11111111000303','L3',72), ('11111111000404','L4',71),
  ('11111111000909','L9',50);
SQL

for f in "$MIG_D" "$MIG_H"; do
  if ! P -q -f "$f" >> "$TMPD/apply.log" 2>&1; then cat "$TMPD/apply.log"; echo "APLICAÇÃO DE $(basename "$f") FALHOU"; exit 1; fi
done

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
  printf '%s\n' "$out" | sed -n 's/^[A-Z]\{4,5\}:  \([0-9A-Z]\{5\}\): \(.*\)$/\1 \2/p' | head -1
}
prefixo() { case "$2" in "$3"*) eq "$1" "ok" "ok" ;; *) eq "$1" "$2" "$3…" ;; esac; }
md5_de() { Pq -c "SELECT md5(prosrc) FROM pg_proc WHERE oid = to_regprocedure('$1')"; }

# ── A9 (antes do apply): o predecessor do fixture é o corpo de PROD (psql-ro, 2026-11-08) ─────────────────────
eq "A9a radar_funil do pacote H = o de PROD" "$(md5_de 'public.radar_funil(integer)')" "05a8d54a7f86de4a43c3f1f7414ae0d9"
eq "A9b radar_evento_contato do repo = o de PROD" "$(md5_de 'private.radar_evento_contato()')" "a2a62eada5b026bc5bf2c3a8cb83df3d"
eq "A9c radar_placar_uso do repo = o de PROD" "$(md5_de 'public.radar_placar_uso()')" "f648bcff995f7b4db87b2bd829831cbc"

# ── A8: PRE anti-deriva — corpo vivo que não é o predecessor revisado aborta o apply (nada fica aplicado) ──────
OUT_PRE="$(P -q 2>&1 <<SQL || true
BEGIN;
CREATE OR REPLACE FUNCTION public.radar_funil(p_semanas integer DEFAULT 8) RETURNS jsonb LANGUAGE plpgsql STABLE
  SECURITY DEFINER SET search_path = '' AS \$x\$ BEGIN RETURN '{}'::jsonb; END \$x\$;
\i $MIG_USADA
COMMIT;
SQL
)"
case "$OUT_PRE" in *"PRE FALHOU: public.radar_funil(integer) vivo"*) eq "A8a deriva no radar_funil aborta pela PRE" ok ok ;;
  *) eq "A8a deriva no radar_funil aborta pela PRE" "$(printf '%s' "$OUT_PRE" | grep -m1 -E 'ERRO|ERROR|FALHOU' || echo SEM_ERRO)" "PRE FALHOU…" ;; esac
eq "A8b o abort não deixou nada aplicado" "$(Pq -c "SELECT to_regclass('public.radar_card_exibicoes') IS NULL AND to_regprocedure('public.radar_placar_uso()') IS NOT NULL")" "t"

# ── Apply do pacote M (2×: idempotente) ─────────────────────────────────────────────────────────────────────
# Sabotagem de corpo aplica 1× (a régua md5 da PRE recusaria a 2ª, e o vermelho sairia fora do assert dela).
for i in $(seq 1 "$APLICAR_VEZES"); do
  if ! P -q -f "$MIG_USADA" > "$TMPD/apply-m$i.log" 2>&1; then cat "$TMPD/apply-m$i.log"; echo "APLICAÇÃO DO PACOTE M ($i) FALHOU"; exit 1; fi
  if [ -n "${IMPRIMIR_MD5:-}" ]; then grep "MD5 " "$TMPD/apply-m1.log"; exit 0; fi
  grep -q "POSTCONDICAO RADAR MEDICAO M OK" "$TMPD/apply-m$i.log" || [ "${SABOTAGEM:-}" = expurgo_aberto ] || {
    echo "APLICAÇÃO $i SEM O MARCADOR DA POSTCONDIÇÃO"; exit 1; }
done
eq "A0 apply idempotente ($APLICAR_VEZES×, marcador da postcondição em todas)" ok ok

# Cobertura sob controle da prova: os sensores declarados instalados há 60 dias; os sem declaração contam do 1º registro.
P -q -c "UPDATE public.radar_funil_sensores SET instalado_em = now() - interval '60 days' WHERE instalado_em IS NOT NULL"

funil() { # funil <campo da linha> <vendedor> — semana corrente, lido COMO o gestor
  como authenticated "$G" "SELECT COALESCE(l ->> '$1', 'NULL') FROM jsonb_array_elements(public.radar_funil(8) -> 'linhas') l
    WHERE l ->> 'vendedor_user_id' = '$2'
      AND (l ->> 'semana')::date = date_trunc('week', now() AT TIME ZONE 'America/Sao_Paulo')::date"
}
ado() { # ado <campo> <vendedor>
  como authenticated "$G" "SELECT COALESCE(a ->> '$1', 'NULL') FROM jsonb_array_elements(public.radar_funil(8) -> 'adocao' -> 'vendedores') a
    WHERE a ->> 'user_id' = '$2'"
}

# ── A1: o universo ─────────────────────────────────────────────────────────────────────────────────────────
eq "A1a o elegível SEM atividade aparece no painel" \
   "$(como authenticated "$G" "SELECT count(*) FROM jsonb_array_elements(public.radar_funil(8) -> 'vendedores') v WHERE v ->> 'user_id' = '$V2'")" "1"
eq "A1b staff sem cargo comercial e customer ficam fora" \
   "$(como authenticated "$G" "SELECT count(*) FROM jsonb_array_elements(public.radar_funil(8) -> 'vendedores') v WHERE v ->> 'user_id' IN ('$X', '$C')")" "0"
eq "A1c elegíveis agora = farmer×2 + gestor + master" "$(como authenticated "$G" "SELECT public.radar_funil(8) -> 'adocao' ->> 'elegiveis_agora'")" "4"
eq "A1d o sem atividade tem linha com ZERO explícito (sensor que cobre)" "$(funil contatos "$V2")" "0"
eq "A1e o sem atividade: elegível, não exposto, sem ação" "$(ado elegivel "$V2")|$(ado exposto_em "$V2")|$(ado dias_com_acao "$V2")" "true|NULL|0"

# ── A2: a reposição do card ────────────────────────────────────────────────────────────────────────────────
eq "A2a antes da 1ª exibição: exibidos AUSENTE (NULL), não 0" "$(funil card_leads_exibidos "$V1")" "NULL"
eq "A2b 1ª exibição grava os 3" "$(como authenticated "$V1" "SELECT public.radar_registrar_card_exibido(ARRAY['$L1','$L2','$L3']) ->> 'novos'")" "3"
eq "A2c repetir a mesma exibição é idempotente" "$(como authenticated "$V1" "SELECT public.radar_registrar_card_exibido(ARRAY['$L1','$L2','$L3']) ->> 'novos'")" "0"
eq "A2d a reposição (depois de Assumir) grava só o novo; CNPJ inexistente não entra" \
   "$(como authenticated "$V1" "SELECT public.radar_registrar_card_exibido(ARRAY['$L2','$L3','$L4','99999999999999']) ->> 'novos'")" "1"
como authenticated "$V1" "SELECT public.radar_registrar_abertura_empurrada('card', '$L1'), public.radar_registrar_abertura_empurrada('card', '$L4'),
                                 public.radar_registrar_abertura_empurrada('card', '$L9')" >/dev/null
eq "A2e exibidos = 4 (reposição incluída); servido do pacote D segue a 1ª quantidade" \
   "$(funil card_leads_exibidos "$V1")|$(funil card_leads_servidos "$V1")|$(funil card_dias "$V1")" "4|3|1"
eq "A2f clicados ⊂ exibidos: 2 (o clique em CNPJ não exibido fica fora); o clique cru segue 3" \
   "$(funil card_leads_clicados_exibidos "$V1")|$(funil card_leads_clicados "$V1")" "2|3"
prefixo "A2g array vazio recusa (22023)" "$(erro_como authenticated "$V1" "SELECT public.radar_registrar_card_exibido(ARRAY[]::text[])")" "22023 cnpjs fora de 1..20"
prefixo "A2h customer não grava (42501)" "$(erro_como authenticated "$C" "SELECT public.radar_registrar_card_exibido(ARRAY['$L1'])")" "42501 forbidden"
eq "A2i tabela nova fechada ao JWT" "$(Pq -c "SELECT has_table_privilege('authenticated', 'public.radar_card_exibicoes', 'SELECT')")" "f"

# ── A3: a intenção de contato ──────────────────────────────────────────────────────────────────────────────
eq "A3a intenção de ligar grava" "$(como authenticated "$V1" "SELECT public.radar_registrar_intencao('$L1', 'ligar') ->> 'registrado'")" "true"
eq "A3b a 2ª no mesmo dia e canal é idempotente" "$(como authenticated "$V1" "SELECT public.radar_registrar_intencao('$L1', 'ligar') ->> 'registrado'")" "false"
como authenticated "$V1" "SELECT public.radar_registrar_intencao('$L1', 'whatsapp')" >/dev/null
eq "A3c o painel conta 2 intenções (ligar + WhatsApp)" "$(funil intencoes "$V1")" "2"
prefixo "A3d customer não grava intenção (42501)" "$(erro_como authenticated "$C" "SELECT public.radar_registrar_intencao('$L1', 'ligar')")" "42501 forbidden"
prefixo "A3e canal inválido (22023)" "$(erro_como authenticated "$V1" "SELECT public.radar_registrar_intencao('$L1', 'sms')")" "22023 canal invalido"
eq "A3f CNPJ desconhecido não grava" "$(como authenticated "$V1" "SELECT public.radar_registrar_intencao('99999999999999', 'copiar') ->> 'motivo'")" "cnpj_desconhecido"
prefixo "A3g a forma da intenção é constraint do ledger (23514)" \
   "$(erro_como postgres "" "INSERT INTO public.radar_eventos (evento, origem, ocorrido_em, user_id, cnpj, acao, fonte_id)
                             VALUES ('intencao', 'humano', now(), '$V1', '$L1', 'sms', 'x:1')")" "23514"
eq "A3h o elegível sem intenção tem 0 (não NULL) depois da 1ª" "$(funil intencoes "$V2")" "0"

# ── A4: a adoção ───────────────────────────────────────────────────────────────────────────────────────────
P -q -c "INSERT INTO public.radar_eventos (evento, origem, ocorrido_em, user_id, cnpj, fonte_id) VALUES
           ('abriu', 'humano', now() - interval '1 day', '$V1', '$L2', 'outbox:ontem'),
           ('abriu', 'humano', now(), '$G', NULL, 'outbox:gestor-tela')" \
     -c "INSERT INTO public.radar_atendimentos (cnpj, dono_user_id, assumido_em, atribuido_por) VALUES ('$L3', '$V2', now(), '$G')"
eq "A4a quem agiu em 2 dias conta uso em OUTRO dia" "$(ado dias_com_acao "$V1")" "2"
eq "A4b quem agiu está exposto e tem 1ª ação" \
   "$(como authenticated "$G" "SELECT (a ->> 'exposto_em') IS NOT NULL AND (a ->> 'primeira_acao_em') IS NOT NULL
         FROM jsonb_array_elements(public.radar_funil(8) -> 'adocao' -> 'vendedores') a WHERE a ->> 'user_id' = '$V1'")" "t"
eq "A4c abrir a TELA expõe, mas não é ação" "$(como authenticated "$G" "SELECT (a ->> 'exposto_em') IS NOT NULL
         FROM jsonb_array_elements(public.radar_funil(8) -> 'adocao' -> 'vendedores') a WHERE a ->> 'user_id' = '$G'")|$(ado primeira_acao_em "$G")" "t|NULL"
eq "A4d lead ATRIBUÍDO pelo gestor não é ação do dono" "$(ado primeira_acao_em "$V2")" "NULL"

# ── A5: o contato automático não vira evento; o humano vira, com a nota ─────────────────────────────────────
P -q -c "INSERT INTO public.radar_contatos (cnpj, acao, criado_por) VALUES ('$L4', 'descartado', '$SIS'), ('$L3', 'em_conversa', '$V1')"
# Nenhum evento do UUID de sistema, com QUALQUER origem: sem o retorno antecipado o automático cairia no ramo humano.
eq "A5a contato automático: nenhum evento (nem rotulado humano)" "$(Pq -c "SELECT count(*) FROM public.radar_eventos WHERE user_id = '$SIS'")" "0"
eq "A5b contato humano: evento com a nota capturada" \
   "$(Pq -c "SELECT count(*) FROM public.radar_eventos WHERE evento = 'contato' AND origem = 'humano' AND nota_capturada AND score = 72")" "1"
P -q -c "DELETE FROM public.radar_contatos WHERE criado_por IN ('$SIS', '$V1')"
eq "A5c desfazer: só o humano vira contato_desfeito" \
   "$(Pq -c "SELECT string_agg(origem, ',') FROM public.radar_eventos WHERE evento = 'contato_desfeito'")" "humano"
eq "A5d radar_placar_uso não existe mais" "$(Pq -c "SELECT to_regprocedure('public.radar_placar_uso()') IS NULL")" "t"

# ── A6: o experimento com tela ─────────────────────────────────────────────────────────────────────────────
P -q -c "INSERT INTO public.radar_coorte_controle VALUES ('coorte-x', 'topo', '$L1', 'x', 1, 80, 'v1', now() - interval '1 hour')" \
     -c "INSERT INTO public.radar_contatos (cnpj, acao, criado_por) VALUES ('$L1', 'contatado_sem_resposta', '$V1')"
prefixo "A6a farmer não lê o experimento (42501)" "$(erro_como authenticated "$V1" "SELECT public.radar_funil_experimento()")" "42501 forbidden: experimento"
eq "A6b gestor lê: a coorte com o toque depois do sorteio" \
   "$(como authenticated "$G" "SELECT c ->> 'sorteados' || '/' || (c ->> 'tocados') FROM jsonb_array_elements(public.radar_funil_experimento() -> 'coortes') c")" "1/1"
eq "A6c as 4 faixas de nota vêm (mesmo vazias)" "$(como authenticated "$G" "SELECT jsonb_array_length(public.radar_funil_experimento() -> 'faixas')")" "4"
eq "A6d anon não executa o experimento" "$(Pq -c "SELECT has_function_privilege('anon', 'public.radar_funil_experimento()', 'EXECUTE')")" "f"

# ── A7: retenção ───────────────────────────────────────────────────────────────────────────────────────────
P -q <<SQL
INSERT INTO public.radar_eventos (evento, origem, ocorrido_em, user_id, cnpj, contato_id, acao, fonte_id)
SELECT 'contato', 'automatica', now() - interval '20 days', '$SIS', '$L4', gen_random_uuid(), 'descartado', 'auto:' || g
  FROM generate_series(1, 5) g;
INSERT INTO public.radar_eventos (evento, origem, ocorrido_em, user_id, cnpj, acao, fonte_id) VALUES
  ('contato', 'humano', now() - interval '500 days', '$V1', '$L2', 'em_conversa', 'contato:velho'),
  ('abriu',   'humano', now() - interval '401 days', '$V1', NULL, NULL, 'outbox:velho'),
  ('abriu',   'humano', now() - interval '399 days', '$V1', NULL, NULL, 'outbox:quase');
INSERT INTO public.radar_lead_aberturas (origem, cnpj, user_id, do_destinatario, dia) VALUES
  ('card', '$L1', '$V2', true, (now() AT TIME ZONE 'America/Sao_Paulo')::date - 401),
  ('card', '$L1', '$V2', true, (now() AT TIME ZONE 'America/Sao_Paulo')::date - 399);
INSERT INTO public.radar_sensor_falhas (sensor, motivo, user_id, dia) VALUES
  ('card_servido', 'velha', '$V1', (now() AT TIME ZONE 'America/Sao_Paulo')::date - 181),
  ('card_servido', 'nova',  '$V1', (now() AT TIME ZONE 'America/Sao_Paulo')::date - 179);
SQL
eq "A7a o expurgo apaga os automáticos em LOTE" "$(Pq -c "SELECT private.radar_expurgar_medicao(2) ->> 'eventos_automaticos'")" "2"
eq "A7b sobram 3 automáticos para a próxima rodada" "$(Pq -c "SELECT count(*) FROM public.radar_eventos WHERE origem = 'automatica'")" "3"
eq "A7c abriu humano: > 400 dias sai, < 400 fica" \
   "$(Pq -c "SELECT string_agg(fonte_id, ',' ORDER BY fonte_id) FROM public.radar_eventos WHERE fonte_id IN ('outbox:velho', 'outbox:quase')")" "outbox:quase"
eq "A7d contato humano antigo NUNCA sai" "$(Pq -c "SELECT count(*) FROM public.radar_eventos WHERE fonte_id = 'contato:velho'")" "1"
eq "A7e aberturas: > 400 dias sai" "$(Pq -c "SELECT count(*) FROM public.radar_lead_aberturas WHERE user_id = '$V2'")" "1"
eq "A7f falhas de sensor: > 180 dias sai" "$(Pq -c "SELECT string_agg(motivo, ',') FROM public.radar_sensor_falhas WHERE user_id = '$V1'")" "nova"
prefixo "A7g o JWT não executa o expurgo (42501)" "$(erro_como authenticated "$V1" "SELECT private.radar_expurgar_medicao()")" "42501"
eq "A7h cron diário agendado" "$(Pq -c "SELECT schedule || ' ' || command FROM cron.job WHERE jobname = 'radar-expurgo-medicao-diario' AND active")" \
   "20 7 * * * SELECT private.radar_expurgar_medicao()"

echo "PASS=$PASS FAIL=$FAIL"
[ "$FAIL" -eq 0 ]
