import { describe, it, expect } from "vitest";
import { fmtPct, fmtDate } from "../format";

describe("fmtPct", () => {
  it("retorna — para null/undefined", () => {
    expect(fmtPct(null)).toBe("—");
    expect(fmtPct(undefined)).toBe("—");
  });
  it("formata com 2 casas e vírgula", () => {
    expect(fmtPct(12.5)).toBe("12,50%");
    expect(fmtPct(0)).toBe("0,00%");
  });
});

describe("fmtDate", () => {
  it("retorna — para vazio", () => {
    expect(fmtDate(null)).toBe("—");
    expect(fmtDate(undefined)).toBe("—");
  });
  it("formata data ISO (yyyy-mm-dd) para pt-BR", () => {
    expect(fmtDate("2026-05-20")).toBe("20/05/2026");
  });
});
