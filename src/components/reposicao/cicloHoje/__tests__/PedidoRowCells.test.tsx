import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { PrecoCell, ConfiancaBadge } from "../PedidoRowCells";
import type { PedidoItem } from "@/types/reposicao";

function row(partial: Partial<PedidoItem>): PedidoItem {
  return partial as unknown as PedidoItem;
}

describe("PrecoCell", () => {
  it("sem valor anterior: mostra só o valor atual (sem delta)", () => {
    render(<PrecoCell row={row({ valor_total: 100, pedido_anterior_valor: null })} />);
    expect(screen.getByText(/100,00/)).toBeTruthy();
    expect(screen.queryByText(/%/)).toBeNull();
  });

  it("com valor anterior: mostra delta percentual positivo", () => {
    render(<PrecoCell row={row({ valor_total: 110, pedido_anterior_valor: 100 })} />);
    expect(screen.getByText("+10.0%")).toBeTruthy();
  });

  it("com queda de preço: delta negativo", () => {
    render(<PrecoCell row={row({ valor_total: 90, pedido_anterior_valor: 100 })} />);
    expect(screen.getByText("-10.0%")).toBeTruthy();
  });
});

describe("ConfiancaBadge", () => {
  it("renderiza o rótulo conforme o status", () => {
    render(<ConfiancaBadge row={row({ status: "pendente_aprovacao" })} />);
    expect(screen.getByText("Alta")).toBeTruthy();
  });

  it("status cancelado → Baixa", () => {
    render(<ConfiancaBadge row={row({ status: "cancelado" })} />);
    expect(screen.getByText("Baixa")).toBeTruthy();
  });
});
