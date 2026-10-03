# Testes fora do `content` do Tailwind — e a prova que entende a negação

**2026-10-01.** Continuação de [teste-inerte-e-o-leitor-que-nao-importa.md](teste-inerte-e-o-leitor-que-nao-importa.md):
a alavanca que ficou registrada lá — tirar os testes do `content` — foi puxada. O `content` lia todo
`src/**/*.{ts,tsx}` como TEXTO, e duas regras do CSS servido existiam SÓ porque testes as citavam.
Agora o array nega as 3 formas da classe `TESTE`, e a prova do monitor de deploy
(`alcance-bundle.py`) entende isso como **(d2')**. É mudança de BUILD: pede Publish.

## Medido antes de mexer (duas vezes: `99b206a77` em 26/09 e `e570a1f4b` em 01/10)

- CSS do `tailwindcss` 3.4.17 com e sem os testes: somem **só** `.m-1` e `.overscroll-contain` —
  82 de 194.419 bytes. O `tailwind.config.ts` editado gera CSS **byte a byte** igual ao medido com
  `--content` (`cmp` rc 0; contra o CSS de antes, rc 1).
- `m-1` é ID de fixture (`'m-1'`) em 2 testes, 5 linhas. `overscroll-contain` vinha do comentário do
  `table-overscroll.test.ts` — o teste que PROÍBE a classe.
- Uso pelo app: zero literal no repo inteiro; zero construção dinâmica (`m-${…}`, `'m-' + …`,
  `overscroll-…`), com controle sintético 4/4 que não casa o literal; zero composição `${a}-${b}` em
  `className`/`cn(`/`clsx(`/`cva(` (filtro com controle 2/2); zero em libs de `node_modules` (controle
  discriminante; `overscroll-contain` só na definição do utilitário no próprio tailwindcss).
- O 1º controle do grep REPROVOU: `\b` não existe no ERE do `git grep` do macOS — o "vazio" do alvo
  era cegueira, e só o controle na mesma invocação disse isso.

## A prova (d2')

Lido em `node_modules`: o 3.4.17 entrega toda string `!x` do array ao fast-glob como padrão negativo
(`lib/lib/content.js`: `generateTasks` → `task.negative` → `!<base>/<glob>` no `fastGlob.sync`); no
fast-glob **3.3.2** (`managers/tasks.js`, `providers/filters/entry.js` e `deep.js`) a negativa vale
para TODA task em qualquer posição do array, só subtrai (o filtro de profundidade poda, nunca
acrescenta) e casa com `dot: true`.

- A prova entende **exatamente** as 3 strings de `NEGACOES_ENTENDIDAS` — as mesmas classes do `teste()`
  do `classify.sh` —, cada uma pela regex do que ela exclui. Outra `!x` (inclusive equivalente,
  como `!src/**/__tests__/**`) não isenta nada: fail-CLOSED, o teste segue exigindo (d2).
- Só isenta com o extrator auditado (a mesma config, o mesmo 3.4.17), com o lockfile travando o
  fast-glob 3.3.2 (`FAST_GLOB_AUDITADO`) e para arquivo **regular** nas duas pontas. **(d1) não muda.**

## O oráculo POR FORA

O `tailwindcss` real numa árvore de rascunho de 33 caminhos traiçoeiros (parênteses, colchetes,
espaço, acento, dotfile, pasta com nome de teste, symlink de arquivo e de PASTA), cada arquivo com uma
propriedade arbitrária única `[--sonda-N:1]` — a regra no CSS gerado = o Tailwind leu o arquivo:

- 19 TESTE pela tabela, 19 excluídos pela prova, **zero** lidos com as negações — nem com a negação
  ANTES das positivas, nem contra uma positiva EXPLÍCITA para um teste.
- Pasta real chamada `pasta.test.ts/` e symlink-**pasta** com nome de teste **são lidos por dentro**
  com as negações: a forma do nome não poda diretório. É o que justifica o "arquivo regular" — sem
  ele, mudar o alvo de um link `x.test.ts → public/a` muda o texto lido e a prova diria inerte.
- O próprio oráculo quase fabricou um achado: no APFS (sem caixa) `src/a.Test.ts` SOBRESCREVEU
  `src/a.test.ts`, e "a negação casa sem caixa" saiu dos dados. Quem pegou foi o controle "lido sem
  negação". Rodadas as variantes sozinhas, a caixa é sensível — o modelo com caixa é o certo.

## O que só a medição no repo REAL pegou

Rodar a prova sobre os commits só-de-teste da main, com o `tailwind.config.ts` deste PR no lugar do
de cada commit, devolveu **13/13 recusados** em `TESTE_ALCANCA EXTRATOR` — até o #2547, inerte
antes. O comentário novo terminava em ponto na linha logo acima de `content: [`, e o
`\.\s*content\b` do guard de mutação (feito para `config.content = …`) casa através da quebra. Os
fixtures dos evals não tinham comentário e passavam. Consertos: o comentário não termina em ponto
(e diz por quê), a recusa mostra o trecho com escapes (`".\n  content"`, não um ponto solto), e o
cenário `teste_negado_config_real` usa o `tailwind.config.ts` REAL como fixture — editá-lo de um
jeito que a auditoria recuse fica vermelho no CI. Depois do conserto, o denominador:

| commits de 1º pai da main (últimos 300) que tocam `src/` só com TESTE | isentos pela prova |
| --- | --- |
| com o `content` de cada commit (sem negação) | 1 de 13 (o #2547) |
| com o `content` deste PR | **13 de 13** |

Os 12 que (d2) recusava punham palavra nova — 10 deles no mesmo gate textual
(`src/__tests__/edge-money-path-invariants.test.ts`); todos passam o (d1).

Mesma família, no fixture: aspas simples com `"` dentro de `"$(…)"` o bash 3.2 do macOS analisa
errado — o `{ts,tsx}` saiu sem aspas, foi expandido, e o fixture gravou `*.test.ts`. Só a marca
COMPLETA (a string da negação na saída) denunciou; no bash 5 do CI sairia certo.

## Caminho B — o Codex sem cota

`codex-async.sh` saiu **79** (`SALDO_ALTO`: cota em 86%, teto 85%, reabre 03/10 19:11) sem gastar a
chamada; não-money-path ⇒ auto-challenge nos eixos do prompt. Fechados: caixa, NFC/NFD (as regex só
restringem trechos ASCII), caracteres especiais, `content.relative` (só no formato objeto, que a
auditoria recusa), outra config do Tailwind (o 3.4 só procura `./tailwind.config.*` no cwd),
submódulo, troca de classe entre ar e main, e a interação com (a)/(d1). **Achado:** o
`postcss-load-config` 4.0.2 que o Vite usa consulta `package.json#postcss` e `.postcssrc*` ANTES do
`postcss.config.*` auditado — presentes, a auditoria olharia o arquivo errado. Agora recusa, com um
cenário e uma sabotagem por fonte. **REVISÃO INDEPENDENTE PENDENTE:** o mesmo prompt quando a cota
voltar.

## Rede

`monitor-deploy-eval.sh`: 61 cenários (+12) e 55 sabotagens (+11), cada uma com desfecho PREVISTO;
`monitor-deploy-pr-eval.sh`: `prtesteneg` (o #12 com a mesma palavra nova, mas sob as 3 negações:
`PR_SEM_ALCANCE_NO_BUNDLE`) e `prtestenegx` (forma estranha: `PR_TOCA_O_BUNDLE`), +2 sabotagens (26).
`run.sh` verde (rc 0: classify 19/19, verify-frontend 28/28, monitor-deploy 61/61, `--pr` 80/80) e
`run.sh --falsify` verde (rc 0): no monitor-deploy, 110 execuções de CONTROLE verdes nos 2 locales
antes da 1ª sabotagem e 55/55 pegas pela marca prevista, versionados intactos; no `--pr`, 26 pegas e
0 cegueiras. `lint:shell` (shellcheck 0.11.0, o pinado no CI): 0 achados em 479 arquivos. Uma 1ª
rodada de falsificação saiu com 1 cegueira — eu tinha editado a prova, que o pr-eval lê por symlink,
no meio dela; refeita do zero sem edição em voo, 0.

## Limites

- No `--pr`, a negação que vale é a do config **no squash** — um revert posterior dela é ele mesmo
  ALCANCA e o monitor sem `--pr` o pega.
- O `bun.lockb` do repo é do template (último commit 2025-01-01) e não traz essas versões; a
  auditoria lê o `bun.lock`. Qual lockfile o build do Lovable honra é premissa anterior a este PR.
- O oráculo rodou uma vez, aqui; o que o mantém válido são as travas de versão (`TAILWIND_AUDITADO`,
  `FAST_GLOB_AUDITADO`) — versão nova volta a exigir (d2) até alguém reler e atualizar.

## Deploy

`tailwind.config.ts` é ALCANCA: precisa de **Publish**. Prova pelos bytes: o CSS servido perde
`.m-1{` e `.overscroll-contain{` — antes do Publish, `index-BiX2TAAH.css` (153.986 bytes) tinha os
dois.
