// Política de e-mail do disparo — o que chega na caixa do founder, e quando.
//
// PEDIDO DO FOUNDER (2026-09-25): "não precisa me enviar esses e-mails, já percebi que está tudo
// certo na compra — quero apenas o e-mail que diz que o pedido foi implantado no sistema da
// Sayerlack e me diga o código do pedido gerado no sistema da fábrica".
//
// Até aqui TODO run desta edge mandava o resumo "Pedidos disparados: N pedidos, R$ X" — inclusive o
// corte das 10:00 sem nada aprovado ("0 pedidos, R$ 0,00") e o corte em que o Sayerlack só ENFILEIRA o
// portal (`aguardando_portal_sayerlack`, fora das contagens). O código da fábrica nunca aparecia: o
// portal roda em background e, quando confirma, chama esta edge de novo só para registrar o PO no
// Omie (`registrarPedidoOmieAposPortal` / `conciliar-pedido-portal`) — é ESSE run que conhece o
// protocolo, e é nele que o e-mail de "implantado" nasce agora.
//
// Em produção:
//   · implantado  = o run registrou (ou reconciliou) no Omie um pedido que o portal Sayerlack já
//                   aceitou COM protocolo ⇒ um e-mail com o nº do pedido na fábrica;
//   · problema    = o run terminou com desfecho que exige ação (`STATUS_FINAL_PROBLEMA`) ⇒ o resumo
//                   antigo, com o assunto dizendo que há problema. Fica de propósito, fora do pedido
//                   literal: o Sentinela só olha disparo preso depois de 48h (`reposicao_disparo`), e
//                   este e-mail era o ÚNICO aviso rápido de PO que não nasceu no Omie — tirá-lo
//                   trocaria o e-mail diário por uma falha muda. Pedido barrado pelo mínimo de
//                   faturamento NÃO conta: é o benigno que a tela já tirou do vermelho (#1222);
//   · o resto (nada aprovado, só enfileirou o portal, fornecedor sem portal disparado ok) ⇒ nenhum.
// Em dry_run o resumo de sempre continua saindo em todo run: lá o `IncluirPedCompra` cria PO REAL
// no Omie (docs/agent/reposicao.md §Motor) e o e-mail é o aviso disso.
//
// Módulo PURO (sem Deno/IO): a edge decide com ele e o `email-politica_test.ts` prova a régua.

/** Desfechos em que a compra foi ao Omie e ficou REGISTRADA no banco (allowlist — ver index.ts). */
export const STATUS_FINAL_SUCESSO = new Set(["disparado", "disparado_simulado"]);

/**
 * Os desfechos que o operador precisa VER como problema. `nao_disparado` = o claim recusou (um
 * cancelamento venceu antes) — nada foi ao Omie. `disparado_sem_registro` = o oposto, e o mais caro:
 * o PO existe no Omie e o banco não o gravou; a pendência de disparo fica aberta na linha justamente
 * para que ele seja achável.
 */
export const STATUS_FINAL_PROBLEMA = new Set([
  "falha_envio",
  "nao_disparado",
  "disparado_sem_registro",
]);

/** O recorte do resultado de cada pedido que a política lê. */
export interface ResultadoEmail {
  pedido_id: number;
  fornecedor: string;
  status_final: string;
  valor: number | null;
  omie_numero?: string;
  // Nº do pedido no sistema da Sayerlack (o protocolo que o portal devolveu). Só existe quando o
  // portal JÁ aceitou o pedido — o run leu isso do banco antes de ir ao Omie.
  protocolo_portal?: string | null;
  // Previsão de entrega devolvida pelo portal (ISO YYYY-MM-DD), quando capturada.
  portal_data_entrega?: string | null;
  // Pedido filho de um split (lote N de M do pedido pai).
  split_parent_id?: number | null;
  split_lote?: number | null;
  split_total?: number | null;
  // Barrado pelo gate de mínimo de faturamento (benigno: o motor re-sugere no ciclo seguinte).
  gate_minimo?: boolean;
}

export interface PlanoEmailsDisparo {
  /** dry_run: o resumo de sempre, em todo run. */
  resumoDryRun: boolean;
  /** Pedidos implantados na Sayerlack neste run (e-mail com o nº da fábrica). */
  implantados: ResultadoEmail[];
  /** Pedidos com desfecho que exige ação (o resumo sai com assunto de problema). */
  problemas: ResultadoEmail[];
}

function protocoloDe(r: ResultadoEmail): string | null {
  const p = typeof r.protocolo_portal === "string" ? r.protocolo_portal.trim() : "";
  return p === "" ? null : p;
}

/** O pedido foi aceito pelo portal Sayerlack (com nº) E registrado no Omie neste run. */
export function ehImplantadoNaSayerlack(r: ResultadoEmail): boolean {
  return STATUS_FINAL_SUCESSO.has(r.status_final) && protocoloDe(r) !== null;
}

/** Desfecho que exige ação — exceto o barrado pelo mínimo de faturamento (benigno, #1222). */
export function ehProblemaQueAvisa(r: ResultadoEmail): boolean {
  return STATUS_FINAL_PROBLEMA.has(r.status_final) && r.gate_minimo !== true;
}

export function planejarEmailsDoDisparo(
  modo: "dry_run" | "producao",
  resultados: ResultadoEmail[],
): PlanoEmailsDisparo {
  if (modo === "dry_run") return { resumoDryRun: true, implantados: [], problemas: [] };
  return {
    resumoDryRun: false,
    implantados: resultados.filter(ehImplantadoNaSayerlack),
    problemas: resultados.filter(ehProblemaQueAvisa),
  };
}

/** Por que o run não mandou e-mail — vai para o `email_detail` da auditoria. */
export function motivoSemEmail(resultados: ResultadoEmail[]): string {
  if (resultados.length === 0) return "sem e-mail: nenhum pedido neste run";
  return `sem e-mail: nenhum pedido implantado na Sayerlack nem problema (${resultados.length} pedido(s) no run)`;
}

export function escapeHtml(s: unknown): string {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Valor em reais — `null` quando não há número positivo (ausente ≠ zero: nunca "R$ 0,00" inventado). */
export function formatarValor(v: number | null | undefined): string | null {
  if (typeof v !== "number" || !Number.isFinite(v) || v <= 0) return null;
  return new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" }).format(v);
}

/** 'YYYY-MM-DD' → 'DD/MM/YYYY'; qualquer outra forma → null (não adivinha data). */
export function formatarDataIso(iso: string | null | undefined): string | null {
  if (typeof iso !== "string") return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso.trim());
  return m ? `${m[3]}/${m[2]}/${m[1]}` : null;
}

export function assuntoImplantado(implantados: ResultadoEmail[]): string {
  const protocolos = implantados.map((r) => protocoloDe(r) ?? "?");
  if (implantados.length === 1) {
    const valor = formatarValor(implantados[0].valor);
    return `Pedido implantado na Sayerlack — nº ${protocolos[0]}${valor ? ` (${valor})` : ""}`;
  }
  return `${implantados.length} pedidos implantados na Sayerlack — nº ${protocolos.join(", ")}`;
}

export function assuntoProblema(empresa: string, nProblemas: number): string {
  return `⚠️ Problema no disparo de pedidos — ${nProblemas} pedido(s) — ${empresa}`;
}

function linhaDetalhe(rotulo: string, valorHtml: string): string {
  return `<tr>
      <td style="padding:6px 0;font-size:13px;color:#6b7280;width:48%;">${rotulo}</td>
      <td style="padding:6px 0;font-size:13px;font-weight:600;">${valorHtml}</td>
    </tr>`;
}

function cartaoImplantado(r: ResultadoEmail, appUrl: string): string {
  const url = `${appUrl}/admin/reposicao/pedidos?id=${encodeURIComponent(String(r.pedido_id))}`;
  const lote = r.split_parent_id != null && r.split_lote != null && r.split_total != null
    ? ` <span style="color:#6b7280;font-weight:400;">(lote ${escapeHtml(r.split_lote)}/${escapeHtml(r.split_total)} do #${escapeHtml(r.split_parent_id)})</span>`
    : "";
  const valor = formatarValor(r.valor);
  const entrega = formatarDataIso(r.portal_data_entrega);
  const omie = typeof r.omie_numero === "string" && r.omie_numero.trim() !== "" ? r.omie_numero.trim() : null;
  const linhas = [
    linhaDetalhe("Pedido no app", `<a href="${escapeHtml(url)}" style="color:#111827;">#${escapeHtml(r.pedido_id)}</a>${lote}`),
    linhaDetalhe("Pedido de compra no Omie", omie ? escapeHtml(omie) : "—"),
    linhaDetalhe("Valor", valor ? escapeHtml(valor) : "—"),
  ];
  if (entrega) linhas.push(linhaDetalhe("Previsão de entrega (portal)", escapeHtml(entrega)));
  return `
  <div style="border:1px solid #e5e7eb;border-radius:10px;padding:16px 20px;margin-bottom:14px;">
    <div style="font-size:11px;color:#6b7280;text-transform:uppercase;letter-spacing:.04em;">Nº do pedido na Sayerlack</div>
    <div style="font-size:30px;font-weight:700;margin:2px 0 10px;">${escapeHtml(protocoloDe(r) ?? "?")}</div>
    <div style="font-size:12px;color:#6b7280;margin-bottom:6px;">${escapeHtml(r.fornecedor)}</div>
    <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="width:100%;border-collapse:collapse;">
    ${linhas.join("\n    ")}
    </table>
  </div>`;
}

export function htmlImplantado(
  empresa: string,
  implantados: ResultadoEmail[],
  appUrl: string,
  geradoEm: string,
): string {
  const titulo = implantados.length === 1
    ? "Pedido implantado na Sayerlack"
    : `${implantados.length} pedidos implantados na Sayerlack`;
  return `
<!DOCTYPE html><html><body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Arial,sans-serif;background:#f3f4f6;margin:0;padding:16px;color:#111827;">
<div style="max-width:560px;margin:0 auto;background:#fff;border-radius:12px;padding:24px;">
  <h1 style="margin:0 0 4px;font-size:20px;">${escapeHtml(titulo)}</h1>
  <p style="margin:0 0 20px;color:#6b7280;font-size:13px;">${escapeHtml(empresa)} · ${escapeHtml(geradoEm)}</p>
  ${implantados.map((r) => cartaoImplantado(r, appUrl)).join("\n")}
  <div style="margin-top:20px;text-align:center;">
    <a href="${escapeHtml(`${appUrl}/admin/reposicao/pedidos`)}" style="display:inline-block;background:#111827;color:#fff;padding:12px 28px;border-radius:8px;text-decoration:none;font-size:14px;font-weight:600;">Ver pedidos no app</a>
  </div>
</div>
</body></html>`;
}
