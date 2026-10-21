import { describe, expect, it } from "vitest";
import { lerEnvioSeparacao, lerResultadoComando, paraTarefaV2 } from "../borda-rpc";

const tarefa = {
  id: "t1",
  account: "oben",
  omie_codigo_pedido: 10,
  numero_pedido: null,
  cliente_nome: null,
  status: "aguardando",
  revisao: 1,
  estado_seq: 1,
  operador_id: null,
  atribuicao_id: null,
  motivo_bloqueio: null,
  ausente_rodadas: 0,
  incluido_em: null,
};

describe("paraTarefaV2", () => {
  it("aceita conta e status do CHECK de prod", () => {
    expect(paraTarefaV2(tarefa)).toEqual(tarefa);
    expect(paraTarefaV2({ ...tarefa, account: "colacor", status: "bloqueado_dado" }).status).toBe("bloqueado_dado");
  });

  it("lança em conta fora do vocabulário", () => {
    expect(() => paraTarefaV2({ ...tarefa, account: "afiacao" })).toThrow(/account desconhecida "afiacao"/);
  });

  it("lança em status fora do vocabulário", () => {
    expect(() => paraTarefaV2({ ...tarefa, status: "cancelada" })).toThrow(/status desconhecido "cancelada"/);
  });
});

describe("lerResultadoComando", () => {
  it("data NULL (replay sem resultado gravado) segue como sem_resposta", () => {
    expect(lerResultadoComando(null)).toEqual({ ok: false, motivo: "sem_resposta" });
  });

  it("lê o sucesso do pegar com atribuição e revisão", () => {
    expect(
      lerResultadoComando({ ok: true, atribuicao_id: "a1", tarefa_revisao: 3, estado_seq: 7, replay: false }),
    ).toEqual({ ok: true, motivo: undefined, atribuicao_id: "a1", tarefa_revisao: 3, estado_seq: 7 });
  });

  it("chaves opcionais ausentes ou NULL viram undefined", () => {
    expect(lerResultadoComando({ ok: false, motivo: "estado_mudou", atribuicao_id: null })).toEqual({
      ok: false,
      motivo: "estado_mudou",
      atribuicao_id: undefined,
      tarefa_revisao: undefined,
      estado_seq: undefined,
    });
  });

  it("lança sem `ok` booleano (chave ausente ≠ falso)", () => {
    expect(() => lerResultadoComando({ motivo: "x" })).toThrow(/sem "ok" booleano/);
    expect(() => lerResultadoComando({ ok: "true" })).toThrow(/sem "ok" booleano/);
  });

  it("lança quando a resposta não é objeto", () => {
    expect(() => lerResultadoComando([])).toThrow(/não é objeto/);
    expect(() => lerResultadoComando("ok")).toThrow(/não é objeto/);
  });

  it("lança em opcional com tipo trocado", () => {
    expect(() => lerResultadoComando({ ok: true, tarefa_revisao: "3" })).toThrow(/"tarefa_revisao" não é número/);
    expect(() => lerResultadoComando({ ok: true, atribuicao_id: 1 })).toThrow(/"atribuicao_id" não é texto/);
  });
});

describe("lerEnvioSeparacao", () => {
  it("lê task_id e created (extras ignorados)", () => {
    expect(lerEnvioSeparacao({ task_id: "t1", created: true, item_count: 2, bad_count: 0 })).toEqual({
      task_id: "t1",
      created: true,
    });
  });

  it("lança sem created booleano (o toast depende dele)", () => {
    expect(() => lerEnvioSeparacao({ task_id: "t1" })).toThrow(/sem "created" booleano/);
  });

  it("lança sem task_id ou com data NULL", () => {
    expect(() => lerEnvioSeparacao({ created: false })).toThrow(/sem "task_id"/);
    expect(() => lerEnvioSeparacao(null)).toThrow(/não é objeto/);
  });
});
