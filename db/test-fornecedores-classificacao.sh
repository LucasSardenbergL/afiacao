#!/usr/bin/env bash
# Teste PG17 — Fornecedores fora da carteira (Fase 1): RPCs classificar/reverter + trigger + cleanup.
# Aplica schema-snapshot + migration A (schema) + migration B (RPCs/trigger), semeia cenários e assere:
#   A1  fornecedor (tag) sem exceção        → excluir_da_carteira=true
#   A2  fornecedor COM exceção (curadoria)  → excluir_da_carteira=false
#   A3  cliente comum (sem tag)             → is_fornecedor=false, excluir=false
#   A4  'FORNECEDOR' / ' Transportadora '   → is_fornecedor=true (lower/trim)
#   A5  cleanup: eligible=false + scores deletados p/ flaggeds; não-flaggeds intactos
#   A6  transportadora pura (cleanup)       → eligible=false (carteira é 1:1 por UNIQUE(customer_user_id))
#   A7  reverter (master)                   → exceção, excluir=false, eligible=true, AMBAS as filas enfileiradas
#   A7g reverter (NÃO-master)               → RAISE (gate), alvo intacto
#   A8  fornecedor COM venda real → NÃO exclui (régua A: tem pedido = cliente, fica); cancelada não conta
#   A9  trigger deriva no INSERT e no UPDATE OF tags_omie (sem chamar a RPC)
# Base: db/verify-snapshot-replay.sh / db/test-minimo-forcado.sh. Pré-req: brew install postgresql@17 pgvector.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PGVER=17
PGBIN="/opt/homebrew/opt/postgresql@${PGVER}/bin"
PORT=5436
DATA="$(mktemp -d /tmp/pgtest-fornec.XXXXXX)/data"
export LC_ALL=C LANG=C

[ -x "$PGBIN/initdb" ] || { echo "postgresql@${PGVER} ausente: brew install postgresql@${PGVER} pgvector"; exit 1; }

CELLAR="$(brew --prefix postgresql@${PGVER})"
cp -Rn "$CELLAR"/share/postgresql/. "/opt/homebrew/share/postgresql@${PGVER}/" 2>/dev/null || true
mkdir -p "/opt/homebrew/lib/postgresql@${PGVER}"
cp -Rn "$CELLAR"/lib/postgresql/. "/opt/homebrew/lib/postgresql@${PGVER}/" 2>/dev/null || true

cleanup() { "$PGBIN/pg_ctl" -D "$DATA" stop -m immediate >/dev/null 2>&1 || true; rm -rf "$(dirname "$DATA")"; rm -f "${RR:-}"; }
trap cleanup EXIT

"$PGBIN/initdb" -D "$DATA" -U postgres -E UTF8 --locale=C >/dev/null
"$PGBIN/pg_ctl" -D "$DATA" -o "-p $PORT -k /tmp" -l /tmp/pg-fornec.log -w start >/dev/null
"$PGBIN/createdb" -p "$PORT" -h /tmp -U postgres fornec_verify
P() { "$PGBIN/psql" -p "$PORT" -h /tmp -U postgres -d fornec_verify "$@"; }

RR="$(mktemp "${TMPDIR:-/tmp}/snap-fornec.XXXXXX")"
sed -E 's/^(CREATE SCHEMA public;)/-- \1/' "$REPO_ROOT/supabase/schema-snapshot.sql" \
  | grep -vE '^\\(un)?restrict ' > "$RR"

echo "→ stubs + prelude + snapshot…"
P -v ON_ERROR_STOP=1 -q -f "$REPO_ROOT/db/stubs-supabase.sql"
P -v ON_ERROR_STOP=1 -q -f "$REPO_ROOT/supabase/schema-extensions-prelude.sql"
P --single-transaction -v ON_ERROR_STOP=1 -q -f "$RR"
rm -f "$RR"

echo "→ migration A (schema cliente_classificacao + fornecedor_excecao)…"
P -v ON_ERROR_STOP=1 -q -f "$REPO_ROOT/supabase/migrations/20260606170000_fornecedores_classificacao_schema.sql" >/dev/null
echo "→ migration B (RPCs classificar/reverter + trigger)…"
P -v ON_ERROR_STOP=1 -q -f "$REPO_ROOT/supabase/migrations/20260606170100_fornecedores_classificacao_rpcs.sql" >/dev/null

echo "→ override auth.uid() p/ ler GUC de sessão (padrão Silver+ do replay)…"
P -v ON_ERROR_STOP=1 -q <<'SQL'
CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$
  SELECT nullif(current_setting('test.current_uid', true), '')::uuid
$$;
-- stub: customer_canonical_alias (B-lite) NÃO está no schema-snapshot (stale); o reverter a referencia.
CREATE TABLE IF NOT EXISTS public.customer_canonical_alias (
  alias_user_id uuid, canonical_user_id uuid, status text
);
SQL

echo "→ seed dos cenários (trigger deriva no INSERT)…"
P -v ON_ERROR_STOP=1 -q <<'SQL'
-- usuários (FK: cliente_classificacao/fornecedor_excecao/carteira_assignments → auth.users)
INSERT INTO auth.users (id) VALUES
  ('00000000-0000-0000-0000-0000000000aa'), -- master
  ('00000000-0000-0000-0000-0000000000bb'), -- não-master (employee)
  ('00000000-0000-0000-0000-0000000000f1'), -- farmer 1
  ('00000000-0000-0000-0000-0000000000f2'), -- farmer 2
  ('00000000-0000-0000-0000-0000000000c1'),
  ('00000000-0000-0000-0000-0000000000c2'),
  ('00000000-0000-0000-0000-0000000000c3'),
  ('00000000-0000-0000-0000-0000000000c4'),
  ('00000000-0000-0000-0000-0000000000c5'),
  ('00000000-0000-0000-0000-0000000000c6'),
  ('00000000-0000-0000-0000-0000000000c8'); -- fornecedor com SÓ orçamento (testa orcamento ∉ venda)

INSERT INTO public.user_roles (user_id, role) VALUES
  ('00000000-0000-0000-0000-0000000000aa','master'),
  ('00000000-0000-0000-0000-0000000000bb','employee');

-- exceção curada de c2 ANTES da classificação (o trigger lê fornecedor_excecao no INSERT)
INSERT INTO public.fornecedor_excecao (user_id, motivo) VALUES
  ('00000000-0000-0000-0000-0000000000c2','cliente real — compra recorrente');

-- carteira: 1 dono por cliente (UNIQUE(customer_user_id) — invariante "1 por cliente" do Omie).
INSERT INTO public.carteira_assignments (customer_user_id, owner_user_id, source, eligible) VALUES
  ('00000000-0000-0000-0000-0000000000c1','00000000-0000-0000-0000-0000000000f1','omie',true),
  ('00000000-0000-0000-0000-0000000000c2','00000000-0000-0000-0000-0000000000f1','omie',true),
  ('00000000-0000-0000-0000-0000000000c3','00000000-0000-0000-0000-0000000000f1','omie',true),
  ('00000000-0000-0000-0000-0000000000c4','00000000-0000-0000-0000-0000000000f1','omie',true),
  ('00000000-0000-0000-0000-0000000000c5','00000000-0000-0000-0000-0000000000f1','omie',true),
  ('00000000-0000-0000-0000-0000000000c6','00000000-0000-0000-0000-0000000000f1','omie',true);

-- vendas: c6 válida (enviado) → tem_venda_real=true; c1 só cancelada → false
INSERT INTO public.sales_orders (customer_user_id, status, created_by) VALUES
  ('00000000-0000-0000-0000-0000000000c6','enviado',  '00000000-0000-0000-0000-0000000000f1'),
  ('00000000-0000-0000-0000-0000000000c1','cancelado','00000000-0000-0000-0000-0000000000f1'),
  ('00000000-0000-0000-0000-0000000000c8','orcamento','00000000-0000-0000-0000-0000000000f1');

-- classificação (o trigger deriva SÓ is_fornecedor no INSERT; excluir vem da RPC, régua A)
INSERT INTO public.cliente_classificacao (user_id, tags_omie) VALUES
  ('00000000-0000-0000-0000-0000000000c1', ARRAY['Fornecedor']),
  ('00000000-0000-0000-0000-0000000000c2', ARRAY['Fornecedor']),
  ('00000000-0000-0000-0000-0000000000c3', ARRAY['Cliente VIP']),
  ('00000000-0000-0000-0000-0000000000c4', ARRAY['FORNECEDOR',' Transportadora ']),
  ('00000000-0000-0000-0000-0000000000c5', ARRAY['Transportadora']),
  ('00000000-0000-0000-0000-0000000000c6', ARRAY['Fornecedor']),
  ('00000000-0000-0000-0000-0000000000c8', ARRAY['Fornecedor']);

-- scores p/ testar o cleanup (c1 flagged → deletado; c3 comum → permanece)
INSERT INTO public.customer_visit_scores (customer_user_id, farmer_id) VALUES
  ('00000000-0000-0000-0000-0000000000c1','00000000-0000-0000-0000-0000000000f1'),
  ('00000000-0000-0000-0000-0000000000c3','00000000-0000-0000-0000-0000000000f1');
INSERT INTO public.farmer_client_scores (customer_user_id, farmer_id) VALUES
  ('00000000-0000-0000-0000-0000000000c1','00000000-0000-0000-0000-0000000000f1'),
  ('00000000-0000-0000-0000-0000000000c3','00000000-0000-0000-0000-0000000000f1');
SQL

echo ""
echo "→ A9 (trigger no INSERT) + corrupt + classificar + A1–A4/A8:"
P -v ON_ERROR_STOP=1 -q <<'SQL'
DO $$
DECLARE r RECORD; res jsonb;
BEGIN
  -- A9 (insert trigger): deriva SÓ is_fornecedor; excluir NÃO é setado pelo trigger (fica default false)
  SELECT is_fornecedor AS isf, excluir_da_carteira AS exc INTO r FROM cliente_classificacao WHERE user_id='00000000-0000-0000-0000-0000000000c1';
  IF NOT r.isf THEN RAISE EXCEPTION 'A9 FALHOU (insert): c1 deveria nascer is_fornecedor=true'; END IF;
  IF r.exc THEN RAISE EXCEPTION 'A9 FALHOU (insert): trigger NÃO deve setar excluir (é da RPC) — c1 nasceu exc=true'; END IF;
  SELECT is_fornecedor AS isf INTO r FROM cliente_classificacao WHERE user_id='00000000-0000-0000-0000-0000000000c3';
  IF r.isf THEN RAISE EXCEPTION 'A9 FALHOU (insert): c3 comum não deveria ser fornecedor'; END IF;
  RAISE NOTICE 'OK A9 (insert): trigger seta só is_fornecedor (c1=t, c3=f); excluir fica p/ a RPC';

  -- corromper as flags SEM tocar tags_omie (trigger é UPDATE OF tags_omie → não dispara) — valores
  -- ERRADOS em ambas as direções p/ provar que a RPC sobrescreve.
  UPDATE cliente_classificacao SET is_fornecedor=false, excluir_da_carteira=true, tem_venda_real=true;

  -- classificar (RPC) deve restaurar tudo conforme a RÉGUA A
  SELECT classificar_clientes_fornecedores() INTO res;
  IF (res->>'excluidos')::int <> 4 THEN RAISE EXCEPTION 'RPC excluidos=% (esperado 4: c1,c4,c5,c8 — c6 tem venda, fica)', res->>'excluidos'; END IF;
  RAISE NOTICE 'OK RPC classificar → %', res;

  -- A1: c1 fornecedor SEM venda (só cancelada) → exclui
  SELECT is_fornecedor AS isf, excluir_da_carteira AS exc INTO r FROM cliente_classificacao WHERE user_id='00000000-0000-0000-0000-0000000000c1';
  IF NOT (r.isf AND r.exc) THEN RAISE EXCEPTION 'A1 FALHOU: c1 fornecedor sem venda deveria excluir'; END IF;
  RAISE NOTICE 'OK A1 — fornecedor sem venda exclui';
  -- A2
  SELECT is_fornecedor AS isf, excluir_da_carteira AS exc INTO r FROM cliente_classificacao WHERE user_id='00000000-0000-0000-0000-0000000000c2';
  IF NOT r.isf OR r.exc THEN RAISE EXCEPTION 'A2 FALHOU: c2 (is=% exc=%) exceção deveria manter na carteira', r.isf, r.exc; END IF;
  RAISE NOTICE 'OK A2 — exceção vence (fica)';
  -- A3
  SELECT is_fornecedor AS isf, excluir_da_carteira AS exc INTO r FROM cliente_classificacao WHERE user_id='00000000-0000-0000-0000-0000000000c3';
  IF r.isf OR r.exc THEN RAISE EXCEPTION 'A3 FALHOU: c3 comum não deveria sair'; END IF;
  RAISE NOTICE 'OK A3 — cliente comum fica';
  -- A4 (case/acento/trim)
  SELECT is_fornecedor AS isf, excluir_da_carteira AS exc INTO r FROM cliente_classificacao WHERE user_id='00000000-0000-0000-0000-0000000000c4';
  IF NOT (r.isf AND r.exc) THEN RAISE EXCEPTION 'A4 FALHOU: FORNECEDOR/'' Transportadora '' c/ case/trim não detectado'; END IF;
  RAISE NOTICE 'OK A4 — case/trim detectado';
  -- A8 (RÉGUA A): c6 fornecedor COM venda → NÃO exclui (poupado); venda cancelada de c1 não conta
  SELECT tem_venda_real AS tvr, is_fornecedor AS isf, excluir_da_carteira AS exc INTO r FROM cliente_classificacao WHERE user_id='00000000-0000-0000-0000-0000000000c6';
  IF NOT r.tvr THEN RAISE EXCEPTION 'A8 FALHOU: c6 tem venda enviada → tem_venda_real=true'; END IF;
  IF NOT r.isf THEN RAISE EXCEPTION 'A8 FALHOU: c6 tem tag Fornecedor → is_fornecedor=true'; END IF;
  IF r.exc THEN RAISE EXCEPTION 'A8 FALHOU (régua A): c6 fornecedor COM venda NÃO deve sair (exc=true)'; END IF;
  SELECT tem_venda_real AS tvr INTO r FROM cliente_classificacao WHERE user_id='00000000-0000-0000-0000-0000000000c1';
  IF r.tvr THEN RAISE EXCEPTION 'A8 FALHOU: c1 só tem venda cancelada → tem_venda_real=false'; END IF;
  RAISE NOTICE 'OK A8 (régua A) — fornecedor COM venda (c6) fica; cancelada (c1) não conta';
  -- A8b (Codex #5): c8 fornecedor com SÓ orçamento → orcamento ∉ venda → exclui
  SELECT tem_venda_real AS tvr, excluir_da_carteira AS exc INTO r FROM cliente_classificacao WHERE user_id='00000000-0000-0000-0000-0000000000c8';
  IF r.tvr THEN RAISE EXCEPTION 'A8b FALHOU: c8 só tem orçamento → tem_venda_real=false (orcamento não é venda)'; END IF;
  IF NOT r.exc THEN RAISE EXCEPTION 'A8b FALHOU (Codex #5): c8 fornecedor com só orçamento DEVE sair'; END IF;
  RAISE NOTICE 'OK A8b (#5) — orçamento não conta como venda; fornecedor-só-orçamento sai';
END $$;
SQL

echo ""
echo "→ A9b (trigger no UPDATE OF tags_omie, sem RPC):"
P -v ON_ERROR_STOP=1 -q <<'SQL'
DO $$
DECLARE r RECORD;
BEGIN
  INSERT INTO auth.users (id) VALUES ('00000000-0000-0000-0000-0000000000c7');
  INSERT INTO cliente_classificacao (user_id, tags_omie) VALUES ('00000000-0000-0000-0000-0000000000c7', ARRAY['Cliente']);
  SELECT is_fornecedor AS isf INTO r FROM cliente_classificacao WHERE user_id='00000000-0000-0000-0000-0000000000c7';
  IF r.isf THEN RAISE EXCEPTION 'A9b FALHOU: c7 nasceu comum, não deveria ser fornecedor'; END IF;
  UPDATE cliente_classificacao SET tags_omie = ARRAY['Transportadora'] WHERE user_id='00000000-0000-0000-0000-0000000000c7';
  SELECT is_fornecedor AS isf INTO r FROM cliente_classificacao WHERE user_id='00000000-0000-0000-0000-0000000000c7';
  IF NOT r.isf THEN RAISE EXCEPTION 'A9b FALHOU: UPDATE de tags_omie não re-derivou is_fornecedor (is=%)', r.isf; END IF;
  RAISE NOTICE 'OK A9b — UPDATE OF tags_omie re-deriva is_fornecedor (excluir fica p/ a RPC)';
END $$;
SQL

echo ""
echo "→ A5/A6 cleanup via aplicar_exclusao_fornecedores() (Codex #3 — cleanup recorrente):"
P -v ON_ERROR_STOP=1 -q <<'SQL'
SELECT public.aplicar_exclusao_fornecedores();
DO $$
DECLARE n int;
BEGIN
  -- A5: c1 (flagged) não-elegível; c3 (comum) elegível
  IF EXISTS (SELECT 1 FROM carteira_assignments WHERE customer_user_id='00000000-0000-0000-0000-0000000000c1' AND eligible) THEN RAISE EXCEPTION 'A5 FALHOU: c1 ainda elegível'; END IF;
  IF NOT EXISTS (SELECT 1 FROM carteira_assignments WHERE customer_user_id='00000000-0000-0000-0000-0000000000c3' AND eligible) THEN RAISE EXCEPTION 'A5 FALHOU: c3 comum perdeu elegibilidade'; END IF;
  -- scores: c1 deletado, c3 mantido
  IF EXISTS (SELECT 1 FROM customer_visit_scores WHERE customer_user_id='00000000-0000-0000-0000-0000000000c1')
     OR EXISTS (SELECT 1 FROM farmer_client_scores WHERE customer_user_id='00000000-0000-0000-0000-0000000000c1') THEN
    RAISE EXCEPTION 'A5 FALHOU: scores de c1 não foram deletados';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM customer_visit_scores WHERE customer_user_id='00000000-0000-0000-0000-0000000000c3')
     OR NOT EXISTS (SELECT 1 FROM farmer_client_scores WHERE customer_user_id='00000000-0000-0000-0000-0000000000c3') THEN
    RAISE EXCEPTION 'A5 FALHOU: scores de c3 (comum) foram deletados por engano';
  END IF;
  RAISE NOTICE 'OK A5 — eligible=false + scores deletados p/ flaggeds; comum intacto';
  -- A6: c5 (tag 'Transportadora' pura) flagged → eligible=false (carteira é 1:1; cobre o tag transportadora no cleanup)
  IF EXISTS (SELECT 1 FROM carteira_assignments WHERE customer_user_id='00000000-0000-0000-0000-0000000000c5' AND eligible) THEN
    RAISE EXCEPTION 'A6 FALHOU: c5 (transportadora pura) ainda elegível após cleanup';
  END IF;
  RAISE NOTICE 'OK A6 — transportadora pura flagged → não-elegível';
END $$;
SQL

echo ""
echo "→ A7 reverter (master) — exceção + flag off + eligible on + AMBAS as filas:"
P -v ON_ERROR_STOP=1 -q <<'SQL'
SET test.current_uid = '00000000-0000-0000-0000-0000000000aa';  -- master
SELECT reverter_exclusao_fornecedor('00000000-0000-0000-0000-0000000000c1','teste-reversao');
DO $$
DECLARE n int; r RECORD;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM fornecedor_excecao WHERE user_id='00000000-0000-0000-0000-0000000000c1') THEN RAISE EXCEPTION 'A7 FALHOU: exceção não criada'; END IF;
  SELECT excluir_da_carteira AS exc INTO r FROM cliente_classificacao WHERE user_id='00000000-0000-0000-0000-0000000000c1';
  IF r.exc THEN RAISE EXCEPTION 'A7 FALHOU: excluir ainda true'; END IF;
  IF EXISTS (SELECT 1 FROM carteira_assignments WHERE customer_user_id='00000000-0000-0000-0000-0000000000c1' AND NOT eligible) THEN RAISE EXCEPTION 'A7 FALHOU: ainda há assignment não-elegível'; END IF;
  SELECT count(*) INTO n FROM visit_score_recalc_queue WHERE customer_user_id='00000000-0000-0000-0000-0000000000c1' AND processed_at IS NULL;
  IF n < 1 THEN RAISE EXCEPTION 'A7 FALHOU: visit_score_recalc_queue não enfileirada'; END IF;
  SELECT count(*) INTO n FROM score_recalc_queue WHERE customer_user_id='00000000-0000-0000-0000-0000000000c1' AND processed_at IS NULL;
  IF n < 1 THEN RAISE EXCEPTION 'A7 FALHOU: score_recalc_queue não enfileirada'; END IF;
  RAISE NOTICE 'OK A7 — reverter: exceção + flag off + eligible on + 2 filas enfileiradas';
END $$;
SQL

echo ""
echo "→ A7g reverter (NÃO-master) — gate deve barrar, alvo intacto:"
P -v ON_ERROR_STOP=1 -q <<'SQL'
SET test.current_uid = '00000000-0000-0000-0000-0000000000bb';  -- employee, não-master
DO $$
DECLARE barrou boolean := false;
BEGIN
  BEGIN
    PERFORM reverter_exclusao_fornecedor('00000000-0000-0000-0000-0000000000c4','tentativa indevida');
  EXCEPTION WHEN others THEN barrou := true;
  END;
  IF NOT barrou THEN RAISE EXCEPTION 'A7g FALHOU: não-master conseguiu reverter (gate furado)'; END IF;
  IF EXISTS (SELECT 1 FROM fornecedor_excecao WHERE user_id='00000000-0000-0000-0000-0000000000c4') THEN RAISE EXCEPTION 'A7g FALHOU: exceção criada por não-master'; END IF;
  IF NOT (SELECT excluir_da_carteira FROM cliente_classificacao WHERE user_id='00000000-0000-0000-0000-0000000000c4') THEN RAISE EXCEPTION 'A7g FALHOU: c4 deveria seguir excluído'; END IF;
  RAISE NOTICE 'OK A7g — gate master barra não-master (alvo intacto)';
END $$;
SQL

echo ""
P -v ON_ERROR_STOP=1 -q -c "SELECT 'TODOS OS TESTES PG17 PASSARAM ✓' AS resultado;"
echo "✓ db/test-fornecedores-classificacao.sh — PASSOU"
