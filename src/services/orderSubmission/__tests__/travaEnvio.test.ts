import { describe, it, expect, vi } from 'vitest';
import { executarComTravaDeEnvio, protegerDuranteEnvio, ENVIO_EM_ANDAMENTO } from '../travaEnvio';

// A2/A3/A5 (rodada 2) — a trava de envio do Novo Pedido.
describe('executarComTravaDeEnvio', () => {
  it('A2: return antecipado no corpo (ex.: conflito de envelope) LIBERA a trava — o próximo envio roda', async () => {
    const trava = { current: false };
    const setSubmitting = vi.fn();
    await executarComTravaDeEnvio(trava, setSubmitting, async () => 'conflito');
    expect(trava.current).toBe(false);
    const corpo = vi.fn().mockResolvedValue('enviado');
    expect(await executarComTravaDeEnvio(trava, setSubmitting, corpo)).toBe('enviado');
    expect(corpo).toHaveBeenCalledTimes(1);
    expect(setSubmitting.mock.calls.map(c => c[0])).toEqual([true, false, true, false]);
  });

  it('exceção no corpo também libera a trava', async () => {
    const trava = { current: false };
    await expect(executarComTravaDeEnvio(trava, vi.fn(), async () => { throw new Error('rede'); }))
      .rejects.toThrow('rede');
    expect(trava.current).toBe(false);
  });

  it('A3: toque duplo — a 2ª chamada com a 1ª em voo NÃO roda o corpo', async () => {
    const trava = { current: false };
    let soltar!: () => void;
    const corpo = vi.fn(() => new Promise<void>(r => { soltar = r; }));
    const primeira = executarComTravaDeEnvio(trava, vi.fn(), corpo);
    const segunda = await executarComTravaDeEnvio(trava, vi.fn(), corpo);
    expect(segunda).toBe(ENVIO_EM_ANDAMENTO);
    expect(corpo).toHaveBeenCalledTimes(1);
    soltar();
    await primeira;
    expect(trava.current).toBe(false);
  });
});

describe('protegerDuranteEnvio (A5)', () => {
  it('com envio em voo o mutador NÃO roda e avisa; fora do envio roda normal', () => {
    const trava = { current: false };
    const add = vi.fn((_id: string, _qtd: number) => undefined);
    const aviso = vi.fn();
    const { add: addProtegido } = protegerDuranteEnvio(trava, { add }, aviso);
    addProtegido('p1', 2);
    expect(add).toHaveBeenCalledWith('p1', 2);
    trava.current = true;
    addProtegido('p2', 1);
    expect(add).toHaveBeenCalledTimes(1);
    expect(aviso).toHaveBeenCalledTimes(1);
  });
});
