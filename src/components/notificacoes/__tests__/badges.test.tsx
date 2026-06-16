import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { SeveridadeBadge, StatusBadge } from "../badges";

describe("notificacoes/badges", () => {
  it("SeveridadeBadge por nível", () => {
    const { rerender } = render(<SeveridadeBadge s="urgente" />);
    expect(screen.getByText("urgente")).toBeTruthy();
    rerender(<SeveridadeBadge s="atencao" />);
    expect(screen.getByText("atenção")).toBeTruthy();
    rerender(<SeveridadeBadge s="info" />);
    expect(screen.getByText("info")).toBeTruthy();
  });

  it("StatusBadge por status", () => {
    const { rerender } = render(<StatusBadge s="notificado" />);
    expect(screen.getByText("notificado")).toBeTruthy();
    rerender(<StatusBadge s="falha_notificacao" />);
    expect(screen.getByText("falha")).toBeTruthy();
    rerender(<StatusBadge s="pendente_notificacao" />);
    expect(screen.getByText("pendente_notificacao")).toBeTruthy();
    rerender(<StatusBadge s={null} />);
    expect(screen.getByText("—")).toBeTruthy();
  });
});
