import { describe, expect, it } from "vitest";
import { coletarArestasCross, validarContraBaseline, type Aresta } from "../fronteiras";
import type { ModuloApp } from "../tipos";

const mod = (id: string, kind: "negocio" | "plataforma", codigo: string[]): ModuloApp => ({
  id,
  nome: id,
  kind,
  rotaPrefixos: [],
  gates: [],
  codigo,
  testes: [],
  risco: { moneyPath: false, offlineFirst: false, authSensitive: false },
});

const MODS = [
  mod("a", "negocio", ["src/a/**"]),
  mod("b", "negocio", ["src/b/**"]),
  mod("plataforma", "plataforma", ["src/plat/**", "src/App.tsx"]),
];

const arquivosDe = (conteudos: Record<string, string>) => Object.keys(conteudos).sort();
const leitorDe = (conteudos: Record<string, string>) => (p: string) => conteudos[p] ?? "";

describe("coletarArestasCross — semântica das fronteiras", () => {
  it("negócio→si mesmo e negócio→plataforma NÃO são arestas", () => {
    const conteudos = {
      "src/a/x.ts": `import { y } from "@/a/y";\nimport { p } from "@/plat/p";`,
      "src/a/y.ts": "",
      "src/plat/p.ts": "",
    };
    const r = coletarArestasCross(arquivosDe(conteudos), MODS, [], leitorDe(conteudos));
    expect(r.arestas).toEqual([]);
    expect(r.naoResolvidos).toBe(0);
  });

  it("negócio→negócio é aresta (vazamento)", () => {
    const conteudos = { "src/a/x.ts": `import { z } from "@/b/z";`, "src/b/z.ts": "" };
    const r = coletarArestasCross(arquivosDe(conteudos), MODS, [], leitorDe(conteudos));
    expect(r.arestas).toEqual([
      { de: "src/a/x.ts", para: "src/b/z.ts", deModulo: "a", paraModulo: "b", kind: "runtime" },
    ]);
  });

  it("plataforma→negócio é aresta (inversão)", () => {
    const conteudos = { "src/plat/p.ts": `import { z } from "@/b/z";`, "src/b/z.ts": "" };
    const r = coletarArestasCross(arquivosDe(conteudos), MODS, [], leitorDe(conteudos));
    expect(r.arestas).toHaveLength(1);
    expect(r.arestas[0].deModulo).toBe("plataforma");
  });

  it("composition root declarado é isento (App.tsx lazy-importa as pages de todos)", () => {
    const conteudos = { "src/App.tsx": `const P = () => import("@/b/z");`, "src/b/z.ts": "" };
    const r = coletarArestasCross(arquivosDe(conteudos), MODS, ["src/App.tsx"], leitorDe(conteudos));
    expect(r.arestas).toEqual([]);
  });

  it("import type cross vira aresta com kind 'type' (conta igual, diagnóstico distinto)", () => {
    const conteudos = { "src/a/x.ts": `import type { T } from "@/b/z";`, "src/b/z.ts": "" };
    const r = coletarArestasCross(arquivosDe(conteudos), MODS, [], leitorDe(conteudos));
    expect(r.arestas[0].kind).toBe("type");
  });

  it("alvo css NÃO é dependência arquitetural", () => {
    const conteudos = { "src/a/x.ts": `import "@/b/estilo.css";`, "src/b/estilo.css": "" };
    const r = coletarArestasCross(arquivosDe(conteudos), MODS, [], leitorDe(conteudos));
    expect(r.arestas).toEqual([]);
  });

  it("pacote npm não conta; interno não-resolvido é CONTADO (nunca silencioso)", () => {
    const conteudos = { "src/a/x.ts": `import React from "react";\nimport { s } from "@/b/sumiu";` };
    const r = coletarArestasCross(arquivosDe(conteudos), MODS, [], leitorDe(conteudos));
    expect(r.arestas).toEqual([]);
    expect(r.naoResolvidos).toBe(1);
  });

  it("import() com variável soma em naoAnalisaveis", () => {
    const conteudos = { "src/a/x.ts": "const m = await import(caminho);" };
    const r = coletarArestasCross(arquivosDe(conteudos), MODS, [], leitorDe(conteudos));
    expect(r.naoAnalisaveis).toBe(1);
  });

  it("saída ordenada deterministicamente (de → para → kind)", () => {
    const conteudos = {
      "src/a/z.ts": `import { x } from "@/b/x";`,
      "src/a/a.ts": `import { x } from "@/b/x";\nimport type { T } from "@/b/x";`,
      "src/b/x.ts": "",
    };
    const r = coletarArestasCross(arquivosDe(conteudos), MODS, [], leitorDe(conteudos));
    expect(r.arestas.map((a) => `${a.de}|${a.kind}`)).toEqual([
      "src/a/a.ts|runtime",
      "src/a/a.ts|type",
      "src/a/z.ts|runtime",
    ]);
  });
});

describe("validarContraBaseline — ratchet", () => {
  const aresta = (de: string, kind: "runtime" | "type" = "runtime"): Aresta => ({
    de,
    para: "src/b/z.ts",
    deModulo: "a",
    paraModulo: "b",
    kind,
  });

  it("aresta atual fora da baseline → vazamento-novo", () => {
    const p = validarContraBaseline([aresta("src/a/novo.ts")], []);
    expect(p).toEqual([
      { tipo: "vazamento-novo", detalhe: "src/a/novo.ts → src/b/z.ts (a→b, runtime)" },
    ]);
  });

  it("aresta da baseline que não existe mais → baseline-resolvida (burn-down obrigatório)", () => {
    const p = validarContraBaseline([], [aresta("src/a/velho.ts")]);
    expect(p).toEqual([
      { tipo: "baseline-resolvida", detalhe: "src/a/velho.ts → src/b/z.ts (a→b, runtime)" },
    ]);
  });

  it("mesmo par de arquivos com kind diferente é aresta DIFERENTE", () => {
    const p = validarContraBaseline([aresta("src/a/x.ts", "type")], [aresta("src/a/x.ts", "runtime")]);
    expect(p).toHaveLength(2);
  });

  it("baseline espelha o atual → []", () => {
    const p = validarContraBaseline([aresta("src/a/x.ts")], [aresta("src/a/x.ts")]);
    expect(p).toEqual([]);
  });
});
