#!/usr/bin/env bash
# read-contexto-nudge.sh — PreToolUse(Read): disciplina de leitura.
#
# POR QUÊ: o Read é 60,2% de todo o texto que entra por ferramenta (18,2M tokens
# em 48 dias; 8.836 chamadas, média 2.058 tok). E 82% do custo de token é ENTRADA
# de contexto, não geração — então o alvo é o que ENTRA. Dois bolsos concentram
# o desperdício:
#   (a) VOLUME    — 226 leituras acima de 10k tokens = 2,6% das chamadas e 32%
#                   do volume. Um Read de 50k no início de uma sessão de 1.000
#                   requests é relido ~1.000 vezes (~US$ 25 sozinho).
#   (b) RELEITURA — 2.457 leituras repetidas do MESMO arquivo na MESMA sessão
#                   (28% dos Reads; campeão: um index.ts lido 24 vezes). A cópia
#                   anterior não sai do contexto — a segunda só empilha.
# O contraste com o subagente é a tese: ele lê muito, pensa muito e devolve 638
# tokens em média. Por isso a mensagem EMPURRA para subagente; não proíbe Read.
#
# NÃO BLOQUEIA e NÃO DECIDE PERMISSÃO — só anexa contexto. Emitir
# permissionDecision:"allow" pularia o prompt de permissão de toda leitura
# (auto-aprovaria ler ~/.ssh/id_rsa); "deny"/"ask" quebraria investigação
# legítima. O padrão do repo é nudge; o CI é o gate.
#
# LIMITAÇÃO ASSUMIDA: rodando em PreToolUse, o aviso chega ao modelo junto com o
# resultado da leitura — ele não evita o custo DESTA leitura, muda a PRÓXIMA
# decisão. Evitar a primeira exigiria "ask"/"deny", que foi descartado acima.
#
# BARATO DE PROPÓSITO: 1 jq + 1 stat + 1 head|wc + 1 grep numa marca pequena.
# Roda antes de CADA Read (dezenas por turno), então nada de varrer transcript
# nem chamar git — brigaria com a latência por turno e com o semáforo `heavy`.
# Testes em scripts/test-read-contexto-nudge.sh.
set -u

command -v jq >/dev/null 2>&1 || exit 0

entrada="$(cat)"

# Um único jq para os 5 campos: o hook roda antes de CADA Read (dezenas por
# turno) e cada `printf | jq` custa um fork (~10ms medidos). `file_path` vem por
# último porque `read` joga o resto da linha no último campo — assim um caminho
# com tab não desloca os outros.
campos="$(printf '%s' "$entrada" | jq -r '[(.tool_name // ""), (.session_id // "sem-id"),
  ((.tool_input.limit // 0)|tostring), ((.tool_input.offset // 0)|tostring),
  (.tool_input.file_path // "")] | @tsv' 2>/dev/null)"
IFS="$(printf '\t')" read -r tool sessao limite inicio arquivo <<EOF
$campos
EOF

[ "$tool" = "Read" ] || exit 0        # defesa se o matcher do settings.json mudar
[ -n "${arquivo:-}" ] && [ -f "$arquivo" ] || exit 0   # inexistente: quem reporta é o Read

# Binário/imagem/PDF: a heurística de bytes→tokens não vale (o custo não sai do
# tamanho do arquivo). Silêncio é melhor que conselho errado.
case "$(printf '%s' "$arquivo" | tr '[:upper:]' '[:lower:]')" in
  *.png|*.jpg|*.jpeg|*.gif|*.webp|*.bmp|*.svg|*.ico|*.pdf|*.zip|*.gz|*.woff|*.woff2|*.ttf) exit 0 ;;
esac

# --- quanto ESTA leitura vai injetar -----------------------------------------
# Não é o tamanho do arquivo: o Read lê no máximo `limit` linhas (default 2000) a
# partir de `offset`. Medido no repo: types.ts tem 612KB mas só 58KB nas 2000
# primeiras linhas (19.973 linhas curtas), enquanto bugs-resolvidos.md entrega
# 486KB em 376 linhas (linha média de 1,3KB). Estimar pelo arquivo erraria os
# dois lados — o que conta são as linhas EFETIVAMENTE lidas.
case "$limite" in ''|*[!0-9]*|0) limite=2000 ;; esac    # default do Read
case "$inicio" in ''|*[!0-9]*|0) inicio=1 ;; esac
[ "$limite" -gt 0 ] || exit 0

bytes="$(tail -n "+$inicio" "$arquivo" 2>/dev/null | head -n "$limite" 2>/dev/null | wc -c 2>/dev/null | tr -d ' ')"
case "$bytes" in ''|*[!0-9]*) exit 0 ;; esac
tokens=$(( bytes * 10 / 36 ))          # ~3,6 bytes/token em código e markdown

# --- marca da sessão: o que já foi lido --------------------------------------
# Uma linha por leitura: "<mtime>|<offset>|<limite>|<caminho>". mtime na chave
# porque reler um arquivo QUE MUDOU é legítimo (o conteúdo no contexto está
# velho); offset/limite porque ler OUTRO trecho é leitura complementar, não
# desperdício. Só a repetição exata dos três é cópia pura.
marca="${TMPDIR:-/tmp}/afiacao-read-${sessao}"
mtime="$(stat -f '%m' "$arquivo" 2>/dev/null || stat -c '%Y' "$arquivo" 2>/dev/null || echo 0)"
chave="${mtime}|${inicio}|${limite}|${arquivo}"
vistas=0
if [ -f "$marca" ]; then
  vistas="$(command grep -Fxc -- "$chave" "$marca" 2>/dev/null || echo 0)"
  case "$vistas" in ''|*[!0-9]*) vistas=0 ;; esac
fi
printf '%s\n' "$chave" >> "$marca" 2>/dev/null || true

curto="$(basename -- "$arquivo")"
tok_k=$(( tokens / 1000 ))

# --- (b) releitura: tem precedência ------------------------------------------
# Vem antes do volume de propósito: na 2ª leitura do mesmo arquivo grande o que
# importa é que a cópia JÁ ESTÁ no contexto, não que o arquivo é grande. Sem
# isso, um arquivo grande relido gritaria as duas coisas a cada leitura.
#
# READ-RELEITURA / READ-GRANDE são CONTRATO DE TESTE: marcadores ASCII, caixa
# fixa, exclusivos de um ramo. scripts/test-read-contexto-nudge.sh casa por eles
# com `command grep` sem -i — prosa acentuada casaria o ramo errado sob
# pt_BR.UTF-8 e não sob LC_ALL=C (#1483). Não troque por trechos do português.
if [ "$vistas" -gt 0 ]; then
  n=$(( vistas + 1 ))
  msg="🔁 Releitura: ${curto} (${n}ª vez nesta sessão, arquivo inalterado) — a 1ª cópia continua no contexto."
  ctx="READ-RELEITURA: você já leu ${arquivo} nesta sessão (esta é a ${n}ª vez), no mesmo trecho, e o arquivo NÃO mudou desde então. O conteúdo continua no seu contexto acima — reler injeta uma segunda cópia idêntica e não traz informação nova. Role para cima e use o que já leu. Se precisa de OUTRO trecho, use offset/limit; se quer confirmar uma alteração sua, o resultado do Edit já mostrou o diff."
else
  # --- (a) volume: só na PRIMEIRA leitura daquele trecho ---------------------
  # 10k tokens = o corte medido (2,6% das chamadas, 32% do volume). Abaixo disso
  # o aviso viraria ruído: 96% dos arquivos do repo passam longe.
  [ "$tokens" -ge 10000 ] || exit 0
  if [ "$tokens" -ge 40000 ]; then
    grito="🔴"; peso="Isso sozinho ocupa mais que muitas sessões inteiras."
  else
    grito="🟡"; peso="Cada turno seguinte relê esses ${tok_k}k."
  fi
  msg="${grito} Leitura cara: ${curto} ≈ ${tok_k}k tokens. ${peso}
→ delegue a um subagente (ele devolve ~638 tok em média) ou use rg + Read com offset/limit."
  ctx="READ-GRANDE: a leitura de ${arquivo} vai injetar cerca de ${tok_k}k tokens no contexto, e cada turno seguinte relê tudo isso. Antes de ler o arquivo inteiro de novo, considere, nesta ordem: (1) delegue a um subagente (Agent/Explore) — ele lê muito, pensa muito e devolve ~638 tokens em média, contra os ~2.058 de um Read médio; (2) localize o trecho com Grep/rg e leia só ele com offset/limit; (3) se o alvo é um dump, log ou arquivo gerado (schema-snapshot.sql, types.ts, package-lock.json), prefira consultar com rg/jq a trazer para o contexto. Se você realmente precisa do arquivo inteiro, siga em frente — isto é um lembrete, não um bloqueio."
fi

jq -n --arg m "$msg" --arg c "$ctx" \
  '{systemMessage:$m, hookSpecificOutput:{hookEventName:"PreToolUse", additionalContext:$c}}'
exit 0
