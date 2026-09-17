import type { OAuthResult } from "@huggingface/hub";
import reachyHackerUrl from "../assets/reachy-hacker.png";

interface Model {
  id: string;
  label: string;
}

interface TopBarProps {
  user: OAuthResult["userInfo"] | null;
  models: Model[];
  selectedModel: string | null;
  onModelChange: (id: string) => void;
  onPublish: () => void;
  onSignOut: () => void;
  onReset: () => void;
  onOpenKnowledge: () => void;
  /**
   * When non-null, the Publish button is disabled and this string is
   * shown as the tooltip. Null means the button is active.
   */
  publishDisabledReason: string | null;
}

export function TopBar({
  user,
  models,
  selectedModel,
  onModelChange,
  onPublish,
  onSignOut,
  onReset,
  onOpenKnowledge,
  publishDisabledReason,
}: TopBarProps) {
  return (
    <header className="topbar">
      <div className="topbar-brand">
        <span className="topbar-logo">
          <img src={reachyHackerUrl} alt="" />
        </span>
        <span className="topbar-title-main">Reachy Mini · Vibe Coding Apps</span>
      </div>

      <div className="topbar-spacer" />

      {models.length > 0 && (
        <div className="topbar-model">
          <span>Model</span>
          <select
            value={selectedModel ?? ""}
            onChange={(e) => onModelChange(e.target.value)}
          >
            {models.map((m) => (
              <option key={m.id} value={m.id}>
                {m.label}
              </option>
            ))}
          </select>
        </div>
      )}

      <button
        type="button"
        className="btn btn-ghost"
        onClick={onOpenKnowledge}
        title="Edit long-lived app knowledge the agent always sees"
      >
        Knowledge
      </button>

      <button
        type="button"
        className="btn btn-ghost"
        onClick={onReset}
        title="Reset virtual FS and chat"
      >
        Reset
      </button>

      <button
        type="button"
        className="btn btn-primary"
        onClick={onPublish}
        disabled={publishDisabledReason !== null}
        title={publishDisabledReason ?? "Publish to Hugging Face Space"}
      >
        Publish to HF Space
      </button>

      {user && (
        <div className="topbar-user" title={user.preferred_username}>
          {user.picture ? (
            <img src={user.picture} alt={user.preferred_username} />
          ) : (
            <span className="avatar-fallback">
              {user.preferred_username.slice(0, 1).toUpperCase()}
            </span>
          )}
          <span className="topbar-user-name">{user.preferred_username}</span>
          <button
            type="button"
            className="btn-ghost topbar-user-menu"
            onClick={onSignOut}
            title="Sign out"
          >
            ✕
          </button>
        </div>
      )}
    </header>
  );
}
