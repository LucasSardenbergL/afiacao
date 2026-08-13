#!/usr/bin/env bash
# ╔══════════════════════════════════════════════════════════════════════════════╗
# ║  PROVA PG17 — ATP FASE 2: gate do pedido na fronteira (money-path)             ║
# ║  Migration: 20260807015000_atp_gate_pedido_fase2.sql (sobre a fase 1 aplicada) ║
# ║                                                                                ║
# ║  Invariantes provados:                                                         ║
# ║   • gate deriva itens DO BANCO, reserva e VINCULA sales_order_id na mesma tx   ║
# ║   • omie_pedido_id preenchido → 'ja_enviado' SEM re-reservar (retry não renova)║
# ║   • enforcement: recusa → blocked:'atp'; advisory: registra e NÃO bloqueia     ║
# ║   • backorder: só ator humano + motivo + bloqueio prévio de MESMO fingerprint; ║
# ║     re-tenta a reserva primeiro (saldo voltou → 'reservado' vence o override)  ║
# ║   • trilha atp_decisoes é APPEND-ONLY (service_role sem UPDATE/DELETE)         ║
# ║   • agregação por SKU; checkout sintético p/ linha sem checkout_id; RLS staff  ║
# ║  Falsificações F1..F5 sabotam a migration e EXIGEM o vermelho correspondente.  ║
# ║                                                                                ║
# ║  Veredito por byte-compare (eq) com sentinelas ASCII — imune a dobra de locale.║
# ╚══════════════════════════════════════════════════════════════════════════════╝
set -euo pipefail

# ── arranque PG17 descartável ──
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PGVER=17
PGBIN="/opt/homebrew/opt/postgresql@${PGVER}/bin"
PORT="${PGPORT_TEST:-5462}"
SLUG="atp-fase2"
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
ok()  { PASS=$((PASS+1)); echo "  OK  $1"; }
bad() { FAIL=$((FAIL+1)); echo "  ERR $1"; }
eq()  { if [ "$2" = "$3" ]; then ok "$1 (=$2)"; else bad "$1 — esperado [$3], veio [$2]"; fi; }

echo "=== setup pronto (PG17 :$PORT) ==="

# ══════════════════════════════════════════════════════════════════════════════
# ZONA 1 — PRÉ-REQUISITOS (o que as migrations LEEM mas não criam)
# ══════════════════════════════════════════════════════════════════════════════
P -q <<'SQL'
-- Réplica dos DEFAULT PRIVILEGES da PROD (pg_default_acl 2026-08-06): tabela
-- nova em public nasce com ALL p/ anon/authenticated/service_role. SEM isto o
-- harness fica MENOS permissivo que a prod e o assert de append-only (N8) vira
-- tautologia — o REVOKE da migration precisa MORDER contra este default.
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO anon, authenticated, service_role;

CREATE SCHEMA IF NOT EXISTS private;
GRANT USAGE ON SCHEMA private TO authenticated, service_role;

DO $$ BEGIN CREATE TYPE public.app_role AS ENUM ('master','employee','customer');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS public.user_roles (
  user_id uuid NOT NULL,
  role public.app_role NOT NULL
);

CREATE OR REPLACE FUNCTION public.has_role(_user_id uuid, _role public.app_role)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $f$ SELECT EXISTS (SELECT 1 FROM public.user_roles WHERE user_id = _user_id AND role = _role) $f$;

CREATE TABLE IF NOT EXISTS public.inventory_position (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  omie_codigo_produto bigint NOT NULL,
  account text NOT NULL DEFAULT 'vendas',
  saldo numeric DEFAULT 0,
  cmc numeric DEFAULT 0,
  synced_at timestamptz DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.sku_parametros (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  empresa text NOT NULL,
  sku_codigo_omie bigint NOT NULL,
  estoque_seguranca numeric
);

-- fase 2 lê items/omie_pedido_id (colunas reais de prod conferidas via psql-ro)
CREATE TABLE IF NOT EXISTS public.sales_orders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  checkout_id uuid,
  account text,
  items jsonb,
  omie_pedido_id bigint
);

-- pg_cron: a fase 1.1 agenda o job de expiração no fim (cron.schedule). A
-- TABELA cron.job vem de db/stubs-supabase.sql; faltam as FUNÇÕES (mesmo
-- stub do harness da 1.1 — assinatura e comportamento do pg_cron real).
CREATE OR REPLACE FUNCTION cron.schedule(p_name text, p_sched text, p_cmd text)
RETURNS bigint LANGUAGE plpgsql AS $f$
DECLARE v_id bigint;
BEGIN
  DELETE FROM cron.job WHERE jobname = p_name;
  SELECT COALESCE(max(jobid), 0) + 1 INTO v_id FROM cron.job;
  INSERT INTO cron.job(jobid, jobname, schedule, command, active)
  VALUES (v_id, p_name, p_sched, p_cmd, true);
  RETURN v_id;
END $f$;
CREATE OR REPLACE FUNCTION cron.unschedule(p_name text)
RETURNS boolean LANGUAGE plpgsql AS $f$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM cron.job WHERE jobname = p_name) THEN
    RAISE EXCEPTION 'could not find valid entry for job %', p_name;
  END IF;
  DELETE FROM cron.job WHERE jobname = p_name;
  RETURN true;
END $f$;
SQL

# ══════════════════════════════════════════════════════════════════════════════
# ZONA 2 — MIGRATIONS REAIS (fase 1 + fase 2, em ordem)
# ══════════════════════════════════════════════════════════════════════════════
MIG1="$REPO_ROOT/supabase/migrations/20260806101417_atp_reserva_estoque_fase1.sql"
MIG11="$REPO_ROOT/supabase/migrations/20260806225052_atp_reserva_estoque_fase1_1_hardening.sql"
MIG2="$REPO_ROOT/supabase/migrations/20260807015000_atp_gate_pedido_fase2.sql"
P -q -f "$MIG1"
P -q -f "$MIG11"
P -q -f "$MIG2"
echo "migrations aplicadas: $(basename "$MIG1") + $(basename "$MIG11") + $(basename "$MIG2")"

# ══════════════════════════════════════════════════════════════════════════════
# ZONA 3 — SEEDS
# ══════════════════════════════════════════════════════════════════════════════
STAFF='22222222-2222-2222-2222-222222222222'
CUST='44444444-4444-4444-4444-444444444444'
SO_OK='e0000000-0000-0000-0000-000000000001'      # oben, checkout, saldo sobra
SO_SEM='e0000000-0000-0000-0000-000000000002'     # oben, checkout, saldo insuficiente
SO_JA='e0000000-0000-0000-0000-000000000003'      # oben, omie_pedido_id preenchido
SO_SEMCK='e0000000-0000-0000-0000-000000000004'   # oben, SEM checkout (conversao/cron)
SO_COL='e0000000-0000-0000-0000-000000000005'     # colacor (fora do pool)
SO_AGG='e0000000-0000-0000-0000-000000000006'     # oben, MESMO sku em 2 linhas de item
SO_INVAL='e0000000-0000-0000-0000-000000000007'   # oben, item com qtd invalida
SO_VOLTA='e0000000-0000-0000-0000-000000000008'   # oben, saldo volta antes do backorder
CK_OK='c0000000-0000-0000-0000-000000000001'
CK_SEM='c0000000-0000-0000-0000-000000000002'
CK_JA='c0000000-0000-0000-0000-000000000003'
CK_COL='c0000000-0000-0000-0000-000000000005'
CK_AGG='c0000000-0000-0000-0000-000000000006'
CK_VOLTA='c0000000-0000-0000-0000-000000000008'

P -q <<SQL
INSERT INTO auth.users (id) VALUES ('$STAFF'), ('$CUST') ON CONFLICT DO NOTHING;
INSERT INTO public.user_roles (user_id, role) VALUES
  ('$STAFF', 'employee'), ('$CUST', 'customer');

INSERT INTO public.inventory_position (omie_codigo_produto, account, saldo, synced_at) VALUES
  (2001, 'oben', 100, now()),
  (2002, 'oben',   3, now()),
  (2003, 'oben',  50, now()),
  (2004, 'oben',   0, now());

INSERT INTO public.sales_orders (id, checkout_id, account, items, omie_pedido_id) VALUES
  ('$SO_OK',    '$CK_OK',  'oben', '[{"omie_codigo_produto":2001,"quantidade":5,"valor_unitario":10}]', NULL),
  ('$SO_SEM',   '$CK_SEM', 'oben', '[{"omie_codigo_produto":2002,"quantidade":10,"valor_unitario":10}]', NULL),
  ('$SO_JA',    '$CK_JA',  'oben', '[{"omie_codigo_produto":2001,"quantidade":2,"valor_unitario":10}]', 987654),
  ('$SO_SEMCK', NULL,      'oben', '[{"omie_codigo_produto":2003,"quantidade":4,"valor_unitario":10}]', NULL),
  ('$SO_COL',   '$CK_COL', 'colacor', '[{"omie_codigo_produto":2001,"quantidade":1,"valor_unitario":10}]', NULL),
  ('$SO_AGG',   '$CK_AGG', 'oben', '[{"omie_codigo_produto":2003,"quantidade":2,"valor_unitario":10},{"omie_codigo_produto":2003,"quantidade":3,"valor_unitario":12}]', NULL),
  ('$SO_INVAL', NULL,      'oben', '[{"omie_codigo_produto":2001,"quantidade":-1,"valor_unitario":10}]', NULL),
  ('$SO_VOLTA', '$CK_VOLTA','oben', '[{"omie_codigo_produto":2004,"quantidade":2,"valor_unitario":10}]', NULL);
SQL

echo "=== seeds prontos ==="

# helper: chama o gate como o EDGE chama (service_role)
gate() { # $1=sales_order_id  $2=enforcement  $3=actor(uuid|NULL)  $4=backorder(true|false)  $5=motivo(sql literal ou NULL)
  Pq <<SQL | tail -1
SET test.role='service_role';
SELECT public.atp_gate_pedido('$1'::uuid, $2, $3, $4, $5);
SQL
}

# ══════════════════════════════════════════════════════════════════════════════
# ZONA 4 — ASSERTS
# ══════════════════════════════════════════════════════════════════════════════
echo "-- positivos --"

# P1: caminho feliz — reservado + vinculo sales_order_id na mesma tx + trilha
R=$(gate "$SO_OK" true "'$STAFF'" false NULL)
case "$R" in *'"reservado"'*) ok "P1 gate com saldo devolve resultado=reservado";; *) bad "P1 esperava reservado, veio: $R";; esac
V=$(Pq -c "SELECT count(*) FROM public.estoque_reservas WHERE sales_order_id='$SO_OK' AND status='ativa'")
eq "P1 reserva ativa nasce VINCULADA ao pedido (sales_order_id)" "$V" "1"
V=$(Pq -c "SELECT count(*) FROM public.atp_decisoes WHERE sales_order_id='$SO_OK' AND decisao='reservado' AND enforcement")
eq "P1 trilha registra decisao=reservado" "$V" "1"
V=$(Pq -c "SELECT length(itens_fingerprint)=32 FROM public.atp_decisoes WHERE sales_order_id='$SO_OK' LIMIT 1")
eq "P1 fingerprint md5 registrado" "$V" "t"

# P2: PV ja criado -> ja_enviado, SEM re-reservar
R=$(gate "$SO_JA" true "'$STAFF'" false NULL)
case "$R" in *'"ja_enviado"'*) ok "P2 omie_pedido_id preenchido -> ja_enviado";; *) bad "P2 esperava ja_enviado, veio: $R";; esac
V=$(Pq -c "SELECT count(*) FROM public.estoque_reservas WHERE checkout_id='$CK_JA'")
eq "P2 nenhuma reserva nasce/renova para PV ja criado" "$V" "0"

# P3: advisory (caller antigo) — recusa registra e NAO bloqueia
R=$(gate "$SO_SEM" false NULL false NULL)
case "$R" in *'"advisory_bloqueado"'*) ok "P3 advisory devolve ok+advisory_bloqueado (nao bloqueia caller antigo)";; *) bad "P3 esperava advisory_bloqueado, veio: $R";; esac
V=$(Pq -c "SELECT count(*) FROM public.atp_decisoes WHERE sales_order_id='$SO_SEM' AND decisao='bloqueado' AND NOT enforcement")
eq "P3 trilha registra o bloqueio advisory (enforcement=false)" "$V" "1"

# P4: enforcement sem saldo -> blocked:'atp' + recusas + snapshot com frescor
R=$(gate "$SO_SEM" true "'$STAFF'" false NULL)
case "$R" in *'"blocked": "atp"'*|*'"blocked":"atp"'*) ok "P4 enforcement sem saldo -> blocked=atp";; *) bad "P4 esperava blocked atp, veio: $R";; esac
case "$R" in *'"saldo_insuficiente"'*) ok "P4 recusas presentes no retorno";; *) bad "P4 sem recusas no retorno: $R";; esac
V=$(Pq -c "SELECT count(*) FROM public.atp_decisoes WHERE sales_order_id='$SO_SEM' AND decisao='bloqueado' AND enforcement AND recusas IS NOT NULL AND atp_snapshot->'2002'->>'saldo_synced_at' IS NOT NULL")
eq "P4 trilha guarda recusas + snapshot com saldo_synced_at" "$V" "1"

# P5: backorder valido (ator + motivo + bloqueio previo mesmo fingerprint)
R=$(gate "$SO_SEM" true "'$STAFF'" true "'cliente aceita prazo de reposicao'")
case "$R" in *'"backorder_autorizado"'*) ok "P5 backorder autorizado apos bloqueio previo";; *) bad "P5 esperava backorder_autorizado, veio: $R";; esac
V=$(Pq -c "SELECT count(*) FROM public.atp_decisoes WHERE sales_order_id='$SO_SEM' AND decisao='backorder_autorizado' AND actor_user_id='$STAFF' AND motivo_backorder IS NOT NULL")
eq "P5 trilha registra override com ator+motivo" "$V" "1"
V=$(Pq -c "SELECT count(*) FROM public.estoque_reservas WHERE checkout_id='$CK_SEM' AND status='ativa'")
eq "P5 backorder NAO cria reserva ativa" "$V" "0"

# P6: saldo VOLTOU antes do backorder -> reserva vence o override
R=$(gate "$SO_VOLTA" true "'$STAFF'" false NULL)
case "$R" in *'"bloqueado"'*) ok "P6a sku sem saldo bloqueia primeiro";; *) bad "P6a esperava bloqueado, veio: $R";; esac
P -q -c "UPDATE public.inventory_position SET saldo=20, synced_at=now() WHERE omie_codigo_produto=2004;"
R=$(gate "$SO_VOLTA" true "'$STAFF'" true "'aceita prazo'")
case "$R" in *'"resultado": "reservado"'*|*'"resultado":"reservado"'*) ok "P6b com saldo de volta, backorder vira RESERVADO (reserva vence)";; *) bad "P6b esperava reservado, veio: $R";; esac

# P7: linha SEM checkout_id -> chave sintetica = sales_order_id
R=$(gate "$SO_SEMCK" true "'$STAFF'" false NULL)
V=$(Pq -c "SELECT count(*) FROM public.estoque_reservas WHERE checkout_id='$SO_SEMCK' AND sales_order_id='$SO_SEMCK' AND status='ativa'")
eq "P7 sem checkout_id a reserva ancora no proprio sales_order_id" "$V" "1"

# P8: agregacao por SKU (2 linhas do mesmo sku somam numa reserva)
R=$(gate "$SO_AGG" true "'$STAFF'" false NULL)
V=$(Pq -c "SELECT quantidade::text FROM public.estoque_reservas WHERE checkout_id='$CK_AGG' AND status='ativa' AND omie_codigo_produto=2003")
eq "P8 itens duplicados do mesmo sku agregam (2+3=5) numa reserva" "$V" "5"

# P9: retry apos recusa acumula trilha (append-only funciona como historico)
V=$(Pq -c "SELECT count(*) FROM public.atp_decisoes WHERE sales_order_id='$SO_SEM'")
eq "P9 trilha do pedido bloqueado acumula (advisory+bloqueado+backorder = 3)" "$V" "3"

# P10: conta fora do pool nao reserva
R=$(gate "$SO_COL" true "'$STAFF'" false NULL)
case "$R" in *'"fora_do_pool"'*) ok "P10 linha colacor -> fora_do_pool";; *) bad "P10 esperava fora_do_pool, veio: $R";; esac
V=$(Pq -c "SELECT count(*) FROM public.estoque_reservas WHERE checkout_id='$CK_COL'")
eq "P10 nenhuma reserva para conta fora do pool" "$V" "0"

echo "-- negativos (SQLSTATE esperada + re-raise do resto) --"

# N1: backorder com ator NULL (cron) -> 42501
N1=$(Pq <<SQL 2>&1 | tr '\n' ' ' || true
SET test.role='service_role';
DO \$\$
BEGIN
  PERFORM public.atp_gate_pedido('$SO_SEM'::uuid, true, NULL, true, 'motivo qualquer');
  RAISE EXCEPTION 'ATP2_N1_ENTROU_SEM_ATOR';
EXCEPTION
  WHEN sqlstate '42501' THEN RAISE NOTICE 'ATP2_N1_BARRADO_42501';
END \$\$;
SQL
)
case "$N1" in *ATP2_N1_BARRADO_42501*) ok "N1 backorder sem ator humano (cron) -> 42501";; *) bad "N1 esperava 42501, veio: $N1";; esac

# N2: backorder sem motivo -> 22023
N2=$(Pq <<SQL 2>&1 | tr '\n' ' ' || true
SET test.role='service_role';
DO \$\$
BEGIN
  PERFORM public.atp_gate_pedido('$SO_SEM'::uuid, true, '$STAFF'::uuid, true, '   ');
  RAISE EXCEPTION 'ATP2_N2_ENTROU_SEM_MOTIVO';
EXCEPTION
  WHEN sqlstate '22023' THEN RAISE NOTICE 'ATP2_N2_BARRADO_22023';
END \$\$;
SQL
)
case "$N2" in *ATP2_N2_BARRADO_22023*) ok "N2 backorder sem motivo textual -> 22023";; *) bad "N2 esperava 22023, veio: $N2";; esac

# N3: backorder sem bloqueio previo -> 42501 (SO_OK foi reservado, nunca bloqueado)
N3=$(Pq <<SQL 2>&1 | tr '\n' ' ' || true
SET test.role='service_role';
UPDATE public.sales_orders SET omie_pedido_id=NULL WHERE id='$SO_OK';
DO \$\$
BEGIN
  PERFORM public.atp_gate_pedido('$SO_OK'::uuid, true, '$STAFF'::uuid, true, 'sem bloqueio previo');
  RAISE EXCEPTION 'ATP2_N3_ENTROU_SEM_BLOQUEIO';
EXCEPTION
  WHEN sqlstate '42501' THEN RAISE NOTICE 'ATP2_N3_BARRADO_42501';
END \$\$;
SQL
)
case "$N3" in *ATP2_N3_BARRADO_42501*) ok "N3 backorder sem bloqueio previo -> 42501";; *) bad "N3 esperava 42501, veio: $N3";; esac

# N4: itens mudaram apos o bloqueio (fingerprint diverge) -> 42501
P -q -c "UPDATE public.sales_orders SET items='[{\"omie_codigo_produto\":2002,\"quantidade\":99,\"valor_unitario\":10}]' WHERE id='$SO_SEM';"
N4=$(Pq <<SQL 2>&1 | tr '\n' ' ' || true
SET test.role='service_role';
DO \$\$
BEGIN
  PERFORM public.atp_gate_pedido('$SO_SEM'::uuid, true, '$STAFF'::uuid, true, 'itens editados');
  RAISE EXCEPTION 'ATP2_N4_ENTROU_FP_DIVERGENTE';
EXCEPTION
  WHEN sqlstate '42501' THEN RAISE NOTICE 'ATP2_N4_BARRADO_42501';
END \$\$;
SQL
)
case "$N4" in *ATP2_N4_BARRADO_42501*) ok "N4 fingerprint divergente do bloqueio -> 42501 (edicao invalida o override)";; *) bad "N4 esperava 42501, veio: $N4";; esac
P -q -c "UPDATE public.sales_orders SET items='[{\"omie_codigo_produto\":2002,\"quantidade\":10,\"valor_unitario\":10}]' WHERE id='$SO_SEM';"

# N5: item invalido (qtd <= 0) -> 22023 sem override
N5=$(Pq <<SQL 2>&1 | tr '\n' ' ' || true
SET test.role='service_role';
DO \$\$
BEGIN
  PERFORM public.atp_gate_pedido('$SO_INVAL'::uuid, true, '$STAFF'::uuid, false, NULL);
  RAISE EXCEPTION 'ATP2_N5_ENTROU_ITEM_INVALIDO';
EXCEPTION
  WHEN sqlstate '22023' THEN RAISE NOTICE 'ATP2_N5_BARRADO_22023';
END \$\$;
SQL
)
case "$N5" in *ATP2_N5_BARRADO_22023*) ok "N5 item ilegivel (qtd<=0) -> 22023 (bug de dado nao vira backorder)";; *) bad "N5 esperava 22023, veio: $N5";; esac

# N6: pedido inexistente -> 22023
N6=$(Pq <<SQL 2>&1 | tr '\n' ' ' || true
SET test.role='service_role';
DO \$\$
BEGIN
  PERFORM public.atp_gate_pedido('99999999-9999-9999-9999-999999999999'::uuid, true, NULL, false, NULL);
  RAISE EXCEPTION 'ATP2_N6_ENTROU_INEXISTENTE';
EXCEPTION
  WHEN sqlstate '22023' THEN RAISE NOTICE 'ATP2_N6_BARRADO_22023';
END \$\$;
SQL
)
case "$N6" in *ATP2_N6_BARRADO_22023*) ok "N6 sales_order inexistente -> 22023";; *) bad "N6 esperava 22023, veio: $N6";; esac

# N7: authenticated NAO executa o gate (EXECUTE revogado)
N7=$(Pq <<SQL 2>&1 | tr '\n' ' ' || true
SET test.uid='$STAFF';
SET ROLE authenticated;
DO \$\$
BEGIN
  PERFORM public.atp_gate_pedido('$SO_OK'::uuid, true, NULL, false, NULL);
  RAISE EXCEPTION 'ATP2_N7_ENTROU_AUTHENTICATED';
EXCEPTION
  WHEN insufficient_privilege THEN RAISE NOTICE 'ATP2_N7_BARRADO_PRIV';
END \$\$;
SQL
)
case "$N7" in *ATP2_N7_BARRADO_PRIV*) ok "N7 authenticated nao executa atp_gate_pedido (so service_role)";; *) bad "N7 esperava permission denied, veio: $N7";; esac

# N8: trilha APPEND-ONLY — service_role sem UPDATE/DELETE
N8=$(Pq <<SQL 2>&1 | tr '\n' ' ' || true
SET ROLE service_role;
DO \$\$
BEGIN
  UPDATE public.atp_decisoes SET motivo_backorder='adulterado';
  RAISE EXCEPTION 'ATP2_N8_UPDATE_PASSOU';
EXCEPTION
  WHEN insufficient_privilege THEN RAISE NOTICE 'ATP2_N8_UPDATE_NEGADO';
END \$\$;
DO \$\$
BEGIN
  DELETE FROM public.atp_decisoes;
  RAISE EXCEPTION 'ATP2_N8_DELETE_PASSOU';
EXCEPTION
  WHEN insufficient_privilege THEN RAISE NOTICE 'ATP2_N8_DELETE_NEGADO';
END \$\$;
SQL
)
case "$N8" in *ATP2_N8_UPDATE_NEGADO*) ok "N8a append-only: service_role sem UPDATE na trilha";; *) bad "N8a UPDATE deveria negar, veio: $N8";; esac
case "$N8" in *ATP2_N8_DELETE_NEGADO*) ok "N8b append-only: service_role sem DELETE na trilha";; *) bad "N8b DELETE deveria negar, veio: $N8";; esac

# N9: authenticated nao INSERE na trilha
N9=$(Pq <<SQL 2>&1 | tr '\n' ' ' || true
SET test.uid='$STAFF';
SET ROLE authenticated;
DO \$\$
BEGIN
  INSERT INTO public.atp_decisoes (checkout_id, pool, account, decisao, enforcement, itens_fingerprint)
  VALUES (gen_random_uuid(), 'oben', 'oben', 'reservado', true, 'x');
  RAISE EXCEPTION 'ATP2_N9_INSERT_PASSOU';
EXCEPTION
  WHEN insufficient_privilege THEN RAISE NOTICE 'ATP2_N9_INSERT_NEGADO';
END \$\$;
SQL
)
case "$N9" in *ATP2_N9_INSERT_NEGADO*) ok "N9 authenticated nao insere na trilha (escrita so server-side)";; *) bad "N9 esperava negado, veio: $N9";; esac

echo "-- RLS da trilha --"

# R1: staff le; customer nao le
R1=$(Pq <<SQL | tail -1
SET test.uid='$STAFF';
SET ROLE authenticated;
SELECT count(*) > 0 FROM public.atp_decisoes;
SQL
)
eq "R1 staff (employee) LE a trilha via RLS" "$R1" "t"
R2=$(Pq <<SQL | tail -1
SET test.uid='$CUST';
SET ROLE authenticated;
SELECT count(*) FROM public.atp_decisoes;
SQL
)
eq "R2 customer NAO le a trilha (0 linhas via RLS)" "$R2" "0"

# ══════════════════════════════════════════════════════════════════════════════
# ZONA 5 — FALSIFICAÇÕES (sabota → exige vermelho → restaura via re-apply MIG2)
# Cada sabotagem PROVA que aplicou (REPLACE_NOOP) antes de julgar.
# ══════════════════════════════════════════════════════════════════════════════
echo "-- falsificacoes (a migration sabotada TEM de derrubar o assert correspondente) --"

GATESIG="public.atp_gate_pedido(uuid,boolean,uuid,boolean,text)"

# F1: sabotar o VINCULO (UPDATE de sales_order_id vira no-op)
P -q <<SQL
DO \$\$
DECLARE def text; novo text;
BEGIN
  def := pg_get_functiondef('$GATESIG'::regprocedure);
  novo := replace(def, 'SET sales_order_id = p_sales_order_id,', 'SET sales_order_id = sales_order_id,');
  IF novo = def THEN RAISE EXCEPTION 'FALSIF_F1_REPLACE_NOOP'; END IF;
  EXECUTE novo;
END \$\$;
SQL
P -q -c "DELETE FROM public.estoque_reservas; INSERT INTO public.sales_orders (id, checkout_id, account, items) VALUES ('f0000000-0000-0000-0000-000000000001','cf000000-0000-0000-0000-000000000001','oben','[{\"omie_codigo_produto\":2001,\"quantidade\":1}]');"
R=$(gate 'f0000000-0000-0000-0000-000000000001' true "'$STAFF'" false NULL)
V=$(Pq -c "SELECT count(*) FROM public.estoque_reservas WHERE sales_order_id='f0000000-0000-0000-0000-000000000001'")
eq "F1 SEM o vinculo, a reserva nasce orfa (dente do P1 provado)" "$V" "0"
P -q -f "$MIG2"

# F2: sabotar o guard de ja_enviado (retry re-reservaria PV criado)
P -q <<SQL
DO \$\$
DECLARE def text; novo text;
BEGIN
  def := pg_get_functiondef('$GATESIG'::regprocedure);
  novo := replace(def, 'IF v_row.omie_pedido_id IS NOT NULL THEN', 'IF false THEN');
  IF novo = def THEN RAISE EXCEPTION 'FALSIF_F2_REPLACE_NOOP'; END IF;
  EXECUTE novo;
END \$\$;
SQL
R=$(gate "$SO_JA" true "'$STAFF'" false NULL)
V=$(Pq -c "SELECT count(*) FROM public.estoque_reservas WHERE checkout_id='$CK_JA' AND status='ativa'")
eq "F2 SEM o guard, retry de PV criado RE-RESERVA (dente do P2 provado)" "$V" "1"
P -q -f "$MIG2"
P -q -c "UPDATE public.estoque_reservas SET status='liberada' WHERE checkout_id='$CK_JA';"

# F3: sabotar a validacao de fingerprint do override
P -q <<SQL
DO \$\$
DECLARE def text; novo text;
BEGIN
  def := pg_get_functiondef('$GATESIG'::regprocedure);
  novo := replace(def, 'IF v_bloqueio.itens_fingerprint IS DISTINCT FROM v_fp THEN', 'IF false THEN');
  IF novo = def THEN RAISE EXCEPTION 'FALSIF_F3_REPLACE_NOOP'; END IF;
  EXECUTE novo;
END \$\$;
SQL
P -q -c "UPDATE public.sales_orders SET items='[{\"omie_codigo_produto\":2002,\"quantidade\":77,\"valor_unitario\":10}]' WHERE id='$SO_SEM';"
F3=$(gate "$SO_SEM" true "'$STAFF'" true "'itens editados passam'")
case "$F3" in *'"backorder_autorizado"'*) ok "F3 SEM checagem de fingerprint, itens editados autorizam (dente do N4 provado)";; *) bad "F3 esperava autorizar sob sabotagem, veio: $F3";; esac
P -q -f "$MIG2"
P -q -c "UPDATE public.sales_orders SET items='[{\"omie_codigo_produto\":2002,\"quantidade\":10,\"valor_unitario\":10}]' WHERE id='$SO_SEM';"

# F4: sabotar o enforcement (bloqueio vira advisory sempre)
P -q <<SQL
DO \$\$
DECLARE def text; novo text;
BEGIN
  def := pg_get_functiondef('$GATESIG'::regprocedure);
  novo := replace(def, 'IF p_enforcement THEN', 'IF false THEN');
  IF novo = def THEN RAISE EXCEPTION 'FALSIF_F4_REPLACE_NOOP'; END IF;
  EXECUTE novo;
END \$\$;
SQL
F4=$(gate "$SO_SEM" true "'$STAFF'" false NULL)
case "$F4" in *'"advisory_bloqueado"'*) ok "F4 SEM enforcement, o bloqueio vira advisory (dente do P4 provado)";; *) bad "F4 esperava advisory sob sabotagem, veio: $F4";; esac
P -q -f "$MIG2"

# F5: sabotar o append-only (GRANT UPDATE) — N8 perderia o dente
P -q -c "GRANT UPDATE ON public.atp_decisoes TO service_role;"
F5=$(Pq <<SQL 2>&1 | tr '\n' ' ' || true
SET ROLE service_role;
DO \$\$
BEGIN
  UPDATE public.atp_decisoes SET motivo_backorder='adulterado' WHERE decisao='backorder_autorizado';
  RAISE NOTICE 'ATP2_F5_UPDATE_PASSOU';
EXCEPTION
  WHEN insufficient_privilege THEN RAISE NOTICE 'ATP2_F5_AINDA_NEGADO';
END \$\$;
SQL
)
case "$F5" in *ATP2_F5_UPDATE_PASSOU*) ok "F5 com GRANT sabotado a trilha vira editavel (dente do N8 provado)";; *) bad "F5 esperava update passar sob sabotagem, veio: $F5";; esac
P -q -c "REVOKE UPDATE ON public.atp_decisoes FROM service_role;"
# pos-restauro: N8 volta a negar
F5R=$(Pq <<SQL 2>&1 | tr '\n' ' ' || true
SET ROLE service_role;
DO \$\$
BEGIN
  UPDATE public.atp_decisoes SET motivo_backorder='x2';
  RAISE EXCEPTION 'ATP2_F5R_PASSOU';
EXCEPTION
  WHEN insufficient_privilege THEN RAISE NOTICE 'ATP2_F5R_NEGADO';
END \$\$;
SQL
)
case "$F5R" in *ATP2_F5R_NEGADO*) ok "F5r restaurado: trilha volta a ser append-only";; *) bad "F5r esperava negar apos restauro, veio: $F5R";; esac

# ══════════════════════════════════════════════════════════════════════════════
echo ""
echo "=== RESULTADO: PASS=$PASS FAIL=$FAIL ==="
[ "$FAIL" -eq 0 ] || exit 1
echo "VERDE-REAL: migrations fase1+fase2 provadas com falsificacao"
