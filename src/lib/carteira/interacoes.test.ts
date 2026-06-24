import { describe, it, expect } from 'vitest';
import { canalToLabel, canalToTone, canalToKind, formatDiasSemContato } from './interacoes';

describe('carteira/interacoes helpers', () => {
  it('mapeia canal para label', () => {
    expect(canalToLabel('ligacao')).toBe('Ligação');
    expect(canalToLabel('whatsapp')).toBe('WhatsApp');
    expect(canalToLabel('visita')).toBe('Visita');
    expect(canalToLabel('tarefa')).toBe('Tarefa');
    expect(canalToLabel('mensagem_pedido')).toBe('Mensagem do pedido');
  });

  it('tom por canal usa tokens de status (não cores cruas)', () => {
    expect(canalToTone('visita')).toContain('text-status');
    expect(canalToTone('whatsapp')).toContain('text-status');
  });

  it('mapeia canal para o kind do ActivityColumn', () => {
    expect(canalToKind('ligacao')).toBe('call');
    expect(canalToKind('whatsapp')).toBe('call');
    expect(canalToKind('visita')).toBe('visit');
    expect(canalToKind('tarefa')).toBe('task');
    expect(canalToKind('mensagem_pedido')).toBe('message');
  });

  it('formata dias sem contato', () => {
    expect(formatDiasSemContato(null)).toBe('Nunca contatado');
    expect(formatDiasSemContato(0)).toBe('Hoje');
    expect(formatDiasSemContato(1)).toBe('1 dia');
    expect(formatDiasSemContato(20)).toBe('20 dias');
  });
});
