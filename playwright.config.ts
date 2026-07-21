import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "test/e2e",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 90_000,
  expect: {
    timeout: 5_000,
  },
  use: {
    actionTimeout: 10_000,
    navigationTimeout: 10_000,
  },
  projects: [
    {
      name: "chromium",
      use: {
        browserName: "chromium",
        trace: "retain-on-failure",
        screenshot: "only-on-failure",
        video: "off",
      },
    },
  ],
});
