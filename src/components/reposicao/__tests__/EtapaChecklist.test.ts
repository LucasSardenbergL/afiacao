import { describe, it, expect } from "vitest";
import { buildEtapaChecklist } from "@/components/reposicao/EtapaChecklist";
import type { ReposicaoStatus } from "@/hooks/useReposicaoSessao";

const baseStatus: ReposicaoStatus = {
  current: 3,
  oportunidadesCount: 0,
  pedidosTotal: 0,
  pedidosPendentes: 0,
  pedidosBloqueados: 0,
  pedidosAprovados: 0,
  pedidosDisparados: 0,
};

describe("buildEtapaChecklist", () => {
  it("Etapa 1: item done when no opportunities, no CTA", () => {
    const def = buildEtapaChecklist(1, baseStatus);
    expect(def.title).toMatch(/Mercado/);
    expect(def.items[0].done).toBe(true);
    expect(def.items[0].cta).toBeUndefined();
  });

  it("Etapa 1: item pending + CTA when opportunities exist", () => {
    const def = buildEtapaChecklist(1, { ...baseStatus, oportunidadesCount: 4 });
    expect(def.items[0].done).toBe(false);
    expect(def.items[0].label).toMatch(/4 oportunidade/);
    expect(def.items[0].cta?.to).toBe("/admin/reposicao/oportunidades");
  });

  it("Etapa 2: auto-managed — done, sem ação de aprovação", () => {
    const def = buildEtapaChecklist(2, baseStatus);
    expect(def.title).toMatch(/autom/i);
    expect(def.items[0].done).toBe(true);
    expect(def.items[0].cta).toBeUndefined();
  });

  it("Etapa 3: not done while no pedidos generated", () => {
    const def = buildEtapaChecklist(3, { ...baseStatus, pedidosTotal: 0 });
    expect(def.items[0].done).toBe(false);
    expect(def.items[0].label).toMatch(/gerar pedidos/i);
  });

  it("Etapa 3: done when pedidos exist and none pending", () => {
    const def = buildEtapaChecklist(3, {
      ...baseStatus,
      pedidosTotal: 12,
      pedidosPendentes: 0,
      pedidosBloqueados: 0,
    });
    expect(def.items[0].done).toBe(true);
    expect(def.items[1].done).toBe(true);
  });

  it("Etapa 3: flags blocked pedidos as a separate not-done item", () => {
    const def = buildEtapaChecklist(3, {
      ...baseStatus,
      pedidosTotal: 12,
      pedidosBloqueados: 2,
    });
    expect(def.items[1].done).toBe(false);
    expect(def.items[1].label).toMatch(/2 pedido.*bloquead/i);
  });

  it("Etapa 4: done only when nothing approved-awaiting and something dispatched", () => {
    const notDone = buildEtapaChecklist(4, { ...baseStatus, pedidosAprovados: 3 });
    expect(notDone.items[0].done).toBe(false);

    const done = buildEtapaChecklist(4, {
      ...baseStatus,
      pedidosAprovados: 0,
      pedidosDisparados: 5,
    });
    expect(done.items[0].done).toBe(true);
  });

  it("Etapa 5: done only when every pedido is dispatched", () => {
    const partial = buildEtapaChecklist(5, {
      ...baseStatus,
      pedidosTotal: 10,
      pedidosDisparados: 7,
    });
    expect(partial.items[0].done).toBe(false);

    const full = buildEtapaChecklist(5, {
      ...baseStatus,
      pedidosTotal: 10,
      pedidosDisparados: 10,
    });
    expect(full.items[0].done).toBe(true);
  });

  it("returns empty def for unknown step", () => {
    const def = buildEtapaChecklist(99, baseStatus);
    expect(def.title).toBe("");
    expect(def.items).toHaveLength(0);
  });
});
