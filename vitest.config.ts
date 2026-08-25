import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react-swc";
import path from "path";

export default defineConfig({
  plugins: [react()],
  // Espelha os `define` do vite.config: sem isto, código que lê uma const injetada
  // (ex. `__COMMIT_SHA__` em analytics.ts) lança ReferenceError SÓ no teste — o
  // ambiente de teste divergir do de build é bug latente, não detalhe de config.
  define: {
    __COMMIT_SHA__: JSON.stringify("testsha1"),
    __PWA_ENABLED__: JSON.stringify(false),
  },
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["./src/test/setup.ts"],
    include: ["src/**/*.{test,spec}.{ts,tsx}", "scripts/**/*.test.ts"],
    // Cold-start de um render síncrono (init de módulos + 1ª varredura a11y do getByRole) pode passar dos 5s default quando o suite de 184 arquivos satura a CPU (M2 8GB). Teto generoso elimina falha falsa sem frear teste que passa; só atrasa morte de hang real.
    testTimeout: 20000,
  },
  resolve: {
    alias: { "@": path.resolve(__dirname, "./src") },
  },
});
