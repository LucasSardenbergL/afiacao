# shellcheck shell=bash
# scripts/lib/tentar.sh — retry FAIL-CLOSED para as chamadas de rede dos steps do ci.yml.
# Carregado com `. scripts/lib/tentar.sh` (o `run:` do Actions roda em $GITHUB_WORKSPACE, depois do
# checkout). Steps não compartilham funções de shell, então o helper mora aqui, UMA vez — e não
# copiado em cada step que baixa algo (cópia é laço novo, com a sua própria chance de desistir verde).
#
# Quem usa: o step "PostgreSQL 17 (PGDG)" do `provas-sql` (curl da chave + 2 apt-get) e os dois
# steps "shellcheck pinado 0.11.0" (`gates-e-falsificacao` e `falsificacao`). Quem PROVA:
# scripts/lab-retry-pgdg/ no `test:hooks` — o lab embute ESTE arquivo no texto do step PGDG
# extraído do ci.yml e o falsificador sabota ESTE arquivo (S1, S2, S5).
#
# FAIL-CLOSED, e é por isso que não é `|| true` nem `for ... && break`: esgotadas as tentativas,
# `tentar` devolve o exit da ÚLTIMA (56, não 1) e é chamada NUA — sob `set -e` isso MATA o step,
# com o erro real já no log (o `-sS` do curl e o stderr do apt-get não são silenciados). Laço de
# retry é o lugar clássico do verde por DESISTÊNCIA: `for i in 1 2 3; do cmd && break; done`
# termina normalmente quando as três falham e o script SEGUE com 0 — o caminho não-reconhecido
# caindo no lado otimista, que é o `ausente ≠ zero` no tempo
# (docs/historico/espera-sem-desistencia.md). Aqui o caminho não-reconhecido é o que REPROVA.
#
# Um helper para todas as camadas, e não `curl --retry`: o `--retry` não cobre os `apt-get`, e
# seu conjunto de erros "transitórios" só inclui o exit 56 com `--retry-all-errors`. Mecanismo
# único = uma falsificação que vale para todos os pontos de uso, em vez de várias meias-provas.
# O teto e a espera são LITERAIS, sem `${VAR:-3}`: botão de ambiente em gate é o caminho para um
# `env:` de workflow mudar a verdade do step sem aparecer no diff dele. O lab acelera dublando
# `sleep` no PATH, que é problema do lab e não costura no código de produção.
#
# Não use com pipe (`tentar curl … | tar`): o pipe fica FORA do `tentar`, que só repete o curl, e
# sob `pipefail` o exit que sobra é o do último comando que falhou — no run 42659232737 o curl
# morreu com (22) HTTP 500 e o step saiu com o 2 do `tar`. Baixe para arquivo e extraia depois.
TENTATIVAS=3
tentar() {
  local rotulo="$1"; shift
  local n=1 rc=0 espera=5
  while :; do
    rc=0
    # `|| rc=$?` põe o comando em contexto de condição: o `set -e` fica suspenso AQUI de
    # propósito (é o único ponto onde a falha é dado, não veredito) e `rc` guarda o exit
    # REAL. Em qualquer outro lugar do step o `set -e` segue valendo.
    "$@" || rc=$?
    if [ "$rc" -eq 0 ]; then
      if [ "$n" -gt 1 ]; then
        echo "  ↻ $rotulo: OK na tentativa $n/$TENTATIVAS"
      fi
      return 0
    fi
    if [ "$n" -ge "$TENTATIVAS" ]; then
      echo "::error::$rotulo falhou nas $TENTATIVAS tentativas — exit da última: $rc"
      return "$rc"
    fi
    echo "  ↻ $rotulo: tentativa $n/$TENTATIVAS falhou (exit=$rc) — repetindo em ${espera}s"
    sleep "$espera"
    espera=$(( espera * 2 ))
    n=$(( n + 1 ))
  done
}
