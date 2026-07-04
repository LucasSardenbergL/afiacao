#!/usr/bin/env bash
# ╔══════════════════════════════════════════════════════════════════════════════╗
# ║  PROVA PG17 — 20260704160000_fin_sync_watchdog_retry_sem_efeito.sql            ║
# ║  Sentinela: check "retry sem efeito" no fin_sync_watchdog_check (money-path).  ║
# ║  Rode:  bash db/test-fin-sync-watchdog-retry-sem-efeito.sh >/tmp/t.log 2>&1; echo $?  ║
# ║                                                                                ║
# ║  Prova:                                                                        ║
# ║   • GUARD md5: base local == md5 de prod (guard exercitado contra estado real).║
# ║   • ROBUSTEZ DE ORDEM: sem a tabela fin_sync_kick_retry (esta migration        ║
# ║     aplicada ANTES da 20260704102000) o watchdog NÃO quebra (to_regclass) e os ║
# ║     outros checks (sync_stale) seguem funcionando.                             ║
# ║   • POSITIVOS: retry morto alerta; retry com efeito não; grace 15min; dismiss  ║
# ║     ao resolver; correlação temporal/company/resource.                         ║
# ║   • FALSIFICAÇÃO: sabota to_regclass / grace / correlação-temporal / NOT       ║
# ║     EXISTS(log) → exige VERMELHO → restaura.                                    ║
# ╚══════════════════════════════════════════════════════════════════════════════╝
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PGVER=17
PGBIN="/opt/homebrew/opt/postgresql@${PGVER}/bin"
PORT="${PGPORT_TEST:-5459}"
SLUG="fin_sync_wd_retry"
DATA="$(mktemp -d "/tmp/pgtest-${SLUG}.XXXXXX")/data"
export LC_ALL=C LANG=C
MD5_BASE="7d0eccbd0a9764476da50b0952a2f9e3"   # md5 do fin_sync_watchdog_check VIVO em prod (2026-07-04) — o mesmo do guard

[ -x "$PGBIN/initdb" ] || { echo "postgresql@${PGVER} ausente: brew install postgresql@${PGVER} pgvector"; exit 1; }

CELLAR="$(brew --prefix "postgresql@${PGVER}")"
cp -Rn "$CELLAR"/share/postgresql/. "/opt/homebrew/share/postgresql@${PGVER}/" 2>/dev/null || true
mkdir -p "/opt/homebrew/lib/postgresql@${PGVER}"
cp -Rn "$CELLAR"/lib/postgresql/. "/opt/homebrew/lib/postgresql@${PGVER}/" 2>/dev/null || true

cleanup() { "$PGBIN/pg_ctl" -D "$DATA" stop -m immediate >/dev/null 2>&1 || true; rm -rf "$(dirname "$DATA")"; }
trap cleanup EXIT

"$PGBIN/initdb" -D "$DATA" -U postgres -E UTF8 --locale=C >/dev/null
"$PGBIN/pg_ctl" -D "$DATA" -o "-p $PORT -k /tmp" -l "/tmp/pg-${SLUG}.log" -w start >/dev/null
"$PGBIN/createdb" -p "$PORT" -h /tmp -U postgres prove
P()  { "$PGBIN/psql" -p "$PORT" -h /tmp -U postgres -d prove -v ON_ERROR_STOP=1 "$@"; }
Pq() { P -tA "$@"; }

PASS=0; FAIL=0
ok()  { PASS=$((PASS+1)); echo "  ✅ $1"; }
bad() { FAIL=$((FAIL+1)); echo "  ❌ $1"; }
eq()  { if [ "$2" = "$3" ]; then ok "$1 (=$2)"; else bad "$1 — esperado [$3], veio [$2]"; fi; }

echo "═══ setup PG17 :$PORT ═══"

# ══════════════════════════════════════════════════════════════════════════════
# ZONA 1 — PRÉ-REQUISITOS (tabelas que a função LÊ/ESCREVE) + FUNÇÃO BASE de prod
# ══════════════════════════════════════════════════════════════════════════════
# NÃO cria fin_sync_kick_retry ainda: R1/R2 provam robustez de ordem (esta migration
# aplicada ANTES da 20260704102000, sem a tabela).
P -q <<'SQL'
CREATE TABLE public.fin_sync_log (
  id uuid DEFAULT gen_random_uuid(), action text, companies text[], status text,
  error_message text, started_at timestamptz, completed_at timestamptz
);
CREATE TABLE public.fin_sync_cursor (
  company text, resource text, next_page int, updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (company, resource)
);
CREATE TABLE public.fin_alertas (
  id uuid DEFAULT gen_random_uuid(), company text NOT NULL CHECK (company IN ('oben','colacor','colacor_sc')),
  tipo text NOT NULL, severidade text NOT NULL CHECK (severidade IN ('info','aviso','critico')),
  mensagem text NOT NULL, contexto jsonb, criado_em timestamptz NOT NULL DEFAULT now(),
  dismissed_at timestamptz, email_enfileirado_em timestamptz
);
CREATE UNIQUE INDEX fin_alertas_unique_ativo ON public.fin_alertas (company, tipo) WHERE dismissed_at IS NULL;
CREATE TABLE public.fornecedor_alerta (
  id bigserial PRIMARY KEY, empresa text NOT NULL, tipo text NOT NULL CHECK (tipo IN ('outro')),
  severidade text NOT NULL CHECK (severidade IN ('info','atencao','urgente')),
  titulo text NOT NULL, mensagem text, status text CHECK (status IN ('pendente_notificacao','notificado','falha_notificacao','ignorado'))
);
SQL

# FUNÇÃO BASE: corpo VERBATIM do pg_get_functiondef de prod (md5 7d0eccbd...). O guard da
# migration compara md5(pg_get_functiondef(...)) contra este — a base local tem de reproduzi-lo.
P -q <<'SQL'
CREATE OR REPLACE FUNCTION public.fin_sync_watchdog_check()
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_companies text[] := ARRAY['oben','colacor','colacor_sc'];
  v_resources text[] := ARRAY['contas_pagar','contas_receber','movimentacoes'];
  v_stale_hours  int := 18;
  v_error_hours  int := 6;
  v_cursor_hours int := 2;
  v_grace_mins   int := 40;
  c text;
  v_stale text[];
  v_errs  text[];
  v_stuck text[];
  v_msg text;
BEGIN
  UPDATE fin_sync_log
  SET status        = 'error',
      error_message = 'orphaned_running_timeout',
      completed_at  = CASE WHEN started_at > now() - make_interval(hours => v_error_hours)
                           THEN now() ELSE started_at END
  WHERE status = 'running'
    AND action LIKE 'sync_%'
    AND started_at < now() - interval '30 minutes';

  FOREACH c IN ARRAY v_companies LOOP
    SELECT array_agg(r ORDER BY r) INTO v_stale
    FROM unnest(v_resources) AS r
    WHERE EXISTS (
      SELECT 1 FROM fin_sync_log l
      WHERE l.status='complete' AND l.action='sync_'||r AND c = ANY(l.companies)
        AND l.completed_at > now() - interval '7 days')
      AND NOT EXISTS (
      SELECT 1 FROM fin_sync_log l
      WHERE l.status='complete' AND l.action='sync_'||r AND c = ANY(l.companies)
        AND l.completed_at > now() - make_interval(hours => v_stale_hours));
    IF v_stale IS NOT NULL THEN
      v_msg := 'Sync sem conclusão há >'||v_stale_hours||'h: '||array_to_string(v_stale, ', ');
      INSERT INTO fin_alertas (company, tipo, severidade, mensagem, contexto)
      VALUES (c, 'sync_stale', 'critico', v_msg,
              jsonb_build_object('recursos', v_stale, 'janela_horas', v_stale_hours))
      ON CONFLICT (company, tipo) WHERE dismissed_at IS NULL DO NOTHING;
      UPDATE fin_alertas
      SET email_enfileirado_em = now()
      WHERE company = c AND tipo = 'sync_stale'
        AND dismissed_at IS NULL
        AND email_enfileirado_em IS NULL
        AND criado_em <= now() - make_interval(mins => v_grace_mins);
      IF FOUND THEN
        INSERT INTO fornecedor_alerta (empresa, tipo, severidade, titulo, mensagem, status)
        VALUES (c, 'outro', 'urgente', '[Sync parado] '||upper(c), v_msg, 'pendente_notificacao');
      END IF;
    ELSE
      UPDATE fin_alertas SET dismissed_at = now()
      WHERE company = c AND tipo = 'sync_stale' AND dismissed_at IS NULL;
    END IF;

    WITH terminal AS (
      SELECT l.action, l.status, l.started_at
      FROM fin_sync_log l
      WHERE l.action LIKE 'sync_%'
        AND c = ANY(l.companies)
        AND l.status IN ('complete','error')
        AND l.started_at > now() - interval '24 hours'
    ),
    latest AS (
      SELECT DISTINCT ON (action) action, status, started_at
      FROM terminal
      ORDER BY action, started_at DESC
    )
    SELECT array_agg(lt.action ORDER BY lt.action) INTO v_errs
    FROM latest lt
    WHERE lt.status = 'error'
      AND lt.started_at > now() - interval '3 hours'
      AND (
        SELECT count(*) FROM terminal t
        WHERE t.action = lt.action
          AND t.status = 'error'
          AND t.started_at <= lt.started_at
          AND NOT EXISTS (
            SELECT 1 FROM terminal cpl
            WHERE cpl.action = lt.action
              AND cpl.status = 'complete'
              AND cpl.started_at > t.started_at
              AND cpl.started_at <= lt.started_at
          )
      ) >= 2;
    IF v_errs IS NOT NULL THEN
      v_msg := 'Sync falhando agora (run mais recente em erro, >=2 consecutivos): '||array_to_string(v_errs, ', ');
      INSERT INTO fin_alertas (company, tipo, severidade, mensagem, contexto)
      VALUES (c, 'sync_error', 'critico', v_msg, jsonb_build_object('actions', v_errs))
      ON CONFLICT (company, tipo) WHERE dismissed_at IS NULL DO NOTHING;
      IF FOUND THEN
        INSERT INTO fornecedor_alerta (empresa, tipo, severidade, titulo, mensagem, status)
        VALUES (c, 'outro', 'urgente', '[Sync erro] '||upper(c), v_msg, 'pendente_notificacao');
      END IF;
    ELSE
      UPDATE fin_alertas SET dismissed_at = now()
      WHERE company = c AND tipo = 'sync_error' AND dismissed_at IS NULL;
    END IF;

    SELECT array_agg(resource ORDER BY resource) INTO v_stuck
    FROM fin_sync_cursor
    WHERE company = c AND next_page IS NOT NULL
      AND updated_at < now() - make_interval(hours => v_cursor_hours);
    IF v_stuck IS NOT NULL THEN
      v_msg := 'Cursor de continuação travado há >'||v_cursor_hours||'h: '||array_to_string(v_stuck, ', ');
      INSERT INTO fin_alertas (company, tipo, severidade, mensagem, contexto)
      VALUES (c, 'sync_cursor_stuck', 'aviso', v_msg, jsonb_build_object('recursos', v_stuck))
      ON CONFLICT (company, tipo) WHERE dismissed_at IS NULL DO NOTHING;
      IF FOUND THEN
        INSERT INTO fornecedor_alerta (empresa, tipo, severidade, titulo, mensagem, status)
        VALUES (c, 'outro', 'atencao', '[Sync cursor] '||upper(c), v_msg, 'pendente_notificacao');
      END IF;
    ELSE
      UPDATE fin_alertas SET dismissed_at = now()
      WHERE company = c AND tipo = 'sync_cursor_stuck' AND dismissed_at IS NULL;
    END IF;
  END LOOP;
END;
$function$;
SQL
echo "pré-requisitos + função base ok"

# S0 — a base local reproduz o md5 de prod (senão o guard da migration não seria exercitado real)
eq "S0 md5(base local) == md5 de prod ($MD5_BASE)" \
   "$(Pq -c "SELECT md5(pg_get_functiondef('public.fin_sync_watchdog_check()'::regprocedure));")" "$MD5_BASE"

# ══════════════════════════════════════════════════════════════════════════════
# ZONA 2 — APLICAR A MIGRATION REAL (guard vê md5==base → recria com o check)
# ══════════════════════════════════════════════════════════════════════════════
MIG="$REPO_ROOT/supabase/migrations/20260704160000_fin_sync_watchdog_retry_sem_efeito.sql"
P -q -f "$MIG"
echo "migration aplicada: $(basename "$MIG")"

# L0 late-bound: a função EXECUTA (CREATE passar não basta) + contém a marca
Pq -c "SELECT public.fin_sync_watchdog_check();" >/dev/null && ok "L0 fin_sync_watchdog_check executa (não só CREATE)"
eq "L1 função contém o check retry_sem_efeito" \
   "$(Pq -c "SELECT (pg_get_functiondef('public.fin_sync_watchdog_check()'::regprocedure) LIKE '%sync_retry_sem_efeito%')::text;")" "true"

# helpers de cenário
reset()  { P -q -c "TRUNCATE public.fin_sync_log, public.fin_sync_cursor, public.fin_alertas, public.fornecedor_alerta RESTART IDENTITY;"; }
run()    { P -q -c "SELECT public.fin_sync_watchdog_check();" >/dev/null; }
at()     { Pq -c "SELECT count(*) FROM public.fin_alertas WHERE tipo='$1' AND company='$2' AND dismissed_at IS NULL;"; }
forn()   { Pq -c "SELECT count(*) FROM public.fornecedor_alerta WHERE titulo LIKE '$1%';"; }

# ══════════════════════════════════════════════════════════════════════════════
# ROBUSTEZ DE ORDEM — SEM a tabela fin_sync_kick_retry (guard to_regclass)
# ══════════════════════════════════════════════════════════════════════════════
echo "── robustez de ordem (tabela AUSENTE — esta migration antes da 20260704102000) ──"
reset
Pq -c "SELECT public.fin_sync_watchdog_check();" >/dev/null && ok "R1 watchdog roda SEM erro sem a tabela (não derruba o Sentinela)"

# R2 — o resto do watchdog (sync_stale) segue funcionando sem a tabela
reset
P -q -c "INSERT INTO public.fin_sync_log(action,companies,status,completed_at)
         VALUES ('sync_contas_pagar', ARRAY['oben'], 'complete', now() - interval '20 hours');"
run
eq "R2 sync_stale detectado mesmo sem a tabela" "$(at sync_stale oben)" "1"

# ══════════════════════════════════════════════════════════════════════════════
# cria a tabela (schema da 20260704102000) — daqui pra frente o check está ativo
# ══════════════════════════════════════════════════════════════════════════════
P -q <<'SQL'
CREATE TABLE public.fin_sync_kick_retry (
  company text NOT NULL,
  resource text NOT NULL CHECK (resource IN ('contas_pagar','contas_receber','movimentacoes')),
  janela timestamptz NOT NULL,
  attempted_at timestamptz NOT NULL DEFAULT now(),
  request_id bigint,
  PRIMARY KEY (company, resource, janela)
);
SQL
reset2() { P -q -c "TRUNCATE public.fin_sync_log, public.fin_sync_cursor, public.fin_alertas, public.fornecedor_alerta, public.fin_sync_kick_retry RESTART IDENTITY;"; }
# retry(company, resource, mins_atras) — janela única derivada de mins
retry()  { P -q -c "INSERT INTO public.fin_sync_kick_retry(company,resource,janela,attempted_at)
                    VALUES ('$1','$2', now() - make_interval(mins => $3 + 30), now() - make_interval(mins => $3));"; }
# logrow(action_resource, company, status, started_mins_atras)
logrow() { P -q -c "INSERT INTO public.fin_sync_log(action,companies,status,started_at)
                    VALUES ('sync_$1', ARRAY['$2'], '$3', now() - make_interval(mins => $4));"; }

# ══════════════════════════════════════════════════════════════════════════════
# POSITIVOS
# ══════════════════════════════════════════════════════════════════════════════
echo "── positivos (retry sem efeito) ──"

# P1 retry morto puro (attempted 20min atrás, sem log) → alerta AVISO + fornecedor_alerta
reset2; retry oben contas_pagar 20; run
eq "P1 retry morto → alerta sync_retry_sem_efeito" "$(at sync_retry_sem_efeito oben)" "1"
eq "P1 fornecedor_alerta '[Sync retry]' enfileirado" "$(forn '[Sync retry]')" "1"
eq "P1 severidade=aviso" "$(Pq -c "SELECT severidade FROM public.fin_alertas WHERE tipo='sync_retry_sem_efeito' AND company='oben';")" "aviso"

# P2 retry COM efeito (log started_at pós-attempted) → SEM alerta
reset2; retry oben contas_pagar 20; logrow contas_pagar oben running 19; run
eq "P2 retry com efeito (running pós-attempted) → sem alerta" "$(at sync_retry_sem_efeito oben)" "0"

# P3 retry recente dentro do grace (5min < 15min) → SEM alerta
reset2; retry oben contas_pagar 5; run
eq "P3 retry recente (<15min grace) → sem alerta" "$(at sync_retry_sem_efeito oben)" "0"

# P4 dismiss ao resolver: P1 vira alerta; depois o sync roda (log pós-attempted) → dismiss
reset2; retry oben contas_pagar 20; run
eq "P4a alerta ativo antes de resolver" "$(at sync_retry_sem_efeito oben)" "1"
logrow contas_pagar oben complete 1; run
eq "P4b alerta dismissado após sync rodar" "$(at sync_retry_sem_efeito oben)" "0"

# P5 log ANTIGO (started_at < attempted) NÃO mascara → alerta (o sinal tem de ser PÓS-retry)
reset2; retry oben contas_pagar 20; logrow contas_pagar oben complete 40; run
eq "P5 log pré-retry não mascara → alerta" "$(at sync_retry_sem_efeito oben)" "1"

# P6 correlação por COMPANY: log de colacor não mascara retry de oben
reset2; retry oben contas_pagar 20; logrow contas_pagar colacor running 19; run
eq "P6 log de outra company não mascara" "$(at sync_retry_sem_efeito oben)" "1"

# P7 correlação por RESOURCE: log de movimentacoes não mascara retry de contas_pagar
reset2; retry oben contas_pagar 20; logrow movimentacoes oben running 19; run
eq "P7 log de outro resource não mascara" "$(at sync_retry_sem_efeito oben)" "1"

# ══════════════════════════════════════════════════════════════════════════════
# FALSIFICAÇÃO — sabota a migration (sed âncora única) → exige VERMELHO → restaura
# ══════════════════════════════════════════════════════════════════════════════
echo "── falsificação (cada guard/predicado tem dente?) ──"
MUT="/tmp/mig-mut-${SLUG}.sql"
aplica_mut() {  # $1 = expr sed; garante que a mutação REALMENTE alterou o arquivo (anti-teatro)
  sed "$1" "$MIG" > "$MUT"
  if diff -q "$MIG" "$MUT" >/dev/null; then bad "SABOTAGEM NÃO CASOU (âncora mudou?): $1"; return 1; fi
  P -q -f "$MUT" >/dev/null
}
restaura() { P -q -f "$MIG" >/dev/null; }   # guard aceita re-run (marca presente)
cria_tabela() { P -q -c "CREATE TABLE IF NOT EXISTS public.fin_sync_kick_retry (company text NOT NULL, resource text NOT NULL, janela timestamptz NOT NULL, attempted_at timestamptz NOT NULL DEFAULT now(), request_id bigint, PRIMARY KEY (company,resource,janela));"; }

# F1 — guard to_regclass tem dente: sem ele (IF true), sem a tabela o watchdog QUEBRA
reset2
aplica_mut "s@IF to_regclass('public.fin_sync_kick_retry') IS NOT NULL THEN@IF true THEN@"
P -q -c "DROP TABLE public.fin_sync_kick_retry;"
if Pq -c "SELECT public.fin_sync_watchdog_check();" >/dev/null 2>/tmp/f1.err; then
  bad "F1 sabotei o to_regclass e sem a tabela NÃO quebrou → guard não provado"
else
  ok "F1 sem to_regclass + sem tabela → watchdog erra (guard de ordem tem dente)"
fi
cria_tabela; restaura

# F2 — grace tem dente: sem ele (now()+60), o retry recente (5min) vira alerta
reset2; retry oben contas_pagar 5
aplica_mut "s@rk.attempted_at < now() - make_interval(mins => v_retry_dead_mins)@rk.attempted_at < now() + make_interval(mins => 60)@"
run
V=$(at sync_retry_sem_efeito oben)
[ "$V" = "1" ] && ok "F2 grace furado → retry recente alerta (P3 tem dente)" || bad "F2 sabotei o grace e P3 não mudou (veio $V) → fraco"
restaura

# F3 — correlação temporal tem dente: com started_at>=epoch, log ANTIGO passa a mascarar
reset2; retry oben contas_pagar 20; logrow contas_pagar oben complete 40
aplica_mut "s@AND l.started_at >= rk.attempted_at@AND l.started_at >= '1970-01-01'::timestamptz@"
run
V=$(at sync_retry_sem_efeito oben)
[ "$V" = "0" ] && ok "F3 correlação temporal furada → log antigo mascara (P5 tem dente)" || bad "F3 sabotei a correlação e P5 não mudou (veio $V) → fraco"
restaura

# F4 — NOT EXISTS(log) tem dente: com action que nunca casa, retry COM efeito vira alerta
reset2; retry oben contas_pagar 20; logrow contas_pagar oben running 19
aplica_mut "s@l.action = 'sync_' || rk.resource@l.action = 'NUNCA_CASA_xyz'@"
run
V=$(at sync_retry_sem_efeito oben)
[ "$V" = "1" ] && ok "F4 NOT EXISTS(log) furado → retry com efeito alerta (P2 tem dente)" || bad "F4 sabotei o NOT EXISTS e P2 não mudou (veio $V) → fraco"
restaura

# sanidade pós-restore: a função real voltou (P2 volta a não alertar)
reset2; retry oben contas_pagar 20; logrow contas_pagar oben running 19; run
eq "F5 pós-restore a lógica real voltou (P2 de novo sem alerta)" "$(at sync_retry_sem_efeito oben)" "0"

# ══════════════════════════════════════════════════════════════════════════════
# GUARD anti-drift + anti-rollback (marca VERSIONADA — achado Codex [P1])
# ══════════════════════════════════════════════════════════════════════════════
echo "── guard: anti-drift + anti-rollback por marca versionada ──"
# corpo alienígena/sucessora mínimo (md5 != base); parametriza o comentário-marca
falsa_funcao() { P -q -c "CREATE OR REPLACE FUNCTION public.fin_sync_watchdog_check() RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public','pg_temp' AS \$fn\$ BEGIN /* $1 */ PERFORM 1; END \$fn\$;"; }
aplica_espera_abort() { if P -q -f "$MIG" >/dev/null 2>/tmp/guarderr-${SLUG}.log; then bad "$1 — guard NÃO abortou (aplicou sobre estado errado!)"; else ok "$1 — guard abortou (exit≠0)"; fi; }

# G3 idempotência: função já é a minha (F5 deixou 'guard v1') → re-aplicar PASSA
if P -q -f "$MIG" >/dev/null 2>&1; then ok "G3 re-run idempotente (marca v1 presente → guard passa)"; else bad "G3 re-run abortou indevidamente"; fi
eq "G3 marca versionada presente no corpo" \
   "$(Pq -c "SELECT (pg_get_functiondef('public.fin_sync_watchdog_check()'::regprocedure) LIKE '%retry_sem_efeito guard v1%')::text;")" "true"

# G1 anti-drift: base ALIENÍGENA (md5≠base, sem marca) → migration ABORTA
falsa_funcao "funcao de outra sessao qualquer"
aplica_espera_abort "G1 base alienígena (md5≠base, sem marca)"

# G2 anti-rollback [P1]: SUCESSORA (marca v2, sem v1, md5≠base) → migration ABORTA
#   (prova que re-rodar ESTA sobre uma sucessora NÃO a reverte silenciosamente)
falsa_funcao "retry_sem_efeito guard v2 — versao futura hipotetica"
aplica_espera_abort "G2 sucessora com marca v2 → não reverte (anti-rollback)"
# confirma que a sucessora v2 continua intacta (o rollback silencioso NÃO ocorreu)
eq "G2 sucessora preservada (guard não sobrescreveu)" \
   "$(Pq -c "SELECT (pg_get_functiondef('public.fin_sync_watchdog_check()'::regprocedure) LIKE '%guard v2%')::text;")" "true"

echo "──────────────────────────────"
echo "RESULTADO: $PASS ok / $FAIL fail"
[ "$FAIL" = "0" ] || { echo "❌ HARNESS VERMELHO"; exit 1; }
echo "✅ HARNESS VERDE"
