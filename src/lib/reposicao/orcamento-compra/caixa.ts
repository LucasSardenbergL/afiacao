// src/lib/reposicao/orcamento-compra/caixa.ts
// Guarda de caixa diária (spec §6). Saldo = fim do dia. Fluxo antes do início cai no início.
import { addDias, diffDias, type DataISO } from './datas';

export type Camada =
  | 'base_titulos' | 'reconciliacao_saldo' | 'compromisso_conciliado' | 'compromisso_nao_conciliado'
  | 'saida_nao_sayerlack' | 'continuidade_motor' | 'candidato';

export interface Fluxo { data: DataISO; valor: number; camada: Camada }
export interface PontoTrajetoria { data: DataISO; saldo: number }

export type EstadoCaixa =
  | { tipo: 'viavel'; piso: number; dataPiso: DataISO }
  | { tipo: 'inviavel'; primeiraViolacao: DataISO; deficitMax: number }
  | { tipo: 'indeterminado'; camadas: string[]; piso: number | null };

export function trajetoriaDiaria(saldoInicial: number, inicio: DataISO, dias: number, fluxos: Fluxo[]): PontoTrajetoria[] {
  let n = dias;
  for (const fl of fluxos) n = Math.max(n, diffDias(inicio, fl.data) + 1);
  const delta = new Array<number>(n).fill(0);
  for (const fl of fluxos) delta[Math.max(0, diffDias(inicio, fl.data))] += fl.valor;
  let saldo = saldoInicial;
  return delta.map((v, i) => {
    saldo += v;
    return { data: addDias(inicio, i), saldo };
  });
}

export function avaliarEstado(traj: PontoTrajetoria[], reserva: number, ausencias: string[]): EstadoCaixa {
  // Trajetória vazia = nada a avaliar: fail-closed (nunca 'viavel' com piso Infinity).
  if (traj.length === 0) return { tipo: 'indeterminado', camadas: [...ausencias, 'trajetoria_vazia'], piso: null };
  let piso = Infinity;
  let dataPiso = traj[0]?.data ?? '';
  let primeiraViolacao: DataISO | null = null;
  for (const p of traj) {
    if (p.saldo < piso) { piso = p.saldo; dataPiso = p.data; }
    if (primeiraViolacao === null && p.saldo < reserva) primeiraViolacao = p.data;
  }
  if (ausencias.length > 0) return { tipo: 'indeterminado', camadas: [...ausencias], piso };
  if (primeiraViolacao !== null) return { tipo: 'inviavel', primeiraViolacao, deficitMax: reserva - piso };
  return { tipo: 'viavel', piso, dataPiso };
}

export function fluxosDeSemanaAgregada(inicio: DataISO, fim: DataISO, entradas: number, saidas: number): Fluxo[] {
  return [
    { data: inicio, valor: -saidas, camada: 'base_titulos' },
    { data: fim, valor: entradas, camada: 'base_titulos' },
  ];
}
