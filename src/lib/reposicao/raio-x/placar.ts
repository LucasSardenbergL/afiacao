// Placar do Raio-X: só mercadoria PARADA com valor entra no total. Sem custo (valor null) não vira R$ 0:
// é contado à parte em `semCustoN`. `nao_mercadoria`/`uso_consumo` distorcem o DIO e ficam em `distorceDio`,
// nunca somados ao total.
import { DESTINOS } from './classificar';
import type { DecisaoRow, Destino, ItemRaioX } from './tipos';

export interface Placar {
  total: number;
  decidido: number;
  pendente: number;
  porDestino: Partial<Record<Destino, number>>;
  topTotal: number;
  topDecidido: number;
  semCustoN: number;
  distorceDio: number;
}

const destinoDecidido = (d: DecisaoRow | undefined): Destino | null =>
  d?.destino && (DESTINOS as readonly string[]).includes(d.destino) ? d.destino : null;

export function placar(itens: ItemRaioX[], decisoes: Map<number, DecisaoRow>): Placar {
  const p: Placar = {
    total: 0, decidido: 0, pendente: 0, porDestino: {}, topTotal: 0, topDecidido: 0, semCustoN: 0, distorceDio: 0,
  };
  for (const i of itens) {
    if (i.categoria !== 'mercadoria') {
      if (i.valor !== null) p.distorceDio += i.valor;
      continue;
    }
    if (!i.parado) continue;
    if (i.valor === null) { p.semCustoN += 1; continue; }
    p.total += i.valor;
    if (i.top) p.topTotal += i.valor;
    const destino = destinoDecidido(decisoes.get(i.sku_codigo_omie));
    if (destino) {
      p.decidido += i.valor;
      if (i.top) p.topDecidido += i.valor;
      p.porDestino[destino] = (p.porDestino[destino] ?? 0) + i.valor;
    }
  }
  p.pendente = p.total - p.decidido;
  return p;
}
