import { describe, it, expect } from "vitest";
import { estadoBadgeClass, formatPeriodo, ESTADOS, EMPRESA, ALL } from "../types";

describe("estadoBadgeClass", () => {
  it("retorna classes por estado e vazio para desconhecido", () => {
    expect(estadoBadgeClass("rascunho")).toContain("status-warning");
    expect(estadoBadgeClass("negociando")).toContain("status-info");
    expect(estadoBadgeClass("ativa")).toContain("status-success");
    expect(estadoBadgeClass("encerrada")).toContain("muted");
    expect(estadoBadgeClass("cancelada")).toContain("destructive");
    expect(estadoBadgeClass("zzz")).toBe("");
  });
});

describe("formatPeriodo", () => {
  it("formata dd/mm/aa – dd/mm/aa", () => {
    expect(formatPeriodo("2026-01-05", "2026-01-20")).toBe("05/01/26 – 20/01/26");
  });
});

describe("constantes", () => {
  it("EMPRESA, ALL e ESTADOS", () => {
    expect(EMPRESA).toBe("OBEN");
    expect(ALL).toBe("__all__");
    expect(ESTADOS.map((e) => e.value)).toEqual(["rascunho", "negociando", "ativa", "encerrada", "cancelada"]);
  });
});
