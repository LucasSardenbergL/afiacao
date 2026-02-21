import { Toaster } from "@/components/ui/toaster";
import { Toaster as Sonner } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter, Routes, Route } from "react-router-dom";
import { AuthProvider } from "@/contexts/AuthContext";
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
import QualityChecklist from "./pages/QualityChecklist";
import RecurringSchedules from "./pages/RecurringSchedules";
import SavingsDashboard from "./pages/SavingsDashboard";
import ToolHistory from "./pages/ToolHistory";
import ToolPublicHistory from "./pages/ToolPublicHistory";
import NotFound from "./pages/NotFound";

const queryClient = new QueryClient();

const App = () => (
  <QueryClientProvider client={queryClient}>
    <TooltipProvider>
      <Toaster />
      <Sonner />
      <BrowserRouter>
        <AuthProvider>
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
              path="/tools/:toolId"
              element={
                <ProtectedRoute>
                  <ToolHistory />
                </ProtectedRoute>
              }
            />
            <Route path="/tool/:toolId" element={<ToolPublicHistory />} />
            <Route path="*" element={<NotFound />} />
          </Routes>
          <NotificationPrompt />
        </AuthProvider>
      </BrowserRouter>
    </TooltipProvider>
  </QueryClientProvider>
);

export default App;
