import { describe, it, expect } from "vitest";
import { fmtNum, fmtData, desvioColorClass, cardTone } from "../config";

describe("slaFornecedor/config", () => {
  it("fmtNum trata null/undefined e arredonda", () => {
    expect(fmtNum(null)).toBe("—");
    expect(fmtNum(undefined)).toBe("—");
    expect(fmtNum(3.456)).toBe("3.5");
    expect(fmtNum(3.456, 2)).toBe("3.46");
  });

  it("fmtData trata null e formata DD/MM/AAAA", () => {
    expect(fmtData(null)).toBe("—");
    expect(fmtData("2026-03-15")).toMatch(/^\d{2}\/\d{2}\/\d{4}$/);
  });

  it("desvioColorClass por faixa", () => {
    expect(desvioColorClass(null)).toBe("text-muted-foreground");
    expect(desvioColorClass(5)).toBe("text-success font-medium");
    expect(desvioColorClass(20)).toBe("text-warning font-medium");
    expect(desvioColorClass(40)).toBe("text-warning font-semibold");
    expect(desvioColorClass(60)).toBe("text-destructive font-semibold");
  });

  it("cardTone por faixa de compliance", () => {
    expect(cardTone(null)).toBe("border-border");
    expect(cardTone(95)).toBe("border-success/40 bg-success/5");
    expect(cardTone(75)).toBe("border-warning/40 bg-warning/5");
    expect(cardTone(50)).toBe("border-destructive/40 bg-destructive/5");
  });
});
