// Helpers puros da ATRIBUIÇÃO do item de recebimento (omie-sync-sku-items).
//
// Por que existem: uma mesma chave de NFe pode cobrir VÁRIOS pedidos — cada pedido tem
// sua própria linha em purchase_orders_tracking. A edge gravava o histórico sob
// `tracking_id = <a linha que FEZ a consulta>`, mas resolvia o t1 a partir de OUTRA linha
// (o pedido real do item). Resultado: t1 e tracking_id vinham de linhas diferentes, e cada
// linha irmã regravava TODOS os itens da NFe sob si — histórico duplicado, e com o t4 da
// irmã (não do recebimento) o MESMO item ganhava leadtimes divergentes.
//
// Aqui o item é atribuído ao pedido DELE; a unicidade
// (tracking_id, sku_codigo_omie, nid_receb) então deduplica sozinha entre irmãs, e
// entregas parciais (mesmo SKU do mesmo pedido em NFes distintas) coexistem por terem
// nid_receb distintos.
//
// ESPELHADOS verbatim na edge supabase/functions/omie-sync-sku-items/index.ts
// (bloco // MIRROR-START sku-items-atribuicao) — o Deno da edge não importa de src/;
// a paridade é provada em src/__tests__/edge-money-path-invariants.test.ts.

// MIRROR-START sku-items-atribuicao
export interface PedidoCandidato {
  id: string;
  t1_data_pedido: string;
  numero_pedido: string | null;
  grupo_leadtime: string | null;
  fornecedor_nome: string | null;
}

/** Data BR (dd/mm/aaaa [+ hh:mm]) → ISO com offset de São Paulo. */
export function parseBRDateToISO(
  dateBR?: string | null,
  timeBR?: string | null,
): string | null {
  if (!dateBR) return null;
  const m = dateBR.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  if (!m) return null;
  const [, dd, mm, yyyy] = m;
  const time = timeBR && /^\d{2}:\d{2}(:\d{2})?$/.test(timeBR)
    ? (timeBR.length === 5 ? `${timeBR}:00` : timeBR)
    : "00:00:00";
  return `${yyyy}-${mm}-${dd}T${time}-03:00`;
}

/** O pedido dono do item. AMBÍGUO (mais de um candidato) ⇒ null: precisão > recall.
 *  O `.limit(1)` sem `.order()` que existia antes escolhia de forma NÃO-determinística e
 *  podia carimbar no item o t1 de um pedido que não é o dele. */
export function resolverPedidoDoItem(
  candidatos: PedidoCandidato[],
): PedidoCandidato | null {
  return candidatos.length === 1 ? candidatos[0] : null;
}

/** tracking_id do histórico: o PEDIDO do item quando resolvido; senão a linha da NFe
 *  (comportamento atual). É isto que faz irmãs da mesma NFe convergirem para a mesma
 *  chave — sem isto, cada irmã regrava os mesmos itens sob si. */
export function trackingIdDoItem(
  pedido: PedidoCandidato | null,
  fallbackNfeId: string,
): string {
  return pedido?.id ?? fallbackNfeId;
}

/** t4 do PAYLOAD do recebimento (autoritativo p/ todas as irmãs), não da linha que
 *  consultou. Não recebido ⇒ null (ausente ≠ data errada). Payload ilegível ⇒ degrada
 *  para o valor da linha. */
export function t4DoRecebimento(
  detalhe: unknown,
  fallbackT4: string | null,
): string | null {
  const info = (detalhe as { infoCadastro?: Record<string, unknown> } | null)?.infoCadastro;
  if (!info) return fallbackT4;
  const recebido = String(info.cRecebido ?? "N").toUpperCase() === "S";
  if (!recebido) return null;
  const iso = parseBRDateToISO(
    info.dRec as string | null | undefined,
    info.hRec as string | null | undefined,
  );
  return iso ?? fallbackT4;
}
// MIRROR-END
