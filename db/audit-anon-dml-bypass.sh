#!/usr/bin/env bash
# ╔══════════════════════════════════════════════════════════════════════════════╗
# ║  audit-anon-dml-bypass.sh — LINTER de segurança (READ-ONLY, prod via psql-ro)  ║
# ║                                                                                ║
# ║  CONTEXTO: o Supabase concede, por DEFAULT PRIVILEGE (pg_default_acl de         ║
# ║  postgres E supabase_admin), arwdDxtm — INSERT/UPDATE/DELETE/etc — a anon E     ║
# ║  authenticated em ~toda relação nova do schema public (medido 2026-07-11:       ║
# ║  350/382 relações). É o MODELO do Supabase: grant amplo + proteção por RLS e    ║
# ║  security_invoker. O grant SOZINHO NÃO é vazamento — NÃO revogar em massa       ║
# ║  (quebraria telas anon legítimas e briga com a plataforma).                     ║
# ║                                                                                 ║
# ║  O grant só vira DML REAL (escrita bypassando RLS) por DOIS caminhos, que este  ║
# ║  linter vigia no schema INTEIRO (query em db/audit-anon-dml-bypass.sql):        ║
# ║   (1) view ATUALIZÁVEL + security_invoker=OFF → DML roda como owner=postgres,   ║
# ║       bypassa a RLS da base, e anon/authenticated têm o grant → escrita real.   ║
# ║   (2) view ATUALIZÁVEL + invoker=ON + tabela-base SEM RLS → DML passa como o    ║
# ║       role e, sem RLS, não há o que barrar.                                     ║
# ║                                                                                 ║
# ║  Enquanto AMBOS = 0, o awdDxtm é INÓCUO (a proteção invoker=on+RLS está no      ║
# ║  lugar). exit 1 = achou fogo real → tratar aquele objeto. Dente da query        ║
# ║  provado em db/test-audit-anon-dml-bypass.sh. Baseline 1º run (2026-07-11): 0/0.║
# ║                                                                                 ║
# ║  Uso:  bash db/audit-anon-dml-bypass.sh ; echo $?    (0=limpo · 1=fogo · 2=erro)║
# ║  Não é CI (o CI não tem a credencial psql-ro) — é auditoria on-demand.          ║
# ╚══════════════════════════════════════════════════════════════════════════════╝
set -uo pipefail

PSQL="${PSQL_RO:-$HOME/.config/afiacao/psql-ro}"
SQL_FILE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/audit-anon-dml-bypass.sql"
[ -x "$PSQL" ]     || { echo "❌ psql-ro ausente/não-executável: $PSQL"; exit 2; }
[ -f "$SQL_FILE" ] || { echo "❌ query ausente: $SQL_FILE"; exit 2; }

echo "→ auditando views atualizáveis anon/authenticated-DML no public (prod, read-only)…"
RAW="$("$PSQL" -tA -f "$SQL_FILE")" || { echo "❌ falha ao consultar (psql-ro)"; exit 2; }

# filtra o marcador 'HIT|' (ignora as tags 'SET' que o psqlrc-ro read-only ecoa no stdout)
HITS=()
while IFS= read -r ln; do
  case "$ln" in HIT\|*) HITS+=("${ln#HIT|}") ;; esac
done <<< "$RAW"

if [ "${#HITS[@]}" -eq 0 ]; then
  echo "✅ LIMPO: nenhuma view atualizável permite DML de anon/authenticated bypassando RLS."
  echo "   (o grant amplo default do Supabase segue INÓCUO — invoker=on + RLS protegem.)"
  exit 0
fi

echo "❌ FOGO REAL — ${#HITS[@]} caminho(s) de DML bypassando RLS (view | role | motivo):"
for h in "${HITS[@]}"; do echo "   $h"; done
echo ""
echo "   Trate cada um: ligar security_invoker=on na view, OU ligar RLS na tabela-base,"
echo "   OU REVOKE INSERT,UPDATE,DELETE daquela view de anon/authenticated."
exit 1
