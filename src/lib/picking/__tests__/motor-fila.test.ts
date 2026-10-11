import { describe, expect, it } from "vitest";
import { criarMotor } from "../motor-fila";
import { armazemMemoria, type Comando, type ItemFila, type ResultadoEnvio } from "../scanner/fila";

function item(id: string, dono = "U1", tarefa = "T1"): Omit<ItemFila, "seq"> {
  const comando: Comando = { leitura_id: id, account: "oben", tarefa_id: tarefa, atribuicao_id: "A1", tarefa_revisao: 1, tipo: "bipe", lido_em: "x" };
  return { comando, operador_id: dono, estado: "pendente", tentativas: 0, motivo: null, linha_id: null, unidades: null, previsto: { linha_id: "L", unidades: 1 }, divergente_nao_visto: false };
}

const aceita: ResultadoEnvio = { tipo: "resposta", resposta: { ok: true, motivo: null, linha_id: "L", unidades: 1 } };
const espera = () => new Promise((r) => setTimeout(r, 0));

async function montar(enviar: (c: Comando) => Promise<ResultadoEnvio>, itens: string[], dono = "U1") {
  const a = armazemMemoria();
  for (const id of itens) await a.enfileirar(item(id, dono));
  const enviados: string[] = [];
  const motor = criarMotor((c) => {
    enviados.push(c.leitura_id);
    return enviar(c);
  }, () => Promise.resolve(a));
  await espera();
  return { motor, enviados, a };
}

describe("motor da fila", () => {
  it("sem operador configurado (ou sob a lente) NÃO envia nada", async () => {
    const { motor, enviados } = await montar(() => Promise.resolve(aceita), ["u1"]);
    motor.configurar("U1", true);
    await motor.drenar("T1");
    await espera();
    expect(enviados).toEqual([]);
    expect(motor.estado().pausado).toBe(true);
  });

  it("com o dono e sem lente, drena a tarefa em ordem", async () => {
    const { motor, enviados } = await montar(() => Promise.resolve(aceita), ["u1", "u2"]);
    motor.configurar("U1", false);
    expect(await motor.drenar("T1")).toBe(true);
    expect(enviados.slice(0, 2)).toEqual(["u1", "u2"]);
  });

  it("outro usuário não envia as leituras do anterior; drenar devolve false (não conclui)", async () => {
    const { motor, enviados } = await montar(() => Promise.resolve(aceita), ["u1"], "U1");
    motor.configurar("U2", false);
    expect(await motor.drenar("T1")).toBe(false);
    expect(enviados).toEqual([]);
  });

  it("offline: drenar devolve false sem marcar nada como resolvido", async () => {
    const { motor, a } = await montar(() => Promise.resolve({ tipo: "transitorio", erro: "Failed to fetch" }), ["u1"]);
    motor.configurar("U1", false);
    expect(await motor.drenar("T1")).toBe(false);
    expect((await a.todos())[0].estado).toBe("pendente");
  });

  it("armazém que não abre vira erro visível (sem fallback em memória)", async () => {
    const motor = criarMotor(() => Promise.resolve(aceita), () => Promise.reject(new Error("IndexedDB indisponível")));
    await espera();
    expect([motor.estado().pronto, motor.estado().erroArmazem]).toEqual([false, "IndexedDB indisponível"]);
  });
});
