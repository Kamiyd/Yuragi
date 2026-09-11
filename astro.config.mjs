import { defineConfig } from "astro/config";
import react from "@astrojs/react";

// 纯静态站：整条流水线都在浏览器里跑，没有后端可代理了。
// `npm run build` 出的 dist/ 直接丢给 Vercel（或者任何静态托管）。
export default defineConfig({
  output: "static",
  integrations: [react()],
  server: { host: true, port: 4321 },
});
