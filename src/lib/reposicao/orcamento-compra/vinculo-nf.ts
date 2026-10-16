// src/lib/reposicao/orcamento-compra/vinculo-nf.ts
// R57/R58: NFs de um pedido disparado além da linha do tracking (decisão do founder 2026-10-16, endurecida
// pelo challenge Codex xhigh da mesma data). A NF órfã do tracking (chegou antes da linha do pedido) e o
// pedido refeito à mão no Omie deixavam pedidos faturados e pagos sem NF → "não conciliado" para sempre.
// Aqui só se ACRESCENTA NF, com a data em que ela passou a existir; quem decide se liquida é
// `conciliarCompromissos` com os títulos as-of (existir NF ≠ pago).
import { diffDias, type DataISO } from './datas';

export interface PedidoOmieSay {
  codigo: string;
  t1: DataISO;
  /** cContrato do cabeçalho Omie = nº do pedido na Sayerlack */
  contrato: string | null;
  /** existe em pedido_compra_sugerido (qualquer status) — pedido do motor nunca é substituto */
  doMotor: boolean;
  itens: { prod: string; qtde: number }[];
}
/** Par (nNumPedCompra do item, NF da linha) de itensRecebimento — órfã ou não; data = faturamento da NF */
export interface NfDoContrato { contrato: string; nf: string; data: DataISO }
export interface DisparadoVinculo { id: number; omiePedido: string | null; protocolo: string | null; nfs: string[] }
export interface NfVinculada { nf: string; data: DataISO }
export type ViaNf = 'contrato' | 'substituto';

const chave = (s: string | null | undefined) => (s ?? '').trim();

/** Multiconjunto (produto, qtde) canônico; null = vazio ou algum item inválido (ausente ≠ igual). */
function assinatura(itens: { prod: string; qtde: number }[]): string | null {
  if (!itens.length) return null;
  if (itens.some((i) => chave(i.prod) === '' || !Number.isFinite(i.qtde))) return null;
  return itens.map((i) => `${chave(i.prod)}|${i.qtde}`).sort().join(';');
}

/**
 * Só para disparados SEM NF no tracking. Devolve os vínculos novos (id → NFs com data, via).
 * R57 (A): todo identificador Sayerlack do pedido (cContrato, protocolo do portal) tem de ter NF; se um deles
 *   não tem, aquele pedido na Sayerlack pode estar em aberto (ex.: reenvio ao portal) → não liga.
 * R58 (B): só quando o pedido não tem NENHUM identificador Sayerlack (não chegou à Sayerlack pelo motor): pedido Omie
 *   manual com o mesmo multiconjunto de itens, t1 em [t1(d), t1(d)+janela], com NF por contrato, cujo contrato
 *   não pertence a nenhum pedido do motor (proprietário concorrente) — e unicidade nos dois sentidos.
 */
export function vincularNfs(
  disparados: DisparadoVinculo[],
  pedidos: PedidoOmieSay[],
  nfsDoContrato: NfDoContrato[],
  opts: { janelaSubstitutoDias: number },
): Map<number, { nfs: NfVinculada[]; via: ViaNf }> {
  if (!Number.isFinite(opts.janelaSubstitutoDias) || opts.janelaSubstitutoDias < 0) throw new Error('janelaSubstitutoDias inválida');
  const porContrato = new Map<string, Map<string, DataISO>>();
  for (const x of nfsDoContrato) {
    const k = chave(x.contrato);
    if (k === '' || chave(x.nf) === '' || !x.data) continue; // vazio não identifica; sem data não é as-of
    const m = porContrato.get(k) ?? new Map<string, DataISO>();
    const ant = m.get(x.nf);
    if (!ant || x.data < ant) m.set(x.nf, x.data);
    porContrato.set(k, m);
  }
  const nfsDe = (ids: string[]): NfVinculada[] => {
    const m = new Map<string, DataISO>();
    for (const id of ids) for (const [nf, data] of porContrato.get(id) ?? []) if (!m.has(nf) || data < m.get(nf)!) m.set(nf, data);
    return [...m].map(([nf, data]) => ({ nf, data })).sort((a, b) => (a.nf < b.nf ? -1 : 1));
  };
  const pedidoPorCodigo = new Map(pedidos.map((p) => [p.codigo, p]));
  const donosDoMotor = new Set<string>([
    ...pedidos.filter((p) => p.doMotor).map((p) => chave(p.contrato)),
    ...disparados.map((d) => chave(d.protocolo)),
  ].filter((x) => x !== ''));

  const r = new Map<number, { nfs: NfVinculada[]; via: ViaNf }>();
  const paraB: { d: DisparadoVinculo; p: PedidoOmieSay }[] = [];
  for (const d of disparados) {
    if (d.nfs.some((nf) => chave(nf) !== '')) continue; // o tracking já liga
    const p = d.omiePedido == null ? undefined : pedidoPorCodigo.get(d.omiePedido);
    const ids = [...new Set([chave(p?.contrato), chave(d.protocolo)].filter((x) => x !== ''))];
    if (ids.length && ids.every((id) => porContrato.has(id))) {
      r.set(d.id, { nfs: nfsDe(ids), via: 'contrato' });
      continue;
    }
    if (p && ids.length === 0) paraB.push({ d, p });
  }

  const candidatos = new Map<number, PedidoOmieSay[]>();
  const usos = new Map<string, number>();
  for (const { d, p } of paraB) {
    const ass = assinatura(p.itens);
    if (ass == null) continue;
    const cs = pedidos.filter((o) => {
      const c = chave(o.contrato);
      if (o.doMotor || o.codigo === p.codigo || c === '' || donosDoMotor.has(c) || !porContrato.has(c)) return false;
      const dt = diffDias(p.t1, o.t1);
      return dt >= 0 && dt <= opts.janelaSubstitutoDias && assinatura(o.itens) === ass;
    });
    candidatos.set(d.id, cs);
    cs.forEach((o) => usos.set(o.codigo, (usos.get(o.codigo) ?? 0) + 1));
  }
  for (const [id, cs] of candidatos) {
    if (cs.length !== 1 || usos.get(cs[0].codigo) !== 1) continue;
    r.set(id, { nfs: nfsDe([chave(cs[0].contrato)]), via: 'substituto' });
  }
  return r;
}
