import { describe, it, expect } from "vitest";
import { estadoBadgeClass, formatDate } from "../config";

describe("aumentos/config", () => {
  it("formatDate trata null e formata DD/MM/AA", () => {
    expect(formatDate(null)).toBe("—");
    expect(formatDate("2026-04-15")).toBe("15/04/26");
  });

  it("estadoBadgeClass por estado", () => {
    expect(estadoBadgeClass("ativo")).toContain("status-info");
    expect(estadoBadgeClass("vigente")).toContain("status-success");
    expect(estadoBadgeClass("rascunho")).toContain("status-warning");
    expect(estadoBadgeClass("cancelado")).toContain("destructive");
    expect(estadoBadgeClass("expirado")).toBe("bg-muted text-muted-foreground border-border");
    expect(estadoBadgeClass("desconhecido")).toBe("");
  });
});
