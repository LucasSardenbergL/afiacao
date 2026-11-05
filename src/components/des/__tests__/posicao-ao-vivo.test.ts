import { describe, it, expect } from "vitest";
import { derivarPosicaoAoVivo, posicaoConhecida } from "../posicao-ao-vivo";

// Payloads reais da v_des_posicao_trimestre_ao_vivo (OBEN, prod, 2026-11-05).
const FAIXA_3 = { faixa_id: 13, faixa_numero: 3, estrelas: 3, desconto_padrao_perc: 1.5, volume_min: 250000, volume_max: 349999.99 };
const FAIXA_2 = { faixa_id: 12, faixa_numero: 2, estrelas: 2, desconto_padrao_perc: 1, volume_min: 100000, volume_max: 249999.99 };

/** View ANTIGA, T4/26 sem snapshot: a "posição" é só trânsito, e faixa e gap saem dela. */
const VIEW_ANTIGA_SEM_FATURADO = {
  fat_bruto_confirmado: null,
  meta_pessoal: 400840.02,
  posicao_ao_vivo_conservadora: 297966.59,
  posicao_ao_vivo_otimista: 297966.59,
  faixa_conservadora: FAIXA_3,
  faixa_otimista: FAIXA_3,
  gap_para_meta_pessoal: 102873.43,
};

/** View NOVA (20261105091216), mesmo trimestre: posição, faixa e gap NULL. */
const VIEW_NOVA_SEM_FATURADO = {
  fat_bruto_confirmado: null,
  meta_pessoal: 400840.02,
  posicao_ao_vivo_conservadora: null,
  posicao_ao_vivo_otimista: null,
  faixa_conservadora: null,
  faixa_otimista: null,
  gap_para_meta_pessoal: null,
};

/** T2/26 com snapshot: faturado 103.068,74, sem trânsito. */
const COM_FATURADO = {
  fat_bruto_confirmado: 103068.74,
  meta_pessoal: 400840.02,
  posicao_ao_vivo_conservadora: 103068.74,
  posicao_ao_vivo_otimista: 120000,
  faixa_conservadora: FAIXA_2,
  faixa_otimista: FAIXA_3,
  gap_para_meta_pessoal: 297771.28,
};

const DESCONHECIDA = {
  conhecida: false,
  conservadora: null,
  otimista: null,
  estrelasConservadora: null,
  estrelasOtimista: null,
  faixaConservadoraId: null,
  faixaConservadoraNumero: null,
  gap: null,
  progresso: null,
  metaAtingida: null,
};

describe("derivarPosicaoAoVivo — sem faturado confirmado, posição/faixa/gap são desconhecidos", () => {
  it("view ANTIGA: o trânsito preenchido não vira posição, faixa nem gap", () => {
    expect(posicaoConhecida(VIEW_ANTIGA_SEM_FATURADO)).toBe(false);
    expect(derivarPosicaoAoVivo(VIEW_ANTIGA_SEM_FATURADO)).toEqual({ ...DESCONHECIDA, meta: 400840.02 });
  });

  it("view NOVA: NULL continua NULL — nunca 0 estrelas nem 'meta atingida'", () => {
    expect(posicaoConhecida(VIEW_NOVA_SEM_FATURADO)).toBe(false);
    expect(derivarPosicaoAoVivo(VIEW_NOVA_SEM_FATURADO)).toEqual({ ...DESCONHECIDA, meta: 400840.02 });
  });

  it("sem linha: desconhecida, inclusive a meta", () => {
    expect(posicaoConhecida(null)).toBe(false);
    expect(derivarPosicaoAoVivo(undefined)).toEqual({ ...DESCONHECIDA, meta: null });
  });

  it("faturado presente mas posição NULL (forma inesperada): desconhecida, não 0", () => {
    const linha = { ...COM_FATURADO, posicao_ao_vivo_conservadora: null };
    expect(posicaoConhecida(linha)).toBe(false);
    expect(derivarPosicaoAoVivo(linha).conhecida).toBe(false);
  });
});

describe("derivarPosicaoAoVivo — com faturado confirmado", () => {
  it("lê posição, faixa, gap e progresso da view", () => {
    expect(posicaoConhecida(COM_FATURADO)).toBe(true);
    const p = derivarPosicaoAoVivo(COM_FATURADO);
    expect(p).toEqual({
      conhecida: true,
      conservadora: 103068.74,
      otimista: 120000,
      estrelasConservadora: 2,
      estrelasOtimista: 3,
      faixaConservadoraId: 12,
      faixaConservadoraNumero: 2,
      meta: 400840.02,
      gap: 297771.28,
      progresso: (103068.74 / 400840.02) * 100,
      metaAtingida: false,
    });
  });

  it("faturado ZERO é fato: posição 0 conhecida; sem faixa atingida = 0 estrelas (não desconhecida)", () => {
    const linha = {
      ...COM_FATURADO,
      fat_bruto_confirmado: 0,
      posicao_ao_vivo_conservadora: 0,
      posicao_ao_vivo_otimista: 0,
      faixa_conservadora: null,
      faixa_otimista: null,
      gap_para_meta_pessoal: 400840.02,
    };
    expect(posicaoConhecida(linha)).toBe(true);
    const p = derivarPosicaoAoVivo(linha);
    expect(p.conhecida).toBe(true);
    expect(p.conservadora).toBe(0);
    expect(p.estrelasConservadora).toBe(0);
    expect(p.faixaConservadoraNumero).toBe(0);
    expect(p.faixaConservadoraId).toBeNull();
    expect(p.progresso).toBe(0);
    expect(p.metaAtingida).toBe(false);
  });

  it("meta NULL: posição e faixa valem; gap, progresso e 'atingida' são desconhecidos", () => {
    const linha = { ...COM_FATURADO, meta_pessoal: null, gap_para_meta_pessoal: null };
    const p = derivarPosicaoAoVivo(linha);
    expect(p.conhecida).toBe(true);
    expect(p.estrelasConservadora).toBe(2);
    expect(p.gap).toBeNull();
    expect(p.progresso).toBeNull();
    expect(p.metaAtingida).toBeNull();
  });

  it("meta NULL com o gap 0 da view ANTIGA (GREATEST(0, 0 − posição)): não vira 'meta atingida'", () => {
    const linha = { ...COM_FATURADO, meta_pessoal: null, gap_para_meta_pessoal: 0 };
    const p = derivarPosicaoAoVivo(linha);
    expect(p.gap).toBeNull();
    expect(p.metaAtingida).toBeNull();
  });

  it("meta ZERO não é meta: gap e progresso desconhecidos", () => {
    const p = derivarPosicaoAoVivo({ ...COM_FATURADO, meta_pessoal: 0, gap_para_meta_pessoal: 0 });
    expect(p.metaAtingida).toBeNull();
    expect(p.progresso).toBeNull();
  });

  it("gap 0 com meta cadastrada: meta atingida; progresso no teto de 100", () => {
    const p = derivarPosicaoAoVivo({
      ...COM_FATURADO,
      posicao_ao_vivo_conservadora: 450000,
      gap_para_meta_pessoal: 0,
    });
    expect(p.metaAtingida).toBe(true);
    expect(p.progresso).toBe(100);
  });

  it("número não finito vindo da borda não é posição", () => {
    const linha = { ...COM_FATURADO, posicao_ao_vivo_conservadora: Number.NaN };
    expect(posicaoConhecida(linha)).toBe(false);
  });
});
