#!/usr/bin/env bash
# lovable-recibos.sh — recibo de banco de CADA migration do intervalo <ar>..<head>, para o vigia.
#
# Por que existe: o vigia retinha o front por migration até alguém gravar `liberar` à mão (36 RETIDO
# × 2 liberações em 22–26/11, mediana ~5 h — docs/historico/lovable-publish-automatico.md). Quem
# aplica pelo `bun run db:aplicar` já deixa recibo em public.db_aplicacoes, pelo SHA-256 dos bytes
# commitados. Este script só LÊ (psql-ro) e responde, por arquivo:
#   aplicada     — há recibo `aplicada` para o SHA-256 dos bytes de <head>
#   adiada       — public.db_migracoes_adiadas declara o SHA-256 adiado (não revogado)
#   desconhecido — recibo `tentativa`/`desconhecido` sem `aplicada`: pode ter rodado, não sei
#   sem_recibo   — nenhum recibo (ou só `falhou`): não aplicada pelo db:aplicar
#   removida     — o arquivo saiu do repo no intervalo: nada prova o estado do banco
# NUNCA usa supabase_migrations.schema_migrations (fail-open: docs/historico/schema-migrations-fail-open.md).
#
# Saída: 1ª linha = veredito (0 = todas aplicada/adiada · 1 = alguma sem_recibo/removida ·
# 2 = alguma desconhecida ou não consegui LER), depois `<estado> <arquivo> <sha12>` por migration.
# Exit = o veredito. Uso: scripts/lovable-recibos.sh <ar> <head>   (LP_PSQL_RO = wrapper psql-ro)
set -u
AR=${1:?uso: lovable-recibos.sh <ar> <head>}; HEAD=${2:?uso: lovable-recibos.sh <ar> <head>}
PSQL=${LP_PSQL_RO:-$HOME/.config/afiacao/psql-ro}
sai() { echo "$1"; [ -n "${LINHAS:-}" ] && printf '%s' "$LINHAS"; exit "$1"; }
LINHAS=""
LISTA=$(git diff --no-renames --name-status "$AR" "$HEAD" -- supabase/migrations 2>/dev/null) || { LINHAS="mecanica git-diff $AR..$HEAD -"$'\n'; sai 2; }
[ -n "$LISTA" ] || sai 0
[ -x "$PSQL" ] || { LINHAS=$(printf 'mecanica psql-ro-ausente %s -\n' "$PSQL"); sai 2; }

declare -a ARQ=() SHA=()
while IFS=$'\t' read -r st arq; do
  case "$arq" in *.sql) ;; *) continue ;; esac
  if [ "$st" = D ]; then LINHAS+=$(printf 'removida %s -' "$arq")$'\n'; continue; fi
  h=$(git show "$HEAD:$arq" 2>/dev/null | shasum -a 256 | cut -c1-64)
  [[ "$h" =~ ^[0-9a-f]{64}$ ]] || { LINHAS+=$(printf 'mecanica %s sha-ilegivel' "$arq")$'\n'; sai 2; }
  ARQ+=("$arq"); SHA+=("$h")
done <<< "$LISTA"

VEREDITO=0
if [ "${#SHA[@]}" -gt 0 ]; then
  IN=$(printf "'%s'," "${SHA[@]}"); IN=${IN%,}
  # um SELECT só: estados do ledger + adiada (a tabela pode não existir ainda → nenhuma adiada)
  R=$("$PSQL" -X -A -t -F' ' -v ON_ERROR_STOP=1 -c "
    select s, coalesce((select string_agg(distinct estado, ',') from public.db_aplicacoes where sha256 = s), '-')
    from unnest(array[$IN]) s" 2>&1) || { LINHAS+=$(printf 'mecanica psql-ro %s' "$(printf '%s' "$R" | head -c 120 | tr '\n' ' ')")$'\n'; sai 2; }
  AD=""
  T=$("$PSQL" -X -A -t -v ON_ERROR_STOP=1 -c "select to_regclass('public.db_migracoes_adiadas') is not null" 2>&1) \
    || { LINHAS+="mecanica psql-ro adiadas"$'\n'; sai 2; }
  if [ "$T" = t ]; then
    AD=$("$PSQL" -X -A -t -v ON_ERROR_STOP=1 -c "select sha256 from public.db_migracoes_adiadas
      where revogada_em is null and sha256 = any(array[$IN])" 2>&1) || { LINHAS+="mecanica psql-ro adiadas"$'\n'; sai 2; }
  fi
  for i in "${!SHA[@]}"; do
    est=$(printf '%s\n' "$R" | awk -v s="${SHA[$i]}" '$1 == s { print $2 }')
    [ -n "$est" ] || { LINHAS+=$(printf 'mecanica %s sem-linha-na-resposta' "${ARQ[$i]}")$'\n'; sai 2; }
    case ",$est," in
      *,aplicada,*) e=aplicada ;;
      *) if printf '%s\n' "$AD" | grep -qx "${SHA[$i]}"; then e=adiada
         else case ",$est," in *,tentativa,*|*,desconhecido,*) e=desconhecido ;; *) e=sem_recibo ;; esac; fi ;;
    esac
    LINHAS+=$(printf '%s %s %s' "$e" "${ARQ[$i]}" "${SHA[$i]:0:12}")$'\n'
    case "$e" in desconhecido) VEREDITO=2 ;; sem_recibo) [ "$VEREDITO" = 2 ] || VEREDITO=1 ;; esac
  done
fi
printf '%s' "$LINHAS" | grep -q '^removida ' && [ "$VEREDITO" = 0 ] && VEREDITO=1
sai "$VEREDITO"
