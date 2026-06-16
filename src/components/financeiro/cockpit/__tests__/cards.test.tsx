import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { Wallet } from "lucide-react";
import { CockpitCard } from "../CockpitCard";
import { MiniCard } from "../MiniCard";

describe("CockpitCard", () => {
  it("renderiza título, valor, detalhe e badge", () => {
    render(
      <CockpitCard
        title="Caixa Disponível"
        value="R$ 10.0k"
        positive
        icon={Wallet}
        detail="Risco de liquidez: Baixo"
        badge="Saldo bancário real"
      />,
    );
    expect(screen.getByText("Caixa Disponível")).toBeTruthy();
    expect(screen.getByText("R$ 10.0k")).toBeTruthy();
    expect(screen.getByText("Risco de liquidez: Baixo")).toBeTruthy();
    expect(screen.getByText("Saldo bancário real")).toBeTruthy();
  });

  it("dispara onClick", () => {
    const onClick = vi.fn();
    render(<CockpitCard title="Caixa" value="R$ 1" positive icon={Wallet} onClick={onClick} />);
    fireEvent.click(screen.getByText("Caixa"));
    expect(onClick).toHaveBeenCalledTimes(1);
  });
});

describe("MiniCard", () => {
  it("renderiza label, valor e subtitle", () => {
    render(<MiniCard label="Inadimplência" value="12.0%" color="text-status-warning" subtitle="R$ 5.0k" />);
    expect(screen.getByText("Inadimplência")).toBeTruthy();
    expect(screen.getByText("12.0%")).toBeTruthy();
    expect(screen.getByText("R$ 5.0k")).toBeTruthy();
  });

  it("dispara onClick", () => {
    const onClick = vi.fn();
    render(<MiniCard label="Aging" value="3.0%" color="text-status-success" onClick={onClick} />);
    fireEvent.click(screen.getByText("Aging"));
    expect(onClick).toHaveBeenCalledTimes(1);
  });
});
