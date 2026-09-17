import type { Context, Next } from "hono";

export interface HfUser {
  name: string;
  fullname?: string;
  avatarUrl?: string;
  email?: string;
}

export function hfAuthMiddleware() {
  const required = process.env.REQUIRE_HF_AUTH === "1";
  return async (c: Context, next: Next) => {
    if (!required) {
      c.set("hfUser", { name: "local_user", fullname: "Local User" });
      c.set("hfToken", "local-dev-token");
      return next();
    }
    return next();
  };
}

export function getHfToken(c: Context): string | null {
  return (c.get("hfToken") as string | undefined) ?? null;
}

export function getHfUser(c: Context): HfUser | null {
  return (c.get("hfUser") as HfUser | undefined) ?? null;
}
