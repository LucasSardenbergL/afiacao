# F1 Modularização — Manifesto de Módulos + Boletim de Saúde — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Manifesto declarativo dos módulos do app (fonte única, verificada por gate no CI) + boletim de saúde por módulo (testes/typecheck/churn/LOC atribuídos por dono) — sem mover nenhum código existente.

**Architecture:** Lógica pura e testável em `src/lib/modulos/` (matcher de padrões restritos, resolver de ownership, métricas); um teste-gate vitest comum garante que todo arquivo de `src/` tem exatamente 1 dono ou está em `naoClassificados` explícito; `scripts/boletim-modulos.ts` (bun) é casca fina que orquestra subprocessos (vitest/tsc/eslint/git) e renderiza markdown. Spec: `docs/superpowers/specs/2026-07-08-modularizacao-f1-manifesto-boletim-design.md`.

**Tech Stack:** TS 5.8 strict, vitest 3 (jsdom, globals), bun (scripts), node:fs/node:child_process. **Zero dependências novas** (matcher próprio de ~40 linhas em vez de fast-glob).

## Global Constraints

- **Só arquivos NOVOS** — nenhuma modificação em código existente, `package.json`, lockfile, workflows de CI ou `vitest.config.ts`.
- pt-BR em identificadores/nomes (sem acento em identifier: `naoClassificados`, `orfaos`).
- Regra money-path aplicada ao tooling: métrica sem fonte = `"desconhecido"`, teste ausente = `"sem-testes"` — **nunca** 0/“passou” fabricado.
- Comandos pesados (test/typecheck/lint/boletim completo) com prefixo `heavy`.
- `cmd | tail` engole exit code → `> log 2>&1; echo $?` quando o exit importa.
- Imports absolutos `@/` dentro de `src/`; script bun importa de `src/` por caminho relativo (padrão de `scripts/wt-preflight-migration.ts`).
- Gate anti-vazamento do knip: todo export novo de `src/` deve ser importado por teste ou pelo gate (vitest é entry do knip); **não** editar `knip.json` sem antes checar conflito com PR #1212.

---

### Task 1: Matcher de padrões restritos (`padrao.ts`)

**Files:**
- Create: `src/lib/modulos/padrao.ts`
- Test: `src/lib/modulos/__tests__/padrao.test.ts`

**Interfaces:**
- Produces: `casaPadrao(padrao: string, caminho: string): boolean` — gramática restrita: sufixo `/**` (tudo sob o dir), `*` (wildcard dentro de UM segmento, ex. `src/pages/Financeiro*.tsx`), ou caminho exato. Paths sempre POSIX relativos à raiz do repo (`src/...`).

- [ ] **Step 1: Write the failing test**

```ts
// src/lib/modulos/__tests__/padrao.test.ts
import { describe, expect, it } from "vitest";
import { casaPadrao } from "../padrao";

describe("casaPadrao — gramática restrita de globs do manifesto", () => {
  it("dir/** casa qualquer profundidade sob o dir", () => {
    expect(casaPadrao("src/lib/financeiro/**", "src/lib/financeiro/dre.ts")).toBe(true);
    expect(casaPadrao("src/lib/financeiro/**", "src/lib/financeiro/__tests__/dre.test.ts")).toBe(true);
  });
  it("dir/** NÃO casa o próprio dir nem vizinho com prefixo comum", () => {
    expect(casaPadrao("src/lib/financeiro/**", "src/lib/financeiro")).toBe(false);
    expect(casaPadrao("src/lib/fin/**", "src/lib/financeiro/dre.ts")).toBe(false);
  });
  it("* casa dentro de um único segmento (não atravessa /)", () => {
    expect(casaPadrao("src/pages/Financeiro*.tsx", "src/pages/FinanceiroDashboard.tsx")).toBe(true);
    expect(casaPadrao("src/pages/Financeiro*.tsx", "src/pages/sub/FinanceiroX.tsx")).toBe(false);
    expect(casaPadrao("src/pages/Financeiro*.tsx", "src/pages/Financeiro.tsx")).toBe(false); // não existe FinanceiroX vazio? casa: * aceita vazio
  });
  it("* aceita vazio (prefixo exato também casa)", () => {
    expect(casaPadrao("src/pages/Tint*.tsx", "src/pages/Tint.tsx")).toBe(true);
  });
  it("caminho exato casa só ele mesmo", () => {
    expect(casaPadrao("src/lib/reposicao.ts", "src/lib/reposicao.ts")).toBe(true);
    expect(casaPadrao("src/lib/reposicao.ts", "src/lib/reposicao/motor.ts")).toBe(false);
  });
  it("escapa caracteres de regex no padrão (. não vira curinga)", () => {
    expect(casaPadrao("src/lib/a.ts", "src/lib/aXts")).toBe(false);
  });
});
```

Nota: o 3º teste tem asserts contraditórios de propósito no rascunho acima — ao escrever, fixar a semântica: `*` aceita vazio (`Financeiro*.tsx` casa `Financeiro.tsx`); remover a linha `toBe(false)` duplicada e manter só a semântica “aceita vazio”.

- [ ] **Step 2: Run test to verify it fails**

Run: `heavy bunx vitest run src/lib/modulos/__tests__/padrao.test.ts > /tmp/t1.log 2>&1; echo $?; tail -20 /tmp/t1.log`
Expected: exit ≠ 0, "Cannot find module '../padrao'"

- [ ] **Step 3: Write minimal implementation**

```ts
// src/lib/modulos/padrao.ts
// Matcher de padrões RESTRITOS do manifesto de módulos (sem dependência de glob lib).
// Gramática: "dir/**" (tudo sob dir) · "*" (wildcard num segmento, não atravessa "/") · caminho exato.
const escapaRegex = (s: string) => s.replace(/[.+?^${}()|[\]\\]/g, "\\$&");

export function padraoParaRegex(padrao: string): RegExp {
  if (padrao.endsWith("/**")) {
    const base = escapaRegex(padrao.slice(0, -3));
    return new RegExp(`^${base}/.+$`);
  }
  const corpo = padrao.split("*").map(escapaRegex).join("[^/]*");
  return new RegExp(`^${corpo}$`);
}

export function casaPadrao(padrao: string, caminho: string): boolean {
  return padraoParaRegex(padrao).test(caminho);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `heavy bunx vitest run src/lib/modulos/__tests__/padrao.test.ts > /tmp/t1.log 2>&1; echo $?; tail -5 /tmp/t1.log`
Expected: exit 0, todos passam

- [ ] **Step 5: Commit**

```bash
git add src/lib/modulos && git commit -m "feat(modulos): matcher de padrões restritos do manifesto (F1)"
```

---

### Task 2: Tipos + resolver de ownership (`tipos.ts`, `resolver.ts`)

**Files:**
- Create: `src/lib/modulos/tipos.ts`, `src/lib/modulos/resolver.ts`
- Test: `src/lib/modulos/__tests__/resolver.test.ts`

**Interfaces:**
- Consumes: `casaPadrao` (Task 1).
- Produces:
  - `type ModuloApp = { id: string; nome: string; kind: "negocio" | "plataforma"; rotaPrefixos: string[]; gates: string[]; codigo: string[]; testes: string[]; risco: { moneyPath: boolean; offlineFirst: boolean; authSensitive: boolean } }`
  - `type NaoClassificado = { path: string; motivo: string; desde: string }`
  - `type ProblemaManifesto = { tipo: "orfao" | "sobreposicao" | "glob-morto" | "nao-classificado-inexistente" | "nao-classificado-com-dono"; detalhe: string }`
  - `donoDoArquivo(caminho: string, modulos: ModuloApp[]): string[]` — ids dos módulos cujos globs `codigo` OU `testes` casam.
  - `validarManifesto(arquivos: string[], modulos: ModuloApp[], naoClassificados: NaoClassificado[]): ProblemaManifesto[]`

Regras de `validarManifesto` (uma por teste):
1. arquivo com 0 donos e fora de `naoClassificados` → `orfao`;
2. arquivo com 2+ donos → `sobreposicao` (detalhe lista os ids);
3. glob (codigo/testes) que não casa nenhum arquivo → `glob-morto`;
4. entrada de `naoClassificados` cujo path não existe na árvore → `nao-classificado-inexistente`;
5. entrada de `naoClassificados` que TEM dono → `nao-classificado-com-dono` (limpar a lista);
6. árvore íntegra + manifesto correto → `[]`.

- [ ] **Step 1: Write the failing test** — um `it` por regra acima, com árvore sintética:

```ts
// src/lib/modulos/__tests__/resolver.test.ts
import { describe, expect, it } from "vitest";
import { donoDoArquivo, validarManifesto } from "../resolver";
import type { ModuloApp, NaoClassificado } from "../tipos";

const mod = (id: string, codigo: string[], testes: string[] = []): ModuloApp => ({
  id, nome: id, kind: "negocio", rotaPrefixos: [], gates: [], codigo, testes,
  risco: { moneyPath: false, offlineFirst: false, authSensitive: false },
});

describe("donoDoArquivo", () => {
  it("retorna ids de todos os módulos que reivindicam o path (codigo e testes)", () => {
    const mods = [mod("a", ["src/lib/a/**"]), mod("b", [], ["src/lib/a/x.test.ts"])];
    expect(donoDoArquivo("src/lib/a/x.test.ts", mods).sort()).toEqual(["a", "b"]);
  });
});

describe("validarManifesto", () => {
  const arvore = ["src/lib/a/x.ts", "src/lib/b/y.ts"];
  it("orfao: arquivo sem dono e fora de naoClassificados", () => {
    const p = validarManifesto(arvore, [mod("a", ["src/lib/a/**"])], []);
    expect(p).toEqual([{ tipo: "orfao", detalhe: "src/lib/b/y.ts" }]);
  });
  it("sobreposicao: 2+ donos é erro com ids no detalhe", () => {
    const p = validarManifesto(["src/lib/a/x.ts"], [mod("a", ["src/lib/a/**"]), mod("b", ["src/lib/a/x.ts"])], []);
    expect(p).toEqual([{ tipo: "sobreposicao", detalhe: "src/lib/a/x.ts → a, b" }]);
  });
  it("glob-morto: padrão que não casa nada é erro (manifesto apodrecendo)", () => {
    const p = validarManifesto(["src/lib/a/x.ts"], [mod("a", ["src/lib/a/**", "src/lib/zumbi/**"])], []);
    expect(p).toEqual([{ tipo: "glob-morto", detalhe: "a: src/lib/zumbi/**" }]);
  });
  it("nao-classificado-inexistente: entrada stale é erro", () => {
    const nc: NaoClassificado[] = [{ path: "src/sumiu.ts", motivo: "bootstrap", desde: "2026-07-08" }];
    const p = validarManifesto(["src/lib/a/x.ts"], [mod("a", ["src/lib/a/**"])], nc);
    expect(p).toEqual([{ tipo: "nao-classificado-inexistente", detalhe: "src/sumiu.ts" }]);
  });
  it("nao-classificado-com-dono: entrada que ganhou dono exige limpeza", () => {
    const nc: NaoClassificado[] = [{ path: "src/lib/a/x.ts", motivo: "bootstrap", desde: "2026-07-08" }];
    const p = validarManifesto(["src/lib/a/x.ts"], [mod("a", ["src/lib/a/**"])], nc);
    expect(p).toEqual([{ tipo: "nao-classificado-com-dono", detalhe: "src/lib/a/x.ts → a" }]);
  });
  it("manifesto íntegro → []", () => {
    const p = validarManifesto(arvore, [mod("a", ["src/lib/a/**"]), mod("b", ["src/lib/b/**"])], []);
    expect(p).toEqual([]);
  });
});
```

- [ ] **Step 2: Run to fail** — `heavy bunx vitest run src/lib/modulos/__tests__/resolver.test.ts > /tmp/t2.log 2>&1; echo $?; tail -20 /tmp/t2.log` → módulo inexistente.

- [ ] **Step 3: Implement**

```ts
// src/lib/modulos/tipos.ts
export type ModuloApp = {
  id: string;
  nome: string;
  kind: "negocio" | "plataforma";
  rotaPrefixos: string[];
  gates: string[];
  codigo: string[];
  testes: string[];
  risco: { moneyPath: boolean; offlineFirst: boolean; authSensitive: boolean };
};

export type NaoClassificado = { path: string; motivo: string; desde: string };

export type ProblemaManifesto = {
  tipo: "orfao" | "sobreposicao" | "glob-morto" | "nao-classificado-inexistente" | "nao-classificado-com-dono";
  detalhe: string;
};
```

```ts
// src/lib/modulos/resolver.ts
import { casaPadrao } from "./padrao";
import type { ModuloApp, NaoClassificado, ProblemaManifesto } from "./tipos";

export function donoDoArquivo(caminho: string, modulos: ModuloApp[]): string[] {
  return modulos
    .filter((m) => [...m.codigo, ...m.testes].some((p) => casaPadrao(p, caminho)))
    .map((m) => m.id);
}

export function validarManifesto(
  arquivos: string[],
  modulos: ModuloApp[],
  naoClassificados: NaoClassificado[],
): ProblemaManifesto[] {
  const problemas: ProblemaManifesto[] = [];
  const ncPaths = new Set(naoClassificados.map((n) => n.path));

  for (const arq of arquivos) {
    const donos = donoDoArquivo(arq, modulos);
    if (donos.length === 0 && !ncPaths.has(arq)) problemas.push({ tipo: "orfao", detalhe: arq });
    if (donos.length >= 2) problemas.push({ tipo: "sobreposicao", detalhe: `${arq} → ${donos.join(", ")}` });
  }
  for (const m of modulos) {
    for (const padrao of [...m.codigo, ...m.testes]) {
      if (!arquivos.some((a) => casaPadrao(padrao, a))) problemas.push({ tipo: "glob-morto", detalhe: `${m.id}: ${padrao}` });
    }
  }
  for (const nc of naoClassificados) {
    if (!arquivos.includes(nc.path)) problemas.push({ tipo: "nao-classificado-inexistente", detalhe: nc.path });
    else {
      const donos = donoDoArquivo(nc.path, modulos);
      if (donos.length > 0) problemas.push({ tipo: "nao-classificado-com-dono", detalhe: `${nc.path} → ${donos.join(", ")}` });
    }
  }
  return problemas;
}
```

- [ ] **Step 4: Run to pass** — mesmo comando do Step 2, exit 0.
- [ ] **Step 5: Commit** — `git add src/lib/modulos && git commit -m "feat(modulos): tipos + resolver de ownership com validação anti-apodrecimento (F1)"`

---

### Task 3: Walker da árvore real (`arvore.ts`)

**Files:**
- Create: `src/lib/modulos/arvore.ts`
- Test: `src/lib/modulos/__tests__/arvore.test.ts`

**Interfaces:**
- Produces: `listarArquivosSrc(raizRepo?: string): string[]` — TODOS os arquivos (qualquer extensão) sob `src/`, paths POSIX relativos (`src/...`), ordenados. `raizRepo` default = `process.cwd()`.

- [ ] **Step 1: Failing test** (sanidade contra o repo real — âncoras estáveis):

```ts
// src/lib/modulos/__tests__/arvore.test.ts
import { describe, expect, it } from "vitest";
import { listarArquivosSrc } from "../arvore";

describe("listarArquivosSrc", () => {
  const arquivos = listarArquivosSrc();
  it("varre a árvore real e encontra volume plausível (>1000 arquivos)", () => {
    expect(arquivos.length).toBeGreaterThan(1000);
  });
  it("retorna paths POSIX relativos começando com src/", () => {
    expect(arquivos.every((a) => a.startsWith("src/") && !a.includes("\\"))).toBe(true);
  });
  it("inclui âncoras conhecidas (código, teste e não-.ts)", () => {
    expect(arquivos).toContain("src/App.tsx");
    expect(arquivos).toContain("src/index.css");
    expect(arquivos).toContain("src/lib/modulos/arvore.ts");
  });
  it("é ordenado e sem duplicatas", () => {
    const unica = [...new Set(arquivos)].sort();
    expect(arquivos).toEqual(unica);
  });
});
```

- [ ] **Step 2: Run to fail** → módulo inexistente.
- [ ] **Step 3: Implement**

```ts
// src/lib/modulos/arvore.ts
import { readdirSync } from "node:fs";
import { join } from "node:path";

export function listarArquivosSrc(raizRepo: string = process.cwd()): string[] {
  const resultado: string[] = [];
  const visita = (rel: string) => {
    for (const e of readdirSync(join(raizRepo, rel), { withFileTypes: true })) {
      const caminho = `${rel}/${e.name}`;
      if (e.isDirectory()) visita(caminho);
      else resultado.push(caminho);
    }
  };
  visita("src");
  return resultado.sort();
}
```

- [ ] **Step 4: Run to pass.**
- [ ] **Step 5: Commit** — `git commit -m "feat(modulos): walker da árvore src/ (F1)"`

---

### Task 4: Manifesto bootstrap + gate anti-apodrecimento

**Files:**
- Create: `src/lib/modulos/manifesto.ts`
- Test: `src/lib/modulos/__tests__/manifesto.gate.test.ts`

**Interfaces:**
- Consumes: tudo das Tasks 1–3.
- Produces: `MODULOS: ModuloApp[]` (15 módulos: 14 negócio + plataforma), `NAO_CLASSIFICADOS: NaoClassificado[]`.

- [ ] **Step 1: Write the gate test FIRST** (ele dirige o bootstrap inteiro):

```ts
// src/lib/modulos/__tests__/manifesto.gate.test.ts
import { describe, expect, it } from "vitest";
import { listarArquivosSrc } from "../arvore";
import { MODULOS, NAO_CLASSIFICADOS } from "../manifesto";
import { validarManifesto } from "../resolver";

describe("GATE: manifesto de módulos espelha a árvore real de src/", () => {
  it("ids de módulo são únicos", () => {
    const ids = MODULOS.map((m) => m.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
  it("todo arquivo tem exatamente 1 dono ou está em NAO_CLASSIFICADOS (sem órfão silencioso, sem glob morto)", () => {
    const problemas = validarManifesto(listarArquivosSrc(), MODULOS, NAO_CLASSIFICADOS);
    const resumo = problemas.slice(0, 40).map((p) => `[${p.tipo}] ${p.detalhe}`).join("\n");
    expect(problemas, `\n${problemas.length} problema(s) no manifesto:\n${resumo}`).toEqual([]);
  });
});
```

- [ ] **Step 2: Escrever o manifesto com a tabela-base abaixo e iterar até o gate ficar verde.** Módulos (ids fixos): `loja-afiacao, tarefas, financeiro, vendas, farmer-inteligencia, caca, admin-crm, tintometrico, estoque-recebimento, reposicao, producao, governanca, knowledge-base, telefonia-whatsapp-rota, plataforma`. Riscos: `moneyPath: true` em financeiro, vendas, reposicao, estoque-recebimento, tintometrico (preço); `offlineFirst: true` em estoque-recebimento; `authSensitive: true` em plataforma (auth/impersonation), financeiro, caca. Globs-base por módulo (dirs inteiros por `/**`; pages/hooks por prefixo `*`):

| Módulo | Globs principais (codigo) |
|---|---|
| loja-afiacao | `src/lib/afiacao/**`, `src/lib/tools/**`, `src/components/customerDashboard/**`, `src/components/loyalty/**`, pages: `Index,Orders,OrderDetail,Tools,Tool*,Loyalty,Gamification,Training,SavingsDashboard,Addresses,Profile,Support,QualityChecklist,RecurringSchedules,AdminLoyalty,AdminGamification,AdminTraining` (exatos), comps raiz: `AddToolDialog,CustomerDashboard,GamificationCertificate,OrderCard,OrderChat,OrderPrintLayout,OrderReview,OrderSuccessDialog,OrderTimeline,SendingQualityChecklist,SharpeningSuggestions,ToolImageIdentifier` (exatos), `src/queries/useOrders.ts,useTraining.ts,useUserTools.ts` |
| tarefas | `src/lib/tarefas/**`, `src/components/tarefas/**`, `src/components/KanbanBoard.tsx`, pages `Tarefas*.tsx`, hooks `useTarefas*.ts` |
| financeiro | `src/lib/financeiro/**`, `src/components/financeiro/**`, `src/services/financeiro*.ts`, `src/utils/financeiroAlerts.ts`, pages `Financeiro*.tsx`, hooks: `useFinanceiro*,useAntecipacoes,useCashflow*,useEndividamento,useFunding,useRegimeTributario,useValor,useValorCockpit,usePontoEquilibrio,useConcentracaoRecebiveis,useUtiContas,useProximaAcao,useEventosEventuais,useEventosRecorrentes,usePeriodOverride`, `src/__tests__/financeiro.test.ts` |
| vendas | `src/lib/{unified-order,venda-assistida,pedido,pedidosProgramados,preco,pricing,regua-preco,spin? NÃO — spin→farmer}/**`, `src/components/{sales,salesOrders,salesOrderEdit,unified-order,unifiedAI,pedidosProgramados,regua-preco}/**`, `src/services/orderSubmission/**`, `src/hooks/unifiedOrder/**`, pages: `Sales*,UnifiedOrder,VendasFerramentas,PedidosProgramados,PedidoProgramadoDetalhe` , hooks: `useUnifiedOrder,usePricingEngine,useReguaPreco*,useCanariaPreco,usePrecoCockpit,usePriceHistory,useCustoPrazoRegua,useOrderDraft,useOrderDeepLink,useAlertaCreditoCliente,useExcecaoCredito,useBuscaClienteOmie,useHistoricoCompras,useCrossSellEngine`, `src/components/UnifiedAIAssistant.tsx`, `src/__tests__/edge-money-path-invariants.test.ts` |
| farmer-inteligencia | `src/lib/{scoring,tactical,radar,carteira,carteira-saude,positivacao,mixgap,visitas,visit-scoring,dashboard,sinais,spin,gestor? NÃO — gestor→governanca}/**`, `src/components/{farmer,intelligence,radar,carteira,dashboard,customer360,visitas}/**`, `src/hooks/dashboard/**`, pages: `Farmer*,MeuDia,CarteiraBoard,Customer360,IntelligenceDashboard,ExecutiveDashboard,PerformanceHub,RadarClientes,CoachingSPIN`, hooks: `useFarmer*,useCarteira*,useVisitas*,useMyKpis,useMyMixGap,useMyPositivacao,useMyCarteiraScores,useMyVisitSuggestions,useMyAgendaToday,useTacticalPlan,useTeamKpis,useTeamRanking,useCoverage,useSpinAnalysis,useBundle*,useCopilotEngine,useRecommendationEngine,useKpisVisita*,useLastVisit,useFollowupsVisita,useMinhasVisitasResultado,useDefasagemCliente,useClienteTier,useCustomerSegments,useDiagnosticQuestions`, queries `useRadar*,useRegistrarContato*`, comps raiz `RecommendationCard,RecommendationsPanel`, types `carteira.ts` |
| caca | `src/lib/caca/**`, `src/components/caca/**`, `src/pages/Caca.tsx`, `src/hooks/useCaca.ts` |
| admin-crm | `src/lib/{clientes-cadastro,clientes-nao-vinculados,customer-contact,customer-process}/**`, `src/components/{admin-order,adminCustomers,customer}/**`, pages: `Admin.tsx,AdminCustomers,AdminApprovals,AdminOrderDetail,AdminPriceTable,AdminDemandForecast,AdminMonthlyReports,AdminProductivity,AdminDepartments,AdminCalculadora,ClientesNaoVinculados`, hooks: `useAdminOrderDetail,useApprovalQueue,useClientesNaoVinculados,useRefreshClientesNaoVinculados,useExportNaoVinculados,useCustomerContacts,useCustomerProcess,useCustomerCalls? NÃO — calls→telefonia,useDepartmentsAdmin,useCompletude,useCriticaFila,useSuggestedMapping? (consumer-grep)` |
| tintometrico | `src/lib/{tint,mixgap? NÃO — mixgap→farmer}/**`, `src/components/{tint,tintColorSelect,tintImport}/**`, `src/components/TintColorSelectDialog.tsx`, pages `Tint*.tsx`, hooks `useTint*,useDirectTintImport` |
| estoque-recebimento | `src/lib/{picking,recebimento,fila}/**`, `src/components/{picking,recebimento,fila}/**`, `src/pages/picking/**`, `src/services/{picking-confirm,recebimento-confirm,recebimento-cte,recebimento-divergencia}.ts`, pages: `AdminEstoquePicking,AdminEstoqueRecebimento,Recebimento,RecebimentoConferencia,NfeReceipt`, queries `useEnviarParaSeparacao,usePedidosASeparar`, hooks `useEstoqueValor,useOffline*? NÃO — offline infra→plataforma` |
| reposicao | `src/lib/{reposicao,fornecedores,custo,custos}/**`, `src/lib/reposicao.ts`, `src/components/{reposicao,skuMapeamento}/**`, pages `AdminReposicao*,AdminSkuMapeamento,ParamAutoMudancas`, hooks `useReposicaoSessao,useParamAutoMudancas,useHistoricoCompras? NÃO — vendas`, types `reposicao.ts`, contexts `ReposicaoEmpresaContext.tsx` |
| producao | `src/lib/pcp/**`, `src/services/pcp-apontamento.ts`, pages `Producao*,ProductionOrders` |
| governanca | `src/lib/{governanca,dataHealth,melhorias,gestor,grupos}/**`, `src/components/{governanca,dataHealth,melhorias,grupos,analyticsSync,des}/**`, pages: `Gestao*,Governance*,SaudeDados,Melhorias,GrupoCliente360,AdminAnalyticsSync,AdminDesTrimestreAtual`, hooks `useDataHealth,useMelhorias,useExcecoesGestor,useIniciativasIceberg,useAuditTrail,useFarmerGovernance? NÃO — farmer`, queries `useClienteGrupos,useGrupoComercial,useGrupoContatos,useGrupoFinanceiro` |
| knowledge-base | `src/lib/{knowledge-base,rag,standard-process}/**`, `src/components/{knowledge-base,standard-process}/**`, pages `AdminKnowledgeBase*,AdminStandardProcess*`, hooks `useKb*,useKnowledgeBaseList,useSpecVersions,useExtractSpecs,useExtractionDrafts,useBatchExtract,useBatchUploadKbDocuments,useBulkApproveSpecs,useSaveProductSpecs,useProductSpecLink,useApproveStandardProcess,useSaveStandardProcess,useStandardProcess*,useProcessComparison,useReindexRag,useIcMatches` |
| telefonia-whatsapp-rota | `src/lib/{call,call-log,call-session,sip,transcription,whatsapp,rota? não existe — route,maps,cep}/**`, `src/components/{call,telefonia,whatsapp,rota}/**`, `src/components/NvoipDialer.tsx`, pages: `Telefonia,Whatsapp*,Rota*,AdminRoutePlanner,AdminVendorSipCredentials`, hooks `useCall*,useNvoipCall,useWebRTCCall,useIsTelefoniaManager,useGravacaoTranscricao,useTranscription,useLinkCallToCustomer,useCustomerCalls,useSendWhatsapp,useWhatsappPendentes,useRoutePlanner,useMunicaoLigacao,useCatalisadorLink`, queries `useRoute*,useSnapshotRouteQueue,useWhatsapp*,usePropostaPreview`, contexts `WebRTCCallContext,ConditionalWebRTCProvider,webrtc-call-context.ts`, types `call-log.ts`, utils `whatsappShare.ts` |
| plataforma | `src/components/ui/**`, `src/components/{shell,auth,help,docs,impersonation,push,notificacoes,aiOps}/**`, `src/lib/{impersonation,mcp,nav,omie,posthog-error,push,time}/**`, `src/integrations/**`, `src/content/**`, `src/test/**`, `src/types/index.ts`, `src/hooks/__tests__/**` (por arquivo? NÃO — ver Step 3), lib raiz: `analytics,logger,format,escape-html*,phone,postgrest,utils,invoke-function,offline-handlers,offline-queue,pwa-update,routeCrumbs,help-utils,leading-trailing-throttle,agruparPorMes,reposicao? NÃO — reposicao.ts→reposicao,logger-migration.md`, `src/App.tsx,src/App.css,src/main.tsx,src/index.css,src/vite-env.d.ts`, pages: `Auth,ResetPassword,OAuthConsent,NotFound,DesignPreview,DesignSystem,UXRules,TechnicalDocs,AIops,SettingsConfig,AdminAjuda,AdminNotificacoes`, contexts `AuthContext,CompanyContext,AppShellContext,ImpersonationContext,DashboardEditModeContext? (consumer-grep),DashboardPersonaContext? (idem)`, comps raiz: `AppShell,AppShellLayout,EmptyState,ErrorBoundary,ForgotPasswordDialog,NotificationPrompt,ProtectedRoute,RequireCaca,RequireFinanceiroAccess,RequireStaff,StatusBadge,PhotoUpload? (grep),OnboardingWizard? (grep),VoiceServiceInput? (grep)`, hooks genéricos: `use-mobile,useDebouncedValue,useInfiniteScroll,useUrlState,useNetworkStatus,useBiometricAuth,usePushNotifications,usePushSubscription,useFeatureFlag,useGlobalSearch,useBreadcrumbs,useSidebarFavorites,useIsTouchDevice,useOffline*,usePersona,useDisplayAccess,useImpersonat*,useCommercialRole,useMyCommercialRole,useUserDepartment,useSalesOnlyRestriction,useAlertasCriticos? (grep),useDashboardCompany? (grep),useDashboardLayout? (grep),useGamificationScore? NÃO — loja`, `src/__tests__/{app-route-dedupe,auth,index-html}.test.ts` |

  Entradas marcadas `? (grep)`/`? NÃO` acima são as decisões finas — resolvê-las no Step 3; nunca copiar os `?` para o manifesto.

- [ ] **Step 3: Loop de classificação até verde** (procedimento mecânico, repetir até exit 0):
  1. `heavy bunx vitest run src/lib/modulos/__tests__/manifesto.gate.test.ts > /tmp/gate.log 2>&1; echo $?; grep -c 'orfao' /tmp/gate.log` — a mensagem do assert lista até 40 problemas.
  2. Para cada `orfao`: (a) se casa numa regra da tabela acima → adicionar glob/path exato ao módulo; (b) senão, descobrir o consumidor: `grep -rl "<nomeDoArquivoSemExt>" src/pages src/components --include='*.tsx' | head -5` → dono = módulo das páginas consumidoras; (c) consumidores em 2+ módulos e arquivo genérico → `plataforma`; (d) ambíguo de verdade → `NAO_CLASSIFICADOS` com `{ path, motivo: "bootstrap F1 — <por quê é ambíguo>", desde: "2026-07-08" }`.
  3. Para cada `sobreposicao`: apertar o glob mais largo (trocar prefixo por lista de exatos) — NUNCA deixar 2 donos.
  4. Para cada `glob-morto`: corrigir typo ou remover.
  5. Testes (`__tests__` espalhados): pertencem ao módulo do código que testam — cobertos pelos mesmos globs `dir/**`; para dirs de teste FLAT (`src/hooks/__tests__/`, `src/pages/__tests__/`, `src/__tests__/`, `src/components/__tests__/`, `src/contexts/__tests__/`, `src/utils/__tests__/`, `src/queries` se tiver, `src/services/__tests__/`), atribuir POR ARQUIVO ao módulo do alvo testado (mesmo prefixo do hook/página), em `testes:[]` do módulo; ambíguo → `NAO_CLASSIFICADOS`.
  6. Meta de honestidade: `NAO_CLASSIFICADOS` final < 60 entradas, cada uma com motivo específico (não genérico).
- [ ] **Step 4: Rodar a suíte do diretório inteiro** — `heavy bunx vitest run src/lib/modulos > /tmp/t4.log 2>&1; echo $?; tail -5 /tmp/t4.log` → exit 0.
- [ ] **Step 5: Commit** — `git add src/lib/modulos && git commit -m "feat(modulos): manifesto bootstrap (15 módulos) + gate anti-apodrecimento no CI (F1)"`

---

### Task 5: Métricas puras do boletim (`boletim.ts`)

**Files:**
- Create: `src/lib/modulos/boletim.ts`
- Test: `src/lib/modulos/__tests__/boletim.test.ts`

**Interfaces:**
- Consumes: `ModuloApp`, `donoDoArquivo`, `casaPadrao`.
- Produces:
  - `type StatusTestes = "passou" | "falhou" | "sem-testes" | "desconhecido"`
  - `type LinhaBoletim = { id: string; arquivos: number; arquivosTeste: number; loc: number; densidade: string; churn30d: number | "desconhecido"; churn90d: number | "desconhecido"; testes: StatusTestes; testesDetalhe: string; errosTs: number | "desconhecido"; errosLint: number | "desconhecido"; riscos: string[] }`
  - `contarArquivos(arquivos: string[], m: ModuloApp): { codigo: number; teste: number }` — teste = casa em `m.testes` OU nome contém `.test.`/`.spec.`; código = o resto dos arquivos do módulo.
  - `atribuirPorDono<T>(itens: { path: string; valor: T }[], modulos: ModuloApp[]): Map<string, T[]>` — descarta path sem dono (retorna também `semDono: number`).
  - `parseResultadosVitest(json: unknown, modulos: ModuloApp[]): Map<string, { passaram: number; falharam: number }> | "desconhecido"` — shape inesperado → `"desconhecido"` (nunca fabricar).
  - `parseErrosTsc(stdout: string): { path: string }[]` — regex `/^(.+?)\(\d+,\d+\): error TS/`.
  - `montarMarkdown(linhas: LinhaBoletim[], meta: { data: string; naoClassificados: number; avisos: string[] }): string` — inclui SEMPRE a seção "Metodologia e limitações" (fato vs proxy vs desconhecido; cobertura = desconhecida/provider não instalado; bugs históricos = desconhecido/fonte não-estruturada; typecheck = veredito global com erros LOCALIZADOS por dono, nunca "typecheck do módulo").

- [ ] **Step 1: Failing tests** — fixtures sintéticos, um `it` por função: contagem separa código×teste; `parseResultadosVitest` com JSON válido (2 arquivos → módulos distintos) e com shape inválido (`{}` → `"desconhecido"`); `parseErrosTsc` com 2 erros + linha de ruído; `montarMarkdown` contém "Metodologia e limitações", "desconhecid" e o rótulo "proxy" na densidade; módulo sem testes → `"sem-testes"` (NUNCA "passou"). Código de teste completo escrito nesse passo seguindo os exemplos das Tasks 1–2 (mesmo estilo describe/it/expect).
- [ ] **Step 2: Run to fail.**  `heavy bunx vitest run src/lib/modulos/__tests__/boletim.test.ts > /tmp/t5.log 2>&1; echo $?`
- [ ] **Step 3: Implement** as funções puras acima em `boletim.ts` (sem I/O — LOC/churn recebem dados prontos; quem lê fs/git é o script).
- [ ] **Step 4: Run to pass.** exit 0.
- [ ] **Step 5: Commit** — `git commit -m "feat(modulos): métricas puras do boletim — fato≠proxy≠desconhecido (F1)"`

---

### Task 6: Script casca (`scripts/boletim-modulos.ts`)

**Files:**
- Create: `scripts/boletim-modulos.ts`

**Interfaces:**
- Consumes: `manifesto.ts`, `arvore.ts`, `resolver.ts`, `boletim.ts` via import relativo `../src/lib/modulos/*`.
- CLI: `bun scripts/boletim-modulos.ts boletim [--out docs/modulos/x.md] [--sem-testes] [--sem-typecheck] [--sem-lint]` e `bun scripts/boletim-modulos.ts test <id-do-modulo>`.

- [ ] **Step 1: Implement** — casca fina com `#!/usr/bin/env bun` (padrão dos scripts do repo):
  - subcomando `boletim`: monta linhas por módulo — arquivos/LOC (fs), churn 30/90d (`spawnSync git log --since=... --name-only --pretty=format:`, filtra `src/`, atribui por dono; paths deletados ignorados e contados num aviso), testes (spawn `bunx vitest run --reporter=json --outputFile=<tmp>`; parse; exit≠0 com JSON válido ainda é resultado válido — falhas são dado), typecheck (spawn `bunx tsc --noEmit -p tsconfig.app.json`, maxBuffer 64MB, parse por linha), lint (spawn `bunx eslint . --format json`, idem). Flags `--sem-*` pulam a etapa → coluna `"desconhecido"` com aviso "(pulado por flag)".
  - subcomando `test <id>`: expande `testes` do módulo; vazio → imprime `sem-testes` e exit 0; senão `spawnSync bunx vitest run <arquivos...>` herdando stdio e propagando exit code.
  - saída: markdown no stdout; `--out` grava arquivo.
- [ ] **Step 2: Verificar de ponta a ponta o caminho barato** — `bun scripts/boletim-modulos.ts boletim --sem-testes --sem-typecheck --sem-lint > /tmp/b1.md 2>&1; echo $?; head -40 /tmp/b1.md` → exit 0, tabela com 15 linhas + Metodologia; colunas puladas = "desconhecido (pulado por flag)".
- [ ] **Step 3: Verificar subcomando test** — `heavy bun scripts/boletim-modulos.ts test caca > /tmp/b2.log 2>&1; echo $?; tail -5 /tmp/b2.log` (caca é pequeno) → roda só os testes do módulo.
- [ ] **Step 4: Spot-check de honestidade** — conferir 2 números do markdown contra contagem manual: `find src/lib/caca src/components/caca -type f | wc -l` e idem p/ tarefas; divergência → investigar antes de seguir.
- [ ] **Step 5: Commit** — `git add scripts/boletim-modulos.ts && git commit -m "feat(modulos): boletim de saúde por módulo — script bun (F1)"`

---

### Task 7: Boletim inaugural (evidência real)

**Files:**
- Create: `docs/modulos/boletim-inaugural.md`

- [ ] **Step 1:** `heavy bun scripts/boletim-modulos.ts boletim --out docs/modulos/boletim-inaugural.md > /tmp/b3.log 2>&1; echo $?` (rodada COMPLETA: testes+tsc+lint — minutos no M2; é 1×).
- [ ] **Step 2:** Ler o boletim inteiro; validar: nenhuma célula "0" onde deveria ser "desconhecido"; módulos `sem-testes` aparecem como tal; erros (se houver) atribuídos a módulo fazem sentido (spot-check 2).
- [ ] **Step 3: Commit** — `git add docs/modulos && git commit -m "docs(modulos): boletim de saúde inaugural por módulo (F1)"`

---

### Task 8: Verificação global + PR

- [ ] **Step 1:** `heavy bun run test > /tmp/v1.log 2>&1; echo $?` → exit 0 (suíte INTEIRA — prova de não-regressão nos vizinhos).
- [ ] **Step 2:** `heavy bun run typecheck > /tmp/v2.log 2>&1; echo $?` → exit 0.
- [ ] **Step 3:** `heavy bun run lint > /tmp/v3.log 2>&1; echo $?` → exit 0.
- [ ] **Step 4:** `heavy bunx knip > /tmp/v4.log 2>&1; echo $?; tail -20 /tmp/v4.log` → sem NOVO unused vs. main (baseline: comparar com `git stash`-less run em main não é viável no worktree; critério prático: nenhum arquivo `src/lib/modulos/*` ou `scripts/boletim-modulos.ts` listado). Se listar: garantir que gate/testes importam o export; NÃO editar knip.json sem checar PR #1212.
- [ ] **Step 5:** Push + PR não-draft (auto-merge no verde) com corpo: objetivo F1, decisões Claude×Codex, evidência (gate verde, boletim inaugural), nota de que NADA de código existente foi tocado. Armar `scripts/pr-watch.sh <nº>` em background e avisar desfecho via PushNotification.
