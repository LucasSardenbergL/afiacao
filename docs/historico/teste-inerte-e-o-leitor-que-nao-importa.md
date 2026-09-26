# Teste em `src/` inerte no monitor — e o leitor do build que não importa nada

**2026-09-26.** `monitor-deploy.sh --pr 2547` saiu `PR_TOCA_O_BUNDLE` por causa de **um teste**
(`src/__tests__/erro-object-object-gate.test.ts`, um `4` → `3` num mapa de dívida). A premissa do
pedido: *"o Vite só empacota o que o entry alcança"* — logo teste em `src/` seria inerte sempre que
nenhum módulo do app o importasse e nenhum `import.meta.glob` o cobrisse. A premissa vale para o
**grafo de módulos** e é falsa para o **build**: o `tailwind.config.ts` tem
`content: ["./src/**/*.{ts,tsx}"]`, e o Tailwind lê TODO teste como **texto** à procura de classes.
Um teste com `toHaveClass('text-status-warning')`, para uma classe que o app monta dinâmica
(`text-status-${tom}`), faz nascer no CSS servido uma regra que o app usa — sem import nenhum.

## A lição (vale além deste script)

**"Módulo alcançável" ≠ "arquivo lido pelo build".** Antes de declarar uma classe de arquivo
inerte, enumere os LEITORES do build, não os importadores: grafo de módulos, `content` do Tailwind,
`publicDir`, plugin que faz glob, config que lê arquivo por API. Cada leitor tem a sua prova — e a
do Tailwind não é "ninguém importa", é "o texto que ele lê não mudou o que ele extrai".

## A prova que entrou (`alcance-bundle.py`, parte (d))

- **Tabela:** classe nova `TESTE` (`src/**/__tests__/**`, `src/**/*.{test,spec}.ts(x)`, `src/test/**`).
  No Passo 1 continua contando como frontend; no monitor, só vira inerte com a prova — sem ela
  **continua ALCANCA** (`ALCANCA_BUNDLE` / `PR_TOCA_O_BUNDLE`), nunca "sem alcance".
- **(d1) Módulo:** ponto fixo a partir de TODO arquivo ALCANCA de código (superconjunto do alcançável
  do entry — um grafo a partir do entry que perdesse uma aresta abriria) + transitivo (app → helper
  de teste → teste). Config de build que nomeia pasta com teste é **leitor** (bytes); config que lê
  arquivo por API (`readFileSync`, glob, processo além do `git rev-parse` do carimbo) recusa.
- **(d2) Tailwind:** li o 3.4.17 em `node_modules`: `getClassCandidates` extrai **por linha** e os
  candidatos são **ordenados** antes do `generateRules`; nenhum padrão do `defaultExtractor` casa `\s`
  do JS, sem lookbehind ⇒ o conjunto de candidatos é função do **conjunto de palavras**. Prova: cada
  teste mudado tem as mesmas palavras no ar e na main — separadas pelo `\s` EXATO do JS (o
  `str.split()` do Python corta também em `\x1c-\x1f`/`\x85`: fail-OPEN). Só para o extrator
  auditado: lockfile travando **3.4.17**, `content` = UM array só de strings, sem
  purge/separator/extract/presets/spread/mutação/import local, postcss `tailwindcss: {}`.

## Medido (com denominador)

- 11 dos últimos 300 commits da main tocaram `src/` **só com teste**; a regra de palavras cobre **1**
  (o #2547: 924 = 924 palavras). Os outros 10 acrescentam palavra e seguem ALCANCA — erra para MAIS.
- Real: `--pr 2547` → exit 3 `PR_FORA_DO_AR` + `PR_SEM_ALCANCE_NO_BUNDLE` (11 arquivos, ~1 s de prova).
- Guardas descartadas por custo: "nome do teste citado no app" pegaria **41/795** testes (comentários
  "Guardado por src/__tests__/x.test.ts"); "componente de caminho nos configs", **314/795**.

## A 2ª opinião (Codex xhigh, 484 s) — 6 achados

Procederam e entraram: (1) arestas que a varredura não reconhecia — `import(/* c */ "./x")`, a troca
`.js`→`.ts` do Vite, `new URL("x", import.meta.url)` sem `./`, template/concatenação em `import()`;
(3) `content: [` não garante extrator padrão — array JS carrega `.transform` (ele reproduziu CSS
diferente com as mesmas palavras); (4) só as strings DO ARRAY são canal de texto — outra string do
config é leitor. (6) **Pré-existente, fail-open:** o atalho `ar_full == main_full` (exit 0) vinha
ANTES da conferência de prefixo do carimbo — branch com o nome do carimbo apontando para a main dava
"sincronizado" (conserto em commit próprio). (2) symlink já estava coberto; (5) carimbo de SHA muda
bytes em todo commit: o exit 5 é equivalência **módulo o carimbo**, contrato que já valia para docs.

## A alavanca que NÃO foi puxada (decisão do founder)

Tirar os testes do `content` do Tailwind (`"!./src/**/*.{test,spec}.{ts,tsx}"`,
`"!./src/**/__tests__/**"`, `"!./src/test/**"` — o 3.4 aceita negação, `task.negative` em
`lib/content.js`) tornaria (d2) desnecessária e ~todo PR só-de-teste inerte. É mudança de **build**
(pede Publish) e tem risco real: classe que só existe no CSS porque um teste a cita some. Medir o CSS
com e sem os testes ANTES.

**Limite conhecido, pré-existente:** config que MONTA caminho (`path.join(base, "docs")`) escapa da
varredura de strings também para `docs/`/`supabase/`. Para TESTE a prova agora exige configs sem API
de leitura; para INERTE, não — fica registrado aqui.
