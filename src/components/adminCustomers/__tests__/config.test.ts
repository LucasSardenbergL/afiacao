import { describe, it, expect } from "vitest";
import { formatDocument, HEALTH_CLASSES, fmt } from "../config";

describe("adminCustomers/config", () => {
  it("formatDocument formata CPF/CNPJ e trata null/outros", () => {
    expect(formatDocument(null)).toBe("-");
    expect(formatDocument("12345678901")).toBe("123.456.789-01");
    expect(formatDocument("12345678000199")).toBe("12.345.678/0001-99");
    expect(formatDocument("123")).toBe("123");
  });

  it("HEALTH_CLASSES mapeia rótulos", () => {
    expect(HEALTH_CLASSES.saudavel.label).toBe("Saudável");
    expect(HEALTH_CLASSES.alerta.label).toBe("Alerta");
    expect(HEALTH_CLASSES.critico.label).toBe("Crítico");
  });

  it("fmt em BRL", () => {
    expect(fmt(1000)).toContain("1.000,00");
  });
});
