#!/usr/bin/env bash
# ╔══════════════════════════════════════════════════════════════════════════════╗
# ║  PROVA — CHECK de domínio em sinal_classe_config.classe (money-path: gate de   ║
# ║  scoring da Fatia 2). Migration: 20260617091500_sinal_classe_config_check_classe ║
# ║                                                                                ║
# ║  Prova: (P1) os 3 do union entram; (N1) 'lixo', (N2) 'marca ' c/ espaço,       ║
# ║  (N3) 'Preco' caixa, (N4) service_role/BYPASSRLS — todos barrados 23514;       ║
# ║  (P3) re-run é no-op; (P4) re-run preserva constraint mais nova (furo Codex);   ║
# ║  (P2) ADD CONSTRAINT sobre dado sujo falha alto (auto-defesa); (F1) falsifica.  ║
# ║  Rode:  bash db/test-sinal_classe_config_check_classe.sh > /tmp/t.log 2>&1; echo "exit=$?" ║
# ╚══════════════════════════════════════════════════════════════════════════════╝
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PGVER=17
PGBIN="/opt/homebrew/opt/postgresql@${PGVER}/bin"
PORT="${PGPORT_TEST:-5467}"     # fora do cluster 5434-5444 dos outros harnesses
SLUG="sinalclasse"
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
ALTER ROLE service_role BYPASSRLS;
SQL

PASS=0; FAIL=0
ok()  { PASS=$((PASS+1)); echo "  ✅ $1"; }
bad() { FAIL=$((FAIL+1)); echo "  ❌ $1"; }
eq()  { if [ "$2" = "$3" ]; then ok "$1 (=$2)"; else bad "$1 — esperado [$3], veio [$2]"; fi; }

# must_reject VALOR RÓTULO — exige que INSERT do VALOR falhe com check_violation (23514).
# Heredoc NÃO-quotado p/ interpolar $1; dollar-quote escapado (\$do\$) p/ o bash não tocar.
# Sentinela CHECK_BARROU_SENTINELA é NOSSA (não o texto do Postgres) — anti-teatro.
must_reject() {
  local R
  R=$(P -tA 2>&1 <<SQL
DO \$do\$
BEGIN
  INSERT INTO public.sinal_classe_config(classe) VALUES ('$1');
  RAISE EXCEPTION 'CHECK_NAO_BARROU_SENTINELA';
EXCEPTION
  WHEN check_violation THEN RAISE NOTICE 'CHECK_BARROU_SENTINELA';
  WHEN OTHERS THEN RAISE;
END
\$do\$;
SQL
) || true
  case "$R" in
    *CHECK_BARROU_SENTINELA*) ok "$2 (rejeitado: check_violation 23514)";;
    *) bad "$2 — NÃO barrou como check_violation; veio: $R";;
  esac
}

echo "═══ setup pronto (PG17 :$PORT) ═══"

# ══════════════════════════════════════════════════════════════════════════════
# ZONA 1 — PRÉ-REQUISITO: a tabela base (definição EXATA da migration 20260616140941,
#          sem as policies RLS, que não tocam o CHECK). Tabela vazia — semeio nos asserts.
# ══════════════════════════════════════════════════════════════════════════════
P -q <<'SQL'
CREATE TABLE IF NOT EXISTS public.sinal_classe_config (
  classe text PRIMARY KEY,
  ativado boolean NOT NULL DEFAULT false,
  ativado_em timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
);
SQL

# ══════════════════════════════════════════════════════════════════════════════
# ZONA 2 — APLICAR A MIGRATION REAL (Lei #1: o .sql commitado)
# ══════════════════════════════════════════════════════════════════════════════
MIG="$REPO_ROOT/supabase/migrations/20260617091500_sinal_classe_config_check_classe.sql"
P -q -f "$MIG"
echo "migration aplicada: $(basename "$MIG")"

# ══════════════════════════════════════════════════════════════════════════════
# ZONA 3 — GRANT (p/ o assert N4 sob service_role chegar ao CHECK, não parar em 42501)
# ══════════════════════════════════════════════════════════════════════════════
P -q <<'SQL'
GRANT INSERT ON public.sinal_classe_config TO service_role;
SQL

# ══════════════════════════════════════════════════════════════════════════════
# ZONA 4 — ASSERTS
# ══════════════════════════════════════════════════════════════════════════════
echo "── asserts ──"

# P1 — os 3 do union (= o seed real da Fatia 2) entram e coexistem com o CHECK.
P -q <<'SQL'
INSERT INTO public.sinal_classe_config (classe) VALUES ('preco'), ('marca'), ('demanda')
  ON CONFLICT (classe) DO NOTHING;
SQL
N=$(Pq -c "SELECT count(*) FROM public.sinal_classe_config WHERE classe IN ('preco','marca','demanda');")
eq "P1 os 3 valores válidos do union entram" "$N" "3"

# N1..N3 — lixo barrado em todas as formas que o gate sujo poderia assumir.
must_reject "lixo"   "N1 'lixo' (classe inexistente)"
must_reject "marca " "N2 'marca ' (espaço à direita — text é byte-a-byte, não faz trim)"
must_reject "Preco"  "N3 'Preco' (caixa errada — IN é case-sensitive; union é lowercase)"

# N4 — CHECK é ABSOLUTO: nem service_role (BYPASSRLS) o contorna (≠ RLS). É a razão de ser CHECK.
R=$(P -tA 2>&1 <<'SQL'
SET ROLE service_role;
DO $$
BEGIN
  INSERT INTO public.sinal_classe_config(classe) VALUES ('lixo_sr');
  RAISE EXCEPTION 'CHECK_NAO_BARROU_SENTINELA';
EXCEPTION
  WHEN check_violation THEN RAISE NOTICE 'CHECK_BARROU_SENTINELA';
  WHEN OTHERS THEN RAISE;
END $$;
SQL
) || true
case "$R" in
  *CHECK_BARROU_SENTINELA*) ok "N4 service_role/BYPASSRLS também barrado (CHECK absoluto, não é RLS)";;
  *) bad "N4 — service_role NÃO foi barrado; veio: $R";;
esac

# P3 — idempotência do padrão DO IF NOT EXISTS: re-aplicar a migration com o constraint já
#      presente é NO-OP (não dropa, não duplica, não erra). É a melhoria vs o antigo DROP+ADD.
P -q -f "$MIG"
CNT=$(Pq -c "SELECT count(*) FROM pg_constraint WHERE conname='sinal_classe_config_classe_check';")
eq "P3 re-run da migration é no-op (DO IF NOT EXISTS não dropa/duplica)" "$CNT" "1"

# P4 — o cenário EXATO do Codex (P1 #3): simula evolução futura — uma constraint de MESMO NOME
#      com uma 4ª classe. Re-aplicar esta migration ANTIGA não pode dropá-la (IF NOT EXISTS
#      preserva pelo nome). Com o padrão antigo DROP+ADD este assert ficaria VERMELHO (o re-run
#      perderia a 4ª classe e deixaria só 3) — é a falsificação que prova o dente do hardening.
P -q -c "ALTER TABLE public.sinal_classe_config DROP CONSTRAINT sinal_classe_config_classe_check;"
P -q -c "ALTER TABLE public.sinal_classe_config ADD CONSTRAINT sinal_classe_config_classe_check CHECK (classe IN ('preco','marca','demanda','novaclasse'));"
P -q -f "$MIG"   # re-aplica a migration antiga (domínio de 3 classes)
DEF=$(Pq -c "SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conname='sinal_classe_config_classe_check';")
case "$DEF" in
  *novaclasse*) ok "P4 re-run preservou a constraint mais nova (4ª classe) — hardening fecha o furo do Codex" ;;
  *) bad "P4 re-run DROPOU a constraint mais nova — hardening sem dente; veio: $DEF" ;;
esac
# restaura o domínio canônico (3 classes) p/ a falsificação seguir do estado verde
P -q -c "ALTER TABLE public.sinal_classe_config DROP CONSTRAINT sinal_classe_config_classe_check;"
P -q -f "$MIG"

# ══════════════════════════════════════════════════════════════════════════════
# ZONA 5 — FALSIFICAÇÃO (Lei #3)
# ══════════════════════════════════════════════════════════════════════════════
echo "── falsificação ──"

# F1 — SABOTA: dropa o CHECK → 'lixo' deve passar a entrar (prova que N1..N4 tinham dente).
P -q -c "ALTER TABLE public.sinal_classe_config DROP CONSTRAINT sinal_classe_config_classe_check;"
if P -q -c "INSERT INTO public.sinal_classe_config(classe) VALUES ('lixo');" >/dev/null 2>&1; then
  ok "F1 sem o CHECK, 'lixo' ENTROU → os asserts negativos têm dente"
else
  bad "F1 droppei o CHECK e 'lixo' AINDA falhou → asserts negativos não provam o CHECK"
fi

# P2 — AUTO-DEFESA: com 'lixo' presente, re-adicionar o CHECK deve FALHAR (23514).
#      Prova que a migration não pode ser aplicada sobre dados sujos sem antes limpar
#      (falha ALTA, não silenciosa) — exatamente a pré-condição "conferir/limpar antes".
R=$(P -tA 2>&1 <<'SQL'
DO $$
BEGIN
  ALTER TABLE public.sinal_classe_config
    ADD CONSTRAINT sinal_classe_config_classe_check CHECK (classe IN ('preco','marca','demanda'));
  RAISE EXCEPTION 'ADDCHECK_NAO_BARROU_SENTINELA';
EXCEPTION
  WHEN check_violation THEN RAISE NOTICE 'ADDCHECK_BARROU_SUJO_SENTINELA';
  WHEN OTHERS THEN RAISE;
END $$;
SQL
) || true
case "$R" in
  *ADDCHECK_BARROU_SUJO_SENTINELA*) ok "P2 ADD CONSTRAINT rejeita aplicar sobre 'lixo' pré-existente (falha alta, não silenciosa)";;
  *) bad "P2 — ADD CONSTRAINT aplicou sobre dado sujo; veio: $R";;
esac

# RESTAURA: limpar 'lixo' ANTES de re-aplicar (senão o ADD CONSTRAINT do .sql valida e falha).
P -q -c "DELETE FROM public.sinal_classe_config WHERE classe='lixo';" >/dev/null
P -q -f "$MIG"
RESTORE=$(Pq -c "SELECT count(*) FROM pg_constraint WHERE conname='sinal_classe_config_classe_check';")
eq "F1.restore CHECK recriado após limpeza (estado verde)" "$RESTORE" "1"

# ── veredito ──
echo "──────────────────────────────"
echo "RESULTADO: $PASS ok / $FAIL fail"
[ "$FAIL" = "0" ] || { echo "❌ HARNESS VERMELHO"; exit 1; }
echo "✅ HARNESS VERDE"
