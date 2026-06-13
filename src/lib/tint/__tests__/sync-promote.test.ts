// src/lib/tint/__tests__/sync-promote.test.ts
import { describe, it, expect } from "vitest";
import {
  expandirFormula,
  precoFinalSayer,
  validarSnapshotKeys,
  type EmbalagemVendavel,
  type InsumoPrecoBase,
  type InsumoCorante,
} from "../sync-promote";

describe("expandirFormula (regra de 3 da embalagem de formulação → vendáveis)", () => {
  const itens = [
    { id_corante: "AX", ordem: 1, qtd_ml: 12.5 },
    { id_corante: "VM", ordem: 2, qtd_ml: 3.2 },
  ];
  const vendaveis: EmbalagemVendavel[] = [
    { id_embalagem: "EMB-900", volume_ml: 900 },
    { id_embalagem: "EMB-3600", volume_ml: 3600 },
  ];

  it("expande qtds pelo fator vol_destino/vol_formulacao", () => {
    const out = expandirFormula({ volumeFormulacaoMl: 900, itens }, vendaveis);
    expect(out).toHaveLength(2);
    const e900 = out.find((e) => e.id_embalagem === "EMB-900")!;
    const e3600 = out.find((e) => e.id_embalagem === "EMB-3600")!;
    expect(e900.itens[0].qtd_ml).toBe(12.5); // fator 1
    expect(e3600.itens[0].qtd_ml).toBe(50); // 12.5 × 4
    expect(e3600.itens[1].qtd_ml).toBeCloseTo(12.8, 6); // 3.2 × 4
    expect(e3600.volume_final_ml).toBe(3600);
  });

  it("volume de formulação 0 → vazio (guarda divisão por zero)", () => {
    expect(expandirFormula({ volumeFormulacaoMl: 0, itens }, vendaveis)).toEqual([]);
  });

  it("volume de formulação null → vazio", () => {
    expect(expandirFormula({ volumeFormulacaoMl: null, itens }, vendaveis)).toEqual([]);
  });

  it("zero embalagens vendáveis → vazio (não inventa embalagem)", () => {
    expect(expandirFormula({ volumeFormulacaoMl: 900, itens }, [])).toEqual([]);
  });

  it("embalagem vendável com volume inválido é pulada", () => {
    const out = expandirFormula({ volumeFormulacaoMl: 900, itens }, [
      { id_embalagem: "EMB-OK", volume_ml: 900 },
      { id_embalagem: "EMB-RUIM", volume_ml: 0 },
      { id_embalagem: "EMB-NULL", volume_ml: null as unknown as number },
    ]);
    expect(out.map((e) => e.id_embalagem)).toEqual(["EMB-OK"]);
  });
});

describe("precoFinalSayer (pág 9 do manual: base×(1+imp)×(1+marg) + Σ corantes/ml; NULL honesto)", () => {
  const base: InsumoPrecoBase = { custo: 100, imposto_pct: 30, margem_pct: 50 };
  const corantes: InsumoCorante[] = [
    { id_corante: "AX", custo: 200, volume_ml: 900 },
  ];

  it("reproduz o exemplo do manual (100 → 130 → 195) + corante 0,222/ml × 5ml", () => {
    const out = precoFinalSayer(base, [{ id_corante: "AX", qtd_ml: 5 }], corantes);
    // 195 + (200/900)*5 = 195 + 1.1111... → round2 = 196.11
    expect(out).toBe(196.11);
  });

  it("sem corantes = só a base", () => {
    expect(precoFinalSayer(base, [], corantes)).toBe(195);
  });

  it("insumo da base ausente → null (NUNCA 0)", () => {
    expect(precoFinalSayer(null, [{ id_corante: "AX", qtd_ml: 5 }], corantes)).toBeNull();
  });

  it("corante usado sem preço → null (não fabrica preço parcial)", () => {
    const out = precoFinalSayer(base, [{ id_corante: "ZZ", qtd_ml: 5 }], corantes);
    expect(out).toBeNull();
  });

  it("corante com volume 0/null → null (não divide por zero)", () => {
    const out = precoFinalSayer(base, [{ id_corante: "AX", qtd_ml: 5 }], [
      { id_corante: "AX", custo: 200, volume_ml: 0 },
    ]);
    expect(out).toBeNull();
  });

  it("custo base 0 é VÁLIDO (≠ ausente): preço = só corantes", () => {
    const out = precoFinalSayer({ custo: 0, imposto_pct: 30, margem_pct: 50 }, [{ id_corante: "AX", qtd_ml: 9 }], corantes);
    expect(out).toBe(2); // (200/900)*9 = 2.00
  });
});

describe("validarSnapshotKeys (blast radius — chunk perdido não apaga a loja)", () => {
  it("aprova snapshot saudável (pouca deleção)", () => {
    const r = validarSnapshotKeys({ totalOficialAtivas: 1000, chavesNoSnapshot: 990, desativariam: 10 });
    expect(r.ok).toBe(true);
  });
  it("aborta se desativaria >20% das ativas", () => {
    const r = validarSnapshotKeys({ totalOficialAtivas: 1000, chavesNoSnapshot: 700, desativariam: 300 });
    expect(r.ok).toBe(false);
    expect(r.motivo).toMatch(/blast/i);
  });
  it("aborta se snapshot < 50% do oficial ativo (snapshot incompleto)", () => {
    const r = validarSnapshotKeys({ totalOficialAtivas: 1000, chavesNoSnapshot: 400, desativariam: 600 });
    expect(r.ok).toBe(false);
  });
  it("oficial vazio (primeira carga) → ok com snapshot qualquer", () => {
    const r = validarSnapshotKeys({ totalOficialAtivas: 0, chavesNoSnapshot: 100, desativariam: 0 });
    expect(r.ok).toBe(true);
  });
});
