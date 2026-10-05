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
cenário e uma sabotagem por fonte. A revisão independente veio depois, pelo Fable — e achou
o que este auto-challenge não achou (abaixo).

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

## Revisão independente — o Fable no lugar do Codex (05/10)

Com o Codex sem cota, o founder pediu a revisão pelo Fable: subagente só-leitura, experimentos num
rascunho, o mesmo prompt do Codex (com o Publish já medido, para não gastar nessa pergunta). Ele montou
um repo de cenários e mediu os DOIS lados — a prova (exit) e o build real (`tailwindcss` 3.4.17 e
`vite build` nas duas pontas) —, com os controles antes de tudo: `teste_negado` exit 0 e CSS igual; sem
negação, a prova recusa e o CSS ganha as regras. Rodei de novo os scripts dele, com os mesmos
controles: os 6 fail-open se reproduzem.

| forma (residente na base; o delta só põe palavra nova num teste) | a prova | o build real |
| --- | --- | --- |
| pasta-symlink na raiz `app → src/lib/__tests__`, lida pelo `./app/**` | inerte | o CSS ganha `.m-1`/`.overscroll-contain` |
| pasta-symlink com nome de teste `src/lib/x.test.ts → __tests__` | inerte | idem |
| `vite.config` importa `./src/build/css`, que traz o `css.postcss` | inerte | idem (`vite build`) |
| `@config` num `src/index.pcss` importado pelo `main.tsx` | inerte | idem |
| `@config` num `<style>` do `index.html` | inerte | o `index.html` gerado ganha as regras |
| plugin num módulo local do `vite.config` lendo o teste por `readFileSync` | inerte | o JS muda |

Os dois primeiros são do próprio (d2'): a negação casa a STRING do caminho, o Tailwind segue symlink, e
o mesmo texto chega por um caminho que negação nenhuma cobre — o "arquivo regular" olhava só o teste
MUDADO, nunca quem aponta para ele. Os outros quatro são buracos da auditoria do extrator e de (d1) que o
(d2') herdou e ALARGOU: com (d2), a mesma mudança (palavra nova) já era recusada.

Consertos, todos fail-CLOSED:

- (d2') só numa árvore **só de arquivos regulares**, nas duas pontas: symlink ou submódulo em qualquer
  lugar ⇒ o teste volta a exigir (d2). Substitui o `regular()` do teste mudado.
- Config da raiz (`vite`/`tailwind`/`postcss`) que importa módulo LOCAL (`./`, `/`, `@/`) ⇒
  `TESTE_ALCANCA LEITOR`. A checagem existia só para o `tailwind.config`, dentro do extrator, e saiu de
  lá (ficaria inalcançável).
- Folha `.pcss`/`.postcss`/`.sss`/`.scss`/`.sass`/`.less`/`.styl`/`.stylus` na árvore ⇒ o extrator
  recusa (o resto do `CSS_LANGS_RE` do Vite: mesmo PostCSS, e a prova só varria `.css`).
- O HTML do bundle entra na varredura de `@config`, como o `.css`.

O repo real não tem nenhuma das formas — 0 entradas fora de 100644/100755, `vite.config.ts` só com
pacotes, 0 folha pré-processada, e o único `<style>` do `index.html` é o `@keyframes` do spinner (uma
trava "recusa todo `<style>`" zeraria o denominador) —, e a medição repetida confirma: nos últimos 400
commits de 1º pai da main, **18 de 18** só-de-teste isentos, os 13 de 01/10 entre eles.

Rede: +5 cenários (`teste_negado_link_raiz`, `_link_nome`, `_vite_local`, `_pcss`, `_html_config`) e 4
sabotagens novas no lugar da do `regular()`, cada uma com desfecho PREVISTO. `run.sh` verde (rc 0:
classify 19/19, verify-frontend 28/28, monitor-deploy 66/66, `--pr` 80/80). `run.sh --falsify` verde (rc 0): no monitor-deploy, 116
execuções de CONTROLE verdes nos 2 locales antes da 1ª sabotagem e 58/58 pegas pela marca
prevista (as 4 novas inclusive), versionados intactos; no `--pr`, 26 pegas, 0 cegueiras.

## Limites

- No `--pr`, a negação que vale é a do config **no squash** — um revert posterior dela é ele mesmo
  ALCANCA e o monitor sem `--pr` o pega.
- O `bun.lockb` do repo é do template (último commit 2025-01-01) e não traz essas versões; a
  auditoria lê o `bun.lock`. Qual lockfile o build do Lovable honra é premissa anterior a este PR.
- O oráculo rodou uma vez, aqui; o que o mantém válido são as travas de versão (`TAILWIND_AUDITADO`,
  `FAST_GLOB_AUDITADO`) — versão nova volta a exigir (d2) até alguém reler e atualizar.
- Sobraram da revisão do Fable, sem conserto (o repo não tem nenhuma das formas): `@import url(…)`
  num `<style>` do HTML não vira referência (o `@import "x"` vira), e um `.css` FORA da tabela com
  `@config`, importado assim, escaparia; `patchedDependencies`/`patches/` trocando o tailwindcss ou o
  fast-glob com a versão do lockfile intacta (não reproduzido); e plugin de PACOTE cujo `config()`
  troque o `css.postcss` — pacote novo muda o lockfile (ALCANCA), o residente é premissa.

## Deploy

`tailwind.config.ts` é ALCANCA: pediu **Publish**, feito pelo founder em 03/10 depois do merge
(squash `0c373d066`). Prova pelos bytes, colhida por fora:

- `monitor-deploy.sh --pr 2773` → exit 0 `PR_NO_AR` (o ar serve `18affb75`, que contém o squash).
- O CSS servido trocou de `index-BiX2TAAH.css` (153.986 bytes) para `index-D_wObP2W.css` (153.922).
  O de antes **sem** `.m-1{margin:4px}` e `.overscroll-contain{overscroll-behavior:contain}` é byte a
  byte igual ao de depois (controle: sem só uma das duas, não é). No build real do Lovable as
  negações valem, e o CSS não mudou em mais nada — a pergunta "o Vite real difere do CLI?" saiu
  respondida pelos bytes servidos.
