#!/usr/bin/env bash
# test-hooks-sessionstart.sh — os 2 hooks de SessionStart emitem JSON VÁLIDO
# em qualquer circunstância (hook com stdout inválido é ignorado pelo harness,
# ou pior, polui o boot da sessão — o contrato é: sempre JSON parseável).
#
# Bloco 1 do vigia-worktree (deps, casos [D0]-[D13]): a pergunta é se as deps
# RESPONDEM, não se o diretório existe. Em 2026-09-25 a worktree tinha o
# `node_modules` EXISTENTE e VAZIO, o hook antigo (`! -d node_modules`) calou e a
# resolução de módulos subiu ao checkout principal: teste verde com as deps de
# OUTRA árvore (docs/historico/exclusividade-media-outra-coisa.md). `bun`, `pgrep`
# e `lsof` são STUBS aqui: a suíte nunca roda install de verdade, nem lê a tabela
# de processos real (que traria installs de outras worktrees e faria o veredito
# variar com o humor do Mac).
#
# Uso: bash scripts/test-hooks-sessionstart.sh               (exit 0 = verde · 1 = asserção · 2 = infra)
#      bash scripts/test-hooks-sessionstart.sh --falsificar  (sabota CÓPIAS do vigia-worktree; exige vermelho)
#
# Marcadores ASCII de caixa fixa, casados com grep -F e sem -i; a falsificação
# roda nos DOIS locales (LC_ALL=C e um UTF-8 achado por sonda positiva), porque
# falsificar num só não prova (#1483).
set -u

here="$(cd "$(dirname "$0")" && pwd)"
HOOKS="$here/../.claude/hooks"
VW="${VIGIA_WORKTREE_HOOK:-$HOOKS/vigia-worktree.sh}"

command -v jq >/dev/null 2>&1 || { echo "INFRA: jq ausente — nao da para conferir o envelope"; exit 2; }
[ -f "$VW" ] || { echo "INFRA: vigia-worktree nao encontrado em $VW"; exit 2; }

tmp="$(mktemp -d)" || exit 2
trap 'rm -rf "$tmp"' EXIT

# ── falsificação ───────────────────────────────────────────────────────────────
# Sabota uma CÓPIA do vigia-worktree (o hook está VIVO: roda no boot de toda
# sessão) com troca LITERAL de âncora ÚNICA — 1x antes, 0x depois, texto novo
# +1x; o `cmp` sozinho só provaria que o arquivo mudou — e roda o bloco de deps
# desta suíte contra ela (TESTE_SO_DEPS=1 + o override VIGIA_WORKTREE_HOOK). Cada
# sabotagem tem de sair com exit 1 E com FAIL no caso que ela mira: exit 2 é
# infra, e FAIL noutro caso não prova que o caso-alvo tem dente. O CONTROLE é a
# MESMA invocação com o hook REAL, exigido verde em cada locale antes do 1º sed e
# de novo no fim: suíte sempre-vermelha aprovaria toda sabotagem
# (docs/historico/falsificacao-sem-linha-de-base.md).
if [ "${1:-}" = "--falsificar" ]; then
  command -v perl >/dev/null 2>&1 || { echo "INFRA: perl ausente — a troca literal nao roda"; exit 2; }
  utf8=""
  for cand in pt_BR.UTF-8 pt_BR.utf8 en_US.UTF-8 en_US.utf8 C.UTF-8 C.utf8; do
    if [ "$(LC_ALL="$cand" locale charmap 2>/dev/null)" = "UTF-8" ]; then utf8="$cand"; break; fi
  done
  if [ -z "$utf8" ]; then
    echo "ABORTA — nenhum locale UTF-8 neste ambiente; metade da falsificacao nao rodaria."; exit 1
  fi

  falhas=0
  controle() {
    local saida rc
    saida="$(TESTE_SO_DEPS=1 LC_ALL="$1" VIGIA_WORKTREE_HOOK="$VW" bash "$0" 2>&1)"; rc=$?
    if [ "$rc" -ne 0 ] || ! printf '%s\n' "$saida" | grep -qF 'PASS — deps'; then
      printf 'ABORTA — controle nao esta verde (LC_ALL=%s, rc=%s). Sabotar agora aprovaria qualquer coisa.\n%s\n' "$1" "$rc" "$saida"
      exit 1
    fi
  }
  # conta <texto> <arquivo> — ocorrências LITERAIS (não linhas)
  conta() { DE="$1" perl -0ne 'my $n = () = /\Q$ENV{DE}\E/g; print $n' "$2"; }
  # sabotar <id> <caso-alvo> <descricao> <de> <para>
  sabotar() {
    local id="$1" alvo="$2" desc="$3" de="$4" para="$5" copia="$tmp/sabotado-$1.sh" saida rc antes
    antes="$(conta "$de" "$VW")"
    if [ "$antes" != 1 ]; then
      printf '  ❌ %s: a ancora aparece %s vez(es) no hook — precisa ser UNICA; sabotagem sem alvo nao prova nada\n' "$id" "$antes"
      falhas=$((falhas + 1)); return
    fi
    DE="$de" PARA="$para" perl -0pe 's/\Q$ENV{DE}\E/$ENV{PARA}/' "$VW" > "$copia"
    if [ "$(conta "$de" "$copia")" != 0 ] \
       || [ "$(conta "$para" "$copia")" != "$(( $(conta "$para" "$VW") + 1 ))" ]; then
      printf '  ❌ %s: a troca nao foi 1x -> 0x com o texto novo +1x\n' "$id"
      falhas=$((falhas + 1)); return
    fi
    saida="$(TESTE_SO_DEPS=1 LC_ALL="$LOC" VIGIA_WORKTREE_HOOK="$copia" bash "$0" 2>&1)"; rc=$?
    if [ "$rc" -eq 1 ] && printf '%s\n' "$saida" | grep -qF "FAIL [$alvo]"; then
      printf '  ✅ %s %s -> vermelho em [%s] (LC_ALL=%s)\n' "$id" "$desc" "$alvo" "$LOC"
    else
      printf '  ❌ %s %s: esperava exit 1 com FAIL [%s]; veio rc=%s\n%s\n' "$id" "$desc" "$alvo" "$rc" "$saida"
      falhas=$((falhas + 1))
    fi
  }

  # shellcheck disable=SC2016  # os `$` das âncoras são TEXTO do hook a casar, não expansão
  for LOC in C "$utf8"; do
    printf '== falsificacao (LC_ALL=%s) ==\n' "$LOC"
    controle "$LOC"
    sabotar S1 D3 'o DEFEITO de volta: node_modules existente = deps OK' \
      'if [ ! -e "$1" ] && [ ! -L "$1" ]; then echo VAZIO; return; fi' 'echo OK; return'
    sabotar S2 D4 'entrada oculta (.vite/.bin) conta como pacote' \
      'set -- node_modules/*' 'set -- node_modules/.*'
    sabotar S3 D3 'aviso nao nomeia o VAZIO (sai como AUSENTE)' \
      'VAZIO)   desc="node_modules VAZIO' 'VAZIO)   desc="node_modules AUSENTE'
    sabotar S4 D5 'manifesto: basta existir, versao nao importa' \
      '"version"[[:space:]]*:[[:space:]]*"[0-9]+\.[0-9]+\.[0-9]+' '"name"'
    sabotar S5 D6 '.bin nao conferido (link pendurado passa)' \
      '[ -x "node_modules/.bin/$b" ]' 'true'
    sabotar S6 D2 'avisa e NAO dispara o install' \
      '(disparar_install >>"$log" 2>&1 </dev/null & echo "vigia-worktree: job pid $!" >>"$log")' ': SABOTADO-sem-disparo'
    sabotar S7 D7 'dispara install com deps OK' \
      'if [ "$estado" != OK ]; then' 'if true; then'
    sabotar S8 D8 'sonda de install em voo desligada' \
      'pid="$(install_em_voo)"; rc=$?' 'pid=""; rc=1'
    sabotar S9 D9 'install de QUALQUER worktree conta como daqui' \
      'if [ "${linha#n}" = "$aqui" ]; then echo "$pid"; return 0; fi ;;' 'echo "$pid"; return 0 ;;'
    sabotar S10 D10 'pgrep quebrado vira "ninguem instalando"' \
      '*) return 2 ;;   # pgrep ausente ou quebrado' '*) return 1 ;;   # SABOTADO'
    sabotar S11 D11 'lsof mudo vira "ninguem aqui"' \
      '[ "$respondeu" -eq 1 ] && return 1' 'return 1  # SABOTADO-lsof-mudo'
    sabotar S12 D12 'bun fora do PATH cala (o ramo antigo)' \
      'avisos="${avisos}${desc} -> bun FORA DO PATH' ': "${avisos}${desc} -> bun FORA DO PATH'
    sabotar S13 D13 'log que nao abre e dispara assim mesmo' \
      'elif ! printf' 'elif false && printf'
    sabotar S14 D0 'lista da sonda vazia' \
      'DEPS_SONDA="eslint:eslint tsc:typescript vite:vite vitest:vitest"' 'DEPS_SONDA=""'
    controle "$LOC"
  done

  echo
  if [ "$falhas" -eq 0 ]; then echo "✅ falsificacao: cada caso-alvo reprova a sua sabotagem, nos 2 locales"; exit 0; fi
  echo "❌ falsificacao: $falhas sabotagem(ns) sem vermelho no caso-alvo"; exit 1
fi

fail=0
ok()   { printf '  ok   [%s] %s\n' "$1" "$2"; }
ruim() { printf '  FAIL [%s] %s\n' "$1" "$2"; fail=1; }

echo "── vigia-worktree.sh: deps da worktree (bloco 1) ──"
# Stubs: `bun` registra a chamada e "instala" na hora; `pgrep` só responde à sonda
# de install (padrão com "bun") — o bloco 3, que conta sessões claude, recebe
# "nenhum"; `lsof` dá a cwd dos pids achados: 4242 em STUB_LSOF_CWD, 4243 noutra.
stub="$tmp/stub"
mkdir -p "$stub"
cat > "$stub/bun" <<'STUB'
#!/bin/sh
printf '%s\n' "$*" >> "${STUB_BUN_REG:?}"
STUB
cat > "$stub/pgrep" <<'STUB'
#!/bin/sh
case "$*" in *bun*) ;; *) exit 1 ;; esac
case "${STUB_PGREP:-nada}" in
  achou)    printf '4242\n4243\n' ;;
  quebrado) exit 3 ;;
  *)        exit 1 ;;
esac
STUB
cat > "$stub/lsof" <<'STUB'
#!/bin/sh
[ "${STUB_LSOF:-}" = mudo ] && exit 1
printf 'p4242\nfcwd\nn%s\np4243\nfcwd\nn/outra/worktree\n' "${STUB_LSOF_CWD:-/lugar/nenhum}"
STUB
chmod +x "$stub/bun" "$stub/pgrep" "$stub/lsof"

# O que o hook pergunta (os 4 de BINARIOS_DAS_DEPS, com o pacote dono de cada um).
DEPS_TESTE="eslint:eslint tsc:typescript vite:vite vitest:vitest"

# deps "instaladas" no formato que o bun deixa: <pkg>/package.json com versão e
# .bin/<b> -> ../<pkg>/bin/<b> executável
deps_completas() {
  local d="$1/node_modules" par b p
  mkdir -p "$d/.bin"
  for par in $DEPS_TESTE; do
    b="${par%%:*}"; p="${par#*:}"
    mkdir -p "$d/$p/bin"
    printf '{\n  "name": "%s",\n  "version": "1.2.3"\n}\n' "$p" > "$d/$p/package.json"
    printf '#!/bin/sh\necho 1.2.3\n' > "$d/$p/bin/$b"; chmod +x "$d/$p/bin/$b"
    ln -s "../$p/bin/$b" "$d/.bin/$b"
  done
}

# fixture <nome> — worktree de mentira com package.json; ecoa o caminho
fixture() { mkdir -p "$tmp/$1/.tmp"; echo '{}' > "$tmp/$1/package.json"; printf '%s' "$tmp/$1"; }

# rodar_vw <dir> [VAR=valor ...] — roda o hook na fixture; deixa o JSON em $out e
# o additionalContext em $ctx. TMPDIR por fixture: o log do install cai lá.
rodar_vw() {
  local dir="$1"; shift
  out="$(cd "$dir" && env TMPDIR="$dir/.tmp" STUB_BUN_REG="$dir/.bun-chamadas" PATH="$stub:$PATH" "$@" bash "$VW" 2>/dev/null)"
  ctx="$(printf '%s' "$out" | jq -r '.hookSpecificOutput.additionalContext // ""' 2>/dev/null)"
}
json_ok() { printf '%s' "$out" | jq -e 'type == "object"' >/dev/null 2>&1; }
tem()     { printf '%s' "$ctx" | grep -qF -- "$1"; }

# log_de <dir> — o log do install que o hook abriu na fixture ("" se não abriu)
log_de() { local l; for l in "$1"/.tmp/bun-install-wt-*.log; do [ -e "$l" ] && printf '%s' "$l"; return; done; }

# esperar_job <dir> — espera SAIR o job que o hook pôs em background (o hook
# grava o pid no log). Prazo fixo é flake: sob load 153 o job levou mais de 2 s
# (medido), sem decisão errada nenhuma. Sem pid no log não houve job, e volta na
# hora; o teto de 60 s é só contra job pendurado. Depois dele, o que o job fez
# está em disco: o registro do stub (a prova de que o install RODOU, não o aviso)
# e a marca de desfecho do log.
esperar_job() {
  local lg pid i=0
  lg="$(log_de "$1")"
  [ -n "$lg" ] || return 0
  pid="$(sed -n 's/^vigia-worktree: job pid \([0-9][0-9]*\)$/\1/p' "$lg" | head -1)"
  [ -n "$pid" ] || return 0
  while kill -0 "$pid" 2>/dev/null && [ "$i" -lt 600 ]; do
    sleep 0.1; i=$((i + 1))
  done
}
chamou() { grep -qF -- install "$1/.bun-chamadas" 2>/dev/null; }   # o stub do bun rodou `install`
no_log() { grep -qF -- "$2" "$(log_de "$1")" 2>/dev/null; }        # a marca está no log da fixture

# [D0] a lista que o hook pergunta existe e só tem pacote que o repo DECLARA: um
# pacote largado pelo repo viraria PARCIAL eterno, com install a cada sessão.
lista="$(sed -n 's/^DEPS_SONDA="\([^"]*\)"$/\1/p' "$VW")"
d0=1
[ -n "$lista" ] || d0=0
for par in $lista; do
  jq -e --arg p "${par#*:}" '(.dependencies[$p] // .devDependencies[$p]) != null' \
    "$here/../package.json" >/dev/null 2>&1 || d0=0
done
if [ "$d0" -eq 1 ]; then ok D0 "DEPS_SONDA do hook ($lista) toda declarada no package.json"
else ruim D0 "DEPS_SONDA ausente/vazia no hook, ou com pacote fora do package.json: [$lista]"; fi

# [D1] sem package.json: não é worktree do app — nem olha deps
f="$tmp/d1"; mkdir -p "$f/.tmp"
rodar_vw "$f"
if json_ok && ! tem 'node_modules'; then ok D1 "sem package.json -> JSON valido, sem aviso de deps"
else ruim D1 "sem package.json deveria calar sobre deps: $out"; fi

# [D2] AUSENTE: avisa, dispara o install e o log fecha com VIGIA-FIM
f="$(fixture d2)"
rodar_vw "$f"; esperar_job "$f"
if json_ok && tem 'node_modules AUSENTE' && chamou "$f" && no_log "$f" 'VIGIA-FIM'; then
  ok D2 "AUSENTE -> avisa + bun install disparado + log fecha com VIGIA-FIM"
else ruim D2 "AUSENTE deveria avisar e disparar o install: $out"; fi

# [D3] VAZIO — o incidente de 2026-09-25, literal: o diretório existe, zero entradas
f="$(fixture d3)"; mkdir -p "$f/node_modules"
rodar_vw "$f"; esperar_job "$f"
if json_ok && tem 'node_modules VAZIO' && ! tem 'node_modules AUSENTE' && chamou "$f"; then
  ok D3 "VAZIO (o incidente) -> avisa com a marca VAZIO + install disparado"
else ruim D3 "node_modules VAZIO deveria avisar VAZIO (nao AUSENTE) e disparar install: $out"; fi

# [D4] VAZIO também com só entrada OCULTA: cache não é pacote (o vite cria o
# `.vite` mesmo resolvendo as deps do checkout de cima)
f="$(fixture d4)"; mkdir -p "$f/node_modules/.vite/deps" "$f/node_modules/.bin"
rodar_vw "$f"; esperar_job "$f"
if json_ok && tem 'node_modules VAZIO' && chamou "$f"; then
  ok D4 "so .vite/.bin (nenhum pacote) -> VAZIO + install disparado"
else ruim D4 "node_modules so com entrada oculta deveria ser VAZIO: $out"; fi

# [D5] PARCIAL: o manifesto existe mas não DECLARA versão (truncado) — existência não basta
f="$(fixture d5)"; deps_completas "$f"
printf '{ "name": "typescript" }\n' > "$f/node_modules/typescript/package.json"
rodar_vw "$f"; esperar_job "$f"
if json_ok && tem 'node_modules PARCIAL' && tem 'caminho local: tsc)' && chamou "$f"; then
  ok D5 "manifesto sem versao -> PARCIAL nomeando tsc + install disparado"
else ruim D5 "manifesto sem versao deveria dar PARCIAL (tsc): $out"; fi

# [D6] PARCIAL: `.bin/vite` pendurado (o alvo sumiu) — o link existir não basta
f="$(fixture d6)"; deps_completas "$f"; rm -f "$f/node_modules/vite/bin/vite"
rodar_vw "$f"; esperar_job "$f"
if json_ok && tem 'node_modules PARCIAL' && tem 'caminho local: vite)' && chamou "$f"; then
  ok D6 ".bin pendurado -> PARCIAL nomeando vite + install disparado"
else ruim D6 ".bin pendurado deveria dar PARCIAL (vite): $out"; fi

# [D7] CONTROLE: deps que respondem -> silêncio, nenhum log, nenhum install
f="$(fixture d7)"; deps_completas "$f"
rodar_vw "$f"
if json_ok && ! tem 'node_modules' && [ -z "$(log_de "$f")" ] && [ ! -e "$f/.bun-chamadas" ]; then
  ok D7 "CONTROLE com deps -> silencio, sem log, sem install"
else ruim D7 "deps completas NAO deveriam disparar nada: $out"; fi

# [D8] install EM VOO nesta worktree (outra sessão/hook): não dispara o 2º
f="$(fixture d8)"; mkdir -p "$f/node_modules"
rodar_vw "$f" STUB_PGREP=achou STUB_LSOF_CWD="$(cd "$f" && pwd -P)"; esperar_job "$f"
lg="$(log_de "$f")"
if json_ok && tem 'node_modules VAZIO' && no_log "$f" 'VIGIA-EM-VOO' && no_log "$f" '(pid 4242)' \
   && ! chamou "$f"; then ok D8 "install EM VOO aqui -> log VIGIA-EM-VOO (pid 4242), nenhum 2o install"
else ruim D8 "com install em voo nesta worktree NAO pode disparar outro: $out | log: $(cat "$lg" 2>/dev/null)"; fi

# [D9] install em voo noutra worktree NÃO conta: o daqui dispara
f="$(fixture d9)"; mkdir -p "$f/node_modules"
rodar_vw "$f" STUB_PGREP=achou STUB_LSOF_CWD=/outra/worktree/qualquer; esperar_job "$f"
lg="$(log_de "$f")"
if json_ok && chamou "$f" && no_log "$f" 'VIGIA-FIM' && ! no_log "$f" 'VIGIA-EM-VOO'; then
  ok D9 "install em voo NOUTRA worktree -> dispara o daqui"
else ruim D9 "install de outra worktree nao deveria segurar este: $out | log: $(cat "$lg" 2>/dev/null)"; fi

# [D10] a sonda de voo QUEBRADA (pgrep sai 3) é falta de dado, não "ninguém
# instalando": não dispara (2 installs na mesma árvore a deixam PARCIAL)
f="$(fixture d10)"; mkdir -p "$f/node_modules"
rodar_vw "$f" STUB_PGREP=quebrado; esperar_job "$f"
lg="$(log_de "$f")"
if json_ok && no_log "$f" 'VIGIA-NAO-CONFERI' && ! chamou "$f"; then
  ok D10 "pgrep quebrado -> log VIGIA-NAO-CONFERI, nenhum install"
else ruim D10 "sonda de voo quebrada nao pode virar 'ninguem instalando': $out | log: $(cat "$lg" 2>/dev/null)"; fi

# [D11] lsof MUDO (achou candidato e não devolveu cwd nenhuma) também é falta de dado
f="$(fixture d11)"; mkdir -p "$f/node_modules"
rodar_vw "$f" STUB_PGREP=achou STUB_LSOF=mudo; esperar_job "$f"
lg="$(log_de "$f")"
if json_ok && no_log "$f" 'VIGIA-NAO-CONFERI' && ! chamou "$f"; then
  ok D11 "lsof mudo -> log VIGIA-NAO-CONFERI, nenhum install"
else ruim D11 "lsof mudo nao pode virar 'ninguem aqui': $out | log: $(cat "$lg" 2>/dev/null)"; fi

# [D12] bun fora do PATH do hook: avisa em vez de calar (o teste antigo exigia o
# bun para sequer OLHAR as deps — ausência virava silêncio)
sb="$tmp/stub-sem-bun"; mkdir -p "$sb"
cp "$stub/pgrep" "$stub/lsof" "$sb/"; ln -s "$(command -v jq)" "$sb/jq"
if PATH="$sb:/usr/bin:/bin" command -v bun >/dev/null 2>&1; then
  echo "INFRA: ha bun em /usr/bin ou /bin — o caso [D12] nao consegue tira-lo do PATH"; exit 2
fi
f="$(fixture d12)"; mkdir -p "$f/node_modules"
rodar_vw "$f" PATH="$sb:/usr/bin:/bin"
if json_ok && tem 'node_modules VAZIO' && tem 'bun FORA DO PATH' && [ -z "$(log_de "$f")" ]; then
  ok D12 "bun fora do PATH -> avisa VAZIO + FORA DO PATH, sem log"
else ruim D12 "deps quebradas sem bun no PATH deveriam AVISAR: $out"; fi

# [D13] log que não abre (TMPDIR inexistente): "delegado" só com o log aberto — é
# ele que fecha com a marca do desfecho. Sem log, avisa e não dispara.
f="$(fixture d13)"; mkdir -p "$f/node_modules"
rodar_vw "$f" TMPDIR="$f/nao-existe"
if json_ok && tem 'node_modules VAZIO' && tem 'NAO ABRI O LOG' && ! tem 'delegado' \
   && [ ! -e "$f/.bun-chamadas" ]; then ok D13 "log que nao abre -> avisa NAO ABRI O LOG, nao dispara"
else ruim D13 "sem log aberto o aviso nao pode dizer 'delegado': $out"; fi

# Tardio: o install de [D7] e [D13] iria ao background; depois das esperas acima,
# um disparo indevido já teria registrado.
[ ! -e "$tmp/d7/.bun-chamadas" ] || ruim D7 "install disparou ATRASADO no controle com deps completas"
[ ! -e "$tmp/d13/.bun-chamadas" ] || ruim D13 "install disparou ATRASADO sem log aberto"

# A falsificação roda só o bloco de deps — é ele que ela sabota.
if [ "${TESTE_SO_DEPS:-0}" = 1 ]; then
  echo
  if [ "$fail" -eq 0 ]; then echo "PASS — deps"; else echo "FALHOU"; fi
  exit "$fail"
fi

echo "── pos-compact-ptbr.sh ──"
out="$(bash "$HOOKS/pos-compact-ptbr.sh" 2>/dev/null)"
if printf '%s' "$out" | jq -e '.hookSpecificOutput.hookEventName == "SessionStart"' >/dev/null 2>&1; then
  echo "  ok    JSON válido com hookEventName=SessionStart"
else
  echo "  FAIL  saída não é o JSON esperado: $out"; fail=1
fi
if printf '%s' "$out" | jq -r '.hookSpecificOutput.additionalContext' | grep -q "pt-BR"; then
  echo "  ok    contexto reforça pt-BR"
else
  echo "  FAIL  contexto sem o reforço de pt-BR"; fail=1
fi

echo "── vigia-worktree.sh: órfãos custosos ──"
# 2026-08-23: 8 `zsh` órfãos (PPID=1) queimaram ~5,5 dos 8 cores por 16h55min e
# este hook não tinha como vê-los — ele contava SESSÕES, que é o que o founder
# já enxerga. Levou 17 horas, por acidente. Sandbox próprio: `ps` stubado e a
# sonda REAL copiada pra dentro (nunca o ps da máquina, que traria os órfãos de
# verdade e faria a asserção variar com o humor do Mac).
orf="$tmp/orf"
mkdir -p "$orf/scripts" "$orf/stub"
cp "$here/orfaos-custosos.sh" "$orf/scripts/orfaos-custosos.sh" 2>/dev/null || true
echo '{}' > "$orf/package.json"; deps_completas "$orf"   # deps que RESPONDEM: cala o bloco 1 (vazio agora dispara install)
cat > "$orf/stub/ps" <<'STUB'
#!/bin/sh
case "${ORF_MODO:-caro}" in
  caro) printf '91234     1  1015:22.33  68.4 /bin/zsh -c while :; do :; done\n' ;;
  *)    printf '91235     1     9:32.85   3.5 /Users/x/.bun/bin/bun worker-service\n' ;;
esac
STUB
chmod +x "$orf/stub/ps"

out="$(cd "$orf" && PATH="$orf/stub:$PATH" ORF_MODO=caro bash "$VW" 2>/dev/null)"
ctx="$(printf '%s' "$out" | jq -r '.hookSpecificOutput.additionalContext // ""' 2>/dev/null)"
if printf '%s' "$ctx" | grep -q '91234'; then
  echo "  ok    orfao custoso -> avisa com o pid"
else
  echo "  FAIL  orfao custoso NAO chegou ao aviso: $out"; fail=1
fi

# Silêncio quando não há órfão CARO é metade do valor: hook que fala a cada boot
# o founder aprende a ignorar, e aí volta a levar 17h. Âncora ASCII de caixa
# fixa (ORFAO), nunca a palavra acentuada — `grep` daqui dobra acento (#1483).
out="$(cd "$orf" && PATH="$orf/stub:$PATH" ORF_MODO=barato bash "$VW" 2>/dev/null)"
ctx="$(printf '%s' "$out" | jq -r '.hookSpecificOutput.additionalContext // ""' 2>/dev/null)"
if printf '%s' "$out" | jq -e 'type == "object"' >/dev/null 2>&1 && ! printf '%s' "$ctx" | grep -q 'ORFAO'; then
  echo "  ok    orfao BARATO (claude-mem) -> silencio"
else
  echo "  FAIL  falou de orfao sem ter orfao caro: $out"; fail=1
fi

# Sonda ausente (worktree anterior a ela): sensor degrada, hook não quebra.
rm -f "$orf/scripts/orfaos-custosos.sh"
out="$(cd "$orf" && PATH="$orf/stub:$PATH" bash "$VW" 2>/dev/null)"
if printf '%s' "$out" | jq -e 'type == "object"' >/dev/null 2>&1; then
  echo "  ok    sonda ausente -> JSON valido (degrada, nao quebra)"
else
  echo "  FAIL  sonda ausente quebrou o hook: $out"; fail=1
fi

echo "── vigia-worktree.sh: bloco 4 (semáforo heavy) ──"
# Sandbox git PRÓPRIO deste bloco, dentro do $tmp já trapado acima (nunca toca
# ~/.local/bin real nem /tmp/afiacao-heavy-slots — há ~40 worktrees/sessões
# reais usando). origin/main tem VERSAO-MAIN, a worktree de teste tem
# VERSAO-LOCAL — só com essa divergência dá pra provar o estado "em voo"
# (instalado == worktree local, ≠ origin/main).
HI="$here/heavy-install.sh"
hv="$tmp/heavy4"
git init -q --bare "$hv/upstream"
git init -q "$hv/wt"
git -C "$hv/wt" remote add origin "$hv/upstream"
mkdir -p "$hv/wt/scripts"
cp "$HI" "$hv/wt/scripts/heavy-install.sh"; chmod +x "$hv/wt/scripts/heavy-install.sh"
printf '#!/usr/bin/env bash\necho VERSAO-MAIN\n' > "$hv/wt/scripts/heavy.sh"
git -C "$hv/wt" add -A
git -C "$hv/wt" -c user.email=t@t -c user.name=t commit -qm base
git -C "$hv/wt" push -q origin HEAD:main
git -C "$hv/wt" fetch -q origin
printf '#!/usr/bin/env bash\necho VERSAO-LOCAL\n' > "$hv/wt/scripts/heavy.sh"
export AFIACAO_HEAVY_DEST="$hv/bin/heavy"

# ── sincronizado → silêncio (nenhuma menção a heavy) ──────────────────────────
bash "$hv/wt/scripts/heavy-install.sh" >/dev/null 2>&1
out="$(cd "$hv/wt" && bash "$VW" 2>/dev/null)"
ctx="$(printf '%s' "$out" | jq -r '.hookSpecificOutput.additionalContext // ""' 2>/dev/null)"
if printf '%s' "$out" | jq -e 'type == "object"' >/dev/null 2>&1 && ! printf '%s' "$ctx" | grep -qi heavy; then
  echo "  ok    sincronizado → silêncio quanto ao heavy"
else
  echo "  FAIL  sincronizado deveria ficar em silêncio: $out"; fail=1
fi

# ── divergente → avisa ────────────────────────────────────────────────────────
printf '#!/usr/bin/env bash\necho OUTRACOISA\n' > "$AFIACAO_HEAVY_DEST"
out="$(cd "$hv/wt" && bash "$VW" 2>/dev/null)"
ctx="$(printf '%s' "$out" | jq -r '.hookSpecificOutput.additionalContext // ""' 2>/dev/null)"
if printf '%s' "$out" | jq -e 'type == "object"' >/dev/null 2>&1 && printf '%s' "$ctx" | grep -q "DIVERGENTE"; then
  echo "  ok    divergente → avisa"
else
  echo "  FAIL  divergente deveria avisar: $out"; fail=1
fi

# ── ausente → avisa ───────────────────────────────────────────────────────────
rm -f "$AFIACAO_HEAVY_DEST"
out="$(cd "$hv/wt" && bash "$VW" 2>/dev/null)"
ctx="$(printf '%s' "$out" | jq -r '.hookSpecificOutput.additionalContext // ""' 2>/dev/null)"
if printf '%s' "$out" | jq -e 'type == "object"' >/dev/null 2>&1 && printf '%s' "$ctx" | grep -q "NÃO instalado"; then
  echo "  ok    ausente → avisa"
else
  echo "  FAIL  ausente deveria avisar: $out"; fail=1
fi

# ── não consegui verificar → avisa ISSO, NUNCA "divergente" ───────────────────
# origin/main ilegível (repo git sem o remote/branch main): uma das 4 causas
# do exit 3. Duas condições, cada uma fechando um falso-verde medido:
#   • "FALTA DE DADO" é literal ESCRITO PELO HOOK, só no ramo `*)` (o
#     heavy-install.sh nunca emite essa string) — grep sem -i, caixa fixa.
#     Sabotar o `case` trocando o ramo `1)` por `1|*)` faz rc=3 cair no ramo
#     de "divergente" — mas a mensagem ainda contém "NÃO CONSEGUI VERIFICAR"
#     (essa vem do $st, produzida pelo heavy-install.sh). Com grep -qi
#     "não consegui verificar" (o teste antigo), sob LC_ALL=C o -i não dobra
#     Ã↔ã (bytes multibyte UTF-8 tratados como opacos pelo casefold em C) e a
#     asserção falha — correto — mas sob LC_ALL=pt_BR.UTF-8 o -i dobra e ela
#     passa mesmo com o ramo errado (falso verde medido, dependente de
#     locale). "FALTA DE DADO" é ASCII puro e exclusivo do ramo certo: não
#     ambíguo em nenhum locale, e só aparece se o CÓDIGO tomou o ramo `*)`.
#   • "git fetch origin" só chega em $ctx se o hook capturar STDERR (2>&1) —
#     é a dica que o heavy-install.sh manda por lá quando a fonte é ilegível.
#     Sabotar de volta para 2>/dev/null zera $st, mas a frase-catch-all do
#     hook (com o default "${st:-sem detalhe...}") ainda contém "FALTA DE
#     DADO" sozinha — só a exigência do fragmento exclusivo de stderr pega
#     essa sabotagem.
git init -q "$hv/semmain"
mkdir -p "$hv/semmain/scripts"
cp "$HI" "$hv/semmain/scripts/heavy-install.sh"; chmod +x "$hv/semmain/scripts/heavy-install.sh"
printf '#!/usr/bin/env bash\necho SEMMAIN\n' > "$hv/semmain/scripts/heavy.sh"
printf 'outro\n' > "$AFIACAO_HEAVY_DEST"
out="$(cd "$hv/semmain" && bash "$VW" 2>/dev/null)"
ctx="$(printf '%s' "$out" | jq -r '.hookSpecificOutput.additionalContext // ""' 2>/dev/null)"
if printf '%s' "$out" | jq -e 'type == "object"' >/dev/null 2>&1 \
   && printf '%s' "$ctx" | grep -q "FALTA DE DADO" \
   && printf '%s' "$ctx" | grep -q "git fetch origin" \
   && ! printf '%s' "$ctx" | grep -q "DIVERGENTE"; then
  echo "  ok    não consegui verificar → avisa isso (nunca 'divergente')"
else
  echo "  FAIL  origin/main ilegível deveria avisar 'não consegui verificar', nunca 'divergente': $out"; fail=1
fi

# ── em voo (--daqui) → silêncio ────────────────────────────────────────────────
bash "$hv/wt/scripts/heavy-install.sh" --daqui >/dev/null 2>&1
out="$(cd "$hv/wt" && bash "$VW" 2>/dev/null)"
ctx="$(printf '%s' "$out" | jq -r '.hookSpecificOutput.additionalContext // ""' 2>/dev/null)"
if printf '%s' "$out" | jq -e 'type == "object"' >/dev/null 2>&1 && ! printf '%s' "$ctx" | grep -qi heavy; then
  echo "  ok    em voo (--daqui) → silêncio"
else
  echo "  FAIL  em voo deveria ficar em silêncio: $out"; fail=1
fi

unset AFIACAO_HEAVY_DEST

echo
if [ "$fail" -eq 0 ]; then echo "PASS — todos os casos"; else echo "FALHOU"; fi
exit "$fail"
