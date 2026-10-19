import { describe, expect, it } from 'vitest';
import { criarFila, retryDelayCiclo } from '@/lib/financeiro/ciclo-fila';

function adiada() {
  let soltar!: () => void;
  let falhar!: (e: unknown) => void;
  const p = new Promise<void>((res, rej) => { soltar = res; falhar = rej; });
  return { p, soltar, falhar };
}
const tick = () => new Promise((r) => setTimeout(r, 0));

describe('criarFila', () => {
  it('nunca passa do limite e roda na ordem de chegada', async () => {
    const fila = criarFila(2);
    const ordem: number[] = [];
    let ativas = 0;
    let pico = 0;
    const tarefas = Array.from({ length: 5 }, () => adiada());
    const resultados = tarefas.map((t, i) => fila(async () => {
      ordem.push(i); ativas += 1; pico = Math.max(pico, ativas);
      await t.p; ativas -= 1; return i;
    }));
    await tick();
    expect(ordem).toEqual([0, 1]);
    for (const t of tarefas) { t.soltar(); await tick(); }
    expect(await Promise.all(resultados)).toEqual([0, 1, 2, 3, 4]);
    expect(ordem).toEqual([0, 1, 2, 3, 4]);
    expect(pico).toBe(2);
  });

  it('erro (assíncrono ou síncrono) chega ao chamador e devolve a vaga', async () => {
    const fila = criarFila(1);
    const t = adiada();
    const a = fila(() => t.p);
    const b = fila(() => { throw new Error('sincrono'); });
    const c = fila(async () => 'c');
    t.falhar(new Error('timeout 57014'));
    await expect(a).rejects.toThrow('timeout 57014');
    await expect(b).rejects.toThrow('sincrono');
    await expect(c).resolves.toBe('c');
  });

  it('rejeita limite inválido', () => {
    expect(() => criarFila(0)).toThrow('limite inválido');
  });
});

describe('retryDelayCiclo', () => {
  it('espaça e tem teto', () => {
    expect([0, 1, 2, 5].map(retryDelayCiclo)).toEqual([4000, 8000, 16000, 30000]);
  });
});
