import { HfLogo } from "./HfLogo";
import reachyHackerUrl from "../assets/reachy-hacker.png";

interface SignInScreenProps {
  onSignIn: () => void;
  isSigningIn: boolean;
  error: string | null;
  hasClientId: boolean;
}

export function SignInScreen({
  onSignIn,
  isSigningIn,
  error,
  hasClientId,
}: SignInScreenProps) {
  return (
    <div className="signin-screen">
      <div className="signin-hero" aria-hidden="true">
        <img src={reachyHackerUrl} alt="" />
      </div>
      <h1 className="signin-title">Reachy Mini - Vibe Coding Apps</h1>
      <p className="signin-subtitle">
        <strong>Vibe-code</strong> browser-based apps for your Reachy Mini.
        Describe what you want, preview it <strong>live</strong>, and ship it
        as a <strong>Hugging Face Space</strong> in one click.
      </p>
      <button
        type="button"
        className="signin-button"
        onClick={onSignIn}
        disabled={isSigningIn || !hasClientId}
      >
        <HfLogo size={22} />
        <span>
          {isSigningIn ? "Redirecting…" : "Sign in with Hugging Face"}
        </span>
      </button>

      {!hasClientId && (
        <p className="signin-hint">
          No OAuth client ID detected. On a Hugging Face Space this is injected
          automatically via the Docker entrypoint. For local dev, create an
          OAuth app and set <code>VITE_HF_OAUTH_CLIENT_ID</code> in{" "}
          <code>frontend/.env.local</code>.
        </p>
      )}

      {error && <div className="signin-error">{error}</div>}
    </div>
  );
}
