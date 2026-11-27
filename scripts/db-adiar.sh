#!/usr/bin/env bash
# db-adiar.sh — declara uma migration DELIBERADAMENTE não aplicada (status `adiada`), ou revoga.
#
# Por que existe: o vigia do Publish libera o front sozinho quando toda migration de ar..main tem
# recibo `aplicada` do `db:aplicar` (scripts/lovable-recibos.sh). Uma migration que se decidiu NÃO
# aplicar agora travaria o Publish para sempre — esta é a declaração explícita, por SHA-256 dos
# bytes COMMITADOS, com motivo, em public.db_migracoes_adiadas (só claude_rw escreve; o vigia lê).
# Mudou o arquivo depois? O SHA muda e a declaração não vale mais — de propósito.
#
# Uso:
#   bash scripts/db-adiar.sh <supabase/migrations/arq.sql> "<motivo, ≥10 caracteres>"
#   bash scripts/db-adiar.sh --revogar <supabase/migrations/arq.sql>
# Exit: 0 gravado/revogado (com releitura) · 2 uso/arquivo inválido · 6 não consegui gravar/ler.
set -u
RW="${AFIACAO_PSQL_RW:-$HOME/.config/afiacao/psql-rw}"
morre() { echo "❌ $2" >&2; exit "$1"; }
REVOGAR=0; [ "${1:-}" = --revogar ] && { REVOGAR=1; shift; }
ARQ=${1:-}; MOTIVO=${2:-}
[[ "$ARQ" =~ ^supabase/migrations/[^/]+\.sql$ ]] || morre 2 "uso: db-adiar.sh [--revogar] <supabase/migrations/arq.sql> [\"motivo\"]"
git ls-files --error-unmatch -- "$ARQ" >/dev/null 2>&1 || morre 2 "não versionado: $ARQ"
[ -z "$(git status --porcelain -- "$ARQ")" ] || morre 2 "alteração não commitada em $ARQ — o SHA tem de ser o dos bytes do commit"
SHA=$(git show "HEAD:$ARQ" | shasum -a 256 | cut -c1-64)
[[ "$SHA" =~ ^[0-9a-f]{64}$ ]] || morre 6 "sha256 ilegível"
[ -x "$RW" ] || morre 6 "psql-rw ausente: $RW"
if [ "$REVOGAR" = 1 ]; then
  SQL="update public.db_migracoes_adiadas set revogada_em = now() where sha256 = '$SHA' and revogada_em is null"
else
  [ "${#MOTIVO}" -ge 10 ] || morre 2 "motivo obrigatório (≥10 caracteres): por que esta migration NÃO vai ao banco agora?"
  M=${MOTIVO//\'/\'\'}
  SQL="insert into public.db_migracoes_adiadas (sha256, arquivo, motivo) values ('$SHA', '$ARQ', '$M')
       on conflict (sha256) do update set motivo = excluded.motivo, revogada_em = null, adiada_em = now()"
fi
"$RW" -X -q -v ON_ERROR_STOP=1 -c "$SQL" >/dev/null 2>&1 || morre 6 "não gravei em db_migracoes_adiadas (psql-rw)"
# releitura por fora: o estado gravado é o que vale, não o exit do UPDATE/INSERT
EST=$("$RW" -X -A -t -v ON_ERROR_STOP=1 -c "select case when revogada_em is null then 'adiada' else 'revogada' end
  from public.db_migracoes_adiadas where sha256 = '$SHA'" 2>/dev/null) || morre 6 "não reli db_migracoes_adiadas"
ESPERADO=adiada; [ "$REVOGAR" = 1 ] && ESPERADO=revogada
[ "$EST" = "$ESPERADO" ] || morre 6 "releitura: '$EST' (esperado $ESPERADO) para ${SHA:0:12}"
echo "✅ $ARQ ${SHA:0:12} → $EST"
