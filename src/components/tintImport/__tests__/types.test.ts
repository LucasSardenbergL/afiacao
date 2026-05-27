import { describe, it, expect, vi } from 'vitest';

vi.mock('@/lib/invoke-function', () => ({ invokeFunction: vi.fn() }));

import { invokeFunction } from '@/lib/invoke-function';
import {
  getChunkSize, sha256, sleep, sendChunkWithRetry,
  TIPO_OPTIONS, statusColor, CHUNK_SIZE_DEFAULT, CHUNK_SIZE_FORMULAS,
} from '../types';

describe('getChunkSize', () => {
  it('fórmulas → 50; demais → 200', () => {
    expect(getChunkSize('formulas_padrao')).toBe(CHUNK_SIZE_FORMULAS);
    expect(getChunkSize('formulas_personalizadas')).toBe(CHUNK_SIZE_FORMULAS);
    expect(getChunkSize('dados_corantes')).toBe(CHUNK_SIZE_DEFAULT);
    expect(getChunkSize('qualquer')).toBe(200);
  });
});

describe('sha256', () => {
  it('hash determinístico de "abc"', async () => {
    expect(await sha256('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });
});

describe('sleep', () => {
  it('resolve', async () => {
    await expect(sleep(0)).resolves.toBeUndefined();
  });
});

describe('constantes', () => {
  it('TIPO_OPTIONS e statusColor', () => {
    expect(TIPO_OPTIONS.map(o => o.value)).toEqual([
      'dados_corantes', 'dados_produto_base_embalagem', 'formulas_padrao', 'formulas_personalizadas',
    ]);
    expect(statusColor.concluido).toContain('status-success');
    expect(statusColor.erro).toContain('status-error');
  });
});

describe('sendChunkWithRetry', () => {
  it('sucesso na primeira tentativa retorna o resultado', async () => {
    const mocked = vi.mocked(invokeFunction);
    mocked.mockResolvedValueOnce({ registros_importados: 5, registros_atualizados: 2 });
    const res = await sendChunkWithRetry({ foo: 1 }, 0, 3);
    expect(res.registros_importados).toBe(5);
    expect(mocked).toHaveBeenCalledWith('tint-import', { foo: 1 });
  });
});
