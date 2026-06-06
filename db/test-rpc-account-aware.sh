#!/usr/bin/env bash
# Teste PG17 da Frente C — JOIN omie_products account-aware na RPC gerar_pedidos_sugeridos_ciclo.
# Aplica schema-snapshot + foundation (omie_products.tipo_produto) + 20260604190000 (frente B,
# RPC account-BLIND como base), semeia 15 cenários, roda a RPC ANTES (blind), aplica a migration C
# (account-AWARE), roda DEPOIS, e asserta a matriz antes/depois + invariantes (multiset exato,
# unicidade no ciclo, num_skus, valor_total, retorno da RPC, neutralidade) + diff mecânico (1 linha).
# Base: db/verify-snapshot-replay.sh. Pré-req: brew install postgresql@17 pgvector.
# Achados do Codex incorporados: 3002 (anti-hardcode 'oben'), ativo inserido direto (trigger de
# inativação mexe em sku_parametros sem filtrar account), scratch NÃO-TEMP (somem entre sessões),
# códigos numéricos (bigint), familia_nao_comprada.motivo NOT NULL, EXCEPT ALL nas 2 direções.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PGVER=17
PGBIN="/opt/homebrew/opt/postgresql@${PGVER}/bin"
PORT=5435
DATA="$(mktemp -d /tmp/pgtest-acctaware.XXXXXX)/data"
export LC_ALL=C LANG=C

[ -x "$PGBIN/initdb" ] || { echo "postgresql@${PGVER} ausente: brew install postgresql@${PGVER} pgvector"; exit 1; }

CELLAR="$(brew --prefix postgresql@${PGVER})"
cp -Rn "$CELLAR"/share/postgresql/. "/opt/homebrew/share/postgresql@${PGVER}/" 2>/dev/null || true
mkdir -p "/opt/homebrew/lib/postgresql@${PGVER}"
cp -Rn "$CELLAR"/lib/postgresql/. "/opt/homebrew/lib/postgresql@${PGVER}/" 2>/dev/null || true

cleanup() { "$PGBIN/pg_ctl" -D "$DATA" stop -m immediate >/dev/null 2>&1 || true; rm -rf "$(dirname "$DATA")"; }
trap cleanup EXIT

"$PGBIN/initdb" -D "$DATA" -U postgres -E UTF8 --locale=C >/dev/null
"$PGBIN/pg_ctl" -D "$DATA" -o "-p $PORT -k /tmp" -l /tmp/pg-acctaware.log -w start >/dev/null
"$PGBIN/createdb" -p "$PORT" -h /tmp -U postgres acctaware_verify
P() { "$PGBIN/psql" -p "$PORT" -h /tmp -U postgres -d acctaware_verify "$@"; }

RR="$(mktemp /tmp/snap-acctaware.XXXXXX.sql)"
sed -E 's/^(CREATE SCHEMA public;)/-- \1/' "$REPO_ROOT/supabase/schema-snapshot.sql" \
  | grep -vE '^\\(un)?restrict ' > "$RR"

echo "→ stubs + prelude + snapshot…"
P -v ON_ERROR_STOP=1 -q -f "$REPO_ROOT/db/stubs-supabase.sql"
P -v ON_ERROR_STOP=1 -q -f "$REPO_ROOT/supabase/schema-extensions-prelude.sql"
P --single-transaction -v ON_ERROR_STOP=1 -q -f "$RR"
rm -f "$RR"

echo "→ foundation (omie_products.tipo_produto — stale no snapshot)…"
P -v ON_ERROR_STOP=1 -q -c "ALTER TABLE public.omie_products ADD COLUMN IF NOT EXISTS tipo_produto text;"

echo "→ base: 20260604190000 (frente B — RPC account-BLIND)…"
P -v ON_ERROR_STOP=1 -q -f "$REPO_ROOT/supabase/migrations/20260604190000_reposicao_minimo_forcado.sql" >/dev/null

echo "→ seed dos 15 cenários + tabelas scratch (NÃO-TEMP, persistem entre sessões psql)…"
P -v ON_ERROR_STOP=1 -q <<'SQL'
-- omie_products: codigo+descricao NOT NULL; account lowercase; ativo INSERIDO DIRETO
-- (NÃO fazer UPDATE depois — trigger de inativação altera sku_parametros sem filtrar account).
INSERT INTO public.omie_products (omie_codigo_produto, codigo, descricao, account, ativo, familia, tipo_produto) VALUES
  (2001,'2001','PROD 2001','oben',   true, 'F1','00'),  (2001,'2001','PROD 2001','colacor',true, 'F1','00'),  -- ambos válidos
  (2002,'2002','PROD 2002','oben',   false,'F1','00'),  (2002,'2002','PROD 2002','colacor',true, 'F1','00'),  -- oben inativo
  (2003,'2003','PROD 2003 405ML','oben',true,'F1','00'),(2003,'2003','PROD 2003','colacor',true, 'F1','00'), -- oben 405ML
  (2004,'2004','PROD 2004','oben',   true, 'FAM-BLOQ','00'),(2004,'2004','PROD 2004','colacor',true,'FAM-OK','00'), -- familia oben bloqueada
  (2051,'2051','PROD 2051','colacor',false,'F1','00'),  -- sem oben; colacor inativa
  (2052,'2052','PROD 2052 405ML','colacor',true,'F1','00'), -- sem oben; colacor 405ML
  (2053,'2053','PROD 2053','colacor',true, 'FAM-BLOQ','00'),-- sem oben; familia (OBEN) bloqueada
  -- 2006: NENHUMA linha omie_products (fail-open antes e depois)
  (2007,'2007','PROD 2007','oben',   true, 'F1','04'),  (2007,'2007','PROD 2007','colacor',true, 'F1','00'),  -- oben '04' (guarda exclui)
  (2008,'2008','PROD 2008','oben',   true, 'F1','00'),  (2008,'2008','PROD 2008','colacor',true, 'F1','04'),  -- oben '00', estrangeira '04'
  (9001,'9001','PROD 9001','oben',   true, 'F1','00'),  -- neutros: só oben (espelho dos 292)
  (9002,'9002','PROD 9002','oben',   true, 'F1','00'),
  (9003,'9003','PROD 9003','oben',   true, 'F1','00'),
  (3001,'3001','PROD 3001','colacor',true, 'F1','00'),  (3001,'3001','PROD 3001','oben',   true, 'F1','00'),  -- COLACOR: ambos válidos
  (3002,'3002','PROD 3002','colacor',true, 'F1','00'),  (3002,'3002','PROD 3002','oben',   false,'F1','00');  -- COLACOR válida, oben inativa (anti-hardcode 'oben')

-- sku_parametros: empresa uppercase, fornecedor próprio por SKU (isola headers), pp=100/emax=100
-- (→ qtde natural = 100-90 = 10), habilitado+automatica, minimo NULL.
INSERT INTO public.sku_parametros
  (empresa, sku_codigo_omie, sku_descricao, fornecedor_nome, ponto_pedido, estoque_maximo,
   habilitado_reposicao_automatica, tipo_reposicao, minimo_forcado_manual, ativo) VALUES
  ('OBEN',2001,'SKU 2001','FORN-2001',100,100,true,'automatica',NULL,true),
  ('OBEN',2002,'SKU 2002','FORN-2002',100,100,true,'automatica',NULL,true),
  ('OBEN',2003,'SKU 2003','FORN-2003',100,100,true,'automatica',NULL,true),
  ('OBEN',2004,'SKU 2004','FORN-2004',100,100,true,'automatica',NULL,true),
  ('OBEN',2051,'SKU 2051','FORN-2051',100,100,true,'automatica',NULL,true),
  ('OBEN',2052,'SKU 2052','FORN-2052',100,100,true,'automatica',NULL,true),
  ('OBEN',2053,'SKU 2053','FORN-2053',100,100,true,'automatica',NULL,true),
  ('OBEN',2006,'SKU 2006','FORN-2006',100,100,true,'automatica',NULL,true),
  ('OBEN',2007,'SKU 2007','FORN-2007',100,100,true,'automatica',NULL,true),
  ('OBEN',2008,'SKU 2008','FORN-2008',100,100,true,'automatica',NULL,true),
  ('OBEN',9001,'SKU 9001','FORN-9001',100,100,true,'automatica',NULL,true),
  ('OBEN',9002,'SKU 9002','FORN-9002',100,100,true,'automatica',NULL,true),
  ('OBEN',9003,'SKU 9003','FORN-9003',100,100,true,'automatica',NULL,true),
  ('COLACOR',3001,'SKU 3001','FORN-3001',100,100,true,'automatica',NULL,true),
  ('COLACOR',3002,'SKU 3002','FORN-3002',100,100,true,'automatica',NULL,true);

-- estoque: fisico 90 <= pp 100 → precisa; natural = emax 100 - 90 = 10.
INSERT INTO public.sku_estoque_atual (empresa, sku_codigo_omie, estoque_fisico, estoque_pendente_entrada)
SELECT empresa, sku_codigo_omie::text, 90, 0 FROM public.sku_parametros;

-- preço determinístico via inventory_position.cmc (account = empresa que roda).
INSERT INTO public.inventory_position (omie_codigo_produto, account, cmc)
SELECT sku_codigo_omie, lower(empresa), 10 FROM public.sku_parametros;

-- familia bloqueada (OBEN). motivo é NOT NULL.
INSERT INTO public.familia_nao_comprada (empresa, familia, motivo) VALUES ('OBEN','FAM-BLOQ','teste account-aware');

-- ── tabelas scratch (NORMAIS — sobrevivem entre as sessões psql separadas) ──
CREATE TABLE scratch_antes  (empresa text, data_ciclo date, pedido_id bigint, num_skus int, valor_total numeric, sku_codigo_omie text, qtde_final numeric, valor_linha numeric);
CREATE TABLE scratch_depois (LIKE scratch_antes);
CREATE TABLE scratch_ret    (fase text, empresa text, pedidos_gerados int, skus_incluidos int, valor_total_ciclo numeric, bloqueados int);

-- matriz esperada (contagem de itens por SKU, antes account-blind / depois account-aware).
CREATE TABLE esperado_cnt (sku text, empresa text, n_antes int, n_depois int);
INSERT INTO esperado_cnt VALUES
  ('2001','OBEN',2,1),('2002','OBEN',1,0),('2003','OBEN',1,0),('2004','OBEN',1,0),
  ('2051','OBEN',0,1),('2052','OBEN',0,1),('2053','OBEN',0,1),('2006','OBEN',1,1),
  ('2007','OBEN',0,0),('2008','OBEN',2,1),('9001','OBEN',1,1),('9002','OBEN',1,1),('9003','OBEN',1,1),
  ('3001','COLACOR',2,1),('3002','COLACOR',1,1);

-- multiset exato esperado DEPOIS (só os que entram; qtde_final=10, valor_linha=10*cmc=100).
CREATE TABLE esperado_depois (empresa text, sku text, qtde_final numeric, valor_linha numeric);
INSERT INTO esperado_depois VALUES
  ('OBEN','2001',10,100),('OBEN','2051',10,100),('OBEN','2052',10,100),('OBEN','2053',10,100),
  ('OBEN','2006',10,100),('OBEN','2008',10,100),('OBEN','9001',10,100),('OBEN','9002',10,100),('OBEN','9003',10,100),
  ('COLACOR','3001',10,100),('COLACOR','3002',10,100);
SQL

echo "→ RODA ANTES (account-blind, frente B) p/ OBEN e COLACOR…"
P -v ON_ERROR_STOP=1 -q <<'SQL'
INSERT INTO scratch_ret SELECT 'antes','OBEN',    g.* FROM public.gerar_pedidos_sugeridos_ciclo('OBEN',    CURRENT_DATE) g;
INSERT INTO scratch_ret SELECT 'antes','COLACOR', g.* FROM public.gerar_pedidos_sugeridos_ciclo('COLACOR', CURRENT_DATE) g;
INSERT INTO scratch_antes
  SELECT pcs.empresa, pcs.data_ciclo, pcs.id, pcs.num_skus, pcs.valor_total,
         pci.sku_codigo_omie, pci.qtde_final, pci.valor_linha
  FROM pedido_compra_item pci JOIN pedido_compra_sugerido pcs ON pcs.id = pci.pedido_id
  WHERE pcs.data_ciclo = CURRENT_DATE AND pcs.status = 'pendente_aprovacao';
SQL

echo "→ aplica a migration C (account-AWARE): 20260606120000_reposicao_rpc_account_aware.sql…"
P -v ON_ERROR_STOP=1 -q -f "$REPO_ROOT/supabase/migrations/20260606120000_reposicao_rpc_account_aware.sql" >/dev/null

echo "→ RODA DEPOIS (account-aware) p/ OBEN e COLACOR (a RPC limpa os pendentes do ciclo e regenera)…"
P -v ON_ERROR_STOP=1 -q <<'SQL'
INSERT INTO scratch_ret SELECT 'depois','OBEN',    g.* FROM public.gerar_pedidos_sugeridos_ciclo('OBEN',    CURRENT_DATE) g;
INSERT INTO scratch_ret SELECT 'depois','COLACOR', g.* FROM public.gerar_pedidos_sugeridos_ciclo('COLACOR', CURRENT_DATE) g;
INSERT INTO scratch_depois
  SELECT pcs.empresa, pcs.data_ciclo, pcs.id, pcs.num_skus, pcs.valor_total,
         pci.sku_codigo_omie, pci.qtde_final, pci.valor_linha
  FROM pedido_compra_item pci JOIN pedido_compra_sugerido pcs ON pcs.id = pci.pedido_id
  WHERE pcs.data_ciclo = CURRENT_DATE AND pcs.status = 'pendente_aprovacao';
SQL

echo ""
echo "→ ASSERTS:"
P -v ON_ERROR_STOP=1 -q <<'SQL'
DO $$
DECLARE r RECORD; d int;
BEGIN
  -- A. MATRIZ antes (account-blind: prova multi-match/exclusão pela linha errada)
  FOR r IN SELECT * FROM esperado_cnt LOOP
    SELECT count(*) INTO d FROM scratch_antes WHERE sku_codigo_omie = r.sku AND empresa = r.empresa;
    IF d <> r.n_antes THEN RAISE EXCEPTION 'ANTES % (%): % itens, esperado %', r.sku, r.empresa, d, r.n_antes; END IF;
  END LOOP;
  RAISE NOTICE 'OK A — matriz ANTES (account-blind) bate (multi-match 2001/2008/3001=2; exclusão linha-errada)';

  -- B. MATRIZ depois (account-aware)
  FOR r IN SELECT * FROM esperado_cnt LOOP
    SELECT count(*) INTO d FROM scratch_depois WHERE sku_codigo_omie = r.sku AND empresa = r.empresa;
    IF d <> r.n_depois THEN RAISE EXCEPTION 'DEPOIS % (%): % itens, esperado %', r.sku, r.empresa, d, r.n_depois; END IF;
  END LOOP;
  RAISE NOTICE 'OK B — matriz DEPOIS (account-aware) bate (multi-match→1; fail-open 2051/2052/2053→1; 3002 mata hardcode oben)';

  -- C. MULTISET exato depois (EXCEPT ALL nas 2 direções) — pega item extra OU faltante OU valor errado
  SELECT count(*) INTO d FROM (
    (SELECT empresa,sku,qtde_final,valor_linha FROM esperado_depois
       EXCEPT ALL SELECT empresa,sku_codigo_omie,qtde_final,valor_linha FROM scratch_depois)
    UNION ALL
    (SELECT empresa,sku_codigo_omie,qtde_final,valor_linha FROM scratch_depois
       EXCEPT ALL SELECT empresa,sku,qtde_final,valor_linha FROM esperado_depois)
  ) x;
  IF d <> 0 THEN RAISE EXCEPTION 'C FALHOU: multiset DEPOIS diverge em % linha(s)', d; END IF;
  RAISE NOTICE 'OK C — multiset DEPOIS (empresa,sku,qtde_final,valor_linha) exato';

  -- D. UNICIDADE no ciclo: nenhum (empresa,data_ciclo,sku) com >1 item depois
  SELECT count(*) INTO d FROM (
    SELECT empresa, data_ciclo, sku_codigo_omie FROM scratch_depois
    GROUP BY 1,2,3 HAVING count(*) > 1) x;
  IF d <> 0 THEN RAISE EXCEPTION 'D FALHOU: % SKU(s) duplicado(s) no ciclo depois', d; END IF;
  RAISE NOTICE 'OK D — zero duplicação por (empresa,data_ciclo,sku)';

  -- E. HEADER depois: num_skus = count(*) itens = count(distinct sku); valor_total = sum(valor_linha); sem header vazio
  SELECT count(*) INTO d FROM (
    SELECT pcs.id, pcs.num_skus, pcs.valor_total,
           count(pci.*) AS n_itens, count(DISTINCT pci.sku_codigo_omie) AS n_dist, COALESCE(sum(pci.valor_linha),0) AS soma
    FROM pedido_compra_sugerido pcs LEFT JOIN pedido_compra_item pci ON pci.pedido_id = pcs.id
    WHERE pcs.data_ciclo = CURRENT_DATE AND pcs.status='pendente_aprovacao'
    GROUP BY pcs.id, pcs.num_skus, pcs.valor_total
    HAVING pcs.num_skus <> count(pci.*)
        OR pcs.num_skus <> count(DISTINCT pci.sku_codigo_omie)
        OR pcs.valor_total IS DISTINCT FROM COALESCE(sum(pci.valor_linha),0)
        OR count(pci.*) = 0
  ) x;
  IF d <> 0 THEN RAISE EXCEPTION 'E FALHOU: % header(s) com num_skus/valor_total inconsistente ou vazio', d; END IF;
  RAISE NOTICE 'OK E — headers: num_skus=itens=distinct(sku), valor_total=sum(valor_linha), sem header vazio';

  -- F. RETORNO da RPC depois == agregado persistido (pedidos/skus/valor) + bloqueados=0
  FOR r IN SELECT empresa FROM (VALUES ('OBEN'),('COLACOR')) v(empresa) LOOP
    DECLARE ped int; skus int; val numeric; bloq int; rped int; rskus int; rval numeric;
    BEGIN
      SELECT pedidos_gerados, skus_incluidos, valor_total_ciclo, bloqueados
        INTO ped, skus, val, bloq FROM scratch_ret WHERE fase='depois' AND empresa=r.empresa;
      SELECT count(*), COALESCE(sum(num_skus),0), COALESCE(sum(valor_total),0)
        INTO rped, rskus, rval FROM pedido_compra_sugerido
        WHERE empresa=r.empresa AND data_ciclo=CURRENT_DATE AND status='pendente_aprovacao';
      IF bloq <> 0 THEN RAISE EXCEPTION 'F FALHOU: % bloqueados=% (esperado 0)', r.empresa, bloq; END IF;
      IF ped<>rped OR skus<>rskus OR val IS DISTINCT FROM rval THEN
        RAISE EXCEPTION 'F FALHOU: % retorno(ped=%,skus=%,val=%) <> persistido(%,%,%)', r.empresa, ped,skus,val, rped,rskus,rval; END IF;
    END;
  END LOOP;
  RAISE NOTICE 'OK F — retorno da RPC == agregado persistido; bloqueados=0';

  -- G. NEUTRALIDADE: os neutros (só oben, espelho dos 292) — rowset antes == depois
  SELECT count(*) INTO d FROM (
    (SELECT empresa,sku_codigo_omie,qtde_final,valor_linha FROM scratch_antes  WHERE sku_codigo_omie IN ('9001','9002','9003')
       EXCEPT ALL
     SELECT empresa,sku_codigo_omie,qtde_final,valor_linha FROM scratch_depois WHERE sku_codigo_omie IN ('9001','9002','9003'))
    UNION ALL
    (SELECT empresa,sku_codigo_omie,qtde_final,valor_linha FROM scratch_depois WHERE sku_codigo_omie IN ('9001','9002','9003')
       EXCEPT ALL
     SELECT empresa,sku_codigo_omie,qtde_final,valor_linha FROM scratch_antes  WHERE sku_codigo_omie IN ('9001','9002','9003'))
  ) x;
  IF d <> 0 THEN RAISE EXCEPTION 'G FALHOU: neutralidade quebrada (antes<>depois) em % linha(s)', d; END IF;
  RAISE NOTICE 'OK G — neutralidade: SKUs sem colisão idênticos antes/depois (fix não muda o estado dos 292)';

  RAISE NOTICE '──────── TODOS OS ASSERTS SQL OK ────────';
END $$;
SELECT 'ASSERTS SQL PASSARAM ✓' AS resultado;
SQL

echo ""
echo "→ DIFF MECÂNICO (prova que o corpo muda em EXATAMENTE a cláusula account-aware):"
# Extrai o bloco da função das duas migrations.
awk '/^CREATE OR REPLACE FUNCTION public\.gerar_pedidos_sugeridos_ciclo/,/^\$function\$;$/' \
  "$REPO_ROOT/supabase/migrations/20260604190000_reposicao_minimo_forcado.sql" > /tmp/aa-funcB.sql
awk '/^CREATE OR REPLACE FUNCTION public\.gerar_pedidos_sugeridos_ciclo/,/^\$function\$;$/' \
  "$REPO_ROOT/supabase/migrations/20260606120000_reposicao_rpc_account_aware.sql" > /tmp/aa-funcC.sql
N=$(grep -c '^      AND op.account = lower(p_empresa)$' /tmp/aa-funcC.sql)
[ "$N" = "1" ] || { echo "✗ cláusula aparece $N vezes (esperado 1)"; exit 1; }
# A cláusula deve vir imediatamente APÓS a linha do JOIN omie_products.
grep -A1 '^    LEFT JOIN omie_products op ON op.omie_codigo_produto::text = sp.sku_codigo_omie::text$' /tmp/aa-funcC.sql \
  | grep -q '^      AND op.account = lower(p_empresa)$' || { echo "✗ cláusula não está logo após o JOIN"; exit 1; }
# Remove APENAS essa linha de C e compara com B byte-a-byte → devem ser idênticos.
grep -v '^      AND op.account = lower(p_empresa)$' /tmp/aa-funcC.sql > /tmp/aa-funcC-stripped.sql
if cmp -s /tmp/aa-funcB.sql /tmp/aa-funcC-stripped.sql; then
  echo "✓ corpo de C == corpo de B + exatamente a cláusula 'AND op.account = lower(p_empresa)' (cmp idêntico)"
else
  echo "✗ DIFF MECÂNICO FALHOU: C menos a cláusula difere de B:"; diff -u /tmp/aa-funcB.sql /tmp/aa-funcC-stripped.sql | head -40; exit 1
fi
rm -f /tmp/aa-funcB.sql /tmp/aa-funcC.sql /tmp/aa-funcC-stripped.sql

echo ""
echo "✓ db/test-rpc-account-aware.sh — PASSOU"
