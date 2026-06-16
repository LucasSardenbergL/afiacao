import { lazy, Suspense, useEffect } from "react";
import { ThemeProvider } from "next-themes";
import { ErrorBoundary } from "@/components/ErrorBoundary";
import { initAnalytics } from "@/lib/analytics";
// Sistema de toast unificado em Sonner (Radix Toaster legado e wrapper useToast removidos).
import { Toaster as Sonner } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom";
import { AuthProvider } from "@/contexts/AuthContext";
import { CompanyProvider } from "@/contexts/CompanyContext";
import { ImpersonationProvider } from "@/contexts/ImpersonationContext";
import { ConditionalWebRTCProvider } from "@/contexts/ConditionalWebRTCProvider";
import { ProtectedRoute } from "@/components/ProtectedRoute";
import { RequireFinanceiroAccess } from "@/components/RequireFinanceiroAccess";
import { RequireStaff } from '@/components/RequireStaff';
import { RequireCaca } from '@/components/RequireCaca';
import { NotificationPrompt } from "@/components/NotificationPrompt";
import { AppShellLayout } from "@/components/AppShellLayout";
import { PageSkeleton } from "@/components/ui/page-skeleton";

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
const Customer360 = lazy(() => import("./pages/Customer360"));
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
const MeuDia = lazy(() => import("./pages/MeuDia"));
const Tarefas = lazy(() => import("./pages/Tarefas"));
const TarefasTemplates = lazy(() => import("./pages/TarefasTemplates"));
const FarmerCalls = lazy(() => import("./pages/FarmerCalls"));
const FarmerCallsPendingLink = lazy(() => import("./pages/FarmerCallsPendingLink"));
const FarmerGovernance = lazy(() => import("./pages/FarmerGovernance"));
const FarmerRecommendations = lazy(() => import("./pages/FarmerRecommendations"));
const FarmerLOCC = lazy(() => import("./pages/FarmerLOCC"));
const FarmerBundles = lazy(() => import("./pages/FarmerBundles"));
const FarmerCopilot = lazy(() => import("./pages/FarmerCopilot"));
const FarmerTacticalPlan = lazy(() => import("./pages/FarmerTacticalPlan"));
const FarmerIPFDashboard = lazy(() => import("./pages/FarmerIPFDashboard"));
const ExecutiveDashboard = lazy(() => import("./pages/ExecutiveDashboard"));
const AdminApprovals = lazy(() => import("./pages/AdminApprovals"));
const AdminDepartments = lazy(() => import("./pages/AdminDepartments"));
const NotFound = lazy(() => import("./pages/NotFound"));
const DesignSystem = lazy(() => import("./pages/DesignSystem"));
const DesignPreview = lazy(() => import("./pages/DesignPreview"));
const CoachingSPIN = lazy(() => import("./pages/CoachingSPIN"));
const SettingsConfig = lazy(() => import("./pages/SettingsConfig"));
const UXRules = lazy(() => import("./pages/UXRules"));
const AdminAnalyticsSync = lazy(() => import("./pages/AdminAnalyticsSync"));
const ClientesNaoVinculados = lazy(() => import("./pages/ClientesNaoVinculados"));
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
// Tint standalone (TintImport/Mapping/Pricing/Formulas/Corantes/Integrations/Reconciliation/
// SyncRuns/ApiContract): import só dentro dos wrappers TintCatalogo/TintIntegracao (abas).
// As rotas /tintometrico/<tela> antigas viraram redirect pros wrappers (#8).
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
const FinanceiroIntercompanyFila = lazy(() => import("./pages/FinanceiroIntercompanyFila"));
const FinanceiroTributario = lazy(() => import("./pages/FinanceiroTributario"));
const FinanceiroValor = lazy(() => import("./pages/FinanceiroValor"));
const FinanceiroValorCockpit = lazy(() => import("./pages/FinanceiroValorCockpit"));
const FinanceiroProximaAcao = lazy(() => import("./pages/FinanceiroProximaAcao"));
const FinanceiroRegimeTributario = lazy(() => import("./pages/FinanceiroRegimeTributario"));
const FinanceiroFunding = lazy(() => import("./pages/FinanceiroFunding"));
const Recebimento = lazy(() => import("./pages/Recebimento"));
const RecebimentoConferencia = lazy(() => import("./pages/RecebimentoConferencia"));
const ProductionOrders = lazy(() => import("./pages/ProductionOrders"));
const AdminReposicaoHistorico = lazy(() => import("./pages/AdminReposicaoHistorico"));
const AdminReposicaoAlertas = lazy(() => import("./pages/AdminReposicaoAlertas"));
const AdminReposicaoGruposProducao = lazy(() => import("./pages/AdminReposicaoGruposProducao"));
const AdminReposicaoSlaFornecedor = lazy(() => import("./pages/AdminReposicaoSlaFornecedor"));
const AdminReposicaoCadeiaLogistica = lazy(() => import("./pages/AdminReposicaoCadeiaLogistica"));
const AdminReposicaoPedidos = lazy(() => import("./pages/AdminReposicaoPedidos"));
const AdminSkuMapeamento = lazy(() => import("./pages/AdminSkuMapeamento"));
const AdminReposicaoPromocoes = lazy(() => import("./pages/AdminReposicaoPromocoes"));
const AdminReposicaoPromocaoDetail = lazy(() => import("./pages/AdminReposicaoPromocaoDetail"));
const AdminReposicaoAumentos = lazy(() => import("./pages/AdminReposicaoAumentos"));
const AdminReposicaoAumentoDetail = lazy(() => import("./pages/AdminReposicaoAumentoDetail"));
const AdminReposicaoOportunidades = lazy(() => import("./pages/AdminReposicaoOportunidades"));
const AdminReposicaoNegociacaoParalela = lazy(() => import("./pages/AdminReposicaoNegociacaoParalela"));
const AdminReposicaoBaixoGiro = lazy(() => import("./pages/AdminReposicaoBaixoGiro"));
const AdminReposicaoCockpit = lazy(() => import("./pages/AdminReposicaoCockpit"));
const AdminReposicaoParametros = lazy(() => import("./pages/AdminReposicaoParametros"));
const AdminReposicaoMercado = lazy(() => import("./pages/AdminReposicaoMercado"));
const AdminReposicaoSessaoPedidos = lazy(() => import("./pages/AdminReposicaoSessaoPedidos"));
const AdminReposicaoSessaoAplicacao = lazy(() => import("./pages/AdminReposicaoSessaoAplicacao"));
const AdminReposicaoSessaoConfirmacao = lazy(() => import("./pages/AdminReposicaoSessaoConfirmacao"));
const AdminReposicaoSessaoHistorico = lazy(() => import("./pages/AdminReposicaoSessaoHistorico"));
const ReposicaoSessionLayout = lazy(() => import("./components/reposicao/ReposicaoSessionLayout"));
const LegacyCockpitRedirect = lazy(() => import("./components/reposicao/LegacyCockpitRedirect"));
const AdminReposicaoCadastros = lazy(() => import("./pages/AdminReposicaoCadastros"));
const AdminReposicaoEmbalagem = lazy(() => import("./pages/AdminReposicaoEmbalagem"));
const ParamAutoMudancas = lazy(() => import("./pages/ParamAutoMudancas"));
const AdminEstoqueRecebimento = lazy(() => import("./pages/AdminEstoqueRecebimento"));
const AdminEstoquePicking = lazy(() => import("./pages/AdminEstoquePicking"));
const TouchPickingView = lazy(() => import("./pages/picking/TouchPickingView"));
const FinanceiroGestao = lazy(() => import("./pages/FinanceiroGestao"));
const FinanceiroAnalise = lazy(() => import("./pages/FinanceiroAnalise"));
const TintCatalogo = lazy(() => import("./pages/TintCatalogo"));
const TintIntegracao = lazy(() => import("./pages/TintIntegracao"));
const PerformanceHub = lazy(() => import("./pages/PerformanceHub"));
const VendasFerramentas = lazy(() => import("./pages/VendasFerramentas"));
const GestaoAdmin = lazy(() => import("./pages/GestaoAdmin"));
const GestaoGovernanca = lazy(() => import("./pages/GestaoGovernanca"));
const SaudeDados = lazy(() => import("./pages/SaudeDados"));
const AdminAjuda = lazy(() => import("./pages/AdminAjuda"));
const AdminDesTrimestreAtual = lazy(() => import("./pages/AdminDesTrimestreAtual"));
const AdminNotificacoes = lazy(() => import("./pages/AdminNotificacoes"));
const AdminVendorSipCredentials = lazy(() => import("./pages/AdminVendorSipCredentials"));
const AdminKnowledgeBase = lazy(() => import("./pages/AdminKnowledgeBase"));
const AdminKnowledgeBaseDetail = lazy(() => import("./pages/AdminKnowledgeBaseDetail"));
const AdminStandardProcesses = lazy(() => import("./pages/AdminStandardProcesses"));
const AdminStandardProcessNew = lazy(() => import("./pages/AdminStandardProcessNew"));
const AdminStandardProcessDetail = lazy(() => import("./pages/AdminStandardProcessDetail"));
const AdminCalculadora = lazy(() => import("./pages/AdminCalculadora"));
const Telefonia = lazy(() => import("./pages/Telefonia"));
const WhatsappInbox = lazy(() => import("./pages/WhatsappInbox"));
const WhatsappSlaSupervisao = lazy(() => import("./pages/WhatsappSlaSupervisao"));
const RotaListaLigacao = lazy(() => import("./pages/RotaListaLigacao"));
const RotaPainelLigacoes = lazy(() => import("./pages/RotaPainelLigacoes"));
const RotaPropostas = lazy(() => import("./pages/RotaPropostas"));
const Caca = lazy(() => import("./pages/Caca"));
const Melhorias = lazy(() => import("./pages/Melhorias"));
const GestaoMelhorias = lazy(() => import("./pages/GestaoMelhorias"));
const RadarClientes = lazy(() => import("./pages/RadarClientes"));

const PageLoader = () => <PageSkeleton variant="auto" />;

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

const App = () => {
  // PostHog é carregado via dynamic import DEPOIS do primeiro paint (fora do
  // caminho crítico do boot). Eventos disparados antes do SDK terminar de
  // baixar ficam numa fila no wrapper e são drenados no load.
  useEffect(() => {
    initAnalytics();
  }, []);

  return (
  <QueryClientProvider client={queryClient}>
    <ThemeProvider attribute="class" defaultTheme="light" enableSystem={false} disableTransitionOnChange>
    <TooltipProvider>
      <Sonner />
      <BrowserRouter>
        <AuthProvider>
          <ImpersonationProvider>
          <CompanyProvider>
          <ConditionalWebRTCProvider>
          <ErrorBoundary>
          <Suspense fallback={<PageLoader />}>
          <Routes>
            {/* Public routes */}
            <Route path="/auth" element={<Auth />} />
            <Route path="/reset-password" element={<ResetPassword />} />
            <Route path="/tool/:toolId" element={<ToolPublicHistory />} />

            {/* All authenticated routes inside AppShell */}
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
              {/* `tarefas` + `admin/calculadora` ficam abertas de propósito (cliente/staff).
                  ⚠️ As demais rotas de staff (sales, farmer, governance, ai-ops, tint, intelligence,
                  executive, settings, docs, design-system, coaching, ux-rules, nfe) foram REMOVIDAS daqui:
                  estavam DUPLICADAS com as cópias gated do bloco <RequireStaff> abaixo, e a cópia
                  aberta (1ª no source) vencia o match do react-router → o gate ficava MORTO
                  (regressão do #508, que adicionou o RequireStaff mas não removeu as flat antigas).
                  Cada rota de staff agora existe SÓ dentro do <RequireStaff> (fail-closed).
                  O teste src/__tests__/app-route-dedupe.test.ts impede a duplicação voltar. */}
              <Route path="tarefas" element={<Tarefas />} />
              <Route path="tarefas/templates" element={<TarefasTemplates />} />
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
                {/* #8: rotas tint standalone consolidadas → abas dos wrappers (Catálogo/Integração).
                    As telas seguem existindo como abas dos wrappers; aqui só redirecionamos a URL
                    antiga (preserva bookmark, mata a duplicação de telas). */}
                <Route path="tintometrico/formulas" element={<Navigate to="/tintometrico/catalogo?tab=formulas" replace />} />
                <Route path="tintometrico/corantes" element={<Navigate to="/tintometrico/catalogo?tab=corantes" replace />} />
                <Route path="tintometrico/mapeamento" element={<Navigate to="/tintometrico/catalogo?tab=mapeamento" replace />} />
                <Route path="tintometrico/precos" element={<Navigate to="/tintometrico/catalogo?tab=precificacao" replace />} />
                <Route path="tintometrico/importar" element={<Navigate to="/tintometrico/integracao?tab=importar" replace />} />
                <Route path="tintometrico/integracoes" element={<Navigate to="/tintometrico/integracao?tab=integracoes" replace />} />
                <Route path="tintometrico/reconciliacao" element={<Navigate to="/tintometrico/integracao?tab=reconciliacao" replace />} />
                <Route path="tintometrico/sync-runs" element={<Navigate to="/tintometrico/integracao?tab=sync-runs" replace />} />
                <Route path="tintometrico/api-contract" element={<Navigate to="/tintometrico/integracao?tab=api-contract" replace />} />
                <Route path="recebimento" element={<Recebimento />} />
                <Route path="recebimento/:id" element={<RecebimentoConferencia />} />
                <Route path="producao" element={<ProductionOrders />} />
                <Route path="admin/reposicao/revisao" element={<Navigate to="/admin/reposicao/sessao/parametros?tab=ajuste" replace />} />
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
                <Route path="admin/reposicao/baixo-giro" element={<AdminReposicaoBaixoGiro />} />
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
                <Route path="admin/reposicao/embalagem" element={<AdminReposicaoEmbalagem />} />
                <Route path="admin/reposicao/mudancas-automaticas" element={<ParamAutoMudancas />} />
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
                <Route path="gestao/melhorias" element={<GestaoMelhorias />} />
                <Route path="melhorias" element={<Melhorias />} />
                <Route path="radar" element={<RadarClientes />} />
                <Route path="admin/ajuda" element={<AdminAjuda />} />
                <Route path="admin/des/trimestre-atual" element={<AdminDesTrimestreAtual />} />
                <Route path="admin/des/configuracao" element={<AdminDesTrimestreAtual />} />
                <Route path="admin/notificacoes" element={<AdminNotificacoes />} />
                {/* Fase 3 · 3c: tela aposentada. A conciliação inline vive em /admin/reposicao/pedidos (PortalDrawer). */}
                <Route path="admin/portal-sayerlack" element={<Navigate to="/admin/reposicao/pedidos" replace />} />
                <Route path="admin/sip-credentials" element={<AdminVendorSipCredentials />} />
                <Route path="admin/knowledge-base" element={<AdminKnowledgeBase />} />
                <Route path="admin/knowledge-base/:id" element={<AdminKnowledgeBaseDetail />} />
                <Route path="admin/standard-processes" element={<AdminStandardProcesses />} />
                <Route path="admin/standard-processes/new" element={<AdminStandardProcessNew />} />
                <Route path="admin/standard-processes/:id" element={<AdminStandardProcessDetail />} />
                <Route path="telefonia" element={<Telefonia />} />
                <Route path="whatsapp" element={<WhatsappInbox />} />
                <Route path="whatsapp/sla" element={<WhatsappSlaSupervisao />} />
                <Route path="rota/ligacoes" element={<RotaListaLigacao />} />
                <Route path="rota/ligacoes/painel" element={<RotaPainelLigacoes />} />
                <Route path="rota/propostas" element={<RotaPropostas />} />
                {/* Caça (Frente B): gate fino hunter/master dentro do RequireStaff */}
                <Route element={<RequireCaca />}>
                  <Route path="caca" element={<Caca />} />
                </Route>
              </Route>
            </Route>

            <Route path="*" element={<NotFound />} />
          </Routes>
          </Suspense>
          </ErrorBoundary>
          </ConditionalWebRTCProvider>
          <NotificationPrompt />
          </CompanyProvider>
          </ImpersonationProvider>
        </AuthProvider>
      </BrowserRouter>
    </TooltipProvider>
    </ThemeProvider>
  </QueryClientProvider>
  );
};

export default App;
