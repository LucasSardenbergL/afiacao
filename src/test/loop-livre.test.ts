import { spawnSync } from 'node:child_process';

import { describe, expect, it, vi } from 'vitest';

import { drenar, type Passos } from '@/lib/gates/passos';

import { cederAoLoop, contarPulsos, drenarCedendo, emFatias, rodar, rodarOk } from './loop-livre';

// O relógio REAL, capturado no load: com fake timers ligados, `performance.now` pode congelar e o
// laço de `queimar` não terminaria nunca.
const agoraReal = performance.now.bind(performance);

/** Queima CPU de verdade por `ms` — o laço síncrono que segura o loop. */
function queimar(ms: number): void {
  const fim = agoraReal() + ms;
  while (agoraReal() < fim) {
    // CPU
  }
}

function* passosQueQueimam(n: number, ms: number): Passos<number> {
  let soma = 0;
  for (let i = 0; i < n; i++) {
    queimar(ms);
    soma += i;
    yield;
  }
  return soma;
}

describe('contarPulsos — o CONTROLE: o instrumento distingue loop preso de loop livre', () => {
  it('spawnSync de 300ms: o pulso bate ZERO, e o maior trecho sem bater cobre o bloqueio', async () => {
    const p = await contarPulsos(() => spawnSync('sleep', ['0.3']).status);
    expect(p.resultado).toBe(0);
    expect(p.batidas).toBe(0);
    expect(p.maiorIntervaloMs).toBeGreaterThanOrEqual(250);
  });

  it('laço síncrono de CPU de 200ms: ZERO, mesmo dentro de função async', async () => {
    const p = await contarPulsos(async () => {
      queimar(200);
    });
    expect(p.batidas).toBe(0);
  });

  it('`await` em promise já resolvida só cede a microtarefas: continua ZERO', async () => {
    const p = await contarPulsos(async () => {
      for (let i = 0; i < 20; i++) {
        queimar(10);
        await Promise.resolve();
      }
    });
    expect(p.batidas).toBe(0);
  });

  it('espera assíncrona de 150ms: o pulso bate', async () => {
    const p = await contarPulsos(() => new Promise((ok) => setTimeout(ok, 150)));
    expect(p.batidas).toBeGreaterThanOrEqual(5);
  });
});

describe('o MESMO trabalho, cedendo o loop — o pulso bate', () => {
  it('cederAoLoop entre os pedaços (o laço do controle de microtarefa, com a cessão certa)', async () => {
    const p = await contarPulsos(async () => {
      for (let i = 0; i < 20; i++) {
        queimar(10);
        await cederAoLoop();
      }
    });
    expect(p.batidas).toBeGreaterThanOrEqual(5);
  });

  it('emFatias entrega todos os itens, em ordem, e cede no meio', async () => {
    const itens = Array.from({ length: 100 }, (_, k) => k);
    const vistos: number[] = [];
    const p = await contarPulsos(async () => {
      for await (const i of emFatias(itens)) {
        queimar(2);
        vistos.push(i);
      }
    });
    expect(vistos).toEqual(itens);
    expect(p.batidas).toBeGreaterThanOrEqual(3);
  });

  it('drenarCedendo devolve o MESMO resultado do `drenar` da CLI — e só ele cede', async () => {
    const cli = await contarPulsos(() => drenar(passosQueQueimam(100, 2)));
    const teste = await contarPulsos(() => drenarCedendo(passosQueQueimam(100, 2)));
    expect(teste.resultado).toBe(4950);
    expect(cli.resultado).toBe(4950);
    expect(cli.batidas).toBe(0);
    expect(teste.batidas).toBeGreaterThanOrEqual(3);
  });

  it('com fake timers ligados, a fatia e o pulso continuam reais (não pendura nem conta zero)', async () => {
    vi.useFakeTimers();
    try {
      const p = await contarPulsos(() => drenarCedendo(passosQueQueimam(60, 2)));
      expect(p.resultado).toBe(1770);
      expect(p.batidas).toBeGreaterThanOrEqual(2);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('rodar — subprocesso sem prender o loop', () => {
  it('o pulso bate enquanto o filho dorme (o spawnSync do controle bate zero)', async () => {
    const p = await contarPulsos(() => rodar('sleep', ['0.3']));
    expect(p.resultado.status).toBe(0);
    expect(p.batidas).toBeGreaterThanOrEqual(5);
  });

  it('devolve status, stdout e stderr separados', async () => {
    const r = await rodar('sh', ['-c', 'printf out; printf err >&2; exit 3']);
    expect(r).toEqual({ status: 3, sinal: null, stdout: 'out', stderr: 'err' });
  });

  it('`entrada` vira o stdin do filho; sem ela o filho lê EOF', async () => {
    expect((await rodar('cat', [], { entrada: 'abc' })).stdout).toBe('abc');
    expect((await rodar('cat', [])).stdout).toBe('');
  });

  it('cwd e env chegam ao filho', async () => {
    const r = await rodar('sh', ['-c', 'pwd; printf "%s" "$X_LOOP_LIVRE"'], {
      cwd: '/',
      env: { ...process.env, X_LOOP_LIVRE: 'ok' },
    });
    expect(r.stdout).toBe('/\nok');
  });

  it('timeoutMs mata o filho com SIGKILL', async () => {
    const r = await rodar('sleep', ['5'], { timeoutMs: 100 });
    expect(r.status).toBeNull();
    expect(r.sinal).toBe('SIGKILL');
  });

  it('rodarOk devolve o stdout — e LANÇA como o execFileSync quando o filho falha', async () => {
    expect(await rodarOk('sh', ['-c', 'printf ok'])).toBe('ok');
    await expect(rodarOk('sh', ['-c', 'printf ruim >&2; exit 2'])).rejects.toThrow(/status 2: ruim/);
  });

  it('comando inexistente rejeita com ENOENT, não pendura', async () => {
    await expect(rodar('comando-que-nao-existe-loop-livre', [])).rejects.toThrow(/ENOENT/);
  });
});
