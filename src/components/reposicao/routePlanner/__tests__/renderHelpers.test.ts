import { describe, it, expect } from "vitest";
import { formatDuration } from "@/components/reposicao/routePlanner/renderHelpers";

describe("formatDuration", () => {
  it("formata minutos puros abaixo de 1h", () => {
    expect(formatDuration(45)).toBe("45min");
  });

  it("formata exatamente 1h sem minutos", () => {
    expect(formatDuration(60)).toBe("1h");
  });

  it("formata 1h30 (90min)", () => {
    expect(formatDuration(90)).toBe("1h30");
  });

  it("formata 2h30 (150min)", () => {
    expect(formatDuration(150)).toBe("2h30");
  });
});
