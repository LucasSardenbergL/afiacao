#!/usr/bin/env bash
# criterio-caro-eval.sh — o critério MEDIDO do `--caro` do `bun run sonda:sql` (escada de edge).
#
# O QUE ESTE EVAL GUARDA. `--caro` põe a edge atrás de uma trava por CASE porque um bundle
# PRÉ-sensor ignora o `{"probe":true}` e roda o fluxo real. Decidir QUEM entra na trava por um
# proxy de FORMA ("a edge despacha por `body.action`?") reprovou em 2026-09-05: marcou
# `fin-valor-cockpit` como cara, e ela não escreve NADA. O critério é o EFEITO, e a SKILL.md o
# documenta como um `grep`. Este eval EXECUTA aquele grep — o extraído da própria SKILL.md, não
# uma cópia — contra as três edges que ela cita, e exige a classificação de volta.
#
# Ele morde em dois eixos que nenhum outro gate cobre:
#   (a) o recipe some/afrouxa na SKILL.md      -> extração fail-CLOSED, exit vermelho;
#   (b) o exemplo APODRECE no repo vivo        -> `fin-valor-cockpit` ganha um `.upsert(` num PR
#       futuro e a skill passa a ensinar "não escreve nada" sobre código que escreve. O gate
#       `docs:citacoes` confere que a LINHA existe; só este confere que ela ainda diz aquilo.
#
# Exit 0 = tudo passou · 1 = divergência · 2 = via de prova não observável (fail-CLOSED).
# --falsify: sabota cada asserção UMA POR VEZ e exige o vermelho dos IDs que a sabotagem DECLARA
#   (não "a suíte ficou vermelha"), nos 2 locales, sobre um controle verde da mesma invocação.
#   Sabotagem que vira NO-OP (o alvo sumiu, ou aparece ≠1 vez) é CEGUEIRA, não aprovação.
set -uo pipefail
cd "$(dirname "$0")" || exit 2

RAIZ_REAL="$(cd ../../../.. && pwd)" || exit 2
SKILL_REAL="$(cd .. && pwd)/SKILL.md"

BARATA="fin-valor-cockpit"
REVERSIVEL="carteira-positivacao-snapshot"
CARA="omie-sync-pedidos-compra"

# Globais que a suíte lê; --falsify os re-aponta para um sandbox sabotado.
RAIZ="$RAIZ_REAL"
SKILL="$SKILL_REAL"

FALSIFY=0
[ "${1:-}" = "--falsify" ] && FALSIFY=1

# --- via de prova: sem ela o eval RECUSA, nunca aprova em silêncio -----------------------------
[ -f "$SKILL_REAL" ] || { echo "❌ via não observável: SKILL.md ausente ($SKILL_REAL)"; exit 2; }
for e in "$BARATA" "$REVERSIVEL" "$CARA"; do
  [ -f "$RAIZ_REAL/supabase/functions/$e/index.ts" ] || {
    echo "❌ via não observável: supabase/functions/$e/index.ts ausente"; exit 2; }
done

idx() { printf '%s/supabase/functions/%s/index.ts' "$RAIZ" "$1"; }
conta() { grep -cE "$1" "$2" 2>/dev/null || true; }

# Extrai o recipe DOCUMENTADO. Fail-CLOSED nos dois lados: zero ocorrências (alguém apagou o
# bloco) e duas ou mais (ambíguo — o eval não escolhe qual é o critério) recusam igual.
extrair_recipe() {
  local achados n
  achados=$(grep -oE "grep -nE '[^']+'" "$SKILL" 2>/dev/null | grep -F 'upsert' || true)
  n=$(printf '%s\n' "$achados" | grep -c . || true)
  [ "$n" -eq 1 ] || return 1
  printf '%s' "$achados" | sed -E "s/^grep -nE '//; s/'\$//"
}

# --- a suíte -----------------------------------------------------------------------------------
# Cada asserção imprime um ID (C1…C12) antes do rótulo: é ele que a falsificação exige de volta.
# `FIM_DA_SUITE` sai nas DUAS saídas desenhadas (a completa e o fail-closed do recipe) — ausente,
# a suíte abortou no meio, e aborto não é asserção.
f=0
reg() { if [ "$3" -eq 0 ]; then echo "  [ok ] $1 $2"; else echo "  [XX ] $1 $2"; f=$((f + 1)); fi; }

rodar_suite() {
  f=0
  local recipe n linha
  local fb fr fc
  fb=$(idx "$BARATA"); fr=$(idx "$REVERSIVEL"); fc=$(idx "$CARA")

  if ! recipe=$(extrair_recipe); then
    reg C1 "recipe do critério extraível da SKILL.md (1 e só 1 ocorrência)" 1
    echo "  FIM_DA_SUITE (fail-closed: sem o recipe)"
    return "$f"   # fail-CLOSED: sem o critério documentado não há o que verificar
  fi
  reg C1 "recipe do critério extraível da SKILL.md (1 e só 1 ocorrência)" 0

  # CONTROLE POSITIVO: o recipe da skill tem de ACHAR algo na edge barata. Um regex que não casa
  # nada devolveria "zero efeito" para qualquer edge do repo — aprovação por cegueira.
  n=$(conta "$recipe" "$fb")
  reg C2 "controle positivo: o recipe acha $n hit(s) em $BARATA (>0)" "$([ "$n" -gt 0 ] && echo 0 || echo 1)"

  # (1) BARATA — zero escrita de banco. `delete` fica FORA deste padrão de propósito: é o
  #     ambíguo, julgado no check (2).
  n=$(conta '\.(upsert|insert|update)\(|\.rpc\(' "$fb")
  reg C3 "$BARATA: zero escrita de banco (upsert/insert/update/rpc = $n)" "$([ "$n" -eq 0 ] && echo 0 || echo 1)"

  # (2) BARATA — o `.delete(` que o recipe acha é `Set.delete` de JS, não do banco. É a armadilha
  #     que fez o critério parecer "escreve": contar o hit sem LER a linha inverte o veredito.
  n=$(conta '\.delete\(' "$fb")
  linha=$(grep -nE '\.delete\(' "$fb" 2>/dev/null | grep -cE 'custoBaixaConfianca\.delete\(' || true)
  reg C4 "$BARATA: o(s) $n \`.delete(\` são Set.delete de JS ($linha casam a coleção JS)" \
    "$([ "$n" -ge 1 ] && [ "$linha" -eq "$n" ] && echo 0 || echo 1)"
  n=$(conta 'const custoBaixaConfianca = new Set' "$fb")
  reg C5 "$BARATA: \`custoBaixaConfianca\` é mesmo um \`new Set\` (e não um client)" \
    "$([ "$n" -ge 1 ] && echo 0 || echo 1)"

  # (3) BARATA — todo `fetch(` é GET de leitura. Nenhum call site declara `method:`, e o arquivo
  #     não tem verbo de escrita em lugar nenhum.
  n=$(grep -E 'fetch\(' "$fb" 2>/dev/null | grep -c 'method' || true)
  reg C6 "$BARATA: nenhum call site de fetch( declara method: ($n)" "$([ "$n" -eq 0 ] && echo 0 || echo 1)"
  n=$(conta 'method: *"(POST|PUT|PATCH|DELETE)"' "$fb")
  reg C7 "$BARATA: zero verbo HTTP de escrita no arquivo ($n)" "$([ "$n" -eq 0 ] && echo 0 || echo 1)"

  # (4) O PROXY REPROVADO ainda erraria — é isto que mantém o contra-exemplo honesto. Se um dia
  #     `fin-valor-cockpit` ganhar dispatch por action, os dois critérios passam a concordar e a
  #     lição perde o dente: melhor descobrir aqui do que num deploy.
  n=$(conta 'switch *\(|body\.action' "$fb")
  reg C8 "$BARATA NÃO despacha por action ($n) ⇒ o proxy reprovado a chamaria de cara" \
    "$([ "$n" -eq 0 ] && echo 0 || echo 1)"

  # (5) REVERSÍVEL — uma escrita só, idempotente por onConflict, e nenhuma chamada externa.
  n=$(conta '\.(upsert|insert|update)\(|\.rpc\(' "$fr")
  linha=$(grep -cE '\.upsert\(.*onConflict|onConflict' "$fr" 2>/dev/null || true)
  reg C9 "$REVERSIVEL: exatamente 1 escrita ($n) e ela é upsert com onConflict ($linha)" \
    "$([ "$n" -eq 1 ] && [ "$linha" -ge 1 ] && echo 0 || echo 1)"
  n=$(conta 'fetch\(' "$fr")
  reg C10 "$REVERSIVEL: zero chamada a serviço externo ($n)" "$([ "$n" -eq 0 ] && echo 0 || echo 1)"

  # (6) CARA de verdade — o contraste. Escreve E dispara POST externo.
  n=$(conta '\.(upsert|insert|update)\(|\.rpc\(' "$fc")
  linha=$(conta 'method: *"POST"' "$fc")
  reg C11 "$CARA: escreve ($n) E dispara POST externo ($linha)" \
    "$([ "$n" -ge 1 ] && [ "$linha" -ge 1 ] && echo 0 || echo 1)"

  # (7) O proxy reprovado está REGISTRADO — apagar a lição é regressão, não faxina.
  n=$(grep -cF 'PROXY REPROVADO' "$SKILL" 2>/dev/null || true)
  reg C12 "SKILL.md registra o PROXY REPROVADO ($n)" "$([ "$n" -ge 1 ] && echo 0 || echo 1)"

  echo "  FIM_DA_SUITE"
  return "$f"
}
N_ASSERTS=12   # C1…C12 — o controle da falsificação exige exatamente estes, todos verdes

# --- sandbox para a falsificação ----------------------------------------------------------------
preparar_sandbox() {
  local dest="$1" e
  for e in "$BARATA" "$REVERSIVEL" "$CARA"; do
    mkdir -p "$dest/supabase/functions/$e"
    cp "$RAIZ_REAL/supabase/functions/$e/index.ts" "$dest/supabase/functions/$e/index.ts"
  done
  cp "$SKILL_REAL" "$dest/SKILL.md"
}

if [ "$FALSIFY" = 0 ]; then
  echo "  critério --caro (efeito medido, não forma do handler)"
  rodar_suite
  rc=$?
  if [ "$rc" -eq 0 ]; then echo "  ✅ criterio-caro: OK"; else echo "  ❌ criterio-caro: $rc divergência(s)"; fi
  exit "$((rc > 0 ? 1 : 0))"
fi

# locales: sonda POSITIVA — "setei LC_ALL" não prova que o locale existe (glibc cai em C calado)
LOCALES="C"
for cand in pt_BR.UTF-8 pt_BR.utf8 en_US.UTF-8 en_US.utf8 C.UTF-8 C.utf8; do
  if [ "$(LC_ALL="$cand" locale charmap 2>/dev/null)" = "UTF-8" ]; then LOCALES="C $cand"; break; fi
done
[ "$LOCALES" = "C" ] && echo "  ⚠️  nenhum locale UTF-8 disponível — falsificação só em C (metade da prova)"

# suite_em <sandbox> <locale> — roda a suíte contra o sandbox num SUBSHELL (globais isolados) e
# separa stdout ($1/out) de stderr ($1/err): a suíte íntegra não escreve nada em stderr, então
# qualquer linha lá é ERRO DE EXECUÇÃO (`[: : integer expression expected` de um grep que falhou).
suite_em() {
  ( export LC_ALL="$2" LANG="$2"; RAIZ="$1"; SKILL="$1/SKILL.md"; rodar_suite ) >"$1/out" 2>"$1/err"
}
# julga <sandbox> <IDs> → 0 só se CADA ID declarado ficou vermelho POR JULGAMENTO: a suíte chegou
# a uma saída desenhada (FIM_DA_SUITE), sem erro de execução, e cada `[XX ] <ID> ` está lá (o
# espaço impede C1 de casar C10). Senão ecoa o motivo. `case` do shell: sem fork, sem shim.
julga() {
  local out id resto="$2"
  out=$(cat "$1/out")
  case "$out" in *FIM_DA_SUITE*) ;; *) echo "a-suite-ABORTOU-sem-FIM_DA_SUITE"; return 1 ;; esac
  [ -s "$1/err" ] && { echo "ERRO-DE-EXECUCAO:$(head -1 "$1/err" | cut -c1-90 | tr ' ' '_')"; return 1; }
  while :; do
    id=${resto%%,*}
    case "$out" in *"[XX ] $id "*) ;; *) echo "o-declarado-$id-NAO-ficou-vermelho"; return 1 ;; esac
    [ "$id" = "$resto" ] && break
    resto=${resto#*,}
  done
}
aplica() { # arquivo de para — substituição LITERAL; o alvo tem de aparecer EXATAMENTE 1 vez.
  # Os literais entram por argv do python, nunca por `awk -v`: `awk -v x='\.'` processa a sequência
  # de escape e entrega `.` — foi assim que a 1ª sabotagem virou NO-OP silencioso. E "exatamente 1"
  # fecha a porta que o `grep -qF` de antes deixava: alvo repetido sabotado só pela metade.
  python3 - "$1" "$2" "$3" <<'PY'
import sys
arq, de, para = sys.argv[1:4]
s = open(arq, encoding="utf-8").read()
if s.count(de) != 1:
    sys.exit("o alvo aparece %d vez(es)" % s.count(de))
open(arq, "w", encoding="utf-8").write(s.replace(de, para, 1))
PY
}

# CONTROLE VERDE na MESMA invocação, por locale, ANTES da 1ª sabotagem: as N asserções verdes, a
# suíte até o fim e stderr vazio. Sem ele, uma suíte sempre-vermelha aprovaria todas as sabotagens.
echo "  falsificação do critério --caro (sabota e exige o vermelho DECLARADO)"
for loc in $LOCALES; do
  td=$(mktemp -d) || { echo "  [XX ] mktemp falhou"; exit 1; }
  preparar_sandbox "$td"; suite_em "$td" "$loc"
  n_ok=$(grep -c '^  \[ok \] C[0-9]* ' "$td/out" || true)
  if [ "$n_ok" != "$N_ASSERTS" ] || grep -q '\[XX \]' "$td/out" || [ -s "$td/err" ] || ! grep -q FIM_DA_SUITE "$td/out"; then
    echo "  [XX ] CONTROLE sem sabotagem NÃO está verde (LC_ALL=$loc: $n_ok/$N_ASSERTS ok) — nenhuma sabotagem foi tentada"
    sed 's/^/        | /' "$td/out" "$td/err" | head -16
    rm -rf "$td"; exit 1
  fi
  rm -rf "$td"
done
echo "  [ok ] controle: $N_ASSERTS asserções verdes com a árvore íntegra (locales: $LOCALES)"

# Cada sabotagem: (IDs que a acusam | nome | arquivo-alvo | string procurada | substituta). IDs
# separados por `,` = E: cada um tem de ficar vermelho. "A suíte ficou vermelha" (o juiz de antes)
# aceitava QUALQUER assert, aborto e erro de execução: um recipe trocado por regex inválido
# derrubava o C2 por ERRO do grep e contava como "recipe apagado" pego.
# → docs/historico/falsificacao-exit-nao-e-dente.md
cegas=0; total=0
sabotar() {
  local ids="$1" nome="$2" alvo="$3" de="$4" para="$5" td loc motivo pegou=0 n_loc=0 errado=""
  total=$((total + 1))
  td=$(mktemp -d) || { echo "  [XX ] mktemp falhou"; cegas=$((cegas + 1)); return; }
  preparar_sandbox "$td"
  cp "$td/$alvo" "$td/alvo.orig"
  if ! aplica "$td/$alvo" "$de" "$para" 2>"$td/aplica.err" || cmp -s "$td/$alvo" "$td/alvo.orig"; then
    echo "  [XX ] sabotagem NÃO aplicou em $alvo ($(tr '\n' ' ' < "$td/aplica.err")): $nome"
    cegas=$((cegas + 1)); rm -rf "$td"; return
  fi
  for loc in $LOCALES; do
    n_loc=$((n_loc + 1))
    suite_em "$td" "$loc"
    if motivo=$(julga "$td" "$ids"); then pegou=$((pegou + 1)); else errado="$errado $loc:$motivo"; fi
  done
  if [ "$pegou" -eq "$n_loc" ]; then
    echo "  [ok ] pega por $ids em $n_loc locale(s): $nome"
  else
    echo "  [XX ] NÃO pega pelo declarado ($ids;$errado): $nome"
    sed 's/^/        | /' "$td/out" "$td/err" | head -16
    cegas=$((cegas + 1))
  fi
  rm -rf "$td"
}

sabotar C1 "recipe apagado da SKILL.md" "SKILL.md" \
  "grep -nE '\\.(upsert|insert|update|delete)\\(|\\.rpc\\(|fetch\\('" "grep -n 'nada'"
sabotar C12 "lição do proxy reprovado apagada" "SKILL.md" "PROXY REPROVADO" "proxy antigo"
sabotar C3 "$BARATA ganha escrita de banco" "supabase/functions/$BARATA/index.ts" \
  'const custoBaixaConfianca = new Set' 'await supabase.from("x").upsert({}); const custoBaixaConfianca = new Set'
sabotar C4 "o Set.delete de $BARATA vira delete de BANCO" "supabase/functions/$BARATA/index.ts" \
  'custoBaixaConfianca.delete(' 'supabase.from("custos").delete('
sabotar C6,C7 "$BARATA passa a mandar POST" "supabase/functions/$BARATA/index.ts" \
  '/auth/v1/user`, { headers' '/auth/v1/user`, { method: "POST", headers'
sabotar C8 "$BARATA passa a despachar por action" "supabase/functions/$BARATA/index.ts" \
  'if (req.method === "OPTIONS")' 'switch (body.action) { default: break; } if (req.method === "OPTIONS")'
sabotar C9 "upsert de $REVERSIVEL perde o onConflict" "supabase/functions/$REVERSIVEL/index.ts" \
  "onConflict: 'mes,customer_user_id'" "ignoreDuplicates: false"
sabotar C11 "$CARA deixa de chamar o Omie" "supabase/functions/$CARA/index.ts" \
  'method: "POST"' 'method_: "POST"'

# CONTROLE NEGATIVO DO JUIZ — o gate de reintrodução. O recipe trocado por um regex INVÁLIDO segue
# extraível (C1 verde) e derruba o C2 por ERRO do grep: sabotagem que só quebra a medição. Ela tem de
# ser RECUSADA; se o juiz a creditar como "recipe apagado", ele voltou a contar erro como dente.
cegas_ok=$cegas; total_ok=$total
sabotar C1 "juiz-negativo: recipe vira regex inválido (só quebra a medição)" "SKILL.md" \
  "grep -nE '\\.(upsert|insert|update|delete)\\(|\\.rpc\\(|fetch\\('" \
  "grep -nE '\\.(upsert|insert|update|delete\\(|\\.rpc\\(|fetch\\('" > /dev/null 2>&1
if [ "$cegas" -eq "$cegas_ok" ]; then
  echo "  [XX ] controle negativo do juiz: um ERRO de medição foi creditado como dente — o juiz perdeu a identidade"
  cegas=$((cegas_ok + 1))
else
  echo "  [ok ] controle negativo do juiz: a sabotagem que só quebra a medição foi RECUSADA"
  cegas=$cegas_ok
fi
total=$total_ok

echo "  --falsify: $cegas cegueira(s) em $total sabotagem(ns) (esperado: 0 em 8)"
[ "$total" -ge 8 ] && [ "$cegas" -eq 0 ]
