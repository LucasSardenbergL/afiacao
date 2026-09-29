# shellcheck shell=bash
# scripts/lib/falsificacao-stderr.sh — a CAMADA 4 dos laços de falsificação de scripts/: a rodada
# sabotada não pode trazer erro que o CONTROLE da mesma invocação não traz. Carregada com `.` pelos
# laços; docs/historico/falsificacao-exit-nao-e-dente.md, seção "A camada 4 por linhas".
#
# Até 2026-09-29 a camada comparava a CONTAGEM de assinaturas do bash (`unbound variable|…`) entre a
# rodada sabotada e o controle. Dois furos, os dois medidos:
#   · contagem: a sabotagem que apaga um diagnóstico legítimo do controle e cria um crash real passa
#     por `1 = 1` (resíduo do Codex, 2026-09-27);
#   · lista-negra: erro de FERRAMENTA fica fora de qualquer lista — o `git diff` com flag inexistente
#     sai 129 só com `usage: …` no stderr (a meta do #2639 mediu o juiz do lovable aprovando isso).
# Aqui o stderr é julgado INTEIRO, por LINHA normalizada, contra a linha de base do controle.
#
# ⚠️ O stderr NÃO é só diagnóstico: nos alvos do `ocupacao-*` ele é CONTRATO (relatório com
# contagens, marcadores que os asserts leem), e a sabotagem o muda de propósito — medido: 4 das 11
# sabotagens do `ocupacao-por-comando` trazem linha que o controle nunca disse, todas o efeito
# declarado delas. Por isso: (1) "nova" é a FORMA que o controle nunca disse — repetir uma linha
# que o controle disse não é crash, a não ser que ela tenha assinatura de crash; (2) o que a sabotagem
# muda de propósito no stderr ela DECLARA (`declara_stderr`), como o `ID!MARCA` do #2606.

# embrulha_alvo <alvo> <arquivo-de-stderr> — escreve, ao lado do alvo, um script que roda o alvo com os
# mesmos argumentos e stdin, APENSA o stderr INTEIRO dele ao arquivo e o devolve no próprio stderr
# (a suíte continua vendo o que via), com o exit preservado. Ecoa o caminho do embrulho. É o canal
# ÚNICO: toda chamada do alvo passa por ele — a que a suíte mescla (`2>&1`), a que ela descarta
# (`2>/dev/null`) e a que ela recolhe. Síncrono de propósito (arquivo, não `tee` em `>(…)`): o
# processo de fundo sobreviveria ao alvo e o juiz leria o arquivo ANTES do fim — fail-open.
# O stderr devolvido sai DEPOIS do stdout (não intercalado): controle e sabotada passam pelo MESMO
# embrulho, então a comparação entre eles segue maçã com maçã.
#
# Tudo por caminho ABSOLUTO resolvido aqui: há suíte que roda o alvo com o PATH RESTRITO a um
# diretório de stubs (`PATH="$tmp/bin-sem-curl"` no orfaos-custosos) — o embrulho que procurasse
# `bash`/`cat` no PATH quebraria ali. O temporário é `<arquivo>.<pid>`, ao lado do arquivo: nem
# `mktemp` (que nesta máquina IGNORA o TMPDIR) nem o TMPDIR que a suíte às vezes aponta para o
# alvo (`executa_t` do bash-contexto-nudge) — um arquivo estranho ali mudaria o que o alvo vê.
embrulha_alvo() {
  local alvo="$1" dest="$2" emb="$1.embrulho.sh" cat_ rm_
  cat_="$(command -v cat)" || { printf 'embrulha_alvo: sem cat no PATH\n' >&2; return 2; }
  rm_="$(command -v rm)" || { printf 'embrulha_alvo: sem rm no PATH\n' >&2; return 2; }
  {
    printf '#!%s\n' "$BASH"
    printf 'alvo=%q; dest=%q; bash_=%q; cat_=%q; rm_=%q\n' "$alvo" "$dest" "$BASH" "$cat_" "$rm_"
    cat <<'EMBRULHO'
e="$dest.$$"
"$bash_" "$alvo" "$@" 2>"$e"; rc=$?
"$cat_" "$e" >> "$dest"; "$cat_" "$e" >&2; "$rm_" -f "$e"
exit "$rc"
EMBRULHO
  } > "$emb" && chmod +x "$emb" && printf '%s\n' "$emb"
}

# A assinatura de CRASH do bash. Não decide o que é novo (isso é a forma da linha); só diz quais
# linhas contam por OCORRÊNCIA — uma linha de crash repetida além do que o controle tem é crash novo.
ASSINATURA_DE_CRASH='unbound variable|command not found|syntax error|bad substitution'

# linhas_novas <sabotada> <controle> [<trecho>…] — as linhas da rodada sabotada que o controle NÃO
# explica, depois de normalizar o que muda entre rodadas sem mudar o sentido: cada <trecho> literal
# (o caminho da cópia do alvo, o diretório da rodada) vira <R>, caminho temporário vira <TMP>, e o
# nº de linha do diagnóstico, N. Nova = forma que o controle nunca disse; para linha com assinatura
# de crash, também cada ocorrência ALÉM das do controle. Sai ≠0 (e ecoa por quê) se não conseguiu
# comparar — quem chama trata isso como linha nova: ausente ≠ vazio.
linhas_novas() {
  local sab="$1" ctl="$2"; shift 2
  [ -f "$sab" ] && [ -f "$ctl" ] || { printf 'JUIZ: stderr AUSENTE (%s ou %s) — ausente não é vazio\n' "$sab" "$ctl"; return 3; }
  TRECHOS="$(printf '%s\n' "$@")" ASSINATURA="$ASSINATURA_DE_CRASH" LC_ALL=C awk '
    function norm(s,   n, t, i, p) {
      n = split(ENVIRON["TRECHOS"], t, "\n")
      for (i = 1; i <= n; i++) if (t[i] != "") while ((p = index(s, t[i])) > 0) s = substr(s, 1, p - 1) "<R>" substr(s, p + length(t[i]))
      gsub(/(\/private)?\/var\/folders\/[^ :"'"'"')]*|(\/private)?\/tmp\/[^ :"'"'"')]*/, "<TMP>", s)
      gsub(/line [0-9]+/, "line N", s)
      return s
    }
    # FILENAME, não FNR==NR: com o controle VAZIO (o caso comum) o FNR==NR trataria as linhas da
    # sabotada como controle e aprovaria tudo.
    FILENAME == ARGV[1] { k = norm($0); visto[k] = 1; conta[k]++; next }
    {
      k = norm($0)
      if (!(k in visto)) { print; next }
      if (k ~ ENVIRON["ASSINATURA"]) { if (conta[k] > 0) conta[k]--; else print }
    }
  ' "$ctl" "$sab" || { printf 'JUIZ: a comparação do stderr falhou (awk)\n'; return 3; }
}

# declara_stderr <sabotagem> <trecho ASCII>… — o que ESTA sabotagem muda de propósito no stderr do
# alvo. Linha nova que contém um trecho declarado não é crash: é o efeito que ela promete.
declara_stderr() {
  local n="$1" t; shift
  # Trecho VAZIO casaria qualquer linha no `grep -F` — a declaração viraria a aprovação de todo crash.
  for t in "$@"; do [ -n "$t" ] || { printf 'declara_stderr %s: trecho VAZIO casaria tudo\n' "$n" >&2; exit 2; }; done
  [ "$#" -gt 0 ] || { printf 'declara_stderr %s: nenhum trecho\n' "$n" >&2; exit 2; }
  printf -v "stderr_$n" '%s\n' "$@"
}

# linha_de_base <controle> — o que o controle MEDIU, dito em voz alta na linha dele: quantas linhas de
# stderr o alvo teve e quantas com assinatura de crash. É a linha de base de toda comparação da
# camada, e "0" impresso é medida; arquivo ausente é dito como tal (ausente ≠ zero).
linha_de_base() {
  local ctl="$1" n c
  [ -f "$ctl.stderr" ] || { printf 'stderr do alvo AUSENTE'; return 0; }
  # `grep -c` que conta ZERO sai 1: sob `set -e` a atribuição mataria o laço (o `0` já foi impresso).
  n="$(LC_ALL=C grep -c '' "$ctl.stderr" || true)"; c="$(LC_ALL=C grep -cE "$ASSINATURA_DE_CRASH" "$ctl.stderr" || true)"
  printf 'stderr do alvo: %s linha(s), %s com assinatura de crash' "$n" "$c"
}

# camada4 <sabotagem> <log> <controle> [<trecho>…] — ecoa o que a rodada sabotada traz de erro que o
# controle não traz: o stderr INTEIRO do alvo (`<log>.stderr`, o do embrulho) e as linhas com
# assinatura de crash do LOG da suíte (o arnês que morre); menos o que a sabotagem declarou. Vazio =
# a camada passa.
camada4() {
  local sab="$1" log="$2" ctl="$3" v decl linha; shift 3
  v="stderr_$sab"; decl="${!v-}"
  {
    linhas_novas "$log.stderr" "$ctl.stderr" "$@" | sed 's/^/stderr do alvo: /'
    { LC_ALL=C grep -E "$ASSINATURA_DE_CRASH" "$log" || true; } > "$log.crash"
    { LC_ALL=C grep -E "$ASSINATURA_DE_CRASH" "$ctl" || true; } > "$ctl.crash"
    linhas_novas "$log.crash" "$ctl.crash" "$@" | sed 's/^/log da suíte: /'
  } | while IFS= read -r linha; do
    case "$linha" in *JUIZ:*) printf '%s\n' "$linha"; continue ;; esac
    if [ -n "$decl" ] && printf '%s' "$linha" | LC_ALL=C grep -qF -f <(printf '%s' "$decl"); then continue; fi
    printf '%s\n' "$linha"
  done
  # O veredito é a SAÍDA (vazia = passa). O status fica 0 de propósito: sob `set -e`/`pipefail` (o
  # idioma-errexit-leitura) um status ≠0 aqui mataria o laço em vez de reprovar a rodada.
  return 0
}
