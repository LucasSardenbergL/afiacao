import { describe, expect, it } from "vitest";
import { candidatosDe, concluirSonda, escolherMes, mesBr, type Lote } from "./mes-alvo";

// Relógio CONTROLADO (money-path.md): o dado fica parado e quem anda é o `agora` do teste.
const AGORA = new Date("2026-10-20T06:00:00Z"); // 03:00 em Brasília, dia 20
const todosDisponiveis = () => "disponivel" as const;
const nenhumDisponivel = () => "indisponivel" as const;
const lote = (mes: string, status: Lote["status"], iniciado_em: string | null = "2026-06-12T01:05:18Z"): Lote =>
  ({ mes_referencia: mes, status, iniciado_em });
const ha = (horas: number) => new Date(AGORA.getTime() - horas * 3_600_000).toISOString();

describe("mesBr / candidatosDe — janela de 3 meses em Brasília", () => {
  it("[M1] janela [M-2, M-1, M] do mais antigo para o mais novo", () => {
    expect(candidatosDe(AGORA)).toEqual(["2026-08", "2026-09", "2026-10"]);
  });
  it("[M2] vira o ano para trás", () => {
    expect(candidatosDe(new Date("2026-01-20T06:00:00Z"))).toEqual(["2025-11", "2025-12", "2026-01"]);
  });
  it("[M3] o mês é o de Brasília, não o UTC (01:00 UTC do dia 1 ainda é o mês anterior em SP)", () => {
    expect(mesBr(new Date("2026-11-01T01:00:00Z"))).toBe("2026-10");
    expect(mesBr(new Date("2026-11-01T04:00:00Z"))).toBe("2026-11");
  });
});

describe("concluirSonda — 404 em todas as bases é 'não publicado'; transporte ruim é ERRO", () => {
  it("[S1] algum 200 → disponível, mesmo com erro em outra base", () => {
    expect(concluirSonda("2026-10", [{ tipo: "erro", detalhe: "timeout" }, { tipo: "http", status: 200 }])).toBe("disponivel");
  });
  it("[S2] só 404 → indisponível", () => {
    expect(concluirSonda("2026-11", [{ tipo: "http", status: 404 }, { tipo: "http", status: 404 }, { tipo: "http", status: 404 }])).toBe("indisponivel");
  });
  it("[S3] timeout/5xx/429 sem nenhum 200 → lança (nunca vira 'nada a fazer' verde)", () => {
    expect(() => concluirSonda("2026-10", [{ tipo: "erro", detalhe: "timeout" }, { tipo: "http", status: 404 }])).toThrow(/sem resposta conclusiva/);
    expect(() => concluirSonda("2026-10", [{ tipo: "http", status: 503 }, { tipo: "http", status: 404 }])).toThrow(/HTTP 503/);
    expect(() => concluirSonda("2026-10", [{ tipo: "http", status: 429 }])).toThrow(/HTTP 429/);
  });
});

describe("escolherMes — nunca regride, nunca pula em silêncio, nunca atropela carga viva", () => {
  it("[E1] situação de prod: só 2026-05 complete → escolhe o MAIS ANTIGO pendente disponível", async () => {
    const d = await escolherMes({ candidatos: candidatosDe(AGORA), disponivel: todosDisponiveis, lotes: [lote("2026-05", "complete")], forcar: false, agora: AGORA });
    expect(d.mes).toBe("2026-08");
  });
  it("[E2] mês ainda não publicado → nada a fazer com o motivo (não inventa)", async () => {
    const d = await escolherMes({ candidatos: candidatosDe(AGORA), disponivel: (m) => (m === "2026-10" ? "indisponivel" : "disponivel"),
      lotes: [lote("2026-08", "complete"), lote("2026-09", "complete")], forcar: false, agora: AGORA });
    expect(d.mes).toBeNull();
    expect(d.motivos.join("\n")).toContain("2026-10: ainda não publicado");
  });
  it("[E3] publicação atrasada: 2026-09 só saiu depois da rodada → entra na próxima, antes de 2026-10", async () => {
    const d = await escolherMes({ candidatos: candidatosDe(AGORA), disponivel: todosDisponiveis, lotes: [lote("2026-08", "complete")], forcar: false, agora: AGORA });
    expect(d.mes).toBe("2026-09");
  });
  it("[E4] REGRESSÃO barrada: mês anterior ao lote mais novo conhecido nunca é escolhido, nem com --forcar", async () => {
    const lotes = [lote("2026-10", "complete")];
    expect((await escolherMes({ candidatos: ["2026-09"], disponivel: todosDisponiveis, lotes, forcar: false, agora: AGORA })).mes).toBeNull();
    const forcado = await escolherMes({ candidatos: ["2026-09"], disponivel: todosDisponiveis, lotes, forcar: true, agora: AGORA });
    expect(forcado.mes).toBeNull();
    expect(forcado.motivos[0]).toContain("regressão");
  });
  it("[E4b] lote `error` mais novo também é régua de regressão (os chunks já escreveram ultimo_lote)", async () => {
    const lotes = [lote("2026-10", "complete"), lote("2026-11", "error"), lote("2026-12", "error"), lote("2027-01", "error")];
    expect((await escolherMes({ candidatos: ["2026-09"], disponivel: todosDisponiveis, lotes, forcar: true, agora: AGORA })).mes).toBeNull();
    // e o mais novo em error é retomado normalmente
    expect((await escolherMes({ candidatos: ["2026-11", "2026-12", "2027-01"], disponivel: todosDisponiveis, lotes, forcar: false, agora: AGORA })).mes).toBe("2027-01");
  });
  it("[E5] já complete → nada a fazer; --forcar releva SÓ o complete do próprio mês", async () => {
    const lotes = [lote("2026-10", "complete")];
    expect((await escolherMes({ candidatos: ["2026-10"], disponivel: todosDisponiveis, lotes, forcar: false, agora: AGORA })).mes).toBeNull();
    expect((await escolherMes({ candidatos: ["2026-10"], disponivel: todosDisponiveis, lotes, forcar: true, agora: AGORA })).mes).toBe("2026-10");
  });
  it("[E6] QUALQUER lote running vivo (< 8 h) bloqueia a seleção inteira; > 8 h é retomado", async () => {
    // agosto vivo, setembro disponível → nada (dois escritores disputariam ultimo_lote)
    const vivo = [lote("2026-08", "running", ha(2))];
    const d = await escolherMes({ candidatos: ["2026-08", "2026-09"], disponivel: todosDisponiveis, lotes: vivo, forcar: false, agora: AGORA });
    expect(d.mes).toBeNull();
    expect(d.motivos[0]).toContain("nenhum mês é escolhido");
    const morto = [lote("2026-10", "running", ha(9))];
    expect((await escolherMes({ candidatos: ["2026-10"], disponivel: todosDisponiveis, lotes: morto, forcar: false, agora: AGORA })).mes).toBe("2026-10");
  });
  it("[E7] lote error é retomado (begin_lote preserva iniciado_em; upsert é idempotente)", async () => {
    expect((await escolherMes({ candidatos: ["2026-10"], disponivel: todosDisponiveis, lotes: [lote("2026-10", "error")], forcar: false, agora: AGORA })).mes).toBe("2026-10");
  });
  it("[E8] nada disponível → null com um motivo por candidato (nunca escolhe no escuro)", async () => {
    const d = await escolherMes({ candidatos: candidatosDe(AGORA), disponivel: nenhumDisponivel, lotes: [], forcar: false, agora: AGORA });
    expect(d.mes).toBeNull();
    expect(d.motivos).toHaveLength(3);
  });
  it("[E9] sonda preguiçosa: só quem passou pelas guardas é sondado, e para no 1º disponível", async () => {
    const sondados: string[] = [];
    const sonda = async (m: string) => { sondados.push(m); return "disponivel" as const; };
    const d = await escolherMes({ candidatos: candidatosDe(AGORA), disponivel: sonda, lotes: [lote("2026-08", "complete")], forcar: false, agora: AGORA });
    expect(d.mes).toBe("2026-09");
    expect(sondados).toEqual(["2026-09"]); // 2026-08 (complete) não sondado; 2026-10 não alcançado
  });
  it("[E10] erro de sonda em mês pendente PROPAGA (não cai para o próximo mês)", async () => {
    const sonda = async (m: string) => { if (m === "2026-09") throw new Error("sonda da RFB para 2026-09 sem resposta conclusiva (timeout)"); return "disponivel" as const; };
    await expect(escolherMes({ candidatos: candidatosDe(AGORA), disponivel: sonda, lotes: [lote("2026-08", "complete")], forcar: false, agora: AGORA }))
      .rejects.toThrow(/sem resposta conclusiva/);
  });
});
