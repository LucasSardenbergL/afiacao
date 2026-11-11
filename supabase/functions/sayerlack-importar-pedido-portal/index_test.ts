// Testes do HANDLER REAL da importadora (item 8.1 do plano Sayerlack, revisão 2): roda o `index.ts` de verdade com
// fetch simulado por rota (PostgREST, Browserless, disparo do PO) nos ramos money-path que a lógica pura
// (`leitura_test.ts`) não alcança: existente cancelado no portal, resposta perdida depois de gravar, PO manual no
// Omie, re-disparo que falha, falha ao gravar o "6", objeto incompleto e perda do #id.
//
// Roda com: deno test --no-remote --allow-read=supabase/functions supabase/functions/sayerlack-importar-pedido-portal/
import { ENV_TESTE, igual, instalarHarness, registrarCasosDeGate } from "../_shared/harness-handler_test.ts";
import { criarPostgrestFalso, erroBanco, type Resposta, type Rota } from "../_shared/postgrest-falso_test.ts";
import { VERSAO } from "./versao.ts";

const h = instalarHarness({
  ...ENV_TESTE,
  SAYERLACK_PORTAL_USER: "usuario-de-teste",
  SAYERLACK_PORTAL_PASS: "senha-de-teste",
  SAYERLACK_PORTAL_URL: "https://portal-de-teste.invalid",
  SAYERLACK_PORTAL_CLIENTE_CODIGO: "999",
  BROWSERLESS_TOKEN: "token-de-teste",
});
await import(new URL("./index.ts", import.meta.url).href);
const handler = h.handler();

registrarCasosDeGate("sayerlack-importar-pedido-portal", h, VERSAO);

const PROTOCOLO = "2140603";
const BROWSERLESS = "https://chrome.browserless.io/function";
const DISPARO = `${ENV_TESTE.SUPABASE_URL}/functions/v1/disparar-pedidos-aprovados`;

function linha(situacao: string) {
  return {
    "Estab": "CAJ", "Pedido": PROTOCOLO, "Pedido Clien": PROTOCOLO, "Cliente": "OBEN COMERCIO LTDA",
    "Situação": situacao, "Data Emissão": "14/10/2026", "Data Entrega": "26/10/2026",
    "Vlr Mercadori": "4865,5600", "Vlr Total": "5181,8200",
  };
}
const ITENS = {
  success: true,
  itens: [[10, "DFA.4080LT", "", "L", 18, 288, 16, 19.8637, 357.5466, 357.5466, 5, "14,9488", 4865.5584, "DILUENTE PU 4080A LT", "PROREAL", 30, "0.0000", "1.0000", "", 5]],
  data_pedido: { transportadora: "SPMINAS" },
};
function portal(situacao: string): Resposta {
  return {
    corpo: {
      data: {
        success: true, consulta: { linhas: [linha(situacao)] }, itens: ITENS,
        condicao: "70 - 7 DIAS", condicoes_opcoes: ["70 - 7 DIAS", "30 DIAS"],
      },
    },
  };
}

interface Pedido {
  id: number; status: string | null; portal_protocolo: string; omie_pedido_compra_numero: string | null;
  omie_pedido_compra_id: string | null; valor_total: number | null; num_skus: number | null;
  importado_portal_em: string | null; condicao_pagamento_codigo: string | null; condicao_pagamento_descricao: string | null;
}
function pedido(p: Partial<Pedido> = {}): Pedido {
  return {
    id: 501, status: "falha_envio", portal_protocolo: PROTOCOLO, omie_pedido_compra_numero: null,
    omie_pedido_compra_id: null, valor_total: 5181.82, num_skus: 1, importado_portal_em: "2026-11-01T10:00:00Z",
    condicao_pagamento_codigo: "T54", condicao_pagamento_descricao: "30 dias", ...p,
  };
}

interface Cenario {
  /** Linha do pedido por protocolo (null = não existe). Pode trocar ao longo do teste. */
  porProtocolo: () => Pedido | null | "rede";
  porId?: (id: number) => Pedido | null;
  pos?: () => Resposta;
  browserless?: () => Resposta;
  registrar?: () => Resposta;
  importar?: () => Resposta;
  disparo?: () => Resposta;
  pendencia?: () => Resposta;
  evidencia?: () => Resposta;
  /** RPC do 7.1 (default: recusa por conteúdo — o comportamento de antes, sem vínculo). */
  vincular?: () => Resposta | "rede";
  /** RPC do 5.2 (default: o pedido do app bate com a leitura). */
  conferir?: () => Resposta | "rede";
}

function montar(c: Cenario) {
  const rotas: Record<string, Rota> = {
    "rest:profiles": () => ({ corpo: [{ name: "Operador de teste" }] }),
    "POST rest:acoes_execucoes": () => ({ status: 201, corpo: [{ id: "reg-1" }] }),
    "PATCH rest:acoes_execucoes": () => ({ status: 204, corpo: null }),
    "GET rest:pedido_compra_sugerido": (ch) => {
      const id = ch.params.get("id");
      if (id) return { corpo: [c.porId?.(Number(id.replace("eq.", ""))) ?? c.porProtocolo()].filter(Boolean) };
      const p = c.porProtocolo();
      if (p === "rede") return "rede";
      return { corpo: p ? [p] : [] };
    },
    "rest:purchase_orders_tracking": () => c.pos?.() ?? { corpo: [] },
    "PATCH rest:sayerlack_varredura_falha": () => c.pendencia?.() ?? { status: 204, corpo: null },
    "GET rest:sayerlack_varredura_falha": () => ({ corpo: [] }),
    "POST rest:sayerlack_varredura_falha": () => c.pendencia?.() ?? { status: 201, corpo: null },
    [BROWSERLESS]: () => c.browserless?.() ?? portal("5 - Suspenso"),
    "POST rest:sayerlack_portal_evidencia": () => c.evidencia?.() ?? { status: 201, corpo: [{ id: 42 }] },
    "rpc:sayerlack_registrar_situacao_portal": () => c.registrar?.() ?? { corpo: { aceitos: [{ protocolo: PROTOCOLO }] } },
    "rpc:sayerlack_vincular_po_manual": () => c.vincular?.() ?? { corpo: { vinculado: false, motivo: "conteudo_divergente", diferencas: [{ sku: "111", qtde_app: 2, qtde_po: 4, valor_app: 20, valor_po: 40 }] } },
    "rpc:sayerlack_importar_pedido_portal": () => c.importar?.() ?? { corpo: { pedido_id: 777, ja_existia: false } },
    "rpc:sayerlack_conferir_portal": () => c.conferir?.() ?? { corpo: { conferido: true, divergente: false, pedido_id: 501 } },
    [DISPARO]: () => c.disparo?.() ?? { corpo: { ok: true } },
  };
  const falso = criarPostgrestFalso(ENV_TESTE.SUPABASE_URL, rotas);
  h.responderForaDoGate((r) => falso.responder(r));
  return falso;
}

async function importar(corpo: Record<string, unknown> = { protocolo: PROTOCOLO }) {
  const resp = await handler(new Request("https://edge.invalid/", {
    method: "POST",
    headers: { Authorization: "Bearer jwt-employee", "Content-Type": "application/json" },
    body: JSON.stringify(corpo),
  }));
  return { status: resp.status, corpo: await resp.json() as Record<string, unknown> };
}

/** O `detalhes` que o ledger gravou ao fechar (última PATCH em acoes_execucoes). */
function ledger(falso: ReturnType<typeof montar>): Record<string, unknown> {
  const fechos = falso.de("rest:acoes_execucoes", "PATCH");
  if (fechos.length !== 1) throw new Error(`esperava 1 fecho do ledger, vieram ${fechos.length}`);
  return (fechos[0].corpo as { detalhes: Record<string, unknown> }).detalhes;
}

Deno.test("1ª importação: grava pedido, grava a situação de novo pós-criar (B10), dispara o PO e responde pelo banco", async () => {
  let criado = false;
  const falso = montar({
    porProtocolo: () => null,
    porId: () => (criado ? pedido({ id: 777, status: "enviado", omie_pedido_compra_id: "9001", omie_pedido_compra_numero: "PO-9001" }) : null),
    disparo: () => { criado = true; return { corpo: { ok: true } }; },
  });
  const r = await importar();
  igual([r.status, r.corpo.ok, r.corpo.etapa, r.corpo.pedido_id, r.corpo.omie_numero], [200, true, "concluido", 777, "PO-9001"], "resposta");
  igual(falso.de("rpc:sayerlack_registrar_situacao_portal").length, 2, "situação gravada antes E depois de criar");
  igual(falso.de(DISPARO).length, 1, "um disparo");
  igual((falso.de(DISPARO)[0].corpo as { pedido_id: number }).pedido_id, 777, "disparo do pedido criado");
  const l = ledger(falso);
  igual([l.situacao_gravada, l.pedido_id, l.condicoes_opcoes], ["aceita", 777, ["70 - 7 DIAS", "30 DIAS"]], "ledger");
});

Deno.test("existente sem PO cancelado no portal: relê, recusa o re-disparo e mantém o #id", async () => {
  const falso = montar({ porProtocolo: () => pedido(), browserless: () => portal("6 - Cancelado") });
  const r = await importar();
  igual([r.corpo.ok, r.corpo.etapa, r.corpo.motivo, r.corpo.pedido_id, r.corpo.ja_existia], [false, "leitura", "pedido_cancelado", 501, true], "resposta");
  igual(falso.de(DISPARO).length, 0, "nenhum disparo de PO");
  igual(falso.de("rpc:sayerlack_importar_pedido_portal").length, 0, "nada gravado");
  igual(ledger(falso).situacao_gravada, "aceita", "o 6 foi gravado e está no ledger");
});

Deno.test("PO lançado à mão no Omie (contrato composto): não abre o portal nem dispara", async () => {
  const falso = montar({
    porProtocolo: () => pedido(),
    pos: () => ({ corpo: [{ numero_pedido: "PO-77", numero_contrato_fornecedor: `2140000 / ${PROTOCOLO}` }] }),
  });
  const r = await importar();
  igual([r.corpo.ok, r.corpo.motivo, r.corpo.omie_numero, r.corpo.pedido_id], [false, "po_manual_no_omie", "PO-77", 501], "resposta");
  igual(falso.de(BROWSERLESS).length + falso.de(DISPARO).length, 0, "zero portal e zero disparo");
});

Deno.test("7.1: PO manual que casa é VINCULADO pela RPC — sem portal, sem disparo, pendência resolvida", async () => {
  const falso = montar({
    porProtocolo: () => pedido(),
    pos: () => ({ corpo: [{ numero_pedido: "PO-77", numero_contrato_fornecedor: `2140000 / ${PROTOCOLO}` }] }),
    vincular: () => ({ corpo: { vinculado: true, motivo: "vinculado", po_numero: "PO-77", po_codigo: "9077", contrato_composto: true } }),
  });
  const r = await importar();
  igual([r.corpo.ok, r.corpo.motivo, r.corpo.omie_numero, r.corpo.status, r.corpo.contrato_composto], [true, "po_manual_vinculado", "PO-77", "disparado", true], "resposta");
  const args = falso.de("rpc:sayerlack_vincular_po_manual")[0]?.corpo as Record<string, unknown>;
  igual([args?.p_pedido_id, args?.p_ator, args?.p_origem], [501, "u-employee", "importar"], "RPC com o pedido, o operador e a origem");
  igual(falso.de(BROWSERLESS).length + falso.de(DISPARO).length, 0, "zero portal e zero disparo");
  igual(falso.de("rest:sayerlack_varredura_falha", "PATCH").length, 1, "pendência da varredura resolvida");
});

Deno.test("7.1: PO manual que NÃO casa: recusa com motivo e diferenças, sem portal nem disparo", async () => {
  const falso = montar({
    porProtocolo: () => pedido(),
    pos: () => ({ corpo: [{ numero_pedido: "PO-77", numero_contrato_fornecedor: PROTOCOLO }] }),
  });
  const r = await importar();
  igual([r.corpo.ok, r.corpo.motivo, r.corpo.vinculo_motivo], [false, "po_manual_no_omie", "conteudo_divergente"], "resposta");
  igual((r.corpo.diferencas as unknown[]).length, 1, "diferenças na resposta");
  if (!String(r.corpo.mensagem).includes("SKU 111: app 2 un.")) throw new Error(`mensagem sem o diff: ${r.corpo.mensagem}`);
  igual(falso.de(BROWSERLESS).length + falso.de(DISPARO).length, 0, "zero portal e zero disparo");
});

Deno.test("7.1: RPC de vinculação com ERRO não vira re-disparo (fail-closed)", async () => {
  const falso = montar({
    porProtocolo: () => pedido(),
    pos: () => ({ corpo: [{ numero_pedido: "PO-77", numero_contrato_fornecedor: PROTOCOLO }] }),
    vincular: () => "rede",
  });
  const r = await importar();
  igual([r.corpo.ok, r.corpo.pedido_id], [false, 501], "falha com o #id");
  igual(falso.de(BROWSERLESS).length + falso.de(DISPARO).length, 0, "zero portal e zero disparo");
});

Deno.test("contrato que só CONTÉM o protocolo (outro número) não vale como PO manual", async () => {
  let disparou = false;
  const falso = montar({
    porProtocolo: () => pedido(),
    porId: () => pedido(disparou ? { status: "enviado", omie_pedido_compra_id: "9002", omie_pedido_compra_numero: "PO-9002" } : {}),
    pos: () => ({ corpo: [{ numero_pedido: "PO-88", numero_contrato_fornecedor: `${PROTOCOLO}9` }] }),
    disparo: () => { disparou = true; return { corpo: { ok: true } }; },
  });
  const r = await importar();
  igual([r.corpo.ok, r.corpo.etapa, r.corpo.pedido_id], [true, "concluido", 501], "re-disparou");
  igual(falso.de(DISPARO).length, 1, "um disparo");
});

Deno.test("re-disparo que falha: etapa omie, ok=false, #id e 'não lance à mão'", async () => {
  const falso = montar({ porProtocolo: () => pedido(), disparo: () => ({ status: 500, corpo: { erro: "omie fora" } }) });
  const r = await importar();
  igual([r.corpo.ok, r.corpo.etapa, r.corpo.pedido_id, r.corpo.disparo_http], [false, "omie", 501, 500], "resposta");
  if (!String(r.corpo.mensagem).includes("Não lance à mão no Omie")) throw new Error(`mensagem sem o aviso: ${r.corpo.mensagem}`);
  igual(falso.de("rpc:sayerlack_importar_pedido_portal").length, 0, "re-disparo não regrava o pedido");
});

Deno.test("re-disparo de pedido faturado no portal (3) é recusado (B2)", async () => {
  const falso = montar({ porProtocolo: () => pedido(), browserless: () => portal("3 - Atendido Total") });
  const r = await importar();
  igual([r.corpo.ok, r.corpo.motivo, r.corpo.pedido_id], [false, "faturado_no_portal", 501], "resposta");
  igual(falso.de(DISPARO).length, 0, "nenhum disparo");
});

Deno.test("resposta da gravação perdida (rede) e o pedido EXISTE na releitura: devolve o #id e não dispara", async () => {
  let gravou = false;
  const falso = montar({
    porProtocolo: () => (gravou ? pedido({ id: 778, status: "aprovado_aguardando_disparo" }) : null),
    importar: () => { gravou = true; return "rede"; },
  });
  const r = await importar();
  igual([r.corpo.ok, r.corpo.etapa, r.corpo.pedido_id, r.corpo.desfecho], [false, "importacao", 778, undefined], "resposta");
  igual(falso.de(DISPARO).length, 0, "não dispara daqui");
  igual(ledger(falso).pedido_id, 778, "o #id chega ao ledger");
});

Deno.test("resposta da gravação perdida e a releitura NÃO acha: indeterminado (nunca 'não importado')", async () => {
  const falso = montar({ porProtocolo: () => null, importar: () => "rede" });
  const r = await importar();
  igual([r.corpo.ok, r.corpo.desfecho, r.corpo.pedido_id], [false, "indeterminado", undefined], "resposta");
  igual(falso.de(DISPARO).length, 0, "não dispara");
  igual(ledger(falso).desfecho, "indeterminado", "ledger diz indeterminado");
});

Deno.test("erro com sqlstate da casa (IP007) é recusa reconhecida, sem releitura", async () => {
  const falso = montar({ porProtocolo: () => null, importar: () => erroBanco("IP007", "condição ambígua") });
  const r = await importar();
  igual([r.corpo.ok, r.corpo.sqlstate, r.corpo.desfecho], [false, "IP007", undefined], "resposta");
  igual(falso.de("rest:pedido_compra_sugerido", "GET").length, 1, "só a leitura inicial — sem releitura");
});

Deno.test("RPC responde sem pedido_id válido (objeto incompleto): indeterminado", async () => {
  const falso = montar({ porProtocolo: () => null, importar: () => ({ corpo: {} }) });
  const r = await importar();
  igual([r.corpo.ok, r.corpo.desfecho], [false, "indeterminado"], "resposta");
  igual(falso.de(DISPARO).length, 0, "não dispara");
});

Deno.test("espelho de POs falha depois de achar o pedido: 500 COM o #id (B7)", async () => {
  const falso = montar({ porProtocolo: () => pedido(), pos: () => erroBanco("57014", "statement timeout", 500) });
  const r = await importar();
  igual([r.status, r.corpo.ok, r.corpo.pedido_id, r.corpo.ja_existia], [500, false, 501, true], "resposta");
  igual(falso.de(BROWSERLESS).length + falso.de(DISPARO).length, 0, "nada além da leitura");
});

Deno.test("leitura inicial do pedido falha (rede): indeterminado 500, sem portal", async () => {
  const falso = montar({ porProtocolo: () => "rede" });
  const r = await importar();
  igual([r.status, r.corpo.desfecho, r.corpo.pedido_id], [500, "indeterminado", undefined], "resposta");
  igual(falso.de(BROWSERLESS).length, 0, "não abre o portal");
});

Deno.test("6 lido e NÃO gravado (2 tentativas) pelo botão: abre pendência vencida e o ledger diz 'erro' (B3)", async () => {
  const falso = montar({
    porProtocolo: () => pedido(),
    browserless: () => portal("6 - Cancelado"),
    registrar: () => erroBanco("40001", "serialização"),
  });
  const r = await importar();
  igual([r.corpo.ok, r.corpo.motivo, r.corpo.situacao_gravada], [false, "pedido_cancelado", "erro"], "resposta");
  igual(falso.de("rpc:sayerlack_registrar_situacao_portal").length, 2, "2 tentativas");
  const abertas = falso.de("rest:sayerlack_varredura_falha", "POST");
  igual(abertas.length, 1, "pendência aberta");
  igual((abertas[0].corpo as { ultima_em: string }).ultima_em, new Date(0).toISOString(), "pendência VENCIDA");
  igual(ledger(falso).situacao_gravada, "erro", "ledger");
});

Deno.test("6 não gravado vindo da VARREDURA (situacoes_permitidas): não abre pendência pelo botão", async () => {
  const falso = montar({
    porProtocolo: () => pedido(),
    browserless: () => portal("6 - Cancelado"),
    registrar: () => erroBanco("40001", "serialização"),
  });
  const r = await importar({ protocolo: PROTOCOLO, situacoes_permitidas: ["1", "5"] });
  igual(r.corpo.situacao_gravada, "erro", "situação não gravada");
  igual(falso.de("rest:sayerlack_varredura_falha", "POST").length, 0, "pendência é da varredura");
});

Deno.test("somente_situacao: grava a situação e não toca pedido nem PO", async () => {
  const falso = montar({ porProtocolo: () => pedido({ status: "enviado", omie_pedido_compra_id: "9001" }), browserless: () => portal("6 - Cancelado") });
  const r = await importar({ protocolo: PROTOCOLO, somente_situacao: true });
  igual([r.corpo.ok, r.corpo.motivo, r.corpo.situacao_gravada, r.corpo.pedido_id], [true, "somente_situacao", "aceita", 501], "resposta");
  igual(falso.de(DISPARO).length + falso.de("rpc:sayerlack_importar_pedido_portal").length, 0, "nada além da situação");
});

Deno.test("Browserless fora: recusa de leitura sem gravar nada", async () => {
  const falso = montar({ porProtocolo: () => null, browserless: () => ({ status: 502, corpo: "bad gateway" }) });
  const r = await importar();
  igual([r.corpo.ok, r.corpo.etapa], [false, "leitura"], "resposta");
  igual(falso.de("rpc:sayerlack_registrar_situacao_portal").length + falso.de("rpc:sayerlack_importar_pedido_portal").length, 0, "nada gravado");
});

Deno.test("cron não importa pedido (403) e não toca o banco", async () => {
  const falso = montar({ porProtocolo: () => null });
  const resp = await handler(new Request("https://edge.invalid/", {
    method: "POST",
    headers: { "x-cron-secret": ENV_TESTE.CRON_SECRET, "Content-Type": "application/json" },
    body: JSON.stringify({ protocolo: PROTOCOLO }),
  }));
  igual(resp.status, 403, "403");
  await resp.body?.cancel();
  igual(falso.chamadas.length, 0, "zero efeito");
});

// 8.2: o script que VAI ao Browserless é JS válido e carrega as funções de página testadas contra HTML real
// (`scripts/sayerlack-portal-dom.test.ts`). Pega um `.toString()` que saia com tipo TS, crase ou cifrão-chave.
Deno.test("script do Browserless parseia e embute as funções de página do _shared (8.2)", async () => {
  const falso = montar({ porProtocolo: () => null });
  await importar();
  const envios = falso.de(BROWSERLESS);
  igual(envios.length >= 1, true, "chamou o Browserless");
  const code = String((envios[0].corpo as { code: string }).code);
  const fn = new Function(code.trim().replace(/^export default /, "return "))();
  igual(typeof fn, "function", "o módulo exporta a função");
  for (const nome of ["aplicarFiltrosConsultaDom", "clicarFiltrarDom", "lerTabelaConsultaDom", "lerCondicaoSelecionadaDom", "lerCondicoesOpcoesDom", "diagnosticarCondicaoDom"]) {
    igual(code.includes(`function ${nome}(`), true, `embute ${nome}`);
  }
});

// ── 7.2 (evidência imutável) e 4.3 (sessão do Browserless) ──────────────────────────────────────────────────────────
function evidencias(falso: ReturnType<typeof montar>): Record<string, unknown>[] {
  return falso.de("rest:sayerlack_portal_evidencia", "POST").map((c) => {
    const corpo = c.corpo as Record<string, unknown> | Record<string, unknown>[];
    return Array.isArray(corpo) ? corpo[0] : corpo;
  });
}

Deno.test("7.2: a leitura do portal vira 1 evidência com o envelope cru, correlacionada ao ledger", async () => {
  const falso = montar({ porProtocolo: () => null });
  const r = await importar();
  const ev = evidencias(falso);
  igual(ev.length, 1, "uma evidência por leitura");
  const e = ev[0];
  igual([e.execucao_id, e.protocolo, e.origem, e.somente_situacao, e.leitura_ok, e.http_status, e.pedido_id],
    ["reg-1", PROTOCOLO, "manual", false, true, 200, null], "identidade e desfecho");
  igual([e.itens_brutos, e.consulta_linhas, e.condicao, e.condicoes_opcoes],
    [ITENS, [linha("5 - Suspenso")], "70 - 7 DIAS", ["70 - 7 DIAS", "30 DIAS"]], "o que o portal mostrou");
  igual(typeof e.lido_de === "string" && typeof e.lido_ate === "string" && String(e.lido_ate) >= String(e.lido_de), true, "intervalo");
  const l = ledger(falso);
  igual([l.evidencia_id, l.evidencia_gravada, l.sessao_browserless], [42, true, true], "ledger aponta a evidência");
  igual(r.corpo.sessao_browserless, true, "resposta diz que abriu sessão");
});

Deno.test("7.2: pedido já no app — a evidência leva o #id; somente_situacao também é evidência", async () => {
  const falso = montar({ porProtocolo: () => pedido({ status: "enviado", omie_pedido_compra_id: "9001" }), browserless: () => portal("6 - Cancelado") });
  await importar({ protocolo: PROTOCOLO, somente_situacao: true });
  const e = evidencias(falso)[0];
  igual([e.pedido_id, e.somente_situacao, e.leitura_ok], [501, true, true], "evidência do pedido conhecido");
});

Deno.test("7.2: Browserless fora também é evidência (leitura_ok=false, status e erro)", async () => {
  const falso = montar({ porProtocolo: () => null, browserless: () => ({ status: 502, corpo: "bad gateway" }) });
  const r = await importar();
  const e = evidencias(falso)[0];
  igual([e.leitura_ok, e.http_status, e.itens_brutos], [false, 502, null], "falha registrada");
  igual(r.corpo.sessao_browserless, true, "o fetch foi tentado: a sessão conta");
});

Deno.test("7.2: evidência que não grava é fail-open — a importação segue e o ledger diz que não gravou", async () => {
  let criado = false;
  const falso = montar({
    porProtocolo: () => null,
    porId: () => (criado ? pedido({ id: 777, status: "enviado", omie_pedido_compra_id: "9001", omie_pedido_compra_numero: "PO-9001" }) : null),
    disparo: () => { criado = true; return { corpo: { ok: true } }; },
    evidencia: () => erroBanco("23514", "new row violates check constraint"),
  });
  const r = await importar();
  igual([r.corpo.ok, r.corpo.etapa], [true, "concluido"], "importação não muda");
  const l = ledger(falso);
  igual([l.evidencia_id, l.evidencia_gravada], [null, false], "ledger: evidência não gravada");
});

Deno.test("4.3: recusa antes do portal (PO manual) responde sessao_browserless=false e não grava evidência", async () => {
  const falso = montar({
    porProtocolo: () => pedido(),
    pos: () => ({ corpo: [{ numero_pedido: "PO-77", numero_contrato_fornecedor: `2140000 / ${PROTOCOLO}` }] }),
  });
  const r = await importar();
  igual([r.corpo.motivo, r.corpo.sessao_browserless], ["po_manual_no_omie", false], "sem sessão");
  igual(evidencias(falso).length, 0, "sem leitura, sem evidência");
  igual(ledger(falso).sessao_browserless, false, "ledger sem sessão");
});

Deno.test("4.3: já com PO responde sessao_browserless=false", async () => {
  montar({ porProtocolo: () => pedido({ status: "enviado", omie_pedido_compra_id: "9001", omie_pedido_compra_numero: "PO-9001" }) });
  const r = await importar();
  igual([r.corpo.ja_existia, r.corpo.sessao_browserless], [true, false], "sem sessão");
});

Deno.test("7.2 (Codex P1): INSERT da evidência pendurado não segura a situação nem o disparo", async () => {
  let criado = false;
  const falso = montar({
    porProtocolo: () => null,
    porId: () => (criado ? pedido({ id: 777, status: "enviado", omie_pedido_compra_id: "9001", omie_pedido_compra_numero: "PO-9001" }) : null),
    disparo: () => { criado = true; return { corpo: { ok: true } }; },
    evidencia: () => new Promise<Resposta>(() => {}) as unknown as Resposta,
  });
  const r = await importar();
  igual([r.corpo.ok, r.corpo.etapa], [true, "concluido"], "importação segue");
  igual(falso.de("rpc:sayerlack_registrar_situacao_portal").length, 2, "a situação foi gravada");
  igual([ledger(falso).evidencia_gravada, ledger(falso).evidencia_id], [false, null], "ledger: sem evidência confirmada");
});

Deno.test("4.3 (Codex P2): saídas antecipadas também dizem sessao_browserless=false", async () => {
  montar({ porProtocolo: () => null });
  const invalido = await importar({ protocolo: "12a" });
  igual([invalido.status, invalido.corpo.sessao_browserless], [400, false], "protocolo inválido");
  const cron = await handler(new Request("https://edge.invalid/", {
    method: "POST",
    headers: { "x-cron-secret": ENV_TESTE.CRON_SECRET, "Content-Type": "application/json" },
    body: JSON.stringify({ protocolo: PROTOCOLO }),
  }));
  igual([cron.status, (await cron.json() as Record<string, unknown>).sessao_browserless], [403, false], "cron");
});

// ── 5.2 fatia 1: conferência pedido do app × leitura do portal ANTES de qualquer re-disparo ─────────────────────
const DIVERGENTE: Resposta = {
  corpo: {
    conferido: true, divergente: true, pedido_id: 501, divergencia_id: 9,
    diferencas: [{ tipo: "quantidade", sku: "DFA.4080LT", app: 16, portal: 17 }],
  },
};

Deno.test("5.2: re-disparo confere a leitura inteira (itens, total, condição, intervalo, evidência) e só então dispara", async () => {
  const falso = montar({ porProtocolo: () => pedido() });
  await importar();
  const args = falso.de("rpc:sayerlack_conferir_portal")[0]?.corpo as Record<string, unknown>;
  const l = args?.p_leitura as Record<string, unknown>;
  igual([args?.p_pedido_id, args?.p_evidencia_id, args?.p_origem], [501, 42, "redisparo"], "pedido, evidência 7.2 e origem");
  igual([l?.protocolo, l?.valor_total, l?.condicao, typeof l?.lido_de, typeof l?.lido_ate], [PROTOCOLO, 5181.82, "70 - 7 DIAS", "string", "string"], "leitura");
  igual(l?.itens, [{ sku_portal: "DFA.4080LT", qtde_portal: 16, valor_mercadoria: 4865.5584 }], "itens lidos");
  igual(falso.de(DISPARO).length, 1, "bateu ⇒ um disparo");
});

Deno.test("5.2: pedido alterado no portal NÃO re-dispara — alterado_no_portal com as diferenças e o #id", async () => {
  const falso = montar({ porProtocolo: () => pedido(), conferir: () => DIVERGENTE });
  const r = await importar();
  igual([r.corpo.ok, r.corpo.motivo, r.corpo.pedido_id, r.corpo.divergencia_id], [false, "alterado_no_portal", 501, 9], "resposta");
  igual((r.corpo.diferencas as unknown[]).length, 1, "diferenças na resposta");
  if (!String(r.corpo.mensagem).includes("quantidade DFA.4080LT: app 16 → portal 17")) throw new Error(`mensagem sem o diff: ${r.corpo.mensagem}`);
  igual(falso.de(DISPARO).length, 0, "zero disparo");
  igual(ledger(falso).divergencia_id, 9, "a divergência vai ao ledger");
});

Deno.test("5.2: conferência com ERRO ou recusa (leitura antiga) não vira re-disparo (fail-closed)", async () => {
  for (const conferir of [() => "rede" as const, () => ({ corpo: { conferido: false, motivo: "leitura_antiga" } })]) {
    const falso = montar({ porProtocolo: () => pedido(), conferir });
    const r = await importar();
    igual([r.corpo.ok, r.corpo.pedido_id], [false, 501], "falha com o #id");
    if (!String(r.corpo.mensagem).includes("re-disparei")) throw new Error(`mensagem sem o 'não re-disparei': ${r.corpo.mensagem}`);
    igual(falso.de(DISPARO).length, 0, "zero disparo");
  }
});

Deno.test("5.2: resposta da conferência fora do contrato (sem 'divergente') não vira re-disparo", async () => {
  const falso = montar({ porProtocolo: () => pedido(), conferir: () => ({ corpo: { conferido: true } }) });
  const r = await importar();
  igual([r.corpo.ok, r.corpo.pedido_id], [false, 501], "falha com o #id");
  igual(falso.de(DISPARO).length, 0, "zero disparo");
});

Deno.test("5.2: re-disparo com a condição ilegível no portal recusa sem conferir nem disparar", async () => {
  const semCondicao: Resposta = {
    corpo: { data: { success: true, consulta: { linhas: [linha("5 - Suspenso")] }, itens: ITENS, condicao: "  " } },
  };
  const falso = montar({ porProtocolo: () => pedido(), browserless: () => semCondicao });
  const r = await importar();
  igual([r.corpo.ok, r.corpo.motivo, r.corpo.pedido_id], [false, "condicao_ilegivel", 501], "resposta");
  igual(falso.de("rpc:sayerlack_conferir_portal").length + falso.de(DISPARO).length, 0, "zero conferência e zero disparo");
});

Deno.test("5.2: 1ª importação não confere pela edge (o retrato nasce dentro da RPC de importar)", async () => {
  const falso = montar({ porProtocolo: () => null });
  await importar();
  igual(falso.de("rpc:sayerlack_conferir_portal").length, 0, "nenhuma conferência pela edge");
  igual(falso.de(DISPARO).length, 1, "um disparo");
});

Deno.test("5.2: a RPC achou o pedido JÁ gravado (outra aba): confere antes de disparar e recusa o divergente", async () => {
  const falso = montar({
    porProtocolo: () => null,
    importar: () => ({ corpo: { pedido_id: 501, ja_existia: true } }),
    conferir: () => DIVERGENTE,
  });
  const r = await importar();
  igual([r.corpo.ok, r.corpo.motivo, r.corpo.pedido_id], [false, "alterado_no_portal", 501], "resposta");
  igual(falso.de("rpc:sayerlack_conferir_portal").length, 1, "conferiu");
  igual(falso.de(DISPARO).length, 0, "zero disparo");
});

Deno.test("5.2: a RPC achou o pedido JÁ gravado e o portal diz faturado: recusa como re-disparo (B2)", async () => {
  const falso = montar({
    porProtocolo: () => null,
    browserless: () => portal("3 - Atendido Total"),
    importar: () => ({ corpo: { pedido_id: 501, ja_existia: true } }),
  });
  const r = await importar();
  igual([r.corpo.ok, r.corpo.motivo, r.corpo.pedido_id], [false, "faturado_no_portal", 501], "resposta");
  igual(falso.de(DISPARO).length, 0, "zero disparo");
});

// ── C16 (plano v8): condição ausente — o caso REAL dos pedidos 2148220/2148223 ─────────────────────────
// Envelope que o portal devolveu em prod (evidência #12, pedido 2148223, 2026-11-11 01:31 UTC): consulta e itens
// lidos, condição null e ZERO opções. Sem retrato da tela (a edge de então não o capturava).
const PROTOCOLO_REAL = "2148223";
const ENVELOPE_REAL_2148223 = {
  success: true,
  consulta: {
    headers: ["Estab", "Pedido", "Pedido Cliente", "Cliente", "Situação", "Data Emissão", "Data Entrega", "Vlr Mercadoria", "Vlr Total", "Ações"],
    linhas: [{
      "Estab": "CAJ", "Pedido": "2148223", "Ações": "", "Cliente": "OBEN COMERCIO LTDA", "Vlr Total": "576,2700",
      "Situação": "1 - Aberto", "Data Entrega": "16/11/2026", "Data Emissão": "09/11/2026", "Pedido Cliente": "2148223",
      "Vlr Mercadoria": "576,2700",
    }],
  },
  itens: {
    success: true,
    itens: [[10, "FL.6264.02KGBH", "", "KG", 25, 75, 3, 7.6836, 192.09, 192.09, 5, "0", 576.27, "PRIMER PU 6264 BRANCO 02 KG BH", "PROREAL", 31, "0.0000", "1.0000", "", 1]],
    data_pedido: { tabelaPreco: "PROREAL", transportadora: "SPMINAS", taxa_financiamento: 1, cliente_remessa_triang: "" },
  },
  condicao: null,
  condicoes_opcoes: [],
  trace: [{ step: "itens_direto", status: 200, ok: true, t: 9809 }, { step: "condicao", condicao: null, t: 25056 }],
};

function nadaGravado(falso: ReturnType<typeof montar>) {
  return falso.de("rpc:sayerlack_importar_pedido_portal").length + falso.de(DISPARO).length;
}

Deno.test("C16: envelope REAL do 2148223 (condição null, 0 opções, sem retrato) recusa sem gravar nem disparar", async () => {
  const falso = montar({ porProtocolo: () => null, browserless: () => ({ corpo: { data: ENVELOPE_REAL_2148223 } }) });
  const r = await importar({ protocolo: PROTOCOLO_REAL });
  igual([r.corpo.ok, r.corpo.etapa, r.corpo.motivo, r.corpo.causa_condicao], [false, "leitura", "condicao_ilegivel", "sem_retrato"], "resposta");
  igual(nadaGravado(falso), 0, "nada gravado, nenhum PO");
  const m = String(r.corpo.mensagem);
  igual([m.includes("Nada foi gravado"), m.includes("nunca é presumida"), m.includes("Tente de novo")], [true, true, true], "mensagem");
});

Deno.test("C16: tela de detalhe SEM o campo de condição → recusa dizendo que repetir não resolve e como seguir", async () => {
  const diag = {
    caminho: "/order-creation-form-edit/2148223/route/order-viewer", titulo: "Pedido", select_presente: false,
    select_n_opcoes: null, select_selecionada: null, select_desabilitado: null, selects: [], campos: [], textos: [],
  };
  const falso = montar({ porProtocolo: () => null, browserless: () => ({ corpo: { data: { ...ENVELOPE_REAL_2148223, condicao_diag: diag } } }) });
  const r = await importar({ protocolo: PROTOCOLO_REAL });
  igual([r.corpo.ok, r.corpo.motivo, r.corpo.causa_condicao], [false, "condicao_ilegivel", "campo_ausente"], "resposta");
  igual(nadaGravado(falso), 0, "nada gravado, nenhum PO");
  const m = String(r.corpo.mensagem);
  igual([m.includes("tentar de novo não adianta"), m.includes("nº 2148223 no campo contrato"), m.includes("Tente de novo em")], [true, true, false], "mensagem acionável");
  igual((r.corpo.condicao_diag as { select_presente: boolean }).select_presente, false, "o retrato volta na resposta");
});

Deno.test("C16: re-disparo de pedido já no app com condição ausente explica a causa e não dispara", async () => {
  const diag = {
    caminho: "/login", titulo: "Login", select_presente: false, select_n_opcoes: null, select_selecionada: null,
    select_desabilitado: null, selects: [], campos: [], textos: [],
  };
  const falso = montar({
    porProtocolo: () => pedido({ portal_protocolo: PROTOCOLO_REAL }),
    pos: () => ({ corpo: [] }),
    browserless: () => ({ corpo: { data: { ...ENVELOPE_REAL_2148223, condicao_diag: diag } } }),
  });
  const r = await importar({ protocolo: PROTOCOLO_REAL });
  igual([r.corpo.ok, r.corpo.motivo, r.corpo.causa_condicao, r.corpo.pedido_id], [false, "condicao_ilegivel", "fora_do_detalhe", 501], "resposta");
  igual(falso.de(DISPARO).length + falso.de("rpc:sayerlack_conferir_portal").length, 0, "sem conferência nem disparo");
  igual(String(r.corpo.mensagem).includes('"/login"'), true, "diz a página que abriu");
});
