import { describe, expect, it } from "vitest";
import {
  atribuirPorDono,
  contarArquivos,
  montarMarkdown,
  parseErrosTsc,
  parseResultadosVitest,
  statusTestesDoModulo,
  type LinhaBoletim,
} from "../boletim";
import type { ModuloApp } from "../tipos";

const mod = (id: string, codigo: string[], testes: string[] = []): ModuloApp => ({
  id,
  nome: id,
  kind: "negocio",
  rotaPrefixos: [],
  gates: [],
  codigo,
  testes,
  risco: { moneyPath: false, offlineFirst: false, authSensitive: false },
});

describe("contarArquivos", () => {
  it("separa código de teste (glob testes OU nome .test./.spec.)", () => {
    const m = mod("a", ["src/lib/a/**"], ["src/outros/a.test.ts"]);
    const arvore = [
      "src/lib/a/x.ts",
      "src/lib/a/x.test.ts", // dentro do glob codigo, mas é teste pelo nome
      "src/lib/a/y.spec.tsx",
      "src/outros/a.test.ts", // glob testes
      "src/lib/b/z.ts", // de outro módulo — não conta
    ];
    expect(contarArquivos(arvore, m)).toEqual({ codigo: 1, teste: 3 });
  });
});

describe("atribuirPorDono", () => {
  it("agrupa itens pelo módulo dono e conta os sem dono à parte", () => {
    const mods = [mod("a", ["src/lib/a/**"]), mod("b", ["src/lib/b/**"])];
    const { porModulo, semDono } = atribuirPorDono(
      [
        { path: "src/lib/a/x.ts", valor: 1 },
        { path: "src/lib/a/y.ts", valor: 2 },
        { path: "src/lib/b/z.ts", valor: 3 },
        { path: "src/fora.ts", valor: 4 },
      ],
      mods,
    );
    expect(porModulo.get("a")).toEqual([1, 2]);
    expect(porModulo.get("b")).toEqual([3]);
    expect(semDono).toBe(1);
  });
});

describe("parseResultadosVitest", () => {
  const mods = [mod("a", ["src/lib/a/**"]), mod("b", ["src/lib/b/**"])];

  it("atribui pass/fail por arquivo ao módulo dono (name pode ser absoluto)", () => {
    const json = {
      testResults: [
        { name: "/repo/src/lib/a/x.test.ts", status: "passed" },
        { name: "/repo/src/lib/b/y.test.ts", status: "failed" },
      ],
    };
    const r = parseResultadosVitest(json, mods, "/repo");
    expect(r).not.toBe("desconhecido");
    if (r !== "desconhecido") {
      expect(r.get("a")).toEqual({ passaram: 1, falharam: 0 });
      expect(r.get("b")).toEqual({ passaram: 0, falharam: 1 });
    }
  });

  it("shape inesperado → 'desconhecido' (nunca fabricar)", () => {
    expect(parseResultadosVitest({}, mods, "/repo")).toBe("desconhecido");
    expect(parseResultadosVitest(null, mods, "/repo")).toBe("desconhecido");
  });
});

describe("statusTestesDoModulo", () => {
  it("sem arquivos de teste → 'sem-testes' (NUNCA 'passou')", () => {
    expect(statusTestesDoModulo(0, undefined)).toBe("sem-testes");
  });
  it("com testes e resultado ausente → 'desconhecido'", () => {
    expect(statusTestesDoModulo(3, undefined)).toBe("desconhecido");
  });
  it("falha > 0 → 'falhou'; tudo verde → 'passou'", () => {
    expect(statusTestesDoModulo(3, { passaram: 2, falharam: 1 })).toBe("falhou");
    expect(statusTestesDoModulo(3, { passaram: 3, falharam: 0 })).toBe("passou");
  });
});

describe("parseErrosTsc", () => {
  it("extrai paths de linhas de erro e ignora ruído", () => {
    const stdout = [
      "src/lib/a/x.ts(12,5): error TS2322: Type 'string' is not assignable.",
      "  detalhe indentado que não é erro novo",
      "src/lib/b/y.tsx(3,1): error TS2304: Cannot find name 'z'.",
      "Found 2 errors.",
    ].join("\n");
    expect(parseErrosTsc(stdout)).toEqual([{ path: "src/lib/a/x.ts" }, { path: "src/lib/b/y.tsx" }]);
  });
});

describe("montarMarkdown", () => {
  const linha: LinhaBoletim = {
    id: "a",
    arquivos: 10,
    arquivosTeste: 2,
    loc: 500,
    densidade: "0.20 (proxy fraco)",
    churn30d: 4,
    churn90d: "desconhecido",
    testes: "sem-testes",
    testesDetalhe: "",
    errosTs: "desconhecido",
    errosLint: 0,
    riscos: ["money-path"],
  };

  it("inclui seção de metodologia, rotula proxy e preserva 'desconhecido'", () => {
    const md = montarMarkdown([linha], { data: "2026-07-08", naoClassificados: 0, avisos: ["typecheck pulado por flag"] });
    expect(md).toContain("Metodologia e limitações");
    expect(md).toContain("desconhecido");
    expect(md).toContain("proxy");
    expect(md).toContain("sem-testes");
    expect(md).toContain("typecheck pulado por flag");
    expect(md).toContain("Cobertura");
  });
});
