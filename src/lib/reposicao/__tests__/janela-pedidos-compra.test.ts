import { describe, it, expect } from "vitest";
// A janela de previsão do sync de pedidos de compra é money-path e roda SÓ no edge (Deno) — não no
// frontend. Por isso vive em supabase/functions/_shared (a edge importa de lá) e é testada DIRETO daqui
// pelo vitest (sem cópia em src/ → sem paridade a manter). Encolher o FUTURO reintroduz o #1072.
import {
  computeJanelaPrevisao,
  deveRodarCompleto,
  JANELA_FUTURO_DIAS,
  JANELA_PASSADO_INCREMENTAL_DIAS,
  JANELA_PASSADO_COMPLETO_DIAS,
  JANELA_PASSADO_MAX_DIAS,
  FULL_SYNC_MAX_IDADE_H,
} from "../../../../supabase/functions/_shared/janela-pedidos-compra";

describe("computeJanelaPrevisao — passado por modo, FUTURO fixo (guard #1072)", () => {
  it("incremental: passado curto, futuro 120", () => {
    expect(computeJanelaPrevisao("incremental")).toEqual({
      passadoDias: JANELA_PASSADO_INCREMENTAL_DIAS,
      futuroDias: JANELA_FUTURO_DIAS,
    });
  });

  it("completo (default): passado 365, futuro 120", () => {
    expect(computeJanelaPrevisao("completo")).toEqual({
      passadoDias: JANELA_PASSADO_COMPLETO_DIAS,
      futuroDias: JANELA_FUTURO_DIAS,
    });
  });

  it("completo: `dias` AMPLIA o passado (backfill manual)", () => {
    expect(computeJanelaPrevisao("completo", 500)).toEqual({ passadoDias: 500, futuroDias: 120 });
  });

  it("completo: clampa o passado ao máximo (3 anos)", () => {
    expect(computeJanelaPrevisao("completo", 5000)).toEqual({
      passadoDias: JANELA_PASSADO_MAX_DIAS,
      futuroDias: 120,
    });
  });

  it("completo: NUNCA encolhe abaixo de 365 (dias menor é ignorado — guard anti-regressão)", () => {
    expect(computeJanelaPrevisao("completo", 10)).toEqual({ passadoDias: 365, futuroDias: 120 });
    expect(computeJanelaPrevisao("completo", 3)).toEqual({ passadoDias: 365, futuroDias: 120 });
  });

  it("incremental: ignora `dias` (não amplia nem encolhe)", () => {
    expect(computeJanelaPrevisao("incremental", 999)).toEqual({ passadoDias: 60, futuroDias: 120 });
    expect(computeJanelaPrevisao("incremental", 1)).toEqual({ passadoDias: 60, futuroDias: 120 });
  });

  it("INVARIANTE money-path: futuro é SEMPRE 120 — em todo modo e todo `dias`", () => {
    const modos = ["incremental", "completo"] as const;
    const diasCasos = [undefined, 0, -5, 30, 120, 365, 9999, Number.NaN, Infinity];
    for (const modo of modos) {
      for (const dias of diasCasos) {
        expect(computeJanelaPrevisao(modo, dias).futuroDias).toBe(JANELA_FUTURO_DIAS);
      }
    }
  });

  it("passado nunca passa do teto nem fica abaixo do piso, em qualquer entrada", () => {
    for (const dias of [-100, 0, 999999, Number.NaN]) {
      const { passadoDias } = computeJanelaPrevisao("completo", dias);
      expect(passadoDias).toBeGreaterThanOrEqual(JANELA_PASSADO_COMPLETO_DIAS);
      expect(passadoDias).toBeLessThanOrEqual(JANELA_PASSADO_MAX_DIAS);
    }
  });
});

describe("deveRodarCompleto — cadência de reconciliação (robusta a schedule)", () => {
  const H = 3600_000;
  const now = 1_700_000_000_000;

  it("nunca houve completo (null) → completo", () => {
    expect(deveRodarCompleto(null, now)).toBe(true);
  });

  it("último completo há >20h → completo", () => {
    expect(deveRodarCompleto(now - 21 * H, now)).toBe(true);
  });

  it("último completo há <20h → incremental", () => {
    expect(deveRodarCompleto(now - 19 * H, now)).toBe(false);
  });

  it("exatamente no limiar (20h) → incremental (limiar é estritamente >)", () => {
    expect(deveRodarCompleto(now - 20 * H, now)).toBe(false);
  });

  it("usa FULL_SYNC_MAX_IDADE_H (=20h) como limiar default", () => {
    expect(FULL_SYNC_MAX_IDADE_H).toBe(20);
    expect(deveRodarCompleto(now - (FULL_SYNC_MAX_IDADE_H - 1) * H, now)).toBe(false);
    expect(deveRodarCompleto(now - (FULL_SYNC_MAX_IDADE_H + 1) * H, now)).toBe(true);
  });

  it("limiar customizável", () => {
    expect(deveRodarCompleto(now - 5 * H, now, 4)).toBe(true);
    expect(deveRodarCompleto(now - 3 * H, now, 4)).toBe(false);
  });
});
