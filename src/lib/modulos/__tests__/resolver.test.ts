import { describe, expect, it } from "vitest";
import { donoDoArquivo, validarManifesto } from "../resolver";
import type { ModuloApp, NaoClassificado } from "../tipos";

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

describe("donoDoArquivo", () => {
  it("retorna ids de todos os módulos que reivindicam o path (codigo e testes)", () => {
    const mods = [mod("a", ["src/lib/a/**"]), mod("b", [], ["src/lib/a/x.test.ts"])];
    expect(donoDoArquivo("src/lib/a/x.test.ts", mods).sort()).toEqual(["a", "b"]);
  });
});

describe("validarManifesto", () => {
  const arvore = ["src/lib/a/x.ts", "src/lib/b/y.ts"];

  it("orfao: arquivo sem dono e fora de naoClassificados", () => {
    const p = validarManifesto(arvore, [mod("a", ["src/lib/a/**"])], []);
    expect(p).toEqual([{ tipo: "orfao", detalhe: "src/lib/b/y.ts" }]);
  });

  it("sobreposicao: 2+ donos é erro com ids no detalhe", () => {
    const p = validarManifesto(
      ["src/lib/a/x.ts"],
      [mod("a", ["src/lib/a/**"]), mod("b", ["src/lib/a/x.ts"])],
      [],
    );
    expect(p).toEqual([{ tipo: "sobreposicao", detalhe: "src/lib/a/x.ts → a, b" }]);
  });

  it("glob-morto: padrão que não casa nada é erro (manifesto apodrecendo)", () => {
    const p = validarManifesto(["src/lib/a/x.ts"], [mod("a", ["src/lib/a/**", "src/lib/zumbi/**"])], []);
    expect(p).toEqual([{ tipo: "glob-morto", detalhe: "a: src/lib/zumbi/**" }]);
  });

  it("nao-classificado-inexistente: entrada stale é erro", () => {
    const nc: NaoClassificado[] = [{ path: "src/sumiu.ts", motivo: "bootstrap", desde: "2026-07-08" }];
    const p = validarManifesto(["src/lib/a/x.ts"], [mod("a", ["src/lib/a/**"])], nc);
    expect(p).toEqual([{ tipo: "nao-classificado-inexistente", detalhe: "src/sumiu.ts" }]);
  });

  it("nao-classificado-com-dono: entrada que ganhou dono exige limpeza", () => {
    const nc: NaoClassificado[] = [{ path: "src/lib/a/x.ts", motivo: "bootstrap", desde: "2026-07-08" }];
    const p = validarManifesto(["src/lib/a/x.ts"], [mod("a", ["src/lib/a/**"])], nc);
    expect(p).toEqual([{ tipo: "nao-classificado-com-dono", detalhe: "src/lib/a/x.ts → a" }]);
  });

  it("manifesto íntegro → []", () => {
    const p = validarManifesto(arvore, [mod("a", ["src/lib/a/**"]), mod("b", ["src/lib/b/**"])], []);
    expect(p).toEqual([]);
  });
});
