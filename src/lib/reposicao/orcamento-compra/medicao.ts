// src/lib/reposicao/orcamento-compra/medicao.ts
import { diffDias, type DataISO } from './datas';
import type { ClasseCorte } from './replay';

export interface Episodio { sku: string; inicio: DataISO; fim: DataISO; valor: number }

export function deduplicarEpisodios(cortes: { sku: string; data: DataISO; valor: number }[], gapDias: number): Episodio[] {
  const ordenados = [...cortes].sort((a, b) => a.sku.localeCompare(b.sku) || a.data.localeCompare(b.data));
  const out: Episodio[] = [];
  for (const c of ordenados) {
    const ult = out[out.length - 1];
    if (ult && ult.sku === c.sku && diffDias(ult.fim, c.data) <= gapDias) {
      ult.fim = c.data;
      ult.valor = Math.max(ult.valor, c.valor);
    } else out.push({ sku: c.sku, inicio: c.data, fim: c.data, valor: c.valor });
  }
  return out;
}

export function precisaoDoCorte(itens: { classe: ClasseCorte; valor: number }[]) {
  const validos = itens.filter((i) => i.classe !== 'indeterminado');
  const valorCortado = validos.reduce((s, i) => s + i.valor, 0);
  const seguro = validos.filter((i) => i.classe !== 'teria_rompido').reduce((s, i) => s + i.valor, 0);
  return {
    precisao: valorCortado > 0 ? seguro / valorCortado : null,
    valorCortado,
    n: validos.length,
    indeterminados: itens.length - validos.length,
  };
}

export function deltaDio(estoqueMedioCustoCom: number, estoqueMedioCustoSem: number, cmvDiario: number | null): number | null {
  if (cmvDiario == null || !(cmvDiario > 0)) return null;
  return (estoqueMedioCustoCom - estoqueMedioCustoSem) / cmvDiario;
}
