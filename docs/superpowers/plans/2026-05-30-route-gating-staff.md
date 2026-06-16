# Gating de rota por staff (`RequireStaff`) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Impedir que um customer aprovado alcance telas de staff por deep-link, com um gate `RequireStaff` fail-closed nas rotas administrativas, sem quebrar as rotas que o cliente usa.

**Architecture:** Novo componente `RequireStaff` (guard com `<Outlet/>`, espelha o `RequireFinanceiroAccess` existente; não-staff → `<Navigate to="/" />`). O `<Routes>` do `App.tsx` é reorganizado em 3 grupos: **abertas** (cliente+staff), **financeiro** (mantém `RequireFinanceiroAccess`), e **staff** (todo o resto sob `RequireStaff`). Default-deny: o que não está no grupo aberto/financeiro exige staff.

**Tech Stack:** React 18 + react-router-dom 6 + TypeScript, vitest + @testing-library/react. Spec: `docs/superpowers/specs/2026-05-30-route-gating-staff-design.md`. **Front puro — sem backend/SQL/migration.**

---

## File Structure

| Arquivo | Responsabilidade | Ação |
| --- | --- | --- |
| `src/components/RequireStaff.tsx` | Guard de rota staff-only (`<Outlet/>` ou redirect) | Criar |
| `src/components/__tests__/RequireStaff.test.tsx` | Testes do guard (3 estados) | Criar |
| `src/App.tsx` | Reorganizar o `<Routes>` em 3 grupos + importar `RequireStaff` | Modificar |

**Validações (CLAUDE.md §2/§13):** `heavy bun run test` · `heavy bunx tsc --noEmit -p tsconfig.app.json` · `bun lint`. Prefixo `heavy` obrigatório.

---

## Task 1: Componente `RequireStaff` (TDD)

**Files:**
- Create: `src/components/RequireStaff.tsx`
- Test: `src/components/__tests__/RequireStaff.test.tsx`

- [ ] **Step 1: Escrever o teste que falha**

Criar `src/components/__tests__/RequireStaff.test.tsx`:
```tsx
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { RequireStaff } from '../RequireStaff';

const mockUseAuth = vi.fn();
vi.mock('@/contexts/AuthContext', () => ({ useAuth: () => mockUseAuth() }));

function renderAtStaffRoute() {
  return render(
    <MemoryRouter initialEntries={['/staff']}>
      <Routes>
        <Route path="/" element={<div>HOME</div>} />
        <Route element={<RequireStaff />}>
          <Route path="/staff" element={<div>STAFF AREA</div>} />
        </Route>
      </Routes>
    </MemoryRouter>,
  );
}

describe('RequireStaff', () => {
  it('loading → spinner (não mostra a área nem o home)', () => {
    mockUseAuth.mockReturnValue({ isStaff: false, loading: true });
    renderAtStaffRoute();
    expect(screen.queryByText('STAFF AREA')).toBeNull();
    expect(screen.queryByText('HOME')).toBeNull();
  });

  it('isStaff=true → renderiza a área (Outlet)', () => {
    mockUseAuth.mockReturnValue({ isStaff: true, loading: false });
    renderAtStaffRoute();
    expect(screen.getByText('STAFF AREA')).toBeTruthy();
  });

  it('isStaff=false (customer) → redireciona pra / (HOME)', () => {
    mockUseAuth.mockReturnValue({ isStaff: false, loading: false });
    renderAtStaffRoute();
    expect(screen.getByText('HOME')).toBeTruthy();
    expect(screen.queryByText('STAFF AREA')).toBeNull();
  });
});
```

- [ ] **Step 2: Rodar e confirmar que falha**

Run: `heavy bun run test src/components/__tests__/RequireStaff.test.tsx`
Expected: FAIL (`RequireStaff` não existe / não é exportado).

- [ ] **Step 3: Implementar o componente**

Criar `src/components/RequireStaff.tsx`:
```tsx
import { Navigate, Outlet } from 'react-router-dom';
import { Loader2 } from 'lucide-react';
import { useAuth } from '@/contexts/AuthContext';

/**
 * Gate de rota: só staff (isAdmin || isEmployee || isMaster) passa.
 * Não-staff (customer) é redirecionado pra '/' (cai no CustomerDashboard).
 * Fail-closed: se o role falhou ao carregar, isStaff=false → redirect (seguro).
 * O '/' fica FORA deste gate, então não há loop de redirect.
 */
export const RequireStaff = () => {
  const { isStaff, loading } = useAuth();

  if (loading) {
    return (
      <div className="min-h-[60vh] flex items-center justify-center">
        <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
      </div>
    );
  }
  if (!isStaff) return <Navigate to="/" replace />;
  return <Outlet />;
};
```

- [ ] **Step 4: Rodar e confirmar que passa**

Run: `heavy bun run test src/components/__tests__/RequireStaff.test.tsx`
Expected: PASS (3/3).

- [ ] **Step 5: Typecheck + lint**

Run: `heavy bunx tsc --noEmit -p tsconfig.app.json` → 0 erros.
Run: `bun lint` → sem novos errors.

- [ ] **Step 6: Commit**
```bash
git add src/components/RequireStaff.tsx src/components/__tests__/RequireStaff.test.tsx
git commit -m "feat(auth): componente RequireStaff (gate de rota staff-only, fail-closed)"
```

---

## Task 2: Reorganizar o `<Routes>` do `App.tsx` em 3 grupos

**Files:**
- Modify: `src/App.tsx` (import + o bloco `<Route element={<ProtectedRoute><AppShellLayout /></ProtectedRoute>}>`, linhas ~206-363)

Contexto: hoje as rotas são irmãs planas (cliente e staff interlaçadas na ordem do arquivo); o `financeiro/*` já está aninhado sob `<Route element={<RequireFinanceiroAccess />}>` (linhas ~284-304); o `admin/reposicao/sessao/*` sob `<Route element={<ReposicaoSessionLayout />}>` (~326-334). A reordenação é segura: o react-router v6 casa por **especificidade de path**, não por ordem no arquivo (o único sensível à ordem é o catch-all `*`, que fica fora e por último).

- [ ] **Step 1: Importar `RequireStaff`**

No topo de `src/App.tsx`, adicionar (junto dos outros imports de `@/components`):
```ts
import { RequireStaff } from '@/components/RequireStaff';
```

- [ ] **Step 2: Substituir o bloco do AppShell VERBATIM**

Localizar o bloco que começa em `<Route element={<ProtectedRoute><AppShellLayout /></ProtectedRoute>}>` e termina no `</Route>` correspondente (logo antes de `<Route path="*" element={<NotFound />} />`). Substituir o bloco INTEIRO por:

```tsx
            <Route element={<ProtectedRoute><AppShellLayout /></ProtectedRoute>}>
              {/* ─── Abertas (cliente + staff) — sem RequireStaff ─── */}
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
              <Route path="admin/calculadora" element={<AdminCalculadora />} />

              {/* ─── Financeiro (gate próprio: permite não-staff com permissão) ─── */}
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

              {/* ─── Staff-only (fail-closed: todo o resto) ─── */}
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
                <Route element={<ReposicaoSessionLayout />}>
                  <Route path="admin/reposicao/sessao" element={<AdminReposicaoCockpit />} />
                  <Route path="admin/reposicao/sessao/mercado" element={<AdminReposicaoMercado />} />
                  <Route path="admin/reposicao/sessao/parametros" element={<AdminReposicaoParametros />} />
                  <Route path="admin/reposicao/sessao/pedidos" element={<AdminReposicaoSessaoPedidos />} />
                  <Route path="admin/reposicao/sessao/aplicacao" element={<AdminReposicaoSessaoAplicacao />} />
                  <Route path="admin/reposicao/sessao/confirmacao" element={<AdminReposicaoSessaoConfirmacao />} />
                  <Route path="admin/reposicao/sessao/historico" element={<AdminReposicaoSessaoHistorico />} />
                </Route>
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
                <Route path="telefonia" element={<Telefonia />} />
                <Route path="whatsapp" element={<WhatsappInbox />} />
              </Route>
            </Route>
```

> ⚠️ Não mexer nas rotas públicas (`/auth`, `/reset-password`, `/tool/:toolId`) nem no catch-all `<Route path="*" element={<NotFound />} />` — ficam como estão, fora do AppShell. `RequireFinanceiroAccess` e `ReposicaoSessionLayout` continuam referenciados do mesmo jeito (não precisam de import novo).

- [ ] **Step 3: Verificar que NENHUMA rota foi perdida/alterada (diff dos paths)**

A reorganização só **agrupa** rotas — não cria/remove/muda nenhum `path`. (A contagem de `<Route ` cru **não** serve: o novo bloco adiciona 1 wrapper `<Route element={<RequireStaff />}>`.) A checagem certa é diffar a lista ordenada dos `path="..."` antes vs depois:

Run:
```bash
git show HEAD:src/App.tsx | grep -oE 'path="[^"]*"' | sort > /tmp/routes-before.txt
grep -oE 'path="[^"]*"' src/App.tsx | sort > /tmp/routes-after.txt
diff /tmp/routes-before.txt /tmp/routes-after.txt && echo "✅ paths idênticos (nenhuma rota perdida/adicionada/alterada)"
```
Expected: **`diff` vazio** + `✅ paths idênticos`. (A rota `index` não tem `path=` e fica fora dos dois lados — consistente; as públicas/`*` estão nos dois, inalteradas.)

> Se o `diff` mostrar QUALQUER linha (`<` ou `>`): uma rota foi perdida, duplicada ou teve o path alterado na substituição — corrigir antes de seguir.

- [ ] **Step 4: Typecheck + lint + test**

Run: `heavy bunx tsc --noEmit -p tsconfig.app.json` → 0 erros.
Run: `bun lint` → sem novos errors.
Run: `heavy bun run test` → todos passam (a suíte não testa as rotas do App diretamente, mas confirma que nada quebrou).

- [ ] **Step 5: Commit**
```bash
git add src/App.tsx
git commit -m "feat(auth): gateia rotas administrativas com RequireStaff (fail-closed) no App.tsx"
```

---

## Task 3: Validação final + QA de perfil

**Files:** nenhum (verificação)

- [ ] **Step 1: Suíte completa**

Run: `heavy bun run test` → 100% PASS (inclui os 3 testes do `RequireStaff`).
Run: `heavy bun run typecheck:strict` → 0 erros.
Run: `heavy bunx tsc --noEmit -p tsconfig.app.json` → 0 erros.
Run: `bun lint` → sem novos errors.

- [ ] **Step 2: QA de perfil (founder, no device — o headless não renderiza a SPA)**

- Logar como **customer** → digitar na URL `/admin/customers`, `/sales`, `/farmer`, `/tintometrico` → deve **cair em `/`** (CustomerDashboard).
- Como **customer**, confirmar que as **abertas continuam acessíveis**: `/tools`, `/orders`, `/loyalty`, `/gamification`, `/training`, `/recurring-schedules`, `/savings`, e **`/admin/calculadora`**.
- Logar como **staff** → todas as rotas acessíveis (nada bloqueado, nenhum redirect indevido).
- Logar como **não-staff COM permissão de financeiro** (se existir esse perfil) → `/financeiro` continua acessível (a exceção do design).

---

## Notas
- **Front puro:** sem migration/Edge Function/SQL — nada pro Lovable.
- **Sem mudança de comportamento de tela:** só o aninhamento das rotas muda; cada página renderiza igual.
- **Fora de escopo:** RLS (já protege dados), filtro da sidebar (já existe), granularidade fina por persona (trabalho futuro), `useSalesOnlyRestriction` (ortogonal, inalterado).
- **Risco:** rota no grupo errado → mitigado pela contagem (Step 3 da Task 2) + o QA dos 2 perfis (Task 3).
