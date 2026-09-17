import type { HfUser } from "./auth.js";

export type AppBindings = {
  Variables: {
    hfUser?: HfUser;
    hfToken?: string;
  };
};
