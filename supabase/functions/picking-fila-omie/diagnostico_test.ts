// Roda com: deno test --no-remote supabase/functions/picking-fila-omie/diagnostico_test.ts
import { resumirEtapas, resumirPedidos, resumirProdutos } from "./diagnostico.ts";

function assertEquals(a: unknown, b: unknown, msg?: string) {
  if (JSON.stringify(a) !== JSON.stringify(b)) {
    throw new Error(msg ?? `assertEquals falhou: ${JSON.stringify(a)} !== ${JSON.stringify(b)}`);
  }
}

Deno.test("resumirEtapas: achata operação × etapa e lê cInativo S/N/ausente", () => {
  const r = resumirEtapas({
    cadastros: [{
      cCodOperacao: "11",
      cDescOperacao: "Venda de Produto",
      etapas: [
        { cCodigo: "10", cDescricao: "Separar", cInativo: "N" },
        { cCodigo: "20", cDescrPadrao: "Faturar", cInativo: "S" },
        { cCodigo: "30" },
      ],
    }],
  });
  assertEquals(r.map((e) => [e.codigo, e.descricao, e.inativa]), [
    ["10", "Separar", false],
    ["20", "Faturar", true],
    ["30", null, null],
  ]);
});

Deno.test("resumirEtapas: resposta fora do formato vira lista vazia, não lança", () => {
  assertEquals(resumirEtapas(null), []);
  assertEquals(resumirEtapas({ cadastros: "x" }), []);
});

Deno.test("resumirPedidos: conta codigo_item ausente/duplicado, fracionário, unidade e dAlt", () => {
  const r = resumirPedidos({
    total_de_registros: 7,
    total_de_paginas: 1,
    pedido_venda_produto: [
      {
        cabecalho: { codigo_pedido: 1, numero_pedido: "100", etapa: "10" },
        infoCadastro: { dAlt: "10/10/2026", hAlt: "09:00:00" },
        det: [
          { ide: { codigo_item: 11 }, produto: { quantidade: 2, unidade: "un", codigo_produto: 5 } },
          { ide: { codigo_item: 11 }, produto: { quantidade: 1.5, unidade: "L" } },
        ],
      },
      {
        cabecalho: { codigo_pedido: 2, etapa: "10" },
        det: [{ produto: { quantidade: 0 } }],
      },
    ],
  });
  assertEquals(r.total_de_registros, 7);
  assertEquals(r.na_pagina, 2);
  assertEquals(r.com_dalt, 1);
  assertEquals(r.linhas, 3);
  assertEquals(r.linhas_sem_codigo_item, 1);
  assertEquals(r.pedidos_com_codigo_item_duplicado, 1);
  assertEquals(r.linhas_sem_quantidade_valida, 1);
  assertEquals(r.linhas_fracionarias, 1);
  assertEquals(r.unidades, { UN: 1, L: 1, "(ausente)": 1 });
  assertEquals(r.chaves_produto_amostra, ["codigo_produto", "quantidade", "unidade"]);
  assertEquals(r.amostra[0], { codigo_pedido: "1", numero_pedido: "100", etapa: "10", dAlt: "10/10/2026", hAlt: "09:00:00", linhas: 2 });
});

Deno.test("resumirPedidos: total ausente fica null (ausente ≠ zero)", () => {
  const r = resumirPedidos({ pedido_venda_produto: [] });
  assertEquals(r.total_de_registros, null);
  assertEquals(r.na_pagina, 0);
});

Deno.test("resumirProdutos: EAN vazio não conta; agrupa por tamanho", () => {
  const r = resumirProdutos({
    total_de_registros: 900,
    produto_servico_cadastro: [{ ean: "7891234567895" }, { ean: "" }, { ean: "  " }, {}, { ean: "12345678" }],
  });
  assertEquals(r, { total_de_registros: 900, na_pagina: 5, com_ean: 2, ean_tamanhos: { "13": 1, "8": 1 } });
});
