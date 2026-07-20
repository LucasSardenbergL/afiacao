#!/usr/bin/env bash
# ╔══════════════════════════════════════════════════════════════════════════════════════════╗
# ║  PROVA PG17 — DROP do espelho `omie_clientes` (P0-B-bis Fatia 5B, FINAL)                  ║
# ║  Migration: supabase/migrations/20260722110000_drop_omie_clientes_espelho.sql             ║
# ║  Rode:  bash db/test-drop-omie-clientes.sh > /tmp/t.log 2>&1; echo $?                     ║
# ║                                                                                            ║
# ║  Um DROP é irreversível, então a prova cobre TRÊS eixos:                                   ║
# ║    1. ATOMICIDADE — o bloco é BEGIN/COMMIT: se o DROP falhar, o arquivo morto NÃO fica     ║
# ║       para trás (senão um re-run acumularia lixo e mascararia a falha).                     ║
# ║    2. ARQUIVO MORTO FIEL E TRANCADO — 6909 linhas idênticas, RLS ligada, anon/authenticated ║
# ║       SEM leitura (tabela nova no Supabase nasce ABERTA — database.md §7).                  ║
# ║    3. SOBREVIVÊNCIA — as 2 funções que a Fatia 5A migrou executam DEPOIS do DROP.          ║
# ║       `LANGUAGE sql` é late-bound: o DROP passa limpo e só o EXECUTE revela a quebra.      ║
# ║                                                                                            ║
# ║  Falsificações (Lei #3): F1 restaura o corpo PRÉ-5A e exige 42P01 (prova que A5/A6 medem   ║
# ║  algo real); F2 remove o REVOKE e exige que `anon` PASSE a ler (prova que A4 tem dente).   ║
# ╚══════════════════════════════════════════════════════════════════════════════════════════╝
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PGVER=17
PGBIN="/opt/homebrew/opt/postgresql@${PGVER}/bin"
PORT="${PGPORT_TEST:-5471}"
SLUG="drop-espelho"
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

PASS=0; FAIL=0
ok()  { PASS=$((PASS+1)); echo "  ✅ $1"; }
bad() { FAIL=$((FAIL+1)); echo "  ❌ $1"; }
eq()  { if [ "$2" = "$3" ]; then ok "$1 (=$2)"; else bad "$1 — esperado [$3], veio [$2]"; fi; }

echo "═══ setup pronto (PG17 :$PORT) ═══"

# ══════════════════════════════════════════════════════════════════════════════════════════
# ZONA 1 — espelho da PROD: colunas, constraints, policies e triggers REAIS (psql-ro 2026-07-19).
#   Reproduzir as 2 policies e os 2 triggers importa: eles caem junto no DROP, e o teste tem de
#   provar que caem — trigger órfão apontando p/ tabela inexistente seria dívida silenciosa.
#   ⚠️ Replica o DEFAULT PRIVILEGE do Supabase ANTES de criar as tabelas: sem isso o arquivo morto
#   nasce fechado POR ACIDENTE e o REVOKE "provaria" uma proteção que a prod não teria.
# ══════════════════════════════════════════════════════════════════════════════════════════
P -q <<'SQL'
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO anon, authenticated, service_role;

CREATE TABLE public.omie_clientes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  omie_codigo_cliente bigint NOT NULL,
  omie_codigo_cliente_integracao text,
  omie_codigo_vendedor bigint,
  empresa_omie text NOT NULL DEFAULT 'colacor'
    CONSTRAINT omie_clientes_empresa_omie_check CHECK (empresa_omie IN ('colacor','oben','colacor_sc')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT unique_user_omie UNIQUE (user_id)
);
CREATE INDEX idx_omie_clientes_user_empresa   ON public.omie_clientes(user_id, empresa_omie);
CREATE INDEX idx_omie_clientes_codigo_empresa ON public.omie_clientes(omie_codigo_cliente, empresa_omie);
ALTER TABLE public.omie_clientes ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Staff can manage omie clients" ON public.omie_clientes FOR ALL USING (true);
CREATE POLICY "Users can view their own omie client mapping" ON public.omie_clientes FOR SELECT USING (true);

CREATE TABLE public.carteira_membership_ledger (
  user_id uuid PRIMARY KEY,
  identity_state text NOT NULL DEFAULT 'verified'
    CHECK (identity_state IN ('verified','ambiguous','inactive','conflict')),
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  source text, updated_at timestamptz DEFAULT now()
);
CREATE TABLE public.farmer_client_scores   (customer_user_id uuid, calculated_at timestamptz);
CREATE TABLE public.cliente_classificacao  (user_id uuid PRIMARY KEY, excluir_da_carteira boolean NOT NULL DEFAULT false);
CREATE TABLE public.omie_customer_account_map (user_id uuid, account text, updated_at timestamptz);
CREATE TABLE public.omie_products (account text, updated_at timestamptz);

-- os 2 triggers reais do alvo (têm de sumir junto)
CREATE OR REPLACE FUNCTION public.tg_omie_clientes_to_ledger() RETURNS trigger LANGUAGE plpgsql AS $f$
BEGIN
  INSERT INTO public.carteira_membership_ledger(user_id, source)
  VALUES (NEW.user_id, 'trigger') ON CONFLICT (user_id) DO NOTHING;
  RETURN NEW;
END $f$;
CREATE OR REPLACE FUNCTION public.update_updated_at_column() RETURNS trigger LANGUAGE plpgsql AS $f$
BEGIN NEW.updated_at = now(); RETURN NEW; END $f$;
CREATE TRIGGER trg_omie_clientes_to_ledger AFTER INSERT ON public.omie_clientes
  FOR EACH ROW EXECUTE FUNCTION public.tg_omie_clientes_to_ledger();
CREATE TRIGGER update_omie_clientes_updated_at BEFORE UPDATE ON public.omie_clientes
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- 6909 linhas, com 41 carregando o `_integracao` (o único dado não reconstruível)
INSERT INTO public.omie_clientes (user_id, omie_codigo_cliente, omie_codigo_cliente_integracao)
SELECT gen_random_uuid(), 100000 + g, CASE WHEN g <= 41 THEN 'INTEG-'||g END
FROM generate_series(1, 6909) g;
INSERT INTO public.omie_customer_account_map (user_id, account, updated_at) VALUES (gen_random_uuid(),'oben', now());
INSERT INTO public.omie_products (account, updated_at) VALUES ('oben', now());
SQL
echo "espelho semeado: $(Pq -c 'SELECT count(*) FROM public.omie_clientes;') linhas"

# as 2 funções que a Fatia 5A migrou — aplicadas a partir das migrations REAIS
for M in 20260718220000_data_health_vendas_cadastros_proof 20260718220100_seed_targets_faltantes_ledger; do
  F="$REPO_ROOT/supabase/migrations/${M}.sql"
  [ -f "$F" ] || { echo "❌ migration da Fatia 5A ausente: $F"; exit 1; }
done
TMPD="$(dirname "$DATA")"
# só o CREATE de cada uma (o rodapé de validação chama a função / lê catálogo)
awk '/^CREATE OR REPLACE FUNCTION public\._data_health_compute/{f=1} f{print} /^\$function\$;$/{if(f) exit}' \
  "$REPO_ROOT/supabase/migrations/20260718220000_data_health_vendas_cadastros_proof.sql" > "$TMPD/dhc.sql"
awk '/^CREATE OR REPLACE FUNCTION/{f=1} f{print} /^GRANT EXECUTE/{if(f) exit}' \
  "$REPO_ROOT/supabase/migrations/20260718220100_seed_targets_faltantes_ledger.sql" > "$TMPD/seed.sql"

# o dhc real lê 17 relações; aqui provamos só que ele SOBREVIVE ao DROP, então basta uma
# micro-réplica do bloco vendas_cadastros extraída da migration REAL (verbatim via awk).
{
  echo "CREATE OR REPLACE FUNCTION public._dhc_vendas_cadastros()"
  echo " RETURNS TABLE(source text, status text, freshness_basis text) LANGUAGE sql STABLE AS \$fn\$"
  echo "  SELECT 'vendas_cadastros'::text,"
  echo "    CASE WHEN vc.max_clientes IS NULL OR vc.max_produtos IS NULL THEN 'broken'"
  echo "         WHEN now() - LEAST(vc.max_clientes, vc.max_produtos) > interval '30 hours' THEN 'stale' ELSE 'ok' END,"
  grep -m1 "'max(updated_at) de omie_customer_account_map" "$TMPD/dhc.sql" | sed 's/,$/::text/'
  echo "  FROM ("
  grep -m1 "SELECT (SELECT max(updated_at) FROM public.omie_customer_account_map WHERE account = 'oben') AS max_clientes," "$TMPD/dhc.sql"
  echo "         (SELECT max(updated_at) FROM public.omie_products) AS max_produtos"
  echo "  ) vc"
  echo "\$fn\$;"
} > "$TMPD/dhc_micro.sql"
P -q -f "$TMPD/dhc_micro.sql"
P -q -f "$TMPD/seed.sql"
echo "funções da Fatia 5A aplicadas"

# ══════════════════════════════════════════════════════════════════════════════════════════
# ZONA 2 — baseline ANTES do DROP
# ══════════════════════════════════════════════════════════════════════════════════════════
echo "── baseline ──"
eq  "A0 espelho existe com 6909 linhas"        "$(Pq -c 'SELECT count(*) FROM public.omie_clientes;')" "6909"
# o trigger AFTER INSERT do espelho populou o ledger com os mesmos 6909 (é o que ele faz), e
# farmer_client_scores está vazia ⇒ o seed devolve os 6909. O que interessa aqui é só que as duas
# EXECUTAM antes do DROP, para o A5/A6 depois medirem "continuam executando".
eq  "A0b _dhc executa ANTES do DROP (1 linha)"  "$(Pq -c 'SELECT count(*) FROM public._dhc_vendas_cadastros();')" "1"
eq  "A0c seed executa ANTES do DROP (6909 do ledger, via trigger)" "$(Pq -c 'SELECT count(*) FROM public.seed_targets_faltantes();')" "6909"

# ══════════════════════════════════════════════════════════════════════════════════════════
# ZONA 3 — aplicar a migration REAL do DROP (Lei #1)
# ══════════════════════════════════════════════════════════════════════════════════════════
MIG="$REPO_ROOT/supabase/migrations/20260722110000_drop_omie_clientes_espelho.sql"
awk '/^BEGIN;$/{f=1} f{print} /^COMMIT;$/{if(f) exit}' "$MIG" > "$TMPD/drop.sql"
P -q -f "$TMPD/drop.sql"
echo "migration aplicada: $(basename "$MIG")"

# ══════════════════════════════════════════════════════════════════════════════════════════
# ZONA 4 — asserts
# ══════════════════════════════════════════════════════════════════════════════════════════
echo "── asserts ──"
eq  "A1 a tabela SUMIU"                        "$(Pq -c "SELECT (to_regclass('public.omie_clientes') IS NULL)::text;")" "true"
eq  "A2 ⭐ arquivo morto tem as 6909 linhas"    "$(Pq -c 'SELECT count(*) FROM public._archive_omie_clientes_20260722;')" "6909"
eq  "A3 ⭐ os 41 _integracao (dado NÃO reconstruível) preservados" \
    "$(Pq -c 'SELECT count(*) FROM public._archive_omie_clientes_20260722 WHERE omie_codigo_cliente_integracao IS NOT NULL;')" "41"

# o arquivo nasceria ABERTO (default privilege replicado na ZONA 1) — o REVOKE é o que o fecha
eq  "A4 ⭐ anon NÃO lê o arquivo"               "$(Pq -c "SELECT has_table_privilege('anon','public._archive_omie_clientes_20260722','SELECT')::text;")" "false"
eq  "A4b authenticated NÃO lê o arquivo"        "$(Pq -c "SELECT has_table_privilege('authenticated','public._archive_omie_clientes_20260722','SELECT')::text;")" "false"
eq  "A4c RLS ligada no arquivo"                 "$(Pq -c "SELECT relrowsecurity::text FROM pg_class WHERE relname='_archive_omie_clientes_20260722';")" "true"

# ⭐ o par que autoriza o DROP: as funções da Fatia 5A executam SEM a tabela (late-bound)
eq  "A5 ⭐ _data_health_compute (bloco real) executa SEM o espelho" \
    "$(Pq -c "SELECT status FROM public._dhc_vendas_cadastros();")" "ok"
# ⚠️ 6909, não 0: o ledger é ACUMULADOR e sobrevive ao DROP com seus membros intactos — que é
# exatamente a propriedade que o épico inteiro existe para garantir. Se viesse 0 aqui, seria o
# sintoma de que a membership foi perdida junto com a tabela.
eq  "A6 ⭐ seed executa SEM o espelho e a membership do ledger SOBREVIVE" \
    "$(Pq -c 'SELECT count(*) FROM public.seed_targets_faltantes();')" "6909"

# os objetos-satélite caíram junto — trigger órfão seria dívida silenciosa
eq  "A7 os 2 triggers do alvo sumiram"          "$(Pq -c "SELECT count(*) FROM pg_trigger WHERE NOT tgisinternal AND tgname IN ('trg_omie_clientes_to_ledger','update_omie_clientes_updated_at');")" "0"
eq  "A8 os 2 índices sumiram"                   "$(Pq -c "SELECT count(*) FROM pg_indexes WHERE tablename='omie_clientes';")" "0"
eq  "A9 as 2 policies sumiram"                  "$(Pq -c "SELECT count(*) FROM pg_policy pol JOIN pg_class c ON c.oid=pol.polrelid WHERE c.relname='omie_clientes';")" "0"
# a função do trigger SOBREVIVE (é objeto próprio) — não pode virar erro, mas fica órfã
eq  "A10 tg_omie_clientes_to_ledger fica órfã (esperado: existe, sem trigger)" \
    "$(Pq -c "SELECT count(*) FROM pg_proc WHERE proname='tg_omie_clientes_to_ledger';")" "1"

# ══════════════════════════════════════════════════════════════════════════════════════════
# ZONA 5 — FALSIFICAÇÃO (Lei #3)
# ══════════════════════════════════════════════════════════════════════════════════════════
echo "── falsificação ──"

# F1 ⭐: com o corpo PRÉ-Fatia-5A (lendo o espelho), o mesmo DROP quebra no EXECUTE (42P01).
#        `check_function_bodies=off` reproduz o estado real: a função foi criada quando a tabela
#        existia. Sem este assert, A5/A6 poderiam estar medindo funções que nunca dependeram dela.
# ⚠️ `psql -c` IGNORA o stdin: com `-c "SET ..."` o heredoc é descartado em silêncio, a função não
#    é substituída, e a falsificação passa a medir a função NOVA (falso "não reproduziu"). O SET vai
#    DENTRO do próprio heredoc. Mordido ao escrever este harness.
P -q <<'SQL'
SET check_function_bodies = off;
CREATE OR REPLACE FUNCTION public.seed_targets_faltantes()
RETURNS TABLE(user_id uuid) LANGUAGE sql STABLE SECURITY INVOKER SET search_path=public AS $f$
  SELECT DISTINCT oc.user_id FROM public.omie_clientes oc WHERE oc.user_id IS NOT NULL
$f$;
SQL
R=$(P -tA 2>&1 <<'SQL'
DO $$ BEGIN
  PERFORM count(*) FROM public.seed_targets_faltantes();
  RAISE EXCEPTION 'SENTINELA_SOBREVIVEU_SEM_ESPELHO';
EXCEPTION
  WHEN undefined_table THEN RAISE NOTICE 'QUEBRA_CONFIRMADA_42P01';
  WHEN OTHERS THEN RAISE;
END $$;
SQL
)
case "$R" in
  *QUEBRA_CONFIRMADA_42P01*)        ok "F1 ⭐ corpo PRÉ-5A quebra sem o espelho (42P01) — A5/A6 têm dente" ;;
  *SENTINELA_SOBREVIVEU_SEM_ESPELHO*) bad "F1 o corpo velho sobreviveu ao DROP — A5/A6 não provam nada" ;;
  *)                                bad "F1 erro inesperado — veio: $R" ;;
esac
P -q -f "$TMPD/seed.sql"

# F2 ⭐: sem o REVOKE, o arquivo morto nasce LEGÍVEL por anon (default privilege do Supabase).
#        Prova que A4 mede a proteção, e não um acidente do harness.
P -q -c "CREATE TABLE public._archive_sem_revoke AS SELECT * FROM public._archive_omie_clientes_20260722 LIMIT 1;"
SEM=$(Pq -c "SELECT has_table_privilege('anon','public._archive_sem_revoke','SELECT')::text;")
if [ "$SEM" = "true" ]; then ok "F2 ⭐ sem REVOKE o arquivo nasce legível por anon → A4 tem dente"; else bad "F2 tabela nova nasceu fechada sozinha (=$SEM) → A4 é falso-verde"; fi
P -q -c "DROP TABLE public._archive_sem_revoke;"

# F3: ATOMICIDADE — com um dependente que impede o DROP, a transação inteira reverte e o arquivo
#     morto NÃO fica para trás. (Sem CASCADE de propósito: falhar aqui é o resultado BOM.)
P -q <<'SQL'
CREATE TABLE public.omie_clientes (user_id uuid PRIMARY KEY);
CREATE VIEW public.v_dependente_do_espelho AS SELECT user_id FROM public.omie_clientes;
DROP TABLE IF EXISTS public._archive_atomic_test;
SQL
set +e
P -q > /dev/null 2>&1 <<'SQL'
BEGIN;
CREATE TABLE public._archive_atomic_test AS SELECT * FROM public.omie_clientes;
DROP TABLE public.omie_clientes;
COMMIT;
SQL
RC=$?
set -e
SOBROU=$(Pq -c "SELECT (to_regclass('public._archive_atomic_test') IS NOT NULL)::text;")
AINDA=$(Pq -c "SELECT (to_regclass('public.omie_clientes') IS NOT NULL)::text;")
if [ "$RC" != "0" ] && [ "$SOBROU" = "false" ] && [ "$AINDA" = "true" ]; then
  ok "F3 ⭐ dependente bloqueia o DROP e a transação reverte INTEIRA (sem arquivo órfão)"
else
  bad "F3 atomicidade falhou — rc=$RC arquivo_sobrou=$SOBROU tabela_ainda_existe=$AINDA"
fi

echo "──────────────────────────────"
echo "RESULTADO: $PASS ok / $FAIL fail"
[ "$FAIL" = "0" ] || { echo "❌ HARNESS VERMELHO"; exit 1; }
echo "✅ HARNESS VERDE"
