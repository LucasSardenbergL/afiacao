import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { TooltipProvider } from "@/components/ui/tooltip";
import { OportunidadesTable } from "../OportunidadesTable";
import type { OportunidadeComDecisao } from "../types";
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
  decisao: {
    empresa: "OBEN",
    sku: "999",
    fornecedor: "SAYERLACK",
    q_base: 10,
    q_candidata: 30,
    q_extra: 20,
    dias_cobertura_extra: 10,
    desconto_rs: 0,
    aumento_evitado_rs: 0,
    ruptura_evitada_rs: 0,
    capital_extra_rs: 0,
    impacto_prazo_rs: 0,
    frete_incremental_rs: 0,
    beneficio_liquido_rs: 0,
    recomendacao: "manter_base",
    escopo: "sku",
    eoq_recalculo_ignorado: true,
    flags: [],
    confianca: { nivel: "media", motivos: [] },
  },
} as unknown as OportunidadeComDecisao;

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
