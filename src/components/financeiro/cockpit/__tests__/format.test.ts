import { describe, it, expect } from "vitest";
import { fmt, fmtCompact, IMPOSTO_LABEL } from "../format";

describe("cockpit/format", () => {
  it("fmt formata em BRL", () => {
    expect(fmt(1000)).toContain("1.000,00");
  });

  it("fmtCompact usa M/k/valor cheio", () => {
    expect(fmtCompact(2_500_000)).toBe("R$ 2.5M");
    expect(fmtCompact(100_000)).toBe("R$ 100.0k");
    expect(fmtCompact(500)).toContain("500,00");
  });

  it("IMPOSTO_LABEL mapeia chaves conhecidas", () => {
    expect(IMPOSTO_LABEL.ded_icms).toBe("ICMS");
    expect(IMPOSTO_LABEL.das).toBe("DAS (Simples)");
    expect(IMPOSTO_LABEL.irpj).toBe("IRPJ");
  });
});
