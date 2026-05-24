import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { BatchActionsBar } from "../BatchActionsBar";

describe("BatchActionsBar", () => {
  it("mostra contagem e total selecionado", () => {
    render(<BatchActionsBar count={3} totalValue={1500} busy={false} onReject={() => {}} onApprove={() => {}} />);
    expect(screen.getByText("3")).toBeTruthy();
    expect(screen.getByText(/Total:/)).toBeTruthy();
    expect(screen.getByText(/1\.500,00/)).toBeTruthy();
  });

  it("dispara onReject e onApprove", () => {
    const onReject = vi.fn();
    const onApprove = vi.fn();
    render(<BatchActionsBar count={2} totalValue={10} busy={false} onReject={onReject} onApprove={onApprove} />);
    fireEvent.click(screen.getByRole("button", { name: /Rejeitar selecionados/ }));
    fireEvent.click(screen.getByRole("button", { name: /Aprovar selecionados/ }));
    expect(onReject).toHaveBeenCalledTimes(1);
    expect(onApprove).toHaveBeenCalledTimes(1);
  });

  it("desabilita os botões quando busy", () => {
    render(<BatchActionsBar count={2} totalValue={10} busy onReject={() => {}} onApprove={() => {}} />);
    expect(screen.getByRole("button", { name: /Rejeitar selecionados/ })).toHaveProperty("disabled", true);
    expect(screen.getByRole("button", { name: /Aprovar selecionados/ })).toHaveProperty("disabled", true);
  });
});
