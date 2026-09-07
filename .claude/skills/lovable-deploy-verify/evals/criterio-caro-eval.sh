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
# --falsify: sabota cada asserção UMA POR VEZ e exige vermelho. Sabotagem que vira NO-OP (o alvo
#   sumiu do arquivo) é CEGUEIRA, não aprovação — conta como falha, igual às MUTACOES do run.sh.
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
f=0
reg() { if [ "$2" -eq 0 ]; then echo "  [ok ] $1"; else echo "  [XX ] $1"; f=$((f + 1)); fi; }

rodar_suite() {
  f=0
  local recipe n linha
  local fb fr fc
  fb=$(idx "$BARATA"); fr=$(idx "$REVERSIVEL"); fc=$(idx "$CARA")

  if ! recipe=$(extrair_recipe); then
    reg "recipe do critério extraível da SKILL.md (1 e só 1 ocorrência)" 1
    return "$f"   # fail-CLOSED: sem o critério documentado não há o que verificar
  fi
  reg "recipe do critério extraível da SKILL.md (1 e só 1 ocorrência)" 0

  # CONTROLE POSITIVO: o recipe da skill tem de ACHAR algo na edge barata. Um regex que não casa
  # nada devolveria "zero efeito" para qualquer edge do repo — aprovação por cegueira.
  n=$(conta "$recipe" "$fb")
  reg "controle positivo: o recipe acha $n hit(s) em $BARATA (>0)" "$([ "$n" -gt 0 ] && echo 0 || echo 1)"

  # (1) BARATA — zero escrita de banco. `delete` fica FORA deste padrão de propósito: é o
  #     ambíguo, julgado no check (2).
  n=$(conta '\.(upsert|insert|update)\(|\.rpc\(' "$fb")
  reg "$BARATA: zero escrita de banco (upsert/insert/update/rpc = $n)" "$([ "$n" -eq 0 ] && echo 0 || echo 1)"

  # (2) BARATA — o `.delete(` que o recipe acha é `Set.delete` de JS, não do banco. É a armadilha
  #     que fez o critério parecer "escreve": contar o hit sem LER a linha inverte o veredito.
  n=$(conta '\.delete\(' "$fb")
  linha=$(grep -nE '\.delete\(' "$fb" 2>/dev/null | grep -cE 'custoBaixaConfianca\.delete\(' || true)
  reg "$BARATA: o(s) $n \`.delete(\` são Set.delete de JS ($linha casam a coleção JS)" \
    "$([ "$n" -ge 1 ] && [ "$linha" -eq "$n" ] && echo 0 || echo 1)"
  n=$(conta 'const custoBaixaConfianca = new Set' "$fb")
  reg "$BARATA: \`custoBaixaConfianca\` é mesmo um \`new Set\` (e não um client)" \
    "$([ "$n" -ge 1 ] && echo 0 || echo 1)"

  # (3) BARATA — todo `fetch(` é GET de leitura. Nenhum call site declara `method:`, e o arquivo
  #     não tem verbo de escrita em lugar nenhum.
  n=$(grep -E 'fetch\(' "$fb" 2>/dev/null | grep -c 'method' || true)
  reg "$BARATA: nenhum call site de fetch( declara method: ($n)" "$([ "$n" -eq 0 ] && echo 0 || echo 1)"
  n=$(conta 'method: *"(POST|PUT|PATCH|DELETE)"' "$fb")
  reg "$BARATA: zero verbo HTTP de escrita no arquivo ($n)" "$([ "$n" -eq 0 ] && echo 0 || echo 1)"

  # (4) O PROXY REPROVADO ainda erraria — é isto que mantém o contra-exemplo honesto. Se um dia
  #     `fin-valor-cockpit` ganhar dispatch por action, os dois critérios passam a concordar e a
  #     lição perde o dente: melhor descobrir aqui do que num deploy.
  n=$(conta 'switch *\(|body\.action' "$fb")
  reg "$BARATA NÃO despacha por action ($n) ⇒ o proxy reprovado a chamaria de cara" \
    "$([ "$n" -eq 0 ] && echo 0 || echo 1)"

  # (5) REVERSÍVEL — uma escrita só, idempotente por onConflict, e nenhuma chamada externa.
  n=$(conta '\.(upsert|insert|update)\(|\.rpc\(' "$fr")
  linha=$(grep -cE '\.upsert\(.*onConflict|onConflict' "$fr" 2>/dev/null || true)
  reg "$REVERSIVEL: exatamente 1 escrita ($n) e ela é upsert com onConflict ($linha)" \
    "$([ "$n" -eq 1 ] && [ "$linha" -ge 1 ] && echo 0 || echo 1)"
  n=$(conta 'fetch\(' "$fr")
  reg "$REVERSIVEL: zero chamada a serviço externo ($n)" "$([ "$n" -eq 0 ] && echo 0 || echo 1)"

  # (6) CARA de verdade — o contraste. Escreve E dispara POST externo.
  n=$(conta '\.(upsert|insert|update)\(|\.rpc\(' "$fc")
  linha=$(conta 'method: *"POST"' "$fc")
  reg "$CARA: escreve ($n) E dispara POST externo ($linha)" \
    "$([ "$n" -ge 1 ] && [ "$linha" -ge 1 ] && echo 0 || echo 1)"

  # (7) O proxy reprovado está REGISTRADO — apagar a lição é regressão, não faxina.
  n=$(grep -cF 'PROXY REPROVADO' "$SKILL" 2>/dev/null || true)
  reg "SKILL.md registra o PROXY REPROVADO ($n)" "$([ "$n" -ge 1 ] && echo 0 || echo 1)"

  return "$f"
}

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

# Cada sabotagem: (nome | arquivo-alvo | string procurada | substituta). Alvo ausente = NO-OP,
# que é cegueira: o eval estaria passando por acidente naquele eixo.
cegas=0
sabotar() {
  local nome="$1" alvo="$2" de="$3" para="$4" td
  td=$(mktemp -d) || { echo "  [XX ] mktemp falhou"; cegas=$((cegas + 1)); return; }
  preparar_sandbox "$td"
  local arquivo="$td/$alvo"
  if ! grep -qF "$de" "$arquivo"; then
    echo "  [XX ] sabotagem NO-OP (alvo sumiu de $alvo): $nome"
    cegas=$((cegas + 1)); rm -rf "$td"; return
  fi
  # Índice LITERAL: `sed` leria `.`/`(`/`"` do alvo como regex. E os literais entram pelo ENVIRON,
  # nunca por `-v`: `awk -v x='\.'` processa a sequência de escape e entrega `.` — foi assim que a
  # 1ª sabotagem virou NO-OP silencioso (o alvo casava no `grep -F`, e não no `index()` do awk).
  cp "$arquivo" "$arquivo.orig"
  de="$de" para="$para" awk 'BEGIN{de=ENVIRON["de"]; para=ENVIRON["para"]}
    { i=index($0,de); if(i>0) $0=substr($0,1,i-1) para substr($0,i+length(de)); print }' \
    "$arquivo" > "$arquivo.novo" && mv "$arquivo.novo" "$arquivo"
  # PÓS-CONDIÇÃO: o `grep -F` acima diz que o alvo EXISTE; só a comparação diz que a sabotagem
  # PEGOU. Sem ela, qualquer divergência futura entre as duas mecânicas volta a passar batido —
  # ausência de mudança não é sabotagem aplicada.
  if cmp -s "$arquivo" "$arquivo.orig"; then
    echo "  [XX ] sabotagem NÃO ALTEROU o arquivo (NO-OP silencioso): $nome"
    cegas=$((cegas + 1)); rm -rf "$td"; return
  fi
  RAIZ="$td"; SKILL="$td/SKILL.md"
  local saida
  saida=$(rodar_suite); local rc=$?
  RAIZ="$RAIZ_REAL"; SKILL="$SKILL_REAL"
  if [ "$rc" -gt 0 ]; then
    echo "  [ok ] pega ($rc asserção(ões) vermelha(s)): $nome"
  else
    echo "  [XX ] passou despercebida: $nome"
    printf '%s\n' "$saida" | sed 's/^/        /'
    cegas=$((cegas + 1))
  fi
  rm -rf "$td"
}

echo "  falsificação do critério --caro (sabota e exige vermelho)"
sabotar "recipe apagado da SKILL.md" "SKILL.md" \
  "grep -nE '\\.(upsert|insert|update|delete)\\(|\\.rpc\\(|fetch\\('" "grep -n 'nada'"
sabotar "lição do proxy reprovado apagada" "SKILL.md" "PROXY REPROVADO" "proxy antigo"
sabotar "$BARATA ganha escrita de banco" "supabase/functions/$BARATA/index.ts" \
  'const custoBaixaConfianca = new Set' 'await supabase.from("x").upsert({}); const custoBaixaConfianca = new Set'
sabotar "o Set.delete de $BARATA vira delete de BANCO" "supabase/functions/$BARATA/index.ts" \
  'custoBaixaConfianca.delete(' 'supabase.from("custos").delete('
sabotar "$BARATA passa a mandar POST" "supabase/functions/$BARATA/index.ts" \
  '/auth/v1/user`, { headers' '/auth/v1/user`, { method: "POST", headers'
sabotar "$BARATA passa a despachar por action" "supabase/functions/$BARATA/index.ts" \
  'if (req.method === "OPTIONS")' 'switch (body.action) { default: break; } if (req.method === "OPTIONS")'
sabotar "upsert de $REVERSIVEL perde o onConflict" "supabase/functions/$REVERSIVEL/index.ts" \
  "onConflict: 'mes,customer_user_id'" "ignoreDuplicates: false"
sabotar "$CARA deixa de chamar o Omie" "supabase/functions/$CARA/index.ts" \
  'method: "POST"' 'method_: "POST"'

echo "  --falsify: $cegas cegueira(s) (esperado: 0)"
[ "$cegas" -eq 0 ]
