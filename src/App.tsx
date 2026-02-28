import { Toaster } from "@/components/ui/toaster";
import { Toaster as Sonner } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter, Routes, Route } from "react-router-dom";
import { AuthProvider } from "@/contexts/AuthContext";
import { CompanyProvider } from "@/contexts/CompanyContext";
import { ProtectedRoute } from "@/components/ProtectedRoute";
import { NotificationPrompt } from "@/components/NotificationPrompt";
import { AppShellLayout } from "@/components/AppShellLayout";
import Index from "./pages/Index";
import Orders from "./pages/Orders";
import OrderDetail from "./pages/OrderDetail";
import NewOrder from "./pages/NewOrder";
import Profile from "./pages/Profile";
import Addresses from "./pages/Addresses";
import Tools from "./pages/Tools";
import Support from "./pages/Support";
import Auth from "./pages/Auth";
import ResetPassword from "./pages/ResetPassword";
import Admin from "./pages/Admin";
import AdminCustomers from "./pages/AdminCustomers";
import AdminOrderDetail from "./pages/AdminOrderDetail";
import AdminDemandForecast from "./pages/AdminDemandForecast";
import AdminRoutePlanner from "./pages/AdminRoutePlanner";
import AdminMonthlyReports from "./pages/AdminMonthlyReports";
import AdminProductivity from "./pages/AdminProductivity";
import AdminLoyalty from "./pages/AdminLoyalty";
import AdminGamification from "./pages/AdminGamification";
import Gamification from "./pages/Gamification";
import QualityChecklist from "./pages/QualityChecklist";
import RecurringSchedules from "./pages/RecurringSchedules";
import SavingsDashboard from "./pages/SavingsDashboard";
import Loyalty from "./pages/Loyalty";
import ToolHistory from "./pages/ToolHistory";
import ToolPublicHistory from "./pages/ToolPublicHistory";
import ToolReports from "./pages/ToolReports";
import AdminTraining from "./pages/AdminTraining";
import AdminPriceTable from "./pages/AdminPriceTable";
import Training from "./pages/Training";
import SalesProducts from "./pages/SalesProducts";
import SalesOrders from "./pages/SalesOrders";
import NewSalesOrder from "./pages/NewSalesOrder";
import UnifiedOrder from "./pages/UnifiedOrder";
import FarmerDashboard from "./pages/FarmerDashboard";
import FarmerCalls from "./pages/FarmerCalls";
import FarmerGovernance from "./pages/FarmerGovernance";
import FarmerRecommendations from "./pages/FarmerRecommendations";
import FarmerLOCC from "./pages/FarmerLOCC";
import FarmerBundles from "./pages/FarmerBundles";
import FarmerCopilot from "./pages/FarmerCopilot";
import FarmerTacticalPlan from "./pages/FarmerTacticalPlan";
import FarmerIPFDashboard from "./pages/FarmerIPFDashboard";
import ExecutiveDashboard from "./pages/ExecutiveDashboard";
import AdminApprovals from "./pages/AdminApprovals";
import NotFound from "./pages/NotFound";
import DesignSystem from "./pages/DesignSystem";
import CoachingSPIN from "./pages/CoachingSPIN";
import SettingsConfig from "./pages/SettingsConfig";
import UXRules from "./pages/UXRules";
import AdminAnalyticsSync from "./pages/AdminAnalyticsSync";
import TechnicalDocs from "./pages/TechnicalDocs";
import IntelligenceDashboard from "./pages/IntelligenceDashboard";
import GovernanceUsers from "./pages/GovernanceUsers";
import GovernancePermissions from "./pages/GovernancePermissions";
import GovernanceMathParams from "./pages/GovernanceMathParams";
import GovernanceAudit from "./pages/GovernanceAudit";

const queryClient = new QueryClient();

const App = () => (
  <QueryClientProvider client={queryClient}>
    <TooltipProvider>
      <Toaster />
      <Sonner />
      <BrowserRouter>
        <AuthProvider>
          <CompanyProvider>
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
              <Route path="new-order" element={<NewOrder />} />
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
              <Route path="unified-order" element={<UnifiedOrder />} />
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
            </Route>

            <Route path="*" element={<NotFound />} />
          </Routes>
          <NotificationPrompt />
          </CompanyProvider>
        </AuthProvider>
      </BrowserRouter>
    </TooltipProvider>
  </QueryClientProvider>
);

export default App;
