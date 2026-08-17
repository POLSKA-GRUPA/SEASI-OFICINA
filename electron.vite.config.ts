import { defineConfig } from "electron-vite";

export default defineConfig({
  main: {
    build: {
      outDir: "out/main",
      lib: { entry: "src/main/index.ts" },
    },
  },
  preload: {
    build: {
      outDir: "out/preload",
      lib: { entry: "src/preload/index.ts" },
      rollupOptions: {
        // sandbox:true exige preload CJS (.js), no ESM (.mjs)
        output: { format: "cjs", entryFileNames: "[name].js" },
      },
    },
  },
  renderer: {
    root: "src/renderer",
    build: {
      outDir: "out/renderer",
      rollupOptions: { input: "src/renderer/index.html" },
    },
  },
});
