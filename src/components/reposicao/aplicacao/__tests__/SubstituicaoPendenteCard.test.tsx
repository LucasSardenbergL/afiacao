import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { FilaItem } from "../types";

// Mock chainable do supabase: o card dispara a query no mount
// (from→select→eq→eq→eq→maybeSingle).
const maybeSingle = vi.fn();
vi.mock("@/integrations/supabase/client", () => {
  const chain: Record<string, unknown> = {};
  chain.select = () => chain;
  chain.eq = () => chain;
  chain.update = () => chain;
  chain.maybeSingle = () => maybeSingle();
  return { supabase: { from: () => chain } };
});

import { SubstituicaoPendenteCard } from "../SubstituicaoPendenteCard";

const item = {
  sku_codigo_omie: "999",
  sku_descricao: "Antigo X",
  empresa: "OBEN",
} as FilaItem;

function renderCard() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <SubstituicaoPendenteCard item={item} onChange={vi.fn()} />
    </QueryClientProvider>,
  );
}

describe("SubstituicaoPendenteCard", () => {
  beforeEach(() => vi.clearAllMocks());

  it("com substituição pendente → SKU novo/ação/motivo e botões habilitados", async () => {
    maybeSingle.mockResolvedValue({
      data: {
        id: 1,
        sku_codigo_novo: "888",
        acao_parametros: "transferir",
        motivo: "descontinuado",
      },
    });
    renderCard();
    expect(await screen.findByText("888")).toBeTruthy();
    expect(screen.getByText("transferir")).toBeTruthy();
    expect(screen.getByText(/descontinuado/)).toBeTruthy();
    const aplicar = screen.getByRole("button", { name: /Aplicar substituição/i });
    expect((aplicar as HTMLButtonElement).disabled).toBe(false);
  });

  it("sem substituição → badge presente e botões desabilitados", async () => {
    maybeSingle.mockResolvedValue({ data: null });
    renderCard();
    expect(screen.getByText("Substituição pendente")).toBeTruthy();
    await waitFor(() => {
      const aplicar = screen.getByRole("button", { name: /Aplicar substituição/i });
      expect((aplicar as HTMLButtonElement).disabled).toBe(true);
    });
  });
});
