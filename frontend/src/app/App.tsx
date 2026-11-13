import { lazy, Suspense, type ReactNode } from "react";
import { Navigate, Route, Routes } from "react-router-dom";
import { useAuth } from "../auth/AuthProvider";
import { hasPermission, type Permission } from "../auth/permissions";
import { Loading } from "../components/Feedback";
import { AppShell } from "../layouts/AppShell";
const AuditEventsPage = lazy(() => import("../pages/AuditEventsPage").then((module) => ({ default: module.AuditEventsPage })));
const FindingsPage = lazy(() => import("../pages/FindingsPage").then((module) => ({ default: module.FindingsPage })));
const GitHubInstallationCallbackPage = lazy(() => import("../pages/GitHubInstallationCallbackPage").then((module) => ({ default: module.GitHubInstallationCallbackPage })));
const LoginPage = lazy(() => import("../pages/LoginPage").then((module) => ({ default: module.LoginPage })));
const OverviewPage = lazy(() => import("../pages/OverviewPage").then((module) => ({ default: module.OverviewPage })));
const ProjectDetailPage = lazy(() => import("../pages/ProjectDetailPage").then((module) => ({ default: module.ProjectDetailPage })));
const ProjectsPage = lazy(() => import("../pages/ProjectsPage").then((module) => ({ default: module.ProjectsPage })));
const RemediationDetailPage = lazy(() => import("../pages/RemediationDetailPage").then((module) => ({ default: module.RemediationDetailPage })));
const RemediationProposalPage = lazy(() => import("../pages/RemediationProposalPage").then((module) => ({ default: module.RemediationProposalPage })));
const RemediationsPage = lazy(() => import("../pages/RemediationsPage").then((module) => ({ default: module.RemediationsPage })));
const ScansPage = lazy(() => import("../pages/ScansPage").then((module) => ({ default: module.ScansPage })));

function RequirePermission({ permission, children }: { permission: Permission; children: ReactNode }) {
  const { account, roles, loading } = useAuth();
  if (loading) return <Loading label="Checking session" />;
  if (!account) return <Navigate to="/login" replace />;
  if (!hasPermission(roles, permission)) return <main className="page-container"><div className="alert alert-warning" role="alert">Your CloudPilot role does not grant <code>{permission}</code>.</div></main>;
  return children;
}

export function App() {
  const { account, loading } = useAuth();
  return <Suspense fallback={<Loading label="Loading page" />}><Routes>
    <Route path="/login" element={loading ? <Loading label="Checking session" /> : account ? <Navigate to="/overview" replace /> : <LoginPage />} />
    <Route path="/github/installations/callback" element={<GitHubInstallationCallbackPage />} />
    <Route element={<AppShell />}>
      <Route path="/" element={<Navigate to={account ? "/overview" : "/login"} replace />} />
      <Route path="/overview" element={<RequirePermission permission="project:read"><OverviewPage /></RequirePermission>} />
      <Route path="/projects" element={<RequirePermission permission="project:read"><ProjectsPage /></RequirePermission>} />
      <Route path="/projects/:projectId" element={<RequirePermission permission="project:read"><ProjectDetailPage /></RequirePermission>} />
      <Route path="/scans" element={<RequirePermission permission="scan:read"><ScansPage /></RequirePermission>} />
      <Route path="/findings" element={<RequirePermission permission="finding:read"><FindingsPage /></RequirePermission>} />
      <Route path="/projects/:projectId/scans/:scanId/findings" element={<RequirePermission permission="finding:read"><FindingsPage /></RequirePermission>} />
      <Route path="/projects/:projectId/scans/:scanId" element={<RequirePermission permission="finding:read"><FindingsPage /></RequirePermission>} />
      <Route path="/remediations" element={<RequirePermission permission="remediation:read"><RemediationsPage /></RequirePermission>} />
      <Route path="/remediations/:remediationId" element={<RequirePermission permission="remediation:read"><RemediationDetailPage /></RequirePermission>} />
      <Route path="/proposals/:proposalId" element={<RequirePermission permission="remediation:read"><RemediationProposalPage /></RequirePermission>} />
      <Route path="/audit-events" element={<RequirePermission permission="audit:read"><AuditEventsPage /></RequirePermission>} />
      <Route path="*" element={<main className="page-container"><h1>Page not found</h1><p className="text-muted">The requested CloudPilot page does not exist.</p></main>} />
    </Route>
  </Routes></Suspense>;
}
