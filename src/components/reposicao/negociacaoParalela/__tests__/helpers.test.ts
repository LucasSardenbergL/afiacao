import { describe, it, expect } from "vitest";
import {
  toggleSet,
  categoriaLabel,
  categoriaBadgeClass,
  statusLabel,
  lastDayOfNextMonth,
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
