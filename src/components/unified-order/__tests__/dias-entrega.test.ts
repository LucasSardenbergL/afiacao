import { describe, it, expect } from 'vitest';
import { proximosDiasUteis } from '../dias-entrega';

// B3 (rodada 2): na quinta o seletor oferecia seg/ter/qua JÁ PASSADAS (startOfWeek).
describe('proximosDiasUteis', () => {
  it('quinta 19/11/2026: começa hoje e pula o fim de semana — nenhum dia passado', () => {
    const quinta = new Date(2026, 10, 19, 15, 30);
    const dias = proximosDiasUteis(quinta);
    expect(dias.map(d => d.value)).toEqual(['2026-11-19', '2026-11-20', '2026-11-23', '2026-11-24', '2026-11-25']);
    expect(dias[0].label.startsWith('hoje · ')).toBe(true);
    expect(dias[1].label.startsWith('hoje')).toBe(false);
  });

  it('sábado: o primeiro dia é a segunda seguinte', () => {
    const sabado = new Date(2026, 10, 21, 9, 0);
    const dias = proximosDiasUteis(sabado);
    expect(dias[0].value).toBe('2026-11-23');
    expect(dias).toHaveLength(5);
    expect(dias.some(d => d.label.startsWith('hoje'))).toBe(false);
  });
});
