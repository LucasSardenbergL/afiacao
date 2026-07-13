import { describe, it, expect } from "vitest";
import { devePublicarRun, cadenciaPodeAvancar, type RunPublicacaoStatus } from "./publicacao-run";

// Prova as 2 decisões money-path da edge omie-sync-pedidos-compra que o Codex apontou sem cobertura
// (challenge xhigh 2026-07-12): P1#1/#2 (quando publicar) e P1#3 (quando a cadência avança).

describe("devePublicarRun (Codex P1 #1/#2 — só completo LIMPO e NÃO-filtrado)", () => {
  const base: RunPublicacaoStatus = { modo: "completo", erros: 0, varreduraCompleta: true, fornecedorCodigo: undefined };

  it("publica no completo limpo, não-filtrado, que viu o fim", () => {
    expect(devePublicarRun(base)).toBe(true);
  });
  it("P1#2: NÃO publica run filtrado por fornecedor (carimbaria um subset)", () => {
    expect(devePublicarRun({ ...base, fornecedorCodigo: 8689681266 })).toBe(false);
  });
  it("NÃO publica no modo incremental (janela curta, não é o snapshot de verdade)", () => {
    expect(devePublicarRun({ ...base, modo: "incremental" })).toBe(false);
  });
  it("P1#1: NÃO publica com erro (abort/fault/truncamento incrementam erros)", () => {
    expect(devePublicarRun({ ...base, erros: 1 })).toBe(false);
  });
  it("P1#1: NÃO publica se não viu o fim legítimo (varredura incompleta)", () => {
    expect(devePublicarRun({ ...base, varreduraCompleta: false })).toBe(false);
  });
  it("fornecedorCodigo=0 (falsy) NÃO conta como filtro — publica", () => {
    expect(devePublicarRun({ ...base, fornecedorCodigo: 0 })).toBe(true);
  });
});

describe("cadenciaPodeAvancar (Codex P1 #3 — só run VÁLIDO avança a cadência)", () => {
  it("avança só com volume_ok=true (run válido)", () => {
    expect(cadenciaPodeAvancar(true)).toBe(true);
  });
  it("NÃO avança no bootstrap (volume_ok=null) — sem baseline não há run válido", () => {
    expect(cadenciaPodeAvancar(null)).toBe(false);
  });
  it("NÃO avança no truncado (volume_ok=false) — próximo ciclo re-tenta o completo", () => {
    expect(cadenciaPodeAvancar(false)).toBe(false);
  });
});
