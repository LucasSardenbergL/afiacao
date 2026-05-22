import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { CancelCampanhaDialog } from "../CancelCampanhaDialog";

describe("CancelCampanhaDialog", () => {
  beforeEach(() => vi.clearAllMocks());

  it("aberto: renderiza o título de confirmação", () => {
    render(
      <CancelCampanhaDialog open onOpenChange={vi.fn()} onConfirm={vi.fn()} />,
    );
    expect(screen.getByText("Cancelar campanha?")).toBeTruthy();
  });

  it("'Sim, cancelar' chama onConfirm", () => {
    const onConfirm = vi.fn();
    render(
      <CancelCampanhaDialog open onOpenChange={vi.fn()} onConfirm={onConfirm} />,
    );
    fireEvent.click(screen.getByRole("button", { name: /Sim, cancelar/i }));
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it("fechado: não renderiza o conteúdo", () => {
    render(
      <CancelCampanhaDialog
        open={false}
        onOpenChange={vi.fn()}
        onConfirm={vi.fn()}
      />,
    );
    expect(screen.queryByText("Cancelar campanha?")).toBeNull();
  });
});
