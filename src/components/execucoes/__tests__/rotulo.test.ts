import { describe, it, expect } from "vitest";
import { rotuloUltimaExecucao } from "../rotulo";
import type { AcaoExecucao } from "../tipos";

const AGORA = new Date("2026-07-18T15:00:00-03:00");

function execucao(parcial: Partial<AcaoExecucao>): AcaoExecucao {
  return {
    id: "1",
    acao: "analytics_sync.recalcular_custos",
    origem: "manual",
    executado_por: "u1",
    executado_por_nome: "Lucas",
    iniciado_em: "2026-07-18T13:00:00-03:00",
    finalizado_em: "2026-07-18T13:05:00-03:00",
    status: "sucesso",
    detalhes: null,
    ...parcial,
  };
}

describe("rotuloUltimaExecucao", () => {
  it("sem execução → Nunca executada", () => {
    expect(rotuloUltimaExecucao(null, AGORA)).toEqual({ texto: "Nunca executada", tom: "muted" });
  });

  it("executando recente → em andamento com tempo relativo", () => {
    const r = rotuloUltimaExecucao(
      execucao({ status: "executando", iniciado_em: "2026-07-18T14:55:00-03:00", finalizado_em: null }),
      AGORA,
    );
    expect(r.tom).toBe("andamento");
    expect(r.texto).toBe("Em andamento (há 5 minutos)");
  });

  it("executando há mais de 2h → interrompida?", () => {
    const r = rotuloUltimaExecucao(
      execucao({ status: "executando", iniciado_em: "2026-07-18T07:00:00-03:00", finalizado_em: null }),
      AGORA,
    );
    expect(r.tom).toBe("muted");
    expect(r.texto).toBe("Iniciada há cerca de 8 horas (interrompida?)");
  });

  it("sucesso manual → tempo relativo do FIM + nome + ✓", () => {
    const r = rotuloUltimaExecucao(execucao({}), AGORA);
    expect(r.tom).toBe("muted");
    expect(r.texto).toBe("Última execução: há cerca de 2 horas · Lucas · ✓");
  });

  it("sucesso automática → rotula automática", () => {
    const r = rotuloUltimaExecucao(
      execucao({ origem: "automatica", executado_por: null, executado_por_nome: null }),
      AGORA,
    );
    expect(r.texto).toBe("Última execução: há cerca de 2 horas · automática · ✓");
  });

  it("erro → falhou em tom de erro", () => {
    const r = rotuloUltimaExecucao(execucao({ status: "erro" }), AGORA);
    expect(r.tom).toBe("erro");
    expect(r.texto).toBe("Última execução: há cerca de 2 horas · Lucas · falhou");
  });

  it("manual sem nome (lookup falhou) → omite o segmento do executor", () => {
    const r = rotuloUltimaExecucao(execucao({ executado_por_nome: null }), AGORA);
    expect(r.texto).toBe("Última execução: há cerca de 2 horas · ✓");
  });

  it("sucesso sem finalizado_em (legado) → cai no iniciado_em", () => {
    const r = rotuloUltimaExecucao(
      execucao({ finalizado_em: null, iniciado_em: "2026-07-18T13:05:00-03:00" }),
      AGORA,
    );
    expect(r.texto).toContain("há");
  });
});
