#!/usr/bin/env bash
# Teste PG17 — reposicao_persistir_qtde_inteira + backfill (migration 20260606190000).
# Prova:
#  - Backfill ceila itens fracionários de pedidos NÃO-disparados + recalcula valor_linha/valor_total.
#  - NÃO toca pedidos disparado/concluído/cancelado (escopo do backfill).
#  - PRESERVA valor_linha em linha JÁ inteira (= total capturado do portal não é clobberado).
#  - ceil (não round): 10,6 → 11.
#  - Função idempotente (2ª chamada retorna 0 ajustes).
#  - Conjunto/relacionamento intacto; validação da migração (frac_restantes_nao_disparados=0).
# Base: db/verify-snapshot-replay.sh + db/test-rpc-account-aware.sh. Pré-req: brew install postgresql@17 pgvector.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PGVER=17
PGBIN="/opt/homebrew/opt/postgresql@${PGVER}/bin"
PORT=5437
DATA="$(mktemp -d /tmp/pgtest-qtdepersist.XXXXXX)/data"
export LC_ALL=C LANG=C

[ -x "$PGBIN/initdb" ] || { echo "postgresql@${PGVER} ausente: brew install postgresql@${PGVER} pgvector"; exit 1; }

CELLAR="$(brew --prefix postgresql@${PGVER})"
cp -Rn "$CELLAR"/share/postgresql/. "/opt/homebrew/share/postgresql@${PGVER}/" 2>/dev/null || true
mkdir -p "/opt/homebrew/lib/postgresql@${PGVER}"
cp -Rn "$CELLAR"/lib/postgresql/. "/opt/homebrew/lib/postgresql@${PGVER}/" 2>/dev/null || true

cleanup() { "$PGBIN/pg_ctl" -D "$DATA" stop -m immediate >/dev/null 2>&1 || true; rm -rf "$(dirname "$DATA")"; }
trap cleanup EXIT

"$PGBIN/initdb" -D "$DATA" -U postgres -E UTF8 --locale=C >/dev/null
"$PGBIN/pg_ctl" -D "$DATA" -o "-p $PORT -k /tmp" -l /tmp/pg-qtdepersist.log -w start >/dev/null
"$PGBIN/createdb" -p "$PORT" -h /tmp -U postgres qtdepersist_verify
P() { "$PGBIN/psql" -p "$PORT" -h /tmp -U postgres -d qtdepersist_verify "$@"; }

RR="$(mktemp /tmp/snap-qtdepersist.XXXXXX.sql)"
sed -E 's/^(CREATE SCHEMA public;)/-- \1/' "$REPO_ROOT/supabase/schema-snapshot.sql" \
  | grep -vE '^\\(un)?restrict ' > "$RR"

echo "→ stubs + prelude + snapshot…"
P -v ON_ERROR_STOP=1 -q -f "$REPO_ROOT/db/stubs-supabase.sql"
P -v ON_ERROR_STOP=1 -q -f "$REPO_ROOT/supabase/schema-extensions-prelude.sql"
P --single-transaction -v ON_ERROR_STOP=1 -q -f "$RR"
rm -f "$RR"
# service_role precisa existir p/ o GRANT da migração não falhar no replay isolado.
P -v ON_ERROR_STOP=1 -q -c "DO \$\$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN CREATE ROLE service_role; END IF; END \$\$;"

echo "→ seed: pedidos com itens fracionários em vários status (ANTES da migração)…"
P -v ON_ERROR_STOP=1 -q <<'SQL'
-- P1 NÃO-disparado (pendente): 2 itens fracionários → backfill ceila
INSERT INTO public.pedido_compra_sugerido (id, empresa, fornecedor_nome, status, valor_total)
  VALUES (90001,'OBEN','FORN-A','pendente_aprovacao', 0);
INSERT INTO public.pedido_compra_item (pedido_id, sku_codigo_omie, qtde_sugerida, qtde_final, preco_unitario, valor_linha) VALUES
  (90001,'8001', 9.99996, 9.99996, 10, 99.9996),  -- → 10, valor 100
  (90001,'8002', 10.4,    10.4,    20, 208.0);     -- → 11 (ceil; round daria 10), valor 220
UPDATE public.pedido_compra_sugerido SET valor_total = 307.9996 WHERE id=90001; -- soma crua (será recomputada)

-- P2 DISPARADO: fracionário + valor_linha "capturado" do portal (≠ qty×preco) → backfill NÃO toca
INSERT INTO public.pedido_compra_sugerido (id, empresa, fornecedor_nome, status, valor_total)
  VALUES (90002,'OBEN','FORN-B','disparado', 999);
INSERT INTO public.pedido_compra_item (pedido_id, sku_codigo_omie, qtde_sugerida, qtde_final, preco_unitario, valor_linha) VALUES
  (90002,'8003', 5.5, 5.5, 30, 999);  -- intocado (status fora do escopo)

-- P3 NÃO-disparado (aprovado_aguardando_disparo): item JÁ INTEIRO com valor_linha capturado 777
--    (≠ 5×preco) → função pula (qty já inteira) → 777 PRESERVADO; valor_total NÃO recomputado
INSERT INTO public.pedido_compra_sugerido (id, empresa, fornecedor_nome, status, valor_total)
  VALUES (90003,'OBEN','FORN-C','aprovado_aguardando_disparo', 777);
INSERT INTO public.pedido_compra_item (pedido_id, sku_codigo_omie, qtde_sugerida, qtde_final, preco_unitario, valor_linha) VALUES
  (90003,'8004', 5, 5, 100, 777);  -- captured total preservado

-- P4 CANCELADO: fracionário → terminal, intocado
INSERT INTO public.pedido_compra_sugerido (id, empresa, fornecedor_nome, status, valor_total)
  VALUES (90004,'OBEN','FORN-D','cancelado', 50);
INSERT INTO public.pedido_compra_item (pedido_id, sku_codigo_omie, qtde_sugerida, qtde_final, preco_unitario, valor_linha) VALUES
  (90004,'8005', 2.3, 2.3, 25, 57.5);
SQL

echo "→ aplica a migração 20260606190000 (cria função + roda backfill)…"
P -v ON_ERROR_STOP=1 -f "$REPO_ROOT/supabase/migrations/20260606190000_reposicao_qtde_inteira_persist.sql"

echo ""
echo "→ ASSERTS:"
P -v ON_ERROR_STOP=1 -q <<'SQL'
DO $$
DECLARE n int;
BEGIN
  -- A. P1 (não-disparado): itens ceilados + valor_linha = ceil(qty)×preco
  PERFORM 1 FROM pedido_compra_item WHERE pedido_id=90001 AND sku_codigo_omie='8001'
    AND qtde_final=10 AND qtde_sugerida=10 AND valor_linha=100;
  IF NOT FOUND THEN RAISE EXCEPTION 'A FALHOU: 8001 não virou 10 / valor 100'; END IF;
  PERFORM 1 FROM pedido_compra_item WHERE pedido_id=90001 AND sku_codigo_omie='8002'
    AND qtde_final=11 AND valor_linha=220;  -- ceil(10,4)=11 (round daria 10) → prova ceil, não round
  IF NOT FOUND THEN RAISE EXCEPTION 'A FALHOU: 8002 não virou 11 (ceil de 10,4) / valor 220'; END IF;
  RAISE NOTICE 'OK A — P1 itens ceilados + valor_linha recalculado';

  -- A2. P1 valor_total recomputado = soma (100 + 220 = 320)
  PERFORM 1 FROM pedido_compra_sugerido WHERE id=90001 AND valor_total=320;
  IF NOT FOUND THEN RAISE EXCEPTION 'A2 FALHOU: P1 valor_total != 320 (= %)', (SELECT valor_total FROM pedido_compra_sugerido WHERE id=90001); END IF;
  RAISE NOTICE 'OK A2 — P1 valor_total recomputado = Σ valor_linha (320)';

  -- B. P2 (disparado): INTOCADO (qty 5,5; valor_linha capturado 999; valor_total 999)
  PERFORM 1 FROM pedido_compra_item WHERE pedido_id=90002 AND qtde_final=5.5 AND valor_linha=999;
  IF NOT FOUND THEN RAISE EXCEPTION 'B FALHOU: P2 disparado foi alterado (devia ficar 5,5 / 999)'; END IF;
  PERFORM 1 FROM pedido_compra_sugerido WHERE id=90002 AND valor_total=999;
  IF NOT FOUND THEN RAISE EXCEPTION 'B FALHOU: P2 valor_total mudou'; END IF;
  RAISE NOTICE 'OK B — P2 (disparado) intocado pelo backfill (escopo correto)';

  -- C. P3 (não-disparado, item JÁ inteiro): valor_linha capturado 777 PRESERVADO; qty 5; total 777
  PERFORM 1 FROM pedido_compra_item WHERE pedido_id=90003 AND qtde_final=5 AND valor_linha=777;
  IF NOT FOUND THEN RAISE EXCEPTION 'C FALHOU: P3 valor_linha capturado (777) foi clobberado! (= %)', (SELECT valor_linha FROM pedido_compra_item WHERE pedido_id=90003); END IF;
  PERFORM 1 FROM pedido_compra_sugerido WHERE id=90003 AND valor_total=777;
  IF NOT FOUND THEN RAISE EXCEPTION 'C FALHOU: P3 valor_total mudou (item inteiro não devia recomputar)'; END IF;
  RAISE NOTICE 'OK C — P3 item já inteiro: valor_linha capturado (777) PRESERVADO (não clobbera o total do portal)';

  -- D. P4 (cancelado): INTOCADO
  PERFORM 1 FROM pedido_compra_item WHERE pedido_id=90004 AND qtde_final=2.3;
  IF NOT FOUND THEN RAISE EXCEPTION 'D FALHOU: P4 cancelado foi alterado'; END IF;
  RAISE NOTICE 'OK D — P4 (cancelado) intocado';

  -- E. IDEMPOTÊNCIA: 2ª chamada em P1 retorna 0 ajustes
  SELECT public.reposicao_persistir_qtde_inteira(90001) INTO n;
  IF n <> 0 THEN RAISE EXCEPTION 'E FALHOU: 2ª chamada ajustou % (esperado 0 — não idempotente)', n; END IF;
  RAISE NOTICE 'OK E — função idempotente (2ª passada = 0 ajustes)';

  -- F. Função em pedido só-inteiro retorna 0 e não recomputa (P3 já provou preservação)
  SELECT public.reposicao_persistir_qtde_inteira(90003) INTO n;
  IF n <> 0 THEN RAISE EXCEPTION 'F FALHOU: P3 (já inteiro) ajustou % (esperado 0)', n; END IF;
  RAISE NOTICE 'OK F — pedido já inteiro → 0 ajustes (não toca valor_linha capturado)';

  RAISE NOTICE '──────── TODOS OS ASSERTS SQL OK ────────';
END $$;

-- G. validação embutida da migração (re-rodada): 0 fracionários nos não-disparados
SELECT 'frac_nao_disparados' AS check,
  (SELECT count(*) FROM pedido_compra_item pci JOIN pedido_compra_sugerido pcs ON pcs.id=pci.pedido_id
    WHERE pcs.status IN ('pendente_aprovacao','bloqueado_guardrail','aprovado_aguardando_disparo','falha_envio')
      AND (pci.qtde_final IS DISTINCT FROM ceil(pci.qtde_final) OR pci.qtde_sugerida IS DISTINCT FROM ceil(pci.qtde_sugerida))) AS n;
SQL

echo ""
echo "✓ db/test-qtde-inteira-persist.sh — PASSOU"
