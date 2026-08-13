#!/usr/bin/env bash
# test-tokens-report.sh — TDD do recorte por data de REQUEST em scripts/tokens-report.sh
#
# POR QUÊ ESTE TESTE EXISTE: `--dias N` filtra por mtime do ARQUIVO (`find -mtime`),
# não pela data do request. Um JSONL de sessão retomada tem mtime de hoje e requests
# de meses atrás — medido em 2026-08-04, `--dias 30` devolveu requests desde 05-20,
# 5,1% deles fora da janela nominal. Numa verificação pós-entrega isso é fatal: a
# janela carrega dados PRÉ-mudança e dilui justamente o efeito que se quer medir.
# `--desde`/`--ate` recortam pela data do próprio request; este teste prova que o
# recorte SEGURA (e falsifica: sem ele, o request velho entra).
#
# Uso: bash scripts/test-tokens-report.sh   (exit 0 = verde)
set -u

here="$(cd "$(dirname "$0")" && pwd)"
REPORT="$here/tokens-report.sh"
command -v jq >/dev/null 2>&1 || { echo "SKIP — jq ausente"; exit 0; }

tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' EXIT
export CLAUDE_PROJECTS_DIR="$tmp/projects"
mkdir -p "$CLAUDE_PROJECTS_DIR/proj-teste"

# Dois requests no MESMO arquivo (mtime de agora, portanto sempre dentro de
# --dias): um VELHO em Fable, um NOVO em Opus. É exatamente a forma da armadilha —
# nenhum filtro de mtime consegue separá-los; só a data do request consegue.
JSONL="$CLAUDE_PROJECTS_DIR/proj-teste/sessao.jsonl"
linha() { # $1=timestamp $2=modelo $3=cache_read
  jq -nc --arg t "$1" --arg m "$2" --argjson cr "$3" \
    '{timestamp:$t, sessionId:"s1", message:{model:$m, usage:{
       input_tokens:10, output_tokens:5,
       cache_creation_input_tokens:0, cache_read_input_tokens:$cr}}}'
}
linha "2026-05-20T10:00:00.000Z" "claude-fable-5" 900000 >  "$JSONL"
linha "2026-08-04T10:00:00.000Z" "claude-opus-5"  100000 >> "$JSONL"

fail=0
ok()  { printf '  \033[32mok\033[0m   %s\n' "$1"; }
bad() { printf '  \033[31mFALHA\033[0m %s\n' "$1"; fail=1; }

roda() { bash "$REPORT" --dias 0 "$@" 2>/dev/null; }

# Casa string ASCII, caixa fixa, exclusiva do ramo certo — sem -i (a regra do
# CLAUDE.md: `grep -i` sob pt_BR.UTF-8 dobra acento e casa o ramo errado).
tem()   { printf '%s' "$1" | command grep -q "$2"; }

echo "== recorte por data do REQUEST =="

saida="$(roda --desde 2026-08-01)"
if tem "$saida" "claude-opus-5" && ! tem "$saida" "claude-fable-5"; then
  ok "--desde 2026-08-01 mantém o request novo e corta o velho"
else
  bad "--desde 2026-08-01 deveria deixar SÓ o opus-5"; printf '%s\n' "$saida" | sed 's/^/      /'
fi

saida="$(roda --ate 2026-05-31)"
if tem "$saida" "claude-fable-5" && ! tem "$saida" "claude-opus-5"; then
  ok "--ate 2026-05-31 mantém o request velho e corta o novo"
else
  bad "--ate 2026-05-31 deveria deixar SÓ o fable-5"; printf '%s\n' "$saida" | sed 's/^/      /'
fi

# FALSIFICAÇÃO: sem recorte os DOIS entram. Se este caso passasse a "só um", o
# recorte estaria filtrando por conta própria e os dois testes acima seriam vácuo.
saida="$(roda)"
if tem "$saida" "claude-fable-5" && tem "$saida" "claude-opus-5"; then
  ok "falsificação: SEM --desde/--ate os dois requests entram (mtime não separa)"
else
  bad "sem recorte os dois deveriam entrar"; printf '%s\n' "$saida" | sed 's/^/      /'
fi

echo "== janela real declarada =="
saida="$(roda)"
if tem "$saida" "de 2026-05-20 a 2026-08-04"; then
  ok "imprime a janela REAL de datas (impede ler '--dias 30' como '30 dias')"
else
  bad "deveria imprimir a janela real 2026-05-20..2026-08-04"; printf '%s\n' "$saida" | sed 's/^/      /'
fi

echo "== %reqs ao lado de %custo =="
# 1 request de cada → 50%/50% em REQS, mas o custo pende para o Fable (2x o preço
# e 9x o contexto). É a desproporção que a coluna nova torna visível.
#
# `50[.,]0` e não `50\.0`: o awk formata %.1f pelo LC_NUMERIC — "50.0" sob
# LC_ALL=C e "50,0" sob pt_BR.UTF-8. Casar só o ponto deixava esta asserção
# VERDE no shell de quem escreveu (C) e VERMELHA no do founder (pt_BR) — a
# mesma classe de falso-verde do #1483, com separador decimal no lugar do acento.
saida="$(roda)"
if tem "$saida" "%reqs" && printf '%s' "$saida" | command grep -E -q 'claude-fable-5 +1 +50[.,]0%'; then
  ok "POR MODELO mostra %reqs (fable: 1 req = 50%) além do %custo"
else
  bad "POR MODELO deveria ter coluna %reqs com fable em 50%"; printf '%s\n' "$saida" | sed 's/^/      /'
fi

echo "== dedupe por requestId =="
# UMA resposta com vários blocos (texto + tool_use + tool_use) vira VÁRIAS linhas
# no JSONL, e TODAS repetem o mesmo message.usage — verificado: cada requestId tem
# exatamente 1 valor distinto de usage. Somar linha a linha multiplica o custo.
# Medido em 2026-08-06: 131.605 linhas brutas para 60.376 requests reais (2,18x).
# O relatório inflado por isso chegou a US$ 3.347 numa semana que custou US$ 1.596.
dup_dir() { # $1=nome -> cria dir de projects próprio e ecoa o caminho
  local d="$tmp/$1"; mkdir -p "$d/proj"; printf '%s' "$d"
}
linha_req() { # $1=requestId ("" = ausente, transcript antigo) $2=uuid
  jq -nc --arg r "$1" --arg u "$2" \
    '{timestamp:"2026-08-04T10:00:00.000Z", sessionId:"s1", uuid:$u}
     + (if $r == "" then {} else {requestId:$r} end)
     + {message:{model:"claude-opus-5", usage:{input_tokens:10, output_tokens:5,
         cache_creation_input_tokens:0, cache_read_input_tokens:1000}}}'
}
reqs_de() { # $1=dir de projects -> nº de requests que o relatório contou
  CLAUDE_PROJECTS_DIR="$1" bash "$REPORT" --dias 0 2>/dev/null \
    | command grep -E '^  requests ' | command tr -cd '0-9'
}

# 3 linhas do MESMO request (uuid distinto, como no JSONL real) + 1 request outro.
D="$(dup_dir projects-dup)"
{ linha_req req_AAA u1; linha_req req_AAA u2; linha_req req_AAA u3
  linha_req req_BBB u4; } > "$D/proj/sessao.jsonl"
n="$(reqs_de "$D")"
# 4 = não deduplicou; 1 = colapsou requests distintos. Só o certo dá 2 — a
# asserção fecha dos DOIS lados, então não passa por acidente.
if [ "$n" = "2" ]; then
  ok "3 linhas do mesmo requestId contam 1 request (total 2, não 4 nem 1)"
else
  bad "esperava 2 requests após dedupe, veio '$n'"
fi

# Mesmo request repetido em DOIS arquivos (fork/resume copia o transcript do pai):
# o dedupe tem de ser GLOBAL, não por arquivo.
D="$(dup_dir projects-fork)"
linha_req req_CCC u1 > "$D/proj/pai.jsonl"
{ linha_req req_CCC u1; linha_req req_DDD u2; } > "$D/proj/filho.jsonl"
n="$(reqs_de "$D")"
if [ "$n" = "2" ]; then
  ok "requestId repetido entre arquivos (fork/resume) conta 1 vez"
else
  bad "esperava 2 requests com dedupe global, veio '$n'"
fi

# FALSIFICAÇÃO da chave: transcript SEM requestId (formato antigo) não pode
# colapsar. Se o dedupe usasse campo vazio como chave, estes 2 virariam 1.
D="$(dup_dir projects-sem-req)"
{ linha_req "" u1; linha_req "" u2; } > "$D/proj/sessao.jsonl"
n="$(reqs_de "$D")"
if [ "$n" = "2" ]; then
  ok "falsificação: linhas SEM requestId não colapsam (2 continuam 2)"
else
  bad "sem requestId os 2 requests deveriam sobreviver, veio '$n'"
fi

# TSV de 8 colunas (coletado por versão ANTERIOR ao dedupe) reusado com
# --pular-coleta: a col. 9 não existe. Sem o guard NF < 9 a chave seria vazia e
# IGUAL em toda linha — o arquivo inteiro colapsaria em 1 request. É a regressão
# mais cara possível aqui: silenciosa, e para MENOS custo (parece otimização).
T="$tmp/antigo.tsv"
printf 'proj\t2026-08-04\tclaude-opus-5\t10\t5\t0\t1000\ts1\n'  > "$T"
printf 'proj\t2026-08-04\tclaude-opus-5\t20\t7\t0\t2000\ts1\n' >> "$T"
n="$(bash "$REPORT" --tsv "$T" --pular-coleta 2>/dev/null \
     | command grep -E '^  requests ' | command tr -cd '0-9')"
if [ "$n" = "2" ]; then
  ok "TSV antigo (8 colunas) com --pular-coleta não colapsa (2 continuam 2)"
else
  bad "TSV de 8 colunas deveria manter 2 requests, veio '$n'"
fi

echo "== validação de entrada =="
if bash "$REPORT" --dias 0 --desde "04/08/2026" >/dev/null 2>&1; then rc=0; else rc=$?; fi
if [ "$rc" -eq 2 ]; then
  ok "data em formato errado sai com exit 2"
else
  bad "--desde 04/08/2026 deveria sair 2 (saiu $rc)"
fi

echo
if [ "$fail" -eq 0 ]; then printf '\033[32mVERDE\033[0m — todos os casos passaram\n'; else printf '\033[31mVERMELHO\033[0m\n'; fi
exit "$fail"
