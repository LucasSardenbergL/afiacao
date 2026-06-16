import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import type { NavigateFunction } from "react-router-dom";
import { OrderRow } from "../OrderRow";
import type { Order } from "../types";

const order: Order = {
  id: "o1",
  status: "orcamento_enviado",
  created_at: "2026-03-15T12:00:00",
  service_type: "afiação",
};

describe("OrderRow", () => {
  it("renderiza status, service_type e dispara navigate ao clicar", () => {
    const navigate = vi.fn();
    render(<OrderRow order={order} index={0} navigate={navigate as unknown as NavigateFunction} />);
    expect(screen.getByText("Orçamento")).toBeTruthy(); // statusConfig label
    expect(screen.getByText("afiação")).toBeTruthy();
    fireEvent.click(screen.getByText("Orçamento"));
    expect(navigate).toHaveBeenCalledWith("/orders/o1");
  });

  it("mostra badge de ação necessária quando needsAction", () => {
    const navigate = vi.fn();
    render(<OrderRow order={order} index={0} navigate={navigate as unknown as NavigateFunction} needsAction />);
    expect(screen.getByText("Ação necessária")).toBeTruthy();
  });
});
