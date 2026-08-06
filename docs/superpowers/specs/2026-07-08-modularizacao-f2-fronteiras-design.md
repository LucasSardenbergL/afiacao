# Modularização — F2: fronteiras anti-vazamento (design)

> Fase 2 do programa (F1 = manifesto+gate+boletim, PR #1251). Decidido em sessão 2026-07-08 com medição real prévia + 2ª opinião Codex (consult de arquitetura). Diário: `docs/historico/modularizacao.md`.

## Problema

O manifesto da F1 declara QUEM é dono de cada arquivo, mas nada impede um módulo de importar código de outro — bug de um vaza pro outro, e o acoplamento cresce silencioso. F2 = declarar a regra de fronteira e **impedir vazamento NOVO** no CI, com a dívida existente inventariada e queimável (ratchet).

## Medição real (2026-07-08, scripts de scratchpad sobre o manifesto F1)

| Fato | Valor |
|---|---|
| Imports `@/` | 4.909 — **0 não-resolvidos** pela resolução por convenção (`src/<spec>` + `.ts/.tsx/index`) |
| Vazamentos via `@/` (negócio→negócio ou plataforma→negócio) | **276 arestas** arquivo→arquivo, 58 pares de módulos |
| Imports relativos | 1.633 — 8 não-resolvidos (0,5%) |
| Relativos cross-módulo | 161, sendo **147 do `src/App.tsx`** (router lazy = composition root legítimo) — **14 reais** |
| Baseline estimada (fora composition root) | **~290 arestas** |
| Pares mais quentes | telefonia→reposicao (35) · farmer↔telefonia (26+17) · farmer→tarefas (13) · admin-crm→farmer (12) |

## Decisões

### 1. Ferramenta: verificador PRÓPRIO como teste vitest (não dependency-cruiser/eslint-boundaries)

Mesma filosofia da F1: zero dependência nova (lockfile = ímã de conflito com as worktrees), zero mudança de CI (gate é teste vitest comum), reusa `manifesto/resolver/arvore` da F1. A medição prova que a resolução por convenção do repo (imports absolutos `@/` + relativos simples) cobre 99,5%+ dos imports sem resolver TS completo. Os 8 não-resolvidos degradam para **contagem exposta** no gate (nunca "ok" silencioso — regra money-path do tooling).

### 2. Semântica da regra

- Módulo de **negócio** importa de: **si mesmo + plataforma**. Importar de outro módulo de negócio = **vazamento**.
- **plataforma** NÃO importa de módulo de negócio (**inversão**) — exceto os **composition roots declarados** (`COMPOSICAO_RAIZ` no manifesto; hoje só `src/App.tsx`, que lazy-importa as 173 pages por definição de router).
- `import type` conta **igual** (acoplamento de tipo é acoplamento; tipo compartilhado legítimo deve migrar para plataforma ou para o dono — o ratchet absorve os existentes).
- Arquivo de **teste** segue a mesma regra do código (teste de A importando de B é acoplamento de A→B).
- Barrel/index "público" por módulo = **F3+, YAGNI** agora.

### 3. Ratchet/baseline

- `src/lib/modulos/fronteiras-baseline.ts`: as arestas atuais como `{ de, para, deModulo, paraModulo, kind }` exatos, **ordenadas deterministicamente** (de → para → kind; 1 por linha — merge semântico simples), geradas por script e commitadas.
- Gate (`fronteiras.gate.test.ts`, vitest comum): aresta cross-módulo **fora da baseline = vermelho** (com mensagem ensinando: mover o código pro dono, extrair pra plataforma, ou — conscientemente — adicionar à baseline no diff do PR, visível ao reviewer); aresta da baseline **que não existe mais = vermelho** (burn-down obrigatório, paridade com `NAO_CLASSIFICADOS` da F1).
- Aresta exata (não contagem por par): burn-down por aresta e diff de PR explícito. Conflito de merge na baseline é raro (aresta só muda quando o import muda) e resolve-se re-gerando (`script gerar-baseline`).

### 4. Extrator de imports (`imports.ts`, puro) — parser TS, não regex

Parecer Codex acatado: o risco nº1 da abordagem própria é **falso negativo do extrator** (subcontar = gate que mente). Em vez de regex, usar a **API do `typescript` que JÁ é dependência do projeto** (`ts.createSourceFile`, só sintaxe — sem type-check): cobre `import … from`, `export … from`/`export * from` (re-export é import arquitetural), `import("…")` lazy, `vi.mock/jest.mock`, multi-linha, e detecta `import type` nativamente (aresta ganha `kind: "type" | "runtime"` no diagnóstico — conta IGUAL para o gate).

- Resolve `@/x` → `src/x` e relativos → a partir do dir do arquivo; candidatos `.ts/.tsx/.d.ts/index.ts/index.tsx` contra a árvore da F1.
- **CSS/assets não são dependência arquitetural** (aresta só conta se o alvo é .ts/.tsx/.d.ts).
- Import dinâmico com argumento não-literal → `nao-analisavel`, **contado e exposto** no gate (não bloqueante na F2), nunca ignorado silencioso; idem spec não-resolvido.

## Componentes (novos, exceto 1 export novo no manifesto)

1. `src/lib/modulos/imports.ts` — `extrairImports(conteudo)` + `resolverImport(spec, arquivoOrigem, arvore)` (puros).
2. `src/lib/modulos/fronteiras.ts` — `classificarArestas(...)` → `ok | vazamento | inversao` + `validarFronteiras(arestas, baseline)` → problemas `{tipo: "vazamento-novo" | "baseline-resolvida", detalhe}`.
3. `src/lib/modulos/fronteiras-baseline.ts` — gerado, commitado.
4. `src/lib/modulos/manifesto.ts` — ganha `export const COMPOSICAO_RAIZ = ["src/App.tsx"]`.
5. `src/lib/modulos/__tests__/{imports,fronteiras}.test.ts` (fixtures) + `fronteiras.gate.test.ts` (árvore real).
6. `scripts/fronteiras-modulos.ts` — `gerar-baseline` (re-gera o arquivo 3) e `relatorio` (vazamentos por módulo/par, p/ priorizar burn-down).

## Critérios de aceite (rubrica da sessão)

1. Testes novos verdes incl. edge cases (export-from, import type, css, template dinâmico ignorado, não-resolvido contado).
2. Ponta a ponta real: baseline gerada da árvore real; gate verde; **falsificação manual** (sabotar com 1 import cross → gate vermelho → reverter) com evidência na sessão.
3. Money-path: nada tocado; regra "não-resolvido ≠ ok" aplicada e testada.
4. Vizinhos: suíte global + typecheck + lint verdes; knip sem menção aos arquivos novos.
