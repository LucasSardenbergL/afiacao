import { lazy, Suspense } from "react";
import { ErrorBoundary } from "@/components/ErrorBoundary";
import { Toaster } from "@/components/ui/toaster";
import { Toaster as Sonner } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom";
import { AuthProvider } from "@/contexts/AuthContext";
import { CompanyProvider } from "@/contexts/CompanyContext";
import { ProtectedRoute } from "@/components/ProtectedRoute";
import { NotificationPrompt } from "@/components/NotificationPrompt";
import { AppShellLayout } from "@/components/AppShellLayout";
import { Skeleton } from "@/components/ui/skeleton";

// Lazy-loaded pages
const Index = lazy(() => import("./pages/Index"));
const Orders = lazy(() => import("./pages/Orders"));
const OrderDetail = lazy(() => import("./pages/OrderDetail"));

const Profile = lazy(() => import("./pages/Profile"));
const Addresses = lazy(() => import("./pages/Addresses"));
const Tools = lazy(() => import("./pages/Tools"));
const Support = lazy(() => import("./pages/Support"));
const Auth = lazy(() => import("./pages/Auth"));
const ResetPassword = lazy(() => import("./pages/ResetPassword"));
const Admin = lazy(() => import("./pages/Admin"));
const AdminCustomers = lazy(() => import("./pages/AdminCustomers"));
const AdminOrderDetail = lazy(() => import("./pages/AdminOrderDetail"));
const AdminDemandForecast = lazy(() => import("./pages/AdminDemandForecast"));
const AdminRoutePlanner = lazy(() => import("./pages/AdminRoutePlanner"));
const AdminMonthlyReports = lazy(() => import("./pages/AdminMonthlyReports"));
const AdminProductivity = lazy(() => import("./pages/AdminProductivity"));
const AdminLoyalty = lazy(() => import("./pages/AdminLoyalty"));
const AdminGamification = lazy(() => import("./pages/AdminGamification"));
const Gamification = lazy(() => import("./pages/Gamification"));
const QualityChecklist = lazy(() => import("./pages/QualityChecklist"));
const RecurringSchedules = lazy(() => import("./pages/RecurringSchedules"));
const SavingsDashboard = lazy(() => import("./pages/SavingsDashboard"));
const Loyalty = lazy(() => import("./pages/Loyalty"));
const ToolHistory = lazy(() => import("./pages/ToolHistory"));
const ToolPublicHistory = lazy(() => import("./pages/ToolPublicHistory"));
const ToolReports = lazy(() => import("./pages/ToolReports"));
const AdminTraining = lazy(() => import("./pages/AdminTraining"));
const AdminPriceTable = lazy(() => import("./pages/AdminPriceTable"));
const Training = lazy(() => import("./pages/Training"));
const SalesProducts = lazy(() => import("./pages/SalesProducts"));
const SalesOrders = lazy(() => import("./pages/SalesOrders"));
const SalesPrintDashboard = lazy(() => import("./pages/SalesPrintDashboard"));

const UnifiedOrder = lazy(() => import("./pages/UnifiedOrder"));
const SalesOrderEdit = lazy(() => import("./pages/SalesOrderEdit"));
const SalesQuotes = lazy(() => import("./pages/SalesQuotes"));
const FarmerDashboard = lazy(() => import("./pages/FarmerDashboard"));
const FarmerCalls = lazy(() => import("./pages/FarmerCalls"));
const FarmerGovernance = lazy(() => import("./pages/FarmerGovernance"));
const FarmerRecommendations = lazy(() => import("./pages/FarmerRecommendations"));
const FarmerLOCC = lazy(() => import("./pages/FarmerLOCC"));
const FarmerBundles = lazy(() => import("./pages/FarmerBundles"));
const FarmerCopilot = lazy(() => import("./pages/FarmerCopilot"));
const FarmerTacticalPlan = lazy(() => import("./pages/FarmerTacticalPlan"));
const FarmerIPFDashboard = lazy(() => import("./pages/FarmerIPFDashboard"));
const ExecutiveDashboard = lazy(() => import("./pages/ExecutiveDashboard"));
const AdminApprovals = lazy(() => import("./pages/AdminApprovals"));
const NotFound = lazy(() => import("./pages/NotFound"));
const DesignSystem = lazy(() => import("./pages/DesignSystem"));
const CoachingSPIN = lazy(() => import("./pages/CoachingSPIN"));
const SettingsConfig = lazy(() => import("./pages/SettingsConfig"));
const UXRules = lazy(() => import("./pages/UXRules"));
const AdminAnalyticsSync = lazy(() => import("./pages/AdminAnalyticsSync"));
const TechnicalDocs = lazy(() => import("./pages/TechnicalDocs"));
const IntelligenceDashboard = lazy(() => import("./pages/IntelligenceDashboard"));
const GovernanceUsers = lazy(() => import("./pages/GovernanceUsers"));
const GovernancePermissions = lazy(() => import("./pages/GovernancePermissions"));
const GovernanceMathParams = lazy(() => import("./pages/GovernanceMathParams"));
const GovernanceAudit = lazy(() => import("./pages/GovernanceAudit"));
const GovernanceSettings = lazy(() => import("./pages/GovernanceSettings"));
const GovernanceCompanies = lazy(() => import("./pages/GovernanceCompanies"));
const AIops = lazy(() => import("./pages/AIops"));
const NfeReceipt = lazy(() => import("./pages/NfeReceipt"));
const TintDashboard = lazy(() => import("./pages/TintDashboard"));
const TintImport = lazy(() => import("./pages/TintImport"));
const TintMapping = lazy(() => import("./pages/TintMapping"));
const TintPricing = lazy(() => import("./pages/TintPricing"));
const TintFormulas = lazy(() => import("./pages/TintFormulas"));
const TintCorantes = lazy(() => import("./pages/TintCorantes"));
const TintIntegrations = lazy(() => import("./pages/TintIntegrations"));
const TintReconciliation = lazy(() => import("./pages/TintReconciliation"));
const TintSyncRuns = lazy(() => import("./pages/TintSyncRuns"));
const TintApiContract = lazy(() => import("./pages/TintApiContract"));
const FinanceiroDashboard = lazy(() => import("./pages/FinanceiroDashboard"));
const FinanceiroSync = lazy(() => import("./pages/FinanceiroSync"));
const FinanceiroMapping = lazy(() => import("./pages/FinanceiroMapping"));
const FinanceiroCapitalGiro = lazy(() => import("./pages/FinanceiroCapitalGiro"));
const FinanceiroFechamento = lazy(() => import("./pages/FinanceiroFechamento"));
const FinanceiroAnalytics = lazy(() => import("./pages/FinanceiroAnalytics"));
const FinanceiroCockpit = lazy(() => import("./pages/FinanceiroCockpit"));
const FinanceiroConciliacao = lazy(() => import("./pages/FinanceiroConciliacao"));
const FinanceiroOrcamento = lazy(() => import("./pages/FinanceiroOrcamento"));
const FinanceiroIntercompany = lazy(() => import("./pages/FinanceiroIntercompany"));
const FinanceiroTributario = lazy(() => import("./pages/FinanceiroTributario"));
const Recebimento = lazy(() => import("./pages/Recebimento"));
const RecebimentoConferencia = lazy(() => import("./pages/RecebimentoConferencia"));
const ProductionOrders = lazy(() => import("./pages/ProductionOrders"));
const AdminReposicaoRevisao = lazy(() => import("./pages/AdminReposicaoRevisao"));
const AdminReposicaoHistorico = lazy(() => import("./pages/AdminReposicaoHistorico"));
const AdminReposicaoAlertas = lazy(() => import("./pages/AdminReposicaoAlertas"));
const AdminReposicaoAplicacao = lazy(() => import("./pages/AdminReposicaoAplicacao"));
const AdminReposicaoGruposProducao = lazy(() => import("./pages/AdminReposicaoGruposProducao"));
const AdminReposicaoSlaFornecedor = lazy(() => import("./pages/AdminReposicaoSlaFornecedor"));
const AdminReposicaoCadeiaLogistica = lazy(() => import("./pages/AdminReposicaoCadeiaLogistica"));
const AdminReposicaoPedidos = lazy(() => import("./pages/AdminReposicaoPedidos"));
const AdminReposicaoPromocoes = lazy(() => import("./pages/AdminReposicaoPromocoes"));
const AdminReposicaoPromocaoDetail = lazy(() => import("./pages/AdminReposicaoPromocaoDetail"));
const AdminReposicaoAumentos = lazy(() => import("./pages/AdminReposicaoAumentos"));
const AdminReposicaoAumentoDetail = lazy(() => import("./pages/AdminReposicaoAumentoDetail"));

const PageLoader = () => (
  <div className="flex flex-col gap-4 p-6">
    <Skeleton className="h-8 w-48" />
    <Skeleton className="h-64 w-full" />
    <Skeleton className="h-32 w-full" />
  </div>
);

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 60_000, // 1 minute
      refetchOnWindowFocus: false,
      retry: 2,
      retryDelay: (attempt) => Math.min(1000 * 2 ** attempt, 10_000),
    },
  },
});

const App = () => (
  <QueryClientProvider client={queryClient}>
    <TooltipProvider>
      <Toaster />
      <Sonner />
      <BrowserRouter>
        <AuthProvider>
          <CompanyProvider>
          <ErrorBoundary>
          <Suspense fallback={<PageLoader />}>
          <Routes>
            {/* Public routes */}
            <Route path="/auth" element={<Auth />} />
            <Route path="/reset-password" element={<ResetPassword />} />
            <Route path="/tool/:toolId" element={<ToolPublicHistory />} />

            {/* All authenticated routes inside AppShell */}
            <Route element={<ProtectedRoute><AppShellLayout /></ProtectedRoute>}>
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
              <Route path="admin" element={<Admin />} />
              <Route path="admin/approvals" element={<AdminApprovals />} />
              <Route path="admin/customers" element={<AdminCustomers />} />
              <Route path="admin/customers/:customerId" element={<AdminCustomers />} />
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
              <Route path="recurring-schedules" element={<RecurringSchedules />} />
              <Route path="savings" element={<SavingsDashboard />} />
              <Route path="loyalty" element={<Loyalty />} />
              <Route path="gamification" element={<Gamification />} />
              <Route path="training" element={<Training />} />
              <Route path="sales" element={<SalesOrders />} />
              <Route path="sales/products" element={<SalesProducts />} />
              <Route path="sales/new" element={<UnifiedOrder />} />
              <Route path="sales/print" element={<SalesPrintDashboard />} />
              <Route path="sales/quotes" element={<SalesQuotes />} />
              <Route path="sales/edit/:id" element={<SalesOrderEdit />} />
              <Route path="unified-order" element={<Navigate to="/sales/new" replace />} />
              <Route path="farmer" element={<FarmerDashboard />} />
              <Route path="farmer/calls" element={<FarmerCalls />} />
              <Route path="farmer/governance" element={<FarmerGovernance />} />
              <Route path="farmer/recommendations" element={<FarmerRecommendations />} />
              <Route path="farmer/locc" element={<FarmerLOCC />} />
              <Route path="farmer/bundles" element={<FarmerBundles />} />
              <Route path="farmer/copilot" element={<FarmerCopilot />} />
              <Route path="farmer/tactical-plan" element={<FarmerTacticalPlan />} />
              <Route path="farmer/ipf" element={<FarmerIPFDashboard />} />
              <Route path="executive/dashboard" element={<ExecutiveDashboard />} />
              <Route path="design-system" element={<DesignSystem />} />
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
              <Route path="financeiro/tributario" element={<FinanceiroTributario />} />
              <Route path="recebimento" element={<Recebimento />} />
              <Route path="recebimento/:id" element={<RecebimentoConferencia />} />
              <Route path="producao" element={<ProductionOrders />} />
              <Route path="admin/reposicao/revisao" element={<AdminReposicaoRevisao />} />
              <Route path="admin/reposicao/historico" element={<AdminReposicaoHistorico />} />
              <Route path="admin/reposicao/alertas" element={<AdminReposicaoAlertas />} />
              <Route path="admin/reposicao/aplicacao" element={<AdminReposicaoAplicacao />} />
              <Route path="admin/reposicao/grupos-producao" element={<AdminReposicaoGruposProducao />} />
              <Route path="admin/reposicao/cadeia-logistica" element={<AdminReposicaoCadeiaLogistica />} />
              <Route path="admin/reposicao/pedidos" element={<AdminReposicaoPedidos />} />
              <Route path="admin/reposicao/sla-fornecedor" element={<AdminReposicaoSlaFornecedor />} />
              <Route path="admin/reposicao/promocoes" element={<AdminReposicaoPromocoes />} />
              <Route path="admin/reposicao/promocoes/novo" element={<AdminReposicaoPromocaoDetail />} />
              <Route path="admin/reposicao/promocoes/:id" element={<AdminReposicaoPromocaoDetail />} />
              <Route path="admin/reposicao/aumentos" element={<AdminReposicaoAumentos />} />
              <Route path="admin/reposicao/aumentos/novo" element={<AdminReposicaoAumentoDetail />} />
              <Route path="admin/reposicao/aumentos/:id" element={<AdminReposicaoAumentoDetail />} />
            </Route>

            <Route path="*" element={<NotFound />} />
          </Routes>
          </Suspense>
          </ErrorBoundary>
          <NotificationPrompt />
          </CompanyProvider>
        </AuthProvider>
      </BrowserRouter>
    </TooltipProvider>
  </QueryClientProvider>
);

export default App;
