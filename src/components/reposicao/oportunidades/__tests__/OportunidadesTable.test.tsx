import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { TooltipProvider } from "@/components/ui/tooltip";
import { OportunidadesTable } from "../OportunidadesTable";
import type { Oportunidade } from "../types";
import type { useNavigate } from "react-router-dom";

const navigate = vi.fn() as unknown as ReturnType<typeof useNavigate>;

const op = {
  empresa: "OBEN",
  sku_codigo_omie: 999,
  sku_descricao: "Verniz Premium",
  fornecedor_nome: "SAYERLACK",
  cenario: "promo_flat",
  desconto_total_perc: 12.5,
  desconto_promo_perc: 10,
  aumento_evitado_perc: 0,
  tem_negociacao_extra: false,
  data_limite_acao: "2026-01-20",
  dias_ate_limite: 3,
  demanda_diaria: 2,
  qtde_base: 10,
  qtde_oportunidade: 30,
  economia_bruta_estimada: 500,
} as unknown as Oportunidade;

function noop() { /* */ }
const renderTab = (ui: React.ReactElement) => render(<TooltipProvider>{ui}</TooltipProvider>);

describe("OportunidadesTable", () => {
  it("loading → Carregando…", () => {
    renderTab(<OportunidadesTable isLoading totalCount={0} rows={[]} navigate={navigate} onOpenDrawer={noop} onIgnorar={noop} />);
    expect(screen.getByText("Carregando…")).toBeTruthy();
  });

  it("totalCount=0 → estado vazio (sem cabeçalho da tabela)", () => {
    renderTab(<OportunidadesTable isLoading={false} totalCount={0} rows={[]} navigate={navigate} onOpenDrawer={noop} onIgnorar={noop} />);
    expect(screen.queryByText("SKU / Descrição")).toBeNull();
  });

  it("filtros sem match → mensagem; com linha → dados e clique abre drawer", () => {
    const onOpenDrawer = vi.fn();
    const { rerender } = renderTab(
      <OportunidadesTable isLoading={false} totalCount={1} rows={[]} navigate={navigate} onOpenDrawer={onOpenDrawer} onIgnorar={noop} />
    );
    expect(screen.getByText("Nenhum SKU bate os filtros atuais.")).toBeTruthy();

    rerender(
      <TooltipProvider>
        <OportunidadesTable isLoading={false} totalCount={1} rows={[op]} navigate={navigate} onOpenDrawer={onOpenDrawer} onIgnorar={noop} />
      </TooltipProvider>
    );
    expect(screen.getByText("Verniz Premium")).toBeTruthy();
    expect(screen.getByText("999")).toBeTruthy();
    expect(screen.getByText(/500,00/)).toBeTruthy();
    // primeiro botão da linha (ChevronRight) abre o drawer
    const chevronBtn = screen.getAllByRole("button")[0];
    fireEvent.click(chevronBtn);
    expect(onOpenDrawer).toHaveBeenCalledWith(op);
  });
});
