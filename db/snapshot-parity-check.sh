#!/usr/bin/env bash
# Mede a deriva entre `supabase/schema-snapshot.sql` (fonte de DR) e a PRODUÇÃO, objeto a objeto.
# READ-ONLY: só lê o arquivo e o catálogo via psql-ro. Não regenera nada — para isso, db/refresh-snapshot.sh.
#
# POR QUE: o re-dump depende de alguém lembrar de rodá-lo (cadência real jul–out/2026: ~6 semanas).
# Este check é o lembrete. Ele NÃO roda no CI de propósito: falharia PRs de todo mundo por uma tarefa
# que só quem tem a credencial resolve. Roda agendado e AVISA.
#
# Compara por NOME (tabela, view, função public+private, policy) — pega objeto novo/removido.
# Limitação conhecida: NÃO pega policy/função que existe nos dois com CORPO diferente (foi assim que
# 61 policies passaram 24 dias invisíveis em jul/2026, #1509). Para isso, só o re-dump.
#
# Saída: 0 = em dia | 1 = deriva SENSÍVEL (função em `private` ou policy) | 2 = deriva comum | 3 = erro
# Uso: bash db/snapshot-parity-check.sh [arquivo]   (default: supabase/schema-snapshot.sql)
# Compatível com bash 3.2 do macOS.
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SNAP="${1:-$REPO_ROOT/supabase/schema-snapshot.sql}"
PSQLRO="$HOME/.config/afiacao/psql-ro"
[ -r "$SNAP" ]   || { echo "erro: snapshot ilegível: $SNAP"; exit 3; }
[ -x "$PSQLRO" ] || { echo "erro: psql-ro ausente: $PSQLRO"; exit 3; }

T="$(mktemp -d "${TMPDIR:-/tmp}/snapparity.XXXXXX")"; trap 'rm -rf "$T"' EXIT

# Falha de conexão NÃO pode virar "0 objetos em prod" (= tudo sobrando, nada faltando, falso-verde).
ro() { "$PSQLRO" -At -c "$1" 2>"$T/err" | grep -vE '^SET$|^$' || true; }
ext() { echo "NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.objid=$1 AND d.deptype='e')"; }

ro "SELECT relname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE nspname='public' AND relkind IN ('r','p') AND $(ext c.oid)" | sort -u > "$T/p_tabela"
ro "SELECT relname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE nspname='public' AND relkind='v' AND $(ext c.oid)" | sort -u > "$T/p_view"
ro "SELECT DISTINCT nspname||'.'||proname FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE nspname IN ('public','private') AND $(ext p.oid)" | sort -u > "$T/p_funcao"
ro "SELECT tablename||'|'||policyname FROM pg_policies WHERE schemaname='public'" | sort -u > "$T/p_policy"
[ -s "$T/p_tabela" ] && [ -s "$T/p_policy" ] || { echo "erro: catálogo de prod veio vazio (conexão?)"; cat "$T/err"; exit 3; }

grep -oE '^CREATE TABLE public\.[a-z0-9_]+' "$SNAP" | sed 's/.*\.//' | sort -u > "$T/f_tabela"
grep -oE '^CREATE VIEW public\.[a-z0-9_]+'  "$SNAP" | sed 's/.*\.//' | sort -u > "$T/f_view"
grep -oE '^CREATE FUNCTION (public|private)\.[a-z0-9_]+' "$SNAP" | sed 's/^CREATE FUNCTION //' | sort -u > "$T/f_funcao"
grep -oE '^CREATE POLICY ("[^"]+"|[A-Za-z0-9_]+) ON public\.[a-z0-9_]+' "$SNAP" \
  | sed -E 's/^CREATE POLICY "?([^"]+)"? ON public\.(.*)$/\2|\1/' | sort -u > "$T/f_policy"

total=0; sensivel=0
for k in tabela view funcao policy; do
  comm -23 "$T/p_$k" "$T/f_$k" > "$T/falta_$k"; comm -13 "$T/p_$k" "$T/f_$k" > "$T/sobra_$k"
  f=$(wc -l < "$T/falta_$k" | tr -d ' '); s=$(wc -l < "$T/sobra_$k" | tr -d ' ')
  printf '%-7s prod=%-4s snapshot=%-4s faltando=%-3s removidos_em_prod=%s\n' "$k" "$(wc -l < "$T/p_$k" | tr -d ' ')" "$(wc -l < "$T/f_$k" | tr -d ' ')" "$f" "$s"
  total=$((total + f + s))
done
sensivel=$(( $(grep -c '^private\.' "$T/falta_funcao" "$T/sobra_funcao" | awk -F: '{s+=$2} END{print s}') \
           + $(cat "$T/falta_policy" "$T/sobra_policy" | wc -l | tr -d ' ') ))

if [ "$total" -eq 0 ]; then echo "✅ snapshot em dia com prod (por nome)"; exit 0; fi
echo ""
for k in tabela view funcao policy; do
  sed "s/^/  + [$k] /" "$T/falta_$k"; sed "s/^/  - [$k] /" "$T/sobra_$k"
done | head -60
echo ""
if [ "$sensivel" -gt 0 ]; then
  echo "⚠️  deriva SENSÍVEL: $sensivel objeto(s) de autorização (função private / policy). Rode: bash db/refresh-snapshot.sh"
  exit 1
fi
echo "ℹ️  deriva comum: $total objeto(s). Re-dump recomendado: bash db/refresh-snapshot.sh"
exit 2
