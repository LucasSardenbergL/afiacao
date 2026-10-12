/**
 * @vitest-environment jsdom
 */
import { describe, expect, it } from "vitest";
import { avancarEpoca, criarMotor, ehChaveEpoca, lerEpoca } from "../motor-fila";
import { armazemMemoria, type Comando, type ItemFila, type ResultadoEnvio } from "../scanner/fila";

function item(id: string, dono = "U1", tarefa = "T1"): Omit<ItemFila, "seq"> {
  const comando: Comando = { leitura_id: id, account: "oben", tarefa_id: tarefa, atribuicao_id: "A1", tarefa_revisao: 1, tipo: "bipe", lido_em: "x" };
  return { comando, operador_id: dono, estado: "pendente", tentativas: 0, motivo: null, linha_id: null, unidades: null, previsto: { linha_id: "L", unidades: 1 }, divergente_nao_visto: false };
}

const aceita: ResultadoEnvio = { tipo: "resposta", resposta: { ok: true, motivo: null, linha_id: "L", unidades: 1 } };
const espera = () => new Promise((r) => setTimeout(r, 0));

/** Ambiente mutável: o teste troca a sessão e a lente como o app trocaria (sem página montada). */
async function montar(enviar: (c: Comando) => Promise<ResultadoEnvio>, itens: string[], dono = "U1", inicio: { sessao?: string | null; lente?: boolean } = {}) {
  const a = armazemMemoria();
  for (const id of itens) await a.enfileirar(item(id, dono));
  const enviados: string[] = [];
  const amb = { sessao: "U1" as string | null, lente: false, aoEnviar: () => {}, ...inicio };
  const motor = criarMotor(
    (c) => {
      enviados.push(c.leitura_id);
      amb.aoEnviar();
      return enviar(c);
    },
    () => Promise.resolve(a),
    () => {},
    { sessao: () => Promise.resolve(amb.sessao), lente: () => amb.lente },
  );
  await espera();
  return { motor, enviados, a, amb };
}

describe("motor da fila", () => {
  it("sob a lente NÃO envia nada; desligada a lente, envia sem precisar de página", async () => {
    const { motor, enviados, amb } = await montar(() => Promise.resolve(aceita), ["u1"], "U1", { lente: true });
    expect(await motor.drenar("T1")).toBe(false);
    expect(enviados).toEqual([]);
    amb.lente = false;
    expect(await motor.drenar("T1")).toBe(true);
    expect(enviados).toEqual(["u1"]);
  });

  it("com o dono logado, drena a tarefa em ordem", async () => {
    const { motor, enviados } = await montar(() => Promise.resolve(aceita), ["u1", "u2"]);
    expect(await motor.drenar("T1")).toBe(true);
    expect(enviados.slice(0, 2)).toEqual(["u1", "u2"]);
  });

  it("logout/login como outro usuário: as leituras de U1 não saem com a sessão de U2", async () => {
    const { motor, enviados } = await montar(() => Promise.resolve(aceita), ["u1"], "U1", { sessao: "U2" });
    expect(await motor.drenar("T1")).toBe(false);
    expect(enviados).toEqual([]);
  });

  it("sessão trocada NO MEIO da rodada: o 2º item não sai com a identidade nova", async () => {
    const { motor, enviados, amb, a } = await montar(() => Promise.resolve(aceita), ["u1", "u2"], "U1", { lente: true });
    amb.aoEnviar = () => {
      amb.sessao = "U2";
    };
    amb.lente = false;
    await motor.drenar("T1");
    expect(enviados).toEqual(["u1"]);
    const u2 = (await a.todos()).find((i) => i.comando.leitura_id === "u2");
    expect(u2?.estado).toBe("pendente");
  });

  it("offline: drenar devolve false sem marcar nada como resolvido", async () => {
    const { motor, a } = await montar(() => Promise.resolve({ tipo: "transitorio", erro: "Failed to fetch" }), ["u1"]);
    expect(await motor.drenar("T1")).toBe(false);
    expect((await a.todos())[0].estado).toBe("pendente");
  });

  it("armazém que não abre vira erro visível (sem fallback em memória)", async () => {
    const motor = criarMotor(
      () => Promise.resolve(aceita),
      () => Promise.reject(new Error("IndexedDB indisponível")),
      () => {},
      { sessao: () => Promise.resolve("U1"), lente: () => false },
    );
    await espera();
    expect([motor.estado().pronto, motor.estado().erroArmazem]).toEqual([false, "IndexedDB indisponível"]);
  });
});

describe("época da tarefa entre abas", () => {
  it("avança por tarefa e a chave do evento storage identifica a tarefa certa", () => {
    localStorage.clear();
    expect(lerEpoca("T1")).toBe(0);
    expect(avancarEpoca("T1")).toBe(1);
    expect(avancarEpoca("T1")).toBe(2);
    expect(lerEpoca("T2")).toBe(0);
    expect(ehChaveEpoca("picking-v2:epoca:T1", "T1")).toBe(true);
    expect(ehChaveEpoca("picking-v2:epoca:T1", "T2")).toBe(false);
  });
});
