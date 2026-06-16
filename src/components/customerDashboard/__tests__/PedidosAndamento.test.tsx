import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import type { NavigateFunction } from "react-router-dom";
import { PedidosAndamento } from "../PedidosAndamento";
import type { Order } from "../types";

const quote: Order = { id: "q1", status: "orcamento_enviado", created_at: "2026-03-15T12:00:00", service_type: "afiação" };
const active: Order = { id: "a1", status: "em_afiacao", created_at: "2026-03-10T12:00:00", service_type: "recuperação" };

describe("PedidosAndamento", () => {
  it("renderiza pedidos com ação e ativos", () => {
    const navigate = vi.fn();
    render(
      <PedidosAndamento
        ordersNeedingAction={[quote]}
        otherActiveOrders={[active]}
        navigate={navigate as unknown as NavigateFunction}
      />,
    );
    expect(screen.getByText("Ação necessária")).toBeTruthy();
    expect(screen.getByText("Orçamento")).toBeTruthy();
    expect(screen.getByText("Em Afiação")).toBeTruthy();
  });

  it("navega em Ver todos", () => {
    const navigate = vi.fn();
    render(
      <PedidosAndamento ordersNeedingAction={[]} otherActiveOrders={[active]} navigate={navigate as unknown as NavigateFunction} />,
    );
    fireEvent.click(screen.getByText(/Ver todos/));
    expect(navigate).toHaveBeenCalledWith("/orders");
  });
});
