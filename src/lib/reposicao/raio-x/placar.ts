// Placar do Raio-X: só mercadoria PARADA com valor entra no total. Sem custo (valor null) não vira R$ 0:
// é contado à parte em `semCustoN`. Fora da mercadoria, três blocos que NUNCA somam ao total:
//   * não-mercadoria (08/imobilizado e afins) e uso e consumo (07, família, marcação) — distorcem o DIO;
//   * matéria-prima / produto em processo (01/03) — estoque industrial legítimo (CPC 16), NÃO distorção.
// Top 61: com coorte congelada, o denominador é a coorte (valor congelado pelo servidor); sem ela, o Top de hoje.
import { DESTINOS, ehEstoqueIndustrial } from './classificar';
import type { CoorteTop, DecisaoRow, Destino, ItemRaioX } from './tipos';

export interface Placar {
  total: number;
  decidido: number;
  pendente: number;
  porDestino: Partial<Record<Destino, number>>;
  /** false = coorte ainda não congelada: o Top abaixo é o de hoje (alvo móvel). */
  coorteCongelada: boolean;
  topTotal: number;
  topDecidido: number;
  topN: number;
  topDecididoN: number;
  /** membros do Top sem custo: contados no N, fora das somas (nunca R$ 0). */
  topSemCustoN: number;
  /** entrariam no Top hoje e não estão na coorte: aparecem, não mexem no denominador. */
  topEntrouDepoisN: number;
  semCustoN: number;
  /** não-mercadoria + uso e consumo (07): o que distorce o DIO. NÃO inclui 01/03. */
  distorceDio: number;
  naoMercadoria: number;
  usoConsumo: number;
  /** matéria-prima / produto em processo (01/03): estoque industrial, fora de `distorceDio`. */
  industrial: number;
  /** uso/não-mercadoria/industrial sem custo: fora das somas acima (contados, nunca R$ 0). */
  semCustoDioN: number;
}

const destinoDecidido = (d: DecisaoRow | undefined): Destino | null =>
  d?.destino && (DESTINOS as readonly string[]).includes(d.destino) ? d.destino : null;

export function placar(itens: ItemRaioX[], decisoes: Map<number, DecisaoRow>, coorte: CoorteTop | null = null): Placar {
  const p: Placar = {
    total: 0, decidido: 0, pendente: 0, porDestino: {}, coorteCongelada: coorte !== null,
    topTotal: 0, topDecidido: 0, topN: 0, topDecididoN: 0, topSemCustoN: 0, topEntrouDepoisN: 0,
    semCustoN: 0, distorceDio: 0, naoMercadoria: 0, usoConsumo: 0, industrial: 0, semCustoDioN: 0,
  };
  for (const i of itens) {
    if (i.entrou_no_top) p.topEntrouDepoisN += 1;
    if (i.categoria !== 'mercadoria') {
      if (i.valor === null) { p.semCustoDioN += 1; continue; }
      if (ehEstoqueIndustrial(i)) p.industrial += i.valor;
      else if (i.categoria === 'uso_consumo') p.usoConsumo += i.valor;
      else p.naoMercadoria += i.valor;
      continue;
    }
    if (!i.parado) continue;
    if (i.valor === null) { p.semCustoN += 1; continue; }
    p.total += i.valor;
    const destino = destinoDecidido(decisoes.get(i.sku_codigo_omie));
    if (destino) {
      p.decidido += i.valor;
      p.porDestino[destino] = (p.porDestino[destino] ?? 0) + i.valor;
    }
  }
  p.distorceDio = p.naoMercadoria + p.usoConsumo;
  p.pendente = p.total - p.decidido;

  // Top: a coorte congelada vale por si (o SKU pode ter saído da lista — vendeu tudo — e segue no denominador).
  const membros: Array<{ sku: number; valor: number | null }> = coorte
    ? [...coorte.itens].map(([sku, m]) => ({ sku, valor: m.valor }))
    : itens.filter((i) => i.top_atual).map((i) => ({ sku: i.sku_codigo_omie, valor: i.valor }));
  for (const m of membros) {
    p.topN += 1;
    const decidido = destinoDecidido(decisoes.get(m.sku)) !== null;
    if (decidido) p.topDecididoN += 1;
    if (m.valor === null) { p.topSemCustoN += 1; continue; }
    p.topTotal += m.valor;
    if (decidido) p.topDecidido += m.valor;
  }
  return p;
}
