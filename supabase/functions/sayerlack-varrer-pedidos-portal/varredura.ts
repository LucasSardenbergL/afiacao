// Varredura da Consulta Pedidos do portal Sayerlack — funções PURAS (Deno scope; nada aqui roda no Browserless).
//
// O cron (12:30 · 17:30 · 22:30 SP) lê a lista de pedidos da OBEN emitidos nos últimos dias e, para cada pedido que
// não está no app (`pedido_compra_sugerido.portal_protocolo`) nem no espelho do Omie (`purchase_orders_tracking.
// numero_contrato_fornecedor`), importa pelo MESMO caminho do botão (edge `sayerlack-importar-pedido-portal`, que
// relê o pedido, prova a leitura e grava pela RPC tudo-ou-nada). Aqui mora só a DECISÃO de quem é candidato.
//
// Decisões do founder (2026-10-16), money-path:
//   · corrida com pedido que o próprio app está mandando ao portal (ainda sem protocolo no banco) → a rodada inteira
//     NÃO importa enquanto houver pedido Sayerlack em voo/conciliação, e reconfere o banco antes de cada importação;
//   · janela: emissão nos últimos 7 dias, sem cancelados e sem faturados;
//   · falha → registro de execução + e-mail 1 vez por protocolo.
//
// Situação importável é LISTA FECHADA (precisão > recall): o portal mostra "<código> - <nome>" e só o código na lista
// vira PO. Situação fora da lista (nova, renomeada, ilegível) fica de fora e aparece no relatório da rodada.

//
// ⚠️ CÓPIAS de funções puras de outras edges (nenhuma edge do repo importa a pasta de outra — o bundle do Lovable
// sobe a pasta da edge + `_shared/`): `dataBRparaISO`/`situacaoCancelada` (sayerlack-importar-pedido-portal/leitura.ts)
// e `portalSayerlackFechado` (disparar-pedidos-aprovados/janela-portal.ts). `varredura_test.ts` prova a PARIDADE
// com as originais em cada entrada — divergir quebra o teste.

import { somarDias } from "../_shared/hoje-sp.ts";

export interface LinhaConsultaRaw {
  [coluna: string]: string;
}

/** "26/10/2026" → "2026-10-26"; qualquer outra forma → null. (cópia — ver topo) */
export function dataBRparaISO(s: unknown): string | null {
  if (typeof s !== "string") return null;
  const m = s.trim().match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  if (!m) return null;
  const [, d, mo, a] = m;
  const dt = new Date(Date.UTC(Number(a), Number(mo) - 1, Number(d)));
  if (dt.getUTCFullYear() !== Number(a) || dt.getUTCMonth() !== Number(mo) - 1 || dt.getUTCDate() !== Number(d)) return null;
  return `${a}-${mo}-${d}`;
}

/** Situação "6 - Cancelado". (cópia — ver topo) */
export function situacaoCancelada(situacao: string): boolean {
  return /^\s*6\s*-/.test(situacao) || norm(situacao).includes("cancelad");
}

const FMT_SP = new Intl.DateTimeFormat("en-US", { timeZone: "America/Sao_Paulo", weekday: "short", hour: "2-digit", hourCycle: "h23" });

/** Portal fora do ar: sábado 12:00 → segunda 06:00, hora de SP. (cópia — ver topo) */
export function portalSayerlackFechado(agora: Date): boolean {
  const partes = FMT_SP.formatToParts(agora);
  const dia = partes.find((p) => p.type === "weekday")?.value;
  const hora = Number(partes.find((p) => p.type === "hour")?.value);
  if (!dia || !Number.isFinite(hora)) return false;
  if (dia === "Sun") return true;
  if (dia === "Sat") return hora >= 12;
  if (dia === "Mon") return hora < 6;
  return false;
}

/** Dias de emissão varridos (contando hoje). */
const JANELA_DIAS = 7;

/**
 * Códigos de situação do portal que o cron importa SOZINHO — palavra do founder (2026-10-17), sobre o select real lido
 * na 1ª rodada (1 Aberto · 2 Atendido Parcial · 3 Atendido Total · 4 Pendentes · 5 Suspenso · 6 Cancelado ·
 * 7 Fatur Balcão): Aberto e Suspenso ainda não têm NF, então não há NF no Omie para duplicar.
 */
export const SITUACOES_IMPORTAVEIS: ReadonlySet<string> = new Set<string>(["1", "5"]);

/**
 * Atendido parcial/total: a Sayerlack já faturou. O founder quer o PO se a NF ainda não está no Omie, mas o espelho
 * não prova isso (Codex 2026-10-17, P1: NF com 2 pedidos casada só com um, NF que o sync não leu) — então o cron NÃO
 * importa: avisa por e-mail (1 vez por pedido) para o founder conferir no Omie e usar "Importar do portal".
 * 4 (Pendentes) o founder desconhece; 6 e 7 ficam de fora.
 */
const SITUACOES_CONFERIR: ReadonlySet<string> = new Set<string>(["2", "3"]);

/** Estados de envio em que o pedido do app pode já estar no portal SEM protocolo no banco. */
export const ESTADOS_EM_VOO: readonly string[] = ["enviando_portal", "aceito_portal_sem_protocolo", "indeterminado_requer_conciliacao"];

const PROTOCOLO_RE = /^\d{3,12}$/;

const norm = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/\s+/g, " ").trim();

function coluna(linha: LinhaConsultaRaw, prefixo: string, exato = false): string | null {
  for (const [k, v] of Object.entries(linha)) {
    const nk = norm(k);
    if (exato ? nk === norm(prefixo) : nk.startsWith(norm(prefixo))) return typeof v === "string" ? v : null;
  }
  return null;
}

export interface PedidoListado {
  protocolo: string;
  situacao: string;
  /** Código numérico da situação ("5" em "5 - Suspenso"); null se o texto não tiver código. */
  situacao_codigo: string | null;
  emissao: string | null; // ISO
}

/** Linhas da datatable → pedidos (coluna "Pedido" EXATA; "Pedido Clien[te]" é o nº digitado pelo cliente). */
export function lerListaConsulta(linhas: LinhaConsultaRaw[]): { pedidos: PedidoListado[]; ilegiveis: number; repetidos: string[] } {
  const vistos = new Map<string, PedidoListado>();
  const repetidos = new Set<string>();
  let ilegiveis = 0;
  for (const l of linhas) {
    const protocolo = (coluna(l, "Pedido", true) ?? "").trim();
    if (!PROTOCOLO_RE.test(protocolo)) {
      ilegiveis++;
      continue;
    }
    if (vistos.has(protocolo)) {
      repetidos.add(protocolo);
      continue;
    }
    const situacao = (coluna(l, "Situa") ?? "").trim();
    const m = situacao.match(/^\s*(\d+)\s*-/);
    vistos.set(protocolo, {
      protocolo,
      situacao,
      situacao_codigo: m ? m[1] : null,
      emissao: dataBRparaISO(coluna(l, "Data Emiss")),
    });
  }
  // Nº repetido na lista (proposta + pedido, ou paginação que repetiu) = ambíguo: fica de fora.
  for (const r of repetidos) vistos.delete(r);
  return { pedidos: [...vistos.values()], ilegiveis, repetidos: [...repetidos] };
}

type Classe =
  | "candidato"
  | "ja_no_app"
  | "ja_no_omie"
  | "cancelado"
  | "situacao_nao_importavel"
  | "fora_da_janela"
  | "atendido_conferir"
  | "carencia_primeira_vista"
  | "carencia_aguarda_sync";

export interface PedidoClassificado extends PedidoListado {
  classe: Classe;
}

export function classificar(
  pedidos: PedidoListado[],
  ctx: {
    protocolosNoApp: ReadonlySet<string>;
    contratosNoOmie: ReadonlySet<string>;
    situacoesImportaveis: ReadonlySet<string>;
    emissaoDesde: string; // ISO, inclusive
  },
): PedidoClassificado[] {
  return pedidos.map((p) => {
    // Ordem: o que JÁ existe primeiro (relatório honesto), depois o que o portal diz do pedido.
    const classe: Classe = ctx.protocolosNoApp.has(p.protocolo) ? "ja_no_app"
      : ctx.contratosNoOmie.has(p.protocolo) ? "ja_no_omie"
      : situacaoCancelada(p.situacao) ? "cancelado"
      : !(p.emissao && p.emissao >= ctx.emissaoDesde) ? "fora_da_janela"
      : p.situacao_codigo && SITUACOES_CONFERIR.has(p.situacao_codigo) ? "atendido_conferir"
      : !(p.situacao_codigo && ctx.situacoesImportaveis.has(p.situacao_codigo)) ? "situacao_nao_importavel"
      : "candidato";
    return { ...p, classe };
  });
}

/** Folga entre a 1ª vista e o FIM do sync do espelho: o sync leva até ~2,5 min, então só um fim > vista + 5 min prova
 *  que a coleta inteira começou depois da vista. */
const FOLGA_SYNC_MS = 5 * 60_000;

/**
 * Carência de 1 rodada (palavra do founder, 2026-10-17): PO lançado À MÃO no Omie só chega ao espelho no próximo sync
 * (a cada 2 h) — importar na 1ª vista criaria o 2º PO. O candidato só vale se já foi visto numa rodada ANTERIOR e o
 * sync de pedidos de compra da OBEN terminou `complete` depois dessa vista (+ folga). `syncCompletoEm` null (sem
 * marcador, ou o último sync não foi complete) ⇒ espera.
 */
export function aplicarCarencia(
  classificados: PedidoClassificado[],
  vistos: ReadonlyMap<string, string>,
  syncCompletoEm: string | null,
): PedidoClassificado[] {
  const fimSync = syncCompletoEm ? Date.parse(syncCompletoEm) : NaN;
  return classificados.map((p) => {
    if (p.classe !== "candidato") return p;
    const visto = vistos.get(p.protocolo);
    if (!visto) return { ...p, classe: "carencia_primeira_vista" };
    const vistoMs = Date.parse(visto);
    if (!(Number.isFinite(fimSync) && Number.isFinite(vistoMs) && fimSync > vistoMs + FOLGA_SYNC_MS)) {
      return { ...p, classe: "carencia_aguarda_sync" };
    }
    return p;
  });
}

/** Pedido do app em voo/conciliação ⇒ a rodada não importa nada (pode ser ele o "pedido novo" do portal). */
export function motivoBloqueio(emVoo: { id: number; status_envio_portal: string | null }[]): string | null {
  const ids = emVoo.filter((p) => p.status_envio_portal && ESTADOS_EM_VOO.includes(p.status_envio_portal));
  if (ids.length === 0) return null;
  return `pedido(s) do app em envio/conciliação no portal: ${ids.map((p) => `#${p.id} (${p.status_envio_portal})`).join(", ")}`;
}

/** "AAAA-MM-DD" de `dias - 1` dias antes de `hojeISO` (janela de N dias contando hoje). */
export function inicioDaJanela(hojeISO: string, dias = JANELA_DIAS): string {
  return somarDias(hojeISO, -(dias - 1));
}

/**
 * Nº do contrato no espelho do Omie → protocolos. Um PO pode carregar DOIS pedidos do portal ("1998739/1998740", 15
 * casos medidos em prod): cada pedaço conta. Pedaço que não é nº de pedido (ex. "AFI26050780") é ignorado.
 */
export function contratosDoTexto(v: unknown): string[] {
  if (typeof v !== "string") return [];
  return v.split("/").map((x) => x.trim()).filter((x) => PROTOCOLO_RE.test(x));
}

/** Resultado da edge de importar → falha a notificar? (ok=true com PO criado é sucesso; o resto é falha.) */
export function resumoImportacao(httpStatus: number, corpo: unknown): { ok: boolean; mensagem: string } {
  const b = corpo && typeof corpo === "object" ? (corpo as { ok?: unknown; mensagem?: unknown }) : null;
  const mensagem = typeof b?.mensagem === "string" ? b.mensagem : `resposta HTTP ${httpStatus} sem mensagem`;
  return { ok: httpStatus >= 200 && httpStatus < 300 && b?.ok === true, mensagem };
}
