# Medir "trabalho não entregue" — as três armadilhas (e o `wt:orfas`)

> **A lição não é sobre worktrees.** É sobre MEDIÇÃO: um teste que mede a coisa errada não
> devolve "não sei", devolve um **número plausível e falso**. Pendência fantasma custa mais caro
> que pendência desconhecida — a desconhecida você ainda vai procurar; a fantasma você
> "resolve", e o relatório fica verde por cima de trabalho que continua fora da main.
> Aplicável a qualquer auditoria de entrega, não só a esta.
>
> O corolário operacional está na §4: as quatro armadilhas **erram por linha, não por relatório**.
> Nenhuma derruba a saída inteira — cada uma corrompe o subconjunto que satisfaz uma condição
> (foi squash-mergeada / citou PR alheio / não citou PR nenhum), e o resto sai certo. **Conferir
> uma amostra não detecta nenhuma delas.** O que detecta é atacar a medida: sabotá-la e exigir
> vermelho.

## O problema (2026-08-06)

A pasta de transcript de uma sessão Claude (`~/.claude/projects/-Users-…--claude-worktrees-<nome>`)
**sobrevive ao `git worktree remove`**. Apuramos 104 sessões nesse estado — worktree apagado,
transcript vivo. Delas:

- **89 estavam 100% entregues** (o PR mergeou, a branch morreu limpa);
- **15 tinham commit que nunca chegou na main** — incluindo fix de **money-path**.

O founder não tinha como saber disso sem abrir sessão por sessão, e o acúmulo é contínuo: toda
worktree que morre deixa mais um transcript para trás. Daí o `scripts/wt-orfas.sh` — irmão do
`wt-status`/`wt-clean`/`wt-reap`/`wt-prune`, que cataloga o que ficou para trás em vez de RAM/disco.

## As três armadilhas

Cada uma foi medida na apuração e cada uma **inflou** o resultado. As três compartilham a mesma
raiz: **o auto-merge deste repo faz SQUASH**, e squash reescreve o commit — todo teste que assume
identidade de commit entre a branch e a main responde errado.

### 1. `merge-base --is-ancestor` nunca é verdade após squash — 66 falsos pendentes

```bash
git merge-base --is-ancestor <branch> origin/main   # ← NUNCA verdade numa branch squash-mergeada
```

O squash cria **um commit novo** na main; os commits originais da branch não são ancestrais dele.
Logo o teste responde "não entregue" para *toda* branch mergeada do repo. Foi o maior inflador:
**66 falsos pendentes** de 104 sessões.

**O teste correto** é a identidade que o próprio GitHub registrou no momento do merge:

```bash
# headRefOid do PR MERGED == tip da branch  →  entregue
gh pr list --json number,state,headRefName,headRefOid
```

É prova positiva e não depende de o histórico ter sido preservado.
(Parente da regra já registrada em [`docs/agent/worktrees.md`](../agent/worktrees.md): *não
recommitar em branch já squash-mergeada*. Lá o squash morde quem **escreve**; aqui, quem **mede**.)

### 2. `pr-link` grava PR **citado**, não PR produzido — 9 falsos "PR aberto"

No transcript, `{"type":"pr-link","prNumber":N}` é emitido para **todo PR mencionado na conversa** —
inclusive os que a sessão só leu (`gh pr list` numa checagem de coordenação multi-sessão). Uma
sessão listava **17 PRs que não produziu**. Cruzar isso com "estado do PR" produziu **9 falsos
"PR aberto"**: PRs de terceiros, abertos e legítimos, atribuídos a uma sessão morta.

**O teste correto:** quem decide a posse é `headRefName == gitBranch da sessão`. O `prNumber` do
transcript é informação de contexto, nunca autoridade.

### 3. `git cherry` não sobrevive ao squash de N commits — 18 commits fantasma

`git cherry` compara **patch-id**. Um squash de 3 commits vira 1 commit cujo patch combinado não
bate com nenhum dos 3 individuais → os 3 aparecem como `+` (não entregues). Numa branch que tinha
**1 commit real** o método acusou **18 perdidos**.

**O teste correto** ancora no oid do merge e conta o que veio **depois** dele:

```bash
git rev-list --count <headRefOid>..<branch> --not origin/main
```

### 4. (nova, achada ao reimplementar) `IFS=$'\t' read` **colapsa** tabs — 117 linhas com a branch trocada

Tab é **IFS-whitespace**. Bash trata sequências de IFS-whitespace como **um** delimitador e ignora
as de borda — então, num `titulo⇥prs⇥branch⇥peso` em que `prs` está vazio, os dois tabs viram um,
`prs` recebe a branch, `branch` recebe o peso, e o `read` **não erra**: devolve dados plausíveis
deslocados. No relatório saía `branch:161` (o peso) → classificado `SEM RASTRO`.

O que torna isto perigoso é a **seletividade**: só quebra na linha que *tem* campo vazio. Aqui,
exatamente as sessões que não citaram PR nenhum — **117 de 449 linhas**. As outras 332 saíam
certas, então o relatório inteiro parecia coerente. Uma amostra de 5 linhas tinha ~74% de chance de
não conter nenhuma quebrada.

**A correção é o separador, não o `read`:** campo interno em `US` (`$'\037'`), que não é
IFS-whitespace, e o campo vazio se preserva. (`cut -d`, `sort -t` e `awk -F` já tratavam o tab
corretamente — só o `read` do shell colapsa. Por isso o bug sobreviveu ao `sort`/`awk` do
pipeline e só apareceu na leitura final.) Cobre o caso
`scripts/test-wt-orfas.sh` → *"campo VAZIO no meio nao pode deslocar os seguintes"*.

Prova executável das três primeiras, com squash de verdade num repo descartável:
[`scripts/test-wt-orfas.sh`](../../scripts/test-wt-orfas.sh) — os casos afirmam **os dois lados**:
que a medida ingênua erra (`--is-ancestor` dá falso; `cherry` conta 3 e depois 4) e que a correta
acerta (rev-list dá 0, e 1 quando há mesmo 1 commit pós-merge). Falsificada por sabotagem das três
funções, em `LC_ALL=C` **e** `pt_BR.UTF-8` (a lição do #1483).

## Duas descobertas de implementação

- **Nome de pasta começando com `-` é lido como OPÇÃO.** As pastas são
  `-Users-lucassardenberg-…` e `grep`/`ls` respondem `unrecognized option`. Caminho absoluto ou
  `--` antes dos operandos; o script usa os dois. Falha ruidosa no `ls`, mas no `grep` dentro de
  `$(…)` ela vira **saída vazia** — que o loop lê como "nenhuma branch", não como erro. Custou uma
  medição inteira dando `130 pastas sem branch`.
- **`HEAD` passava como "entregue" por acidente.** Em *detached HEAD* o transcript grava
  `"gitBranch":"HEAD"`. Não existe `refs/heads/HEAD`, mas **existe** `refs/remotes/origin/HEAD` →
  resolve para `origin/main`, e `rev-list --count origin/main --not origin/main` dá 0. O veredito
  certo pela razão errada é o pior caso: some da lista sem nunca ter sido medido. Filtrado como
  nome sentinela (`branch_util`), não como caso especial da classificação.
- **Uma sessão toca VÁRIAS branches.** 144 dos 326 transcritos têm mais de um `gitBranch` (um
  chegou a 26), porque o mesmo diretório de worktree é reusado e a sessão entra/sai de outros.
  "Primeiro `gitBranch` não-nulo" atribui a branch errada e **esconde trabalho**. O script mede
  **todas** as branches da sessão, descarta as que ainda estão checadas em worktree viva (trabalho
  vivo não é órfão) e reporta cada branch pendente na sessão mais recente que a tocou.

## A ferramenta

```bash
bun run wt:orfas              # só o que tem trabalho NÃO entregue
bun run wt:orfas --todas      # inclui as já entregues
bun run wt:orfas --sem-fetch  # pula o git fetch
```

Estados: `PR ABERTO` · `PR SEM MERGE` · `COMMITS SOLTOS` · `SEM RASTRO` · `entregue`.

`SEM RASTRO` (branch citada que não existe local nem em `origin`, e sem nenhum PR) sai **separado**
de propósito: é ausência de dado, não prova de entrega. Contá-lo como entregue seria o mesmo erro
das três armadilhas, só que na direção que esconde — e a regra do repo é que
**ausência de sinal não é aprovação**.

Custo: **uma** chamada `gh pr list --state all --limit 3000` cruzada localmente. `gh pr view` por PR
seriam 1600+ chamadas. Os transcritos têm MBs, então os metadados saem de `command grep` **antes**
do `jq` (`grep` neste ambiente é shim do `ugrep` → sempre `command grep`), com cache por
`mtime+tamanho` em `~/.cache/afiacao/wt-orfas` — transcript de sessão morta nunca mais muda.
