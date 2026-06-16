import { describe, it, expect } from "vitest";
import {
  deriveActiveStep,
  deriveCurrentStep,
  getStepLocks,
  REPOSICAO_STEP_PATHS,
  type ReposicaoStatus,
} from "@/hooks/useReposicaoSessao";

const baseStatus: ReposicaoStatus = {
  current: 3,
  oportunidadesCount: 0,
  pedidosTotal: 0,
  pedidosPendentes: 0,
  pedidosBloqueados: 0,
  pedidosAprovados: 0,
  pedidosDisparados: 0,
};

describe("deriveCurrentStep", () => {
  const m = {
    oportunidadesCount: 0,
    pedidosPendentes: 0,
    pedidosAprovados: 0,
    pedidosDisparados: 0,
  };

  it("returns 1 when there are open opportunities (highest priority)", () => {
    expect(deriveCurrentStep({ ...m, oportunidadesCount: 5 })).toBe(1);
  });

  it("does NOT force step 2 — params are auto-managed (no approval gate)", () => {
    // Pré-aposentadoria, params pendentes forçavam a etapa 2. Agora a etapa 2 é
    // automática e nada de params afeta a derivação → cai no default 3.
    expect(deriveCurrentStep({ ...m })).toBe(3);
  });

  it("returns 3 when pedidos pending and earlier steps clear", () => {
    expect(deriveCurrentStep({ ...m, pedidosPendentes: 2 })).toBe(3);
  });

  it("returns 4 when only approved-awaiting-dispatch remain", () => {
    expect(deriveCurrentStep({ ...m, pedidosAprovados: 4 })).toBe(4);
  });

  it("returns 5 when only dispatched remain", () => {
    expect(deriveCurrentStep({ ...m, pedidosDisparados: 7 })).toBe(5);
  });

  it("defaults to 3 when nothing is pending", () => {
    expect(deriveCurrentStep(m)).toBe(3);
  });

  it("respects priority order: opportunities beat everything", () => {
    expect(
      deriveCurrentStep({
        oportunidadesCount: 1,
        pedidosPendentes: 1,
        pedidosAprovados: 1,
        pedidosDisparados: 1,
      }),
    ).toBe(1);
  });
});

describe("getStepLocks", () => {
  it("returns 5 unlocked steps when status is undefined", () => {
    const locks = getStepLocks(undefined);
    expect(locks).toHaveLength(5);
    expect(locks.every((l) => !l.locked)).toBe(true);
  });

  it("never locks steps 1 and 2 (triage steps)", () => {
    const locks = getStepLocks({ ...baseStatus, pedidosTotal: 0 });
    expect(locks[0].locked).toBe(false);
    expect(locks[1].locked).toBe(false);
  });

  it("locks step 3 when no pedidos were generated", () => {
    const locks = getStepLocks({ ...baseStatus, pedidosTotal: 0 });
    expect(locks[2].locked).toBe(true);
    expect(locks[2].reason).toMatch(/nenhum pedido/i);
  });

  it("unlocks step 3 once pedidos exist", () => {
    const locks = getStepLocks({ ...baseStatus, pedidosTotal: 10 });
    expect(locks[2].locked).toBe(false);
  });

  it("locks step 4 while pedidos are still pending review", () => {
    const locks = getStepLocks({
      ...baseStatus,
      pedidosTotal: 10,
      pedidosPendentes: 3,
    });
    expect(locks[3].locked).toBe(true);
    expect(locks[3].reason).toMatch(/aguardando revis/i);
  });

  it("unlocks step 4 when all pedidos are reviewed", () => {
    const locks = getStepLocks({
      ...baseStatus,
      pedidosTotal: 10,
      pedidosPendentes: 0,
      pedidosAprovados: 10,
    });
    expect(locks[3].locked).toBe(false);
  });

  it("locks step 5 when nothing is approved or dispatched", () => {
    const locks = getStepLocks({ ...baseStatus, pedidosTotal: 10 });
    expect(locks[4].locked).toBe(true);
  });

  it("unlocks step 5 once there are approved or dispatched pedidos", () => {
    const locks = getStepLocks({
      ...baseStatus,
      pedidosTotal: 10,
      pedidosAprovados: 5,
    });
    expect(locks[4].locked).toBe(false);
  });
});

describe("deriveActiveStep", () => {
  it("returns the 1-based step index matching the current pathname", () => {
    expect(deriveActiveStep("/admin/reposicao/sessao/mercado")).toBe(1);
    expect(deriveActiveStep("/admin/reposicao/sessao/parametros")).toBe(2);
    expect(deriveActiveStep("/admin/reposicao/sessao/pedidos")).toBe(3);
    expect(deriveActiveStep("/admin/reposicao/sessao/aplicacao")).toBe(4);
    expect(deriveActiveStep("/admin/reposicao/sessao/confirmacao")).toBe(5);
  });

  it("ignores query strings and trailing slashes", () => {
    expect(deriveActiveStep("/admin/reposicao/sessao/pedidos?fornecedor=ACME")).toBe(3);
    expect(deriveActiveStep("/admin/reposicao/sessao/pedidos/")).toBe(3);
  });

  it("returns 0 for the cockpit index (no step page)", () => {
    expect(deriveActiveStep("/admin/reposicao/sessao")).toBe(0);
  });

  it("returns 0 for unrelated routes", () => {
    expect(deriveActiveStep("/admin/customers")).toBe(0);
  });

  it("exposes the canonical step paths in order", () => {
    expect(REPOSICAO_STEP_PATHS).toEqual([
      "/admin/reposicao/sessao/mercado",
      "/admin/reposicao/sessao/parametros",
      "/admin/reposicao/sessao/pedidos",
      "/admin/reposicao/sessao/aplicacao",
      "/admin/reposicao/sessao/confirmacao",
    ]);
  });
});
