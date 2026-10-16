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
 * Códigos de situação do portal que viram PO. VAZIA de propósito até a 1ª rodada listar as situações reais do select
 * `#situacao` (só se conhece "5 - Suspenso" e "6 - Cancelado"): com a lista vazia a varredura só RELATA, não importa.
 */
export const SITUACOES_IMPORTAVEIS: ReadonlySet<string> = new Set<string>([]);

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
  | "fora_da_janela";

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
      : !(p.situacao_codigo && ctx.situacoesImportaveis.has(p.situacao_codigo)) ? "situacao_nao_importavel"
      : "candidato";
    return { ...p, classe };
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

/** Nº do contrato no espelho do Omie → protocolo comparável (mesmo `btrim` da RPC, IP006). */
export function normalizarContrato(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const s = v.trim();
  return s === "" ? null : s;
}

/** Resultado da edge de importar → falha a notificar? (ok=true com PO criado é sucesso; o resto é falha.) */
export function resumoImportacao(httpStatus: number, corpo: unknown): { ok: boolean; mensagem: string } {
  const b = corpo && typeof corpo === "object" ? (corpo as { ok?: unknown; mensagem?: unknown }) : null;
  const mensagem = typeof b?.mensagem === "string" ? b.mensagem : `resposta HTTP ${httpStatus} sem mensagem`;
  return { ok: httpStatus >= 200 && httpStatus < 300 && b?.ok === true, mensagem };
}
