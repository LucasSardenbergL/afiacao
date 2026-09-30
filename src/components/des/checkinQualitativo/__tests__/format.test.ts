import { describe, it, expect } from "vitest";
import { fmtPct, fmtDate, numeroOuNulo, coresDoDesconto } from "../format";

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

describe("numeroOuNulo", () => {
  it("ausente vira null, nunca 0 (Number(null) é 0)", () => {
    expect(numeroOuNulo(null)).toBeNull();
    expect(numeroOuNulo(undefined)).toBeNull();
    expect(numeroOuNulo("")).toBeNull();
    expect(numeroOuNulo("  ")).toBeNull();
  });
  it("não-finito vira null", () => {
    expect(numeroOuNulo(Number.NaN)).toBeNull();
    expect(numeroOuNulo(Number.POSITIVE_INFINITY)).toBeNull();
    expect(numeroOuNulo("abc")).toBeNull();
  });
  it("número de verdade passa — inclusive o zero legítimo", () => {
    expect(numeroOuNulo(10.09)).toBe(10.09);
    expect(numeroOuNulo("4.37")).toBe(4.37);
    expect(numeroOuNulo(0)).toBe(0);
  });
});

describe("coresDoDesconto", () => {
  it("sem projetado ou sem máximo: neutro — não pinta vermelho sobre dado ausente", () => {
    for (const [total, max] of [[null, null], [7.5, null], [null, 10]] as const) {
      const c = coresDoDesconto(total, max);
      expect(c.cardColor).toBe("border-border");
      expect(c.totalColor).toBe("text-muted-foreground");
    }
  });
  it("máximo zero não divide: neutro", () => {
    expect(coresDoDesconto(0, 0).cardColor).toBe("border-border");
  });
  it("a razão projetado/máximo decide o tom quando os dois existem", () => {
    expect(coresDoDesconto(10.09, 10.09).cardColor).toContain("status-success");
    expect(coresDoDesconto(7.5, 10).cardColor).toContain("status-warning");
    expect(coresDoDesconto(4.37, 10.09).cardColor).toContain("status-error");
    expect(coresDoDesconto(4.37, 10.09).totalColor).toBe("text-status-error-foreground");
  });
});
