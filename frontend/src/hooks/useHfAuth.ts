import type { OAuthResult } from "@huggingface/hub";

export interface HfAuthState {
  isReady: boolean;
  isSignedIn: boolean;
  isSigningIn: boolean;
  user: OAuthResult["userInfo"] | null;
  accessToken: string | null;
  error: string | null;
  clientId: string | null;
  signIn: () => Promise<void>;
  signOut: () => void;
}

export function useHfAuth(): HfAuthState {
  return {
    isReady: true,
    isSignedIn: true,
    isSigningIn: false,
    user: { preferred_username: "local_user", name: "Local User" } as OAuthResult["userInfo"],
    accessToken: "local-dev-token",
    error: null,
    clientId: "local",
    signIn: async () => {},
    signOut: () => {},
  };
}
