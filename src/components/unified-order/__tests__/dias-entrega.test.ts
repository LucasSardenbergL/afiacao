import { describe, it, expect } from 'vitest';
import { dataEntregaJaPassou, dataEntregaVencida, dataLocalDeISO, diaLocalISO, proximosDiasUteis } from '../dias-entrega';

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

// Follow-up do #4068 (Codex): a tela que atravessa a virada do dia não pode manter "hoje" velho
// nem deixar ir `ready_by_date` no passado.
describe('virada do dia no seletor de entrega', () => {
  it('dataLocalDeISO ↔ diaLocalISO (meia-noite local, sem deslocar de fuso)', () => {
    const d = dataLocalDeISO('2026-11-21');
    expect([d.getFullYear(), d.getMonth(), d.getDate(), d.getHours()]).toEqual([2026, 10, 21, 0]);
    expect(diaLocalISO(d)).toBe('2026-11-21');
  });
  it('escolha de sexta vira passado quando a lista recalcula na segunda → vencida', () => {
    const dias = proximosDiasUteis(dataLocalDeISO('2026-11-23'));
    expect(dias[0].label.startsWith('hoje')).toBe(true);
    expect(dataEntregaVencida('2026-11-20', dias)).toBe(true);
  });
  it('escolha ainda na lista, vazia ou lista vazia → não vencida', () => {
    const dias = proximosDiasUteis(dataLocalDeISO('2026-11-23'));
    expect(dataEntregaVencida('2026-11-23', dias)).toBe(false);
    expect(dataEntregaVencida('', dias)).toBe(false);
    expect(dataEntregaVencida('2026-11-20', [])).toBe(false);
  });
});

// Codex P2: o timer acorda com folga — o envio confere pelo relógio de AGORA.
describe('dataEntregaJaPassou', () => {
  it('ontem → passou; hoje e amanhã → não; vazio → não', () => {
    expect(dataEntregaJaPassou('2026-11-23', '2026-11-24')).toBe(true);
    expect(dataEntregaJaPassou('2026-11-24', '2026-11-24')).toBe(false);
    expect(dataEntregaJaPassou('2026-11-25', '2026-11-24')).toBe(false);
    expect(dataEntregaJaPassou('', '2026-11-24')).toBe(false);
  });
});
