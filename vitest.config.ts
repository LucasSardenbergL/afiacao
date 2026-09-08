import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react-swc";
import path from "path";

export default defineConfig({
  plugins: [react()],
  test: {
    globals: true,
    // Só o setup COMUM aqui; o project `dom` acrescenta o seu (ver abaixo).
    setupFiles: ["./src/test/setup.ts"],
    // Cold-start de um render síncrono (init de módulos + 1ª varredura a11y do getByRole) pode passar dos 5s default quando o suite satura a CPU (M2 8GB). Teto generoso elimina falha falsa sem frear teste que passa; só atrasa morte de hang real.
    // ⚠️ ESTE TETO É PARA RENDER, NÃO PARA GATE QUE VARRE O REPO. Nasceu no #271 (2026-05-24) com 195 arquivos de teste; hoje são 786, e ninguém o redimensionou. Medido em 2026-09-07 (#2311): dos 8.134 testes, só DOIS passam de 10s — os dois `it` de varredura AST de src/__tests__/erro-colapsado-em-vazio-gate.test.ts (12.643ms e 10.263ms sob a suíte completa), que por isso declaram orçamento PRÓPRIO, acima deste. O 3º mais lento fica em 9.820ms, com 2× de folga.
    // Gate de varredura NOVO que encoste em 10s deve declarar o seu teto (3º arg do `it`, POR FONTE), não subir este: subir aqui afrouxaria os outros 8.132 testes para acomodar 2.
    testTimeout: 20000,
    // Dois ambientes, particionados por EXTENSÃO. A união dos dois `include` é EXATAMENTE o
    // `include` único que existia antes (`src/**/*.{test,spec}.{ts,tsx}` + `scripts/**/*.test.ts`),
    // e a interseção é vazia: nenhum arquivo deixa de rodar nem roda duas vezes. O denominador
    // (`Test Files N passed`) é o guarda dessa invariante — se ele cair, um glob deixou arquivo
    // órfão, e um teste que não roda é verde por AUSÊNCIA.
    //
    // Por quê: montar o jsdom era METADE de todo o trabalho da suíte no CI — 289s dos 577s
    // acumulados (406ms por arquivo), contra 64s de teste de verdade. E 2/3 dos arquivos nunca
    // tocam o DOM. Medido no log do CI (a linha `Duration ... (environment ...)` do próprio
    // vitest), NÃO na máquina local: a M2 8GB satura com as worktrees paralelas e distorce
    // qualquer atribuição de custo — o mesmo arquivo já variou 57s→197s sem alteração nenhuma.
    //
    // Por extensão, e não por lista de arquivos, por dois motivos: (1) uma lista de exceções em
    // arquivo compartilhado viraria ímã de conflito entre as ~30 worktrees paralelas; (2) a regra
    // é verificável — TODO `.tsx` do repo toca DOM, e dos `.ts` só 15 tocavam. Esses 15 declaram o
    // ambiente no próprio arquivo (`// @vitest-environment jsdom`), que sobrepõe o project e é
    // local ao arquivo (zero conflito). Arquivo `.ts` NOVO que precise de DOM falha com
    // "document is not defined"; a saída é o mesmo docblock — não afrouxar este particionamento.
    //
    // ⚠️ AO ESCREVER ESSE DOCBLOCK: o vitest procura o token no TEXTO do arquivo, não numa
    // declaração. Citá-lo EM PROSA liga o ambiente — inclusive negando ("sem <token> de
    // propósito" põe o arquivo em jsdom). E o rótulo da saída (`|node|`) é o nome do PROJECT,
    // não o ambiente que rodou, então ele não denuncia a troca: o sintoma é VERDE provando
    // outra coisa. Teste cujo valor depende do ambiente deve ASSERIR o ambiente (ex.:
    // `expect(navigator.onLine).toBeUndefined()` em `src/hooks/useOfflineMutation.node.test.ts`).
    // Medido em 2026-09-07: docs/historico/docblock-de-ambiente-que-liga-o-que-nega.md
    projects: [
      {
        extends: true,
        test: {
          name: "node",
          environment: "node",
          include: ["src/**/*.{test,spec}.ts", "scripts/**/*.test.ts"],
        },
      },
      {
        extends: true,
        test: {
          name: "dom",
          environment: "jsdom",
          include: ["src/**/*.{test,spec}.tsx"],
          // Acrescenta o setup de DOM ao comum — `setupFiles` de project SUBSTITUI o herdado,
          // não soma, então o `setup.ts` precisa ser repetido aqui.
          setupFiles: ["./src/test/setup.ts", "./src/test/setup-dom.ts"],
        },
      },
    ],
  },
  resolve: {
    alias: { "@": path.resolve(__dirname, "./src") },
  },
});
