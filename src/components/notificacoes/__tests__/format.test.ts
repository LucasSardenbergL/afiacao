import { describe, it, expect } from "vitest";
import { relTime, fmtDate } from "../format";

describe("notificacoes/format", () => {
  it("relTime formata deltas relativos", () => {
    expect(relTime(new Date().toISOString())).toBe("agora");
    expect(relTime(new Date(Date.now() - 5 * 60000).toISOString())).toBe("há 5m");
    expect(relTime(new Date(Date.now() - 2 * 3600000).toISOString())).toBe("há 2h");
    expect(relTime(new Date(Date.now() - 3 * 86400000).toISOString())).toBe("há 3d");
  });

  it("fmtDate trata null e formata data válida", () => {
    expect(fmtDate(null)).toBe("—");
    expect(fmtDate("2026-03-01T10:00:00Z")).toMatch(/2026/);
  });
});
