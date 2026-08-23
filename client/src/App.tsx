import { Navigate, Route, HashRouter, Routes } from "react-router-dom";
import { Layout } from "./components/Layout.js";
import { RegisterPage } from "./pages/RegisterPage.js";
import { LocationSummaryPage } from "./pages/LocationSummaryPage.js";
import { AuditReconciliationPage } from "./pages/AuditReconciliationPage.js";
import { DepreciationPostingPage } from "./pages/DepreciationPostingPage.js";
import { SettingsPage } from "./pages/SettingsPage.js";
import { LoginPage } from "./pages/LoginPage.js";
import { ChangePasswordPage } from "./pages/ChangePasswordPage.js";
import { AdminPage } from "./pages/AdminPage.js";
import { TransfersPage } from "./pages/TransfersPage.js";
import { CapitalizationPage } from "./pages/CapitalizationPage.js";
import { DisposalPage } from "./pages/DisposalPage.js";
import { ReportsPage } from "./pages/ReportsPage.js";
import { BulkUploadPage } from "./pages/BulkUploadPage.js";
import { MastersPage } from "./pages/MastersPage.js";
import { AssetSearchPage } from "./pages/AssetSearchPage.js";
import { AssetLifecyclePage } from "./pages/AssetLifecyclePage.js";
import { SettingsProvider } from "./lib/SettingsContext.js";
import { FiltersProvider } from "./lib/FiltersContext.js";
import { AuthProvider } from "./lib/AuthContext.js";
import { SettingsGate } from "./components/SettingsGate.js";
import { RequireAuth } from "./components/RequireAuth.js";
import { RequireAdmin } from "./components/RequireAdmin.js";
import { RequireEditor } from "./components/RequireEditor.js";
import { ToastProvider } from "./components/Toast.js";

export default function App() {
  return (
    <ToastProvider>
    <AuthProvider>
      <SettingsProvider>
        <FiltersProvider>
          <HashRouter>
            <Routes>
              <Route path="/login" element={<LoginPage />} />
              <Route path="/change-password" element={<ChangePasswordPage />} />
              <Route
                element={
                  <RequireAuth>
                    <Layout />
                  </RequireAuth>
                }
              >
                <Route index element={<Navigate to="/register" replace />} />
                <Route
                  path="/register"
                  element={
                    <SettingsGate>
                      <RegisterPage />
                    </SettingsGate>
                  }
                />
                <Route
                  path="/location-summary"
                  element={
                    <SettingsGate>
                      <LocationSummaryPage />
                    </SettingsGate>
                  }
                />
                <Route
                  path="/audit-reconciliation"
                  element={
                    <SettingsGate>
                      <AuditReconciliationPage />
                    </SettingsGate>
                  }
                />
                <Route
                  path="/depreciation-posting"
                  element={
                    <SettingsGate>
                      <DepreciationPostingPage />
                    </SettingsGate>
                  }
                />
                <Route
                  path="/reports"
                  element={
                    <SettingsGate>
                      <ReportsPage />
                    </SettingsGate>
                  }
                />
                <Route
                  path="/assets"
                  element={
                    <SettingsGate>
                      <AssetSearchPage />
                    </SettingsGate>
                  }
                />
                <Route
                  path="/assets/:farId"
                  element={
                    <SettingsGate>
                      <AssetLifecyclePage />
                    </SettingsGate>
                  }
                />
                <Route
                  path="/transfers"
                  element={
                    <RequireEditor>
                      <SettingsGate>
                        <TransfersPage />
                      </SettingsGate>
                    </RequireEditor>
                  }
                />
                <Route
                  path="/capitalization"
                  element={
                    <RequireEditor>
                      <SettingsGate>
                        <CapitalizationPage />
                      </SettingsGate>
                    </RequireEditor>
                  }
                />
                <Route
                  path="/disposals"
                  element={
                    <RequireEditor>
                      <SettingsGate>
                        <DisposalPage />
                      </SettingsGate>
                    </RequireEditor>
                  }
                />
                <Route
                  path="/bulk-upload"
                  element={
                    <RequireEditor>
                      <SettingsGate>
                        <BulkUploadPage />
                      </SettingsGate>
                    </RequireEditor>
                  }
                />
                {/* Not gated by SettingsGate: this is where a first-run user configures settings. */}
                <Route path="/settings" element={<SettingsPage />} />
                {/* Also ungated — an admin should be able to set up master data before FY settings exist. */}
                <Route path="/masters" element={<MastersPage />} />
                <Route
                  path="/admin"
                  element={
                    <RequireAdmin>
                      <AdminPage />
                    </RequireAdmin>
                  }
                />
              </Route>
            </Routes>
          </HashRouter>
        </FiltersProvider>
      </SettingsProvider>
    </AuthProvider>
    </ToastProvider>
  );
}
