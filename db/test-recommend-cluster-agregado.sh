#!/usr/bin/env bash
# ╔══════════════════════════════════════════════════════════════════════════════╗
# ║  HARNESS PG17 — PROVA de migration money-path/auth com FALSIFICAÇÃO            ║
# ║  Copie p/ db/test-<slug>.sh, preencha as ZONAS [[...]], rode:                  ║
# ║      bash db/test-<slug>.sh > /tmp/t.log 2>&1; echo "exit=$?"                  ║
# ║  (NÃO pipe pra tail — engole o exit≠0; §2 do CLAUDE.md.)                       ║
# ║                                                                                ║
# ║  Lei de Ferro (skill prove-sql-money-path):                                    ║
# ║   1. Aplica a migration REAL (psql -f), não um stub da lógica.                 ║
# ║   2. Assert negativo captura a SQLSTATE esperada e RE-LANÇA o resto.           ║
# ║   3. Falsificação obrigatória: sabota a migração → exija VERMELHO → restaura.  ║
# ╚══════════════════════════════════════════════════════════════════════════════╝
set -euo pipefail

# ── arranque PG17 descartável (idêntico em todos os harnesses; contorna keg-only do brew) ──
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PGVER=17
PGBIN="/opt/homebrew/opt/postgresql@${PGVER}/bin"
PORT="${PGPORT_TEST:-5473}"     # mude se rodar em paralelo com outro harness (40 worktrees)
SLUG="recommend-cluster-agregado"   # nomeia tmpdir e log
DATA="$(mktemp -d "/tmp/pgtest-${SLUG}.XXXXXX")/data"
export LC_ALL=C LANG=C          # sem isso o postmaster aborta ("became multithreaded during startup")

[ -x "$PGBIN/initdb" ] || { echo "postgresql@${PGVER} ausente: brew install postgresql@${PGVER} pgvector"; exit 1; }

# keg-only do brew: share/lib do postgresql@17 podem não estar linkados → initdb/server falham. Copia do Cellar (idempotente).
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
Pq() { P -tA "$@"; }   # tuples-only, unaligned (pra capturar 1 valor)

# ── base mínima do Supabase: roles, schema auth, auth.uid()/role() via GUC (impersonação de RLS) ──
P -q -f "$REPO_ROOT/db/stubs-supabase.sql"
P -q <<'SQL'
CREATE OR REPLACE FUNCTION auth.uid()  RETURNS uuid LANGUAGE sql STABLE AS $f$ SELECT nullif(current_setting('test.uid',  true), '')::uuid $f$;
CREATE OR REPLACE FUNCTION auth.role() RETURNS text LANGUAGE sql STABLE AS $f$ SELECT nullif(current_setting('test.role', true), '') $f$;
ALTER ROLE service_role BYPASSRLS;   -- espelha o admin role do Supabase (semear sem esbarrar em RLS)
SQL

# ── helpers de assert (pass/fail contados; exit 1 no fim se houve fail) ──
PASS=0; FAIL=0
ok()  { PASS=$((PASS+1)); echo "  ✅ $1"; }
bad() { FAIL=$((FAIL+1)); echo "  ❌ $1"; }
eq()  { if [ "$2" = "$3" ]; then ok "$1 (=$2)"; else bad "$1 — esperado [$3], veio [$2]"; fi; }
# exige que um comando SQL FALHE (caminho negativo grosso). Pra checar a SQLSTATE exata, use o
# padrão DO/EXCEPTION de references/assert-patterns.md (preferível — Lei #2).
must_fail() { if P -q -c "$1" >/dev/null 2>&1; then bad "$2 — devia ter falhado e PASSOU"; else ok "$2 (rejeitado)"; fi; }


# ══════════════════════════════════════════════════════════════════════════════
# ZONA 1 — PRÉ-REQUISITOS (as 4 tabelas que a RPC LÊ e não cria)
# ══════════════════════════════════════════════════════════════════════════════
P -q <<'SQL'
CREATE TABLE IF NOT EXISTS public.farmer_client_scores (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_user_id uuid NOT NULL,
  health_class text,
  sales_history_status text
);
CREATE TABLE IF NOT EXISTS public.sales_orders (
  id uuid PRIMARY KEY,
  customer_user_id uuid NOT NULL,
  status text NOT NULL,
  deleted_at timestamptz
);
CREATE TABLE IF NOT EXISTS public.omie_products (
  id uuid PRIMARY KEY,
  ativo boolean NOT NULL DEFAULT true
);
CREATE TABLE IF NOT EXISTS public.order_items (
  id uuid PRIMARY KEY,
  sales_order_id uuid NOT NULL REFERENCES public.sales_orders(id),
  customer_user_id uuid NOT NULL,
  product_id uuid REFERENCES public.omie_products(id)
);
SQL

# ══════════════════════════════════════════════════════════════════════════════
# ZONA 2 — APLICAR A MIGRATION REAL (Lei #1)
# ══════════════════════════════════════════════════════════════════════════════
MIG="$REPO_ROOT/supabase/migrations/20260822000358_recommend_cluster_agregado.sql"
P -q -f "$MIG"
echo "migration aplicada: $(basename "$MIG")"
# Guardado p/ restaurar cirurgicamente depois de cada sabotagem da ZONA 5.
restaurar() { P -q -f "$MIG"; }

# ══════════════════════════════════════════════════════════════════════════════
# ZONA 3 — SEED: reproduz a FORMA do defeito medido em prod
# ══════════════════════════════════════════════════════════════════════════════
# O ponto do seed: `pesado` sozinho gera 1.200 linhas de order_items e seus `id` ordenam
# ANTES dos de `leve` (prefixo '0' vs 'f'). Sob o `ORDER BY id LIMIT 1000` do código antigo,
# as 1.000 lidas são TODAS do pesado e `leve` some — apesar de ter compra real. É exatamente
# o que a prod mostrou (5 clientes zerados em `atencao`, 2 em `estavel`).
P -q <<'SQL'
-- 600 produtos ativos + 1 inativo
INSERT INTO public.omie_products(id, ativo)
SELECT ('00000000-0000-4000-8000-' || lpad(g::text, 12, '0'))::uuid, true FROM generate_series(0, 599) g;
INSERT INTO public.omie_products(id, ativo) VALUES ('00000000-0000-4000-8000-999999999999', false);

-- cluster 'critico': 3 elegíveis (pesado, leve, sem_compra) + 2 que a whitelist deve BARRAR
INSERT INTO public.farmer_client_scores(customer_user_id, health_class, sales_history_status) VALUES
  ('aaaaaaaa-0000-4000-8000-000000000001', 'critico', 'ativo'),        -- pesado
  ('aaaaaaaa-0000-4000-8000-000000000002', 'critico', 'stale'),        -- leve
  ('aaaaaaaa-0000-4000-8000-000000000003', 'critico', 'ativo'),        -- elegível SEM compra
  ('aaaaaaaa-0000-4000-8000-000000000004', 'critico', 'sem_historico'),-- barrado pela whitelist
  ('aaaaaaaa-0000-4000-8000-000000000005', 'critico', NULL);           -- barrado (NULL-blind)

-- pedidos: 1 válido por cliente + os inválidos que o universo canônico exclui
INSERT INTO public.sales_orders(id, customer_user_id, status, deleted_at) VALUES
  ('0a000000-0000-4000-8000-000000000001', 'aaaaaaaa-0000-4000-8000-000000000001', 'faturado',  NULL),
  ('0a000000-0000-4000-8000-000000000002', 'aaaaaaaa-0000-4000-8000-000000000002', 'faturado',  NULL),
  ('0a000000-0000-4000-8000-000000000003', 'aaaaaaaa-0000-4000-8000-000000000004', 'faturado',  NULL),
  ('0a000000-0000-4000-8000-000000000005', 'aaaaaaaa-0000-4000-8000-000000000005', 'faturado',  NULL),
  ('0c000000-0000-4000-8000-00000000000c', 'aaaaaaaa-0000-4000-8000-000000000003', 'cancelado', NULL),
  ('0d000000-0000-4000-8000-00000000000d', 'aaaaaaaa-0000-4000-8000-000000000003', 'faturado',  now()),
  ('0e000000-0000-4000-8000-00000000000e', 'aaaaaaaa-0000-4000-8000-000000000003', 'pendente',  NULL);

-- pesado: 1.200 linhas (600 produtos x 2 recompras), ids com prefixo '0' → ordenam PRIMEIRO
INSERT INTO public.order_items(id, sales_order_id, customer_user_id, product_id)
SELECT ('0b000000-0000-4000-8000-' || lpad(g::text, 12, '0'))::uuid,
       '0a000000-0000-4000-8000-000000000001',
       'aaaaaaaa-0000-4000-8000-000000000001',
       ('00000000-0000-4000-8000-' || lpad((g % 600)::text, 12, '0'))::uuid
FROM generate_series(0, 1199) g;

-- leve: 3 linhas do MESMO produto (prova o dedup) + 1 de SKU inativo. Prefixo 'f' → ordenam por ÚLTIMO.
INSERT INTO public.order_items(id, sales_order_id, customer_user_id, product_id) VALUES
  ('ff000000-0000-4000-8000-000000000001', '0a000000-0000-4000-8000-000000000002', 'aaaaaaaa-0000-4000-8000-000000000002', '00000000-0000-4000-8000-000000000000'),
  ('ff000000-0000-4000-8000-000000000002', '0a000000-0000-4000-8000-000000000002', 'aaaaaaaa-0000-4000-8000-000000000002', '00000000-0000-4000-8000-000000000000'),
  ('ff000000-0000-4000-8000-000000000003', '0a000000-0000-4000-8000-000000000002', 'aaaaaaaa-0000-4000-8000-000000000002', '00000000-0000-4000-8000-000000000000'),
  ('ff000000-0000-4000-8000-000000000004', '0a000000-0000-4000-8000-000000000002', 'aaaaaaaa-0000-4000-8000-000000000002', '00000000-0000-4000-8000-999999999999');

-- linhas dos BARRADOS e dos pedidos INVÁLIDOS (não podem entrar em nada)
INSERT INTO public.order_items(id, sales_order_id, customer_user_id, product_id) VALUES
  ('fa000000-0000-4000-8000-000000000001', '0a000000-0000-4000-8000-000000000003', 'aaaaaaaa-0000-4000-8000-000000000004', '00000000-0000-4000-8000-000000000001'),
  ('fa000000-0000-4000-8000-000000000002', '0a000000-0000-4000-8000-000000000005', 'aaaaaaaa-0000-4000-8000-000000000005', '00000000-0000-4000-8000-000000000001'),
  ('fc000000-0000-4000-8000-00000000000c', '0c000000-0000-4000-8000-00000000000c', 'aaaaaaaa-0000-4000-8000-000000000003', '00000000-0000-4000-8000-000000000001'),
  ('fd000000-0000-4000-8000-00000000000d', '0d000000-0000-4000-8000-00000000000d', 'aaaaaaaa-0000-4000-8000-000000000003', '00000000-0000-4000-8000-000000000001'),
  ('fe000000-0000-4000-8000-00000000000e', '0e000000-0000-4000-8000-00000000000e', 'aaaaaaaa-0000-4000-8000-000000000003', '00000000-0000-4000-8000-000000000001');

-- ⚠️ ESPELHA O SUPABASE REAL: lá `authenticated` TEM SELECT nestas tabelas (é a RLS que filtra
-- linha, não o GRANT). Sem estes grants o harness testaria um mundo que não existe — o 42501 do
-- assert A9 viria da TABELA, não da função, e o REVOKE pareceria redundante justamente onde ele
-- é a única barreira. A falsificação F4 é quem pegou isso: o assert passava sem o REVOKE.
GRANT SELECT ON public.farmer_client_scores, public.order_items, public.sales_orders, public.omie_products TO authenticated;
SQL

# ══════════════════════════════════════════════════════════════════════════════
# ZONA 4 — ASSERTS
# ══════════════════════════════════════════════════════════════════════════════
echo "── asserts ──"

RPC="SELECT denominador, observados, produtos, truncado FROM public.recommend_cluster_agregado('critico')"
P1="'00000000-0000-4000-8000-000000000000'"   # o produto que pesado E leve compraram

# ── A0. CONTROLE: o defeito EXISTE neste seed ────────────────────────────────
# Sem isto o resto seria verde por vacuidade: se o teto de 1.000 não mordesse no fixture,
# "nenhum cliente zerado" não provaria conserto nenhum. Reproduz a leitura ANTIGA verbatim.
ANTIGO=$(Pq -c "SELECT count(DISTINCT customer_user_id) FROM (
  SELECT customer_user_id FROM public.order_items
  WHERE customer_user_id IN ('aaaaaaaa-0000-4000-8000-000000000001','aaaaaaaa-0000-4000-8000-000000000002','aaaaaaaa-0000-4000-8000-000000000003')
  ORDER BY id LIMIT 1000) t;")
eq "A0 CONTROLE: a leitura ANTIGA (ORDER BY id LIMIT 1000) observa só 1 dos 3 clientes" "$ANTIGO" "1"

ANTIGO_P1=$(Pq -c "SELECT count(DISTINCT customer_user_id) FROM (
  SELECT customer_user_id, product_id FROM public.order_items
  WHERE customer_user_id IN ('aaaaaaaa-0000-4000-8000-000000000001','aaaaaaaa-0000-4000-8000-000000000002')
  ORDER BY id LIMIT 1000) t WHERE product_id = $P1;")
eq "A0b CONTROLE: no produto compartilhado a leitura ANTIGA conta 1 cliente (zerou o 'leve')" "$ANTIGO_P1" "1"

# ── A1. O CONSERTO: o cliente que o teto apagava agora CONTA ──────────────────
N_P1=$(Pq -c "SELECT (produtos->>$P1)::int FROM public.recommend_cluster_agregado('critico');")
eq "A1 CONSERTO: o produto compartilhado conta os DOIS clientes (o 'leve' voltou)" "$N_P1" "2"

# ── A2. Dedup (cliente,produto): 3 compras do MESMO SKU contam 1 ─────────────
# 'leve' comprou o produto compartilhado 3x. Se contasse linha, o numerador daria 4 (1+3).
LINHAS_LEVE=$(Pq -c "SELECT count(*) FROM public.order_items WHERE customer_user_id='aaaaaaaa-0000-4000-8000-000000000002' AND product_id=$P1;")
eq "A2a o fixture TEM recompra (senão o dedup não é testado)" "$LINHAS_LEVE" "3"
eq "A2b dedup: 3 recompras do mesmo SKU contam 1 cliente, não 3" "$N_P1" "2"

# ── A3. Denominador = POPULAÇÃO elegível, não observados ─────────────────────
DEN=$(Pq -c "SELECT denominador FROM public.recommend_cluster_agregado('critico');")
OBS=$(Pq -c "SELECT observados  FROM public.recommend_cluster_agregado('critico');")
eq "A3a denominador = população elegível (inclui o elegível SEM compra válida)" "$DEN" "3"
eq "A3b observados = quem tem >=1 par no recorte — DIVERGE do denominador" "$OBS" "2"

# ── A4. Whitelist de status: 'sem_historico' e NULL ficam FORA ───────────────
# Os dois têm order_items de pedido válido; se entrassem, o denominador seria 5.
eq "A4 whitelist positiva barra 'sem_historico' E NULL (negação seria NULL-blind)" "$DEN" "3"

# ── A5. Universo de pedidos canônico ─────────────────────────────────────────
# O cliente 'sem_compra' tem 3 linhas, todas em pedido cancelado / apagado / pendente.
eq "A5 pedido cancelado, deleted_at e 'pendente' não viram compra (observados seguem 2)" "$OBS" "2"

# ── A6. SKU inativo fora do agregado ─────────────────────────────────────────
INATIVO=$(Pq -c "SELECT coalesce((produtos->>'00000000-0000-4000-8000-999999999999')::int, -1) FROM public.recommend_cluster_agregado('critico');")
eq "A6 SKU inativo não entra (o consumidor já o descarta — seria payload puro)" "$INATIVO" "-1"

# ── A7. DISJUNTOR: acima do teto NÃO devolve número, devolve NULL ────────────
TRUNC=$(Pq -c "SELECT truncado FROM public.recommend_cluster_agregado('critico', 1);")
T_OBS=$(Pq -c "SELECT coalesce(observados::text,'NULO') FROM public.recommend_cluster_agregado('critico', 1);")
T_PRD=$(Pq -c "SELECT coalesce(produtos::text,'NULO')   FROM public.recommend_cluster_agregado('critico', 1);")
T_DEN=$(Pq -c "SELECT denominador FROM public.recommend_cluster_agregado('critico', 1);")
eq "A7a truncado=true quando a população passa do teto" "$TRUNC" "t"
eq "A7b observados vem NULO, não 0 (0 seria 'medi e ninguém comprou')" "$T_OBS" "NULO"
eq "A7c produtos vem NULO, não '{}' (o mesmo zero fabricado, de outra forma)" "$T_PRD" "NULO"
eq "A7d denominador segue sendo o FATO observável mesmo truncado" "$T_DEN" "3"

# ── A8. Cluster vazio é estado legítimo, não erro ────────────────────────────
V_DEN=$(Pq -c "SELECT denominador FROM public.recommend_cluster_agregado('inexistente');")
V_PRD=$(Pq -c "SELECT produtos::text FROM public.recommend_cluster_agregado('inexistente');")
V_TRN=$(Pq -c "SELECT truncado FROM public.recommend_cluster_agregado('inexistente');")
eq "A8a cluster vazio: denominador 0" "$V_DEN" "0"
eq "A8b cluster vazio: produtos '{}' (aqui o vazio É medido)" "$V_PRD" "{}"
eq "A8c cluster vazio: não truncado" "$V_TRN" "f"

# ── A9. REVOKE: 'authenticated' NÃO executa (agregado cross-customer) ────────
# Sentinela ANTI-TEATRO: 'BARRADO_42501' não aparece em nenhuma mensagem que o Postgres emite,
# então um ILIKE não pode casar a própria sentinela e pintar verde sozinho.
NEG="$(mktemp -t neg-cluster)"
cat > "$NEG" <<'SQL'
DO $t$
BEGIN
  SET LOCAL ROLE authenticated;
  PERFORM * FROM public.recommend_cluster_agregado('critico');
  RESET ROLE;
  RAISE NOTICE 'EXECUTOU_SEM_BARRAR';
EXCEPTION
  WHEN insufficient_privilege THEN RESET ROLE; RAISE NOTICE 'BARRADO_42501';
  WHEN OTHERS THEN RESET ROLE; RAISE;
END $t$;
SQL
R=$(P -tA -f "$NEG" 2>&1)
case "$R" in
  *BARRADO_42501*) ok "A9 REVOKE: 'authenticated' recebe permission denied (42501)" ;;
  *)               bad "A9 REVOKE: authenticated NAO foi barrado - saida: $R" ;;
esac

# ══════════════════════════════════════════════════════════════════════════════
# ZONA 5 — FALSIFICAÇÃO (Lei #3): sabota → exige VERMELHO → restaura
# ══════════════════════════════════════════════════════════════════════════════
# Um assert que continua verde com a defesa sabotada não tem dente. Cada bloco abaixo
# quebra UMA garantia e exige que o assert correspondente da ZONA 4 mude de valor.
echo "── falsificação ──"

# `esperado` aqui é o valor do assert VERDE; a sabotagem tem de fazê-lo DIVERGIR.
exige_vermelho() { # $1 rótulo · $2 valor sob sabotagem · $3 valor verde
  if [ "$2" = "$3" ]; then bad "FALSIF $1 — assert seguiu VERDE sob sabotagem (sem dente)"
  else ok "FALSIF $1 — assert ficou vermelho ($3 → $2)"; fi
}

# Reescreve só o corpo, preservando assinatura/ACL. Opera numa CÓPIA — o .sql do repo nunca é
# tocado, então não depende de `git checkout --` para restaurar (§ falsificação do CLAUDE.md).
# `perl -0777` e não `sed`: preciso de substituição da PRIMEIRA ocorrência apenas (F3 troca o
# CASE de `observados`, que é int, sem tocar o de `produtos`, que é jsonb e não aceita 0), e
# `0,/re/` do GNU sed não existe no BSD sed do macOS — a flag homônima faria OUTRA coisa em
# silêncio em vez de falhar.
sabotar() { # $1 = expressão perl aplicada ao .sql
  SAB="$(mktemp -t sab-cluster)"
  perl -0777 -pe "$1" "$MIG" > "$SAB"
  P -q -f "$SAB"
  rm -f "$SAB"
}

# F1 — tira o DISTINCT: o numerador volta a contar LINHA, não cliente.
sabotar 's/SELECT DISTINCT i\.customer_user_id, i\.product_id/SELECT i.customer_user_id, i.product_id/'
F1=$(Pq -c "SELECT (produtos->>$P1)::int FROM public.recommend_cluster_agregado('critico');")
exige_vermelho "A1/A2 dedup (sem DISTINCT conta recompra)" "$F1" "2"
restaurar

# F2 — abre a whitelist: 'sem_historico' e NULL voltam para o denominador.
sabotar "s/AND s\\.sales_history_status IN \\('ativo', 'stale'\\)/AND (s.sales_history_status IS NOT NULL OR s.sales_history_status IS NULL)/"
F2=$(Pq -c "SELECT denominador FROM public.recommend_cluster_agregado('critico');")
exige_vermelho "A3a/A4 whitelist de sales_history_status" "$F2" "3"
restaurar

# F3 — o disjuntor devolve ZERO em vez de NULL: o zero fabricado, de outra forma.
# só a PRIMEIRA ocorrência: é a de `observados` (int). A de `produtos` é jsonb.
sabotar 's/THEN NULL/THEN 0/'
F3=$(Pq -c "SELECT coalesce(observados::text,'NULO') FROM public.recommend_cluster_agregado('critico', 1);")
exige_vermelho "A7b truncado devolve NULO, não 0" "$F3" "NULO"
restaurar

# F4 — o REVOKE cai: qualquer customer logado leria o agregado cross-customer.
P -q -c "GRANT EXECUTE ON FUNCTION public.recommend_cluster_agregado(text, integer) TO authenticated;"
R4=$(P -tA -f "$NEG" 2>&1)
case "$R4" in
  *EXECUTOU_SEM_BARRAR*) ok  "FALSIF A9 REVOKE - com GRANT o assert ficou vermelho" ;;
  *)                     bad "FALSIF A9 REVOKE - assert seguiu verde COM grant (sem dente): $R4" ;;
esac
restaurar   # o .sql reemite os REVOKE nomeando as roles

# F5 — cai o filtro de SKU ativo.
sabotar 's/\n    AND o\.ativo\n/\n    AND (o.ativo OR NOT o.ativo)\n/'
F5=$(Pq -c "SELECT coalesce((produtos->>'00000000-0000-4000-8000-999999999999')::int, -1) FROM public.recommend_cluster_agregado('critico');")
exige_vermelho "A6 filtro de SKU ativo" "$F5" "-1"
restaurar

# F6 — cai o universo de pedidos: cancelado/apagado/pendente voltam a contar como compra.
sabotar "s/AND so\\.status NOT IN \\('cancelado', 'rascunho', 'pendente', 'orcamento'\\)/AND true/; s/AND so\\.deleted_at IS NULL/AND true/"
F6=$(Pq -c "SELECT observados FROM public.recommend_cluster_agregado('critico');")
exige_vermelho "A5 universo de pedidos canônico" "$F6" "2"
restaurar

# Prova que restaurar() funcionou — senão os asserts acima mediriam a última sabotagem.
POS=$(Pq -c "SELECT (produtos->>$P1)::int FROM public.recommend_cluster_agregado('critico');")
eq "A10 restauração: a função voltou à versão verdadeira ao fim da falsificação" "$POS" "2"
echo "──────────────────────────────"
echo "RESULTADO: $PASS ok / $FAIL fail"
[ "$FAIL" = "0" ] || { echo "❌ HARNESS VERMELHO"; exit 1; }
echo "✅ HARNESS VERDE"
