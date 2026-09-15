# bun: filho aberto sem `env` herda o ambiente da PARTIDA — a mutação de `process.env` não chega nele

> **A regra:** em código que roda sob **bun**, processo filho que precisa de uma mutação de
> `process.env` recebe `env` **explícito** (`env: process.env`, ou `{ ...process.env, X }`) — ou o
> processo é re-executado com o ambiente já montado na partida. Sem isso, `spawnSync`, `execSync`,
> `execFileSync`, `Bun.spawn` e `Bun.spawnSync` entregam ao filho o ambiente de quando o bun
> **arrancou**, em silêncio. No node — e portanto no vitest — as mesmas linhas funcionam: **o teste
> verde não prova o script**.

**Quando:** 2026-09-14. Achado do founder na M2 (bun 1.3.14 × node v26.5.0); re-medido e ampliado
na sessão que abriu este doc. Medido no **macOS**; o CI é Linux e **não** foi medido lá (eixo de SO
é independente — `evidencia-positiva-shell.md` §6).

## A matriz

Um script muta o estado do processo **depois** da partida — atribuição, `Object.assign`, `delete`,
sobrescrita de uma variável herdada, e `process.chdir` — e pergunta a um `sh` filho o que recebeu.
Partida com `MAT_DEL=herdado MAT_SOBRE=partida`; o mesmo arquivo roda nos dois runtimes.

| API, **sem** `env` | bun 1.3.14 | node v26.5.0 |
|---|---|---|
| `spawnSync` · `execSync` · `execFileSync` | **cego** às 4 mutações | vê |
| `Bun.spawn` · `Bun.spawnSync` | **cego** às 4 mutações | — |
| `spawn` · `exec` · `execFile` · `fork` (os async de `node:child_process`) | vê | vê |
| `` Bun.$ `` | vê | — |
| qualquer uma **com** `env: process.env` ou `env: { ...process.env }` | vê | vê |
| `cwd` do filho depois de `process.chdir` (todas as APIs) | vê | vê |

O que a matriz acrescentou ao repro original (que só olhava o `spawnSync`):

1. **Não é "o `child_process` do bun"** — é a família SÍNCRONA dele, mais o `Bun.spawn*`. Os async do
   mesmo módulo enxergam a mutação. A assinatura de busca é por **API**, não por módulo.
2. **O retrato é da partida do PROCESSO, não do carregamento do módulo:** mutar antes do
   `require('node:child_process')` também some. E passar `env` numa chamada **não descongela** as
   seguintes — um `spawnSync` sem `env` depois de um com `env` continua cego.
3. **`cwd` não é da classe:** `process.chdir` chega a todos os filhos. Só o ambiente fica congelado.

## Upstream

- Em `Bun.spawn`/`Bun.spawnSync` é **contrato documentado**: a referência da API avisa que mudança
  em runtime no `process.env` não entra no valor padrão. Há PR **aberto** propondo herdar o
  `process.env` vivo ([oven-sh/bun#34972](https://github.com/oven-sh/bun/pull/34972)).
- Em `node:child_process` é **divergência do node**, reportada em
  [oven-sh/bun#29237](https://github.com/oven-sh/bun/issues/29237) (aberta em 2026-04-12 sobre
  `execFileSync` e `PATH`, no 1.3.12; fechada como *completed* em 2026-07-24 — **depois** do 1.3.14,
  publicado em 2026-05-13). O 1.3.14 que o CI fixa (`bun-version: 1.3.14` em todo `setup-bun`) se
  comporta como na matriz.
- ⇒ **bump do bun é gatilho para RE-MEDIR** (roteiro no fim), nunca para presumir: a correção de uma
  família pode não cobrir a outra, e a do `Bun.spawn*` nem tinha sido mergeada.

## O caso conhecido: um teste que só funciona com a semântica do node

`scripts/sonda-versao-bump-gate.test.ts`, bloco *"coletarEstado — a fiação do git, num repo que o
TESTE constrói sob config global hostil"*: seta `process.env.GIT_CONFIG_GLOBAL` para uma config
forjada e chama `coletarEstado`, cujos `git()` e `lerNaRev()` usam `spawnSync` **sem** `env`. Rodado
nos dois runners com a config global **da partida** sabotada — sintaxe inválida, todo `git` que a ler
morre com `bad config` (controle da sabotagem conferido antes de medir):

| runner | partida benigna (controle) | partida com `GIT_CONFIG_GLOBAL` quebrada |
|---|---|---|
| `bun test` | `1 pass` · `Ran 1 test across 1 file` | **`1 fail`** — `` `git diff --name-only …` falhou `` |
| vitest (`bun run test`) | `Tests 1 passed \| 53 skipped (54)` | `Tests 1 passed \| 53 skipped (54)` |

Duas leituras:

1. Sob bun, os commits do próprio teste funcionaram — o helper dele passa `env` explícito — e só o
   `git diff` do coletor, sem `env`, leu a config da partida. A mutação é **portante** e **não chega**.
2. O `bun test` roda o arquivo **sem reclamar** dos imports de `vitest`. Então a quebra não seria
   alta: numa máquina de config global benigna, o teste passa **sem isolar nada** — verde por
   construção, a família inteira do `evidencia-positiva-shell.md`.

O rótulo `|node|` do relatório do vitest é o nome do *project*, não o runtime (aviso do próprio
`vitest.config.ts`). Quem prova que o vitest roda sob a semântica do node é a coluna da direita da
tabela, não o rótulo.

## A varredura

Universo: `scripts/`, `db/`, `.claude/hooks/` e o que o `package.json` e os workflows executam,
seguindo os imports. A busca foi com `--hidden` (`.claude/` incluso — §19 do catálogo) e **calibrada
contra o caso conhecido**: assinatura que não o casasse estaria errada. A varredura foi delegada a
subagente, e as conclusões conferidas por outros dois eixos: `git grep` pelo índice e o próprio
ESLint da trava, que lê AST e não texto.

**Quem roda sob o quê.**

- Sob **bun**: 35 scripts do `package.json` no formato `bun scripts/*.ts` ou `bun db/*.ts`; os `.sh`
  que chamam bun (`scripts/pendencias.sh` e três `db/test-*.sh`); e 39 arquivos com shebang
  `#!/usr/bin/env bun`.
- Sob **node**: o vitest (`bun run test` → `vitest run`, cujo bin tem shebang node; não há `--bun` no
  repo), além de `vite`, `tsc`, `knip` e `eslint`.
- **Bash puro:** os hooks do `.claude/settings.json` e o pre-commit.
- **`bun test` (runner nativo): nenhum invocador** — nem no `package.json`, workflows, hooks, skills
  ou `.sh`. Pelo índice, o único casamento fora de docs é uma *string* de fixture em
  `scripts/test-pipestatus-guard-sinal.sh`. Mas o `bunfig.toml` configurava um `[test] preload` que
  deixava o runner errado *quase* funcionando (achado A9, item M-21 do plano de melhorias de
  2026-09-05). A tabela do caso conhecido é o preço medido disso: verde sem isolar. Desde o M-21, o
  mesmo preload faz o `bun test` sair 1 — ver *Consertos*.

**Onde se muta `process.env`.** Num único arquivo do escopo: o próprio caso conhecido
(`GIT_CONFIG_GLOBAL` e `GIT_CONFIG_NOSYSTEM`; a restauração do `finally` não abre filho depois). Os
outros dois casamentos da assinatura são falso positivo conferido: um `delete` sobre CÓPIA que já vai
como `env` explícito (`scripts/pendencias-deploy-allowlist.test.ts`) e um `vi.stubEnv` sem processo
filho (`src/lib/__tests__/analytics-build-id.test.ts`).

**Onde se abre filho.** 79 linhas com chamada síncrona em 33 arquivos (61 fora de teste; `git grep
-c`, com controle positivo), **todas** em API cega (`spawnSync`, `execSync`, `execFileSync`): nenhum
arquivo importa as versões async de `node:child_process`, nenhum usa `Bun.spawn*` ou `Bun.$`, e não
há wrapper compartilhado em `scripts/lib/`. Os wrappers são locais por arquivo, e o
`git()`/`lerNaRev()` de `scripts/sonda-versao-bump-gate.ts` serve outros quatro scripts. Quase todas
sem `env`. Hoje é inofensivo porque nenhum processo bun
muta o ambiente antes deles, e aí o retrato da partida **é** o ambiente atual. É por isso que a trava
mira a mutação, e não a chamada.

| veredito | sites |
|---|---|
| afetado sob bun | **0** |
| só-vitest — portante sob `bun test`, que ninguém invoca | 1 arquivo, o caso conhecido |
| falso positivo da assinatura | 2 (cópia passada como `env`; `vi.stubEnv` sem filho) |

## Consertos

**Nenhum site de código mudou** — pela regra da entrega, *conserto só onde a medição mostrar
efeito*. Sob bun, nenhum processo muta o ambiente antes de abrir filho; e o caso conhecido roda no
vitest, onde a medição mostra a mutação chegando. Dar `env: process.env` às 61 chamadas fora de teste "por garantia"
seria diff grande, em arquivos quentes de dezenas de worktrees, sem efeito mensurável — e esconderia
o que de fato protege hoje, que é não haver mutação.

**M-21, a parte "preload que lança" — entregue em 2026-09-14.** A medição acima era a evidência que
faltava àquele item do plano de 2026-09-05: o custo do runner errado não é só `vi.mock` ausente, é
**teste de isolamento que passa sem isolar**. O `src/test/bun-setup.ts` deixou de ser o shim: agora
imprime a mensagem abaixo e sai 1, antes de carregar qualquer arquivo de teste.

```text
use bun run test (vitest); bun test não é o runner deste repo — ver docs/historico/bun-filho-sem-env-herda-a-partida.md
```

Duas escolhas, as duas medidas no bun 1.3.14:

- **Manter o preload, em vez de tirá-lo** (a outra saída que o A9 propunha): com o `bunfig.toml` sem
  `[test]`, o `bun test scripts/sonda-versao-bump-gate.test.ts` segue `54 pass` e exit 0. Tirar o
  preload tira o shim, mas não faz o runner falhar.
- **`process.exit(1)`, e não `throw`:** preload que lança não aborta — o bun repete o erro uma vez por
  arquivo de teste e fecha com `Ran N tests across N files`, que se lê como execução (com 3 arquivos,
  3 blocos de erro). Com `exit`, o `bun test` sem argumento, na raiz, sai 1 com a mensagem uma vez
  só: 193 bytes de saída e nenhuma linha `Ran`.

A asserção — exit ≠ 0 **e** a marca ASCII `use bun run test (vitest); bun test ` no começo da linha,
porque exit ≠ 0 sozinho qualquer quebra do runner também daria — foi falsificada com o commit feito
antes, controle verde na MESMA invocação e antes do primeiro sabotar, em `LC_ALL=C` **e**
`pt_BR.UTF-8`:

| rodada | exit | marca | resumo do bun | veredito |
|---|---|---|---|---|
| controle, antes e depois das sabotagens | 1 | 1× | nenhum | verde 4/4 |
| sabotagem A: o preload antigo (= sem a mudança) | 0 | 0× | `54 pass` | vermelho 2/2 |
| sabotagem B: `bunfig.toml` sem `[test]` (= tirar o preload) | 0 | 0× | `54 pass` | vermelho 2/2 |

O `[test] preload` não vaza para o `bun run`: `bun run docs:citacoes` segue exit 0, sem a mensagem.

**Limite conhecido:** de um subdiretório o preload não carrega. Rodado de `scripts/`, o
`bun test ./sonda-versao-bump-gate.test.ts` executou os 54 testes sem a mensagem (51 pass; os 3 que
falham abrem caminhos relativos à raiz, como `supabase/functions/_shared/sonda-cron-alvos.ts`).

As outras duas partes do M-21 — o step `build-id-paridade` e os tetos do `priceGuard` — seguem no
plano.

## A trava contra reintrodução

Sem site afetado, a entrega é a trava — contramedida textual reincide, gate estrutural para. Uma
regra `no-restricted-syntax` no `eslint.config.js` reprova **mutar `process.env`** em `scripts/` e
`db/` (TS e JS), fora os `*.test.ts`:

- **Mira a mutação, não a chamada.** Chamadas síncronas sem `env` são dezenas no repo, todas inofensivas enquanto
  nada mutar antes delas; barrar a chamada seria ruído em arquivo quente. A mutação é a raiz que
  alcança o filho **até por função importada** — o formato do caso conhecido, em que quem muta e quem
  abre o filho moram em arquivos diferentes, e que regra nenhuma olhando só a chamada pegaria.
- **Formas cobertas:** atribuição a propriedade (`=`, `+=`, `??=`…), reatribuição do objeto, `delete`,
  e `Object.assign`/`defineProperty`/`defineProperties` e `Reflect.set`/`deleteProperty`/
  `defineProperty` sobre `process.env` — e o mesmo sobre `Bun.env`, que é o mesmo objeto.
- **Fora, de propósito:** `*.test.ts` roda no vitest (node), onde a mutação chega; `src/` é frontend.
  Mutação só in-process (ex.: uma variável lida pelo próprio processo) desliga a linha com o motivo:
  o custo é uma linha de justificativa local ao arquivo, sem lista compartilhada entre worktrees.
- **Limite conhecido:** apelido (`const e = process.env; e.X = …`) escapa, como de todo seletor de
  AST. A regra evita a reintrodução acidental no padrão comum; não é prova de ausência.
- **O gate tem prova:** `scripts/eslint-mutacao-env-bun.test.ts` passa fixtures pela API do ESLint e
  confere, linha a linha e pela marca da mensagem, que cada forma é pega, que leitura e cópia passada
  como `env` não são, e que o escopo é o do bun.

**A prova do gate foi falsificada.** Com o commit feito antes (o `restaurar()` é `git checkout --`),
controle verde na MESMA invocação e antes do primeiro sabotar, em `LC_ALL=C` **e** `pt_BR.UTF-8`, e
execução positiva exigida: o JSON do vitest tinha de existir e contar 4 testes, senão a rodada valia
"harness quebrado", nunca "vermelho". Cada sabotagem declara quais testes têm de cair **e** quais têm
de ficar de pé — só a regra sabotada decide o resultado:

| sabotagem no `eslint.config.js` | cai | fica de pé |
|---|---|---|
| `files` aponta para outro diretório | formas · escopo do bun | leituras · fora do node |
| sem o `ignores: ["**/*.test.ts"]` | fora do node | formas · leituras · escopo do bun |
| seletor de atribuição cego | formas · escopo do bun | leituras · fora do node |
| seletor de reatribuição cego | formas · escopo do bun | leituras · fora do node |
| seletor de `delete` cego | formas · escopo do bun | leituras · fora do node |
| seletor de `Object`/`Reflect` cego | formas · escopo do bun | leituras · fora do node |
| mensagem sem a marca | formas · escopo do bun | leituras · fora do node |

Resultado: `CONTROLE_VERDE` 2/2, `VERMELHO_CERTO` 14/14 (7 sabotagens × 2 locales),
`FALSIFICACAO_FALHOU` 0, `HARNESS_QUEBRADO` 0. Na árvore real, antes da entrega, o ESLint sobre
`scripts/` e `db/` lintou 123 arquivos com **0 violações** da regra e 0 erros fatais — inclusive o
único `.mjs` do escopo, que passou a ser lintado.

## Como re-medir (no bump do bun)

Rodar nos dois runtimes. O controle é a variável herdada da partida: sem ela, `${MAT_DEL:-apagado}`
diria "apagado" com o filho cego ou não, e a matriz aprovaria tudo.

```js
// matriz-env.mjs — MAT_DEL=herdado bun matriz-env.mjs   (e o mesmo com node)
import cp from 'node:child_process';
if (process.env.MAT_DEL !== 'herdado') {
  console.error('PRE-CONDICAO: rode com MAT_DEL=herdado');
  process.exit(2);
}
process.env.MAT_ATRIB = 'atribuido';
delete process.env.MAT_DEL;
const SH = 'printf "%s|%s" "${MAT_ATRIB:-vazio}" "${MAT_DEL:-apagado}"';
const ve = (s) => (String(s).trim() === 'atribuido|apagado' ? 've' : `CEGO (${String(s).trim()})`);
const casos = {
  'spawnSync sem env': () => cp.spawnSync('sh', ['-c', SH], { encoding: 'utf8' }).stdout,
  'execSync sem env': () => cp.execSync(SH, { encoding: 'utf8' }),
  'execFileSync sem env': () => cp.execFileSync('sh', ['-c', SH], { encoding: 'utf8' }),
  'spawnSync env explicito': () => cp.spawnSync('sh', ['-c', SH], { encoding: 'utf8', env: process.env }).stdout,
};
if (typeof Bun !== 'undefined') {
  casos['Bun.spawnSync sem env'] = () => Bun.spawnSync(['sh', '-c', SH]).stdout.toString();
}
for (const [nome, rodar] of Object.entries(casos)) console.log(nome.padEnd(26), ve(rodar()));
let saida = '';
const filho = cp.spawn('sh', ['-c', SH]);
filho.stdout.on('data', (d) => (saida += d));
filho.on('close', () => console.log('spawn (async) sem env'.padEnd(26), ve(saida), '\nFIM_MATRIZ'));
```

Sem a linha `FIM_MATRIZ`, não houve medição. Se um bump fizer a família síncrona enxergar a mutação,
a regra do ESLint continua correta — o idioma explícito vale nos dois runtimes —, mas este doc passa
a descrever uma versão velha, e é aqui que se registra a nova medição.
