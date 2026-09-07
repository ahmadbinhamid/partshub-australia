import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom";
import { AppProviders } from "@/components/providers/AppProviders";
import { ProtectedRoute } from "@/components/auth/ProtectedRoute";
import { GuestRoute } from "@/components/auth/GuestRoute";
import { ErpLayout } from "@/components/layouts/ErpLayout";
import { SettingsLayout } from "@/components/layouts/SettingsLayout";
import { useAuth } from "@/context/auth";

// Auth pages
import LoginPage from "@/pages/LoginPage";
import RegisterPage from "@/pages/RegisterPage";
import ForgotPasswordPage from "@/pages/ForgotPasswordPage";
import ResetPasswordPage from "@/pages/ResetPasswordPage";

// ERP pages
import DashboardPage from "@/pages/erp/DashboardPage";
import ProductsPage from "@/pages/erp/ProductsPage";
import ProductCreatePage from "@/pages/erp/ProductCreatePage";
import ProductEditPage from "@/pages/erp/ProductEditPage";
import CategoriesPage from "@/pages/erp/CategoriesPage";
import InventoryPage from "@/pages/erp/InventoryPage";
import CustomersPage from "@/pages/erp/CustomersPage";
import CustomerDetailPage from "@/pages/erp/CustomerDetailPage";
import OrdersPage from "@/pages/erp/OrdersPage";
import OrderDetailPage from "@/pages/erp/OrderDetailPage";
import CreateOrderPage from "@/pages/erp/CreateOrderPage";
import PaymentsPage from "@/pages/erp/PaymentsPage";
import ListingsPage from "@/pages/erp/ListingsPage";
import ListingCreatePage from "@/pages/erp/ListingCreatePage";
import ListingEditPage from "@/pages/erp/ListingEditPage";
import ActivityLogPage from "@/pages/erp/ActivityLogPage";
import ProfilePage from "@/pages/erp/ProfilePage";
import BusinessInfoPage from "@/pages/erp/settings/BusinessInfoPage";
import PaymentAccountPage from "@/pages/erp/settings/PaymentAccountPage";
import PaymentSettingsPage from "@/pages/erp/settings/PaymentSettingsPage";
import EmailSettingsPage from "@/pages/erp/settings/EmailSettingsPage";
import EbaySettingsPage from "@/pages/erp/settings/EbaySettingsPage";
import GoogleSettingsPage from "@/pages/erp/settings/GoogleSettingsPage";
import DomainsPage from "@/pages/erp/settings/DomainsPage";
import PayOrderPage from "@/pages/PayOrderPage";

function HomeRedirect() {
  const { isAuthenticated, isLoading } = useAuth();
  if (isLoading) {
    return (
      <div className="grid min-h-dvh place-items-center bg-bg">
        <div className="h-8 w-8 animate-spin rounded-full border-2 border-border border-t-accent" />
      </div>
    );
  }
  return <Navigate to={isAuthenticated ? "/dashboard" : "/login"} replace />;
}

export default function App() {
  return (
    <BrowserRouter
      future={{ v7_startTransition: true, v7_relativeSplatPath: true }}
    >
      <AppProviders>
        <Routes>
          {/* Public — no login, no tenant context beyond the order id + guest
              token in the URL. Shared across every tenant's payment links. */}
          <Route path="/pay/:orderId" element={<PayOrderPage />} />

          <Route
            path="/login"
            element={
              <GuestRoute>
                <LoginPage />
              </GuestRoute>
            }
          />

          <Route
            path="/register"
            element={
              <GuestRoute>
                <RegisterPage />
              </GuestRoute>
            }
          />

          <Route
            path="/auth/forgot-password"
            element={
              <GuestRoute>
                <ForgotPasswordPage />
              </GuestRoute>
            }
          />

          <Route path="/auth/reset-password" element={<ResetPasswordPage />} />

          <Route
            element={
              <ProtectedRoute>
                <ErpLayout />
              </ProtectedRoute>
            }
          >
            <Route path="/dashboard" element={<DashboardPage />} />
            <Route path="/products" element={<ProductsPage />} />
            <Route path="/products/new" element={<ProductCreatePage />} />
            <Route path="/products/:slug/edit" element={<ProductEditPage />} />
            <Route path="/categories" element={<CategoriesPage />} />
            <Route path="/inventory" element={<InventoryPage />} />
            <Route path="/customers" element={<CustomersPage />} />
            <Route path="/customers/:id" element={<CustomerDetailPage />} />
            <Route path="/create-order" element={<CreateOrderPage />} />
            <Route path="/orders" element={<OrdersPage />} />
            <Route path="/orders/:id" element={<OrderDetailPage />} />
            <Route path="/payments" element={<PaymentsPage />} />
            <Route path="/listings" element={<ListingsPage />} />
            <Route path="/listings/new" element={<ListingCreatePage />} />
            <Route path="/listings/:id/edit" element={<ListingEditPage />} />
            <Route path="/activity-log" element={<ActivityLogPage />} />
            <Route path="/profile" element={<ProfilePage />} />

            <Route path="/settings" element={<SettingsLayout />}>
              <Route index element={<Navigate to="/settings/business-info" replace />} />
              <Route path="business-info" element={<BusinessInfoPage />} />
              <Route path="payment-account" element={<PaymentAccountPage />} />
              <Route path="payment-settings" element={<PaymentSettingsPage />} />
              <Route path="email" element={<EmailSettingsPage />} />
              <Route path="ebay" element={<EbaySettingsPage />} />
              <Route path="google" element={<GoogleSettingsPage />} />
              <Route path="domains" element={<DomainsPage />} />
            </Route>
          </Route>

          <Route path="/" element={<HomeRedirect />} />

          <Route path="*" element={<Navigate to="/login" replace />} />
        </Routes>
      </AppProviders>
    </BrowserRouter>
  );
}
