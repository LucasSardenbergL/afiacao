import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { PedidoRow } from "../PedidoRow";
import type { ColKey, PedidoItem } from "@/types/reposicao";

function renderRow(opts: { reviewMode?: boolean; cols?: Partial<Record<ColKey, boolean>>; onToggle?: () => void } = {}) {
  const cols = {
    fornecedor: true, grupo: false, skus: true, valor: true,
    preco: false, confianca: false, status: true, qtdAprovada: false,
    ...opts.cols,
  } as Record<ColKey, boolean>;
  const row = {
    id: 1,
    fornecedor_nome: "ACME Ltda",
    grupo_codigo: "G1",
    num_skus: 7,
    valor_total: 250,
    status: "pendente_aprovacao",
    aprovado_em: null,
    cancelado_em: null,
    pedido_anterior_valor: null,
  } as unknown as PedidoItem;
  return render(
    <table>
      <tbody>
        <PedidoRow
          row={row}
          reviewMode={opts.reviewMode ?? false}
          selected={false}
          onToggle={opts.onToggle ?? (() => {})}
          cols={cols}
          user={{ id: "u1", email: "a@b.c" }}
          onChanged={() => {}}
        />
      </tbody>
    </table>,
  );
}

describe("PedidoRow", () => {
  it("renderiza fornecedor, skus, valor e status", () => {
    renderRow();
    expect(screen.getByText("ACME Ltda")).toBeTruthy();
    expect(screen.getByText("7")).toBeTruthy();
    expect(screen.getByText(/250,00/)).toBeTruthy();
    expect(screen.getByText("pendente_aprovacao")).toBeTruthy();
  });

  it("no modo revisão, mostra o checkbox e dispara onToggle", () => {
    const onToggle = vi.fn();
    renderRow({ reviewMode: true, onToggle });
    const checkbox = screen.getByRole("checkbox");
    fireEvent.click(checkbox);
    expect(onToggle).toHaveBeenCalledTimes(1);
  });
});
