import { describe, it, expect, vi, beforeEach } from "vitest";

// Gravar um item de promoção só "deu certo" se UMA linha mudou. O PostgREST responde 204 sem erro a
// um PATCH que não casa nada (item excluído depois que a tela carregou, ou escondido pela RLS) — e
// o vínculo manual seguia, inserindo irmãos e anunciando "vinculado" sobre um original que não existe.

const { resposta, chamadas } = vi.hoisted(() => ({
  resposta: { data: [] as unknown[] | null, error: null as null | { message: string } },
  chamadas: [] as Array<{ tabela: string; changes: unknown; id: unknown; colunas: unknown }>,
}));

vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    from: (tabela: string) => ({
      update: (changes: unknown) => ({
        eq: (_coluna: string, id: unknown) => ({
          select: (colunas: unknown) => {
            chamadas.push({ tabela, changes, id, colunas });
            return Promise.resolve({ data: resposta.data, error: resposta.error });
          },
        }),
      }),
    }),
  },
}));

import { atualizarItemPromocao } from "../atualizarItemPromocao";

beforeEach(() => {
  chamadas.length = 0;
  resposta.data = [];
  resposta.error = null;
});

describe("atualizarItemPromocao", () => {
  it("grava o patch no item e resolve quando exatamente 1 linha mudou", async () => {
    resposta.data = [{ id: 151 }];
    await expect(atualizarItemPromocao(151, { confirmado: true })).resolves.toBeUndefined();
    expect(chamadas).toStrictEqual([{ tabela: "promocao_item", changes: { confirmado: true }, id: 151, colunas: "id" }]);
  });

  it("PATCH que não casou linha nenhuma (204 sem erro) REJEITA — nunca vira sucesso", async () => {
    resposta.data = [];
    await expect(atualizarItemPromocao(151, { confirmado: true })).rejects.toThrow(/nenhuma linha/);
  });

  it("erro do supabase rejeita com o próprio erro", async () => {
    resposta.error = { message: "new row violates row-level security policy" };
    await expect(atualizarItemPromocao(151, { confirmado: true })).rejects.toMatchObject({
      message: "new row violates row-level security policy",
    });
  });
});
