/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_HF_OAUTH_CLIENT_ID?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

interface Window {
  huggingface?: {
    variables?: {
      OAUTH_CLIENT_ID?: string;
      OAUTH_SCOPES?: string;
      SPACE_HOST?: string;
      SPACE_ID?: string;
    };
  };
}
