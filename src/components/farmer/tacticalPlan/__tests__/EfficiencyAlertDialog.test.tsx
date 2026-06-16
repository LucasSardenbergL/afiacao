import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { EfficiencyAlertDialog } from "../EfficiencyAlertDialog";

describe("EfficiencyAlertDialog", () => {
  it("não renderiza conteúdo quando alert é null", () => {
    render(<EfficiencyAlertDialog alert={null} onClose={vi.fn()} onConfirm={vi.fn()} />);
    expect(screen.queryByText("Potencial Baixo")).toBeNull();
  });

  it("mostra o lucro/hora quando há alerta", () => {
    render(
      <EfficiencyAlertDialog
        alert={{ customerId: "c1", profitPerHour: 30, planType: "essencial" }}
        onClose={vi.fn()}
        onConfirm={vi.fn()}
      />,
    );
    expect(screen.getByText("Potencial Baixo")).toBeTruthy();
    expect(screen.getByText(/30,00\/h/)).toBeTruthy();
  });

  it("dispara onClose e onConfirm", () => {
    const onClose = vi.fn();
    const onConfirm = vi.fn();
    render(
      <EfficiencyAlertDialog
        alert={{ customerId: "c1", profitPerHour: 30, planType: "essencial" }}
        onClose={onClose}
        onConfirm={onConfirm}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Cancelar" }));
    fireEvent.click(screen.getByRole("button", { name: "Continuar" }));
    expect(onClose).toHaveBeenCalled();
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });
});
