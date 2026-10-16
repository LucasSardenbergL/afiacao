// Datas como 'YYYY-MM-DD' em aritmética UTC pura (sem fuso): o dia já vem resolvido em America/Sao_Paulo pelo SQL.
export type DataISO = string;

const paraDate = (d: DataISO) => new Date(`${d}T00:00:00Z`);

export function addDias(d: DataISO, n: number): DataISO {
  const x = paraDate(d);
  x.setUTCDate(x.getUTCDate() + n);
  const p2 = (v: number) => String(v).padStart(2, '0');
  return `${x.getUTCFullYear()}-${p2(x.getUTCMonth() + 1)}-${p2(x.getUTCDate())}`;
}

export function diffDias(a: DataISO, b: DataISO): number {
  return Math.round((paraDate(b).getTime() - paraDate(a).getTime()) / 86_400_000);
}

export function ehDiaUtil(d: DataISO): boolean {
  const dia = paraDate(d).getUTCDay();
  return dia !== 0 && dia !== 6;
}
