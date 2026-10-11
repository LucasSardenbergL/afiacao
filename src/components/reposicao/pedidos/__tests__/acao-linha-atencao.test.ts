import { describe, it, expect } from 'vitest';
import { acaoLinhaAtencao } from '../shared';

// Ação PRIMÁRIA de cada linha da fila "Precisam de atenção". Caso real (#3169, 2026-09-30):
// aprovado + erro_nao_retentavel (GRUPO_LEADTIME_MISMATCH) ficou 11 dias na fila só com "Disparar"
// na linha — o cancelamento existia, mas escondido no drawer do portal. "Disparar" ali rebaixa o
// erro terminal para pendente e reenvia os MESMOS itens que o ciclo seguinte já comprou (#3174).
const base = { resposta_canal: null };

describe('acaoLinhaAtencao', () => {
  it('aprovado + erro_nao_retentavel → cancelar (NUNCA disparar)', () => {
    expect(
      acaoLinhaAtencao({ ...base, status: 'aprovado_aguardando_disparo', status_envio_portal: 'erro_nao_retentavel' }, false),
    ).toBe('cancelar');
    expect(
      acaoLinhaAtencao({ ...base, status: 'aprovado_aguardando_disparo', status_envio_portal: 'erro_nao_retentavel' }, true),
    ).toBe('cancelar');
  });

  it('falha_envio + erro_nao_retentavel → nenhuma (não cancelável pelo humano; reenvio só pelo drawer)', () => {
    expect(
      acaoLinhaAtencao({ ...base, status: 'falha_envio', status_envio_portal: 'erro_nao_retentavel' }, true),
    ).toBe('nenhuma');
  });

  it('aprovado sem recusa definitiva → disparar (comportamento anterior)', () => {
    expect(
      acaoLinhaAtencao({ ...base, status: 'aprovado_aguardando_disparo', status_envio_portal: 'falha_envio_portal' }, false),
    ).toBe('disparar');
  });

  it('falha_envio sem portal de atenção → disparar (Re-disparar)', () => {
    expect(acaoLinhaAtencao({ ...base, status: 'falha_envio', status_envio_portal: 'nao_aplicavel' }, false)).toBe('disparar');
  });

  it('gate de mínimo com override → override; sem permissão → disparar', () => {
    const p = { status: 'falha_envio', status_envio_portal: 'nao_aplicavel' as const, resposta_canal: { gate: 'minimo_faturamento' } };
    expect(acaoLinhaAtencao(p, true)).toBe('override');
    expect(acaoLinhaAtencao(p, false)).toBe('disparar');
  });

  it('conciliáveis com status disparado → nenhuma', () => {
    expect(
      acaoLinhaAtencao({ ...base, status: 'disparado', status_envio_portal: 'indeterminado_requer_conciliacao' }, true),
    ).toBe('nenhuma');
  });
});
