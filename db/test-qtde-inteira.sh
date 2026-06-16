#!/usr/bin/env bash
# Teste PG17 — ceil em qtde_sugerida/qtde_final na RPC gerar_pedidos_sugeridos_ciclo
# (migration 20260606150000_reposicao_qtde_inteira.sql).
#
# Prova, sobre dados semeados com poeira decimal no estoque (tinta em litros):
#  - ANTES (20260606120000, account-aware SEM ceil): qtde_sugerida/qtde_final FRACIONÁRIAS
#    (9,99996 / 10,6 / 0,00004 / mínimo forçado fracionário) → o bug existe (teste significativo).
#  - DEPOIS (20260606150000, +ceil): toda qtde_sugerida e qtde_final é INTEIRA (= ceil do antes).
#  - O CONJUNTO de itens é IDÊNTICO antes/depois (ceil(x)>0 ⟺ x>0 — só o VALOR muda). [Q5]
#  - valor_linha = qtde_final(ceil) × cmc; valor_total = Σ; retorno da RPC == persistido.
#  - GUARD anti-drift: a função DEPOIS preserva TODAS as guardas da base (fail-closed tipo_produto,
#    account-aware, '04', 405/450ML, fornecedor NOT NULL, gate de necessidade <= ponto_pedido).
# Base: db/verify-snapshot-replay.sh + db/test-rpc-account-aware.sh. Pré-req: brew install postgresql@17 pgvector.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PGVER=17
PGBIN="/opt/homebrew/opt/postgresql@${PGVER}/bin"
PORT=5436
DATA="$(mktemp -d /tmp/pgtest-qtdeint.XXXXXX)/data"
export LC_ALL=C LANG=C

[ -x "$PGBIN/initdb" ] || { echo "postgresql@${PGVER} ausente: brew install postgresql@${PGVER} pgvector"; exit 1; }

CELLAR="$(brew --prefix postgresql@${PGVER})"
cp -Rn "$CELLAR"/share/postgresql/. "/opt/homebrew/share/postgresql@${PGVER}/" 2>/dev/null || true
mkdir -p "/opt/homebrew/lib/postgresql@${PGVER}"
cp -Rn "$CELLAR"/lib/postgresql/. "/opt/homebrew/lib/postgresql@${PGVER}/" 2>/dev/null || true

cleanup() { "$PGBIN/pg_ctl" -D "$DATA" stop -m immediate >/dev/null 2>&1 || true; rm -rf "$(dirname "$DATA")"; }
trap cleanup EXIT

"$PGBIN/initdb" -D "$DATA" -U postgres -E UTF8 --locale=C >/dev/null
"$PGBIN/pg_ctl" -D "$DATA" -o "-p $PORT -k /tmp" -l /tmp/pg-qtdeint.log -w start >/dev/null
"$PGBIN/createdb" -p "$PORT" -h /tmp -U postgres qtdeint_verify
P() { "$PGBIN/psql" -p "$PORT" -h /tmp -U postgres -d qtdeint_verify "$@"; }

RR="$(mktemp /tmp/snap-qtdeint.XXXXXX.sql)"
sed -E 's/^(CREATE SCHEMA public;)/-- \1/' "$REPO_ROOT/supabase/schema-snapshot.sql" \
  | grep -vE '^\\(un)?restrict ' > "$RR"

echo "→ stubs + prelude + snapshot…"
P -v ON_ERROR_STOP=1 -q -f "$REPO_ROOT/db/stubs-supabase.sql"
P -v ON_ERROR_STOP=1 -q -f "$REPO_ROOT/supabase/schema-extensions-prelude.sql"
P --single-transaction -v ON_ERROR_STOP=1 -q -f "$RR"
rm -f "$RR"

echo "→ foundation (omie_products.tipo_produto — stale no snapshot)…"
P -v ON_ERROR_STOP=1 -q -c "ALTER TABLE public.omie_products ADD COLUMN IF NOT EXISTS tipo_produto text;"

echo "→ base coluna minimo_forcado_manual: 20260604190000…"
P -v ON_ERROR_STOP=1 -q -f "$REPO_ROOT/supabase/migrations/20260604190000_reposicao_minimo_forcado.sql" >/dev/null

echo "→ ANTES: 20260606120000 (account-aware, SEM ceil)…"
P -v ON_ERROR_STOP=1 -q -f "$REPO_ROOT/supabase/migrations/20260606120000_reposicao_rpc_account_aware.sql" >/dev/null

echo "→ seed: estoque com poeira decimal (tinta em litros). pp=100, emax=100 → natural = 100 − estoque…"
P -v ON_ERROR_STOP=1 -q <<'SQL'
-- omie_products: account lowercase, ativo, tipo '00' (comprável), familia neutra. codigo+descricao NOT NULL.
INSERT INTO public.omie_products (omie_codigo_produto, codigo, descricao, account, ativo, familia, tipo_produto) VALUES
  (8001,'8001','POEIRA 9,99996','oben',true,'F1','00'),   -- estoque 90,00004 → natural 9,99996
  (8002,'8002','FRACAO 10,6','oben',true,'F1','00'),       -- estoque 89,4     → natural 10,6
  (8003,'8003','MIN-FORCADO INT','oben',true,'F1','00'),   -- estoque 95,5 (nat 4,5), min 8     → final 8
  (8004,'8004','MIN-FORCADO FRAC','oben',true,'F1','00'),  -- estoque 95,5 (nat 4,5), min 7,5   → final ceil 8
  (8005,'8005','INTEIRO EXATO','oben',true,'F1','00'),      -- estoque 90 exato → natural 10 (ceil no-op)
  (8006,'8006','LIMIAR ZERO','oben',true,'F1','00'),        -- estoque 100 = pp, natural 0 → EXCLUÍDO (ambos)
  (8007,'8007','POEIRA POSITIVA','oben',true,'F1','00');    -- estoque 99,99996 → natural 0,00004 → INCLUÍDO ambos

INSERT INTO public.sku_parametros
  (empresa, sku_codigo_omie, sku_descricao, fornecedor_nome, ponto_pedido, estoque_maximo,
   habilitado_reposicao_automatica, tipo_reposicao, minimo_forcado_manual, ativo) VALUES
  ('OBEN',8001,'SKU 8001','FORN-8001',100,100,true,'automatica',NULL,true),
  ('OBEN',8002,'SKU 8002','FORN-8002',100,100,true,'automatica',NULL,true),
  ('OBEN',8003,'SKU 8003','FORN-8003',100,100,true,'automatica',8,  true),
  ('OBEN',8004,'SKU 8004','FORN-8004',100,100,true,'automatica',7.5,true),
  ('OBEN',8005,'SKU 8005','FORN-8005',100,100,true,'automatica',NULL,true),
  ('OBEN',8006,'SKU 8006','FORN-8006',100,100,true,'automatica',NULL,true),
  ('OBEN',8007,'SKU 8007','FORN-8007',100,100,true,'automatica',NULL,true);

-- estoque com a poeira decimal exata de cada cenário (estoque_efetivo <= pp=100 → entra no gate)
INSERT INTO public.sku_estoque_atual (empresa, sku_codigo_omie, estoque_fisico, estoque_pendente_entrada) VALUES
  ('OBEN','8001',90.00004,0),
  ('OBEN','8002',89.4,    0),
  ('OBEN','8003',95.5,    0),
  ('OBEN','8004',95.5,    0),
  ('OBEN','8005',90,      0),
  ('OBEN','8006',100,     0),
  ('OBEN','8007',99.99996,0);

-- preço determinístico via inventory_position.cmc=10 (account = empresa).
INSERT INTO public.inventory_position (omie_codigo_produto, account, cmc)
SELECT sku_codigo_omie, 'oben', 10 FROM public.sku_parametros WHERE empresa='OBEN';

CREATE TABLE scratch_antes  (sku text, qtde_sugerida numeric, qtde_final numeric, valor_linha numeric);
CREATE TABLE scratch_depois (sku text, qtde_sugerida numeric, qtde_final numeric, valor_linha numeric);
CREATE TABLE scratch_ret    (fase text, pedidos int, skus int, valor numeric, bloqueados int);
SQL

echo "→ RODA ANTES (sem ceil)…"
P -v ON_ERROR_STOP=1 -q <<'SQL'
INSERT INTO scratch_ret SELECT 'antes', g.* FROM public.gerar_pedidos_sugeridos_ciclo('OBEN', CURRENT_DATE) g;
INSERT INTO scratch_antes
  SELECT pci.sku_codigo_omie, pci.qtde_sugerida, pci.qtde_final, pci.valor_linha
  FROM pedido_compra_item pci JOIN pedido_compra_sugerido pcs ON pcs.id = pci.pedido_id
  WHERE pcs.data_ciclo = CURRENT_DATE AND pcs.status = 'pendente_aprovacao';
SQL

echo "→ aplica a migration: 20260606150000_reposicao_qtde_inteira.sql (+ceil)…"
P -v ON_ERROR_STOP=1 -f "$REPO_ROOT/supabase/migrations/20260606150000_reposicao_qtde_inteira.sql"

echo "→ RODA DEPOIS (com ceil)…"
P -v ON_ERROR_STOP=1 -q <<'SQL'
INSERT INTO scratch_ret SELECT 'depois', g.* FROM public.gerar_pedidos_sugeridos_ciclo('OBEN', CURRENT_DATE) g;
INSERT INTO scratch_depois
  SELECT pci.sku_codigo_omie, pci.qtde_sugerida, pci.qtde_final, pci.valor_linha
  FROM pedido_compra_item pci JOIN pedido_compra_sugerido pcs ON pcs.id = pci.pedido_id
  WHERE pcs.data_ciclo = CURRENT_DATE AND pcs.status = 'pendente_aprovacao';
SQL

echo ""
echo "→ ASSERTS:"
P -v ON_ERROR_STOP=1 -q <<'SQL'
DO $$
DECLARE d int; fdef text;
BEGIN
  -- 0. SANIDADE: o teste é significativo? ANTES deve ter qtde FRACIONÁRIA (senão não prova nada).
  SELECT count(*) INTO d FROM scratch_antes WHERE qtde_final <> trunc(qtde_final) OR qtde_sugerida <> trunc(qtde_sugerida);
  IF d = 0 THEN RAISE EXCEPTION '0 FALHOU: ANTES não tem nenhuma fração — seed/base inválido, teste não prova o fix'; END IF;
  RAISE NOTICE 'OK 0 — ANTES tem % linha(s) fracionária(s) (o bug existe; teste é significativo)', d;

  -- 0b. casos pontuais ANTES (a fração exata)
  PERFORM 1 FROM scratch_antes WHERE sku='8001' AND qtde_final = 9.99996 AND qtde_sugerida = 9.99996;
  IF NOT FOUND THEN RAISE EXCEPTION '0b FALHOU: 8001 ANTES != 9,99996'; END IF;
  PERFORM 1 FROM scratch_antes WHERE sku='8004' AND qtde_final = 7.5;  -- min forçado fracionário cru
  IF NOT FOUND THEN RAISE EXCEPTION '0b FALHOU: 8004 ANTES (min forçado 7,5) != 7,5'; END IF;
  PERFORM 1 FROM scratch_antes WHERE sku='8007' AND qtde_final = 0.00004;  -- poeira positiva
  IF NOT FOUND THEN RAISE EXCEPTION '0b FALHOU: 8007 ANTES != 0,00004'; END IF;
  RAISE NOTICE 'OK 0b — frações exatas ANTES (8001=9,99996; 8004=7,5; 8007=0,00004)';

  -- A. DEPOIS: NENHUMA fração — toda qtde_sugerida e qtde_final é inteira.
  SELECT count(*) INTO d FROM scratch_depois WHERE qtde_final <> trunc(qtde_final) OR qtde_sugerida <> trunc(qtde_sugerida);
  IF d <> 0 THEN RAISE EXCEPTION 'A FALHOU: DEPOIS ainda tem % linha(s) fracionária(s)', d; END IF;
  RAISE NOTICE 'OK A — DEPOIS: zero fração (toda qtde inteira)';

  -- B. DEPOIS = ceil(ANTES) em ambas as colunas (valor exato, item a item).
  SELECT count(*) INTO d FROM scratch_antes a JOIN scratch_depois p ON p.sku = a.sku
   WHERE p.qtde_final <> ceil(a.qtde_final) OR p.qtde_sugerida <> ceil(a.qtde_sugerida);
  IF d <> 0 THEN RAISE EXCEPTION 'B FALHOU: % linha(s) DEPOIS != ceil(ANTES)', d; END IF;
  RAISE NOTICE 'OK B — DEPOIS = ceil(ANTES) em qtde_sugerida e qtde_final (item a item)';

  -- B2. casos pontuais DEPOIS
  PERFORM 1 FROM scratch_depois WHERE sku='8001' AND qtde_final=10 AND qtde_sugerida=10; -- 9,99996→10
  IF NOT FOUND THEN RAISE EXCEPTION 'B2 FALHOU: 8001 DEPOIS != 10'; END IF;
  PERFORM 1 FROM scratch_depois WHERE sku='8002' AND qtde_final=11;                       -- 10,6→11 (ceil, não round)
  IF NOT FOUND THEN RAISE EXCEPTION 'B2 FALHOU: 8002 DEPOIS != 11 (ceil de 10,6)'; END IF;
  PERFORM 1 FROM scratch_depois WHERE sku='8003' AND qtde_final=8 AND qtde_sugerida=5;     -- min8 vence nat4,5; sugerida ceil(4,5)=5
  IF NOT FOUND THEN RAISE EXCEPTION 'B2 FALHOU: 8003 DEPOIS (final=8, sugerida=5)'; END IF;
  PERFORM 1 FROM scratch_depois WHERE sku='8004' AND qtde_final=8;                         -- ceil(GREATEST(4,5; 7,5))=ceil(7,5)=8
  IF NOT FOUND THEN RAISE EXCEPTION 'B2 FALHOU: 8004 DEPOIS != 8 (ceil do min forçado 7,5)'; END IF;
  PERFORM 1 FROM scratch_depois WHERE sku='8005' AND qtde_final=10 AND qtde_sugerida=10;   -- inteiro exato: ceil no-op
  IF NOT FOUND THEN RAISE EXCEPTION 'B2 FALHOU: 8005 DEPOIS != 10 (ceil de inteiro deve ser no-op)'; END IF;
  PERFORM 1 FROM scratch_depois WHERE sku='8007' AND qtde_final=1;                         -- poeira 0,00004 → ceil 1
  IF NOT FOUND THEN RAISE EXCEPTION 'B2 FALHOU: 8007 DEPOIS != 1 (ceil de 0,00004)'; END IF;
  RAISE NOTICE 'OK B2 — casos: 8001→10, 8002→11(ceil≠round), 8003(min8/sug5), 8004→8(ceil min frac), 8005=10(no-op), 8007→1';

  -- C. [Q5] CONJUNTO de itens IDÊNTICO antes/depois (ceil só muda valor, não inclusão).
  --     8006 (natural 0) excluído em AMBOS; 8007 (0,00004) incluído em AMBOS.
  SELECT count(*) INTO d FROM (
    (SELECT sku FROM scratch_antes EXCEPT SELECT sku FROM scratch_depois)
    UNION ALL
    (SELECT sku FROM scratch_depois EXCEPT SELECT sku FROM scratch_antes)
  ) x;
  IF d <> 0 THEN RAISE EXCEPTION 'C FALHOU: conjunto de itens MUDOU (% SKU divergente) — ceil não pode mudar inclusão', d; END IF;
  PERFORM 1 FROM scratch_antes WHERE sku='8006'; IF FOUND THEN RAISE EXCEPTION 'C FALHOU: 8006 (nat 0) não devia entrar ANTES'; END IF;
  PERFORM 1 FROM scratch_depois WHERE sku='8006'; IF FOUND THEN RAISE EXCEPTION 'C FALHOU: 8006 (nat 0) não devia entrar DEPOIS'; END IF;
  PERFORM 1 FROM scratch_antes WHERE sku='8007'; IF NOT FOUND THEN RAISE EXCEPTION 'C FALHOU: 8007 (0,00004) devia entrar ANTES'; END IF;
  PERFORM 1 FROM scratch_depois WHERE sku='8007'; IF NOT FOUND THEN RAISE EXCEPTION 'C FALHOU: 8007 devia entrar DEPOIS'; END IF;
  RAISE NOTICE 'OK C [Q5] — conjunto idêntico (6 itens; 8006 fora dos dois; 8007 dentro dos dois)';

  -- D. valor_linha DEPOIS = qtde_final(inteira) × cmc(10); valor_total do header = Σ valor_linha.
  SELECT count(*) INTO d FROM scratch_depois WHERE valor_linha <> qtde_final * 10;
  IF d <> 0 THEN RAISE EXCEPTION 'D FALHOU: % valor_linha != qtde_final*cmc', d; END IF;
  SELECT count(*) INTO d FROM (
    SELECT pcs.id FROM pedido_compra_sugerido pcs JOIN pedido_compra_item pci ON pci.pedido_id=pcs.id
    WHERE pcs.data_ciclo=CURRENT_DATE AND pcs.status='pendente_aprovacao'
    GROUP BY pcs.id, pcs.valor_total HAVING pcs.valor_total IS DISTINCT FROM sum(pci.valor_linha)
  ) x;
  IF d <> 0 THEN RAISE EXCEPTION 'D FALHOU: % header(s) com valor_total != Σ valor_linha', d; END IF;
  RAISE NOTICE 'OK D — valor_linha = qtde_final×cmc; valor_total = Σ valor_linha';

  -- E. retorno da RPC DEPOIS == agregado persistido; bloqueados=0.
  DECLARE rped int; rskus int; rval numeric; bloq int; aped int; askus int; aval numeric;
  BEGIN
    SELECT pedidos, skus, valor, bloqueados INTO rped, rskus, rval, bloq FROM scratch_ret WHERE fase='depois';
    SELECT count(*), COALESCE(sum(num_skus),0), COALESCE(sum(valor_total),0) INTO aped, askus, aval
      FROM pedido_compra_sugerido WHERE empresa='OBEN' AND data_ciclo=CURRENT_DATE AND status='pendente_aprovacao';
    IF bloq <> 0 THEN RAISE EXCEPTION 'E FALHOU: bloqueados=% (esperado 0)', bloq; END IF;
    IF rped<>aped OR rskus<>askus OR rval IS DISTINCT FROM aval THEN
      RAISE EXCEPTION 'E FALHOU: retorno(%,%,%) <> persistido(%,%,%)', rped,rskus,rval, aped,askus,aval; END IF;
  END;
  RAISE NOTICE 'OK E — retorno da RPC == persistido; bloqueados=0';

  -- F. GUARD anti-drift: a função DEPOIS preservou TODAS as guardas da base (não dropei nada ao editar).
  fdef := pg_get_functiondef('public.gerar_pedidos_sugeridos_ciclo(text,date)'::regprocedure);
  IF fdef NOT LIKE '%tipo_produto_unhealthy%'        THEN RAISE EXCEPTION 'F FALHOU: perdeu fail-closed tipo_produto'; END IF;
  IF fdef NOT LIKE '%op.account = lower(p_empresa)%'  THEN RAISE EXCEPTION 'F FALHOU: perdeu account-aware'; END IF;
  IF fdef NOT LIKE '%405ML%' OR fdef NOT LIKE '%450ML%' THEN RAISE EXCEPTION 'F FALHOU: perdeu exclusão 405/450ML'; END IF;
  IF fdef NOT LIKE '%btrim(sp.fornecedor_nome)%'      THEN RAISE EXCEPTION 'F FALHOU: perdeu guarda fornecedor NOT NULL/vazio'; END IF;
  IF fdef NOT LIKE '%<= sp.ponto_pedido%'             THEN RAISE EXCEPTION 'F FALHOU: perdeu gate de necessidade estoque<=ponto_pedido'; END IF;
  IF fdef NOT LIKE '%minimo_forcado_manual%'          THEN RAISE EXCEPTION 'F FALHOU: perdeu mínimo forçado'; END IF;
  -- e os 3 ceil entraram (qtde_sugerida + os 2 do qtde_final)
  d := (length(fdef) - length(replace(lower(fdef),'ceil(',''))) / length('ceil(');
  IF d <> 3 THEN RAISE EXCEPTION 'F FALHOU: esperava 3 ceil( na função, achei %', d; END IF;
  RAISE NOTICE 'OK F — todas as guardas preservadas + exatamente 3 ceil( na função';

  RAISE NOTICE '──────── TODOS OS ASSERTS SQL OK ────────';
END $$;
SELECT 'ASSERTS SQL PASSARAM ✓' AS resultado;
SQL

echo ""
echo "✓ db/test-qtde-inteira.sh — PASSOU"
