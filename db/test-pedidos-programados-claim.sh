#!/usr/bin/env bash
# ╔══════════════════════════════════════════════════════════════════════════════╗
# ║  PROVA — claim 'processando' + watchdog + UNIQUE (envio, account)              ║
# ║  Migration: 20260704070000_pedidos_programados_claim_processando               ║
# ║  Money-path: fecha por construção a corrida edge×edge e o residual             ║
# ║  cancelamento-vs-edge-em-voo (pedido DUPLICADO real no Omie).                  ║
# ║                                                                                ║
# ║  Prova: (A1-A5) claim/release CAS; (A6) CHECK rejeita 23514; (A7) trigger      ║
# ║  bumpa updated_at (precondição do watchdog); (A8-A11) watchdog por timestamp   ║
# ║  reverte SÓ claim órfão, com [OMIE-INCERTO]; (A12) UNIQUE parcial 23505;       ║
# ║  (A13) backfill do map; (A14) re-run idempotente; (A15) constraint mais nova   ║
# ║  sobrevive ao re-run guardado; (A16) REVOKE nega anon/authenticated;           ║
# ║  (A17) cura de SO legado map-only (janela de deploy — achado Codex 07-04);     ║
# ║  (A18) trigger barra cancelar header com claim em voo.                         ║
# ║  Falsifica: F1 constraint sem 'processando'; F2 janela 15d; F3 sem marcador;   ║
# ║  F4 sem índice; F5 DROP+ADD cego clobbera a constraint mais nova; F6 sem o     ║
# ║  trigger o header cancela com claim em voo.                                    ║
# ║  Rode:  bash db/test-pedidos-programados-claim.sh > /tmp/t.log 2>&1; echo "exit=$?"  ║
# ╚══════════════════════════════════════════════════════════════════════════════╝
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PGVER=17
PGBIN="/opt/homebrew/opt/postgresql@${PGVER}/bin"
PORT="${PGPORT_TEST:-5471}"     # fora dos ports dos outros harnesses
SLUG="ppclaim"
DATA="$(mktemp -d "/tmp/pgtest-${SLUG}.XXXXXX")/data"
export LC_ALL=C LANG=C

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

P -q -f "$REPO_ROOT/db/stubs-supabase.sql"
P -q <<'SQL'
CREATE OR REPLACE FUNCTION auth.uid()  RETURNS uuid LANGUAGE sql STABLE AS $f$ SELECT nullif(current_setting('test.uid',  true), '')::uuid $f$;
CREATE OR REPLACE FUNCTION auth.role() RETURNS text LANGUAGE sql STABLE AS $f$ SELECT nullif(current_setting('test.role', true), '') $f$;
ALTER ROLE service_role BYPASSRLS;
SQL

PASS=0; FAIL=0
ok()  { PASS=$((PASS+1)); echo "  ✅ $1"; }
bad() { FAIL=$((FAIL+1)); echo "  ❌ $1"; }
eq()  { if [ "$2" = "$3" ]; then ok "$1 (=$2)"; else bad "$1 — esperado [$3], veio [$2]"; fi; }

echo "═══ setup pronto (PG17 :$PORT) ═══"

# ══════════════════════════════════════════════════════════════════════════════
# ZONA 1 — PRÉ-REQUISITOS (o que a migração lê/altera mas não cria)
# ══════════════════════════════════════════════════════════════════════════════
# stubs de cron.schedule/unschedule (stubs-supabase.sql só tem as tabelas)
P -q <<'SQL'
CREATE SEQUENCE IF NOT EXISTS cron.jobid_seq;
CREATE OR REPLACE FUNCTION cron.schedule(job_name text, sched text, command text)
RETURNS bigint LANGUAGE plpgsql AS $f$
DECLARE jid bigint;
BEGIN
  SELECT nextval('cron.jobid_seq') INTO jid;
  INSERT INTO cron.job (jobid, schedule, command, active, jobname)
  VALUES (jid, sched, command, true, job_name);
  RETURN jid;
END $f$;
CREATE OR REPLACE FUNCTION cron.unschedule(job_name text)
RETURNS boolean LANGUAGE plpgsql AS $f$
BEGIN
  DELETE FROM cron.job WHERE jobname = job_name;
  RETURN FOUND;
END $f$;
SQL

# trigger de updated_at — definição REAL de prod (pg_get_functiondef, 2026-07-03)
P -q <<'SQL'
CREATE OR REPLACE FUNCTION public.update_updated_at_column()
RETURNS trigger LANGUAGE plpgsql SET search_path TO 'public' AS $function$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$function$;
SQL

# tabelas que a migração toca — DDL fiel à 20260703090000 (envios: colunas + CHECK
# INLINE, pra reproduzir o nome auto-gerado pedidos_programados_envios_status_check
# que existe em prod) + stub mínimo de sales_orders (colunas que a migração usa)
P -q <<'SQL'
CREATE TABLE public.pedidos_programados (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  status text NOT NULL DEFAULT 'ativo',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE public.pedidos_programados_envios (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  pedido_programado_id uuid NOT NULL REFERENCES public.pedidos_programados(id) ON DELETE CASCADE,
  data_envio date NOT NULL,
  status text NOT NULL DEFAULT 'agendado'
    CHECK (status IN ('agendado','enviado','erro','cancelado')),
  erro_motivo text,
  sales_orders_map jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER upd_pp_envios BEFORE UPDATE ON public.pedidos_programados_envios
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TABLE public.sales_orders (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  account text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
SQL

# seed PRÉ-migration (prova o backfill executando no apply): E1 tem map com um
# sales_order real (SO1) e um valor NÃO-uuid que o guard de regex deve ignorar
# sem explodir a transação; SO2 não está em map nenhum (deve ficar NULL).
P -q <<'SQL'
INSERT INTO public.pedidos_programados (id) VALUES ('aaaaaaaa-0000-0000-0000-000000000001');
INSERT INTO public.sales_orders (id, account) VALUES
  ('cccccccc-0000-0000-0000-000000000001', 'oben'),
  ('cccccccc-0000-0000-0000-000000000002', 'colacor');
INSERT INTO public.pedidos_programados_envios (id, pedido_programado_id, data_envio, status, sales_orders_map) VALUES
  ('bbbbbbbb-0000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-000000000001', '2026-07-03', 'agendado',
   '{"oben": "cccccccc-0000-0000-0000-000000000001", "colacor": "nao-e-uuid"}'::jsonb);
SQL

# ══════════════════════════════════════════════════════════════════════════════
# ZONA 2 — APLICAR A MIGRATION REAL
# ══════════════════════════════════════════════════════════════════════════════
MIG="$REPO_ROOT/supabase/migrations/20260704070000_pedidos_programados_claim_processando.sql"
P -q -f "$MIG"
echo "migration aplicada: $(basename "$MIG")"

# ══════════════════════════════════════════════════════════════════════════════
# ZONA 3 — SEED dos cenários de claim/watchdog/unique
# ══════════════════════════════════════════════════════════════════════════════
P -q <<'SQL'
INSERT INTO public.pedidos_programados_envios (id, pedido_programado_id, data_envio, status, erro_motivo) VALUES
  ('bbbbbbbb-0000-0000-0000-000000000002', 'aaaaaaaa-0000-0000-0000-000000000001', '2026-07-03', 'agendado', NULL),
  ('bbbbbbbb-0000-0000-0000-000000000003', 'aaaaaaaa-0000-0000-0000-000000000001', '2026-07-03', 'erro', 'falha anterior'),
  ('bbbbbbbb-0000-0000-0000-000000000004', 'aaaaaaaa-0000-0000-0000-000000000001', '2026-07-03', 'agendado', NULL),
  ('bbbbbbbb-0000-0000-0000-000000000005', 'aaaaaaaa-0000-0000-0000-000000000001', '2026-07-03', 'cancelado', NULL),
  ('bbbbbbbb-0000-0000-0000-000000000007', 'aaaaaaaa-0000-0000-0000-000000000001', '2026-07-03', 'agendado', NULL);
SQL

# ══════════════════════════════════════════════════════════════════════════════
# ZONA 4 — ASSERTS
# ══════════════════════════════════════════════════════════════════════════════
echo "── backfill (A13) ──"
V=$(Pq -c "SELECT pedido_programado_envio_id FROM public.sales_orders WHERE id='cccccccc-0000-0000-0000-000000000001';")
eq "A13a backfill vinculou SO1 ao envio E1 (via map)" "$V" "bbbbbbbb-0000-0000-0000-000000000001"
V=$(Pq -c "SELECT pedido_programado_envio_id IS NULL FROM public.sales_orders WHERE id='cccccccc-0000-0000-0000-000000000002';")
eq "A13b SO2 (fora de qualquer map) ficou NULL" "$V" "t"
V=$(Pq -c "SELECT count(*) FROM public.sales_orders WHERE pedido_programado_envio_id IS NOT NULL;")
eq "A13c só 1 sales_order vinculado (valor 'nao-e-uuid' ignorado sem explodir)" "$V" "1"

echo "── claim/release CAS (A1-A5) ──"
V=$(Pq -c "WITH c AS (UPDATE public.pedidos_programados_envios SET status='processando' WHERE id='bbbbbbbb-0000-0000-0000-000000000002' AND status IN ('agendado','erro') RETURNING 1) SELECT count(*) FROM c;")
eq "A1 claim agendado→processando retorna 1 linha (CHECK aceita o valor novo)" "$V" "1"
V=$(Pq -c "WITH c AS (UPDATE public.pedidos_programados_envios SET status='processando' WHERE id='bbbbbbbb-0000-0000-0000-000000000002' AND status IN ('agendado','erro') RETURNING 1) SELECT count(*) FROM c;")
eq "A2 segundo claim no MESMO envio retorna 0 (atômico — outro runner perde)" "$V" "0"
V=$(Pq -c "WITH c AS (UPDATE public.pedidos_programados_envios SET status='cancelado' WHERE id='bbbbbbbb-0000-0000-0000-000000000002' AND status IN ('agendado','erro') RETURNING 1) SELECT count(*) FROM c;")
eq "A3a CAS de cancelamento em cima de 'processando' retorna 0 (incancelável)" "$V" "0"
V=$(Pq -c "SELECT status FROM public.pedidos_programados_envios WHERE id='bbbbbbbb-0000-0000-0000-000000000002';")
eq "A3b envio segue 'processando' após a tentativa de cancelar" "$V" "processando"
V=$(Pq -c "WITH c AS (UPDATE public.pedidos_programados_envios SET status='enviado', erro_motivo=NULL WHERE id='bbbbbbbb-0000-0000-0000-000000000002' AND status='processando' RETURNING 1) SELECT count(*) FROM c;")
eq "A4 release processando→enviado (CAS do dono do claim) retorna 1" "$V" "1"
V=$(Pq -c "WITH c AS (UPDATE public.pedidos_programados_envios SET status='processando' WHERE id='bbbbbbbb-0000-0000-0000-000000000003' AND status IN ('agendado','erro') RETURNING 1) SELECT count(*) FROM c;")
eq "A5 claim a partir de 'erro' (retry) retorna 1" "$V" "1"

echo "── CHECK rejeita status inválido (A6) ──"
R=$(P -tA 2>&1 <<'SQL'
DO $do$
BEGIN
  INSERT INTO public.pedidos_programados_envios (pedido_programado_id, data_envio, status)
  VALUES ('aaaaaaaa-0000-0000-0000-000000000001', '2026-07-03', 'foo');
  RAISE EXCEPTION 'CHECK_NAO_BARROU_SENTINELA';
EXCEPTION
  WHEN check_violation THEN RAISE NOTICE 'CHECK_BARROU_SENTINELA';
  WHEN OTHERS THEN RAISE;
END $do$;
SQL
)
case "$R" in
  *CHECK_BARROU_SENTINELA*) ok "A6 status inválido rejeitado com 23514 (check_violation)" ;;
  *) bad "A6 CHECK não barrou status inválido — veio: $R" ;;
esac

echo "── trigger bumpa updated_at (A7 — precondição do watchdog) ──"
U1=$(Pq -c "SELECT updated_at FROM public.pedidos_programados_envios WHERE id='bbbbbbbb-0000-0000-0000-000000000004';")
P -q -c "UPDATE public.pedidos_programados_envios SET erro_motivo='tick' WHERE id='bbbbbbbb-0000-0000-0000-000000000004';"
V=$(Pq -c "SELECT (updated_at > '$U1'::timestamptz) FROM public.pedidos_programados_envios WHERE id='bbbbbbbb-0000-0000-0000-000000000004';")
eq "A7 UPDATE qualquer bumpa updated_at via trigger (claim renova o relógio do watchdog)" "$V" "t"

echo "── watchdog (A8-A11) ──"
# E7 vira claim órfão: claim + envelhecimento do updated_at (trigger desabilitado
# só pra simular a passagem do tempo; em prod o envelhecimento é natural).
# E1 (agendado) e E5 (cancelado) também envelhecem: o watchdog NÃO pode tocá-los.
P -q <<'SQL'
UPDATE public.pedidos_programados_envios SET status='processando'
 WHERE id='bbbbbbbb-0000-0000-0000-000000000007' AND status IN ('agendado','erro');
ALTER TABLE public.pedidos_programados_envios DISABLE TRIGGER upd_pp_envios;
UPDATE public.pedidos_programados_envios SET updated_at = now() - interval '16 minutes'
 WHERE id IN ('bbbbbbbb-0000-0000-0000-000000000007',
              'bbbbbbbb-0000-0000-0000-000000000001',
              'bbbbbbbb-0000-0000-0000-000000000005');
ALTER TABLE public.pedidos_programados_envios ENABLE TRIGGER upd_pp_envios;
SQL
V=$(Pq -c "SELECT public.pedidos_programados_watchdog_claims();")
eq "A8a watchdog reverte exatamente 1 claim órfão (E7) e retorna a contagem" "$V" "1"
V=$(Pq -c "SELECT status FROM public.pedidos_programados_envios WHERE id='bbbbbbbb-0000-0000-0000-000000000007';")
eq "A8b claim órfão virou 'erro' (visível pra decisão humana)" "$V" "erro"
V=$(Pq -c "SELECT position('[OMIE-INCERTO]' in erro_motivo) > 0 FROM public.pedidos_programados_envios WHERE id='bbbbbbbb-0000-0000-0000-000000000007';")
eq "A11 motivo do watchdog carrega o marcador [OMIE-INCERTO] (bloqueia cancelamento)" "$V" "t"
V=$(Pq -c "SELECT status FROM public.pedidos_programados_envios WHERE id='bbbbbbbb-0000-0000-0000-000000000003';")
eq "A9 claim FRESCO (E3, <15min) não foi tocado pelo watchdog" "$V" "processando"
V=$(Pq -c "SELECT status || '|' || (SELECT status FROM public.pedidos_programados_envios WHERE id='bbbbbbbb-0000-0000-0000-000000000005') FROM public.pedidos_programados_envios WHERE id='bbbbbbbb-0000-0000-0000-000000000001';")
eq "A10 agendado/cancelado VELHOS intocados (watchdog filtra por status, não só idade)" "$V" "agendado|cancelado"

echo "── UNIQUE parcial (envio, account) (A12) ──"
P -q -c "INSERT INTO public.sales_orders (account, pedido_programado_envio_id) VALUES ('oben', 'bbbbbbbb-0000-0000-0000-000000000002');"
R=$(P -tA 2>&1 <<'SQL'
DO $do$
BEGIN
  INSERT INTO public.sales_orders (account, pedido_programado_envio_id)
  VALUES ('oben', 'bbbbbbbb-0000-0000-0000-000000000002');
  RAISE EXCEPTION 'UNIQUE_NAO_BARROU_SENTINELA';
EXCEPTION
  WHEN unique_violation THEN RAISE NOTICE 'UNIQUE_BARROU_SENTINELA';
  WHEN OTHERS THEN RAISE;
END $do$;
SQL
)
case "$R" in
  *UNIQUE_BARROU_SENTINELA*) ok "A12a segundo sales_order do MESMO (envio, account) → 23505 (duplicata de PV barrada)" ;;
  *) bad "A12a UNIQUE não barrou o par duplicado — veio: $R" ;;
esac
P -q -c "INSERT INTO public.sales_orders (account, pedido_programado_envio_id) VALUES ('colacor', 'bbbbbbbb-0000-0000-0000-000000000002');"
ok "A12b mesmo envio, account DIFERENTE entra (1 sales_order por empresa)"
P -q -c "INSERT INTO public.sales_orders (account, pedido_programado_envio_id) VALUES ('oben', 'bbbbbbbb-0000-0000-0000-000000000003');"
ok "A12c mesmo account, envio DIFERENTE entra"
P -q -c "INSERT INTO public.sales_orders (account) VALUES ('oben'), ('oben');"
ok "A12d envio NULL ×2 entra (índice parcial não morde fora dos pedidos programados)"

echo "── idempotência do re-run (A14) ──"
P -q -f "$MIG"
V=$(Pq -c "SELECT count(*) FROM cron.job WHERE jobname='pedidos-programados-watchdog';")
eq "A14a re-run inteiro: cron continua com 1 job (unschedule+schedule)" "$V" "1"
V=$(Pq -c "SELECT count(*) FROM pg_indexes WHERE schemaname='public' AND indexname='uniq_sales_orders_pp_envio_account';")
eq "A14b índice único segue existindo (IF NOT EXISTS)" "$V" "1"
V=$(Pq -c "WITH c AS (UPDATE public.pedidos_programados_envios SET status='processando' WHERE id='bbbbbbbb-0000-0000-0000-000000000004' AND status IN ('agendado','erro') RETURNING 1) SELECT count(*) FROM c;")
eq "A14c CHECK segue aceitando 'processando' após re-run (constraint não foi recriada quebrada)" "$V" "1"
V=$(Pq -c "SELECT count(*) FROM pg_trigger WHERE tgname='pp_guard_cancel_com_claim' AND NOT tgisinternal;")
eq "A14d trigger do guard de header segue 1 após re-run (DROP IF EXISTS + CREATE)" "$V" "1"

echo "── constraint mais nova sobrevive ao re-run guardado (A15) ──"
P -q <<'SQL'
ALTER TABLE public.pedidos_programados_envios DROP CONSTRAINT pedidos_programados_envios_status_check;
ALTER TABLE public.pedidos_programados_envios ADD CONSTRAINT pedidos_programados_envios_status_check
  CHECK (status IN ('agendado','processando','enviado','erro','cancelado','pausado'));
SQL
P -q -f "$MIG"
R=$(P -tA 2>&1 <<'SQL'
DO $do$
BEGIN
  INSERT INTO public.pedidos_programados_envios (id, pedido_programado_id, data_envio, status)
  VALUES ('bbbbbbbb-0000-0000-0000-000000000015', 'aaaaaaaa-0000-0000-0000-000000000001', '2026-07-03', 'pausado');
  RAISE NOTICE 'VFUTURA_SOBREVIVEU_SENTINELA';
EXCEPTION
  WHEN check_violation THEN RAISE NOTICE 'VFUTURA_CLOBRADA_SENTINELA';
  WHEN OTHERS THEN RAISE;
END $do$;
SQL
)
case "$R" in
  *VFUTURA_SOBREVIVEU_SENTINELA*) ok "A15 re-run da migration NÃO dropou a constraint v-futura (6º status segue aceito)" ;;
  *) bad "A15 re-run clobberou a constraint mais nova — veio: $R" ;;
esac
# restaura a constraint REAL: limpa a linha 'pausado', dropa a v-futura e deixa a
# própria migration recriar a versão verdadeira (def NULL → ADD)
P -q <<'SQL'
DELETE FROM public.pedidos_programados_envios WHERE id='bbbbbbbb-0000-0000-0000-000000000015';
ALTER TABLE public.pedidos_programados_envios DROP CONSTRAINT pedidos_programados_envios_status_check;
SQL
P -q -f "$MIG"
V=$(Pq -c "SELECT (pg_get_constraintdef(oid) LIKE '%processando%' AND pg_get_constraintdef(oid) NOT LIKE '%pausado%') FROM pg_constraint WHERE conname='pedidos_programados_envios_status_check';")
eq "A15b constraint real restaurada (com processando, sem pausado)" "$V" "t"

echo "── REVOKE (A16) ──"
V=$(Pq -c "SELECT has_function_privilege('anon', 'public.pedidos_programados_watchdog_claims()', 'EXECUTE');")
eq "A16a anon NÃO executa o watchdog" "$V" "f"
V=$(Pq -c "SELECT has_function_privilege('authenticated', 'public.pedidos_programados_watchdog_claims()', 'EXECUTE');")
eq "A16b authenticated NÃO executa o watchdog" "$V" "f"

echo "── cura de SO legado map-only (A17 — janela de deploy, achado Codex 07-04) ──"
# SO "do edge velho": coluna NULL, referenciado só pelo sales_orders_map de E4.
# O edge novo adota+cura via UPDATE ... WHERE pedido_programado_envio_id IS NULL —
# aqui provamos a SEMÂNTICA SQL dessa cura (o TS é inspecionável, o SQL é provável).
P -q <<'SQL'
INSERT INTO public.sales_orders (id, account) VALUES ('cccccccc-0000-0000-0000-000000000010', 'oben');
UPDATE public.pedidos_programados_envios
   SET sales_orders_map = '{"oben": "cccccccc-0000-0000-0000-000000000010"}'::jsonb
 WHERE id='bbbbbbbb-0000-0000-0000-000000000004';
SQL
V=$(Pq -c "WITH c AS (UPDATE public.sales_orders SET pedido_programado_envio_id='bbbbbbbb-0000-0000-0000-000000000004' WHERE id='cccccccc-0000-0000-0000-000000000010' AND pedido_programado_envio_id IS NULL RETURNING 1) SELECT count(*) FROM c;")
eq "A17a cura preenche o vínculo do SO legado (map-only → coluna)" "$V" "1"
R=$(P -tA 2>&1 <<'SQL'
DO $do$
BEGIN
  INSERT INTO public.sales_orders (account, pedido_programado_envio_id)
  VALUES ('oben', 'bbbbbbbb-0000-0000-0000-000000000004');
  RAISE EXCEPTION 'A17_UNIQUE_NAO_BARROU_SENTINELA';
EXCEPTION
  WHEN unique_violation THEN RAISE NOTICE 'A17_UNIQUE_BARROU_SENTINELA';
  WHEN OTHERS THEN RAISE;
END $do$;
SQL
)
case "$R" in
  *A17_UNIQUE_BARROU_SENTINELA*) ok "A17b pós-cura o UNIQUE barra o 2º SO do par (retry nunca duplica)" ;;
  *) bad "A17b unique não barrou pós-cura — veio: $R" ;;
esac
V=$(Pq -c "WITH c AS (UPDATE public.sales_orders SET pedido_programado_envio_id='bbbbbbbb-0000-0000-0000-000000000002' WHERE id='cccccccc-0000-0000-0000-000000000010' AND pedido_programado_envio_id IS NULL RETURNING 1) SELECT count(*) FROM c;")
eq "A17c cura NÃO re-aponta SO já vinculado (WHERE IS NULL → 0 linhas)" "$V" "0"

echo "── guard: header não cancela com claim em voo (A18) ──"
P -q <<'SQL'
INSERT INTO public.pedidos_programados (id) VALUES ('aaaaaaaa-0000-0000-0000-000000000002');
INSERT INTO public.pedidos_programados_envios (id, pedido_programado_id, data_envio, status) VALUES
  ('bbbbbbbb-0000-0000-0000-000000000020', 'aaaaaaaa-0000-0000-0000-000000000002', '2026-07-03', 'agendado');
UPDATE public.pedidos_programados_envios SET status='processando'
 WHERE id='bbbbbbbb-0000-0000-0000-000000000020';
SQL
# sentinela com ERRCODE 22023: só o P0001 do guard cai no WHEN raise_exception;
# a própria sentinela cai no OTHERS e re-lança (anti-teatro — nunca se auto-casa).
R=$(P -tA 2>&1 <<'SQL'
DO $do$
BEGIN
  UPDATE public.pedidos_programados SET status='cancelado'
   WHERE id='aaaaaaaa-0000-0000-0000-000000000002';
  RAISE EXCEPTION 'A18_GUARD_NAO_BARROU_SENTINELA' USING ERRCODE='22023';
EXCEPTION
  WHEN raise_exception THEN RAISE NOTICE 'A18_GUARD_BARROU_SENTINELA';
  WHEN OTHERS THEN RAISE;
END $do$;
SQL
)
case "$R" in
  *A18_GUARD_BARROU_SENTINELA*) ok "A18a cancelar header com envio 'processando' → P0001 (guard fail-closed)" ;;
  *) bad "A18a guard não barrou o cancel com claim em voo — veio: $R" ;;
esac
V=$(Pq -c "SELECT status FROM public.pedidos_programados WHERE id='aaaaaaaa-0000-0000-0000-000000000002';")
eq "A18b header seguiu intocado (status original)" "$V" "ativo"
P -q -c "UPDATE public.pedidos_programados_envios SET status='erro', erro_motivo='falha x' WHERE id='bbbbbbbb-0000-0000-0000-000000000020';"
V=$(Pq -c "WITH c AS (UPDATE public.pedidos_programados SET status='cancelado' WHERE id='aaaaaaaa-0000-0000-0000-000000000002' RETURNING 1) SELECT count(*) FROM c;")
eq "A18c sem claim em voo o cancelamento passa (guard não super-bloqueia)" "$V" "1"

# ══════════════════════════════════════════════════════════════════════════════
# ZONA 5 — FALSIFICAÇÃO (sabota → exige VERMELHO → restaura)
# ══════════════════════════════════════════════════════════════════════════════
echo "── falsificação ──"

# F1: constraint SEM 'processando' → o claim (A1) tem de QUEBRAR com 23514.
# NOT VALID: há linhas 'processando' legítimas dos cenários anteriores — a sabotagem
# só precisa morder em escrita NOVA (NOT VALID pula o legado, enforça o novo).
P -q <<'SQL'
ALTER TABLE public.pedidos_programados_envios DROP CONSTRAINT pedidos_programados_envios_status_check;
ALTER TABLE public.pedidos_programados_envios ADD CONSTRAINT pedidos_programados_envios_status_check
  CHECK (status IN ('agendado','enviado','erro','cancelado')) NOT VALID;
SQL
R=$(P -tA 2>&1 <<'SQL'
DO $do$
BEGIN
  UPDATE public.pedidos_programados_envios SET status='processando'
   WHERE id='bbbbbbbb-0000-0000-0000-000000000001' AND status IN ('agendado','erro');
  RAISE NOTICE 'F1_CLAIM_PASSOU_SENTINELA';
EXCEPTION
  WHEN check_violation THEN RAISE NOTICE 'F1_CLAIM_QUEBROU_SENTINELA';
  WHEN OTHERS THEN RAISE;
END $do$;
SQL
)
case "$R" in
  *F1_CLAIM_QUEBROU_SENTINELA*) ok "F1 sem 'processando' no CHECK o claim quebra (A1 tem dente)" ;;
  *) bad "F1 sabotei a constraint e o claim passou — A1 é fraco: $R" ;;
esac
P -q -f "$MIG"   # restaura: def sem 'processando' → o guard dropa e recria a real

# F2: watchdog com janela sabotada (15 DIAS) → claim órfão novo NÃO é revertido
P -q <<'SQL'
INSERT INTO public.pedidos_programados_envios (id, pedido_programado_id, data_envio, status) VALUES
  ('bbbbbbbb-0000-0000-0000-000000000009', 'aaaaaaaa-0000-0000-0000-000000000001', '2026-07-03', 'agendado');
UPDATE public.pedidos_programados_envios SET status='processando'
 WHERE id='bbbbbbbb-0000-0000-0000-000000000009';
ALTER TABLE public.pedidos_programados_envios DISABLE TRIGGER upd_pp_envios;
UPDATE public.pedidos_programados_envios SET updated_at = now() - interval '16 minutes'
 WHERE id='bbbbbbbb-0000-0000-0000-000000000009';
ALTER TABLE public.pedidos_programados_envios ENABLE TRIGGER upd_pp_envios;
CREATE OR REPLACE FUNCTION public.pedidos_programados_watchdog_claims()
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE n integer;
BEGIN
  UPDATE public.pedidos_programados_envios
     SET status = 'erro',
         erro_motivo = '[OMIE-INCERTO] Runner morreu no meio do envio (claim ''processando'' órfão há mais de 15 min). O pedido PODE existir no Omie sem registro aqui — confira no Omie ou use "Enviar agora" (idempotente). Não cancele sem conferir.'
   WHERE status = 'processando'
     AND updated_at < now() - interval '15 days';
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END;
$$;
SQL
V=$(Pq -c "SELECT public.pedidos_programados_watchdog_claims();")
V2=$(Pq -c "SELECT status FROM public.pedidos_programados_envios WHERE id='bbbbbbbb-0000-0000-0000-000000000009';")
if [ "$V" = "0" ] && [ "$V2" = "processando" ]; then
  ok "F2 janela sabotada (15d) deixa o órfão preso em 'processando' (A8 tem dente)"
else
  bad "F2 sabotei a janela e o watchdog reverteu mesmo assim (n=$V, status=$V2) — A8 é fraco"
fi
P -q -f "$MIG"   # restaura o watchdog real
V=$(Pq -c "SELECT public.pedidos_programados_watchdog_claims();")
V2=$(Pq -c "SELECT status FROM public.pedidos_programados_envios WHERE id='bbbbbbbb-0000-0000-0000-000000000009';")
if [ "$V" = "1" ] && [ "$V2" = "erro" ]; then
  ok "F2b watchdog real restaurado reverte o mesmo órfão (dupla prova)"
else
  bad "F2b restaurei o watchdog e ele não reverteu (n=$V, status=$V2)"
fi

# F3: watchdog SEM o marcador [OMIE-INCERTO] → o assert do marcador (A11) tem de falhar
P -q <<'SQL'
INSERT INTO public.pedidos_programados_envios (id, pedido_programado_id, data_envio, status) VALUES
  ('bbbbbbbb-0000-0000-0000-000000000010', 'aaaaaaaa-0000-0000-0000-000000000001', '2026-07-03', 'agendado');
UPDATE public.pedidos_programados_envios SET status='processando'
 WHERE id='bbbbbbbb-0000-0000-0000-000000000010';
ALTER TABLE public.pedidos_programados_envios DISABLE TRIGGER upd_pp_envios;
UPDATE public.pedidos_programados_envios SET updated_at = now() - interval '16 minutes'
 WHERE id='bbbbbbbb-0000-0000-0000-000000000010';
ALTER TABLE public.pedidos_programados_envios ENABLE TRIGGER upd_pp_envios;
CREATE OR REPLACE FUNCTION public.pedidos_programados_watchdog_claims()
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE n integer;
BEGIN
  UPDATE public.pedidos_programados_envios
     SET status = 'erro', erro_motivo = 'claim orfao revertido pelo watchdog'
   WHERE status = 'processando'
     AND updated_at < now() - interval '15 minutes';
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END;
$$;
SQL
Pq -c "SELECT public.pedidos_programados_watchdog_claims();" >/dev/null
V=$(Pq -c "SELECT position('[OMIE-INCERTO]' in erro_motivo) > 0 FROM public.pedidos_programados_envios WHERE id='bbbbbbbb-0000-0000-0000-000000000010';")
if [ "$V" = "f" ]; then
  ok "F3 watchdog sem marcador deixa o envio CANCELÁVEL indevidamente (A11 tem dente)"
else
  bad "F3 sabotei o marcador e o assert do marcador ainda passa — A11 é fraco (veio: $V)"
fi
P -q -f "$MIG"   # restaura o watchdog real

# F4: DROPA o índice único → a duplicata (envio, account) tem de PASSAR
P -q -c "DROP INDEX public.uniq_sales_orders_pp_envio_account;"
if P -q -c "INSERT INTO public.sales_orders (id, account, pedido_programado_envio_id) VALUES ('cccccccc-0000-0000-0000-000000000099', 'oben', 'bbbbbbbb-0000-0000-0000-000000000002');" >/dev/null 2>&1; then
  ok "F4 sem o índice a duplicata de (envio, account) entra (A12a tem dente)"
else
  bad "F4 droppei o índice e a duplicata AINDA foi barrada — A12a não provava o índice"
fi
P -q -c "DELETE FROM public.sales_orders WHERE id='cccccccc-0000-0000-0000-000000000099';"
P -q -f "$MIG"   # recria o índice (IF NOT EXISTS)
R=$(P -tA 2>&1 <<'SQL'
DO $do$
BEGIN
  INSERT INTO public.sales_orders (account, pedido_programado_envio_id)
  VALUES ('oben', 'bbbbbbbb-0000-0000-0000-000000000002');
  RAISE EXCEPTION 'F4B_UNIQUE_NAO_VOLTOU_SENTINELA';
EXCEPTION
  WHEN unique_violation THEN RAISE NOTICE 'F4B_UNIQUE_VOLTOU_SENTINELA';
  WHEN OTHERS THEN RAISE;
END $do$;
SQL
)
case "$R" in
  *F4B_UNIQUE_VOLTOU_SENTINELA*) ok "F4b índice restaurado volta a barrar 23505" ;;
  *) bad "F4b restaurei e o unique não morde — veio: $R" ;;
esac

# F5: o padrão PROIBIDO (DROP IF EXISTS + ADD cego) clobbera a constraint mais nova
# — a razão de o guard por definição existir (mesma lição da 20260617091500)
P -q <<'SQL'
ALTER TABLE public.pedidos_programados_envios DROP CONSTRAINT pedidos_programados_envios_status_check;
ALTER TABLE public.pedidos_programados_envios ADD CONSTRAINT pedidos_programados_envios_status_check
  CHECK (status IN ('agendado','processando','enviado','erro','cancelado','pausado'));
-- re-run "cego" (o anti-padrão que a migration evita):
ALTER TABLE public.pedidos_programados_envios DROP CONSTRAINT IF EXISTS pedidos_programados_envios_status_check;
ALTER TABLE public.pedidos_programados_envios ADD CONSTRAINT pedidos_programados_envios_status_check
  CHECK (status IN ('agendado','processando','enviado','erro','cancelado'));
SQL
R=$(P -tA 2>&1 <<'SQL'
DO $do$
BEGIN
  INSERT INTO public.pedidos_programados_envios (id, pedido_programado_id, data_envio, status)
  VALUES ('bbbbbbbb-0000-0000-0000-000000000016', 'aaaaaaaa-0000-0000-0000-000000000001', '2026-07-03', 'pausado');
  RAISE NOTICE 'F5_VFUTURA_SOBREVIVEU_SENTINELA';
EXCEPTION
  WHEN check_violation THEN RAISE NOTICE 'F5_VFUTURA_CLOBRADA_SENTINELA';
  WHEN OTHERS THEN RAISE;
END $do$;
SQL
)
case "$R" in
  *F5_VFUTURA_CLOBRADA_SENTINELA*) ok "F5 DROP+ADD cego clobbera a constraint mais nova (o guard por definição de A15 é necessário)" ;;
  *) bad "F5 o anti-padrão não clobberou?! — veio: $R" ;;
esac
# estado final já é a constraint real de 5 status (o próprio F5 a instalou por último)
V=$(Pq -c "SELECT (pg_get_constraintdef(oid) LIKE '%processando%' AND pg_get_constraintdef(oid) NOT LIKE '%pausado%') FROM pg_constraint WHERE conname='pedidos_programados_envios_status_check';")
eq "F5b estado final: constraint real (com processando, sem pausado)" "$V" "t"

# F6: DROPA o trigger do header → cancelar com claim em voo tem de PASSAR
P -q <<'SQL'
INSERT INTO public.pedidos_programados (id) VALUES ('aaaaaaaa-0000-0000-0000-000000000003');
INSERT INTO public.pedidos_programados_envios (id, pedido_programado_id, data_envio, status) VALUES
  ('bbbbbbbb-0000-0000-0000-000000000021', 'aaaaaaaa-0000-0000-0000-000000000003', '2026-07-03', 'agendado');
UPDATE public.pedidos_programados_envios SET status='processando'
 WHERE id='bbbbbbbb-0000-0000-0000-000000000021';
DROP TRIGGER pp_guard_cancel_com_claim ON public.pedidos_programados;
SQL
if P -q -c "UPDATE public.pedidos_programados SET status='cancelado' WHERE id='aaaaaaaa-0000-0000-0000-000000000003';" >/dev/null 2>&1; then
  ok "F6 sem o trigger o header cancela com claim em voo (A18 tem dente)"
else
  bad "F6 droppei o trigger e o cancel AINDA foi barrado — A18 não provava o trigger"
fi
P -q -c "UPDATE public.pedidos_programados SET status='ativo' WHERE id='aaaaaaaa-0000-0000-0000-000000000003';"
P -q -f "$MIG"   # restaura o trigger (DROP IF EXISTS + CREATE)
R=$(P -tA 2>&1 <<'SQL'
DO $do$
BEGIN
  UPDATE public.pedidos_programados SET status='cancelado'
   WHERE id='aaaaaaaa-0000-0000-0000-000000000003';
  RAISE EXCEPTION 'F6B_GUARD_NAO_VOLTOU_SENTINELA' USING ERRCODE='22023';
EXCEPTION
  WHEN raise_exception THEN RAISE NOTICE 'F6B_GUARD_VOLTOU_SENTINELA';
  WHEN OTHERS THEN RAISE;
END $do$;
SQL
)
case "$R" in
  *F6B_GUARD_VOLTOU_SENTINELA*) ok "F6b trigger restaurado volta a barrar" ;;
  *) bad "F6b restaurei e o guard não morde — veio: $R" ;;
esac

# ── veredito ──
echo "──────────────────────────────"
echo "RESULTADO: $PASS ok / $FAIL fail"
[ "$FAIL" = "0" ] || { echo "❌ HARNESS VERMELHO"; exit 1; }
echo "✅ HARNESS VERDE"
