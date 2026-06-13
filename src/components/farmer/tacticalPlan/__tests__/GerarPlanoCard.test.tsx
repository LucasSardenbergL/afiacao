import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { GerarPlanoCard } from "../GerarPlanoCard";
import type { CustomerLite } from "../types";

// GerarPlanoCard lê useImpersonation pra desabilitar a geração na lente "Ver como".
// Fora da lente (isImpersonating=false) os botões seguem habilitados — comportamento testado aqui.
vi.mock("@/contexts/ImpersonationContext", () => ({ useImpersonation: vi.fn(() => ({ isImpersonating: false })) }));

const customers: CustomerLite[] = [
  { id: "c1", name: "Marcenaria Alfa", healthScore: 80, churnRisk: 10 },
  { id: "c2", name: "Móveis Beta", healthScore: 30, churnRisk: 60 },
];

function setup(overrides: Partial<React.ComponentProps<typeof GerarPlanoCard>> = {}) {
  const props: React.ComponentProps<typeof GerarPlanoCard> = {
    searchTerm: "",
    onSearchChange: vi.fn(),
    filteredCustomers: customers,
    generating: null,
    onGenerate: vi.fn(),
    ...overrides,
  };
  render(<GerarPlanoCard {...props} />);
  return props;
}

describe("GerarPlanoCard", () => {
  it("lista os clientes com health score", () => {
    setup();
    expect(screen.getByText("Marcenaria Alfa")).toBeTruthy();
    expect(screen.getByText("HS:80")).toBeTruthy();
  });

  it("dispara onSearchChange ao digitar", () => {
    const props = setup();
    fireEvent.change(screen.getByPlaceholderText("Buscar cliente..."), { target: { value: "alfa" } });
    expect(props.onSearchChange).toHaveBeenCalledWith("alfa");
  });

  it("gera plano essencial e estratégico", () => {
    const props = setup({ filteredCustomers: [customers[0]] });
    fireEvent.click(screen.getByRole("button", { name: /Essencial/ }));
    fireEvent.click(screen.getByRole("button", { name: /Estratégico/ }));
    expect(props.onGenerate).toHaveBeenNthCalledWith(1, "c1", "essencial");
    expect(props.onGenerate).toHaveBeenNthCalledWith(2, "c1", "estrategico");
  });

  it("mostra empty state quando não há clientes", () => {
    setup({ filteredCustomers: [] });
    expect(screen.getByText("Nenhum cliente encontrado")).toBeTruthy();
  });

  it("desabilita os botões do cliente em geração", () => {
    setup({ filteredCustomers: [customers[0]], generating: "c1" });
    const buttons = screen.getAllByRole("button");
    expect(buttons).toHaveLength(2);
    buttons.forEach((b) => expect(b).toHaveProperty("disabled", true));
  });
});
