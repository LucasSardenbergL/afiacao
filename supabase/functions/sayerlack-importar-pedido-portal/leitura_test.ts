// `assertEquals` local em vez de std/assert remoto: `test:edges` roda com `--no-remote`.
function assertEquals(atual: unknown, esperado: unknown) {
  const a = JSON.stringify(atual);
  const e = JSON.stringify(esperado);
  if (a !== e) throw new Error(`esperado ${e}, veio ${a}`);
}
import { dataBRparaISO, explicarCondicaoAusente, lerCabecalho, mensagemCondicaoAusente, lerItens, lerPedidoPortal, mensagemErroImportacao, ncmsDoCp006, numeroBR, situacaoCancelada, situacaoFaturada, situacaoObservada, situacaoPermitida } from "./leitura.ts";

// Resposta REAL do portal (pedido 2140603, 2026-10-14) — consulta e busca-itens-pedido.
const LINHA_REAL = {
  "Estab": "CAJ",
  "Pedido": "2140603",
  "Pedido Clien": "2140603",
  "Cliente": "OBEN COMERCIO LTDA",
  "Situação": "5 - Suspenso",
  "Data Emissão": "14/10/2026",
  "Data Entrega": "26/10/2026",
  "Vlr Mercadori": "4865,5600",
  "Vlr Total": "5181,8200",
};
const ITENS_REAL = {
  success: true,
  itens: [[10, "DFA.4080LT", "", "L", 18, 288, 16, 19.8637, 357.5466, 357.5466, 5, "14,9488", 4865.5584, "DILUENTE PU 4080A LT", "PROREAL", 30, "0.0000", "1.0000", "", 5]],
  data_pedido: { transportadora: "SPMINAS", cliente_remessa_triang: "", taxa_financiamento: 1, tabelaPreco: "PROREAL" },
};

Deno.test("pedido real 2140603: lê cabeçalho e item, total cobrado = Vlr Total", () => {
  const r = lerPedidoPortal([LINHA_REAL], ITENS_REAL, "2140603");
  if (!r.ok) throw new Error(`esperava ok, veio ${r.motivo}: ${r.detalhe}`);
  assertEquals(r.cabecalho, {
    protocolo: "2140603", cliente: "OBEN COMERCIO LTDA", situacao: "5 - Suspenso",
    data_entrega: "2026-10-26", valor_mercadoria: 4865.56, valor_total: 5181.82,
  });
  assertEquals(r.itens, [{ seq: 10, sku_portal: "DFA.4080LT", descricao: "DILUENTE PU 4080A LT", qtde_portal: 16, valor_mercadoria: 4865.5584 }]);
});

Deno.test("coluna Pedido é casada EXATA: 'Pedido Clien' com o nº não vale como o pedido", () => {
  const r = lerCabecalho([{ ...LINHA_REAL, "Pedido": "2140999", "Pedido Clien": "2140603" }], "2140603");
  assertEquals(r.ok ? "ok" : r.motivo, "nao_encontrado");
});

Deno.test("duas linhas com o mesmo nº (proposta + pedido) = ambíguo", () => {
  const r = lerCabecalho([LINHA_REAL, LINHA_REAL], "2140603");
  assertEquals(r.ok ? "ok" : r.motivo, "consulta_ambigua");
});

Deno.test("cliente que não é a OBEN é recusado", () => {
  const r = lerCabecalho([{ ...LINHA_REAL, "Cliente": "COLACOR COMERCIAL LTDA" }], "2140603");
  assertEquals(r.ok ? "ok" : r.motivo, "consulta_incompleta");
});

Deno.test("situação ausente é recusada (não dá para saber o que é a linha)", () => {
  const r = lerCabecalho([{ ...LINHA_REAL, "Situação": "" }], "2140603");
  assertEquals(r.ok ? "ok" : r.motivo, "consulta_incompleta");
});

Deno.test("Vlr Total ilegível: ausente ≠ zero, recusa", () => {
  const r = lerCabecalho([{ ...LINHA_REAL, "Vlr Total": "" }], "2140603");
  assertEquals(r.ok ? "ok" : r.motivo, "consulta_incompleta");
});

Deno.test("itens: success falso ou lista vazia = itens_ausentes", () => {
  assertEquals((r => r.ok ? "ok" : r.motivo)(lerItens({ success: false, itens: ITENS_REAL.itens })), "itens_ausentes");
  assertEquals((r => r.ok ? "ok" : r.motivo)(lerItens({ success: true, itens: [] })), "itens_ausentes");
  assertEquals((r => r.ok ? "ok" : r.motivo)(lerItens(null)), "itens_ausentes");
});

Deno.test("portal reordenou colunas (qtd UN no lugar da qtd fat) = item_incoerente, não importa número errado", () => {
  const trocado = [...ITENS_REAL.itens[0]];
  [trocado[5], trocado[6]] = [trocado[6], trocado[5]];
  assertEquals((r => r.ok ? "ok" : r.motivo)(lerItens({ success: true, itens: [trocado] })), "item_incoerente");
});

Deno.test("Preço Venda que não fecha com Preço UN × qtd × (1 − desc) = item_incoerente", () => {
  const alterado = [...ITENS_REAL.itens[0]];
  alterado[12] = 4900;
  assertEquals((r => r.ok ? "ok" : r.motivo)(lerItens({ success: true, itens: [alterado] })), "item_incoerente");
});

Deno.test("quantidade fracionária de embalagem = item_malformado", () => {
  const frac = [...ITENS_REAL.itens[0]];
  frac[6] = 16.5; frac[5] = 18 * 16.5;
  assertEquals((r => r.ok ? "ok" : r.motivo)(lerItens({ success: true, itens: [frac] })), "item_malformado");
});

Deno.test("item que falta na leitura: Σ linhas ≠ Vlr Mercadoria da consulta", () => {
  const r = lerPedidoPortal([{ ...LINHA_REAL, "Vlr Mercadori": "9731,1200" }], ITENS_REAL, "2140603");
  assertEquals(r.ok ? "ok" : r.motivo, "mercadoria_diverge_da_consulta");
});

Deno.test("numeroBR e dataBRparaISO", () => {
  assertEquals(numeroBR("4.865,5600"), 4865.56);
  assertEquals(numeroBR("4865.5584"), 4865.5584);
  assertEquals(numeroBR(""), null);
  assertEquals(numeroBR("R$ 10"), null);
  assertEquals(dataBRparaISO("26/10/2026"), "2026-10-26");
  assertEquals(dataBRparaISO("31/02/2026"), null);
  assertEquals(dataBRparaISO("2026-10-26"), null);
});

Deno.test("mensagem de erro por SQLSTATE; desconhecida não inventa motivo", () => {
  assertEquals(mensagemErroImportacao("IP002", null).startsWith("Há item sem de-para"), true);
  assertEquals(mensagemErroImportacao("XX999", "boom"), "Falha ao gravar a importação. Detalhe: boom");
});

Deno.test("pedido cancelado no portal (6 - Cancelado) é recusado na leitura, com motivo próprio", () => {
  const r = lerPedidoPortal([{ ...LINHA_REAL, "Situação": "6 - Cancelado" }], ITENS_REAL, "2140603");
  assertEquals(r.ok ? "ok" : r.motivo, "pedido_cancelado");
  if (!r.ok && !r.detalhe.includes("cancelado no portal")) throw new Error(`detalhe sem o motivo: ${r.detalhe}`);
});

Deno.test("situacaoCancelada: código 6 ou o texto; as outras situações passam", () => {
  assertEquals(
    ["6 - Cancelado", "6 -", "Cancelado", "CANCELADA", "5 - Suspenso", "1 - Aberto", "16 - Outro", "4 - Faturado"].map(situacaoCancelada),
    [true, true, true, true, false, false, false, false],
  );
});

Deno.test("situacaoPermitida: só código da lista; sem código ou lista vazia = não", () => {
  assertEquals(
    [situacaoPermitida("1 - Aberto", ["1"]), situacaoPermitida("4 - Faturado", ["1"]), situacaoPermitida("Aberto", ["1"]),
     situacaoPermitida("1 - Aberto", []), situacaoPermitida("11 - Outro", ["1"])],
    [true, false, false, false, false],
  );
});

Deno.test("CP006 diz o NCM e o passo, sem 'peça ao administrador' (Fable C4)", () => {
  const rpc = "custo_portal: item sem alíquota de IPI conhecida no pedido 3751 (NCM: 32091020, 32110000) — nada gravado";
  assertEquals(ncmsDoCp006(rpc), ["32091020", "32110000"]);
  const m = mensagemErroImportacao("CP006", rpc);
  assertEquals(m.startsWith("O NCM 32091020, 32110000 não tem alíquota de IPI cadastrada no app"), true);
  assertEquals(m.includes("docs/runbooks/sayerlack-pedido-portal-nao-entrou.md"), true);
  assertEquals(m.includes("administrador"), false);
  // Sem NCM legível na mensagem: não inventa um.
  assertEquals(ncmsDoCp006("sem detalhe"), []);
  assertEquals(mensagemErroImportacao("CP006", null).startsWith("Um item tem NCM sem alíquota"), true);
});

// ── Onda 5A: situação observada → escritor único ──
Deno.test("situacaoObservada: linha única da OBEN com código 1..7, inclusive cancelado", () => {
  const l = (situacao: string, cliente = "OBEN COMERCIO", pedido = "2141001") => ({ "Pedido": pedido, "Cliente": cliente, "Situação": situacao });
  assertEquals(situacaoObservada([l("6 - Cancelado")], "2141001"), { protocolo: "2141001", codigo: "6", texto: "6 - Cancelado" });
  assertEquals(situacaoObservada([l("1 - Aberto")], "2141001")?.codigo, "1");
  // ilegível, código fora da lista fechada, outro cliente, ausente, ambíguo ⇒ nada a gravar
  assertEquals(situacaoObservada([l("Cancelado")], "2141001"), null);
  assertEquals(situacaoObservada([l("8 - Novo")], "2141001"), null);
  assertEquals(situacaoObservada([l("6 - Cancelado", "OUTRA LTDA")], "2141001"), null);
  assertEquals(situacaoObservada([l("6 - Cancelado", "OBEN", "2141002")], "2141001"), null);
  assertEquals(situacaoObservada([l("6 - Cancelado"), l("1 - Aberto")], "2141001"), null);
  // "Pedido Clien[te]" não é a coluna Pedido
  assertEquals(situacaoObservada([{ "Pedido Cliente": "2141001", "Cliente": "OBEN", "Situação": "6 - Cancelado" }], "2141001"), null);
});

// ── Revisão 2 (2026-11-08) ──
Deno.test("B1: situação sem código reconhecido (1..7) é recusada — o botão também não importa/re-dispara '???'", () => {
  for (const sit of ["???", "Suspenso", "8 - Novo", "0 - Rascunho", "- Aberto"]) {
    const r = lerPedidoPortal([{ ...LINHA_REAL, "Situação": sit }], ITENS_REAL, "2140603");
    assertEquals(`${sit}:${r.ok ? "ok" : r.motivo}`, `${sit}:situacao_ilegivel`);
  }
  // Reconhecida segue lendo (todas as 7 do select real, menos o 6 que tem motivo próprio).
  for (const sit of ["1 - Aberto", "2 - Atendido Parcial", "3 - Atendido Total", "4 - Pendentes", "5 - Suspenso", "7 - Fatur Balcão"]) {
    const r = lerPedidoPortal([{ ...LINHA_REAL, "Situação": sit }], ITENS_REAL, "2140603");
    assertEquals(`${sit}:${r.ok ? "ok" : r.motivo}`, `${sit}:ok`);
  }
  // Cancelado sem código (só o texto) continua cancelado, não "ilegível".
  const c = lerPedidoPortal([{ ...LINHA_REAL, "Situação": "Cancelado" }], ITENS_REAL, "2140603");
  assertEquals(c.ok ? "ok" : c.motivo, "pedido_cancelado");
});

Deno.test("B2: situacaoFaturada só para 3 (Atendido Total) e 7 (Fatur Balcão)", () => {
  assertEquals(["1 - Aberto", "2 - Atendido Parcial", "3 - Atendido Total", "4 - Pendentes", "5 - Suspenso", "6 - Cancelado", "7 - Fatur Balcão", "37 - X", ""].map(situacaoFaturada),
    [false, false, true, false, false, false, true, false, false]);
});

// ── C16: por que a condição não veio (nunca devolve condição — só explica a recusa) ─────────────────────
const DETALHE = "/order-creation-form-edit/2148223/route/order-viewer";
function diagCond(p: Record<string, unknown> = {}) {
  return {
    caminho: DETALHE, titulo: "Pedido", select_presente: true, select_n_opcoes: 4, select_selecionada: "Selecione",
    select_desabilitado: false, selects: [], campos: [], textos: [], ...p,
  };
}
Deno.test("C16: causa da condição ausente pelo retrato da tela", () => {
  const causa = (d: unknown) => explicarCondicaoAusente(d).causa;
  assertEquals(
    [
      causa(undefined), causa(null), causa([]), causa({ erro: "Execution context was destroyed" }),
      causa(diagCond({ caminho: "/login" })), causa(diagCond({ select_presente: false, select_n_opcoes: null })),
      causa(diagCond({ select_n_opcoes: 0 })), causa(diagCond()), causa(diagCond({ select_selecionada: "" })),
      causa(diagCond({ select_selecionada: "70 - 7 DIAS" })),
    ],
    [
      "sem_retrato", "sem_retrato", "sem_retrato", "sem_retrato", "fora_do_detalhe", "campo_ausente",
      "campo_sem_opcoes", "sem_selecao", "sem_selecao", "fora_do_prazo",
    ],
  );
});
Deno.test("C16: repetir só é sugerido quando pode resolver; o resto diz como seguir sem presumir condição", () => {
  const estrutural = mensagemCondicaoAusente("2148223", diagCond({ select_presente: false }));
  const transitoria = mensagemCondicaoAusente("2148223", diagCond({ caminho: "/login" }));
  assertEquals(
    [
      estrutural.mensagem.includes("tentar de novo não adianta"), estrutural.mensagem.includes("nº 2148223 no campo contrato"),
      estrutural.mensagem.includes("Tente de novo em"), transitoria.mensagem.includes("Tente de novo em"),
      transitoria.mensagem.includes('"/login"'), estrutural.mensagem.includes("Nada foi gravado"),
    ],
    [true, true, false, true, true, true],
  );
});
