import { describe, it, expect, vi, beforeAll } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { AlertaDrillSheet } from "../AlertaDrillSheet";
import type { EventoOutlier } from "../types";

// recharts (ResponsiveContainer) usa ResizeObserver, ausente no jsdom.
beforeAll(() => {
  vi.stubGlobal("ResizeObserver", class {
    observe() { /* */ }
    unobserve() { /* */ }
    disconnect() { /* */ }
  });
});

const evtVenda: EventoOutlier = {
  id: 1, empresa: "oben", sku_codigo_omie: "12345", sku_descricao: "Produto X",
  tipo: "venda_atipica", severidade: "atencao", data_evento: "2026-01-15T00:00:00",
  valor_observado: 100, valor_esperado: 50, desvios_padrao: 3.2,
  detalhes: { mensagem: "pico de venda" }, status: "pendente",
  decidido_em: null, decidido_por: null, justificativa_decisao: null, detectado_em: "2026-01-16T08:00:00",
};

const evtSemGrupo: EventoOutlier = {
  ...evtVenda, id: 2, tipo: "sku_sem_grupo",
  detalhes: { fornecedor: "ACME" },
};

function noop() { /* */ }

function baseProps(over: Partial<React.ComponentProps<typeof AlertaDrillSheet>> = {}): React.ComponentProps<typeof AlertaDrillSheet> {
  return {
    drillEvento: evtVenda,
    onClose: noop,
    isSemGrupo: false,
    skuInfo: null,
    historico: null,
    impacto: null,
    gruposFornecedor: [],
    grupoEscolhido: "",
    setGrupoEscolhido: noop,
    atribuirGrupoPending: false,
    onAtribuirGrupo: noop,
    justificativa: "",
    setJustificativa: noop,
    onAcao: noop,
    ...over,
  };
}

describe("AlertaDrillSheet", () => {
  it("venda atípica pendente → seções contexto/SKU/histórico/decisão; Aceitar dispara onAcao", () => {
    const onAcao = vi.fn();
    render(<AlertaDrillSheet {...baseProps({ onAcao })} />);
    expect(screen.getByText("1. Contexto")).toBeTruthy();
    expect(screen.getByText("2. Dados do SKU")).toBeTruthy();
    expect(screen.getByText("3. Histórico")).toBeTruthy();
    expect(screen.getByText("5. Decisão")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Aceitar/ }));
    expect(onAcao).toHaveBeenCalledWith("aceitar");
  });

  it("sku_sem_grupo pendente → atribuição de grupo; botão dispara onAtribuirGrupo", () => {
    const onAtribuirGrupo = vi.fn();
    render(
      <AlertaDrillSheet
        {...baseProps({
          drillEvento: evtSemGrupo,
          isSemGrupo: true,
          gruposFornecedor: [{ id: 1, codigo_grupo: "G1", descricao: "Grupo 1", lt_producao_dias: 5 }],
          grupoEscolhido: "1",
          onAtribuirGrupo,
        })}
      />
    );
    expect(screen.getByText("3. Atribuir grupo de produção")).toBeTruthy();
    expect(screen.getByText("ACME")).toBeTruthy();
    expect(screen.queryByText("3. Histórico")).toBeNull();
    expect(screen.queryByText("5. Decisão")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /Atribuir e marcar como aceito/ }));
    expect(onAtribuirGrupo).toHaveBeenCalled();
  });

  it("fechado (drillEvento=null) → conteúdo não aparece", () => {
    render(<AlertaDrillSheet {...baseProps({ drillEvento: null })} />);
    expect(screen.queryByText("1. Contexto")).toBeNull();
  });
});
