#!/usr/bin/env bash
# ╔══════════════════════════════════════════════════════════════════════════════╗
# ║  PROVA PG17 — ATP FASE 1.1 (hardening pós-challenge Codex) [money-path]        ║
# ║  Migrations em CASCATA: 20260806101417 (fase 1) → 20260806225052 (fase 1.1)    ║
# ║                                                                                ║
# ║  ⚠️ VERSÃO COBERTA ≠ VERSÃO ENTREGUE (money-path.md, #1515). A 1.1 faz          ║
# ║  CREATE OR REPLACE da função INTEIRA, então os invariantes da fase 1 são        ║
# ║  RE-EXERCIDOS aqui (grupo R) sob a v1.1 — herdar a cobertura do harness         ║
# ║  anterior provaria uma função que ninguém mais executa.                        ║
# ║                                                                                ║
# ║  Novos invariantes (grupo C):                                                  ║
# ║   C1 saldo Infinity → não-confiável        C2 colchão inválido → fail-closed    ║
# ║   C3 contas do pool divergentes → f-c      C4 synced_at futuro → não-confiável  ║
# ║   C5 expira_em pelo relógio de PAREDE      C6 service_role sem DML direto       ║
# ║   C7 job de expiração roda SEM JWT (pg_cron)                                   ║
# ║  Falsificações G1..G6 sabotam a 1.1 e EXIGEM o vermelho correspondente.         ║
# ║                                                                                ║
# ║  Stub ESPELHA a prod (money-path.md): inclui os UNIQUE reais conferidos via     ║
# ║  psql-ro — UNIQUE(omie_codigo_produto, account) e UNIQUE(empresa, sku_codigo).  ║
# ║  Veredito por byte-compare (eq) com sentinelas ASCII exclusivas → imune à       ║
# ║  dobra de locale (C × pt_BR.UTF-8) que mordeu o #1483.                          ║
# ╚══════════════════════════════════════════════════════════════════════════════╝
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PGVER=17
PGBIN="/opt/homebrew/opt/postgresql@${PGVER}/bin"
PORT="${PGPORT_TEST:-5462}"
SLUG="atp-fase1-1"
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
# ZONA 1 — PRÉ-REQUISITOS (espelho da PROD, conferido via psql-ro 2026-08-06)
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

CREATE OR REPLACE FUNCTION public.has_role(_user_id uuid, _role public.app_role)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $f$ SELECT EXISTS (SELECT 1 FROM public.user_roles WHERE user_id = _user_id AND role = _role) $f$;

-- inventory_position: colunas E CHAVES reais da prod (o stub da fase 1 omitia
-- a UNIQUE e o product_id — achado E do challenge Codex)
CREATE TABLE IF NOT EXISTS public.inventory_position (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  omie_codigo_produto bigint NOT NULL,
  product_id uuid,
  account text NOT NULL DEFAULT 'vendas',
  saldo numeric DEFAULT 0,
  cmc numeric DEFAULT 0,
  preco_medio numeric DEFAULT 0,
  synced_at timestamptz DEFAULT now(),
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS inventory_position_produto_account_uq
  ON public.inventory_position (omie_codigo_produto, account);

CREATE TABLE IF NOT EXISTS public.sku_parametros (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  empresa text NOT NULL,
  sku_codigo_omie bigint NOT NULL,
  estoque_seguranca numeric
);
CREATE UNIQUE INDEX IF NOT EXISTS sku_parametros_empresa_sku_codigo_omie_key
  ON public.sku_parametros (empresa, sku_codigo_omie);

CREATE TABLE IF NOT EXISTS public.sales_orders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  checkout_id uuid,
  account text
);

-- pg_cron: a TABELA cron.job já vem de db/stubs-supabase.sql (jobid bigint PK,
-- jobname SEM unique) — não recriar. Faltam só as duas FUNÇÕES, com a mesma
-- assinatura do pg_cron real e o mesmo comportamento no caso que a migration
-- exercita: unschedule de job inexistente LANÇA (é o que o DO/EXCEPTION cobre).
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
# ZONA 2 — MIGRATIONS REAIS, EM CASCATA
# ══════════════════════════════════════════════════════════════════════════════
MIG1="$REPO_ROOT/supabase/migrations/20260806101417_atp_reserva_estoque_fase1.sql"
MIG="$REPO_ROOT/supabase/migrations/20260806225052_atp_reserva_estoque_fase1_1_hardening.sql"
P -q -f "$MIG1"
P -q -f "$MIG"
echo "migrations aplicadas: fase1 + $(basename "$MIG")"

# guard anti-#1515: a versão SOB TESTE tem de ser a 1.1, não a da fase 1
V=$(Pq -c "SELECT (pg_get_functiondef('private.atp_disponivel(text,bigint,uuid)'::regprocedure) LIKE '%Infinity%')::text;")
eq "Z0 a funcao viva e a da FASE 1.1 (contem o bound de finitude)" "$V" "true"

# ══════════════════════════════════════════════════════════════════════════════
# ZONA 3 — SEEDS
# ══════════════════════════════════════════════════════════════════════════════
STAFF='22222222-2222-2222-2222-222222222222'
MASTER='33333333-3333-3333-3333-333333333333'
CUST='44444444-4444-4444-4444-444444444444'
CK_A='bbbbbbb1-0000-0000-0000-000000000001'
CK_B='bbbbbbb1-0000-0000-0000-000000000002'
CK_C='bbbbbbb1-0000-0000-0000-000000000003'
CK_D='bbbbbbb1-0000-0000-0000-000000000004'
CK_E='bbbbbbb1-0000-0000-0000-000000000005'
CK_K1='bbbbbbb1-0000-0000-0000-00000000000a'
CK_K2='bbbbbbb1-0000-0000-0000-00000000000b'

P -q <<SQL
INSERT INTO auth.users(id) VALUES ('$STAFF'), ('$MASTER'), ('$CUST') ON CONFLICT DO NOTHING;
INSERT INTO public.user_roles(user_id, role) VALUES
  ('$STAFF', 'employee'), ('$MASTER', 'master'), ('$CUST', 'customer');

INSERT INTO public.inventory_position (omie_codigo_produto, account, saldo, synced_at) VALUES
  -- fase 1 re-exercida (grupo R)
  (1001, 'vendas',         100,  now() - interval '1 hour'),
  (1001, 'oben',           100,  now() - interval '30 days'),  -- velha: perde a eleicao
  (1001, 'colacor_vendas', 5000, now()),                       -- FORA do pool
  (1002, 'oben',           50,   now() - interval '25 hours'), -- STALE
  (1004, 'vendas',         -5,   now()),                       -- negativo
  (1005, 'vendas',         NULL, now()),                       -- NULL
  (1006, 'vendas',         'NaN'::numeric, now()),             -- NaN
  (1007, 'vendas',         20,   now()),                       -- sem parametro
  (1010, 'vendas',         10,   now()),                       -- concorrencia R7
  -- novos (grupo C)
  (2001, 'vendas', 'Infinity'::numeric, now()),                -- C1 Infinity
  (2002, 'vendas', 50, now()),                                 -- C2a colchao NaN
  (2003, 'vendas', 50, now()),                                 -- C2b colchao Infinity
  (2004, 'vendas', 50, now()),                                 -- C2c colchao negativo
  (2005, 'vendas', 50, now()),                                 -- C2d colchao valido
  (2010, 'vendas', 10, now() - interval '10 minutes'),         -- C3a divergente
  (2010, 'oben',   90, now() - interval '5 minutes'),          -- C3a divergente (mais fresca)
  (2011, 'vendas', 40, now() - interval '10 minutes'),         -- C3b iguais
  (2011, 'oben',   40, now() - interval '5 minutes'),          -- C3b iguais
  (2012, 'vendas', 30, now() - interval '5 minutes'),          -- C3c fresca
  (2012, 'oben',   999, now() - interval '40 hours'),          -- C3c stale divergente: ignorada
  (2020, 'vendas', 70, now() + interval '30 minutes'),         -- C4 futuro alem da folga
  (2021, 'vendas', 70, now() + interval '2 minutes'),          -- C4b futuro DENTRO da folga
  (2030, 'vendas', 60, now()),                                 -- C5 relogio de parede
  (2040, 'vendas', 60, now()),                                 -- C6 service_role
  (2050, 'vendas', 60, now()),                                 -- C7 job sem JWT
  (3001, 'vendas', 60, now()),                                 -- G1 falsificacao
  (3002, 'vendas', 60, now()),                                 -- G2
  (3003, 'vendas', 10, now() - interval '10 minutes'),
  (3003, 'oben',   90, now() - interval '5 minutes'),          -- G3
  (3004, 'vendas', 60, now() + interval '30 minutes'),         -- G4
  (3005, 'vendas', 60, now()),                                 -- G5
  (3006, 'vendas', 60, now());                                 -- G6

INSERT INTO public.sku_parametros (empresa, sku_codigo_omie, estoque_seguranca) VALUES
  ('OBEN', 1001, 10),
  ('OBEN', 1002, 0),
  ('OBEN', 2002, 'NaN'::numeric),        -- C2a
  ('OBEN', 2003, 'Infinity'::numeric),   -- C2b
  ('OBEN', 2004, -7),                    -- C2c
  ('OBEN', 2005, 15),                    -- C2d
  ('OBEN', 3002, 'NaN'::numeric);        -- G2
SQL

# ══════════════════════════════════════════════════════════════════════════════
# ZONA 4 — GRUPO R: invariantes da FASE 1, RE-EXERCIDOS sob a v1.1 (anti-#1515)
# ══════════════════════════════════════════════════════════════════════════════
echo "-- grupo R: invariantes da fase 1 re-exercidos sob a versao 1.1 --"

R=$(Pq <<SQL | tail -1
SET test.uid='$STAFF';
SELECT public.reservar_estoque('oben', '$CK_A', '[{"omie_codigo_produto":1001,"quantidade":50}]'::jsonb, 30)->>'ok';
SQL
)
eq "R1 reserva feliz (saldo 100, colchao 10, pede 50)" "$R" "true"

V=$(Pq <<SQL | tail -1
SET test.uid='$STAFF';
SELECT COALESCE(disponivel::text,'NULL') FROM public.atp_consultar('oben', ARRAY[1001]::bigint[]);
SQL
)
eq "R2 conta segue 100-50-10 = 40 (colacor_vendas 5000 nao contamina o pool)" "$V" "40"

R=$(Pq <<SQL | tail -1
SET test.uid='$STAFF';
SELECT public.reservar_estoque('oben', '$CK_B', '[{"omie_codigo_produto":1001,"quantidade":45}]'::jsonb, 30)->>'ok';
SQL
)
eq "R3 pede 45 com 40 disponivel → recusa" "$R" "false"

V=$(Pq <<SQL | tail -1
SET test.uid='$STAFF';
SELECT confiavel::text FROM public.atp_consultar('oben', ARRAY[1002]::bigint[]);
SQL
)
eq "R4 stale >24h segue nao-confiavel" "$V" "false"

V=$(Pq <<SQL | tail -1
SET test.uid='$STAFF';
SELECT string_agg(confiavel::text, ',' ORDER BY omie_codigo_produto)
FROM public.atp_consultar('oben', ARRAY[1004,1005,1006]::bigint[]);
SQL
)
eq "R5 negativo/NULL/NaN seguem nao-confiaveis" "$V" "false,false,false"

R=$(Pq <<SQL | tail -1
SET test.uid='$STAFF';
SELECT public.reservar_estoque('oben', '$CK_A', '[{"omie_codigo_produto":1001,"quantidade":50}]'::jsonb, 30)->>'ok';
SQL
)
eq "R6 re-reserva do MESMO checkout (retry) segue ok" "$R" "true"
V=$(Pq -c "SELECT count(*)::text || '/' || COALESCE(sum(quantidade),0)::text FROM public.estoque_reservas WHERE checkout_id='$CK_A' AND status='ativa';")
eq "R6b substituiu, nao somou" "$V" "1/50"

R=$(Pq <<SQL | tail -1
SET test.uid='$STAFF';
SELECT public.reservar_estoque('oben', '$CK_C', '[{"omie_codigo_produto":1007,"quantidade":5},{"omie_codigo_produto":9999,"quantidade":1}]'::jsonb, 30)->>'ok';
SQL
)
eq "R7 multi-item com 1 SKU inexistente → recusa o CONJUNTO" "$R" "false"
V=$(Pq -c "SELECT count(*)::text FROM public.estoque_reservas WHERE checkout_id='$CK_C';")
eq "R7b all-or-nothing segue valendo (0 linhas)" "$V" "0"

R=$(P -tA 2>&1 <<SQL
SET test.uid='$CUST';
SET ROLE authenticated;
DO \$\$ BEGIN
  PERFORM public.reservar_estoque('oben', gen_random_uuid(), '[{"omie_codigo_produto":1001,"quantidade":1}]'::jsonb, 30);
  RAISE NOTICE 'ATP11_R8_PASSOU_INDEVIDO';
EXCEPTION WHEN sqlstate '42501' THEN RAISE NOTICE 'ATP11_R8_BARROU_CERTO';
WHEN OTHERS THEN RAISE; END \$\$;
SQL
)
case "$R" in
  *ATP11_R8_BARROU_CERTO*) ok "R8 customer segue barrado com 42501";;
  *) bad "R8 customer nao foi barrado: $R";;
esac

P -q -c "INSERT INTO public.estoque_reservas (pool, omie_codigo_produto, quantidade, checkout_id, status, expira_em) VALUES ('oben', 1001, 30, '$CK_D', 'ativa', now() - interval '1 minute');"
V=$(Pq <<SQL | tail -1
SET test.uid='$STAFF';
SELECT COALESCE(disponivel::text,'NULL') FROM public.atp_consultar('oben', ARRAY[1001]::bigint[]);
SQL
)
eq "R9 reserva VENCIDA segue sem descontar (disponivel 40)" "$V" "40"

echo "-- grupo R: concorrencia re-exercida sob a v1.1 --"
# Sincronizacao por ESTADO, nao por sleep cego (achado E do Codex): espera a
# conexao A aparecer em pg_stat_activity DENTRO do pg_sleep antes de soltar B.
P -q <<SQL &
SET application_name = 'atp11_conexao_A';
SET test.uid='$STAFF';
BEGIN;
SELECT public.reservar_estoque('oben', '$CK_K1', '[{"omie_codigo_produto":1010,"quantidade":8}]'::jsonb, 30);
SELECT pg_sleep(4);
COMMIT;
SQL
BG_PID=$!
ESPERA=0
while [ "$ESPERA" -lt 100 ]; do
  PRONTO=$(Pq -c "SELECT count(*)::text FROM pg_stat_activity WHERE application_name='atp11_conexao_A' AND query LIKE '%pg_sleep%';" || echo 0)
  [ "$PRONTO" = "1" ] && break
  ESPERA=$((ESPERA+1)); sleep 0.1
done
eq "R10-infra conexao A entrou no pg_sleep com a reserva ja feita (sem sleep cego)" "$PRONTO" "1"
R_B=$(Pq <<SQL | tail -1
SET test.uid='$STAFF';
SELECT public.reservar_estoque('oben', '$CK_K2', '[{"omie_codigo_produto":1010,"quantidade":8}]'::jsonb, 30)->>'ok';
SQL
)
wait "$BG_PID" || bad "R10-infra: conexao A falhou — o resultado abaixo nao mede o lock"
eq "R10 concorrente que chegou depois foi RECUSADO" "$R_B" "false"
V=$(Pq -c "SELECT count(*)::text || '/' || COALESCE(sum(quantidade),0)::text FROM public.estoque_reservas WHERE omie_codigo_produto=1010 AND status='ativa';")
eq "R10b invariante: 1 reserva ativa somando 8 (<= saldo 10)" "$V" "1/8"

# ══════════════════════════════════════════════════════════════════════════════
# ZONA 5 — GRUPO C: os invariantes NOVOS da fase 1.1
# ══════════════════════════════════════════════════════════════════════════════
echo "-- grupo C1: saldo Infinity --"
V=$(Pq <<SQL | tail -1
SET test.uid='$STAFF';
SELECT confiavel::text || '/' || COALESCE(disponivel::text,'NULL') FROM public.atp_consultar('oben', ARRAY[2001]::bigint[]);
SQL
)
eq "C1 saldo Infinity → nao-confiavel, disponivel NULL" "$V" "false/NULL"
R=$(Pq <<SQL | tail -1
SET test.uid='$STAFF';
SELECT public.reservar_estoque('oben', gen_random_uuid(), '[{"omie_codigo_produto":2001,"quantidade":999999}]'::jsonb, 30)->>'ok';
SQL
)
eq "C1b reservar contra saldo Infinity → recusa" "$R" "false"

echo "-- grupo C2: estoque_seguranca invalido = FAIL-CLOSED (nao colchao 0) --"
V=$(Pq <<SQL | tail -1
SET test.uid='$STAFF';
SELECT string_agg(confiavel::text, ',' ORDER BY omie_codigo_produto)
FROM public.atp_consultar('oben', ARRAY[2002,2003,2004]::bigint[]);
SQL
)
eq "C2 colchao NaN/Infinity/negativo → os TRES nao-confiaveis" "$V" "false,false,false"
R=$(Pq <<SQL | tail -1
SET test.uid='$STAFF';
SELECT public.reservar_estoque('oben', gen_random_uuid(), '[{"omie_codigo_produto":2002,"quantidade":1}]'::jsonb, 30)->>'ok';
SQL
)
eq "C2b reservar com colchao NaN → recusa (antes o NaN aceitava TUDO)" "$R" "false"
V=$(Pq <<SQL | tail -1
SET test.uid='$STAFF';
SELECT COALESCE(disponivel::text,'NULL') FROM public.atp_consultar('oben', ARRAY[2005]::bigint[]);
SQL
)
eq "C2c colchao VALIDO segue descontando: 50-0-15 = 35" "$V" "35"
V=$(Pq <<SQL | tail -1
SET test.uid='$STAFF';
SELECT COALESCE(disponivel::text,'NULL') FROM public.atp_consultar('oben', ARRAY[1007]::bigint[]);
SQL
)
eq "C2d parametro AUSENTE segue colchao 0 (nao regrediu p/ fail-closed)" "$V" "20"

echo "-- grupo C3: divergencia entre as contas do pool --"
V=$(Pq <<SQL | tail -1
SET test.uid='$STAFF';
SELECT confiavel::text || '/' || COALESCE(disponivel::text,'NULL') FROM public.atp_consultar('oben', ARRAY[2010]::bigint[]);
SQL
)
eq "C3 duas contas frescas DIVERGENTES (10 x 90) → nao-confiavel" "$V" "false/NULL"
V=$(Pq <<SQL | tail -1
SET test.uid='$STAFF';
SELECT COALESCE(disponivel::text,'NULL') FROM public.atp_consultar('oben', ARRAY[2011]::bigint[]);
SQL
)
eq "C3b duas contas frescas CONCORDANTES (40 x 40) → confiavel, disponivel 40" "$V" "40"
V=$(Pq <<SQL | tail -1
SET test.uid='$STAFF';
SELECT COALESCE(disponivel::text,'NULL') FROM public.atp_consultar('oben', ARRAY[2012]::bigint[]);
SQL
)
eq "C3c conta STALE divergente nao envenena a fresca (30, nao NULL)" "$V" "30"

echo "-- grupo C4: bound SUPERIOR do synced_at --"
V=$(Pq <<SQL | tail -1
SET test.uid='$STAFF';
SELECT confiavel::text FROM public.atp_consultar('oben', ARRAY[2020]::bigint[]);
SQL
)
eq "C4 synced_at 30min no FUTURO (alem da folga) → nao-confiavel" "$V" "false"
V=$(Pq <<SQL | tail -1
SET test.uid='$STAFF';
SELECT confiavel::text FROM public.atp_consultar('oben', ARRAY[2021]::bigint[]);
SQL
)
eq "C4b synced_at 2min no futuro (folga de relogio) segue confiavel" "$V" "true"

echo "-- grupo C5: expira_em pelo relogio de PAREDE, nao pelo inicio da transacao --"
# Dentro de UMA transacao: now() congela no BEGIN; dorme 3s; reserva com TTL 5min.
# clock_timestamp() → expira_em ~= now()+3s+5min ⇒ MAIOR que now()+5min.
# now()            → expira_em  = now()+5min      ⇒ NAO maior.
# DO block (nao BEGIN/COMMIT): o command tag "COMMIT" do psql viraria a ultima
# linha e o tail -1 mediria o TAG em vez do resultado — falso vermelho.
R=$(P -tA 2>&1 <<SQL
SET test.uid='$STAFF';
DO \$\$
DECLARE v_res boolean;
BEGIN
  PERFORM pg_sleep(3);
  PERFORM public.reservar_estoque('oben', '$CK_E', '[{"omie_codigo_produto":2030,"quantidade":1}]'::jsonb, 5);
  SELECT (r.expira_em > now() + interval '5 minutes') INTO v_res
  FROM public.estoque_reservas r WHERE r.checkout_id = '$CK_E';
  IF v_res THEN RAISE NOTICE 'ATP11_C5_RELOGIO_DE_PAREDE';
  ELSE RAISE NOTICE 'ATP11_C5_PRESO_AO_INICIO'; END IF;
END \$\$;
SQL
)
case "$R" in
  *ATP11_C5_RELOGIO_DE_PAREDE*) ok "C5 apos 3s de espera na transacao, expira_em passa de now()+TTL (relogio de parede)";;
  *) bad "C5 expira_em ficou preso ao inicio da transacao: $R";;
esac

echo "-- grupo C6: '1 writer' — service_role perde o DML direto --"
R=$(P -tA 2>&1 <<SQL
SET test.role='service_role';
SET ROLE service_role;
DO \$\$ BEGIN
  INSERT INTO public.estoque_reservas (pool, omie_codigo_produto, quantidade, checkout_id, expira_em)
  VALUES ('oben', 2040, 1000000, gen_random_uuid(), now() + interval '4 hours');
  RAISE NOTICE 'ATP11_C6_ESCREVEU_DIRETO';
EXCEPTION WHEN sqlstate '42501' THEN RAISE NOTICE 'ATP11_C6_BARROU_CERTO';
WHEN OTHERS THEN RAISE; END \$\$;
SQL
)
case "$R" in
  *ATP11_C6_BARROU_CERTO*) ok "C6 service_role NAO insere direto (42501) — o desenho '1 writer' virou verdade";;
  *) bad "C6 service_role escreveu direto, contornando calculo e locks: $R";;
esac
V=$(Pq <<SQL | tail -1
SET test.role='service_role';
SET ROLE service_role;
SELECT COALESCE(disponivel::text,'NULL') FROM public.atp_consultar('oben', ARRAY[2040]::bigint[]);
SQL
)
eq "C6b service_role segue CONSULTANDO pela RPC (engines da fase 3 nao quebram)" "$V" "60"
R=$(Pq <<SQL | tail -1
SET test.uid='$STAFF';
SELECT public.reservar_estoque('oben', gen_random_uuid(), '[{"omie_codigo_produto":2040,"quantidade":5}]'::jsonb, 30)->>'ok';
SQL
)
eq "C6c a RPC continua escrevendo (SECURITY DEFINER escreve como OWNER)" "$R" "true"

echo "-- grupo C7: job de expiracao roda SEM JWT (pg_cron nativo) --"
# zera o passivo de vencidas deixado pelos cenarios anteriores (o R9) por UPDATE
# direto, NAO pela funcao sob teste — senao a limpeza dependeria do que ela prova
P -q -c "UPDATE public.estoque_reservas SET status='expirada' WHERE status='ativa' AND expira_em <= now();" > /dev/null
P -q -c "INSERT INTO public.estoque_reservas (pool, omie_codigo_produto, quantidade, checkout_id, status, expira_em) VALUES ('oben', 2050, 3, gen_random_uuid(), 'ativa', now() - interval '1 minute');"
# sessao LIMPA: sem test.uid, sem test.role — exatamente o pg_cron nativo
V=$(Pq -c "SELECT private.expirar_reservas_vencidas_job()->>'expiradas';")
eq "C7 job expira SEM JWT (auth.uid e auth.role NULL) — a RPC publica dava 42501 aqui" "$V" "1"
R=$(P -tA 2>&1 <<'SQL'
DO $$ BEGIN
  PERFORM public.expirar_reservas_vencidas();
  RAISE NOTICE 'ATP11_C7_PUBLICA_PASSOU_SEM_JWT';
EXCEPTION WHEN sqlstate '42501' THEN RAISE NOTICE 'ATP11_C7_PUBLICA_BARROU_CERTO';
WHEN OTHERS THEN RAISE; END $$;
SQL
)
case "$R" in
  *ATP11_C7_PUBLICA_BARROU_CERTO*) ok "C7b a RPC publica segue exigindo staff (o gate nao foi afrouxado)";;
  *) bad "C7b a RPC publica deixou passar sem JWT: $R";;
esac
R=$(P -tA 2>&1 <<SQL
SET test.uid='$STAFF';
SET ROLE authenticated;
DO \$\$ BEGIN
  PERFORM private.expirar_reservas_vencidas_job();
  RAISE NOTICE 'ATP11_C7_JOB_EXPOSTO';
EXCEPTION WHEN sqlstate '42501' THEN RAISE NOTICE 'ATP11_C7_JOB_PROTEGIDO';
WHEN OTHERS THEN RAISE; END \$\$;
SQL
)
case "$R" in
  *ATP11_C7_JOB_PROTEGIDO*) ok "C7c authenticated NAO executa o job privado (42501)";;
  *) bad "C7c o job privado ficou executavel por authenticated: $R";;
esac
V=$(Pq -c "SELECT schedule FROM cron.job WHERE jobname='atp-expirar-reservas-vencidas';")
eq "C7d a migration agendou o cron de higiene" "$V" "*/15 * * * *"

echo "-- grupo A: privilegio medido por CATALOGO (nao por SQLSTATE ambigua) --"
# Achado E do Codex: o assert de anon da fase 1 via 42501 do GATE INTERNO, entao
# passaria mesmo com EXECUTE concedido por acidente. Medir o privilegio direto.
V=$(Pq -c "SELECT has_function_privilege('anon','public.reservar_estoque(text,uuid,jsonb,integer)','EXECUTE')::text;")
eq "A1 anon NAO tem EXECUTE em reservar_estoque (medido no catalogo)" "$V" "false"
V=$(Pq -c "SELECT has_function_privilege('anon','public.atp_consultar(text,bigint[])','EXECUTE')::text;")
eq "A1b anon NAO tem EXECUTE em atp_consultar" "$V" "false"
V=$(Pq -c "SELECT has_function_privilege('authenticated','private.atp_disponivel(text,bigint,uuid)','EXECUTE')::text;")
eq "A2 authenticated NAO tem EXECUTE na interna atp_disponivel" "$V" "false"
V=$(Pq -c "SELECT has_table_privilege('service_role','public.estoque_reservas','INSERT')::text || '/' || has_table_privilege('service_role','public.estoque_reservas','SELECT')::text;")
eq "A3 service_role: INSERT revogado, SELECT preservado" "$V" "false/true"
V=$(Pq -c "SELECT has_table_privilege('authenticated','public.estoque_reservas','INSERT')::text;")
eq "A4 authenticated segue sem INSERT" "$V" "false"

# ══════════════════════════════════════════════════════════════════════════════
# ZONA 6 — FALSIFICAÇÕES (sabota → exige o vermelho → restaura re-aplicando a 1.1)
# Cada sabotagem PROVA que aplicou (replace no-op ABORTA) antes de julgar.
# ══════════════════════════════════════════════════════════════════════════════
echo "-- falsificacoes: a 1.1 sabotada TEM de derrubar o assert correspondente --"

sabota_atp() {  # $1 = de, $2 = para, $3 = tag
  P -q <<SQL
DO \$\$
DECLARE def text; novo text;
BEGIN
  def := pg_get_functiondef('private.atp_disponivel(text,bigint,uuid)'::regprocedure);
  novo := replace(def, \$s\$$1\$s\$, \$s\$$2\$s\$);
  IF novo = def THEN RAISE EXCEPTION 'FALSIF_$3_REPLACE_NOOP'; END IF;
  EXECUTE novo;
END \$\$;
SQL
}

# G1: bound de finitude removido → Infinity volta a passar
sabota_atp "AND b.saldo < 'Infinity'::numeric" "AND true" "G1"
R=$(Pq <<SQL | tail -1
SET test.uid='$STAFF';
SELECT public.reservar_estoque('oben', gen_random_uuid(), '[{"omie_codigo_produto":2001,"quantidade":999999}]'::jsonb, 30)->>'ok';
SQL
)
eq "G1 SEM o bound de finitude, Infinity volta a reservar qualquer quantidade (dente do C1)" "$R" "true"
P -q -f "$MIG"

# G2: guard do colchao invalido removido.
# ⚠️ O invariante tem DUAS defesas (money-path §"a falsificacao mente quando o
# assert tem duas defesas"): (a) o filtro do COALESCE, que EXCLUI NaN/Inf/negativo
# e degrada o colchao para 0, e (b) o seg_invalida, que reprova o SKU. Sabotar (b)
# NAO faz o SKU aceitar 999999 — (a) ainda entrega colchao 0 e a recusa por
# quantidade continua valendo. A 1ª versao deste assert media exatamente isso e
# voltou INERTE (verde sob sabotagem). O dente de (b) e o FAIL-CLOSED, entao e o
# fail-closed que se mede: com o guard, false/NULL; sem ele, o colchao some EM
# SILENCIO e o SKU volta a prometer os 60.
V=$(Pq <<SQL | tail -1
SET test.uid='$STAFF';
SELECT confiavel::text || '/' || COALESCE(disponivel::text,'NULL') FROM public.atp_consultar('oben', ARRAY[3002]::bigint[]);
SQL
)
eq "G2-baseline com o guard, colchao NaN reprova o SKU" "$V" "false/NULL"
sabota_atp "AND NOT s.seg_invalida" "AND true" "G2"
V=$(Pq <<SQL | tail -1
SET test.uid='$STAFF';
SELECT confiavel::text || '/' || COALESCE(disponivel::text,'NULL') FROM public.atp_consultar('oben', ARRAY[3002]::bigint[]);
SQL
)
eq "G2 SEM o fail-closed, o colchao invalido vira 0 em silencio e o SKU volta a prometer (dente do C2)" "$V" "true/60"
P -q -f "$MIG"

# G3: guard de divergencia removido → a conta mais fresca (90) vence sozinha
sabota_atp "AND NOT b.divergente" "AND true" "G3"
V=$(Pq <<SQL | tail -1
SET test.uid='$STAFF';
SELECT COALESCE(disponivel::text,'NULL') FROM public.atp_consultar('oben', ARRAY[3003]::bigint[]);
SQL
)
eq "G3 SEM o guard de divergencia, publica os 90 da conta mais fresca em vez de recusar (dente do C3)" "$V" "90"
P -q -f "$MIG"

# G4: bound superior do synced_at removido → futuro volta a passar
sabota_atp "AND b.synced_at <= now() + interval '5 minutes'" "AND true" "G4"
V=$(Pq <<SQL | tail -1
SET test.uid='$STAFF';
SELECT confiavel::text FROM public.atp_consultar('oben', ARRAY[3004]::bigint[]);
SQL
)
eq "G4 SEM o bound superior, synced_at 30min no futuro volta a ser confiavel (dente do C4)" "$V" "true"
P -q -f "$MIG"

# G5: clock_timestamp() volta a now() → a reserva nasce vencida apos espera
P -q <<'SQL'
DO $$
DECLARE def text; novo text;
BEGIN
  def := pg_get_functiondef('public.reservar_estoque(text,uuid,jsonb,integer)'::regprocedure);
  novo := replace(def, 'v_expira := clock_timestamp() +', 'v_expira := now() +');
  IF novo = def THEN RAISE EXCEPTION 'FALSIF_G5_REPLACE_NOOP'; END IF;
  EXECUTE novo;
END $$;
SQL
R=$(P -tA 2>&1 <<SQL
SET test.uid='$STAFF';
DO \$\$
DECLARE v_res boolean;
BEGIN
  PERFORM pg_sleep(3);
  PERFORM public.reservar_estoque('oben', gen_random_uuid(), '[{"omie_codigo_produto":3005,"quantidade":1}]'::jsonb, 5);
  SELECT (r.expira_em > now() + interval '5 minutes') INTO v_res
  FROM public.estoque_reservas r WHERE r.omie_codigo_produto = 3005;
  IF v_res THEN RAISE NOTICE 'ATP11_G5_AINDA_PAREDE';
  ELSE RAISE NOTICE 'ATP11_G5_PRESO_AO_INICIO'; END IF;
END \$\$;
SQL
)
case "$R" in
  *ATP11_G5_PRESO_AO_INICIO*) ok "G5 COM now(), expira_em fica preso ao inicio da transacao (dente do C5)";;
  *) bad "G5 sabotagem do clock_timestamp nao mudou nada — assert C5 sem dente? $R";;
esac
P -q -f "$MIG"

# G6: GRANT de volta a service_role → o insert direto reabre
P -q -c "GRANT INSERT ON TABLE public.estoque_reservas TO service_role;"
V=$(Pq -c "SELECT has_table_privilege('service_role','public.estoque_reservas','INSERT')::text;")
eq "G6-guard sabotagem aplicada (service_role reganhou INSERT)" "$V" "true"
R=$(P -tA 2>&1 <<SQL
SET test.role='service_role';
SET ROLE service_role;
DO \$\$ BEGIN
  INSERT INTO public.estoque_reservas (pool, omie_codigo_produto, quantidade, checkout_id, expira_em)
  VALUES ('oben', 3006, 1000000, gen_random_uuid(), now() + interval '4 hours');
  RAISE NOTICE 'ATP11_G6_ESCREVEU_DIRETO';
EXCEPTION WHEN sqlstate '42501' THEN RAISE NOTICE 'ATP11_G6_AINDA_BARRADO';
WHEN OTHERS THEN RAISE; END \$\$;
SQL
)
case "$R" in
  *ATP11_G6_ESCREVEU_DIRETO*) ok "G6 COM o grant de volta, service_role fura o '1 writer' (dente do C6)";;
  *) bad "G6 sabotagem do grant nao reabriu a escrita — assert C6 sem dente? $R";;
esac
P -q -f "$MIG"
V=$(Pq -c "SELECT has_table_privilege('service_role','public.estoque_reservas','INSERT')::text;")
eq "G6r restaurado: service_role volta a nao ter INSERT" "$V" "false"

# ── veredito ──
echo "------------------------------"
echo "RESULTADO: $PASS ok / $FAIL fail"
TOTAL=$((PASS+FAIL))
if [ "$TOTAL" != "48" ]; then
  echo "ERR DENOMINADOR: esperava 48 asserts executados, rodaram $TOTAL — caminho pulado em silencio"
  exit 1
fi
[ "$FAIL" = "0" ] || { echo "HARNESS VERMELHO"; exit 1; }
echo "HARNESS VERDE (48/48, falsificacoes G1-G6 com dente provado)"
