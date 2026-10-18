// Passada SÓ DE ENCERRADOS do PesquisarPedCompra (money-path, R59 do orçamento de compra).
//
// Por quê: o encerramento NÃO aparece no cabeçalho — 1014/1049/1032, encerrados no Omie, vêm com
// cEtapa="15" (até o webhook CompraProduto.Encerrada traz "15"). O único sinal é o filtro
// lExibirPedidosEncerrados, que a varredura completa liga JUNTO com todos os outros e por isso não
// distingue. Esta passada liga SÓ ele, e o conjunto vira purchase_orders_tracking.encerrado_omie_em
// pela RPC reposicao_marcar_encerrados_omie (1 writer).
//
// ⚠️ Que o filtro sozinho devolve SÓ encerrados é hipótese até a 1ª rodada em produção com controles
// (1014/1049 aparecem; pedido aberto de out/2026 não). As guardas abaixo não provam isso — só barram
// a falha grosseira (filtro ignorado ⇒ tudo volta), que marcaria todo pedido como fora do caixa.

/** Os 7 filtros da varredura completa: todos ligados (o espelho inteiro). */
export const FILTROS_TODOS: Readonly<Record<string, "T" | "F">> = {
  lExibirPedidosPendentes: "T",
  lExibirPedidosFaturados: "T",
  lExibirPedidosRecebidos: "T",
  lExibirPedidosCancelados: "T",
  lExibirPedidosEncerrados: "T",
  lExibirPedidosRecParciais: "T",
  lExibirPedidosFatParciais: "T",
};

/** Só encerrados: os outros 6 DESLIGADOS explicitamente (omitir = default do Omie, desconhecido). */
export const FILTROS_SO_ENCERRADOS: Readonly<Record<string, "T" | "F">> = {
  lExibirPedidosPendentes: "F",
  lExibirPedidosFaturados: "F",
  lExibirPedidosRecebidos: "F",
  lExibirPedidosCancelados: "F",
  lExibirPedidosEncerrados: "T",
  lExibirPedidosRecParciais: "F",
  lExibirPedidosFatParciais: "F",
};

/** yyyy-mm-dd → dd/mm/yyyy (a janela da passada é a MESMA do completo, que o summary guarda em ISO). */
export function isoParaBR(iso: string | null): string | null {
  const m = iso?.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  return m ? `${m[3]}/${m[2]}/${m[1]}` : null;
}

export type DecisaoEncerrados =
  | { tipo: "publicar"; ids: number[] }
  | { tipo: "abster"; motivo: string };

/**
 * Decide se o conjunto da passada de encerrados pode ser publicado. Fail-closed: qualquer dúvida
 * ABSTÉM (nada marcado nem limpo; o marcador grava o motivo e o Sentinela alerta).
 *
 * - a passada de encerrados e o completo do MESMO run precisam ter terminado limpos;
 * - encerrados ⊆ completo: o completo liga todos os filtros na mesma janela, então um encerrado que ele
 *   não viu é paginação/janela divergente;
 * - encerrados = completo inteiro (não-vazio): o filtro foi IGNORADO e devolveu tudo — publicar tiraria
 *   do caixa todo disparado sem NF;
 * - mais da metade do completo encerrada: implausível para o espelho de compras; abstém em vez de confiar.
 *   Conjunto VAZIO publica: limpar marcas devolve pedidos ao caixa, o lado conservador.
 */
export function decidirPublicacaoEncerrados(e: {
  completaEncerrados: boolean;
  idsEncerrados: ReadonlySet<number>;
  completaGeral: boolean;
  idsGeral: ReadonlySet<number>;
}): DecisaoEncerrados {
  if (!e.completaGeral) return { tipo: "abster", motivo: "varredura completa não terminou limpa" };
  if (!e.completaEncerrados) return { tipo: "abster", motivo: "passada de encerrados não terminou limpa" };
  const fora = [...e.idsEncerrados].filter((id) => !e.idsGeral.has(id));
  if (fora.length > 0) {
    return { tipo: "abster", motivo: `${fora.length} encerrado(s) fora da varredura completa (janela/paginação divergente)` };
  }
  const n = e.idsEncerrados.size;
  if (n > 0 && n === e.idsGeral.size) {
    return { tipo: "abster", motivo: "filtro de encerrados devolveu a varredura inteira (filtro ignorado?)" };
  }
  if (n * 2 > e.idsGeral.size) {
    return { tipo: "abster", motivo: `encerrados (${n}) passam da metade da varredura (${e.idsGeral.size}) — implausível` };
  }
  return { tipo: "publicar", ids: [...e.idsEncerrados].sort((a, b) => a - b) };
}
