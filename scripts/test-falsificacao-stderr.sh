#!/usr/bin/env bash
# test-falsificacao-stderr.sh — a camada 4 dos laços de falsificação (scripts/lib/falsificacao-stderr.sh):
# o que conta como erro NOVO da rodada sabotada, e o embrulho que recolhe o stderr INTEIRO do alvo.
# As mutações que provam o dente de cada caso: scripts/mutcheck.d/falsificacao-stderr.mut.
#
# Uso: bash scripts/test-falsificacao-stderr.sh   (exit 0 = tudo verde)
set -u

here="$(cd "$(dirname "$0")" && pwd)"
LIB="${FALSIFICACAO_STDERR_LIB:-$here/lib/falsificacao-stderr.sh}"
# shellcheck source=scripts/lib/falsificacao-stderr.sh disable=SC1091
. "$LIB"

tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' EXIT
falhas=0
ok()   { printf '  ok   %s\n' "$1"; }
ruim() { printf '  FAIL %s\n' "${1//$'\n'/ | }"; falhas=$((falhas + 1)); }
# arquivo <nome> <linha>… — escreve as linhas (nenhuma = arquivo VAZIO, que existe)
arquivo() { local f="$tmp/$1"; shift; : > "$f"; [ "$#" -eq 0 ] || printf '%s\n' "$@" > "$f"; printf '%s' "$f"; }
novas() { linhas_novas "$@" | LC_ALL=C grep -c . || true; }

echo "▶ linhas_novas — forma nova × repetição"

# F1 — controle VAZIO (o caso comum): a linha da sabotada é nova. O truque `FNR==NR` do awk
# trataria o 2º arquivo como o 1º quando o 1º é vazio, e aprovaria TUDO.
c="$(arquivo c1)"; s="$(arquivo s1 'x.sh: line 9: foo: unbound variable')"
[ "$(novas "$s" "$c")" = 1 ] && ok "F1 controle vazio: o crash da sabotada é novo" || ruim "F1 controle vazio aprovou o crash (FNR==NR?): $(linhas_novas "$s" "$c")"

# F2 — o resíduo do Codex: o controle tem um diagnóstico LEGÍTIMO com assinatura, a sabotada troca por
# um crash REAL. Contando assinaturas dá 1 = 1; por linha, a forma nova aparece.
c="$(arquivo c2 'x.sh: line 3: legado: unbound variable')"; s="$(arquivo s2 'x.sh: line 7: novo: unbound variable')"
[ "$(novas "$s" "$c")" = 1 ] && ok "F2 1=1 não passa: a linha de crash nova é outra forma" || ruim "F2 o crash que troca o diagnóstico legítimo passou"

# F3 — ferramenta externa fora de qualquer lista-negra: o `git diff` com flag inexistente sai só com `usage:`.
c="$(arquivo c3)"; s="$(arquivo s3 'usage: git diff [<options>] [<commit>] [--] [<path>...]')"
[ "$(novas "$s" "$c")" = 1 ] && ok "F3 o 'usage:' do git é novo sem estar em lista nenhuma" || ruim "F3 o 'usage:' passou calado"

# F4 — relatório LEGÍTIMO repetido (o stderr do ocupacao-* é contrato): a forma que o controle disse não
# é nova, quantas vezes vier.
c="$(arquivo c4 'sessões analisadas: 1' 'sessões analisadas: 1')"; s="$(arquivo s4 'sessões analisadas: 1' 'sessões analisadas: 1' 'sessões analisadas: 1')"
[ "$(novas "$s" "$c")" = 0 ] && ok "F4 a 3ª ocorrência de uma linha de relatório não é crash" || ruim "F4 relatório repetido virou erro novo: $(linhas_novas "$s" "$c")"

# F5 — mas a linha de CRASH conta por ocorrência: 1 legítima no controle, 2 na sabotada = 1 nova.
c="$(arquivo c5 'x.sh: line 3: a: unbound variable')"; s="$(arquivo s5 'x.sh: line 3: a: unbound variable' 'x.sh: line 3: a: unbound variable')"
[ "$(novas "$s" "$c")" = 1 ] && ok "F5 a 2ª ocorrência do MESMO crash é nova" || ruim "F5 o crash repetido passou pela forma"

echo "▶ normalização — o que muda entre rodadas sem mudar o sentido"

# N1 — o caminho da CÓPIA do alvo difere entre controle e sabotada; o nº de linha também.
c="$(arquivo c6 '/r/controle.sh: line 12: x: unbound variable')"; s="$(arquivo s6 '/r/sabotado.sh: line 40: x: unbound variable')"
[ "$(novas "$s" "$c" /r/controle.sh /r/sabotado.sh)" = 0 ] && ok "N1 cópia e nº de linha normalizados" || ruim "N1 o caminho da cópia virou erro novo: $(linhas_novas "$s" "$c" /r/controle.sh /r/sabotado.sh)"
[ "$(novas "$s" "$c")" = 1 ] && ok "N1b sem os trechos, a mesma linha é outra forma (o trecho é o que normaliza)" || ruim "N1b normalizou sem trecho — a normalização está larga demais"

# N2 — diretório temporário da rodada (mktemp) some.
c="$(arquivo c7 'cat: /var/folders/ab/xy/T/tmp.AAAA/f: No such file or directory')"; s="$(arquivo s7 'cat: /var/folders/ab/xy/T/tmp.BBBB/f: No such file or directory')"
[ "$(novas "$s" "$c")" = 0 ] && ok "N2 caminho temporário normalizado" || ruim "N2 o mktemp da rodada virou erro novo"

# N3 — dígito fora do 'line N' NÃO é normalizado: código de saída tem sentido (rc=0 ≠ rc=129).
c="$(arquivo c8 'ERRO: rc=0')"; s="$(arquivo s8 'ERRO: rc=129')"
[ "$(novas "$s" "$c")" = 1 ] && ok "N3 rc=129 não vira rc=0" || ruim "N3 a normalização engoliu o código de saída"

echo "▶ fail-closed"
out="$(linhas_novas "$tmp/nao-existe" "$tmp/c1")"; rc=$?
{ [ "$rc" -ne 0 ] && case "$out" in *'JUIZ: stderr AUSENTE'*) true ;; *) false ;; esac; } \
  && ok "A1 stderr ausente é linha de JUIZ e rc≠0, não 'nada novo'" || ruim "A1 arquivo ausente passou por vazio: rc=$rc [$out]"

echo "▶ camada4 + declara_stderr"
log="$tmp/sab.log"; ctl="$tmp/ctl.log"
printf '  ok   T1\n' > "$ctl"; : > "$ctl.stderr"
printf '  FALHA T1\n' > "$log"; printf '%s\n' 'TAXONOMIA-SILENCIOSA n=0 de 1' 'jq: error: syntax error' > "$log.stderr"
declara_stderr sab_x 'TAXONOMIA-SILENCIOSA'
out="$(camada4 sab_x "$log" "$ctl")"
case "$out" in
  *'jq: error'*) case "$out" in *TAXONOMIA*) ruim "D1 a linha DECLARADA seguiu acusada: [$out]" ;; *) ok "D1 a linha declarada sai; o crash do jq fica" ;; esac ;;
  *) ruim "D1 o crash do jq sumiu junto com a declarada: [$out]" ;;
esac
out="$(camada4 sem_declaracao "$log" "$ctl")"
[ "$(printf '%s\n' "$out" | LC_ALL=C grep -c 'stderr do alvo:')" = 2 ] && ok "D2 sem declaração, as duas linhas novas acusam" || ruim "D2 sem declaração: [$out]"
printf '  FALHA T1\n%s\n' 'teste.sh: line 5: arnes: command not found' > "$log"; : > "$log.stderr"
out="$(camada4 sem_declaracao "$log" "$ctl")"
case "$out" in *'log da suíte:'*'command not found'*) ok "D3 o crash do ARNÊS no log acusa" ;; *) ruim "D3 crash do arnês calado: [$out]" ;; esac
( declara_stderr vazia '' ) 2>/dev/null; rc=$?
[ "$rc" -eq 2 ] && ok "D4 declarar trecho VAZIO aborta (casaria qualquer crash)" || ruim "D4 trecho vazio aceito (rc=$rc)"

echo "▶ linha_de_base"
printf '%s\n' 'relatorio: 3' 'x.sh: line 2: y: unbound variable' > "$tmp/lb.log.stderr"
[ "$(linha_de_base "$tmp/lb.log")" = 'stderr do alvo: 2 linha(s), 1 com assinatura de crash' ] \
  && ok "L1 a linha de base diz o que mediu (2 linhas, 1 de crash)" || ruim "L1 [$(linha_de_base "$tmp/lb.log")]"
: > "$tmp/lz.log.stderr"
# sob `set -e`, como no laço do idioma-errexit-leitura: o `grep -c` que conta zero sai 1
lz="$( set -e; linha_de_base "$tmp/lz.log" )"
[ "$lz" = 'stderr do alvo: 0 linha(s), 0 com assinatura de crash' ] \
  && ok "L2 zero medido é '0', dito — e sobrevive a set -e" || ruim "L2 [$lz]"
[ "$(linha_de_base "$tmp/nao-existe.log")" = 'stderr do alvo AUSENTE' ] \
  && ok "L3 arquivo ausente não vira 0 (ausente ≠ zero)" || ruim "L3 [$(linha_de_base "$tmp/nao-existe.log")]"

echo "▶ embrulha_alvo"
alvo="$tmp/alvo.sh"
printf '%s\n' 'read -r x; printf "saida:%s:%s\n" "$x" "$1"; printf "diag:%s\n" "$2" >&2; exit 7' > "$alvo"
emb="$(embrulha_alvo "$alvo" "$tmp/inteiro.err")"
so="$(printf 'entrada\n' | PATH=/nao/existe "$emb" A B 2>"$tmp/fwd.err")"; rc=$?
[ "$rc" -eq 7 ] && ok "E1 o exit do alvo atravessa o embrulho (7), com PATH restrito" || ruim "E1 exit $rc (esperado 7)"
[ "$so" = 'saida:entrada:A' ] && ok "E2 stdin e argumentos chegam ao alvo" || ruim "E2 stdout [$so]"
[ "$(cat "$tmp/inteiro.err")" = 'diag:B' ] && ok "E3 o stderr INTEIRO vai para o arquivo" || ruim "E3 arquivo [$(cat "$tmp/inteiro.err")]"
[ "$(cat "$tmp/fwd.err")" = 'diag:B' ] && ok "E4 e volta no stderr (a suíte vê o que via)" || ruim "E4 stderr devolvido [$(cat "$tmp/fwd.err")]"
printf 'x\n' | "$emb" C D 2>/dev/null >/dev/null
[ "$(LC_ALL=C grep -c . "$tmp/inteiro.err")" = 2 ] && ok "E5 chamada com stderr DESCARTADO pela suíte ainda é recolhida (apensa)" || ruim "E5 [$(cat "$tmp/inteiro.err")]"

echo
if [ "$falhas" -eq 0 ]; then echo "✅ falsificacao-stderr: todos os casos verdes"; exit 0; fi
echo "❌ falsificacao-stderr: $falhas caso(s) vermelho(s)"; exit 1
