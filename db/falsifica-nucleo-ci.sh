#!/usr/bin/env bash
# falsifica-nucleo-ci.sh — o gate de provas SQL tem DENTE?
# =====================================================================================
#   bash db/falsifica-nucleo-ci.sh
#
# Um gate só vale o que ele REPROVA. Este harness restaura defeitos que existiram de
# verdade neste repo e exige que o núcleo fique VERMELHO **pelo motivo certo** — não
# por qualquer motivo. Depois desfaz e exige o verde de volta.
#
# ## As três regras que este arquivo obedece
#
# 1. **Controle verde na MESMA invocação, antes do primeiro `sed`.** Uma suíte
#    sempre-vermelha aprovaria toda sabotagem, e o verde de outra invocação não é
#    linha de base (docs/historico/falsificacao-sem-linha-de-base.md). Se o controle
#    não passar, isto ABORTA sem sabotar nada.
# 2. **A marca, não o vermelho — e a marca EXCLUSIVA da falha.** Cada sabotagem declara a
#    string que o vermelho tem de conter. `exit != 0` sozinho aceitaria falha de ambiente —
#    Postgres ausente, porta ocupada, disco cheio — como se fosse captura. Não é. E a marca
#    que também sai no VERDE casa qualquer vermelho (o título de uma asserção aparece no ✅
#    e no ❌): o `julga_captura` a confere contra o log do controle verde da mesma prova — e recusa
#    o controle VAZIO, contra o qual essa conferência não mediria nada.
# 3. **Sabotagem que não aplicou é falsificação INVÁLIDA, não gate sem dente.** Toda
#    sabotagem confere que mudou o arquivo, e o quê. Isto foi medido durante a escrita
#    deste harness: a primeira tentativa contra `security_invoker` apagou uma linha de
#    COMENTÁRIO, o teste seguiu verde — e a leitura ingênua seria "o gate não pega".
#
# ## Nunca toca `supabase/migrations/`
#
# O acervo de migrations é DR do Lovable, e há hook de imutabilidade sobre ele. Então
# tudo aqui acontece num ESPELHO em tmpdir: as provas resolvem `REPO_ROOT` a partir do
# próprio caminho (`dirname $BASH_SOURCE/..`), então rodá-las de dentro do espelho faz
# com que leiam as migrations do espelho. O repo de trabalho fica intocado — não há
# `git checkout --` nenhum no caminho de restauração, e nada a restaurar se isto morrer.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ESPELHO="$(mktemp -d "/tmp/falsif-nucleo.XXXXXX")"
LOGS="$ESPELHO/_logs"; mkdir -p "$LOGS"
PORTA=5920
export LC_ALL=C LANG=C

trap 'rm -rf "$ESPELHO"' EXIT

OK=0; XX=0; FALHAS=()
ok()  { OK=$((OK+1)); echo "  OK   $1"; }
bad() { XX=$((XX+1)); FALHAS+=("$1"); echo "  XX   $1"; }

echo "=== espelho em $ESPELHO ==="
cp -R "$REPO_ROOT/db" "$ESPELHO/db"
mkdir -p "$ESPELHO/supabase"
cp -R "$REPO_ROOT/supabase/migrations" "$ESPELHO/supabase/migrations"

# roda_prova <script-basename> -> ecoa rc; log em $LOGS/<nome>.<tag>.log
roda_prova() {
  local nome="$1" tag="$2" rc
  PORTA=$((PORTA + 1))
  PGPORT_TEST="$PORTA" bash "$ESPELHO/db/$nome.sh" > "$LOGS/$nome.$tag.log" 2>&1 && rc=0 || rc=$?
  printf '%s' "$rc"
}

# julga_captura <rc> <log-sabotado> <log-controle-verde> <marca> -> ecoa CERTO se o vermelho é o
# certo; senão, o que está errado nele. O veredito é uma PALAVRA, nunca o silêncio (regra 5 de
# docs/historico/falsificacao-da-canaria-no-caminho-obrigatorio.md).
# A marca que já aparece no CONTROLE VERDE da mesma prova, nesta invocação, casa QUALQUER vermelho.
# Foi a do bug real 3 até 2026-09-14 — o título da asserção, que o `eq` imprime no ✅ e no ❌: com a
# asserção autorreferente e o vermelho vindo de OUTRA (a de metadados), este harness creditava a
# captura (parecer Codex, 3ª rodada do #2472 — reproduzido por execução).
julga_captura() {
  local rc="$1" log="$2" ctrl="$3" marca="$4" no_verde
  if [ "$rc" -eq 0 ]; then printf 'o gate ficou VERDE com o defeito instalado'; return 0; fi
  # Controle de 0 bytes: o `grep` abaixo sairia 1 — "a marca não sai no verde" — sem ter medido nada.
  if [ ! -s "$ctrl" ]; then printf 'controle verde VAZIO ou ausente (%s): nada contra o que medir a marca' "$ctrl"; return 0; fi
  grep -qF -e "$marca" "$ctrl" && no_verde=0 || no_verde=$?
  case "$no_verde" in
    1) ;;
    0) printf "a marca '%s' aparece no CONTROLE VERDE da prova — casaria qualquer vermelho" "$marca"; return 0 ;;
    *) printf 'nao consegui ler o controle verde (%s, grep saiu %s)' "$ctrl" "$no_verde"; return 0 ;;
  esac
  if grep -qF -e "$marca" "$log"; then printf 'CERTO'
  else printf "vermelho (exit %s) mas SEM a marca '%s'; motivo não confirmado" "$rc" "$marca"; fi
}

# ── CONTROLE DO JUIZ POR RAMO ───────────────────────────────────────────────────
# Antes de qualquer Postgres, custo ~0: um caso sintético por RAMO do `julga_captura`, o positivo
# incluído. Os 3 bugs reais não distinguem juiz bom de quebrado (as marcas deles JÁ são exclusivas e
# o vermelho sempre vem): voltar ao `grep` no log inteiro, trocar a checagem final por `printf CERTO`,
# aceitar controle vazio ou esquecer o exit 0 passaria por todos eles (parecer Codex sobre o
# conserto, 2026-09-14). Cada caso isola o SEU ramo: quando a recusa não é pela marca ausente, a
# marca ESTÁ no sabotado. O positivo pega o juiz que recusa tudo. Logs em ASCII.
echo
echo "=== controle do juiz (um caso por ramo, sem Postgres) ==="
printf '  OK   customer NAO le v_exemplo (=0)\n  OK   outra assercao (=5)\n' > "$LOGS/juiz.ctrl.log"
: > "$LOGS/juiz.vazio.ctrl.log"
printf '  FAIL customer NAO le v_exemplo -- esperado [0], veio [1]\n' > "$LOGS/juiz.capturado.log"
printf '  OK   customer NAO le v_exemplo (=1)\n  FAIL outra assercao -- esperado [5], veio [4]\n' > "$LOGS/juiz.outro.log"
marca_titulo='customer NAO le v_exemplo'; marca_falha="$marca_titulo -- esperado [0], veio [1]"
# juiz_exige <descrição> <CERTO | trecho só da recusa esperada> <rc> <log-sabotado> <log-controle> <marca>
juiz_exige() {
  local desc="$1" espera="$2" v; shift 2
  v="$(julga_captura "$@")"
  if [ "$espera" = CERTO ] && [ "$v" = CERTO ]; then ok "juiz $desc"; return 0; fi
  if [ "$espera" != CERTO ] && [ "$v" != CERTO ] && [[ "$v" == *"$espera"* ]]; then ok "juiz $desc"; return 0; fi
  bad "juiz $desc — veio: ${v:-nada (saiu sem veredito)}"
}
juiz_exige "credita a marca que só sai no vermelho (não recusa tudo)" CERTO \
  1 "$LOGS/juiz.capturado.log" "$LOGS/juiz.ctrl.log" "$marca_falha"
juiz_exige "recusa a marca que também sai no controle verde (casaria qualquer vermelho)" "CONTROLE VERDE" \
  1 "$LOGS/juiz.outro.log" "$LOGS/juiz.ctrl.log" "$marca_titulo"
juiz_exige "recusa o vermelho SEM a marca (quem reprovou foi outra asserção)" "SEM a marca" \
  1 "$LOGS/juiz.outro.log" "$LOGS/juiz.ctrl.log" "$marca_falha"
juiz_exige "recusa exit 0 mesmo com a marca no log" "ficou VERDE com o defeito" \
  0 "$LOGS/juiz.capturado.log" "$LOGS/juiz.ctrl.log" "$marca_falha"
juiz_exige "recusa o controle verde VAZIO (medir a marca contra nada)" "VAZIO ou ausente" \
  1 "$LOGS/juiz.capturado.log" "$LOGS/juiz.vazio.ctrl.log" "$marca_falha"

# ── CONTROLE INICIAL ────────────────────────────────────────────────────────────
# Antes de qualquer sabotagem. Se uma destas já estiver vermelha, todo veredito
# abaixo seria ruído — e o harness precisa dizer isso, não seguir em frente.
echo
echo "=== controle inicial (linha de base VERDE, mesma invocação) ==="
for p in test-claim-disparo-cenario-b test-disparado-simulado-pos-disparo test-security-invoker-views; do
  rc="$(roda_prova "$p" ctrl)"
  if [ "$rc" -ne 0 ]; then
    echo "::error::CONTROLE VERMELHO em $p (exit $rc) — abortando ANTES de sabotar."
    echo "  sem linha de base verde, nenhuma captura abaixo significaria nada."
    tail -20 "$LOGS/$p.ctrl.log" | sed 's/^/    /'
    exit 1
  fi
  ok "controle verde: $p"
done

# ── SABOTAGENS DE BUG REAL ──────────────────────────────────────────────────────
# aplica_e_exige <descrição> <prova> <arquivo-relativo> <marca-esperada> <python-de-sabotagem>
aplica_e_exige() {
  local desc="$1" prova="$2" rel="$3" marca="$4" py="$5"
  local alvo="$ESPELHO/$rel"

  cp "$alvo" "$alvo.intacto"
  # A sabotagem é um programa que ABORTA se não mudar nada. "Não aplicou" e "gate sem
  # dente" produzem o mesmo verde, e são coisas opostas — separá-las é o ponto.
  if ! python3 -c "$py" "$alvo" > "$LOGS/sabotagem.log" 2>&1; then
    bad "$desc — SABOTAGEM NÃO APLICOU (falsificação inválida): $(tail -1 "$LOGS/sabotagem.log")"
    mv "$alvo.intacto" "$alvo"; return
  fi

  local rc; rc="$(roda_prova "$prova" sabotado)"
  local log="$LOGS/$prova.sabotado.log" veredito

  # Vermelho pelo motivo ERRADO é indistinguível de falha de ambiente — e a marca que também sai no
  # verde casa qualquer vermelho. Quem decide é o `julga_captura`, contra o controle verde da prova.
  veredito="$(julga_captura "$rc" "$log" "$LOGS/$prova.ctrl.log" "$marca")"
  if [ "$veredito" = CERTO ]; then
    ok "$desc — vermelho com a marca '$marca', ausente do controle verde"
  else
    bad "$desc — ${veredito:-o juiz saiu sem veredito}"
    grep -oE '\[[A-Z0-9-]+\]|❌.{0,70}' "$log" | sort -u | head -4 | sed 's/^/       visto: /' || true
  fi

  mv "$alvo.intacto" "$alvo"
  # Restauração CONFERIDA: um harness que deixa a sabotagem para trás envenena tudo
  # que rodar depois dele.
  local rc2; rc2="$(roda_prova "$prova" restaurado)"
  if [ "$rc2" -eq 0 ]; then ok "  └ restaurado: $prova volta ao verde"
  else bad "  └ RESTAURAÇÃO FALHOU: $prova segue vermelho (exit $rc2)"; fi
}

echo
echo "=== bug real 1 — #2285, Cenário B do TOCTOU (money-path) ==="
echo "    a allowlist de status sai do WHERE que GRAVA: o claim passaria a decidir"
echo "    sobre um retrato, e o cancelamento entre os round-trips volta a furar."
aplica_e_exige \
  "#2285 allowlist fora do UPDATE" \
  "test-claim-disparo-cenario-b" \
  "supabase/migrations/20260906190615_reposicao_claim_disparo_cenario_b.sql" \
  "[CLAIM-GUARD-FORA-DO-UPDATE]" \
  'import sys,pathlib
p=pathlib.Path(sys.argv[1]); t=p.read_text()
a="\n     AND status IN ('"'"'aprovado_aguardando_disparo'"'"', '"'"'falha_envio'"'"')"
assert t.count(a)==1, f"esperava 1 ocorrencia da allowlist, achei {t.count(a)}"
p.write_text(t.replace(a,"",1))'

echo
echo "=== bug real 2 — #2306, disparado_simulado não era estado pós-disparo ==="
echo "    o dry-run cria pedido de compra REAL no Omie; tirar o estado do predicado"
echo "    do trigger devolve o cancelamento silencioso de uma compra que aconteceu."
# A marca é a do RAISE da postcondição, não a tag sozinha: `[GUARD-CEGO]` sai 2 vezes no controle
# verde, nas asserções F5/F7 da própria prova (medido 2026-09-14 — tag: verde 2, sabotado 1;
# `POST FALHOU [GUARD-CEGO]`: verde 0, sabotado 1).
aplica_e_exige \
  "#2306 disparado_simulado escapa do trigger" \
  "test-disparado-simulado-pos-disparo" \
  "supabase/migrations/20260907095841_disparado_simulado_e_estado_pos_disparo.sql" \
  "POST FALHOU [GUARD-CEGO]" \
  'import sys,pathlib
p=pathlib.Path(sys.argv[1]); t=p.read_text()
a="IF OLD.status NOT IN ('"'"'disparado'"'"', '"'"'disparado_simulado'"'"', '"'"'concluido_recebido'"'"') THEN"
b="IF OLD.status NOT IN ('"'"'disparado'"'"', '"'"'concluido_recebido'"'"') THEN"
assert t.count(a)>=1, "predicado do trigger nao encontrado"
p.write_text(t.replace(a,b,1))'

echo
echo "=== bug real 3 — security_invoker omitido (classe #1375) ==="
echo "    UMA view perde o invoker e passa a ler como OWNER, bypassando a RLS."
echo "    É falha ABERTA: nada no CI textual a enxerga, e a tela segue funcionando."
# A marca é a do ❌ do `eq`, não o título da asserção: o título sai também no ✅ e, no log inteiro,
# casava qualquer vermelho — com a asserção autorreferente e o vermelho vindo da de metadados, este
# caso ficava OK (parecer Codex 2026-09-14; medido — título: verde 1; esta marca: verde 0, sabotado 1).
aplica_e_exige \
  "view sem security_invoker vaza para customer" \
  "test-security-invoker-views" \
  "supabase/migrations/20260717015000_restaurar_security_invoker_views.sql" \
  "customer NÃO lê v_sku_sigma_demanda — esperado [0], veio [1]" \
  'import sys,pathlib
p=pathlib.Path(sys.argv[1]); ls=p.read_text().splitlines(keepends=True)
alvo="ALTER VIEW public.v_sku_sigma_demanda              SET (security_invoker = on);\n"
i=[n for n,l in enumerate(ls) if l==alvo]
assert len(i)==1, f"esperava 1 linha de CODIGO (nao comentario), achei {len(i)}"
ls[i[0]]="-- "+alvo
p.write_text("".join(ls))'

# ── SABOTAGENS DO EXECUTOR ──────────────────────────────────────────────────────
# O runner é código novo: ele também precisa reprovar quando deveria. Cada caso
# abaixo é um jeito conhecido de um gate ficar verde sem ter provado nada.
echo
echo "=== o EXECUTOR reconhece as próprias falhas? ==="

exec_exige() {
  local desc="$1" marca="$2"; shift 2
  local log="$LOGS/exec.$RANDOM.log" rc
  "$@" > "$log" 2>&1 && rc=0 || rc=$?
  if [ "$rc" -eq 0 ]; then bad "$desc — runner APROVOU"
  elif ! grep -qF -e "$marca" "$log"; then
    bad "$desc — reprovou (exit $rc) sem a marca '$marca'"; tail -3 "$log" | sed 's/^/       /'
  else ok "$desc — reprovou com a marca certa"; fi
}

: > "$ESPELHO/manifesto-vazio.txt"
exec_exige "manifesto VAZIO não é 'nada a fazer'" "não executa nada" \
  env MANIFESTO="$ESPELHO/manifesto-vazio.txt" bash "$ESPELHO/db/roda-nucleo-ci.sh"

printf 'db/test-nao-existe-mesmo.sh 10\n' > "$ESPELHO/manifesto-fantasma.txt"
exec_exige "caminho inexistente ABORTA (não é filtrado)" "arquivo não existe" \
  env MANIFESTO="$ESPELHO/manifesto-fantasma.txt" bash "$ESPELHO/db/roda-nucleo-ci.sh"

printf 'db/test-fin-sync-lease.sh 0\n' > "$ESPELHO/manifesto-zero.txt"
exec_exige "mínimo 0 é recusado (aprovaria prova vazia)" "precisa ser ≥1" \
  env MANIFESTO="$ESPELHO/manifesto-zero.txt" bash "$ESPELHO/db/roda-nucleo-ci.sh"

printf 'db/test-fin-sync-lease.sh 22\ndb/test-fin-sync-lease.sh 22\n' > "$ESPELHO/manifesto-dup.txt"
exec_exige "duplicata no manifesto ABORTA" "duplicata" \
  env MANIFESTO="$ESPELHO/manifesto-dup.txt" bash "$ESPELHO/db/roda-nucleo-ci.sh"

# Prova substituída por um `exit 0` — o caso que a contagem de asserts existe para pegar,
# e que `[ "$FAIL" -eq 0 ]` sozinho aceitaria.
printf '#!/usr/bin/env bash\nexit 0\n' > "$ESPELHO/db/test-fin-sync-lease.sh"
printf 'db/test-fin-sync-lease.sh 22\n' > "$ESPELHO/manifesto-oco.txt"
exec_exige "prova esvaziada (exit 0 sem asserts) REPROVA" "SEM linha de contagem" \
  env MANIFESTO="$ESPELHO/manifesto-oco.txt" bash "$ESPELHO/db/roda-nucleo-ci.sh"

# Prova que roda, mas encolheu abaixo do contrato do manifesto.
printf '#!/usr/bin/env bash\necho "RESULTADO: 3 ok / 0 fail"\nexit 0\n' > "$ESPELHO/db/test-fin-sync-lease.sh"
exec_exige "prova ENCOLHIDA (3 asserts < 22) REPROVA" "o manifesto exige" \
  env MANIFESTO="$ESPELHO/manifesto-oco.txt" bash "$ESPELHO/db/roda-nucleo-ci.sh"

# `sed -i` no dialeto BSD numa prova do manifesto: verde no laptop, vermelho no CI.
# Foi o defeito REAL que a 1ª execução deste job no Ubuntu encontrou (o GNU lê o
# argumento vazio como SCRIPT e a expressão como NOME DE ARQUIVO).
{ printf '#!/usr/bin/env bash\n'
  printf 'sed -i %s "s/a/b/" /tmp/x\n' "''"
  printf 'echo "RESULTADO: 30 ok / 0 fail"\n'
} > "$ESPELHO/db/test-fin-sync-lease.sh"
exec_exige "sed -i BSD-only numa prova do manifesto REPROVA" "BSD-only" \
  env MANIFESTO="$ESPELHO/manifesto-oco.txt" bash "$ESPELHO/db/roda-nucleo-ci.sh"

# Os casos acima reescrevem a MESMA prova do espelho, então este precisa devolvê-la a um
# estado que passe pelas checagens anteriores — senão ele reprovaria pelo guard do caso
# anterior e o veredito seria sobre outra coisa. Estado compartilhado entre casos de um
# harness é a forma mais barata de fabricar "vermelho pelo motivo errado".
{ printf '#!/usr/bin/env bash\n'
  printf 'echo "RESULTADO: 30 ok / 0 fail"\n'
} > "$ESPELHO/db/test-fin-sync-lease.sh"

# Postgres ausente: o caso em que degradar aprovaria TUDO.
printf 'db/test-fin-sync-lease.sh 22\n' > "$ESPELHO/manifesto-pg.txt"
# `PGVER=99` não existe em caminho canônico nenhum, e nenhum `initdb` do PATH tem
# major 99 — então o helper percorre a busca inteira e precisa terminar em ERRO. Testa
# o fail-closed do helper REAL, sem sabotá-lo, e sem depender do que está instalado.
exec_exige "PostgreSQL ausente é ERRO, nunca skip" "PostgreSQL 99 não encontrado" \
  env MANIFESTO="$ESPELHO/manifesto-pg.txt" PGVER=99 \
  bash "$ESPELHO/db/roda-nucleo-ci.sh"

# ── O 3º CAMPO: a falsificação das provas no caminho obrigatório (2026-09-10) ──────────────
# Caminho novo do runner, e com a mesma exigência dos de cima: reprovar PELO MOTIVO CERTO. Mas
# recusa não basta — um runner que reprovasse TODA falsificação passaria em todos os casos de
# recusa abaixo. Por isso o 1º caso é o CONTROLE POSITIVO: falsificação honesta, runner VERDE.
echo
echo "=== o EXECUTOR roda --falsificar e confere o RECIBO? ==="

exec_verde() { # <descrição> <marca-que-o-verde-tem-de-conter> <cmd...>
  local desc="$1" marca="$2"; shift 2
  local log="$LOGS/exec-verde.$RANDOM.log" rc
  "$@" > "$log" 2>&1 && rc=0 || rc=$?
  if [ "$rc" -ne 0 ]; then bad "$desc — runner REPROVOU (exit $rc)"; tail -4 "$log" | sed 's/^/       /'
  elif ! grep -qF -e "$marca" "$log"; then bad "$desc — verde SEM a marca '$marca'"; tail -3 "$log" | sed 's/^/       /'
  else ok "$desc — verde com a marca certa"; fi
}

# fake_falsificavel <arquivo-no-espelho> <corpo do modo --falsificar> — prova falsa com modo:
# o modo normal é sempre `RESULTADO: 5 ok / 0 fail`; o que muda de caso a caso é o --falsificar.
fake_falsificavel() {
  { printf '#!/usr/bin/env bash\n'
    # shellcheck disable=SC2016  # o `${1:-}` é TEXTO da prova falsa: expande lá, não aqui
    printf 'if [ "${1:-}" = "--falsificar" ]; then\n%s\nfi\n' "$2"
    printf 'echo "RESULTADO: 5 ok / 0 fail"\n'
  } > "$ESPELHO/db/$1"
}
MF="$ESPELHO/manifesto-falsif.txt"
FALSO="db/test-fake-falsificavel.sh"

fake_falsificavel test-fake-falsificavel.sh '  echo "SABOTAGENS: 3 vermelhas / 0 falhas"; exit 0'
printf '%s 5 falsificar=3\n' "$FALSO" > "$MF"
exec_verde "CONTROLE: falsificação honesta passa, com a identidade (arquivo, modo) no recibo" \
  "falsificacoes=1/1 fora_do_ci=0" env MANIFESTO="$MF" bash "$ESPELHO/db/roda-nucleo-ci.sh"

printf '%s 5 falsificar=fora-do-ci  # motivo-de-teste-XYZ\n' "$FALSO" > "$MF"
exec_verde "exceção fora-do-ci é IMPRESSA com o motivo, nunca calada" \
  "FORA DO CI — ausência de dado, não aprovação: motivo-de-teste-XYZ" \
  env MANIFESTO="$MF" bash "$ESPELHO/db/roda-nucleo-ci.sh"

printf '%s 5 falsifcar=3\n' "$FALSO" > "$MF"
exec_exige "3º campo com erro de digitação ABORTA (não desliga a falsificação)" "3º campo inválido" \
  env MANIFESTO="$MF" bash "$ESPELHO/db/roda-nucleo-ci.sh"

printf '%s 5\n' "$FALSO" > "$MF"
exec_exige "prova com modo --falsificar SEM declaração ABORTA" "tem modo --falsificar e a linha não diz" \
  env MANIFESTO="$MF" bash "$ESPELHO/db/roda-nucleo-ci.sh"

printf '%s 5 falsificar=fora-do-ci\n' "$FALSO" > "$MF"
exec_exige "exceção fora-do-ci SEM motivo ABORTA" "sem o MOTIVO em comentário" \
  env MANIFESTO="$MF" bash "$ESPELHO/db/roda-nucleo-ci.sh"

printf 'db/test-fin-sync-lease.sh 22 falsificar=3\n' > "$MF"
exec_exige "declarar falsificar numa prova SEM modo ABORTA" "não tem modo --falsificar" \
  env MANIFESTO="$MF" bash "$ESPELHO/db/roda-nucleo-ci.sh"

# A flag IGNORADA: a prova menciona `--falsificar` (passa o detector) mas não tem o modo, e sai 0
# no modo normal. É o buraco que o recibo exclusivo existe para fechar.
{ printf '#!/usr/bin/env bash\n# diz aceitar --falsificar, mas ignora a flag\n'
  printf 'echo "RESULTADO: 5 ok / 0 fail"\n'; } > "$ESPELHO/$FALSO"
printf '%s 5 falsificar=3\n' "$FALSO" > "$MF"
exec_exige "flag IGNORADA (roda o modo normal e sai 0) REPROVA" "sem UM recibo" \
  env MANIFESTO="$MF" bash "$ESPELHO/db/roda-nucleo-ci.sh"

fake_falsificavel test-fake-falsificavel.sh '  echo "SABOTAGENS: 3 vermelhas / 0 falhas"; echo "SABOTAGENS: 9 vermelhas / 0 falhas"; exit 0'
exec_exige "DOIS recibos (o tail -1 leria só o último) REPROVA" "recibos=2" \
  env MANIFESTO="$MF" bash "$ESPELHO/db/roda-nucleo-ci.sh"

fake_falsificavel test-fake-falsificavel.sh '  echo "SABOTAGENS: 3 vermelhas/0 falhas"; exit 0'
exec_exige "recibo MALFORMADO (o emissor mudou sem o runner saber) REPROVA" "válidos=0" \
  env MANIFESTO="$MF" bash "$ESPELHO/db/roda-nucleo-ci.sh"

# Um VÁLIDO e um MALFORMADO: só a contagem de LINHAS vê. Os dois casos acima reprovam também pela
# contagem de válidos, então a guarda `n_linhas != 1` podia sumir do runner sem nada ficar vermelho
# (parecer Codex 2026-09-14 — a camada do runner que não tinha caso).
fake_falsificavel test-fake-falsificavel.sh '  echo "SABOTAGENS: 0 vermelhas/3 falhas"; echo "SABOTAGENS: 3 vermelhas / 0 falhas"; exit 0'
exec_exige "um recibo VÁLIDO e outro MALFORMADO REPROVA (conta as linhas, não só as válidas)" "recibos=2 (válidos=1)" \
  env MANIFESTO="$MF" bash "$ESPELHO/db/roda-nucleo-ci.sh"

fake_falsificavel test-fake-falsificavel.sh '  echo "SABOTAGENS: 2 vermelhas / 0 falhas"; exit 0'
exec_exige "falsificação ENCOLHIDA (2 < 3) REPROVA" "a falsificação encolheu" \
  env MANIFESTO="$MF" bash "$ESPELHO/db/roda-nucleo-ci.sh"

fake_falsificavel test-fake-falsificavel.sh '  echo "SABOTAGENS: 5 vermelhas / 1 falhas"; exit 0'
exec_exige "sabotagem sem o vermelho certo com exit 0 REPROVA" "recibo e exit se contradizem" \
  env MANIFESTO="$MF" bash "$ESPELHO/db/roda-nucleo-ci.sh"

fake_falsificavel test-fake-falsificavel.sh '  echo "SABOTAGENS: 3 vermelhas / 0 falhas"; exit 1'
exec_exige "--falsificar que sai !=0 REPROVA mesmo com recibo válido" "--falsificar: exit 1" \
  env MANIFESTO="$MF" bash "$ESPELHO/db/roda-nucleo-ci.sh"

# IDENTIDADE, não contagem: o runner sabotado PULA a falsificação da 2ª prova. A contagem de
# provas continua batendo (2/2) — só o recibo por (arquivo, modo) vê o buraco. A sabotagem é
# conferida por conteúdo antes de valer (regra 3 do cabeçalho).
fake_falsificavel test-fake-falsificavel.sh '  echo "SABOTAGENS: 3 vermelhas / 0 falhas"; exit 0'
cp "$ESPELHO/$FALSO" "$ESPELHO/db/test-fake-falsificavel-2.sh"
printf '%s 5 falsificar=3\ndb/test-fake-falsificavel-2.sh 5 falsificar=3\n' "$FALSO" > "$MF"
if python3 - "$ESPELHO/db/roda-nucleo-ci.sh" "$ESPELHO/db/roda-nucleo-ci-pula.sh" > "$LOGS/sabotagem.log" 2>&1 <<'PY'
import sys, pathlib
t = pathlib.Path(sys.argv[1]).read_text()
a = '*)    executa "${scripts[$i]}" falsificar "${falsifs[$i]}" ;;'
assert t.count(a) == 1, f"esperava 1 chamada da falsificacao no laco, achei {t.count(a)}"
pathlib.Path(sys.argv[2]).write_text(t.replace(a, '*)    [ "$i" -eq 1 ] || executa "${scripts[$i]}" falsificar "${falsifs[$i]}" ;;', 1))
PY
then
  exec_exige "falsificação OMITIDA entre duas declaradas REPROVA pelo recibo de identidade" \
    "sem recibo de conclusão: db/test-fake-falsificavel-2.sh falsificar" \
    env MANIFESTO="$MF" bash "$ESPELHO/db/roda-nucleo-ci-pula.sh"
else
  bad "runner que pula a falsificação — SABOTAGEM NÃO APLICOU (falsificação inválida): $(tail -1 "$LOGS/sabotagem.log")"
fi
rm -f "$ESPELHO/$FALSO" "$ESPELHO/db/test-fake-falsificavel-2.sh" "$ESPELHO/db/roda-nucleo-ci-pula.sh"

# ── CONTROLE FINAL ──────────────────────────────────────────────────────────────
echo
echo "=== controle final — o verde voltou? ==="
for p in test-claim-disparo-cenario-b test-disparado-simulado-pos-disparo test-security-invoker-views; do
  rc="$(roda_prova "$p" final)"
  if [ "$rc" -eq 0 ]; then ok "verde de volta: $p"
  else bad "NÃO voltou ao verde: $p (exit $rc)"; fi
done

echo
echo "=================================================="
for f in ${FALHAS[@]+"${FALHAS[@]}"}; do echo "  ❌ $f"; done
echo "FALSIFICACAO: OK=$OK XX=$XX"
# Piso de casos, para quem roda à mão: `[ "$XX" -eq 0 ]` sozinho aprovaria caso REMOVIDO — OK
# baixo, XX=0, sai 0. Tirar caso reprova até alguém baixar o número aqui, e a perda fica no diff.
# Mas este piso mora no arquivo que ele vigia: um harness TRUNCADO perde o piso junto e sai 0
# (parecer Codex 2026-09-14). No CI quem decide é o step do `provas-sql`, que confere o recibo
# acima com o piso FORA daqui — `HARNESS_OK_MINIMO` no ci.yml; mude os dois juntos.
OK_MINIMO=39
if [ "$OK" -lt "$OK_MINIMO" ]; then
  echo "❌ só $OK caso(s) ok, o piso é $OK_MINIMO — o harness encolheu (ou parou no meio)"; exit 1
fi
[ "$XX" -eq 0 ]
