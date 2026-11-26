// Testa o CÓDIGO REAL de edicao-omie.ts no runtime real (Deno).
// Roda com: deno test --no-remote --allow-read=supabase/functions supabase/functions/omie-vendas-sync/edicao-omie_test.ts
import {
  type CabecalhoLido,
  cabecalhoDaEdicao,
  codigoClienteDoPayload,
  freteDaEdicao,
  informacoesAdicionaisDaEdicao,
  lerCabecalhoParaEdicao,
  type VereditoEdicao,
  vereditoClienteEdicao,
  vereditoEtapaEdicao,
  vereditoGemeoEdicao,
  vereditoPedidoLocalEdicao,
} from "./edicao-omie.ts";

function igual(veio: unknown, esperado: unknown, ctx: string) {
  const v = JSON.stringify(veio);
  const e = JSON.stringify(esperado);
  if (v !== e) throw new Error(`${ctx}: esperava ${e}, veio ${v}`);
}

/** Recusa com a MARCA do ramo e um trecho do motivo — nunca só "recusou". */
function recusa(v: VereditoEdicao, bloqueio: string, trecho: string, ctx: string) {
  if (v.permitido) throw new Error(`${ctx}: deveria recusar (${bloqueio})`);
  if (v.bloqueio !== bloqueio) throw new Error(`${ctx}: marca ${bloqueio} esperada, veio ${v.bloqueio}`);
  if (!v.motivo.includes(trecho)) throw new Error(`${ctx}: motivo sem "${trecho}": ${v.motivo}`);
}

const OK = { permitido: true };

// ── pedido local ──────────────────────────────────────────────────────────

Deno.test("pedido local: conta desconhecida recusa (antes virava 'oben' por omissão)", () => {
  recusa(vereditoPedidoLocalEdicao({ account: "colacor_sc", hashPayload: null, status: "enviado" }), "conta_desconhecida", "colacor_sc", "conta");
});

Deno.test("pedido local: linha importada (omie_*) recusa na edge, não só no React", () => {
  recusa(vereditoPedidoLocalEdicao({ account: "oben", hashPayload: "omie_oben_123", status: "separacao" }), "origem_omie", "importado do Omie", "origem");
});

Deno.test("pedido local: status bloqueado ou ausente recusa", () => {
  for (const status of ["faturado", "importado", "cancelado", "entregue", null]) {
    recusa(vereditoPedidoLocalEdicao({ account: "colacor", hashPayload: null, status }), "status_pedido", "não pode ser editado", `status ${status}`);
  }
});

Deno.test("pedido local: recibo do app enviado é editável", () => {
  igual(vereditoPedidoLocalEdicao({ account: "oben", hashPayload: null, status: "enviado" }), OK, "enviado");
});

// ── gêmeo importado ───────────────────────────────────────────────────────

Deno.test("gêmeo em separacao: recibo do app é RECUSADO pelo avanço", () => {
  recusa(vereditoGemeoEdicao({ status: "separacao" }), "gemeo_omie", '"separacao"', "separacao");
});

Deno.test("gêmeo faturado ou cancelado: recusa (o caso medido: 19 recibos em prod)", () => {
  recusa(vereditoGemeoEdicao({ status: "faturado" }), "gemeo_omie", "já avançou no Omie", "faturado");
  recusa(vereditoGemeoEdicao({ status: "cancelado" }), "gemeo_omie", "já avançou no Omie", "cancelado");
});

Deno.test("gêmeo com status ausente: recusa (desconhecido não é editável)", () => {
  recusa(vereditoGemeoEdicao({ status: null }), "gemeo_omie", '"desconhecido"', "status null");
});

Deno.test("sem gêmeo: o recibo do app continua editável", () => {
  igual(vereditoGemeoEdicao(null), OK, "sem gemeo");
});

Deno.test("gêmeo importado/enviado: editável (o cliente é provado pelo codigo_cliente vivo)", () => {
  igual(vereditoGemeoEdicao({ status: "importado" }), OK, "importado");
  igual(vereditoGemeoEdicao({ status: "enviado" }), OK, "enviado");
});

// ── cliente vivo × âncora do recibo ───────────────────────────────────────

Deno.test("âncora: codigo_cliente que o app mandou ao criar o PV", () => {
  igual(codigoClienteDoPayload({ cabecalho: { codigo_cliente: 8812345 } }), 8812345, "numero");
  igual(codigoClienteDoPayload({ cabecalho: { codigo_cliente: "8812345" } }), 8812345, "texto");
  igual(codigoClienteDoPayload({ cabecalho: {} }), null, "sem campo");
  igual(codigoClienteDoPayload({ det: [] }), null, "payload de edição antiga, sem cabeçalho");
  igual(codigoClienteDoPayload(null), null, "null");
  igual(codigoClienteDoPayload({ cabecalho: { codigo_cliente: 0 } }), null, "zero não é cliente");
});

Deno.test("PV reaproveitado: cliente vivo ≠ âncora recusa", () => {
  recusa(vereditoClienteEdicao({ codigoClienteAncora: 100, codigoClienteVivo: 200, ancoraIndependente: true }), "cliente_omie", "PV reaproveitado", "reaproveitado");
});

Deno.test("sem âncora ou sem cliente vivo: recusa (não dá para provar de quem é o PV)", () => {
  recusa(vereditoClienteEdicao({ codigoClienteAncora: null, codigoClienteVivo: 200, ancoraIndependente: true }), "cliente_omie", "não há registro do cliente", "sem ancora");
  recusa(vereditoClienteEdicao({ codigoClienteAncora: 100, codigoClienteVivo: null, ancoraIndependente: true }), "cliente_omie", "veio sem o cliente", "sem vivo");
});

Deno.test("mesmo cliente: editável", () => {
  igual(vereditoClienteEdicao({ codigoClienteAncora: 100, codigoClienteVivo: 100, ancoraIndependente: true }), OK, "mesmo");
});

Deno.test("PV vinculado por duplicidade (reconciled): âncora não é independente — recusa mesmo com cliente igual", () => {
  recusa(
    vereditoClienteEdicao({ codigoClienteAncora: 100, codigoClienteVivo: 100, ancoraIndependente: false }),
    "cliente_omie", "vinculado a um PV que já existia", "reconciliado",
  );
});

// ── leitura do cabeçalho / etapa viva ─────────────────────────────────────

const FRETE_OMIE = { modalidade: "1", codigo_transportadora: 987, quantidade_volumes: 3, especie_volumes: "CX", valor_frete: 45.5, previsao_entrega: "05/12/2026" };
const LIDO_OK: CabecalhoLido = {
  etapa: "10", dataPrevisao: "01/12/2026", cancelado: "N", faturado: "N", frete: {},
  categoria: "1.01.01", contaCorrente: 8693825504, codVend: null,
};

Deno.test("lê etapa/previsão/frete/marcas/classificação aninhados e no topo (drift de shape)", () => {
  const aninhado = lerCabecalhoParaEdicao({
    pedido_venda_produto: {
      cabecalho: { etapa: "20", data_previsao: "28/11/2026" },
      frete: FRETE_OMIE,
      infoCadastro: { cancelado: "N", faturado: "N" },
      informacoes_adicionais: { codigo_categoria: "1.01.03", codigo_conta_corrente: 123, codVend: 456 },
    },
  });
  igual(aninhado, {
    etapa: "20", dataPrevisao: "28/11/2026", cancelado: "N", faturado: "N", frete: FRETE_OMIE,
    categoria: "1.01.03", contaCorrente: 123, codVend: 456,
  }, "aninhado");
  const topo = lerCabecalhoParaEdicao({ cabecalho: { etapa: 10, data_previsao: "01/12/2026" }, frete: FRETE_OMIE });
  igual(topo, {
    etapa: "10", dataPrevisao: "01/12/2026", cancelado: null, faturado: null, frete: FRETE_OMIE,
    categoria: null, contaCorrente: null, codVend: null,
  }, "topo");
});

Deno.test("etapa 50 viva: recusa com a marca etapa_omie", () => {
  recusa(vereditoEtapaEdicao({ ...LIDO_OK, etapa: "50" }), "etapa_omie", "etapa 50", "etapa 50");
});

Deno.test("cancelado ou faturado no Omie em etapa 10: recusa com a marca etapa_omie", () => {
  recusa(vereditoEtapaEdicao({ ...LIDO_OK, cancelado: "S" }), "etapa_omie", "cancelado", "cancelado");
  recusa(vereditoEtapaEdicao({ ...LIDO_OK, faturado: "S" }), "etapa_omie", "faturado", "faturado");
});

Deno.test("cancelamento ilegível (sem 'N' explícito) em etapa 20: recusa como leitura incompleta", () => {
  recusa(vereditoEtapaEdicao({ ...LIDO_OK, etapa: "20", cancelado: null }), "leitura_omie_incompleta", "situação de cancelamento", "cancelado null");
});

Deno.test("leitura sem etapa, previsão ou frete: recusa com a marca leitura_omie_incompleta", () => {
  recusa(vereditoEtapaEdicao({ ...LIDO_OK, etapa: null }), "leitura_omie_incompleta", "etapa", "sem etapa");
  recusa(vereditoEtapaEdicao({ ...LIDO_OK, dataPrevisao: null }), "leitura_omie_incompleta", "data de previsão", "sem previsao");
  recusa(vereditoEtapaEdicao({ ...LIDO_OK, frete: null }), "leitura_omie_incompleta", "frete", "sem frete");
});

Deno.test("etapas 10 e 20 com leitura completa: editável", () => {
  igual(vereditoEtapaEdicao({ ...LIDO_OK, etapa: "10" }), OK, "etapa 10");
  igual(vereditoEtapaEdicao({ ...LIDO_OK, etapa: "20" }), OK, "etapa 20");
});

// ── o que vai no AlterarPedidoVenda ───────────────────────────────────────

Deno.test("salvar só observação: cabeçalho reenvia etapa e previsão LIDAS, nunca 10/hoje", () => {
  const lido = lerCabecalhoParaEdicao({ cabecalho: { etapa: "20", data_previsao: "28/11/2026" }, frete: FRETE_OMIE });
  igual(
    cabecalhoDaEdicao({ codigoPedido: 555, lido, codigoParcela: "028" }),
    { codigo_pedido: 555, data_previsao: "28/11/2026", etapa: "20", codigo_parcela: "028" },
    "cabecalho",
  );
});

Deno.test("salvar só observação: frete sai IDÊNTICO ao lido (transportadora, volumes, valor, previsão)", () => {
  const lido = lerCabecalhoParaEdicao({ cabecalho: { etapa: "10", data_previsao: "28/11/2026" }, frete: FRETE_OMIE });
  igual(freteDaEdicao({ lido }), FRETE_OMIE, "frete intacto");
  igual(freteDaEdicao({ lido, quantidadeVolumes: 0 }), FRETE_OMIE, "volumes 0 não sobrescreve");
});

Deno.test("volumes mandados pelo caller sobrescrevem só quantidade_volumes", () => {
  const lido = lerCabecalhoParaEdicao({ cabecalho: { etapa: "10", data_previsao: "28/11/2026" }, frete: FRETE_OMIE });
  igual(freteDaEdicao({ lido, quantidadeVolumes: 7 }), { ...FRETE_OMIE, quantidade_volumes: 7 }, "volumes 7");
});

Deno.test("classificação: vai a LIDA; vendedor ausente vai ausente (não restaura o da criação)", () => {
  igual(
    informacoesAdicionaisDaEdicao({ ...LIDO_OK, categoria: "1.01.03", contaCorrente: 77, codVend: 9 }),
    { codigo_categoria: "1.01.03", codigo_conta_corrente: 77, codVend: 9 },
    "lida",
  );
  igual(
    informacoesAdicionaisDaEdicao({ ...LIDO_OK, codVend: null }),
    { codigo_categoria: "1.01.01", codigo_conta_corrente: 8693825504 },
    "sem codVend",
  );
});

Deno.test("leitura sem categoria ou conta corrente: recusa antes de mutar (não cai no default da conta)", () => {
  recusa(vereditoEtapaEdicao({ ...LIDO_OK, categoria: null }), "leitura_omie_incompleta", "categoria", "sem categoria");
  recusa(vereditoEtapaEdicao({ ...LIDO_OK, contaCorrente: null }), "leitura_omie_incompleta", "conta corrente", "sem cc");
  let msg = "";
  try { informacoesAdicionaisDaEdicao({ ...LIDO_OK, categoria: null }); } catch (e) { msg = (e as Error).message; }
  if (!msg.includes("informacoesAdicionaisDaEdicao: leitura sem categoria")) throw new Error(`não lançou o ramo certo: ${msg}`);
});

Deno.test("cabecalho/frete sem leitura aprovada: lança com a marca do ramo", () => {
  const vazio: CabecalhoLido = { ...LIDO_OK, etapa: null, dataPrevisao: null, frete: null };
  let msg = "";
  try { cabecalhoDaEdicao({ codigoPedido: 1, lido: vazio, codigoParcela: "000" }); } catch (e) { msg = (e as Error).message; }
  if (!msg.includes("cabecalhoDaEdicao: leitura sem etapa")) throw new Error(`cabecalho não lançou o ramo certo: ${msg}`);
  msg = "";
  try { freteDaEdicao({ lido: vazio }); } catch (e) { msg = (e as Error).message; }
  if (!msg.includes("freteDaEdicao: leitura sem frete")) throw new Error(`frete não lançou o ramo certo: ${msg}`);
});
