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
[[ "$ARQ" =~ ^supabase/migrations/[A-Za-z0-9_.-]+\.sql$ ]] || morre 2 "uso: db-adiar.sh [--revogar] <supabase/migrations/arq.sql> [\"motivo\"]"
git ls-files --error-unmatch -- "$ARQ" >/dev/null 2>&1 || morre 2 "não versionado: $ARQ"
[ -z "$(git status --porcelain -- "$ARQ")" ] || morre 2 "alteração não commitada em $ARQ — o SHA tem de ser o dos bytes do commit"
SHA=$(git show "HEAD:$ARQ" | shasum -a 256 | cut -c1-64)
[[ "$SHA" =~ ^[0-9a-f]{64}$ ]] || morre 6 "sha256 ilegível"
[ -x "$RW" ] || morre 6 "psql-rw ausente: $RW"
if [ "$REVOGAR" = 1 ]; then
  # Revogar depois que o front foi ao ar sobre a migration adiada deixaria o ar dependendo de DDL que o
  # gate não volta a olhar (ela já está atrás do ar — Codex PR2 #1). Aí o caminho é APLICAR (db:aplicar).
  AR=${DB_ADIAR_AR:-$(bash "$(dirname "$0")/lovable-publish.sh" --julgar HEAD 2>/dev/null | sed -n 's/^ar=\([0-9a-f]*\) .*/\1/p' | head -1)}   # DB_ADIAR_AR: só teste
  [ -n "$AR" ] && AR=$(git rev-parse --verify --quiet "$AR^{commit}") || morre 6 "não li o commit no ar — não revogo às cegas"
  INTRO=$(git log --diff-filter=A --format=%H -- "$ARQ" | tail -1)
  [ -n "$INTRO" ] || morre 6 "não achei o commit que introduziu $ARQ"
  git merge-base --is-ancestor "$INTRO" "$AR" && morre 2 "$ARQ já está no ar (${AR:0:8}): revogar não volta a reter nada — aplique com bun run db:aplicar $ARQ"
  SQL="update public.db_migracoes_adiadas set revogada_em = now() where sha256 = :'sha' and arquivo = :'arq' and revogada_em is null;"
else
  [ "${#MOTIVO}" -ge 10 ] || morre 2 "motivo obrigatório (≥10 caracteres): por que esta migration NÃO vai ao banco agora?"
  SQL="insert into public.db_migracoes_adiadas (sha256, arquivo, motivo) values (:'sha', :'arq', :'mot')
       on conflict (sha256) do update set arquivo = excluded.arquivo, motivo = excluded.motivo, revogada_em = null, adiada_em = now();"
fi
# valores como VARIÁVEIS do psql (:'x' cita e escapa) e o SQL pela entrada — nada interpolado (Codex PR2 #7)
printf '%s\n' "$SQL" | "$RW" -X -q -v ON_ERROR_STOP=1 -v sha="$SHA" -v arq="$ARQ" -v mot="$MOTIVO" >/dev/null 2>&1 \
  || morre 6 "não gravei em db_migracoes_adiadas (psql-rw)"
# releitura por fora: o estado gravado é o que vale, não o exit do UPDATE/INSERT
EST=$(printf '%s\n' "select case when revogada_em is null then 'adiada' else 'revogada' end from public.db_migracoes_adiadas where sha256 = :'sha' and arquivo = :'arq';" \
  | "$RW" -X -A -t -v ON_ERROR_STOP=1 -v sha="$SHA" -v arq="$ARQ" 2>/dev/null) || morre 6 "não reli db_migracoes_adiadas"
ESPERADO=adiada; [ "$REVOGAR" = 1 ] && ESPERADO=revogada
[ "$EST" = "$ESPERADO" ] || morre 6 "releitura: '$EST' (esperado $ESPERADO) para ${SHA:0:12}"
echo "✅ $ARQ ${SHA:0:12} → $EST"
