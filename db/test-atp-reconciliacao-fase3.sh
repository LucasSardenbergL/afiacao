#!/usr/bin/env bash
# ╔════════════════════════════════════════════════════════════════════════════════╗
# ║  PROVA PG17 — ATP FASE 3: a reserva do PV firme para de morrer por TTL         ║
# ║  Migration: 20260808012000_atp_reconciliacao_fase3.sql                          ║
# ║  (sobre as fases 1 + 1.1 + 2, aplicadas em ordem)                               ║
# ║  + FASE 3.1: 20261009120000_atp_fase3_1_elo_pid.sql, aplicada POR CIMA — as     ║
# ║    zonas 4-8 re-exercem a fase 3 sob as funções que a 3.1 recria (versão        ║
# ║    coberta = versão entregue) e a ZONA 9 prova o elo que sobrevive ao DELETE.   ║
# ║                                                                                ║
# ║  Invariante CENTRAL:                                                           ║
# ║   • reserva de PV FIRME (pedido com omie_pedido_id) não morre por relógio —     ║
# ║     segue descontando no cálculo depois do expira_em, e o job de TTL não a      ║
# ║     carimba. Reserva PRÉ-PV e reserva sem pedido seguem no TTL.                 ║
# ║   • o FATO é lido da linha CANÔNICA do pedido, não da linha vinculada — o app   ║
# ║     cria a linha "push" e o sync mantém o status na "pull" irmã (medido em      ║
# ║     prod: 19 pedidos oben com 2+ linhas).                                       ║
# ║   • cancelamento CONFIRMADO no Omie libera; deleted_at NÃO (o front o grava     ║
# ║     antes da confirmação remota).                                               ║
# ║   • o consumo NÃO é automático — carimba a observação e a resolução é humana,   ║
# ║     auditada (atp_resolver_reserva).                                            ║
# ║                                                                                ║
# ║  ⚠️ O TTL tinha DUAS defesas independentes (o filtro do cálculo e o carimbo do  ║
# ║     job). Cobertas separadamente, e F1/F2 sabotam uma de cada vez.              ║
# ║                                                                                ║
# ║  Zona 6 re-exerce os invariantes das fases 1.1/2 SOB A VERSÃO NOVA da função    ║
# ║  (armadilha #1515: versão coberta ≠ versão entregue).                           ║
# ║                                                                                ║
# ║  Veredito por byte-compare (eq) com sentinelas ASCII — imune a dobra de locale. ║
# ╚════════════════════════════════════════════════════════════════════════════════╝
set -euo pipefail

# ── arranque PG17 descartável ──
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PGVER=17
PGBIN="/opt/homebrew/opt/postgresql@${PGVER}/bin"
PORT="${PGPORT_TEST:-5463}"
SLUG="atp-fase3"
DATA="$(mktemp -d "/tmp/pgtest-${SLUG}.XXXXXX")/data"
export LC_ALL="${LC_ALL:-C}" LANG="${LANG:-C}"

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
P()  { "$PGBIN/psql" -X -p "$PORT" -h /tmp -U postgres -d prove -v ON_ERROR_STOP=1 "$@"; }
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
-- Réplica dos DEFAULT PRIVILEGES da PROD (pg_default_acl): objeto novo em public
-- nasce com ALL/EXECUTE p/ anon/authenticated/service_role. SEM isto o harness
-- fica MENOS permissivo que a prod e os asserts de privilégio viram tautologia.
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO anon, authenticated, service_role;

CREATE SCHEMA IF NOT EXISTS private;
GRANT USAGE ON SCHEMA private TO authenticated, service_role;

DO $$ BEGIN CREATE TYPE public.app_role AS ENUM ('master','employee','customer');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS public.user_roles (user_id uuid NOT NULL, role public.app_role NOT NULL);

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

-- Espelha a PROD, não o design (money-path §"Stub de tabela"): as colunas e o
-- índice único abaixo foram conferidos por psql-ro em 2026-08-08. O UNIQUE
-- PARCIAL é o que garante "no máximo uma linha canônica por (account, pedido)" —
-- sem ele o stub deixaria o LIMIT 1 da função parecer arbitrário quando não é.
CREATE TABLE IF NOT EXISTS public.sales_orders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  checkout_id uuid,
  account text,
  items jsonb,
  omie_pedido_id bigint,
  status text,
  hash_payload text,
  origem text,
  deleted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  -- fase 3.1: o que o write-back do PV grava (tipos conferidos por psql-ro, 2026-10-09)
  omie_numero_pedido text,
  omie_payload jsonb,
  omie_response jsonb
);
CREATE UNIQUE INDEX IF NOT EXISTS uniq_sales_orders_omie_pedido_id
  ON public.sales_orders (account, omie_pedido_id)
  WHERE hash_payload IS NOT NULL AND omie_pedido_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uniq_sales_orders_omie_hash
  ON public.sales_orders (account, hash_payload) WHERE hash_payload LIKE 'omie\_%';

-- pg_cron: fase 1.1 e fase 3 agendam jobs. A TABELA cron.job vem do stub; faltam
-- as FUNÇÕES (mesma assinatura/comportamento do pg_cron real).
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
# ZONA 2 — MIGRATIONS REAIS (fases 1 → 1.1 → 2 → 3, em ordem)
# ══════════════════════════════════════════════════════════════════════════════
MIG1="$REPO_ROOT/supabase/migrations/20260806101417_atp_reserva_estoque_fase1.sql"
MIG11="$REPO_ROOT/supabase/migrations/20260806225052_atp_reserva_estoque_fase1_1_hardening.sql"
MIG2="$REPO_ROOT/supabase/migrations/20260807015000_atp_gate_pedido_fase2.sql"
MIG3="$REPO_ROOT/supabase/migrations/20260808012000_atp_reconciliacao_fase3.sql"
MIG31="$REPO_ROOT/supabase/migrations/20261009120000_atp_fase3_1_elo_pid.sql"
P -q -f "$MIG1"; P -q -f "$MIG11"; P -q -f "$MIG2"; P -q -f "$MIG3"
# a 3.1 vai em UMA transação, como o BEGIN; … COMMIT; do bloco do SQL Editor (a TRAVA só vale assim)
P -q -1 -f "$MIG31"
echo "migrations aplicadas: fase1 + fase1.1 + fase2 + fase3 + fase3.1"

# ══════════════════════════════════════════════════════════════════════════════
# ZONA 3 — SEEDS
# ══════════════════════════════════════════════════════════════════════════════
STAFF='22222222-2222-2222-2222-222222222222'
CUST='44444444-4444-4444-4444-444444444444'

# Um SKU por cenário — assim um assert nunca mede a reserva do vizinho.
#  3001 PV firme (não expira)        3002 sem pedido (TTL vale)
#  3003 cancelado NA CANÔNICA        3004 deleted_at (NÃO libera)
#  3005 faturado (observa, não come) 3006 PRÉ-PV (TTL vale)
#  3007 hard-delete                  3008 fase 2 ponta-a-ponta
#  3013 cancelado só na PUSH (NÃO age)   3014 regressão de status
P -q <<SQL
INSERT INTO auth.users (id) VALUES ('$STAFF'), ('$CUST') ON CONFLICT DO NOTHING;
INSERT INTO public.user_roles (user_id, role) VALUES ('$STAFF','employee'), ('$CUST','customer');

INSERT INTO public.inventory_position (omie_codigo_produto, account, saldo, synced_at)
SELECT s, a, 10, now() FROM unnest(ARRAY[3001,3002,3003,3004,3005,3006,3007,3008,3013,3014]) s,
                            unnest(ARRAY['oben','vendas']) a;
SQL

SO_VIVO='e3000000-0000-0000-0000-000000000001'
SO_CANC='e3000000-0000-0000-0000-000000000003'
SO_DEL='e3000000-0000-0000-0000-000000000004'
SO_FAT='e3000000-0000-0000-0000-000000000005'
SO_PREPV='e3000000-0000-0000-0000-000000000006'
SO_HARD='e3000000-0000-0000-0000-000000000007'
SO_F2='e3000000-0000-0000-0000-000000000008'
SO_PUSHC='e3000000-0000-0000-0000-000000000013'
SO_REGR='e3000000-0000-0000-0000-000000000014'

# ⚠️ A MODELAGEM QUE O CHALLENGE REVELOU: o app cria a linha PUSH (origem
# preenchida, hash_payload NULL) e o sync mantém o status na linha PULL irmã
# (hash_payload='omie_<account>_<pid>'). A reserva se vincula à PUSH. Medido em
# prod: o pedido da 1ª reserva real tem exatamente esse par (push 'enviado' /
# pull 'importado'). Por isso toda linha push abaixo fica num status que o sync
# NUNCA atualizaria — se o código lesse a linha vinculada, nada aconteceria.
P -q <<SQL
-- linhas PUSH (as que as reservas apontam)
INSERT INTO public.sales_orders (id, checkout_id, account, items, omie_pedido_id, status, hash_payload, origem) VALUES
  ('$SO_VIVO', 'c3000000-0000-0000-0000-000000000001','oben','[{"omie_codigo_produto":3001,"quantidade":2}]',9001,'enviado',NULL,'web_staff'),
  ('$SO_CANC', 'c3000000-0000-0000-0000-000000000003','oben','[{"omie_codigo_produto":3003,"quantidade":2}]',9003,'enviado',NULL,'web_staff'),
  ('$SO_DEL',  'c3000000-0000-0000-0000-000000000004','oben','[{"omie_codigo_produto":3004,"quantidade":2}]',9004,'enviado',NULL,'web_staff'),
  ('$SO_FAT',  'c3000000-0000-0000-0000-000000000005','oben','[{"omie_codigo_produto":3005,"quantidade":2}]',9005,'enviado',NULL,'web_staff'),
  ('$SO_PREPV','c3000000-0000-0000-0000-000000000006','oben','[{"omie_codigo_produto":3006,"quantidade":2}]',NULL, 'rascunho',NULL,'web_staff'),
  ('$SO_HARD', 'c3000000-0000-0000-0000-000000000007','oben','[{"omie_codigo_produto":3007,"quantidade":2}]',9007,'enviado',NULL,'web_staff'),
  ('$SO_F2',   'c3000000-0000-0000-0000-000000000008','oben','[{"omie_codigo_produto":3008,"quantidade":2}]',NULL, 'rascunho',NULL,'web_staff'),
  ('$SO_PUSHC','c3000000-0000-0000-0000-000000000013','oben','[{"omie_codigo_produto":3013,"quantidade":2}]',9013,'cancelado',NULL,'web_staff'),
  ('$SO_REGR', 'c3000000-0000-0000-0000-000000000014','oben','[{"omie_codigo_produto":3014,"quantidade":2}]',9014,'enviado',NULL,'web_staff');

-- linhas PULL irmãs (canônicas — é onde o sync escreve o status de verdade)
INSERT INTO public.sales_orders (account, omie_pedido_id, status, hash_payload, items) VALUES
  ('oben', 9001, 'importado',  'omie_oben_9001', '[]'),
  ('oben', 9003, 'cancelado',  'omie_oben_9003', '[]'),
  ('oben', 9004, 'importado',  'omie_oben_9004', '[]'),
  ('oben', 9005, 'faturado',   'omie_oben_9005', '[]'),
  ('oben', 9007, 'importado',  'omie_oben_9007', '[]'),
  ('oben', 9013, 'importado',  'omie_oben_9013', '[]'),
  ('oben', 9014, 'faturado',   'omie_oben_9014', '[]');
SQL

# helper: cria reserva ativa pela RPC real e vincula ao pedido (como o gate faz)
seed_reserva() { # $1=sku $2=qtd $3=checkout $4=sales_order_id(uuid|NULL)
  Pq <<SQL >/dev/null
SET test.uid='$STAFF'; SET test.role='authenticated';
SELECT public.reservar_estoque('oben','$3'::uuid,
  jsonb_build_array(jsonb_build_object('omie_codigo_produto',$1,'quantidade',$2)));
SQL
  if [ "$4" != "NULL" ]; then
    P -q -c "UPDATE public.estoque_reservas SET sales_order_id='$4' WHERE checkout_id='$3' AND status='ativa'"
  fi
}
reservado()  { Pq -c "SELECT reservado FROM private.atp_disponivel('oben', $1)"; }
disponivel() { Pq -c "SELECT COALESCE(disponivel::text,'NULL') FROM private.atp_disponivel('oben', $1)"; }
vencer()     { P -q -c "UPDATE public.estoque_reservas SET expira_em = now() - interval '1 hour' WHERE checkout_id='$1'"; }
reconciliar(){ Pq -c "SELECT private.atp_reconciliar_job()"; }   # sessão LIMPA = como o pg_cron roda
expirar()    { Pq -c "SELECT private.expirar_reservas_vencidas_job()"; }
st()         { Pq -c "SELECT status FROM public.estoque_reservas WHERE checkout_id='$1'"; }
carimbo()    { Pq -c "SELECT (faturamento_observado_em IS NOT NULL)::text FROM public.estoque_reservas WHERE checkout_id='$1'"; }

CK_VIVO='c3000000-0000-0000-0000-000000000001'
CK_SEM='c3000000-0000-0000-0000-000000000002'
CK_CANC='c3000000-0000-0000-0000-000000000003'
CK_DEL='c3000000-0000-0000-0000-000000000004'
CK_FAT='c3000000-0000-0000-0000-000000000005'
CK_PREPV='c3000000-0000-0000-0000-000000000006'
CK_HARD='c3000000-0000-0000-0000-000000000007'
CK_PUSHC='c3000000-0000-0000-0000-000000000013'
CK_REGR='c3000000-0000-0000-0000-000000000014'

seed_reserva 3001 2 "$CK_VIVO"  "$SO_VIVO"
seed_reserva 3002 2 "$CK_SEM"   NULL
seed_reserva 3003 2 "$CK_CANC"  "$SO_CANC"
seed_reserva 3004 2 "$CK_DEL"   "$SO_DEL"
seed_reserva 3005 2 "$CK_FAT"   "$SO_FAT"
seed_reserva 3006 2 "$CK_PREPV" "$SO_PREPV"
seed_reserva 3007 2 "$CK_HARD"  "$SO_HARD"
seed_reserva 3013 2 "$CK_PUSHC" "$SO_PUSHC"
seed_reserva 3014 2 "$CK_REGR"  "$SO_REGR"

echo "=== seeds prontos ==="

# ══════════════════════════════════════════════════════════════════════════════
# ZONA 4 — O INVARIANTE CENTRAL (a janela PV→saldo)
# ══════════════════════════════════════════════════════════════════════════════
echo "-- invariante central: a reserva do PV firme nao morre por relogio --"

# A1 — baseline: antes de vencer, as três descontam igual. Sem isto, "desconta"
#      e "o cenário nunca mediu nada" produzem o mesmo verde.
eq "A1 baseline PV firme desconta"  "$(reservado 3001)" "2"
eq "A1 baseline sem pedido desconta" "$(reservado 3002)" "2"
eq "A1 baseline pre-PV desconta"     "$(reservado 3006)" "2"

vencer "$CK_VIVO"; vencer "$CK_SEM"; vencer "$CK_PREPV"

# A2 — O CORAÇÃO DA ENTREGA. Mesma linha de código, três resultados: só o PV
#      firme sobrevive ao relógio.
eq "A2 vencida com PV FIRME ainda desconta (janela fechada)" "$(reservado 3001)" "2"
eq "A2 vencida SEM pedido para de descontar (TTL vale)"      "$(reservado 3002)" "0"
eq "A2 vencida PRE-PV para de descontar (nao ha PV firme)"   "$(reservado 3006)" "0"
eq "A2 disponivel com PV firme reflete a reserva viva" "$(disponivel 3001)" "8"
eq "A2 disponivel sem pedido volta ao saldo cheio"     "$(disponivel 3002)" "10"

# A3 — a SEGUNDA defesa (o carimbo do job), medida separadamente do cálculo
R=$(expirar)
case "$R" in *'"expiradas": 2'*|*'"expiradas":2'*) ok "A3 job de TTL expirou exatamente 2 (sem pedido + pre-PV)";; *) bad "A3 esperava 2 expiradas, veio: $R";; esac
eq "A3 reserva de PV firme NAO foi carimbada pelo TTL" "$(st "$CK_VIVO")"  "ativa"
eq "A3 reserva sem pedido foi carimbada expirada"      "$(st "$CK_SEM")"   "expirada"
eq "A3 reserva pre-PV foi carimbada expirada"          "$(st "$CK_PREPV")" "expirada"

# A4 — o carimbo não muda o cálculo (as duas defesas são independentes)
eq "A4 apos o job, PV firme segue descontando" "$(reservado 3001)" "2"

# A5 — A EXPIRADA NÃO RESSUSCITA quando o pedido ganha PV depois.
# Cenário levantado por outra sessão do mesmo épico (coordenação multi-sessão,
# challenge Codex independente): reserva A expira → retry do MESMO pedido cria B
# (reservar_estoque só substitui as ATIVAS, a expirada fica) → o PV é confirmado
# → se a suspensão do TTL olhasse a expirada, A+B do mesmo (pedido, SKU) seriam
# compromisso em DOBRO. Aqui não acontece porque o predicado exige status='ativa',
# e este assert TRAVA isso: quem "melhorar" o predicado para incluir expirada
# reabre o duplo, e o vermelho aponta para cá. Medido antes de escrever: 2, não 4.
P -q -c "UPDATE public.sales_orders SET omie_pedido_id = 9006 WHERE id='$SO_PREPV'"
eq "A5 expirada NAO ressuscita quando o PV e confirmado depois" "$(reservado 3006)" "0"

# ══════════════════════════════════════════════════════════════════════════════
# ZONA 5 — O FATO VEM DA LINHA CANÔNICA, NÃO DA VINCULADA
# (achado A do challenge, medido em prod: 19 pedidos oben com 2+ linhas)
# ══════════════════════════════════════════════════════════════════════════════
echo "-- reconciliacao: le a linha canonica, nao a push --"

# B0 — o cenário é o de prod: a linha VINCULADA está em 'enviado' nos dois casos,
#      e só a canônica distingue. Se o código lesse a vinculada, B1 e B2 dariam
#      o MESMO resultado — o assert perde o dente sem esta prova de montagem.
eq "B0 linha vinculada do cancelado esta em 'enviado' (nao diz cancelado)" \
   "$(Pq -c "SELECT status FROM public.sales_orders WHERE id='$SO_CANC'")" "enviado"
eq "B0 a canonica irma e que diz cancelado" \
   "$(Pq -c "SELECT status FROM public.sales_orders WHERE hash_payload='omie_oben_9003'")" "cancelado"

R=$(reconciliar)
case "$R" in *'"liberadas_por_cancelamento": 1'*|*'"liberadas_por_cancelamento":1'*) ok "B1 liberou exatamente 1 (o cancelado na canonica)";; *) bad "B1 esperava 1 liberada, veio: $R";; esac
eq "B1 cancelamento confirmado na canonica -> liberada" "$(st "$CK_CANC")" "liberada"
eq "B1 liberada para de descontar" "$(reservado 3003)" "0"

# B2 — o INVERSO: 'cancelado' só na linha PUSH, canônica em 'importado'.
#      Ler a vinculada liberaria estoque de pedido vivo. Este par (B1×B2) é o que
#      prova a direção da leitura — um sozinho não distingue.
eq "B2 push diz cancelado mas a canonica NAO -> nao libera" "$(st "$CK_PUSHC")" "ativa"
eq "B2 reserva segue descontando" "$(reservado 3013)" "2"

# B3 — deleted_at NÃO libera (o front o grava ANTES da confirmação do Omie)
eq "B3 deleted_at sozinho nao libera" "$(st "$CK_DEL")" "ativa"
P -q -c "UPDATE public.sales_orders SET deleted_at = now() WHERE id='$SO_DEL'"
R=$(reconciliar)
eq "B3 mesmo com deleted_at preenchido, segue ativa" "$(st "$CK_DEL")" "ativa"
eq "B3 e segue descontando" "$(reservado 3004)" "2"

# B4 — faturado: OBSERVA e NÃO consome (a prova de baixa não existe — item B)
eq "B4 faturado na canonica -> carimbou observacao" "$(carimbo "$CK_FAT")" "true"
eq "B4 faturado NAO consome automaticamente"        "$(st "$CK_FAT")" "ativa"
eq "B4 reserva observada AINDA desconta (fail-closed)" "$(reservado 3005)" "2"
case "$R" in *'"aguardando_resolucao": 2'*|*'"aguardando_resolucao":2'*) ok "B4 contador de aguardando resolucao = 2";; *) bad "B4 esperava 2 aguardando, veio: $R";; esac

# B5 — REGRESSÃO de status entre passadas: o carimbo é rearmado
eq "B5 carimbo presente antes da regressao" "$(carimbo "$CK_REGR")" "true"
P -q -c "UPDATE public.sales_orders SET status='separacao' WHERE hash_payload='omie_oben_9014'"
R=$(reconciliar)
case "$R" in *'"carimbos_rearmados": 1'*|*'"carimbos_rearmados":1'*) ok "B5 status regrediu -> carimbo rearmado";; *) bad "B5 esperava 1 rearmado, veio: $R";; esac
eq "B5 carimbo limpo apos regressao" "$(carimbo "$CK_REGR")" "false"
# … e um faturamento NOVO volta a carimbar (o rearme não pode ser um caminho sem volta)
P -q -c "UPDATE public.sales_orders SET status='faturado' WHERE hash_payload='omie_oben_9014'"
reconciliar >/dev/null
eq "B5 novo faturamento volta a carimbar" "$(carimbo "$CK_REGR")" "true"

# B6 — hard-delete do pedido: FK ON DELETE SET NULL zera o vínculo e a reserva
#      volta ao regime de TTL — na hora, no cálculo (o tick só muda o status).
#      ⚠️ Sob a 3.1 isto vale SÓ para a reserva confirmada SEM o par próprio (o
#      seed vincula direto, como o edge antigo fazia). A reserva confirmada pela
#      atp_confirmar_pv faz o CONTRÁRIO — ZONA 9 (E3-E5). Os dois lados juntos
#      provam que é o par, e não outra coisa, que segura o elo.
vencer "$CK_HARD"
eq "B6 antes do delete, PV firme nao expira" "$(reservado 3007)" "2"
P -q -c "DELETE FROM public.sales_orders WHERE id='$SO_HARD'"
eq "B6 FK SET NULL zerou o vinculo" \
   "$(Pq -c "SELECT (sales_order_id IS NULL)::text FROM public.estoque_reservas WHERE checkout_id='$CK_HARD'")" "true"
eq "B6 sem vinculo, o TTL volta a valer NO CALCULO (nao espera tick)" "$(reservado 3007)" "0"
expirar >/dev/null
eq "B6 e o job passa a carimba-la" "$(st "$CK_HARD")" "expirada"

# B7 — IDEMPOTÊNCIA: re-rodar não muda estado nem duplica trilha
T1=$(Pq -c "SELECT count(*) FROM public.atp_decisoes WHERE contexto='reconciliacao'")
reconciliar >/dev/null; reconciliar >/dev/null
T2=$(Pq -c "SELECT count(*) FROM public.atp_decisoes WHERE contexto='reconciliacao'")
eq "B7 2 ticks extras nao acrescentam evento na trilha" "$T2" "$T1"

# B8 — TRILHA append-only: cada desfecho virou evento novo
eq "B8 trilha registra a liberacao por cancelamento" \
   "$(Pq -c "SELECT count(*) FROM public.atp_decisoes WHERE decisao='liberado_por_cancelamento' AND contexto='reconciliacao'")" "1"
eq "B8 trilha registra o faturamento observado" \
   "$(Pq -c "SELECT count(*) FROM public.atp_decisoes WHERE decisao='faturamento_observado'")" "3"

# ══════════════════════════════════════════════════════════════════════════════
# ZONA 5B — A VÁLVULA HUMANA AUDITADA
# ══════════════════════════════════════════════════════════════════════════════
echo "-- resolucao humana auditada --"

RES_FAT=$(Pq -c "SELECT id FROM public.estoque_reservas WHERE checkout_id='$CK_FAT'")
resolver() { # $1=reserva $2=desfecho $3=motivo(literal SQL) $4=uid(''|uuid) $5=role
  P -q -v ON_ERROR_STOP=0 <<SQL 2>&1 | tr -d '\n'
SET test.uid='$4'; SET test.role='${5:-authenticated}';
DO \$\$ DECLARE v jsonb; BEGIN
  v := public.atp_resolver_reserva('$1'::uuid, $2, $3);
  RAISE NOTICE 'SENTINELA_RETORNO %', v->>'ok';
EXCEPTION
  WHEN insufficient_privilege THEN RAISE NOTICE 'SENTINELA_42501';
  WHEN invalid_parameter_value THEN RAISE NOTICE 'SENTINELA_22023';
END \$\$;
SQL
}

V=$(resolver "$RES_FAT" "'liberacao_forcada'" "NULL" "$STAFF")
case "$V" in *SENTINELA_22023*) ok "V1 motivo obrigatorio (22023)";; *) bad "V1 esperava 22023 sem motivo: $V";; esac
V=$(resolver "$RES_FAT" "'desfecho_invalido'" "'x'" "$STAFF")
case "$V" in *SENTINELA_22023*) ok "V2 desfecho fora do dominio (22023)";; *) bad "V2 esperava 22023: $V";; esac

# V3 — ⚠️ O GUARD DE ATOR HUMANO PRECISA SER ISOLADO. Com role='authenticated' e
# uid NULL, quem barraria é o gate cap_estoque_reservar (que devolve false para
# _uid NULL fora de service_role) — o 42501 viria dele, e sabotar o guard de ator
# deixaria o assert VERDE (a "falsificação inerte por segunda defesa" do
# money-path). Rodando como SERVICE_ROLE o gate PASSA (cap_estoque_reservar:45),
# e o único mecanismo que pode barrar é o `v_uid IS NULL` sob teste.
# É também o cenário real: cron/engine tem service_role e não tem ator.
eq "V3-pre o gate PASSA para service_role (isola o guard de ator)" \
   "$(Pq <<SQL | tail -1
SET test.uid=''; SET test.role='service_role';
SELECT private.cap_estoque_reservar(NULL)::text;
SQL
)" "true"
V=$(resolver "$RES_FAT" "'consumo_confirmado_manual'" "'NF 123 conferida'" "" "service_role")
case "$V" in *SENTINELA_42501*) ok "V3 service_role SEM ator humano -> 42501 (guard proprio)";; *) bad "V3 esperava 42501 sem uid: $V";; esac

V=$(resolver "$RES_FAT" "'consumo_confirmado_manual'" "'NF 123 conferida'" "$CUST")
case "$V" in *SENTINELA_42501*) ok "V4 customer barrado pelo gate -> 42501";; *) bad "V4 esperava 42501: $V";; esac
eq "V5 nenhuma recusa mexeu no estado da reserva" "$(st "$CK_FAT")" "ativa"

V=$(resolver "$RES_FAT" "'consumo_confirmado_manual'" "'NF 123 conferida'" "$STAFF")
case "$V" in *"SENTINELA_RETORNO true"*) ok "V6 staff com motivo resolve";; *) bad "V6 esperava ok:true: $V";; esac
eq "V6 desfecho consumo -> status consumida" "$(st "$CK_FAT")" "consumida"
eq "V6 consumida para de descontar"          "$(reservado 3005)" "0"
eq "V6 trilha registra o ato COM ator e motivo" \
   "$(Pq -c "SELECT count(*) FROM public.atp_decisoes WHERE decisao='consumo_confirmado_manual' AND contexto='resolucao_manual' AND actor_user_id='$STAFF' AND motivo_backorder='NF 123 conferida'")" "1"

# V7 — re-resolver uma reserva já resolvida é recusa de NEGÓCIO (jsonb), não erro
V=$(resolver "$RES_FAT" "'liberacao_forcada'" "'tentativa dupla'" "$STAFF")
case "$V" in *"SENTINELA_RETORNO false"*) ok "V7 reserva ja resolvida -> ok:false (nao excecao)";; *) bad "V7 esperava ok:false: $V";; esac
eq "V7 e o status nao muda" "$(st "$CK_FAT")" "consumida"

# V8 — a fila que o humano enxerga
V=$(Pq <<SQL | tail -1
SET test.uid='$STAFF'; SET test.role='authenticated';
SELECT count(*) FROM public.atp_reservas_pendentes(0);
SQL
)
eq "V8 atp_reservas_pendentes lista as ativas com pedido" "$V" "4"
V=$(Pq <<SQL | tail -1
SET test.uid='$STAFF'; SET test.role='authenticated';
SELECT status_canonico FROM public.atp_reservas_pendentes(0) WHERE sales_order_id='$SO_PUSHC';
SQL
)
eq "V8 a fila mostra o status CANONICO (nao o da linha vinculada)" "$V" "importado"

# ══════════════════════════════════════════════════════════════════════════════
# ZONA 6 — RE-EXERCER OS INVARIANTES DAS FASES 1.1/2 SOB A VERSÃO NOVA
# (armadilha #1515: a fase 3 recriou atp_disponivel INTEIRA, então a cobertura
#  da 1.1 aponta para uma função que ninguém mais executa)
# ══════════════════════════════════════════════════════════════════════════════
echo "-- guards C1-C4 re-exercidos SOB a atp_disponivel da fase 3 --"

P -q <<'SQL'
INSERT INTO public.inventory_position (omie_codigo_produto, account, saldo, synced_at) VALUES
  (3009,'oben','Infinity',now()), (3009,'vendas','Infinity',now()),
  (3010,'oben',10,now()),         (3010,'vendas',10,now()),
  (3011,'oben',10,now()),         (3011,'vendas',7,now()),
  (3012,'oben',10,now() + interval '2 hours'), (3012,'vendas',10,now() + interval '2 hours');
INSERT INTO public.sku_parametros (empresa, sku_codigo_omie, estoque_seguranca) VALUES ('OBEN', 3010, 'NaN');
SQL
eq "C1 saldo Infinity -> nao-confiavel (disponivel NULL)" "$(disponivel 3009)" "NULL"
eq "C2 estoque_seguranca NaN -> nao-confiavel"            "$(disponivel 3010)" "NULL"
eq "C3 contas do pool divergentes -> nao-confiavel"       "$(disponivel 3011)" "NULL"
eq "C4 synced_at no futuro (>5min) -> nao-confiavel"      "$(disponivel 3012)" "NULL"

# C5 — o gate da fase 2 continua íntegro ponta-a-ponta sob a versão nova
R=$(Pq <<SQL | tail -1
SET test.role='service_role';
SELECT public.atp_gate_pedido('$SO_F2'::uuid, true, '$STAFF'::uuid, false, NULL);
SQL
)
case "$R" in *'"reservado"'*) ok "C5 gate da fase 2 segue reservando sob a fase 3";; *) bad "C5 gate quebrou: $R";; esac
eq "C5 gate vincula sales_order_id na mesma transacao" \
   "$(Pq -c "SELECT count(*) FROM public.estoque_reservas WHERE sales_order_id='$SO_F2' AND status='ativa'")" "1"

# C6 — expira_em nasce no futuro (clock_timestamp, C5 da fase 1.1)
eq "C6 reserva nasce com expira_em no futuro" \
   "$(Pq -c "SELECT (expira_em > now())::text FROM public.estoque_reservas WHERE sales_order_id='$SO_F2'")" "true"

# ══════════════════════════════════════════════════════════════════════════════
# ZONA 7 — AUTORIZAÇÃO (privilégio por CATÁLOGO; gate por SQLSTATE — asserts
# distintos, porque 42501 tem DOIS emissores: falta de GRANT e o RAISE do gate)
# ══════════════════════════════════════════════════════════════════════════════
echo "-- autorizacao --"

eq "N1 anon sem EXECUTE em atp_reconciliar (catalogo)" \
   "$(Pq -c "SELECT has_function_privilege('anon','public.atp_reconciliar()','EXECUTE')::text")" "false"
eq "N2 authenticated COM EXECUTE em atp_reconciliar (quem barra e o gate interno)" \
   "$(Pq -c "SELECT has_function_privilege('authenticated','public.atp_reconciliar()','EXECUTE')::text")" "true"
eq "N3 authenticated sem EXECUTE no JOB privado (catalogo)" \
   "$(Pq -c "SELECT has_function_privilege('authenticated','private.atp_reconciliar_job()','EXECUTE')::text")" "false"
eq "N4 anon sem EXECUTE no JOB privado (catalogo)" \
   "$(Pq -c "SELECT has_function_privilege('anon','private.atp_reconciliar_job()','EXECUTE')::text")" "false"
eq "N5 anon sem EXECUTE em atp_resolver_reserva (catalogo)" \
   "$(Pq -c "SELECT has_function_privilege('anon','public.atp_resolver_reserva(uuid,text,text)','EXECUTE')::text")" "false"
eq "N6 anon sem EXECUTE em atp_reservas_pendentes (catalogo)" \
   "$(Pq -c "SELECT has_function_privilege('anon','public.atp_reservas_pendentes(integer)','EXECUTE')::text")" "false"
eq "N7 authenticated sem EXECUTE em atp_pedido_canonico (catalogo)" \
   "$(Pq -c "SELECT has_function_privilege('authenticated','private.atp_pedido_canonico(uuid)','EXECUTE')::text")" "false"

# N8 — o GATE (comportamento): customer na RPC pública leva 42501 do RAISE
V=$(P -q -v ON_ERROR_STOP=0 <<SQL 2>&1 | tr -d '\n'
SET test.uid='$CUST'; SET test.role='authenticated';
DO \$\$ BEGIN
  PERFORM public.atp_reconciliar();
  RAISE NOTICE 'SENTINELA_NAO_BARROU';
EXCEPTION WHEN insufficient_privilege THEN RAISE NOTICE 'SENTINELA_BARRADO_42501';
END \$\$;
SQL
)
case "$V" in *SENTINELA_BARRADO_42501*) ok "N8 customer barrado pelo gate (42501)";; *) bad "N8 customer NAO foi barrado: $V";; esac

# N9 — SESSÃO LIMPA (o único jeito de reproduzir pg_cron): a RPC pública recusa a
#      si mesma — é exatamente por isso que o entrypoint de JOB existe
V=$(P -q -v ON_ERROR_STOP=0 <<'SQL' 2>&1 | tr -d '\n'
DO $$ BEGIN
  PERFORM public.atp_reconciliar();
  RAISE NOTICE 'SENTINELA_RPC_PUBLICA_PASSOU';
EXCEPTION WHEN insufficient_privilege THEN RAISE NOTICE 'SENTINELA_RPC_PUBLICA_INAGENDAVEL';
END $$;
SQL
)
case "$V" in *SENTINELA_RPC_PUBLICA_INAGENDAVEL*) ok "N9 RPC publica e inagendavel por cron (42501 sem JWT)";; *) bad "N9 esperava 42501 em sessao limpa: $V";; esac

# N10 — o JOB privado roda em sessão limpa (é o que o pg_cron faz de verdade)
eq "N10 job privado roda SEM JWT (agendavel de verdade)" \
   "$(Pq -c "SELECT (private.atp_reconciliar_job()->>'ok')")" "true"

# N11 — o cron agenda o JOB, não a RPC pública
eq "N11 cron agenda o entrypoint privado" \
   "$(Pq -c "SELECT (command LIKE '%private.atp_reconciliar_job%')::text FROM cron.job WHERE jobname='atp-reconciliar'")" "true"

# N12 — a trilha segue APPEND-ONLY sob a fase 3 (o ALTER do CHECK não tocou ACL)
eq "N12 service_role sem UPDATE na trilha" \
   "$(Pq -c "SELECT has_table_privilege('service_role','public.atp_decisoes','UPDATE')::text")" "false"
eq "N12 service_role sem DELETE na trilha" \
   "$(Pq -c "SELECT has_table_privilege('service_role','public.atp_decisoes','DELETE')::text")" "false"
eq "N12 service_role mantem INSERT na trilha" \
   "$(Pq -c "SELECT has_table_privilege('service_role','public.atp_decisoes','INSERT')::text")" "true"

# N13 — o CHECK novo aceita os desfechos da fase 3 e RECUSA valor fora do domínio
V=$(P -q -v ON_ERROR_STOP=0 <<'SQL' 2>&1 | tr -d '\n'
DO $$ BEGIN
  INSERT INTO public.atp_decisoes (checkout_id, pool, account, decisao, contexto, enforcement)
  VALUES (gen_random_uuid(), 'oben', 'oben', 'valor_invalido_xyz', 'reconciliacao', true);
  RAISE NOTICE 'SENTINELA_CHECK_ACEITOU_LIXO';
EXCEPTION WHEN check_violation THEN RAISE NOTICE 'SENTINELA_CHECK_BARROU';
END $$;
SQL
)
case "$V" in *SENTINELA_CHECK_BARROU*) ok "N13 CHECK de decisao recusa valor fora do dominio";; *) bad "N13 CHECK aceitou lixo: $V";; esac

# ══════════════════════════════════════════════════════════════════════════════
# ZONA 9 — FASE 3.1: O ELO RESERVA↔PV SOBREVIVE AO DELETE
#  A reserva conhecia o pedido só pela FK (ON DELETE SET NULL). O excluir_pedido
#  apaga a linha push MESMO com o CancelarPedido falho no Omie ⇒ PV vivo, reserva
#  cega. A 3.1 dá à reserva o PAR PRÓPRIO (omie_account, omie_pedido_id), gravado
#  pelo writer único atp_confirmar_pv na mesma transação do write-back.
#  SKUs 3101-3106, um cenário por SKU.
# ══════════════════════════════════════════════════════════════════════════════
echo "-- fase 3.1: elo que sobrevive ao DELETE --"

SO_E1='e3100000-0000-0000-0000-000000000001'   # confirma → apaga a push → PV vivo
SO_E2='e3100000-0000-0000-0000-000000000002'   # confirma → apaga a push → faturado
SO_E3='e3100000-0000-0000-0000-000000000003'   # write-back que não casa (atomicidade)
SO_E4='e3100000-0000-0000-0000-000000000004'   # expirada antes do PV (não ressuscita)
SO_E5='e3100000-0000-0000-0000-000000000005'   # lock
SO_E6='e3100000-0000-0000-0000-000000000006'   # vencida-mas-ativa: confirmar AUMENTA
CK_E1='c3100000-0000-0000-0000-000000000001'
CK_E2='c3100000-0000-0000-0000-000000000002'
CK_E3='c3100000-0000-0000-0000-000000000003'
CK_E4='c3100000-0000-0000-0000-000000000004'
CK_E5='c3100000-0000-0000-0000-000000000005'
CK_E6='c3100000-0000-0000-0000-000000000006'

P -q <<SQL
INSERT INTO public.inventory_position (omie_codigo_produto, account, saldo, synced_at)
SELECT s, a, 10, now() FROM unnest(ARRAY[3101,3102,3103,3104,3105,3106]) s,
                            unnest(ARRAY['oben','vendas']) a;
-- linhas PUSH pré-PV (o gate já vinculou a reserva; o PID ainda não voltou do Omie)
INSERT INTO public.sales_orders (id, checkout_id, account, items, omie_pedido_id, status, hash_payload, origem) VALUES
  ('$SO_E1','$CK_E1','oben','[{"omie_codigo_produto":3101,"quantidade":2}]',NULL,'rascunho',NULL,'web_staff'),
  ('$SO_E2','$CK_E2','oben','[{"omie_codigo_produto":3102,"quantidade":2}]',NULL,'rascunho',NULL,'web_staff'),
  ('$SO_E3','$CK_E3','oben','[{"omie_codigo_produto":3103,"quantidade":2}]',NULL,'rascunho',NULL,'web_staff'),
  ('$SO_E4','$CK_E4','oben','[{"omie_codigo_produto":3104,"quantidade":2}]',NULL,'rascunho',NULL,'web_staff'),
  ('$SO_E5','$CK_E5','oben','[{"omie_codigo_produto":3105,"quantidade":2}]',NULL,'rascunho',NULL,'web_staff'),
  ('$SO_E6','$CK_E6','oben','[{"omie_codigo_produto":3106,"quantidade":2}]',NULL,'rascunho',NULL,'web_staff');
-- canônicas (pull) que o sync traria depois do PV
INSERT INTO public.sales_orders (account, omie_pedido_id, status, hash_payload, items) VALUES
  ('oben', 9101, 'importado', 'omie_oben_9101', '[]'),
  ('oben', 9102, 'faturado',  'omie_oben_9102', '[]');
SQL
seed_reserva 3101 2 "$CK_E1" "$SO_E1"
seed_reserva 3102 2 "$CK_E2" "$SO_E2"
seed_reserva 3103 2 "$CK_E3" "$SO_E3"
seed_reserva 3104 2 "$CK_E4" "$SO_E4"
seed_reserva 3105 2 "$CK_E5" "$SO_E5"
seed_reserva 3106 2 "$CK_E6" "$SO_E6"

# o edge chama como service_role (supabaseAdmin) — o gate próprio lê auth.role()
confirmar() { # $1=sales_order_id $2=account $3=pid
  Pq -q <<SQL
SET test.role='service_role';
SELECT public.atp_confirmar_pv('$1'::uuid, '$2', $3, 'N$3', '{"p":1}'::jsonb, '{"r":1}'::jsonb)::text;
SQL
}
par() { Pq -c "SELECT COALESCE(omie_account,'NULL')||'/'||COALESCE(omie_pedido_id::text,'NULL') FROM public.estoque_reservas WHERE checkout_id='$1' ORDER BY created_at DESC LIMIT 1"; }
# assert negativo por SQLSTATE: imprime SENTINELA_<estado> só se veio o erro esperado
sqlstate_de() { # stdin = SQL dentro do DO; $1 = condição esperada
  P -q -v ON_ERROR_STOP=0 2>&1 <<SQL | tr -d '\n'
DO \$\$ BEGIN
  $(cat)
  RAISE NOTICE 'SENTINELA_NADA_LANCOU';
EXCEPTION WHEN $1 THEN RAISE NOTICE 'SENTINELA_VEIO_O_ESPERADO';
END \$\$;
SQL
}

# ── E1/E2 — o writer único: write-back + carimbo na MESMA transação ──
R=$(confirmar "$SO_E1" oben 9101)
eq "E1 RPC confirma e carimba 1 reserva" "$(printf '%s' "$R" | command grep -o '"reservas_firmadas": 1' | head -1)" '"reservas_firmadas": 1'
eq "E1 write-back gravou o PID na push" \
   "$(Pq -c "SELECT omie_pedido_id||'/'||status||'/'||omie_numero_pedido FROM public.sales_orders WHERE id='$SO_E1'")" "9101/enviado/N9101"
eq "E2 a reserva ganhou o PAR PROPRIO" "$(par "$CK_E1")" "oben/9101"

# ── E3-E5 — o caso pior: CancelarPedido falhou, DELETE local feito mesmo assim ──
vencer "$CK_E1"
P -q -c "DELETE FROM public.sales_orders WHERE id='$SO_E1'"
eq "E3 FK SET NULL zerou o vinculo (o cenario do excluir_pedido)" \
   "$(Pq -c "SELECT (sales_order_id IS NULL)::text FROM public.estoque_reservas WHERE checkout_id='$CK_E1'")" "true"
eq "E3 push apagada: a reserva SEGUE descontando (elo sobrevive)" "$(reservado 3101)" "2"
expirar >/dev/null
eq "E4 push apagada + vencida: o TTL NAO a carimba" "$(st "$CK_E1")" "ativa"
reconciliar >/dev/null
eq "E5 canonica viva (PV nao cancelado no Omie): reconciliacao NAO libera" "$(st "$CK_E1")" "ativa"
eq "E5 a desvinculada aparece na FILA humana, pelo PID proprio" \
   "$(Pq -q <<SQL
SET test.uid='$STAFF'; SET test.role='authenticated';
SELECT p.omie_pedido_id||'/'||COALESCE(p.status_vinculado,'NULL')||'/'||COALESCE(p.status_canonico,'NULL')
FROM public.atp_reservas_pendentes(0) p
JOIN public.estoque_reservas r ON r.id = p.reserva_id WHERE r.checkout_id='$CK_E1';
SQL
)" "9101/NULL/importado"

# o Omie confirma o cancelamento (o sync traz 'cancelado' para a canônica)
P -q -c "UPDATE public.sales_orders SET status='cancelado' WHERE hash_payload='omie_oben_9101'"
reconciliar >/dev/null
eq "E6 canonica cancelada: a desvinculada e LIBERADA pelo par proprio" "$(st "$CK_E1")" "liberada"
eq "E6 trilha registra a liberacao mesmo sem sales_order_id" \
   "$(Pq -c "SELECT count(*) FROM public.atp_decisoes WHERE decisao='liberado_por_cancelamento' AND checkout_id='$CK_E1' AND sales_order_id IS NULL")" "1"

# E7 — faturado observado numa reserva desvinculada (o carimbo da fila também acha)
confirmar "$SO_E2" oben 9102 >/dev/null
P -q -c "DELETE FROM public.sales_orders WHERE id='$SO_E2'"
reconciliar >/dev/null
eq "E7 desvinculada + canonica faturada: carimba a observacao" "$(carimbo "$CK_E2")" "true"
eq "E7 e NAO consome (consumo segue humano na 3.1)" "$(st "$CK_E2")" "ativa"

# ── S1-S3 — o SINAL da fila: o saldo eleito foi COLETADO depois do faturamento?
#    (decisão 2026-10-09: o consumo segue humano; o sinal encurta a decisão).
#    Margem de 1h sobre o faturamento_observado_em: os writers de synced_at
#    carimbam depois da coleta, na mesma invocação (<= ~400s).
sinal() { Pq -q <<SQL
SET test.uid='$STAFF'; SET test.role='authenticated';
SELECT COALESCE(p.saldo_embute_faturamento::text,'NULL')
FROM public.atp_reservas_pendentes(0) p
JOIN public.estoque_reservas r ON r.id = p.reserva_id WHERE r.checkout_id='$1';
SQL
}
eq "S1 sem carimbo de faturamento: o sinal NAO se aplica (NULL, nunca false)" "$(sinal "$CK_E5")" "NULL"
P -q -c "UPDATE public.inventory_position SET synced_at = now() WHERE omie_codigo_produto = 3102"
P -q -c "UPDATE public.estoque_reservas SET faturamento_observado_em = now() - interval '30 minutes' WHERE checkout_id='$CK_E2'"
eq "S2 coletado 30min depois do faturamento: AINDA NAO prova (dentro da margem)" "$(sinal "$CK_E2")" "false"
P -q -c "UPDATE public.estoque_reservas SET faturamento_observado_em = now() - interval '61 minutes' WHERE checkout_id='$CK_E2'"
eq "S3 coletado 61min depois: o saldo eleito EMBUTE o faturamento" "$(sinal "$CK_E2")" "true"
eq "S3 o sinal so informa: a reserva segue ativa" "$(st "$CK_E2")" "ativa"

# ── E8 — ATOMICIDADE: write-back que não casa ⇒ P0002 e NADA gravado ──
V=$(sqlstate_de no_data_found <<SQL
PERFORM set_config('test.role','service_role',true);
PERFORM public.atp_confirmar_pv('$SO_E3'::uuid, 'colacor', 9103, 'N', '{}'::jsonb, '{}'::jsonb);
SQL
)
case "$V" in *SENTINELA_VEIO_O_ESPERADO*) ok "E8 write-back sem a linha (conta errada) -> P0002";; *) bad "E8 esperava P0002: $V";; esac
eq "E8 nada gravado: a reserva ficou SEM par" "$(par "$CK_E3")" "NULL/NULL"
eq "E8 nada gravado: a push ficou sem PID" \
   "$(Pq -c "SELECT COALESCE(omie_pedido_id::text,'NULL') FROM public.sales_orders WHERE id='$SO_E3'")" "NULL"

# ── E9 — reserva já ENCERRADA não é carimbada nem ressuscita (gêmeo do A5) ──
vencer "$CK_E4"; expirar >/dev/null
R=$(confirmar "$SO_E4" oben 9104)
eq "E9 expirada antes do PV: 0 reservas firmadas" "$(printf '%s' "$R" | command grep -o '"reservas_firmadas": 0' | head -1)" '"reservas_firmadas": 0'
eq "E9 e segue expirada, sem descontar" "$(st "$CK_E4")/$(reservado 3104)" "expirada/0"

# ── E10 — confirmar AUMENTA o reservado (por isso a RPC trava como o reservar) ──
vencer "$CK_E6"
eq "E10 antes: vencida pre-PV ainda 'ativa' NAO desconta" "$(st "$CK_E6")/$(reservado 3106)" "ativa/0"
confirmar "$SO_E6" oben 9106 >/dev/null
eq "E10 depois do PV: a mesma reserva VOLTA a descontar" "$(reservado 3106)" "2"

# ── E11-E14 — WRITE-ONCE ──
R=$(confirmar "$SO_E6" oben 9106)
eq "E11 reconfirmar o MESMO PID e idempotente" "$(printf '%s' "$R" | command grep -o '"ok": true' | head -1)" '"ok": true'
V=$(sqlstate_de check_violation <<SQL
PERFORM set_config('test.role','service_role',true);
PERFORM public.atp_confirmar_pv('$SO_E6'::uuid, 'oben', 9199, 'N', '{}'::jsonb, '{}'::jsonb);
SQL
)
case "$V" in *SENTINELA_VEIO_O_ESPERADO*) ok "E12 trocar o PID pela RPC -> 23514";; *) bad "E12 esperava 23514 ao trocar o PID: $V";; esac
eq "E12 e a push NAO ficou com o PID trocado (rollback inteiro)" \
   "$(Pq -c "SELECT omie_pedido_id FROM public.sales_orders WHERE id='$SO_E6'")" "9106"
V=$(sqlstate_de check_violation <<SQL
UPDATE public.estoque_reservas SET omie_pedido_id = NULL, omie_account = NULL WHERE checkout_id='$CK_E6';
SQL
)
case "$V" in *SENTINELA_VEIO_O_ESPERADO*) ok "E13 apagar o par -> 23514";; *) bad "E13 esperava 23514 ao apagar o par: $V";; esac
V=$(sqlstate_de check_violation <<SQL
INSERT INTO public.estoque_reservas (pool, checkout_id, omie_codigo_produto, quantidade, expira_em, omie_pedido_id, omie_account)
VALUES ('oben', gen_random_uuid(), 3106, 1, now() + interval '30 minutes', 9106, 'oben');
SQL
)
case "$V" in *SENTINELA_VEIO_O_ESPERADO*) ok "E14 reserva nao NASCE com par -> 23514";; *) bad "E14 esperava 23514 no INSERT com par: $V";; esac

# ── E15-E18 — AUTORIZAÇÃO (catálogo ≠ comportamento: 42501 tem dois emissores) ──
eq "E15 anon sem EXECUTE em atp_confirmar_pv (catalogo)" \
   "$(Pq -c "SELECT has_function_privilege('anon','public.atp_confirmar_pv(uuid,text,bigint,text,jsonb,jsonb)','EXECUTE')::text")" "false"
eq "E15 authenticated sem EXECUTE em atp_confirmar_pv (catalogo)" \
   "$(Pq -c "SELECT has_function_privilege('authenticated','public.atp_confirmar_pv(uuid,text,bigint,text,jsonb,jsonb)','EXECUTE')::text")" "false"
eq "E16 service_role COM EXECUTE (senao o edge quebra depois do PV criado)" \
   "$(Pq -c "SELECT has_function_privilege('service_role','public.atp_confirmar_pv(uuid,text,bigint,text,jsonb,jsonb)','EXECUTE')::text")" "true"
# comportamento: o superuser do harness TEM execute — então só o gate PRÓPRIO barra
V=$(sqlstate_de insufficient_privilege <<SQL
PERFORM set_config('test.role','authenticated',true);
PERFORM public.atp_confirmar_pv('$SO_E5'::uuid, 'oben', 9105, 'N', '{}'::jsonb, '{}'::jsonb);
SQL
)
case "$V" in *SENTINELA_VEIO_O_ESPERADO*) ok "E17 gate proprio: role authenticated -> 42501";; *) bad "E17 esperava 42501 do gate proprio: $V";; esac
V=$(sqlstate_de invalid_parameter_value <<SQL
PERFORM set_config('test.role','service_role',true);
PERFORM public.atp_confirmar_pv('$SO_E5'::uuid, 'oben', 0, 'N', '{}'::jsonb, '{}'::jsonb);
SQL
)
case "$V" in *SENTINELA_VEIO_O_ESPERADO*) ok "E18 PID 0 -> 22023";; *) bad "E18 esperava 22023 para PID 0: $V";; esac
eq "E18 e o gate/validacao nao deixaram rastro" "$(par "$CK_E5")" "NULL/NULL"

# ── E19 — LOCK: com o SKU travado por outra sessão (um reservar_estoque em
#    curso), a RPC ESPERA — prova por lock_timeout ⇒ 55P03. Sem o lock ela
#    passaria e a ordem com o reservar ficaria indefinida.
espera_lock() { # $1 = chave do advisory lock
  P -q -c "SELECT pg_advisory_lock(hashtextextended('$1',0)); SELECT pg_sleep(6);" >/dev/null 2>&1 &
  local bg=$!
  for _ in $(seq 1 50); do
    [ "$(Pq -c "SELECT count(*) FROM pg_locks WHERE locktype='advisory' AND granted")" -ge 1 ] && break
    sleep 0.1
  done
  V=$(sqlstate_de lock_not_available <<SQL
PERFORM set_config('test.role','service_role',true);
PERFORM set_config('lock_timeout','300ms',true);
PERFORM public.atp_confirmar_pv('$SO_E5'::uuid, 'oben', 9105, 'N', '{}'::jsonb, '{}'::jsonb);
SQL
)
  kill "$bg" 2>/dev/null; wait "$bg" 2>/dev/null || true
  P -q -c "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE query LIKE '%pg_sleep(6)%' AND pid <> pg_backend_pid()" >/dev/null
  for _ in $(seq 1 50); do
    [ "$(Pq -c "SELECT count(*) FROM pg_locks WHERE locktype='advisory'")" -eq 0 ] && break
    sleep 0.1
  done
  printf '%s' "$V"
}
V=$(espera_lock "atp:sku:oben:3105")
case "$V" in *SENTINELA_VEIO_O_ESPERADO*) ok "E19 SKU travado: a RPC espera o lock (55P03)";; *) bad "E19 a RPC NAO esperou o lock do SKU: $V";; esac
V=$(espera_lock "atp:checkout:$CK_E5")
case "$V" in *SENTINELA_VEIO_O_ESPERADO*) ok "E19 checkout travado: a RPC espera o lock (55P03)";; *) bad "E19 a RPC NAO esperou o lock do checkout: $V";; esac
eq "E19 sem lock livre, nada gravado" "$(par "$CK_E5")" "NULL/NULL"

# ── E20 — re-aplicar a migration é IDEMPOTENTE e o BACKFILL dá o par a quem
#    já tinha PV pelo vínculo (o seed da fase 3: 3001 → push com PID 9001)
eq "E20 antes do re-apply, a reserva legada nao tem par" "$(par "$CK_VIVO")" "NULL/NULL"
if P -q -1 -f "$MIG31" >/dev/null 2>&1; then ok "E20 re-aplicar a 3.1 nao quebra (idempotente)"
else bad "E20 re-aplicar a 3.1 FALHOU"; fi
eq "E20 backfill deu o par a reserva legada" "$(par "$CK_VIVO")" "oben/9001"
eq "E20 backfill nao tocou a ja carimbada (write-once intacto)" "$(par "$CK_E6")" "oben/9106"

# ── P1/P2 — as defesas do APPLY (provadas pelo ESTADO, não pela mensagem) ──
# P1: uma cópia da migration com GRANT acidental a authenticated tem de ABORTAR
#     na PÓS — e, numa transação só, nada do que veio antes fica gravado.
TMPMIG="$(mktemp -t atp31-sabotada.XXXXXX)"
sed 's/^REVOKE ALL ON FUNCTION public.atp_confirmar_pv(uuid, text, bigint, text, jsonb, jsonb) FROM authenticated;$/GRANT EXECUTE ON FUNCTION public.atp_confirmar_pv(uuid, text, bigint, text, jsonb, jsonb) TO authenticated;/' \
  "$MIG31" > "$TMPMIG"
if cmp -s "$TMPMIG" "$MIG31"; then bad "P1 a copia sabotada NAO mudou (sed nao casou) — teste invalido"
elif P -q -1 -f "$TMPMIG" >/dev/null 2>&1; then bad "P1 a POS deixou passar GRANT a authenticated"
else ok "P1 GRANT acidental a authenticated: o apply ABORTA na POS"; fi
eq "P1 e nada ficou concedido (transacao unica voltou inteira)" \
   "$(Pq -c "SELECT has_function_privilege('authenticated','public.atp_confirmar_pv(uuid,text,bigint,text,jsonb,jsonb)','EXECUTE')::text")" "false"
rm -f "$TMPMIG"

# P2: outra sessão recriou o cálculo DEPOIS do pré-voo ⇒ a PRE aborta e o corpo
#     dela SOBREVIVE (CREATE OR REPLACE às cegas o apagaria em silêncio).
P -q <<'SQL'
CREATE TABLE public._harness_p2 AS
  SELECT pg_get_functiondef('private.atp_disponivel(text,bigint,uuid)'::regprocedure) AS def;
DO $$ BEGIN
  EXECUTE replace((SELECT def FROM public._harness_p2), 'SELECT COALESCE(sum(r.quantidade), 0) AS reservado',
                  'SELECT /* OUTRA_SESSAO_P2 */ COALESCE(sum(r.quantidade), 0) AS reservado');
END $$;
SQL
MD5_OUTRA=$(Pq -c "SELECT md5(prosrc) FROM pg_proc WHERE oid = 'private.atp_disponivel(text,bigint,uuid)'::regprocedure")
if P -q -1 -f "$MIG31" >/dev/null 2>&1; then bad "P2 a PRE deixou sobrescrever o corpo de outra sessao"
else ok "P2 corpo vivo desconhecido: o apply ABORTA na PRE"; fi
eq "P2 e o corpo da outra sessao SOBREVIVEU" \
   "$(Pq -c "SELECT md5(prosrc) FROM pg_proc WHERE oid = 'private.atp_disponivel(text,bigint,uuid)'::regprocedure")" "$MD5_OUTRA"
# devolve o corpo desta migration (o validador da ZONA 8 mede o estado entregue)
P -q -c "DO \$\$ BEGIN EXECUTE (SELECT def FROM public._harness_p2); END \$\$;"
P -q -c "DROP TABLE public._harness_p2"
eq "P2 restaurado: o corpo vivo voltou a ser o desta migration" \
   "$(Pq -c "SELECT md5(prosrc) FROM pg_proc WHERE oid = 'private.atp_disponivel(text,bigint,uuid)'::regprocedure")" "af3d5d4d97c4a47977c030daab87c385"

# ══════════════════════════════════════════════════════════════════════════════
# ZONA 8 — O VALIDADOR PÓS-APPLY TAMBÉM É CÓDIGO, E TAMBÉM MENTE
# (money-path §"O VALIDADOR mente": o script que o founder cola no SQL Editor
#  nasce sem prova de que morde, e erra nos dois sentidos. Aqui ele é EXECUTADO
#  contra banco bom — tem de dar 100% — e contra banco sabotado — tem de reprovar.
#  Sem a segunda metade ele é carimbo.)
# ══════════════════════════════════════════════════════════════════════════════
echo "-- o validador pos-apply --"

VAL=$(Pq -f "$REPO_ROOT/db/valida-atp-fase3.sql" 2>&1)
eq "Z1 validador contra banco BOM: nenhum FALHOU" \
   "$(printf '%s' "$VAL" | command grep -c 'FALHOU' || true)" "0"
eq "Z1 validador da o veredito APLICADA" \
   "$(printf '%s' "$VAL" | command grep -c 'FASE 3 APLICADA' || true)" "1"
eq "Z1 validador da o veredito da 3.1 APLICADA" \
   "$(printf '%s' "$VAL" | command grep -c 'FASE 3.1 APLICADA' || true)" "1"
eq "Z1 validador tem os 42 checks (3 + 3.1)" \
   "$(printf '%s' "$VAL" | command grep -cE '^[0-9]+\|(OK|FALHOU)' || true)" "42"

# Z2 — banco SABOTADO: um objeto some e o validador tem de acusar. Roda por
# último de propósito (o DROP não pode contaminar assert anterior).
P -q -c "DROP FUNCTION public.atp_reservas_pendentes(integer)"
VAL2=$(Pq -f "$REPO_ROOT/db/valida-atp-fase3.sql" 2>&1)
N2=$(printf '%s' "$VAL2" | command grep -c 'FALHOU' || true)
if [ "$N2" -ge 1 ]; then ok "Z2 validador REPROVA quando um objeto some (=$N2 FALHOU)"
else bad "Z2 validador ficou verde com objeto ausente — e carimbo"; fi

echo
echo "=== RESULTADO: $PASS OK / $FAIL ERR ==="
[ "$FAIL" -eq 0 ] || exit 1
