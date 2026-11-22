import { describe, it, expect } from "vitest";
import {
  formatDocument, HEALTH_CLASSES, fmt, NAO_APURADO, fmtContagem, fmtGasto, fmtPrioridade,
  classeSaudeExibida, metricasExibiveis, estadoFiltroSaude, prioridadeDisponivel,
} from "../config";

describe("adminCustomers/config", () => {
  it("formatDocument formata CPF/CNPJ e trata null/outros", () => {
    expect(formatDocument(null)).toBe("-");
    expect(formatDocument("12345678901")).toBe("123.456.789-01");
    expect(formatDocument("12345678000199")).toBe("12.345.678/0001-99");
    expect(formatDocument("123")).toBe("123");
  });

  it("HEALTH_CLASSES mapeia rótulos", () => {
    expect(HEALTH_CLASSES.saudavel.label).toBe("Saudável");
    expect(HEALTH_CLASSES.estavel.label).toBe("Estável");
    expect(HEALTH_CLASSES.atencao.label).toBe("Atenção"); // antes 'alerta' (drift do engine, que grava 'atencao')
    expect(HEALTH_CLASSES.critico.label).toBe("Crítico");
  });

  it("fmt em BRL", () => {
    expect(fmt(1000)).toContain("1.000,00");
  });
});

describe("adminCustomers/config — ausente ≠ zero", () => {
  const base = { days_since_last_purchase: 999, avg_monthly_spend_180d: 0, priority_score: 67 };

  it("sem_historico: as sentinelas da edge (999d, R$ 0, prioridade 67) viram null", () => {
    expect(metricasExibiveis({ ...base, sales_history_status: "sem_historico" }))
      .toEqual({ dias: null, gasto: null, prioridade: null });
  });

  it("com histórico: zero MEDIDO é preservado (R$ 0,00 na janela de 180d é dado real)", () => {
    expect(metricasExibiveis({ sales_history_status: "ativo", days_since_last_purchase: 218, avg_monthly_spend_180d: 0, priority_score: 32 }))
      .toEqual({ dias: 218, gasto: 0, prioridade: 32 });
  });

  it("formatadores: null → '—'; prioridade inteira; contagem com milhar", () => {
    expect(fmtGasto(null)).toBe(NAO_APURADO);
    expect(fmtGasto(0)).toContain("0,00");
    expect(fmtPrioridade(null)).toBe(NAO_APURADO);
    expect(fmtPrioridade(34)).toBe("34");
    expect(fmtContagem(16099)).toBe("16.099");
  });

  it("classe ausente ou desconhecida → 'Não avaliado', nunca 'Crítico'", () => {
    expect(classeSaudeExibida(null).label).toBe("Não avaliado");
    expect(classeSaudeExibida("xpto").label).toBe("Não avaliado");
    expect(classeSaudeExibida("atencao").label).toBe("Atenção");
  });
});

describe('estadoFiltroSaude — mapa vazio de scores não vira "nenhum Crítico"', () => {
  it('"Todos" é inativo em qualquer estado', () => {
    expect(estadoFiltroSaude({ filtro: 'all', filtroNoServidor: false, scoresEstado: 'falha' })).toBe('inativo');
  });
  it('base completa: o servidor aplica — scores locais não importam', () => {
    expect(estadoFiltroSaude({ filtro: 'critico', filtroNoServidor: true, scoresEstado: 'carregando' })).toBe('aplicado');
  });
  it('carteira: só aplica com scores lidos; senão herda carregando/falha', () => {
    expect(estadoFiltroSaude({ filtro: 'critico', filtroNoServidor: false, scoresEstado: 'ok' })).toBe('aplicado');
    expect(estadoFiltroSaude({ filtro: 'critico', filtroNoServidor: false, scoresEstado: 'carregando' })).toBe('carregando');
    expect(estadoFiltroSaude({ filtro: 'sem_historico', filtroNoServidor: false, scoresEstado: 'falha' })).toBe('falha');
  });
});

describe('prioridadeDisponivel', () => {
  it('carteira em "prioridade" sem scores lidos: indisponível (cai no A–Z e a tela avisa)', () => {
    expect(prioridadeDisponivel({ ordem: 'prioridade', filtroNoServidor: false, scoresEstado: 'carregando' })).toBe(false);
    expect(prioridadeDisponivel({ ordem: 'prioridade', filtroNoServidor: false, scoresEstado: 'falha' })).toBe(false);
    expect(prioridadeDisponivel({ ordem: 'prioridade', filtroNoServidor: false, scoresEstado: 'ok' })).toBe(true);
  });
  it('A–Z e base completa sempre disponíveis', () => {
    expect(prioridadeDisponivel({ ordem: 'nome', filtroNoServidor: false, scoresEstado: 'falha' })).toBe(true);
    expect(prioridadeDisponivel({ ordem: 'prioridade', filtroNoServidor: true, scoresEstado: 'falha' })).toBe(true);
  });
});
