import { defineConfig } from "vitest/config";

const live = process.env.RECALL_LIVE_AI === "1";

export default defineConfig({
  test: {
    environment: "node",
    include: ["server/test/**/*.test.ts", "web/src/**/*.test.ts"],
    // Live tests call the real Claude API, so they only run through `npm run test:live`.
    exclude: live ? ["**/node_modules/**"] : ["**/node_modules/**", "**/*.live.test.ts"],
  },
});
