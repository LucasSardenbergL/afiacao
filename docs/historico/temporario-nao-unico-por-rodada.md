# Temporário não-único por rodada: duas rodadas simultâneas da mesma prova leem o arquivo uma da outra

> 2026-09-30 · classe erradicada em 6 PRs:
> - LucasSardenbergL/afiacao#2676 (tint)
> - #2677 (data-health)
> - #2678 (pedido/corrida)
> - #2679 (carteira/preço)
> - #2680 (farmer e outros)
> - #2682 (fase 6, com este registro)
>
> Método: skill `matar-classe`.

**Resumo.** Prova PG17 em `db/*.sh` que grava arquivo temporário com nome **não único por rodada**
(caminho fixo em `/tmp`, `/tmp/x-${SLUG}`, ou `mktemp` com sufixo depois dos X) compartilha esse
arquivo com qualquer outra rodada simultânea da mesma prova: outra worktree, outra sessão, ou um
runner paralelo. A reprovação que sai disso **acusa o código** ("a migration mudou?", "C14.2 é
fraco"). A varredura achou **234 sites em 51 arquivos**; 49 foram consertados para o diretório
único da rodada, que o trap já apagava, e 2 ficaram fora por desenho (abaixo).

## O incidente, e a leitura errada que ele induz

Em 2026-09-27, `db/test-tint-promote.sh` reprovou em F1d-1 com `✗ F1d-1: âncora da tríade não
encontrada (a migration mudou?)`, numa rodada que sozinha passava. O texto manda procurar a
migration. A causa estava em `/tmp/sab-tint-1d-excecao.sql`: outra rodada da mesma prova truncou o
arquivo entre o `sed` que o escreve e o `grep` que o confere.

## A classe: quatro formas, e o que NÃO é dela

| forma | exemplo | por que colide |
|---|---|---|
| (a) literal em `/tmp` | `sed … "$M" > /tmp/sab-tint-1c.sql` | o mesmo nome em toda rodada |
| (b) `mktemp` com sufixo | `mktemp /tmp/snap-rr.XXXXXX.sql` | **no BSD (macOS) só os X FINAIS são trocados**: o nome sai literal e a 2ª chamada morre com `File exists`. No GNU do CI funciona, e é por isso que o CI nunca viu |
| (c) nome por PROVA | `SAB="/tmp/sab-${SLUG}.sql"` | o `SLUG` é o nome da prova: único entre provas, **não entre rodadas** |
| (d) na árvore do repo | `cat > supabase/migrations/2999…_sabotagem.sql` | duas rodadas na MESMA worktree |

**Assinaturas.** Rode as duas antes de fechar qualquer prova nova em `db/`:

```bash
# (a) e (c): caminho temporário FIXO em código (a linha de comentário não conta)
grep -nE '^[[:space:]]*[^#[:space:]][^#]*(/tmp|\$\{TMPDIR:-/tmp\}|\$TMPDIR)/[A-Za-z0-9_-]+' db/*.sh \
  | grep -vE 'mktemp|\$\$|\$\{?PORT|\.s\.PGSQL|-h /tmp|-k /tmp|pgtest-|pg_ctl'
# (b): mktemp com sufixo depois dos X (vale para ${TMPDIR:-/tmp}, que no macOS é por USUÁRIO)
grep -nE 'mktemp "?[^[:space:]")]*X{3,}\.[A-Za-z]+' db/*.sh | grep -vE '^[^:]+:[0-9]+:[[:space:]]*#'
```

Elas foram **falsificadas** antes de virar regra:

- **15 de 15 casos certos.** O controle (uma prova consertada) dá 0. As 8 reintroduções são pegas: literal escrito, literal lido, `${SLUG}`, `${TMPDIR:-/tmp}/fixo`, `$TMPDIR/fixo`, sufixo, sufixo em `${TMPDIR}`, X no meio. As 7 exceções ficam em silêncio: comentário das duas formas, log do servidor, `$$`, X no fim, socket e `$RODADA`.
- **Sobre a `main` pré-conserto** elas acham 50 arquivos: os 49 consertados, nenhum de fora, e mais um falso-positivo.
- **Sobre a árvore com as 6 fases aplicadas** sobra só esse falso-positivo, que é texto de fixture gravado no espelho, na linha 270 de `db/falsifica-nucleo-ci.sh`.

**Não é da classe** (conferido, não suposto):
- **`$$`** é o PID e é único por rodada.
- **Nome derivado de `${PORT}`** é único por cluster.
- **Socket** `-k /tmp`/`-h /tmp`.
- **`mktemp` com os X no fim** já é único e não foi mexido. Aprofundar um `mktemp -d` de socket dentro da rodada pode estourar os **103 bytes** do caminho de Unix-domain socket (`test-tint-promocao-assincrona.sh` documenta o limite).
- **O log do servidor** `pg_ctl -l /tmp/pg-<nome>.log`, presente em quase todas as provas:
  - é só-escrita em append, e nenhuma prova o lê (conferido), então não muda veredito;
  - **sobreviver ao trap é o que dá diagnóstico quando o Postgres não sobe**, e movê-lo para a rodada apagaria justamente esse log.

## Reprodução, antes do conserto (macOS, PG 17.10, portas distintas via `PGPORT_TEST`)

- **(b), determinística:** `test-tint-promote-nome-cor.sh` ×2 com disparo simultâneo deu **2 de 2** tentativas com uma rodada morta em `mktemp: mkstemp failed on /tmp/snap-rr.XXXXXX.sql: File exists`.
  - O mesmo literal está em **4 provas diferentes**, então colide entre provas, não só entre rodadas.
  - Disparar a 2ª rodada *depois* de a 1ª criar o arquivo deu verde, porque a 1ª já tinha apagado. A janela é a da chegada simultânea ao `mktemp`.
- **(a), probabilística:** `test-tint-promote.sh` ×2 simultâneas deu **1 de 3** tentativas com `✗ FALSIF FALHOU: sabotei o guard4 e a receita NÃO corrompeu (ainda 2 itens) → C14.2 é fraco`. Uma falsificação reprovada acusando a força de um guard que está íntegro.

## Por que a contramedida textual não segurou

A forma (b) já estava escrita em **quatro** lugares antes desta erradicação:
- `docs/agent/money-path.md`: "teste que só passa uma vez não é regressão".
- `cancelamento-pos-disparo-porta-com-evidencia.md`, de julho. Ele ainda apontava `test-cancelar-pedido-guard-atomico.sh` como "mesmo bug latente", e a prova seguia com os três sites.
- `paginacao-offset-janela.md`.
- `falsificacao-exit-nao-e-dente.md`.

Mesmo assim restavam **63 sites** da forma (b). É a meta-regra do catálogo de retrabalho, medida de
novo: contramedida textual reincide.

## O conserto: o padrão

```bash
DATA="$(mktemp -d "/tmp/pgtest-${SLUG}.XXXXXX")/data"
RODADA="$(dirname "$DATA")"   # dir ÚNICO desta rodada (o trap apaga): temporário mora aqui, nunca em /tmp/<nome-fixo>
…
sed … "$MIG" > "$RODADA/sab-x.sql"          # (a)/(c)
SAB="$(mktemp "$RODADA/sab-x.XXXXXX")"       # (b): X no FIM
```

**Armadilhas que o conserto mecânico teria errado.** Cada uma foi pega no diff:
- **Mensagem que manda ler um log** (`(ver /tmp/snap-apply.log)`): com o log na rodada, o trap o apaga antes de alguém ler. A prova passa a imprimir o fim do log antes de sair. O `/tmp/mig-apply.log` era `>>` e acumulava todas as rodadas de todas as sessões.
- **Heredoc citado** (`python3 - <<'EOF'` com `open("/tmp/x.sql")`) não expande variável. O caminho entra por `sys.argv[1]`.
- **`rm -f` por GLOB no `cleanup`** (`/tmp/fn-${SLUG}-*.sql`, `/tmp/pg-${SLUG}-sab-*`): o glob casa os arquivos de QUALQUER rodada, e a que termina primeiro apaga os da vizinha se ela ainda os usa.
  - Isso vem da **leitura do código, não de reprodução**: 4 pares escalonados (a 2ª rodada 0, 1, 2 e 3 s depois) passaram, porque a janela é de milissegundos.
  - Depois do conserto o glob continuaria apagando os arquivos de rodadas PRÉ-conserto em outras worktrees, então ele sai.
  - No `deploy-sonda-cron`, os `sab-*` tinham X no fim, mas só o glob os limpava. Por isso eles também foram para a rodada.
- **Corrida em subshell** (`corrida()` chamada em `$( )`): o caminho tem de nascer FORA da função. Continua nascendo fora, só que na rodada, e o comentário "CAMINHO FIXO" foi reescrito.
- **Escrita morta.** `/tmp/farmer-r1.json` nunca era lido em lugar nenhum, então a linha sai e `RODADA` não entra naquele arquivo; o shellcheck (SC2034) acusaria a variável sem uso.
- **Ferramenta fora de `db/`.** O `scripts/wt-prune.sh` mandava o stderr do `git worktree remove` para `/tmp/wt-prune-err`, e agora o guarda numa variável. O teste do script só cobre o `remove` bem-sucedido, então o ramo `FALHOU` foi exercitado à parte, com um stub que falha: saída idêntica à do original.

## Prova, depois do conserto

- **Por fase:** cada prova rodou ×2 simultâneas em portas distintas, as duas verdes, e as assinaturas dão 0 no arquivo.
- **No CI (ubuntu, o outro contrato do `mktemp`):** as 9 provas tint do núcleo passaram com o conserto no job `provas-sql` do #2676. Foi conferido no log do job, não só no `validate` verde.
- **Exceções honestas:**
  - `test-data-health-carteira-rebuild.sh` **já reprova na `main`** (`esperado [30], veio [25]`, uma contagem de checks). O resultado é idêntico antes e depois do conserto, nas duas rodadas. A prova não está no núcleo, e por isso ninguém viu.
  - `test-reparo-passivo-coerencia.sh` exige `FIXTURE=` com dados reais de produção e, sem ela, nem roda. Um teste diferencial com fixture vazia deu original × consertada idênticas, e duas rodadas simultâneas iguais à solo.

## Gate: não construído, e o porquê

A skill `matar-classe` manda gatear, e a tarefa pediu para **avaliar** um gate textual com o
`removerComentariosShell` compartilhado. A regra viva de [maquinas-meta.md](../agent/maquinas-meta.md)
(2026-09-29) decide contra, e a decisão aqui é aplicá-la. Ela exige dano NOMEADO fora do repo ou
verde-falso PROVADO num PR de produto, e diz que CI vermelho, lento ou flaky não é incidente.
Nesta classe:

- O dano medido é **vermelho falso LOCAL** (as duas reproduções acima): custa tempo de sessão e diagnóstico errado, não dano fora do repo.
- O **CI é imune por construção**: o `roda-nucleo-ci.sh` roda as provas em sequência num runner limpo, e o `mktemp` do GNU aceita sufixo.
- O verde-falso é possível em cenário cruzado: a worktree A lê a sabotagem que a B gerou da SUA migration, numa prova fora do núcleo, e aprova uma falsificação que nunca exercitou a migration de A. O mecanismo é plausível, mas **não foi provado** em PR nenhum.

⇒ `Máquina meta: nenhuma`. No lugar do gate ficam as duas assinaturas acima, falsificadas, e 1 linha
em [worktrees.md](../agent/worktrees.md). O custo foi aceito conscientemente: a classe pode voltar
numa prova nova, e a assinatura a acha em segundos.

**Gatilho para reabrir:** um verde-falso desta classe **provado** num PR de produto. Aí o fiscal
nasce no molde do `scripts/relogio-bash-em-provas-gate.ts`: stripper compartilhado, piso de
denominador, sentinelas de sobre e sub-limpeza, e mutações em `scripts/mutcheck.d/`.

## Fora do escopo, registrado

- **(d) `test-authz-{funcoes,reescrita}-falsificacao.sh`** gravam a sabotagem dentro de `supabase/migrations/` por desenho, porque o auditor lê o acervo inteiro.
  - Nome único não resolve, já que o auditor lê o diretório inteiro.
  - O conserto seria um espelho, como o de `falsifica-nucleo-ci.sh`.
  - Duas worktrees não colidem.
- **Classe irmã: a PORTA fixa.** **58 provas** sobem o Postgres numa porta fixa sem honrar `PGPORT_TEST`. Exemplo: `PORT=5435` no `test-rpc-account-aware.sh`, a mesma 5435 que é o default do `test-tint-promote.sh`. Duas rodadas simultâneas disputam a porta, e a 2ª nem sobe.
  - Ela difere desta classe no que importa: a falha é RUIDOSA e se explica sozinha (`pg_ctl: could not start server`, e `Address already in use` no log do servidor). Não se disfarça de defeito.
  - As 58 estão todas fora do núcleo; o runner do CI entrega porta distinta a cada prova.
  - Só a `rpc-account-aware` foi consertada (default preservado), porque a prova de duas rodadas da fase 6 dependia dela. As outras 57 ficam registradas.
  - Assinatura: `for f in db/test-*.sh; do grep -qE 'pg_ctl[^|]*start' "$f" && ! grep -q PGPORT_TEST "$f" && echo "$f"; done`.
- **`test-recommend-cluster-agregado.sh`** (linhas 228 e 271): `mktemp -t neg-cluster` sem X, que o GNU recusa (`too few X's`). É outra classe (BSD×GNU), e a prova está fora do núcleo.
- **De passagem: dois hooks olham o checkout PRINCIPAL, não a worktree do app.** Em sessão de worktree do app, o `pr-collision-guard.sh` e o `branch-pos-squash-guard.sh` rodam `git branch --show-current` no diretório do hook.
  - Aqui eles avisaram sobre a branch `claude/preferencia-delegar-fable` e sobre o `CLAUDE.md`, que nenhum dos 6 PRs toca.
  - Nesse cenário o alarme é falso, **e** a checagem da worktree real não acontece.
