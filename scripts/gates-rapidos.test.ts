import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { GATES_RAPIDOS, consolidar, scriptsAusentes } from './gates-rapidos';

describe('gates:rapidos — consolidar', () => {
  it('lista vazia é falha (sentinela de varredura vazia), nunca OK', () => {
    const v = consolidar([]);
    expect(v.exit).toBe(2);
    expect(v.marca.startsWith('GATES_RAPIDOS_SEM_VEREDITO')).toBe(true);
  });

  it('um gate reprovado reprova o agregado e é NOMEADO na marca', () => {
    const v = consolidar([
      { gate: 'docs:indice', tipo: 'passou', ms: 1 },
      { gate: 'claude:size', tipo: 'reprovou', ms: 1, exit: 1, saida: 'x' },
    ]);
    expect(v).toEqual({ exit: 1, marca: 'GATES_RAPIDOS_REPROVOU: claude:size' });
  });

  it('reprovação vence o sem-veredito (o hook só nega com veredito)', () => {
    const v = consolidar([
      { gate: 'a', tipo: 'sem-veredito', ms: 1, motivo: 'timeout' },
      { gate: 'b', tipo: 'reprovou', ms: 1, exit: 1, saida: '' },
    ]);
    expect(v.exit).toBe(1);
  });

  it('sem veredito sem reprovação sai 2, não 0', () => {
    const v = consolidar([
      { gate: 'a', tipo: 'passou', ms: 1 },
      { gate: 'b', tipo: 'sem-veredito', ms: 1, motivo: 'timeout' },
    ]);
    expect(v).toEqual({ exit: 2, marca: 'GATES_RAPIDOS_SEM_VEREDITO: b' });
  });

  it('todos verdes → OK com a contagem', () => {
    expect(consolidar([{ gate: 'a', tipo: 'passou', ms: 1 }])).toEqual({ exit: 0, marca: 'GATES_RAPIDOS_OK n=1' });
  });
});

describe('gates:rapidos — a lista aponta para gates que existem', () => {
  it('todo gate da lista é script do package.json (ou o knip, via bunx)', () => {
    const pkg = readFileSync(join(process.cwd(), 'package.json'), 'utf8');
    expect(GATES_RAPIDOS.length).toBeGreaterThan(10);
    expect(scriptsAusentes(GATES_RAPIDOS, pkg)).toEqual([]);
  });

  it('script ausente é detectado (o detector não é sempre-vazio)', () => {
    expect(scriptsAusentes(['nao:existe', 'knip'], '{"scripts":{}}')).toEqual(['nao:existe']);
  });
});
