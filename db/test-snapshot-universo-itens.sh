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
PORT="${PGPORT_TEST:-5461}"   # distinto dos outros harnesses (worktrees em paralelo)
SLUG="snapshot-universo-itens"
DATA="$(mktemp -d "/tmp/pgtest-${SLUG}.XXXXXX")/data"
export LC_ALL=C LANG=C          # sem isso o postmaster aborta ("became multithreaded during startup")

[ -x "$PGBIN/initdb" ] || { echo "postgresql@${PGVER} ausente: brew install postgresql@${PGVER} pgvector"; exit 1; }

# keg-only do brew: share/lib do postgresql@17 podem não estar linkados → initdb/server falham. Copia do Cellar (idempotente).
CELLAR="$(brew --prefix "postgresql@${PGVER}")"
cp -Rn "$CELLAR"/share/postgresql/. "/opt/homebrew/share/postgresql@${PGVER}/" 2>/dev/null || true
mkdir -p "/opt/homebrew/lib/postgresql@${PGVER}"
cp -Rn "$CELLAR"/lib/postgresql/. "/opt/homebrew/lib/postgresql@${PGVER}/" 2>/dev/null || true

cleanup() { "$PGBIN/pg_ctl" -D "$DATA" stop -m immediate >/dev/null 2>&1 || true; rm -rf "$(dirname "$DATA")"; rm -f "${VOLAT:-}" "${FURADA:-}" "${FURADA2:-}" "${CORRIDA_OUT:-}" "${WRITER_OUT:-}"; }
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

echo "═══ setup pronto (PG17 :$PORT) ═══"

# ══════════════════════════════════════════════════════════════════════════════════════════
# ZONA 1 — PRÉ-REQUISITOS (as duas tabelas que a migration LÊ; ela não cria nenhuma)
# ══════════════════════════════════════════════════════════════════════════════════════════
P -q <<'SQL'
CREATE TABLE public.sales_orders (
  id               uuid PRIMARY KEY,
  customer_user_id uuid NOT NULL,
  status           text NOT NULL,
  deleted_at       timestamptz,
  order_date_kpi   date,
  account          text NOT NULL,
  origem           text,
  checkout_id      uuid,
  created_at       timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE public.order_items (
  id                  uuid PRIMARY KEY,
  customer_user_id    uuid NOT NULL,
  product_id          uuid,
  omie_codigo_produto bigint,
  quantity            numeric NOT NULL,
  unit_price          numeric NOT NULL,
  discount            numeric,
  sales_order_id      uuid NOT NULL REFERENCES public.sales_orders(id) ON DELETE CASCADE,
  created_at          timestamptz
);
-- Espelha os índices REAIS de prod (`idx_order_items_sales_order` em especial). Não é detalhe de
-- performance do teste: sem o índice da FK, o `ON DELETE CASCADE` faz um seq scan de `order_items`
-- POR PEDIDO apagado — com 70 mil pedidos de ruído o harness passava de 7 minutos na limpeza.
CREATE INDEX idx_order_items_sales_order ON public.order_items (sales_order_id);
CREATE INDEX idx_order_items_product     ON public.order_items (product_id);
SQL

# ══════════════════════════════════════════════════════════════════════════════════════════
# ZONA 2 — APLICAR A MIGRATION REAL (Lei #1)
# ══════════════════════════════════════════════════════════════════════════════════════════
MIG="$REPO_ROOT/supabase/migrations/20260830123820_snapshot_atomico_universo_itens.sql"
P -q -f "$MIG"
echo "migration aplicada: $(basename "$MIG")"

# ══════════════════════════════════════════════════════════════════════════════════════════
# ZONA 3 — SEED (universo PEQUENO, contagens conhecidas)
# ══════════════════════════════════════════════════════════════════════════════════════════
# PA é o pedido ALVO e tem DOIS irmãos com uuid nos EXTREMOS da ordenação (IA o menor de todos,
# IB o maior) — é o que reproduz "irmãos em páginas diferentes" sem depender de sorte.
U=11111111-1111-1111-1111-111111111111
PA=aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa
IA=00000000-0000-0000-0000-00000000000a
IB=ffffffff-ffff-ffff-ffff-ffffffffffff
P -q <<SQL
INSERT INTO public.sales_orders (id, customer_user_id, status, deleted_at, account, order_date_kpi) VALUES
  ('$PA','$U','faturado', NULL, 'oben','2026-08-01'),
  ('cccccccc-cccc-cccc-cccc-cccccccccccc','$U','cancelado', NULL, 'oben','2026-08-01'),
  ('dddddddd-dddd-dddd-dddd-dddddddddddd','$U','faturado', now(),  'oben','2026-08-01'),
  ('eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee','$U','faturado', NULL, 'colacor','2026-08-01'),
  ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb','$U','faturado', NULL, 'oben','2025-01-01');
-- IA e IB: os dois irmãos do PEDIDO ALVO (a "cesta"). Entram no universo do Apriori.
INSERT INTO public.order_items (id, customer_user_id, product_id, quantity, unit_price, sales_order_id, created_at) VALUES
  ('$IA','$U','7d000000-0000-0000-0000-0000000000a1',2,10,'$PA', now()),
  ('$IB','$U','7d000000-0000-0000-0000-0000000000b1',3,20,'$PA', now()),
  -- pai CANCELADO  → fora do Apriori, DENTRO do cockpit (a régua de faturabilidade é do consumidor)
  ('11111111-0000-0000-0000-0000000000c1','$U','7d000000-0000-0000-0000-0000000000c1',1,5,'cccccccc-cccc-cccc-cccc-cccccccccccc', now()),
  -- pai SOFT-DELETADO → fora do Apriori, dentro do cockpit
  ('22222222-0000-0000-0000-0000000000d1','$U','7d000000-0000-0000-0000-0000000000d1',1,5,'dddddddd-dddd-dddd-dddd-dddddddddddd', now()),
  -- SEM product_id → fora do Apriori (pai válido), dentro do cockpit
  ('33333333-0000-0000-0000-0000000000e1','$U',NULL,1,5,'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee', now()),
  -- created_at ANTIGO e sem product_id → fora dos DOIS (prova o prefiltro de carga do cockpit)
  ('44444444-0000-0000-0000-0000000000f1','$U',NULL,1,5,'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', now() - interval '500 days');
SQL

DENY="ARRAY['cancelado','rascunho','pendente','orcamento']"
# Conta os itens do PEDIDO ALVO dentro do snapshot — é "quantos irmãos da cesta vieram".
ALVO_APRIORI="SELECT count(*) FROM jsonb_array_elements(public.apriori_universo_snapshot($DENY)->'itens') e WHERE e->>'sales_order_id' = '$PA'"

echo "── asserts: contrato do snapshot ──"
eq "A1 Apriori: total do universo" \
   "$(Pq -c "SELECT public.apriori_universo_snapshot($DENY)->>'total';")" "2"
eq "A2 Apriori: 'total' bate com o tamanho REAL do array (guard de transporte)" \
   "$(Pq -c "SELECT (public.apriori_universo_snapshot($DENY)->>'total')::int = jsonb_array_length(public.apriori_universo_snapshot($DENY)->'itens');")" "t"
eq "A3 Apriori: pai cancelado/soft-deletado e item sem product_id ficam FORA" \
   "$(Pq -c "SELECT count(*) FROM jsonb_array_elements(public.apriori_universo_snapshot($DENY)->'itens') e WHERE e->'sales_orders'->>'account' <> 'oben';")" "0"
eq "A4 Apriori: ordem DETERMINÍSTICA (duas chamadas, mesmo array)" \
   "$(Pq -c "SELECT public.apriori_universo_snapshot($DENY)->'itens' = public.apriori_universo_snapshot($DENY)->'itens';")" "t"
eq "A5 cockpit: prefiltro de carga exclui o item antigo (6 itens na tabela, 5 na janela)" \
   "$(Pq -c "SELECT public.cockpit_itens_snapshot(now() - interval '400 days')->>'total';")" "5"
eq "A6 cockpit: NÃO filtra status — o pai cancelado VEM (a régua é do consumidor)" \
   "$(Pq -c "SELECT count(*) FROM jsonb_array_elements(public.cockpit_itens_snapshot(now() - interval '400 days')->'itens') e WHERE e->'sales_orders'->>'status' = 'cancelado';")" "1"
eq "A7 cockpit: o pai vem embedado com as 6 colunas que o cálculo usa" \
   "$(Pq -c "SELECT count(*) FROM jsonb_array_elements(public.cockpit_itens_snapshot(now() - interval '400 days')->'itens') e WHERE e->'sales_orders' ?& array['status','deleted_at','order_date_kpi','account','origem','checkout_id'];")" "5"

echo "── asserts: fail-closed (SQLSTATE esperada, resto RE-LANÇADO) ──"
# Sentinela anti-teatro: 'SENTINELA_SEM_DENTE' NÃO aparece no corpo da migration — se aparecesse,
# um assert que casasse texto casaria a própria sentinela e mentiria.
neg() { # neg "<descrição>" "<chamada SQL>" "<sqlstate esperada>" ["<prefixo SQL>"]
  if P -q -c "${4:-} DO \$t\$ BEGIN PERFORM $2; RAISE EXCEPTION 'SENTINELA_SEM_DENTE: aceitou entrada inválida' USING ERRCODE='P0001'; EXCEPTION WHEN sqlstate '$3' THEN NULL; WHEN OTHERS THEN RAISE; END \$t\$;" >/dev/null 2>&1
  then ok "$1 (rejeitado com $3)"; else bad "$1 — NÃO lançou $3"; fi
}
neg "B1 denylist NULL"                "public.apriori_universo_snapshot(NULL)"            "22023"
neg "B2 denylist VAZIA"               "public.apriori_universo_snapshot(ARRAY[]::text[])" "22023"
neg "B3 denylist com NULL dentro"     "public.apriori_universo_snapshot(ARRAY['cancelado',NULL])" "22023"
neg "B4 teto de bytes <= 0"           "public.apriori_universo_snapshot($DENY, 250000, 0)"        "22023"
neg "B5 teto ESTOURADO (não trunca)"  "public.apriori_universo_snapshot($DENY, 250000, 10)"       "54000"
neg "B6 cockpit sem prefiltro de carga" "public.cockpit_itens_snapshot(NULL)"             "22023"
neg "B7 teto de LINHAS estourado"     "public.apriori_universo_snapshot($DENY, 1)"        "54000"
# B8 é o buraco que o challenge Codex achou: uma denylist SINTATICAMENTE válida (não-vazia, sem
# NULL) mas que OMITE `cancelado` passaria por qualquer checagem de forma e produziria um universo
# com pedido cancelado dentro — regra de associação publicada sobre o que não é venda, sem erro.
neg "B8 denylist DIVERGENTE da canônica (sem 'cancelado')" "public.apriori_universo_snapshot(ARRAY['rascunho','pendente','orcamento'])" "22023"
# B9 é o contrapeso de B8: a validação tem de ser por CONJUNTO, não por sequência — senão ela
# vira uma armadilha que quebra a leitura quando alguém só reordena a lista no TS.
eq "B9 denylist canônica fora de ordem e com repetição é ACEITA (conjunto, não sequência)" \
   "$(Pq -c "SELECT public.apriori_universo_snapshot(ARRAY['orcamento','cancelado','pendente','rascunho','cancelado'])->>'total';")" "2"

echo "── asserts: autorização (REVOKE nomeando as roles) ──"
# ⚠️ As tabelas recebem SELECT para as TRÊS roles de propósito. Sem isso o teste passa pelo motivo
# ERRADO: `anon` seria barrado por não enxergar `order_items`, e o assert diria "o REVOKE funciona"
# sem nunca ter exercitado o REVOKE. Concedendo o acesso às tabelas, o ÚNICO obstáculo que resta é
# o `REVOKE EXECUTE` da função — que é o que se quer provar. (Em prod `service_role` tem SELECT nas
# duas, `authenticated` só em `order_items`; aqui o teste é MAIS permissivo que prod de propósito.)
P -q -c "GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;
         GRANT SELECT ON public.order_items, public.sales_orders TO anon, authenticated, service_role;"
for R in anon authenticated; do
  neg "C1 $R barrado pelo REVOKE EXECUTE (e não por falta de SELECT)" \
      "public.apriori_universo_snapshot($DENY)" "42501" "SET ROLE $R;"
done
eq "C2 service_role executa" \
   "$(Pq -c "SET ROLE service_role; SELECT public.apriori_universo_snapshot($DENY)->>'total';" | tail -1)" "2"

echo "── D1: o CENÁRIO tem dente? a leitura PAGINADA rasga a cesta (determinístico) ──"
# Emula fielmente `fetchAllKeyset` com página de 1 linha: statement por página, filtro do pai
# aplicado no JOIN (o que o `sales_orders!inner` faz), writer atuando ENTRE as páginas.
PAG1=$(Pq -c "SELECT oi.id::text FROM public.order_items oi JOIN public.sales_orders so ON so.id=oi.sales_order_id
              WHERE oi.product_id IS NOT NULL AND so.deleted_at IS NULL AND so.status <> ALL ($DENY)
              ORDER BY oi.id LIMIT 1;")
P -q -c "UPDATE public.sales_orders SET status='cancelado' WHERE id='$PA';"   # writer real: sync-reprocess
PAG2=$(Pq -c "SELECT count(*) FROM (
                SELECT oi.id FROM public.order_items oi JOIN public.sales_orders so ON so.id=oi.sales_order_id
                WHERE oi.product_id IS NOT NULL AND so.deleted_at IS NULL AND so.status <> ALL ($DENY)
                  AND oi.id > '$PAG1'::uuid ORDER BY oi.id LIMIT 1) pagina2;")
eq "D1 paginado: 1ª página trouxe o irmão IA" "$PAG1" "$IA"
eq "D1 paginado: CESTA RASGADA — o irmão IB some da 2ª página (1 de 2)" "$PAG2" "0"

echo "── D2a: a RPC nunca devolve cesta PARCIAL (determinístico) ──"
eq "D2a com o pai já cancelado: a cesta some INTEIRA (0 de 2), nunca 1" \
   "$(Pq -c "$ALVO_APRIORI;")" "0"
P -q -c "UPDATE public.sales_orders SET status='faturado' WHERE id='$PA';"    # restaura o alvo
eq "D2a com o pai vivo: a cesta vem INTEIRA (2 de 2)" \
   "$(Pq -c "$ALVO_APRIORI;")" "2"

# ══════════════════════════════════════════════════════════════════════════════════════════
# D2b — ATOMICIDADE SOB ESCRITA CONCORRENTE (corrida REAL)
# ══════════════════════════════════════════════════════════════════════════════════════════
# D1/D2a são determinísticos e provam a FORMA (a paginação rasga; a RPC nunca devolve parcial).
# Falta o caso que dói de verdade: o writer commitando ENQUANTO a leitura roda. Isso exige
# corrida — e corrida exige antídoto contra falso-verde: se o commit do writer NÃO cair dentro
# da janela de execução da RPC, o teste FALHA por "cenário sem dente", em vez de passar de graça.
echo "── D2b: seed de ruído (para a leitura durar o suficiente) ──"
P -q <<SQL
INSERT INTO public.sales_orders (id, customer_user_id, status, account, origem, order_date_kpi)
SELECT gen_random_uuid(), '$U', 'faturado', 'oben', 'ruido', '2026-08-01'
FROM generate_series(1, 70000);
INSERT INTO public.order_items (id, customer_user_id, product_id, quantity, unit_price, sales_order_id, created_at)
SELECT gen_random_uuid(), '$U', gen_random_uuid(), 1, 10, so.id, now()
FROM public.sales_orders so, generate_series(1, 2) WHERE so.origem = 'ruido';
SQL
# 70.000 pedidos x 2 itens + os 4 itens com product_id do universo pequeno (IA, IB, IC, ID).
# O tamanho do ruído é limitado pelo TETO ABSOLUTO de 32 MiB — a ~151 bytes por item medidos aqui,
# 140 mil itens dão ~21 MB e cabem; 250 mil davam 37,7 MB e o fusível LANÇAVA, corretamente.
eq "D2b seed: universo de ruído carregado" \
   "$(Pq -c "SELECT count(*) FROM public.order_items WHERE product_id IS NOT NULL;")" "140004"

TETO=33554432       # tetos folgados só para o ruído do teste caber —
TETO_LINHAS=400000  # os de produção são os defaults (250k linhas / 24 MiB)
CORRIDA_OUT="$(mktemp "/tmp/corrida-${SLUG}.XXXXXX")"
WRITER_OUT="$(mktemp "/tmp/writer-${SLUG}.XXXXXX")"

# Roda a leitura sob um writer que cancela o pai do meio da execução. Ecoa "N=<irmãos> DUR=<s>
# SOBREP=<SIM|NAO>". O chamador decide o que exigir.
corrida() { # corrida <sleep_do_writer>
  P -q -c "UPDATE public.sales_orders SET status='faturado' WHERE id='$PA';"
  ( sleep "$1"
    P -tA >"$WRITER_OUT" 2>&1 <<SQL
UPDATE public.sales_orders SET status='cancelado' WHERE id='$PA';
SELECT 'TW=' || clock_timestamp()::text;
SQL
  ) &
  WPID=$!
  P -tA >"$CORRIDA_OUT" 2>&1 <<SQL
SELECT 'T0=' || clock_timestamp()::text;
SELECT 'N=' || (SELECT count(*) FROM jsonb_array_elements(public.apriori_universo_snapshot($DENY, $TETO_LINHAS, $TETO)->'itens') e WHERE e->>'sales_order_id' = '$PA');
SELECT 'T1=' || clock_timestamp()::text;
SQL
  wait "$WPID"
  T0=$(sed -n 's/^T0=//p' "$CORRIDA_OUT"); T1=$(sed -n 's/^T1=//p' "$CORRIDA_OUT")
  N=$(sed -n 's/^N=//p' "$CORRIDA_OUT");  TW=$(sed -n 's/^TW=//p' "$WRITER_OUT")
  if [ -z "$T0" ] || [ -z "$T1" ] || [ -z "$TW" ] || [ -z "$N" ]; then
    echo "N=? DUR=? SOBREP=ERRO"; return
  fi
  Pq -c "SELECT 'N=$N DUR=' || round(extract(epoch from ('$T1'::timestamptz - '$T0'::timestamptz))::numeric, 2)
              || ' SOBREP=' || CASE WHEN '$T0'::timestamptz < '$TW'::timestamptz
                                     AND '$TW'::timestamptz < '$T1'::timestamptz THEN 'SIM' ELSE 'NAO' END;"
}

R=$(corrida 0.4)
echo "     [$R]"
case "$R" in
  *SOBREP=SIM*) ok "D2b cenário TEM dente: o commit do writer caiu DENTRO da execução da RPC ($R)" ;;
  *) bad "D2b cenário SEM dente: o writer não commitou durante a leitura ($R) — aumente o ruído ou reduza o sleep" ;;
esac
eq "D2b a cesta veio INTEIRA sob writer concorrente (2 de 2, jamais 1)" "${R%% *}" "N=2"

# ══════════════════════════════════════════════════════════════════════════════════════════
# E1 — A GARANTIA É ESTRUTURAL, NÃO DO QUALIFICADOR
# ══════════════════════════════════════════════════════════════════════════════════════════
# Falsifica a hipótese "isto só funciona porque a função é STABLE". Aplica a migration REAL com
# uma única troca — STABLE → VOLATILE — e repete a corrida. Se o resultado continuar correto, a
# atomicidade vem da QUERY ÚNICA, e não de um qualificador que um `CREATE OR REPLACE` futuro
# apagaria em silêncio (a armadilha do `security_invoker` do CLAUDE.md, por outra porta).
echo "── E1: mesma função marcada VOLATILE ──"
VOLAT="$(mktemp "/tmp/volatile-${SLUG}.XXXXXX")"
sed 's/^STABLE$/VOLATILE/' "$MIG" > "$VOLAT"
eq "E1 sabotagem aplicada: as duas funções viraram VOLATILE" \
   "$(grep -c '^VOLATILE$' "$VOLAT")" "2"
P -q -f "$VOLAT"
RV=$(corrida 0.4)
echo "     [$RV]"
case "$RV" in
  *SOBREP=SIM*) eq "E1 VOLATILE: a cesta SEGUE inteira — a garantia é da query única" "${RV%% *}" "N=2" ;;
  *) bad "E1 cenário sem sobreposição ($RV) — inconclusivo, não conta como prova" ;;
esac
P -q -f "$MIG"   # restaura a versão verdadeira

# ══════════════════════════════════════════════════════════════════════════════════════════
# ZONA 5 — FALSIFICAÇÃO (Lei #3)
# ══════════════════════════════════════════════════════════════════════════════════════════
echo "── F3: sabota a ATOMICIDADE (duas queries) e exige que a cesta RASGUE ──"
# A sabotagem é a própria alternativa que este desenho recusa: a função lê o universo em DUAS
# queries (como duas páginas). O `pg_sleep` entre elas só torna a janela determinística — o
# defeito é a segunda query pegar um snapshot NOVO, que é o que acontece em toda leitura paginada.
P -q <<SQL
CREATE OR REPLACE FUNCTION public.apriori_universo_snapshot(
  p_status_nao_venda text[], p_teto_linhas integer DEFAULT 250000, p_teto_bytes bigint DEFAULT 25165824
) RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY INVOKER SET search_path = public, pg_temp
AS \$sab\$
DECLARE a jsonb; b jsonb;
BEGIN
  SELECT coalesce(jsonb_agg(jsonb_build_object('sales_order_id', t.sales_order_id, 'product_id', t.product_id,
                                               'sales_orders', jsonb_build_object('account', t.account))), '[]'::jsonb)
    INTO a FROM (SELECT oi.sales_order_id, oi.product_id, so.account FROM public.order_items oi
                 JOIN public.sales_orders so ON so.id = oi.sales_order_id
                 WHERE oi.product_id IS NOT NULL AND so.deleted_at IS NULL
                   AND so.status <> ALL (p_status_nao_venda)
                   AND oi.id <= '7fffffff-ffff-ffff-ffff-ffffffffffff'::uuid) t;
  PERFORM pg_sleep(1.2);
  SELECT coalesce(jsonb_agg(jsonb_build_object('sales_order_id', t.sales_order_id, 'product_id', t.product_id,
                                               'sales_orders', jsonb_build_object('account', t.account))), '[]'::jsonb)
    INTO b FROM (SELECT oi.sales_order_id, oi.product_id, so.account FROM public.order_items oi
                 JOIN public.sales_orders so ON so.id = oi.sales_order_id
                 WHERE oi.product_id IS NOT NULL AND so.deleted_at IS NULL
                   AND so.status <> ALL (p_status_nao_venda)
                   AND oi.id > '7fffffff-ffff-ffff-ffff-ffffffffffff'::uuid) t;
  RETURN jsonb_build_object('total', jsonb_array_length(a || b), 'bytes_itens', 0, 'itens', a || b);
END \$sab\$;
SQL
RS=$(corrida 0.4)
echo "     [$RS]"
eq "F3 sabotada em DUAS queries: a cesta RASGA (1 de 2) — o cenário tem dente" "${RS%% *}" "N=1"
P -q -f "$MIG"   # restaura
# O ruído sai de cena aqui: ele existe só para dar DURAÇÃO à corrida, e os asserts abaixo chamam a
# função com os tetos de PRODUÇÃO — sob 140 mil itens eles bateriam no fusível de teto em vez de
# exercitar o guard que se quer falsificar (foi o que aconteceu na primeira execução deste harness).
P -q -c "DELETE FROM public.order_items WHERE sales_order_id IN (SELECT id FROM public.sales_orders WHERE origem='ruido');
         DELETE FROM public.sales_orders WHERE origem = 'ruido';
         UPDATE public.sales_orders SET status='faturado' WHERE id='$PA';"
eq "F3 restaurada: a cesta volta a vir inteira" "$(Pq -c "$ALVO_APRIORI;")" "2"

echo "── F1/F2: sabota os guards fail-closed e exige que os asserts B fiquem VERMELHOS ──"
# ⚠️ UMA SABOTAGEM POR ARQUIVO. Juntar as duas num `sed` só já reprovou este harness: a inversão do
# comparador (F1) faz a denylist CANÔNICA passar a ser rejeitada, e aí a chamada de F2 — que usa a
# canônica — falhava na validação em vez de chegar ao guard de bytes. O assert acusou "o teto seguiu
# barrando", que é um diagnóstico que aponta para o lugar errado. Sabotagem que contamina o assert
# vizinho não prova o assert vizinho.
FURADA="$(mktemp "/tmp/furada-${SLUG}.XXXXXX")"
FURADA2="$(mktemp "/tmp/furada2-${SLUG}.XXXXXX")"
sed 's/IS DISTINCT FROM/IS NOT DISTINCT FROM/' "$MIG" > "$FURADA"
sed 's/IF v_bytes > v_teto_bytes THEN/IF false THEN/'  "$MIG" > "$FURADA2"
eq "F1 sabotagem aplicada: o comparador da denylist foi invertido" \
   "$(command grep -c 'IS NOT DISTINCT FROM' "$FURADA")" "1"
eq "F2 sabotagem aplicada: os dois guards de bytes foram neutralizados" \
   "$(command grep -c 'IF false THEN' "$FURADA2")" "2"
P -q -f "$FURADA"
if P -q -c "SELECT public.apriori_universo_snapshot(ARRAY['rascunho','pendente','orcamento']);" >/dev/null 2>&1
then ok "F1 com o comparador invertido, a denylist DIVERGENTE passa — o assert B8 tem dente"
else bad "F1 a denylist divergente seguiu rejeitada mesmo com o comparador invertido — B8 não prova nada"; fi
P -q -f "$FURADA2"
if P -q -c "SELECT public.apriori_universo_snapshot($DENY, 250000, 10);" >/dev/null 2>&1
then ok "F2 sem o guard, o teto de 10 bytes NÃO barra — o assert B5 tem dente"
else bad "F2 o teto seguiu barrando mesmo sem o guard — B5 não prova o teto"; fi
P -q -f "$MIG"   # restaura a versão verdadeira
eq "F1/F2 restauradas: a denylist divergente volta a ser rejeitada" \
   "$(P -q -c "SELECT public.apriori_universo_snapshot(ARRAY['rascunho','pendente','orcamento']);" >/dev/null 2>&1 && echo PASSOU || echo REJEITADA)" "REJEITADA"

# ── veredito ──
echo "──────────────────────────────"
echo "RESULTADO: $PASS ok / $FAIL fail"
[ "$FAIL" = "0" ] || { echo "❌ HARNESS VERMELHO"; exit 1; }
echo "✅ HARNESS VERDE"
