# Degradação honesta no dashboard financeiro (PR-A, revisão 2026-10-10) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`) syntax.
> **Revisão:** o plano original (7 tasks, 2026-07-22) ficou obsoleto — a main resolveu D3/D4/cockpit por outros PRs e passou a LIMPAR o dado na falha (fluxo/aging). Ver "Revisão 2026-10-10" no spec `docs/superpowers/specs/2026-07-22-financeiro-degradacao-honesta-design.md`.

**Goal:** sob falha de consulta, cada aba do `/financeiro` diz "indisponível" (com o motivo) em vez de "Sincronize os dados primeiro", "Clique em Recalcular", R$ 0,00, skeleton eterno, card que some — ou o dado de outra empresa.

**Architecture:** o hook `useFinanceiro` passa a ter erro **por dataset** (`errosCarga`) e a limpar o dado do dataset que falhou (padrão que a main já usa em `loadFluxoCaixa`/`loadAging`). O `error` string fica só para ações de sync. As abas ganham a prop aditiva `indisponivel?: string | null`.

**Tech Stack:** React 18 + TS strict, vitest + @testing-library/react (`renderHook`, `render`).

## Global Constraints

- Idioma **pt-BR** em código, comentário, UI e commit. Commits terminam com `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Money-path §2/§7: ausente ≠ zero; falha → "indisponível" com motivo; **nunca** zero fabricado, **nunca** skeleton eterno, **nunca** mensagem que culpa sync/usuário por falha de leitura.
- Props novas são **opcionais** com default que preserva o comportamento atual (`indisponivel` ausente/`null` = como hoje).
- Vazio GENUÍNO (consulta ok, zero linhas) **mantém** a mensagem atual ("Sincronize…"/"Recalcular") — só a FALHA muda de texto.
- Cores: `text-status-error`/`text-status-warning`/`text-muted-foreground`. Aviso de falha com `role="alert"`.
- Texto-âncora dos testes (ASCII-safe na parte casada): o aviso de falha contém a palavra **`indisponível`** e a mensagem do erro; asserte com `/indispon/i` + a mensagem do erro.
- Testes: `heavy bun run test -- <arquivos>` (semáforo de RAM; pode enfileirar — aguarde, não contorne). Captura com `> log 2>&1; echo $?`, nunca `| tail`.
- Falsificação: para cada guard, sabotar, exigir o vermelho **do assert certo** conferindo **contagem total e nomes** (Syntax Error/denominador diferente = sabotagem inválida), reverter e reconfirmar verde ANTES do commit. Nunca commitar com sabotagem viva.

---

### Task 1: Hook `useFinanceiro` — `errosCarga` por dataset; falha limpa o dataset

**Files:**
- Modify: `src/hooks/useFinanceiro.ts`
- Create: `src/hooks/__tests__/useFinanceiro.erros-carga.test.tsx`

**Interfaces — Produces:**
- `export type DatasetFinanceiro = 'resumo' | 'contasPagar' | 'contasReceber' | 'aging' | 'dre' | 'fluxoCaixa' | 'inadimplentes';`
- No retorno do hook: `errosCarga: Partial<Record<DatasetFinanceiro, string>>` (novo). `error: string | null` continua, mas **só** setado por `syncAll`/`calcularDRE`/`calcularDREAnual`/`syncSpecific`.

**Comportamento por loader** (sucesso → `limparFalha(ds)`; catch → limpar o dado + `marcarFalha(ds, e)`; **remover** o `setError(...)` dos loaders):

| loader | dataset | o que limpar no catch |
|---|---|---|
| `loadResumo` | `resumo` | remover do `resumo` as chaves das `companies` pedidas (não as outras) |
| `loadContasPagar` | `contasPagar` | `setContasPagar([])` + `setContasPagarTotal(null)` |
| `loadContasReceber` | `contasReceber` | `setContasReceber([])` + `setContasReceberTotal(null)` |
| `loadAging` | `aging` | já zera para `null` no início; manter o guard de `geracao` — marcar/limpar falha **só** se `geracao === agingGeracao.current` |
| `loadDRE` | `dre` | `setDre([])` |
| `loadFluxoCaixa` | `fluxoCaixa` | já faz `setFluxoCaixa([])` — manter |
| `loadInadimplentes` | `inadimplentes` | `setInadimplentes([])` |

Helpers (dentro do hook, após os `useState`):

```ts
  // Falha de LEITURA por dataset (não de ação). Cada aba lê a sua — o `error` global
  // acusava a aba errada e não sumia com a recarga bem-sucedida (spec D2).
  const [errosCarga, setErrosCarga] = useState<Partial<Record<DatasetFinanceiro, string>>>({});
  const marcarFalha = useCallback((ds: DatasetFinanceiro, e: unknown) => {
    const msg = mensagemDeErro(e) ?? 'Erro sem mensagem — tente de novo ou avise a equipe.';
    setErrosCarga((prev) => ({ ...prev, [ds]: msg }));
  }, []);
  const limparFalha = useCallback((ds: DatasetFinanceiro) => {
    setErrosCarga((prev) => {
      if (!(ds in prev)) return prev;
      const next = { ...prev };
      delete next[ds];
      return next;
    });
  }, []);
```

Adicionar `marcarFalha`/`limparFalha` às deps dos `useCallback` que os usam. Comentário no catch de cada loader explicando por que limpa (mesma razão do `loadFluxoCaixa`: dado anterior pode ser de outra empresa/filtro).

- [ ] **Step 1 (RED):** criar o teste com `vi.hoisted` + `vi.mock('@/services/financeiroService', …)` (todos os getters usados pelo hook como `vi.fn()`; `getContasPagar`/`getContasReceber` resolvem `{ rows, total }`), `renderHook(() => useFinanceiro('all'))` + `act`. Casos:
  1. `loadContasPagar` ok (1 linha) → depois falha → `errosCarga.contasPagar` contém a mensagem, `contasPagar` é `[]` e `contasPagarTotal` é `null`, e `error` segue `null`.
  2. Falha depois sucesso → `errosCarga.contasPagar` volta a `undefined`.
  3. `loadResumo` falha e `loadFluxoCaixa` tem sucesso → `errosCarga.resumo` definido, `errosCarga.fluxoCaixa` indefinido, `error` `null` (D2).
  4. `loadResumo('all')` ok com as 3 empresas → `view` vira `'oben'` → `loadResumo` falha → `resumo.oben` some mas `resumo.colacor` permanece.
  5. `loadAging` falha → `errosCarga.aging` definido, `agingReceber` `null`.
  6. `syncAll` com `triggerFinanceiroSync` rejeitando → `error` definido (ação continua no canal global).
  Rodar: `heavy bun run test -- src/hooks/__tests__/useFinanceiro.erros-carga.test.tsx` → esperado FAIL (`errosCarga` undefined).
- [ ] **Step 2 (GREEN):** implementar conforme a tabela. Rodar o mesmo comando → 6/6 verdes. Rodar também `heavy bun run test -- src/pages src/components/financeiro src/hooks/__tests__` para não quebrar consumidores (FinanceiroSync usa `error`).
- [ ] **Step 3 (falsificar):** (a) no catch de `loadContasPagar`, remover o `setContasPagar([])` → exigir vermelho só no caso 1; (b) tornar `limparFalha` no-op → exigir vermelho só no caso 2. Reverter e reconfirmar 6/6.
- [ ] **Step 4:** commit `fix(financeiro): falha de leitura vira erro POR ABA e limpa o dado daquela aba — o banner global acusava a aba errada [money-path]`.

---

### Task 2: Abas de lista/fluxo/DRE — prop `indisponivel`

**Files:**
- Modify: `src/components/financeiro/dashboard/FluxoCaixaTab.tsx`, `ContasPagarTab.tsx`, `ContasReceberTab.tsx`, `DRETab.tsx`
- Modify tests: `__tests__/FluxoCaixaTab.test.tsx`, `ContasPagarTab.test.tsx`, `ContasReceberTab.test.tsx`, `DRETab.test.tsx` (acrescentar `describe` novo; não alterar os casos existentes)

**Interfaces — Produces:** cada componente aceita `indisponivel?: string | null` (default `null`).

- **FluxoCaixaTab:** após o `if (loading)`, se `indisponivel` → `<Card>` com `<p role="alert" className="text-status-error">Fluxo de caixa indisponível — a leitura falhou: {indisponivel}</p>` (com o ícone `BarChart3` como o empty-state). O empty-state "Sincronize" só para `!indisponivel && data.length === 0`.
- **ContasPagarTab / ContasReceberTab:** a linha vazia (`… .length === 0 && !loading`) passa a renderizar, se `indisponivel`, `<span role="alert" className="text-status-error">Títulos indisponíveis — a leitura falhou: {indisponivel}</span>`; senão o texto atual. O `<Badge>` de contagem mostra `indisponível` (não "0 títulos") quando `indisponivel`.
- **DRETab:** no ramo `!data || data.length === 0`, se `indisponivel` → `<p role="alert" className="text-status-error">DRE indisponível — a leitura falhou: {indisponivel}</p>` no lugar de "Clique em Recalcular" (mantendo `peCard`).

- [ ] **Step 1 (RED):** por componente, 2 casos: (i) `indisponivel="statement timeout"` + dado vazio → `getByRole('alert')` casa `/indispon/i` e `/statement timeout/`, e `queryByText(/Sincronize os dados primeiro/)` (ou `/Recalcular/` no DRE) é `null`; (ii) `indisponivel` ausente + vazio → mensagem atual presente (vazio genuíno). Contas: (iii) badge não mostra `0 títulos` sob falha. Rodar os 4 arquivos → FAIL.
- [ ] **Step 2 (GREEN):** implementar. Rodar os 4 arquivos + `contas-tabs.*.test.tsx` → verdes.
- [ ] **Step 3 (falsificar):** remover o ramo `indisponivel` do FluxoCaixaTab → vermelho só no caso (i) do Fluxo; idem DRETab. Reverter, reconfirmar.
- [ ] **Step 4:** commit `fix(financeiro): falha de leitura deixa de dizer "Sincronize"/"Recalcule" — fluxo, títulos e DRE dizem indisponível [money-path]`.

---

### Task 3: Visão Geral + AgingCard — "—" e aviso em vez de R$ 0,00 / skeleton / card sumido

**Files:**
- Modify: `src/components/financeiro/dashboard/VisaoGeralTab.tsx`, `AgingCard.tsx`
- Modify tests: `__tests__/VisaoGeralTab.test.tsx`, `AgingCard.test.tsx` (acrescentar `describe`)

**Interfaces — Produces:**
- `AgingCard` aceita `indisponivel?: string | null`: com `data === null` e `indisponivel` → `<p role="alert" className="text-xs text-status-error …">Aging indisponível — a leitura falhou: {indisponivel}</p>` no lugar do `<Skeleton>`.
- `VisaoGeralTab` aceita `resumoIndisponivel?`, `agingIndisponivel?`, `inadimplentesIndisponivel?` (todos `string | null`, default `null`).
  - Os 4 `KpiCard` passam `activeResumo?.<campo> ?? null` (nunca `|| 0`); ícone/cor da Posição Líquida usam `(activeResumo?.posicao_liquida ?? 0)` só para escolher cor.
  - Topo da aba: se algum dos três estiver setado, um único `<div role="alert" className="… text-status-error">` "Alguns indicadores estão indisponíveis — a leitura falhou. Exibimos "—"; nenhum número foi estimado." listando os motivos.
  - `AgingCard` recebe `indisponivel={agingIndisponivel}`.
  - Card "Maiores Inadimplentes": se `inadimplentesIndisponivel`, renderiza o card com aviso "Lista de inadimplentes indisponível — a leitura falhou: …" (antes sumia, o que se lê como "ninguém inadimplente").

- [ ] **Step 1 (RED):** casos: (i) `activeResumo={null}` + `resumoIndisponivel="timeout"` → aviso com `/indispon/i` e nenhum `/R\$\s*0,00/` na tela; (ii) `agingReceber={null}` + `agingIndisponivel="timeout"` → zero elementos `[class*="animate-pulse"]` e aviso de aging; (iii) `inadimplentes={[]}` + `inadimplentesIndisponivel="timeout"` → texto `/inadimplentes indispon/i` presente; (iv) AgingCard isolado com `data={null}` + `indisponivel` → `role="alert"`, sem skeleton. Rodar → FAIL.
- [ ] **Step 2 (GREEN):** implementar; rodar os 2 arquivos + `KpiCard.test.tsx` → verdes (casos antigos intactos).
- [ ] **Step 3 (falsificar):** voltar um KPI para `|| 0` → vermelho no caso (i); remover o ramo do AgingCard → vermelho no (ii)/(iv). Reverter, reconfirmar.
- [ ] **Step 4:** commit `fix(financeiro): Visão Geral para de afirmar R$ 0,00 e "ninguém inadimplente" quando a leitura falha [money-path]`.

---

### Task 4: `FinanceiroDashboard` — fiação + gates

**Files:** Modify `src/pages/FinanceiroDashboard.tsx`.

- Desestruturar `errosCarga` do hook.
- Passar: `VisaoGeralTab` ← `resumoIndisponivel={errosCarga.resumo ?? null}`, `agingIndisponivel={errosCarga.aging ?? null}`, `inadimplentesIndisponivel={errosCarga.inadimplentes ?? null}`; `ContasReceberTab` ← `indisponivel={errosCarga.contasReceber ?? null}`; `ContasPagarTab` ← `errosCarga.contasPagar`; `FluxoCaixaTab` ← `errosCarga.fluxoCaixa`; `DRETab` ← `errosCarga.dre`.
- O banner `{error && …}` fica (agora só erro de sync). Ajustar o texto para deixar isso explícito: prefixo "Falha ao sincronizar/recalcular: ".

- [ ] **Step 1:** implementar.
- [ ] **Step 2:** `heavy bun run typecheck > log 2>&1; echo $?` → 0.
- [ ] **Step 3:** `heavy bun run test > log 2>&1; echo $?` → 0, conferindo `Tests N passed (N)` sem `failed`.
- [ ] **Step 4:** `bun lint > log 2>&1; echo $?` → 0 errors.
- [ ] **Step 5:** commit `fix(financeiro): dashboard entrega a cada aba o PRÓPRIO erro de leitura; banner do topo fica só para sync [money-path]`.

## Verificação final

- Re-conferir `git fetch origin main` + `gh pr list` nos arquivos tocados imediatamente antes do `gh pr create`.
- PR não-draft; armar `scripts/pr-watch.sh <nº>` em background. Pós-merge: **Publish** do frontend no Lovable (só `src/`, sem migration/edge).
