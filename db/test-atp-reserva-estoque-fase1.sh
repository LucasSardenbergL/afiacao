#!/usr/bin/env bash
# ╔══════════════════════════════════════════════════════════════════════════════╗
# ║  PROVA PG17 — ATP/reserva de estoque FASE 1 (money-path)                       ║
# ║  Migration: 20260806101417_atp_reserva_estoque_fase1.sql                       ║
# ║                                                                                ║
# ║  Invariantes provados:                                                         ║
# ║   • disponivel = saldo_confiavel − reservas_ativas − estoque_seguranca         ║
# ║   • FAIL-CLOSED: sem linha / stale >24h / saldo NULL/negativo/NaN → recusa     ║
# ║   • pool 'oben' = eleição por frescor SÓ entre accounts 'vendas'/'oben'        ║
# ║   • re-reserva do mesmo checkout SUBSTITUI (idempotente), não soma             ║
# ║   • multi-item all-or-nothing; reserva vencida não desconta; liberar devolve   ║
# ║   • gate staff/service (42501); contrato 22023/23514; RLS; escrita só via RPC  ║
# ║   • concorrência: 2 conexões no mesmo saldo → exatamente 1 vence               ║
# ║  Falsificações F1..F5 sabotam a migration e EXIGEM o vermelho correspondente.  ║
# ║                                                                                ║
# ║  Veredito por byte-compare do bash (eq) com sentinelas ASCII exclusivas do     ║
# ║  teste — nenhum grep -i, nenhum acento no caminho de decisão → imune à dobra   ║
# ║  de locale (C × pt_BR.UTF-8) que mordeu o #1483.                               ║
# ╚══════════════════════════════════════════════════════════════════════════════╝
set -euo pipefail

# ── arranque PG17 descartável ──
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PGVER=17
PGBIN="/opt/homebrew/opt/postgresql@${PGVER}/bin"
PORT="${PGPORT_TEST:-5461}"
SLUG="atp-fase1"
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
# ZONA 1 — PRÉ-REQUISITOS (o que a migration LÊ/referencia mas não cria)
# ══════════════════════════════════════════════════════════════════════════════
P -q <<'SQL'
CREATE SCHEMA IF NOT EXISTS private;
GRANT USAGE ON SCHEMA private TO authenticated, service_role;

DO $$ BEGIN CREATE TYPE public.app_role AS ENUM ('master','employee','customer');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS public.user_roles (
  user_id uuid NOT NULL,
  role public.app_role NOT NULL
);

-- espelho fiel do has_role de prod (SECDEF STABLE lendo user_roles)
CREATE OR REPLACE FUNCTION public.has_role(_user_id uuid, _role public.app_role)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $f$ SELECT EXISTS (SELECT 1 FROM public.user_roles WHERE user_id = _user_id AND role = _role) $f$;

-- colunas reais de prod que o cálculo usa (schema conferido via psql-ro 2026-08-06)
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

CREATE TABLE IF NOT EXISTS public.sales_orders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  checkout_id uuid,
  account text
);
SQL

# ══════════════════════════════════════════════════════════════════════════════
# ZONA 2 — MIGRATION REAL
# ══════════════════════════════════════════════════════════════════════════════
MIG="$REPO_ROOT/supabase/migrations/20260806101417_atp_reserva_estoque_fase1.sql"
P -q -f "$MIG"
echo "migration aplicada: $(basename "$MIG")"

# ══════════════════════════════════════════════════════════════════════════════
# ZONA 3 — SEEDS + GRANTS
# ══════════════════════════════════════════════════════════════════════════════
STAFF='22222222-2222-2222-2222-222222222222'
MASTER='33333333-3333-3333-3333-333333333333'
CUST='44444444-4444-4444-4444-444444444444'
CK_A='aaaaaaa1-0000-0000-0000-000000000001'
CK_B='aaaaaaa1-0000-0000-0000-000000000002'
CK_C='aaaaaaa1-0000-0000-0000-000000000003'
CK_D='aaaaaaa1-0000-0000-0000-000000000004'
CK_K1='aaaaaaa1-0000-0000-0000-00000000000a'
CK_K2='aaaaaaa1-0000-0000-0000-00000000000b'

P -q <<SQL
INSERT INTO auth.users(id) VALUES ('$STAFF'), ('$MASTER'), ('$CUST') ON CONFLICT DO NOTHING;
INSERT INTO public.user_roles(user_id, role) VALUES
  ('$STAFF', 'employee'), ('$MASTER', 'master'), ('$CUST', 'customer');

INSERT INTO public.inventory_position (omie_codigo_produto, account, saldo, synced_at) VALUES
  (1001, 'vendas',         100,  now() - interval '1 hour'),   -- eleita (mais fresca DO POOL)
  (1001, 'oben',           999,  now() - interval '30 days'),  -- velha: perde a eleição
  (1001, 'colacor_vendas', 5000, now()),                       -- FORA do pool oben: ignorada
  (1002, 'oben',           50,   now() - interval '25 hours'), -- STALE (>24h) → indisponível
  (1004, 'vendas',         -5,   now()),                       -- negativo → indisponível
  (1005, 'vendas',         NULL, now()),                       -- NULL → indisponível
  (1006, 'vendas',         'NaN'::numeric, now()),             -- NaN → indisponível
  (1007, 'vendas',         20,   now()),                       -- sem parâmetro → colchão 0
  (1010, 'vendas',         10,   now()),                       -- concorrência K1
  (1011, 'vendas',         30,   now()),                       -- falsificação F2
  (1012, 'vendas',         20,   now()),                       -- falsificação F4
  (1013, 'vendas',         10,   now());                       -- falsificação F5

INSERT INTO public.sku_parametros (empresa, sku_codigo_omie, estoque_seguranca) VALUES
  ('OBEN', 1001, 10),
  ('OBEN', 1002, 0),
  ('OBEN', 1012, 15);
SQL

# ══════════════════════════════════════════════════════════════════════════════
# ZONA 4 — ASSERTS
# ══════════════════════════════════════════════════════════════════════════════
echo "-- grupo P: caminho feliz + invariantes do calculo --"

R=$(Pq <<SQL
SET test.uid='$STAFF';
SELECT public.reservar_estoque('oben', '$CK_A', '[{"omie_codigo_produto":1001,"quantidade":50}]'::jsonb, 30)->>'ok';
SQL
)
eq "P1 reserva feliz (staff, saldo 100 seg 10, pede 50)" "$(echo "$R" | tail -1)" "true"
V=$(Pq -c "SELECT count(*)::text FROM public.estoque_reservas WHERE checkout_id='$CK_A' AND status='ativa';")
eq "P1b exatamente 1 reserva ativa do checkout A" "$V" "1"

V=$(Pq <<SQL | tail -1
SET test.uid='$STAFF';
SELECT COALESCE(disponivel::text, 'NULL') FROM public.atp_consultar('oben', ARRAY[1001]::bigint[]);
SQL
)
eq "P2 consulta: disponivel = 100−50−10 = 40 (e a conta colacor_vendas 5000 NAO contamina o pool)" "$V" "40"

R=$(Pq <<SQL | tail -1
SET test.uid='$STAFF';
SELECT public.reservar_estoque('oben', '$CK_B', '[{"omie_codigo_produto":1001,"quantidade":45}]'::jsonb, 30)->>'ok';
SQL
)
eq "P3 checkout B pede 45 com 40 disponivel → recusa" "$R" "false"
M=$(Pq <<SQL | tail -1
SET test.uid='$STAFF';
SELECT r.j->>'motivo' FROM (
  SELECT jsonb_array_elements(public.reservar_estoque('oben', '$CK_B', '[{"omie_codigo_produto":1001,"quantidade":45}]'::jsonb, 30)->'recusas') AS j
) r;
SQL
)
eq "P3b motivo da recusa = saldo_insuficiente" "$M" "saldo_insuficiente"

R=$(Pq <<SQL | tail -1
SET test.uid='$STAFF';
SELECT public.reservar_estoque('oben', '$CK_B', '[{"omie_codigo_produto":1001,"quantidade":40}]'::jsonb, 30)->>'ok';
SQL
)
eq "P4 checkout B pede exatamente os 40 disponiveis → ok" "$R" "true"
V=$(Pq -c "SELECT COALESCE(sum(quantidade),0)::text FROM public.estoque_reservas WHERE omie_codigo_produto=1001 AND status='ativa';")
eq "P4b soma das ativas do SKU 1001 = 90" "$V" "90"

R=$(Pq <<SQL | tail -1
SET test.uid='$STAFF';
SELECT public.reservar_estoque('oben', '$CK_A', '[{"omie_codigo_produto":1001,"quantidade":50}]'::jsonb, 30)->>'ok';
SQL
)
eq "P5 re-reserva do MESMO checkout A (retry) → ok (exclui a propria do calculo)" "$R" "true"
V=$(Pq -c "SELECT count(*)::text || '/' || COALESCE(sum(quantidade),0)::text FROM public.estoque_reservas WHERE checkout_id='$CK_A' AND status='ativa';")
eq "P5b substituiu (nao somou): 1 ativa de 50 no checkout A" "$V" "1/50"

R=$(Pq <<SQL | tail -1
SET test.uid='$STAFF';
SELECT public.reservar_estoque('oben', '$CK_C', '[{"omie_codigo_produto":1007,"quantidade":5},{"omie_codigo_produto":1003,"quantidade":1}]'::jsonb, 30)->>'ok';
SQL
)
eq "P6 multi-item com 1 SKU inexistente → recusa o CONJUNTO" "$R" "false"
V=$(Pq -c "SELECT count(*)::text FROM public.estoque_reservas WHERE checkout_id='$CK_C';")
eq "P6b all-or-nothing: NENHUMA linha gravada p/ o checkout C (nem a do item bom)" "$V" "0"

R=$(Pq <<SQL | tail -1
SET test.uid='$STAFF';
SELECT public.liberar_reserva_checkout('$CK_B', 'oben', 'teste de liberacao')->>'liberadas';
SQL
)
eq "P7 liberar checkout B → 1 liberada" "$R" "1"
V=$(Pq <<SQL | tail -1
SET test.uid='$STAFF';
SELECT COALESCE(disponivel::text, 'NULL') FROM public.atp_consultar('oben', ARRAY[1001]::bigint[]);
SQL
)
eq "P7b disponivel volta a 40 apos liberar" "$V" "40"

P -q -c "INSERT INTO public.estoque_reservas (pool, omie_codigo_produto, quantidade, checkout_id, status, expira_em) VALUES ('oben', 1001, 30, '$CK_D', 'ativa', now() - interval '1 minute');"
V=$(Pq <<SQL | tail -1
SET test.uid='$STAFF';
SELECT COALESCE(disponivel::text, 'NULL') FROM public.atp_consultar('oben', ARRAY[1001]::bigint[]);
SQL
)
eq "P8 reserva VENCIDA (ativa, expira no passado) NAO desconta: disponivel segue 40" "$V" "40"
R=$(Pq <<SQL | tail -1
SET test.uid='$STAFF';
SELECT public.expirar_reservas_vencidas()->>'expiradas';
SQL
)
eq "P8b expirar_reservas_vencidas marca 1" "$R" "1"
V=$(Pq -c "SELECT status FROM public.estoque_reservas WHERE checkout_id='$CK_D';")
eq "P8c status da vencida = expirada" "$V" "expirada"

V=$(Pq <<SQL | tail -1
SET test.uid='$STAFF';
SELECT COALESCE(disponivel::text, 'NULL') FROM public.atp_consultar('oben', ARRAY[1007]::bigint[]);
SQL
)
eq "P9 SKU sem sku_parametros → colchao 0: disponivel = saldo 20" "$V" "20"

echo "-- grupo N: FAIL-CLOSED (ausente/stale/invalido → indisponivel, nunca 0 fabricado) --"

V=$(Pq <<SQL | tail -1
SET test.uid='$STAFF';
SELECT confiavel::text || '/' || COALESCE(disponivel::text, 'NULL') || '/' || COALESCE(motivo, 'sem_motivo')
FROM public.atp_consultar('oben', ARRAY[1003]::bigint[]);
SQL
)
eq "N1 SKU sem linha em inventory_position → nao-confiavel, disponivel NULL" "$V" "false/NULL/saldo_indisponivel"

V=$(Pq <<SQL | tail -1
SET test.uid='$STAFF';
SELECT confiavel::text || '/' || COALESCE(disponivel::text, 'NULL') FROM public.atp_consultar('oben', ARRAY[1002]::bigint[]);
SQL
)
eq "N2 synced_at 25h atras (>24h) → STALE → nao-confiavel" "$V" "false/NULL"

R=$(Pq <<SQL | tail -1
SET test.uid='$STAFF';
SELECT r.j->>'motivo' FROM (
  SELECT jsonb_array_elements(public.reservar_estoque('oben', gen_random_uuid(), '[{"omie_codigo_produto":1002,"quantidade":1}]'::jsonb, 30)->'recusas') AS j
) r;
SQL
)
eq "N2b reservar SKU stale → recusa saldo_indisponivel" "$R" "saldo_indisponivel"

V=$(Pq <<SQL | tail -1
SET test.uid='$STAFF';
SELECT confiavel::text FROM public.atp_consultar('oben', ARRAY[1004]::bigint[]);
SQL
)
eq "N3 saldo negativo → nao-confiavel" "$V" "false"

V=$(Pq <<SQL | tail -1
SET test.uid='$STAFF';
SELECT confiavel::text FROM public.atp_consultar('oben', ARRAY[1005]::bigint[]);
SQL
)
eq "N4 saldo NULL → nao-confiavel" "$V" "false"

V=$(Pq <<SQL | tail -1
SET test.uid='$STAFF';
SELECT confiavel::text FROM public.atp_consultar('oben', ARRAY[1006]::bigint[]);
SQL
)
eq "N5 saldo NaN (ordena ACIMA de 0 em numeric!) → nao-confiavel" "$V" "false"

echo "-- grupo C: contrato (SQLSTATE esperada + re-raise do resto) --"

run_do() {  # roda um bloco DO como staff e devolve stdout+stderr (sentinelas via RAISE NOTICE)
  P -tA 2>&1 <<SQL
SET test.uid='$STAFF';
$1
SQL
}

R=$(run_do "DO \$\$ BEGIN
  PERFORM public.reservar_estoque('colacor', gen_random_uuid(), '[{\"omie_codigo_produto\":1,\"quantidade\":1}]'::jsonb, 30);
  RAISE NOTICE 'ATP_TESTE_C1_PASSOU_INDEVIDO';
EXCEPTION WHEN sqlstate '22023' THEN RAISE NOTICE 'ATP_TESTE_C1_BARROU_CERTO';
WHEN OTHERS THEN RAISE; END \$\$;")
case "$R" in
  *ATP_TESTE_C1_BARROU_CERTO*) ok "C1 pool 'colacor' → 22023 (fase 1 = oben only)";;
  *) bad "C1 pool invalido nao deu 22023: $R";;
esac

R=$(run_do "DO \$\$ BEGIN
  PERFORM public.reservar_estoque('oben', gen_random_uuid(), '[{\"omie_codigo_produto\":1001,\"quantidade\":1},{\"omie_codigo_produto\":1001,\"quantidade\":2}]'::jsonb, 30);
  RAISE NOTICE 'ATP_TESTE_C2_PASSOU_INDEVIDO';
EXCEPTION WHEN sqlstate '22023' THEN RAISE NOTICE 'ATP_TESTE_C2_BARROU_CERTO';
WHEN OTHERS THEN RAISE; END \$\$;")
case "$R" in
  *ATP_TESTE_C2_BARROU_CERTO*) ok "C2 item duplicado no payload → 22023";;
  *) bad "C2 duplicata nao deu 22023: $R";;
esac

R=$(run_do "DO \$\$ BEGIN
  PERFORM public.reservar_estoque('oben', gen_random_uuid(), '[{\"omie_codigo_produto\":1001,\"quantidade\":0}]'::jsonb, 30);
  RAISE NOTICE 'ATP_TESTE_C3_PASSOU_INDEVIDO';
EXCEPTION WHEN sqlstate '22023' THEN RAISE NOTICE 'ATP_TESTE_C3_BARROU_CERTO';
WHEN OTHERS THEN RAISE; END \$\$;")
case "$R" in
  *ATP_TESTE_C3_BARROU_CERTO*) ok "C3 quantidade 0 → 22023";;
  *) bad "C3 quantidade 0 nao deu 22023: $R";;
esac

R=$(run_do "DO \$\$ BEGIN
  PERFORM public.reservar_estoque('oben', gen_random_uuid(), '[{\"omie_codigo_produto\":1001,\"quantidade\":1}]'::jsonb, 300);
  RAISE NOTICE 'ATP_TESTE_C4_PASSOU_INDEVIDO';
EXCEPTION WHEN sqlstate '22023' THEN RAISE NOTICE 'ATP_TESTE_C4_BARROU_CERTO';
WHEN OTHERS THEN RAISE; END \$\$;")
case "$R" in
  *ATP_TESTE_C4_BARROU_CERTO*) ok "C4 TTL 300min (>240) → 22023";;
  *) bad "C4 TTL fora do range nao deu 22023: $R";;
esac

R=$(run_do "DO \$\$ BEGIN
  PERFORM public.reservar_estoque('oben', gen_random_uuid(), '{\"omie_codigo_produto\":1001}'::jsonb, 30);
  RAISE NOTICE 'ATP_TESTE_C5_PASSOU_INDEVIDO';
EXCEPTION WHEN sqlstate '22023' THEN RAISE NOTICE 'ATP_TESTE_C5_BARROU_CERTO';
WHEN OTHERS THEN RAISE; END \$\$;")
case "$R" in
  *ATP_TESTE_C5_BARROU_CERTO*) ok "C5 p_itens objeto (nao array) → 22023";;
  *) bad "C5 p_itens invalido nao deu 22023: $R";;
esac

R=$(P -tA 2>&1 <<'SQL'
DO $$ BEGIN
  INSERT INTO public.estoque_reservas (pool, omie_codigo_produto, quantidade, checkout_id, expira_em)
  VALUES ('oben', 9999, -5, gen_random_uuid(), now() + interval '30 minutes');
  RAISE NOTICE 'ATP_TESTE_C6_PASSOU_INDEVIDO';
EXCEPTION WHEN sqlstate '23514' THEN RAISE NOTICE 'ATP_TESTE_C6_BARROU_CERTO';
WHEN OTHERS THEN RAISE; END $$;
SQL
)
case "$R" in
  *ATP_TESTE_C6_BARROU_CERTO*) ok "C6 CHECK da tabela rejeita quantidade negativa (23514)";;
  *) bad "C6 CHECK nao rejeitou: $R";;
esac

echo "-- grupo A: autorizacao (gate 42501, RLS, escrita so via RPC) --"

R=$(P -tA 2>&1 <<SQL
SET test.uid='$CUST';
SET ROLE authenticated;
DO \$\$ BEGIN
  PERFORM public.reservar_estoque('oben', gen_random_uuid(), '[{"omie_codigo_produto":1001,"quantidade":1}]'::jsonb, 30);
  RAISE NOTICE 'ATP_TESTE_A1_PASSOU_INDEVIDO';
EXCEPTION WHEN sqlstate '42501' THEN RAISE NOTICE 'ATP_TESTE_A1_BARROU_CERTO';
WHEN OTHERS THEN RAISE; END \$\$;
SQL
)
case "$R" in
  *ATP_TESTE_A1_BARROU_CERTO*) ok "A1 customer chama reservar_estoque → 42501 (gate)";;
  *) bad "A1 customer nao foi barrado: $R";;
esac

R=$(P -tA 2>&1 <<'SQL'
SET ROLE anon;
DO $$ BEGIN
  PERFORM public.reservar_estoque('oben', gen_random_uuid(), '[{"omie_codigo_produto":1001,"quantidade":1}]'::jsonb, 30);
  RAISE NOTICE 'ATP_TESTE_A2_PASSOU_INDEVIDO';
EXCEPTION WHEN sqlstate '42501' THEN RAISE NOTICE 'ATP_TESTE_A2_BARROU_CERTO';
WHEN OTHERS THEN RAISE; END $$;
SQL
)
case "$R" in
  *ATP_TESTE_A2_BARROU_CERTO*) ok "A2 anon sem EXECUTE → 42501";;
  *) bad "A2 anon nao foi barrado: $R";;
esac

V=$(Pq <<SQL | tail -1
SET test.uid='$STAFF';
SET ROLE authenticated;
SELECT (count(*) > 0)::text FROM public.estoque_reservas;
SQL
)
eq "A3 RLS: staff (authenticated) LE as reservas" "$V" "true"

V=$(Pq <<SQL | tail -1
SET test.uid='$CUST';
SET ROLE authenticated;
SELECT count(*)::text FROM public.estoque_reservas;
SQL
)
eq "A3b RLS: customer le ZERO linhas" "$V" "0"

R=$(P -tA 2>&1 <<SQL
SET test.uid='$STAFF';
SET ROLE authenticated;
DO \$\$ BEGIN
  INSERT INTO public.estoque_reservas (pool, omie_codigo_produto, quantidade, checkout_id, expira_em)
  VALUES ('oben', 1001, 1, gen_random_uuid(), now() + interval '30 minutes');
  RAISE NOTICE 'ATP_TESTE_A4_PASSOU_INDEVIDO';
EXCEPTION WHEN sqlstate '42501' THEN RAISE NOTICE 'ATP_TESTE_A4_BARROU_CERTO';
WHEN OTHERS THEN RAISE; END \$\$;
SQL
)
case "$R" in
  *ATP_TESTE_A4_BARROU_CERTO*) ok "A4 INSERT direto de staff via PostgREST-role → 42501 (escrita SO via RPC)";;
  *) bad "A4 INSERT direto nao foi barrado: $R";;
esac

R=$(P -tA 2>&1 <<SQL
SET test.uid='$STAFF';
SET ROLE authenticated;
DO \$\$ BEGIN
  PERFORM * FROM private.atp_disponivel('oben', 1001, NULL);
  RAISE NOTICE 'ATP_TESTE_A5_PASSOU_INDEVIDO';
EXCEPTION WHEN sqlstate '42501' THEN RAISE NOTICE 'ATP_TESTE_A5_BARROU_CERTO';
WHEN OTHERS THEN RAISE; END \$\$;
SQL
)
case "$R" in
  *ATP_TESTE_A5_BARROU_CERTO*) ok "A5 atp_disponivel (interna) inacessivel a authenticated → 42501 (sem bypass do gate)";;
  *) bad "A5 authenticated executou a interna: $R";;
esac

V=$(Pq <<SQL | tail -1
SET test.role='service_role';
SET ROLE service_role;
SELECT COALESCE(disponivel::text, 'NULL') FROM public.atp_consultar('oben', ARRAY[1007]::bigint[]);
SQL
)
eq "A6 service_role consulta (engines/fase 3) → 20" "$V" "20"

V=$(Pq <<SQL | tail -1
SET test.uid='$MASTER';
SELECT confiavel::text FROM public.atp_consultar('oben', ARRAY[1007]::bigint[]);
SQL
)
eq "A7 master tambem passa no gate" "$V" "true"

echo "-- grupo K: concorrencia (2 conexoes, mesmo saldo) --"
# A reserva 8 de 10 e SEGURA a transacao aberta 3s; B (0.8s depois) pede 8 →
# espera no advisory xact-lock → ve a reserva de A → recusa. Invariante final:
# exatamente 1 vencedora, soma ativa ≤ saldo.
P -q <<SQL &
SET test.uid='$STAFF';
BEGIN;
SELECT public.reservar_estoque('oben', '$CK_K1', '[{"omie_codigo_produto":1010,"quantidade":8}]'::jsonb, 30);
SELECT pg_sleep(3);
COMMIT;
SQL
BG_PID=$!
sleep 0.8
R_B=$(Pq <<SQL | tail -1
SET test.uid='$STAFF';
SELECT public.reservar_estoque('oben', '$CK_K2', '[{"omie_codigo_produto":1010,"quantidade":8}]'::jsonb, 30)->>'ok';
SQL
)
wait "$BG_PID" || bad "K1-infra: a conexao A (background) falhou — resultado abaixo nao mede o lock"
eq "K1 concorrente que chegou depois foi RECUSADO" "$R_B" "false"
V=$(Pq -c "SELECT count(*)::text || '/' || COALESCE(sum(quantidade),0)::text FROM public.estoque_reservas WHERE omie_codigo_produto=1010 AND status='ativa';")
eq "K1b invariante: exatamente 1 reserva ativa somando 8 (≤ saldo 10)" "$V" "1/8"

# ══════════════════════════════════════════════════════════════════════════════
# ZONA 5 — FALSIFICAÇÕES (sabota → exige o vermelho → restaura via re-apply da MIG)
# Cada sabotagem PROVA que aplicou (guard no-op / efeito observável) antes de julgar.
# ══════════════════════════════════════════════════════════════════════════════
echo "-- falsificacoes (a migration sabotada TEM de derrubar o assert correspondente) --"

# F1: frescor 24h → 24000h (o bound de staleness deixa de existir)
P -q <<'SQL'
DO $$
DECLARE def text; novo text;
BEGIN
  def := pg_get_functiondef('private.atp_disponivel(text,bigint,uuid)'::regprocedure);
  novo := replace(def, $s$interval '24 hours'$s$, $s$interval '24000 hours'$s$);
  IF novo = def THEN RAISE EXCEPTION 'FALSIF_F1_REPLACE_NOOP'; END IF;
  EXECUTE novo;
END $$;
SQL
R=$(Pq <<SQL | tail -1
SET test.uid='$STAFF';
SELECT public.reservar_estoque('oben', gen_random_uuid(), '[{"omie_codigo_produto":1002,"quantidade":1}]'::jsonb, 30)->>'ok';
SQL
)
eq "F1 SEM o bound de frescor, o SKU stale passa a reservar (dente do N2b provado)" "$R" "true"
P -q -f "$MIG"
V=$(Pq <<SQL | tail -1
SET test.uid='$STAFF';
SELECT confiavel::text FROM public.atp_consultar('oben', ARRAY[1002]::bigint[]);
SQL
)
eq "F1r restaurado: stale volta a ser nao-confiavel" "$V" "false"

# F2: desconto de reservas alheias zerado (status match sabotado → reservado = 0)
R1=$(Pq <<SQL | tail -1
SET test.uid='$STAFF';
SELECT public.reservar_estoque('oben', gen_random_uuid(), '[{"omie_codigo_produto":1011,"quantidade":25}]'::jsonb, 30)->>'ok';
SQL
)
eq "F2-baseline primeiro checkout reserva 25 de 30" "$R1" "true"
R2=$(Pq <<SQL | tail -1
SET test.uid='$STAFF';
SELECT public.reservar_estoque('oben', gen_random_uuid(), '[{"omie_codigo_produto":1011,"quantidade":25}]'::jsonb, 30)->>'ok';
SQL
)
eq "F2-baseline segundo checkout e recusado (25+25 > 30)" "$R2" "false"
P -q <<'SQL'
DO $$
DECLARE def text; novo text;
BEGIN
  def := pg_get_functiondef('private.atp_disponivel(text,bigint,uuid)'::regprocedure);
  novo := replace(def, $s$r.status = 'ativa'$s$, $s$r.status = 'sabotado_nunca'$s$);
  IF novo = def THEN RAISE EXCEPTION 'FALSIF_F2_REPLACE_NOOP'; END IF;
  EXECUTE novo;
END $$;
SQL
R3=$(Pq <<SQL | tail -1
SET test.uid='$STAFF';
SELECT public.reservar_estoque('oben', gen_random_uuid(), '[{"omie_codigo_produto":1011,"quantidade":25}]'::jsonb, 30)->>'ok';
SQL
)
eq "F2 SEM descontar reservas alheias, o oversell passa (dente do P3 provado)" "$R3" "true"
P -q -f "$MIG"

# F3: gate sabotado → cap_estoque_reservar sempre true
P -q <<'SQL'
CREATE OR REPLACE FUNCTION private.cap_estoque_reservar(_uid uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$ SELECT true; $function$;
SQL
V=$(Pq -c "SELECT private.cap_estoque_reservar(NULL)::text;")
eq "F3-guard sabotagem aplicada (cap(NULL) virou true)" "$V" "true"
R=$(P -tA 2>&1 <<SQL
SET test.uid='$CUST';
SET ROLE authenticated;
DO \$\$ BEGIN
  PERFORM public.reservar_estoque('oben', gen_random_uuid(), '[{"omie_codigo_produto":1007,"quantidade":1}]'::jsonb, 30);
  RAISE NOTICE 'ATP_TESTE_F3_CUSTOMER_ENTROU';
EXCEPTION WHEN sqlstate '42501' THEN RAISE NOTICE 'ATP_TESTE_F3_AINDA_BARRADO';
WHEN OTHERS THEN RAISE; END \$\$;
SQL
)
case "$R" in
  *ATP_TESTE_F3_CUSTOMER_ENTROU*) ok "F3 com o gate sabotado o customer ENTRA (dente do A1 provado)";;
  *) bad "F3 sabotagem do gate nao abriu a porta — assert A1 sem dente? $R";;
esac
P -q -f "$MIG"
V=$(Pq -c "SELECT private.cap_estoque_reservar(NULL)::text;")
eq "F3r restaurado: cap(NULL) volta a false (fail-closed)" "$V" "false"

# F4: colchão de segurança zerado (empresa do parametro sabotada)
R=$(Pq <<SQL | tail -1
SET test.uid='$STAFF';
SELECT public.reservar_estoque('oben', gen_random_uuid(), '[{"omie_codigo_produto":1012,"quantidade":10}]'::jsonb, 30)->>'ok';
SQL
)
eq "F4-baseline saldo 20 seg 15 → pedir 10 e recusado (disponivel 5)" "$R" "false"
P -q <<'SQL'
DO $$
DECLARE def text; novo text;
BEGIN
  def := pg_get_functiondef('private.atp_disponivel(text,bigint,uuid)'::regprocedure);
  novo := replace(def, $s$WHEN 'oben' THEN 'OBEN'$s$, $s$WHEN 'oben' THEN 'SABOTADO'$s$);
  IF novo = def THEN RAISE EXCEPTION 'FALSIF_F4_REPLACE_NOOP'; END IF;
  EXECUTE novo;
END $$;
SQL
R=$(Pq <<SQL | tail -1
SET test.uid='$STAFF';
SELECT public.reservar_estoque('oben', gen_random_uuid(), '[{"omie_codigo_produto":1012,"quantidade":10}]'::jsonb, 30)->>'ok';
SQL
)
eq "F4 SEM o colchao, os 10 passam (dente do calculo de seguranca provado)" "$R" "true"
P -q -f "$MIG"

# F5: advisory lock trocado por SHARED (nao serializa) → corrida abre oversell
P -q <<'SQL'
DO $$
DECLARE def text; novo text;
BEGIN
  def := pg_get_functiondef('public.reservar_estoque(text,uuid,jsonb,integer)'::regprocedure);
  novo := replace(def, 'pg_advisory_xact_lock(', 'pg_advisory_xact_lock_shared(');
  IF novo = def THEN RAISE EXCEPTION 'FALSIF_F5_REPLACE_NOOP'; END IF;
  EXECUTE novo;
END $$;
SQL
P -q <<SQL &
SET test.uid='$STAFF';
BEGIN;
SELECT public.reservar_estoque('oben', gen_random_uuid(), '[{"omie_codigo_produto":1013,"quantidade":8}]'::jsonb, 30);
SELECT pg_sleep(3);
COMMIT;
SQL
BG_PID=$!
sleep 0.8
R_B=$(Pq <<SQL | tail -1
SET test.uid='$STAFF';
SELECT public.reservar_estoque('oben', gen_random_uuid(), '[{"omie_codigo_produto":1013,"quantidade":8}]'::jsonb, 30)->>'ok';
SQL
)
wait "$BG_PID" || bad "F5-infra: a conexao A (background) falhou — resultado abaixo nao mede a corrida"
V=$(Pq -c "SELECT COALESCE(sum(quantidade),0)::text FROM public.estoque_reservas WHERE omie_codigo_produto=1013 AND status='ativa';")
eq "F5 SEM o lock exclusivo, ambos entram e a soma estoura o saldo (16 > 10) — dente do K1 provado" "$R_B/$V" "true/16"
P -q -f "$MIG"

# ── veredito ──
echo "------------------------------"
echo "RESULTADO: $PASS ok / $FAIL fail"
TOTAL=$((PASS+FAIL))
if [ "$TOTAL" != "50" ]; then
  echo "ERR DENOMINADOR: esperava 50 asserts executados, rodaram $TOTAL — caminho pulado em silencio"
  exit 1
fi
[ "$FAIL" = "0" ] || { echo "HARNESS VERMELHO"; exit 1; }
echo "HARNESS VERDE (50/50, falsificacoes F1-F5 com dente provado)"
