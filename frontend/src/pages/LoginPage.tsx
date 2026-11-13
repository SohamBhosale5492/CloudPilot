import { ShieldCheck } from "lucide-react";
import { useAuth } from "../auth/AuthProvider";

export function LoginPage() {
  const { signIn, error } = useAuth();
  return (
    <main className="login-screen">
      <section className="login-panel">
        <div className="brand-lockup login-brand"><div className="brand-mark">CP</div><div><strong>CloudPilot</strong><small>Observability assurance</small></div></div>
        <div className="login-rule" />
        <div className="login-copy">
          <span className="eyebrow">ENGINEERING WORKSPACE</span>
          <h1>Observe with confidence.</h1>
          <p>Review observability coverage, scan results, and human-reviewed remediation activity across your projects.</p>
        </div>
        {error && <div className="alert alert-danger" role="alert">{error}</div>}
        <button className="btn btn-primary microsoft-signin" onClick={() => void signIn()}>
          <ShieldCheck size={17} /> Continue with Microsoft
        </button>
        <p className="login-footnote">Access is controlled by your organization and CloudPilot role.</p>
      </section>
    </main>
  );
}
