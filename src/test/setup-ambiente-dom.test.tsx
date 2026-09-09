// Testemunhas do setup no ambiente `dom` (project `dom` do vitest.config.ts).
//
// A partição é por EXTENSÃO, e é ela — não um docblock — que põe este arquivo no jsdom: `.tsx`
// ⇒ project `dom` ⇒ `setupFiles: [setup.ts, setup-dom.ts]`. O irmão `.ts` deste arquivo
// (`setup-ambiente-node.test.ts`) prova o outro lado no project `node`. Separar por ARQUIVO em
// vez de declarar `@vitest-`+`environment` é deliberado: o vitest lê essa diretiva por regex no
// TEXTO INTEIRO do arquivo e citá-la aqui — inclusive em prosa, inclusive negando — trocaria o
// ambiente em silêncio (docs/historico/docblock-de-ambiente-que-liga-o-que-nega.md). A extensão
// não tem esse modo de falhar.
import { describe, it, expect } from "vitest";
import { getConfig } from "@testing-library/react";

describe("setup no ambiente dom", () => {
  it("é MESMO o jsdom — a asserção que o rótulo |dom| não faz", () => {
    // O rótulo da saída do vitest é o nome do PROJECT, não o ambiente que rodou: se algo
    // trocasse o ambiente deste arquivo, a saída continuaria dizendo `|dom|`. Só uma asserção
    // sobre o ambiente denuncia a troca.
    expect(typeof document).not.toBe("undefined");
    expect(typeof window).not.toBe("undefined");
  });

  it("o setup COMUM rodou aqui também: localStorage faz round-trip", () => {
    localStorage.setItem("chave", "valor");
    expect(localStorage.getItem("chave")).toBe("valor");
    localStorage.removeItem("chave");
    expect(localStorage.getItem("chave")).toBeNull();
  });

  it("o setup COMUM rodou aqui também: MediaStream está polifilado", () => {
    // O jsdom não traz WebRTC — este construtor só existe porque `setup.ts` roda nos DOIS
    // ambientes. Se um dia o `setup.ts` sair do project `dom`, esta asserção acusa.
    expect(typeof globalThis.MediaStream).toBe("function");
  });

  it("o setup de DOM rodou: matchMedia existe e ecoa a query", () => {
    // Testemunha do `setup-dom.ts`. O jsdom NÃO implementa `matchMedia`; quem o define é o
    // stub de lá. O eco de `media` distingue o stub de qualquer implementação acidental.
    expect(typeof window.matchMedia).toBe("function");
    const mql = window.matchMedia("(min-width: 768px)");
    expect(mql.matches).toBe(false);
    expect(mql.media).toBe("(min-width: 768px)");
  });

  it("o setup de DOM rodou: asyncUtilTimeout é o orçamento de 5000ms, não o default de 1000ms", () => {
    // A outra metade do `setup-dom.ts`, e a que falha CALADA quando some: com o default de
    // 1000ms os `findBy*` morrem sob carga com "Unable to find role=…" — que parece elemento
    // ausente, não estouro de budget. Um número fixo é exatamente o que uma testemunha pega.
    expect(getConfig().asyncUtilTimeout).toBe(5000);
  });
});
