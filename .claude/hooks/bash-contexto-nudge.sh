#!/usr/bin/env bash
# bash-contexto-nudge.sh — PostToolUse(Bash): disciplina de saída de comando.
#
# POR QUÊ: medido em scripts/ocupacao-contexto.sh sobre as 3 sessões mais caras
# de uma janela de 7 dias, o custo de OCUPAÇÃO (tamanho x requests que ainda vão
# reler aquilo) se divide em Read ~55% e Bash ~40% — juntos 95%. O Read já tem
# guard (read-contexto-nudge.sh, #1647); este é o do Bash.
# A cauda é curta e gorda: saídas >= 4.000 chars foram 2,6% das chamadas e 23,4%
# do volume. Uma saída grande CEDO na sessão é relida em todos os requests
# seguintes — é o item mais caro que existe.
#
# O ERRO REAL NÃO É ESQUECER O `head`: as maiores saídas medidas JÁ usavam
# `| head -120` e `| head -60` e ainda assim despejaram 9.784 e 5.460 chars.
# `head -n` limita LINHAS; o contexto se paga em BYTES. Em SQL, log e código a
# linha média passa de 80 chars, então 120 linhas viram ~10k. Por isso a
# mensagem empurra `head -c` / `cut -c` — não "use head".
#
# POST e não PRE de propósito: no PreToolUse só existe o COMANDO, e prever o
# volume pela cara dele é fraco — 46,5% das chamadas medidas caíram em "outros"
# (compostos, heredoc, script inline). Só depois de rodar se sabe o tamanho.
# LIMITAÇÃO ASSUMIDA (mesma do read-nudge): não evita o custo DESTA saída, muda
# a PRÓXIMA decisão.
#
# NÃO BLOQUEIA e NÃO DECIDE PERMISSÃO — só anexa contexto.
#
# BARATO DE PROPÓSITO: 1 jq só. Roda depois de CADA Bash (dezenas por turno).
# Testes em scripts/test-bash-contexto-nudge.sh.
set -u

command -v jq >/dev/null 2>&1 || exit 0

entrada="$(cat)"

# Um único jq: nome da ferramenta, tamanho da saída e o comando.
# A saída do Bash pode vir como string ou como objeto {stdout,stderr,...} —
# `tostring` cobre os dois sem ramificar. O comando vai por último porque `read`
# joga o resto da linha no último campo (comando com tab não desloca os outros).
campos="$(printf '%s' "$entrada" | jq -r '
  [ (.tool_name // ""),
    (((.tool_response // "") | tostring) | length | tostring),
    ((.tool_input.command // "") | gsub("[\\t\\n]"; " "))
  ] | @tsv' 2>/dev/null)"
IFS="$(printf '\t')" read -r tool chars comando <<EOF
$campos
EOF

[ "$tool" = "Bash" ] || exit 0          # defesa se o matcher do settings.json mudar
case "${chars:-}" in ''|*[!0-9]*) exit 0 ;; esac

# 4.000 chars = o corte medido (2,6% das chamadas, 23,4% do volume). Abaixo
# disso o aviso viraria ruído: a saída mediana do Bash tem ~718 chars.
[ "$chars" -ge 4000 ] || exit 0

tokens=$(( chars * 10 / 36 ))           # ~3,6 bytes/token em log, SQL e código
tok_k=$(( tokens / 1000 ))
[ "$tok_k" -ge 1 ] || tok_k=1

# Já tinha `head -n`/`tail -n` e MESMO ASSIM veio grande? Então o problema é a
# unidade (linha vs byte), não a ausência do limite — e o conselho tem de ser
# outro, senão o hook manda fazer o que já foi feito.
tinha_head=0
case "$comando" in
  *"head -"*|*"tail -"*|*" head"*|*" tail"*) tinha_head=1 ;;
esac

# BASH-SAIDA-GRANDE / BASH-LIMITE-POR-LINHA são CONTRATO DE TESTE: marcadores
# ASCII, caixa fixa, exclusivos de um ramo. scripts/test-bash-contexto-nudge.sh
# casa por eles com `command grep` sem -i — prosa acentuada casaria o ramo errado
# sob pt_BR.UTF-8 e não sob LC_ALL=C (#1483). Não troque por trechos em português.
if [ "$tinha_head" -eq 1 ]; then
  msg="🟡 Saída grande mesmo com head/tail: ≈${tok_k}k tokens. head -n corta LINHAS; o contexto paga BYTES.
→ use head -c 2000 (ou cut -c1-200) para limitar de verdade."
  ctx="BASH-LIMITE-POR-LINHA: este comando já limitava com head/tail e ainda assim a saída injetou cerca de ${tok_k}k tokens no contexto, que serão relidos em todo request seguinte desta sessão. A causa é a unidade: 'head -n N' corta N LINHAS, mas o contexto se paga em BYTES — em SQL, log e código a linha passa de 80 chars, então 120 linhas viram ~10k. Da próxima vez limite por bytes: 'head -c 2000', ou 'cut -c1-200' para cortar a largura de cada linha, ou combine ('head -40 | cut -c1-160'). Se precisa do conteúdo inteiro, mande para arquivo e traga só o recorte: 'cmd > /tmp/saida.txt 2>&1; echo \$?; head -c 1500 /tmp/saida.txt' — o arquivo continua lá para consultar com rg/jq sem reinjetar tudo."
else
  if [ "$chars" -ge 12000 ]; then
    grito="🔴"; peso="Isso sozinho pesa mais que muitos arquivos inteiros."
  else
    grito="🟡"; peso="Cada turno seguinte relê esses ${tok_k}k."
  fi
  msg="${grito} Saída grande: ≈${tok_k}k tokens no contexto. ${peso}
→ redirecione para arquivo e traga só o recorte (> /tmp/x.txt; head -c 1500 /tmp/x.txt)."
  ctx="BASH-SAIDA-GRANDE: a saída deste comando injetou cerca de ${tok_k}k tokens no contexto, e cada request seguinte desta sessão relê tudo isso — saída grande no INÍCIO da sessão é o item mais caro que existe. Para os próximos comandos parecidos, nesta ordem: (1) mande a saída para arquivo e traga só o recorte — 'cmd > /tmp/saida.txt 2>&1; echo \$?; head -c 1500 /tmp/saida.txt' (mantém o exit code, que '| tail' engoliria, e o arquivo fica para consultar com rg/jq depois); (2) peça ao comando para responder menos: 'git diff --stat' em vez de 'git diff', 'grep -c'/'grep -l' em vez de listar tudo, 'psql' com LIMIT e colunas nomeadas em vez de SELECT *, 'jq' projetando só os campos que interessam; (3) limite por BYTES e não por linhas — 'head -c 2000', 'cut -c1-200'. Se você realmente precisa de tudo isso agora, siga em frente — isto é um lembrete, não um bloqueio."
fi

jq -n --arg m "$msg" --arg c "$ctx" \
  '{systemMessage:$m, hookSpecificOutput:{hookEventName:"PostToolUse", additionalContext:$c}}'
exit 0
