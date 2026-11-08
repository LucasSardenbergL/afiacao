// Testes do HANDLER REAL da varredura (item 8.1 do plano Sayerlack, revisão 2): roda o `index.ts` de verdade com
// fetch simulado por rota e o RELÓGIO fixo (a rodada pula sábado 12h → segunda 6h), nos ramos que a lógica pura
// (`varredura_test.ts`) não alcança: `listar` com zero efeito (não mascara o cron), 0 lidos sem prova, falha ao gravar
// o "6", importação sem resposta (indeterminado durável) e indeterminado de pendência fora da janela.
//
// Roda com: deno test --no-remote --allow-read=supabase/functions supabase/functions/sayerlack-varrer-pedidos-portal/
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

registrarCasosDeGate("sayerlack-varrer-pedidos-portal", h, VERSAO);

const BROWSERLESS = "https://chrome.browserless.io/function";
const IMPORTADORA = `${ENV_TESTE.SUPABASE_URL}/functions/v1/sayerlack-importar-pedido-portal`;
const HEADERS = ["Estab", "Pedido", "Pedido Clien", "Cliente", "Situação", "Data Emissão", "Data Entrega", "Vlr Mercadori", "Vlr Total"];

/** Quarta 11/11/2026, 10:00 em SP (13:00Z): portal aberto, depois do corte das 14h ainda não. */
const QUARTA = "2026-11-11T13:00:00.000Z";
const DOMINGO = "2026-11-08T15:00:00.000Z";

const DateReal = Date;
function comRelogio<T>(iso: string, fn: () => Promise<T>): Promise<T> {
  const base = DateReal.parse(iso);
  class DateFixo extends DateReal {
    constructor(...a: unknown[]) {
      if (a.length === 0) super(base);
      else super(...(a as [string]));
    }
    static override now() {
      return base;
    }
  }
  globalThis.Date = DateFixo as DateConstructor;
  return fn().finally(() => {
    globalThis.Date = DateReal;
  });
}

function linha(pedido: string, situacao: string, emissao = "10/11/2026") {
  return {
    "Estab": "CAJ", "Pedido": pedido, "Pedido Clien": pedido, "Cliente": "OBEN COMERCIO LTDA", "Situação": situacao,
    "Data Emissão": emissao, "Data Entrega": "26/11/2026", "Vlr Mercadori": "100,0000", "Vlr Total": "106,5000",
  };
}
function portal(linhas: Record<string, string>[], total: number | null = linhas.length): Resposta {
  return {
    corpo: {
      data: {
        success: true, headers: HEADERS, linhas, paginas: 1, situacoes: [],
        resposta_total: total, dt_total: total, info: total == null ? null : `Mostrando 1 até ${total} de ${total} registros`,
      },
    },
  };
}

interface Cenario {
  browserless?: () => Resposta;
  /** Linhas de pedido_compra_sugerido devolvidas a QUALQUER leitura dela (no app por protocolo, em voo, sem PO…). */
  pedidosNoApp?: Record<string, unknown>[];
  registrar?: () => Resposta;
  importadora?: () => Resposta;
  falhasAbertas?: Record<string, unknown>[];
  vistos?: Record<string, unknown>[];
  sync?: Record<string, unknown>[];
}

function montar(c: Cenario) {
  const rotas: Record<string, Rota> = {
    "POST rest:acoes_execucoes": () => ({ status: 201, corpo: [{ id: "exec-1" }] }),
    "PATCH rest:acoes_execucoes": () => ({ status: 204, corpo: null }),
    "GET rest:pedido_compra_sugerido": (ch) =>
      // pedidos em voo (status_envio_portal=in.(...)) nunca bloqueiam neste teste
      ({ corpo: ch.params.has("status_envio_portal") ? [] : (c.pedidosNoApp ?? []) }),
    "GET rest:sayerlack_varredura_falha": () => ({ corpo: c.falhasAbertas ?? [] }),
    // reserva da tentativa (UPDATE … RETURNING): devolve a linha = reservado
    "PATCH rest:sayerlack_varredura_falha": (ch) => ({ corpo: [{ protocolo: (ch.params.get("protocolo") ?? "").replace("eq.", "") }] }),
    "GET rest:sayerlack_varredura_visto": () => ({ corpo: c.vistos ?? [] }),
    "GET rest:sync_state": () => ({ corpo: c.sync ?? [] }),
    "rpc:sayerlack_registrar_situacao_portal": () => c.registrar?.() ?? { corpo: { aceitos: [], ignorados: 0 } },
    "rpc:sayerlack_cobertura_situacao_portal": () => ({ corpo: [] }),
    [BROWSERLESS]: () => c.browserless?.() ?? portal([]),
    [IMPORTADORA]: () => c.importadora?.() ?? { corpo: { ok: true, mensagem: "importado" } },
    // o resto (espelho, configuração, runs do detector, escritas de pendência/vista): vazio / aceito
    "*": (ch) => (ch.metodo === "GET" ? { corpo: [] } : ch.metodo === "POST" && ch.rota.startsWith("rpc:") ? { corpo: null } : { status: 201, corpo: [] }),
  };
  const falso = criarPostgrestFalso(ENV_TESTE.SUPABASE_URL, rotas);
  h.responderForaDoGate((r) => falso.responder(r));
  return falso;
}

async function varrer(modo: string) {
  const resp = await handler(new Request("https://edge.invalid/", {
    method: "POST",
    headers: { "x-cron-secret": ENV_TESTE.CRON_SECRET, "Content-Type": "application/json" },
    body: JSON.stringify({ modo }),
  }));
  return { status: resp.status, corpo: await resp.json() as Record<string, unknown> };
}

/** Escritas = o que não é leitura nem o ledger da própria execução. */
function escritas(falso: ReturnType<typeof montar>) {
  return falso.chamadas.filter((c) =>
    c.rota !== BROWSERLESS && c.metodo !== "GET" && c.rota !== "rest:acoes_execucoes" &&
    c.rota !== "rpc:sayerlack_cobertura_situacao_portal");
}

const NO_APP_CANCELADO = { id: 601, portal_protocolo: "2141200", status: "enviado", omie_pedido_compra_id: "9100", atualizado_em: "2026-11-10T12:00:00Z", enviado_portal_em: "2026-11-10T12:00:00Z", portal_data_entrega: "2026-11-26" };

Deno.test("modo inválido: 400 sem tocar banco nem portal", async () => {
  const falso = montar({});
  const r = await varrer("tudo");
  igual(r.status, 400, "400");
  igual(falso.chamadas.length, 0, "zero chamadas");
});

Deno.test("portal fechado (domingo): rodada pulada, sem abrir o navegador", () =>
  comRelogio(DOMINGO, async () => {
    const falso = montar({});
    const r = await varrer("importar");
    igual([r.status, r.corpo.pulado], [200, "portal_fechado"], "pulada");
    igual(falso.de(BROWSERLESS).length, 0, "sem Browserless");
  }));

Deno.test("listar: lê e relata com ZERO efeito — sem situação, vista, importação ou pendência (B9/3.10)", () =>
  comRelogio(QUARTA, async () => {
    const falso = montar({
      browserless: () => portal([linha("2141200", "6 - Cancelado"), linha("2141300", "1 - Aberto")]),
      pedidosNoApp: [NO_APP_CANCELADO],
    });
    const r = await varrer("listar");
    igual([r.status, r.corpo.ok, r.corpo.prova_leitura, r.corpo.linhas_lidas], [200, true, "ok", 2], "relatou");
    igual(escritas(falso).map((c) => `${c.metodo} ${c.rota}`), [], "zero escrita");
    igual(falso.de(IMPORTADORA).length, 0, "não importa");
    const abertura = falso.de("rest:acoes_execucoes", "POST")[0].corpo as { acao: string };
    igual(abertura.acao, "reposicao.listar_portal_sayerlack", "slug do listar (o vigia do cron não conta)");
  }));

Deno.test("0 linhas sem total anunciado: rodada VERMELHA com a causa, nada decidido", () =>
  comRelogio(QUARTA, async () => {
    const falso = montar({ browserless: () => portal([], null) });
    const r = await varrer("importar");
    igual([r.status, r.corpo.ok, r.corpo.causa_pre_protocolo], [500, false, "prova:zero_lidos_sem_prova"], "vermelha");
    igual(escritas(falso).length, 0, "sem escrita");
    const fecho = falso.de("rest:acoes_execucoes", "PATCH")[0].corpo as { status: string };
    igual(fecho.status, "erro", "ledger em erro");
  }));

Deno.test("lidos ≠ total anunciado (página perdida): vermelha, sem gravar situação", () =>
  comRelogio(QUARTA, async () => {
    const falso = montar({ browserless: () => portal([linha("2141200", "6 - Cancelado")], 2), pedidosNoApp: [NO_APP_CANCELADO] });
    const r = await varrer("importar");
    igual([r.status, r.corpo.causa_pre_protocolo], [500, "prova:lidos_diferente_do_total"], "vermelha");
    igual(falso.de("rpc:sayerlack_registrar_situacao_portal").length, 0, "nada gravado");
  }));

Deno.test("6 lido e NÃO gravado (2 tentativas): pendência do protocolo e rodada vermelha (B3)", () =>
  comRelogio(QUARTA, async () => {
    const falso = montar({
      browserless: () => portal([linha("2141200", "6 - Cancelado")]),
      pedidosNoApp: [NO_APP_CANCELADO],
      registrar: () => erroBanco("40001", "serialização"),
    });
    const r = await varrer("importar");
    igual([r.status, r.corpo.ok], [500, false], "vermelha");
    if (!String(r.corpo.mensagem).includes("situação do portal não gravada")) throw new Error(`mensagem: ${r.corpo.mensagem}`);
    igual(falso.de("rpc:sayerlack_registrar_situacao_portal").length, 2, "2 tentativas");
    const pend = falso.de("rest:sayerlack_varredura_falha", "POST").map((c) => (c.corpo as { protocolo: string }).protocolo);
    igual(pend, ["2141200"], "pendência do cancelado");
  }));

Deno.test("6 lido e gravado: rodada segue verde com a situação aceita", () =>
  comRelogio(QUARTA, async () => {
    const falso = montar({
      browserless: () => portal([linha("2141200", "6 - Cancelado")]),
      pedidosNoApp: [NO_APP_CANCELADO],
      registrar: () => ({ corpo: { aceitos: [{ pedido_id: 601, protocolo: "2141200", codigo: "6" }] } }),
    });
    const r = await varrer("importar");
    igual([r.status, r.corpo.ok], [200, true], "verde");
    igual((r.corpo.situacoes as { aceitas: number }).aceitas, 1, "aceita");
    igual(falso.de("rest:sayerlack_varredura_falha", "POST").length, 0, "sem pendência");
  }));

Deno.test("pendência fora da janela com importação sem resposta: indeterminado DURÁVEL e rodada vermelha (B6)", () =>
  comRelogio(QUARTA, async () => {
    const falso = montar({
      browserless: () => portal([]),
      falhasAbertas: [{ protocolo: "2130000", mensagem: "x", ultima_em: "2026-11-09T10:00:00Z", primeira_em: "2026-11-09T10:00:00Z", tentativas: 1, resolvido_em: null }],
      vistos: [{ protocolo: "2130000", primeira_vez_em: "2026-11-01T10:00:00Z" }],
      sync: [{ status: "complete", last_sync_at: "2026-11-11T12:50:00Z" }],
      importadora: () => ({ status: 504, corpo: "gateway timeout" }),
    });
    const r = await varrer("importar");
    const rec = (r.corpo.reconsultas as { protocolo: string; acao: string }[]).map((q) => `${q.protocolo}:${q.acao}`);
    igual(rec, ["2130000:indeterminado"], "reconsulta indeterminada");
    igual([r.status, r.corpo.ok], [500, false], "vermelha");
    if (!String(r.corpo.mensagem).includes("não sei se entraram")) throw new Error(`mensagem: ${r.corpo.mensagem}`);
    igual(falso.de(IMPORTADORA).length, 1, "uma sessão de importação");
  }));

// 8.2: o script que VAI ao Browserless é JS válido e carrega as funções de página e o laço de paginação testados
// contra HTML real (`scripts/sayerlack-portal-dom.test.ts`).
Deno.test("script do Browserless parseia e embute as funções de página do _shared (8.2)", () =>
  comRelogio(QUARTA, async () => {
    const falso = montar({});
    await varrer("listar");
    const envios = falso.de(BROWSERLESS);
    igual(envios.length >= 1, true, "chamou o Browserless");
    const code = String((envios[0].corpo as { code: string }).code);
    const fn = new Function(code.trim().replace(/^export default /, "return "))();
    igual(typeof fn, "function", "o módulo exporta a função");
    for (const nome of ["aplicarFiltrosConsultaDom", "clicarFiltrarDom", "clicarProximaPaginaDom", "lerSituacoesDom", "lerTabelaConsultaDom", "lerTodasAsPaginas"]) {
      igual(code.includes(`function ${nome}(`), true, `embute ${nome}`);
    }
  }));

// 4.3: a cota conta a importação pelo que a importadora DIZ; sem o campo é indeterminado (faixa), nunca zero.
for (const [rotulo, resposta, esperado] of [
  ["importadora abriu sessão", { corpo: { ok: false, mensagem: "x", sessao_browserless: true } },
    { importacao: 1, importacao_sem_sessao: 0, importacao_indeterminada: 0, total: 2, total_minimo: 2, total_maximo: 2 }],
  ["importadora recusou antes do portal", { corpo: { ok: false, mensagem: "x", sessao_browserless: false } },
    { importacao: 0, importacao_sem_sessao: 1, importacao_indeterminada: 0, total: 1, total_minimo: 1, total_maximo: 1 }],
  ["importadora sem o campo (timeout)", { status: 504, corpo: "gateway timeout" },
    { importacao: 0, importacao_sem_sessao: 0, importacao_indeterminada: 1, total: null, total_minimo: 1, total_maximo: 2 }],
] as const) {
  Deno.test(`4.3: sessões do Browserless — ${rotulo}`, () =>
    comRelogio(QUARTA, async () => {
      const falso = montar({
        browserless: () => portal([]),
        falhasAbertas: [{ protocolo: "2130000", mensagem: "x", ultima_em: "2026-11-09T10:00:00Z", primeira_em: "2026-11-09T10:00:00Z", tentativas: 1, resolvido_em: null }],
        vistos: [{ protocolo: "2130000", primeira_vez_em: "2026-11-01T10:00:00Z" }],
        sync: [{ status: "complete", last_sync_at: "2026-11-11T12:50:00Z" }],
        importadora: () => resposta,
      });
      const r = await varrer("importar");
      igual(falso.de(IMPORTADORA).length, 1, "uma chamada à importadora");
      igual(r.corpo.sessoes_browserless, { leitura_portal: 1, ...esperado }, "contagem da resposta");
      const fecho = falso.de("rest:acoes_execucoes", "PATCH")[0].corpo as { detalhes: Record<string, unknown> };
      igual(fecho.detalhes.sessoes_browserless, { leitura_portal: 1, ...esperado }, "contagem no ledger");
    }));
}
