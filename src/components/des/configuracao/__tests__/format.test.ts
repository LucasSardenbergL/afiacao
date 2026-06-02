import { describe, it, expect } from "vitest";
import {
  parseMetaInput,
  parseFaixaInput,
  isMetaValida,
  classificarPeriodo,
  anosSelecionaveis,
  formatMetaParaInput,
} from "../format";

describe("parseMetaInput", () => {
  it("parseia inteiro simples", () => {
    expect(parseMetaInput("400840")).toBe(400840);
  });
  it("trata ponto como separador de milhar (pt-BR)", () => {
    expect(parseMetaInput("400.840")).toBe(400840);
    expect(parseMetaInput("1.234.567")).toBe(1234567);
  });
  it("trata vírgula como separador decimal", () => {
    expect(parseMetaInput("400.840,50")).toBe(400840.5);
    expect(parseMetaInput("400840,50")).toBe(400840.5);
    expect(parseMetaInput("1234,5")).toBe(1234.5);
  });
  it("ignora prefixo R$ e espaços", () => {
    expect(parseMetaInput("R$ 400.840,00")).toBe(400840);
    expect(parseMetaInput("  400840  ")).toBe(400840);
  });
  it("retorna null para vazio, só-símbolo ou não-numérico", () => {
    expect(parseMetaInput("")).toBeNull();
    expect(parseMetaInput("   ")).toBeNull();
    expect(parseMetaInput("abc")).toBeNull();
    expect(parseMetaInput("R$")).toBeNull();
  });
  it("REJEITA formato malformado em vez de corromper (money-safe)", () => {
    // Casos onde uma 'limpeza' ingênua salvaria OUTRO valor (bug pego pelo codex).
    expect(parseMetaInput("1.2.3")).toBeNull(); // milhar inválido (viraria 123)
    expect(parseMetaInput("1e6")).toBeNull(); // notação científica (viraria 16)
    expect(parseMetaInput("abc400")).toBeNull(); // lixo + dígitos (viraria 400)
    expect(parseMetaInput("1,2,3")).toBeNull(); // múltiplas vírgulas
    expect(parseMetaInput("400840.50")).toBeNull(); // ponto decimal en-US (viraria 40084050)
    expect(parseMetaInput("1.23")).toBeNull(); // ponto não-milhar (3 dígitos exigidos)
  });
});

describe("isMetaValida", () => {
  it("aceita valor positivo", () => {
    expect(isMetaValida(400840)).toBe(true);
    expect(isMetaValida(0.01)).toBe(true);
  });
  it("rejeita null, zero, negativo e NaN", () => {
    expect(isMetaValida(null)).toBe(false);
    expect(isMetaValida(0)).toBe(false);
    expect(isMetaValida(-5)).toBe(false);
    expect(isMetaValida(NaN)).toBe(false);
  });
});

describe("parseFaixaInput", () => {
  it("parseia inteiro >= 1", () => {
    expect(parseFaixaInput("3")).toBe(3);
    expect(parseFaixaInput("10")).toBe(10);
  });
  it("retorna null para vazio (campo opcional)", () => {
    expect(parseFaixaInput("")).toBeNull();
    expect(parseFaixaInput("   ")).toBeNull();
  });
  it("REJEITA malformado e zero em vez de corromper", () => {
    expect(parseFaixaInput("abc")).toBeNull();
    expect(parseFaixaInput("1.5")).toBeNull(); // viraria 15
    expect(parseFaixaInput("abc3")).toBeNull(); // viraria 3
    expect(parseFaixaInput("0")).toBeNull(); // faixa < 1 inválida
    expect(parseFaixaInput("-2")).toBeNull();
  });
});

describe("classificarPeriodo", () => {
  it("identifica o trimestre corrente", () => {
    expect(classificarPeriodo(2026, 2, 2026, 2)).toBe("corrente");
  });
  it("identifica passado (mesmo ano e ano anterior)", () => {
    expect(classificarPeriodo(2026, 1, 2026, 2)).toBe("passado");
    expect(classificarPeriodo(2025, 4, 2026, 1)).toBe("passado");
  });
  it("identifica futuro (mesmo ano e próximo ano)", () => {
    expect(classificarPeriodo(2026, 3, 2026, 2)).toBe("futuro");
    expect(classificarPeriodo(2027, 1, 2026, 4)).toBe("futuro");
  });
});

describe("formatMetaParaInput", () => {
  it("formata número salvo em pt-BR (sem símbolo de moeda)", () => {
    expect(formatMetaParaInput(400840)).toBe("400.840");
    expect(formatMetaParaInput(400840.5)).toBe("400.840,5");
  });
  it("retorna vazio para null/undefined/NaN", () => {
    expect(formatMetaParaInput(null)).toBe("");
    expect(formatMetaParaInput(undefined)).toBe("");
    expect(formatMetaParaInput(NaN)).toBe("");
  });
  it("é o inverso de parseMetaInput (round-trip, até 2 casas)", () => {
    for (const n of [400840, 1234.56, 1000000, 0.5, 999]) {
      expect(parseMetaInput(formatMetaParaInput(n))).toBe(n);
    }
  });
});

describe("anosSelecionaveis", () => {
  it("retorna anoAtual-3 .. anoAtual+1, mais recente primeiro", () => {
    expect(anosSelecionaveis(2026)).toEqual([2027, 2026, 2025, 2024, 2023]);
  });
  it("sempre contém o ano atual", () => {
    expect(anosSelecionaveis(2030)).toContain(2030);
  });
});
