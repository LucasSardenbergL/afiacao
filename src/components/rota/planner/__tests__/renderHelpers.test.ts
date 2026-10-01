import { describe, it, expect } from "vitest";
import type { ReactElement } from "react";
import { formatDuration, getOrderBadge, semCompraHa30Dias } from "@/components/rota/planner/renderHelpers";
import type { ManualCustomer } from "@/components/rota/planner/types";

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

function cliente(over: Partial<ManualCustomer>): ManualCustomer {
  return {
    user_id: "u1", name: "Cliente", phone: null, city: "", neighborhood: "", hasAddress: false,
    address: { street: "", number: "", neighborhood: "", city: "", state: "", zip_code: "" },
    lastVisitDate: null, lastOrderDate: null, daysSinceLastVisit: null, daysSinceLastOrder: null,
    compraIndisponivel: false,
    ...over,
  };
}

const textoDoBadge = (el: ReturnType<typeof getOrderBadge>) =>
  [(el as ReactElement<{ children: unknown }> | null)?.props.children].flat().join("");

describe("roteirizador — compra INDISPONÍVEL não é 'nunca comprou'", () => {
  it("filtro 'sem compra 30d': indisponível fica de fora, mesmo com daysSinceLastOrder null", () => {
    expect(semCompraHa30Dias(cliente({ compraIndisponivel: true }))).toBe(false);
    // o mesmo null, com a leitura OK, é "nunca comprou" — entra no filtro
    expect(semCompraHa30Dias(cliente({ compraIndisponivel: false }))).toBe(true);
  });

  it("filtro 'sem compra 30d': a fronteira dos 30 dias", () => {
    expect(semCompraHa30Dias(cliente({ daysSinceLastOrder: 31 }))).toBe(true);
    expect(semCompraHa30Dias(cliente({ daysSinceLastOrder: 30 }))).toBe(false);
  });

  it("o badge diz que a compra está indisponível (e não some, como o 'nunca comprou')", () => {
    expect(textoDoBadge(getOrderBadge(cliente({ compraIndisponivel: true })))).toBe("Compra indisponível");
    expect(getOrderBadge(cliente({ compraIndisponivel: false }))).toBeNull();
    expect(textoDoBadge(getOrderBadge(cliente({ daysSinceLastOrder: 120 })))).toBe("Sem compra há 120 dias");
  });
});
