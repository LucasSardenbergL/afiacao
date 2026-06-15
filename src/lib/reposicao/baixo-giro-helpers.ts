import { impactoSimulado } from "./param-auto-helpers";

export function somarCapitalParado(
  itens: Array<{ saldo: number | null; cmc: number | null }>,
): { totalRs: number; semCustoN: number; comEstoqueN: number } {
  let totalRs = 0, semCustoN = 0, comEstoqueN = 0;
  for (const it of itens) {
    const saldo = it.saldo ?? 0;
    if (saldo <= 0) continue;
    comEstoqueN++;
    const cmc = it.cmc ?? 0;
    if (cmc > 0) totalRs += saldo * cmc;
    else semCustoN++;
  }
  return { totalRs, semCustoN, comEstoqueN };
}

export type SituacaoTipo =
  | "ok" | "sem_preco" | "sem_leadtime" | "sem_fornecedor"
  | "sem_grupo" | "aguardando_2a_ordem" | "sem_parametro" | "outro";
export type SituacaoCta = "resolver_bloqueio" | "cold_start" | "manter_ou_descontinuar" | "em_dia";

export function classificarSituacao(
  statusSugestao: string | null,
  estoqueMinimo: number | null,
): { tipo: SituacaoTipo; label: string; cta: SituacaoCta } {
  switch (statusSugestao) {
    case "OK": return { tipo: "ok", label: "Em dia", cta: "em_dia" };
    case "SEM_PRECO": return { tipo: "sem_preco", label: "Sem preço de custo", cta: "resolver_bloqueio" };
    case "SEM_LEADTIME_DEFINIDO": return { tipo: "sem_leadtime", label: "Sem lead time", cta: "resolver_bloqueio" };
    case "AGUARDANDO_HABILITACAO_FORNECEDOR": return { tipo: "sem_fornecedor", label: "Fornecedor não habilitado", cta: "resolver_bloqueio" };
    case "SEM_FORNECEDOR_IDENTIFICADO": return { tipo: "sem_fornecedor", label: "Sem fornecedor", cta: "resolver_bloqueio" };
    case "AGUARDANDO_CLASSIFICACAO_GRUPO": return { tipo: "sem_grupo", label: "Aguardando grupo", cta: "resolver_bloqueio" };
    case "AGUARDANDO_SEGUNDA_ORDEM": return { tipo: "aguardando_2a_ordem", label: "Aguardando 2ª compra", cta: "cold_start" };
    default:
      if (estoqueMinimo == null) return { tipo: "sem_parametro", label: "Sem parâmetro", cta: "manter_ou_descontinuar" };
      return { tipo: "outro", label: statusSugestao ?? "—", cta: "manter_ou_descontinuar" };
  }
}

export function diasSemVender(ultimaVendaISO: string | null, hojeISO: string): number | null {
  if (!ultimaVendaISO) return null;
  const ms = Date.parse(hojeISO) - Date.parse(ultimaVendaISO);
  return Math.floor(ms / 86_400_000);
}

export function previewManterLote(
  itens: Array<{ ppAtual: number | null; maxAtual: number | null; posicao: number; custo: number | null }>,
  ppNovo: number,
  maxNovo: number,
): { qtdeTotal: number; valorTotalRs: number; semCustoN: number } {
  let qtdeTotal = 0, valorTotalRs = 0, semCustoN = 0;
  for (const it of itens) {
    const { qtdeDepois } = impactoSimulado({
      ppAntes: it.ppAtual, maxAntes: it.maxAtual,
      ppDepois: ppNovo, maxDepois: maxNovo,
      posicao: it.posicao, custo: it.custo,
    });
    if (qtdeDepois <= 0) continue;
    qtdeTotal += qtdeDepois;
    if (it.custo != null && it.custo > 0) valorTotalRs += qtdeDepois * it.custo;
    else semCustoN++;
  }
  return { qtdeTotal, valorTotalRs, semCustoN };
}
