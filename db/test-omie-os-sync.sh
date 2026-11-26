#!/usr/bin/env bash
# ╔═════════════════════════════════════════════════════════════════
# ║  PROVA PG17 — 20261126233000_omie_os_espelho.sql (espelho das OS do Omie da Colacor SC, crédito-IA PR 7 C)
# ║      bash db/test-omie-os-sync.sh > /tmp/t.log 2>&1; echo "exit=$?"
# ║      bash db/test-omie-os-sync.sh --falsificar > /tmp/f.log 2>&1; echo "exit=$?"
# ║      HARNESS_LOCALE=pt_BR.UTF-8 bash db/test-omie-os-sync.sh   (2º idioma)
# ║  (NÃO pipe pra tail — engole o exit≠0.)
# ║
# ║   S  a migration aplica (pós-condição) e reaplica (idempotente).
# ║   A  ACL/RLS: RPCs só service_role; espelho por fin_user_can_access; staging fechado; claude_ro mede; cron.
# ║   R  runs: 1 rodando por empresa; rodando velho vira erro e o staging dele é descartado.
# ║   G  gravar: só run rodando; n_cod_os inteiro positivo; repetido no run = erro (paginação instável).
# ║   F  fechar: o BANCO decide íntegro; não íntegro/erro/staging≠total não mexe no espelho; 2º fechar = no-op.
# ║   U  sumiço: só na 2ª varredura íntegra; não íntegra não conta; 1ª data preservada; reaparecer zera.
# ║   N  ausente ≠ zero: tipo jsonb errado/nulo vira NULL, nunca 0.
# ║   V  view: flag NULL não é aberta; ausente fora; idade/dias sem movimento; NULL sem data.
# ║   E  elo: normalização do nº (zeros à esquerda, vazio, só zeros, não-dígito) + medição como claude_ro.
# ║  Diário: docs/historico/credito-os-omie-2026-11.md
# ╚═════════════════════════════════════════════════════════════════
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
export PGVER=17   # consumido pelo db/lib/pg-harness.sh via source
PORT="${PGPORT_TEST:-5841}"
SLUG="omie-os-sync"
LOC="${HARNESS_LOCALE:-C}"
export LC_ALL=C LANG=C          # o CLIENTE fica em C; o idioma do SERVIDOR vem de $LOC
MIG_REAL="$REPO_ROOT/supabase/migrations/20261126233000_omie_os_espelho.sql"
MEDIR="$REPO_ROOT/db/medir-omie-os.sql"
[ -f "$MIG_REAL" ] || { echo "INFRA: ausente: $MIG_REAL"; exit 1; }
[ -f "$MEDIR" ] || { echo "INFRA: ausente: $MEDIR"; exit 1; }

# ══════════════════════════════════════════════════════════════════
# MODO --falsificar — controle VERDE primeiro na MESMA invocação (vermelho aborta antes de sabotar), e
# cada sabotagem só conta se (1) aplicou, (2) a suíte rodou INTEIRA, (3) o assert declarado estava verde
# no controle e virou vermelho. Uma camada por vez.
# ══════════════════════════════════════════════════════════════════
if [ "${1:-}" = "--falsificar" ]; then
  SABOTAGENS="uma_integra_basta:U2 nao_integra_conta:U3 primeira_data_sobrescrita:U4 reaparecer_nao_zera:U5
              staging_diferente_passa:F3 erro_passa:F4 fechar_repetido_conta:F6 view_null_blind:V1
              normaliza_sem_zeros:E1 campo_nulo_vira_zero:N1 gravar_sem_rodando:G1 abrir_concorrente:R2
              staging_legivel:S1"
  LOGDIR="$(mktemp -d "/tmp/falsifica-${SLUG}.XXXXXX")"
  porta=$PORT
  executados() { sed -n 's/^PASS=\([0-9][0-9]*\)  FAIL=\([0-9][0-9]*\)$/\1 \2/p' "$1" | awk '{ print $1 + $2 }'; }

  echo "══ CONTROLE (migration real, sem sabotagem) — tem de ficar VERDE ══"
  if PGPORT_TEST=$porta SABOTAGEM="" bash "$0" > "$LOGDIR/controle.log" 2>&1; then
    asserts_controle="$(executados "$LOGDIR/controle.log")"
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
    faltam=""
    for exigido in ${exigidos//,/ }; do
      if ! grep -Eq "^  ✅ ($exigido) " "$LOGDIR/controle.log" || ! grep -Eq "^  ❌ ($exigido) " "$log"; then
        faltam="$faltam $exigido"
      fi
    done
    if ! grep -q 'SABOTAGEM ATIVA em ' "$log"; then
      echo "  ❌ $sab — vermelha SEM a sabotagem aplicada (padrão derivou?)"
      { grep -m3 -E 'SABOTAGEM|padrão ocorre|INFRA' "$log" || true; } | sed 's/^/       /'
      falhas=$((falhas+1))
    elif [ "$(executados "$log")" != "$asserts_controle" ]; then
      echo "  ❌ $sab — a suíte NÃO rodou inteira ($(executados "$log") de $asserts_controle asserts): vermelho de aborto"
      tail -3 "$log" | sed 's/^/       /'
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
Pq() { P -tA -q "$@"; }
# E: valor de uma consulta; erro vira o texto "ERRO:<sqlstate>" (o assert decide), nunca aborta a suíte
E()  { local out; if out="$(P -tA -q -v VERBOSITY=verbose -c "$1" 2>&1)"; then printf '%s' "$out";
       else printf 'ERRO:%s' "$(grep -Eo 'ERROR:  [0-9A-Z]{5}' <<<"$out" | head -1 | awk '{print $2}')"; fi; }

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
  uma_integra_basta)
    trocar "$MIG" "           ausente_desde = CASE WHEN e.ausencias_integras + 1 >= 2" "           ausente_desde = CASE WHEN e.ausencias_integras + 1 >= 1" ;;
  nao_integra_conta)
    trocar "$MIG" "  IF v_integra THEN
    INSERT INTO public.omie_os_espelho" "  IF v_integra OR p_erro IS NULL THEN
    INSERT INTO public.omie_os_espelho" ;;
  primeira_data_sobrescrita)
    trocar "$MIG" "                                THEN coalesce(e.primeira_ausencia_em, v_run.iniciado_em) END," \
      "                                THEN v_run.iniciado_em END," ;;
  reaparecer_nao_zera)
    trocar "$MIG" "      primeira_ausencia_em = NULL, ausencias_integras = 0, ausente_desde = NULL," "" ;;
  staging_diferente_passa)
    trocar "$MIG" "    WHEN v_gravadas <> v_total THEN" "    WHEN false THEN" ;;
  erro_passa)
    trocar "$MIG" "    WHEN p_erro IS NOT NULL THEN 'erro: ' || left(p_erro, 200)" "    WHEN false THEN 'erro'" ;;
  fechar_repetido_conta)
    trocar "$MIG" "  IF v_run.status <> 'rodando' THEN
    RETURN" "  IF false THEN
    RETURN" ;;
  view_null_blind)
    trocar "$MIG" " WHERE e.faturada IS FALSE AND e.cancelada IS FALSE AND e.ausente_desde IS NULL;" \
      " WHERE e.faturada IS NOT TRUE AND e.cancelada IS NOT TRUE AND e.ausente_desde IS NULL;" ;;
  normaliza_sem_zeros)
    trocar "$MIG" "nullif(ltrim(btrim(p), '0'), '')" "nullif(btrim(p), '')" ;;
  campo_nulo_vira_zero)
    trocar "$MIG" "  SELECT CASE WHEN jsonb_typeof(l -> k) = 'number' THEN (l ->> k)::numeric END;" \
      "  SELECT CASE WHEN jsonb_typeof(l -> k) IN ('number','null') THEN coalesce((l ->> k)::numeric, 0) END;" ;;
  gravar_sem_rodando)
    trocar "$MIG" "  IF v_status IS DISTINCT FROM 'rodando' THEN" "  IF false THEN" ;;
  abrir_concorrente)
    trocar "$MIG" "  IF EXISTS (SELECT 1 FROM public.omie_os_sync_runs WHERE company = p_company AND status = 'rodando') THEN" \
      "  IF false THEN" ;;
  staging_legivel)
    trocar "$MIG" "  GRANT SELECT ON public.omie_os_sync_runs, public.omie_os_espelho TO authenticated;" \
      "  GRANT SELECT ON public.omie_os_sync_runs, public.omie_os_espelho, public.omie_os_staging TO authenticated;" ;;
  *) echo "INFRA: sabotagem desconhecida: $SAB"; exit 1 ;;
esac
if [ -n "$SAB" ]; then
  if cmp -s "$MIG" "$MIG_REAL"; then echo "INFRA: sabotagem $SAB inerte"; exit 1; fi
  echo "SABOTAGEM ATIVA em $SAB"
fi

# ── Banco: papéis do Supabase + o recorte do que a migration lê e não cria ──
P -q <<'SQL' >/dev/null
DO $r$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='anon') THEN CREATE ROLE anon NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN CREATE ROLE authenticated NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN CREATE ROLE service_role NOLOGIN BYPASSRLS; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='claude_ro') THEN CREATE ROLE claude_ro NOLOGIN BYPASSRLS; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='sandbox_exec_x') THEN CREATE ROLE sandbox_exec_x NOLOGIN; END IF;
END $r$;
-- o default ACL do Supabase (ALL para os papéis da API e INSERT para sandbox_exec_*): a allowlist tem de fechar
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT INSERT ON TABLES TO sandbox_exec_x;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO anon, authenticated, service_role;
GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role, claude_ro;
CREATE SCHEMA auth;
CREATE SCHEMA private;
CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $f$ SELECT NULLIF(current_setting('request.jwt.claim.sub', true), '')::uuid $f$;
GRANT USAGE ON SCHEMA auth TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION auth.uid() TO anon, authenticated, service_role;
-- acesso financeiro por empresa: o usuário ...aa vê a SC; o ...bb não
CREATE TABLE public.t_acesso (user_id uuid, company text);
INSERT INTO public.t_acesso VALUES ('00000000-0000-0000-0000-0000000000aa', 'colacor_sc');
CREATE FUNCTION public.fin_user_can_access(p_company text) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = public AS $f$ SELECT EXISTS (SELECT 1 FROM public.t_acesso WHERE user_id = auth.uid() AND company = p_company) $f$;
CREATE SCHEMA cron;
CREATE TABLE cron.job (jobid bigserial PRIMARY KEY, jobname text UNIQUE, schedule text, command text,
                       active boolean NOT NULL DEFAULT true, username text NOT NULL DEFAULT current_user);
CREATE FUNCTION cron.schedule(p_nome text, p_sched text, p_cmd text) RETURNS bigint LANGUAGE sql AS $f$
  INSERT INTO cron.job (jobname, schedule, command) VALUES (p_nome, p_sched, p_cmd)
  ON CONFLICT (jobname) DO UPDATE SET schedule = EXCLUDED.schedule, command = EXCLUDED.command RETURNING jobid $f$;
CREATE FUNCTION cron.unschedule(p_id bigint) RETURNS boolean LANGUAGE sql AS $f$
  DELETE FROM cron.job WHERE jobid = p_id RETURNING true $f$;
CREATE SCHEMA net;
CREATE SCHEMA vault;
CREATE TABLE public.fin_contas_receber (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), company text, omie_codigo_lancamento bigint, omie_codigo_cliente bigint,
  numero_documento text, numero_documento_fiscal text, numero_pedido text, valor_documento numeric, saldo numeric,
  status_titulo text, id_origem text, data_emissao date, updated_at timestamptz DEFAULT now());
GRANT SELECT ON public.fin_contas_receber TO claude_ro;
SQL

# ── Aplica a migration (2× = idempotente) ──
APL1="$(P -q -f "$MIG" 2>&1 || echo "FALHOU_APLICAR")"
APL2="$(P -q -f "$MIG" 2>&1 || echo "FALHOU_APLICAR")"

# helpers de teste: linha no formato que a edge manda; e o ciclo abrir → gravar → fechar como service_role
P -q <<'SQL' >/dev/null 2>&1 || true
CREATE FUNCTION public.t_linha(n bigint, num text, cli bigint, extra jsonb DEFAULT '{}') RETURNS jsonb LANGUAGE sql AS $f$
  SELECT jsonb_build_object('n_cod_os', n, 'c_num_os', num, 'n_cod_cli', cli, 'etapa', '20', 'valor_total', 100,
           'prazo_max_dias', 30, 'n_parcelas', 1, 'parcelas', '[{"nDias":30}]'::jsonb, 'faturada', false, 'cancelada', false,
           'data_inclusao', to_char((now() AT TIME ZONE 'America/Sao_Paulo') - interval '10 days', 'YYYY-MM-DD"T"HH24:MI:SS"-03:00"'),
           'data_alteracao', to_char((now() AT TIME ZONE 'America/Sao_Paulo') - interval '4 days', 'YYYY-MM-DD"T"HH24:MI:SS"-03:00"'),
           'payload', jsonb_build_object('Cabecalho', jsonb_build_object('nCodOS', n))) || extra $f$;
-- ciclo completo; p_integra/p_erro simulam o que a edge afirma; p_total = total_de_registros declarado
CREATE FUNCTION public.t_ciclo(p_linhas jsonb, p_integra boolean DEFAULT true, p_erro text DEFAULT NULL, p_total integer DEFAULT NULL,
                               p_distintas integer DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql AS $f$
DECLARE v_run bigint; v_n integer := jsonb_array_length(p_linhas);
BEGIN
  v_run := public.omie_os_sync_abrir('colacor_sc');
  IF v_n > 0 THEN PERFORM public.omie_os_sync_gravar(v_run, p_linhas); END IF;
  RETURN public.omie_os_sync_fechar(v_run, jsonb_build_object('integra', p_integra, 'distintas', coalesce(p_distintas, v_n),
           'total_registros_declarado', coalesce(p_total, v_n), 'paginas', 1, 'lidas', v_n), p_erro);
END $f$;
SQL

echo "── S. aplicação"
eq "S0 migration aplica com a pós-condição" "$(grep -c 'POSCONDICAO omie-os OK' <<<"$APL1")/$(grep -c FALHOU_APLICAR <<<"$APL1")" "1/0"
eq "S1 reaplica (idempotente)" "$(grep -c 'POSCONDICAO omie-os OK' <<<"$APL2")/$(grep -c FALHOU_APLICAR <<<"$APL2")" "1/0"

echo "── A. ACL / RLS"
eq "A1 anon não abre run" "$(E "SET ROLE anon; SELECT omie_os_sync_abrir('colacor_sc')")" "ERRO:42501"
eq "A2 authenticated não fecha run" "$(E "SET ROLE authenticated; SELECT omie_os_sync_fechar(1, '{}', NULL)")" "ERRO:42501"
eq "A3 authenticated não escreve no espelho" "$(E "SET ROLE authenticated; DELETE FROM omie_os_espelho")" "ERRO:42501"
eq "A4 sandbox_exec_* sem INSERT herdado" "$(E "SELECT has_table_privilege('sandbox_exec_x','public.omie_os_espelho','INSERT')")" "f"
eq "A5 claude_ro lê a view e o espelho" "$(E "SELECT has_table_privilege('claude_ro','public.omie_os_abertas_v','SELECT') AND has_table_privilege('claude_ro','public.omie_os_espelho','SELECT')")" "t"
eq "A6 cron :53 com {action:sync}, Vault e timeout" "$(E "SELECT count(*) FROM cron.job WHERE jobname='omie-os-sync-1h' AND schedule='53 * * * *' AND command LIKE '%{\"action\":\"sync\"}%' AND command LIKE '%timeout_milliseconds:=150000%' AND command LIKE '%vault.decrypted_secrets%'")" "1"

echo "── R. runs"
P -q -c "SET ROLE service_role; SELECT t_ciclo(jsonb_build_array(t_linha(1,'461',3545104666), t_linha(2,'0462',77)))" >/dev/null
R1="$(E "SET ROLE service_role; SELECT omie_os_sync_abrir('colacor_sc')")"
eq "R1 service_role abre run" "$( [[ "$R1" =~ ^[0-9]+$ ]] && echo num || echo "$R1")" "num"
eq "R2 2º run concorrente recusado" "$(E "SET ROLE service_role; SELECT omie_os_sync_abrir('colacor_sc')")" "ERRO:55P03"
P -q -c "SET ROLE service_role; SELECT omie_os_sync_gravar($R1, jsonb_build_array(t_linha(9,'9',9)))" >/dev/null
P -q -c "UPDATE omie_os_sync_runs SET iniciado_em = now() - interval '20 minutes' WHERE id = $R1" >/dev/null
R3="$(E "SET ROLE service_role; SELECT omie_os_sync_abrir('colacor_sc')")"
eq "R3 rodando velho vira erro e o staging dele some" \
  "$(E "SELECT status || '/' || (SELECT count(*) FROM omie_os_staging WHERE run_id = $R1) FROM omie_os_sync_runs WHERE id = $R1")" "erro/0"
eq "R4 empresa inválida" "$(E "SET ROLE service_role; SELECT omie_os_sync_abrir('oben')")" "ERRO:22023"

echo "── G. gravar"
eq "G1 gravar em run fechado é recusado" "$(E "SET ROLE service_role; SELECT omie_os_sync_gravar($R1, jsonb_build_array(t_linha(9,'9',9)))")" "ERRO:55000"
eq "G2 n_cod_os ausente/zero/texto recusado" \
  "$(E "SET ROLE service_role; SELECT omie_os_sync_gravar($R3, '[{\"payload\":{}}]')")/$(E "SET ROLE service_role; SELECT omie_os_sync_gravar($R3, '[{\"n_cod_os\":0,\"payload\":{}}]')")/$(E "SET ROLE service_role; SELECT omie_os_sync_gravar($R3, '[{\"n_cod_os\":\"5\",\"payload\":{}}]')")" \
  "ERRO:22023/ERRO:22023/ERRO:22023"
P -q -c "SET ROLE service_role; SELECT omie_os_sync_gravar($R3, jsonb_build_array(t_linha(5,'5',5)))" >/dev/null
eq "G3 n_cod_os repetido no run = erro" "$(E "SET ROLE service_role; SELECT omie_os_sync_gravar($R3, jsonb_build_array(t_linha(5,'5',5)))")" "ERRO:23505"
P -q -c "SET ROLE service_role; SELECT omie_os_sync_fechar($R3, '{\"integra\":false}', 'teste')" >/dev/null

echo "── F. fechar"
eq "F1 run íntegro promove ao espelho" "$(E "SELECT count(*) FROM omie_os_espelho")" "2"
P -q -c "SET ROLE service_role; SELECT t_ciclo(jsonb_build_array(t_linha(1,'461',3545104666, '{\"valor_total\":555}'), t_linha(2,'0462',77), t_linha(3,'3',3)), false)" >/dev/null
eq "F2 edge diz não íntegro: espelho intacto (valor, contagem, ausência)" \
  "$(E "SELECT (SELECT valor_total FROM omie_os_espelho WHERE n_cod_os=1)::int || '/' || (SELECT count(*) FROM omie_os_espelho) || '/' || (SELECT sum(ausencias_integras) FROM omie_os_espelho)")" "100/2/0"
P -q -c "SET ROLE service_role; SELECT t_ciclo(jsonb_build_array(t_linha(1,'461',3545104666, '{\"valor_total\":555}'), t_linha(2,'0462',77)), true, NULL, 3, 3)" >/dev/null
eq "F3 staging ≠ total declarado (a edge afirma 3 = 3): não íntegro pelo banco" "$(E "SELECT (SELECT valor_total FROM omie_os_espelho WHERE n_cod_os=1)::int || '/' || (SELECT integra FROM omie_os_sync_runs ORDER BY id DESC LIMIT 1)")" "100/false"
P -q -c "SET ROLE service_role; SELECT t_ciclo(jsonb_build_array(t_linha(1,'461',3545104666, '{\"valor_total\":555}'), t_linha(2,'0462',77)), true, 'Omie caiu')" >/dev/null
eq "F4 run com erro: não íntegro, status erro" "$(E "SELECT (SELECT valor_total FROM omie_os_espelho WHERE n_cod_os=1)::int || '/' || (SELECT status || ':' || integra FROM omie_os_sync_runs ORDER BY id DESC LIMIT 1)")" "100/erro:false"
P -q -c "SET ROLE service_role; SELECT t_ciclo(jsonb_build_array(t_linha(1,'461',3545104666, '{\"valor_total\":555}'), t_linha(2,'0462',77)))" >/dev/null
eq "F5 íntegro atualiza o valor" "$(E "SELECT valor_total::int FROM omie_os_espelho WHERE n_cod_os=1")" "555"

echo "── U. sumiço (2 varreduras íntegras, 1ª data preservada)"
# run U1: só a OS 1 aparece → OS 2 ganha a 1ª ausência
P -q -c "SET ROLE service_role; SELECT t_ciclo(jsonb_build_array(t_linha(1,'461',3545104666)))" >/dev/null
INI_U1="$(E "SELECT iniciado_em FROM omie_os_sync_runs ORDER BY id DESC LIMIT 1")"
eq "U1 1ª ausência: contada, ainda NÃO ausente" "$(E "SELECT ausencias_integras || '/' || (ausente_desde IS NULL) || '/' || (primeira_ausencia_em = '$INI_U1'::timestamptz) FROM omie_os_espelho WHERE n_cod_os=2")" "1/true/true"
eq "U2 uma varredura íntegra não basta para sumir (a OS segue aberta na view)" "$(E "SELECT count(*) FROM omie_os_abertas_v WHERE n_cod_os=2")" "1"
P -q -c "SET ROLE service_role; SELECT t_ciclo(jsonb_build_array(t_linha(1,'461',3545104666)), false)" >/dev/null
eq "U3 varredura NÃO íntegra não conta ausência" "$(E "SELECT ausencias_integras FROM omie_os_espelho WHERE n_cod_os=2")" "1"
P -q -c "SELECT pg_sleep(0.05)" >/dev/null
P -q -c "SET ROLE service_role; SELECT t_ciclo(jsonb_build_array(t_linha(1,'461',3545104666)))" >/dev/null
eq "U4 2ª íntegra confirma, com a 1ª data de ausência" "$(E "SELECT ausencias_integras || '/' || (ausente_desde = '$INI_U1'::timestamptz) || '/' || (SELECT count(*) FROM omie_os_abertas_v WHERE n_cod_os=2) FROM omie_os_espelho WHERE n_cod_os=2")" "2/true/0"
P -q -c "SET ROLE service_role; SELECT t_ciclo(jsonb_build_array(t_linha(1,'461',3545104666), t_linha(2,'0462',77)))" >/dev/null
eq "U5 reapareceu: ausência zerada" "$(E "SELECT ausencias_integras || '/' || (ausente_desde IS NULL) || '/' || (primeira_ausencia_em IS NULL) FROM omie_os_espelho WHERE n_cod_os=2")" "0/true/true"
eq "U6 nenhuma linha apagada do espelho" "$(E "SELECT count(*) FROM omie_os_espelho")" "2"

echo "── F6. fechar repetido não conta 2ª ausência"
F6RUN="$(E "SET ROLE service_role; SELECT omie_os_sync_abrir('colacor_sc')")"
P -q -c "SET ROLE service_role; SELECT omie_os_sync_gravar($F6RUN, jsonb_build_array(t_linha(1,'461',3545104666)))" >/dev/null
P -q -c "SET ROLE service_role; SELECT omie_os_sync_fechar($F6RUN, '{\"integra\":true,\"distintas\":1,\"total_registros_declarado\":1}', NULL)" >/dev/null
F6B="$(E "SET ROLE service_role; SELECT omie_os_sync_fechar($F6RUN, '{\"integra\":true,\"distintas\":0,\"total_registros_declarado\":0}', NULL) ->> 'status'")"
eq "F6 2º fechar do mesmo run = no-op; OS 2 com 1 ausência só" "$F6B/$(E "SELECT ausencias_integras FROM omie_os_espelho WHERE n_cod_os=2")" "ja_fechado/1"
P -q -c "SET ROLE service_role; SELECT t_ciclo(jsonb_build_array(t_linha(1,'461',3545104666), t_linha(2,'0462',77)))" >/dev/null

echo "── N. ausente ≠ zero"
P -q -c "SET ROLE service_role; SELECT t_ciclo(jsonb_build_array(t_linha(1,'461',3545104666), t_linha(2,'0462',77),
  t_linha(10,'10',10, '{\"valor_total\":null,\"prazo_max_dias\":null,\"n_cod_cli\":\"\",\"faturada\":null,\"data_inclusao\":\"31/02/2026\",\"data_alteracao\":null}'),
  t_linha(11,'11',11, '{\"valor_total\":\"\",\"prazo_max_dias\":\"30\",\"cancelada\":\"N\"}')))" >/dev/null
eq "N1 valor nulo/vazio vira NULL, não 0" "$(E "SELECT coalesce(string_agg(coalesce(valor_total::text,'NULL'), ',' ORDER BY n_cod_os), '') FROM omie_os_espelho WHERE n_cod_os IN (10,11)")" "NULL,NULL"
eq "N2 prazo nulo/texto vira NULL" "$(E "SELECT count(*) FROM omie_os_espelho WHERE n_cod_os IN (10,11) AND prazo_max_dias IS NULL")" "2"
eq "N3 cliente texto vira NULL" "$(E "SELECT n_cod_cli IS NULL FROM omie_os_espelho WHERE n_cod_os=10")" "t"
eq "N4 flag nula/texto vira NULL" "$(E "SELECT (SELECT faturada IS NULL FROM omie_os_espelho WHERE n_cod_os=10) || '/' || (SELECT cancelada IS NULL FROM omie_os_espelho WHERE n_cod_os=11)")" "true/true"
eq "N5 data fora do formato vira NULL" "$(E "SELECT data_inclusao IS NULL FROM omie_os_espelho WHERE n_cod_os=10")" "t"

echo "── V. view das abertas"
eq "V1 flag NULL não é aberta (só faturada IS FALSE AND cancelada IS FALSE)" "$(E "SELECT count(*) FROM omie_os_abertas_v WHERE n_cod_os IN (10,11)")" "0"
eq "V2 idade e dias sem movimento (dias corridos de Brasília)" "$(E "SELECT idade_dias || '/' || dias_sem_movimento FROM omie_os_abertas_v WHERE n_cod_os=1")" "10/4"
P -q -c "SET ROLE service_role; SELECT t_ciclo(jsonb_build_array(t_linha(1,'461',3545104666), t_linha(2,'0462',77), t_linha(12,'12',12, '{\"data_inclusao\":null,\"data_alteracao\":null}')))" >/dev/null
eq "V3 sem data: idade e parada NULL (indeterminado)" "$(E "SELECT (idade_dias IS NULL) || '/' || (dias_sem_movimento IS NULL) FROM omie_os_abertas_v WHERE n_cod_os=12")" "true/true"
P -q -c "SET ROLE service_role; SELECT t_ciclo(jsonb_build_array(t_linha(1,'461',3545104666, '{\"faturada\":true}'), t_linha(2,'0462',77, '{\"cancelada\":true}'), t_linha(12,'12',12)))" >/dev/null
eq "V4 faturada e cancelada saem da view" "$(E "SELECT count(*) FROM omie_os_abertas_v WHERE n_cod_os IN (1,2)")" "0"
eq "V5 RLS: quem vê a SC lê; quem não vê lê 0; staging fechado" \
  "$(E "SET ROLE authenticated; SET request.jwt.claim.sub='00000000-0000-0000-0000-0000000000aa'; SELECT count(*) FROM omie_os_abertas_v")/$(E "SET ROLE authenticated; SET request.jwt.claim.sub='00000000-0000-0000-0000-0000000000bb'; SELECT count(*) FROM omie_os_espelho")/$(E "SET ROLE authenticated; SELECT count(*) FROM omie_os_staging")" \
  "1/0/ERRO:42501"

echo "── E. elo OS → título"
eq "E1 normalização: zeros à esquerda, brancos; vazio, só zeros e não-dígito rejeitados" \
  "$(E "SELECT concat_ws(',', omie_os_numero_normalizado('0461'), omie_os_numero_normalizado(' 461 '), coalesce(omie_os_numero_normalizado(''),'N'), coalesce(omie_os_numero_normalizado('000'),'N'), coalesce(omie_os_numero_normalizado('A461'),'N'), coalesce(omie_os_numero_normalizado(NULL),'N'))")" \
  "461,461,N,N,N,N"
P -q <<'SQL' >/dev/null
INSERT INTO fin_contas_receber (company, omie_codigo_lancamento, omie_codigo_cliente, numero_documento, numero_documento_fiscal, numero_pedido, valor_documento, saldo, status_titulo, id_origem, data_emissao)
VALUES ('colacor_sc', 5001, 3545104666, 'RPS 278', '302', '0461', 132, 0, 'RECEBIDO', 'VENR', '2025-12-19'),
       ('colacor_sc', 5002, 99, 'RPS 279', '303', '461', 50, 0, 'RECEBIDO', 'VENR', '2025-12-19'),
       ('colacor_sc', 5003, 77, 'RPS 280', '304', '', 50, 0, 'RECEBIDO', 'VENR', '2025-12-19');
SQL
MED="$(P -X -U postgres -c "SET ROLE claude_ro" -f "$MEDIR" 2>&1 || echo "MEDIR_FALHOU")"
eq "E2 medição roda inteira como claude_ro" "$(grep -c 'FIM_OK' <<<"$MED")/$(grep -c 'MEDIR_FALHOU\|ERROR' <<<"$MED")" "1/0"
eq "E3 OS 461 casa com o VENR do MESMO cliente (o de outro cliente não)" \
  "$(E "SELECT count(*) FROM omie_os_espelho e JOIN fin_contas_receber f ON f.company=e.company AND f.id_origem='VENR' AND f.omie_codigo_cliente=e.n_cod_cli AND omie_os_numero_normalizado(f.numero_pedido)=omie_os_numero_normalizado(e.c_num_os) WHERE e.n_cod_os=1")" "1"

echo "PASS=$PASS  FAIL=$FAIL"
echo "RESULTADO: $PASS ok / $FAIL fail (locale $LOC)"
[ "$FAIL" -eq 0 ]
echo "PROVA-OMIE-OS-SYNC-OK"
