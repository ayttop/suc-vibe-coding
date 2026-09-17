import { Hono } from "hono";
import { AVAILABLE_MODELS, DEFAULT_MODEL } from "./chat.js";

export const modelsRoute = new Hono();

modelsRoute.get("/", (c) =>
  c.json({ models: AVAILABLE_MODELS, default: DEFAULT_MODEL }),
);
