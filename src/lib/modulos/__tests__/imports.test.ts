import { describe, expect, it } from "vitest";
import { extrairImports, resolverImport } from "../imports";

describe("extrairImports — parser TS (risco nº1 da F2 é falso negativo)", () => {
  it("import default/named com from → runtime", () => {
    const r = extrairImports(`import X from "@/lib/a";\nimport { y } from "@/lib/b";`, "x.ts");
    expect(r.imports).toEqual([
      { spec: "@/lib/a", kind: "runtime" },
      { spec: "@/lib/b", kind: "runtime" },
    ]);
    expect(r.naoAnalisaveis).toBe(0);
  });

  it("import type → kind 'type' (conta igual no gate; kind é diagnóstico)", () => {
    const r = extrairImports(`import type { T } from "@/lib/tipos";`, "x.ts");
    expect(r.imports).toEqual([{ spec: "@/lib/tipos", kind: "type" }]);
  });

  it("export … from e export * from → re-export é import arquitetural", () => {
    const r = extrairImports(`export { a } from "@/lib/a";\nexport * from "./b";`, "x.ts");
    expect(r.imports.map((i) => i.spec)).toEqual(["@/lib/a", "./b"]);
  });

  it("export type … from → kind 'type'", () => {
    const r = extrairImports(`export type { T } from "@/lib/tipos";`, "x.ts");
    expect(r.imports).toEqual([{ spec: "@/lib/tipos", kind: "type" }]);
  });

  it("import() dinâmico com literal → runtime (lazy pages do router)", () => {
    const r = extrairImports(`const P = lazy(() => import("./pages/X"));`, "x.tsx");
    expect(r.imports).toEqual([{ spec: "./pages/X", kind: "runtime" }]);
  });

  it("import() dinâmico com template/variável → nao-analisavel contado (nunca ignorado silencioso)", () => {
    const r = extrairImports("const m = await import(`@/lib/${x}`);\nconst n = await import(caminho);", "x.ts");
    expect(r.imports).toEqual([]);
    expect(r.naoAnalisaveis).toBe(2);
  });

  it("vi.mock/jest.mock com literal → runtime (teste também acopla)", () => {
    const r = extrairImports(`vi.mock("@/lib/a");\njest.mock("./b");`, "x.test.ts");
    expect(r.imports.map((i) => i.spec)).toEqual(["@/lib/a", "./b"]);
  });

  it("import multi-linha → capturado (parser real, não regex por linha)", () => {
    const r = extrairImports(`import {\n  a,\n  b,\n} from "@/lib/grande";`, "x.ts");
    expect(r.imports).toEqual([{ spec: "@/lib/grande", kind: "runtime" }]);
  });

  it("import de efeito (side-effect) → runtime", () => {
    const r = extrairImports(`import "./estilos.css";`, "x.ts");
    expect(r.imports).toEqual([{ spec: "./estilos.css", kind: "runtime" }]);
  });

  it("sintaxe TSX não confunde o parser", () => {
    const r = extrairImports(`import A from "@/lib/a";\nexport const C = () => <div a="1" />;`, "x.tsx");
    expect(r.imports).toEqual([{ spec: "@/lib/a", kind: "runtime" }]);
  });
});

describe("resolverImport — resolução por convenção do repo", () => {
  const arvore = new Set([
    "src/lib/a.ts",
    "src/lib/b.tsx",
    "src/lib/c/index.ts",
    "src/lib/d/index.tsx",
    "src/lib/e.d.ts",
    "src/lib/f/estilos.css",
    "src/lib/f/g.ts",
  ]);

  it("@/x resolve para src/x com candidatos .ts/.tsx/.d.ts/index", () => {
    expect(resolverImport("@/lib/a", "src/App.tsx", arvore)).toBe("src/lib/a.ts");
    expect(resolverImport("@/lib/b", "src/App.tsx", arvore)).toBe("src/lib/b.tsx");
    expect(resolverImport("@/lib/c", "src/App.tsx", arvore)).toBe("src/lib/c/index.ts");
    expect(resolverImport("@/lib/d", "src/App.tsx", arvore)).toBe("src/lib/d/index.tsx");
    expect(resolverImport("@/lib/e", "src/App.tsx", arvore)).toBe("src/lib/e.d.ts");
  });

  it("relativo resolve a partir do dir do arquivo de origem", () => {
    expect(resolverImport("./g", "src/lib/f/estilos-usa.ts", arvore)).toBe("src/lib/f/g.ts");
    expect(resolverImport("../a", "src/lib/f/g.ts", arvore)).toBe("src/lib/a.ts");
  });

  it("extensão explícita já presente na árvore resolve exata (css incluso — o filtro arquitetural é do chamador)", () => {
    expect(resolverImport("./estilos.css", "src/lib/f/g.ts", arvore)).toBe("src/lib/f/estilos.css");
  });

  it("pacote npm → null (não é interno)", () => {
    expect(resolverImport("react", "src/App.tsx", arvore)).toBeNull();
    expect(resolverImport("@tanstack/react-query", "src/App.tsx", arvore)).toBeNull();
  });

  it("interno inexistente → null (o chamador conta como não-resolvido, nunca ignora)", () => {
    expect(resolverImport("@/lib/zumbi", "src/App.tsx", arvore)).toBeNull();
  });
});
