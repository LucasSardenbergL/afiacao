import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { Tabs } from "@/components/ui/tabs";
import { DetalhesTab } from "../DetalhesTab";
import type { Campanha } from "../types";

const makeCampanha = (over: Partial<Campanha> = {}): Campanha => ({
  id: 1,
  empresa: "OBEN",
  nome: "Promo Abril",
  fornecedor_nome: "RENNER SAYERLACK S/A",
  tipo_origem: "fornecedor_impoe",
  data_inicio: "2026-04-01",
  data_fim: "2026-04-30",
  estado: "rascunho",
  observacoes: null,
  origem_arquivo_url: null,
  origem_arquivo_tipo: null,
  origem_email_assunto: null,
  origem_email_remetente: null,
  origem_email_data: null,
  extracao_confianca: null,
  extracao_observacoes: null,
  extraido_em: null,
  criado_em: "2026-04-01T00:00:00Z",
  ...over,
});

const baseProps = {
  campanha: makeCampanha(),
  signedUrl: null,
  formNome: "Promo Abril",
  setFormNome: vi.fn(),
  formInicio: "2026-04-01",
  setFormInicio: vi.fn(),
  formFim: "2026-04-30",
  setFormFim: vi.fn(),
  formObs: "",
  setFormObs: vi.fn(),
  tipoOrigem: "fornecedor_impoe",
  isNew: false,
  onSave: vi.fn(),
  saving: false,
};

function renderTab(props: Partial<typeof baseProps> = {}) {
  const merged = { ...baseProps, ...props };
  return render(
    <Tabs defaultValue="detalhes">
      <DetalhesTab {...merged} />
    </Tabs>,
  );
}

describe("DetalhesTab", () => {
  beforeEach(() => vi.clearAllMocks());

  it("renderiza o formulário e o fornecedor fixo", () => {
    renderTab();
    expect(screen.getByText("Dados da campanha")).toBeTruthy();
    expect(screen.getByDisplayValue("Renner Sayerlack S/A")).toBeTruthy();
    expect(screen.getByDisplayValue("Promo Abril")).toBeTruthy();
  });

  it("isNew alterna o rótulo do botão de salvar", () => {
    const { rerender } = renderTab({ isNew: true });
    expect(
      screen.getByRole("button", { name: /Criar campanha/i }),
    ).toBeTruthy();
    rerender(
      <Tabs defaultValue="detalhes">
        <DetalhesTab {...baseProps} isNew={false} />
      </Tabs>,
    );
    expect(
      screen.getByRole("button", { name: /Salvar alterações/i }),
    ).toBeTruthy();
  });

  it("clicar em salvar chama onSave", () => {
    const onSave = vi.fn();
    renderTab({ onSave });
    fireEvent.click(screen.getByRole("button", { name: /Salvar alterações/i }));
    expect(onSave).toHaveBeenCalledTimes(1);
  });

  it("editar o nome chama setFormNome", () => {
    const setFormNome = vi.fn();
    renderTab({ setFormNome });
    fireEvent.change(screen.getByDisplayValue("Promo Abril"), {
      target: { value: "Promo Maio" },
    });
    expect(setFormNome).toHaveBeenCalledWith("Promo Maio");
  });

  it("tipoOrigem negociacao_cliente mostra badge Negociação", () => {
    renderTab({ tipoOrigem: "negociacao_cliente" });
    expect(screen.getByText("Negociação")).toBeTruthy();
  });

  it("tipoOrigem fornecedor mostra badge Fornecedor (não Negociação)", () => {
    renderTab({ tipoOrigem: "fornecedor_impoe" });
    expect(screen.queryByText("Negociação")).toBeNull();
    // "Fornecedor" aparece duas vezes: o <Label> e o <Badge>.
    expect(screen.getAllByText("Fornecedor").length).toBeGreaterThanOrEqual(2);
  });

  it("card de extração Vision aparece só com origem_arquivo_url", () => {
    const { rerender } = renderTab({ campanha: makeCampanha() });
    expect(screen.queryByText("Extração via IA")).toBeNull();
    rerender(
      <Tabs defaultValue="detalhes">
        <DetalhesTab
          {...baseProps}
          campanha={makeCampanha({
            origem_arquivo_url: "promocoes/arquivo.pdf",
            extracao_confianca: 0.9,
          })}
        />
      </Tabs>,
    );
    expect(screen.getByText("Extração via IA")).toBeTruthy();
  });
});
