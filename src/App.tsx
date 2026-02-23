import { Toaster } from "@/components/ui/toaster";
import { Toaster as Sonner } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter, Routes, Route } from "react-router-dom";
import { AuthProvider } from "@/contexts/AuthContext";
import { CompanyProvider } from "@/contexts/CompanyContext";
import { ProtectedRoute } from "@/components/ProtectedRoute";
import { NotificationPrompt } from "@/components/NotificationPrompt";
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
import FarmerDashboard from "./pages/FarmerDashboard";
import FarmerCalls from "./pages/FarmerCalls";
import NotFound from "./pages/NotFound";


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
            <Route path="/auth" element={<Auth />} />
            <Route path="/reset-password" element={<ResetPassword />} />
            <Route
              path="/"
              element={
                <ProtectedRoute>
                  <Index />
                </ProtectedRoute>
              }
            />
            <Route
              path="/orders"
              element={
                <ProtectedRoute>
                  <Orders />
                </ProtectedRoute>
              }
            />
            <Route
              path="/orders/:id"
              element={
                <ProtectedRoute>
                  <OrderDetail />
                </ProtectedRoute>
              }
            />
            <Route
              path="/new-order"
              element={
                <ProtectedRoute>
                  <NewOrder />
                </ProtectedRoute>
              }
            />
            <Route
              path="/profile"
              element={
                <ProtectedRoute>
                  <Profile />
                </ProtectedRoute>
              }
            />
            <Route
              path="/addresses"
              element={
                <ProtectedRoute>
                  <Addresses />
                </ProtectedRoute>
              }
            />
            <Route
              path="/tools"
              element={
                <ProtectedRoute>
                  <Tools />
                </ProtectedRoute>
              }
            />
            <Route
              path="/support"
              element={
                <ProtectedRoute>
                  <Support />
                </ProtectedRoute>
              }
            />
            <Route
              path="/admin"
              element={
                <ProtectedRoute>
                  <Admin />
                </ProtectedRoute>
              }
            />
            <Route
              path="/admin/customers"
              element={
                <ProtectedRoute>
                  <AdminCustomers />
                </ProtectedRoute>
              }
            />
            <Route
              path="/admin/customers/:customerId"
              element={
                <ProtectedRoute>
                  <AdminCustomers />
                </ProtectedRoute>
              }
            />
            <Route
              path="/admin/orders/:id"
              element={
                <ProtectedRoute>
                  <AdminOrderDetail />
                </ProtectedRoute>
              }
            />
            <Route
              path="/admin/demand-forecast"
              element={
                <ProtectedRoute>
                  <AdminDemandForecast />
                </ProtectedRoute>
              }
            />
            <Route
              path="/admin/route-planner"
              element={
                <ProtectedRoute>
                  <AdminRoutePlanner />
                </ProtectedRoute>
              }
            />
            <Route
              path="/admin/monthly-reports"
              element={
                <ProtectedRoute>
                  <AdminMonthlyReports />
                </ProtectedRoute>
              }
            />
            <Route
              path="/admin/productivity"
              element={
                <ProtectedRoute>
                  <AdminProductivity />
                </ProtectedRoute>
              }
            />
            <Route
              path="/admin/loyalty"
              element={
                <ProtectedRoute>
                  <AdminLoyalty />
                </ProtectedRoute>
              }
            />
            <Route
              path="/admin/orders/:id/quality"
              element={
                <ProtectedRoute>
                  <QualityChecklist />
                </ProtectedRoute>
              }
            />
            <Route
              path="/recurring-schedules"
              element={
                <ProtectedRoute>
                  <RecurringSchedules />
                </ProtectedRoute>
              }
            />
            <Route
              path="/savings"
              element={
                <ProtectedRoute>
                  <SavingsDashboard />
                </ProtectedRoute>
              }
            />
            <Route
              path="/loyalty"
              element={
                <ProtectedRoute>
                  <Loyalty />
                </ProtectedRoute>
              }
            />
            <Route
              path="/gamification"
              element={
                <ProtectedRoute>
                  <Gamification />
                </ProtectedRoute>
              }
            />
            <Route
              path="/admin/gamification"
              element={
                <ProtectedRoute>
                  <AdminGamification />
                </ProtectedRoute>
              }
            />
            <Route
              path="/tools/:toolId"
              element={
                <ProtectedRoute>
                  <ToolHistory />
                </ProtectedRoute>
              }
            />
            <Route
              path="/tools/:toolId/reports"
              element={
                <ProtectedRoute>
                  <ToolReports />
                </ProtectedRoute>
              }
            />
            <Route
              path="/admin/training"
              element={
                <ProtectedRoute>
                  <AdminTraining />
                </ProtectedRoute>
              }
            />
            <Route
              path="/training"
              element={
                <ProtectedRoute>
                  <Training />
                </ProtectedRoute>
              }
            />
            <Route
              path="/admin/price-table"
              element={
                <ProtectedRoute>
                  <AdminPriceTable />
                </ProtectedRoute>
              }
            />
            <Route path="/tool/:toolId" element={<ToolPublicHistory />} />
            <Route
              path="/sales"
              element={
                <ProtectedRoute>
                  <SalesOrders />
                </ProtectedRoute>
              }
            />
            <Route
              path="/sales/products"
              element={
                <ProtectedRoute>
                  <SalesProducts />
                </ProtectedRoute>
              }
            />
            <Route
              path="/sales/new"
              element={
                <ProtectedRoute>
                  <NewSalesOrder />
                </ProtectedRoute>
              }
            />
            <Route
              path="/farmer"
              element={
                <ProtectedRoute>
                  <FarmerDashboard />
                </ProtectedRoute>
              }
            />
            <Route
              path="/farmer/calls"
              element={
                <ProtectedRoute>
                  <FarmerCalls />
                </ProtectedRoute>
              }
            />
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
