import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { AlertaDrawer } from "../AlertaDrawer";
import type { AlertaRow } from "../types";

function makeAlerta(o: Partial<AlertaRow> = {}): AlertaRow {
  return {
    id: 7,
    empresa: "OBEN",
    fornecedor_nome: "Forn A",
    tipo: "aumento",
    severidade: "urgente",
    titulo: "Reajuste X",
    mensagem: "corpo da mensagem",
    status: "notificado",
    tentativas: 2,
    criado_em: "2026-03-01T10:00:00Z",
    notificado_em: "2026-03-01T11:00:00Z",
    gmail_message_id: "gmid123",
    calendar_evento_id: null,
    erro_notificacao: null,
    metadata: null,
    data_evento: null,
    ...o,
  };
}

describe("AlertaDrawer", () => {
  it("não renderiza conteúdo quando alerta é null", () => {
    render(<AlertaDrawer alerta={null} onOpenChange={vi.fn()} />);
    expect(screen.queryByText("Reajuste X")).toBeNull();
  });

  it("renderiza detalhes e link do Gmail", () => {
    render(<AlertaDrawer alerta={makeAlerta()} onOpenChange={vi.fn()} />);
    expect(screen.getByText("Reajuste X")).toBeTruthy();
    expect(screen.getByText("corpo da mensagem")).toBeTruthy();
    expect(screen.getByText("Forn A")).toBeTruthy();
    expect(screen.getByText(/Abrir no Gmail/)).toBeTruthy();
  });

  it("mostra a seção de erro quando há erro_notificacao", () => {
    render(<AlertaDrawer alerta={makeAlerta({ erro_notificacao: "timeout SMTP" })} onOpenChange={vi.fn()} />);
    expect(screen.getByText("Erro de notificação")).toBeTruthy();
    expect(screen.getByText("timeout SMTP")).toBeTruthy();
  });
});
