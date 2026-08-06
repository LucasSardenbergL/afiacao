import { describe, it, expect } from 'vitest';
import { selecionarUltimoRunSuprimido } from '../shared';

// Linha do log de estoque-não-confirmado (só os campos que o helper toca).
const linha = (run_id: string, sku: string) => ({
  run_id,
  sku_codigo_omie: sku,
  motivo: 'linha_seed_only' as const,
  criado_em: '2026-07-08T09:15:00Z',
});

describe('selecionarUltimoRunSuprimido — a fila ancora no ÚLTIMO run do motor, não no último COM supressão', () => {
  // O bug reportado: às 06:15 o run RUN_0615 suprimiu 2 SKUs (log). Depois o sync confirmou o estoque e o
  // recálculo das 15:15 (RUN_1515) foi LIMPO — não gravou no log. A fila deve refletir RUN_1515 (vazio), não RUN_0615.
  it('run limpo (marcador suprimidos_n=0): a mensagem SOME — ancora no run limpo, sem linhas no log', () => {
    const log = [linha('RUN_0615', '8690166141'), linha('RUN_0615', '8689725397')];
    const { runId, linhas } = selecionarUltimoRunSuprimido({ run_id: 'RUN_1515' }, log);
    expect(runId).toBe('RUN_1515');
    expect(linhas).toEqual([]); // ← o conserto: run mais recente não suprimiu → fila vazia mesmo com log de 24h
  });

  it('marcador aponta run COM supressão: mostra só as linhas daquele run', () => {
    const log = [linha('RUN_NOVO', 'A'), linha('RUN_ANTIGO', 'B')];
    const { runId, linhas } = selecionarUltimoRunSuprimido({ run_id: 'RUN_NOVO' }, log);
    expect(runId).toBe('RUN_NOVO');
    expect(linhas.map((l) => l.sku_codigo_omie)).toEqual(['A']);
  });

  it('marcador AUSENTE (1º deploy, ainda não populou): fallback legado = run mais recente do log', () => {
    const log = [linha('RUN_RECENTE', 'A'), linha('RUN_ANTIGO', 'B')];
    const { runId, linhas } = selecionarUltimoRunSuprimido(null, log);
    expect(runId).toBe('RUN_RECENTE');
    expect(linhas.map((l) => l.sku_codigo_omie)).toEqual(['A']);
  });

  it('marcador presente mas log vazio (run limpo, sem histórico recente): fila vazia', () => {
    const { runId, linhas } = selecionarUltimoRunSuprimido({ run_id: 'RUN_LIMPO' }, []);
    expect(runId).toBe('RUN_LIMPO');
    expect(linhas).toEqual([]);
  });

  it('sem marcador e log vazio: runId null, linhas vazias (nada a mostrar)', () => {
    const { runId, linhas } = selecionarUltimoRunSuprimido(null, []);
    expect(runId).toBeNull();
    expect(linhas).toEqual([]);
  });

  it('não confunde runs: só as linhas do run ancorado (não vaza de outro run do log de 24h)', () => {
    const log = [
      linha('RUN_NOVO', 'A1'),
      linha('RUN_NOVO', 'A2'),
      linha('RUN_ANTIGO', 'B1'),
    ];
    const { linhas } = selecionarUltimoRunSuprimido({ run_id: 'RUN_NOVO' }, log);
    expect(linhas.map((l) => l.sku_codigo_omie)).toEqual(['A1', 'A2']);
  });
});
