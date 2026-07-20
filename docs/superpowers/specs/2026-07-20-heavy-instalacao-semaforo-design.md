# Spec — instalação do `heavy`: fechar a lacuna "merge ≠ semáforo em uso"

> `~/.local/bin/heavy` é uma **cópia manual** de `scripts/heavy.sh`. Mergear na `main`
> não atualiza o semáforo que TODAS as sessões usam — mesma classe de armadilha do
> Lovable ("merge ≠ produção"), já documentada em `docs/agent/worktrees.md` §heavy.
> Mordeu no **#1459**: a correção de 3 bugs de concorrência ficou mergeada e **inerte**
> até alguém copiar à mão.
>
> Objetivo: fechar a lacuna **sem criar cerimônia**. Escopo: 2 scripts novos, 1 bloco
> num hook existente, doc. Nada de CI (ver §6).

## 0. Achados que mudam o desenho (medidos nesta sessão, 2026-07-20)

**A. O estado hoje está sincronizado.** `~/.local/bin/heavy` == `origin/main:scripts/heavy.sh`
== esta worktree (`1b7da797ebb6…`). Alguém já copiou à mão. Logo isto é **prevenção**,
não conserto — não há remediação pendente.

**B. 32 das 39 worktrees carregam o `heavy.sh` PRÉ-#1459.**

```
 32 worktrees  a7c9fc34c946   ← heavy.sh pré-#1459 (com os 3 bugs de concorrência)
  7 worktrees  1b7da797ebb6   ← versão vigente (== origin/main == instalado)
```

Consequência que **define o desenho**: um check que compare o instalado contra o
`scripts/heavy.sh` **da worktree local** daria alarme falso em **82%** das sessões — e
seguir o conselho dele **reinstalaria a versão bugada**, andando o semáforo para trás.
→ A referência do check E do instalador é **`origin/main`**, nunca o arquivo local.

**C. `git checkout` grava inode NOVO (falsificado por teste, não assumido).**
Hipótese inicial: "symlink é perigoso porque `git checkout` reescreveria o arquivo
in-place e o bash, que lê o script por offset de byte, passaria a ler bytes trocados".
**Errada.** Teste em repo descartável: inode antes ≠ inode depois do checkout. Um
`heavy` em execução mantém o inode antigo. O symlink é rejeitado por outro motivo (§1).

O mesmo fato **fundamenta** o `tmp + mv`: `mv` no mesmo filesystem é `rename(2)` atômico
e produz inode novo, então um `heavy` dormindo na fila FIFO (até 30 min, `MAX_WAIT`)
segue lendo o arquivo antigo até terminar. Convivência de versões já é segura — o
`heavy` antigo ignora o subdir `fila/`, só não entra no FIFO (`worktrees.md` §heavy).

**D. `scripts/heavy.sh` mudou 2× na vida do repo** (#245 criação, #1459 concorrência).
Arquivo de mudança rara → a janela de esquecimento é longa e o hábito nunca se forma.
É exatamente o perfil que exige detecção automática em vez de disciplina.

**E. O CI nunca prova o `heavy`.** `scripts/test-heavy.sh` é macOS-only (`sysctl`,
`stat -f`) e o CI é ubuntu. O que está na `main` passou pelo `validate`, mas **não**
pelas 11 asserções de concorrência. É o motivo de o hook **avisar e não auto-instalar**
(§1).

## 1. Decisões (e o que foi rejeitado)

| Decisão | Motivo | Rejeitado |
|---|---|---|
| **Cópia atômica**, não symlink | Symlink faria a versão em vigor ser função de **qual branch o repo principal tem em check-out** — rebaixaria o semáforo das ~22 sessões vivas, invisivelmente. A cópia erra de forma *inspecionável e estável*. | `ln -sf`. (O risco que o founder levantou — worktree sumindo por `wt:prune` — não se aplicaria a um symlink para o repo principal; o branch-flip sim.) |
| Fonte = **`origin/main`** | Achado B: o arquivo local é stale-mas-inocente em 82% das worktrees. | Arquivo da worktree como default. |
| Hook **avisa**, não instala | Achado E: auto-instalar propagaria para todas as sessões um script que o CI não valida, sem ninguém no circuito. O aviso reaparece a cada sessão nova até ser resolvido — o esquecimento não sobrevive. | Auto-instalar; auto-instalar-se-ocioso (o inode novo já protege quem roda, então a condicional não compra segurança). |
| Sem gate de CI | O alvo mora **fora do repo**, na máquina do founder. Ubuntu não enxerga. | Step no `validate`. |

## 2. `scripts/heavy-install.sh` + `bun run heavy:install`

**Contrato.** Instala `heavy` em `~/.local/bin/heavy` a partir de `origin/main`.

| Aspecto | Comportamento |
|---|---|
| Fonte padrão | `git show origin/main:scripts/heavy.sh` |
| `--daqui` | instala o `scripts/heavy.sh` **da worktree atual** (para provar mudança em voo, antes de mergear) |
| `--status` | só reporta instalado × `origin/main`, sem escrever (exit 0 sincronizado, exit 1 divergente) |
| Atomicidade | escreve em `~/.local/bin/.heavy.tmp.$$` — **mesmo filesystem** que o destino, senão `mv` degrada para copy+unlink e perde a atomicidade — `chmod +x`, depois `mv -f` |
| Backup | `~/.local/bin/.heavy.bak` (conteúdo anterior) antes do `mv` |
| Idempotência | já idêntico → **não toca no arquivo**, imprime e sai 0 |
| Bootstrap | cria `~/.local/bin` se ausente; avisa se não estiver no `PATH` |
| Falha | `origin/main` inexistente ou `git show` vazio → erro explícito, **nunca** instala arquivo vazio/parcial |

Registro no `package.json`: `"heavy:install": "bash scripts/heavy-install.sh"`.

## 3. Check no `vigia-worktree.sh` (hook SessionStart existente)

Quarto bloco, no mesmo padrão best-effort dos três atuais (nunca bloqueia; falha
interna vira silêncio). Injeta `additionalContext` quando:

- **Instalado ≠ `origin/main`** → "o `heavy` em uso está desatualizado — `bun run heavy:install`".
- **`heavy` ausente** → hoje o `heavy-guard.sh` fail-opens em silêncio nesse caso
  (linha 32), então uma máquina sem semáforo **não avisa ninguém**. Uma linha fecha isso.

**O hook não reimplementa a comparação**: chama `bash scripts/heavy-install.sh --status`
e lê o exit code. Uma definição só de "divergente", num lugar só — senão o dia em que a
regra mudar, ela muda em metade dos lugares. Script ausente ou erro → silêncio (o hook
já é assim).

Custo: um `git show` + dois `shasum` de 13KB, offline, ~ms.

**Dois limites conhecidos e aceitos:**

1. Se o `origin/main` local estiver velho por falta de `fetch`, o check dá **falso
   negativo** — não pior que hoje. Sem rede no SessionStart (lento e frágil); o
   `git show` lê o object DB compartilhado da worktree.
2. **A cobertura não é retroativa.** O hook vem de `.claude/hooks/` **da worktree**, e as
   32 worktrees pré-#1459 não terão nem o hook novo nem o `heavy-install.sh`. Nelas o
   check simplesmente não roda (em silêncio, por 1). A cobertura cresce sozinha conforme
   worktrees novas nascem de `bun run wt` — mas quem quiser cobrir uma worktree antiga
   hoje precisa rebasear. Não vou tentar consertar isso: o alvo é a **próxima** mudança
   do `heavy.sh`, e até lá a rotatividade de worktrees já resolveu.

## 4. Testes — `scripts/test-heavy-install.sh`

`scripts/test-heavy.sh` (11 asserções de concorrência) **não é tocado** e segue verde.
Suíte nova, isolada por `HOME` temporário + repo git descartável.

| # | Asserção | O que falsifica |
|---|---|---|
| 1 | instala quando ausente; shasum bate com a fonte | — |
| 2 | **inode do destino MUDA** a cada instalação efetiva | trocar `tmp+mv` por `cp` in-place → **vermelho**. É o proxy testável da atomicidade. |
| 3 | default instala o de `origin/main`, **não** o local — em worktree com `heavy.sh` divergente | trocar a fonte default para o arquivo local → **vermelho**. Protege contra a regressão do achado B. |
| 4 | `--daqui` instala o local | inverter as duas fontes → vermelho em 3 **ou** 4 |
| 5 | idempotente: 2ª execução **não** muda o inode | — |
| 6 | backup `.heavy.bak` tem o conteúdo anterior | — |
| 7 | destino fica executável (`-x`) | esquecer o `chmod` antes do `mv` |
| 8 | fonte inválida (`origin/main` sem o arquivo) → exit ≠ 0 **e** destino intacto | fail-open que instalaria vazio |

**Falsificação obrigatória:** cada asserção é provada sabotando a correção e exigindo
vermelho, antes de declarar verde (`money-path.md`; teste negativo sem falsificação é
teatro). `shellcheck` exit 0 nos dois scripts novos — faz parte do health stack.

## 5. Documentação e permissões

- `docs/agent/worktrees.md` §heavy: o ⚠️ já descreve a armadilha; ganha o **remédio**
  (`bun run heavy:install`, fonte `origin/main`, aviso no SessionStart).
- **CLAUDE.md não é tocado** — política de tamanho (`bun run claude:size`); o ponteiro
  para `worktrees.md` já existe.
- `.claude/settings.json`: `Bash(bun run heavy:install)` no allow, senão cada sessão
  pede permissão para o remédio que o próprio hook acabou de sugerir.

## 6. Fora de escopo (deliberado)

- **Gate de CI** — alvo fora do repo (§1).
- **Auto-instalação** — decidido em §1.
- **Hash embutido no `heavy.sh`** (sugestão original nº 2): exigiria o script conhecer o
  caminho do repo e gravar estado na instalação. Desnecessário — quem chama o check
  (o hook) **já sabe** onde o repo está, via cwd da sessão. Sem arquivo de estado, sem
  problema de bootstrap.
- **`heavy --status` reportando divergência**: mesma razão. O `--status` do `heavy`
  segue só sobre slots/fila; quem compara versões é o `heavy-install.sh --status`.

## 7. Critério de pronto

1. `bash scripts/test-heavy-install.sh` verde, com as 8 asserções falsificadas.
2. `bash scripts/test-heavy.sh` **ainda** verde (11 asserções intactas).
3. `shellcheck scripts/*.sh .claude/hooks/*.sh` exit 0.
4. Hook exercitado nos 3 caminhos: sincronizado (silêncio), divergente (avisa), ausente (avisa).
5. `bun run heavy:install` idempotente na máquina real — 2ª execução não mexe no arquivo.
