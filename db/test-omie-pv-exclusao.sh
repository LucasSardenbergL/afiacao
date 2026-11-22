#!/usr/bin/env bash
# ╔═════════════════════════════════════════════════════════════════
# ║  PROVA PG17 — 20261121230000_omie_pv_exclusao_reconciliar.sql (baixa automática de PV excluído no Omie)
# ║      bash db/test-omie-pv-exclusao.sh > /tmp/t.log 2>&1; echo "exit=$?"
# ║      bash db/test-omie-pv-exclusao.sh --falsificar > /tmp/f.log 2>&1; echo "exit=$?"
# ║      HARNESS_LOCALE=pt_BR.UTF-8 bash db/test-omie-pv-exclusao.sh   (2º idioma)
# ║  (NÃO pipe pra tail — engole o exit≠0.)
# ║
# ║   I  execução: identidade fixada, credencial de outra conta, cadência de 50 min, orçamento de listagem.
# ║   T  triagem: suspeito, contradição terminal, disjuntor, identidade não confirmada, cursor.
# ║   C  confirmação: 1 ausência não baixa; 2ª cedo demais não conta; presença (triagem/consulta/sync) zera;
# ║      1/h; teto de erros 24h; idempotência; linha virou faturado entre as ausências.
# ║   B  baixa: linhas ocultas (status preservado), reserva pelo par próprio + trilha + impacto, divergência,
# ║      teto por PV, teto de PVs/24h serializado por conta.
# ║   D  durabilidade: rollback do front, importação tardia, PID atribuído depois.
# ║   S  concorrência (2 sessões): sync relendo o PV durante a baixa; rollback do front durante a baixa.
# ║   A  ACL/RLS + histórico.
# ║  Diário: docs/historico/pv-excluido-omie-baixa-automatica.md
# ╚═════════════════════════════════════════════════════════════════
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
export PGVER=17   # consumido pelo db/lib/pg-harness.sh via source
PORT="${PGPORT_TEST:-5791}"
SLUG="omie-pv-exclusao"
LOC="${HARNESS_LOCALE:-C}"
export LC_ALL=C LANG=C          # o CLIENTE fica em C; o idioma do SERVIDOR vem de $LOC
MIG_REAL="$REPO_ROOT/supabase/migrations/20261121230000_omie_pv_exclusao_reconciliar.sql"
MIG_COTA="$REPO_ROOT/supabase/migrations/20261010204708_omie_cota_metodo.sql"
[ -f "$MIG_REAL" ] || { echo "INFRA: ausente: $MIG_REAL"; exit 1; }
[ -f "$MIG_COTA" ] || { echo "INFRA: ausente: $MIG_COTA"; exit 1; }

# ══════════════════════════════════════════════════════════════════
# MODO --falsificar — controle VERDE primeiro na MESMA invocação (vermelho aborta antes de sabotar), e
# cada sabotagem só conta se (1) aplicou, (2) a suíte rodou INTEIRA, (3) o assert declarado estava verde
# no controle e virou vermelho, (4) sem ERRO de SQL que o controle não tem. Uma camada por vez.
# ══════════════════════════════════════════════════════════════════
if [ "${1:-}" = "--falsificar" ]; then
  SABOTAGENS="uma_ausencia_basta:C1 sem_intervalo:C3 presenca_nao_zera:C4 sem_omie_relido:C6 sem_vez_1h:C7
              sem_teto_erros:C8 sem_terminal_na_baixa:C11 sem_duravel:D1,D2 divergencia_um_sentido:B5
              sem_teto_pvs:B7 sem_identidade:C0 sem_lock_linhas:S1 sem_releitura_ids:S3 atribuicao_so_visivel:D5
              isencao_por_uuid:D7 sem_reinicio_execucao:C12"
  LOGDIR="$(mktemp -d "/tmp/falsifica-${SLUG}.XXXXXX")"
  porta=$PORT
  executados() { sed -n 's/^PASS=\([0-9][0-9]*\)  FAIL=\([0-9][0-9]*\)$/\1 \2/p' "$1" | awk '{ print $1 + $2 }'; }

  echo "══ CONTROLE (migration real, sem sabotagem) — tem de ficar VERDE ══"
  if PGPORT_TEST=$porta SABOTAGEM="" bash "$0" > "$LOGDIR/controle.log" 2>&1; then
    asserts_controle="$(executados "$LOGDIR/controle.log")"
    erros_controle="$(grep -c 'ERROR:  ' "$LOGDIR/controle.log" || true)"
    echo "  ✅ controle VERDE (${asserts_controle:-?} asserts) — a suíte sabe passar"
  else
    echo "  ❌ CONTROLE VERMELHO — abortando ANTES de sabotar."
    tail -25 "$LOGDIR/controle.log"; exit 1
  fi
  case "$asserts_controle" in
    ''|0|*[!0-9]*) echo "  ❌ controle verde SEM recibo PASS/FAIL legível [$asserts_controle] — abortando."; exit 1 ;;
  esac

  falhas=0
  for item in $SABOTAGENS; do
    sab="${item%%:*}"; exigidos="${item#*:}"
    porta=$((porta+1)); log="$LOGDIR/$sab.log"
    if PGPORT_TEST=$porta SABOTAGEM="$sab" bash "$0" > "$log" 2>&1; then
      echo "  ❌ $sab — suíte ficou VERDE com a sabotagem ativa: o assert NÃO tem dente"
      falhas=$((falhas+1)); continue
    fi
    vermelhos="$(grep -Eo '^  ❌ [A-Z][0-9]+b? ' "$log" | grep -Eo '[A-Z][0-9]+b?' | tr '\n' ' ' || true)"
    erros_sql="$(grep -c 'ERROR:  ' "$log" || true)"
    faltam=""
    for exigido in ${exigidos//,/ }; do
      if ! grep -Eq "^  ✅ ($exigido) " "$LOGDIR/controle.log" || ! grep -Eq "^  ❌ ($exigido) " "$log"; then
        faltam="$faltam $exigido"
      fi
    done
    if ! grep -q 'SABOTAGEM ATIVA em ' "$log"; then
      echo "  ❌ $sab — vermelha SEM a sabotagem aplicada (padrão derivou?)"
      { grep -m3 -E 'SABOTAGEM|padrão ocorre|ERROR' "$log" || true; } | sed 's/^/       /'
      falhas=$((falhas+1))
    elif [ "$(executados "$log")" != "$asserts_controle" ]; then
      echo "  ❌ $sab — a suíte NÃO rodou inteira ($(executados "$log") de $asserts_controle asserts): vermelho de aborto"
      tail -3 "$log" | sed 's/^/       /'
      falhas=$((falhas+1))
    elif [ "$erros_sql" != "$erros_controle" ]; then
      echo "  ❌ $sab — vermelha com ERRO de SQL ($erros_sql linha(s) ERROR, controle $erros_controle): não é julgamento"
      { grep -m2 'ERROR:  ' "$log" || true; } | sed 's/^/       /'
      falhas=$((falhas+1))
    elif [ -n "$faltam" ]; then
      echo "  ❌ $sab — vermelha, mas o assert declarado não virou:$faltam · vermelhos: ${vermelhos:-nenhum}"
      falhas=$((falhas+1))
    else
      echo "  ✅ $sab — vermelha no assert certo ($exigidos) · vermelhos: $vermelhos"
    fi
  done

  total="$(wc -w <<<"$SABOTAGENS" | tr -d ' ')"
  echo "SABOTAGENS: $((total - falhas)) vermelhas / $falhas falhas"
  if [ "$falhas" -eq 0 ]; then
    echo "═══ falsificação OK: controle verde + $total sabotagens vermelhas no assert declarado ═══"
    rm -rf "$LOGDIR"; exit 0
  fi
  echo "═══ falsificação REPROVOU: $falhas sabotagem(ns) sem o vermelho certo (logs em $LOGDIR) ═══"
  exit 1
fi

# ══════════════════════════════════════════════════════════════════
# SETUP
# ══════════════════════════════════════════════════════════════════
# shellcheck disable=SC1091  # o gate roda sem -x; o helper é versionado ao lado, em db/lib/
. "$REPO_ROOT/db/lib/pg-harness.sh"
TMP="$(mktemp -d "${TMPDIR:-/tmp}/pgtest-${SLUG}.XXXXXX")"
SOCK="$(mktemp -d /tmp/pgs.XXXXXX)"   # socket curto: o limite do Unix-domain socket é 103 bytes
DATA="$TMP/data"
cleanup() { "$PGBIN/pg_ctl" -D "$DATA" stop -m immediate >/dev/null 2>&1 || true; rm -rf "$TMP" "$SOCK"; }
trap cleanup EXIT

"$PGBIN/initdb" -D "$DATA" -U postgres -E UTF8 --locale="$LOC" >/dev/null 2>&1
"$PGBIN/pg_ctl" -D "$DATA" -o "-p $PORT -k $SOCK -c lc_messages=$LOC -c fsync=off -c full_page_writes=off -c synchronous_commit=off" \
  -l "$TMP/pg.log" -w start >/dev/null
"$PGBIN/createdb" -p "$PORT" -h "$SOCK" -U postgres prove
"$PGBIN/psql" -X -p "$PORT" -h "$SOCK" -U postgres -d postgres -q -c "ALTER DATABASE prove SET TimeZone='UTC';" >/dev/null
P()  { "$PGBIN/psql" -X -p "$PORT" -h "$SOCK" -U postgres -d prove -v ON_ERROR_STOP=1 "$@"; }
Pq() { P -tA -q -v VERBOSITY=verbose "$@"; }

PASS=0; FAIL=0
ok()  { PASS=$((PASS+1)); echo "  ✅ $1"; }
bad() { FAIL=$((FAIL+1)); echo "  ❌ $1"; }
eq()  { if [ "$2" = "$3" ]; then ok "$1 (=$2)"; else bad "$1 — esperado [$3], veio [$2]"; fi; }
trocar() {  # $1 arquivo, $2 de, $3 para — o padrão tem de ocorrer exatamente 1×
  python3 -I - "$1" "$2" "$3" <<'PYSAB'
import sys
p, de, para = sys.argv[1], sys.argv[2], sys.argv[3]
s = open(p, encoding='utf-8').read()
n = s.count(de)
if n != 1:
    print(f"   padrão ocorre {n}x, esperado 1: {de[:70]!r}", file=sys.stderr)
    sys.exit(1)
open(p, 'w', encoding='utf-8').write(s.replace(de, para))
PYSAB
}

# ── Sabotagem (no modo normal, SABOTAGEM vazia = a migration real) ──
MIG="$TMP/migration.sql"
cp "$MIG_REAL" "$MIG"
SAB="${SABOTAGEM:-}"
case "$SAB" in
  "") ;;
  uma_ausencia_basta)
    trocar "$MIG" "      v_efeito := jsonb_build_object('efeito', 'ausencia', 'sequencia', 1);" \
      "      v_efeito := private.omie_pv_aplicar_baixa(v_l.account, v_l.omie_pedido_id, ARRAY[v_l.id]);"
    trocar "$MIG" "    aplicado_em IS NULL OR (prova IS NOT NULL AND (ausencias_afirmadas >= 2 OR prova ? 'origem_historica')))" \
      "    true)" ;;
  sem_intervalo)
    trocar "$MIG" "    ELSIF v_t < v_c.ultima_ausencia_registrada_em + interval '1 hour' THEN" "    ELSIF false THEN" ;;
  presenca_nao_zera)
    trocar "$MIG" "         ausencias_afirmadas = CASE WHEN c.aplicado_em IS NULL THEN 0 ELSE c.ausencias_afirmadas END,
         primeira_ausencia_afirmada_em = CASE WHEN c.aplicado_em IS NULL THEN NULL ELSE c.primeira_ausencia_afirmada_em END,
         ultima_ausencia_afirmada_em = CASE WHEN c.aplicado_em IS NULL THEN NULL ELSE c.ultima_ausencia_afirmada_em END,
         ultima_ausencia_registrada_em = CASE WHEN c.aplicado_em IS NULL THEN NULL ELSE c.ultima_ausencia_registrada_em END,
         primeira_ausencia_log_id = CASE WHEN c.aplicado_em IS NULL THEN NULL ELSE c.primeira_ausencia_log_id END," ""
    trocar "$MIG" "    SELECT GREATEST(v_c.ultima_presenca_em, max(so.omie_reconciliado_em)) INTO v_pres" \
      "    SELECT max(so.omie_reconciliado_em) INTO v_pres" ;;
  sem_omie_relido)
    trocar "$MIG" "    SELECT GREATEST(v_c.ultima_presenca_em, max(so.omie_reconciliado_em)) INTO v_pres" \
      "    SELECT GREATEST(v_c.ultima_presenca_em, NULL::timestamptz) INTO v_pres"
    trocar "$MIG" "  IF v_pres IS NOT NULL AND v_pres >= v_c.primeira_ausencia_afirmada_em THEN
    UPDATE" "  IF false THEN
    UPDATE" ;;
  sem_vez_1h)
    trocar "$MIG" "              WHERE l.account = v.account AND l.reservada_em > now() - interval '60 minutes'" \
      "              WHERE l.account = v.account AND l.reservada_em > now() - interval '0 minutes'" ;;
  sem_teto_erros)
    trocar "$MIG" "         AND l.resultado IS DISTINCT FROM 'existe' AND l.resultado IS DISTINCT FROM 'nao_enviada') >= 4 THEN" \
      "         AND l.resultado IS DISTINCT FROM 'existe' AND l.resultado IS DISTINCT FROM 'nao_enviada') >= 999 THEN" ;;
  sem_terminal_na_baixa)
    trocar "$MIG" "  IF EXISTS (SELECT 1 FROM public.sales_orders so WHERE so.id = ANY (COALESCE(v_ids, '{}'::uuid[]))
                AND so.status IN ('faturado', 'cancelado')) THEN" "  IF false THEN" ;;
  sem_duravel)
    trocar "$MIG" "  EXECUTE FUNCTION public.sales_orders_pv_excluido_omie_duravel();" \
      "  EXECUTE FUNCTION public.sales_orders_pv_excluido_omie_duravel();
ALTER TABLE public.sales_orders DISABLE TRIGGER trg_sales_orders_pv_excluido_omie;"
    trocar "$MIG" "                  AND tgrelid = 'public.sales_orders'::regclass AND tgenabled <> 'D') THEN" \
      "                  AND tgrelid = 'public.sales_orders'::regclass) THEN" ;;
  divergencia_um_sentido)
    trocar "$MIG" "                        OR (r.sales_order_id IS NOT NULL AND NOT (r.sales_order_id = ANY (COALESCE(v_ids, '{}'::uuid[])))))) THEN" \
      "                        OR false)) THEN" ;;
  sem_teto_pvs)
    trocar "$MIG" "  v_max_pvs   integer := CASE p_account WHEN 'oben' THEN 2 ELSE 2 END;" "  v_max_pvs   integer := 99;" ;;
  sem_identidade)
    trocar "$MIG" "  IF NOT v.identidade_confirmada THEN
    RETURN QUERY SELECT NULL::bigint, NULL::bigint, 'identidade_nao_confirmada'::text; RETURN;" "  IF false THEN
    RETURN QUERY SELECT NULL::bigint, NULL::bigint, 'identidade_nao_confirmada'::text; RETURN;" ;;
  sem_lock_linhas)
    trocar "$MIG" "  PERFORM 1 FROM public.sales_orders so WHERE so.id = ANY (COALESCE(v_ids, '{}'::uuid[])) ORDER BY so.id FOR UPDATE;" "" ;;
  sem_releitura_ids)
    trocar "$MIG" "  IF v_ids2 IS DISTINCT FROM v_ids THEN" "  IF false THEN" ;;
  atribuicao_so_visivel)
    trocar "$MIG" "  FOR EACH ROW WHEN (NEW.omie_pedido_id IS NOT NULL)" "  FOR EACH ROW WHEN (NEW.omie_pedido_id IS NOT NULL AND NEW.deleted_at IS NULL)" ;;
  isencao_por_uuid)
    trocar "$MIG" "              WHERE i.sales_order_id = NEW.id AND i.account = NEW.account AND i.omie_pedido_id = NEW.omie_pedido_id) THEN" \
      "              WHERE i.sales_order_id = NEW.id) THEN" ;;
  sem_reinicio_execucao)
    trocar "$MIG" "                     AND e.triagem_ok IS NOT TRUE) THEN" "                     AND false) THEN" ;;
  *) echo "INFRA: sabotagem desconhecida: $SAB"; exit 1 ;;
esac
if [ -n "$SAB" ]; then
  if cmp -s "$MIG" "$MIG_REAL"; then echo "INFRA: sabotagem $SAB inerte"; exit 1; fi
  echo "SABOTAGEM ATIVA em $SAB"
fi

# ── Banco: papéis do Supabase + o recorte das tabelas que a migration toca ──
P -q <<'SQL' >/dev/null
DO $r$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='anon') THEN CREATE ROLE anon NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN CREATE ROLE authenticated NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN CREATE ROLE service_role NOLOGIN BYPASSRLS; END IF;
END $r$;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO anon, authenticated, service_role;
CREATE SCHEMA auth;
CREATE SCHEMA private;
CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $f$ SELECT NULLIF(current_setting('request.jwt.claim.sub', true), '')::uuid $f$;
GRANT USAGE ON SCHEMA auth TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION auth.uid() TO anon, authenticated, service_role;
CREATE TYPE public.app_role AS ENUM ('employee', 'customer', 'master');
CREATE TABLE public.user_roles (user_id uuid, role public.app_role);
CREATE FUNCTION public.has_role(_user_id uuid, _role public.app_role) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = public AS $f$ SELECT EXISTS (SELECT 1 FROM public.user_roles WHERE user_id = _user_id AND role = _role) $f$;
INSERT INTO public.user_roles VALUES ('00000000-0000-0000-0000-0000000000bb', 'employee');
-- cron: o recorte que a migration usa (pg_cron 1.6: schedule por nome faz upsert)
CREATE SCHEMA cron;
CREATE TABLE cron.job (jobid bigserial PRIMARY KEY, jobname text UNIQUE, schedule text, command text,
                       active boolean NOT NULL DEFAULT true, username text NOT NULL DEFAULT current_user);
CREATE FUNCTION cron.schedule(p_nome text, p_sched text, p_cmd text) RETURNS bigint LANGUAGE sql AS $f$
  INSERT INTO cron.job (jobname, schedule, command) VALUES (p_nome, p_sched, p_cmd)
  ON CONFLICT (jobname) DO UPDATE SET schedule = EXCLUDED.schedule, command = EXCLUDED.command RETURNING jobid $f$;
CREATE TABLE public.sales_orders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), account text NOT NULL, status text NOT NULL, total numeric,
  omie_pedido_id bigint, hash_payload text, order_date_kpi date, deleted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now() - interval '3 days', gemeo_importado_id uuid, envio_omie_reivindicado_em timestamptz,
  omie_reconciliado_em timestamptz);
CREATE TABLE public.estoque_reservas (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), pool text NOT NULL CHECK (pool = 'oben'), omie_codigo_produto bigint NOT NULL,
  quantidade numeric NOT NULL CHECK (quantidade > 0), checkout_id uuid NOT NULL, sales_order_id uuid REFERENCES public.sales_orders(id),
  status text NOT NULL CHECK (status IN ('ativa','liberada','consumida','expirada')), expira_em timestamptz NOT NULL DEFAULT now() + interval '1 day',
  motivo text, created_at timestamptz NOT NULL DEFAULT now(), atualizado_em timestamptz NOT NULL DEFAULT now(),
  faturamento_observado_em timestamptz, omie_pedido_id bigint, omie_account text,
  CONSTRAINT estoque_reservas_pv_par_check CHECK ((omie_pedido_id IS NULL AND omie_account IS NULL) OR (omie_pedido_id > 0 AND omie_account IS NOT NULL)));
CREATE TABLE public.atp_decisoes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), sales_order_id uuid, checkout_id uuid NOT NULL, pool text NOT NULL, account text NOT NULL,
  decisao text NOT NULL, contexto text NOT NULL DEFAULT 'criacao', enforcement boolean NOT NULL, motivo_backorder text, actor_user_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT atp_decisoes_decisao_check CHECK (decisao = ANY (ARRAY['reservado','bloqueado','backorder_autorizado','verificacao_indisponivel',
    'liberado_por_cancelamento','faturamento_observado','consumo_confirmado_manual','cancelamento_confirmado_manual','liberacao_forcada'])));
-- os 11 PVs já limpos à mão (estado de prod: todas as linhas ocultas)
INSERT INTO public.sales_orders (account, status, total, omie_pedido_id, hash_payload, order_date_kpi, deleted_at)
SELECT 'oben', 'importado', 100, p, 'omie_oben_' || p, date '2026-08-01', timestamptz '2026-11-22 00:06:38+00'
  FROM unnest(ARRAY[12215613527,12049288140,12121835342,12121839465,12122021156,12136268451,12156020937,12158135460,
                    12169921125,12172563575,12172847394]::bigint[]) p;
SQL
P -q -f "$MIG_COTA" >/dev/null
P -q -f "$MIG" >/dev/null 2>"$TMP/mig.err" || { echo "INFRA: migration falhou"; cat "$TMP/mig.err"; exit 1; }
# idempotência: reaplicar não pode falhar
if P -q -f "$MIG" >/dev/null 2>"$TMP/mig2.err"; then
  ok "A0 migration reaplicada sem erro (idempotente)"
else
  bad "A0 reaplicar a migration falhou"; head -3 "$TMP/mig2.err"
fi

# ── Fixtures + helpers de tempo (só no banco de prova) ──
P -q <<'SQL' >/dev/null
CREATE FUNCTION t_seg() RETURNS date LANGUAGE sql AS $f$ SELECT date_trunc('week', (now() AT TIME ZONE 'America/Sao_Paulo')::date)::date $f$;
CREATE FUNCTION t_hoje() RETURNS date LANGUAGE sql AS $f$ SELECT (now() AT TIME ZONE 'America/Sao_Paulo')::date $f$;
-- "passa" N minutos: empurra para trás todo carimbo que as regras de tempo leem
CREATE FUNCTION t_passar(m integer) RETURNS void LANGUAGE plpgsql AS $f$
DECLARE d interval := make_interval(mins => m);
BEGIN
  -- o tempo passou: as execuções abertas terminaram LIMPAS (o caso sujo é provado à parte, em C12)
  UPDATE public.omie_pv_execucao SET encerrada_em = COALESCE(encerrada_em, now()), triagem_ok = COALESCE(triagem_ok, true);
  UPDATE public.omie_pv_execucao SET iniciada_em = iniciada_em - d, encerrada_em = encerrada_em - d;
  UPDATE public.omie_pv_consulta_log SET reservada_em = reservada_em - d, registrada_em = registrada_em - d;
  UPDATE public.omie_pv_conferencia SET suspeito_desde = suspeito_desde - d, ultima_suspeita_em = ultima_suspeita_em - d,
    ultima_presenca_em = ultima_presenca_em - d, resolvido_em = resolvido_em - d, ultima_consulta_em = ultima_consulta_em - d,
    primeira_ausencia_afirmada_em = primeira_ausencia_afirmada_em - d, ultima_ausencia_afirmada_em = ultima_ausencia_afirmada_em - d,
    ultima_ausencia_registrada_em = ultima_ausencia_registrada_em - d, aplicado_em = aplicado_em - d;
  UPDATE public.omie_pv_baixa_reserva SET aplicado_em = aplicado_em - d;
  UPDATE public.sales_orders SET created_at = created_at - d, omie_reconciliado_em = omie_reconciliado_em - d,
    envio_omie_reivindicado_em = envio_omie_reivindicado_em - d;
  UPDATE public.estoque_reservas SET created_at = created_at - d;
END $f$;
-- só a VEZ envelhece (o ledger não): isola a régua do intervalo entre ausências da régua de 1/h
CREATE FUNCTION t_passar_vez(m integer) RETURNS void LANGUAGE sql AS $f$
  UPDATE public.omie_pv_consulta_log SET reservada_em = reservada_em - make_interval(mins => m),
                                          registrada_em = registrada_em - make_interval(mins => m);
  UPDATE public.omie_pv_execucao SET iniciada_em = iniciada_em - make_interval(mins => m) $f$;
-- um ciclo: passa 61 min, abre execução, registra presença e a janela corrente com os PIDs que o "Omie" listou
CREATE FUNCTION t_ciclo(p_conta text, p_pids bigint[]) RETURNS bigint LANGUAGE plpgsql AS $f$
DECLARE v bigint;
BEGIN
  PERFORM t_passar(61);
  SELECT execucao_id INTO v FROM public.omie_pv_execucao_iniciar(p_conta, CASE p_conta WHEN 'oben' THEN repeat('a', 32) ELSE repeat('b', 32) END);
  IF v IS NULL THEN RAISE EXCEPTION 't_ciclo: execução negada'; END IF;
  IF cardinality(p_pids) > 0 THEN PERFORM public.omie_pv_presenca_registrar(v, p_pids); END IF;
  PERFORM public.omie_pv_triagem_registrar(v, t_seg(), t_hoje(), 'corrente', p_pids);
  RETURN v;
END $f$;
-- uma consulta: pede a vez e registra o resultado; devolve o efeito (ou o motivo da recusa)
CREATE FUNCTION t_consultar(p_exec bigint, p_res text) RETURNS jsonb LANGUAGE plpgsql AS $f$
DECLARE l record;
BEGIN
  SELECT * INTO l FROM public.omie_pv_proxima_consulta(p_exec);
  IF l.log_id IS NULL THEN RETURN jsonb_build_object('efeito', 'sem_vez', 'motivo', l.motivo); END IF;
  RETURN public.omie_pv_consulta_registrar(l.log_id, p_res, '{}'::jsonb) || jsonb_build_object('pid', l.omie_pedido_id);
END $f$;
-- Fixture Oben, semana corrente: 10 PVs presentes (1001..1010) + o alvo X=2001 (canônica + linha do app) com reserva.
INSERT INTO public.sales_orders (account, status, total, omie_pedido_id, hash_payload, order_date_kpi, created_at)
SELECT 'oben', 'importado', 500, p, 'omie_oben_' || p, t_seg(), now() - interval '3 days' FROM generate_series(1001, 1010) p;
INSERT INTO public.sales_orders (id, account, status, total, omie_pedido_id, hash_payload, order_date_kpi, created_at)
VALUES ('00000000-0000-0000-0000-00000000c001', 'oben', 'importado', 800, 2001, 'omie_oben_2001', t_seg(), now() - interval '3 days');
INSERT INTO public.sales_orders (id, account, status, total, omie_pedido_id, hash_payload, order_date_kpi, created_at, gemeo_importado_id)
VALUES ('00000000-0000-0000-0000-00000000a001', 'oben', 'enviado', 800, 2001, NULL, NULL, now() - interval '3 days',
        '00000000-0000-0000-0000-00000000c001');
INSERT INTO public.estoque_reservas (pool, omie_codigo_produto, quantidade, checkout_id, sales_order_id, status, omie_pedido_id, omie_account, created_at)
VALUES ('oben', 777, 1, '00000000-0000-0000-0000-0000000000c1', NULL, 'ativa', 2001, 'oben', now() - interval '3 days');
SQL

E() { Pq -c "$1" 2>&1 | head -c 400; }
PRES="ARRAY[1001,1002,1003,1004,1005,1006,1007,1008,1009,1010]::bigint[]"

echo "── I. execução"
eq "I1 1ª execução fixa a identidade" "$(E "SELECT motivo FROM omie_pv_execucao_iniciar('oben', repeat('a',32))")" "iniciada"
eq "I2 2ª em menos de 50 min é recusada" "$(E "SELECT motivo FROM omie_pv_execucao_iniciar('oben', repeat('a',32))")" "execucao_recente"
eq "I3 credencial diferente na mesma conta" "$(E "SELECT motivo FROM omie_pv_execucao_iniciar('oben', repeat('c',32))")" "identidade_divergente"
eq "I4 credencial da Oben usada na Colacor" "$(E "SELECT motivo FROM omie_pv_execucao_iniciar('colacor', repeat('a',32))")" "identidade_de_outra_conta"
EX="$(E "SELECT max(id) FROM omie_pv_execucao WHERE account='oben'")"
eq "I5 orçamento de listagem: 6 concedidas, a 7ª não" \
  "$(E "SELECT string_agg(omie_pv_listar_vez($EX)::text, ',') FROM generate_series(1,7)")" "true,true,true,true,true,true,false"

echo "── T. triagem"
EX="$(E "SELECT t_ciclo('oben', $PRES)")"
eq "T1 X ausente da listagem vira suspeito" "$(E "SELECT count(*) FROM omie_pv_conferencia WHERE omie_pedido_id=2001 AND suspeito_desde IS NOT NULL AND resolvido_em IS NULL")" "1"
eq "T1b log da janela: 11 no banco, 1 suspeito, sem recusa" "$(E "SELECT n_banco||'/'||n_suspeitos||'/'||coalesce(recusa,'-') FROM omie_pv_triagem_log ORDER BY id DESC LIMIT 1")" "11/1/-"
P -q -c "INSERT INTO sales_orders (account,status,total,omie_pedido_id,hash_payload,order_date_kpi,created_at) VALUES ('oben','faturado',90,3001,'omie_oben_3001',t_seg(),now()-interval '3 days')"
EX="$(E "SELECT t_ciclo('oben', $PRES)")"
eq "T2 linha faturado ausente = contradição (nunca consultada)" "$(E "SELECT contradicao FROM omie_pv_conferencia WHERE omie_pedido_id=3001")" "linha_terminal"
eq "T3 disjuntor: Omie vazio com banco > 3 → janela recusada" \
  "$(E "SELECT omie_pv_triagem_registrar($EX, t_seg(), t_hoje(), 'corrente', '{}'::bigint[])->>'recusa'")" "disjuntor_omie_vazio"
eq "T3b recusada não criou suspeito novo" "$(E "SELECT count(*) FROM omie_pv_conferencia WHERE suspeito_desde IS NOT NULL AND resolvido_em IS NULL AND contradicao IS NULL AND aplicado_em IS NULL")" "1"
eq "T4 maioria ausente (credencial de outra empresa) → recusa" \
  "$(E "SELECT (omie_pv_triagem_registrar($EX, t_seg(), t_hoje(), 'corrente', ARRAY[1001,1002]::bigint[]))->>'recusa'")" "disjuntor_maioria_ausente"
eq "T5 cursor: janela vencida é erro de contrato" "$(Pq -c "SELECT omie_pv_triagem_registrar($EX, date '2025-01-06', date '2025-01-12', 'cursor', '{}')" 2>&1 | grep -c 'janela de cursor vencida')" "1"

echo "── C. confirmação"
P -q -c "UPDATE omie_pv_execucao SET identidade_confirmada=false WHERE id=$EX"
eq "C0 sem identidade confirmada na execução, nenhuma vez de consulta" "$(E "SELECT motivo FROM omie_pv_proxima_consulta($EX)")" "identidade_nao_confirmada"
P -q -c "UPDATE omie_pv_execucao SET identidade_confirmada=true WHERE id=$EX"
eq "C1 1ª ausência afirmada não baixa" "$(E "SELECT t_consultar($EX,'ausente')->>'efeito'")" "ausencia"
eq "C1b linhas de X seguem vivas" "$(E "SELECT count(*) FROM sales_orders WHERE omie_pedido_id=2001 AND deleted_at IS NULL")" "2"
eq "C2 nova vez na mesma hora: negada" "$(E "SELECT motivo FROM omie_pv_proxima_consulta($EX)")" "aguardando_vez"
# só a vez envelhece: a próxima consulta sai, mas o ledger diz que a 1ª resposta foi há segundos
P -q -c "SELECT t_passar_vez(61)"
EX2="$(E "SELECT execucao_id FROM omie_pv_execucao_iniciar('oben', repeat('a',32))")"
P -q -c "UPDATE omie_pv_execucao SET identidade_confirmada=true WHERE id=$EX2"
P -q -c "UPDATE omie_pv_conferencia SET ultima_ausencia_registrada_em=now() - interval '1 minute' WHERE omie_pedido_id=2001 AND ausencias_afirmadas > 0"
# a seleção pede 1h; força X como candidato para provar a régua da RPC de registro
LOGC="$(E "INSERT INTO omie_pv_consulta_log (execucao_id, account, omie_pedido_id) VALUES ($EX2,'oben',2001) RETURNING id")"
eq "C3 2ª ausência iniciada < 1h depois da 1ª resposta NÃO conta" "$(E "SELECT omie_pv_consulta_registrar($LOGC,'ausente','{}')->>'efeito'")" "ausencia_cedo_demais"
eq "C3b X segue com 1 ausência e linhas vivas" "$(E "SELECT ausencias_afirmadas||'/'||(SELECT count(*) FROM sales_orders WHERE omie_pedido_id=2001 AND deleted_at IS NULL) FROM omie_pv_conferencia WHERE omie_pedido_id=2001")" "1/2"

# Y = 2002: presença na triagem entre as ausências zera
P -q -c "INSERT INTO sales_orders (account,status,total,omie_pedido_id,hash_payload,order_date_kpi,created_at) VALUES ('oben','importado',300,2002,'omie_oben_2002',t_seg(),now()-interval '3 days')"
P -q -c "UPDATE omie_pv_conferencia SET contradicao='parado_no_teste' WHERE omie_pedido_id=2001"
EX="$(E "SELECT t_ciclo('oben', $PRES)")"
eq "C4a Y suspeito, 1ª ausência" "$(E "SELECT (t_consultar($EX,'ausente'))->>'pid'")" "2002"
EX="$(E "SELECT t_ciclo('oben', $PRES || ARRAY[2002::bigint])")"
eq "C4 presença na triagem zerou a sequência de Y" "$(E "SELECT ausencias_afirmadas||'/'||(resolvido_em IS NOT NULL) FROM omie_pv_conferencia WHERE omie_pedido_id=2002")" "0/true"
EX="$(E "SELECT t_ciclo('oben', $PRES)")"
eq "C4b reaberta, a ausência seguinte é a 1ª de novo (não baixa)" "$(E "SELECT (t_consultar($EX,'ausente'))->>'sequencia'")" "1"
# o sync relê Y (omie_reconciliado_em) entre as ausências (o orçamento de erros de 24h já foi gasto: só a VEZ envelhece)
P -q -c "SELECT t_passar_vez(24*60)" >/dev/null
P -q -c "UPDATE sales_orders SET omie_reconciliado_em=now() WHERE omie_pedido_id=2002"
EX="$(E "SELECT t_ciclo('oben', $PRES)")"
eq "C6 releitura do sync entre as ausências: recomeça em 1, sem baixa" "$(E "SELECT (t_consultar($EX,'ausente'))->>'sequencia'")" "1"
eq "C6b Y vivo" "$(E "SELECT count(*) FROM sales_orders WHERE omie_pedido_id=2002 AND deleted_at IS NULL")" "1"
eq "C7 1/h: segunda vez na mesma execução negada" "$(E "SELECT motivo FROM omie_pv_proxima_consulta($EX)")" "aguardando_vez"
P -q -c "SELECT t_passar_vez(61)" >/dev/null
EX="$(E "SELECT execucao_id FROM omie_pv_execucao_iniciar('oben', repeat('a',32))")"
P -q -c "UPDATE omie_pv_execucao SET identidade_confirmada=true WHERE id=$EX"
# 3 tentativas anteriores sem desfecho (cobradas) + a de C6 = 4 no dia
P -q -c "INSERT INTO omie_pv_consulta_log (execucao_id, account, omie_pedido_id, reservada_em, resultado, registrada_em)
         SELECT $EX, 'oben', 2002, now() - make_interval(hours => h), 'indeterminado', now() - make_interval(hours => h) FROM generate_series(2,4) h"
eq "C8 teto de erros: ≥ 4 tentativas cobradas em 24h → sem vez" "$(E "SELECT motivo FROM omie_pv_proxima_consulta($EX)")" "teto_erros_24h"
L1="$(E "SELECT max(id) FROM omie_pv_consulta_log")"
eq "C9 registro idempotente pelo log_id" "$(E "SELECT omie_pv_consulta_registrar($L1,'ausente','{}')->>'efeito'")" "ja_registrada"
eq "C10 'existe' na consulta zera e resolve" \
  "$(P -q -t -c "SELECT t_passar(24*60+1)" >/dev/null; E "SELECT (t_consultar(t_ciclo('oben', $PRES),'existe'))->>'efeito'")" "presenca"
eq "C10b Y resolvido" "$(E "SELECT ausencias_afirmadas||'/'||(resolvido_em IS NOT NULL) FROM omie_pv_conferencia WHERE omie_pedido_id=2002")" "0/true"

echo "── B. baixa"
P -q -c "UPDATE omie_pv_conferencia SET contradicao=NULL, ausencias_afirmadas=0, primeira_ausencia_afirmada_em=NULL, ultima_ausencia_afirmada_em=NULL, ultima_ausencia_registrada_em=NULL, primeira_ausencia_log_id=NULL WHERE omie_pedido_id=2001 AND aplicado_em IS NULL"
P -q -t -c "SELECT t_passar(24*60+1)"
EX="$(E "SELECT t_ciclo('oben', $PRES)")"
eq "B0 X: 1ª ausência" "$(E "SELECT (t_consultar($EX,'ausente'))->>'pid'")" "2001"
EX="$(E "SELECT t_ciclo('oben', $PRES)")"
eq "B1 X: 2ª ausência ≥ 1h depois → BAIXA" "$(E "SELECT (t_consultar($EX,'ausente'))->>'efeito'")" "baixa"
eq "B2 as 2 linhas de X ocultas, status preservado" "$(E "SELECT string_agg(status, ',' ORDER BY status) FROM sales_orders WHERE omie_pedido_id=2001 AND deleted_at IS NOT NULL")" "enviado,importado"
eq "B3 reserva pelo par próprio liberada com motivo" "$(E "SELECT status||'/'||(motivo LIKE 'reconciliacao: PV 2001 (oben) excluído no Omie%') FROM estoque_reservas WHERE omie_pedido_id=2001")" "liberada/true"
eq "B4 trilha + impacto imutável (1 cada)" "$(E "SELECT (SELECT count(*) FROM atp_decisoes WHERE decisao='liberado_por_exclusao_omie' AND contexto='reconciliacao')||'/'||(SELECT count(*) FROM omie_pv_baixa_reserva WHERE omie_pedido_id=2001)")" "1/1"
eq "B4b ledger: aplicado com prova de 2 consultas e valor da linha do KPI" "$(E "SELECT jsonb_array_length(prova->'consultas')||'/'||valor_baixado FROM omie_pv_conferencia WHERE omie_pedido_id=2001")" "2/800"

# Z = 2003 com reserva DIVERGENTE: o par aponta Z, mas sales_order_id aponta para um pedido de OUTRO PV
P -q -c "INSERT INTO sales_orders (id,account,status,total,omie_pedido_id,hash_payload,order_date_kpi,created_at) VALUES ('00000000-0000-0000-0000-00000000c003','oben','importado',200,2003,'omie_oben_2003',t_seg(),now()-interval '3 days')"
P -q -c "INSERT INTO estoque_reservas (pool,omie_codigo_produto,quantidade,checkout_id,sales_order_id,status,omie_pedido_id,omie_account,created_at) VALUES ('oben',778,1,'00000000-0000-0000-0000-0000000000c3',(SELECT id FROM sales_orders WHERE omie_pedido_id=1001),'ativa',2003,'oben',now()-interval '3 days')"
P -q -t -c "SELECT t_passar(24*60+1)"
EX="$(E "SELECT t_ciclo('oben', $PRES)")"; P -q -c "SELECT t_consultar($EX,'ausente')" >/dev/null
EX="$(E "SELECT t_ciclo('oben', $PRES)")"
eq "B5 reserva divergente (sales_order_id de outro PV) → revisão, nada liberado" "$(E "SELECT t_consultar($EX,'ausente')->>'motivo'")" "reserva_divergente"
eq "B5b reserva de Z segue ativa e Z vivo" "$(E "SELECT (SELECT status FROM estoque_reservas WHERE omie_pedido_id=2003)||'/'||(SELECT count(*) FROM sales_orders WHERE omie_pedido_id=2003 AND deleted_at IS NULL)")" "ativa/1"

# W = 2004 (R$ 2.500 > teto de R$ 2.000 por PV na Oben)
P -q -c "INSERT INTO sales_orders (account,status,total,omie_pedido_id,hash_payload,order_date_kpi,created_at) VALUES ('oben','importado',2500,2004,'omie_oben_2004',t_seg(),now()-interval '3 days')"
P -q -t -c "SELECT t_passar(24*60+1)"
EX="$(E "SELECT t_ciclo('oben', $PRES)")"; P -q -c "SELECT t_consultar($EX,'ausente')" >/dev/null
EX="$(E "SELECT t_ciclo('oben', $PRES)")"
eq "B6 PV acima do teto por PV → revisão" "$(E "SELECT t_consultar($EX,'ausente')->>'motivo'")" "teto_valor_pv"

# Teto de 2 PVs/24h: V1=2005, V2=2006, V3=2007 baixam em sequência no mesmo dia (já há a baixa de X? não: X foi há > 24h)
P -q -c "INSERT INTO sales_orders (account,status,total,omie_pedido_id,hash_payload,order_date_kpi,created_at) SELECT 'oben','importado',100,p,'omie_oben_'||p,t_seg(),now()-interval '3 days' FROM generate_series(2005,2007) p"
P -q -t -c "SELECT t_passar(24*60+1)"
for _ in 1 2 3 4 5 6; do
  EX="$(E "SELECT t_ciclo('oben', $PRES)")"; P -q -c "SELECT t_consultar($EX,'ausente')" >/dev/null
  P -q -c "SELECT t_passar_vez(24*60)" >/dev/null   # libera o orçamento de ERROS, não o de baixas (aplicado_em não anda)
done
eq "B7 teto de 2 baixas/24h na conta: a 3ª fica adiada" \
  "$(E "SELECT count(*) FILTER (WHERE aplicado_em IS NOT NULL)||'/'||count(*) FILTER (WHERE adiado_motivo='teto_pvs_24h') FROM omie_pv_conferencia WHERE omie_pedido_id BETWEEN 2005 AND 2007")" "2/1"

echo "── C11. linha vira faturado ENTRE as ausências"
P -q -c "INSERT INTO sales_orders (account,status,total,omie_pedido_id,hash_payload,order_date_kpi,created_at) VALUES ('oben','importado',100,2008,'omie_oben_2008',t_seg(),now()-interval '3 days')"
P -q -c "UPDATE omie_pv_conferencia SET contradicao='parado_no_teste' WHERE omie_pedido_id BETWEEN 2005 AND 2007 AND aplicado_em IS NULL"
P -q -t -c "SELECT t_passar(24*60+1)"
EX="$(E "SELECT t_ciclo('oben', $PRES)")"; P -q -c "SELECT t_consultar($EX,'ausente')" >/dev/null
P -q -c "UPDATE sales_orders SET status='faturado' WHERE omie_pedido_id=2008"
P -q -t -c "SELECT t_passar(61)"
EX2="$(E "SELECT execucao_id FROM omie_pv_execucao_iniciar('oben', repeat('a',32))")"
P -q -c "UPDATE omie_pv_execucao SET identidade_confirmada=true WHERE id=$EX2"
eq "C11 faturado na hora da baixa → revisão, linha viva" "$(E "SELECT (t_consultar($EX2,'ausente'))->>'motivo'")/$(E "SELECT count(*) FROM sales_orders WHERE omie_pedido_id=2008 AND deleted_at IS NULL")" "linha_terminal/1"

echo "── D. durabilidade"
P -q -c "UPDATE sales_orders SET deleted_at=NULL WHERE omie_pedido_id=2001"
eq "D1 rollback do front (deleted_at=NULL) não ressuscita PV baixado" "$(E "SELECT count(*) FROM sales_orders WHERE omie_pedido_id=2001 AND deleted_at IS NULL")" "0"
P -q -c "INSERT INTO sales_orders (account,status,total,omie_pedido_id,hash_payload,order_date_kpi) VALUES ('oben','importado',800,2001,'omie_oben_2001_tardia',t_seg())"
eq "D2 importação tardia da canônica nasce oculta" "$(E "SELECT count(*) FROM sales_orders WHERE omie_pedido_id=2001 AND deleted_at IS NULL")" "0"
P -q -c "INSERT INTO sales_orders (id,account,status,total,omie_pedido_id) VALUES ('00000000-0000-0000-0000-00000000a099','oben','enviado',50,NULL)"
P -q -c "UPDATE sales_orders SET omie_pedido_id=2001 WHERE id='00000000-0000-0000-0000-00000000a099'"
eq "D3 PID atribuído depois da baixa → contradição, linha NÃO escondida em silêncio" \
  "$(E "SELECT (SELECT contradicao FROM omie_pv_conferencia WHERE omie_pedido_id=2001)||'/'||(SELECT count(*) FROM sales_orders WHERE id='00000000-0000-0000-0000-00000000a099' AND deleted_at IS NULL)")" "pid_atribuido_apos_baixa/1"
P -q -c "UPDATE sales_orders SET deleted_at=NULL WHERE omie_pedido_id=12156020937"
eq "D4 histórico (limpo à mão) também é durável" "$(E "SELECT count(*) FROM sales_orders WHERE omie_pedido_id=12156020937 AND deleted_at IS NULL")" "0"

echo "── S. concorrência (2 sessões)"
# S1: o sync relê o PV (omie_reconciliado_em) numa transação aberta enquanto a 2ª ausência chega. A baixa trava a
# linha, espera o commit do sync e RELÊ: tem de ver a presença e não baixar.
P -q -c "INSERT INTO sales_orders (account,status,total,omie_pedido_id,hash_payload,order_date_kpi,created_at) VALUES ('oben','importado',100,2009,'omie_oben_2009',t_seg(),now()-interval '3 days')"
P -q -c "INSERT INTO sales_orders (account,status,total,omie_pedido_id,created_at,deleted_at) VALUES ('oben','enviado',100,2009,now()-interval '3 days',now()-interval '1 day')"
P -q -c "UPDATE omie_pv_conferencia SET contradicao='parado_no_teste' WHERE omie_pedido_id=2008"
P -q -t -c "SELECT t_passar(24*60+1)"
EX="$(E "SELECT t_ciclo('oben', $PRES)")"; P -q -c "SELECT t_consultar($EX,'ausente')" >/dev/null
EX="$(E "SELECT t_ciclo('oben', $PRES)")"
( P -q -c "BEGIN; UPDATE sales_orders SET omie_reconciliado_em = now() + interval '1 minute' WHERE omie_pedido_id=2009 AND deleted_at IS NOT NULL; SELECT pg_sleep(2); COMMIT;" >/dev/null 2>&1 ) &
SYNC=$!
sleep 0.5
R="$(E "SELECT t_consultar($EX,'ausente')->>'efeito'")"
wait "$SYNC" || true
eq "S1 releitura do sync em voo durante a baixa → presença, sem baixa" "$R/$(E "SELECT count(*) FROM sales_orders WHERE omie_pedido_id=2009 AND deleted_at IS NULL")" "presenca_do_sync/1"
# S2: o front começa o rollback (deleted_at=NULL) de uma linha OCULTA de outro PV baixado enquanto a baixa corre — e
# a baixa termina primeiro: o rollback, ao ser liberado, encontra a marca durável.
P -q -c "INSERT INTO sales_orders (id,account,status,total,omie_pedido_id,hash_payload,order_date_kpi,created_at) VALUES ('00000000-0000-0000-0000-00000000c010','oben','importado',100,2010,'omie_oben_2010',t_seg(),now()-interval '3 days')"
P -q -c "UPDATE omie_pv_conferencia SET contradicao='parado_no_teste' WHERE omie_pedido_id=2009"
P -q -t -c "SELECT t_passar(24*60+1)"
EX="$(E "SELECT t_ciclo('oben', $PRES)")"; P -q -c "SELECT t_consultar($EX,'ausente')" >/dev/null
EX="$(E "SELECT t_ciclo('oben', $PRES)")"
LOGS2="$(E "SELECT coalesce(log_id::text, 'NULL') FROM omie_pv_proxima_consulta($EX)")"
( P -q -c "BEGIN; SELECT omie_pv_consulta_registrar($LOGS2,'ausente','{}'); SELECT pg_sleep(2); COMMIT;" >/dev/null 2>&1 ) &
BAIXA=$!
sleep 0.7
P -q -c "UPDATE sales_orders SET deleted_at=NULL WHERE id='00000000-0000-0000-0000-00000000c010'" >/dev/null
wait "$BAIXA" || true
eq "S2 rollback do front concorrente com a baixa: linha fica oculta" "$(E "SELECT (deleted_at IS NOT NULL)::text FROM sales_orders WHERE id='00000000-0000-0000-0000-00000000c010'")/$(E "SELECT (aplicado_em IS NOT NULL)::text FROM omie_pv_conferencia WHERE omie_pedido_id=2010")" "true/true"

# S3: um write-back troca o PID de uma linha de V (2011 → 2099) enquanto a 2ª ausência de V chega. A baixa trava a
# linha pelo UUID, espera o commit e RELÊ o conjunto pelo predicado: mudou ⇒ adia, e a linha de 2099 fica viva.
P -q -c "INSERT INTO sales_orders (id,account,status,total,omie_pedido_id,hash_payload,order_date_kpi,created_at) VALUES ('00000000-0000-0000-0000-00000000c011','oben','importado',100,2011,'omie_oben_2011',t_seg(),now()-interval '3 days')"
P -q -c "INSERT INTO sales_orders (id,account,status,total,omie_pedido_id,created_at) VALUES ('00000000-0000-0000-0000-00000000a011','oben','enviado',100,2011,now()-interval '3 days')"
P -q -c "UPDATE omie_pv_conferencia SET contradicao='parado_no_teste' WHERE omie_pedido_id IN (2009,2010) AND aplicado_em IS NULL"
P -q -t -c "SELECT t_passar(24*60+1)" >/dev/null
EX="$(E "SELECT t_ciclo('oben', $PRES)")"; P -q -c "SELECT t_consultar($EX,'ausente')" >/dev/null
EX="$(E "SELECT t_ciclo('oben', $PRES)")"
( P -q -c "BEGIN; UPDATE sales_orders SET omie_pedido_id = 2099 WHERE id='00000000-0000-0000-0000-00000000a011'; SELECT pg_sleep(2); COMMIT;" >/dev/null 2>&1 ) &
WB=$!
sleep 0.5
R="$(E "SELECT t_consultar($EX,'ausente')->>'motivo'")"
wait "$WB" || true
eq "S3 PID trocado por write-back concorrente: baixa adiada, a linha de 2099 viva" "$R/$(E "SELECT count(*) FROM sales_orders WHERE id='00000000-0000-0000-0000-00000000a011' AND deleted_at IS NULL AND omie_pedido_id=2099")" "linhas_mudaram/1"

echo "── D'. atribuição de PID durante o soft-delete do front; terminal depois da baixa"
P -q -c "INSERT INTO sales_orders (id,account,status,total,omie_pedido_id,deleted_at) VALUES ('00000000-0000-0000-0000-00000000a098','oben','enviado',70,NULL,now())"
P -q -c "UPDATE sales_orders SET omie_pedido_id=2005 WHERE id='00000000-0000-0000-0000-00000000a098'"
P -q -c "UPDATE sales_orders SET deleted_at=NULL WHERE id='00000000-0000-0000-0000-00000000a098'"
eq "D5 PID atribuído com o soft-delete provisório gravado: contradição e o rollback devolve a linha" \
  "$(E "SELECT (SELECT contradicao FROM omie_pv_conferencia WHERE omie_pedido_id=2005)||'/'||(SELECT count(*) FROM sales_orders WHERE id='00000000-0000-0000-0000-00000000a098' AND deleted_at IS NULL)")" "pid_atribuido_apos_baixa/1"
P -q -c "UPDATE sales_orders SET status='faturado' WHERE omie_pedido_id=2006 AND hash_payload IS NOT NULL"
eq "D6 status terminal gravado depois da baixa vira contradição (linha segue oculta)" \
  "$(E "SELECT (SELECT contradicao FROM omie_pv_conferencia WHERE omie_pedido_id=2006)||'/'||(SELECT count(*) FROM sales_orders WHERE omie_pedido_id=2006 AND deleted_at IS NULL)")" "terminal_apos_baixa/0"

P -q -c "UPDATE sales_orders SET omie_pedido_id=2013 WHERE id='00000000-0000-0000-0000-00000000a098'"
P -q -c "INSERT INTO omie_pv_conferencia (account, omie_pedido_id, aplicado_em, prova) VALUES ('oben', 2013, now(), '{\"origem_historica\": \"teste D7\"}')"
P -q -c "UPDATE sales_orders SET deleted_at=now() WHERE id='00000000-0000-0000-0000-00000000a098'"
P -q -c "UPDATE sales_orders SET deleted_at=NULL WHERE id='00000000-0000-0000-0000-00000000a098'"
eq "D7 isenção é da linha NAQUELE PV: passou a outro PID baixado, o rollback não ressuscita" \
  "$(E "SELECT count(*) FROM sales_orders WHERE id='00000000-0000-0000-0000-00000000a098' AND deleted_at IS NULL")" "0"

echo "── C12. execução com triagem suja entre as ausências reinicia a contagem"
P -q -c "INSERT INTO sales_orders (account,status,total,omie_pedido_id,hash_payload,order_date_kpi,created_at) VALUES ('oben','importado',100,2014,'omie_oben_2014',t_seg(),now()-interval '3 days')"
P -q -c "UPDATE omie_pv_conferencia SET contradicao='parado_no_teste' WHERE omie_pedido_id=2011 AND aplicado_em IS NULL"
P -q -t -c "SELECT t_passar(24*60+1)" >/dev/null
EX="$(E "SELECT t_ciclo('oben', $PRES)")"; P -q -c "SELECT t_consultar($EX,'ausente')" >/dev/null
P -q -t -c "SELECT t_passar(30)" >/dev/null
# uma execução entre as duas ausências cuja triagem falhou (a presença de 2014 pode ter se perdido nela)
P -q -c "INSERT INTO omie_pv_execucao (account, app_hash, iniciada_em, encerrada_em, triagem_ok) VALUES ('oben', repeat('a',32), now(), now(), false)"
P -q -t -c "SELECT t_passar(40)" >/dev/null
EX="$(E "SELECT t_ciclo('oben', $PRES)")"
eq "C12 2ª ausência depois de uma execução com triagem que falhou: recomeça em 1, sem baixa" \
  "$(E "SELECT coalesce((t_consultar($EX,'ausente'))->>'sequencia', 'efeito?')")/$(E "SELECT count(*) FROM sales_orders WHERE omie_pedido_id=2014 AND deleted_at IS NULL")" "1/1"

echo "── A. ACL / RLS / histórico"
eq "A1 anon não executa RPC" "$(Pq -c "SET ROLE anon; SELECT omie_pv_triagem_janelas('oben')" 2>&1 | grep -c '42501')" "1"
eq "A2 authenticated não executa a RPC da baixa" "$(Pq -c "SET ROLE authenticated; SELECT omie_pv_consulta_registrar(1,'ausente','{}')" 2>&1 | grep -c '42501')" "1"
eq "A3 service_role executa" "$(Pq -c "SET ROLE service_role; SELECT count(*) FROM omie_pv_triagem_janelas('oben')" 2>&1)" "2"
eq "A4 staff lê o ledger; outro logado não" \
  "$(Pq -c "SET ROLE authenticated; SET request.jwt.claim.sub='00000000-0000-0000-0000-0000000000bb'; SELECT count(*)>0 FROM omie_pv_conferencia" 2>&1)/$(Pq -c "SET ROLE authenticated; SET request.jwt.claim.sub='00000000-0000-0000-0000-0000000000ee'; SELECT count(*) FROM omie_pv_conferencia" 2>&1)" "t/0"
eq "A5 identidade não é legível nem por staff" "$(Pq -c "SET ROLE authenticated; SET request.jwt.claim.sub='00000000-0000-0000-0000-0000000000bb'; SELECT count(*) FROM omie_pv_identidade" 2>&1 | grep -c '42501')" "1"
eq "A6 os 11 históricos no ledger como aplicados" "$(E "SELECT count(*) FROM omie_pv_conferencia WHERE prova->>'origem_historica' LIKE 'limpeza manual%' AND aplicado_em IS NOT NULL")" "11"
eq "A8 sequências IDENTITY fechadas para anon/authenticated/service_role" \
  "$(E "SELECT count(*) FROM unnest(ARRAY['omie_pv_execucao','omie_pv_triagem_log','omie_pv_consulta_log','omie_pv_baixa_reserva']) t, unnest(ARRAY['anon','authenticated','service_role']) r WHERE has_sequence_privilege(r, pg_get_serial_sequence('public.'||t,'id'), 'USAGE')")" "0"
eq "A9 app_hash ilegível por staff" "$(Pq -c "SET ROLE authenticated; SET request.jwt.claim.sub='00000000-0000-0000-0000-0000000000bb'; SELECT app_hash FROM omie_pv_execucao LIMIT 1" 2>&1 | grep -c '42501')" "1"
eq "A7 cron com timeout explícito" "$(E "SELECT count(*) FROM cron.job WHERE jobname='omie-pv-exclusao-reconciliar' AND command LIKE '%timeout_milliseconds:=150000%'")" "1"

echo "PASS=$PASS  FAIL=$FAIL"
[ "$FAIL" -eq 0 ]
