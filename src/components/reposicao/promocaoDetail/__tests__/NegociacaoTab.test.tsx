import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { Tabs } from "@/components/ui/tabs";
import { NegociacaoTab } from "../NegociacaoTab";
import type { Evento } from "../types";

// TabsContent precisa do contexto de Tabs.Root pra renderizar.
function renderTab(props: Parameters<typeof NegociacaoTab>[0]) {
  return render(
    <Tabs defaultValue="negociacao">
      <NegociacaoTab {...props} />
    </Tabs>,
  );
}

const evento: Evento = {
  id: 1,
  campanha_id: 10,
  tipo_evento: "proposta_enviada",
  desconto_perc_proposto: 25,
  volume_minimo_proposto: 100,
  data_evento: new Date().toISOString(),
  email_referencia: null,
  conteudo: "Proposta inicial enviada ao cliente",
  registrado_por: "lucas@colacor",
  registrado_em: new Date().toISOString(),
};

describe("NegociacaoTab", () => {
  it("estado vazio: mostra mensagem de nenhum evento", () => {
    renderTab({ eventos: [], onOpenEvento: vi.fn() });
    expect(screen.getByText(/Nenhum evento registrado ainda/i)).toBeTruthy();
  });

  it("lista: renderiza o label do tipo, conteúdo e badges propostos", () => {
    renderTab({ eventos: [evento], onOpenEvento: vi.fn() });
    expect(screen.getByText("Proposta enviada")).toBeTruthy();
    expect(
      screen.getByText("Proposta inicial enviada ao cliente"),
    ).toBeTruthy();
    expect(screen.getByText(/25% desconto/)).toBeTruthy();
    expect(screen.getByText(/Vol\. mín\. 100/)).toBeTruthy();
    expect(
      screen.queryByText(/Nenhum evento registrado ainda/i),
    ).toBeNull();
  });

  it("dispara onOpenEvento ao clicar em Registrar evento", () => {
    const onOpenEvento = vi.fn();
    renderTab({ eventos: [], onOpenEvento });
    fireEvent.click(screen.getByRole("button", { name: /Registrar evento/i }));
    expect(onOpenEvento).toHaveBeenCalledTimes(1);
  });
});
