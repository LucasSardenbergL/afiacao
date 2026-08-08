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

## O limite que fica: commit fora da main ≠ TRABALHO fora da main

As quatro armadilhas acima consertam a contagem de **commits**. Elas não fecham a distância entre
essa contagem e a pergunta do founder, que é sobre **conteúdo**. Num repo que faz squash — e onde
o mesmo arquivo é reescrito por várias sessões — o conteúdo de um commit pode chegar à main por
**outro PR**, sem que o commit vire ancestral de nada. O `rev-list` continua contando 1; o trabalho
já está entregue.

Medido na primeira triagem real das 40 pendências apuradas (2026-08-07):

- `claude/caixa-vazio-fail-closed` — reportado `COMMITS SOLTOS [1 commit]`, e o commit é
  `fix(financeiro): lista VAZIA de conta corrente deixa de virar caixa zero [money-path]`.
  Verificado arquivo por arquivo: **4 dos 5 idênticos à main**, e o quinto difere porque a **main
  está à frente** (trocou o `serve` do `deno.land/std` pelo `Deno.serve` nativo — a branch é que
  ficou velha). Entregue.
- `claude/fase5-desfecho-doc` — reportado `PR SEM MERGE [4 commits]`. A **migration** da Fase 5 e
  os testes já estão na main; os 4 arquivos que "diferem" são dois docs que a main evoluiu depois e
  um **artefato gerado** (`audit-custom-migrations.sql`), que se regenera e não se resolve. A lição
  `falsificação mente quando o assert tem DUAS defesas independentes` também já está em
  `money-path.md`. Entregue.

**Nenhum teste automático barato decide isso.** Foram tentados dois, e ambos erram nas duas
direções: comparar blob a blob marca "revisar" sempre que a main evoluiu o arquivo (39 de 40
falsos); `git apply --cached --check -R` do patch da branch acerta o primeiro caso mas falha no
segundo, porque o patch não aplica quando o **contexto** vizinho mudou (5 de 40 confirmados
entregues, e pelo menos um dos 35 "perdidos" é entregue, provado à mão).

Então a régua honesta é essa: **`wt:orfas` é um filtro de TRIAGEM, não um veredito.** Ele reduz 269
transcritos / 485 branches às ~40 que merecem olho — ganho real — e o veredito de cada uma exige o
diff contra a main, ancorado no `merge-base`:

```bash
mb=$(git merge-base origin/main <branch>) && git diff "$mb" <branch>   # o que a branch REALMENTE fez
```

O erro a não cometer é o mesmo das quatro: tratar o proxy como se fosse a medida. Dizer
"15 pendências, 2 money-path" quando o certo é "15 **candidatas**, verifique o conteúdo" recria
pendência fantasma — desta vez com o número já corrigido.

## A triagem completa (2026-08-08): 38 candidatas → **1** pendência real

A §limite previu que "candidata ≠ pendência". Triadas as **38** que o script listou, uma a uma,
pelo conteúdo:

| classe | n |
|---|---|
| **entregue** — o conteúdo chegou à main, o commit não | **30** |
| viva em **PR draft** (#1543 #1622 #1456 #1326 #1139) — represada de propósito, não é órfã | 5 |
| anexo (spec/plano) de frente que segue represada em draft | 2 |
| **trabalho perdido, recuperado** → `churn-coacao-fixture`, PR #1708 | **1** |

(as 11 `SEM RASTRO` seguem fora da conta, pela regra de que ausência de sinal não é aprovação)

**Taxa de falso-pendente do proxy: ~97%.** Não é ruído aleatório — são cinco formas de "entregue"
que a contagem de commits não vê, cada uma exigindo uma pergunta diferente:

1. **Outro PR entregou o mesmo.** `cranky-keller-1c66a6` (#1526) é o retrabalho que o CLAUDE.md
   já narra: o #1525 mergeou 6 min antes, **nos mesmos arquivos**.
2. **O conteúdo mudou de casa.** `peaceful-rhodes-c940af` propunha o helper
   `src/lib/carteira/vendedor-oben.ts`; a main tem a lógica **dentro** do edge `carteira-rebuild`
   (63 ocorrências) e o teste da branch. Idem `src/lib/margem/` → `src/lib/custos/auditoria-margem.ts`.
   Arquivo ausente ≠ trabalho ausente.
3. **A migration foi renomeada.** `blissful-chandrasekhar-ae87d9` referencia `20260718170000_fu7b_…`;
   na main é `20260718**18**0000_fu7b_…` — colisão de timestamp, o aviso que o CLAUDE.md já dá. Um
   `ls` do nome exato responde "não existe" com o arquivo lá.
4. **A main está À FRENTE.** `dazzling-dewdney-6be961` traz "⏳ PR0.2b … sessão dedicada
   recomendada"; a main tem "⏸️ PR0.2b **ADIADO** (decisão do founder)". A branch carrega a versão
   **velha** da decisão — recuperá-la seria regredir. Idem `churn-coacao`, que reverteria o helper
   `mensagemDeErro` e apagaria um `describe` de teste que a main ganhou depois.
5. **A ausência é a decisão.** `reposicao-pr2-criticidade-insumos` (#1313): "criticidade" não está
   em SQL nenhum porque o **V3 foi abandonado** pelo challenge do Codex e virou curadoria
   operacional *sem código novo* — registrado na spec que **está** na main.

O denominador comum: em quatro dos cinco, a prova de entrega estava **na própria main**, escrita
por outra sessão. O que fecha o veredito não é comparar árvores — é perguntar *onde este conceito
mora hoje*, e o `git grep` do símbolo responde antes de qualquer diff.

### O filtro que ordena a fila (sem decidir nada)

Duas passadas mecânicas levam 38 → 4 sem emitir veredito:

```bash
# 1. só na direção POSITIVA: arquivo já idêntico na main → entregue, sem discussão
git diff origin/main <ref> -- <arquivo>            # vazio = mesmo estado dos dois lados
# 2. o resíduo: das linhas que a branch ADICIONOU, quantas existem na main hoje?
git diff --unified=0 $(git merge-base origin/main <ref>) <ref> -- <f> | grep '^+' | ...
```

**100% presentes ⇒ entregue** (fechou 4 branches sozinho); o que sobra vira lista de símbolos para
`git grep`. Descartar antes `docs/migrations-audit.md` + `scripts/audit-custom-migrations.sql`
(auto-gerados — `database.md` §30 manda tomar o lado da main). O que a passada **não** decide é a
direção: ela conta linha faltante igual, venha de trabalho perdido ou de a main ter reescrito
melhor. Por isso ordena a fila; não emite veredito.

### A triagem de órfãs também corre risco de corrida

O achado principal da apuração — `clever-herschel-8f3d08`, 638 inserções, 4 suítes, money-path,
zero linhas na main, sem PR nenhum — **foi recuperado por outra sessão no meio desta triagem**. O
commit `5a697bfd` cita `8ec822c3` nominalmente e mergeou às 22:47, entre o meu cherry-pick e o fim
dos gates. Descobri no `git rebase`: o conflito acusava um `HEAD` que já tinha o meu conteúdo.

É a corrida do #1525/#1526 outra vez, agora *dentro do trabalho que existe para consertá-la*.
A regra do CLAUDE.md — **re-conferir `origin/main` imediatamente antes do `gh pr create`** — vale
literalmente aqui: uma órfã é um alvo público (qualquer sessão roda `wt:orfas` e vê a mesma lista),
então a janela entre "escolhi esta" e "abri o PR" é exatamente onde duas sessões colidem. Numa
triagem longa, **re-verifique o veredito antes de empurrar**, não só no começo.

### Duas armadilhas novas

- **`git show "$ref:src/…"` é corrompido pelo zsh, em silêncio.** `$var:s/x/y/` é *modificador de
  substituição* do zsh, e casa em path que comece com `s/`: `"$ref:src/lib/scoring/churn.ts"` vira
  `${ref:s/lib/scoring/}` + `hurn.ts` — o git recebe **outro ref**, devolve `exit 0` e imprime o
  **commit inteiro** em vez do arquivo. Sem erro, saída plausível. Aconteceu 2× aqui; na primeira
  eu li o commit como se fosse o conteúdo do arquivo. **Sempre `git show "${ref}":path`** — as
  chaves fecham o parse. Mesma família do `IFS=$'\t' read` da §4: o shell não erra, ele **desloca**.
- **Branch sem PR nunca passou por CI — o que ela "entrega" pode não compilar.** A
  `clever-herschel` tinha import morto (TS6133) e deixou o teste do componente desatualizado com as
  props que ela mesma tornou obrigatórias: 3 erros de `typecheck` no cherry-pick. O trabalho era bom
  **e** estava incompleto — as duas coisas ao mesmo tempo. `COMMITS SOLTOS` sem PR significa,
  literalmente, código que nenhum gate viu: recuperar órfã exige **rodar os gates**, não só abrir o
  PR. (Corolário do semáforo: com ~24 sessões vivas, `heavy` aborta por timeout de fila em 1800s e
  devolve `exit 1` **sem ter rodado nada** — indistinguível de teste vermelho se você só olhar o
  código de saída. Confira a última linha do log.)

## A ferramenta

```bash
bun run wt:orfas              # candidatas: o que tem COMMIT fora da main (≠ trabalho, ver §limite)
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
