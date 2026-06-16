import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { FiltrosCard } from "../FiltrosCard";

function setup(overrides: Partial<React.ComponentProps<typeof FiltrosCard>> = {}) {
  const props: React.ComponentProps<typeof FiltrosCard> = {
    empresa: "OBEN",
    statusFilter: "todos",
    onStatusChange: vi.fn(),
    search: "",
    onSearchChange: vi.fn(),
    classes: [],
    toggleClasse: vi.fn(),
    clearClasses: vi.fn(),
    ...overrides,
  };
  render(<FiltrosCard {...props} />);
  return props;
}

describe("FiltrosCard", () => {
  it("renderiza as opções de classe consolidada", () => {
    setup();
    expect(screen.getByText("AX")).toBeTruthy();
    expect(screen.getByText("CZ")).toBeTruthy();
  });

  it("dispara toggleClasse ao clicar numa classe", () => {
    const props = setup();
    fireEvent.click(screen.getByText("BY"));
    expect(props.toggleClasse).toHaveBeenCalledWith("BY");
  });

  it("mostra 'Limpar' só quando há classes e dispara clearClasses", () => {
    const props = setup({ classes: ["AX"] });
    const btn = screen.getByRole("button", { name: "Limpar" });
    fireEvent.click(btn);
    expect(props.clearClasses).toHaveBeenCalledTimes(1);
  });

  it("não mostra 'Limpar' sem classes", () => {
    setup({ classes: [] });
    expect(screen.queryByRole("button", { name: "Limpar" })).toBeNull();
  });

  it("dispara onSearchChange ao digitar", () => {
    const props = setup();
    fireEvent.change(screen.getByPlaceholderText(/Ex: 12345/), { target: { value: "tinta" } });
    expect(props.onSearchChange).toHaveBeenCalledWith("tinta");
  });
});
