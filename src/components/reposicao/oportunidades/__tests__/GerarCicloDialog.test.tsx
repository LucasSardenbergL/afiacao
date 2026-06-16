import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { GerarCicloDialog } from "../GerarCicloDialog";

function noop() { /* */ }

describe("GerarCicloDialog", () => {
  it("fechado → não renderiza", () => {
    render(<GerarCicloDialog open={false} onOpenChange={noop} oportunidadesCount={5} totalEconomia={1000} executando={false} onConfirm={noop} />);
    expect(screen.queryByText("Gerar ciclo de oportunidade do dia")).toBeNull();
  });

  it("aberto → título, contagem, economia; Confirmar dispara onConfirm", () => {
    const onConfirm = vi.fn();
    render(<GerarCicloDialog open onOpenChange={noop} oportunidadesCount={5} totalEconomia={1000} executando={false} onConfirm={onConfirm} />);
    expect(screen.getByText("Gerar ciclo de oportunidade do dia")).toBeTruthy();
    expect(screen.getByText(/5 SKUs/)).toBeTruthy();
    expect(screen.getByText(/1\.000,00/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Confirmar e gerar/ }));
    expect(onConfirm).toHaveBeenCalled();
  });
});
