#!/usr/bin/env bash
# classify.sh — FONTE ÚNICA da classificação do Passo 1 da skill lovable-deploy-verify.
# Lê nomes de arquivo (1 por linha) do stdin e diz quais camadas de deploy manual do
# Lovable o conjunto toca. O Passo 1 do SKILL.md usa este script; o evals/run.sh testa
# este script. Uma fonte = sem divergência.
#
# Uso:  git diff --name-only origin/main...HEAD | ./classify.sh
# Saída (4 linhas):  frontend=SIM|não / edge=SIM|não / migration=SIM|não / secrets=…
#
# As 3 primeiras camadas são função PURA dos nomes. A 4ª (secrets) precisa do CONTEÚDO
# dos arquivos e do resto do repo, e por isso lê o disco a partir de $CLASSIFY_RAIZ
# (default: $PWD — o Passo 1 roda da raiz do repo; o eval aponta para fixtures).
#
# Modo --bundle (usado pelo scripts/monitor-deploy.sh): mesma tabela, pergunta mais fina.
#   Uso:   git diff --no-renames --name-only <ar> <main> | ./classify.sh --bundle
#   Saída: "<CLASSE>\t<path>" por linha não vazia + "FIM_CLASSIFICACAO_BUNDLE <n>" no fim.
#   CLASSE = ALCANCA | PACKAGE_JSON | INERTE | DESCONHECIDO (ver a tabela abaixo).
set -euo pipefail

# ---------------------------------------------------------------------------
# Tabela ÚNICA do que alcança o bundle servido — fonte do `frontend=` do Passo 1 E do
# `--bundle` do monitor. Duas listas separadas divergiriam (a do Passo 1 já tinha perdido
# public/, .env, tsconfig e os lockfiles de texto: medido em 2026-09-10).
#
# ALCANCA  = lido pelo `vite build` ou pelo install que o precede: src/ e public/ (copiado
#            para o dist), os configs de build, tsconfig (esbuild/resolução), .env (VITE_* é
#            inlinado), lockfiles e config de install, patches/, e os globs de `content` do
#            Tailwind fora de src/ (pages/, components/, app/).
# PACKAGE_JSON = pode ou não alcançar; o Passo 1 conta como frontend (errar para mais custa
#            uma linha de checklist) e o monitor compara o CONTEÚDO (alcance-bundle.py).
# INERTE   = PROVADAMENTE fora do build. Lista FECHADA de propósito: path que não está nem
#            aqui nem em ALCANCA é DESCONHECIDO, e desconhecido SEGURA o alarme do monitor
#            (fail-closed). No Passo 1, desconhecido segue como frontend=não (comportamento
#            de antes). "Inerte" só vale junto com a prova de fechamento do alcance-bundle.py
#            (nada do bundle importa estes caminhos) — a tabela classifica NOMES.
# ---------------------------------------------------------------------------
AWK_TABELA='
function alcanca(p) {
  if (p ~ /^(src|public|patches|pages|components|app)\//) return 1
  if (index(p, "/") != 0) return 0
  return (p == "index.html" || p == "components.json" ||
          p ~ /^(vite|tailwind|postcss)\.config\./ ||
          p ~ /^tsconfig.*\.json$/ ||
          p ~ /^\.env/ ||
          p ~ /^(bun\.lockb?|package-lock\.json|npm-shrinkwrap\.json|yarn\.lock|pnpm-lock\.yaml)$/ ||
          p ~ /^(bunfig\.toml|\.npmrc|\.yarnrc|\.yarnrc\.yml|\.pnpmfile\.cjs|\.browserslistrc|browserslist)$/)
}
function inerte(p) {
  if (p ~ /^(docs|scripts|db|supabase|connector|\.claude|\.github)\//) return 1
  if (index(p, "/") != 0) return 0
  return (p ~ /\.md$/ || p ~ /^(vitest|eslint)\.config\./ || p == "knip.json" || p == ".gitignore")
}
function classe(p) {
  if (alcanca(p)) return "ALCANCA"
  if (p == "package.json") return "PACKAGE_JSON"
  if (inerte(p)) return "INERTE"
  return "DESCONHECIDO"
}
'

if [ "${1:-}" = "--bundle" ]; then
  awk "$AWK_TABELA"'
    $0 == "" { next }
    { n++; printf "%s\t%s\n", classe($0), $0 }
    END { printf "FIM_CLASSIFICACAO_BUNDLE %d\n", n }'
  exit 0
fi

RAIZ="${CLASSIFY_RAIZ:-$PWD}"
entrada="$(cat)"

printf '%s\n' "$entrada" | awk "$AWK_TABELA"'
  # FRONTEND = precisa de Publish. Não é só src/: qualquer arquivo que altere o
  # bundle servido conta (senão dá falso-negativo "não precisa Publish" quando
  # precisa — ex.: mexer no vite.config ou subir uma dependência).
  alcanca($0) || $0 == "package.json" { fe=1 }
  # EDGE = deploy via chat do Lovable (verbatim, só após merge)
  /^supabase\/functions\//  { ef=1 }
  # MIGRATION = SQL Editor (domínio da skill lovable-db-operator)
  /^supabase\/migrations\// { mg=1 }
  END {
    printf "frontend=%s\n",  (fe?"SIM":"não")
    printf "edge=%s\n",      (ef?"SIM":"não")
    printf "migration=%s\n", (mg?"SIM":"não")
  }'

# ---------------------------------------------------------------------------
# 4ª camada — SECRETS (Lovable → Edge Functions → Secrets).
#
# Por que existe: um secret novo NÃO é nenhuma das 3 camadas acima e mesmo assim é
# dependência manual do founder. A edge sobe Active, o cron fica verde,
# `cron.job_run_details` diz `succeeded` — e a função morre no 1º `Deno.env.get`
# devolvendo 500 sem fazer nada. Descoberto no #2035 (`analytics-outbox-drain` lê
# POSTHOG_INGEST_KEY, usado por essa edge e por nenhuma outra): naquele deploy o
# secret já estava configurado, o que foi SORTE — não havia como saber antes de rodar.
#
# Heurística: nome lido por uma edge TOCADA pelo diff que não aparece em nenhuma edge
# NÃO tocada = provavelmente novo. Os tocados saem do universo de propósito — sem isso
# um arquivo se compara consigo mesmo e todo secret novo parece conhecido.
#
# Ausência de literal NÃO é ausência de secret: este repo lê env por nome computado
# (`Deno.env.get(`OMIE_${empresa}_APP_KEY`)`, `Deno.env.get(conta.envKey)`). Nome que
# o script não consegue resolver vira `?dinamico` — pendência de conferência à mão,
# nunca silêncio (silêncio aqui seria ausência de dado lida como aprovação).
#
# Limite honesto: o repo não é a verdade sobre o painel. A saída é lista de CANDIDATOS
# — quem decide é o painel de Secrets do Lovable. Errar para mais custa uma linha de
# checklist; errar para menos custa uma edge morta em produção.
# ---------------------------------------------------------------------------
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

cat > "$tmp/env.awk" <<'AWK'
# Lê uma lista de paths (1 por linha) e, para cada Deno.env.get() encontrado, emite
# "L <NOME>" (literal resolvido) ou "D <arquivo>" (nome dinâmico/irresolvível).
function varrer(linha, arq,   p, resto, aspa, corpo, q, nome) {
  while ((p = index(linha, "Deno.env.get(")) > 0) {
    resto = substr(linha, p + 13)
    linha = resto                       # continua após esta ocorrência (várias por linha)
    sub(/^[ \t]*/, "", resto)
    aspa = substr(resto, 1, 1)
    if (aspa == "\"" || aspa == "\047") {
      corpo = substr(resto, 2)
      q = index(corpo, aspa)
      if (q > 1) {
        nome = substr(corpo, 1, q - 1)
        if (nome ~ /^[A-Za-z_][A-Za-z0-9_]*$/) { print "L " nome; continue }
      }
    }
    print "D " arq                      # crase, variável, string vazia, multi-linha
  }
}
{
  arq = $0
  while ((getline l < arq) > 0) varrer(l, arq)
  close(arq)                            # arquivo inexistente (deletado no diff): getline < 0, silencioso
}
AWK

# Tocados: só código de edge. `_test.ts` fora — não vai pro bundle (mesmo filtro do Passo 3).
printf '%s\n' "$entrada" \
  | awk '/^supabase\/functions\/.*\.ts$/ && !/_test\.ts$/' \
  | sort -u > "$tmp/tocados"

if [ ! -s "$tmp/tocados" ]; then
  echo "secrets=não"
  exit 0
fi

( cd "$RAIZ" 2>/dev/null && awk -f "$tmp/env.awk" "$tmp/tocados" ) > "$tmp/uso" || true
awk '$1=="L"{print $2}' "$tmp/uso" | sort -u > "$tmp/usados"
dinamico="$(awk '$1=="D"{c=1} END{print c?1:0}' "$tmp/uso")"

# Universo = edges já existentes NÃO tocadas pelo diff. `_test.ts` também fora daqui:
# secret citado só em teste não prova que existe no painel (incluí-lo daria falso negativo).
( cd "$RAIZ" 2>/dev/null && find supabase/functions -type f -name '*.ts' 2>/dev/null ) \
  | awk '!/_test\.ts$/' | sort -u > "$tmp/todos" || true
comm -23 "$tmp/todos" "$tmp/tocados" > "$tmp/universo"
( cd "$RAIZ" 2>/dev/null && awk -f "$tmp/env.awk" "$tmp/universo" ) > "$tmp/uso_universo" || true
awk '$1=="L"{print $2}' "$tmp/uso_universo" | sort -u > "$tmp/conhecidos"

comm -23 "$tmp/usados" "$tmp/conhecidos" > "$tmp/novos"
lista="$(awk 'BEGIN{ORS=""} NR>1{print ","} {print}' "$tmp/novos")"
if [ "$dinamico" = 1 ]; then
  lista="${lista:+$lista,}?dinamico"
fi
printf 'secrets=%s\n' "${lista:-não}"
