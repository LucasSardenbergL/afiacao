#!/usr/bin/env bash
# ╔══════════════════════════════════════════════════════════════════════════════════════════╗
# ║  PROVA PG17 — QUARENTENA do espelho `omie_clientes` (P0-B-bis Fatia 5B)                   ║
# ║  Migration: supabase/migrations/20260722110000_quarentena_omie_clientes_espelho.sql       ║
# ║  Rode:  bash db/test-quarentena-omie-clientes.sh > /tmp/t.log 2>&1; echo $?               ║
# ║                                                                                            ║
# ║  A 1ª versão DROPAVA; o /codex challenge xhigh recusou e a quarentena por RENAME entrou    ║
# ║  no lugar. A prova cobre QUATRO eixos:                                                     ║
# ║    1. RENAME PRESERVA — 6909 linhas e os 41 `_integracao` intactos (≠ cópia CTAS, que      ║
# ║       perderia índices/constraints e teria janela de escrita concorrente).                  ║
# ║    2. FECHA O POSTGREST — anon/authenticated sem SELECT. É isto que faz a quarentena        ║
# ║       DETECTAR consumidor externo: ele passa a receber erro, com URL e horário no log.      ║
# ║    3. SOBREVIVÊNCIA — as 2 funções da Fatia 5A executam sem a tabela no nome antigo.        ║
# ║       `LANGUAGE sql` é late-bound: só o EXECUTE revela a quebra.                            ║
# ║    4. ⭐ A VALIDAÇÃO REVERTE — o Codex apontou que, na 1ª versão, as validações rodavam     ║
# ║       DEPOIS do COMMIT: detectavam a quebra mas não a desfaziam. Agora rodam ANTES, e o     ║
# ║       F4 prova que uma função quebrada aborta a transação e a tabela VOLTA ao nome original.║
# ║                                                                                            ║
# ║  Falsificações (Lei #3): F1 corpo PRÉ-5A ⇒ 42P01; F2 sem REVOKE ⇒ `anon` lê; F3 lock        ║
# ║  concorrente ⇒ NOWAIT falha em vez de esperar; F4 validação pré-commit ⇒ rollback real.    ║
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

# A migration valida `_data_health_compute()` com o contrato REAL de 24 checks (é o que existe em
# prod). Aqui o bloco `vendas_cadastros` é o verdadeiro — extraído da migration da Fatia 5A pelo awk
# acima — e os outros 23 são preenchimento: o que este harness prova é a SOBREVIVÊNCIA da função ao
# rename e o rollback quando ela quebra, não os 23 checks alheios (esses têm prova própria em
# db/test-data-health-vendas-cadastros-proof.sh, que roda a função inteira com as 17 relações).
P -q <<'SQL'
CREATE OR REPLACE FUNCTION public._data_health_compute()
RETURNS TABLE(source text, status text, freshness_basis text) LANGUAGE sql STABLE AS $fn$
  SELECT * FROM public._dhc_vendas_cadastros()
  UNION ALL
  SELECT 'check_'||g, 'ok', 'stub' FROM generate_series(1,23) g
$fn$;
SQL
echo "funções da Fatia 5A aplicadas (+ _data_health_compute com o contrato de 24 checks)"

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
# ZONA 3 — aplicar a migration REAL da quarentena (Lei #1)
# ══════════════════════════════════════════════════════════════════════════════════════════
MIG="$REPO_ROOT/supabase/migrations/20260722110000_quarentena_omie_clientes_espelho.sql"
awk '/^BEGIN;$/{f=1} f{print} /^COMMIT;$/{if(f) exit}' "$MIG" > "$TMPD/quar.sql"
P -q -f "$TMPD/quar.sql"
echo "migration aplicada: $(basename "$MIG")"

# ══════════════════════════════════════════════════════════════════════════════════════════
# ZONA 4 — asserts
# ══════════════════════════════════════════════════════════════════════════════════════════
echo "── asserts ──"
eq  "A1 o nome antigo SUMIU"                    "$(Pq -c "SELECT (to_regclass('public.omie_clientes') IS NULL)::text;")" "true"
eq  "A2 ⭐ a quarentena tem as 6909 linhas"      "$(Pq -c 'SELECT count(*) FROM public._quarantine_omie_clientes_20260722;')" "6909"
eq  "A3 ⭐ os 41 _integracao (dado NÃO reconstruível) preservados" \
    "$(Pq -c 'SELECT count(*) FROM public._quarantine_omie_clientes_20260722 WHERE omie_codigo_cliente_integracao IS NOT NULL;')" "41"

# É o REVOKE que transforma a quarentena em DETECTOR: sem acesso pelo PostgREST, um consumidor
# externo passa a receber erro — com URL e horário no log — em vez de seguir lendo em silêncio.
eq  "A4 ⭐ anon NÃO lê a quarentena"             "$(Pq -c "SELECT has_table_privilege('anon','public._quarantine_omie_clientes_20260722','SELECT')::text;")" "false"
eq  "A4b authenticated NÃO lê a quarentena"      "$(Pq -c "SELECT has_table_privilege('authenticated','public._quarantine_omie_clientes_20260722','SELECT')::text;")" "false"
eq  "A4c RLS segue ligada (o rename preserva)"   "$(Pq -c "SELECT relrowsecurity::text FROM pg_class WHERE relname='_quarantine_omie_clientes_20260722';")" "true"

# ⭐ as funções da Fatia 5A executam sem a tabela no nome antigo (late-bound)
eq  "A5 ⭐ _data_health_compute (bloco real) executa"  "$(Pq -c "SELECT status FROM public._dhc_vendas_cadastros();")" "ok"
# ⚠️ 6909, não 0: o ledger é ACUMULADOR e sobrevive intacto — a propriedade que o épico existe para
# garantir. Se viesse 0, seria sintoma de membership perdida junto com o rename.
eq  "A6 ⭐ seed executa e a membership do ledger SOBREVIVE" \
    "$(Pq -c 'SELECT count(*) FROM public.seed_targets_faltantes();')" "6909"

# ⭐ o RENAME preserva o que uma cópia CTAS perderia — é o motivo de ele ser melhor que DROP+arquivo
# 4 = os 2 índices explícitos + os 2 implícitos das constraints (pkey e unique_user_omie).
# `pg_indexes` lista ambos; uma cópia CTAS não traria nenhum deles.
eq  "A7 ⭐ os 4 índices seguem na quarentena"    "$(Pq -c "SELECT count(*) FROM pg_indexes WHERE tablename='_quarantine_omie_clientes_20260722';")" "4"
eq  "A8 ⭐ as 3 constraints seguem"              "$(Pq -c "SELECT count(*) FROM pg_constraint WHERE conrelid='public._quarantine_omie_clientes_20260722'::regclass;")" "3"
eq  "A9 ⭐ as 2 policies seguem"                 "$(Pq -c "SELECT count(*) FROM pg_policy pol JOIN pg_class c ON c.oid=pol.polrelid WHERE c.relname='_quarantine_omie_clientes_20260722';")" "2"
# o ROLLBACK desfaz o rename de teste; `grep -x` isola a saída do SELECT (o `tail -1` pegava a
# linha do próprio ROLLBACK — o comando certo com a leitura errada).
eq  "A10 ⭐ REVERSÍVEL: rename de volta restaura o nome original" \
    "$(Pq -c "BEGIN; ALTER TABLE public._quarantine_omie_clientes_20260722 RENAME TO omie_clientes; SELECT (to_regclass('public.omie_clientes') IS NOT NULL)::text; ROLLBACK;" | grep -x 'true\|false' | head -1)" "true"

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

# F2 ⭐: sem o REVOKE, a quarentena continua legível por anon (default privilege do Supabase, que a
#        ZONA 1 replica). Prova que A4 mede a proteção, e não um acidente do harness.
P -q -c "CREATE TABLE public._quar_sem_revoke AS SELECT * FROM public._quarantine_omie_clientes_20260722 LIMIT 1;"
SEM=$(Pq -c "SELECT has_table_privilege('anon','public._quar_sem_revoke','SELECT')::text;")
if [ "$SEM" = "true" ]; then ok "F2 ⭐ sem REVOKE a tabela nasce legível por anon → A4 tem dente"; else bad "F2 tabela nova nasceu fechada sozinha (=$SEM) → A4 é falso-verde"; fi
P -q -c "DROP TABLE public._quar_sem_revoke;"

# F3 ⭐: o `LOCK ... NOWAIT` falha na hora se houver transação concorrente, em vez de esperar em
#        silêncio atrás do lock. Numa migration colada no SQL Editor, esperar seria pior: o founder
#        vê a query "rodando" sem saber que algo ainda usa a tabela.
P -q -c "CREATE TABLE public._lock_probe (id int);"
(P -q -c "BEGIN; LOCK TABLE public._lock_probe IN ACCESS EXCLUSIVE MODE; SELECT pg_sleep(4); COMMIT;" >/dev/null 2>&1) &
BGPID=$!
sleep 1
set +e
RL=$(P -tA -c "LOCK TABLE public._lock_probe IN ACCESS EXCLUSIVE MODE NOWAIT;" 2>&1)
RC=$?
set -e
wait $BGPID 2>/dev/null || true
P -q -c "DROP TABLE IF EXISTS public._lock_probe;"
case "$RL" in
  *lock*|*Lock*|*LOCK*) if [ "$RC" != "0" ]; then ok "F3 ⭐ NOWAIT falha na hora sob lock concorrente (não espera em silêncio)"; else bad "F3 NOWAIT não falhou com lock ativo"; fi ;;
  *) bad "F3 esperava erro de lock — veio rc=$RC: $RL" ;;
esac

# F4 ⭐⭐ O ACHADO DO CODEX: na 1ª versão as validações rodavam DEPOIS do COMMIT — detectavam a
#        quebra mas NÃO a revertiam. Aqui: com uma função sabotada, a validação pré-commit levanta
#        exceção, a transação inteira aborta e a tabela VOLTA ao nome original sozinha.
#        Sem este assert, "validar antes do commit" seria só uma frase no comentário.
P -q <<'SQL'
SET check_function_bodies = off;
CREATE OR REPLACE FUNCTION public.seed_targets_faltantes()
RETURNS TABLE(user_id uuid) LANGUAGE sql STABLE SECURITY INVOKER SET search_path=public AS $f$
  SELECT DISTINCT oc.user_id FROM public.tabela_que_nao_existe oc
$f$;
SQL
# volta ao nome original p/ reexecutar a migration do zero
P -q -c "ALTER TABLE public._quarantine_omie_clientes_20260722 RENAME TO omie_clientes;"
P -q -c "GRANT SELECT ON public.omie_clientes TO anon, authenticated;"
set +e
P -q -f "$TMPD/quar.sql" > /dev/null 2>&1
RCQ=$?
set -e
AINDA=$(Pq -c "SELECT (to_regclass('public.omie_clientes') IS NOT NULL)::text;")
QUAR=$(Pq -c "SELECT (to_regclass('public._quarantine_omie_clientes_20260722') IS NULL)::text;")
if [ "$RCQ" != "0" ] && [ "$AINDA" = "true" ] && [ "$QUAR" = "true" ]; then
  ok "F4 ⭐⭐ função quebrada ⇒ validação pré-commit ABORTA e o rename REVERTE (tabela volta ao nome original)"
else
  bad "F4 a transação não reverteu — rc=$RCQ nome_original_existe=$AINDA quarentena_ausente=$QUAR"
fi
# restaura o mundo bom e re-aplica a quarentena
P -q -f "$TMPD/seed.sql"
P -q -f "$TMPD/quar.sql"
eq  "F5 pós-restauro: quarentena aplicada e íntegra" "$(Pq -c 'SELECT count(*) FROM public._quarantine_omie_clientes_20260722;')" "6909"

echo "──────────────────────────────"
echo "RESULTADO: $PASS ok / $FAIL fail"
[ "$FAIL" = "0" ] || { echo "❌ HARNESS VERMELHO"; exit 1; }
echo "✅ HARNESS VERDE"
