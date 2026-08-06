import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { TooltipProvider } from "@/components/ui/tooltip";
import type { AcaoExecucao } from "../tipos";

const mockUseUltimaExecucao = vi.fn();
vi.mock("../useUltimaExecucao", () => ({
  useUltimaExecucao: (acao: string | string[]) => mockUseUltimaExecucao(acao),
}));

import { UltimaExecucao } from "../UltimaExecucao";

const BASE: AcaoExecucao = {
  id: "1",
  acao: "analytics_sync.recalcular_custos",
  origem: "manual",
  executado_por: "u1",
  executado_por_nome: "Lucas",
  iniciado_em: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(),
  finalizado_em: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(),
  status: "sucesso",
  detalhes: null,
};

describe("UltimaExecucao", () => {
  it("nunca executada", () => {
    mockUseUltimaExecucao.mockReturnValue({ data: null, isLoading: false });
    render(
      <TooltipProvider>
        <UltimaExecucao acao="x.y" />
      </TooltipProvider>,
    );
    expect(screen.getByText("Nunca executada")).toBeTruthy();
  });

  it("sucesso mostra quem e ✓", () => {
    mockUseUltimaExecucao.mockReturnValue({ data: BASE, isLoading: false });
    render(
      <TooltipProvider>
        <UltimaExecucao acao="x.y" />
      </TooltipProvider>,
    );
    expect(screen.getByText(/Lucas · ✓/)).toBeTruthy();
  });

  it("erro usa tom de erro (text-status-error)", () => {
    mockUseUltimaExecucao.mockReturnValue({ data: { ...BASE, status: "erro" }, isLoading: false });
    const { container } = render(
      <TooltipProvider>
        <UltimaExecucao acao="x.y" />
      </TooltipProvider>,
    );
    expect(container.querySelector(".text-status-error")).toBeTruthy();
  });

  it("carregando → não renderiza nada", () => {
    mockUseUltimaExecucao.mockReturnValue({ data: undefined, isLoading: true });
    const { container } = render(
      <TooltipProvider>
        <UltimaExecucao acao="x.y" />
      </TooltipProvider>,
    );
    expect(container.textContent).toBe("");
  });
});
