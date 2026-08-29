#!/usr/bin/env bash
# verify-edge-escrita.sh — lê o N3 PASSIVO por ESCRITA DE APLICAÇÃO (#2086) com os guards que a
# receita em prosa não tinha.
#
# POR QUE ESTE SCRIPT EXISTE (2026-08-29, verificando as 3 edges do chip de 01:50Z)
# --------------------------------------------------------------------------------
# A via nasceu em prosa no Passo 4 da skill e apodreceu em 3 dias, em dois pontos:
#
#   1. O CONTROLE NEGATIVO PRESCRITO NÃO MATERIALIZAVA. A receita mandava ler
#      `SELECT funcao, count(*) ... FROM ia_uso_evento GROUP BY funcao` e afirmava que as
#      vizinhas com limite configurado "saem em zero na mesma leitura". Não saem: `GROUP BY`
#      só produz grupos que TÊM linhas. Rodado em prod devolveu UMA linha (a própria edge), e
#      as três vizinhas simplesmente não apareceram — nem como zero. Quem seguisse a receita
#      ao pé da letra registrava "controle negativo passou" sem ter observado nada. A própria
#      skill se contradizia: o comentário do bloco já dizia `linha única`.
#   2. O JOIN DE PROVENIÊNCIA ERRAVA A CHAVE. `public.profiles` tem `id` E `user_id`; a FK de
#      `ia_uso_evento` aponta para `auth.users(id)`, que casa com `profiles.user_id`. Com
#      `p.id` o join devolve "sem profile" para usuário legítimo — falso sinal de "user_id
#      inventado" bem no teste da condição (c). E `auth.users` é inacessível ao `claude_ro`
#      (`permission denied for schema auth`), então a identidade SÓ se lê por `profiles`.
#
# E a 2ª opinião (Codex, gpt-5.6-sol xhigh) achou o furo MAIOR, que nenhum dos dois cobria:
#
#   3. A ESCRITA PROVA PASSADO, NÃO ESTADO ATUAL. Uma linha pós-merge prova que o bundle novo
#      atendeu ≥1 chamada NAQUELE INSTANTE. Não prova que ele continua no ar: um redeploy ou
#      revert posterior deixa o rastro intacto. Por isso o exit 0 aqui se chama
#      BUNDLE_NOVO_OBSERVADO_EM_T e NUNCA "versão atual confirmada".
#   4. E o "não expira" da skill é literalmente FALSO: o cron `ia-uso-evento-purga`
#      (`23 4 * * *`, `active=t` em prod) apaga `criado_em < now() - interval '7 days'`. A via
#      tem janela de 7 DIAS — muito maior que as 6 h do `pg_net`, mas finita.
#
# EXIT CODES (mesma gramática dos irmãos verify-frontend.sh / verify-edge-eco.sh)
#   0 = BUNDLE_NOVO_OBSERVADO_EM_T — ≥1 escrita pós-corte, proveniência lida, controle mecânico
#       observado. NUNCA leia como "a versão atual é esta".
#   2 = INDETERMINADO — zero escritas pós-corte (ninguém usou a feature), ou corte além da
#       purga. NUNCA leia como "deploy pendente".
#   3 = RECUSA — uso inválido, via de leitura não provada, alvo fora do universo, ou a query
#       não demonstrou discriminar (correlação suspeita).
#
# 🔴 NENHUM exit significa "bundle velho". A via é unidirecional por construção: presença
#    prova, ausência é indeterminada. Edge de usuário não tem denominador que separe "não
#    subiu" de "ninguém usou".
set -uo pipefail

PSQL_RO="${PSQL_RO:-$HOME/.config/afiacao/psql-ro}"
DESDE=""; FUNCAO=""
TABELA="${TABELA:-public.ia_uso_evento}"
UNIVERSO="${UNIVERSO:-public.ia_uso_limite}"
COL_FUNCAO="${COL_FUNCAO:-funcao}"
COL_TS="${COL_TS:-criado_em}"
PURGA_DIAS="${PURGA_DIAS:-7}"

recusa() { printf '❌ RECUSA: %s\n' "$1" >&2; exit 3; }

while [ $# -gt 0 ]; do
  case "$1" in
    --desde)   [ $# -ge 2 ] && [ -n "${2:-}" ] || recusa "--desde exige um timestamp"; DESDE="$2"; shift 2 ;;
    --funcao)  [ $# -ge 2 ] && [ -n "${2:-}" ] || recusa "--funcao exige o slug da edge"; FUNCAO="$2"; shift 2 ;;
    *) recusa "argumento desconhecido '$1'" ;;
  esac
done

[ -n "$DESDE" ]  || recusa "falta --desde '<timestamp do merge, UTC>' — sem corte temporal não há o que guardar"
[ -n "$FUNCAO" ] || recusa "falta --funcao '<slug da edge>' — é ele que nomeia a EDGE na escrita"

# ── Fail-CLOSED na via de leitura ───────────────────────────────────────────────────────────────
# `command -v` não basta: presente-porém-QUEBRADA esvazia o guard igual, e aí "0 escritas" se leria
# como INDETERMINADO honesto em vez de RECUSA. Exija resposta POSITIVA.
PING=$("$PSQL_RO" -Atc "SELECT 1; -- ESCRITA_PING" 2>/dev/null | command grep -cE '^1$')
[ "${PING:-0}" -ge 1 ] || recusa "a via de leitura não respondeu POSITIVAMENTE ($PSQL_RO). Sem ela, 'não achei escrita' seria ausência de dado se passando por veredito."

# ── O UNIVERSO é `limites UNION alvo` ───────────────────────────────────────────────────────────
# Partir só da tabela de LIMITES materializa os zeros que o GROUP BY escondia — mas esconde o ALVO
# se a configuração dele for removida/renomeada. O alvo entra explicitamente, sempre.
LINHAS=$("$PSQL_RO" -At -F '|' -c "
  WITH universo AS (
    SELECT $COL_FUNCAO AS f FROM $UNIVERSO
    UNION SELECT '$FUNCAO'
  )
  SELECT u.f,
         (SELECT count(*) FROM $TABELA e WHERE e.$COL_FUNCAO = u.f),
         (SELECT count(*) FROM $TABELA e WHERE e.$COL_FUNCAO = u.f AND e.$COL_TS > '$DESDE'::timestamptz)
    FROM universo u ORDER BY 2 DESC, 1; -- ESCRITA_ROWS" 2>/dev/null | command grep -v '^SET$')

[ -n "${LINHAS:-}" ] || recusa "a leitura do universo não devolveu linha alguma — inutilizável, e um vazio aqui se leria como 'ninguém escreveu'."

ALVO_TOTAL=""; ALVO_POS=""; VIZ_ZERO=0; VIZ_N=0; TOTAIS=""
while IFS='|' read -r f total pos; do
  [ -z "${f:-}" ] && continue
  if [ "$f" = "$FUNCAO" ]; then
    ALVO_TOTAL="$total"; ALVO_POS="$pos"
    printf '  🎯 %-26s total=%-5s pós-corte=%s\n' "$f" "$total" "$pos"
  else
    VIZ_N=$((VIZ_N+1)); TOTAIS="$TOTAIS $total"
    [ "$total" -eq 0 ] && VIZ_ZERO=$((VIZ_ZERO+1))
    printf '     %-26s total=%-5s pós-corte=%s\n' "$f" "$total" "$pos"
  fi
done <<< "$LINHAS"

[ -n "${ALVO_TOTAL:-}" ] || recusa "'$FUNCAO' não apareceu no universo lido — sem o alvo na leitura não há veredito a dar."

# ── CONTROLE MECÂNICO: a query sabe dizer "não"? ────────────────────────────────────────────────
# O modo de falha que isto pega: a correlação quebra e a query passa a devolver o MESMO número
# para toda função (filtro solto contando a tabela inteira). Aí ela dá "verde para tudo", e o
# alvo positivo não vale nada.
if [ "$VIZ_N" -eq 0 ]; then
  printf '\n  ⚠️  CONTROLE_CRUZADO_NAO_OBSERVADO — o universo tem só o alvo (nenhuma vizinha em %s).\n' "$UNIVERSO"
  printf '      A query representou o alvo, mas NÃO demonstrou saber dizer "não". Não escreva\n'
  printf '      "controle negativo passou": ele não foi observado.\n'
elif [ "$VIZ_ZERO" -eq 0 ]; then
  UNICOS=$(printf '%s' "$TOTAIS" | tr ' ' '\n' | command grep -E '^[0-9]+$' | sort -u | wc -l | tr -d ' ')
  if [ "$UNICOS" -eq 1 ]; then
    recusa "CORRELACAO_SUSPEITA — as $VIZ_N vizinhas têm TODAS o mesmo total ($TOTAIS ) e nenhuma zera. Isso é a assinatura do filtro solto contando a tabela inteira: a query não discrimina, logo o positivo do alvo não prova nada."
  fi
  printf '\n  ⚠️  CONTROLE_CRUZADO_FRACO — nenhuma vizinha zerou, mas os totais divergem entre si,\n'
  printf '      então a correlação está viva. Controle mais fraco que o de zeros, e dito.\n'
else
  printf '\n  ✓ CONTROLE_CRUZADO_OK — %s de %s vizinha(s) em zero: a query SABE dizer "não".\n' "$VIZ_ZERO" "$VIZ_N"
fi

# ── O guard da PURGA — o irmão do TTL de 6 h do pg_net ──────────────────────────────────────────
FORA=$("$PSQL_RO" -Atc "SELECT CASE WHEN '$DESDE'::timestamptz < now() - interval '$PURGA_DIAS days' THEN 1 ELSE 0 END; -- ESCRITA_PURGA" 2>/dev/null | command grep -E '^[01]$' | head -1)
if [ "${FORA:-0}" = "1" ]; then
  # shellcheck disable=SC2016  # crases são texto citado, não expansão
  printf '\n  ⚠️  CORTE_ALEM_DA_PURGA — --desde é mais antigo que %s dias, e o cron `ia-uso-evento-purga`\n' "$PURGA_DIAS"
  printf '      (23 4 * * *, active=t) apaga o que passa disso. Escrita da época pode ter sumido:\n'
  printf '      um zero aqui é a purga falando, não o deploy. O "não expira" da receita é FALSO.\n'
fi

# ── Veredito ────────────────────────────────────────────────────────────────────────────────────
if [ "${ALVO_POS:-0}" -eq 0 ]; then
  # shellcheck disable=SC2016  # crases são texto citado, não expansão
  printf '\n⏳ INDETERMINADO — nenhuma escrita de `%s` posterior a %s.\n' "$FUNCAO" "$DESDE"
  printf '   Isto NÃO é "deploy pendente": pode ser que ninguém tenha usado a feature. Edge de\n'
  printf '   usuário não tem denominador que separe "não subiu" de "não foi chamada". Sem chamada\n'
  printf '   não houve medição.\n'
  exit 2
fi

# Proveniência: `profiles.user_id` (NÃO `profiles.id`) + a role, que vive em `user_roles`.
printf '\n  quem escreveu (proveniência — condição (c)):\n'
"$PSQL_RO" -At -F '|' -c "
  SELECT to_char(e.$COL_TS,'YYYY-MM-DD HH24:MI:SS'), coalesce(p.name,'(sem profile)'), coalesce(r.role::text,'-')
    FROM $TABELA e
    LEFT JOIN public.profiles   p ON p.user_id = e.user_id
    LEFT JOIN public.user_roles r ON r.user_id = e.user_id
   WHERE e.$COL_FUNCAO = '$FUNCAO' AND e.$COL_TS > '$DESDE'::timestamptz
   ORDER BY e.$COL_TS; -- ESCRITA_QUEM" 2>/dev/null | command grep -v '^SET$' \
  | while IFS='|' read -r ts nome role; do
      [ -z "${ts:-}" ] && continue
      printf '     %s  %s (role: %s)\n' "$ts" "$nome" "$role"
    done

# shellcheck disable=SC2016  # crases são texto citado, não expansão
printf '\n✅ BUNDLE_NOVO_OBSERVADO_EM_T — %s escrita(s) de `%s` após %s.\n' "$ALVO_POS" "$FUNCAO" "$DESDE"
printf '   ⚠️  Isto prova que o bundle novo atendeu ≥1 chamada NAQUELE INSTANTE. NÃO prova que ele\n'
printf '   continua no ar: um redeploy ou revert posterior deixaria este rastro intacto. Para\n'
printf '   afirmar "está no ar AGORA", é preciso sonda viva ou marcador observado depois do\n'
printf '   último deploy possível.\n'
exit 0
