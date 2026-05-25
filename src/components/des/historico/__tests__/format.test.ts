import { describe, it, expect } from "vitest";
import { fmtBRL, fmtPct, fmtDate, quarterDates } from "../format";

describe("historico/format", () => {
  it("fmtBRL trata null/undefined e formata em BRL", () => {
    expect(fmtBRL(null)).toBe("—");
    expect(fmtBRL(undefined)).toBe("—");
    expect(fmtBRL(1000)).toContain("1.000,00");
  });

  it("fmtPct trata null e usa vírgula decimal", () => {
    expect(fmtPct(null)).toBe("—");
    expect(fmtPct(12.5)).toBe("12,50%");
    expect(fmtPct(0)).toBe("0,00%");
  });

  it("fmtDate trata null e formata pt-BR", () => {
    expect(fmtDate(null)).toBe("—");
    expect(fmtDate("2026-03-15")).toBe("15/03/2026");
  });

  it("quarterDates retorna início/fim do trimestre", () => {
    expect(quarterDates(2026, 1)).toEqual({ inicio: "2026-01-01", fim: "2026-03-31" });
    expect(quarterDates(2026, 3)).toEqual({ inicio: "2026-07-01", fim: "2026-09-30" });
  });
});
