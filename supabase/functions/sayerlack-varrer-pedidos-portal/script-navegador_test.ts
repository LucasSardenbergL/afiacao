// Testes do SCRIPT DO NAVEGADOR da varredura: o template que vai ao Browserless roda DE VERDADE, dentro do handler real
// (`index.ts`), contra um portal FALSO no nível da API do Puppeteer (`page.on` / `evaluate` / …). É a orquestração que
// nenhum outro teste alcançava: `varredura_test.ts` vê a decisão pura, `index_test.ts` entrega ao handler um resultado
// do Browserless já pronto, e `scripts/sayerlack-portal-dom.test.ts` vê os seletores contra HTML.
//
// Incidente (ledger `acoes_execucoes`, slug reposicao.varrer_portal_sayerlack): 6 das 20 rodadas das 22:30 SP entre
// 22/10 e 16/11/2026 gravaram `sucesso` com 0 linhas — 4 delas já com `prova_leitura='ok'` (v1.12). Em 09/11 a mesma
// rodada leu 0 linhas desde 03/11 e, 12 s depois, linhas desde 06/11 (subconjunto com linhas, superconjunto vazio).
// O script tomava como resposta da NOSSA consulta a primeira resposta de `/order-viewer/form/list` que chegasse depois
// do clique em Filtrar. A página do portal faz consultas por conta própria (filtros padrão ⇒ vazia para a OBEN); com
// uma delas ainda em voo no clique, o "0 de 0" dela virava a prova. Detalhe em
// `docs/historico/importar-pedido-portal-sayerlack.md` (v1.13).
//
// O tempo é VIRTUAL só enquanto o script roda (as esperas dele são reais: 1,5 s + 1,5 s + 0,5 s por leitura).
//
// Roda com: deno test --no-remote --allow-read=supabase/functions supabase/functions/sayerlack-varrer-pedidos-portal/
import { ENV_TESTE, igual, instalarHarness } from "../_shared/harness-handler_test.ts";
import { criarPostgrestFalso, type Resposta, type Rota } from "../_shared/postgrest-falso_test.ts";

const PORTAL = "https://portal-de-teste.invalid";
const CLIENTE = "999";

const h = instalarHarness({
  ...ENV_TESTE,
  SAYERLACK_PORTAL_USER: "usuario-de-teste",
  SAYERLACK_PORTAL_PASS: "senha-de-teste",
  SAYERLACK_PORTAL_URL: PORTAL,
  SAYERLACK_PORTAL_CLIENTE_CODIGO: CLIENTE,
  BROWSERLESS_TOKEN: "token-de-teste",
});
await import(new URL("./index.ts", import.meta.url).href);
const handler = h.handler();

const BROWSERLESS = "https://chrome.browserless.io/function";
/** Cabeçalhos como o ledger de prod os registra (`detalhes.cabecalhos`). */
const HEADERS = ["Estab", "Pedido", "Pedido Cliente", "Cliente", "Situação", "Data Emissão", "Data Entrega", "Vlr Mercadoria", "Vlr Total", "Ações"];

type Linha = Record<string, string>;
function linha(pedido: string, situacao: string, emissao = "10/11/2026"): Linha {
  return {
    "Estab": "CAJ", "Pedido": pedido, "Pedido Cliente": pedido, "Cliente": "OBEN COMERCIO LTDA", "Situação": situacao,
    "Data Emissão": emissao, "Data Entrega": "26/11/2026", "Vlr Mercadoria": "100,0000", "Vlr Total": "106,5000", "Ações": "",
  };
}
const DUAS = [linha("2148220", "1 - Aberto"), linha("2148223", "1 - Aberto")];
/** O que OUTRO filtro traria: 2 pedidos antigos, cancelados — e que existem no app (abaixo). */
const ALHEIAS = [linha("2099001", "6 - Cancelado", "01/10/2026"), linha("2099002", "6 - Cancelado", "02/10/2026")];
/**
 * Os pedidos das linhas alheias EXISTEM no app, com PO: se a rodada aceitasse a lista alheia, gravaria o "6 - Cancelado"
 * deles (o veto de compra). É o que dá dente à asserção "nenhuma situação gravada" — sem isto ela passaria sempre.
 */
const NO_APP_DAS_ALHEIAS = ALHEIAS.map((l, i) => ({
  id: 900 + i, portal_protocolo: l.Pedido, status: "enviado", omie_pedido_compra_id: String(9900 + i),
  atualizado_em: "2026-10-05T12:00:00Z", enviado_portal_em: "2026-10-05T12:00:00Z", portal_data_entrega: "2026-10-20",
}));

// ── Relógio ────────────────────────────────────────────────────────────────────────────────────────────────────────

/** Quarta 11/11/2026, 10:00 em SP: portal aberto (a rodada pula sábado 12h → segunda 6h). */
const QUARTA = "2026-11-11T13:00:00.000Z";

function comRelogio<T>(iso: string, fn: () => Promise<T>): Promise<T> {
  const DateReal = Date;
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

/**
 * Roda `fn` com `setTimeout` e `Date` VIRTUAIS: o relógio só anda quando não sobra nada a fazer no instante atual, e
 * sempre para o próximo timer agendado. A ordem dos eventos é a dos tempos declarados no cenário — não a da máquina.
 * Espera que nunca termina e não agenda nada LANÇA (o teste falha alto em vez de pendurar).
 */
async function comTempoVirtual<T>(fn: () => Promise<T>): Promise<T> {
  const real = { setTimeout: globalThis.setTimeout, clearTimeout: globalThis.clearTimeout, Date: globalThis.Date };
  let agora = real.Date.now();
  let seq = 0;
  const fila: { quando: number; seq: number; disparar: () => void }[] = [];
  globalThis.setTimeout = ((cb: (...a: unknown[]) => void, ms?: number, ...args: unknown[]) => {
    seq += 1;
    fila.push({ quando: agora + Math.max(0, Number(ms) || 0), seq, disparar: () => cb(...args) });
    return seq;
  }) as unknown as typeof setTimeout;
  globalThis.clearTimeout = ((id?: number) => {
    const i = fila.findIndex((t) => t.seq === id);
    if (i >= 0) fila.splice(i, 1);
  }) as typeof clearTimeout;
  const DateBase = real.Date;
  class DateVirtual extends DateBase {
    constructor(...a: unknown[]) {
      if (a.length === 0) super(agora);
      else super(...(a as [string]));
    }
    static override now() {
      return agora;
    }
  }
  globalThis.Date = DateVirtual as DateConstructor;

  const fim: { desfecho: { ok: true; valor: T } | { ok: false; erro: unknown } | null } = { desfecho: null };
  fn().then((valor) => { fim.desfecho = { ok: true, valor }; }, (erro) => { fim.desfecho = { ok: false, erro }; });
  // Um macrotask REAL esvazia toda a fila de promessas do instante virtual atual.
  const respiro = () => new Promise<void>((r) => real.setTimeout(r, 0));
  try {
    let ociosos = 0;
    while (!fim.desfecho) {
      await respiro();
      if (fim.desfecho) break;
      fila.sort((a, b) => a.quando - b.quando || a.seq - b.seq);
      const proximo = fila.shift();
      if (!proximo) {
        ociosos += 1;
        if (ociosos > 20) throw new Error("tempo virtual: nada agendado e o script não terminou (espera sem fim)");
        continue;
      }
      ociosos = 0;
      agora = Math.max(agora, proximo.quando);
      proximo.disparar();
    }
  } finally {
    globalThis.setTimeout = real.setTimeout;
    globalThis.clearTimeout = real.clearTimeout;
    globalThis.Date = real.Date;
  }
  const d = fim.desfecho as { ok: true; valor: T } | { ok: false; erro: unknown };
  if (!d.ok) throw d.erro;
  return d.valor;
}

// ── Portal falso (o que a página do portal faz, visto pela API do Puppeteer) ────────────────────────────────────────

interface CenarioPortal {
  /** O que o portal devolve para o NOSSO filtro (cliente OBEN, Exibir = Pedido, emissão pedida). */
  linhas: Linha[];
  /** Latência (ms) da resposta à consulta que o NOSSO clique gera. Default 250. */
  msResposta?: number;
  /**
   * Consulta que a PÁGINA faz sozinha, com os filtros que estiverem no formulário na hora (padrão do portal ⇒ vazia
   * para a OBEN): ao abrir a tela, ou quando o campo cliente muda. `ms` = quanto ela demora a responder.
   */
  propria?: { quando: "abrir" | "trocar_cliente"; ms: number };
  /** Clique em Filtrar com consulta ainda em voo: o botão não faz nada ("engolido") ou dispara outra ("envia"). */
  cliqueComConsultaEmVoo?: "engolido" | "envia";
  /** Nº do clique em Filtrar (1 = o primeiro) em que a página faz, além da nossa, uma consulta avulsa com os filtros padrão, que chega depois da nossa. */
  consultaAvulsaNoClique?: number;
  /** Nº do clique em Filtrar em que o portal responde VAZIO à nossa própria consulta (tropeço passageiro do portal). */
  vazioNoClique?: number;
  /** O portal responde à NOSSA consulta com o envelope de erro dele (`success:false`, lista e totais zerados). */
  erroDoPortal?: boolean;
  /** O botão Filtrar não dispara consulta nenhuma, nunca. */
  cliqueInerte?: boolean;
  /** Linhas por página da tabela (paginação no servidor). Default: tudo numa página. */
  porPagina?: number;
  /** O que o portal devolve para os filtros que NÃO são os nossos (default: nada — é o que a OBEN vê em prod). */
  linhasAlheias?: Linha[];
  /** Nº do clique em Filtrar em que a página dispara uma consulta avulsa (filtros padrão) ANTES da nossa, respondendo em 100 ms. */
  avulsaAntesDaNossaNoClique?: number;
  /** Nº do clique em Filtrar cuja consulta o portal responde com o envelope de erro (só naquele clique). */
  erroNoClique?: number;
  /** Nº do clique em Filtrar em que a página, em vez da nossa consulta, faz só uma com os filtros padrão. */
  cliqueViraAvulsaNoClique?: number;
  /** Todo clique em Filtrar vira uma consulta com a emissão padrão e a NOSSA data no campo da ENTREGA. */
  cliqueLevaNossaDataNaEntrega?: boolean;
  /** O clique em "próxima" é respondido por uma consulta com os filtros padrão (outra lista), não pela nossa página 2. */
  proximaViraAvulsa?: boolean;
  /** A resposta que o navegador entrega não tem `text()` (API diferente da esperada): o ouvinte do script lança. */
  respostaSemTexto?: boolean;
  /** O portal manda as linhas em `aaData` e o total em `iTotalDisplayRecords` (DataTables antigo): não há campo `data`. */
  formatoAntigo?: boolean;
  /** O pedido da consulta AVULSA não deixa ler a URL (`url()` lança): o ouvinte do script falha antes de registrá-la. */
  avulsaInobservavel?: boolean;
  /** O pedido não expõe o corpo (o Puppeteer devolve `undefined` em `postData()`): não dá para ler o filtro que ele leva. */
  corpoIlegivel?: boolean;
}

type Filtros = Record<string, string>;
/** Formulário como o portal o entrega: sem cliente, Exibir = Proposta, último mês. */
const FILTROS_PADRAO: Filtros = { cliente: "", situacao: "todos", exibir: "0", ini: "", fim: "", emissao: "2026-10-11", entrega: "2026-10-11" };

class PedidoFalso {
  constructor(readonly filtros: Filtros, private readonly corpoIlegivel = false, private readonly inobservavel = false) {}
  url() {
    if (this.inobservavel) throw new Error("pedido sem URL legível");
    return `${PORTAL}/order-viewer/form/list`;
  }
  method() { return "POST"; }
  /** Formulário urlencoded, como o DataTables manda: o boilerplate dele + os campos do formulário pelos nomes da tela. */
  postData() {
    if (this.corpoIlegivel) return undefined;
    const f = this.filtros;
    return new URLSearchParams({
      draw: "1", start: String(Number(f.pagina ?? "0") * 50), length: "50", "columns[4][data]": "situacao", "search[value]": "",
      cliente: f.cliente, situacao: f.situacao, exibir: f.exibir, num_ped_ini: f.ini, num_ped_fim: f.fim,
      data_emissao_ini: f.emissao, data_emissao_fim: "2026-11-11", data_entrega_ini: f.entrega,
    }).toString();
  }
}

class RespostaFalsa {
  constructor(private readonly pedido: PedidoFalso, private readonly corpo: unknown, semTexto = false) {
    if (semTexto) (this as { text?: unknown }).text = undefined;
  }
  request() { return this.pedido; }
  url() { return `${PORTAL}/order-viewer/form/list`; }
  status() { return 200; }
  json() { return Promise.resolve(this.corpo); }
  text() { return Promise.resolve(JSON.stringify(this.corpo)); }
}

function criarPaginaFalsa(c: CenarioPortal, ctx: { clienteCodigo: string; emissaoDesde: string }) {
  const ouvintes = new Map<string, ((x: unknown) => void)[]>();
  const emitir = (evento: string, x: unknown) => { for (const f of ouvintes.get(evento) ?? []) f(x); };
  const esperasDeResposta: { pred: (r: RespostaFalsa) => boolean; resolver: (r: RespostaFalsa) => void }[] = [];
  let url = "about:blank";
  let filtros: Filtros = { ...FILTROS_PADRAO };
  let tabela: Linha[] = [];
  let paginaNaTela = 0;
  let temProxima = false;
  let emVoo = 0;
  let cliques = 0;

  /** O portal: só o NOSSO filtro tem pedido; os filtros padrão não trazem nada para a OBEN. */
  const corpoDaResposta = (f: Filtros, vazio: boolean, erro: boolean) => {
    const nosso = f.cliente === ctx.clienteCodigo && f.exibir === "1" && f.emissao === ctx.emissaoDesde;
    if (nosso && (c.erroDoPortal || erro)) return { success: false, message: "Erro ao consultar pedidos", data: [] as Linha[], recordsTotal: 0, recordsFiltered: 0 };
    const linhas = nosso ? (vazio ? [] : c.linhas) : (c.linhasAlheias ?? []);
    return { success: true, message: "", data: linhas, recordsTotal: 500, recordsFiltered: linhas.length };
  };

  /** Uma consulta da página: pedido agora, resposta `ms` depois. A resposta não ecoa `draw`, então a tabela mostra a ÚLTIMA que chegar. */
  const consultar = (f: Filtros, ms: number, vazio = false, pagina = 0, erro = false) => {
    const avulsa = f.cliente !== ctx.clienteCodigo || f.exibir !== "1" || f.emissao !== ctx.emissaoDesde;
    const pedido = new PedidoFalso({ ...f, pagina: String(pagina) }, c.corpoIlegivel, avulsa && c.avulsaInobservavel);
    emVoo += 1;
    emitir("request", pedido);
    setTimeout(() => {
      // Paginação no servidor: o corpo traz só a página pedida; `recordsFiltered` é o total do filtro.
      const inteiro = corpoDaResposta(pedido.filtros, vazio, erro);
      const tamanho = c.porPagina ?? Math.max(inteiro.data.length, 1);
      const corpo = { ...inteiro, data: inteiro.data.slice(pagina * tamanho, (pagina + 1) * tamanho) };
      // O que o portal manda: o corpo como está, ou no formato antigo do DataTables (linhas em aaData, sem `data`).
      const mandado = c.formatoAntigo
        ? { success: corpo.success, message: corpo.message, aaData: corpo.data, iTotalRecords: corpo.recordsTotal, iTotalDisplayRecords: corpo.recordsFiltered }
        : corpo;
      const resposta = new RespostaFalsa(pedido, mandado, c.respostaSemTexto);
      for (const e of esperasDeResposta.filter((x) => x.pred(resposta))) {
        esperasDeResposta.splice(esperasDeResposta.indexOf(e), 1);
        e.resolver(resposta);
      }
      emitir("response", resposta);
      tabela = corpo.data;
      paginaNaTela = pagina;
      temProxima = (pagina + 1) * tamanho < inteiro.data.length;
      emVoo -= 1;
      emitir("requestfinished", pedido);
    }, ms);
  };

  const clicarFiltrar = () => {
    if (c.cliqueInerte) return;
    if (emVoo > 0 && c.cliqueComConsultaEmVoo === "engolido") return;
    cliques += 1;
    const ms = c.msResposta ?? 250;
    if (c.cliqueLevaNossaDataNaEntrega) {
      consultar({ ...FILTROS_PADRAO, entrega: ctx.emissaoDesde }, ms);
      return;
    }
    if (c.cliqueViraAvulsaNoClique === cliques) {
      consultar(FILTROS_PADRAO, ms);
      return;
    }
    if (c.avulsaAntesDaNossaNoClique === cliques) consultar(FILTROS_PADRAO, 100);
    consultar(filtros, ms, c.vazioNoClique === cliques, 0, c.erroNoClique === cliques);
    if (c.consultaAvulsaNoClique === cliques) consultar(FILTROS_PADRAO, ms + 400);
  };

  const ok = () => Promise.resolve(null);
  const page = {
    on(evento: string, f: (x: unknown) => void) {
      ouvintes.set(evento, [...(ouvintes.get(evento) ?? []), f]);
    },
    setUserAgent: ok, setViewport: ok, setExtraHTTPHeaders: ok, click: ok, type: ok,
    waitForSelector: ok, waitForFunction: ok, waitForNavigation: ok,
    screenshot: () => Promise.resolve("jpeg-falso"),
    goto(destino: string) {
      url = destino;
      return ok();
    },
    url: () => url,
    waitForResponse(pred: (r: RespostaFalsa) => boolean, opcoes?: { timeout?: number }) {
      return new Promise<RespostaFalsa>((resolver, rejeitar) => {
        const espera = { pred, resolver };
        esperasDeResposta.push(espera);
        setTimeout(() => {
          const i = esperasDeResposta.indexOf(espera);
          if (i < 0) return;
          esperasDeResposta.splice(i, 1);
          rejeitar(new Error(`Waiting failed: ${opcoes?.timeout ?? 30000}ms exceeded`));
        }, opcoes?.timeout ?? 30000);
      });
    },
    // Dentro do navegador real, `evaluate` roda a função na página. Aqui cada função é reconhecida pelo NOME (as do
    // `_shared/sayerlack-portal-dom.ts`) ou por um trecho do corpo (as anônimas do login) e respondida pelo portal falso.
    evaluate(fn: unknown, ...args: unknown[]) {
      const nome = typeof fn === "function" ? fn.name : "";
      const fonte = String(fn);
      if (nome === "lerSituacoesDom") return Promise.resolve([{ valor: "1", texto: "Aberto" }, { valor: "todos", texto: "Todos" }]);
      if (nome === "aplicarFiltrosConsultaDom") {
        const [cod, ini, fim, emissao] = args.map(String);
        const trocouCliente = filtros.cliente !== cod;
        // A página reage à troca do cliente ANTES de os outros campos mudarem: a consulta dela leva os filtros padrão.
        if (trocouCliente && c.propria?.quando === "trocar_cliente") consultar({ ...filtros, cliente: cod }, c.propria.ms);
        filtros = { cliente: cod, situacao: "todos", exibir: "1", ini, fim, emissao, entrega: "2020-01-01" };
        return Promise.resolve({
          set: { cliente: true, situacao: true, exibir: true, ini: true, fim: true, emissao: true, entrega: true },
          cliente: filtros.cliente, exibir: filtros.exibir, situacao: filtros.situacao, emissao: filtros.emissao,
          emissaoFim: "2026-11-11", ini: filtros.ini, fim: filtros.fim,
        });
      }
      if (nome === "clicarFiltrarDom") {
        clicarFiltrar();
        return ok();
      }
      if (nome === "clicarProximaPaginaDom") {
        if (temProxima) consultar(c.proximaViraAvulsa ? FILTROS_PADRAO : filtros, c.msResposta ?? 250, false, paginaNaTela + 1);
        return ok();
      }
      if (nome === "lerTabelaConsultaDom") {
        // Como em prod: sem texto de info, sem total da instância DataTables e sem indicador de "processando".
        return Promise.resolve({ ok: true, headers: HEADERS, linhas: [...tabela], processando: false, info: null, temProxima, dtTotal: null });
      }
      if (fonte.includes("dispatchEvent(new Event('input'")) return ok(); // limpar o campo antes de digitar
      if (fonte.includes("includes('Entrar')")) {
        url = `${PORTAL}/home`;
        return Promise.resolve(true);
      }
      if (fonte.includes("app-sidebar-minified")) return ok();
      if (fonte.includes("camposSenha")) return Promise.resolve({ url, menuLinks: 11, camposSenha: 0, titulo: "Portal", texto: "Bem-vindo" });
      if (fonte.includes("endsWith('/order-viewer')")) {
        url = `${PORTAL}/order-viewer`;
        filtros = { ...FILTROS_PADRAO };
        tabela = [];
        if (c.propria?.quando === "abrir") consultar(filtros, c.propria.ms);
        return Promise.resolve(true);
      }
      return Promise.reject(new Error(`página falsa: evaluate não previsto — ${fonte.slice(0, 90)}`));
    },
  };
  return page;
}

// ── Handler real + Browserless que EXECUTA o script ───────────────────────────────────────────────────────────────

function montar(c: CenarioPortal) {
  const rotas: Record<string, Rota> = {
    "POST rest:acoes_execucoes": () => ({ status: 201, corpo: [{ id: "exec-1" }] }),
    "PATCH rest:acoes_execucoes": () => ({ status: 204, corpo: null }),
    // Pedidos do app por protocolo: só os das linhas alheias existem (a leitura de pedidos em voo vem vazia).
    "GET rest:pedido_compra_sugerido": (ch) =>
      ({ corpo: (ch.params.get("portal_protocolo") ?? "").includes(ALHEIAS[0].Pedido) ? NO_APP_DAS_ALHEIAS : [] }),
    "rpc:sayerlack_registrar_situacao_portal": () => ({ corpo: { aceitos: [], ignorados: 0 } }),
    "rpc:sayerlack_cobertura_situacao_portal": () => ({ corpo: [] }),
    [BROWSERLESS]: async (ch): Promise<Resposta> => {
      const { code, context } = ch.corpo as { code: string; context: { clienteCodigo: string; emissaoDesde: string } };
      const script = new Function(code.trim().replace(/^export default /, "return "))() as
        (a: { page: unknown; context: unknown }) => Promise<unknown>;
      const page = criarPaginaFalsa(c, context);
      return { corpo: await comTempoVirtual(() => script({ page, context })) };
    },
    "*": (ch) => (ch.metodo === "GET" ? { corpo: [] } : ch.metodo === "POST" && ch.rota.startsWith("rpc:") ? { corpo: null } : { status: 201, corpo: [] }),
  };
  const falso = criarPostgrestFalso(ENV_TESTE.SUPABASE_URL, rotas);
  h.responderForaDoGate((r) => falso.responder(r));
  return falso;
}

/** Uma rodada do CRON (modo importar) contra o portal falso: a resposta do handler e o que ficou no ledger. */
function rodada(c: CenarioPortal) {
  return comRelogio(QUARTA, async () => {
    const falso = montar(c);
    const resp = await handler(new Request("https://edge.invalid/", {
      method: "POST",
      headers: { "x-cron-secret": ENV_TESTE.CRON_SECRET, "Content-Type": "application/json" },
      body: JSON.stringify({ modo: "importar" }),
    }));
    const corpo = await resp.json() as Record<string, unknown>;
    const abertura = falso.de("rest:acoes_execucoes", "POST")[0].corpo as { acao: string };
    const fecho = falso.de("rest:acoes_execucoes", "PATCH")[0].corpo as { status: string; detalhes: Record<string, unknown> };
    return { status: resp.status, corpo, acao: abertura.acao, ledger: fecho, situacoesGravadas: falso.de("rpc:sayerlack_registrar_situacao_portal").length };
  });
}

/** O que a rodada disse da leitura, no formato em que o vigia do data_health e o painel leem o ledger. */
function leitura(r: Awaited<ReturnType<typeof rodada>>) {
  const d = r.ledger.detalhes;
  return {
    status: r.ledger.status, prova_leitura: d.prova_leitura ?? null, linhas_lidas: d.linhas_lidas ?? null,
    total_anunciado: d.total_anunciado ?? null, causa: d.causa_pre_protocolo ?? null,
  };
}
const LEITURA_FALHOU = { status: "erro", prova_leitura: null, linhas_lidas: null, total_anunciado: null };

// ── Controle: portal saudável ──────────────────────────────────────────────────────────────────────────────────────

Deno.test("controle — página quieta no clique: lê as 2 linhas na 1ª tentativa, com a resposta do NOSSO clique", async () => {
  const r = await rodada({ linhas: DUAS, propria: { quando: "abrir", ms: 200 } });
  igual(r.acao, "reposicao.varrer_portal_sayerlack", "slug do cron");
  igual(leitura(r), { status: "sucesso", prova_leitura: "ok", linhas_lidas: 2, total_anunciado: 2, causa: null }, "leitura provada");
  const consultas = r.ledger.detalhes.consultas_portal as Record<string, unknown>;
  igual([consultas.tentativa, consultas.em_voo_antes, consultas.assentou, consultas.depois], [1, 0, true, 1], "sem consulta em voo no clique");
  igual([r.ledger.detalhes.filtro_no_pedido, r.ledger.detalhes.resposta_sucesso], [true, true], "o pedido do clique levava o nosso filtro e o portal afirmou sucesso");
  igual(r.ledger.detalhes.linhas_na_resposta, 2, "as 2 linhas lidas na tabela têm o nº no corpo da resposta do clique (medida)");
  // A linha do tempo no ledger: a consulta da própria página (filtros padrão) e a do nosso clique.
  igual((consultas.linha_do_tempo as Record<string, unknown>[]).map((x) => [x.n, x.do_clique, x.filtro, x.total]), [[1, false, false, 0], [2, true, true, 2]], "quem consultou o quê");
});

Deno.test("controle — lista em 2 páginas: cada clique em 'próxima' espera a resposta do PRÓPRIO pedido e a lista inteira prova", async () => {
  const r = await rodada({ linhas: [...DUAS, linha("2148912", "1 - Aberto")], porPagina: 2, propria: { quando: "abrir", ms: 200 } });
  igual(leitura(r), { status: "sucesso", prova_leitura: "ok", linhas_lidas: 3, total_anunciado: 3, causa: null }, "3 linhas em 2 páginas");
  igual(r.ledger.detalhes.paginas, 2, "leu as 2 páginas");
});

const QUATRO = [...DUAS, linha("2148912", "1 - Aberto"), linha("2149764", "1 - Aberto")];
const QUATRO_ALHEIAS = [...ALHEIAS, linha("2099003", "6 - Cancelado", "03/10/2026"), linha("2099004", "6 - Cancelado", "04/10/2026")];

Deno.test("paginação: a 'próxima' respondida por OUTRA consulta, com o mesmo total, não entra na lista — recusada (Codex rodada 2)", async () => {
  // 1ª página nossa (2 de 4). A "próxima" traz 2 de 4 de outra lista: mesma contagem, outro filtro.
  const r = await rodada({ linhas: QUATRO, porPagina: 2, proximaViraAvulsa: true, linhasAlheias: QUATRO_ALHEIAS });
  igual(leitura(r), { ...LEITURA_FALHOU, causa: "leitura:PAGINACAO_SEM_RESPOSTA" }, "página de outra consulta não completa a nossa lista");
  igual([String(r.corpo.mensagem).includes("levava outro filtro"), r.situacoesGravadas], [true, 0], "o motivo vai na mensagem; nada gravado");
});

Deno.test("paginação: sem dar para ler o filtro, a 'próxima' que anuncia OUTRO total também é recusada", async () => {
  const r = await rodada({ linhas: QUATRO, porPagina: 2, proximaViraAvulsa: true, linhasAlheias: [...QUATRO_ALHEIAS, linha("2099005", "6 - Cancelado", "05/10/2026")], corpoIlegivel: true });
  igual(leitura(r), { ...LEITURA_FALHOU, causa: "leitura:PAGINACAO_SEM_RESPOSTA" }, "total que muda no meio não é a mesma consulta");
  igual([String(r.corpo.mensagem).includes("anunciou 5 e a 1ª 4"), r.situacoesGravadas], [true, 0], "o motivo vai na mensagem; nada gravado");
});

// ── O incidente: consulta da PRÓPRIA página ainda em voo no nosso clique ───────────────────────────────────────────
// A resposta dela chega 48 ms depois do clique (medido em prod, 10/11 22:31:32 SP: 48 ms contra 214–502 ms das 20
// respostas legítimas). Antes: "0 de 0" provado. Agora: espera a página se aquietar e lê as linhas de verdade.

for (const [quando, clique, msResposta] of [
  ["abrir", "engolido", 250],
  ["abrir", "envia", 5000],
  ["trocar_cliente", "engolido", 250],
  ["trocar_cliente", "envia", 5000],
] as const) {
  Deno.test(`incidente 22:30 — consulta da página (${quando}) em voo no clique, clique ${clique}: lê as linhas, nunca "0 de 0"`, async () => {
    // "abrir": pedida ~0 ms depois de a tela abrir; o clique sai 1.500 ms depois dos filtros ⇒ 1.548 ms = +48 ms.
    const r = await rodada({ linhas: DUAS, msResposta, propria: { quando, ms: 1548 }, cliqueComConsultaEmVoo: clique });
    igual(leitura(r), { status: "sucesso", prova_leitura: "ok", linhas_lidas: 2, total_anunciado: 2, causa: null }, "leu as linhas do nosso filtro");
    const consultas = r.ledger.detalhes.consultas_portal as Record<string, unknown>;
    igual([consultas.tentativa, consultas.em_voo_antes, consultas.assentou, consultas.depois], [1, 1, true, 1], "esperou a consulta da página e bastou 1 clique");
  });
}

Deno.test("consulta da página pendurada além da espera, clique engolido: a resposta dela NÃO vale pela nossa — 2ª tentativa lê as linhas", async () => {
  // 60 s: passa dos 20 s de espera pela página; chega no meio dos 45 s em que o script aguarda a resposta do clique.
  const r = await rodada({ linhas: DUAS, propria: { quando: "abrir", ms: 60_000 }, cliqueComConsultaEmVoo: "engolido" });
  igual(leitura(r), { status: "sucesso", prova_leitura: "ok", linhas_lidas: 2, total_anunciado: 2, causa: null }, "leu as linhas do nosso filtro");
  igual((r.ledger.detalhes.consultas_portal as Record<string, unknown>).tentativa, 2, "o 1º clique não gerou consulta; o 2º sim");
});

// ── 0 linhas: só com a consulta repetida ───────────────────────────────────────────────────────────────────────────

Deno.test("0 linhas de verdade: a consulta repetida responde 0 de novo — verde, com a repetição no ledger", async () => {
  const r = await rodada({ linhas: [] });
  igual(leitura(r), { status: "sucesso", prova_leitura: "ok", linhas_lidas: 0, total_anunciado: 0, causa: null }, "0 de 0 provado");
  igual(r.ledger.detalhes.zero_repetido, { linhas: 0, total: 0, sucesso: true, filtro: true }, "a 2ª consulta também respondeu 0");
});

Deno.test("0 linhas porque o portal respondeu vazio à NOSSA consulta uma vez: repetida traz 2 — VERMELHA (zero_nao_confirmado)", async () => {
  const r = await rodada({ linhas: DUAS, vazioNoClique: 1 });
  igual(leitura(r), { status: "erro", prova_leitura: "zero_nao_confirmado", linhas_lidas: 0, total_anunciado: 0, causa: "prova:zero_nao_confirmado" }, "0 que não se repete não prova nada");
  igual([r.status, r.ledger.detalhes.zero_repetido], [500, { linhas: 2, total: 2, sucesso: true, filtro: true }], "o que a repetição trouxe fica no ledger");
});

Deno.test("0 linhas por tropeço e a REPETIÇÃO respondendo erro com a lista zerada: o erro não confirma o zero — VERMELHA (Codex P0)", async () => {
  const r = await rodada({ linhas: DUAS, vazioNoClique: 1, erroNoClique: 2 });
  igual(leitura(r), { status: "erro", prova_leitura: "zero_lidos_sem_prova", linhas_lidas: 0, total_anunciado: 0, causa: "prova:zero_lidos_sem_prova" }, "repetição que é erro não é confirmação");
  igual(r.ledger.detalhes.zero_repetido, { linhas: 0, total: 0, sucesso: false, filtro: true }, "o que a repetição disse fica no ledger");
});

// ── Outra consulta da página em volta do nosso clique: a tabela e o total têm de ser os da NOSSA ───────────────────

Deno.test("consulta avulsa da página chega depois da nossa e ESVAZIA a tabela: leitura recusada — o 0 de 0 dela não vale", async () => {
  const r = await rodada({ linhas: DUAS, consultaAvulsaNoClique: 1 });
  igual(leitura(r), { ...LEITURA_FALHOU, causa: "leitura:CONSULTA_ILEGIVEL" }, "tabela disputada não é leitura");
  const vistas = r.ledger.detalhes.consultas_portal as { depois: number; linha_do_tempo: Record<string, unknown>[] };
  // A resposta que derrubou a leitura chegou DEPOIS do nosso clique: o ledger tem de trazê-la já com o desfecho.
  igual([vistas.depois, vistas.linha_do_tempo.map((x) => [x.do_clique, x.filtro, x.total, x.respondida_ms !== null])],
    [2, [[true, true, 2, true], [false, false, 0, true]]], "a nossa e a avulsa, as duas com o que responderam");
});

Deno.test("avulsa DEPOIS da nossa com a MESMA contagem e outras linhas: contagem igual não prova — recusada, nada gravado (Codex P0)", async () => {
  // Nossa resposta: 2 linhas aos 250 ms. A avulsa sobrescreve a tabela aos 650 ms com 2 linhas de OUTRO filtro.
  const r = await rodada({ linhas: DUAS, consultaAvulsaNoClique: 1, linhasAlheias: ALHEIAS });
  igual(leitura(r), { ...LEITURA_FALHOU, causa: "leitura:CONSULTA_ILEGIVEL" }, "2 lidas = 2 anunciadas, mas as linhas não são as da nossa resposta");
  igual(r.situacoesGravadas, 0, "nenhuma situação gravada a partir de linha alheia");
});

Deno.test("avulsa DEPOIS da nossa, mesma contagem, e o portal sem campo `data` (linhas em aaData): a impressão é do corpo inteiro — recusada (Codex rodada 3)", async () => {
  const r = await rodada({ linhas: DUAS, consultaAvulsaNoClique: 1, linhasAlheias: ALHEIAS, formatoAntigo: true });
  igual(leitura(r), { ...LEITURA_FALHOU, causa: "leitura:CONSULTA_ILEGIVEL" }, "duas respostas de total 2 e linhas diferentes não são a mesma resposta");
  igual(r.situacoesGravadas, 0, "nenhuma situação gravada a partir de linha alheia");
});

Deno.test("controle — portal sem campo `data` (linhas em aaData), sem consulta avulsa: lê as 2 linhas", async () => {
  const r = await rodada({ linhas: DUAS, formatoAntigo: true });
  igual(leitura(r), { status: "sucesso", prova_leitura: "ok", linhas_lidas: 2, total_anunciado: 2, causa: null }, "o formato antigo também prova");
});

Deno.test("consulta avulsa que o script não consegue OBSERVAR (o ouvinte falha antes de registrá-la): a leitura não vale (Codex rodada 3)", async () => {
  // A avulsa sobrescreve a tabela aos 650 ms com 2 linhas alheias; o rastreio nem sabe que ela existiu.
  const r = await rodada({ linhas: DUAS, consultaAvulsaNoClique: 1, linhasAlheias: ALHEIAS, avulsaInobservavel: true });
  igual(leitura(r), { ...LEITURA_FALHOU, causa: "leitura:CONSULTA_NAO_OBSERVADA" }, "erro de observação invalida a leitura inteira");
  igual([r.situacoesGravadas, String((r.ledger.detalhes.consultas_portal as { ouvinte_erro?: string }).ouvinte_erro)], [0, "pedido sem URL legível"], "nada gravado; o porquê no ledger");
});

Deno.test("avulsa ANTES da nossa, com linhas: o 1º pedido depois do clique não levava o nosso filtro — recusada (Codex P0)", async () => {
  // A avulsa responde 2 linhas alheias em 100 ms; a nossa demora 3 s.
  const r = await rodada({ linhas: DUAS, msResposta: 3000, avulsaAntesDaNossaNoClique: 1, linhasAlheias: ALHEIAS });
  igual(leitura(r), { ...LEITURA_FALHOU, causa: "leitura:CONSULTA_ILEGIVEL" }, "a resposta rápida e alheia não vale pela nossa");
  igual(r.situacoesGravadas, 0, "nenhuma situação gravada a partir de linha alheia");
  const tempo = (r.ledger.detalhes.consultas_portal as { linha_do_tempo: Record<string, unknown>[] }).linha_do_tempo;
  igual(tempo.map((x) => [x.do_clique, x.filtro]), [[true, false], [false, true]], "o ledger mostra que o pedido do clique levava outro filtro");
});

Deno.test("só uma consulta avulsa responde ao clique, com linhas: o pedido mostra datas e nenhuma é a nossa — recusada (Codex P0)", async () => {
  const r = await rodada({ linhas: DUAS, cliqueViraAvulsaNoClique: 1, linhasAlheias: ALHEIAS });
  igual(leitura(r), { status: "erro", prova_leitura: "resposta_sem_vinculo", linhas_lidas: 2, total_anunciado: 2, causa: "prova:resposta_sem_vinculo" }, "2 lidas = 2 anunciadas, de OUTRO filtro");
  igual([r.ledger.detalhes.filtro_no_pedido, r.situacoesGravadas], [false, 0], "o pedido do clique levava outro filtro; nada gravado");
});

Deno.test("a única consulta que responde leva a NOSSA data no campo errado (entrega) e vem vazia, 2 vezes: não é 0 de 0 nosso (Codex rodada 2)", async () => {
  const r = await rodada({ linhas: DUAS, cliqueLevaNossaDataNaEntrega: true });
  igual(leitura(r), { status: "erro", prova_leitura: "resposta_sem_vinculo", linhas_lidas: 0, total_anunciado: 0, causa: "prova:resposta_sem_vinculo" }, "achar a data no pedido não é levar o nosso filtro");
  igual(r.ledger.detalhes.filtro_no_pedido, false, "a emissão do pedido era outra");
});

Deno.test("avulsa ANTES da nossa e pedido sem corpo legível: quem segura é não ler a tabela com consulta em voo — recusada", async () => {
  // Sem o corpo não dá para saber que o 1º pedido é alheio; a nossa, ainda em voo, vai mexer na tabela.
  const r = await rodada({ linhas: DUAS, msResposta: 3000, avulsaAntesDaNossaNoClique: 1, linhasAlheias: ALHEIAS, corpoIlegivel: true });
  igual(leitura(r), { ...LEITURA_FALHOU, causa: "leitura:CONSULTA_ILEGIVEL" }, "tabela disputada não é leitura");
  igual(r.situacoesGravadas, 0, "nenhuma situação gravada a partir de linha alheia");
});

Deno.test("controle do dente: a MESMA lista de cancelados, quando é a resposta do nosso filtro, grava as situações", async () => {
  const r = await rodada({ linhas: ALHEIAS });
  igual(leitura(r).prova_leitura, "ok", "lista provada");
  igual(r.situacoesGravadas, 1, "os cancelados do app foram gravados — é o que as recusas acima impedem");
});

// ── O que o pedido levava não dá para ler: com linhas segue valendo; 0 linhas não ────────────────────────────────

Deno.test("pedido sem corpo legível: com linhas a leitura vale (e o ledger diz que não deu para saber); com 0 linhas, VERMELHA", async () => {
  const cheia = await rodada({ linhas: DUAS, corpoIlegivel: true });
  igual(leitura(cheia), { status: "sucesso", prova_leitura: "ok", linhas_lidas: 2, total_anunciado: 2, causa: null }, "linhas lidas provam");
  igual(cheia.ledger.detalhes.filtro_no_pedido, null, "não deu para saber ≠ levava");
  const vazia = await rodada({ linhas: [], corpoIlegivel: true });
  igual(leitura(vazia), { status: "erro", prova_leitura: "zero_lidos_sem_prova", linhas_lidas: 0, total_anunciado: 0, causa: "prova:zero_lidos_sem_prova" }, "0 linhas sem saber o filtro não prova");
});

Deno.test("0 linhas com o envelope de ERRO do portal (success:false): VERMELHA, com a mensagem do portal no ledger", async () => {
  const r = await rodada({ linhas: DUAS, erroDoPortal: true });
  igual(leitura(r), { status: "erro", prova_leitura: "zero_lidos_sem_prova", linhas_lidas: 0, total_anunciado: 0, causa: "prova:zero_lidos_sem_prova" }, "erro do portal não é 0 de 0");
  igual([r.ledger.detalhes.resposta_sucesso, r.ledger.detalhes.resposta_mensagem], [false, "Erro ao consultar pedidos"], "o que o portal disse");
});

Deno.test("ouvinte de evento que LANÇA não derruba o script: a leitura falha fechada e o erro vai ao ledger", async () => {
  const r = await rodada({ linhas: DUAS, respostaSemTexto: true });
  igual([r.ledger.status, r.ledger.detalhes.causa_pre_protocolo], ["erro", "leitura:CONSULTA_SEM_RESPOSTA"], "sem desfecho do pedido do clique não há leitura");
  igual(String((r.ledger.detalhes.consultas_portal as { ouvinte_erro?: string }).ouvinte_erro).includes("text"), true, "o porquê fica no registro");
});

Deno.test("clique que nunca gera consulta: CONSULTA_SEM_RESPOSTA, mesmo com a tabela vazia da consulta da página na tela", async () => {
  const r = await rodada({ linhas: DUAS, propria: { quando: "abrir", ms: 200 }, cliqueInerte: true });
  igual([r.ledger.status, r.ledger.detalhes.causa_pre_protocolo], ["erro", "leitura:CONSULTA_SEM_RESPOSTA"], "sem resposta do nosso clique não há leitura");
  // A falha chega ao ledger com a evidência: 2 tentativas, nenhuma consulta depois do clique, e o porquê da 1ª.
  const consultas = r.ledger.detalhes.consultas_portal as { tentativa: number; depois: number; anterior: { erro: string } };
  igual([consultas.tentativa, consultas.depois, consultas.anterior.erro], [2, 0, "o clique não gerou consulta"], "o que a página (não) fez");
});
