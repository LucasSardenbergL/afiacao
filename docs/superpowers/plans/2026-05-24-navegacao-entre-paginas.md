# Navegação entre páginas (stepper + breadcrumb global + voltar contextual) — Plano de Implementação

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Dar ao usuário navegação consistente entre páginas além do menu lateral — corrigindo o stepper da Reposição (que não deixa "voltar" porque destaca uma etapa derivada de dados, não da URL) e adicionando a **infraestrutura** de breadcrumb global + "voltar" contextual, montada uma vez no shell, com um registry de rotas inicial (rotas mais usadas). A cobertura das 119 páginas é **incremental** — cada rota mapeada no registry passa a ter breadcrumb; rotas não mapeadas degradam limpo (sem trilha). O alvo desta entrega é a infra + as primeiras rotas mapeadas, não 119 de uma vez.

**Architecture:** Três camadas independentes, entregáveis em sequência. **Camada 1 (stepper):** separa `activeStep` (derivado da URL) de `progressStep` (derivado dos dados via `deriveCurrentStep`), e faz o lock realmente bloquear navegação + corrige `aria-current`. **Camada 2 (breadcrumb global):** um registry estático de metadados de rota (`ROUTE_CRUMBS`) + hook `useBreadcrumbs()` que casa a URL via `matchRoutes` do react-router, renderizado **uma vez** no `AppShell`. Evita migrar o app de `<BrowserRouter><Routes>` para data-router (decisão de arquitetura adiada de propósito). **Camada 3 (voltar contextual):** mesmo registry ganha `backTo`/`backLabel`; o shell mostra um botão "voltar" só em páginas de detalhe/criação. Remove `navigate(-1)` ad-hoc com o tempo.

**Tech Stack:** React 18.3, TypeScript, react-router-dom 6.30 (`matchRoutes`, `useLocation`), shadcn/ui (`breadcrumb.tsx` já existe), Tailwind, vitest (`bun run test`).

---

## Decisão de arquitetura registrada (Camada 2)

O app usa `<BrowserRouter><Routes>` (`src/App.tsx:185,191`). O idioma "limpo" do react-router 6 para breadcrumbs é `useMatches()` + `handle` em rotas, **mas isso exige `createBrowserRouter`/`RouterProvider`** — migração flag-day de ~119 rotas, fora de escopo agora.

**Escolha:** registry estático (`ROUTE_CRUMBS`) + `matchRoutes(routeObjectsParaBreadcrumb, location)`. `matchRoutes` é exportado pelo react-router-dom 6 e funciona standalone contra um array de route-objects, sem precisar do data-router. Trade-off: mantemos um array de metadados em paralelo às `<Route>`s do `App.tsx` (precisa lembrar de adicionar entrada ao criar rota nova). Aceitável porque: (a) zero risco no router existente, (b) labels em pt-BR e conceitos de negócio ficam explícitos (não derivados de string de URL, que viraria lixo com IDs dinâmicos), (c) reversível — se um dia migrar pra data-router, troca o matcher por `useMatches()` sem tocar nos componentes.

---

## File Structure

**Camada 1 — Stepper:**
- Modify: `src/hooks/useReposicaoSessao.ts` — adiciona `deriveActiveStep(pathname)` (função pura, testável).
- Modify: `src/hooks/__tests__/useReposicaoSessao.test.ts` — testes de `deriveActiveStep`.
- Modify: `src/components/reposicao/ProcessoComprasStepper.tsx` — Props passam a ser `activeStep` + `progressStep`; lock vira `disabled` real com early-return; `aria-current` segue `activeStep`.
- Modify: `src/components/reposicao/ReposicaoSessionLayout.tsx` — calcula `activeStep` da URL e passa ambos.

**Camada 2 — Breadcrumb global:**
- Create: `src/lib/routeCrumbs.ts` — registry `ROUTE_CRUMBS` (array de `{ path, crumb, backTo?, backLabel? }`) + tipo `RouteCrumb`.
- Create: `src/hooks/useBreadcrumbs.ts` — hook que casa a URL atual contra o registry e devolve a trilha.
- Create: `src/hooks/__tests__/useBreadcrumbs.test.ts` — testa o matcher (função pura extraída).
- Create: `src/components/shell/GlobalBreadcrumbs.tsx` — renderiza a trilha usando o `breadcrumb.tsx` shadcn.
- Modify: `src/components/AppShell.tsx` — monta `<GlobalBreadcrumbs />` no topo do `<main>`, antes de `{children}`.

**Camada 3 — Voltar contextual:**
- Modify: `src/lib/routeCrumbs.ts` — adiciona `backTo`/`backLabel` em entradas de detalhe/criação.
- Modify: `src/components/shell/GlobalBreadcrumbs.tsx` — renderiza botão "voltar" quando a entrada-folha tiver `backTo`.

---

## CAMADA 1 — Stepper da Reposição

### Task 1: Função pura `deriveActiveStep(pathname)`

Deriva qual etapa (1-5) corresponde à URL atual, comparando contra os `to` de `REPOSICAO_STEPS`. Retorna `0` quando nenhuma casa (ex.: cockpit index `/admin/reposicao/sessao`).

**Files:**
- Modify: `src/hooks/useReposicaoSessao.ts`
- Test: `src/hooks/__tests__/useReposicaoSessao.test.ts`

> Nota: `REPOSICAO_STEPS` mora em `src/components/reposicao/ProcessoComprasStepper.tsx`. Para evitar dependência circular (hook → componente), a função recebe a lista de paths como parâmetro com default importável. Definimos os paths canônicos como constante no próprio hook e o componente passa a importá-la de lá (single source of truth).

- [ ] **Step 1: Escreve o teste que falha**

Em `src/hooks/__tests__/useReposicaoSessao.test.ts`, **estender o bloco de import existente** (linhas 2-6) para incluir os novos símbolos — não adicionar um segundo `import` do mesmo módulo:

```ts
import {
  deriveActiveStep,
  deriveCurrentStep,
  getStepLocks,
  REPOSICAO_STEP_PATHS,
  type ReposicaoStatus,
} from "@/hooks/useReposicaoSessao";
```

Depois adicionar o novo bloco `describe` ao final do arquivo:

```ts
describe("deriveActiveStep", () => {
  it("returns the 1-based step index matching the current pathname", () => {
    expect(deriveActiveStep("/admin/reposicao/sessao/mercado")).toBe(1);
    expect(deriveActiveStep("/admin/reposicao/sessao/parametros")).toBe(2);
    expect(deriveActiveStep("/admin/reposicao/sessao/pedidos")).toBe(3);
    expect(deriveActiveStep("/admin/reposicao/sessao/aplicacao")).toBe(4);
    expect(deriveActiveStep("/admin/reposicao/sessao/confirmacao")).toBe(5);
  });

  it("ignores query strings and trailing slashes", () => {
    expect(deriveActiveStep("/admin/reposicao/sessao/pedidos?fornecedor=ACME")).toBe(3);
    expect(deriveActiveStep("/admin/reposicao/sessao/pedidos/")).toBe(3);
  });

  it("returns 0 for the cockpit index (no step page)", () => {
    expect(deriveActiveStep("/admin/reposicao/sessao")).toBe(0);
  });

  it("returns 0 for unrelated routes", () => {
    expect(deriveActiveStep("/admin/customers")).toBe(0);
  });

  it("exposes the canonical step paths in order", () => {
    expect(REPOSICAO_STEP_PATHS).toEqual([
      "/admin/reposicao/sessao/mercado",
      "/admin/reposicao/sessao/parametros",
      "/admin/reposicao/sessao/pedidos",
      "/admin/reposicao/sessao/aplicacao",
      "/admin/reposicao/sessao/confirmacao",
    ]);
  });
});
```

- [ ] **Step 2: Roda o teste pra ver falhar**

Run: `bun run test src/hooks/__tests__/useReposicaoSessao.test.ts`
Expected: FAIL — `deriveActiveStep is not exported` / `REPOSICAO_STEP_PATHS is not exported`.

- [ ] **Step 3: Implementa a função pura**

Em `src/hooks/useReposicaoSessao.ts`, adicionar perto do topo (após os imports, antes de `useItensDoDia`):

```ts
/**
 * Paths canônicos das 5 etapas da sessão de Reposição, em ordem.
 * Single source of truth — ProcessoComprasStepper importa daqui para montar
 * REPOSICAO_STEPS (label + ícone + to).
 */
export const REPOSICAO_STEP_PATHS = [
  "/admin/reposicao/sessao/mercado",
  "/admin/reposicao/sessao/parametros",
  "/admin/reposicao/sessao/pedidos",
  "/admin/reposicao/sessao/aplicacao",
  "/admin/reposicao/sessao/confirmacao",
] as const;

/**
 * Deriva a etapa (1-based) correspondente à URL atual. Retorna 0 quando
 * nenhuma etapa casa (ex.: cockpit index /admin/reposicao/sessao, ou rota
 * fora da sessão). Ignora query string e barra final.
 *
 * Esta é a "etapa em foco" (onde o usuário ESTÁ) — distinta de
 * deriveCurrentStep (a etapa de PROGRESSO derivada dos dados).
 */
export function deriveActiveStep(pathname: string): number {
  const clean = pathname.split("?")[0].replace(/\/+$/, "");
  const idx = REPOSICAO_STEP_PATHS.findIndex((p) => p === clean);
  return idx === -1 ? 0 : idx + 1;
}
```

- [ ] **Step 4: Roda o teste pra ver passar**

Run: `bun run test src/hooks/__tests__/useReposicaoSessao.test.ts`
Expected: PASS (todos, incluindo os antigos de `deriveCurrentStep`/`getStepLocks`).

- [ ] **Step 5: Commit**

```bash
git add src/hooks/useReposicaoSessao.ts src/hooks/__tests__/useReposicaoSessao.test.ts
git commit -m "feat(reposicao): deriveActiveStep — etapa em foco derivada da URL"
```

---

### Task 2: Refatora `ProcessoComprasStepper` — separa active de progress, lock real, aria correto

**Files:**
- Modify: `src/components/reposicao/ProcessoComprasStepper.tsx`

- [ ] **Step 1: Troca a fonte de `REPOSICAO_STEPS` para os paths canônicos**

No topo de `src/components/reposicao/ProcessoComprasStepper.tsx`, importar os paths do hook e montar `REPOSICAO_STEPS` a partir deles (mantém label+ícone, garante que `to` nunca diverge do matcher):

```tsx
import { REPOSICAO_STEP_PATHS, type StepLock } from "@/hooks/useReposicaoSessao";

type Step = {
  label: string;
  icon: React.ComponentType<{ className?: string }>;
  to: string;
  description?: string;
};

const STEP_META: { label: string; icon: Step["icon"] }[] = [
  { label: "Mercado", icon: Lightbulb },
  { label: "Parâmetros", icon: SlidersHorizontal },
  { label: "Pedidos", icon: ClipboardCheck },
  { label: "Aplicação Omie", icon: Upload },
  { label: "Confirmação", icon: CheckCircle2 },
];

export const REPOSICAO_STEPS: Step[] = STEP_META.map((m, i) => ({
  label: m.label,
  icon: m.icon,
  to: REPOSICAO_STEP_PATHS[i],
}));
```

Remover o import antigo de `StepLock` se duplicado (já vem na linha acima) e o array literal antigo de `REPOSICAO_STEPS`.

- [ ] **Step 2: Troca a interface de Props**

Substituir o bloco `interface Props { ... }` por:

```tsx
interface Props {
  /** Etapa em FOCO (1-based), derivada da URL. 0 = nenhuma (ex.: cockpit index). */
  activeStep?: number;
  /** Etapa de PROGRESSO (1-based), derivada dos dados (deriveCurrentStep). */
  progressStep?: number;
  onStepClick?: (step: number) => void;
  isLoading?: boolean;
  locks?: StepLock[];
}
```

- [ ] **Step 3: Atualiza a assinatura e a lógica de estado por etapa**

Trocar a assinatura da função e o cálculo dentro do `.map`:

```tsx
export function ProcessoComprasStepper({
  activeStep = 0,
  progressStep = 3,
  onStepClick,
  isLoading = false,
  locks,
}: Props) {
  const navigate = useNavigate();
  const location = useLocation();
  // ...skeleton inalterado...
```

Dentro do `.map`, substituir os booleanos. **Importante (bug pego pelo Codex):** `isDone`/`isFuture` NÃO podem ter `&& !isCurrent` — senão, quando você vê uma etapa passada (activeStep=1) com progresso adiante (progressStep=4), a etapa 4 não cai em nenhum estado e fica sem estilo. Separe os conceitos: `isActive` (foco/URL) controla destaque + aria; `isProgress` (a etapa de progresso dos dados) ganha um marcador sutil "atual" quando não é a que está em foco.

```tsx
const stepNum = idx + 1;
const isActive = stepNum === activeStep;       // etapa em FOCO (URL)
const isProgress = stepNum === progressStep;   // etapa de PROGRESSO (dados)
const isDone = stepNum < progressStep;         // concluída (independe do foco)
const isFuture = stepNum > progressStep;       // futura (independe do foco)
const lock = locks?.[idx];
// nunca trava a etapa que o usuário está vendo
const isLocked = !isActive && !!lock?.locked;
const Icon = step.icon;
```

> `isActive` controla `aria-current` e o destaque forte. `isProgress && !isActive` recebe um marcador discreto (badge "atual" ou borda pontilhada) pra não sumir o "onde o fluxo está" quando você navega pra trás. `isDone`/`isFuture` viram a base de cor; `isActive` sobrepõe.

- [ ] **Step 4: Lock vira bloqueio real (early-return) + `aria-disabled` (NÃO native `disabled`)**

**Bug pego pelo Codex:** native `<button disabled>` não emite eventos de pointer/focus de forma confiável — a Tooltip de "etapa bloqueada" pode não aparecer no hover, e usuário de teclado não consegue focar a etapa pra ler o motivo. Solução: bloqueio comportamental real via early-return no `handleClick`, mas mantendo o botão focável com `aria-disabled` (não `disabled`).

Atualizar `handleClick` e o `<button>`:

```tsx
const handleClick = () => {
  if (isLocked) return; // bloqueio real, comportamental
  if (onStepClick) {
    onStepClick(stepNum);
    return;
  }
  const targetPath = step.to.split("?")[0];
  const samePage = location.pathname === targetPath;
  navigate(step.to, { replace: samePage });
};

const button = (
  <button
    type="button"
    onClick={handleClick}
    aria-current={isActive ? "step" : undefined}
    aria-disabled={isLocked ? "true" : undefined}
    className={cn(
      "flex items-center gap-2 rounded-md px-3 py-2 w-full text-left transition-colors",
      isActive && "bg-primary/10 text-primary border border-primary/30",
      !isActive && isProgress && "border border-primary/20",
      !isActive && isDone && "bg-status-success/5 text-foreground border border-status-success/20",
      !isActive && isFuture && !isLocked && "bg-muted/40 text-muted-foreground border border-transparent",
      isLocked && "bg-muted/30 text-muted-foreground/70 border border-dashed border-muted-foreground/20 opacity-70",
      !isActive && !isLocked && "hover:bg-muted hover:text-foreground cursor-pointer",
      isLocked && "cursor-not-allowed",
    )}
  >
    {/* conteúdo interno (ícone + labels). Onde antes usava isCurrent, usar isActive.
        Onde marca "ok"/done, manter isDone. Pra o marcador de progresso quando não
        está em foco, adicionar um badge discreto quando (isProgress && !isActive),
        ex.: <Badge>atual</Badge>. */}
  </button>
);
```

> A Tooltip de etapa travada já envolve o botão num `<span className="w-full">` (linha ~144). Com `aria-disabled` (e não `disabled`), o botão continua recebendo hover/focus, então a tooltip e o leitor de tela funcionam. O `onClick` ainda dispara, mas o early-return em `handleClick` impede a navegação — bloqueio real sem perder acessibilidade.
> **Atenção ao conteúdo interno:** todas as referências a `isCurrent` no JSX interno do botão (ícone, badge "ok") devem ser renomeadas para `isActive` ou `isDone` conforme o caso, já que `isCurrent` não existe mais.

- [ ] **Step 5: Roda typecheck + testes**

Run: `bun run test && bunx tsc --noEmit`
Expected: PASS. (Sem teste de render do componente aqui — a lógica pura está coberta por `deriveActiveStep`/`deriveCurrentStep`. Render test opcional fica fora de escopo.)

- [ ] **Step 6: Commit**

```bash
git add src/components/reposicao/ProcessoComprasStepper.tsx
git commit -m "fix(reposicao): stepper separa etapa em foco (URL) de progresso (dados) + lock real"
```

---

### Task 3: `ReposicaoSessionLayout` passa `activeStep` (URL) e `progressStep` (dados)

**Files:**
- Modify: `src/components/reposicao/ReposicaoSessionLayout.tsx`

- [ ] **Step 1: Deriva activeStep da URL e passa as duas props**

Reescrever `src/components/reposicao/ReposicaoSessionLayout.tsx`:

```tsx
import { Outlet, useLocation } from "react-router-dom";
import { format } from "date-fns";
import { ptBR } from "date-fns/locale";
import { CalendarRange } from "lucide-react";
import { ProcessoComprasStepper, REPOSICAO_STEPS } from "./ProcessoComprasStepper";
import { useReposicaoStatus, getStepLocks, deriveActiveStep } from "@/hooks/useReposicaoSessao";

const CUTOFF = "09:30";

export default function ReposicaoSessionLayout() {
  const location = useLocation();
  const { data: status, isLoading } = useReposicaoStatus();
  const progressStep = status?.current ?? 3;
  const activeStep = deriveActiveStep(location.pathname);
  // No cockpit index (/admin/reposicao/sessao) não há página de etapa, então
  // activeStep=0. Aí destacamos o PROGRESSO (dados) pra não ficar um stepper sem
  // nada marcado enquanto o ContinuarBanner diz "você está na etapa X" (Codex).
  const isSessionIndex =
    location.pathname.replace(/\/+$/, "") === "/admin/reposicao/sessao";
  const stepperActiveStep = activeStep || (isSessionIndex ? progressStep : 0);
  const locks = getStepLocks(status);
  const today = format(new Date(), "EEEE, dd/MM/yyyy", { locale: ptBR });
  // label da etapa exibida (foco, ou progresso no index)
  const labelStep = stepperActiveStep || progressStep;
  const stepLabel = REPOSICAO_STEPS[Math.min(Math.max(labelStep, 1), REPOSICAO_STEPS.length) - 1]?.label;

  return (
    <div className="container mx-auto px-4 sm:px-6 pt-4 sm:pt-6 max-w-7xl">
      <div className="flex items-center justify-between gap-3 flex-wrap mb-3">
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <CalendarRange className="h-4 w-4" />
          <span className="font-medium text-foreground capitalize">{today}</span>
          <span aria-hidden>·</span>
          <span>cutoff {CUTOFF}</span>
          {!isLoading && stepLabel && (
            <>
              <span aria-hidden>·</span>
              <span>
                {activeStep ? "vendo etapa" : "etapa atual"}{" "}
                <span className="text-foreground font-medium">{labelStep}. {stepLabel}</span>
              </span>
            </>
          )}
        </div>
      </div>
      <ProcessoComprasStepper
        activeStep={stepperActiveStep}
        progressStep={progressStep}
        isLoading={isLoading}
        locks={locks}
      />
      <div className="mt-6 pb-24">
        <Outlet />
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Roda typecheck + testes + lint**

Run: `bun run test && bunx tsc --noEmit && bunx eslint src/components/reposicao/ReposicaoSessionLayout.tsx src/components/reposicao/ProcessoComprasStepper.tsx`
Expected: PASS, 0 erros novos.

- [ ] **Step 3: Verificação manual (dev server)**

Run: `bun dev`, logar como staff, ir em `/admin/reposicao/sessao/pedidos`.
Expected:
- Etapa 3 (Pedidos) destacada como "em foco", mesmo que o progresso (dados) esteja em 4/5.
- Clicar etapa 1 (Mercado) ou 2 (Parâmetros) navega e o destaque acompanha.
- Etapa futura travada não navega (botão `disabled`), tooltip explica o motivo no hover.

- [ ] **Step 4: Commit**

```bash
git add src/components/reposicao/ReposicaoSessionLayout.tsx
git commit -m "fix(reposicao): layout passa activeStep da URL ao stepper (resolve 'não consigo voltar')"
```

---

## CAMADA 2 — Breadcrumb global (cobre as 119 páginas)

### Task 4: Registry `ROUTE_CRUMBS` + hook `useBreadcrumbs`

**Files:**
- Create: `src/lib/routeCrumbs.ts`
- Create: `src/hooks/useBreadcrumbs.ts`
- Test: `src/hooks/__tests__/useBreadcrumbs.test.ts`

- [ ] **Step 1: Cria o registry de metadados**

Create `src/lib/routeCrumbs.ts`. Cada entrada é um padrão de rota (sintaxe react-router, ex.: `:id`) com label pt-BR. Começar com um subconjunto representativo; novas rotas adicionam entradas aqui.

```ts
/**
 * Registry de metadados de navegação por rota. Fonte única dos breadcrumbs
 * globais e do "voltar" contextual. Padrões usam sintaxe react-router 6
 * (ex.: "/admin/customers/:id"). A ordem não importa — matchRoutes ranqueia
 * por especificidade.
 *
 * Ao criar uma rota nova em App.tsx, adicione a entrada correspondente aqui.
 * Sem entrada, a rota simplesmente não aparece na trilha (degrada limpo).
 */
export type RouteCrumb = {
  /** padrão de rota (react-router) */
  path: string;
  /** rótulo exibido no breadcrumb (pt-BR) */
  crumb: string;
  /** se setado, página de detalhe/criação ganha botão "voltar" para cá */
  backTo?: string;
  /** rótulo do botão voltar (default: o crumb do pai) */
  backLabel?: string;
};

export const ROUTE_CRUMBS: RouteCrumb[] = [
  { path: "/", crumb: "Dashboard" },

  // Principal
  { path: "/admin/customers", crumb: "Clientes" },
  { path: "/admin/customers/:id", crumb: "Detalhe do cliente", backTo: "/admin/customers", backLabel: "Clientes" },

  // Vendas
  { path: "/sales", crumb: "Pedidos" },
  { path: "/sales/new", crumb: "Novo pedido", backTo: "/sales", backLabel: "Pedidos" },

  // Reposição (sessão)
  { path: "/admin/reposicao/sessao", crumb: "Reposição" },
  { path: "/admin/reposicao/sessao/mercado", crumb: "Mercado" },
  { path: "/admin/reposicao/sessao/parametros", crumb: "Parâmetros" },
  { path: "/admin/reposicao/sessao/pedidos", crumb: "Pedidos" },
  { path: "/admin/reposicao/sessao/aplicacao", crumb: "Aplicação Omie" },
  { path: "/admin/reposicao/sessao/confirmacao", crumb: "Confirmação" },

  // Financeiro
  { path: "/financeiro/cockpit", crumb: "Financeiro" },

  // Estoque
  { path: "/admin/estoque/recebimento", crumb: "Recebimento" },
  { path: "/admin/estoque/picking", crumb: "Picking & Estoque" },
];
```

> Nota de escopo: este é o conjunto inicial (rotas mais usadas). A cobertura das 119 páginas é incremental — cada PR que tocar uma página adiciona sua entrada. O hook degrada limpo (rota sem entrada não aparece).

- [ ] **Step 2: Escreve o teste do matcher (função pura)**

Create `src/hooks/__tests__/useBreadcrumbs.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { resolveBreadcrumbs } from "@/hooks/useBreadcrumbs";

describe("resolveBreadcrumbs", () => {
  it("builds an ancestor trail from the registry for a leaf route", () => {
    const trail = resolveBreadcrumbs("/admin/reposicao/sessao/pedidos");
    expect(trail.map((t) => t.crumb)).toEqual(["Reposição", "Pedidos"]);
    expect(trail[trail.length - 1].isCurrent).toBe(true);
  });

  it("matches dynamic segments (:id)", () => {
    const trail = resolveBreadcrumbs("/admin/customers/abc-123");
    expect(trail.map((t) => t.crumb)).toEqual(["Clientes", "Detalhe do cliente"]);
    expect(trail[trail.length - 1].href).toBe("/admin/customers/abc-123");
  });

  it("returns a single non-clickable crumb for a top-level page", () => {
    const trail = resolveBreadcrumbs("/admin/customers");
    expect(trail).toHaveLength(1);
    expect(trail[0].crumb).toBe("Clientes");
    expect(trail[0].isCurrent).toBe(true);
  });

  it("returns empty for unmapped routes (degrades clean)", () => {
    expect(resolveBreadcrumbs("/rota/inexistente")).toEqual([]);
  });

  it("surfaces backTo/backLabel from the leaf entry", () => {
    const trail = resolveBreadcrumbs("/sales/new");
    const leaf = trail[trail.length - 1];
    expect(leaf.backTo).toBe("/sales");
    expect(leaf.backLabel).toBe("Pedidos");
  });
});
```

- [ ] **Step 3: Roda o teste pra ver falhar**

Run: `bun run test src/hooks/__tests__/useBreadcrumbs.test.ts`
Expected: FAIL — `resolveBreadcrumbs is not exported`.

- [ ] **Step 4: Implementa `resolveBreadcrumbs` + `useBreadcrumbs`**

> **Implementação validada pelo Codex** (que rodou `matchRoutes` real no node): `matchRoutes` contra um array flat de paths absolutos retorna **só o match-folha**, não a cadeia de ancestrais — só monta hierarquia se os route-objects forem aninhados com `children`. A abordagem correta é construir a trilha por **prefixo de segmento**, casando cada prefixo contra o registry com `matchPath({ end: true })` (que lida com `:id` dinâmico). Isso NÃO inclui `/` (Dashboard) em toda trilha, porque os prefixos de `/admin/reposicao/...` são `/admin`, `/admin/reposicao`, ... — nunca `/`.

Create `src/hooks/useBreadcrumbs.ts`:

```ts
import { useLocation, matchPath } from "react-router-dom";
import { ROUTE_CRUMBS, type RouteCrumb } from "@/lib/routeCrumbs";

export type Crumb = {
  crumb: string;
  href: string;
  isCurrent: boolean;
  backTo?: string;
  backLabel?: string;
};

function cleanPath(pathname: string): string {
  return pathname.split("?")[0].replace(/\/+$/, "") || "/";
}

/** Lista de prefixes acumulativos: "/a/b/c" -> ["/a","/a/b","/a/b/c"]. "/" -> ["/"]. */
function prefixesFor(pathname: string): string[] {
  if (pathname === "/") return ["/"];
  const segs = pathname.split("/").filter(Boolean);
  return segs.map((_, i) => `/${segs.slice(0, i + 1).join("/")}`);
}

/** Acha a entrada do registry que casa exatamente este prefixo (com :id dinâmico). */
function matchMeta(prefix: string): RouteCrumb | undefined {
  return ROUTE_CRUMBS.find((meta) => matchPath({ path: meta.path, end: true }, prefix));
}

/**
 * Resolve a trilha hierárquica de breadcrumbs para um pathname. Constrói os
 * prefixos do path e casa cada um contra o registry via matchPath (end:true),
 * que lida com segmentos dinâmicos (:id). Função pura — testável sem Router.
 */
export function resolveBreadcrumbs(pathname: string): Crumb[] {
  const clean = cleanPath(pathname);
  const trail = prefixesFor(clean)
    .map((href) => {
      const meta = matchMeta(href);
      return meta ? { meta, href } : null;
    })
    .filter((x): x is { meta: RouteCrumb; href: string } => x !== null);

  return trail.map(({ meta, href }, i, arr) => {
    const isCurrent = i === arr.length - 1;
    return {
      crumb: meta.crumb,
      href,
      isCurrent,
      backTo: isCurrent ? meta.backTo : undefined,
      backLabel: isCurrent ? meta.backLabel : undefined,
    };
  });
}

export function useBreadcrumbs(): Crumb[] {
  return resolveBreadcrumbs(useLocation().pathname);
}
```

> Por que `matchPath({ end: true })` por prefixo e não `matchRoutes`: confirmado no node que `matchRoutes([{path}], "/admin/customers/abc-123")` casa `:id`, mas em array flat só devolve 1 match. Iterar prefixos + `matchPath` dá a trilha hierárquica completa de forma previsível. Verificar no Step 5 que os 5 testes passam.

- [ ] **Step 5: Roda o teste pra ver passar**

Run: `bun run test src/hooks/__tests__/useBreadcrumbs.test.ts`
Expected: PASS (5/5).

- [ ] **Step 6: Commit**

```bash
git add src/lib/routeCrumbs.ts src/hooks/useBreadcrumbs.ts src/hooks/__tests__/useBreadcrumbs.test.ts
git commit -m "feat(nav): registry de rotas + useBreadcrumbs (matcher puro testado)"
```

---

### Task 5: Componente `GlobalBreadcrumbs`

**Files:**
- Create: `src/components/shell/GlobalBreadcrumbs.tsx`

- [ ] **Step 1: Implementa o componente**

Create `src/components/shell/GlobalBreadcrumbs.tsx`:

> **Bug pego pelo Codex:** `BreadcrumbSeparator` renderiza um `<li>` (`breadcrumb.tsx:62`). Aninhar o separator DENTRO do `<BreadcrumbItem>` (também `<li>`) gera `<li><li></li></li>` — HTML inválido. O separator tem que ser **irmão** do item, não filho. Usar `<Fragment>` e emitir o separator entre itens.

```tsx
import { Fragment } from "react";
import { Link } from "react-router-dom";
import {
  Breadcrumb,
  BreadcrumbList,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "@/components/ui/breadcrumb";
import { useBreadcrumbs } from "@/hooks/useBreadcrumbs";

/**
 * Breadcrumb global, montado UMA vez no AppShell. Renderiza a trilha derivada
 * do registry de rotas (useBreadcrumbs). Fica oculto quando há 0 ou 1 nível
 * (página top-level não precisa de trilha — o sidebar já indica onde está).
 * Uma linha, baixo contraste, denso — não compete com o conteúdo.
 */
export function GlobalBreadcrumbs() {
  const crumbs = useBreadcrumbs();
  if (crumbs.length <= 1) return null;

  return (
    <Breadcrumb className="mb-3">
      <BreadcrumbList>
        {crumbs.map((c, i) => (
          <Fragment key={c.href}>
            <BreadcrumbItem>
              {c.isCurrent ? (
                <BreadcrumbPage>{c.crumb}</BreadcrumbPage>
              ) : (
                <BreadcrumbLink asChild>
                  <Link to={c.href}>{c.crumb}</Link>
                </BreadcrumbLink>
              )}
            </BreadcrumbItem>
            {i < crumbs.length - 1 && <BreadcrumbSeparator />}
          </Fragment>
        ))}
      </BreadcrumbList>
    </Breadcrumb>
  );
}
```

> Nota: `BreadcrumbLink asChild` + `<Link>` mantém navegação SPA (sem reload). O separator é irmão do item (não filho) e só aparece entre itens, nunca depois do último.

- [ ] **Step 2: Roda typecheck + lint**

Run: `bunx tsc --noEmit && bunx eslint src/components/shell/GlobalBreadcrumbs.tsx`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add src/components/shell/GlobalBreadcrumbs.tsx
git commit -m "feat(nav): componente GlobalBreadcrumbs"
```

---

### Task 6: Monta `GlobalBreadcrumbs` no AppShell

**Files:**
- Modify: `src/components/AppShell.tsx` (dentro do `<main>`, antes de `{children}` — por volta da linha 760)

- [ ] **Step 1: Importa e monta**

No topo de `src/components/AppShell.tsx`, adicionar o import:

```tsx
import { GlobalBreadcrumbs } from "@/components/shell/GlobalBreadcrumbs";
```

Localizar o bloco (por volta da linha 760):

```tsx
              <div className="p-4 lg:p-6">
                {children}
              </div>
```

Substituir por:

```tsx
              <div className="p-4 lg:p-6">
                <GlobalBreadcrumbs />
                {children}
              </div>
```

- [ ] **Step 2: Verificação manual (dev server)**

Run: `bun dev`, logar como staff.
Expected:
- `/admin/customers` (top-level): sem breadcrumb (≤1 nível).
- `/admin/reposicao/sessao/pedidos`: trilha "Reposição / Pedidos", "Reposição" clicável (volta pro cockpit), "Pedidos" como página atual.
- Clicar "Reposição" navega sem reload.
- Páginas sem entrada no registry: sem breadcrumb (degrada limpo, nada quebra).

- [ ] **Step 3: Roda build + testes**

Run: `bun run test && bun build:dev`
Expected: PASS, build sem erro.

- [ ] **Step 4: Commit**

```bash
git add src/components/AppShell.tsx
git commit -m "feat(nav): monta GlobalBreadcrumbs no AppShell (cobre todas as páginas mapeadas)"
```

---

## CAMADA 3 — "Voltar" contextual (opt-in por rota)

### Task 7: Botão voltar em páginas de detalhe/criação

**Files:**
- Modify: `src/components/shell/GlobalBreadcrumbs.tsx`

> O registry (`routeCrumbs.ts`) já tem `backTo`/`backLabel` nas entradas de detalhe/criação (Task 4). Aqui só renderizamos o botão quando a folha tiver `backTo`. Sem `navigate(-1)` — usamos um destino explícito (Codex: `navigate(-1)` é imprevisível após deep-link/reload/redirect/command-palette).

- [ ] **Step 1: Adiciona o botão voltar acima da trilha**

Editar `src/components/shell/GlobalBreadcrumbs.tsx` — pegar a folha e, se tiver `backTo`, renderizar um link compacto antes do `<Breadcrumb>`:

```tsx
import { Fragment } from "react";
import { Link } from "react-router-dom";
import { ChevronLeft } from "lucide-react";
import {
  Breadcrumb, BreadcrumbList, BreadcrumbItem, BreadcrumbLink,
  BreadcrumbPage, BreadcrumbSeparator,
} from "@/components/ui/breadcrumb";
import { useBreadcrumbs } from "@/hooks/useBreadcrumbs";

export function GlobalBreadcrumbs() {
  const crumbs = useBreadcrumbs();
  if (crumbs.length === 0) return null;

  const leaf = crumbs[crumbs.length - 1];
  const showBack = !!leaf.backTo;
  if (crumbs.length <= 1 && !showBack) return null;

  return (
    <div className="mb-3 space-y-2">
      {showBack && (
        <Link
          to={leaf.backTo!}
          className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground transition-colors"
        >
          <ChevronLeft className="h-4 w-4" />
          {leaf.backLabel ?? "Voltar"}
        </Link>
      )}
      {crumbs.length > 1 && (
        <Breadcrumb>
          <BreadcrumbList>
            {crumbs.map((c, i) => (
              <Fragment key={c.href}>
                <BreadcrumbItem>
                  {c.isCurrent ? (
                    <BreadcrumbPage>{c.crumb}</BreadcrumbPage>
                  ) : (
                    <BreadcrumbLink asChild>
                      <Link to={c.href}>{c.crumb}</Link>
                    </BreadcrumbLink>
                  )}
                </BreadcrumbItem>
                {i < crumbs.length - 1 && <BreadcrumbSeparator />}
              </Fragment>
            ))}
          </BreadcrumbList>
        </Breadcrumb>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Verificação manual**

Run: `bun dev`.
Expected:
- `/sales/new`: botão "← Pedidos" acima (de `backTo: "/sales"`). Clicar volta pra lista.
- `/admin/customers/<id>`: botão "← Clientes".
- Páginas sem `backTo`: sem botão voltar (só breadcrumb, se houver).

- [ ] **Step 3: Roda testes + lint**

Run: `bun run test && bunx eslint src/components/shell/GlobalBreadcrumbs.tsx`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/components/shell/GlobalBreadcrumbs.tsx
git commit -m "feat(nav): botão voltar contextual via backTo do registry (sem navigate(-1))"
```

---

## Limpeza incremental (pós-merge, fora do caminho crítico)

Não é uma task bloqueante. Conforme tocar páginas que hoje têm "voltar" ad-hoc:
- Remover botões `ChevronLeft`/`ArrowLeft` locais que duplicam o backTo do registry (15 páginas).
- Trocar `navigate(-1)` (5 ocorrências) por destino explícito via registry.
- Adicionar entrada no `ROUTE_CRUMBS` para a rota tocada (cobertura incremental das 119 páginas).
- A folha do `Customer360View` em `AdminCustomers.tsx` tem breadcrumb "← Clientes" inline — pode migrar pro registry quando essa página for tocada.

---

## Self-Review

**Spec coverage (queixa do founder + diagnóstico Codex):**
- "Não consigo voltar entre as 5 etapas" → Tasks 1-3 (activeStep da URL ≠ progressStep dos dados). ✅
- "Lock visual sem bloqueio real" (bug que o Codex achou) → Task 2 Step 4 (`disabled` + early-return). ✅
- "aria-current na etapa errada" → Task 2 (aria-current segue activeStep). ✅
- "Navegação entre páginas além do menu lateral" (app-wide) → Tasks 4-6 (breadcrumb global). ✅
- "Problema em outras telas também" → registry cobre qualquer rota mapeada, montado 1x no shell. ✅
- "Voltar de páginas de detalhe" → Task 7 (backTo contextual, sem navigate(-1)). ✅

**Type consistency:** `deriveActiveStep`/`REPOSICAO_STEP_PATHS` (Task 1) consumidos em Tasks 2-3. `RouteCrumb`/`ROUTE_CRUMBS` (Task 4) consumidos por `useBreadcrumbs` (Task 4) → `GlobalBreadcrumbs` (Task 5) → AppShell (Task 6) → backTo (Task 7). `Crumb` type estável entre hook e componente. Props do stepper (`activeStep`/`progressStep`) batem entre Task 2 (definição) e Task 3 (uso). ✅

**Placeholder scan:** sem TBD/TODO; todo step tem código real ou comando com expected output. A ambiguidade que existia no Task 4 Step 4 (duas implementações de `resolveBreadcrumbs`) foi **resolvida** após o review do Codex — agora há uma única implementação validada (`matchPath` por prefixo). ✅

**Risco/ordem:** Camada 1 é independente e resolve a queixa imediata (entregável sozinha). Camada 2 depende só de si. Camada 3 depende da 2. Recomendo PR separado por camada.

## Review adversarial do Codex (sessão 019e5c1c, 2026-05-24)

Verdict: **SHIP WITH FIXES**. 6 blockers + 1 nit, todos incorporados acima:

1. **Matcher do breadcrumb (Task 4):** `matchRoutes` em array flat só devolve o match-folha (confirmado por teste real no node). Trocado pela versão `matchPath({ end: true })` por prefixo — não inclui `/` em toda trilha. ✅
2. **HTML inválido (Tasks 5/7):** `<BreadcrumbSeparator>` (um `<li>`) estava aninhado dentro de `<BreadcrumbItem>` (outro `<li>`). Trocado por `<Fragment>` + separator irmão. ✅
3. **Lock do stepper (Task 2):** native `<button disabled>` quebra tooltip + foco de teclado. Trocado por `aria-disabled` + early-return (bloqueio real, mantém focável). ✅
4. **Cockpit index (Task 3):** com `activeStep=0` o stepper ficaria sem destaque enquanto o ContinuarBanner diz "etapa X". Index agora destaca `progressStep`. ✅
5. **Marcador de progresso (Task 2):** lógica booleana deixava a etapa de progresso sem estilo ao navegar pra trás. Separados `isActive`/`isProgress`/`isDone`/`isFuture`. ✅
6. **Escopo "119 páginas" (Goal):** honestado pra "infra + primeiras rotas mapeadas, cobertura incremental". ✅
7. **Nit (Task 1):** estender o import existente do teste em vez de adicionar um segundo. ✅
