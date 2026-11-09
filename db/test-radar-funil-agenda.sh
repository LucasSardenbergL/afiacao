#!/usr/bin/env bash
# Prova PG17 da agenda "Hoje" (pacote L) na adoção do funil — migration 20261111170500_radar_funil_agenda, aplicada
# por cima das REAIS do pacote D, H e M (o fixture é o de db/test-radar-medicao.sh, + radar_agenda_uso na forma do L):
#   • 'vista' da agenda EXPÕE (exposto_em) sem contar como ação; 'aberta' é AÇÃO humana (1ª ação, dias com ação).
#   • quem só usou a agenda entra no universo do período (mesmo sem acesso hoje), marcado não-elegível.
#   • o expurgo apaga radar_agenda_uso com mais de 400 dias e mantém o resto; o JWT segue sem executar o expurgo.
#   • o painel do pacote M segue igual (universo de elegíveis, exibições do card).
#   • PRE anti-deriva: corpo vivo do funil que não é o do pacote M nem este aborta o apply.
#
#   bash db/test-radar-funil-agenda.sh > /tmp/t.log 2>&1; echo "exit=$?"
#   SABOTAGEM=<nome> bash db/test-radar-funil-agenda.sh   # tem de ficar VERMELHA
#   bash db/test-radar-funil-agenda.sh --falsificar        # controle verde + cada sabotagem vermelha no assert dela
#   IMPRIMIR_MD5=1 bash db/test-radar-funil-agenda.sh      # imprime o md5(prosrc) das funções deste arquivo
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MIG_EV="$REPO_ROOT/supabase/migrations/20261029150100_radar_eventos_placar.sql"
MIG_EV2="$REPO_ROOT/supabase/migrations/20261106132259_radar_abriu_ficha_com_cnpj.sql"   # recria o placar
MIG_D="$REPO_ROOT/supabase/migrations/20261106181000_radar_leads_ao_vendedor.sql"
MIG_H="$REPO_ROOT/supabase/migrations/20261107233000_radar_funil_painel.sql"
MIG_M="$REPO_ROOT/supabase/migrations/20261111134500_radar_medicao_pacote_m.sql"
MIG="$REPO_ROOT/supabase/migrations/20261111170500_radar_funil_agenda.sql"

if [ "${1:-}" = "--falsificar" ]; then
  SABOTAGENS="vista_nao_expoe:B2a vista_vira_acao:B2b aberta_nao_age:B3a agenda_fora_do_universo:B4a expurgo_sem_agenda:B5a pre_cega:B6a"
  LOGDIR="$(mktemp -d "${TMPDIR:-/tmp}/falsifica-radar-funil-agenda.XXXXXX")"
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
    if grep -q -- "FAIL $a " "$LOGDIR/$s.log"; then
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
PORT="${PGPORT_TEST:-5496}"
DATA="$(mktemp -d "${TMPDIR:-/tmp}/pgtest-radar-funil-agenda.XXXXXX")/data"
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
# Sabotagem de corpo muda o md5: a PÓS P1 vira aviso (o resto da PÓS segue valendo) e o apply é 1× só.
APLICAR_VEZES=2
pos_md5_aviso() { APLICAR_VEZES=1; sabotar "      RAISE EXCEPTION 'G1 FALHOU: % vivo (md5 %) não é este', r.alvo, r.vivo;" \
                                           "      RAISE NOTICE 'MD5 % %', r.alvo, r.vivo;"; }
case "${SABOTAGEM:-}" in
  "") ;;
  vista_nao_expoe)  sabotar "    UNION ALL SELECT g.user_id, g.criado_em FROM public.radar_agenda_uso g WHERE g.evento = 'vista' AND g.dia >= v_ini
" ""; pos_md5_aviso ;;
  vista_vira_acao)  sabotar "WHERE g.evento = 'aberta' AND g.dia >= v_ini" "WHERE g.dia >= v_ini"; pos_md5_aviso ;;
  aberta_nao_age)   sabotar "    UNION ALL SELECT g.user_id, g.criado_em FROM public.radar_agenda_uso g WHERE g.evento = 'aberta' AND g.dia >= v_ini
" ""; pos_md5_aviso ;;
  agenda_fora_do_universo) sabotar "    UNION SELECT g.user_id FROM public.radar_agenda_uso g WHERE g.dia >= v_ini
" ""; pos_md5_aviso ;;
  expurgo_sem_agenda) sabotar "  DELETE FROM public.radar_agenda_uso g WHERE g.dia < v_hoje - 400;" "  PERFORM 1;"; pos_md5_aviso ;;
  pre_cega)         sabotar "    ELSIF r.vivo IS DISTINCT FROM r.predecessor AND r.vivo IS DISTINCT FROM r.este THEN" "    ELSIF false THEN" ;;
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
-- Uso da agenda "Hoje" na forma do pacote L (20261111134000).
CREATE TABLE public.radar_agenda_uso (
  id bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY, user_id uuid NOT NULL, dia date NOT NULL,
  evento text NOT NULL CHECK (evento IN ('vista', 'aberta')),
  cnpj text NOT NULL DEFAULT '' CHECK ((evento = 'vista') = (cnpj = '')),
  n_retornos integer CHECK (n_retornos >= 0), n_posses integer CHECK (n_posses >= 0),
  criado_em timestamptz NOT NULL DEFAULT now(), UNIQUE (user_id, dia, evento, cnpj));
ALTER TABLE public.radar_agenda_uso ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.radar_agenda_uso FROM PUBLIC, anon, authenticated;
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

for f in "$MIG_D" "$MIG_H" "$MIG_M"; do
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
X_SO_AGENDA=a0000000-0000-0000-0000-0000000000aa   # sem acesso hoje, com uso de agenda no período
hoje="(now() AT TIME ZONE 'America/Sao_Paulo')::date"

# ── B1 (antes do apply): o predecessor do fixture é o corpo de PROD do pacote M (psql-ro, 2026-11-09) ─────────
eq "B1a radar_funil do pacote M = o de PROD" "$(md5_de 'public.radar_funil(integer)')" "fb09ceea1ad40a78dc471b3a5e4ec95d"
eq "B1b expurgo do pacote M = o de PROD" "$(md5_de 'private.radar_expurgar_medicao(integer)')" "398268b3a365066ea7c99964dc9530ea"

# ── B6: PRE anti-deriva ────────────────────────────────────────────────────────────────────────────────────
OUT_PRE="$(P -q 2>&1 <<SQL || true
BEGIN;
CREATE OR REPLACE FUNCTION public.radar_funil(p_semanas integer DEFAULT 8) RETURNS jsonb LANGUAGE plpgsql STABLE
  SECURITY DEFINER SET search_path = '' AS \$x\$ BEGIN RETURN '{}'::jsonb; END \$x\$;
\i $MIG_USADA
COMMIT;
SQL
)"
case "$OUT_PRE" in *"PRE FALHOU: public.radar_funil(integer) vivo"*) eq "B6a deriva no radar_funil aborta pela PRE" ok ok ;;
  *) eq "B6a deriva no radar_funil aborta pela PRE" "$(printf '%s' "$OUT_PRE" | grep -m1 -E 'ERRO|ERROR|FALHOU' || echo SEM_ERRO)" "PRE FALHOU…" ;; esac
eq "B6b o abort não deixou nada aplicado" "$(md5_de 'public.radar_funil(integer)')" "fb09ceea1ad40a78dc471b3a5e4ec95d"

# ── Apply (2×: idempotente) ─────────────────────────────────────────────────────────────────────────────────
for i in $(seq 1 "$APLICAR_VEZES"); do
  if ! P -q -f "$MIG_USADA" > "$TMPD/apply-ag$i.log" 2>&1; then cat "$TMPD/apply-ag$i.log"; echo "APLICAÇÃO DA AGENDA ($i) FALHOU"; exit 1; fi
  if [ -n "${IMPRIMIR_MD5:-}" ]; then grep "MD5 " "$TMPD/apply-ag1.log"; exit 0; fi
  grep -q "POSTCONDICAO RADAR FUNIL AGENDA OK" "$TMPD/apply-ag$i.log" || { echo "APLICAÇÃO $i SEM O MARCADOR DA POSTCONDIÇÃO"; exit 1; }
done
eq "B0 apply idempotente (${APLICAR_VEZES}×, marcador da postcondição em todas)" ok ok
P -q -c "UPDATE public.radar_funil_sensores SET instalado_em = now() - interval '60 days' WHERE instalado_em IS NOT NULL"

ado() { # ado <campo> <vendedor>
  como authenticated "$G" "SELECT COALESCE(a ->> '$1', 'NULL') FROM jsonb_array_elements(public.radar_funil(8) -> 'adocao' -> 'vendedores') a
    WHERE a ->> 'user_id' = '$2'"
}

# ── B7: o painel do pacote M segue igual ───────────────────────────────────────────────────────────────────
eq "B7a elegíveis agora = farmer×2 + gestor + master" "$(como authenticated "$G" "SELECT public.radar_funil(8) -> 'adocao' ->> 'elegiveis_agora'")" "4"
eq "B7b o card segue gravando exibições" "$(como authenticated "$V1" "SELECT public.radar_registrar_card_exibido(ARRAY['$L1','$L2']) ->> 'novos'")" "2"
eq "B7c o elegível sem atividade: não exposto, sem ação" "$(ado exposto_em "$V2")|$(ado primeira_acao_em "$V2")" "NULL|NULL"

# ── B2/B3: a agenda na adoção ──────────────────────────────────────────────────────────────────────────────
P -q -c "INSERT INTO public.radar_agenda_uso (user_id, dia, evento, cnpj, n_retornos, n_posses) VALUES ('$V2', $hoje, 'vista', '', 1, 0)"
eq "B2a agenda VISTA expõe o vendedor" "$(como authenticated "$G" "SELECT (a ->> 'exposto_em') IS NOT NULL
     FROM jsonb_array_elements(public.radar_funil(8) -> 'adocao' -> 'vendedores') a WHERE a ->> 'user_id' = '$V2'")" "t"
eq "B2b agenda VISTA não é ação" "$(ado primeira_acao_em "$V2")|$(ado dias_com_acao "$V2")" "NULL|0"
P -q -c "INSERT INTO public.radar_agenda_uso (user_id, dia, evento, cnpj, criado_em) VALUES
           ('$V2', $hoje, 'aberta', '$L3', now()), ('$V2', $hoje - 1, 'aberta', '$L4', now() - interval '1 day')"
eq "B3a agenda ABERTA é ação humana (em 2 dias = uso em outro dia)" "$(ado dias_com_acao "$V2")|$(ado acoes "$V2")" "2|2"

# ── B4: quem só usou a agenda entra no universo, marcado não-elegível ──────────────────────────────────────
P -q -c "INSERT INTO public.radar_agenda_uso (user_id, dia, evento, cnpj) VALUES ('$X_SO_AGENDA', $hoje, 'aberta', '$L1')"
eq "B4a quem só usou a agenda aparece no painel" \
   "$(como authenticated "$G" "SELECT count(*) FROM jsonb_array_elements(public.radar_funil(8) -> 'vendedores') v WHERE v ->> 'user_id' = '$X_SO_AGENDA'")" "1"
eq "B4b ... como NÃO elegível (fora do denominador)" "$(ado elegivel "$X_SO_AGENDA")" "false"
eq "B4c elegíveis agora não mudou" "$(como authenticated "$G" "SELECT public.radar_funil(8) -> 'adocao' ->> 'elegiveis_agora'")" "4"

# ── B5: retenção ───────────────────────────────────────────────────────────────────────────────────────────
P -q -c "INSERT INTO public.radar_agenda_uso (user_id, dia, evento, cnpj) VALUES
           ('$V1', $hoje - 401, 'aberta', '$L1'), ('$V1', $hoje - 399, 'aberta', '$L1')"
REL_EXP="$(Pq -c "SELECT private.radar_expurgar_medicao() ->> 'agenda'")"
# O ESTADO decide (o número devolvido sozinho passa com um ROW_COUNT de outro comando).
eq "B5a o expurgo apaga a agenda com mais de 400 dias" "$(Pq -c "SELECT count(*) FROM public.radar_agenda_uso WHERE user_id = '$V1' AND dia < $hoje - 400")" "0"
eq "B5b ... mantém a de menos de 400 e devolve a contagem" "$(Pq -c "SELECT count(*) FROM public.radar_agenda_uso WHERE user_id = '$V1'")|$REL_EXP" "1|1"
prefixo "B5c o JWT segue sem executar o expurgo (42501)" "$(erro_como authenticated "$V1" "SELECT private.radar_expurgar_medicao()")" "42501"
eq "B5d anon segue sem executar o funil" "$(Pq -c "SELECT has_function_privilege('anon', 'public.radar_funil(integer)', 'EXECUTE')")" "f"

echo "PASS=$PASS FAIL=$FAIL"
[ "$FAIL" -eq 0 ]
