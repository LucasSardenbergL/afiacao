import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react-swc";
import path from "path";

export default defineConfig({
  plugins: [react()],
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["./src/test/setup.ts"],
    include: ["src/**/*.{test,spec}.{ts,tsx}", "scripts/**/*.test.ts"],
    // Cold-start de um render síncrono (init de módulos + 1ª varredura a11y do getByRole) pode passar dos 5s default quando o suite satura a CPU (M2 8GB). Teto generoso elimina falha falsa sem frear teste que passa; só atrasa morte de hang real.
    // ⚠️ ESTE TETO É PARA RENDER, NÃO PARA GATE QUE VARRE O REPO. Nasceu no #271 (2026-05-24) com 195 arquivos de teste; hoje são 786, e ninguém o redimensionou. Medido em 2026-09-07 (#2311): dos 8.134 testes, só DOIS passam de 10s — os dois `it` de varredura AST de src/__tests__/erro-colapsado-em-vazio-gate.test.ts (12.643ms e 10.263ms sob a suíte completa), que por isso declaram orçamento PRÓPRIO, acima deste. O 3º mais lento fica em 9.820ms, com 2× de folga.
    // Gate de varredura NOVO que encoste em 10s deve declarar o seu teto (3º arg do `it`, POR FONTE), não subir este: subir aqui afrouxaria os outros 8.132 testes para acomodar 2.
    testTimeout: 20000,
  },
  resolve: {
    alias: { "@": path.resolve(__dirname, "./src") },
  },
});
