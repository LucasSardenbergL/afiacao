import { describe, it, expect } from "vitest";
import { motivoContato, rotuloContagem } from "../config";

const base = {
  sales_history_status: "com_historico",
  health_class: "atencao",
  days_since_last_purchase: 66,
  avg_monthly_spend_180d: 1200,
  priority_score: 40,
};

describe("rotuloContagem — total honesto (ausente ≠ zero)", () => {
  it("total confirmado: contagem pt-BR com milhar", () => {
    expect(rotuloContagem({ total: 16099, pendente: false, carregados: 50, isCarteira: false }))
      .toBe("16.099 clientes na base");
  });
  it("carteira confirmada usa o rótulo da carteira", () => {
    expect(rotuloContagem({ total: 12, pendente: false, carregados: 12, isCarteira: true }))
      .toBe("12 clientes na carteira");
  });
  it("0 MEDIDO continua 0 (não vira indisponível)", () => {
    expect(rotuloContagem({ total: 0, pendente: false, carregados: 0, isCarteira: false }))
      .toBe("0 clientes na base");
  });
  it("enquanto a contagem não chega: diz quantos já carregou, não afirma a base", () => {
    expect(rotuloContagem({ total: null, pendente: true, carregados: 1050, isCarteira: false }))
      .toBe("1.050 clientes carregados");
  });
  it("count null ou falha (sem pendência): contagem indisponível, nunca 0", () => {
    expect(rotuloContagem({ total: null, pendente: false, carregados: 50, isCarteira: false }))
      .toBe("contagem indisponível");
  });
});

describe("motivoContato — linha sob o nome", () => {
  it("classe · dias sem compra", () => {
    expect(motivoContato(base)).toBe("Atenção · 66d sem compra");
  });
  it("sem_historico: texto próprio, sem os 999d sentinela", () => {
    expect(motivoContato({ ...base, sales_history_status: "sem_historico", days_since_last_purchase: 999 }))
      .toBe("Sem histórico de compra");
  });
  it("sem recência medida: omite os dias (não fabrica número)", () => {
    expect(motivoContato({ ...base, days_since_last_purchase: null })).toBe("Atenção");
  });
  it("0 dias MEDIDO aparece como 0d", () => {
    expect(motivoContato({ ...base, health_class: "saudavel", days_since_last_purchase: 0 }))
      .toBe("Saudável · 0d sem compra");
  });
  it("classe desconhecida vira Não avaliado, nunca Crítico", () => {
    expect(motivoContato({ ...base, health_class: null })).toBe("Não avaliado · 66d sem compra");
  });
  it("sem score: nada a afirmar", () => {
    expect(motivoContato(undefined)).toBeNull();
    expect(motivoContato(null)).toBeNull();
  });
});
