// src/lib/fila/critica/__tests__/build-inputs.test.ts
import { describe, it, expect } from 'vitest';
import { buildCriticaInputs, type MetricRowFull, type RotaSinalCliente, type TarefaSinalCliente, type WaSlaSinalCliente } from '../build-inputs';
import type { AcaoSugerida } from '@/lib/fila/types';

const acao = (clienteUserId: string | null, nome: string | null = 'X'): AcaoSugerida => ({
  fonte: 'tarefa', entidadeId: 'e', clienteUserId, clienteNome: nome, telefone: null,
  acao: 'Ligar', titulo: 't', motivo: 'm', categoria: 'risco', score: 0.5,
  valorEsperado: null, tipoValor: 'sem_valor', cta: 'ligar', dedupeKey: `k:${clienteUserId}`,
  payload: { kind: 'tarefa', tarefaId: 'e' },
});

const metric = (id: string): MetricRowFull => ({
  customer_user_id: id, intervalo_medio_dias: 15, dias_desde_ultima_compra: 30,
  atraso_relativo: 2.0, faturamento_90d: 1000, faturamento_prev_90d: 1000, is_cold_start: false,
});

describe('buildCriticaInputs', () => {
  it('dedupa por cliente e normaliza métrica/rota/tarefa', () => {
    const acoes = [acao('c1'), acao('c1'), acao('c2'), acao(null)];
    const rota: RotaSinalCliente[] = [{ customerUserId: 'c1', naCallQueue: true, semRespostaRecenteN: 3, ultimoContatoRealHaDias: 2 }];
    const tarefas: TarefaSinalCliente[] = [{ customerUserId: 'c2', atrasada: true, temSugestaoPendente: true, descricao: 'd' }];
    const out = buildCriticaInputs(acoes, [metric('c1')], rota, tarefas);

    expect(out.map(i => i.clienteUserId)).toEqual(['c1', 'c2']); // dedupe + ignora null
    const c1 = out.find(i => i.clienteUserId === 'c1')!;
    expect(c1.metrica?.atrasoRelativo).toBe(2.0);
    expect(c1.rota?.naCallQueue).toBe(true);
    expect(c1.tarefa).toBeNull();
    const c2 = out.find(i => i.clienteUserId === 'c2')!;
    expect(c2.metrica).toBeNull(); // sem linha de métrica
    expect(c2.rota).toEqual({ naCallQueue: false, semRespostaRecenteN: 0, ultimoContatoRealHaDias: null }); // rota lida, sem sinal deste cliente
    expect(c2.tarefa?.temSugestaoPendente).toBe(true);
  });

  it('rotaSinais=null (cadência indisponível) → rota null em todos', () => {
    const out = buildCriticaInputs([acao('c1')], [metric('c1')], null, []);
    expect(out[0].rota).toBeNull();
  });

  it('mapeia waSla por cliente (vermelho); ausência → null', () => {
    const acoes = [acao('c1'), acao('c2')];
    const wa: WaSlaSinalCliente[] = [{ customerUserId: 'c1', minutosUteis: 45, nivel: 'vermelho' }];
    const out = buildCriticaInputs(acoes, [], null, [], wa);
    expect(out.find(i => i.clienteUserId === 'c1')!.waSla).toEqual({ minutosUteis: 45, nivel: 'vermelho' });
    expect(out.find(i => i.clienteUserId === 'c2')!.waSla).toBeNull();
  });
});
