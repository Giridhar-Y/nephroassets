import { Navigate, Route, HashRouter, Routes } from "react-router-dom";
import { Layout } from "./components/Layout.js";
import { RegisterPage } from "./pages/RegisterPage.js";
import { LocationSummaryPage } from "./pages/LocationSummaryPage.js";
import { AuditReconciliationPage } from "./pages/AuditReconciliationPage.js";
import { DepreciationPostingPage } from "./pages/DepreciationPostingPage.js";
import { SettingsPage } from "./pages/SettingsPage.js";
import { LoginPage } from "./pages/LoginPage.js";
import { TransfersPage } from "./pages/TransfersPage.js";
import { CapitalizationPage } from "./pages/CapitalizationPage.js";
import { DisposalPage } from "./pages/DisposalPage.js";
import { ReportsPage } from "./pages/ReportsPage.js";
import { BulkUploadPage } from "./pages/BulkUploadPage.js";
import { SettingsProvider } from "./lib/SettingsContext.js";
import { FiltersProvider } from "./lib/FiltersContext.js";
import { AuthProvider } from "./lib/AuthContext.js";
import { SettingsGate } from "./components/SettingsGate.js";
import { RequireAuth } from "./components/RequireAuth.js";

export default function App() {
  return (
    <AuthProvider>
      <SettingsProvider>
        <FiltersProvider>
          <HashRouter>
            <Routes>
              <Route path="/login" element={<LoginPage />} />
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
                  path="/transfers"
                  element={
                    <SettingsGate>
                      <TransfersPage />
                    </SettingsGate>
                  }
                />
                <Route
                  path="/capitalization"
                  element={
                    <SettingsGate>
                      <CapitalizationPage />
                    </SettingsGate>
                  }
                />
                <Route
                  path="/disposals"
                  element={
                    <SettingsGate>
                      <DisposalPage />
                    </SettingsGate>
                  }
                />
                <Route
                  path="/bulk-upload"
                  element={
                    <SettingsGate>
                      <BulkUploadPage />
                    </SettingsGate>
                  }
                />
                {/* Not gated by SettingsGate: this is where a first-run user configures settings. */}
                <Route path="/settings" element={<SettingsPage />} />
              </Route>
            </Routes>
          </HashRouter>
        </FiltersProvider>
      </SettingsProvider>
    </AuthProvider>
  );
}
