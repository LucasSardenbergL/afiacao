import { describe, it, expect } from "vitest";
import { fmtBRL, fmtPct } from "../format";

describe("fmtBRL", () => {
  it("retorna — para null/undefined", () => {
    expect(fmtBRL(null)).toBe("—");
    expect(fmtBRL(undefined)).toBe("—");
  });
  it("formata como moeda BRL", () => {
    const s = fmtBRL(1234.5);
    expect(s).toContain("R$");
    expect(s).toContain("1.234,50");
  });
  it("formata zero", () => {
    expect(fmtBRL(0)).toContain("0,00");
  });
});

describe("fmtPct", () => {
  it("retorna — para null/undefined", () => {
    expect(fmtPct(null)).toBe("—");
  });
  it("formata com 2 casas e vírgula", () => {
    expect(fmtPct(12.5)).toBe("12,50%");
    expect(fmtPct(-3)).toBe("-3,00%");
  });
});
