import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { EventoDialog } from "../EventoDialog";
import type { NovoEventoForm } from "../types";

const value: NovoEventoForm = {
  tipo_evento: "nota",
  desconto_perc_proposto: "",
  volume_minimo_proposto: "",
  data_evento: "2026-05-22T10:00",
  email_referencia: "",
  conteudo: "",
};

const baseProps = {
  open: true,
  onOpenChange: vi.fn(),
  value,
  onChange: vi.fn(),
  userEmail: "lucas@colacor",
  onSubmit: vi.fn(),
  submitting: false,
};

describe("EventoDialog", () => {
  beforeEach(() => vi.clearAllMocks());

  it("aberto: renderiza título e quem registra", () => {
    render(<EventoDialog {...baseProps} />);
    expect(screen.getByText("Registrar evento de negociação")).toBeTruthy();
    expect(screen.getByText(/Será registrado por: lucas@colacor/)).toBeTruthy();
  });

  it("alterar desconto chama onChange com valor mesclado", () => {
    const onChange = vi.fn();
    render(<EventoDialog {...baseProps} onChange={onChange} />);
    fireEvent.change(screen.getByPlaceholderText("Ex: 25"), {
      target: { value: "25" },
    });
    expect(onChange).toHaveBeenCalledWith({
      ...value,
      desconto_perc_proposto: "25",
    });
  });

  it("Registrar chama onSubmit", () => {
    const onSubmit = vi.fn();
    render(<EventoDialog {...baseProps} onSubmit={onSubmit} />);
    fireEvent.click(screen.getByRole("button", { name: /Registrar/i }));
    expect(onSubmit).toHaveBeenCalledTimes(1);
  });

  it("submitting desabilita o botão Registrar", () => {
    render(<EventoDialog {...baseProps} submitting />);
    const registrar = screen.getByRole("button", { name: /Registrar/i });
    expect((registrar as HTMLButtonElement).disabled).toBe(true);
  });

  it("Cancelar chama onOpenChange(false)", () => {
    const onOpenChange = vi.fn();
    render(<EventoDialog {...baseProps} onOpenChange={onOpenChange} />);
    fireEvent.click(screen.getByRole("button", { name: /Cancelar/i }));
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("fechado: não renderiza o conteúdo", () => {
    render(<EventoDialog {...baseProps} open={false} />);
    expect(
      screen.queryByText("Registrar evento de negociação"),
    ).toBeNull();
  });
});
