import { describe, it, expect } from 'vitest';
import { idadeHoras, frescorCarteira, frescorTexto } from '../montar';
import { EXCECOES_CFG_DEFAULT } from '../types';

const cfg = EXCECOES_CFG_DEFAULT;
const AGORA = '2026-06-04T12:00:00.000Z';

describe('idadeHoras', () => {
  it('calcula horas inteiras entre dois ISO', () => {
    expect(idadeHoras('2026-06-04T06:00:00.000Z', AGORA)).toBe(6);
    expect(idadeHoras(null, AGORA)).toBeNull();
    expect(idadeHoras('lixo', AGORA)).toBeNull();
  });
});

describe('frescorCarteira', () => {
  it('classifica por idade do max(created_at)', () => {
    expect(frescorCarteira('2026-06-04T00:00:00.000Z', AGORA, cfg)).toBe('fresh'); // 12h
    expect(frescorCarteira('2026-06-03T06:00:00.000Z', AGORA, cfg)).toBe('stale'); // 30h
    expect(frescorCarteira('2026-06-01T12:00:00.000Z', AGORA, cfg)).toBe('desatualizada'); // 72h
    expect(frescorCarteira(null, AGORA, cfg)).toBe('desatualizada'); // sem dado = desatualizada
  });
});

describe('frescorTexto', () => {
  it('horas até 48h, dias acima', () => {
    expect(frescorTexto(6)).toBe('há 6h');
    expect(frescorTexto(30)).toBe('há 30h');
    expect(frescorTexto(72)).toBe('há 3d');
    expect(frescorTexto(null)).toBeNull();
  });
});
