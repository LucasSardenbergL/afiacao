import { describe, it, expect, vi, beforeAll } from "vitest";
import { MemoryRouter } from "react-router-dom";
import { render, screen, fireEvent } from "@testing-library/react";
import { CustomerListView } from "../CustomerListView";
import type { Customer, ClientScore } from "../types";

beforeAll(() => {
  // useInfiniteScroll usa IntersectionObserver, ausente no jsdom.
  vi.stubGlobal(
    "IntersectionObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
});

const customer: Customer = {
  user_id: "c1",
  name: "Marcenaria Alfa",
  email: "alfa@x.com",
  phone: "11999",
  document: "12345678000199",
  customer_type: null,
  created_at: "2026-03-01T00:00:00Z",
  requires_po: false,
};

const score: ClientScore = {
  customer_user_id: "c1",
  health_score: 80,
  health_class: "saudavel",
  churn_risk: 20, // escala 0–100 (= 100 - health_score), NÃO fração 0–1
  expansion_score: 5,
  priority_score: 5.2,
  avg_monthly_spend_180d: 1000,
  days_since_last_purchase: 10,
  category_count: 3,
  gross_margin_pct: 0.3,
  sales_history_status: 'ativo',
};

function setup(overrides: Partial<React.ComponentProps<typeof CustomerListView>> = {}) {
  const props: React.ComponentProps<typeof CustomerListView> = {
    customers: [customer],
    scores: new Map([["c1", score]]),
    loading: false,
    // Caminho de sucesso: a lista foi lida. O erro honesto tem suíte própria
    // (AdminCustomers.erro-honesto) — aqui `isError` é só a prop obrigatória do contrato.
    isError: false,
    onRetry: vi.fn(),
    total: 1,
    isCarteira: true,
    onSelect: vi.fn(),
    hasNextPage: false,
    isFetchingNextPage: false,
    onLoadMore: vi.fn(),
    ...overrides,
  };
  render(<MemoryRouter><CustomerListView {...props} /></MemoryRouter>);
  return props;
}

describe("CustomerListView", () => {
  it("mostra skeleton quando loading", () => {
    const { container } = render(
      <MemoryRouter>
        <CustomerListView customers={[]} scores={new Map()} loading isError={false} onRetry={vi.fn()} total={0} isCarteira onSelect={vi.fn()} hasNextPage={false} isFetchingNextPage={false} onLoadMore={vi.fn()} />
      </MemoryRouter>,
    );
    // PageSkeleton (Skeleton usa animate-shimmer), não mais Loader2 full-page
    // (.animate-spin) — convenção §9.
    expect(container.querySelector(".animate-shimmer")).toBeTruthy();
    expect(container.querySelector(".animate-spin")).toBeNull();
  });

  it("renderiza cliente com badge de saúde e dispara onSelect", () => {
    const props = setup();
    expect(screen.getByText("Marcenaria Alfa")).toBeTruthy();
    expect(screen.getByText("1 clientes na carteira")).toBeTruthy();
    expect(screen.getByText("Saudável")).toBeTruthy();
    fireEvent.click(screen.getByText("Marcenaria Alfa"));
    expect(props.onSelect).toHaveBeenCalledWith(expect.objectContaining({ user_id: "c1" }));
  });

  it("mostra empty state sem clientes", () => {
    setup({ customers: [], scores: new Map() });
    expect(screen.getByText("Nenhum cliente na carteira")).toBeTruthy();
  });

  it("busca no servidor: não re-filtra em memória (o servidor casou por coluna que o filtro local não vê)", () => {
    // O servidor devolveu o cliente pelo termo; refiltrar localmente o esconderia.
    render(
      <MemoryRouter initialEntries={["/admin/customers?search=ZZZ"]}>
        <CustomerListView customers={[customer]} scores={new Map()} loading={false} isError={false} onRetry={vi.fn()} total={1} isCarteira={false} onSelect={vi.fn()} hasNextPage={false} isFetchingNextPage={false} onLoadMore={vi.fn()} buscaNoServidor />
      </MemoryRouter>,
    );
    expect(screen.getByText("Marcenaria Alfa")).toBeTruthy();
    expect(screen.getByText("Todos os resultados carregados (1)")).toBeTruthy();
  });

  it("carteira: busca local também casa telefone", () => {
    render(
      <MemoryRouter initialEntries={["/admin/customers?search=11999"]}>
        <CustomerListView customers={[customer]} scores={new Map()} loading={false} isError={false} onRetry={vi.fn()} total={1} isCarteira onSelect={vi.fn()} hasNextPage={false} isFetchingNextPage={false} onLoadMore={vi.fn()} />
      </MemoryRouter>,
    );
    expect(screen.getByText("Marcenaria Alfa")).toBeTruthy();
  });

  it("filtro sem resultado com páginas pendentes não afirma 'Nenhum cliente'", () => {
    render(
      <MemoryRouter initialEntries={["/admin/customers?health=critico"]}>
        <CustomerListView customers={[customer]} scores={new Map([["c1", score]])} loading={false} isError={false} onRetry={vi.fn()} total={5665} isCarteira={false} onSelect={vi.fn()} hasNextPage isFetchingNextPage={false} onLoadMore={vi.fn()} />
      </MemoryRouter>,
    );
    expect(screen.queryByText("Nenhum cliente com esses filtros")).toBeNull();
    expect(screen.getByText("Nenhum cliente nas páginas carregadas até agora")).toBeTruthy();
  });

  it("filtro no servidor: não re-filtra saúde em memória (o recorte já veio filtrado)", () => {
    // O score em memória diz "saudavel", o filtro pede "critico": filtrar aqui esconderia o
    // cliente que o servidor afirmou ser crítico (score da página pode estar stale ou ausente).
    render(
      <MemoryRouter initialEntries={["/admin/customers?health=critico"]}>
        <CustomerListView customers={[customer]} scores={new Map([["c1", score]])} loading={false} isError={false} onRetry={vi.fn()} total={5665} totalRecorte={1} isCarteira={false} filtroNoServidor onSelect={vi.fn()} hasNextPage={false} isFetchingNextPage={false} onLoadMore={vi.fn()} />
      </MemoryRouter>,
    );
    expect(screen.getByText("Marcenaria Alfa")).toBeTruthy();
    expect(screen.getByText("1 com esses filtros · 5.665 clientes na base")).toBeTruthy();
  });

  it("filtro no servidor e recorte vazio: afirma 'Nenhum cliente' (não há parte não lida)", () => {
    render(
      <MemoryRouter initialEntries={["/admin/customers?health=critico"]}>
        <CustomerListView customers={[]} scores={new Map()} loading={false} isError={false} onRetry={vi.fn()} total={5665} totalRecorte={0} isCarteira={false} filtroNoServidor onSelect={vi.fn()} hasNextPage={false} isFetchingNextPage={false} onLoadMore={vi.fn()} />
      </MemoryRouter>,
    );
    expect(screen.getByText("Nenhum cliente com esses filtros")).toBeTruthy();
  });

  it("carteira: filtro de saúde segue em memória (a carteira é lida inteira) e a ordem é escolhível", () => {
    render(
      <MemoryRouter initialEntries={["/admin/customers?health=critico"]}>
        <CustomerListView customers={[customer]} scores={new Map([["c1", score]])} loading={false} isError={false} onRetry={vi.fn()} total={1} isCarteira onSelect={vi.fn()} hasNextPage={false} isFetchingNextPage={false} onLoadMore={vi.fn()} />
      </MemoryRouter>,
    );
    expect(screen.queryByText("Marcenaria Alfa")).toBeNull();
    // Onda 1: a carteira também prioriza — o seletor de ordem aparece para a vendedora.
    expect(screen.getByRole("button", { name: /Ordenar lista/i })).toBeTruthy();
  });
  describe("polimento da lista", () => {
    it("motivo do contato aparece sob o nome (visível sem as colunas do desktop)", () => {
      setup();
      expect(screen.getByText("Saudável · 10d sem compra")).toBeTruthy();
    });

    it("base com count null e sem pendência: 'contagem indisponível', nunca '0 clientes na base'", () => {
      setup({ total: null, isCarteira: false });
      expect(screen.getByText("contagem indisponível")).toBeTruthy();
      expect(screen.queryByText(/0 clientes na base/)).toBeNull();
    });

    it("contagem pendente: diz quantos carregou; rodapé conta o que está na tela", () => {
      setup({ total: null, contagemPendente: true, isCarteira: false });
      expect(screen.getByText("1 clientes carregados")).toBeTruthy();
      expect(screen.getByText("Todos os clientes carregados (1)")).toBeTruthy();
    });

    it("coluna de gasto diz o que mede", () => {
      setup({ isCarteira: false });
      expect(screen.getByText("Média mensal (180d)")).toBeTruthy();
      expect(screen.queryByText("Gasto mensal")).toBeNull();
    });
  });
});
