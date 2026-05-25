import { describe, it, expect } from "vitest";
import { fmt } from "../format";

describe("bundles/format", () => {
  it("formata em BRL", () => {
    expect(fmt(1000)).toContain("1.000,00");
    expect(fmt(0)).toContain("0,00");
  });
});
