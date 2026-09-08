# O instrumento também envelhece — ler o DADO da ref não protege de rodar o JULGADOR da árvore atrasada

**2026-09-08.** Verificando as pendências de deploy da leva `omie-vendas-sync` (P1, money-path) +
`sync-reprocess` (P2), o gate de ordem entre camadas respondeu o oposto do alarme que o alimentava —
e a saída não tinha nada de errado com ela. Era um **verde**.

## 1. O verde que contradizia o próprio pipe

```bash
bun run pendencias:deploy --json | bun run pendencias:pacote -
# → ✓ nada pendente de deploy — nenhum pacote a emitir        (exit 1)
```

Na **mesma invocação**, o lado esquerdo do pipe acusava **2 pendências**. Um pipe cujo produtor diz
"duas" e cujo consumidor responde "nenhuma".

Depois de sincronizar a worktree, o mesmo comando:

```bash
git merge --ff-only origin/main      # f252495c9 → 5bc73bfac (3 commits)
bun run pendencias:deploy --json | bun run pendencias:pacote -
# → pacote 29258bf8ac3d — 2 edges, 11 RPCs de pré-condição conferidas em prod   (exit 0)
```

Mesmo comando, mesmo alvo, mesmo banco, minutos de distância. Entre os dois vereditos não mudou o
dado nem prod: mudou **a versão do arquivo `scripts/pendencias-pacote.ts` que o `bun` carregou**.

## 2. Não foi o dado — o dado já vinha da ref

É esse detalhe que faz a lição. O produtor do pipe, `scripts/pendencias-deploy.ts`, foi reescrito em
2026-09-05 exatamente para não depender da árvore de quem roda: `REF_MAIN = 'origin/main'`, `git
fetch` na entrada, `git show` do mapa e de cada `versao.ts`, e exit 2 se o fetch falhar. A entrega
fechou com a frase — [deploy-redundante-ledger-e-cron-de-sonda.md](deploy-redundante-ledger-e-cron-de-sonda.md) §4:

> O instrumento lê a ref, não a árvore.

E funcionou. As 2 pendências que ele acusou **da worktree atrasada** estavam certas: foram as mesmas
2 depois do sync. O dado atravessou o pipe intacto. Velho estava o **código que julga o dado**: o
`pendencias-pacote.ts` do working tree era a versão pré-#2374, com o bug do `separarSaida()`:

```js
const iSaida = args.indexOf('--saida');                    // -1 quando ausente
args.filter((_, i) => i !== iSaida && i !== iSaida + 1);    // iSaida+1 === 0 → come o índice 0
```

Sem `--saida`, o filtro descartava o argumento de índice 0 — o `-` do pipe canônico. A leva chegava
**vazia**, e leva vazia era `✓ nada pendente de deploy` com exit 1: a mesma saída, byte a byte, de
uma leva legitimamente vazia. Não era um erro que eu pudesse notar; era um veredito verde, na forma
que a ferramenta usa para dizer "não há trabalho". Nada nela pedia investigação.

O #2374 (`fc44eeaa0`) corrigira isso **horas antes**, e o recorte é exato: dos 3 commits que
separavam a worktree de `origin/main`, **um** tocava o script que eu estava rodando.

```bash
git diff --stat f252495c9 fc44eeaa0 -- scripts/pendencias-pacote.ts
# 1 file changed, 28 insertions(+), 6 deletions(-)
```

## 3. O eixo: VERSÃO DO INSTRUMENTO

O caminho de deploy já tinha dois eixos de `ausente ≠ zero` registrados:

| Eixo | Onde está | O que engana |
|---|---|---|
| **TEMPO** | [fatia-de-deploy-envelhece.md](fatia-de-deploy-envelhece.md) | a resposta certa de ontem sobre a main de hoje |
| **ÁRVORE** | skill `lovable-deploy-verify`, Passo 3 (2026-09-04) | `git fetch` move `origin/main`, mas `grep`/`cat` leem os bytes do working tree — o closure sai curto e **se parece com um closure** |

Este é o terceiro, e é **ortogonal aos dois**: mesmo lendo 100% dos dados da ref, você ainda está
executando o **julgador** da árvore. Um CLI de decisão é código *e* é dado sobre si mesmo — a regra
"leia da ref" foi aplicada ao que o script lê, e ninguém a aplicou ao **script**.

Por que morde agora e não mordia antes: com ~31 worktrees paralelas e auto-merge fechando PR em
minutos, a distância entre a árvore e a ref se mede em **horas de trabalho**, não em dias. O #2374
nasceu na madrugada e mordeu na mesma manhã. Uma sessão que abre worktree e trabalha 3h roda, no
fim, gates que a main já corrigiu, endureceu ou aposentou — sem sinal disso na saída.

E o **sentido** do erro não é aleatório, o que torna o eixo pior do que parece: a árvore atrasada
carrega o gate como ele era **antes** de todo endurecimento que a main aplicou desde então. Você não
roda um gate *diferente*; roda um gate **mais frouxo**. Neste caso o #2374 fez as duas coisas —
corrigiu o parser **e** tornou leva vazia com alvos nomeados um exit 2 fail-closed. A worktree
atrasada perdeu as duas de uma vez.

## 4. A regra prática (hoje, sem código novo)

Antes de confiar no **veredito** de um gate/CLI de decisão — não de um comando qualquer;
especificamente daquele cuja saída vira "pode deployar" / "nada a fazer":

```bash
git fetch -q origin main
git rev-list --count HEAD..origin/main       # 0 → a árvore É a ref, siga
git diff --quiet HEAD origin/main -- scripts/pendencias-pacote.ts scripts/pendencias-deploy.ts \
  || echo '⚠️  o INSTRUMENTO diverge da ref — sincronize antes de julgar'
```

- contagem **0** → nada a fazer;
- **> 0** e o script **não** diverge → o veredito vale (foi a mesma máquina);
- **> 0** e o script **diverge** → o veredito é de outra máquina. `git merge --ff-only origin/main`
  e rode de novo — foi o que virou o "nada pendente" em pacote `29258bf8ac3d`;
- sua sessão está **editando** o script → divergir é o desenho, e a pergunta passa a ser a do §5.

E a regra de leitura que sobrevive ao caso: **"Sincronize antes de MEDIR" (CLAUDE.md §Multi-sessão)
inclui o binário que mede.** Não é só o dado.

## 5. A pergunta aberta — qual a forma certa disso? (não resolvida de propósito)

O reflexo é um guard genérico: *"script de decisão recusa rodar de árvore atrasada quando ELE mesmo
diverge da ref"* (exit 2, fail-closed). Não escrevi, e o motivo não é preguiça — o custo cai
exatamente em cima de quem **conserta** o instrumento:

1. **Reprova trabalho legítimo.** A worktree que EDITA o `pendencias-pacote.ts` diverge da ref por
   desenho. Um guard assim proibiria a sessão do #2374 de rodar o próprio fix: a sessão que mais
   precisa executar o script é a primeira que ele barra. E o `--eu-sei` que o contorna vira, em duas
   semanas, a flag que todo mundo cola sem ler.
2. **Já foi tentado no eixo vizinho — e descartado.** A 1ª correção do `pendencias-deploy.ts` foi
   *precisamente* uma trava "worktree atrasada → exit 2". Ela caiu em minutos: a main andou de novo,
   e ficou claro que com ~30 sessões mergeando a trava é ruído permanente. O que a substituiu foi
   **ler da ref** — não bloquear ([§4](deploy-redundante-ledger-e-cron-de-sonda.md)). Para o
   **código** essa saída não existe: um script não pode se auto-carregar de `origin/main` sem virar
   outro programa, e sem eleger sozinho uma versão que quem o roda não revisou.
3. **A generalização não tem borda óbvia.** "Script de decisão" não é propriedade que o repo saiba
   enumerar hoje; teria de ser declarada (marca no cabeçalho, entrada num manifesto) — e manifesto
   novo é dívida que apodrece sozinha, do jeito que o índice de docs apodreceu 3× antes de virar
   gate ([gate-indice-docs.md](gate-indice-docs.md)).

As opções, nomeadas e **sem escolha feita**:

| | Forma | O que compra | O que custa |
|---|---|---|---|
| **A** | Guard fail-closed genérico, por manifesto de "scripts de decisão" | proteção máxima, inclusive para o script que ninguém revisou | os 3 custos acima, inteiros |
| **B** | Auto-conferência: cada CLI de decisão chama um helper na entrada | mesma proteção, sem manifesto | opt-in individual — o script NOVO nasce desprotegido, e quem esquece é quem ninguém revisou |
| **C** | **Proveniência em vez de bloqueio**: o CLI imprime no rodapé o `HEAD`, a distância para `origin/main` e se o próprio arquivo diverge | verde silencioso vira verde **assinado**; zero falso positivo; custo ~nada | fail-open — sinal que não bloqueia é sinal que se aprende a não ler |
| **D** | Nada no código; a regra de leitura do §4 | zero custo | é o estado atual, e o §4 do doc vizinho já concluiu que "sincronize antes de medir" não se sustenta como disciplina com 30 sessões |

O que falta para decidir é **denominador**: quantas vezes isto morde. Hoje há **1 ocorrência
medida** (esta) mais 1 no eixo vizinho dos dados (o P1 falso da `enviar-pedido-portal-sayerlack`,
§4 do doc vizinho). Não é número para pagar (A). **(C) é o experimento barato que PRODUZ o
denominador**: se o rodapé aparecer "divergente" em N vereditos por semana, o próprio N decide entre
(A) e (B) sem discussão. **A escolha é do founder — nenhuma delas foi implementada junto com este
registro**, de propósito: inventar a solução no mesmo PR da lição é como o guard de #2 nasceu e
morreu.

## 6. O que este registro NÃO é

Não é o post-mortem do #2374 — aquele bug está corrigido, com 11 testes em `separarSaida()` e
falsificação. Se a lição fosse "o `separarSaida` estava errado", ela morreria junto com o fix. O que
sobrevive é: **o próximo bug de instrumento vai morar em outro CLI, e a worktree atrasada vai
continuar carregando a versão anterior dele.** O #2374 fechou este modo de falha; não fechou o eixo.

## 7. Evidência

- worktree em `f252495c9`; `git rev-list --count HEAD..origin/main` = **3** (`fc44eeaa0`,
  `9e55bebd1`, `5bc73bfac`).
- `git diff --stat f252495c9 fc44eeaa0 -- scripts/pendencias-pacote.ts` → `1 file changed, 28
  insertions(+), 6 deletions(-)` — o **único** dos 3 commits que toca o script que eu estava rodando.
- **Antes do sync:** `✓ nada pendente de deploy — nenhum pacote a emitir` (exit 1), com o
  `pendencias:deploy` da mesma invocação acusando 2 pendências.
- **Depois de `git merge --ff-only origin/main`** (HEAD = `5bc73bfac`): pacote **`29258bf8ac3d`**,
  2 edges (`omie-vendas-sync` P1 money-path, `sync-reprocess` P2), **11 RPCs** de pré-condição
  conferidas em prod, exit 0.

## 8. Onde isso cruza

- [deploy-redundante-ledger-e-cron-de-sonda.md](deploy-redundante-ledger-e-cron-de-sonda.md) §4 —
  onde "o instrumento lê a ref, não a árvore" foi firmado **para os dados**, e onde a trava de
  worktree atrasada foi tentada e descartada.
- `.claude/skills/lovable-deploy-verify/SKILL.md`, **Passo 3** — o eixo ÁRVORE do closure
  (`git show origin/main:<path>`, nunca `cat <path>`).
- [fatia-de-deploy-envelhece.md](fatia-de-deploy-envelhece.md) — o eixo TEMPO.
- [ordem-entre-camadas-do-mesmo-pr.md](ordem-entre-camadas-do-mesmo-pr.md) — por que o
  `pendencias:pacote` existe (a edge do #2285 serviu ≥2h25 chamando RPC inexistente): o gate que
  respondeu verde aqui é o que impede aquilo.
- CLAUDE.md §Multi-sessão — "Sincronize antes de MEDIR", que este caso estende ao instrumento.
