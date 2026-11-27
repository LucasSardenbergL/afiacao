// Sem rede (`--no-remote` do test:edges): assert inline.
function assertEquals(a: unknown, b: unknown, msg?: string) {
  const ja = JSON.stringify(a), jb = JSON.stringify(b);
  if (ja !== jb) throw new Error(msg ?? `esperado ${jb}, veio ${ja}`);
}
import {
  aplicarVisibilidade,
  CAMPOS_PII_OMIE,
  codigosVisiveis,
  documentoDoPedidoCasa,
  lerAcessoOperacional,
} from "./pii-carteira.ts";

const CLIENTE = {
  codigo_cliente: 42,
  razao_social: "MARCENARIA X LTDA",
  nome_fantasia: "X",
  cnpj_cpf: "12.345.678/0001-90",
  email: "x@x.com",
  telefone: "(47) 99999-0000",
  endereco: "Rua A",
  endereco_numero: "10",
  complemento: "fundos",
  bairro: "Centro",
  cidade: "JOINVILLE",
  estado: "SC",
  cep: "89200-000",
  inscricao_estadual: "123",
  codigo_vendedor: 7,
};

Deno.test("fora da carteira: toda PII vira null, identidade fica", () => {
  const m = aplicarVisibilidade(CLIENTE, false);
  for (const c of CAMPOS_PII_OMIE) assertEquals(m[c], null, c);
  assertEquals(m.razao_social, "MARCENARIA X LTDA");
  assertEquals(m.cidade, "JOINVILLE");
  assertEquals(m.estado, "SC");
  assertEquals(m.codigo_vendedor, 7);
  assertEquals(m.contato_visivel, false);
  assertEquals(CLIENTE.email, "x@x.com"); // não muta a entrada
});

Deno.test("na carteira: cliente inteiro + contato_visivel", () => {
  const m = aplicarVisibilidade(CLIENTE, true);
  assertEquals(m.cnpj_cpf, CLIENTE.cnpj_cpf);
  assertEquals(m.contato_visivel, true);
});

Deno.test("campo ausente não é criado pelo mascaramento (pesquisar_clientes não tem endereço)", () => {
  const m = aplicarVisibilidade({ codigo_cliente: 1, email: "a@a" }, false);
  assertEquals("endereco" in m, false);
  assertEquals(m.email, null);
});

Deno.test("código visível se ALGUM user vinculado está visível; nulos e órfãos ficam fora", () => {
  const v = codigosVisiveis(
    [
      { omie_codigo_cliente: 1, user_id: "a" },
      { omie_codigo_cliente: 1, user_id: "b" },
      { omie_codigo_cliente: 2, user_id: "c" },
      { omie_codigo_cliente: null, user_id: "a" },
      { omie_codigo_cliente: 3, user_id: null },
    ],
    new Set(["b"]),
  );
  assertEquals([...v], [1]);
});

Deno.test("acesso operacional: só pedido/impressao_pedido com uuid", () => {
  const id = "0b9c1f3e-1d2a-4c5b-8e6f-7a8b9c0d1e2f";
  assertEquals(lerAcessoOperacional({ objeto_tipo: "pedido", objeto_id: id, motivo: "impressao_pedido" })?.objeto_id, id);
  assertEquals(lerAcessoOperacional({ objeto_tipo: "pedido", objeto_id: id, motivo: "detalhe_pedido" }), null);
  assertEquals(lerAcessoOperacional({ objeto_tipo: "rota", objeto_id: id, motivo: "impressao_pedido" }), null);
  assertEquals(lerAcessoOperacional({ objeto_tipo: "pedido", objeto_id: "1 or 1=1", motivo: "impressao_pedido" }), null);
  assertEquals(lerAcessoOperacional(null), null);
  assertEquals(lerAcessoOperacional("pedido"), null);
});

Deno.test("documento do pedido casa com o cnpj_cpf da Omie (normalizado); ausente não casa", () => {
  assertEquals(documentoDoPedidoCasa([{ document: "12345678000190" }], "12.345.678/0001-90"), true);
  assertEquals(documentoDoPedidoCasa([{ document: null, cnpj: "12.345.678/0001-90" }], "12345678000190"), true);
  assertEquals(documentoDoPedidoCasa([{ document: "11111111000111" }], "12345678000190"), false);
  assertEquals(documentoDoPedidoCasa([{ document: null, cnpj: null }], "12345678000190"), false);
  assertEquals(documentoDoPedidoCasa([], "12345678000190"), false);
  assertEquals(documentoDoPedidoCasa([{ document: "12345678000190" }], null), false);
  assertEquals(documentoDoPedidoCasa([{ document: "" }], ""), false);
  assertEquals(documentoDoPedidoCasa([{ document: "123" }], "123"), false);
});
