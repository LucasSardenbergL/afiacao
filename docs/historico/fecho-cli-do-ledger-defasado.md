# O `/fecho` julgava o ledger com o CLI do working tree DEFASADO

> Alvo: `.claude/skills/fecho/scripts/edges-pendentes.sh` (Passo 3 do `/fecho`). Classe:
> [sonda-le-worktree-defasado.md](sonda-le-worktree-defasado.md) — "a proteção não se aplicava a
> SI PRÓPRIA". O lado do CLI (a allowlist do cron lida da ref dentro do `pendencias-deploy.ts`) é o
> #2464, mergeado em 2026-09-11 00:45Z; este registro é o lado de quem CONSOME o CLI — e continua
> necessário depois dele, porque a worktree defasada roda justamente o CLI de ANTES do #2464, e a
> defasagem de código e SQL não se resolve lendo a allowlist da ref. Medido no `/fecho` de
> 2026-09-10 (~23:10Z).

## O defeito

`edges-pendentes.sh` lê da REF tudo o que tira do git — mapa de fingerprints, janela, marcador de
aposentadoria — e o `pendencias-deploy.ts` lê da REF o **esperado**. Mas o CLI **roda** do working
tree: o código e o SQL vêm do disco — e, até o #2464, também a allowlist do cron que decidia
"intruso" (`_shared/sonda-cron-alvos.ts`, um `import`). No `/fecho` a worktree está quase sempre atrás da main — a branch da sessão foi
squash-mergeada e a main andou —, e o `/fecho` de 2026-09-10 mediu o custo: worktree 11 commits
atrás, onda 5 do cron (#2461) já aplicada no banco e ausente do disco ⇒

```
❌ MECÂNICA: o banco sonda edge(s) que o repo NÃO aprovou: omie-desconto-backfill. […]
```

⇒ `LEDGER_NAO_CONSULTADO` para TODAS as edges ⇒ `DISPARE: bun run sonda:sql omie-desconto-backfill`
— sonda numa edge que **escreve** em `order_items`. Depois de `git checkout --detach origin/main`, a
mesma medição deu `DESATUALIZADA omie-desconto-backfill` e `DESATUALIZADA sonda-relay`: a defasagem
trocou o veredito **e** o remédio impresso. Fail-closed (nada foi absolvido), mas ruído caro — e ele
recorre em todo `/fecho` de worktree defasada cuja janela traga uma onda nova do cron (5 ondas entre
06 e 09/09).

## Por que detectar, e não rodar o CLI de um checkout temporário da REF

As duas saídas estavam na mesa. O fecho de imports do CLI sai de `scripts/` e entra em `src/lib/`
pelo alias `@/`. Medido com bun 1.3.14 (2026-09-10): uma cópia extraída **dentro** do repo, sem
`tsconfig` próprio, teve `@/lib/erro-mensagem` resolvido para o `src/` do **working tree** — a
mistura silenciosa de REF com worktree que o conserto existe para matar, reentrando pela porta do
alias; a mesma cópia **fora** do repo falhou com `Cannot find module`. O checkout temporário teria de
replicar a resolução do alias (e amanhã a de um pacote npm), e o script é o lado que APAGA pendência:
maquinaria nova no caminho que absolve é superfície nova de presente-porém-quebrado. Detectar custa
dois `git` e não absolve nada a mais; o remédio (sincronizar) é um comando.

## O desenho — `LEDGER_WORKTREE_DEFASADA`

- **O quê:** o fecho transitivo dos imports locais do CLI (relativos, `@/` e dinâmicos), calculado na
  hora sobre o working tree — é o que o bun carrega — e comparado com a REF por `git diff
  --exit-code`. **E só ele.** A 1ª descrição do defeito sugeria incluir o mapa de fingerprints, mas o
  CLI o lê pela REF (`lerNaRev`) e ele muda a cada merge de edge: incluí-lo trocaria o ruído de
  "mecânica" pelo de "defasada" em quase todo `/fecho`. O caso 16l da suíte trava essa precisão.
- **Quando:** **depois** da chamada. O CLI faz `git fetch origin main` e julga contra a ref que ELE
  vê; comparar antes mediria contra uma ref que ele move um segundo depois (caso 16o: em dia antes
  da chamada, defasado depois do fetch).
- **Desfecho:** o veredito é descartado **mesmo quando absolve** — CLI velho julga com lógica velha
  (o #2221 era exatamente "resposta sem `edge` lida como nunca atestada" ⇒ re-sondar quem já
  respondeu). A edge segue pendente, mas **fora do DISPARE** (o ledger pode já ter a resposta), e sai
  o remédio pelo estado do tree: limpo ⇒ `git fetch origin main && git checkout --detach
  origin/main`; sujo ⇒ commit WIP antes (nunca `git stash` pelado: a pilha é compartilhada entre as
  worktrees). Frescura **não verificável** ⇒ `LEDGER_NAO_CONSULTADO` — prova ausente não vira
  "fresco", nem "defasada", que não foi medida.
- **A saída do CLI defasado não é repetida.** O remédio dela é de outra versão — em 2026-09-10, um
  `UPDATE … SET ativo = false` que desativaria o alvo **aprovado** e desfaria a migration aplicada
  (#2464). No aviso antigo ele ficava de fora por **5 bytes**: a palavra `UPDATE` começa no byte 205
  da mensagem e o corte é em 200 — sorte, não desenho (com `sonda-relay` no lugar do slug, a palavra
  já entraria, e a mensagem é de outra versão, livre para mudar de forma). A suíte afirma a
  ausência dos dois trechos: o do slug (dentro do corte) e o `UPDATE` (fora dele).

## A lição do epílogo de 09/09, de novo e na própria carne

O epílogo de [sonda-le-worktree-defasado.md](sonda-le-worktree-defasado.md) terminou em "a fatia
certa não é uma LISTA — é o que o resolvedor LEU". O levantamento feito à mão para este conserto
achou **9** arquivos no fecho do CLI; eram **11** — `sonda-versao-sql.ts` faz `await
import('./canaria-leitor-do-repo')`, e o regex do levantamento exigia espaço entre `import` e a aspa.
A descrição do defeito já pedia "o `pendencias-deploy.ts` **com seus imports locais**" — e é isso: "seus
imports" não se enumera à mão. Lista escrita teria nascido cega a 2 arquivos (e o fecho foi tocado
por 33 commits em duas semanas). A fatia é o que o resolvedor carrega, calculada na hora — e lida
com as linhas juntadas, porque o Prettier quebra `import(` longo em linhas.

## Prova

`scripts/test-fecho-edges-pendentes.sh`, 8 casos novos (16i–16p): o incidente reproduzido com a
mensagem verbatim do CLI; o estrito (CLI defasado dizendo `CONFERE` não absolve); o par mínimo (o
MESMO exit 2 com o CLI em dia é mecânica de verdade, nunca "defasada"); a precisão (main andou só
fora do fecho ⇒ ledger consultado); a cadeia relativo → `import(` em linhas → `@/`; o tree sujo; a
corrida do fetch; e o não verificável. Mais 13 sabotagens na falsificação, cada uma com o caso que só
ela pega, e as fixtures são repos git próprios (`FECHO_LEDGER_RAIZ`): medir o checkout de quem roda
a suíte a deixaria vermelha em todo PR que tocasse o fecho do CLI. O Passo 3 do `SKILL.md` ganhou a
linha "sincronize antes de medir" — a trava é a rede para quando a linha for pulada.
