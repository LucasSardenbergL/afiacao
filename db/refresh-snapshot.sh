#!/usr/bin/env bash
# Re-gera `supabase/schema-snapshot.sql` — a fonte de DR — a partir da PRODUÇÃO.
#
# POR QUE ESTE SCRIPT EXISTE: o snapshot ficou 24 dias stale (27/06 → 21/07, PR #1509)
# e nesse intervalo um DR restauraria o banco a um estado ANTERIOR à matriz de autorização
# E2/FU4 — reabrindo os furos que #1434/#1462/#1472/#1485/#1487/#1501 fecharam. A janela
# não abriu por falta de alarme: abriu porque re-gerar dependia de alguém LEMBRAR de um
# procedimento manual. Isto aqui troca a memória por um comando.
#
# O dump é LEITURA PURA (`pg_dump --schema-only`), então sai pela credencial read-only
# (`claude_ro`) — não precisa do chat do Lovable nem de escrita no banco.
#
# ⚠️ O arquivo do repo só é SUBSTITUÍDO depois de 3 provas passarem (integridade, paridade
# com o catálogo, e replay num PG17 descartável). Dump ruim NUNCA entra: é a regra que
# transforma "re-gerar" numa operação sem risco.
#
# Pré-requisitos: brew install postgresql@17 pgvector  +  ~/.config/afiacao/claude_ro.pgpass
# Uso:  bash db/refresh-snapshot.sh            # dump + 3 provas + instala
#       bash db/refresh-snapshot.sh --dry-run  # tudo, menos instalar
#
# Compatível com o bash 3.2 do macOS (sem `mapfile`, sem array associativo).
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PGBIN="/opt/homebrew/opt/postgresql@17/bin"
PGPASS="$HOME/.config/afiacao/claude_ro.pgpass"
PSQLRO="$HOME/.config/afiacao/psql-ro"
TARGET="$REPO_ROOT/supabase/schema-snapshot.sql"
# Sem senha aqui: ela vive no PGPASSFILE (modo 600, fora do repo). Host/user/ref são
# públicos e já documentados em docs/agent/database.md.
CONN="host=aws-1-eu-west-1.pooler.supabase.com port=5432 dbname=postgres user=claude_ro.fzvklzpomgnyikkfkzai sslmode=require"

DRY_RUN=0
[ "${1:-}" = "--dry-run" ] && DRY_RUN=1

TMP="$(mktemp -d "${TMPDIR:-/tmp}/snaprefresh.XXXXXX")"
cleanup() { rm -rf "$TMP"; }
trap cleanup EXIT

fail() { echo "❌ $*" >&2; exit 1; }

[ -x "$PGBIN/pg_dump" ] || fail "pg_dump 17 ausente: brew install postgresql@17 pgvector"
[ -r "$PGPASS" ]        || fail "credencial ausente: $PGPASS"
[ -x "$PSQLRO" ]        || fail "wrapper read-only ausente: $PSQLRO"

DUMP="$TMP/snapshot-novo.sql"

# ─────────────────────────────────────────────────────────────────────────────
echo "→ 1/5  pg_dump da produção (leva ~10 min; o pooler é remoto e fica quieto boa parte do tempo)…"
env PGPASSFILE="$PGPASS" "$PGBIN/pg_dump" \
  --schema-only --schema=public --schema=private --no-owner --no-privileges \
  -f "$DUMP" "$CONN" > "$TMP/pgdump.log" 2>&1 \
  || { cat "$TMP/pgdump.log" >&2; fail "pg_dump falhou"; }

# ─────────────────────────────────────────────────────────────────────────────
echo "→ 2/5  integridade do dump…"
[ -s "$DUMP" ] || fail "dump vazio"
# pg_dump 17 fecha com \unrestrict. Sem isso, o dump foi TRUNCADO — e um dump truncado
# restaura "com sucesso" até a linha em que parou: falha silenciosa clássica.
tail -5 "$DUMP" | grep -q '^\\unrestrict ' || fail "dump não termina em \\unrestrict — truncado"
LINHAS="$(wc -l < "$DUMP" | tr -d ' ')"
[ "$LINHAS" -gt 30000 ] || fail "dump com só $LINHAS linhas — suspeito (esperado >30k)"
if [ -s "$TMP/pgdump.log" ]; then
  echo "   ⚠️  pg_dump emitiu avisos:"; sed 's/^/     /' "$TMP/pgdump.log"
fi
echo "   ok — $LINHAS linhas, termina íntegro"

# ─────────────────────────────────────────────────────────────────────────────
# Paridade com o CATÁLOGO. É o check que pega o modo de falha silencioso: um dump que
# restaura limpo mas não contém tudo (ex.: faltou --schema=private → a matriz de authz
# some sem nenhum erro de sintaxe).
echo "→ 3/5  paridade objeto-a-objeto contra o catálogo de prod…"

ro() { "$PSQLRO" -At -c "$1" 2>/dev/null | grep -vE '^SET$|^$' || true; }

grep -oE '^CREATE TABLE public\.[a-z0-9_]+'   "$DUMP" | sed 's/.*public\.//' | sort -u > "$TMP/f_tables"
grep -oE '^CREATE VIEW public\.[a-z0-9_]+'    "$DUMP" | sed 's/.*public\.//' | sort -u > "$TMP/f_views"
grep -oE '^CREATE FUNCTION public\.[a-z0-9_]+' "$DUMP" | sed 's/.*public\.//' | sort -u > "$TMP/f_funcs"
grep -oE '^CREATE POLICY ("[^"]+"|[A-Za-z0-9_]+) ON public\.[a-z0-9_]+' "$DUMP" \
  | sed -E 's/^CREATE POLICY "?([^"]+)"? ON public\.(.*)$/\2|\1/' | sort -u > "$TMP/f_pol"

ro "SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind IN ('r','p') AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.objid=c.oid AND d.deptype='e') ORDER BY 1;" | sort -u > "$TMP/p_tables"
ro "SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind='v' AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.objid=c.oid AND d.deptype='e') ORDER BY 1;" | sort -u > "$TMP/p_views"
ro "SELECT DISTINCT p.proname FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.objid=p.oid AND d.deptype='e') ORDER BY 1;" | sort -u > "$TMP/p_funcs"
ro "SELECT tablename||'|'||policyname FROM pg_policies WHERE schemaname='public' ORDER BY 1;" | sort -u > "$TMP/p_pol"

PARIDADE_OK=1
for k in tables views funcs pol; do
  falta="$(comm -23 "$TMP/p_$k" "$TMP/f_$k" | wc -l | tr -d ' ')"
  sobra="$(comm -13 "$TMP/p_$k" "$TMP/f_$k" | wc -l | tr -d ' ')"
  prod="$(wc -l < "$TMP/p_$k" | tr -d ' ')"
  printf '   %-7s prod=%-5s dump=%-5s falta=%-4s sobra=%s\n' \
    "$k" "$prod" "$(wc -l < "$TMP/f_$k" | tr -d ' ')" "$falta" "$sobra"
  if [ "$falta" != "0" ] || [ "$sobra" != "0" ]; then
    PARIDADE_OK=0
    [ "$falta" != "0" ] && { echo "     em prod e AUSENTES do dump:"; comm -23 "$TMP/p_$k" "$TMP/f_$k" | sed 's/^/       /'; }
    [ "$sobra" != "0" ] && { echo "     no dump e ausentes de prod:"; comm -13 "$TMP/p_$k" "$TMP/f_$k" | sed 's/^/       /'; }
  fi
done
[ "$PARIDADE_OK" = "1" ] || fail "paridade divergiu — dump NÃO instalado"
echo "   ok — 0 faltando, 0 sobrando"

# ─────────────────────────────────────────────────────────────────────────────
# Replay numa RAIZ TEMPORÁRIA: prova que o dump restaura ANTES de tocar no arquivo do
# repo. O verify-snapshot-replay.sh deriva a raiz do próprio caminho, então basta montar
# uma árvore mínima com o script CANÔNICO (sem editá-lo) apontando para o dump novo.
echo "→ 4/5  replay num PG17 descartável…"
R="$TMP/replayroot"
mkdir -p "$R/db" "$R/supabase"
cp "$REPO_ROOT/db/verify-snapshot-replay.sh" "$REPO_ROOT/db/stubs-supabase.sql" "$R/db/"
cp "$REPO_ROOT/supabase/schema-extensions-prelude.sql" "$R/supabase/"
cp "$DUMP" "$R/supabase/schema-snapshot.sql"
if bash "$R/db/verify-snapshot-replay.sh" > "$TMP/replay.log" 2>&1; then
  grep -E 'REPLAY OK|ENFORCEMENT RLS OK|^(tabelas|views|matviews|functions|triggers|enums|policies)=' "$TMP/replay.log" | sed 's/^/   /'
else
  sed 's/^/   /' "$TMP/replay.log" >&2
  fail "replay falhou — dump NÃO instalado"
fi

# ─────────────────────────────────────────────────────────────────────────────
if [ "$DRY_RUN" = "1" ]; then
  echo "→ 5/5  --dry-run: NÃO instalado. Dump validado em: $DUMP"
  echo "   (o diretório temporário some ao sair; copie antes se quiser guardar)"
  exit 0
fi

echo "→ 5/5  instalando em supabase/schema-snapshot.sql…"
ANTES="$(wc -l < "$TARGET" 2>/dev/null | tr -d ' ' || echo 0)"
cp "$DUMP" "$TARGET"
echo "   ok — $ANTES → $LINHAS linhas"

# Números prontos para o manifest. NÃO edito o manifest automaticamente: ele é uma
# NARRATIVA datada (o que mudou e por quê), não um relatório gerado — e o valor dele
# está justamente em alguém escrever o "por quê".
cat <<RESUMO

────────────────────────────────────────────────────────────
Para o supabase/schema-snapshot.manifest.md (escreva o "por quê" você mesmo):

| Linhas do arquivo | $LINHAS (anterior: $ANTES) |
| \`CREATE TABLE\`  | $(grep -cE '^CREATE TABLE public\.' "$TARGET") |
| \`CREATE VIEW\`   | $(grep -cE '^CREATE VIEW public\.' "$TARGET") |
| \`CREATE FUNCTION\` | $(grep -cE '^CREATE FUNCTION public\.' "$TARGET") (public) + $(grep -cE '^CREATE FUNCTION private\.' "$TARGET") (private) |
| \`CREATE TRIGGER\` | $(grep -cE '^CREATE TRIGGER ' "$TARGET") |
| \`CREATE POLICY\` | $(grep -cE '^CREATE POLICY ' "$TARGET") |
| \`ENABLE ROW LEVEL SECURITY\` | $(grep -cE 'ENABLE ROW LEVEL SECURITY' "$TARGET") |

⚠️ Confira o diff antes de commitar: \`git diff --stat supabase/schema-snapshot.sql\`.
   Objeto REMOVIDO em prod some do dump — o diff é a revisão do drift.
────────────────────────────────────────────────────────────
RESUMO
