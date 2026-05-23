import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter, Routes, Route } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

// Modo "nova campanha" (id === "novo") deixa todas as queries com enabled:false,
// então a página monta sem nenhuma chamada ao Supabase. Mockamos o client mesmo
// assim para enxugar o grafo de módulos (evita inicializar o client real, que
// torna o teste lento/instável sob carga na suíte completa) e o auth.
vi.mock("@/contexts/AuthContext", () => ({
  useAuth: () => ({ user: { email: "test@colacor" } }),
}));
vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    from: () => ({
      select: () => ({
        eq: () => ({
          eq: () => ({ order: () => Promise.resolve({ data: [], error: null }) }),
          single: () => Promise.resolve({ data: null, error: null }),
          in: () => Promise.resolve({ data: [], error: null }),
          order: () => Promise.resolve({ data: [], error: null }),
        }),
      }),
    }),
    storage: {
      from: () => ({
        createSignedUrl: () => Promise.resolve({ data: null, error: null }),
      }),
    },
    rpc: () => Promise.resolve({ error: null }),
  },
}));

import AdminReposicaoPromocaoDetail from "../AdminReposicaoPromocaoDetail";

function renderPage(path: string) {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route
            path="/admin/reposicao/promocoes/:id"
            element={<AdminReposicaoPromocaoDetail />}
          />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("AdminReposicaoPromocaoDetail (smoke / composição)", () => {
  it("monta em modo nova campanha sem backend e fia os filhos", () => {
    renderPage("/admin/reposicao/promocoes/novo");
    // (timeout generoso: a página puxa um grafo grande de módulos e pode
    // sofrer starvation sob carga da suíte completa.)

    // Breadcrumb
    expect(screen.getByText("Nova campanha")).toBeTruthy();
    // DetalhesTab (form)
    expect(screen.getByText("Dados da campanha")).toBeTruthy();
    expect(
      screen.getByRole("button", { name: /Criar campanha/i }),
    ).toBeTruthy();
    // EstadoAcoesSidebar — badge do estado inicial, sem ações (isNew)
    expect(screen.getByText("Rascunho")).toBeTruthy();
    expect(
      screen.queryByRole("button", { name: /Ativar campanha/i }),
    ).toBeNull();
  }, 15000);
});
