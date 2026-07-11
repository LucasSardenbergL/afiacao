#!/usr/bin/env bash
# ╔══════════════════════════════════════════════════════════════════════════════╗
# ║  HARNESS PG17 — PROVA da 20260711090000_prime_fundacao (money-path)           ║
# ║  bash db/test-prime-fundacao.sh > /tmp/prime-sql.log 2>&1; echo "exit=$?"     ║
# ║  3 tabelas (RLS staff/cliente/anon) + view extrato + honestidade por CHECK +  ║
# ║  append-only/estorno + vigência + anti-sobreposição. F1/F2 embutidas.         ║
# ╚══════════════════════════════════════════════════════════════════════════════╝
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PGVER=17
PGBIN="/opt/homebrew/opt/postgresql@${PGVER}/bin"
PORT="${PGPORT_TEST:-5471}"
SLUG="prime-fundacao"
DATA="$(mktemp -d "/tmp/pgtest-${SLUG}.XXXXXX")/data"
export LC_ALL=C LANG=C

[ -x "$PGBIN/initdb" ] || { echo "postgresql@${PGVER} ausente: brew install postgresql@${PGVER}"; exit 1; }

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
Pq() { P -qtA "$@"; }

P -q -f "$REPO_ROOT/db/stubs-supabase.sql"
P -q <<'SQL'
CREATE OR REPLACE FUNCTION auth.uid()  RETURNS uuid LANGUAGE sql STABLE AS $f$ SELECT nullif(current_setting('test.uid',  true), '')::uuid $f$;
CREATE OR REPLACE FUNCTION auth.role() RETURNS text LANGUAGE sql STABLE AS $f$ SELECT nullif(current_setting('test.role', true), '') $f$;
ALTER ROLE service_role BYPASSRLS;
GRANT ALL ON SCHEMA public TO authenticated, anon;
-- Emula o default do Supabase (grants de tabela p/ authenticated/anon) ANTES da
-- migration — RLS é o único gate, como em prod.
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO authenticated, anon, service_role;
SQL

PASS=0; FAIL=0
ok()  { PASS=$((PASS+1)); echo "  ✅ $1"; }
bad() { FAIL=$((FAIL+1)); echo "  ❌ $1"; }
eq()  { if [ "$2" = "$3" ]; then ok "$1 (=$2)"; else bad "$1 — esperado [$3], veio [$2]"; fi; }

echo "═══ setup pronto (PG17 :$PORT) ═══"

# ════════ ZONA 1 — pré-requisitos que a migration referencia (prod já tem) ════════
P -q <<'SQL'
CREATE TYPE public.app_role AS ENUM ('master','employee','customer');
CREATE TABLE public.user_roles (user_id uuid, role public.app_role);
CREATE FUNCTION public.has_role(_user_id uuid, _role public.app_role) RETURNS boolean
  LANGUAGE sql STABLE AS $f$ SELECT EXISTS(SELECT 1 FROM public.user_roles WHERE user_id=_user_id AND role=_role) $f$;
GRANT SELECT ON public.user_roles TO authenticated, anon;

CREATE OR REPLACE FUNCTION public.update_updated_at_column() RETURNS trigger
  LANGUAGE plpgsql AS $f$ BEGIN NEW.updated_at = now(); RETURN NEW; END $f$;
SQL
ok "zona 1: pré-requisitos criados (app_role, has_role, update_updated_at_column)"

# ════════ ZONA 2 — aplica a migration REAL (verbatim) ════════
P -q -f "$REPO_ROOT/supabase/migrations/20260711090000_prime_fundacao.sql"
eq "tabelas+view existem" \
   "$(Pq -c "SELECT count(*) FROM (VALUES (to_regclass('public.prime_planos')), (to_regclass('public.prime_assinaturas')), (to_regclass('public.prime_beneficio_uso')), (to_regclass('public.v_prime_extrato_mensal'))) t(r) WHERE r IS NOT NULL")" "4"
eq "RLS ligada nas 3 tabelas" \
   "$(Pq -c "SELECT count(*) FROM pg_class WHERE relname IN ('prime_planos','prime_assinaturas','prime_beneficio_uso') AND relrowsecurity")" "3"
eq "8 policies criadas (uso SEM policy de DELETE = append-only)" \
   "$(Pq -c "SELECT count(*) FROM pg_policies WHERE tablename LIKE 'prime_%'")" "8"
eq "5 triggers trg_prime_*" \
   "$(Pq -c "SELECT count(*) FROM pg_trigger WHERE tgname LIKE 'trg_prime_%' AND NOT tgisinternal")" "5"

# Competências na MESMA TZ da view/triggers (virada de mês UTC≠SP é armadilha do repo)
MES_ATUAL="$(Pq -c "SELECT date_trunc('month', (now() AT TIME ZONE 'America/Sao_Paulo'))::date")"
MES_PASSADO="$(Pq -c "SELECT (date_trunc('month', (now() AT TIME ZONE 'America/Sao_Paulo')) - interval '1 month')::date")"
MES_QUE_VEM="$(Pq -c "SELECT (date_trunc('month', (now() AT TIME ZONE 'America/Sao_Paulo')) + interval '1 month')::date")"

# ════════ ZONA 3 — seed: staff, 2 clientes, plano, assinatura ════════
P -q <<SQL
INSERT INTO public.user_roles VALUES
  ('00000000-0000-0000-0000-00000000aaaa','employee'),
  ('00000000-0000-0000-0000-00000000bbbb','customer'),
  ('00000000-0000-0000-0000-00000000cccc','customer');
SET test.uid = '00000000-0000-0000-0000-00000000aaaa';
INSERT INTO public.prime_planos (id, nome, preco_mensal, franquia_dentes, beneficios)
  VALUES ('11111111-1111-1111-1111-111111111111','Prime Piloto', 99, 200,
          '["Franquia 200 dentes/mês","Coleta na rota","Prioridade"]'::jsonb);
INSERT INTO public.prime_planos (id, nome, preco_mensal, franquia_dentes, ativo)
  VALUES ('11111111-1111-1111-1111-222222222222','Plano Desativado', 59, 100, false);
INSERT INTO public.prime_assinaturas
  (id, customer_user_id, plano_id, preco_contratado, franquia_dentes_contratada, data_inicio, created_by)
  VALUES ('22222222-2222-2222-2222-111111111111','00000000-0000-0000-0000-00000000bbbb',
          '11111111-1111-1111-1111-111111111111', 99, 200, '${MES_PASSADO}',
          '00000000-0000-0000-0000-00000000aaaa');
SQL
ok "zona 3: seed (staff + plano ativo/inativo + assinatura do cliente B desde ${MES_PASSADO})"

# ════════ ZONA 4 — CHECKs/triggers de honestidade (negativos por SQLSTATE) ════════
expect_sqlstate() { # $1=nome $2=sqlstate esperada $3=sql
  local got
  got="$(P -qtA -c "SET test.uid='00000000-0000-0000-0000-00000000aaaa'; DO \$\$ BEGIN $3; RAISE EXCEPTION 'NAO_FALHOU'; EXCEPTION WHEN OTHERS THEN IF SQLSTATE = '$2' THEN RAISE NOTICE 'SQLSTATE_OK'; ELSE RAISE; END IF; END \$\$;" 2>&1 | grep -c 'SQLSTATE_OK' || true)"
  eq "$1 (SQLSTATE $2)" "$got" "1"
}
A22='22222222-2222-2222-2222-111111111111'
UA='00000000-0000-0000-0000-00000000aaaa'

expect_sqlstate "afiacao SEM valor_tabela é barrada" "23514" \
  "INSERT INTO public.prime_beneficio_uso (assinatura_id, tipo, quantidade, valor_tabela, preco_unitario_snapshot, competencia, referencia, created_by) VALUES ('$A22','afiacao_dentes', 96, NULL, 1.20, '${MES_ATUAL}', 'PV-X', '$UA')"
expect_sqlstate "afiacao com valor 0 é barrada (ausente ≠ zero)" "23514" \
  "INSERT INTO public.prime_beneficio_uso (assinatura_id, tipo, quantidade, valor_tabela, preco_unitario_snapshot, competencia, referencia, created_by) VALUES ('$A22','afiacao_dentes', 96, 0, 1.20, '${MES_ATUAL}', 'PV-X', '$UA')"
expect_sqlstate "monetizável SEM referencia é barrado (lastro Omie obrigatório)" "23514" \
  "INSERT INTO public.prime_beneficio_uso (assinatura_id, tipo, quantidade, valor_tabela, preco_unitario_snapshot, competencia, referencia, created_by) VALUES ('$A22','afiacao_dentes', 96, 115.20, 1.20, '${MES_ATUAL}', NULL, '$UA')"
expect_sqlstate "afiacao com valor ≠ quantidade×snapshot é barrada (contrafactual auditável)" "23514" \
  "INSERT INTO public.prime_beneficio_uso (assinatura_id, tipo, quantidade, valor_tabela, preco_unitario_snapshot, competencia, referencia, created_by) VALUES ('$A22','afiacao_dentes', 96, 999.99, 1.20, '${MES_ATUAL}', 'PV-X', '$UA')"
expect_sqlstate "afiacao SEM snapshot de preço é barrada" "23514" \
  "INSERT INTO public.prime_beneficio_uso (assinatura_id, tipo, quantidade, valor_tabela, preco_unitario_snapshot, competencia, referencia, created_by) VALUES ('$A22','afiacao_dentes', 96, 115.20, NULL, '${MES_ATUAL}', 'PV-X', '$UA')"
expect_sqlstate "snapshot em tipo não-afiacao é barrado" "23514" \
  "INSERT INTO public.prime_beneficio_uso (assinatura_id, tipo, quantidade, valor_tabela, preco_unitario_snapshot, competencia, referencia, created_by) VALUES ('$A22','desconto_abrasivo', 1, 25, 1.20, '${MES_ATUAL}', 'PV-X', '$UA')"
expect_sqlstate "prioridade COM valor_tabela é barrada (não monetiza operacional)" "23514" \
  "INSERT INTO public.prime_beneficio_uso (assinatura_id, tipo, quantidade, valor_tabela, competencia, created_by) VALUES ('$A22','prioridade_entrega', 1, 10, '${MES_ATUAL}', '$UA')"
expect_sqlstate "bonus COM valor_tabela é barrado (crédito não monetiza)" "23514" \
  "INSERT INTO public.prime_beneficio_uso (assinatura_id, tipo, quantidade, valor_tabela, competencia, created_by) VALUES ('$A22','bonus_dentes', 50, 60, '${MES_ATUAL}', '$UA')"
expect_sqlstate "dentes fracionados são barrados" "23514" \
  "INSERT INTO public.prime_beneficio_uso (assinatura_id, tipo, quantidade, valor_tabela, preco_unitario_snapshot, competencia, referencia, created_by) VALUES ('$A22','afiacao_dentes', 96.5, 115.80, 1.20, '${MES_ATUAL}', 'PV-X', '$UA')"
expect_sqlstate "evento operacional com quantidade≠1 é barrado" "23514" \
  "INSERT INTO public.prime_beneficio_uso (assinatura_id, tipo, quantidade, valor_tabela, competencia, created_by) VALUES ('$A22','coleta_rota', 2, NULL, '${MES_ATUAL}', '$UA')"
expect_sqlstate "bonus acima de 50 dentes é barrado (teto do spec)" "23514" \
  "INSERT INTO public.prime_beneficio_uso (assinatura_id, tipo, quantidade, valor_tabela, competencia, created_by) VALUES ('$A22','bonus_dentes', 60, NULL, '${MES_ATUAL}', '$UA')"
expect_sqlstate "competencia fora do dia 1 é barrada" "23514" \
  "INSERT INTO public.prime_beneficio_uso (assinatura_id, tipo, quantidade, valor_tabela, preco_unitario_snapshot, competencia, referencia, created_by) VALUES ('$A22','afiacao_dentes', 96, 115.20, 1.20, ('${MES_PASSADO}'::date + 5), 'PV-X', '$UA')"
expect_sqlstate "competencia FUTURA é barrada (vigência)" "P0001" \
  "INSERT INTO public.prime_beneficio_uso (assinatura_id, tipo, quantidade, valor_tabela, preco_unitario_snapshot, competencia, referencia, created_by) VALUES ('$A22','afiacao_dentes', 96, 115.20, 1.20, '${MES_QUE_VEM}', 'PV-X', '$UA')"
expect_sqlstate "preco_mensal <= 0 é barrado" "23514" \
  "INSERT INTO public.prime_planos (nome, preco_mensal, franquia_dentes) VALUES ('x', 0, 100)"
expect_sqlstate "status inválido é barrado" "23514" \
  "UPDATE public.prime_assinaturas SET status='pausada' WHERE id='$A22'"
expect_sqlstate "cancelada SEM data_fim é barrada (senão bloqueia o cliente pra sempre)" "23514" \
  "UPDATE public.prime_assinaturas SET status='cancelada' WHERE id='$A22'"
expect_sqlstate "suspensa SEM suspensa_em é barrada" "23514" \
  "UPDATE public.prime_assinaturas SET status='suspensa' WHERE id='$A22'"
expect_sqlstate "ativa COM suspensa_em é barrada (estado amarrado às datas)" "23514" \
  "UPDATE public.prime_assinaturas SET suspensa_em = '${MES_ATUAL}' WHERE id='$A22'"
expect_sqlstate "2ª assinatura VIVA do mesmo cliente é barrada (trigger sobreposição — infinito cobre qualquer início)" "P0001" \
  "INSERT INTO public.prime_assinaturas (customer_user_id, plano_id, preco_contratado, franquia_dentes_contratada, data_inicio, created_by) VALUES ('00000000-0000-0000-0000-00000000bbbb','11111111-1111-1111-1111-111111111111', 99, 200, '${MES_QUE_VEM}', '$UA')"

# Backstop isolado (falsificação — só dentro de txn revertida): com o trigger de
# sobreposição DESLIGADO, a UNIQUE parcial (uq_prime_assinatura_viva) AINDA barra a 2ª
# viva — prova que o índice é 2ª linha de defesa (corrida entre transações concorrentes
# que o trigger sozinho não cobre sob READ COMMITTED), não redundância morta atrás do
# trigger.
F3="$(P -qtA <<SQL 2>&1 | grep -c 'SQLSTATE_OK' || true
BEGIN;
SET test.uid = '$UA';
ALTER TABLE public.prime_assinaturas DISABLE TRIGGER trg_prime_assinatura_sem_sobreposicao;
DO \$\$ BEGIN
  INSERT INTO public.prime_assinaturas (customer_user_id, plano_id, preco_contratado, franquia_dentes_contratada, data_inicio, created_by)
    VALUES ('00000000-0000-0000-0000-00000000bbbb','11111111-1111-1111-1111-111111111111', 99, 200, '${MES_QUE_VEM}', '$UA');
  RAISE EXCEPTION 'NAO_FALHOU';
EXCEPTION WHEN OTHERS THEN
  IF SQLSTATE = '23505' THEN RAISE NOTICE 'SQLSTATE_OK'; ELSE RAISE; END IF;
END \$\$;
ROLLBACK;
SQL
)"
eq "backstop: UNIQUE parcial barra a 2ª viva mesmo com o trigger desligado (SQLSTATE 23505)" "$F3" "1"

# ════════ ZONA 5 — uso real do mês (staff registra) + view + bônus/estorno ════════
P -q <<SQL
SET test.uid = '$UA';
-- mês corrente: serra 96 dentes (96×1,20 = R\$115,20), bônus cross-sell +50, 1 coleta
INSERT INTO public.prime_beneficio_uso (id, assinatura_id, tipo, quantidade, valor_tabela, preco_unitario_snapshot, competencia, referencia, created_by) VALUES
  ('33333333-3333-3333-3333-111111111111','$A22','afiacao_dentes', 96, 115.20, 1.20, '${MES_ATUAL}', 'PV-TESTE-1', '$UA');
INSERT INTO public.prime_beneficio_uso (assinatura_id, tipo, quantidade, valor_tabela, competencia, created_by) VALUES
  ('$A22','bonus_dentes',   50, NULL, '${MES_ATUAL}', '$UA'),
  ('$A22','coleta_rota',     1, NULL, '${MES_ATUAL}', '$UA');
SQL
ok "zona 5: uso do mês registrado (96 dentes + bônus 50 + coleta)"

expect_sqlstate "2º bônus VIVO no mesmo mês é barrado (crédito não acumula por erro)" "23505" \
  "INSERT INTO public.prime_beneficio_uso (assinatura_id, tipo, quantidade, valor_tabela, competencia, created_by) VALUES ('$A22','bonus_dentes', 50, NULL, '${MES_ATUAL}', '$UA')"

eq "extrato tem 2 meses (início mês passado → corrente)" \
   "$(Pq -c "SELECT count(*) FROM public.v_prime_extrato_mensal WHERE assinatura_id='$A22'")" "2"
eq "mês corrente: monetizado = 115.20 (comparação SQL, não formato)" \
   "$(Pq -c "SELECT monetizado_total = 115.20 FROM public.v_prime_extrato_mensal WHERE assinatura_id='$A22' AND competencia='${MES_ATUAL}'")" "t"
eq "view expõe mensalidade_contratada = 99 (contrato, NUNCA 'pago')" \
   "$(Pq -c "SELECT mensalidade_contratada = 99 FROM public.v_prime_extrato_mensal WHERE assinatura_id='$A22' AND competencia='${MES_ATUAL}'")" "t"
eq "mês corrente: franquia_total = 250 (200 contratada + 50 bônus)" \
   "$(Pq -c "SELECT franquia_total = 250 FROM public.v_prime_extrato_mensal WHERE assinatura_id='$A22' AND competencia='${MES_ATUAL}'")" "t"
eq "mês corrente: dentes_restantes = 154 (250 − 96)" \
   "$(Pq -c "SELECT dentes_restantes = 154 FROM public.v_prime_extrato_mensal WHERE assinatura_id='$A22' AND competencia='${MES_ATUAL}'")" "t"
eq "mês corrente: 1 uso operacional (só a coleta; bônus NÃO conta)" \
   "$(Pq -c "SELECT usos_operacionais FROM public.v_prime_extrato_mensal WHERE assinatura_id='$A22' AND competencia='${MES_ATUAL}'")" "1"
eq "mês passado (sem uso): monetizado é NULL (nunca 0 fabricado)" \
   "$(Pq -c "SELECT monetizado_total IS NULL FROM public.v_prime_extrato_mensal WHERE assinatura_id='$A22' AND competencia='${MES_PASSADO}'")" "t"
eq "mês passado: n_registros = 0 (UI mostra 'sem uso registrado')" \
   "$(Pq -c "SELECT n_registros FROM public.v_prime_extrato_mensal WHERE assinatura_id='$A22' AND competencia='${MES_PASSADO}'")" "0"

# — overfranchise: registrar 200 dentes a mais NÃO some — a view EXPÕE o excedente —
P -q <<SQL
SET test.uid = '$UA';
INSERT INTO public.prime_beneficio_uso (id, assinatura_id, tipo, quantidade, valor_tabela, preco_unitario_snapshot, competencia, referencia, created_by) VALUES
  ('33333333-3333-3333-3333-222222222222','$A22','afiacao_dentes', 200, 240.00, 1.20, '${MES_ATUAL}', 'PV-TESTE-2', '$UA');
SQL
eq "overfranchise: dentes_restantes = 0" \
   "$(Pq -c "SELECT dentes_restantes = 0 FROM public.v_prime_extrato_mensal WHERE assinatura_id='$A22' AND competencia='${MES_ATUAL}'")" "t"
eq "overfranchise: dentes_excedentes = 46 (296 − 250, exposto, nunca escondido)" \
   "$(Pq -c "SELECT dentes_excedentes = 46 FROM public.v_prime_extrato_mensal WHERE assinatura_id='$A22' AND competencia='${MES_ATUAL}'")" "t"

# — estorno: UPDATE só-estorno; view exclui estornado —
expect_sqlstate "editar VALOR de registro monetário é barrado (append-only)" "P0001" \
  "UPDATE public.prime_beneficio_uso SET valor_tabela = 1.00 WHERE id='33333333-3333-3333-3333-222222222222'"
P -q -c "SET test.uid='$UA'; UPDATE public.prime_beneficio_uso SET estornado_em = now(), estornado_por = '$UA' WHERE id='33333333-3333-3333-3333-222222222222';"
ok "estorno do registro de 200 dentes executado (staff)"
eq "pós-estorno: monetizado volta a 115.20 (estornado FORA da view)" \
   "$(Pq -c "SELECT monetizado_total = 115.20 FROM public.v_prime_extrato_mensal WHERE assinatura_id='$A22' AND competencia='${MES_ATUAL}'")" "t"
expect_sqlstate "registro JÁ estornado é imutável" "P0001" \
  "UPDATE public.prime_beneficio_uso SET estornado_em = now(), estornado_por = '$UA' WHERE id='33333333-3333-3333-3333-222222222222'"

# F1 (falsificação embutida — roda AQUI, com a assinatura ainda ATIVA, senão o trigger
# de vigência barraria antes da constraint e a falsificação perderia o alvo): sem a
# constraint de honestidade, valor fabricado em operacional PASSARIA.
F1="$(P -qtA <<SQL
BEGIN;
SET test.uid = '$UA';
ALTER TABLE public.prime_beneficio_uso DROP CONSTRAINT prime_uso_valor_por_tipo;
INSERT INTO public.prime_beneficio_uso (assinatura_id, tipo, quantidade, valor_tabela, competencia, created_by)
  VALUES ('$A22','prioridade_entrega', 1, 999, '${MES_ATUAL}', '$UA') RETURNING 'ACEITOU_LIXO';
ROLLBACK;
SQL
)"
eq "F1: SEM a constraint, R\$ fabricado em prioridade PASSARIA (dente provado)" \
   "$(echo "$F1" | grep -c 'ACEITOU_LIXO' || true)" "1"

# ════════ ZONA 6 — RLS matriz (SET ROLE + GUC; psql superuser bypassaria) ════════
rls() { # $1=uid (vazio = anon) $2=sql
  if [ -z "$1" ]; then
    P -qtA -c "SET ROLE anon; SET test.uid=''; $2" 2>&1; P -q -c "RESET ROLE" >/dev/null
  else
    P -qtA -c "SET ROLE authenticated; SET test.uid='$1'; $2" 2>&1; P -q -c "RESET ROLE" >/dev/null
  fi
}
UB='00000000-0000-0000-0000-00000000bbbb'  # cliente dono
UC='00000000-0000-0000-0000-00000000cccc'  # cliente alheio
UD='00000000-0000-0000-0000-00000000dddd'  # logado SEM role nenhum

eq "staff lê a assinatura" "$(rls $UA "SELECT count(*) FROM public.prime_assinaturas")" "1"
eq "cliente dono lê a própria assinatura" "$(rls $UB "SELECT count(*) FROM public.prime_assinaturas")" "1"
eq "cliente ALHEIO não vê assinatura de outro" "$(rls $UC "SELECT count(*) FROM public.prime_assinaturas")" "0"
eq "logado SEM role não vê assinaturas" "$(rls $UD "SELECT count(*) FROM public.prime_assinaturas")" "0"
eq "anon não vê assinaturas" "$(rls '' "SELECT count(*) FROM public.prime_assinaturas")" "0"
eq "cliente dono lê o próprio uso (4 linhas, incl. estornada)" "$(rls $UB "SELECT count(*) FROM public.prime_beneficio_uso")" "4"
eq "cliente ALHEIO não vê uso de outro" "$(rls $UC "SELECT count(*) FROM public.prime_beneficio_uso")" "0"
eq "cliente vê o catálogo ATIVO (1 plano)" "$(rls $UB "SELECT count(*) FROM public.prime_planos")" "1"
eq "anon não vê catálogo" "$(rls '' "SELECT count(*) FROM public.prime_planos")" "0"
eq "cliente dono vê o próprio extrato (2 meses)" "$(rls $UB "SELECT count(*) FROM public.v_prime_extrato_mensal")" "2"
eq "cliente ALHEIO vê extrato vazio" "$(rls $UC "SELECT count(*) FROM public.v_prime_extrato_mensal")" "0"
eq "anon vê extrato vazio (view security_invoker)" "$(rls '' "SELECT count(*) FROM public.v_prime_extrato_mensal")" "0"
CLIENTE_INSERT="$(rls $UB "INSERT INTO public.prime_beneficio_uso (assinatura_id, tipo, quantidade, valor_tabela, competencia, created_by) VALUES ('$A22','coleta_rota', 1, NULL, '${MES_ATUAL}', '$UB') RETURNING 1" | grep -c '42501\|row-level security' || true)"
eq "cliente NÃO registra uso (writer único staff)" "$CLIENTE_INSERT" "1"
CLIENTE_UPDATE="$(rls $UB "UPDATE public.prime_beneficio_uso SET estornado_em=now(), estornado_por='$UB' WHERE assinatura_id='$A22' RETURNING 1" | grep -c 'RETURNING\|^1$' || true)"
eq "cliente NÃO estorna/edita uso (UPDATE 0 linhas sob RLS)" "$CLIENTE_UPDATE" "0"
CLIENTE_DELETE="$(rls $UB "DELETE FROM public.prime_beneficio_uso WHERE assinatura_id='$A22' RETURNING 1" | grep -c '^1$' || true)"
eq "cliente NÃO deleta uso" "$CLIENTE_DELETE" "0"
STAFF_DELETE="$(rls $UA "DELETE FROM public.prime_beneficio_uso WHERE assinatura_id='$A22' RETURNING 1" | grep -c '^1$' || true)"
eq "NEM STAFF deleta uso (sem policy de DELETE = append-only de verdade)" "$STAFF_DELETE" "0"
STAFF_FORJA="$(rls $UA "INSERT INTO public.prime_beneficio_uso (assinatura_id, tipo, quantidade, valor_tabela, competencia, created_by) VALUES ('$A22','coleta_rota', 1, NULL, '${MES_ATUAL}', '$UB') RETURNING 1" | grep -c '42501\|row-level security' || true)"
eq "staff NÃO forja created_by de outro (WITH CHECK created_by=auth.uid())" "$STAFF_FORJA" "1"

# ════════ ZONA 7 — ciclo de vida: suspensão congela; cancelar × sobreposição ════════
P -q <<SQL
SET test.uid = '$UA';
UPDATE public.prime_assinaturas SET status='suspensa', suspensa_em = '${MES_ATUAL}' WHERE id='$A22';
SQL
expect_sqlstate "uso em assinatura SUSPENSA é barrado (suspensa congela franquia)" "P0001" \
  "INSERT INTO public.prime_beneficio_uso (assinatura_id, tipo, quantidade, valor_tabela, competencia, created_by) VALUES ('$A22','coleta_rota', 1, NULL, '${MES_ATUAL}', '$UA')"
eq "extrato NÃO cresce após suspensa_em (2 meses, congelado)" \
   "$(Pq -c "SELECT count(*) FROM public.v_prime_extrato_mensal WHERE assinatura_id='$A22'")" "2"
P -q <<SQL
SET test.uid = '$UA';
UPDATE public.prime_assinaturas SET status='cancelada', data_fim = (now() AT TIME ZONE 'America/Sao_Paulo')::date WHERE id='$A22';
SQL
expect_sqlstate "nova assinatura no MESMO mês do fim da anterior é barrada (competência não duplica)" "P0001" \
  "INSERT INTO public.prime_assinaturas (customer_user_id, plano_id, preco_contratado, franquia_dentes_contratada, data_inicio, created_by) VALUES ('$UB','11111111-1111-1111-1111-111111111111', 119, 200, '${MES_ATUAL}', '$UA')"
P -q <<SQL
SET test.uid = '$UA';
INSERT INTO public.prime_assinaturas (customer_user_id, plano_id, preco_contratado, franquia_dentes_contratada, data_inicio, created_by)
  VALUES ('$UB','11111111-1111-1111-1111-111111111111', 119, 200, '${MES_QUE_VEM}', '$UA');
SQL
eq "nova assinatura no mês SEGUINTE passa (preço novo = ciclo novo, grandfathering)" \
   "$(Pq -c "SELECT count(*) FROM public.prime_assinaturas WHERE customer_user_id='$UB'")" "2"
expect_sqlstate "UPDATE que puxa o início pra mês já coberto é barrado (sobreposição via UPDATE)" "P0001" \
  "UPDATE public.prime_assinaturas SET data_inicio = '${MES_ATUAL}' WHERE customer_user_id='$UB' AND status='ativa'"
eq "updated_at avançou no UPDATE (trigger vivo)" \
   "$(Pq -c "SELECT updated_at > created_at FROM public.prime_assinaturas WHERE id='$A22'")" "t"

# ════════ ZONA 8 — FALSIFICAÇÃO EMBUTIDA F2 (F1 rodou no fim da zona 5) ════════
# F2: com a policy do cliente sabotada para USING(true), o ALHEIO passa a ver tudo.
F2="$(P -qtA <<SQL
BEGIN;
ALTER POLICY prime_assinaturas_cliente_read ON public.prime_assinaturas USING (true);
SET ROLE authenticated; SET test.uid='$UC';
SELECT count(*) FROM public.prime_assinaturas;
RESET ROLE;
ROLLBACK;
SQL
)"
eq "F2: policy sabotada p/ USING(true) → cliente ALHEIO vê 2 assinaturas (dente provado)" \
   "$(echo "$F2" | tail -1)" "2"

echo
echo "═══════════════════════════════════"
echo " PASS=$PASS FAIL=$FAIL"
echo "═══════════════════════════════════"
[ "$FAIL" -eq 0 ]
