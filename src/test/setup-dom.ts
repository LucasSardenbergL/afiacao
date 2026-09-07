// Setup exclusivo do ambiente jsdom (project `dom` em vitest.config.ts). Separado do `setup.ts`
// comum porque estes três blocos só fazem sentido sobre um DOM: sob `node` o `matchMedia` abaixo
// seria ReferenceError na primeira linha, e jest-dom/testing-library seriam import puro de custo.
// Manter os imports ESTÁTICOS é de propósito: `await import("@testing-library/jest-dom")` não
// type-checa (TS2306 — o pacote não é um módulo para import dinâmico), e a saída certa é
// particionar o setup, não silenciar o compilador.
import "@testing-library/jest-dom";
import { configure } from "@testing-library/react";

// Budget dos utilitários ASSÍNCRONOS do testing-library (`findBy*`, `waitFor`).
// Irmão esquecido do `testTimeout: 20000` do vitest.config.ts (#271): aquele PR subiu o teto do
// vitest 5s→20s porque o cold-start sob CPU saturada (M2 8GB) estourava o default — mas
// `findBy*`/`waitFor` NÃO são governados pelo testTimeout. Eles têm budget PRÓPRIO, o
// `asyncUtilTimeout` do @testing-library/dom, que seguiu no default de 1000ms. O resultado é uma
// armadilha de leitura: um `it(..., 15000)` aparenta 15s de folga enquanto o `findByRole` dentro
// dele morre em 1s — e o erro sai como "Unable to find role=..." (parece elemento ausente), não
// como timeout. Foi assim que SalesQuotes.accountGuard (money-path P0-B) piscou sob carga: medido,
// o caminho até a asserção levou 5.894ms sob load 59, contra um budget de 1s.
// O budget é WALL-CLOCK, mas o trabalho (render + varredura a11y) é CPU-bound: com a máquina
// dividida entre dezenas de processos, 1000ms não compra nem as primeiras tentativas do retry.
// 5000ms = 5× o default e ainda 4× ABAIXO do testTimeout de 20s — a folga importa nos dois
// sentidos: quem nunca resolve continua falhando, e falha COM o dump de DOM do testing-library
// em vez do timeout opaco do vitest, que é o que torna o vermelho diagnosticável.
configure({ asyncUtilTimeout: 5000 });

Object.defineProperty(window, "matchMedia", {
  writable: true,
  value: (query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => {},
  }),
});
