import { defineConfig, devices } from "@playwright/test";

// Preview smoke tests: mount a `buildPreviewDoc` output in a real browser
// and assert the boot/diagnostic contract. Dev-only, not copied into the
// Docker image. Browsers must be installed once with `npx playwright
// install chromium`.
export default defineConfig({
  testDir: "tests/e2e",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? "line" : "list",
  use: {
    ...devices["Desktop Chrome"],
    headless: true,
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});
