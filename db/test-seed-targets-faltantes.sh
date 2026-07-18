#!/usr/bin/env bash
# ╔══════════════════════════════════════════════════════════════════════════════════╗
# ║  PROVA PG17 — seed_targets_faltantes() (anti-ressurreição no SEED, money-path)     ║
# ║  Migrations:  20260621120000_seed_targets_faltantes_rpc.sql      (v1, espelho)     ║
# ║               20260718220100_seed_targets_faltantes_ledger.sql   (v2, LEDGER)      ║
# ║  Rode:  bash db/test-seed-targets-faltantes.sh > /tmp/t.log 2>&1; echo $?          ║
# ║                                                                                    ║
# ║  v1 provou que a RPC retorna SÓ quem é seguro semear (fonte − fcs − flaggeds) e    ║
# ║  FALSIFICA: sem o filtro de flaggeds, o fornecedor excluído RESSUSCITA.            ║
# ║                                                                                    ║
# ║  v2 (P0-B-bis Fatia 5) troca a FONTE do universo — omie_clientes → o acumulador    ║
# ║  carteira_membership_ledger — e acrescenta a prova que AUTORIZA o DROP:            ║
# ║    B1 ⭐ NENHUM alvo se perde na troca ("só-no-espelho = 0" — o critério de aceite  ║
# ║          REAL; contagem IGUAL seria o critério ERRADO: o ledger é SUPERSET)        ║
# ║    B4 ⭐ a RPC sobrevive ao `DROP TABLE omie_clientes`                              ║
# ║    F3 ⭐ a versão v1 NÃO sobrevive ao mesmo DROP (senão B4 não provaria nada)       ║
# ║    F4 ⭐ filtrar identity_state (o erro tentador) ENCOLHERIA o universo             ║
# ╚══════════════════════════════════════════════════════════════════════════════════╝
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PGVER=17
PGBIN="/opt/homebrew/opt/postgresql@${PGVER}/bin"
PORT="${PGPORT_TEST:-5457}"
SLUG="seed-targets"
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
# ZONA 1 — pré-requisitos. O ledger espelha a PROD (psql-ro 2026-07-18): user_id é
#   PRIMARY KEY (⇒ duplicata estruturalmente impossível, ≠ o espelho, que tinha 1
#   linha por (user_id, empresa_omie)) e o CHECK de identity_state é o real.
# ══════════════════════════════════════════════════════════════════════════════
P -q <<'SQL'
-- fonte ANTIGA (v1) — mantida no harness p/ provar a paridade B1 e a falsificação F3
CREATE TABLE public.omie_clientes (
  user_id      uuid,
  empresa_omie text DEFAULT 'colacor'
);
-- fonte NOVA (v2)
CREATE TABLE public.carteira_membership_ledger (
  user_id        uuid PRIMARY KEY,
  identity_state text NOT NULL DEFAULT 'verified'
                 CHECK (identity_state IN ('verified','ambiguous','inactive','conflict')),
  first_seen_at  timestamptz NOT NULL DEFAULT now(),
  source         text CHECK (source IN ('backfill','trigger','rpc','sync')),
  updated_at     timestamptz DEFAULT now()
);
CREATE TABLE public.farmer_client_scores (
  customer_user_id uuid
);
CREATE TABLE public.cliente_classificacao (
  user_id             uuid PRIMARY KEY,
  excluir_da_carteira boolean NOT NULL DEFAULT false
);
SQL

# ══════════════════════════════════════════════════════════════════════════════
# ZONA 2 — aplicar as migrations REAIS, em ordem (Lei #1). Aplicar a v1 antes da v2
#   também prova que o CREATE OR REPLACE da v2 substitui de fato o corpo anterior.
# ══════════════════════════════════════════════════════════════════════════════
MIG_V1="$REPO_ROOT/supabase/migrations/20260621120000_seed_targets_faltantes_rpc.sql"
MIG="$REPO_ROOT/supabase/migrations/20260718220100_seed_targets_faltantes_ledger.sql"

# As migrations trazem blocos de VALIDAÇÃO pro SQL Editor (chamam a RPC / leem catálogo) —
# ruído aqui. Corta no primeiro REVOKE (fim do bloco funcional).
TMPD="$(dirname "$DATA")"
cut_func() { awk '/^CREATE OR REPLACE FUNCTION/{f=1} f{print} /^GRANT EXECUTE/{if(f) exit}' "$1"; }
cut_func "$MIG_V1" > "$TMPD/v1.sql"; cut_func "$MIG" > "$TMPD/v2.sql"

P -q -f "$TMPD/v1.sql"
echo "v1 aplicada (fonte = omie_clientes)"

# ══════════════════════════════════════════════════════════════════════════════
# ZONA 3 — seed dos cenários + grant p/ service_role (espelha o admin role do Supabase)
# ══════════════════════════════════════════════════════════════════════════════
# c1 faltante+flagged (o caso do bug) | c2 faltante limpo | c3 faltante SEM classificacao
# c4 existente limpo | c5 existente+flagged | c6 faltante em 2 empresas (dedup)  → nos DOIS
# c7 faltante SÓ no ledger (o GANHO da v2: admitido pela RPC register_carteira_member
#    depois que o writer do espelho morreu — em prod eram 392 clientes em 18/07)
# c8 faltante só no ledger e `ambiguous` (quarantinado): DEVE aparecer mesmo assim
# c9 `inactive`: NÃO pode aparecer (único estado que significa "deixou de ser membro")
# ca `conflict`: DEVE aparecer (como ambiguous — quarantine governa comissão, não score)
P -q <<'SQL'
INSERT INTO public.omie_clientes (user_id, empresa_omie) VALUES
  ('00000000-0000-0000-0000-0000000000c1','colacor'),
  ('00000000-0000-0000-0000-0000000000c2','colacor'),
  ('00000000-0000-0000-0000-0000000000c3','colacor'),
  ('00000000-0000-0000-0000-0000000000c4','colacor'),
  ('00000000-0000-0000-0000-0000000000c5','colacor'),
  ('00000000-0000-0000-0000-0000000000c6','colacor'),
  ('00000000-0000-0000-0000-0000000000c6','oben'),    -- dup: mesmo cliente, +1 empresa
  (NULL,                                  'colacor'); -- guard: user_id NULL nunca vira alvo

-- o ledger é SUPERSET: tem os 6 do espelho + c7/c8 que só ele conhece
INSERT INTO public.carteira_membership_ledger (user_id, identity_state, source) VALUES
  ('00000000-0000-0000-0000-0000000000c1','verified' ,'backfill'),
  ('00000000-0000-0000-0000-0000000000c2','verified' ,'backfill'),
  ('00000000-0000-0000-0000-0000000000c3','verified' ,'backfill'),
  ('00000000-0000-0000-0000-0000000000c4','verified' ,'backfill'),
  ('00000000-0000-0000-0000-0000000000c5','verified' ,'backfill'),
  ('00000000-0000-0000-0000-0000000000c6','verified' ,'backfill'),
  ('00000000-0000-0000-0000-0000000000c7','verified' ,'rpc'),
  ('00000000-0000-0000-0000-0000000000c8','ambiguous','rpc'),
  ('00000000-0000-0000-0000-0000000000c9','inactive' ,'rpc'),   -- NÃO pode ser semeado
  ('00000000-0000-0000-0000-0000000000ca','conflict' ,'rpc');   -- DEVE ser semeado

INSERT INTO public.farmer_client_scores (customer_user_id) VALUES
  ('00000000-0000-0000-0000-0000000000c4'),
  ('00000000-0000-0000-0000-0000000000c5');

INSERT INTO public.cliente_classificacao (user_id, excluir_da_carteira) VALUES
  ('00000000-0000-0000-0000-0000000000c1', true),   -- flagged
  ('00000000-0000-0000-0000-0000000000c2', false),
  ('00000000-0000-0000-0000-0000000000c4', false),
  ('00000000-0000-0000-0000-0000000000c5', true),   -- flagged
  ('00000000-0000-0000-0000-0000000000c6', false);
  -- c3 NÃO tem linha em cliente_classificacao (não-fornecedor implícito → deve aparecer)

GRANT SELECT ON public.omie_clientes, public.carteira_membership_ledger,
                public.farmer_client_scores, public.cliente_classificacao TO service_role;
SQL

alvos()  { Pq -c "SELECT count(*) FROM public.seed_targets_faltantes();"; }
tem()    { Pq -c "SELECT count(*) FROM public.seed_targets_faltantes() WHERE user_id='00000000-0000-0000-0000-000000000$1';"; }

# baseline com a v1 (fonte = espelho): captura o conjunto que o comportamento ATUAL entrega
P -q -c "CREATE TABLE public._baseline_v1 AS SELECT user_id FROM public.seed_targets_faltantes();"
eq  "A0 baseline v1 (espelho) = {c2,c3,c6}"                  "$(Pq -c 'SELECT count(*) FROM public._baseline_v1;')" "3"

# ══════════════════════════════════════════════════════════════════════════════
# agora a v2 (fonte = ledger)
# ══════════════════════════════════════════════════════════════════════════════
P -q -f "$TMPD/v2.sql"
echo "v2 aplicada (fonte = carteira_membership_ledger)"

# ══════════════════════════════════════════════════════════════════════════════
# ZONA 4 — asserts (política preservada / paridade / guard / auth)
# ══════════════════════════════════════════════════════════════════════════════
echo "── asserts: a POLÍTICA de quem é seguro semear não mudou ──"
eq  "A1 total de alvos = {c2,c3,c6,c7,c8,ca} (c9 inactive FORA)"  "$(alvos)"  "6"
eq  "A2 ⭐ faltante+flagged NÃO aparece (anti-ressurreição)"  "$(tem 0c1)" "0"
eq  "A3 faltante limpo aparece"                              "$(tem 0c2)" "1"
eq  "A4 faltante SEM classificação aparece"                  "$(tem 0c3)" "1"
eq  "A5 já-existente (limpo) NÃO re-semeado"                 "$(tem 0c4)" "0"
eq  "A6 já-existente+flagged NÃO aparece"                    "$(tem 0c5)" "0"
eq  "A7 dedup: 1 linha por cliente (user_id é PK no ledger)" "$(tem 0c6)" "1"
eq  "A8 guard: user_id NULL fora"                            "$(Pq -c "SELECT count(*) FROM public.seed_targets_faltantes() WHERE user_id IS NULL;")" "0"

echo "── asserts: a TROCA DE FONTE (o que a Fatia 5 acrescenta) ──"
PERDIDOS=$(Pq -c "SELECT count(*) FROM (SELECT user_id FROM public._baseline_v1 EXCEPT SELECT user_id FROM public.seed_targets_faltantes()) x;")
eq  "B1 ⭐ PERDIDOS na troca de fonte = 0 (o critério de aceite REAL)"  "$PERDIDOS" "0"

eq  "B2 c7 (só no ledger, source='rpc') É semeado — o ganho da troca"   "$(tem 0c7)" "1"
eq  "B3 ⭐ c8 ambiguous É semeado (quarantine governa vendedor/comissão, NÃO a existência de score)" "$(tem 0c8)" "1"
eq  "B3b ⭐ ca conflict É semeado (mesma razão de ambiguous)"           "$(tem 0ca)" "1"
eq  "B3c ⭐ c9 inactive NÃO é semeado (único estado que deixou de ser membro)" "$(tem 0c9)" "0"

# ⭐ o assert que autoriza o DROP
P -q -c "DROP TABLE public.omie_clientes;"
eq  "B4 ⭐ SEM omie_clientes a RPC ainda devolve os 6 alvos"            "$(alvos)"  "6"

echo "── asserts: acesso ──"
# authenticated NÃO executa (REVOKE EXECUTE → insufficient_privilege 42501)
R=$(P -tA 2>&1 <<'SQL'
SET ROLE authenticated;
DO $$ BEGIN
  PERFORM count(*) FROM public.seed_targets_faltantes();
  RAISE EXCEPTION 'EXECUTOU_SEM_GRANT';
EXCEPTION
  WHEN insufficient_privilege THEN RAISE NOTICE 'REVOKE_OK';
  WHEN OTHERS THEN RAISE;
END $$;
SQL
)
case "$R" in *REVOKE_OK*) ok "A9 REVOKE: authenticated não executa (42501)" ;; *) bad "A9 REVOKE — veio: $R" ;; esac

SR=$(Pq -c "SET ROLE service_role; SELECT count(*) FROM public.seed_targets_faltantes();" | tail -1)
eq  "A10 service_role executa (6 alvos)"                     "$SR" "6"

# ══════════════════════════════════════════════════════════════════════════════
# ZONA 5 — FALSIFICAÇÃO (Lei #3: sabota → exija VERMELHO → restaura)
# ══════════════════════════════════════════════════════════════════════════════
echo "── falsificação ──"
# F1 ⭐: sem o filtro de flaggeds → c1 (fornecedor excluído) DEVE vazar (prova A2)
P -q <<'SQL'
CREATE OR REPLACE FUNCTION public.seed_targets_faltantes()
RETURNS TABLE(user_id uuid) LANGUAGE sql STABLE SECURITY INVOKER SET search_path=public AS $f$
  SELECT DISTINCT l.user_id FROM public.carteira_membership_ledger l
  WHERE l.user_id IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM public.farmer_client_scores f WHERE f.customer_user_id = l.user_id)
  ORDER BY l.user_id
$f$;
SQL
if [ "$(tem 0c1)" = "1" ]; then ok "F1 ⭐ sem o filtro de flaggeds, c1 RESSUSCITA → A2 tem dente"; else bad "F1 sabotei flaggeds e c1 NÃO vazou → A2 é fraco"; fi
P -q -f "$TMPD/v2.sql"

# F2: sem o filtro de fcs → c4 (já-existente) DEVE vazar (prova A5)
P -q <<'SQL'
CREATE OR REPLACE FUNCTION public.seed_targets_faltantes()
RETURNS TABLE(user_id uuid) LANGUAGE sql STABLE SECURITY INVOKER SET search_path=public AS $f$
  SELECT DISTINCT l.user_id FROM public.carteira_membership_ledger l
  WHERE l.user_id IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM public.cliente_classificacao cc WHERE cc.user_id = l.user_id AND cc.excluir_da_carteira)
  ORDER BY l.user_id
$f$;
SQL
if [ "$(tem 0c4)" = "1" ]; then ok "F2 sem o filtro de fcs, c4 (existente) vaza → A5 tem dente"; else bad "F2 sabotei fcs e c4 NÃO vazou → A5 é fraco"; fi
P -q -f "$TMPD/v2.sql"

# F3 ⭐: a v1 (fonte = espelho) NÃO sobrevive ao DROP — sem isto, B4 poderia estar medindo um
#        harness que nunca dependeu do espelho.
#
#        `check_function_bodies=off` NÃO é conveniência de teste: é o que reproduz o estado REAL da
#        prod. Lá a v1 foi criada em 21/06 com o espelho VIVO, e a tabela só some agora. Com a flag
#        ligada o PG analisaria o corpo AGORA (tabela já dropada) e recusaria o CREATE — um estado
#        que a produção nunca viveu.
#
#        E é justamente essa análise-no-CREATE que explica por que o `DROP TABLE` não é barrado:
#        `LANGUAGE sql` (não-ATOMIC) é checado no CREATE mas NÃO registra dependência em `pg_depend`
#        (confirmado pelo preflight em prod: nenhuma das 2 funções aparece como dependente). Logo o
#        DROP passa limpo e a quebra só aparece no EXECUTE, atrás de um cron — a falha silenciosa
#        que esta fatia inteira existe para evitar.
P -q -c "SET check_function_bodies = off;" -f "$TMPD/v1.sql"
R3=$(P -tA 2>&1 <<'SQL'
DO $$ BEGIN
  PERFORM count(*) FROM public.seed_targets_faltantes();
  RAISE EXCEPTION 'SENTINELA_V1_SOBREVIVEU';
EXCEPTION
  WHEN undefined_table THEN RAISE NOTICE 'V1_QUEBRA_SEM_ESPELHO_42P01';
  WHEN OTHERS THEN RAISE;
END $$;
SQL
)
case "$R3" in
  *V1_QUEBRA_SEM_ESPELHO_42P01*) ok "F3 ⭐ a v1 quebra sem o espelho (42P01) → B4 tem dente" ;;
  *SENTINELA_V1_SOBREVIVEU*)     bad "F3 a v1 sobreviveu ao DROP — B4 não prova nada" ;;
  *)                             bad "F3 erro inesperado — veio: $R3" ;;
esac
P -q -f "$TMPD/v2.sql"

# F4 ⭐: os DOIS erros simétricos da allowlist de identity_state.
#   F4a — estreitar demais (só 'verified'): derruba ambiguous e conflict ⇒ prova B3/B3b.
#   F4b — não filtrar nada (a 1ª versão desta migration, que o Codex refutou): deixa 'inactive'
#         entrar ⇒ prova B3c. Sem F4b, "não filtrar" e "filtrar certo" seriam indistinguíveis.
P -q <<'SQL'
CREATE OR REPLACE FUNCTION public.seed_targets_faltantes()
RETURNS TABLE(user_id uuid) LANGUAGE sql STABLE SECURITY INVOKER SET search_path=public AS $f$
  SELECT DISTINCT l.user_id FROM public.carteira_membership_ledger l
  WHERE l.user_id IS NOT NULL
    AND l.identity_state = 'verified'
    AND NOT EXISTS (SELECT 1 FROM public.farmer_client_scores f WHERE f.customer_user_id = l.user_id)
    AND NOT EXISTS (SELECT 1 FROM public.cliente_classificacao cc WHERE cc.user_id = l.user_id AND cc.excluir_da_carteira)
  ORDER BY l.user_id
$f$;
SQL
if [ "$(tem 0c8)" = "0" ] && [ "$(tem 0ca)" = "0" ] && [ "$(alvos)" = "4" ]; then
  ok "F4a ⭐ allowlist só-'verified' derruba c8+ca (6→4) → B3/B3b têm dente"
else
  bad "F4a estreitei p/ só-'verified' e o universo não encolheu (alvos=$(alvos)) → B3/B3b são fracos"
fi
P -q -f "$TMPD/v2.sql"

# F4b ⭐: a 1ª versão desta migration NÃO filtrava identity_state nenhum — foi o que o /codex xhigh
#        refutou. Sem esta sabotagem, "não filtrar" e "filtrar certo" dariam o mesmo resultado em
#        todos os outros asserts, e B3c estaria provando o vazio.
P -q <<'SQL'
CREATE OR REPLACE FUNCTION public.seed_targets_faltantes()
RETURNS TABLE(user_id uuid) LANGUAGE sql STABLE SECURITY INVOKER SET search_path=public AS $f$
  SELECT DISTINCT l.user_id FROM public.carteira_membership_ledger l
  WHERE l.user_id IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM public.farmer_client_scores f WHERE f.customer_user_id = l.user_id)
    AND NOT EXISTS (SELECT 1 FROM public.cliente_classificacao cc WHERE cc.user_id = l.user_id AND cc.excluir_da_carteira)
  ORDER BY l.user_id
$f$;
SQL
if [ "$(tem 0c9)" = "1" ] && [ "$(alvos)" = "7" ]; then
  ok "F4b ⭐ SEM a allowlist, c9 'inactive' entra no seed (6→7) → B3c tem dente"
else
  bad "F4b tirei a allowlist e c9 NÃO vazou (alvos=$(alvos)) → B3c é fraco"
fi
P -q -f "$TMPD/v2.sql"

eq  "A11 pós-restauro: volta a 6 alvos"                      "$(alvos)" "6"

echo "──────────────────────────────"
echo "RESULTADO: $PASS ok / $FAIL fail"
[ "$FAIL" = "0" ] || { echo "❌ HARNESS VERMELHO"; exit 1; }
echo "✅ HARNESS VERDE"
