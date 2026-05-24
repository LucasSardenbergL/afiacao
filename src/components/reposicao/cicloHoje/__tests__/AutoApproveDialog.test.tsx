import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { AutoApproveDialog } from "../AutoApproveDialog";
import type { ManualReviewItem } from "../useCicloHoje";
import type { PedidoItem } from "@/types/reposicao";

const manual: ManualReviewItem[] = [
  {
    item: { id: 7, fornecedor_nome: "ACME" } as unknown as PedidoItem,
    suggestion: { mode: "review", reasons: ["Aumento de preço", "Cobertura alta"] } as ManualReviewItem["suggestion"],
  },
];

function setup(overrides: Partial<React.ComponentProps<typeof AutoApproveDialog>> = {}) {
  const props: React.ComponentProps<typeof AutoApproveDialog> = {
    open: true,
    onOpenChange: vi.fn(),
    eligibleCount: 5,
    autoApprovalGroups: [{ fornecedor: "ACME", qtd: 12 }],
    manualReviewItems: [],
    busy: false,
    onConfirm: vi.fn(),
    ...overrides,
  };
  render(<AutoApproveDialog {...props} />);
  return props;
}

describe("AutoApproveDialog", () => {
  it("mostra a contagem de elegíveis e os grupos por fornecedor", () => {
    setup();
    expect(screen.getByText(/5 pedido\(s\) serão aprovados automaticamente/)).toBeTruthy();
    expect(screen.getByText("ACME")).toBeTruthy();
    expect(screen.getByText("12")).toBeTruthy();
  });

  it("lista itens que ficam para revisão manual com o motivo", () => {
    setup({ manualReviewItems: manual });
    expect(screen.getByText(/1 pedido\(s\) ficarão para aprovação manual/)).toBeTruthy();
    expect(screen.getByText("Aumento de preço; Cobertura alta")).toBeTruthy();
  });

  it("dispara onConfirm e onOpenChange(false) ao cancelar", () => {
    const props = setup();
    fireEvent.click(screen.getByRole("button", { name: /Confirmar aprovação automática/ }));
    fireEvent.click(screen.getByRole("button", { name: /Cancelar/ }));
    expect(props.onConfirm).toHaveBeenCalledTimes(1);
    expect(props.onOpenChange).toHaveBeenCalledWith(false);
  });
});
