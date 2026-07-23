#!/usr/bin/env bash
# verify-edge.sh — verifica se uma edge function foi DEPLOYADA em produção (Lovable/Supabase).
# É o lado-edge do Passo 4 da skill lovable-deploy-verify.
#
# DIFERENÇA CRUCIAL vs frontend: o frontend SERVE seus bytes (grepáveis -> prova por bytes,
# verify-frontend.sh). A edge NÃO serve seu código — só executa. Então NÃO há prova por bytes.
# A verificação de edge é uma ESCADA de confiança:
#
#   N1  EXISTÊNCIA  (este script, sem auth):  OPTIONS na função -> 200/204 (servida) vs 404 (ausente).
#       Preflight CORS, NÃO executa a lógica. Prova que a função está no ar; NÃO prova a VERSÃO.
#   N2  VERSÃO      (precisa PAT do Supabase): Management API -> `version` (incrementa a cada deploy)
#       + `updated_at`. Com SUPABASE_PAT no env, este script consulta; senão imprime o handoff.
#       É a prova canônica de "a versão NOVA está ativa": updated_at recente + version subiu.
#   N3  COMPORTAMENTO (prova real, precisa auth): chamar com um input que exercita a ASSINATURA da
#       mudança (campo novo na resposta, ação nova aceita, etc.) e confirmar. As funções são gated
#       (84/85 no auth) -> founder logado ou cron secret. Específico por mudança, não automatizável aqui.
#
# Uso:   verify-edge.sh <funcao> [<funcao2> ...]
#        SUPABASE_PAT=sbp_xxx verify-edge.sh <funcao>     # tenta também N2 (prova de versão)
#        SUPABASE_REF=<ref>   verify-edge.sh <funcao>     # default: fzvklzpomgnyikkfkzai
# Exit:  0 = todas servidas (N1) · 1 = alguma AUSENTE (404) · 2 = uso inválido
set -uo pipefail

REF="${SUPABASE_REF:-fzvklzpomgnyikkfkzai}"
BASE="https://$REF.supabase.co/functions/v1"
[ "$#" -ge 1 ] || { echo "uso: verify-edge.sh <funcao> [funcao2 ...]   (SUPABASE_PAT=sbp_... p/ provar versão)"; exit 2; }

# Fonte do PAT p/ N2: env SUPABASE_PAT > arquivo (LDV_PAT_FILE > ~/.config/afiacao/supabase-pat,
# mesmo padrão do psql-ro: o founder cria 1x com chmod 600 e toda sessão ganha N2 automático —
# sem isso, cada verificação de versão vira handoff manual na UI do Lovable (#4407: 3 retomadas
# de sessão para confirmar 1 deploy). O valor NUNCA aparece em chat/log — só viaja no header.
if [ -z "${SUPABASE_PAT:-}" ]; then
  pat_file="${LDV_PAT_FILE:-$HOME/.config/afiacao/supabase-pat}"
  if [ -r "$pat_file" ]; then
    SUPABASE_PAT="$(head -1 "$pat_file" | tr -d '[:space:]')"
  fi
fi

any_missing=0
for fn in "$@"; do
  code=$(curl -s -o /dev/null -w '%{http_code}' -X OPTIONS "$BASE/$fn" --max-time 12 || echo "000")
  case "$code" in
    200|204) state="✅ servida (N1 existência)";;
    404)     state="❌ AUSENTE (404) — não deployada"; any_missing=1;;
    000)     state="⚠️ sem resposta (rede/timeout)";;
    *)       state="⚠️ HTTP $code inesperado (existe? gate? veja manualmente)";;
  esac
  printf "  %-30s %s\n" "$fn" "$state"

  # N2: prova de versão via Management API (só se houver PAT)
  if [ -n "${SUPABASE_PAT:-}" ] && [ "$code" != "404" ]; then
    meta=$(curl -s "https://api.supabase.com/v1/projects/$REF/functions/$fn" -H "Authorization: Bearer $SUPABASE_PAT" --max-time 12 || echo '')
    ver=$(printf '%s' "$meta" | grep -oE '"version":[0-9]+' | head -1)
    upd=$(printf '%s' "$meta" | grep -oE '"updated_at":"[^"]+"' | head -1)
    if [ -n "$ver$upd" ]; then echo "        N2 versão: ${ver:-version?} · ${upd:-updated_at?}"
    else echo "        N2: Management API não retornou metadata (PAT sem escopo, ou função fora deste projeto)"; fi
  fi
done

if [ -z "${SUPABASE_PAT:-}" ]; then
  echo ""
  echo "  N1 só prova EXISTÊNCIA, não a versão. Para provar que a versão NOVA está ativa (N2):"
  echo "    SUPABASE_PAT=sbp_xxx $(basename "$0") $*"
  echo "    -> compara version/updated_at (a Management API é a fonte canônica)."
  echo "  Sem PAT, o handoff é: o founder confirma no Lovable que a função mostra 'Active' + updated agora."
  echo "  Permanente (1x): cole um Access Token (supabase.com → Account → Access Tokens) em"
  echo "    ~/.config/afiacao/supabase-pat   (chmod 600 — padrão psql-ro; nunca no chat)"
  echo "  e toda sessão passa a provar N2 sozinha."
fi
[ "$any_missing" = 0 ] || exit 1
