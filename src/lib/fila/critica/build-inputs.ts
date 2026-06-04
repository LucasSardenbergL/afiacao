// src/lib/fila/critica/build-inputs.ts
import type { AcaoSugerida } from '@/lib/fila/types';
import type { CriticaInput, MetricaCliente, RotaCliente, TarefaCliente } from './types';

export interface MetricRowFull {
  customer_user_id: string;
  intervalo_medio_dias: number | null;
  dias_desde_ultima_compra: number | null;
  atraso_relativo: number | null;
  faturamento_90d: number | null;
  faturamento_prev_90d: number | null;
  is_cold_start: boolean | null;
}
export interface RotaSinalCliente {
  customerUserId: string;
  naCallQueue: boolean;
  semRespostaRecenteN: number;
  ultimoContatoRealHaDias: number | null;
}
export interface TarefaSinalCliente {
  customerUserId: string;
  atrasada: boolean;
  temSugestaoPendente: boolean;
  descricao: string;
}

/**
 * Junta ações + linhas de sinal em CriticaInput[] (1 por cliente, dedupe na ordem das ações).
 * rotaSinais === null ⇒ cadência indisponível (rota null em todos = degradação honesta).
 * rotaSinais !== null mas sem o cliente ⇒ rota lida, cliente sem sinal (default neutro).
 */
export function buildCriticaInputs(
  acoes: AcaoSugerida[],
  metricas: MetricRowFull[],
  rotaSinais: RotaSinalCliente[] | null,
  tarefaSinais: TarefaSinalCliente[],
): CriticaInput[] {
  const mByCli = new Map(metricas.map(m => [m.customer_user_id, m]));
  const rByCli = rotaSinais ? new Map(rotaSinais.map(s => [s.customerUserId, s])) : null;

  // 1 tarefa por cliente: prioriza a atrasada-com-indício
  const tByCli = new Map<string, TarefaSinalCliente>();
  for (const s of tarefaSinais) {
    const atual = tByCli.get(s.customerUserId);
    if (!atual || (s.atrasada && s.temSugestaoPendente)) tByCli.set(s.customerUserId, s);
  }

  const out: CriticaInput[] = [];
  const vistos = new Set<string>();
  for (const a of acoes) {
    const cli = a.clienteUserId;
    if (cli == null || vistos.has(cli)) continue;
    vistos.add(cli);

    const mRow = mByCli.get(cli);
    const metrica: MetricaCliente | null = mRow
      ? {
          intervaloMedioDias: mRow.intervalo_medio_dias,
          diasDesdeUltimaCompra: mRow.dias_desde_ultima_compra,
          atrasoRelativo: mRow.atraso_relativo,
          faturamento90d: mRow.faturamento_90d,
          faturamentoPrev90d: mRow.faturamento_prev_90d,
          isColdStart: mRow.is_cold_start ?? false,
        }
      : null;

    let rota: RotaCliente | null;
    if (rByCli == null) rota = null; // cadência indisponível globalmente
    else {
      const rRow = rByCli.get(cli);
      rota = rRow
        ? { naCallQueue: rRow.naCallQueue, semRespostaRecenteN: rRow.semRespostaRecenteN, ultimoContatoRealHaDias: rRow.ultimoContatoRealHaDias }
        : { naCallQueue: false, semRespostaRecenteN: 0, ultimoContatoRealHaDias: null };
    }

    const tRow = tByCli.get(cli);
    const tarefa: TarefaCliente | null = tRow
      ? { atrasada: tRow.atrasada, temSugestaoPendente: tRow.temSugestaoPendente, descricao: tRow.descricao }
      : null;

    out.push({ clienteUserId: cli, clienteNome: a.clienteNome, metrica, rota, tarefa });
  }
  return out;
}
