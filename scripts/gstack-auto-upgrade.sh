#!/usr/bin/env bash
# gstack-auto-upgrade.sh — upgrade do gstack FORA da sessão, sem furar o gate de supply chain.
#
# Por quê (2026-09-29). Com `auto_upgrade: true`, o gstack manda o MODELO rodar `git pull` + `./setup`
# no meio de qualquer sessão que use uma skill dele, e o classificador do modo auto barra:
# `[Code from External]`. É código baixado do GitHub e executado, reescrevendo skills e hooks do
# ~/.claude/settings.json, por ordem vinda de SAÍDA DE FERRAMENTA, e não do founder (sessão do
# cockpit FCA/WP01, 2026-09-28). Aplicar às cegas, fora da sessão, também furaria o gate de supply
# chain de docs/agent/skills.md (decisão de 2026-09-27). Decisão do founder (2026-09-29): o job
# PREPARA sozinho e o founder APLICA com uma frase. Registro: docs/historico/gstack-upgrade-fora-da-sessao.md.
#
# Dois modos:
#   (padrão) preparar: roda toda semana pelo launchd (com.lucas.gstack-upgrade, instalado por
#       scripts/gstack-auto-upgrade-instalar.sh). Busca a origin. Havendo versão nova, NÃO aplica:
#       extrai as duas árvores, roda o skill-scanner offline nas duas, calcula os achados NOVOS
#       (o delta do gate: severidade + regra + arquivo + trecho) e o diff do que dispara sozinho
#       (setup, bin/, hooks, plugin, dependências), e grava $AUTO/revisao.md + status PENDENTE.
#   --aplicar <sha>: numa sessão, SÓ a pedido do founder e depois da revisão. Faz fast-forward para
#       EXATAMENTE o sha revisado (nunca para um tip mais novo, que ninguém revisou), roda ./setup -q,
#       as migrações da versão e o marcador do "What's New". É o caminho git do /gstack-upgrade
#       (gstack-upgrade/SKILL.md, passos 4, 4.75 e 5).
# Ficam de fora, de propósito:
#   • reset --hard quando o fast-forward é recusado: é destrutivo e pede decisão humana, então vira
#     FALHOU e o vigia avisa;
#   • parar o daemon velho do browse (passo 4.8): o próprio CLI reinicia o servidor quando o hash do
#     binário muda (browse/src/cli.ts, "auto-restart on update");
#   • a cópia vendorizada (passo 4.5): este repo não vendoriza o gstack.
#
# Origem permitida: só github.com/garrytan/gstack, conferida na URL CRUA do remote (sem o insteadOf).
# Um remote trocado não vira código de terceiro executado sem ninguém ver.
#
# Status em $AUTO/status (chave=valor, ASCII, gravado por mv atômico). É o que o
# .claude/hooks/vigia-gstack.sh lê:
#   estado=JA-EM-DIA | PENDENTE | ATUALIZADO | SEM-REDE | FALHOU
#   versao (instalada), nova e alvo (só PENDENTE), de (só ATUALIZADO), epoch (esta rodada),
#   ultimo_ok (última rodada que cumpriu o papel: JA-EM-DIA, PENDENTE ou ATUALIZADO; SEM-REDE e
#   FALHOU preservam o anterior, para o vigia medir "parado há quanto tempo"), detalhe (frase curta).
#
# Lock: o MESMO diretório do atualizador do próprio gstack ($HOME/.gstack/.setup-lock, com pidfile e
# TTL), para nunca rodar dois ./setup ao mesmo tempo, nem com o hook de sessão do gstack (./setup --team).
#
# Saída: 0 = JA-EM-DIA/PENDENTE/ATUALIZADO · 1 = FALHOU (precisa de humano) · 3 = SEM-REDE (transitório)
#        4 = OCUPADO (outro upgrade em curso; status intocado) · 5 = RECUSADO (uso/estado; nada feito).
# Uso: bash scripts/gstack-auto-upgrade.sh [--aplicar <sha>]   (o launchd roda a cópia instalada)
set -uo pipefail

: "${HOME:?HOME indefinido}"
# O launchd entrega um PATH mínimo: bun (./setup), skill-scanner e heavy moram fora dele.
export PATH="$HOME/.bun/bin:$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin${PATH:+:$PATH}"
# Sem prompt de credencial (travaria o job) e sem fetch pendurado para sempre em rede ruim.
export GIT_TERMINAL_PROMPT=0 GIT_HTTP_LOW_SPEED_LIMIT=1000 GIT_HTTP_LOW_SPEED_TIME=60

G="$HOME/.claude/skills/gstack"
STATE="$HOME/.gstack"
AUTO="$STATE/auto-upgrade"
STATUS="$AUTO/status"
LOG="$AUTO/log"
REV="$AUTO/revisao"
REVMD="$AUTO/revisao.md"
LOCK_DIR="$STATE/.setup-lock"
LOCK_TTL_MIN=30
BUN="${GSTACK_AUTO_BUN:-bun}"                    # injetável: os testes trocam por stub
SCANNER="${GSTACK_AUTO_SCANNER:-skill-scanner}"  # idem
ORIGEM_OK='^(https://github\.com/|git@github\.com:|ssh://git@github\.com/)garrytan/gstack(\.git)?/?$'
# O que dispara SOZINHO, sem o modelo pedir: é aqui que o gate de 27/09 exige zero achado novo.
SOZINHO=(setup 'bin/*' 'hosts/*/hooks/*' '*.claude-plugin*' package.json bun.lock)

agora() { date +%s; }
log() { printf '%s  %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$1" | tee -a "$LOG"; }
# O status é lido por um sensor que monta JSON: só ASCII sem aspas nem barra invertida.
limpa() { LC_ALL=C tr -cd 'A-Za-z0-9 ._:/@=+,;()>-'; }
campo() { [ -r "$STATUS" ] || return 0; sed -n "s/^$1=//p" "$STATUS" | sed -n 1p; }
versao_instalada() { [ -r "$G/VERSION" ] && LC_ALL=C tr -cd '0-9.' < "$G/VERSION"; }
pesado() { if command -v heavy >/dev/null 2>&1; then heavy "$@"; else "$@"; fi; }
batimento() { touch "$LOCK_DIR/pid" 2>/dev/null; }   # renova o TTL do lock entre etapas longas

# escrever_status <estado> <detalhe> [chave=valor ...]
escrever_status() {
  local estado="$1" detalhe="$2" t ok kv
  shift 2
  t="$(agora)"
  case "$estado" in
    JA-EM-DIA|PENDENTE|ATUALIZADO) ok="$t" ;;
    *) ok="$(campo ultimo_ok | LC_ALL=C tr -cd '0-9')" ;;
  esac
  {
    printf 'estado=%s\n' "$estado"
    printf 'versao=%s\n' "$(versao_instalada)"
    for kv in "$@"; do printf '%s' "$kv" | limpa; printf '\n'; done
    printf 'epoch=%s\n' "$t"
    printf 'ultimo_ok=%s\n' "$ok"
    printf 'detalhe=%s\n' "$(printf '%s' "$detalhe" | limpa)"
  } > "$STATUS.tmp.$$" && mv -f "$STATUS.tmp.$$" "$STATUS"
}

falhou() { escrever_status FALHOU "$1"; log "FALHOU: $1"; exit 1; }
recusa() { log "RECUSADO: $1 (nada feito, status intocado)"; exit 5; }

lock_expirado() {
  local hb="$LOCK_DIR/pid"
  [ -f "$hb" ] || hb="$LOCK_DIR"
  [ -n "$(find "$hb" -maxdepth 0 -mmin +"$LOCK_TTL_MIN" 2>/dev/null)" ]
}
# Mesma semântica do bin/gstack-session-update: dono morto ou TTL vencido libera; a retomada é por mv
# atômico (dois contendores nunca vencem juntos); pidfile vazio dentro do TTL = "acabou de pegar".
pegar_lock() {
  local pid
  if mkdir "$LOCK_DIR" 2>/dev/null; then echo "$$" > "$LOCK_DIR/pid"; return 0; fi
  pid="$(cat "$LOCK_DIR/pid" 2>/dev/null || true)"
  if lock_expirado || { [ -n "$pid" ] && ! kill -0 "$pid" 2>/dev/null; }; then
    mv "$LOCK_DIR" "$LOCK_DIR.reap.$$" 2>/dev/null || return 1
    rm -rf "$LOCK_DIR.reap.$$"
    mkdir "$LOCK_DIR" 2>/dev/null || return 1
    echo "$$" > "$LOCK_DIR/pid"
    return 0
  fi
  return 1
}
# shellcheck disable=SC2329  # invocada indiretamente, pelo trap EXIT do fim do script
soltar_lock() {
  if [ "$(cat "$LOCK_DIR/pid" 2>/dev/null)" = "$$" ]; then rm -rf "$LOCK_DIR"; fi
}

podar_log() {
  [ -f "$LOG" ] || return 0
  if [ "$(wc -l < "$LOG")" -gt 5000 ]; then tail -n 2000 "$LOG" > "$LOG.tmp.$$" && mv -f "$LOG.tmp.$$" "$LOG"; fi
}

conferir_clone() {
  local origem ramo
  [ -d "$G/.git" ] || falhou "gstack nao e um clone git em $G"
  origem="$(git -C "$G" config --get remote.origin.url || true)"
  printf '%s\n' "$origem" | grep -E -- "$ORIGEM_OK" >/dev/null || falhou "origem nao permitida: ${origem:-vazia}"
  ramo="$(git -C "$G" symbolic-ref --short -q HEAD || true)"
  [ "$ramo" = main ] || falhou "o clone nao esta na main (ramo: ${ramo:-HEAD solto})"
}

buscar() {
  if ! git -C "$G" fetch --quiet origin main >>"$LOG" 2>&1; then
    escrever_status SEM-REDE "git fetch falhou (rede ou GitHub fora do ar)"
    log "SEM-REDE: git fetch falhou - tento de novo na proxima rodada"
    exit 3
  fi
  batimento
}

# Só os analisadores OFFLINE, como manda o gate: sem LLM, VirusTotal, AI Defense nem OSV (as chaves
# saem do ambiente para nenhum deles ligar sozinho).
rodar_scanner() {  # <dir> <json>
  local rc t0="$SECONDS"
  log "scanner: $(basename "$1") (fila do heavy, se houver, conta no tempo)"
  pesado env -u ANTHROPIC_API_KEY -u OPENAI_API_KEY -u VT_API_KEY -u VIRUSTOTAL_API_KEY \
      -u AI_DEFENSE_API_KEY -u AIDEFENSE_API_KEY \
    nice -n 10 "$SCANNER" scan-all "$1" --recursive --use-behavioral --use-trigger \
      --format json --output-json "$2" >>"$LOG" 2>&1
  rc=$?
  batimento
  log "scanner: $(basename "$1") terminou rc=$rc em $((SECONDS - t0))s"
  [ "$rc" -eq 0 ] && [ -s "$2" ]
}

# Delta do gate (o mesmo algoritmo da revisão de 2026-09-27): multiconjunto de achados por
# (severidade, regra, arquivo relativo, trecho de 90 caracteres); novos = nova - atual.
delta_scanner() {  # <json atual> <json nova> → markdown no stdout; exit != 0 = JSON ilegível
  python3 - "$1" "$2" "${SOZINHO[@]}" <<'PY'
import collections, fnmatch, json, re, sys
atual_fn, nova_fn, sozinho = sys.argv[1], sys.argv[2], sys.argv[3:]
def carregar(fn):
    with open(fn) as fh:
        d = json.load(fh)
    c = collections.Counter()
    for r in d.get("results", []):
        for f in r.get("findings", []):
            fp = re.sub(r"^.*/revisao/(atual|nova)/", "", f.get("file_path") or "")
            sn = re.sub(r"\s+", " ", str(f.get("snippet") or f.get("description") or ""))[:90]
            c[(f.get("severity") or "?", f.get("rule_id") or "?", fp, sn)] += 1
    return c
atual, nova = carregar(atual_fn), carregar(nova_fn)
novos = nova - atual
sev = collections.Counter(k[0] for k in novos.elements())
dispara = sorted(k for k in novos if any(fnmatch.fnmatch(k[2], p) for p in sozinho))
print(f"- achados: instalada {sum(atual.values())} · nova {sum(nova.values())} · **novos {sum(novos.values())}**"
      + (" (" + ", ".join(f"{s} {n}" for s, n in sev.most_common()) + ")" if sev else ""))
print(f"- **novos em código que dispara sozinho: {len(dispara)}**" + (" ← o gate exige ZERO aqui" if dispara else ""))
for s, r, fp, sn in dispara[:40]:
    print(f"  - `{s}` `{r}` em `{fp}`: {sn}")
crit = collections.Counter((k[0], k[1]) for k in novos if k[0] in ("CRITICAL", "HIGH"))
if crit:
    print("- CRITICAL/HIGH novos por regra (todos os caminhos; em skill de segurança costuma ser o próprio assunto, trie POR ARQUIVO):")
    for (s, r), n in crit.most_common(15):
        print(f"  - `{s}` `{r}`: {n}")
PY
}

# shellcheck disable=SC2016  # as crases aqui são MARKDOWN literal da revisão, não expansão de shell
montar_revisao() {  # <head> <alvo> <de> <nova>
  local head="$1" alvo="$2" de="$3" nova="$4" scan
  rm -rf "$REV" && mkdir -p "$REV/atual" "$REV/nova" || return 1
  git -C "$G" archive "$head" | tar -x -C "$REV/atual" || return 1
  git -C "$G" archive "$alvo" | tar -x -C "$REV/nova" || return 1
  if ! command -v "$SCANNER" >/dev/null 2>&1; then
    scan="- ⚠️ **GATE INCOMPLETO: \`$SCANNER\` ausente nesta máquina.** Instale (\`uv tool install 'cisco-ai-skill-scanner==2.1.0'\`) e rode o preparo de novo antes de aplicar."
  elif ! rodar_scanner "$REV/atual" "$REV/scan-atual.json" || ! rodar_scanner "$REV/nova" "$REV/scan-nova.json"; then
    scan="- ⚠️ **GATE INCOMPLETO: o scanner falhou** (ver $LOG). Não aplique sem rodar o preparo de novo."
  elif ! scan="$(delta_scanner "$REV/scan-atual.json" "$REV/scan-nova.json" 2>>"$LOG")"; then
    scan="- ⚠️ **GATE INCOMPLETO: JSON do scanner ilegível** (ver $LOG)."
  fi
  {
    printf '# Revisão do upgrade do gstack: v%s → v%s\n\n' "$de" "$nova"
    printf -- '- alvo: `%s` (a origin/main na hora do preparo; é EXATAMENTE isto que o --aplicar instala)\n' "$alvo"
    printf -- '- commits: %s · arquivos: %s\n' "$(git -C "$G" rev-list --count "$head..$alvo")" "$(git -C "$G" diff --name-only "$head" "$alvo" | wc -l | tr -d ' ')"
    printf -- '- preparado em %s por scripts/gstack-auto-upgrade.sh\n\n' "$(date '+%Y-%m-%d %H:%M')"
    printf '## Critério do gate (docs/agent/skills.md, decisão de 2026-09-27)\n\n'
    printf 'Nenhum achado NOVO em código que dispara sozinho (%s) e leitura à mão do que mudou ali.\n' "${SOZINHO[*]}"
    printf 'Aplicar, SÓ a pedido do Lucas e em background (o ./setup leva minutos):\n\n'
    printf '    bash %s/atualizar-gstack.sh --aplicar %s\n\n' "$AUTO" "$alvo"
    printf '## skill-scanner (offline): delta\n\n%s\n\n' "$scan"
    printf '## O que dispara sozinho e mudou\n\n```\n'
    git -C "$G" diff --stat "$head" "$alvo" -- "${SOZINHO[@]}" | tail -n 40
    printf '```\n\n## Hooks que o setup registra (linhas add-event): diferença\n\n```\n'
    diff <(git -C "$G" show "$head:setup" 2>/dev/null | grep -E 'add-event' || true) \
         <(git -C "$G" show "$alvo:setup" 2>/dev/null | grep -E 'add-event' || true) || true
    printf '```\n\n## Commits\n\n```\n'
    git -C "$G" log --oneline "$head..$alvo" | head -n 60
    printf '```\n'
  } > "$REVMD.tmp.$$" && mv -f "$REVMD.tmp.$$" "$REVMD"
}

preparar() {
  local head alvo nova de d
  conferir_clone
  buscar
  head="$(git -C "$G" rev-parse HEAD)"
  alvo="$(git -C "$G" rev-parse origin/main)"
  if git -C "$G" merge-base --is-ancestor "$alvo" "$head"; then
    d="nenhuma versao nova"
    [ "$head" = "$alvo" ] || d="clone a frente da origin (commits locais)"
    rm -rf "$REV" "$REVMD"
    escrever_status JA-EM-DIA "$d"
    log "JA-EM-DIA: v$(versao_instalada) ($d)"
    exit 0
  fi
  git -C "$G" merge-base --is-ancestor "$head" "$alvo" \
    || falhou "o clone divergiu da origin (commits locais e remotos) - resolver com /gstack-upgrade"
  nova="$(git -C "$G" show "$alvo:VERSION" 2>/dev/null | LC_ALL=C tr -cd '0-9.')"
  de="$(versao_instalada)"
  if [ "$(campo estado)" = PENDENTE ] && [ "$(campo alvo)" = "$alvo" ] && [ -s "$REVMD" ]; then
    escrever_status PENDENTE "revisao ja pronta (a origin nao mudou)" "nova=$nova" "alvo=$alvo"
    log "PENDENTE: v$de -> v$nova ja preparado antes ($alvo)"
    exit 0
  fi
  log "preparo: v$de -> v$nova ($alvo) - montando a revisao"
  montar_revisao "$head" "$alvo" "$de" "$nova" || falhou "nao consegui montar a revisao (ver $LOG)"
  escrever_status PENDENTE "revisao pronta em $REVMD" "nova=$nova" "alvo=$alvo"
  log "PENDENTE: v$de -> v$nova ($alvo) - revisao em $REVMD"
  exit 0
}

mais_nova() {  # <a> <b>: a > b na ordem de versão (sort -V), como no passo 4.75 do /gstack-upgrade
  [ "$1" != "$2" ] && [ "$(printf '%s\n%s\n' "$2" "$1" | sort -V | sed -n 1p)" = "$2" ]
}

migracoes() {  # <versão antiga>: passo 4.75 do /gstack-upgrade, roda as v*.sh MAIS NOVAS que ela
  local de="$1" m v dir="$G/gstack-upgrade/migrations"
  if [ -z "$de" ]; then log "AVISO: versao antiga desconhecida - migracoes puladas (como no /gstack-upgrade)"; return 0; fi
  [ -d "$dir" ] || return 0
  while IFS= read -r m; do
    v="$(basename "$m" .sh)"
    v="${v#v}"
    mais_nova "$v" "$de" || continue
    log "migracao v$v"
    GSTACK_INSTALL_DIR="$G" bash "$m" </dev/null >>"$LOG" 2>&1 \
      || log "AVISO: migracao v$v com erros (nao fatal, como no /gstack-upgrade)"
  done < <(find "$dir" -maxdepth 1 -name 'v*.sh' -type f | sort -V)
}

aplicar() {
  local pedido="$1" alvo full head de novo
  [ -n "$pedido" ] || recusa "uso: --aplicar <sha da revisao>"
  [ "$(campo estado)" = PENDENTE ] || recusa "nao ha revisao pendente (estado: $(campo estado))"
  alvo="$(campo alvo)"
  conferir_clone
  full="$(git -C "$G" rev-parse --verify -q "$pedido^{commit}")" || recusa "sha desconhecido: $pedido"
  [ "$full" = "$alvo" ] || recusa "o sha pedido ($full) nao e o revisado ($alvo)"
  head="$(git -C "$G" rev-parse HEAD)"
  de="$(versao_instalada)"
  if [ "$head" = "$alvo" ]; then
    rm -rf "$REV" "$REVMD"
    escrever_status JA-EM-DIA "o alvo revisado ja estava instalado"
    log "JA-EM-DIA: $alvo ja instalado"
    exit 0
  fi
  git -C "$G" merge-base --is-ancestor "$head" "$alvo" \
    || falhou "o clone divergiu do alvo revisado - resolver com /gstack-upgrade"
  command -v "$BUN" >/dev/null 2>&1 || falhou "bun ausente no PATH - o ./setup precisa dele"
  # Sujeira de render (gstack-upgrade/SKILL.md, #2569): SKILL.md e sections gerados, regeneráveis.
  # UM checkout por padrão: com vários, basta um não casar nada para o git recusar o comando INTEIRO
  # e não descartar nada (medido no teste A12: sem sections/, a sujeira do SKILL.md ficava).
  for p in 'SKILL.md' '*/SKILL.md' '*/sections/*.md'; do git -C "$G" checkout -- "$p" 2>/dev/null || true; done
  [ -z "$(git -C "$G" status --porcelain --untracked-files=no)" ] \
    || falhou "clone com alteracoes locais - nao sobrescrevo sem voce (git -C $G status)"
  git -C "$G" merge --ff-only "$alvo" >>"$LOG" 2>&1 || falhou "fast-forward para $alvo recusado"
  batimento
  ( cd "$G" && pesado nice -n 10 ./setup -q ) </dev/null >>"$LOG" 2>&1 \
    || falhou "./setup falhou apos o fast-forward (commit anterior $head) - ver $LOG"
  batimento
  migracoes "$de"
  printf '%s\n' "$de" > "$STATE/just-upgraded-from"
  rm -f "$STATE/last-update-check" "$STATE/update-snoozed"
  rm -rf "$REV" "$REVMD"
  novo="$(versao_instalada)"
  escrever_status ATUALIZADO "v$de -> v$novo (alvo revisado)" "de=$de"
  log "ATUALIZADO: v$de -> v$novo ($alvo)"
  exit 0
}

case "${1:-}" in
  ""|--aplicar) ;;
  *) echo "uso: $0 [--aplicar <sha>]" >&2; exit 5 ;;
esac
mkdir -p "$AUTO" || { echo "ERRO: nao consegui criar $AUTO" >&2; exit 1; }
podar_log
pegar_lock || { log "OCUPADO: outro upgrade do gstack em curso ($LOCK_DIR) - nada feito"; exit 4; }
trap soltar_lock EXIT
if [ "${1:-}" = --aplicar ]; then aplicar "${2:-}"; else preparar; fi
