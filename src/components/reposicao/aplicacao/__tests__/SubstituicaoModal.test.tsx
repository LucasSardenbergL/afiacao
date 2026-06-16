import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { SubstituicaoModal } from "../SubstituicaoModal";
import type { FilaItem } from "../types";

const item = {
  sku_codigo_omie: "12345",
  sku_descricao: "Lixa X",
  empresa: "OBEN",
} as FilaItem;

function renderModal(over: { onClose?: () => void; onDone?: () => void } = {}) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <SubstituicaoModal
        item={item}
        onClose={over.onClose ?? vi.fn()}
        onDone={over.onDone ?? vi.fn()}
      />
    </QueryClientProvider>,
  );
}

describe("SubstituicaoModal", () => {
  it("renderiza título, SKU antigo e as 3 ações de parâmetros", () => {
    renderModal();
    expect(screen.getByText("Registrar substituição")).toBeTruthy();
    expect(screen.getByText(/12345/)).toBeTruthy();
    expect(screen.getByText("Transferir")).toBeTruthy();
    expect(screen.getByText("Recalcular do zero")).toBeTruthy();
    expect(screen.getByText("Manter ambos")).toBeTruthy();
  });

  it("Cancelar chama onClose", () => {
    const onClose = vi.fn();
    renderModal({ onClose });
    fireEvent.click(screen.getByRole("button", { name: /^Cancelar$/i }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
