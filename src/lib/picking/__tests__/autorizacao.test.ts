import { describe, expect, it } from "vitest";
import { bloqueioDaTarefa, type InsumosBloqueio } from "../autorizacao";
import type { TarefaV2 } from "../v2-api";

const tarefa = { status: "em_separacao", atribuicao_id: "A1", operador_id: "U1", revisao: 3, ausente_rodadas: 0 } as TarefaV2;
const base: InsumosBloqueio = {
  tarefa,
  atribuicao: { atribuicao_id: "A1", tarefa_revisao: 3 },
  operador: "U1",
  epocaLida: 2,
  epocaAtual: { n: 2, aberta: false },
  leituraIniciadaEm: 1_000,
  montadoEm: 500,
  ausenteEm: null,
};
const com = (p: Partial<InsumosBloqueio>) => bloqueioDaTarefa({ ...base, ...p });

describe("bloqueio da captura", () => {
  it("contexto em dia autoriza", () => {
    expect(com({})).toBeNull();
  });

  it("sem releitura que COMEÇOU depois do mount não autoriza: reload, cache, consulta em voo herdada, releitura falhando (Codex r4)", () => {
    expect(com({ leituraIniciadaEm: null, epocaLida: null })).toBe("conferindo_tarefa");
    expect(com({ leituraIniciadaEm: 400 })).toBe("conferindo_tarefa");
    expect(com({ leituraIniciadaEm: 500 })).toBeNull();
  });

  it("barreira aberta em outra aba bloqueia, mesmo com a releitura em dia (Codex r3-B)", () => {
    expect(com({ epocaLida: 3, epocaAtual: { n: 3, aberta: true } })).toBe("barreira_em_andamento");
  });

  it("época mudou depois da releitura: conferir de novo", () => {
    expect(com({ epocaAtual: { n: 4, aberta: false } })).toBe("conferindo_tarefa");
  });

  it("negativa `ausente_do_omie` bloqueia até uma releitura que COMEÇOU depois dela (Codex r3-C/r4)", () => {
    // Consulta iniciada antes da negativa e respondida depois ainda carrega o retrato velho.
    expect(com({ ausenteEm: 1_500, leituraIniciadaEm: 1_000 })).toBe("ausente_do_omie");
    expect(com({ ausenteEm: 1_500, leituraIniciadaEm: 1_500 })).toBe("ausente_do_omie");
    expect(com({ ausenteEm: 1_500, leituraIniciadaEm: 1_501 })).toBeNull();
  });

  it("espelha a RPC: status, atribuição, operador, revisão e ausente_rodadas", () => {
    expect(com({ tarefa: { ...tarefa, status: "aguardando_ajuste" } as TarefaV2 })).toBe("tarefa_fora_de_separacao");
    expect(com({ tarefa: { ...tarefa, atribuicao_id: "A2" } as TarefaV2 })).toBe("atribuicao_antiga");
    expect(com({ operador: "U2" })).toBe("atribuicao_antiga");
    expect(com({ tarefa: { ...tarefa, revisao: 4 } as TarefaV2 })).toBe("revisao_antiga");
    expect(com({ tarefa: { ...tarefa, ausente_rodadas: 2 } as TarefaV2 })).toBe("ausente_do_omie");
  });
});
