import { describe, it, expect } from "vitest";
import { computePriority } from "../priority";
import type { Order, UserTool } from "../types";

function makeOrder(o: Partial<Order> = {}): Order {
  return { id: "o1", status: "aprovado", created_at: "2026-03-01T12:00:00", service_type: "afiação", ...o };
}
function makeTool(o: Partial<UserTool> = {}): UserTool {
  return {
    id: "t1",
    tool_category_id: "c1",
    next_sharpening_due: null,
    last_sharpened_at: null,
    sharpening_interval_days: 30,
    tool_categories: { name: "Faca", suggested_interval_days: null },
    ...o,
  };
}

describe("computePriority", () => {
  it("orçamento pendente tem prioridade máxima", () => {
    const p = computePriority([makeOrder({ id: "q1", status: "orcamento_enviado" })], [], [makeTool()], true);
    expect(p.type).toBe("quote");
    expect(p.path).toBe("/orders/q1");
    expect(p.orderId).toBe("q1");
  });

  it("ferramentas vencidas em segundo", () => {
    const overdue = [makeTool()];
    const p = computePriority([], overdue, [makeTool()], true);
    expect(p.type).toBe("tools_overdue");
    expect(p.variant).toBe("destructive");
  });

  it("sem ferramentas cadastradas", () => {
    const p = computePriority([], [], [], true);
    expect(p.type).toBe("no_tools");
  });

  it("sem endereço tem precedência sobre nunca_afiada (mesmo cadastrada sem afiar)", () => {
    // makeTool() default é all-null (nunca afiada); sem endereço, o convite de endereço vence
    const p = computePriority([], [], [makeTool()], false);
    expect(p.type).toBe("no_address");
  });

  it("ferramenta cadastrada mas NUNCA afiada → nunca_afiada, não 'tudo em dia'", () => {
    // com endereço e sem afiação alguma: empurra a 1ª afiação em vez de afirmar "bem cuidadas"
    const p = computePriority([], [], [makeTool()], true);
    expect(p.type).toBe("nunca_afiada");
    expect(p.path).toBe("/new-order");
  });

  it("tudo em dia só quando JÁ afiou e está no prazo", () => {
    const p = computePriority(
      [],
      [],
      [makeTool({ last_sharpened_at: "2026-01-01", next_sharpening_due: "2999-01-01" })],
      true,
    );
    expect(p.type).toBe("all_good");
    expect(p.variant).toBe("success");
  });
});
