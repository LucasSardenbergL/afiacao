#!/usr/bin/env bash
# ╔══════════════════════════════════════════════════════════════════════════════╗
# ║  PROVA PG17 — 20260717010000_preco_medio_leadtime_efetivo.sql                 ║
# ║      bash db/test-preco-medio-leadtime-efetivo.sh > /tmp/t.log 2>&1; echo $?  ║
# ║  (NÃO pipe pra tail — engole o exit≠0; §2 do CLAUDE.md.)                      ║
# ║                                                                               ║
# ║  O QUE ESTA PROVA COBRE                                                       ║
# ║  A CTE `preco_medio` do motor de compra passa a ler v_sku_leadtime_efetivo    ║
# ║  (1 obs por NFe) em vez de sku_leadtime_history (1 obs por LINHA). O teste é  ║
# ║  END-TO-END de propósito: roda gerar_pedidos_sugeridos_ciclo() de verdade e   ║
# ║  lê o preco_unitario que ela GRAVA em pedido_compra_item — não a CTE isolada. ║
# ║  Isso é o que pega o bug late-bound (plpgsql só falha ao EXECUTAR) e o que    ║
# ║  prova que a repontagem atravessa os dois consumidores (âncora + badge).      ║
# ║                                                                               ║
# ║  O CENÁRIO (é o defeito real, reproduzido)                                    ║
# ║  sku_leadtime_history tem UNIQUE(tracking_id, sku_codigo_omie) — logo N cópias ║
# ║  do mesmo item exigem N tracking_id distintos. É exatamente o que a Omie faz: ║
# ║  1 NFe que fatura N pedidos → a edge regrava o item sob o tracking de CADA    ║
# ║  pedido. As cópias compartilham a nfe_chave_acesso ⇒ a view colapsa por ela.  ║
# ║                                                                               ║
# ║  Lei de Ferro (skill prove-sql-money-path):                                   ║
# ║   1. Aplica a migration REAL (psql -f), não um stub da lógica.                ║
# ║   2. Assert negativo captura a SQLSTATE esperada e RE-LANÇA o resto.          ║
# ║   3. Falsificação obrigatória: sabota a migração → exija VERMELHO → restaura. ║
# ╚══════════════════════════════════════════════════════════════════════════════╝
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PGVER=17
PGBIN="/opt/homebrew/opt/postgresql@${PGVER}/bin"
PORT="${PGPORT_TEST:-5462}"     # distinto dos outros harnesses (worktrees em paralelo)
SLUG="preco-medio-lt-efetivo"
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
# ZONA 1 — PRÉ-REQUISITOS: snapshot fiel + as migrations REAIS que o snapshot não tem
# ══════════════════════════════════════════════════════════════════════════════
# Escolha do caminho FIEL (não stub): a função lê ~17 tabelas. Stubá-las à mão convidaria
# a errar um tipo e mascarar justamente o bug que a prova existe pra pegar.
# ⚠️ O snapshot está STALE p/ 2 objetos (conferido 2026-07-16): v_sku_leadtime_efetivo
#    (nasce em #1343) e reposicao_motor_run. Aplico as migrations REAIS que os criam —
#    Lei #1 vale p/ os pré-requisitos também: migration de verdade, não CREATE TABLE à mão.
RR="$(mktemp /tmp/snap-rr-lt.XXXXXX.sql)"
sed -E 's/^(CREATE SCHEMA public;)/-- \1/' "$REPO_ROOT/supabase/schema-snapshot.sql" \
  | grep -vE '^\\(un)?restrict ' > "$RR"
P -q -f "$REPO_ROOT/supabase/schema-extensions-prelude.sql"
P --single-transaction -q -f "$RR"; rm -f "$RR"
echo "snapshot aplicado"

P -q -f "$REPO_ROOT/supabase/migrations/20260708171049_reposicao_motor_run_marker.sql"
P -q -f "$REPO_ROOT/supabase/migrations/20260716180000_leadtime_efetivo_dedup_nfe.sql"
echo "pré-requisitos aplicados (reposicao_motor_run, v_sku_leadtime_efetivo)"

# ══════════════════════════════════════════════════════════════════════════════
# ZONA 2 — APLICAR A MIGRATION REAL (Lei #1)
# ══════════════════════════════════════════════════════════════════════════════
MIG="$REPO_ROOT/supabase/migrations/20260717010000_preco_medio_leadtime_efetivo.sql"
P -q -f "$MIG"
echo "migration aplicada: $(basename "$MIG")"

# ══════════════════════════════════════════════════════════════════════════════
# ZONA 3 — SEED
# ══════════════════════════════════════════════════════════════════════════════
# Elegibilidade p/ o SKU chegar a pedido_compra_item (todas conferidas no corpo da função):
#   · omie_products(account='oben') com tipo_produto NOT NULL  → destrava o gate tipo_produto_unhealthy
#   · sku_parametros habilitado/automatica/fornecedor/ponto_pedido/estoque_maximo
#   · sku_estoque_atual com fonte_sync <> 'cold_start_seed'    → senão `suprimido` e NÃO gera pedido
#   · estoque_efetivo (0) <= ponto_pedido (10)                 → dispara
#   · SEM sku_embalagem_equivalencia                           → `trocou`=false ⇒ preco_unitario = preco_unitario_ancora
#                                                                (é o campo que queremos ler)
P -q <<'SQL'
INSERT INTO public.company_config(key, value) VALUES ('embalagem_preco_motor_stale_dias','45')
  ON CONFLICT (key) DO NOTHING;

-- Catálogo: 5 SKUs, todos compráveis. tipo_produto NOT NULL destrava o gate de saúde.
INSERT INTO public.omie_products (omie_codigo_produto, codigo, descricao, account, ativo, tipo_produto, familia)
VALUES (1001,'A','SKU A — NFe duplicada + NFe unica','oben',true,'00','F1'),
       (1002,'B','SKU B — tem cmc','oben',true,'00','F1'),
       (1003,'C','SKU C — copias divergem na QUANTIDADE','oben',true,'00','F1'),
       (1004,'D','SKU D — copias divergem no VALOR','oben',true,'00','F1'),
       (1005,'E','SKU E — sem historico nenhum','oben',true,'00','F1');

INSERT INTO public.sku_parametros (empresa, sku_codigo_omie, sku_descricao, fornecedor_nome,
                                   ponto_pedido, estoque_maximo, habilitado_reposicao_automatica, tipo_reposicao)
SELECT 'OBEN', p.omie_codigo_produto, p.descricao, 'FORNEC-TESTE', 10, 100, true, 'automatica'
FROM public.omie_products p WHERE p.account='oben';

-- fonte_sync real (não seed) ⇒ linha CONFIRMADA ⇒ não suprimida. estoque 0 <= ponto_pedido ⇒ dispara.
INSERT INTO public.sku_estoque_atual (empresa, sku_codigo_omie, estoque_fisico, estoque_pendente_entrada, fonte_sync)
SELECT 'OBEN', p.omie_codigo_produto::text, 0, 0, 'omie'
FROM public.omie_products p WHERE p.account='oben';

INSERT INTO public.fornecedor_habilitado_reposicao (empresa, fornecedor_nome, horario_corte_pedido)
VALUES ('OBEN','FORNEC-TESTE','16:00:00');

-- ── O DEFEITO REPRODUZIDO ────────────────────────────────────────────────────
-- NFe-AAA fatura 3 pedidos ⇒ 3 tracking distintos ⇒ 3 CÓPIAS do item do SKU 1001
-- (idênticas: qtde 1, valor 100 ⇒ preço unitário 100). NFe-BBB é uma compra única (preço 200).
--   fonte CRUA  → AVG(100,100,100,200) = 125  ← ponderado pela multiplicidade (o viés)
--   view EFETIVA→ AVG(100,200)         = 150  ← 1 obs por NFe (o correto)
INSERT INTO public.purchase_orders_tracking (id, empresa, omie_codigo_pedido, fornecedor_codigo_omie, nfe_chave_acesso, t1_data_pedido) VALUES
  ('aaaaaaaa-0000-0000-0000-000000000001','OBEN',9001,77,'NFE-AAA','2026-06-01'),
  ('aaaaaaaa-0000-0000-0000-000000000002','OBEN',9002,77,'NFE-AAA','2026-06-01'),
  ('aaaaaaaa-0000-0000-0000-000000000003','OBEN',9003,77,'NFE-AAA','2026-06-01'),
  ('bbbbbbbb-0000-0000-0000-000000000001','OBEN',9004,77,'NFE-BBB','2026-06-10'),
  ('cccccccc-0000-0000-0000-000000000001','OBEN',9005,77,'NFE-CCC','2026-06-01'),
  ('cccccccc-0000-0000-0000-000000000002','OBEN',9006,77,'NFE-CCC','2026-06-01'),
  ('dddddddd-0000-0000-0000-000000000001','OBEN',9007,77,'NFE-DDD','2026-06-01'),
  ('dddddddd-0000-0000-0000-000000000002','OBEN',9008,77,'NFE-DDD','2026-06-01');

INSERT INTO public.sku_leadtime_history (tracking_id, empresa, sku_codigo_omie, quantidade_recebida, valor_total, origem_compra, t1_data_pedido) VALUES
  -- SKU 1001 · NFe-AAA triplicada (cópias IDÊNTICAS — o caso real do writer pré-#1345)
  ('aaaaaaaa-0000-0000-0000-000000000001','OBEN',1001, 1, 100, 'normal','2026-06-01'),
  ('aaaaaaaa-0000-0000-0000-000000000002','OBEN',1001, 1, 100, 'normal','2026-06-01'),
  ('aaaaaaaa-0000-0000-0000-000000000003','OBEN',1001, 1, 100, 'normal','2026-06-01'),
  -- SKU 1001 · NFe-BBB única
  ('bbbbbbbb-0000-0000-0000-000000000001','OBEN',1001, 1, 200, 'normal','2026-06-10'),
  -- SKU 1002 · histórico simples (o cmc é que manda nele)
  ('bbbbbbbb-0000-0000-0000-000000000001','OBEN',1002, 1, 500, 'normal','2026-06-10'),
  -- SKU 1003 · cópias CONCORDAM no valor, DIVERGEM na quantidade ⇒ view NULLa a quantidade
  ('cccccccc-0000-0000-0000-000000000001','OBEN',1003, 1, 100, 'normal','2026-06-01'),
  ('cccccccc-0000-0000-0000-000000000002','OBEN',1003, 2, 100, 'normal','2026-06-01'),
  -- SKU 1004 · cópias CONCORDAM na quantidade, DIVERGEM no valor ⇒ view NULLa o valor
  ('dddddddd-0000-0000-0000-000000000001','OBEN',1004, 1, 100, 'normal','2026-06-01'),
  ('dddddddd-0000-0000-0000-000000000002','OBEN',1004, 1, 300, 'normal','2026-06-01');
  -- SKU 1005 · nenhuma linha de leadtime (primeira compra de verdade)

-- cmc SÓ p/ o SKU 1002 ⇒ ele prova que cmc-first continua vencendo o preço do leadtime.
-- Os demais ficam sem inventory_position ⇒ caem no fallback (que é o caminho sob teste).
INSERT INTO public.inventory_position (omie_codigo_produto, account, cmc, saldo, synced_at)
VALUES (1002,'vendas', 77, 0, now());
SQL
echo "seed pronto"

# ══════════════════════════════════════════════════════════════════════════════
# ZONA 4 — ASSERTS
# ══════════════════════════════════════════════════════════════════════════════
# Helper: roda o motor de VERDADE (pega o late-bound) e lê o que ele GRAVOU.
roda_motor() { P -q -c "SELECT public.gerar_pedidos_sugeridos_ciclo('OBEN','2026-07-16');" >/dev/null; }
preco_de()  { Pq -c "SELECT COALESCE(round(preco_unitario,4)::text,'NULL') FROM pedido_compra_item WHERE sku_codigo_omie='$1';"; }
primeira_de() { Pq -c "SELECT COALESCE(primeira_compra::text,'NULL') FROM pedido_compra_item WHERE sku_codigo_omie='$1';"; }

echo "── asserts (motor real, migration real) ──"
roda_motor
ok "A0 late-bound: gerar_pedidos_sugeridos_ciclo() EXECUTOU (não só CREATE)"

# ── A1: o coração. A NFe triplicada conta 1×, não 3×. ──
eq "A1 dedup: NFe que fatura N pedidos pesa 1 obs — AVG(100,200), não AVG(100,100,100,200)" \
   "$(preco_de 1001)" "150.0000"

# ── A2: cmc-first intacto (a repontagem não pode mexer na precedência) ──
eq "A2 cmc-first: havendo cmc, a âncora é o cmc — o leadtime nem entra" \
   "$(preco_de 1002)" "77.0000"

# ── A3: ausente ≠ zero (quantidade incognoscível ⇒ preço NULL, JAMAIS 0) ──
# Cópias divergem na quantidade ⇒ view NULLa o campo ⇒ o par sai da CTE pelo `> 0`
# (NULL > 0 é NULL). Sem cmc ⇒ preço da âncora fica NULL. Fabricar 0 aqui viraria compra
# a custo zero. Na fonte crua isto daria AVG(100/1, 100/2) = 75 — um número inventado.
eq "A3 ausente≠zero: cópias divergem na QUANTIDADE ⇒ preço NULL (não 0, não 75)" \
   "$(preco_de 1003)" "NULL"

# ── A4: idem pelo valor_total (o campo que o briefing temia; em prod nenhum par perde) ──
eq "A4 ausente≠zero: cópias divergem no VALOR ⇒ preço NULL (não 0, não 200)" \
   "$(preco_de 1004)" "NULL"

# ── A5/A6: o SEGUNDO consumidor da CTE — primeira_compra = (pm.n IS NULL) ──
# Sem proteção de cmc. Este é o campo que a repontagem poderia fazer MENTIR.
eq "A5 primeira_compra NÃO mente: SKU com histórico que sobrevive ao colapso ⇒ false" \
   "$(primeira_de 1001)" "false"
eq "A6 primeira_compra honesta: SKU sem nenhum histórico ⇒ true" \
   "$(primeira_de 1005)" "true"

# ── A7: O GUARD. Comprar ≠ saber quanto custou. ──
# SKU 1003 tem NFe (foi comprado!), mas as cópias divergem na quantidade ⇒ o preço é
# incognoscível (A3 acima prova o NULL). O que ele NÃO é: primeira compra.
# Sem o FILTER (filtro de preço no WHERE), o SKU sumiria da CTE inteira ⇒ pm.n IS NULL ⇒ o
# badge mentiria. Medido em prod: ZERO casos no pré-flight, DOIS poucas horas depois na
# mesma sessão (o sync grava; o resíduo se move). Este é o assert que impede a repontagem
# de trocar viés por mentira.
eq "A7 GUARD: SKU comprado cujo PREÇO é incognoscível NÃO é primeira compra" \
   "$(primeira_de 1003)" "false"

# ══════════════════════════════════════════════════════════════════════════════
# ZONA 5 — FALSIFICAÇÃO (Lei #3): sabota → exige VERMELHO → restaura
# ══════════════════════════════════════════════════════════════════════════════
# A sabotagem é a mudança que esta migration faz, INVERTIDA: volta o FROM pra tabela crua.
# Se os asserts continuarem verdes com o defeito de volta, eles não têm dente.
echo "── falsificação (sabota a migração → os asserts TÊM que ficar vermelhos) ──"
SAB="$(mktemp /tmp/sabota-lt.XXXXXX.sql)"
sed 's|^    FROM v_sku_leadtime_efetivo slh.*$|    FROM sku_leadtime_history slh|' "$MIG" > "$SAB"
grep -q 'FROM sku_leadtime_history slh' "$SAB" || { echo "❌ a sabotagem não pegou — sed não casou"; exit 1; }
P -q -f "$SAB"
P -q -c "DELETE FROM pedido_compra_item; DELETE FROM pedido_compra_sugerido;"
roda_motor

falsifica() { # $1=rótulo  $2=valor_observado  $3=valor_do_assert_verdadeiro
  if [ "$2" = "$3" ]; then bad "FALS $1 — sabotado e AINDA verde ⇒ assert SEM DENTE"
  else ok "FALS $1 — sabotado ⇒ virou [$2] (≠ [$3]) ⇒ o assert morde"; fi
}
falsifica "A1 (dedup)"      "$(preco_de 1001)" "150.0000"   # crua ⇒ 125 (AVG ponderado)
falsifica "A3 (quantidade)" "$(preco_de 1003)" "NULL"       # crua ⇒ 75  (número fabricado)
falsifica "A4 (valor)"      "$(preco_de 1004)" "NULL"       # crua ⇒ 200 (número fabricado)

# Contraprova da falsificação: o valor enviesado exato que a fonte crua produz. Ancora o
# "vermelho" num número previsto, não em "mudou alguma coisa".
eq "FALS A1b: a fonte crua produz EXATAMENTE o AVG ponderado pela multiplicidade" \
   "$(preco_de 1001)" "125.0000"

# A2 é o controle NEGATIVO da falsificação: cmc-first não depende da fonte do leadtime,
# então sabotar NÃO pode movê-lo. Se movesse, a sabotagem teria efeito colateral e as
# outras conclusões estariam contaminadas.
eq "FALS A2 (controle): cmc-first imune à sabotagem — segue no cmc" \
   "$(preco_de 1002)" "77.0000"

# restaura a versão verdadeira (cirúrgico: só o que foi sabotado)
P -q -f "$MIG"; rm -f "$SAB"
P -q -c "DELETE FROM pedido_compra_item; DELETE FROM pedido_compra_sugerido;"
roda_motor
eq "RESTAURA: migration verdadeira de volta ⇒ A1 volta ao correto" "$(preco_de 1001)" "150.0000"

# ── SABOTAGEM 2: mata o GUARD (o filtro de preço volta do FILTER pro WHERE) ──
# Esta é a sabotagem que reproduz a versão ANTERIOR desta própria migration — a que media
# "0 casos" no pré-flight e teria mentido em 2 SKUs ativos horas depois. Sem este par
# assert+falsificação, nada impediria alguém de "simplificar" o FILTER de volta pro WHERE.
echo "── falsificação 2 (mata o guard do primeira_compra) ──"
SAB2="$(mktemp /tmp/sabota-guard.XXXXXX.sql)"
sed -e 's|^             FILTER (WHERE slh.quantidade_recebida > 0 AND slh.valor_total > 0) AS preco_unitario,$|             AS preco_unitario,|' \
    -e 's|^    GROUP BY slh.empresa, slh.sku_codigo_omie$|    WHERE slh.quantidade_recebida > 0 AND slh.valor_total > 0\n    GROUP BY slh.empresa, slh.sku_codigo_omie|' \
    "$MIG" > "$SAB2"
# guard: a sabotagem-2 só vale se o WHERE VOLTOU **e** o FILTER SUMIU. Sem os dois, o sed não casou e o
# "vermelho" abaixo não provaria nada (a lição do #1362: comando quebrado parece a prova que você queria).
if ! grep -q '^    WHERE slh.quantidade_recebida > 0 AND slh.valor_total > 0$' "$SAB2" \
   || grep -q 'FILTER (WHERE slh.quantidade_recebida' "$SAB2"; then
  echo "❌ a sabotagem-2 não pegou — sed não casou"; exit 1
fi
P -q -f "$SAB2"
P -q -c "DELETE FROM pedido_compra_item; DELETE FROM pedido_compra_sugerido;"
roda_motor
falsifica "A7 (guard)" "$(primeira_de 1003)" "false"   # sem o guard ⇒ vira 'true' (a mentira)
# Controle: matar o guard NÃO pode mexer no preço — se mexesse, a sabotagem teria efeito
# colateral e o veredito do A7 estaria contaminado.
eq "FALS A7b (controle): matar o guard não move o preço (A1 segue correto)" \
   "$(preco_de 1001)" "150.0000"
eq "FALS A7c (controle): o preço incognoscível segue NULL — o guard só toca o badge" \
   "$(preco_de 1003)" "NULL"

P -q -f "$MIG"; rm -f "$SAB2"
P -q -c "DELETE FROM pedido_compra_item; DELETE FROM pedido_compra_sugerido;"
roda_motor
eq "RESTAURA 2: guard de volta ⇒ A7 volta ao correto" "$(primeira_de 1003)" "false"

# ── veredito ──
echo "──────────────────────────────"
echo "RESULTADO: $PASS ok / $FAIL fail"
[ "$FAIL" = "0" ] || { echo "❌ HARNESS VERMELHO"; exit 1; }
echo "✅ HARNESS VERDE"
