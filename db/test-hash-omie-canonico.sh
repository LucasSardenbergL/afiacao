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
PORT="${PGPORT_TEST:-5471}"     # mude se rodar em paralelo com outro harness (40 worktrees)
SLUG="hash-omie-canonico"
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

echo "═══ setup pronto (PG17 :$PORT) ═══"

# ══════════════════════════════════════════════════════════════════════════════
# Helper de SQLSTATE (Lei #2): devolve a SQLSTATE do comando, ou 00000 se passou.
# Não engole nada — um erro DIFERENTE do esperado volta com o CÓDIGO DELE e o eq
# reprova nomeando-o. A sentinela ('23514') não aparece no texto que o CHECK emite.
# ══════════════════════════════════════════════════════════════════════════════
P -q <<'SQL'
CREATE OR REPLACE FUNCTION public.tentar(cmd text) RETURNS text
LANGUAGE plpgsql AS $f$
BEGIN
  EXECUTE cmd;
  RETURN '00000';
EXCEPTION WHEN OTHERS THEN
  RETURN SQLSTATE;
END $f$;
SQL

# ══════════════════════════════════════════════════════════════════════════════
# ZONA 1 — PRÉ-REQUISITOS. Stub de sales_orders com os tipos REAIS das 3 colunas que
# o CHECK lê, conferidos no information_schema da PROD (2026-08-29):
#   account bigint→NÃO: account text NOT NULL · hash_payload text NULL · omie_pedido_id bigint NULL
# `account NOT NULL` é material, não cosmético: se fosse NULL-able, a concatenação viraria
# NULL e o CHECK avaliaria NULL — e CHECK que avalia NULL PASSA (fresta fail-open silenciosa).
# ══════════════════════════════════════════════════════════════════════════════
P -q <<'SQL'
CREATE TABLE public.sales_orders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account text NOT NULL,
  hash_payload text,
  omie_pedido_id bigint,
  status text NOT NULL DEFAULT 'rascunho'
);
-- espelha o índice parcial de identidade da PROD (uniq_sales_orders_omie_hash): é ele que
-- transforma o hash corrompido em 23505 e faz o ON CONFLICT sumir com o pedido original.
CREATE UNIQUE INDEX uniq_sales_orders_omie_hash
  ON public.sales_orders (account, hash_payload) WHERE hash_payload LIKE 'omie\_%';
SQL

# ── ACERVO PRÉ-EXISTENTE: semeado ANTES da migration, para provar que ela ENTRA sem quebrar
#    linha existente (é o que o pré-voo mediu na PROD: 31.086 pull, 0 violando).
P -q <<'SQL'
INSERT INTO public.sales_orders (account, hash_payload, omie_pedido_id, status) VALUES
  ('oben',    'omie_oben_42',    42,   'faturado'),
  ('colacor', 'omie_colacor_77', 77,   'importado'),
  (E'oben',    NULL,              4242, 'enviado'),     -- push JA enviada (as 26 da PROD)
  ('oben',    NULL,              NULL, 'rascunho'),     -- push virgem
  ('oben',    'checkout_abc123', NULL, 'orcamento');    -- hash de OUTRA origem
SQL

# ══════════════════════════════════════════════════════════════════════════════
# ZONA 2 — APLICAR A MIGRATION REAL (Lei #1)
# ══════════════════════════════════════════════════════════════════════════════
MIG="$REPO_ROOT/supabase/migrations/20260829081556_sales_orders_hash_omie_canonico.sql"
P -q -f "$MIG"
echo "migration aplicada: $(basename "$MIG")"
echo

# a própria aplicação sobre o acervo JÁ é um assert: se alguma das 5 linhas violasse,
# o ADD CONSTRAINT teria abortado acima (set -e) e o harness morreria aqui.
ok "migration ENTRA sobre acervo pré-existente (pull canônica + push + hash de outra origem)"
eq "constraint existe e está VALIDADA" \
   "$(Pq -c "SELECT convalidated FROM pg_constraint WHERE conname='sales_orders_hash_omie_canonico';")" "t"
eq "re-aplicar a migration é idempotente (DO guardado)" \
   "$(Pq -c "SELECT public.tentar('SET search_path=public');" >/dev/null; P -q -f "$MIG" >/dev/null 2>&1 && echo ok || echo falhou)" "ok"

# ══════════════════════════════════════════════════════════════════════════════
# ZONA 3 — ASSERTS
# ══════════════════════════════════════════════════════════════════════════════
INS="INSERT INTO public.sales_orders (account, hash_payload, omie_pedido_id) VALUES"

echo "── POSITIVOS: o que DEVE passar (precisão > recall — o CHECK não legisla fora do namespace omie_)"
eq "P1 pull canônica nova (omie_oben_99 / pid 99)" \
   "$(Pq -c "SELECT public.tentar(\$q\$$INS ('oben','omie_oben_99',99)\$q\$);")" "00000"
eq "P2 push virgem (hash NULL, pid NULL)" \
   "$(Pq -c "SELECT public.tentar(\$q\$$INS ('oben',NULL,NULL)\$q\$);")" "00000"
eq "P3 push JÁ enviada (hash NULL, pid preenchido) — as 26 linhas da PROD" \
   "$(Pq -c "SELECT public.tentar(\$q\$$INS ('colacor',NULL,5555)\$q\$);")" "00000"
eq "P4 hash de OUTRA origem (checkout_*) com pid NULL" \
   "$(Pq -c "SELECT public.tentar(\$q\$$INS ('oben','checkout_zzz',NULL)\$q\$);")" "00000"
eq "P5 hash que CONTÉM 'omie_' mas não COMEÇA com ele (LIKE ancorado)" \
   "$(Pq -c "SELECT public.tentar(\$q\$$INS ('oben','checkout_omie_oben_1',NULL)\$q\$);")" "00000"
eq "P6 conta com underscore no nome (colacor_sc) é canônica" \
   "$(Pq -c "SELECT public.tentar(\$q\$$INS ('colacor_sc','omie_colacor_sc_7',7)\$q\$);")" "00000"

echo
echo "── NEGATIVOS: 23514 (check_violation). SQLSTATE exata — erro DIFERENTE volta com o código dele."
eq "N1 [DEFEITO CENTRAL] write-back do reenvio grava pid NOVO sobre hash VELHO (omie_oben_42 → pid 43)" \
   "$(Pq -c "SELECT public.tentar(\$q\$UPDATE public.sales_orders SET omie_pedido_id=43 WHERE hash_payload='omie_oben_42'\$q\$);")" "23514"
eq "N2 linha pull SEM pid (hash omie_* com omie_pedido_id NULL)" \
   "$(Pq -c "SELECT public.tentar(\$q\$$INS ('oben','omie_oben_500',NULL)\$q\$);")" "23514"
eq "N3 hash da conta ERRADA (omie_colacor_* gravado em account 'oben')" \
   "$(Pq -c "SELECT public.tentar(\$q\$$INS ('oben','omie_colacor_800',800)\$q\$);")" "23514"
eq "N4 pid divergente do hash já no INSERT (omie_oben_900 / pid 901)" \
   "$(Pq -c "SELECT public.tentar(\$q\$$INS ('oben','omie_oben_900',901)\$q\$);")" "23514"
eq "N5 UPDATE que reescreve o HASH deixando o pid para trás" \
   "$(Pq -c "SELECT public.tentar(\$q\$UPDATE public.sales_orders SET hash_payload='omie_oben_1' WHERE hash_payload='omie_colacor_77'\$q\$);")" "23514"

echo
echo "── A CADEIA QUE O CHECK CORTA: sem ele, o hash corrompido faz o pedido original SUMIR."
# Prova o elo: se o hash pudesse mentir, o sync do pedido 42 bateria 23505 no índice de
# identidade — e o ON CONFLICT DO NOTHING da RPC transformaria isso em no-op silencioso.
eq "elo: re-inserir o hash omie_oben_42 bate 23505 no índice de identidade" \
   "$(Pq -c "SELECT public.tentar(\$q\$$INS ('oben','omie_oben_42',42)\$q\$);")" "23505"

# ══════════════════════════════════════════════════════════════════════════════
# ZONA 4 — FALSIFICAÇÃO (Lei #3): sabota o CHECK, exige que o assert fique VERMELHO,
# restaura. Sem isto, um assert que nunca poderia falhar passaria por prova.
# ══════════════════════════════════════════════════════════════════════════════
echo
echo "═══ FALSIFICAÇÃO ═══"
DROP="ALTER TABLE public.sales_orders DROP CONSTRAINT sales_orders_hash_omie_canonico"
restaurar() { P -q -c "$DROP" >/dev/null 2>&1 || true; P -q -f "$MIG" >/dev/null; }
# assert-de-falsificação: o negativo tem de PARAR de morder (voltar a 00000).
morde_menos() { if [ "$2" = "00000" ]; then ok "F$1 sabotagem soltou o assert (dente confirmado)"; else bad "F$1 SEM DENTE — sabotei e o assert seguiu [$2]: ele não estava provando isto"; fi; }

echo "F1 — CHECK sem a cláusula de CANONICIDADE (só exige pid não-nulo)"
P -q -c "$DROP" >/dev/null
P -q -c "ALTER TABLE public.sales_orders ADD CONSTRAINT sales_orders_hash_omie_canonico CHECK (hash_payload IS NULL OR hash_payload NOT LIKE 'omie\_%' OR omie_pedido_id IS NOT NULL)" >/dev/null
morde_menos 1a "$(Pq -c "SELECT public.tentar(\$q\$UPDATE public.sales_orders SET omie_pedido_id=43 WHERE hash_payload='omie_oben_42'\$q\$);")"
morde_menos 1b "$(Pq -c "SELECT public.tentar(\$q\$$INS ('oben','omie_colacor_801',801)\$q\$);")"
P -q -c "UPDATE public.sales_orders SET omie_pedido_id=42 WHERE hash_payload='omie_oben_42'" >/dev/null
P -q -c "DELETE FROM public.sales_orders WHERE hash_payload='omie_colacor_801'" >/dev/null
restaurar

echo "F2 — CHECK sem a exigência de pid não-nulo"
P -q -c "$DROP" >/dev/null
P -q -c "ALTER TABLE public.sales_orders ADD CONSTRAINT sales_orders_hash_omie_canonico CHECK (hash_payload IS NULL OR hash_payload NOT LIKE 'omie\_%' OR hash_payload = 'omie_' || account || '_' || omie_pedido_id::text)" >/dev/null
morde_menos 2 "$(Pq -c "SELECT public.tentar(\$q\$$INS ('oben','omie_oben_501',NULL)\$q\$);")"
P -q -c "DELETE FROM public.sales_orders WHERE hash_payload='omie_oben_501'" >/dev/null
restaurar

echo "F3 — LIKE DESANCORADO ('%omie\_%'): o CHECK passa a legislar sobre hash que não é dele"
DESANC="CHECK (hash_payload IS NULL OR hash_payload NOT LIKE '%omie\_%' OR (omie_pedido_id IS NOT NULL AND hash_payload = 'omie_' || account || '_' || omie_pedido_id::text))"
P -q -c "$DROP" >/dev/null
# F3a — o desancorado nem ENTRA: o `checkout_omie_oben_1` do P5 (linha legítima) já o viola.
# Efeito não previsto quando escrevi o F3; é a prova mais forte do que a âncora protege.
eq "F3a desancorar nem APLICA sobre o acervo (linha checkout_* legítima viola)" \
   "$(Pq -c "SELECT public.tentar(\$q\$ALTER TABLE public.sales_orders ADD CONSTRAINT sales_orders_hash_omie_canonico $DESANC\$q\$);")" "23514"
# F3b — mesmo NOT VALID (que ignora o acervo), ele reprova a PRÓXIMA linha legítima.
P -q -c "ALTER TABLE public.sales_orders ADD CONSTRAINT sales_orders_hash_omie_canonico $DESANC NOT VALID" >/dev/null
FS3="$(Pq -c "SELECT public.tentar(\$q\$$INS ('oben','checkout_omie_oben_2',NULL)\$q\$);")"
if [ "$FS3" = "23514" ]; then ok "F3b desancorar REPROVA linha legítima nova (P5 tem dente)"; else bad "F3b SEM DENTE — desancorei e o checkout_ passou [$FS3]"; fi
restaurar

echo "F4 — constraint presente porém NOT VALID: a POSTCONDIÇÃO da migration tem de RECUSAR"
P -q -c "$DROP" >/dev/null
P -q -c "ALTER TABLE public.sales_orders ADD CONSTRAINT sales_orders_hash_omie_canonico CHECK (hash_payload IS NULL OR hash_payload NOT LIKE 'omie\_%' OR (omie_pedido_id IS NOT NULL AND hash_payload = 'omie_' || account || '_' || omie_pedido_id::text)) NOT VALID" >/dev/null
if P -q -f "$MIG" >/dev/null 2>&1; then bad "F4 SEM DENTE — a migration aceitou uma constraint NOT VALID como aplicada"; else ok "F4 postcondição recusa constraint NAO validada ('existe' != 'vale')"; fi
restaurar

echo
echo "═══ VERDE DE VOLTA (migration verdadeira restaurada) ═══"
eq "R1 negativo central volta a morder" \
   "$(Pq -c "SELECT public.tentar(\$q\$UPDATE public.sales_orders SET omie_pedido_id=44 WHERE hash_payload='omie_oben_42'\$q\$);")" "23514"
eq "R2 positivo segue passando" \
   "$(Pq -c "SELECT public.tentar(\$q\$$INS ('oben','checkout_final',NULL)\$q\$);")" "00000"

echo
echo "═══ $PASS ok · $FAIL falhas ═══"
[ "$FAIL" -eq 0 ]
