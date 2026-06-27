#!/usr/bin/env bash
# ╔══════════════════════════════════════════════════════════════════════════════╗
# ║  HARNESS PG17 — PROVA: fin_sync_watchdog_check() reage às NOVAS actions        ║
# ║  sync_nfes_recebidas / sync_sku_items (edges omie-sync-*) sem falso alarme.    ║
# ║  A FUNÇÃO NÃO foi modificada — provamos que o comportamento EXISTENTE já       ║
# ║  cobre as novas actions corretamente.                                          ║
# ║                                                                                ║
# ║  Rode:  bash db/test-watchdog-novas-actions.sh > /tmp/t.log 2>&1; echo $?      ║
# ║  Lei de Ferro: 1) aplica o corpo REAL da prod  2) negativo c/ sentinela        ║
# ║                3) FALSIFICAÇÃO (sabota → exige vermelho → restaura).           ║
# ╚══════════════════════════════════════════════════════════════════════════════╝
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PGVER=17
PGBIN="/opt/homebrew/opt/postgresql@${PGVER}/bin"
PORT="${PGPORT_TEST:-5466}"
SLUG="watchdog-novas-actions"
DATA="$(mktemp -d "/tmp/pgtest-${SLUG}.XXXXXX")/data"
export LC_ALL=C LANG=C

# Corpo REAL da função, extraído do snapshot VERSIONADO (auto-contido, fiel ao repo —
# sem dependência de scratchpad efêmero). pg_dump escreve `CREATE FUNCTION ... AS $$ ... $$;`,
# aplicável direto num PG vazio. O drift snapshot×prod foi conferido no momento da prova.
FN_SQL="$(mktemp "/tmp/fn-${SLUG}.XXXXXX.sql")"
# sed: pg_dump emite `CREATE FUNCTION`; a falsificação re-aplica → precisa de OR REPLACE.
awk '/^CREATE FUNCTION public\.fin_sync_watchdog_check\(\)/{f=1} f{print} f&&/^\$\$;/{exit}' \
  "$REPO_ROOT/supabase/schema-snapshot.sql" \
  | sed '1s/^CREATE FUNCTION/CREATE OR REPLACE FUNCTION/' > "$FN_SQL"
[ -s "$FN_SQL" ] || { echo "fin_sync_watchdog_check não achada no snapshot"; exit 1; }

[ -x "$PGBIN/initdb" ] || { echo "postgresql@${PGVER} ausente: brew install postgresql@${PGVER}"; exit 1; }

CELLAR="$(brew --prefix "postgresql@${PGVER}")"
cp -Rn "$CELLAR"/share/postgresql/. "/opt/homebrew/share/postgresql@${PGVER}/" 2>/dev/null || true
mkdir -p "/opt/homebrew/lib/postgresql@${PGVER}"
cp -Rn "$CELLAR"/lib/postgresql/. "/opt/homebrew/lib/postgresql@${PGVER}/" 2>/dev/null || true

cleanup() { "$PGBIN/pg_ctl" -D "$DATA" stop -m immediate >/dev/null 2>&1 || true; rm -rf "$(dirname "$DATA")"; rm -f "$FN_SQL"; }
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

echo "═══ setup pronto (PG17 :$PORT) ═══"

# ══════════════════════════════════════════════════════════════════════════════
# ZONA 1 — PRÉ-REQUISITOS DE SCHEMA (mínimo: as 4 tabelas que a função lê/escreve)
#   DDLs reais do supabase/schema-snapshot.sql; CRÍTICO: o índice ÚNICO PARCIAL
#   fin_alertas_unique_ativo é o alvo do ON CONFLICT (company, tipo) WHERE dismissed_at IS NULL.
#   NÃO recrio o trigger trg_audit (ambiental, não faz parte da função sob teste).
# ══════════════════════════════════════════════════════════════════════════════
P -q <<'SQL'
CREATE TABLE public.fin_sync_log (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    action text NOT NULL,
    companies text[],
    status text DEFAULT 'running'::text,
    results jsonb DEFAULT '{}'::jsonb,
    error_message text,
    triggered_by text DEFAULT 'manual'::text,
    started_at timestamp with time zone DEFAULT now(),
    completed_at timestamp with time zone,
    CONSTRAINT fin_sync_log_status_check CHECK ((status = ANY (ARRAY['running'::text, 'complete'::text, 'error'::text])))
);

CREATE TABLE public.fin_alertas (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    company text NOT NULL,
    tipo text NOT NULL,
    severidade text NOT NULL,
    mensagem text NOT NULL,
    contexto jsonb,
    criado_em timestamp with time zone DEFAULT now() NOT NULL,
    dismissed_at timestamp with time zone,
    email_enfileirado_em timestamp with time zone,
    CONSTRAINT fin_alertas_company_check CHECK ((company = ANY (ARRAY['oben'::text, 'colacor'::text, 'colacor_sc'::text]))),
    CONSTRAINT fin_alertas_severidade_check CHECK ((severidade = ANY (ARRAY['info'::text, 'aviso'::text, 'critico'::text])))
);
-- ÍNDICE ÚNICO PARCIAL — alvo do ON CONFLICT (company, tipo) WHERE dismissed_at IS NULL
CREATE UNIQUE INDEX fin_alertas_unique_ativo ON public.fin_alertas USING btree (company, tipo) WHERE (dismissed_at IS NULL);

CREATE TABLE public.fornecedor_alerta (
    id bigint GENERATED ALWAYS AS IDENTITY,
    empresa text NOT NULL,
    tipo text NOT NULL,
    severidade text DEFAULT 'info'::text NOT NULL,
    titulo text NOT NULL,
    mensagem text,
    status text DEFAULT 'pendente_notificacao'::text,
    criado_em timestamp with time zone DEFAULT now(),
    CONSTRAINT fornecedor_alerta_severidade_check CHECK ((severidade = ANY (ARRAY['info'::text, 'atencao'::text, 'urgente'::text]))),
    CONSTRAINT fornecedor_alerta_status_check CHECK ((status = ANY (ARRAY['pendente_notificacao'::text, 'notificado'::text, 'falha_notificacao'::text, 'ignorado'::text]))),
    CONSTRAINT fornecedor_alerta_tipo_check CHECK ((tipo = ANY (ARRAY['promocao_suspensa'::text, 'aumento_anunciado'::text, 'promocao_nova'::text, 'polling_erro'::text, 'mapeamento_pendente'::text, 'oportunidade_calculada'::text, 'tarefa_atrasada'::text, 'whatsapp_sla'::text, 'erro_app'::text, 'outro'::text, 'param_auto_resumo'::text, 'reposicao_pedido_minimo'::text])))
);

CREATE TABLE public.fin_sync_cursor (
    company text NOT NULL,
    resource text NOT NULL,
    next_page integer,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT fin_sync_cursor_resource_check CHECK ((resource = ANY (ARRAY['contas_pagar'::text, 'contas_receber'::text, 'movimentacoes'::text])))
);
SQL
echo "pré-requisitos (4 tabelas + índice parcial) criados"

# ══════════════════════════════════════════════════════════════════════════════
# ZONA 2 — APLICAR A FUNÇÃO REAL (Lei #1: o corpo da prod, não um stub)
# ══════════════════════════════════════════════════════════════════════════════
P -q -f "$FN_SQL"
echo "função REAL aplicada: public.fin_sync_watchdog_check()"
# prova que a função existe com o corpo certo (não um stub)
HASCORE=$(Pq -c "SELECT (position('orphaned_running_timeout' in pg_get_functiondef('public.fin_sync_watchdog_check()'::regprocedure))>0)::int;")
eq "A0 corpo real carregado (cita orphaned_running_timeout)" "$HASCORE" "1"

# helper: zera o estado entre cenários (mantém schema)
reset() { P -q -c "TRUNCATE public.fin_sync_log, public.fin_alertas, public.fornecedor_alerta, public.fin_sync_cursor;" >/dev/null; }

# ══════════════════════════════════════════════════════════════════════════════
# ASSERÇÃO 1 — sync_error PEGA nfes
#   última run de sync_nfes_recebidas em 'error', >=2 errors consecutivos (sem complete entre),
#   última < 3h, companies=['oben'] -> cria fin_alertas (oben, sync_error, ativo) citando a action.
# ══════════════════════════════════════════════════════════════════════════════
echo "── Asserção 1: sync_error pega nfes ──"
reset
P -q <<'SQL'
-- 2 errors consecutivos, o mais recente < 3h (started_at), nenhum 'complete' entre eles
INSERT INTO public.fin_sync_log (action, companies, status, started_at, completed_at) VALUES
  ('sync_nfes_recebidas', ARRAY['oben'], 'error', now() - interval '2 hours 30 minutes', now() - interval '2 hours 25 minutes'),
  ('sync_nfes_recebidas', ARRAY['oben'], 'error', now() - interval '1 hour',           now() - interval '55 minutes');
SQL
# pré-condição: confirmo que SEM rodar a função NÃO há alerta (senão o teste não exercita o ramo)
PRE=$(Pq -c "SELECT count(*) FROM public.fin_alertas WHERE company='oben' AND tipo='sync_error' AND dismissed_at IS NULL;")
eq "A1.pre nenhum alerta antes de rodar" "$PRE" "0"
Pq -c "SELECT public.fin_sync_watchdog_check();" >/dev/null
A1=$(Pq -c "SELECT count(*) FROM public.fin_alertas WHERE company='oben' AND tipo='sync_error' AND dismissed_at IS NULL AND mensagem ILIKE '%sync_nfes_recebidas%';")
eq "A1 alerta sync_error ativo (oben) citando sync_nfes_recebidas" "$A1" "1"
# e gerou a notificação acoplada em fornecedor_alerta
A1F=$(Pq -c "SELECT count(*) FROM public.fornecedor_alerta WHERE empresa='oben' AND titulo ILIKE '[Sync erro]%';")
eq "A1.b fornecedor_alerta enfileirado" "$A1F" "1"

# ══════════════════════════════════════════════════════════════════════════════
# ASSERÇÃO 2 — 'complete' NÃO alarma (e dismissa alerta prévio)  [base p/ falsificação]
#   última run de sync_nfes_recebidas = 'complete' -> NÃO deve haver sync_error ativo,
#   e um alerta sync_error prévio deve ser DISMISSADO pela função.
# ══════════════════════════════════════════════════════════════════════════════
echo "── Asserção 2: complete não alarma + dismissa prévio ──"
reset
P -q <<'SQL'
-- alerta sync_error pré-existente (de um episódio anterior), AINDA ativo
INSERT INTO public.fin_alertas (company, tipo, severidade, mensagem, dismissed_at)
VALUES ('oben', 'sync_error', 'critico', 'episódio anterior sync_nfes_recebidas', NULL);
-- histórico: 2 errors e DEPOIS um complete (a run mais recente é o complete)
INSERT INTO public.fin_sync_log (action, companies, status, started_at, completed_at) VALUES
  ('sync_nfes_recebidas', ARRAY['oben'], 'error',    now() - interval '3 hours', now() - interval '2 hours 55 minutes'),
  ('sync_nfes_recebidas', ARRAY['oben'], 'error',    now() - interval '2 hours', now() - interval '1 hour 55 minutes'),
  ('sync_nfes_recebidas', ARRAY['oben'], 'complete', now() - interval '30 minutes', now() - interval '25 minutes');
SQL
Pq -c "SELECT public.fin_sync_watchdog_check();" >/dev/null
A2=$(Pq -c "SELECT count(*) FROM public.fin_alertas WHERE company='oben' AND tipo='sync_error' AND dismissed_at IS NULL;")
eq "A2 nenhum sync_error ATIVO quando última run é complete" "$A2" "0"
A2D=$(Pq -c "SELECT count(*) FROM public.fin_alertas WHERE company='oben' AND tipo='sync_error' AND dismissed_at IS NOT NULL;")
eq "A2.b alerta prévio foi DISMISSADO pela função" "$A2D" "1"

# ══════════════════════════════════════════════════════════════════════════════
# ASSERÇÃO 3 — ÓRFÃ vira erro
#   sync_sku_items 'running' com started_at < now()-31min -> UPDATE para
#   status='error', error_message='orphaned_running_timeout'.
# ══════════════════════════════════════════════════════════════════════════════
echo "── Asserção 3: órfã vira erro ──"
reset
ORPHID=$(Pq -q -c "INSERT INTO public.fin_sync_log (action, companies, status, started_at) VALUES ('sync_sku_items', ARRAY['colacor'], 'running', now() - interval '31 minutes') RETURNING id;")
# pré: ainda está running antes de rodar
PRE3=$(Pq -c "SELECT status FROM public.fin_sync_log WHERE id='$ORPHID';")
eq "A3.pre ainda 'running' antes de rodar" "$PRE3" "running"
Pq -c "SELECT public.fin_sync_watchdog_check();" >/dev/null
A3S=$(Pq -c "SELECT status FROM public.fin_sync_log WHERE id='$ORPHID';")
A3M=$(Pq -c "SELECT error_message FROM public.fin_sync_log WHERE id='$ORPHID';")
eq "A3 status virou error"               "$A3S" "error"
eq "A3.b error_message = orphaned_running_timeout" "$A3M" "orphaned_running_timeout"

# ══════════════════════════════════════════════════════════════════════════════
# ASSERÇÃO 4 — SEM sync_stale falso para nfes
#   sync_nfes_recebidas antigo (complete há >18h e dentro de 7d, sem complete recente)
#   -> a função NÃO cria fin_alertas tipo='sync_stale' (sync_stale só olha contas_*/movimentacoes).
# ══════════════════════════════════════════════════════════════════════════════
echo "── Asserção 4: sem sync_stale falso p/ nfes ──"
reset
P -q <<'SQL'
-- nfes: tem complete dentro de 7d, mas nenhum nas últimas 18h -> seria "stale" SE a função olhasse nfes
INSERT INTO public.fin_sync_log (action, companies, status, started_at, completed_at) VALUES
  ('sync_nfes_recebidas', ARRAY['oben'], 'complete', now() - interval '2 days', now() - interval '2 days');
SQL
Pq -c "SELECT public.fin_sync_watchdog_check();" >/dev/null
A4=$(Pq -c "SELECT count(*) FROM public.fin_alertas WHERE company='oben' AND tipo='sync_stale' AND dismissed_at IS NULL;")
eq "A4 nenhum sync_stale criado p/ nfes" "$A4" "0"
# controle POSITIVO do ramo stale: o MESMO padrão com um v_resource REAL (contas_pagar) DEVE alarmar
# — prova que o ramo stale funciona e que a ausência em A4 é por DESIGN (nfes fora de v_resources), não por bug.
P -q <<'SQL'
INSERT INTO public.fin_sync_log (action, companies, status, started_at, completed_at) VALUES
  ('sync_contas_pagar', ARRAY['oben'], 'complete', now() - interval '2 days', now() - interval '2 days');
SQL
Pq -c "SELECT public.fin_sync_watchdog_check();" >/dev/null
A4CTRL=$(Pq -c "SELECT count(*) FROM public.fin_alertas WHERE company='oben' AND tipo='sync_stale' AND dismissed_at IS NULL AND mensagem ILIKE '%contas_pagar%';")
eq "A4.ctrl sync_stale DISPARA p/ contas_pagar (ramo vivo)" "$A4CTRL" "1"

# ══════════════════════════════════════════════════════════════════════════════
# ASSERÇÃO 5 — erro PARCIAL não alarma
#   última run de sync_sku_items = 'complete' com results.erros>0 -> NÃO dispara sync_error
#   (a função olha status, não results — erro parcial fica 'complete').
# ══════════════════════════════════════════════════════════════════════════════
echo "── Asserção 5: erro parcial não alarma ──"
reset
P -q <<'SQL'
INSERT INTO public.fin_sync_log (action, companies, status, results, started_at, completed_at) VALUES
  ('sync_sku_items', ARRAY['colacor'], 'complete', '{"erros": 7, "ok": 120}'::jsonb, now() - interval '20 minutes', now() - interval '15 minutes');
SQL
Pq -c "SELECT public.fin_sync_watchdog_check();" >/dev/null
A5=$(Pq -c "SELECT count(*) FROM public.fin_alertas WHERE company='colacor' AND tipo='sync_error' AND dismissed_at IS NULL;")
eq "A5 nenhum sync_error quando última é complete c/ erros parciais" "$A5" "0"

# ══════════════════════════════════════════════════════════════════════════════
# ZONA 5 — FALSIFICAÇÃO (Lei #3): sabota o corpo -> exige VERMELHO -> restaura.
#   Provo que A1, A2(dismiss) e A3 têm DENTE. Sentinelas próprias (anti-teatro).
# ══════════════════════════════════════════════════════════════════════════════
echo "── FALSIFICAÇÃO ──"

# ── F1: sabota o ramo sync_error (troca a condição >=2 por >=999 -> NUNCA alarma).
#   Re-semeia o cenário 1 e EXIGE que o alerta NÃO apareça (A1 perderia o dente se passasse).
P -q <<'SQL'
CREATE OR REPLACE FUNCTION public.fin_sync_watchdog_check()
 RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_companies text[] := ARRAY['oben','colacor','colacor_sc'];
  c text; v_errs text[];
BEGIN
  FOREACH c IN ARRAY v_companies LOOP
    WITH terminal AS (
      SELECT l.action, l.status, l.started_at FROM fin_sync_log l
      WHERE l.action LIKE 'sync_%' AND c = ANY(l.companies)
        AND l.status IN ('complete','error') AND l.started_at > now() - interval '24 hours'),
    latest AS (SELECT DISTINCT ON (action) action, status, started_at FROM terminal ORDER BY action, started_at DESC)
    SELECT array_agg(lt.action ORDER BY lt.action) INTO v_errs FROM latest lt
    WHERE lt.status='error' AND lt.started_at > now() - interval '3 hours'
      AND (SELECT count(*) FROM terminal t WHERE t.action=lt.action AND t.status='error'
           AND t.started_at <= lt.started_at
           AND NOT EXISTS (SELECT 1 FROM terminal cpl WHERE cpl.action=lt.action AND cpl.status='complete'
                           AND cpl.started_at > t.started_at AND cpl.started_at <= lt.started_at)) >= 999;  -- SABOTADO
    IF v_errs IS NOT NULL THEN
      INSERT INTO fin_alertas (company, tipo, severidade, mensagem, contexto)
      VALUES (c,'sync_error','critico','x',jsonb_build_object('actions',v_errs))
      ON CONFLICT (company, tipo) WHERE dismissed_at IS NULL DO NOTHING;
    END IF;
  END LOOP;
END;
$function$;
SQL
reset
P -q <<'SQL'
INSERT INTO public.fin_sync_log (action, companies, status, started_at, completed_at) VALUES
  ('sync_nfes_recebidas', ARRAY['oben'], 'error', now() - interval '2 hours 30 minutes', now() - interval '2 hours 25 minutes'),
  ('sync_nfes_recebidas', ARRAY['oben'], 'error', now() - interval '1 hour',           now() - interval '55 minutes');
SQL
Pq -c "SELECT public.fin_sync_watchdog_check();" >/dev/null
F1=$(Pq -c "SELECT count(*) FROM public.fin_alertas WHERE company='oben' AND tipo='sync_error' AND dismissed_at IS NULL;")
# com o corpo sabotado, NÃO deve alarmar; se o assert A1 tem dente, este 0 é o esperado da sabotagem
if [ "$F1" = "0" ]; then ok "F1 sabotagem do ramo sync_error suprimiu o alerta (A1 tem dente)"; else bad "F1 sabotei o limiar e AINDA alarmou ($F1) -> A1 é fraco"; fi
# RESTAURA o corpo real
P -q -f "$FN_SQL" >/dev/null
# re-prova A1 com o corpo restaurado (sanidade do restore)
reset
P -q <<'SQL'
INSERT INTO public.fin_sync_log (action, companies, status, started_at, completed_at) VALUES
  ('sync_nfes_recebidas', ARRAY['oben'], 'error', now() - interval '2 hours 30 minutes', now() - interval '2 hours 25 minutes'),
  ('sync_nfes_recebidas', ARRAY['oben'], 'error', now() - interval '1 hour',           now() - interval '55 minutes');
SQL
Pq -c "SELECT public.fin_sync_watchdog_check();" >/dev/null
F1R=$(Pq -c "SELECT count(*) FROM public.fin_alertas WHERE company='oben' AND tipo='sync_error' AND dismissed_at IS NULL;")
eq "F1.restore corpo real volta a alarmar" "$F1R" "1"

# ── F2: sabota o ramo órfão (remove o UPDATE para 'error') -> EXIGE que a órfã siga 'running'.
P -q <<'SQL'
CREATE OR REPLACE FUNCTION public.fin_sync_watchdog_check()
 RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  -- SABOTADO: removido o UPDATE de órfã (a função vira no-op p/ órfãs)
  PERFORM 1;
END;
$function$;
SQL
reset
ORPHID2=$(Pq -q -c "INSERT INTO public.fin_sync_log (action, companies, status, started_at) VALUES ('sync_sku_items', ARRAY['colacor'], 'running', now() - interval '31 minutes') RETURNING id;")
Pq -c "SELECT public.fin_sync_watchdog_check();" >/dev/null
F2=$(Pq -c "SELECT status FROM public.fin_sync_log WHERE id='$ORPHID2';")
if [ "$F2" = "running" ]; then ok "F2 sem o UPDATE de órfã ela seguiu 'running' (A3 tem dente)"; else bad "F2 sabotei o ramo órfão e mesmo assim virou [$F2] -> A3 é fraco"; fi
# RESTAURA
P -q -f "$FN_SQL" >/dev/null

# ── F3: sabota o ramo de DISMISS do sync_error (remove o ELSE/UPDATE dismissed_at)
#   -> com a última run = complete, o alerta prévio NÃO seria dismissado. EXIGE que ele siga ativo.
P -q <<'SQL'
CREATE OR REPLACE FUNCTION public.fin_sync_watchdog_check()
 RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_companies text[] := ARRAY['oben','colacor','colacor_sc'];
  c text; v_errs text[];
BEGIN
  FOREACH c IN ARRAY v_companies LOOP
    WITH terminal AS (
      SELECT l.action, l.status, l.started_at FROM fin_sync_log l
      WHERE l.action LIKE 'sync_%' AND c = ANY(l.companies)
        AND l.status IN ('complete','error') AND l.started_at > now() - interval '24 hours'),
    latest AS (SELECT DISTINCT ON (action) action, status, started_at FROM terminal ORDER BY action, started_at DESC)
    SELECT array_agg(lt.action ORDER BY lt.action) INTO v_errs FROM latest lt
    WHERE lt.status='error' AND lt.started_at > now() - interval '3 hours'
      AND (SELECT count(*) FROM terminal t WHERE t.action=lt.action AND t.status='error'
           AND t.started_at <= lt.started_at
           AND NOT EXISTS (SELECT 1 FROM terminal cpl WHERE cpl.action=lt.action AND cpl.status='complete'
                           AND cpl.started_at > t.started_at AND cpl.started_at <= lt.started_at)) >= 2;
    IF v_errs IS NOT NULL THEN
      INSERT INTO fin_alertas (company, tipo, severidade, mensagem, contexto)
      VALUES (c,'sync_error','critico','x',jsonb_build_object('actions',v_errs))
      ON CONFLICT (company, tipo) WHERE dismissed_at IS NULL DO NOTHING;
    END IF;
    -- SABOTADO: removido o ELSE que faz UPDATE fin_alertas SET dismissed_at = now()
  END LOOP;
END;
$function$;
SQL
reset
P -q <<'SQL'
INSERT INTO public.fin_alertas (company, tipo, severidade, mensagem, dismissed_at)
VALUES ('oben', 'sync_error', 'critico', 'episódio anterior', NULL);
INSERT INTO public.fin_sync_log (action, companies, status, started_at, completed_at) VALUES
  ('sync_nfes_recebidas', ARRAY['oben'], 'complete', now() - interval '30 minutes', now() - interval '25 minutes');
SQL
Pq -c "SELECT public.fin_sync_watchdog_check();" >/dev/null
F3=$(Pq -c "SELECT count(*) FROM public.fin_alertas WHERE company='oben' AND tipo='sync_error' AND dismissed_at IS NULL;")
if [ "$F3" = "1" ]; then ok "F3 sem o ELSE de dismiss o alerta prévio ficou ATIVO (A2.b tem dente)"; else bad "F3 sabotei o dismiss e o alerta sumiu mesmo assim ($F3) -> A2.b é fraco"; fi
# RESTAURA o corpo real (final)
P -q -f "$FN_SQL" >/dev/null

# ── veredito ──
echo "──────────────────────────────"
echo "RESULTADO: $PASS ok / $FAIL fail"
[ "$FAIL" = "0" ] || { echo "❌ HARNESS VERMELHO"; exit 1; }
echo "✅ HARNESS VERDE"
