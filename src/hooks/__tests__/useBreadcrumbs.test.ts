import { describe, it, expect } from "vitest";
import { resolveBreadcrumbs } from "@/hooks/useBreadcrumbs";

describe("resolveBreadcrumbs", () => {
  it("builds an ancestor trail from the registry for a leaf route", () => {
    const trail = resolveBreadcrumbs("/admin/reposicao/sessao/pedidos");
    expect(trail.map((t) => t.crumb)).toEqual(["Reposição", "Pedidos"]);
    expect(trail[trail.length - 1].isCurrent).toBe(true);
  });

  it("matches dynamic segments (:id)", () => {
    const trail = resolveBreadcrumbs("/admin/customers/abc-123");
    expect(trail.map((t) => t.crumb)).toEqual(["Clientes", "Detalhe do cliente"]);
    expect(trail[trail.length - 1].href).toBe("/admin/customers/abc-123");
  });

  it("returns a single non-clickable crumb for a top-level page", () => {
    const trail = resolveBreadcrumbs("/admin/customers");
    expect(trail).toHaveLength(1);
    expect(trail[0].crumb).toBe("Clientes");
    expect(trail[0].isCurrent).toBe(true);
  });

  it("returns empty for unmapped routes (degrades clean)", () => {
    expect(resolveBreadcrumbs("/rota/inexistente")).toEqual([]);
  });

  it("surfaces backTo/backLabel from the leaf entry", () => {
    const trail = resolveBreadcrumbs("/sales/new");
    const leaf = trail[trail.length - 1];
    expect(leaf.backTo).toBe("/sales");
    expect(leaf.backLabel).toBe("Pedidos");
  });
});
