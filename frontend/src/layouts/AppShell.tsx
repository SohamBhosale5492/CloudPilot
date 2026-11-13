import { NavLink, Outlet } from "react-router-dom";
import type { ReactNode } from "react";
import {
  Activity, Boxes, ClipboardList, FileSearch, GitPullRequest, LayoutDashboard, LogOut, ScrollText
} from "lucide-react";
import { useAuth } from "../auth/AuthProvider";
import { hasPermission, type Permission } from "../auth/permissions";

const NAV_ITEMS = [
  { label: "Overview", path: "/overview", permission: "project:read" as Permission, icon: LayoutDashboard },
  { label: "Projects", path: "/projects", permission: "project:read" as Permission, icon: Boxes },
  { label: "Scans", path: "/scans", permission: "scan:read" as Permission, icon: Activity },
  { label: "Findings", path: "/findings", permission: "finding:read" as Permission, icon: FileSearch },
  { label: "Remediations", path: "/remediations", permission: "remediation:read" as Permission, icon: GitPullRequest },
  { label: "Audit events", path: "/audit-events", permission: "audit:read" as Permission, icon: ScrollText }
];

export function AppShell() {
  const { account, roles, error, interactionRequired, continueSignIn, signOut } = useAuth();
  const items = NAV_ITEMS.filter((item) => hasPermission(roles, item.permission));
  const name = account?.name || account?.username || "Signed-in user";

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand-lockup"><div className="brand-mark">CP</div><div><strong>CloudPilot</strong><small>Observability assurance</small></div></div>
        <div className="workspace-label">WORKSPACE</div>
        <nav className="side-nav" aria-label="Main navigation">
          {items.map(({ label, path, icon: Icon }) => (
            <NavLink key={path} to={path} className={({ isActive }) => `side-link${isActive ? " active" : ""}`}>
              <Icon size={17} strokeWidth={1.8} aria-hidden="true" /><span>{label}</span>
            </NavLink>
          ))}
        </nav>
        <div className="sidebar-footer"><span className="connection-dot" /> API session active</div>
      </aside>
      <div className="main-column">
        <header className="topbar">
          <div className="breadcrumb-label">CloudPilot <span>/</span> Workspace</div>
          <div className="user-context">
            <div className="user-copy"><strong>{name}</strong><span>{roles.length ? roles.join(" · ") : "Role not available"}</span></div>
            {interactionRequired && <button className="btn btn-sm btn-outline-primary" onClick={() => void continueSignIn()}>Continue sign-in</button>}
            <button className="btn btn-sm btn-outline-secondary signout-button" onClick={() => void signOut()} title="Sign out"><LogOut size={15} /> <span>Sign out</span></button>
          </div>
        </header>
        {error && <div className="auth-alert" role="alert"><span>{error}</span>{interactionRequired && <button className="btn btn-sm btn-primary" onClick={() => void continueSignIn()}>Continue</button>}</div>}
        <main className="page-container"><Outlet /></main>
      </div>
    </div>
  );
}

export function PageHeading({ title, description, actions }: { title: string; description?: string; actions?: ReactNode }) {
  return <div className="page-heading"><div><h1>{title}</h1>{description && <p>{description}</p>}</div>{actions && <div className="heading-actions">{actions}</div>}</div>;
}

export function SectionHeading({ title, detail }: { title: string; detail?: string }) {
  return <div className="section-heading"><div><h2>{title}</h2>{detail && <p>{detail}</p>}</div></div>;
}

export function DataTable({ children }: { children: ReactNode }) {
  return <div className="table-responsive"><table className="table align-middle data-table">{children}</table></div>;
}

export function EmptyPageIcon() {
  return <ClipboardList size={22} strokeWidth={1.7} aria-hidden="true" />;
}
