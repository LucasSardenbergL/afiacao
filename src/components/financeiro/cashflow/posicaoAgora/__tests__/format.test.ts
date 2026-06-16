import { describe, it, expect } from "vitest";
import { fmt, fmtCompact } from "../format";

describe("posicaoAgora/format", () => {
  it("fmt em BRL", () => {
    expect(fmt(1000)).toContain("1.000,00");
  });

  it("fmtCompact usa M/k/valor cheio", () => {
    expect(fmtCompact(2_500_000)).toBe("R$ 2.5M");
    expect(fmtCompact(100_000)).toBe("R$ 100.0k");
    expect(fmtCompact(500)).toContain("500,00");
  });
});
