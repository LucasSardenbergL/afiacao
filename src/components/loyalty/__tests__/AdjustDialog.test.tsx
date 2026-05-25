import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { AdjustDialog } from "../AdjustDialog";

function setup(overrides: Partial<React.ComponentProps<typeof AdjustDialog>> = {}) {
  const props: React.ComponentProps<typeof AdjustDialog> = {
    open: true,
    onOpenChange: vi.fn(),
    type: "earn",
    points: "",
    setPoints: vi.fn(),
    description: "",
    setDescription: vi.fn(),
    onSubmit: vi.fn(),
    loading: false,
    ...overrides,
  };
  render(<AdjustDialog {...props} />);
  return props;
}

describe("AdjustDialog", () => {
  it("título e botão de earn", () => {
    setup({ type: "earn", points: "100" });
    expect(screen.getByText("➕ Adicionar Pontos")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Adicionar Pontos" })).toHaveProperty("disabled", false);
  });

  it("título de redeem", () => {
    setup({ type: "redeem" });
    expect(screen.getByText("🎁 Aprovar Resgate")).toBeTruthy();
  });

  it("desabilita submit sem pontos", () => {
    setup({ type: "earn", points: "" });
    expect(screen.getByRole("button", { name: "Adicionar Pontos" })).toHaveProperty("disabled", true);
  });

  it("dispara onSubmit", () => {
    const props = setup({ type: "earn", points: "50" });
    fireEvent.click(screen.getByRole("button", { name: "Adicionar Pontos" }));
    expect(props.onSubmit).toHaveBeenCalledTimes(1);
  });
});
