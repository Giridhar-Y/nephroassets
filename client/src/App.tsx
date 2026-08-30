import { Navigate, Route, HashRouter, Routes } from "react-router-dom";
import { Layout } from "./components/Layout.js";
import { RegisterPage } from "./pages/RegisterPage.js";
import { LocationSummaryPage } from "./pages/LocationSummaryPage.js";
import { AuditReconciliationPage } from "./pages/AuditReconciliationPage.js";
import { DepreciationPostingPage } from "./pages/DepreciationPostingPage.js";
import { TransferDepreciationReportPage } from "./pages/TransferDepreciationReportPage.js";
import { SettingsPage } from "./pages/SettingsPage.js";
import { LoginPage } from "./pages/LoginPage.js";
import { ChangePasswordPage } from "./pages/ChangePasswordPage.js";
import { AdminPage } from "./pages/AdminPage.js";
import { ActivityLogPage } from "./pages/ActivityLogPage.js";
import { TransfersPage } from "./pages/TransfersPage.js";
import { CapitalizationPage } from "./pages/CapitalizationPage.js";
import { AdditionsPage } from "./pages/AdditionsPage.js";
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
import { RequirePermission } from "./components/RequirePermission.js";
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
                    <RequirePermission module="register" action="view">
                      <SettingsGate>
                        <RegisterPage />
                      </SettingsGate>
                    </RequirePermission>
                  }
                />
                <Route
                  path="/location-summary"
                  element={
                    <RequirePermission module="reports" action="view">
                      <SettingsGate>
                        <LocationSummaryPage />
                      </SettingsGate>
                    </RequirePermission>
                  }
                />
                <Route
                  path="/audit-reconciliation"
                  element={
                    <RequirePermission module="reports" action="view">
                      <SettingsGate>
                        <AuditReconciliationPage />
                      </SettingsGate>
                    </RequirePermission>
                  }
                />
                <Route
                  path="/depreciation-posting"
                  element={
                    <RequirePermission module="reports" action="view">
                      <SettingsGate>
                        <DepreciationPostingPage />
                      </SettingsGate>
                    </RequirePermission>
                  }
                />
                <Route
                  path="/reports"
                  element={
                    <RequirePermission module="reports" action="view">
                      <SettingsGate>
                        <ReportsPage />
                      </SettingsGate>
                    </RequirePermission>
                  }
                />
                <Route
                  path="/transfer-depreciation-report"
                  element={
                    <RequirePermission module="reports" action="view">
                      <SettingsGate>
                        <TransferDepreciationReportPage />
                      </SettingsGate>
                    </RequirePermission>
                  }
                />
                <Route
                  path="/assets"
                  element={
                    <RequirePermission module="assetHistory" action="view">
                      <SettingsGate>
                        <AssetSearchPage />
                      </SettingsGate>
                    </RequirePermission>
                  }
                />
                <Route
                  path="/assets/:farId"
                  element={
                    <RequirePermission module="assetHistory" action="view">
                      <SettingsGate>
                        <AssetLifecyclePage />
                      </SettingsGate>
                    </RequirePermission>
                  }
                />
                <Route
                  path="/transfers"
                  element={
                    <RequirePermission module="transfers" action="view">
                      <SettingsGate>
                        <TransfersPage />
                      </SettingsGate>
                    </RequirePermission>
                  }
                />
                <Route
                  path="/capitalization"
                  element={
                    <RequirePermission module="capitalization" action="view">
                      <SettingsGate>
                        <CapitalizationPage />
                      </SettingsGate>
                    </RequirePermission>
                  }
                />
                <Route
                  path="/disposals"
                  element={
                    <RequirePermission module="disposals" action="view">
                      <SettingsGate>
                        <DisposalPage />
                      </SettingsGate>
                    </RequirePermission>
                  }
                />
                <Route
                  path="/additions"
                  element={
                    <RequirePermission module="additions" action="view">
                      <SettingsGate>
                        <AdditionsPage />
                      </SettingsGate>
                    </RequirePermission>
                  }
                />
                <Route
                  path="/bulk-upload"
                  element={
                    <RequirePermission module="bulkUpload" anyOf={["capitalization", "transfers", "disposals", "merge"]}>
                      <SettingsGate>
                        <BulkUploadPage />
                      </SettingsGate>
                    </RequirePermission>
                  }
                />
                {/* Not gated by SettingsGate: this is where a first-run user configures settings. */}
                <Route
                  path="/settings"
                  element={
                    <RequirePermission module="settings" action="view">
                      <SettingsPage />
                    </RequirePermission>
                  }
                />
                {/* Also ungated by SettingsGate — a Masters editor should be able to set up master
                    data before FY settings exist. */}
                <Route
                  path="/masters"
                  element={
                    <RequirePermission module="masters" action="view">
                      <MastersPage />
                    </RequirePermission>
                  }
                />
                <Route
                  path="/admin"
                  element={
                    <RequirePermission module="admin" action="view">
                      <AdminPage />
                    </RequirePermission>
                  }
                />
                <Route
                  path="/activity-log"
                  element={
                    <RequirePermission module="activityLog" action="view">
                      <ActivityLogPage />
                    </RequirePermission>
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
