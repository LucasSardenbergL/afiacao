import { describe, it, expect } from "vitest";
import { getTier } from "../config";

describe("loyalty/config getTier", () => {
  it("classifica por faixa de saldo", () => {
    expect(getTier(0).name).toBe("Bronze");
    expect(getTier(199).name).toBe("Bronze");
    expect(getTier(200).name).toBe("Prata");
    expect(getTier(499).name).toBe("Prata");
    expect(getTier(500).name).toBe("Ouro");
    expect(getTier(999).name).toBe("Ouro");
    expect(getTier(1000).name).toBe("Diamante");
    expect(getTier(5000).name).toBe("Diamante");
  });
});
