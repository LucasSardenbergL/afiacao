import { describe, expect, it } from 'vitest';

import { julgar, parsearObservacoes, SEM_MAPA } from './lib/pendencias-deploy';

const MAPA = { 'edge-a': 'aaa111', 'edge-b': 'bbb222' };
const obs = (edge: string, fonte: string, criado = '2026-08-27 21:00:00+00', versao = 'v1') => ({
  edge,
  fonte,
  criado,
  versao,
});

describe('parsearObservacoes', () => {
  it('o SET do wrapper NÃO conta como ruído — senão o aviso dispararia em toda execução', () => {
    const { observacoes, linhasIgnoradas } = parsearObservacoes(
      'SET\nSET\nedge-a|v1|aaa111|2026-08-27 21:00:00+00\n',
    );
    expect(observacoes).toEqual([obs('edge-a', 'aaa111')]);
    expect(linhasIgnoradas).toBe(0);
  });

  it('mas ruído DE VERDADE continua contado — o filtro é do chatter conhecido, não de tudo', () => {
    const { observacoes, linhasIgnoradas } = parsearObservacoes(
      'SET\nERROR: alguma coisa\nedge-a|v1|aaa111|hoje\n',
    );
    expect(observacoes).toHaveLength(1);
    expect(linhasIgnoradas).toBe(1);
  });

  it('CONTA a linha malformada — engolir ruído fabricaria NAO_OBSERVADA numa edge que respondeu', () => {
    const { observacoes, linhasIgnoradas } = parsearObservacoes('edge-a|v1|\nedge-b|v1|bbb222|hoje\n');
    expect(observacoes.map((o) => o.edge)).toEqual(['edge-b']);
    expect(linhasIgnoradas).toBe(1);
  });
});

describe('julgar', () => {
  it('CONFERE só quando o fonte observado é igual ao commitado', () => {
    const r = julgar(MAPA, [obs('edge-a', 'aaa111'), obs('edge-b', 'bbb222')]);
    expect(r.vereditos.every((v) => v.estado === 'CONFERE')).toBe(true);
    expect(r.totalDivergentes).toBe(0);
  });

  it('ARMADILHA 1 — edge sem sonda na janela é NAO_OBSERVADA, JAMAIS CONFERE', () => {
    const r = julgar(MAPA, [obs('edge-a', 'aaa111')]);
    const b = r.vereditos.find((v) => v.edge === 'edge-b');
    expect(b?.estado).toBe('NAO_OBSERVADA');
    expect(b?.estado).not.toBe('CONFERE');
    // e ela NÃO conta como observada — senão a cobertura mentiria
    expect(r.totalObservadas).toBe(1);
  });

  it('ARMADILHA 2 — fonte "nao-mapeada" é DIVERGÊNCIA, não ausência', () => {
    const r = julgar(MAPA, [obs('edge-a', SEM_MAPA), obs('edge-b', 'bbb222')]);
    expect(r.vereditos.find((v) => v.edge === 'edge-a')?.estado).toBe('SEM_MAPA_NO_BUNDLE');
    expect(r.totalDivergentes).toBe(1);
  });

  it('ARMADILHA 3 — zero observações não vira relatório limpo', () => {
    const r = julgar(MAPA, []);
    expect(r.totalObservadas).toBe(0);
    expect(r.totalDivergentes).toBe(0); // e é JUSTAMENTE por isso que o CLI trata 0 observações
    expect(r.vereditos.every((v) => v.estado === 'NAO_OBSERVADA')).toBe(true); // como exit 2
  });

  it('fonte diferente do commitado é DEPLOY PENDENTE, com os dois lados no veredito', () => {
    const r = julgar(MAPA, [obs('edge-a', 'ANTIGO0'), obs('edge-b', 'bbb222')]);
    const a = r.vereditos.find((v) => v.edge === 'edge-a');
    expect(a?.estado).toBe('DIVERGE');
    expect(a?.esperado).toBe('aaa111');
    expect(a?.observado).toBe('ANTIGO0');
  });

  it('a observação MAIS RECENTE vence quando a janela tem várias da mesma edge', () => {
    const r = julgar(MAPA, [
      obs('edge-a', 'ANTIGO0', '2026-08-27 10:00:00+00'),
      obs('edge-a', 'aaa111', '2026-08-27 21:00:00+00'),
      obs('edge-b', 'bbb222'),
    ]);
    expect(r.vereditos.find((v) => v.edge === 'edge-a')?.estado).toBe('CONFERE');
  });

  it('edge que prod serve e a main não mapeia aparece, em vez de sumir do relatório', () => {
    const r = julgar(MAPA, [obs('edge-a', 'aaa111'), obs('edge-b', 'bbb222'), obs('fantasma', 'xxx')]);
    expect(r.vereditos.find((v) => v.edge === 'fantasma')?.estado).toBe('FORA_DO_MAPA');
    expect(r.totalDivergentes).toBe(1);
  });
});
