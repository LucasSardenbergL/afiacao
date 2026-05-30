# Gate de Rotas Staff — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Impedir que um usuário `customer` aprovado alcance rotas administrativas via deep-link, adicionando um guard `RequireStaff` (default-deny) na árvore de rotas.

**Architecture:** Novo layout-route `RequireStaff` (gêmeo do `RequireFinanceiroAccess` existente), que renderiza `<Outlet/>` para staff e um Card "Área restrita à equipe" para o resto. O `App.tsx` é reorganizado em 3 grupos irmãos sob o `ProtectedRoute` que já existe: customer-facing (15, diretas), `/financeiro/*` (guard próprio, intocado), e todo o resto dentro do `RequireStaff`. Nenhuma página muda; nenhuma URL muda (wrapper pathless). RLS no backend não é tocada — isto é hardening de UX/superfície.

**Tech Stack:** React 18 + react-router-dom v6 (layout routes / `<Outlet/>`), TypeScript, vitest + @testing-library/react, shadcn/ui (Card/Button), lucide-react.

**Spec:** [docs/superpowers/specs/2026-05-30-gate-rotas-staff-design.md](../specs/2026-05-30-gate-rotas-staff-design.md)

---

## File Structure

- **Create** `src/components/RequireStaff.tsx` — o guard. Layout-route: `isStaff` → `<Outlet/>`; senão tela de bloqueio; trata `loading`. Responsabilidade única: gatear a subárvore de staff.
- **Create** `src/components/__tests__/RequireStaff.test.tsx` — 3 casos (loading, customer bloqueado, staff liberado). Espelha `RequireFinanceiroAccess.test.tsx`.
- **Modify** `src/App.tsx` — adicionar import do `RequireStaff` e reorganizar o bloco de rotas autenticadas em 3 grupos.
- **Modify** `src/pages/Gamification.tsx` (linhas 27 e 49) — fix do bug pré-existente `/orders/new` → `/new-order`.

---

## Task 1: Criar o componente `RequireStaff` (TDD)

**Files:**
- Create: `src/components/RequireStaff.tsx`
- Test: `src/components/__tests__/RequireStaff.test.tsx`

Referências vivas (ler antes de começar): `src/components/RequireFinanceiroAccess.tsx` (o componente-modelo) e `src/components/__tests__/RequireFinanceiroAccess.test.tsx` (o teste-modelo). O `RequireStaff` é mais simples — não tem a query `fin_permissoes`, só lê `isStaff`/`loading` do `useAuth()`.

- [ ] **Step 1: Escrever o teste que falha**

Create `src/components/__tests__/RequireStaff.test.tsx`:

```tsx
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { RequireStaff } from '../RequireStaff';
import { useAuth } from '@/contexts/AuthContext';

vi.mock('@/contexts/AuthContext', () => ({ useAuth: vi.fn() }));

const mockUseAuth = vi.mocked(useAuth);

function renderGuard() {
  return render(
    <MemoryRouter initialEntries={['/admin']}>
      <Routes>
        <Route element={<RequireStaff />}>
          <Route path="/admin" element={<div>CONTEUDO STAFF</div>} />
        </Route>
      </Routes>
    </MemoryRouter>,
  );
}

describe('RequireStaff', () => {
  beforeEach(() => vi.clearAllMocks());

  it('mostra spinner enquanto loading (não bloqueia antes do role resolver)', () => {
    mockUseAuth.mockReturnValue({ isStaff: false, loading: true } as unknown as ReturnType<typeof useAuth>);
    const { container } = renderGuard();
    expect(container.querySelector('.animate-spin')).toBeTruthy();
    expect(screen.queryByText('CONTEUDO STAFF')).toBeNull();
    expect(screen.queryByText('Área restrita à equipe')).toBeNull();
  });

  it('bloqueia customer (loading=false, isStaff=false)', () => {
    mockUseAuth.mockReturnValue({ isStaff: false, loading: false } as unknown as ReturnType<typeof useAuth>);
    renderGuard();
    expect(screen.getByText('Área restrita à equipe')).toBeTruthy();
    expect(screen.queryByText('CONTEUDO STAFF')).toBeNull();
  });

  it('libera staff (loading=false, isStaff=true)', () => {
    mockUseAuth.mockReturnValue({ isStaff: true, loading: false } as unknown as ReturnType<typeof useAuth>);
    renderGuard();
    expect(screen.getByText('CONTEUDO STAFF')).toBeTruthy();
  });
});
```

- [ ] **Step 2: Rodar o teste e verificar que falha**

Run: `heavy bunx vitest run src/components/__tests__/RequireStaff.test.tsx`
Expected: FAIL — erro de resolução de módulo (`Failed to resolve import "../RequireStaff"` / "Cannot find module"), pois o componente ainda não existe.

- [ ] **Step 3: Criar o componente mínimo que passa**

Create `src/components/RequireStaff.tsx`:

```tsx
import { Link, Outlet } from 'react-router-dom';
import { Loader2, Lock } from 'lucide-react';
import { useAuth } from '@/contexts/AuthContext';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';

/**
 * Defesa em profundidade da superfície de staff. O ProtectedRoute só checa
 * auth+aprovação (não role), então sem este guard um customer logado alcança
 * rotas administrativas pela URL (deep-link/bookmark). Libera staff
 * (employee/master); bloqueia o resto com uma tela clara. O gate real continua
 * no banco (RLS) — isto é UX + redução de superfície, não a barreira primária.
 * Espelha o padrão de RequireFinanceiroAccess (sem a query de fin_permissoes).
 */
export const RequireStaff = () => {
  const { isStaff, loading } = useAuth();

  // Não decide antes do role resolver — senão pisca bloqueio / falso-negativo no refresh.
  if (loading) {
    return (
      <div className="min-h-[60vh] flex items-center justify-center">
        <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (!isStaff) {
    return (
      <div className="min-h-[60vh] flex items-center justify-center p-4">
        <Card className="max-w-md w-full">
          <CardContent className="pt-6 text-center space-y-4">
            <div className="mx-auto w-16 h-16 rounded-full bg-status-warning-bg flex items-center justify-center">
              <Lock className="w-8 h-8 text-status-warning" />
            </div>
            <h2 className="text-xl font-bold">Área restrita à equipe</h2>
            <p className="text-muted-foreground">
              Esta área é exclusiva para a equipe Colacor. Se você precisa de
              acesso, fale com um administrador.
            </p>
            <Button asChild variant="outline" className="w-full">
              <Link to="/">Voltar ao início</Link>
            </Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  return <Outlet />;
};
```

- [ ] **Step 4: Rodar o teste e verificar que passa**

Run: `heavy bunx vitest run src/components/__tests__/RequireStaff.test.tsx`
Expected: PASS — 3 testes passando.

- [ ] **Step 5: Commit**

```bash
git add src/components/RequireStaff.tsx src/components/__tests__/RequireStaff.test.tsx
git commit -m "feat(auth): adiciona guard RequireStaff (default-deny p/ rotas de equipe)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: Reorganizar `App.tsx` em 3 grupos de rotas

**Files:**
- Modify: `src/App.tsx` (import perto da linha 15; bloco de rotas autenticadas ~linhas 206–363)

Esta task move rotas existentes para dentro do `<RequireStaff>` sem alterar nenhum `path` nem `element`. O wrapper é um **pathless layout route**, então nenhuma URL muda. Não há teste unitário novo (renderizar o `App` inteiro exigiria mockar dezenas de páginas lazy + Supabase, custo desproporcional para um wrapper trivial — o spec define verificação por typecheck/build + smoke manual; ver Task 4). A verificação automática desta task é o **typecheck + build passando** e a **contagem de rotas idêntica** antes/depois.

- [ ] **Step 1: Contar as rotas ANTES (baseline para conferência)**

Run: `grep -cE '<Route ' src/App.tsx`
Anote o número (deve ser o total de `<Route ` no arquivo). Após o Step 3, o mesmo comando deve retornar **esse número + 1** (o único `<Route>` adicionado é o wrapper `<Route element={<RequireStaff />}>`; os 2 wrappers que já existem — RequireFinanceiroAccess e ReposicaoSessionLayout — permanecem).

- [ ] **Step 2: Adicionar o import do `RequireStaff`**

Em `src/App.tsx`, logo abaixo da linha `import { RequireFinanceiroAccess } from "@/components/RequireFinanceiroAccess";` (linha 15), adicione:

```tsx
import { RequireStaff } from "@/components/RequireStaff";
```

- [ ] **Step 3: Substituir o bloco de rotas autenticadas**

Localize o bloco que começa em `<Route element={<ProtectedRoute><AppShellLayout /></ProtectedRoute>}>` e termina no `</Route>` imediatamente antes de `<Route path="*" element={<NotFound />} />`. Substitua **todo o conteúdo entre a tag de abertura e a de fechamento** por exatamente o JSX abaixo (a tag de abertura `<Route element={<ProtectedRoute><AppShellLayout /></ProtectedRoute>}>` e o `</Route>` de fechamento permanecem). Cada rota abaixo é idêntica à original — só foram regrupadas.

```tsx
              {/* ── Customer-facing: abertas a qualquer usuário aprovado (self-scoped ao user.id) ── */}
              <Route index element={<Index />} />
              <Route path="orders" element={<Orders />} />
              <Route path="orders/:id" element={<OrderDetail />} />
              <Route path="new-order" element={<UnifiedOrder />} />
              <Route path="profile" element={<Profile />} />
              <Route path="addresses" element={<Addresses />} />
              <Route path="tools" element={<Tools />} />
              <Route path="tools/:toolId" element={<ToolHistory />} />
              <Route path="tools/:toolId/reports" element={<ToolReports />} />
              <Route path="support" element={<Support />} />
              <Route path="recurring-schedules" element={<RecurringSchedules />} />
              <Route path="savings" element={<SavingsDashboard />} />
              <Route path="loyalty" element={<Loyalty />} />
              <Route path="gamification" element={<Gamification />} />
              <Route path="training" element={<Training />} />

              {/* ── Financeiro: guard PRÓPRIO (libera staff OU fin_permissoes) — irmão, NÃO dentro do RequireStaff ── */}
              <Route element={<RequireFinanceiroAccess />}>
                <Route path="financeiro" element={<FinanceiroDashboard />} />
                <Route path="financeiro/sync" element={<FinanceiroSync />} />
                <Route path="financeiro/mapping" element={<FinanceiroMapping />} />
                <Route path="financeiro/capital-giro" element={<FinanceiroCapitalGiro />} />
                <Route path="financeiro/fechamento" element={<FinanceiroFechamento />} />
                <Route path="financeiro/analytics" element={<FinanceiroAnalytics />} />
                <Route path="financeiro/cockpit" element={<FinanceiroCockpit />} />
                <Route path="financeiro/conciliacao" element={<FinanceiroConciliacao />} />
                <Route path="financeiro/orcamento" element={<FinanceiroOrcamento />} />
                <Route path="financeiro/intercompany" element={<FinanceiroIntercompany />} />
                <Route path="financeiro/intercompany/fila" element={<FinanceiroIntercompanyFila />} />
                <Route path="financeiro/tributario" element={<FinanceiroTributario />} />
                <Route path="financeiro/valor" element={<FinanceiroValor />} />
                <Route path="financeiro/valor-cockpit" element={<FinanceiroValorCockpit />} />
                <Route path="financeiro/proxima-acao" element={<FinanceiroProximaAcao />} />
                <Route path="financeiro/regime-tributario" element={<FinanceiroRegimeTributario />} />
                <Route path="financeiro/funding" element={<FinanceiroFunding />} />
                <Route path="financeiro/gestao" element={<FinanceiroGestao />} />
                <Route path="financeiro/analise" element={<FinanceiroAnalise />} />
              </Route>

              {/* ── Staff-only: default-deny. Todo o resto exige employee/master ── */}
              <Route element={<RequireStaff />}>
                <Route path="admin" element={<Admin />} />
                <Route path="admin/approvals" element={<AdminApprovals />} />
                <Route path="admin/departments" element={<AdminDepartments />} />
                <Route path="admin/customers" element={<AdminCustomers />} />
                <Route path="admin/customers/:customerId" element={<AdminCustomers />} />
                <Route path="admin/customers/:customerId/360" element={<Customer360 />} />
                <Route path="admin/orders/:id" element={<AdminOrderDetail />} />
                <Route path="admin/orders/:id/quality" element={<QualityChecklist />} />
                <Route path="admin/demand-forecast" element={<AdminDemandForecast />} />
                <Route path="admin/route-planner" element={<AdminRoutePlanner />} />
                <Route path="admin/monthly-reports" element={<AdminMonthlyReports />} />
                <Route path="admin/productivity" element={<AdminProductivity />} />
                <Route path="admin/loyalty" element={<AdminLoyalty />} />
                <Route path="admin/gamification" element={<AdminGamification />} />
                <Route path="admin/training" element={<AdminTraining />} />
                <Route path="admin/price-table" element={<AdminPriceTable />} />
                <Route path="admin/analytics-sync" element={<AdminAnalyticsSync />} />
                <Route path="admin/clientes-nao-vinculados" element={<ClientesNaoVinculados />} />
                <Route path="sales" element={<SalesOrders />} />
                <Route path="sales/products" element={<SalesProducts />} />
                <Route path="sales/new" element={<UnifiedOrder />} />
                <Route path="sales/print" element={<SalesPrintDashboard />} />
                <Route path="sales/quotes" element={<SalesQuotes />} />
                <Route path="sales/edit/:id" element={<SalesOrderEdit />} />
                <Route path="unified-order" element={<Navigate to="/sales/new" replace />} />
                <Route path="farmer" element={<FarmerDashboard />} />
                <Route path="meu-dia" element={<MeuDia />} />
                <Route path="farmer/calls" element={<FarmerCalls />} />
                <Route path="farmer/calls/pending-link" element={<FarmerCallsPendingLink />} />
                <Route path="farmer/governance" element={<FarmerGovernance />} />
                <Route path="farmer/recommendations" element={<FarmerRecommendations />} />
                <Route path="farmer/locc" element={<FarmerLOCC />} />
                <Route path="farmer/bundles" element={<FarmerBundles />} />
                <Route path="farmer/copilot" element={<FarmerCopilot />} />
                <Route path="farmer/tactical-plan" element={<FarmerTacticalPlan />} />
                <Route path="farmer/ipf" element={<FarmerIPFDashboard />} />
                <Route path="executive/dashboard" element={<ExecutiveDashboard />} />
                <Route path="design-system" element={<DesignSystem />} />
                <Route path="design-preview" element={<DesignPreview />} />
                <Route path="ux-rules" element={<UXRules />} />
                <Route path="coaching" element={<CoachingSPIN />} />
                <Route path="settings" element={<SettingsConfig />} />
                <Route path="docs" element={<TechnicalDocs />} />
                <Route path="intelligence" element={<IntelligenceDashboard />} />
                <Route path="governance/users" element={<GovernanceUsers />} />
                <Route path="governance/permissions" element={<GovernancePermissions />} />
                <Route path="governance/math" element={<GovernanceMathParams />} />
                <Route path="governance/audit" element={<GovernanceAudit />} />
                <Route path="governance/settings" element={<GovernanceSettings />} />
                <Route path="governance/companies" element={<GovernanceCompanies />} />
                <Route path="ai-ops" element={<AIops />} />
                <Route path="nfe-receipt" element={<NfeReceipt />} />
                <Route path="tintometrico" element={<TintDashboard />} />
                <Route path="tintometrico/importar" element={<TintImport />} />
                <Route path="tintometrico/mapeamento" element={<TintMapping />} />
                <Route path="tintometrico/precos" element={<TintPricing />} />
                <Route path="tintometrico/formulas" element={<TintFormulas />} />
                <Route path="tintometrico/corantes" element={<TintCorantes />} />
                <Route path="tintometrico/integracoes" element={<TintIntegrations />} />
                <Route path="tintometrico/reconciliacao" element={<TintReconciliation />} />
                <Route path="tintometrico/sync-runs" element={<TintSyncRuns />} />
                <Route path="tintometrico/api-contract" element={<TintApiContract />} />
                <Route path="recebimento" element={<Recebimento />} />
                <Route path="recebimento/:id" element={<RecebimentoConferencia />} />
                <Route path="producao" element={<ProductionOrders />} />
                <Route path="admin/reposicao/revisao" element={<AdminReposicaoRevisao />} />
                <Route path="admin/reposicao/historico" element={<AdminReposicaoHistorico />} />
                <Route path="admin/reposicao/alertas" element={<AdminReposicaoAlertas />} />
                <Route path="admin/reposicao/aplicacao" element={<Navigate to="/admin/reposicao/sessao/aplicacao" replace />} />
                <Route path="admin/reposicao/grupos-producao" element={<AdminReposicaoGruposProducao />} />
                <Route path="admin/reposicao/cadeia-logistica" element={<AdminReposicaoCadeiaLogistica />} />
                <Route path="admin/reposicao/pedidos" element={<AdminReposicaoPedidos />} />
                <Route path="admin/sku-mapeamento" element={<AdminSkuMapeamento />} />
                <Route path="admin/reposicao/sla-fornecedor" element={<AdminReposicaoSlaFornecedor />} />
                <Route path="admin/reposicao/promocoes" element={<AdminReposicaoPromocoes />} />
                <Route path="admin/reposicao/promocoes/novo" element={<AdminReposicaoPromocaoDetail />} />
                <Route path="admin/reposicao/promocoes/:id" element={<AdminReposicaoPromocaoDetail />} />
                <Route path="admin/reposicao/aumentos" element={<AdminReposicaoAumentos />} />
                <Route path="admin/reposicao/aumentos/novo" element={<AdminReposicaoAumentoDetail />} />
                <Route path="admin/reposicao/aumentos/:id" element={<AdminReposicaoAumentoDetail />} />
                <Route path="admin/reposicao/oportunidades" element={<AdminReposicaoOportunidades />} />
                <Route path="admin/reposicao/negociacao-paralela" element={<AdminReposicaoNegociacaoParalela />} />
                {/* Canonical /sessao routes (inside ReposicaoSessionLayout) */}
                <Route element={<ReposicaoSessionLayout />}>
                  <Route path="admin/reposicao/sessao" element={<AdminReposicaoCockpit />} />
                  <Route path="admin/reposicao/sessao/mercado" element={<AdminReposicaoMercado />} />
                  <Route path="admin/reposicao/sessao/parametros" element={<AdminReposicaoParametros />} />
                  <Route path="admin/reposicao/sessao/pedidos" element={<AdminReposicaoSessaoPedidos />} />
                  <Route path="admin/reposicao/sessao/aplicacao" element={<AdminReposicaoSessaoAplicacao />} />
                  <Route path="admin/reposicao/sessao/confirmacao" element={<AdminReposicaoSessaoConfirmacao />} />
                  <Route path="admin/reposicao/sessao/historico" element={<AdminReposicaoSessaoHistorico />} />
                </Route>
                {/* Legacy redirects */}
                <Route path="admin/reposicao/cockpit" element={<LegacyCockpitRedirect />} />
                <Route path="admin/reposicao/mercado" element={<Navigate to="/admin/reposicao/sessao/mercado" replace />} />
                <Route path="admin/reposicao/parametros" element={<Navigate to="/admin/reposicao/sessao/parametros" replace />} />
                <Route path="admin/reposicao/cadastros" element={<AdminReposicaoCadastros />} />
                <Route path="admin/estoque/recebimento" element={<AdminEstoqueRecebimento />} />
                <Route path="admin/estoque/picking" element={<AdminEstoquePicking />} />
                <Route path="admin/estoque/picking/mobile" element={<TouchPickingView />} />
                <Route path="tintometrico/catalogo" element={<TintCatalogo />} />
                <Route path="tintometrico/integracao" element={<TintIntegracao />} />
                <Route path="performance" element={<PerformanceHub />} />
                <Route path="vendas/ferramentas" element={<VendasFerramentas />} />
                <Route path="gestao/admin" element={<GestaoAdmin />} />
                <Route path="gestao/governanca" element={<GestaoGovernanca />} />
                <Route path="gestao/saude-dados" element={<SaudeDados />} />
                <Route path="admin/ajuda" element={<AdminAjuda />} />
                <Route path="admin/des/trimestre-atual" element={<AdminDesTrimestreAtual />} />
                <Route path="admin/notificacoes" element={<AdminNotificacoes />} />
                <Route path="admin/portal-sayerlack" element={<AdminPortalSayerlack />} />
                <Route path="admin/sip-credentials" element={<AdminVendorSipCredentials />} />
                <Route path="admin/knowledge-base" element={<AdminKnowledgeBase />} />
                <Route path="admin/knowledge-base/:id" element={<AdminKnowledgeBaseDetail />} />
                <Route path="admin/standard-processes" element={<AdminStandardProcesses />} />
                <Route path="admin/standard-processes/new" element={<AdminStandardProcessNew />} />
                <Route path="admin/standard-processes/:id" element={<AdminStandardProcessDetail />} />
                <Route path="admin/calculadora" element={<AdminCalculadora />} />
                <Route path="telefonia" element={<Telefonia />} />
                <Route path="whatsapp" element={<WhatsappInbox />} />
              </Route>
```

- [ ] **Step 4: Conferir contagem de rotas e ausência de duplicatas**

Run: `grep -cE '<Route ' src/App.tsx`
Expected: o número do Step 1 **+ 1** (só o wrapper `<RequireStaff>` foi adicionado).

Run: `grep -oE 'path="[^"]+"' src/App.tsx | sort | uniq -d`
Expected: **vazio** (nenhum path duplicado — confirma que nenhuma rota foi copiada por engano nem deixada para trás).

- [ ] **Step 5: Typecheck e build**

Run: `heavy bun run typecheck:strict && heavy bunx tsc --noEmit -p tsconfig.app.json`
Expected: 0 erros.

Run: `heavy bun build`
Expected: build conclui sem erro.

- [ ] **Step 6: Commit**

```bash
git add src/App.tsx
git commit -m "feat(auth): gateia rotas administrativas sob RequireStaff (default-deny)

15 rotas customer-facing ficam diretas; /financeiro/* segue com guard
próprio (irmão, mais permissivo); todo o resto exige staff. Paths e
elements inalterados — wrapper pathless, nenhuma URL muda.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: Fix do bug pré-existente `/orders/new` → `/new-order` (Gamification)

**Files:**
- Modify: `src/pages/Gamification.tsx` (linhas 27 e 49)

`/orders/new` não existe na árvore de rotas (a correta é `/new-order`). Hoje o pilar "Organização" da gamificação leva o cliente a um `NotFound`. Duas ocorrências: `PILLAR_CONFIG` (linha 27) e `PILLAR_ACTIONS` (linha 49).

- [ ] **Step 1: Corrigir as duas ocorrências**

Em `src/pages/Gamification.tsx`, troque `route: '/orders/new'` por `route: '/new-order'` nas duas linhas. Comando determinístico:

```bash
sed -i '' "s#route: '/orders/new'#route: '/new-order'#g" src/pages/Gamification.tsx
```

- [ ] **Step 2: Verificar que não sobrou nenhuma ocorrência**

Run: `grep -n "/orders/new" src/pages/Gamification.tsx`
Expected: **vazio** (nenhuma linha).

Run: `grep -cn "route: '/new-order'" src/pages/Gamification.tsx`
Expected: `2`.

- [ ] **Step 3: Lint do arquivo**

Run: `heavy bunx eslint src/pages/Gamification.tsx`
Expected: sem novos erros.

- [ ] **Step 4: Commit**

```bash
git add src/pages/Gamification.tsx
git commit -m "fix(gamificacao): corrige rota inexistente /orders/new -> /new-order

O pilar 'Organização' apontava para /orders/new (NotFound). Rota correta
é /new-order (wizard de pedido do cliente).

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: Verificação final (CI gates + smoke manual)

**Files:** nenhum (verificação)

- [ ] **Step 1: Rodar a suíte completa de testes**

Run: `heavy bun run test`
Expected: todos os testes passando (inclusive os 3 novos de `RequireStaff`). Confirme que nenhum teste existente quebrou.

- [ ] **Step 2: Rodar os gates do CI localmente**

Run: `heavy bun run typecheck:strict && heavy bunx tsc --noEmit -p tsconfig.app.json && heavy bun build && heavy bun lint`
Expected: todos verdes (lint pode ter warnings `react-hooks/exhaustive-deps` pré-existentes — não bloqueiam; 0 *errors*).

- [ ] **Step 3: Smoke manual no navegador real (founder)**

> ⚠️ O `/browse` headless **não renderiza esta SPA** (CLAUDE.md §5) — o smoke de UI é no Chrome real do founder. Documente este checklist na descrição do PR para o founder validar:

Logado como **customer** aprovado, abrir por deep-link (digitar a URL):
- `/admin/customers/<algum-id>/360` → deve ver **"Área restrita à equipe"** (não a tela do Customer 360).
- `/admin/route-planner` → **"Área restrita à equipe"**.
- `/sales/new` → **"Área restrita à equipe"**.
- `/settings` → **"Área restrita à equipe"**.
- `/new-order` → **abre normal** (wizard de OS modo cliente).
- `/orders`, `/tools`, `/gamification`, `/loyalty` → **abrem normais** (dados do próprio cliente).
- No `/gamification`, clicar no pilar **"Organização"** → vai para `/new-order` (não mais NotFound).

Logado como **staff** (employee/master):
- `/admin/customers`, `/sales`, `/financeiro/cockpit`, `/admin/route-planner` → **todas abrem normais**.

- [ ] **Step 4: Integrar o branch**

Seguir o fluxo de merge do repo (CLAUDE.md §10): abrir PR com `gh pr merge --squash --auto` após o check `validate` passar. **Não** usar `--admin`. Incluir no corpo do PR o checklist de smoke do Step 3 e a nota "hardening de UX, RLS inalterada".

---

## Self-Review (preenchido pelo autor do plano)

**Spec coverage:**
- §3.1 default-deny → Task 2 (3 grupos, staff no `RequireStaff`). ✓
- §3.2 binário staff → Task 1 (guard só lê `isStaff`). ✓
- §3.3 `/new-order` aberta · `/settings` staff → Task 2 (new-order no grupo customer; settings no `RequireStaff`). ✓
- §3.4 financeiro irmão → Task 2 (bloco `RequireFinanceiroAccess` separado, não aninhado). ✓
- §4.1 componente (loading/fail-closed/saída clara) → Task 1 (3 testes cobrem loading, bloqueio, liberação). ✓
- §4.2 reorganização sem mudar paths → Task 2 (paths verbatim; check de duplicatas + contagem). ✓
- §5 classificação (15 customer / financeiro / ~95 staff) → Task 2 JSX completo. ✓
- §6 fix `/orders/new` → Task 3. ✓
- §8 estratégia de teste → Task 1 (unit, espelha template) + Task 4 (smoke manual). ✓

**Placeholder scan:** Nenhum TODO/TBD; todo código está completo (componente, 3 testes, JSX inteiro do App, sed do fix). ✓

**Type consistency:** `RequireStaff` (mesmo nome no componente, import, JSX e teste); `isStaff`/`loading` consistentes com `useAuth()` (AuthContext). Nomes de componentes de página no JSX da Task 2 são verbatim dos imports já existentes no `App.tsx`. ✓
