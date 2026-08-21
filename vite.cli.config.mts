import { defineConfig } from "vite";

// Bundle de la CLI `seasi` (Node puro, sin Electron).
export default defineConfig({
  build: {
    outDir: "out/cli",
    emptyOutDir: true,
    ssr: true,
    lib: {
      entry: "src/cli/seasi.ts",
      formats: ["es"],
      fileName: () => "seasi.js",
    },
    rollupOptions: {
      output: { banner: "#!/usr/bin/env node" },
    },
  },
  ssr: { noExternal: ["zod"] },
});
