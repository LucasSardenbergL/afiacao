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
import { JANELA_FUTURO_DIAS, JANELA_PASSADO_INCREMENTAL_DIAS } from "../_shared/janela-pedidos-compra.ts";

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

/** Código de situação RECONHECIDO no texto "<código> - <nome>" do portal (select real: 1..7). Outro ⇒ null. */
export function codigoSituacao(situacao: string): string | null {
  const m = situacao.match(/^\s*([1-7])\s*-/);
  return m ? m[1] : null;
}

/**
 * Linhas da datatable → pedidos (coluna "Pedido" EXATA; "Pedido Clien[te]" é o nº digitado pelo cliente).
 *
 * Ilegível (revisão 2, B1): nº de pedido ilegível, OU nº legível com situação sem código reconhecido (1..7), OU data
 * de emissão ilegível. Sem isso, "situação vazia" virava `situacao_nao_importavel` e "emissão ??" virava
 * `fora_da_janela` — o pedido sumia dos candidatos com a leitura "provada". O pedido de nº legível segue na lista
 * (o relatório e a reconciliação o veem; sem código ele nunca é candidato nem bloqueia/libera), mas a prova reprova.
 */
export function lerListaConsulta(linhas: LinhaConsultaRaw[]): {
  pedidos: PedidoListado[];
  ilegiveis: number;
  repetidos: string[];
  ilegiveis_detalhe: { protocolo: string | null; campo: "pedido" | "situacao" | "emissao" }[];
} {
  const vistos = new Map<string, PedidoListado>();
  const repetidos = new Set<string>();
  const ilegiveisDetalhe: { protocolo: string | null; campo: "pedido" | "situacao" | "emissao" }[] = [];
  for (const l of linhas) {
    const protocolo = (coluna(l, "Pedido", true) ?? "").trim();
    if (!PROTOCOLO_RE.test(protocolo)) {
      ilegiveisDetalhe.push({ protocolo: null, campo: "pedido" });
      continue;
    }
    if (vistos.has(protocolo)) {
      repetidos.add(protocolo);
      continue;
    }
    const situacao = (coluna(l, "Situa") ?? "").trim();
    const codigo = codigoSituacao(situacao);
    const emissao = dataBRparaISO(coluna(l, "Data Emiss"));
    if (!codigo) ilegiveisDetalhe.push({ protocolo, campo: "situacao" });
    if (!emissao) ilegiveisDetalhe.push({ protocolo, campo: "emissao" });
    vistos.set(protocolo, { protocolo, situacao, situacao_codigo: codigo, emissao });
  }
  // Nº repetido na lista (proposta + pedido, ou paginação que repetiu) = ambíguo: fica de fora.
  for (const r of repetidos) vistos.delete(r);
  // Conta LINHAS ilegíveis (uma linha com situação e emissão ilegíveis conta 1).
  const linhasIlegiveis = new Set(ilegiveisDetalhe.map((d, i) => d.protocolo ?? `#${i}`)).size;
  return { pedidos: [...vistos.values()], ilegiveis: linhasIlegiveis, repetidos: [...repetidos], ilegiveis_detalhe: ilegiveisDetalhe };
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
  const base = typeof b?.mensagem === "string" ? b.mensagem : `resposta HTTP ${httpStatus} sem mensagem`;
  // B3: a importadora leu a situação e NÃO conseguiu gravá-la (2 tentativas) — se for um 6, a compra segue liberada
  // pelo estado antigo. O aviso vai junto da mensagem (e-mail da pendência), não some no log da outra edge.
  const naoGravada = (corpo as { situacao_gravada?: unknown } | null)?.situacao_gravada === "erro";
  const mensagem = naoGravada ? `${base} ATENÇÃO: a situação lida no portal NÃO foi gravada no pedido do app.` : base;
  return { ok: httpStatus >= 200 && httpStatus < 300 && b?.ok === true, mensagem };
}

// ── Reconciliação do "PO a reconciliar" pelo portal (v1.3) ──────────────────────────────────────────────────────────
// O card "Pedidos com PO a reconciliar no Omie" lista pedido `disparado` cujo PO sumiu do Omie e pede ao humano que
// confira com o fornecedor se o protocolo segue vivo (cancelar às cegas = o motor re-sugere = compra em dobro). Esta
// varredura JÁ lê a situação de cada protocolo, mas `ja_no_app` vence antes de olhar a situação — o cancelamento que
// responde a pergunta do card nunca era visto (pedido 3666 / protocolo 2141466, 2026-10-28: o founder ligou para saber
// o que a rodada das 12:30 já tinha lido).
//
// Regra (precisão > recall): só encerra quando as DUAS pontas provam que a compra não existe — PO fora do Omie no último
// run válido do detector (mesmos filtros de `reposicao_pos_candidatos`) E situação `6` EXATA no portal, num protocolo
// lido UMA vez. Qualquer outra coisa (vivo, atendido, não achado, repetido, situação sem código) só RELATA.

/** Até quantos dias de emissão a leitura se estende para alcançar um pedido a reconciliar (teto de páginas do portal). */
const JANELA_RECONCILIACAO_MAX_DIAS = 30;

/** Linha de `pedido_compra_sugerido` que a reconciliação lê. */
export interface PedidoDisparadoLido {
  id: number;
  status: string;
  canal_usado: string | null;
  data_ciclo: string; // AAAA-MM-DD
  portal_protocolo: string | null;
  omie_pedido_compra_id: string | number | null;
  omie_po_inexistente_antes_de: string | null;
}

/** Último run VÁLIDO do detector de PO (`reposicao_pedidos_compra_run`: status ok + volume_ok, maior seq). */
export interface MarcadorPo {
  run_id: string;
  seq: number;
  finalizado_em: string;
}

/** Idade máxima do marcador para AUTORIZAR encerramento — o mesmo limiar de frescor do card (`po-sumido.ts`, 26 h).
 *  Ausência apurada por detector parado é evidência velha (Codex P1): o pedido segue no card, com o humano. */
const MARCADOR_MAX_IDADE_MS = 26 * 3600_000;

export function marcadorFresco(marcador: MarcadorPo, agoraMs: number): boolean {
  const fim = Date.parse(marcador.finalizado_em);
  return Number.isFinite(fim) && agoraMs - fim <= MARCADOR_MAX_IDADE_MS;
}

export interface PedidoAReconciliar {
  pedido_id: number;
  protocolo: string;
  omie_po_id: string;
  data_ciclo: string;
}

/** Id do PO na forma CANÔNICA de bigint (o detector compara bigint: "00101" = 101). Fora da faixa segura do JS
 *  (a coluna volta como number do PostgREST) ou não numérico = identidade não interpretável ⇒ fora (Codex P1). */
export function idDoPo(v: string | number | null | undefined): string | null {
  const s = v === null || v === undefined ? "" : String(v).trim();
  if (!/^\d{1,19}$/.test(s)) return null;
  const n = BigInt(s);
  return n > 0n && n <= BigInt(Number.MAX_SAFE_INTEGER) ? n.toString() : null;
}

/**
 * Pedidos do PORTAL cujo PO NÃO apareceu no último run válido — o espelho de `reposicao_pos_candidatos`, restrito a
 * `disparado` (a porta `corrigir_cancelamento_pos_disparo` não aceita outro) e ao canal do portal. Sem marcador ⇒ nada:
 * sem run válido não há como afirmar ausência. Guard causal: PO criado depois do run não teve chance de ser visto.
 *
 * `posVistosDesdeOMarcador` = POs com `visto_seq >= marcador.seq` (ids canônicos). NÃO é `run_id = marcador`: um run
 * novo publicado entre ler o marcador e ler `last_seen` sobrescreve o carimbo, e o PO presente pareceria ausente
 * (Codex P1). Visto no marcador OU depois = presente.
 */
export function pedidosAReconciliar(
  pedidos: PedidoDisparadoLido[],
  marcador: MarcadorPo | null,
  posVistosDesdeOMarcador: ReadonlySet<string>,
): PedidoAReconciliar[] {
  if (!marcador) return [];
  const fim = Date.parse(marcador.finalizado_em);
  if (!Number.isFinite(fim)) return [];
  const out: PedidoAReconciliar[] = [];
  for (const p of pedidos) {
    if (p.status !== "disparado" || p.canal_usado !== "portal_sayerlack") continue;
    const protocolo = (p.portal_protocolo ?? "").trim();
    const po = idDoPo(p.omie_pedido_compra_id);
    if (!PROTOCOLO_RE.test(protocolo) || !po) continue;
    if (posVistosDesdeOMarcador.has(po)) continue;
    if (p.omie_po_inexistente_antes_de !== null) {
      const antes = Date.parse(p.omie_po_inexistente_antes_de);
      if (!Number.isFinite(antes) || antes > fim) continue;
    }
    out.push({ pedido_id: p.id, protocolo, omie_po_id: po, data_ciclo: p.data_ciclo });
  }
  return out;
}

/**
 * Início da emissão a ler: a janela normal de importação, estendida (até o teto) para cobrir o pedido a reconciliar
 * mais antigo — 1 dia antes do ciclo (o disparo noturno em SP pode cair no dia seguinte em UTC, e vice-versa). Pedido
 * além do teto fica `fora_do_alcance` e segue com o humano.
 */
export function janelaDeLeitura(
  hojeISO: string,
  aReconciliar: PedidoAReconciliar[],
): { emissaoDesde: string; alcancaveis: PedidoAReconciliar[]; foraDoAlcance: PedidoAReconciliar[] } {
  const limite = inicioDaJanela(hojeISO, JANELA_RECONCILIACAO_MAX_DIAS);
  let emissaoDesde = inicioDaJanela(hojeISO);
  const alcancaveis: PedidoAReconciliar[] = [];
  const foraDoAlcance: PedidoAReconciliar[] = [];
  for (const p of aReconciliar) {
    const precisa = somarDias(p.data_ciclo, -1);
    if (precisa < limite) {
      foraDoAlcance.push(p);
      continue;
    }
    alcancaveis.push(p);
    if (precisa < emissaoDesde) emissaoDesde = precisa;
  }
  return { emissaoDesde, alcancaveis, foraDoAlcance };
}

export type DesfechoReconciliacao =
  | { classe: "cancelado_no_portal"; situacao: string }
  | { classe: "vivo_ou_outro"; situacao: string }
  | { classe: "nao_encontrado" }
  | { classe: "protocolo_repetido" };

/** O que o portal diz de cada pedido a reconciliar. Só `cancelado_no_portal` autoriza encerrar. */
export function desfechoNoPortal(
  alcancaveis: PedidoAReconciliar[],
  lista: { pedidos: PedidoListado[]; repetidos: string[] },
): (PedidoAReconciliar & DesfechoReconciliacao)[] {
  const repetidos = new Set(lista.repetidos);
  return alcancaveis.map((p) => {
    if (repetidos.has(p.protocolo)) return { ...p, classe: "protocolo_repetido" as const };
    const achados = lista.pedidos.filter((l) => l.protocolo === p.protocolo);
    if (achados.length !== 1) {
      return achados.length === 0 ? { ...p, classe: "nao_encontrado" as const } : { ...p, classe: "protocolo_repetido" as const };
    }
    const l = achados[0];
    return l.situacao_codigo === "6"
      ? { ...p, classe: "cancelado_no_portal" as const, situacao: l.situacao }
      : { ...p, classe: "vivo_ou_outro" as const, situacao: l.situacao };
  });
}

// ── Onda 3 dos pontos cegos (2026-11-07): rodada nunca verde sem prova ─────────────────────────────────────────────
// Incidente: 2 de 46 rodadas leram 0 linhas e registraram sucesso (23/10 e 03/11, 01:30 UTC). Ler "nada" e ler "o
// portal disse 0 de 0" são coisas diferentes — só a segunda prova que não havia pedido.

/** Colunas sem as quais a classificação não tem o que ler (DOM mudou ⇒ erro, nunca "nenhum candidato"). */
const COLUNAS_OBRIGATORIAS: readonly { rotulo: string; prefixo: string; exato: boolean }[] = [
  { rotulo: "Pedido", prefixo: "Pedido", exato: true },
  { rotulo: "Situação", prefixo: "Situa", exato: false },
  { rotulo: "Data Emissão", prefixo: "Data Emiss", exato: false },
  { rotulo: "Vlr", prefixo: "Vlr", exato: false },
];

function inteiroNaoNegativo(n: unknown): number | null {
  if (typeof n === "number" && Number.isInteger(n) && n >= 0) return n;
  if (typeof n === "string" && /^\d+$/.test(n.trim())) return Number(n.trim());
  return null;
}

/** "Mostrando de 1 até 10 de 23 registros" / "Showing 1 to 10 of 23 entries" / "0 até 0 de 0" → 23. */
function totalDoTexto(info: unknown): number | null {
  if (typeof info !== "string") return null;
  const m = info.replace(/\./g, "").match(/\b(?:de|of)\s+(\d+)\s*(?:registros|entries|itens|pedidos)?\s*(?:\(|$)/i);
  return m ? Number(m[1]) : null;
}

/**
 * Total ANUNCIADO pelo portal, por até 3 fontes: `recordsFiltered` da resposta da consulta (só o FILTRADO — o
 * `recordsTotal` é o universo antes dos filtros, Codex P2), `page.info().recordsDisplay` da instância DataTables da
 * tabela lida, e o texto "… de N registros". Fontes que discordam ⇒ `divergente` (nunca escolhe uma).
 */
export function totalAnunciado(fonte: { respostaTotal?: unknown; dtTotal?: unknown; info?: unknown }): number | null | "divergente" {
  const vals = [inteiroNaoNegativo(fonte.respostaTotal), inteiroNaoNegativo(fonte.dtTotal), totalDoTexto(fonte.info)]
    .filter((v): v is number => v !== null);
  if (vals.length === 0) return null;
  return vals.every((v) => v === vals[0]) ? vals[0] : "divergente";
}

export type ProvaLeitura =
  | { ok: true; total: number }
  | { ok: false; motivo: "colunas_ausentes" | "total_nao_anunciado" | "total_divergente" | "zero_lidos_sem_prova" | "lidos_diferente_do_total" | "linhas_ilegiveis" | "protocolo_repetido"; detalhe: string };

/**
 * A leitura só decide se for COMPLETA e LEGÍVEL: as colunas obrigatórias existem, o portal anunciou o total, o número
 * de linhas lidas é esse total (0 só com "0 de 0" explícito), e nenhuma linha foi descartada como ilegível ou repetida.
 */
export function provarLeitura(entrada: {
  headers: readonly string[];
  linhasLidas: number;
  respostaTotal?: unknown;
  dtTotal?: unknown;
  info?: unknown;
  ilegiveis: number;
  repetidos: readonly string[];
}): ProvaLeitura {
  const faltam = COLUNAS_OBRIGATORIAS.filter((c) =>
    !entrada.headers.some((h) => (c.exato ? norm(h) === norm(c.prefixo) : norm(h).startsWith(norm(c.prefixo)))));
  if (faltam.length > 0) {
    return { ok: false, motivo: "colunas_ausentes", detalhe: `colunas ausentes na consulta: ${faltam.map((c) => c.rotulo).join(", ")} (cabeçalhos lidos: ${entrada.headers.filter(Boolean).join(" | ") || "nenhum"})` };
  }
  const total = totalAnunciado({ respostaTotal: entrada.respostaTotal, dtTotal: entrada.dtTotal, info: entrada.info });
  if (total === "divergente") {
    return { ok: false, motivo: "total_divergente", detalhe: `o portal anunciou totais diferentes (resposta ${String(entrada.respostaTotal)}, tabela ${String(entrada.dtTotal)}, texto "${String(entrada.info)}")` };
  }
  if (total === null) {
    return entrada.linhasLidas === 0
      ? { ok: false, motivo: "zero_lidos_sem_prova", detalhe: "0 linhas lidas e o portal não anunciou o total — não prova que não há pedido" }
      : { ok: false, motivo: "total_nao_anunciado", detalhe: `${entrada.linhasLidas} linha(s) lida(s), mas o portal não anunciou o total — não prova que a lista veio inteira` };
  }
  if (entrada.linhasLidas !== total) {
    return { ok: false, motivo: "lidos_diferente_do_total", detalhe: `${entrada.linhasLidas} linha(s) lida(s) contra ${total} anunciada(s) pelo portal` };
  }
  if (entrada.ilegiveis > 0) {
    return { ok: false, motivo: "linhas_ilegiveis", detalhe: `${entrada.ilegiveis} linha(s) sem nº de pedido legível` };
  }
  if (entrada.repetidos.length > 0) {
    return { ok: false, motivo: "protocolo_repetido", detalhe: `nº de pedido repetido na lista: ${entrada.repetidos.join(", ")}` };
  }
  return { ok: true, total };
}

/** Carência esperando o sync do espelho há mais que isto ⇒ o sync travou: vira pendência visível (item 3.9). */
const CARENCIA_SYNC_MAX_MS = 6 * 3600_000;

/** Protocolos presos em `carencia_aguarda_sync` desde a 1ª vista há mais de 6 h. */
export function carenciaTravada(
  classificados: readonly PedidoClassificado[],
  vistos: ReadonlyMap<string, string>,
  agoraMs: number,
): { protocolo: string; visto_em: string }[] {
  const out: { protocolo: string; visto_em: string }[] = [];
  for (const p of classificados) {
    if (p.classe !== "carencia_aguarda_sync") continue;
    const visto = vistos.get(p.protocolo);
    const ms = visto ? Date.parse(visto) : NaN;
    if (visto && Number.isFinite(ms) && agoraMs - ms > CARENCIA_SYNC_MAX_MS) out.push({ protocolo: p.protocolo, visto_em: visto });
  }
  return out;
}

/** Teto de reconsultas por número numa rodada (cada uma abre 1 sessão do Browserless). */
const TETO_RECONSULTAS = 4;

/**
 * Pendências fora da leitura da rodada (item 3.7): pedido do app sem PO e falha aberta cujo protocolo NÃO apareceu na
 * lista lida (emissão além da janela). Fila pela TENTATIVA MAIS ANTIGA (nunca tentado primeiro; empate: pedido do app
 * antes) — ordenar por `primeira_em` deixava a 13ª pendência esperando para sempre (Codex P2). Dedup e teto.
 */
export function reconsultasForaDaJanela(entrada: {
  lidos: ReadonlySet<string>;
  semPoNoApp: readonly { protocolo: string; pedido_id: number; ultima_tentativa?: string | null }[];
  falhasAbertas: readonly { protocolo: string; ultima_em: string }[];
  teto?: number;
}): { protocolo: string; origem: "app_sem_po" | "falha_aberta"; pedido_id: number | null }[] {
  const teto = entrada.teto ?? TETO_RECONSULTAS;
  const porProt = new Map<string, { protocolo: string; origem: "app_sem_po" | "falha_aberta"; pedido_id: number | null; quando: string }>();
  for (const p of entrada.semPoNoApp) {
    if (!PROTOCOLO_RE.test(p.protocolo) || entrada.lidos.has(p.protocolo) || porProt.has(p.protocolo)) continue;
    porProt.set(p.protocolo, { protocolo: p.protocolo, origem: "app_sem_po", pedido_id: p.pedido_id, quando: p.ultima_tentativa ?? "" });
  }
  for (const f of entrada.falhasAbertas) {
    if (!PROTOCOLO_RE.test(f.protocolo) || entrada.lidos.has(f.protocolo) || porProt.has(f.protocolo)) continue;
    porProt.set(f.protocolo, { protocolo: f.protocolo, origem: "falha_aberta", pedido_id: null, quando: f.ultima_em });
  }
  return [...porProt.values()]
    .sort((a, b) => a.quando.localeCompare(b.quando) || (a.origem === b.origem ? 0 : a.origem === "app_sem_po" ? -1 : 1))
    .slice(0, teto)
    .map(({ quando: _q, ...q }) => q);
}

// ── Onda 5A (2026-11-08): situação do portal gravada no pedido ─────────────────────────────────────────────────────
// O disparador geral cria PO de pedido `sucesso_portal` sem reler o portal; a situação que esta varredura JÁ lê vai
// para o pedido pelo escritor único `sayerlack_registrar_situacao_portal`, e o claim de disparo recusa o 6.

export interface ObservacaoSituacao {
  protocolo: string;
  codigo: string;
  texto: string;
}

/** Pedidos da lista que estão no app, com código de situação RECONHECIDO (1..7). Ilegível fica de fora: nunca
 *  substitui a observação vigente (o banco recusa também — esta é a 1ª camada). `soCancelados`: leitura com outra
 *  linha ilegível/repetida — o 6 de uma linha única e legível ainda BLOQUEIA (falha fechada), mas nada libera. */
export function observacoesDaLista(
  pedidos: readonly PedidoListado[],
  protocolosNoApp: ReadonlySet<string>,
  opcoes: { soCancelados?: boolean } = {},
): ObservacaoSituacao[] {
  return pedidos
    .filter((p) => protocolosNoApp.has(p.protocolo) && /^[1-7]$/.test(p.situacao_codigo ?? ""))
    .filter((p) => !opcoes.soCancelados || p.situacao_codigo === "6")
    .map((p) => ({ protocolo: p.protocolo, codigo: p.situacao_codigo as string, texto: p.situacao.slice(0, 200) }));
}

// ── Revisão 2 (2026-11-08): brechas B5–B7 ──────────────────────────────────────────────────────────────────────────

/**
 * Desfecho de uma chamada à importadora (B6/B7). Só é RESPOSTA da importadora o objeto com `ok` booleano e `mensagem`
 * texto (o contrato dela). Rede/prazo (HTTP 0), corpo que não é objeto, `{}` ou `{"msg": …}` do gateway são
 * INDETERMINADOS: o pedido pode ter sido gravado e o PO criado depois — nunca "falhou", nunca "não entrou".
 */
export function desfechoImportacao(httpStatus: number, corpo: unknown): "ok" | "falha" | "indeterminado" {
  if (httpStatus === 0 || !corpo || typeof corpo !== "object" || Array.isArray(corpo)) return "indeterminado";
  const b = corpo as { ok?: unknown; mensagem?: unknown; desfecho?: unknown };
  if (typeof b.ok !== "boolean" || typeof b.mensagem !== "string") return "indeterminado";
  // A importadora declara "não sei" explicitamente quando a gravação pode ter acontecido (Codex revisão 2, B7).
  if (b.desfecho === "indeterminado") return "indeterminado";
  return resumoImportacao(httpStatus, corpo).ok ? "ok" : "falha";
}

/**
 * Carência do RE-DISPARO de pedido do app sem PO (B5): o disparo falhou (ou nunca rodou) e alguém pode ter lançado o
 * PO à mão no Omie depois — o espelho só o vê no próximo sync. Re-dispara só se o sync de pedidos de compra terminou
 * `complete` depois da última mudança do pedido (+ a mesma folga da carência de importação). Sem marcador ⇒ espera;
 * esperando há mais de 6 h ⇒ `travado` (vira pendência visível, como a 3.9).
 */
export function carenciaRedisparo(
  ultimaMudancaISO: string | null,
  syncCompletoEm: string | null,
  agoraMs: number,
): "pode" | "aguarda_sync" | "aguarda_sync_travado" {
  const mudanca = ultimaMudancaISO ? Date.parse(ultimaMudancaISO) : NaN;
  const fimSync = syncCompletoEm ? Date.parse(syncCompletoEm) : NaN;
  if (Number.isFinite(mudanca) && Number.isFinite(fimSync) && fimSync > mudanca + FOLGA_SYNC_MS) return "pode";
  // Sem a data da mudança não há como medir a espera: trava visível já (fail-closed e visível).
  if (!Number.isFinite(mudanca)) return "aguarda_sync_travado";
  return agoraMs - mudanca > CARENCIA_SYNC_MAX_MS ? "aguarda_sync_travado" : "aguarda_sync";
}

/** A mais recente de duas datas ISO (nula some); as duas nulas ⇒ null. */
export function maisRecente(a: string | null | undefined, b: string | null | undefined): string | null {
  const ms = [a, b].map((x) => (x ? Date.parse(x) : NaN)).filter((n) => Number.isFinite(n));
  return ms.length === 0 ? null : new Date(Math.max(...ms)).toISOString();
}

/** Folga dentro da janela do sync incremental: a previsão do PO lançado à mão pode diferir da entrega do portal. */
const FOLGA_COBERTURA_DIAS = 10;

/**
 * O sync de pedidos de compra só coleta PO com previsão de entrega em [hoje − 60, hoje + 120] dias (incremental —
 * `_shared/janela-pedidos-compra.ts`). "Complete depois da falha" só prova ausência de PO manual para pedido cuja
 * entrega cai DENTRO dessa cobertura (Codex revisão 2, B5). Fora dela (ou sem data) o re-disparo automático não sai:
 * vira pendência humana.
 */
export function entregaCobertaPeloSync(dataEntregaISO: string | null, hojeISO: string): boolean {
  if (!dataEntregaISO || !/^\d{4}-\d{2}-\d{2}/.test(dataEntregaISO)) return false;
  const d = dataEntregaISO.slice(0, 10);
  return d >= somarDias(hojeISO, -(JANELA_PASSADO_INCREMENTAL_DIAS - FOLGA_COBERTURA_DIAS)) &&
    d <= somarDias(hojeISO, JANELA_FUTURO_DIAS - FOLGA_COBERTURA_DIAS);
}
