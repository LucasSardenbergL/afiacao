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
  churn_risk: 0.1,
  expansion_score: 5,
  priority_score: 5.2,
  avg_monthly_spend_180d: 1000,
  days_since_last_purchase: 10,
  category_count: 3,
  gross_margin_pct: 0.3,
};

function setup(overrides: Partial<React.ComponentProps<typeof CustomerListView>> = {}) {
  const props: React.ComponentProps<typeof CustomerListView> = {
    customers: [customer],
    scores: new Map([["c1", score]]),
    loading: false,
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
        <CustomerListView customers={[]} scores={new Map()} loading total={0} isCarteira onSelect={vi.fn()} hasNextPage={false} isFetchingNextPage={false} onLoadMore={vi.fn()} />
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
});
