import { describe, expect, it } from "vitest";
import { feedbackDoMotivo, PADROES } from "../feedback";

describe("feedback do bipe", () => {
  it("cada motivo de rejeição de BIPE do servidor tem feedback de erro (nunca o de acerto)", () => {
    const motivos = [
      "codigo_fora_do_pedido",
      "unidade_incompativel",
      "excesso",
      "codigo_desconhecido",
      "codigo_pendente_aprovacao",
      "codigo_ambiguo",
      "linha_fracionaria_exige_manual",
      "tarefa_fora_de_separacao",
      "atribuicao_antiga",
      "revisao_antiga",
      "algo_novo_que_ninguem_mapeou",
    ];
    for (const m of motivos) expect(PADROES[feedbackDoMotivo(m)].cor, m).not.toBe("verde");
  });

  it("acerto é curto (≤100 ms de som) e verde; erros de pedido são vermelhos ou âmbar", () => {
    const dur = PADROES.correta.notas.reduce((s, [, ms]) => s + ms, 0);
    expect([dur <= 100, PADROES.correta.cor]).toEqual([true, "verde"]);
    expect(PADROES.fora_do_pedido.cor).toBe("vermelho");
    expect(PADROES.excesso.cor).toBe("ambar");
  });

  it("padrões distinguíveis: nenhum par de feedbacks com o mesmo som", () => {
    const sons = Object.values(PADROES).map((p) => JSON.stringify(p.notas));
    expect(new Set(sons).size).toBe(sons.length);
  });
});
