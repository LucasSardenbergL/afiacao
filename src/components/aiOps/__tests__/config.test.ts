import { describe, it, expect } from "vitest";
import { actionLabels, confidenceBadge } from "../config";

describe("aiOps/config", () => {
  it("actionLabels mapeia ações", () => {
    expect(actionLabels.ligar).toBe("Ligar");
    expect(actionLabels.visitar).toBe("Visitar");
    expect(actionLabels.mensagem).toBe("Enviar mensagem");
  });

  it("confidenceBadge mapeia níveis", () => {
    expect(confidenceBadge.alta).toEqual({ variant: "default", label: "Alta" });
    expect(confidenceBadge.media.label).toBe("Média");
    expect(confidenceBadge.baixa.variant).toBe("outline");
  });
});
