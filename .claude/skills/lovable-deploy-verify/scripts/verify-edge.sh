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
#       + `updated_at`. Seria a prova canônica de "a versão NOVA está ativa" — mas NESTE projeto ela
#       é ESTRUTURALMENTE INDISPONÍVEL: o app roda em Lovable Cloud e o Supabase é da org do LOVABLE,
#       o founder não tem conta com acesso ao ref e NÃO EXISTE token que ele possa gerar. NÃO PEÇA
#       (confirmado 2026-07-23, após 2 pedidos na mesma sessão; docs/agent/deploy.md §Verificação).
#       O env/arquivo segue lido — o mecanismo vale para outro setup, só não tem quem preencha aqui.
#   N3  COMPORTAMENTO (prova real, precisa auth): chamar com um input que exercita a ASSINATURA da
#       mudança (campo novo na resposta, ação nova aceita, etc.) e confirmar. As funções são gated
#       (84/85 no auth) -> founder logado ou cron secret. Específico por mudança, não automatizável aqui.
#
# Uso:   verify-edge.sh <funcao> [<funcao2> ...]
#        SUPABASE_PAT=sbp_xxx verify-edge.sh <funcao>     # N2 — indisponível neste projeto (ver acima)
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
  echo "  N1 só prova EXISTÊNCIA, não a versão."
  echo "  ⛔ NÃO PEÇA PAT AO FOUNDER — neste projeto o N2 é ESTRUTURALMENTE INDISPONÍVEL:"
  echo "     o app roda em Lovable Cloud e o Supabase (ref $REF) é da org do LOVABLE. O founder"
  echo "     não tem conta em supabase.com com acesso a esse ref, logo NÃO EXISTE Access Token"
  echo "     que ele possa gerar (confirmado 2026-07-23 após eu pedir 2x; docs/agent/deploy.md)."
  echo "     ~/.config/afiacao/supabase-pat segue válido como mecanismo — só que sem quem preencha."
  echo "  Escada REAL aqui, na ordem:"
  echo "    N1 existência ....... acima (OPTIONS)"
  echo "    rastro do deploy .... commit do bot na main ('Deployed …'/'Redeployed …') — prova que UM"
  echo "                          deploy rodou, não QUAL versão; ausência dele não prova o contrário"
  echo "    canária ............. comportamento assinado pela mudança — a ÚNICA prova de versão aqui"
  echo "  Edge SEM canária: declare 'N1 + rastro; versão não provada' — nunca 'no ar'."
fi
[ "$any_missing" = 0 ] || exit 1
