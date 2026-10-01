import { describe, it, expect } from "vitest";
import {
  toggleSet,
  categoriaLabel,
  categoriaBadgeClass,
  statusLabel,
  lastDayOfNextMonth,
  extrairCodigoSayerlack,
} from "../helpers";

describe("toggleSet", () => {
  it("adiciona valor ausente sem mutar o original", () => {
    const orig = new Set<string>(["a"]);
    const next = toggleSet(orig, "b");
    expect([...next].sort()).toEqual(["a", "b"]);
    expect([...orig]).toEqual(["a"]); // imutável
  });

  it("remove valor presente", () => {
    const next = toggleSet(new Set(["a", "b"]), "a");
    expect([...next]).toEqual(["b"]);
  });
});

describe("categoriaLabel", () => {
  it("mapeia categorias conhecidas", () => {
    expect(categoriaLabel("prioritario")).toBe("Prioritário");
    expect(categoriaLabel("fraco")).toBe("Fraco");
  });
  it("retorna — para nulo/desconhecido", () => {
    expect(categoriaLabel(null)).toBe("—");
  });
});

describe("categoriaBadgeClass", () => {
  it("retorna classe específica para prioritário e fallback para nulo", () => {
    expect(categoriaBadgeClass("prioritario")).toContain("status-warning");
    expect(categoriaBadgeClass(null)).toContain("muted");
  });
});

describe("statusLabel", () => {
  it("traduz status", () => {
    expect(statusLabel("nova")).toBe("Nova");
    expect(statusLabel("fechada_sem_acordo")).toBe("Fechada sem acordo");
  });
});

describe("lastDayOfNextMonth", () => {
  it("retorna data ISO (YYYY-MM-DD) do último dia do mês seguinte", () => {
    const s = lastDayOfNextMonth();
    expect(s).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});

describe("extrairCodigoSayerlack", () => {
  // Descrições reais de SKUs Sayerlack no Omie (fila da negociação paralela, 01/10/2026).
  it("pega o código do fim da descrição", () => {
    expect(extrairCodigoSayerlack("VERNIZ PU FOSCO FO5.6717.00GL")).toBe("FO5.6717.00GL");
    expect(extrairCodigoSayerlack("THINNER DR.4403L5")).toBe("DR.4403L5");
    expect(extrairCodigoSayerlack("BASE ACAB TRANSP BRIL 20 WFOT.6501GL")).toBe("WFOT.6501GL");
  });

  it("não confunde volume com código: o código começa por letra", () => {
    expect(extrairCodigoSayerlack("SELADORA 0.9L")).toBe("");
    expect(extrairCodigoSayerlack("TINGIDOR CHERRY TEH 3505.103FG")).toBe("");
  });

  it("sem código reconhecível devolve vazio, e quem converte digita", () => {
    expect(extrairCodigoSayerlack("CARTELA DE CORES METALIZADAS CARTMETAL")).toBe("");
    expect(extrairCodigoSayerlack(null)).toBe("");
    expect(extrairCodigoSayerlack("   ")).toBe("");
  });

  it("com dois candidatos, fica com o último", () => {
    expect(extrairCodigoSayerlack("KIT FO.1000GL + CAT FC.6902QT")).toBe("FC.6902QT");
  });
});
