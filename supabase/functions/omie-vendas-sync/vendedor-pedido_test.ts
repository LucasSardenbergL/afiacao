// Roda o CÓDIGO REAL de vendedor-pedido.ts (quem vendeu cada pedido importado do Omie).
import {
  contadoresVendedorZerados,
  extrairVendedorDoPedido,
  MARCA_VENDEDOR_FALHOU,
  montarLoteVendedor,
  registrarVendedoresDaPagina,
} from "./vendedor-pedido.ts";

// Asserções locais em vez de std/assert remoto: `test:edges` roda com `--no-remote`.
function assertEquals(a: unknown, b: unknown) {
  if (JSON.stringify(a) !== JSON.stringify(b)) {
    throw new Error(`assertEquals falhou: ${JSON.stringify(a)} !== ${JSON.stringify(b)}`);
  }
}

const ped = (codigo: unknown, info?: unknown) =>
  info === undefined
    ? { cabecalho: { codigo_pedido: codigo } }
    : { cabecalho: { codigo_pedido: codigo }, informacoes_adicionais: info as { codVend?: unknown } };

Deno.test("extrai codVend numérico do próprio pedido", () => {
  assertEquals(extrairVendedorDoPedido(ped(123, { codVend: 8689670842 })), { codigo_pedido: 123, cod_vend: 8689670842 });
});

Deno.test("codVend string de dígitos é aceito; lixo vira null (lido, sem vendedor)", () => {
  assertEquals(extrairVendedorDoPedido(ped(123, { codVend: "842" })), { codigo_pedido: 123, cod_vend: 842 });
  assertEquals(extrairVendedorDoPedido(ped(123, { codVend: 0 })), { codigo_pedido: 123, cod_vend: null });
  assertEquals(extrairVendedorDoPedido(ped(123, { codVend: -1 })), { codigo_pedido: 123, cod_vend: null });
  assertEquals(extrairVendedorDoPedido(ped(123, { codVend: 1.5 })), { codigo_pedido: 123, cod_vend: null });
  assertEquals(extrairVendedorDoPedido(ped(123, { codVend: "abc" })), { codigo_pedido: 123, cod_vend: null });
  assertEquals(extrairVendedorDoPedido(ped(123, {})), { codigo_pedido: 123, cod_vend: null });
});

Deno.test("bloco informacoes_adicionais ausente = NÃO lido (fora do lote), não 'sem vendedor'", () => {
  assertEquals(extrairVendedorDoPedido(ped(123)), null);
  assertEquals(extrairVendedorDoPedido(ped(123, null)), null);
});

Deno.test("sem codigo_pedido válido → fora do lote", () => {
  assertEquals(extrairVendedorDoPedido(ped(undefined, { codVend: 1 })), null);
  assertEquals(extrairVendedorDoPedido(ped(0, { codVend: 1 })), null);
  assertEquals(extrairVendedorDoPedido(ped(Number.MAX_SAFE_INTEGER + 2, { codVend: 1 })), null);
});

Deno.test("lote: duplicado concordante entra 1 vez; discordante SAI (ambíguo), nunca sorteia", () => {
  const r = montarLoteVendedor([
    ped(1, { codVend: 10 }), ped(1, { codVend: 10 }),
    ped(2, { codVend: 10 }), ped(2, { codVend: 20 }),
    ped(3), ped(4, { codVend: 30 }),
  ]);
  assertEquals(r, { lote: [{ codigo_pedido: 1, cod_vend: 10 }, { codigo_pedido: 4, cod_vend: 30 }], naoLidos: 1, ambiguos: 1 });
});

Deno.test("registrar: acumula contadores e códigos sem mapa sem repetir", async () => {
  const acc = contadoresVendedorZerados();
  const chamadas: unknown[] = [];
  const rpc = (fn: string, args: Record<string, unknown>) => {
    chamadas.push({ fn, args });
    return Promise.resolve({
      data: { recebidos: 2, casados: 2, atualizados: 1, fora_do_banco: 0, codigos_sem_mapa: [777] },
      error: null,
    });
  };
  await registrarVendedoresDaPagina(rpc, "oben", [ped(1, { codVend: 777 }), ped(2, { codVend: 842 })], acc);
  await registrarVendedoresDaPagina(rpc, "oben", [ped(3, { codVend: 777 }), ped(4)], acc);
  assertEquals(chamadas[0], {
    fn: "sales_orders_registrar_vendedor_omie",
    args: { p_account: "oben", p_pedidos: [{ codigo_pedido: 1, cod_vend: 777 }, { codigo_pedido: 2, cod_vend: 842 }] },
  });
  assertEquals(acc, {
    vendedor_lidos: 4, vendedor_atualizados: 2, vendedor_nao_lidos: 1, vendedor_ambiguos: 0,
    vendedor_falhas: 0, vendedor_codigos_sem_mapa: [777],
  });
});

Deno.test("registrar: falha do escritor é CONTADA e logada com a marca — não lança", async () => {
  const acc = contadoresVendedorZerados();
  const logs: string[] = [];
  const rpc = () => Promise.resolve({ data: null, error: { message: "function does not exist" } });
  await registrarVendedoresDaPagina(rpc, "colacor", [ped(1, { codVend: 5 }), ped(2, { codVend: 6 })], acc, (m) => logs.push(m));
  assertEquals(acc.vendedor_falhas, 2);
  assertEquals(acc.vendedor_lidos, 0);
  assertEquals(logs.length === 1 && logs[0].includes(MARCA_VENDEDOR_FALHOU) && logs[0].includes("[colacor]"), true);
});

Deno.test("registrar: página sem pedido lido não chama o banco", async () => {
  const acc = contadoresVendedorZerados();
  let chamou = false;
  const rpc = () => { chamou = true; return Promise.resolve({ data: {}, error: null }); };
  await registrarVendedoresDaPagina(rpc, "oben", [ped(1), ped(undefined, { codVend: 3 })], acc);
  assertEquals(chamou, false);
  assertEquals(acc.vendedor_nao_lidos, 2);
});
