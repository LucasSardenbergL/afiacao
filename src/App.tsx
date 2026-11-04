import { Suspense, useEffect } from "react";
import { ThemeProvider } from "next-themes";
import { ErrorBoundary } from "@/components/ErrorBoundary";
import { initAnalytics } from "@/lib/analytics";
import { MedidorVitals } from "@/components/shell/MedidorVitals";
// Sistema de toast unificado em Sonner (Radix Toaster legado e wrapper useToast removidos).
import { Toaster as Sonner } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter, Routes, Route, Navigate, createRoutesFromElements } from "react-router-dom";
import { lazyRota, registrarRotas } from "@/lib/preload-rota";
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
import { GuardModuloCongelado } from "@/components/GuardModuloCongelado";
import { PageSkeleton } from "@/components/ui/page-skeleton";

// Lazy-loaded pages
const Index = lazyRota(() => import("./pages/Index"));
const Orders = lazyRota(() => import("./pages/Orders"));
const OrderDetail = lazyRota(() => import("./pages/OrderDetail"));

const Profile = lazyRota(() => import("./pages/Profile"));
const Addresses = lazyRota(() => import("./pages/Addresses"));
const Tools = lazyRota(() => import("./pages/Tools"));
const Support = lazyRota(() => import("./pages/Support"));
const Auth = lazyRota(() => import("./pages/Auth"));
const ResetPassword = lazyRota(() => import("./pages/ResetPassword"));
const OAuthConsent = lazyRota(() => import("./pages/OAuthConsent"));
const Admin = lazyRota(() => import("./pages/Admin"));
const AdminCustomers = lazyRota(() => import("./pages/AdminCustomers"));
const Customer360 = lazyRota(() => import("./pages/Customer360"));
const AdminOrderDetail = lazyRota(() => import("./pages/AdminOrderDetail"));
const AdminDemandForecast = lazyRota(() => import("./pages/AdminDemandForecast"));
const AdminRoutePlanner = lazyRota(() => import("./pages/AdminRoutePlanner"));
const AdminMonthlyReports = lazyRota(() => import("./pages/AdminMonthlyReports"));
const AdminProductivity = lazyRota(() => import("./pages/AdminProductivity"));
const VendaClientePainel = lazyRota(() => import("./pages/VendaClientePainel"));
const AdminLoyalty = lazyRota(() => import("./pages/AdminLoyalty"));
const AdminPrime = lazyRota(() => import("./pages/AdminPrime"));
const AdminGamification = lazyRota(() => import("./pages/AdminGamification"));
const Gamification = lazyRota(() => import("./pages/Gamification"));
const RecurringSchedules = lazyRota(() => import("./pages/RecurringSchedules"));
const SavingsDashboard = lazyRota(() => import("./pages/SavingsDashboard"));
const CentralFerramenta = lazyRota(() => import("./pages/CentralFerramenta"));
const Loyalty = lazyRota(() => import("./pages/Loyalty"));
const ToolHistory = lazyRota(() => import("./pages/ToolHistory"));
const ToolPublicHistory = lazyRota(() => import("./pages/ToolPublicHistory"));
const ToolReports = lazyRota(() => import("./pages/ToolReports"));
const AdminTraining = lazyRota(() => import("./pages/AdminTraining"));
const AdminPriceTable = lazyRota(() => import("./pages/AdminPriceTable"));
const Training = lazyRota(() => import("./pages/Training"));
const SalesProducts = lazyRota(() => import("./pages/SalesProducts"));
const SalesOrders = lazyRota(() => import("./pages/SalesOrders"));
const SalesPrintDashboard = lazyRota(() => import("./pages/SalesPrintDashboard"));

const UnifiedOrder = lazyRota(() => import("./pages/UnifiedOrder"));
const SalesOrderEdit = lazyRota(() => import("./pages/SalesOrderEdit"));
const SalesQuotes = lazyRota(() => import("./pages/SalesQuotes"));
const PedidosProgramados = lazyRota(() => import("./pages/PedidosProgramados"));
const PedidoProgramadoDetalhe = lazyRota(() => import("./pages/PedidoProgramadoDetalhe"));
const FarmerDashboard = lazyRota(() => import("./pages/FarmerDashboard"));
const MeuDia = lazyRota(() => import("./pages/MeuDia"));
const Tarefas = lazyRota(() => import("./pages/Tarefas"));
const TarefasTemplates = lazyRota(() => import("./pages/TarefasTemplates"));
const FarmerCalls = lazyRota(() => import("./pages/FarmerCalls"));
const CarteiraBoard = lazyRota(() => import("./pages/CarteiraBoard"));
const FarmerCallsPendingLink = lazyRota(() => import("./pages/FarmerCallsPendingLink"));
const FarmerGovernance = lazyRota(() => import("./pages/FarmerGovernance"));
const FarmerRecommendations = lazyRota(() => import("./pages/FarmerRecommendations"));
const FarmerLOCC = lazyRota(() => import("./pages/FarmerLOCC"));
const FarmerBundles = lazyRota(() => import("./pages/FarmerBundles"));
const FarmerCopilot = lazyRota(() => import("./pages/FarmerCopilot"));
const FarmerTacticalPlan = lazyRota(() => import("./pages/FarmerTacticalPlan"));
const FarmerIPFDashboard = lazyRota(() => import("./pages/FarmerIPFDashboard"));
const ExecutiveDashboard = lazyRota(() => import("./pages/ExecutiveDashboard"));
const AdminApprovals = lazyRota(() => import("./pages/AdminApprovals"));
const AdminDepartments = lazyRota(() => import("./pages/AdminDepartments"));
const NotFound = lazyRota(() => import("./pages/NotFound"));
const DesignSystem = lazyRota(() => import("./pages/DesignSystem"));
const DesignPreview = lazyRota(() => import("./pages/DesignPreview"));
const CoachingSPIN = lazyRota(() => import("./pages/CoachingSPIN"));
const SettingsConfig = lazyRota(() => import("./pages/SettingsConfig"));
const UXRules = lazyRota(() => import("./pages/UXRules"));
const AdminAnalyticsSync = lazyRota(() => import("./pages/AdminAnalyticsSync"));
const ClientesNaoVinculados = lazyRota(() => import("./pages/ClientesNaoVinculados"));
const TechnicalDocs = lazyRota(() => import("./pages/TechnicalDocs"));
const IntelligenceDashboard = lazyRota(() => import("./pages/IntelligenceDashboard"));
const GovernanceUsers = lazyRota(() => import("./pages/GovernanceUsers"));
const GovernancePermissions = lazyRota(() => import("./pages/GovernancePermissions"));
const GovernanceMathParams = lazyRota(() => import("./pages/GovernanceMathParams"));
const GovernanceAudit = lazyRota(() => import("./pages/GovernanceAudit"));
const GovernanceSettings = lazyRota(() => import("./pages/GovernanceSettings"));
const GovernanceCompanies = lazyRota(() => import("./pages/GovernanceCompanies"));
const AIops = lazyRota(() => import("./pages/AIops"));
const NfeReceipt = lazyRota(() => import("./pages/NfeReceipt"));
const TintDashboard = lazyRota(() => import("./pages/TintDashboard"));
// Tint standalone (TintImport/Mapping/Pricing/Formulas/Corantes/Integrations/Reconciliation/
// SyncRuns/ApiContract): import só dentro dos wrappers TintCatalogo/TintIntegracao (abas).
// As rotas /tintometrico/<tela> antigas viraram redirect pros wrappers (#8).
const FinanceiroDashboard = lazyRota(() => import("./pages/FinanceiroDashboard"));
const FinanceiroSync = lazyRota(() => import("./pages/FinanceiroSync"));
const FinanceiroMapping = lazyRota(() => import("./pages/FinanceiroMapping"));
const FinanceiroCapitalGiro = lazyRota(() => import("./pages/FinanceiroCapitalGiro"));
const FinanceiroFechamento = lazyRota(() => import("./pages/FinanceiroFechamento"));
const FinanceiroAnalytics = lazyRota(() => import("./pages/FinanceiroAnalytics"));
const FinanceiroCockpit = lazyRota(() => import("./pages/FinanceiroCockpit"));
const FinanceiroConciliacao = lazyRota(() => import("./pages/FinanceiroConciliacao"));
const FinanceiroOrcamento = lazyRota(() => import("./pages/FinanceiroOrcamento"));
const GestaoGruposCliente = lazyRota(() => import("./pages/GestaoGruposCliente"));
const GrupoCliente360 = lazyRota(() => import("./pages/GrupoCliente360"));
const FinanceiroIntercompany = lazyRota(() => import("./pages/FinanceiroIntercompany"));
const FinanceiroIntercompanyFila = lazyRota(() => import("./pages/FinanceiroIntercompanyFila"));
const FinanceiroTributario = lazyRota(() => import("./pages/FinanceiroTributario"));
const FinanceiroValor = lazyRota(() => import("./pages/FinanceiroValor"));
const FinanceiroValorCockpit = lazyRota(() => import("./pages/FinanceiroValorCockpit"));
const FinanceiroProximaAcao = lazyRota(() => import("./pages/FinanceiroProximaAcao"));
const FinanceiroRegimeTributario = lazyRota(() => import("./pages/FinanceiroRegimeTributario"));
const FinanceiroFunding = lazyRota(() => import("./pages/FinanceiroFunding"));
const FinanceiroEndividamento = lazyRota(() => import("./pages/FinanceiroEndividamento"));
const FinanceiroAntecipacao = lazyRota(() => import("./pages/FinanceiroAntecipacao"));
const Recebimento = lazyRota(() => import("./pages/Recebimento"));
const RecebimentoConferencia = lazyRota(() => import("./pages/RecebimentoConferencia"));
const ProductionOrders = lazyRota(() => import("./pages/ProductionOrders"));
const ProducaoBomExcecoes = lazyRota(() => import("./pages/ProducaoBomExcecoes"));
const ProducaoApontamento = lazyRota(() => import("./pages/ProducaoApontamento"));
const AdminReposicaoHistorico = lazyRota(() => import("./pages/AdminReposicaoHistorico"));
const AdminReposicaoAlertas = lazyRota(() => import("./pages/AdminReposicaoAlertas"));
const AdminReposicaoGruposProducao = lazyRota(() => import("./pages/AdminReposicaoGruposProducao"));
const AdminReposicaoSlaFornecedor = lazyRota(() => import("./pages/AdminReposicaoSlaFornecedor"));
const AdminReposicaoCadeiaLogistica = lazyRota(() => import("./pages/AdminReposicaoCadeiaLogistica"));
const AdminReposicaoPedidos = lazyRota(() => import("./pages/AdminReposicaoPedidos"));
const AdminSkuMapeamento = lazyRota(() => import("./pages/AdminSkuMapeamento"));
const AdminReposicaoPromocoes = lazyRota(() => import("./pages/AdminReposicaoPromocoes"));
const AdminReposicaoPromocaoDetail = lazyRota(() => import("./pages/AdminReposicaoPromocaoDetail"));
const AdminReposicaoAumentos = lazyRota(() => import("./pages/AdminReposicaoAumentos"));
const AdminReposicaoAumentoDetail = lazyRota(() => import("./pages/AdminReposicaoAumentoDetail"));
const AdminReposicaoOportunidades = lazyRota(() => import("./pages/AdminReposicaoOportunidades"));
const AdminReposicaoNegociacaoParalela = lazyRota(() => import("./pages/AdminReposicaoNegociacaoParalela"));
const AdminReposicaoBaixoGiro = lazyRota(() => import("./pages/AdminReposicaoBaixoGiro"));
const AdminReposicaoVendaPerdida = lazyRota(() => import("./pages/AdminReposicaoVendaPerdida"));
const AdminReposicaoParametros = lazyRota(() => import("./pages/AdminReposicaoParametros"));
const AdminReposicaoMercado = lazyRota(() => import("./pages/AdminReposicaoMercado"));
const AdminReposicaoCadastros = lazyRota(() => import("./pages/AdminReposicaoCadastros"));
const AdminReposicaoEmbalagem = lazyRota(() => import("./pages/AdminReposicaoEmbalagem"));
const ParamAutoMudancas = lazyRota(() => import("./pages/ParamAutoMudancas"));
const AdminEstoqueRecebimento = lazyRota(() => import("./pages/AdminEstoqueRecebimento"));
const AdminEstoquePicking = lazyRota(() => import("./pages/AdminEstoquePicking"));
const SeparacaoV2 = lazyRota(() => import("./pages/picking/SeparacaoV2"));
const FinanceiroGestao = lazyRota(() => import("./pages/FinanceiroGestao"));
const FinanceiroAnalise = lazyRota(() => import("./pages/FinanceiroAnalise"));
const TintCatalogo = lazyRota(() => import("./pages/TintCatalogo"));
const TintIntegracao = lazyRota(() => import("./pages/TintIntegracao"));
const PerformanceHub = lazyRota(() => import("./pages/PerformanceHub"));
const VendasFerramentas = lazyRota(() => import("./pages/VendasFerramentas"));
const Cobranca = lazyRota(() => import("./pages/Cobranca"));
const GestaoAdmin = lazyRota(() => import("./pages/GestaoAdmin"));
const GestaoGovernanca = lazyRota(() => import("./pages/GestaoGovernanca"));
const SaudeDados = lazyRota(() => import("./pages/SaudeDados"));
const AdminAjuda = lazyRota(() => import("./pages/AdminAjuda"));
const AdminDesTrimestreAtual = lazyRota(() => import("./pages/AdminDesTrimestreAtual"));
const AdminNotificacoes = lazyRota(() => import("./pages/AdminNotificacoes"));
const AdminVendorSipCredentials = lazyRota(() => import("./pages/AdminVendorSipCredentials"));
const AdminKnowledgeBase = lazyRota(() => import("./pages/AdminKnowledgeBase"));
const AdminKnowledgeBaseDetail = lazyRota(() => import("./pages/AdminKnowledgeBaseDetail"));
const AdminStandardProcesses = lazyRota(() => import("./pages/AdminStandardProcesses"));
const AdminStandardProcessNew = lazyRota(() => import("./pages/AdminStandardProcessNew"));
const AdminStandardProcessDetail = lazyRota(() => import("./pages/AdminStandardProcessDetail"));
const AdminCalculadora = lazyRota(() => import("./pages/AdminCalculadora"));
const Telefonia = lazyRota(() => import("./pages/Telefonia"));
const WhatsappInbox = lazyRota(() => import("./pages/WhatsappInbox"));
const WhatsappSlaSupervisao = lazyRota(() => import("./pages/WhatsappSlaSupervisao"));
const RotaListaLigacao = lazyRota(() => import("./pages/RotaListaLigacao"));
const RotaPainelLigacoes = lazyRota(() => import("./pages/RotaPainelLigacoes"));
const RotaPropostas = lazyRota(() => import("./pages/RotaPropostas"));
const Caca = lazyRota(() => import("./pages/Caca"));
const Melhorias = lazyRota(() => import("./pages/Melhorias"));
const GestaoMelhorias = lazyRota(() => import("./pages/GestaoMelhorias"));
const RadarClientes = lazyRota(() => import("./pages/RadarClientes"));

const PageLoader = () => <PageSkeleton variant="auto" />;

// Árvore de rotas. É também o mapa rota→loader do prefetch (F1/F5, `@/lib/preload-rota`):
// o MESMO `lazyRota` que o <Routes> renderiza é o que o boot e a sidebar pré-carregam.
const arvoreDeRotas = (
  <>
    {/* Public routes */}
    <Route path="/auth" element={<Auth />} />
    <Route path="/reset-password" element={<ResetPassword />} />
    <Route path="/.lovable/oauth/consent" element={<OAuthConsent />} />
    <Route path="/tool/:toolId" element={<ToolPublicHistory />} />

    {/* All authenticated routes inside AppShell */}
    <Route element={<ProtectedRoute><AppShellLayout /></ProtectedRoute>}>
      {/* M-41: rota de módulo congelado volta para "/" com aviso (o gate confere que
          TODA rota autenticada passa por aqui). */}
      <Route element={<GuardModuloCongelado />}>
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
      <Route path="central" element={<CentralFerramenta />} />
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
        <Route path="financeiro/endividamento" element={<FinanceiroEndividamento />} />
        <Route path="financeiro/antecipacao" element={<FinanceiroAntecipacao />} />
        <Route path="financeiro/gestao" element={<FinanceiroGestao />} />
        <Route path="financeiro/analise" element={<FinanceiroAnalise />} />
        {/* Grupo de Cliente 360 (mesmo gate do financeiro — mostra recebível) */}
        <Route path="gestao/grupos-cliente" element={<GestaoGruposCliente />} />
        <Route path="gestao/grupos-cliente/:grupoId" element={<GrupoCliente360 />} />
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
        <Route path="admin/demand-forecast" element={<AdminDemandForecast />} />
        <Route path="admin/route-planner" element={<AdminRoutePlanner />} />
        <Route path="admin/monthly-reports" element={<AdminMonthlyReports />} />
        <Route path="admin/productivity" element={<AdminProductivity />} />
        {/* Painel do founder — Venda por cliente (master: gate na página e na RPC venda_painel) */}
        <Route path="admin/venda-cliente" element={<VendaClientePainel />} />
        <Route path="admin/loyalty" element={<AdminLoyalty />} />
        <Route path="admin/prime" element={<AdminPrime />} />
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
        <Route path="sales/programados" element={<PedidosProgramados />} />
        <Route path="sales/programados/:id" element={<PedidoProgramadoDetalhe />} />
        <Route path="unified-order" element={<Navigate to="/sales/new" replace />} />
        <Route path="farmer" element={<FarmerDashboard />} />
        <Route path="meu-dia" element={<MeuDia />} />
        <Route path="farmer/calls" element={<FarmerCalls />} />
        <Route path="farmer/carteira" element={<CarteiraBoard />} />
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
        <Route path="producao/bom-excecoes" element={<ProducaoBomExcecoes />} />
        <Route path="producao/apontamento" element={<ProducaoApontamento />} />
        <Route path="admin/reposicao/revisao" element={<Navigate to="/admin/reposicao/sessao/parametros?tab=ajuste" replace />} />
        <Route path="admin/reposicao/historico" element={<AdminReposicaoHistorico />} />
        <Route path="admin/reposicao/alertas" element={<AdminReposicaoAlertas />} />
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
        <Route path="admin/reposicao/venda-perdida" element={<AdminReposicaoVendaPerdida />} />
        {/* Cockpit "Ciclo diário" e etapas 3/4 aposentados (uso real: 0 aprovações em 90d — todas em
            /admin/reposicao/pedidos). As URLs antigas redirecionam para a tela de trabalho. */}
        <Route path="admin/reposicao/sessao" element={<Navigate to="/admin/reposicao/pedidos" replace />} />
        <Route path="admin/reposicao/sessao/mercado" element={<AdminReposicaoMercado />} />
        <Route path="admin/reposicao/sessao/parametros" element={<AdminReposicaoParametros />} />
        <Route path="admin/reposicao/sessao/pedidos" element={<Navigate to="/admin/reposicao/pedidos" replace />} />
        <Route path="admin/reposicao/sessao/confirmacao" element={<Navigate to="/admin/reposicao/pedidos" replace />} />
        <Route path="admin/reposicao/sessao/historico" element={<Navigate to="/admin/reposicao/pedidos" replace />} />
        <Route path="admin/reposicao/cockpit" element={<Navigate to="/admin/reposicao/pedidos" replace />} />
        <Route path="admin/reposicao/mercado" element={<Navigate to="/admin/reposicao/sessao/mercado" replace />} />
        <Route path="admin/reposicao/parametros" element={<Navigate to="/admin/reposicao/sessao/parametros" replace />} />
        <Route path="admin/reposicao/cadastros" element={<AdminReposicaoCadastros />} />
        <Route path="admin/reposicao/embalagem" element={<AdminReposicaoEmbalagem />} />
        <Route path="admin/reposicao/mudancas-automaticas" element={<ParamAutoMudancas />} />
        <Route path="admin/estoque/recebimento" element={<AdminEstoqueRecebimento />} />
        <Route path="admin/estoque/picking" element={<AdminEstoquePicking />} />
        <Route path="admin/estoque/picking/mobile" element={<SeparacaoV2 />} />
        <Route path="tintometrico/catalogo" element={<TintCatalogo />} />
        <Route path="tintometrico/integracao" element={<TintIntegracao />} />
        <Route path="performance" element={<PerformanceHub />} />
        <Route path="vendas/ferramentas" element={<VendasFerramentas />} />
        <Route path="cobranca" element={<Cobranca />} />
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
    </Route>

    <Route path="*" element={<NotFound />} />
  </>
);
registrarRotas(createRoutesFromElements(arvoreDeRotas));

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 60_000, // 1 minute
      // 15min (default é 5): navegação de volta a uma tela já visitada reusa o
      // cache (render instantâneo + refetch em background via staleTime).
      gcTime: 15 * 60_000,
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
      {/* v7_startTransition: navegação entre rotas lazy mantém a tela anterior
          visível durante o load do chunk (sem flash do Suspense global). */}
      <BrowserRouter future={{ v7_startTransition: true }}>
        <MedidorVitals />
        <AuthProvider>
          <ImpersonationProvider>
          <CompanyProvider>
          <ConditionalWebRTCProvider>
          <ErrorBoundary>
          <Suspense fallback={<PageLoader />}>
          <Routes>{arvoreDeRotas}</Routes>
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
