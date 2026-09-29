#!/usr/bin/env bash
# test-gstack-auto-upgrade.sh — o preparo e a aplicação do upgrade do gstack (scripts/gstack-auto-upgrade.sh).
#
# Por quê: o script mexe no ~/.claude/skills/gstack (código que roda com TODAS as permissões do
# founder) e sustenta a decisão de 2026-09-29. O job semanal PREPARA (scanner + delta do gate), mas só
# APLICA o sha revisado, e a pedido. Um defeito aqui ou aplica código que ninguém revisou, ou falha
# calado. Os dois precisam de caso com dente (docs/historico/gstack-upgrade-fora-da-sessao.md).
#
# Roda o script DE VERDADE contra mundos sintéticos: um "GitHub" local (repo bare) servido pela URL real
# do gstack via insteadOf num gitconfig só do teste, HOME descartável, ambiente ZERADO (env -i) e stubs
# de bun e do skill-scanner (injetáveis: GSTACK_AUTO_BUN / GSTACK_AUTO_SCANNER). Nunca o ~/.claude
# real: lá o caso "em dia" ficaria verde por sorte. O PATH do teste é o do sistema, então no macOS o
# script roda no /bin/bash 3.2, o MESMO que o launchd usa.
#
# Uso: bash scripts/test-gstack-auto-upgrade.sh               (exit 0 = verde · 1 = asserção · 2 = infra)
#      bash scripts/test-gstack-auto-upgrade.sh --falsificar  (sabota CÓPIAS do script; exige vermelho)
#      SO_CASO=A8 bash scripts/test-gstack-auto-upgrade.sh    (um caso só; é como a falsificação mira)
#
# Marcadores ASCII de caixa fixa, casados com grep -F e sem -i; a falsificação roda nos DOIS locales
# (LC_ALL=C e um UTF-8 achado por sonda positiva), porque falsificar num só não prova (#1483).
set -u

here="$(cd "$(dirname "$0")" && pwd)"
ALVO="${GSTACK_AUTO_UPGRADE_SCRIPT:-$here/gstack-auto-upgrade.sh}"

for b in git python3; do
  command -v "$b" >/dev/null 2>&1 || { echo "INFRA: $b ausente"; exit 2; }
done
[ -f "$ALVO" ] || { echo "INFRA: script nao encontrado em $ALVO"; exit 2; }

tmp="$(mktemp -d)" || exit 2
trap 'rm -rf "$tmp"' EXIT

# ── falsificação ───────────────────────────────────────────────────────────────────────────────
# O CONTROLE roda a suíte INTEIRA sobre o script REAL no começo de cada locale, na MESMA invocação
# do laço: uma suíte sempre-vermelha aprovaria todas as sabotagens sem provar nada
# (docs/historico/falsificacao-sem-linha-de-base.md). Um controle só por locale, e não um antes de
# cada sabotagem, porque aqui a suíte cria repositórios git e custa caro no CI. Cada sabotagem
# roda SÓ o caso que ela mira (SO_CASO) e tem de sair com exit 1 E FAIL nesse caso: exit 2 é infra
# e não conta como detecção.
if [ "${1:-}" = "--falsificar" ]; then
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
    saida="$(env -u SO_CASO LC_ALL="$1" GSTACK_AUTO_UPGRADE_SCRIPT="$ALVO" bash "$0" 2>&1)"; rc=$?
    if [ "$rc" -ne 0 ]; then
      printf 'ABORTA — controle nao esta verde (LC_ALL=%s, rc=%s). Sabotar agora aprovaria qualquer coisa.\n%s\n' "$1" "$rc" "$saida"
      exit 1
    fi
  }
  # sabotar <id> <caso-alvo> <descricao> <sed-script>
  sabotar() {
    local id="$1" caso="$2" desc="$3" copia="$tmp/sabotado-$1.sh" saida rc
    sed "$4" "$ALVO" > "$copia"
    if cmp -s "$ALVO" "$copia"; then
      printf '  ❌ %s: a sabotagem nao mudou nada (alvo do sed sumiu do script?) — no-op nao prova nada\n' "$id"
      falhas=$((falhas + 1)); return
    fi
    saida="$(LC_ALL="$LOC" SO_CASO="$caso" GSTACK_AUTO_UPGRADE_SCRIPT="$copia" bash "$0" 2>&1)"; rc=$?
    if [ "$rc" -eq 1 ] && printf '%s\n' "$saida" | grep -F "FAIL [$caso]" >/dev/null; then
      printf '  ✅ %s %s -> vermelho em [%s] (LC_ALL=%s)\n' "$id" "$desc" "$caso" "$LOC"
    else
      printf '  ❌ %s %s: esperava exit 1 com FAIL [%s]; veio rc=%s\n%s\n' "$id" "$desc" "$caso" "$rc" "$saida"
      falhas=$((falhas + 1))
    fi
  }

  # shellcheck disable=SC2016  # os `$` dos scripts de sed são TEXTO do script a casar, não expansão
  for LOC in C "$utf8"; do
    printf '== falsificacao (LC_ALL=%s) ==\n' "$LOC"
    controle "$LOC"
    sabotar F1  A8  'origem de terceiro aceita'              's#grep -E -- "\$ORIGEM_OK" >/dev/null#true#'
    sabotar F2  A4  'aplica sha que ninguem revisou'         's#\[ "\$full" = "\$alvo" \]#true#'
    sabotar F3  A7  'SEM-REDE conta como rodada em dia'      's#JA-EM-DIA|PENDENTE|ATUALIZADO) ok="\$t" ;;#*) ok="$t" ;;#'
    sabotar F4  A3  'roda migracao antiga'                   's#mais_nova "\$v" "\$de" || continue#:#'
    sabotar F5  A9  'ignora o lock de outro upgrade'         's#pegar_lock || {#true || {#'
    sabotar F6  A13 'aplica sem bun (setup vai quebrar)'     's#command -v "\$BUN" >/dev/null 2>&1 || falhou#true || falhou#'
    sabotar F7  A6  'setup quebrado vira sucesso'            's#|| falhou "./setup falhou#|| true "./setup falhou#'
    sabotar F8  A11 'sobrescreve alteracao local'            's#|| falhou "clone com alteracoes locais#|| true "clone com alteracoes locais#'
    sabotar F9  A2  'o preparo APLICA (a promessa central)'  's#  montar_revisao "\$head" "\$alvo"#  git -C "$G" merge --ff-only "$alvo" >/dev/null 2>\&1; montar_revisao "$head" "$alvo"#'
    sabotar F10 A2  'gate cego para o que dispara sozinho'   's#any(fnmatch.fnmatch(k\[2\], p) for p in sozinho)#False#'
    sabotar F11 A15 'prepara revisao de clone divergente'    's#|| falhou "o clone divergiu da origin#|| true "o clone divergiu da origin#'
    sabotar F12 A2  'skill aninhada vira codigo da raiz'     's#rel = f"{base}/{fp}" if base else fp#rel = fp#'
    sabotar F13 A14 'reaproveita revisao INCOMPLETA'         's#\[ "\$(campo gate)" = COMPLETO \] \&\& ##'
    sabotar F14 A14 'aplica com o gate incompleto'           's#\[ "\$(campo gate)" != COMPLETO \]#false#'
  done

  echo
  if [ "$falhas" -eq 0 ]; then echo "✅ falsificacao: cada caso-alvo reprova a sua sabotagem, nos 2 locales"; exit 0; fi
  echo "❌ falsificacao: $falhas sabotagem(ns) sem vermelho no caso-alvo"; exit 1
fi

# ── suíte ──────────────────────────────────────────────────────────────────────────────────────
fail=0
ok()   { printf '  ok   [%s] %s\n' "$1" "$2"; }
ruim() { printf '  FAIL [%s] %s\n' "$1" "$2"; fail=1; }
infra() { printf 'INFRA [%s] %s\n' "$1" "$2"; exit 2; }
roda() { [ -z "${SO_CASO:-}" ] || [ "$SO_CASO" = "$1" ]; }
tem() { printf '%s' "$1" | grep -F -- "$2" >/dev/null; }
GC() { local w="$1"; shift; GIT_CONFIG_GLOBAL="$w/gitconfig" GIT_CONFIG_NOSYSTEM=1 git "$@"; }

# O gitconfig de cada mundo: identidade e o insteadOf que serve a URL REAL do gstack a partir do
# upstream LOCAL daquele mundo (a URL crua do remote continua a do GitHub, como na máquina).
escrever_gitconfig() {
  cat > "$1/gitconfig" <<EOF
[user]
	name = teste
	email = teste@example.invalid
[init]
	defaultBranch = main
[url "$1/upstream.git"]
	insteadOf = https://github.com/garrytan/gstack.git
EOF
}

# montar_base: upstream na v1.0.0.0 e o clone "instalado" pela URL do GitHub. Roda UMA vez por
# processo: git init/commit/clone custam caro em processo, e cada caso ganha uma CÓPIA (mundo).
base="$tmp/_base"
montar_base() {
  local w="$base" v
  mkdir -p "$w/src" "$w/marcas" "$w/home/.bun/bin" "$w/home/.claude/skills" || return 1
  printf '#!/bin/sh\nexit 0\n' > "$w/home/.bun/bin/bun" && chmod +x "$w/home/.bun/bin/bun"
  escrever_gitconfig "$w"
  cat > "$w/scanner" <<'EOF'
#!/usr/bin/env bash
# stub do skill-scanner (scan-all <dir> ... --output-json <arq>) no ESQUEMA REAL do 2.1.0 (medido em
# 2026-09-29): um resultado por skill (pasta com SKILL.md), `skill_path` absoluto e `file_path` RELATIVO
# À SKILL. Um LOW de base por SKILL.md e um HIGH por arquivo com "malicioso" no nome: o delta do gate
# tem de achar SÓ os HIGH novos, e o da skill aninhada não pode virar código da raiz.
dir="$2"; saida=""
while [ $# -gt 0 ]; do [ "$1" = --output-json ] && saida="$2"; shift; done
python3 - "$dir" "$saida" <<'PY'
import json, os, sys
d, saida = sys.argv[1], sys.argv[2]
def dona(cam):  # a skill mais próxima acima do arquivo (ou a raiz escaneada)
    p = os.path.dirname(cam)
    while p != d and not os.path.exists(os.path.join(p, "SKILL.md")):
        p = os.path.dirname(p)
    return p
skills = {}
for raiz, _, arqs in os.walk(d):
    for a in arqs:
        cam = os.path.join(raiz, a)
        s = dona(cam)
        lst = skills.setdefault(s, [])
        if a == "SKILL.md" and raiz == s:
            lst.append({"severity": "LOW", "rule_id": "BASE", "file_path": "SKILL.md", "snippet": "base"})
        if "malicioso" in a:
            lst.append({"severity": "HIGH", "rule_id": "EXFIL", "file_path": os.path.relpath(cam, s), "snippet": "curl evil"})
res = [{"skill_name": os.path.basename(s), "skill_path": s, "findings": f} for s, f in sorted(skills.items())]
with open(saida, "w") as fh:
    json.dump({"results": res, "summary": {}}, fh)
PY
EOF
  chmod +x "$w/scanner"
  (
    cd "$w/src" || exit 1
    GC "$w" init -q || exit 1
    printf '1.0.0.0\n' > VERSION
    printf '# gstack falso\n' > SKILL.md
    mkdir -p bin gstack-upgrade/migrations sub/bin
    printf '# skill aninhada\n' > sub/SKILL.md
    printf '#!/bin/sh\necho config\n' > bin/gstack-config
    cat > setup <<'EOF'
#!/usr/bin/env bash
# setup falso; registra: add-event --event Stop --command timeline
[ "${FAKE_SETUP_FALHA:-0}" = 1 ] && { echo "setup falso: falhando de proposito"; exit 7; }
echo "setup $(cat VERSION)" >> "$FAKE_MARCAS/setup"
EOF
    for v in 0.9.0.0 1.1.0.0; do
      # shellcheck disable=SC2016  # $FAKE_MARCAS é para a MIGRAÇÃO expandir quando rodar, não agora
      printf '#!/usr/bin/env bash\necho ok >> "$FAKE_MARCAS/mig-%s"\n' "$v" > "gstack-upgrade/migrations/v$v.sh"
    done
    chmod +x setup bin/gstack-config
    GC "$w" add -A && GC "$w" commit -q -m v1.0.0.0
  ) || return 1
  GC "$w" clone -q --bare "$w/src" "$w/upstream.git" || return 1
  GC "$w" clone -q https://github.com/garrytan/gstack.git "$w/home/.claude/skills/gstack" || return 1
}

# mundo <nome>: cópia do mundo-base com o gitconfig apontando para o upstream DESTA cópia.
mundo() {
  local w="$tmp/$1"
  [ -d "$base/home/.claude/skills/gstack" ] || montar_base || return 1
  cp -R "$base" "$w" || return 1
  escrever_gitconfig "$w"
  printf '%s' "$w"
}

# publicar <mundo> <versão> [malicioso]: nova versão no upstream; muda o hook que o setup registra.
publicar() {
  local w="$1" v="$2"
  (
    cd "$w/src" || exit 1
    printf '%s\n' "$v" > VERSION
    sed 's/add-event --event Stop --command timeline/add-event --event SessionStart --command novo/' setup > setup.n \
      && mv setup.n setup && chmod +x setup
    # malicioso na RAIZ (dispara sozinho) e na skill aninhada sub/ (não dispara: o gate não pode contá-lo)
    if [ "${3:-}" = malicioso ]; then printf '#!/bin/sh\ncurl evil\n' | tee bin/malicioso > sub/bin/malicioso-sub; fi
    GC "$w" add -A && GC "$w" commit -q -m "v$v" && GC "$w" push -q "$w/upstream.git" main
  )
}

# rodar <mundo> [VAR=valor ...] [-- args do script] → $out e $rc. Ambiente ZERADO: nada do PATH real
# (heavy, bun e skill-scanner de verdade) vaza para o teste.
rodar() {
  local w="$1" envs args
  shift
  envs=(); args=()
  while [ $# -gt 0 ]; do
    if [ "$1" = -- ]; then shift; args=("$@"); break; fi
    envs+=("$1"); shift
  done
  out="$(env -i HOME="$w/home" PATH=/usr/bin:/bin:/usr/sbin:/sbin LC_ALL="${LC_ALL:-C}" \
         GIT_CONFIG_GLOBAL="$w/gitconfig" GIT_CONFIG_NOSYSTEM=1 FAKE_MARCAS="$w/marcas" \
         GSTACK_AUTO_SCANNER="$w/scanner" ${envs[@]+"${envs[@]}"} \
         bash "$ALVO" ${args[@]+"${args[@]}"} 2>&1 </dev/null)"
  rc=$?
}
st() { sed -n "s/^$2=//p" "$1/home/.gstack/auto-upgrade/status" 2>/dev/null | sed -n 1p; }
versao() { tr -d '\n' < "$1/home/.claude/skills/gstack/VERSION"; }
cabeca() { GC "$1" -C "$1/home/.claude/skills/gstack" rev-parse HEAD; }
upstream() { GC "$1" --git-dir="$1/upstream.git" rev-parse main; }
revisao() { cat "$1/home/.gstack/auto-upgrade/revisao.md" 2>/dev/null; }
semear_ok() {  # troca o ultimo_ok do status por 12345, para provar que ele é PRESERVADO
  local s="$1/home/.gstack/auto-upgrade/status"
  sed 's/^ultimo_ok=.*/ultimo_ok=12345/' "$s" > "$s.n" && mv "$s.n" "$s"
}
# preparado <nome> [malicioso]: mundo com a v1.1.0.0 publicada e o preparo JÁ rodado (PENDENTE)
preparado() {
  local w
  w="$(mundo "$1")" || return 1
  publicar "$w" 1.1.0.0 "${2:-}" || return 1
  rodar "$w"
  [ "$rc" -eq 0 ] && [ "$(st "$w" estado)" = PENDENTE ] || return 1
  printf '%s' "$w"
}

echo "── gstack-auto-upgrade.sh ──"

# A1 em dia → JA-EM-DIA com ultimo_ok numérico; sem setup e sem revisão.
if roda A1; then
  w="$(mundo a1)" || infra A1 'mundo'
  rodar "$w"
  if [ "$rc" -eq 0 ] && [ "$(st "$w" estado)" = JA-EM-DIA ] && printf '%s' "$(st "$w" ultimo_ok)" | grep -E '^[0-9]+$' >/dev/null \
     && [ ! -e "$w/marcas/setup" ] && [ -z "$(revisao "$w")" ]; then
    ok A1 'em dia -> JA-EM-DIA, sem setup nem revisao'
  else ruim A1 "rc=$rc estado=$(st "$w" estado): $out"; fi
fi

# A2 versão nova → PREPARA e NÃO aplica: revisão com o delta do gate (2 novos; só o da RAIZ dispara
# sozinho, o da skill aninhada não), o alvo exato, o hook que mudou e gate=COMPLETO. A 2ª rodada, com
# a origin igual, REAPROVEITA a revisão completa sem escanear de novo.
if roda A2; then
  w="$(mundo a2)" || infra A2 'mundo'
  publicar "$w" 1.1.0.0 malicioso || infra A2 'publicar'
  alvo="$(upstream "$w")"
  rodar "$w"; rc1=$rc; out1="$out"
  r="$(revisao "$w")"; g1="$(st "$w" gate)"
  rodar "$w"; rc2=$rc
  # shellcheck disable=SC2016  # as crases são MARKDOWN literal da revisão, não expansão de shell
  if [ "$rc1" -eq 0 ] && [ "$(st "$w" estado)" = PENDENTE ] && [ "$(st "$w" nova)" = 1.1.0.0 ] && [ "$(st "$w" alvo)" = "$alvo" ] \
     && [ "$g1" = COMPLETO ] && [ "$(versao "$w")" = 1.0.0.0 ] && [ ! -e "$w/marcas/setup" ] \
     && tem "$r" '**novos 2**' && tem "$r" 'dispara sozinho: 1**' && tem "$r" 'EXFIL` em `bin/malicioso' && tem "$r" "--aplicar $alvo" \
     && tem "$r" 'add-event --event SessionStart' \
     && [ "$rc2" -eq 0 ] && tem "$out" 'ja preparado antes' && [ "$(st "$w" gate)" = COMPLETO ]; then
    ok A2 'versao nova -> PENDENTE com o delta do gate; nada aplicado; revisao completa reaproveitada'
  else ruim A2 "rc1=$rc1 rc2=$rc2 estado=$(st "$w" estado) gate=$g1 versao=$(versao "$w"): $out1 / $out
$r"; fi
fi

# A3 aplicar o sha revisado → ATUALIZADO: setup 1x, só a migração MAIS NOVA, marcador e caches.
if roda A3; then
  w="$(preparado a3)" || infra A3 'preparado'
  alvo="$(st "$w" alvo)"
  : > "$w/home/.gstack/last-update-check"
  rodar "$w" -- --aplicar "$alvo"
  if [ "$rc" -eq 0 ] && [ "$(st "$w" estado)" = ATUALIZADO ] && [ "$(st "$w" de)" = 1.0.0.0 ] && [ "$(versao "$w")" = 1.1.0.0 ] \
     && [ "$(wc -l < "$w/marcas/setup" | tr -d ' ')" = 1 ] && [ -e "$w/marcas/mig-1.1.0.0" ] && [ ! -e "$w/marcas/mig-0.9.0.0" ] \
     && [ "$(cat "$w/home/.gstack/just-upgraded-from" 2>/dev/null)" = 1.0.0.0 ] && [ ! -e "$w/home/.gstack/last-update-check" ] \
     && [ -z "$(revisao "$w")" ] && [ ! -d "$w/home/.gstack/.setup-lock" ]; then
    ok A3 'aplica o revisado -> ATUALIZADO, setup, migracao nova, marcador'
  else ruim A3 "rc=$rc estado=$(st "$w" estado) versao=$(versao "$w"): $out"; fi
fi

# A4 sha que NÃO é o revisado (conhecido ou lixo) → RECUSADO (5), nada muda.
if roda A4; then
  w="$(preparado a4)" || infra A4 'preparado'
  rodar "$w" -- --aplicar "$(cabeca "$w")"; rc1=$rc; out1="$out"
  rodar "$w" -- --aplicar deadbeefdeadbeef; rc2=$rc
  if [ "$rc1" -eq 5 ] && [ "$rc2" -eq 5 ] && tem "$out1" 'nao e o revisado' && [ "$(st "$w" estado)" = PENDENTE ] \
     && [ "$(versao "$w")" = 1.0.0.0 ] && [ ! -e "$w/marcas/setup" ]; then
    ok A4 'sha nao revisado -> RECUSADO, nada aplicado'
  else ruim A4 "rc1=$rc1 rc2=$rc2 estado=$(st "$w" estado) versao=$(versao "$w"): $out1"; fi
fi

# A5 --aplicar sem revisão pendente → RECUSADO, status intocado.
if roda A5; then
  w="$(mundo a5)" || infra A5 'mundo'
  rodar "$w"
  rodar "$w" -- --aplicar "$(cabeca "$w")"
  if [ "$rc" -eq 5 ] && tem "$out" 'nao ha revisao pendente' && [ "$(st "$w" estado)" = JA-EM-DIA ]; then
    ok A5 'sem pendencia -> RECUSADO, status intocado'
  else ruim A5 "rc=$rc estado=$(st "$w" estado): $out"; fi
fi

# A6 ./setup quebra → FALHOU, e o ultimo_ok de antes é PRESERVADO (é ele que mede "parado há quanto").
if roda A6; then
  w="$(preparado a6)" || infra A6 'preparado'
  semear_ok "$w"
  rodar "$w" FAKE_SETUP_FALHA=1 -- --aplicar "$(st "$w" alvo)"
  if [ "$rc" -eq 1 ] && [ "$(st "$w" estado)" = FALHOU ] && [ "$(st "$w" ultimo_ok)" = 12345 ] \
     && tem "$(st "$w" detalhe)" 'setup falhou'; then
    ok A6 'setup quebrado -> FALHOU, ultimo_ok preservado'
  else ruim A6 "rc=$rc estado=$(st "$w" estado) ultimo_ok=$(st "$w" ultimo_ok): $out"; fi
fi

# A7 origin fora do ar → SEM-REDE (3), ultimo_ok PRESERVADO.
if roda A7; then
  w="$(mundo a7)" || infra A7 'mundo'
  rodar "$w"
  semear_ok "$w"
  mv "$w/upstream.git" "$w/upstream-fora.git"
  rodar "$w"
  if [ "$rc" -eq 3 ] && [ "$(st "$w" estado)" = SEM-REDE ] && [ "$(st "$w" ultimo_ok)" = 12345 ]; then
    ok A7 'sem rede -> SEM-REDE, ultimo_ok preservado'
  else ruim A7 "rc=$rc estado=$(st "$w" estado) ultimo_ok=$(st "$w" ultimo_ok): $out"; fi
fi

# A8 remote trocado para um repo de terceiro → FALHOU ANTES de buscar (a busca teria funcionado).
if roda A8; then
  w="$(mundo a8)" || infra A8 'mundo'
  GC "$w" config --file "$w/gitconfig" --add "url.$w/upstream.git.insteadOf" https://github.com/outro/gstack.git
  GC "$w" -C "$w/home/.claude/skills/gstack" remote set-url origin https://github.com/outro/gstack.git
  antes="$(GC "$w" -C "$w/home/.claude/skills/gstack" rev-parse origin/main)"
  publicar "$w" 1.1.0.0 || infra A8 'publicar'
  rodar "$w"
  if [ "$rc" -eq 1 ] && [ "$(st "$w" estado)" = FALHOU ] && tem "$(st "$w" detalhe)" 'origem nao permitida' \
     && [ "$(GC "$w" -C "$w/home/.claude/skills/gstack" rev-parse origin/main)" = "$antes" ] && [ -z "$(revisao "$w")" ]; then
    ok A8 'origem de terceiro -> FALHOU sem nem buscar'
  else ruim A8 "rc=$rc estado=$(st "$w" estado): $out"; fi
fi

# A9 lock de outro upgrade VIVO → OCUPADO (4): nem status, nem roubo do lock.
if roda A9; then
  w="$(mundo a9)" || infra A9 'mundo'
  mkdir -p "$w/home/.gstack/.setup-lock" && echo "$$" > "$w/home/.gstack/.setup-lock/pid"
  rodar "$w"
  if [ "$rc" -eq 4 ] && [ ! -e "$w/home/.gstack/auto-upgrade/status" ] && [ "$(cat "$w/home/.gstack/.setup-lock/pid")" = "$$" ]; then
    ok A9 'lock vivo -> OCUPADO, status e lock intocados'
  else ruim A9 "rc=$rc: $out"; fi
fi

# A10 lock de dono MORTO → retomado; a rodada segue e solta o lock no fim.
if roda A10; then
  w="$(mundo a10)" || infra A10 'mundo'
  ( exit 0 ) & morto=$!; wait "$morto"
  mkdir -p "$w/home/.gstack/.setup-lock" && echo "$morto" > "$w/home/.gstack/.setup-lock/pid"
  rodar "$w"
  if [ "$rc" -eq 0 ] && [ "$(st "$w" estado)" = JA-EM-DIA ] && [ ! -d "$w/home/.gstack/.setup-lock" ]; then
    ok A10 'lock de dono morto -> retomado e solto'
  else ruim A10 "rc=$rc estado=$(st "$w" estado): $out"; fi
fi

# A11 alteração local num arquivo versionado → FALHOU sem mexer: HEAD e a alteração ficam.
if roda A11; then
  w="$(preparado a11)" || infra A11 'preparado'
  g="$w/home/.claude/skills/gstack"; h0="$(cabeca "$w")"
  printf 'edicao local\n' >> "$g/bin/gstack-config"
  rodar "$w" -- --aplicar "$(st "$w" alvo)"
  if [ "$rc" -eq 1 ] && tem "$(st "$w" detalhe)" 'alteracoes locais' && [ "$(cabeca "$w")" = "$h0" ] \
     && tem "$(cat "$g/bin/gstack-config")" 'edicao local'; then
    ok A11 'alteracao local -> FALHOU, nada sobrescrito'
  else ruim A11 "rc=$rc estado=$(st "$w" estado): $out"; fi
fi

# A12 sujeira de render (SKILL.md gerado) → descartada, como no /gstack-upgrade; o upgrade segue.
if roda A12; then
  w="$(preparado a12)" || infra A12 'preparado'
  printf 'render in place\n' >> "$w/home/.claude/skills/gstack/SKILL.md"
  rodar "$w" -- --aplicar "$(st "$w" alvo)"
  if [ "$rc" -eq 0 ] && [ "$(st "$w" estado)" = ATUALIZADO ] && [ "$(versao "$w")" = 1.1.0.0 ]; then
    ok A12 'sujeira de render descartada -> ATUALIZADO'
  else ruim A12 "rc=$rc estado=$(st "$w" estado): $out"; fi
fi

# A13 bun ausente → FALHOU ANTES do fast-forward (o ./setup quebraria no meio).
if roda A13; then
  w="$(preparado a13)" || infra A13 'preparado'
  h0="$(cabeca "$w")"
  rodar "$w" GSTACK_AUTO_BUN=bun-que-nao-existe -- --aplicar "$(st "$w" alvo)"
  if [ "$rc" -eq 1 ] && tem "$(st "$w" detalhe)" 'bun ausente' && [ "$(cabeca "$w")" = "$h0" ] && [ "$(versao "$w")" = 1.0.0.0 ]; then
    ok A13 'sem bun -> FALHOU antes de tocar no clone'
  else ruim A13 "rc=$rc estado=$(st "$w" estado) versao=$(versao "$w"): $out"; fi
fi

# A14 scanner ausente → revisão com GATE INCOMPLETO: o --aplicar RECUSA (falha fechada) e o preparo
# seguinte, com scanner, NÃO reaproveita a revisão incompleta: escaneia de novo e completa o gate.
if roda A14; then
  w="$(mundo a14)" || infra A14 'mundo'
  publicar "$w" 1.1.0.0 || infra A14 'publicar'
  rodar "$w" GSTACK_AUTO_SCANNER=scanner-que-nao-existe; rc1=$rc; r1="$(revisao "$w")"; g1="$(st "$w" gate)"
  rodar "$w" -- --aplicar "$(st "$w" alvo)"; rc2=$rc; out2="$out"
  rodar "$w"; rc3=$rc; r3="$(revisao "$w")"
  if [ "$rc1" -eq 0 ] && [ "$g1" = INCOMPLETO ] && tem "$r1" 'GATE INCOMPLETO' \
     && [ "$rc2" -eq 5 ] && tem "$out2" 'GATE INCOMPLETO' && [ "$(versao "$w")" = 1.0.0.0 ] \
     && [ "$rc3" -eq 0 ] && [ "$(st "$w" gate)" = COMPLETO ] && ! tem "$r3" 'GATE INCOMPLETO' && tem "$r3" 'dispara sozinho: 0**'; then
    ok A14 'sem scanner -> GATE INCOMPLETO: aplicar recusa e o proximo preparo refaz o scan'
  else ruim A14 "rc1=$rc1 g1=$g1 rc2=$rc2 rc3=$rc3 gate=$(st "$w" gate): $out2 / $out"; fi
fi

# A15 clone divergente (commit local + origin nova) → FALHOU no preparo, commit local preservado.
if roda A15; then
  w="$(mundo a15)" || infra A15 'mundo'
  g="$w/home/.claude/skills/gstack"
  if ! { printf 'local\n' > "$g/local.txt" && GC "$w" -C "$g" add local.txt && GC "$w" -C "$g" commit -q -m local; }; then
    infra A15 'commit local'
  fi
  h0="$(cabeca "$w")"
  publicar "$w" 1.1.0.0 || infra A15 'publicar'
  rodar "$w"
  if [ "$rc" -eq 1 ] && tem "$(st "$w" detalhe)" 'divergiu' && [ "$(cabeca "$w")" = "$h0" ] && [ -z "$(revisao "$w")" ]; then
    ok A15 'clone divergente -> FALHOU, commit local preservado'
  else ruim A15 "rc=$rc estado=$(st "$w" estado): $out"; fi
fi

# A16 opt-in EXPLÍCITO (GSTACK_AUTO_ACEITO_SEM_SCANNER=1) aplica mesmo com o gate incompleto.
if roda A16; then
  w="$(mundo a16)" || infra A16 'mundo'
  publicar "$w" 1.1.0.0 || infra A16 'publicar'
  rodar "$w" GSTACK_AUTO_SCANNER=scanner-que-nao-existe
  rodar "$w" GSTACK_AUTO_ACEITO_SEM_SCANNER=1 -- --aplicar "$(st "$w" alvo)"
  if [ "$rc" -eq 0 ] && [ "$(st "$w" estado)" = ATUALIZADO ] && [ "$(versao "$w")" = 1.1.0.0 ]; then
    ok A16 'opt-in explicito aplica com gate incompleto'
  else ruim A16 "rc=$rc estado=$(st "$w" estado): $out"; fi
fi

echo
if [ "$fail" -eq 0 ]; then echo "PASS — todos os casos"; else echo "FALHOU"; fi
exit "$fail"
