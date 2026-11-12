// QUEM VENDEU cada pedido importado do Omie (venda por cliente · rodada 2 · Entrega 2).
//
// O `ListarPedidos` traz, por pedido, `informacoes_adicionais.codVend` — o vendedor do PRÓPRIO
// pedido (medido na Oben em 2026-11-12: 997/997 pedidos desde 01/09 com o campo; e em 285 de 926
// ele DIFERE do vendedor do cadastro do cliente — não é herança do cadastro). Este módulo extrai
// o par (codigo_pedido, codVend) e monta o lote para o escritor único
// `sales_orders_registrar_vendedor_omie` (migration 20261113120000), que resolve o usuário pelo
// `omie_vendedor_map` e casa só o pedido IMPORTADO da conta.
//
// Ausente ≠ chute:
//   • pedido sem `informacoes_adicionais` (bloco inteiro ausente) → fora do lote: "não lido" fica
//     NULL em `vendedor_lido_em`, distinguível de "Omie sem vendedor";
//   • `codVend` ausente/0/não-inteiro → `cod_vend: null` ("lido, Omie sem vendedor"); a RPC nunca
//     apaga um código já conhecido com esse null.
//
// Separado do index.ts para ser testável no Deno sem o resto da edge (vendedor-pedido_test.ts).

/** Marca ASCII estável do ramo de falha do escritor — o log e o teste casam por ela. */
export const MARCA_VENDEDOR_FALHOU = "VENDEDOR_REGISTRO_FALHOU";

export interface PedidoComVendedor {
  cabecalho?: { codigo_pedido?: unknown };
  informacoes_adicionais?: { codVend?: unknown } | null;
}

export interface VendedorDoPedido {
  codigo_pedido: number;
  cod_vend: number | null;
}

/** Inteiro positivo seguro (número ou string só de dígitos); qualquer outra coisa → null. */
function inteiroPositivo(v: unknown): number | null {
  let n: number;
  if (typeof v === "number") n = v;
  else if (typeof v === "string" && /^\d+$/.test(v.trim())) n = Number(v.trim());
  else return null;
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

/** O par do pedido, ou `null` quando ele não pode entrar no lote (sem código ou não lido). */
export function extrairVendedorDoPedido(p: PedidoComVendedor): VendedorDoPedido | null {
  const codigo = inteiroPositivo(p?.cabecalho?.codigo_pedido);
  if (codigo === null) return null;
  const info = p?.informacoes_adicionais;
  if (info === undefined || info === null || typeof info !== "object") return null;
  return { codigo_pedido: codigo, cod_vend: inteiroPositivo(info.codVend) };
}

/**
 * Lote de uma página: um elemento por pedido. O mesmo pedido repetido na página (o Omie pode
 * devolver duplicado entre páginas que se deslocam) só entra UMA vez — e, se as duas leituras
 * discordam do vendedor, o pedido SAI do lote (a RPC recusaria o lote inteiro por duplicado, e
 * escolher um dos dois seria chute). `ambiguos` conta esses.
 */
export function montarLoteVendedor(pedidos: PedidoComVendedor[]): {
  lote: VendedorDoPedido[];
  naoLidos: number;
  ambiguos: number;
} {
  const porPedido = new Map<number, VendedorDoPedido | "ambiguo">();
  let naoLidos = 0;
  for (const p of pedidos) {
    const v = extrairVendedorDoPedido(p);
    if (v === null) { naoLidos++; continue; }
    const ja = porPedido.get(v.codigo_pedido);
    if (ja === undefined) porPedido.set(v.codigo_pedido, v);
    else if (ja !== "ambiguo" && ja.cod_vend !== v.cod_vend) porPedido.set(v.codigo_pedido, "ambiguo");
  }
  const lote: VendedorDoPedido[] = [];
  let ambiguos = 0;
  for (const v of porPedido.values()) {
    if (v === "ambiguo") ambiguos++;
    else lote.push(v);
  }
  return { lote, naoLidos, ambiguos };
}

/** Resposta do escritor `sales_orders_registrar_vendedor_omie`. */
export interface ResultadoRegistroVendedor {
  recebidos: number;
  casados: number;
  atualizados: number;
  fora_do_banco: number;
  codigos_sem_mapa: number[];
}

/** Acumulador por run — vai para o corpo da resposta e para o `fin_sync_log`. */
export interface ContadoresVendedor {
  vendedor_lidos: number;
  vendedor_atualizados: number;
  vendedor_nao_lidos: number;
  vendedor_ambiguos: number;
  vendedor_falhas: number;
  vendedor_codigos_sem_mapa: number[];
}

export function contadoresVendedorZerados(): ContadoresVendedor {
  return {
    vendedor_lidos: 0,
    vendedor_atualizados: 0,
    vendedor_nao_lidos: 0,
    vendedor_ambiguos: 0,
    vendedor_falhas: 0,
    vendedor_codigos_sem_mapa: [],
  };
}

type ChamadaRpc = (
  fn: string,
  args: Record<string, unknown>,
) => PromiseLike<{ data: unknown; error: { message: string } | null }>;

/**
 * Registra o vendedor de UMA página. Falha do escritor NÃO derruba o import do pedido (o pedido é
 * dinheiro; o vendedor é atribuição) — mas fica LEGÍVEL: conta em `vendedor_falhas`, que vai para a
 * resposta e o `fin_sync_log`, e loga com a marca. A próxima leitura do mesmo pedido (2h depois,
 * por 5 dias; ou o backfill) refaz — o escritor é idempotente.
 */
export async function registrarVendedoresDaPagina(
  rpc: ChamadaRpc,
  account: string,
  pedidos: PedidoComVendedor[],
  acc: ContadoresVendedor,
  log: (msg: string) => void = console.error,
): Promise<void> {
  const { lote, naoLidos, ambiguos } = montarLoteVendedor(pedidos);
  acc.vendedor_nao_lidos += naoLidos;
  acc.vendedor_ambiguos += ambiguos;
  if (lote.length === 0) return;
  const { data, error } = await rpc("sales_orders_registrar_vendedor_omie", {
    p_account: account,
    p_pedidos: lote,
  });
  if (error || !data) {
    acc.vendedor_falhas += lote.length;
    log(`[sync_pedidos][${account}] ${MARCA_VENDEDOR_FALHOU}: ${lote.length} pedido(s) — ${error?.message ?? "resposta vazia"}`);
    return;
  }
  const r = data as ResultadoRegistroVendedor;
  acc.vendedor_lidos += r.casados ?? 0;
  acc.vendedor_atualizados += r.atualizados ?? 0;
  for (const c of r.codigos_sem_mapa ?? []) {
    if (!acc.vendedor_codigos_sem_mapa.includes(c)) acc.vendedor_codigos_sem_mapa.push(c);
  }
}
