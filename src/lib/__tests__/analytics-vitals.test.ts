import { describe, it, expect } from 'vitest';
import {
  anotarRota,
  criarColetor,
  montarEvento,
  rotaNoInstante,
  type EventoVital,
  type MarcoDeRota,
  type MetricaVital,
} from '@/lib/analytics-vitals';

/**
 * O que este arquivo defende: `app.vitals` vira a linha de base dos lotes de app
 * do plano v4. Dois jeitos de ela mentir sem nada quebrar:
 *  - a rota levar id/PII para o PostHog (a máscara é a do ledger, mas a
 *    LIGAÇÃO com ela é deste arquivo);
 *  - a métrica ser atribuída à tela errada — o INP do clique que navegou caindo
 *    na tela de DESTINO, que nem tinha sido pintada.
 */

function metrica(over: Partial<MetricaVital> & Pick<MetricaVital, 'name'>): MetricaVital {
  return {
    value: 100,
    rating: 'good',
    id: `v5-${over.name}-1`,
    navigationType: 'navigate',
    entries: [],
    ...over,
  };
}

describe('rota do evento — normalizada, sem id nem querystring', () => {
  it('UUID e id numérico viram :id; a querystring não entra', () => {
    const linha: MarcoDeRota[] = [];
    anotarRota(linha, 0, '/pedidos/3f2a9c1e-4b7d-4e21-9f88-1c0de5a7b210');
    anotarRota(linha, 10, '/clientes/12345?cliente=3f2a9c1e-4b7d-4e21-9f88-1c0de5a7b210');
    expect(linha.map((m) => m.rota)).toEqual(['/pedidos/:id', '/clientes/:id']);
  });

  it('e-mail num segmento não passa cru', () => {
    const linha: MarcoDeRota[] = [];
    anotarRota(linha, 0, '/convite/fulano@empresa.com.br');
    expect(linha[0].rota).toBe('/convite/:id');
  });

  it('dois ids diferentes da MESMA tela não abrem marco novo', () => {
    const linha: MarcoDeRota[] = [];
    anotarRota(linha, 0, '/pedidos/111');
    anotarRota(linha, 5, '/pedidos/222');
    expect(linha).toEqual([{ t: 0, rota: '/pedidos/:id' }]);
  });
});

describe('rotaNoInstante — a tela vigente quando a coisa aconteceu', () => {
  const linha: MarcoDeRota[] = [
    { t: 0, rota: '/' },
    { t: 1000, rota: '/pedidos' },
  ];

  it('antes da troca é a de origem; na troca e depois, a de destino', () => {
    expect(rotaNoInstante(linha, 999)).toBe('/');
    expect(rotaNoInstante(linha, 1000)).toBe('/pedidos');
    expect(rotaNoInstante(linha, 5000)).toBe('/pedidos');
  });

  it('linha vazia é null (quem chama cai na rota atual)', () => {
    expect(rotaNoInstante([], 10)).toBeNull();
  });
});

describe('montarEvento — vocabulário da série', () => {
  it('kebab-case da lib vira snake_case; ms inteiros; CLS com 4 casas', () => {
    expect(
      montarEvento(
        metrica({ name: 'INP', value: 212.6, rating: 'needs-improvement', navigationType: 'back-forward-cache' }),
        '/x',
        '4g',
      ),
    ).toEqual({
      metrica: 'inp',
      valor: 213,
      classificacao: 'melhorar',
      rota: '/x',
      navegacao: 'bfcache',
      metrica_id: 'v5-INP-1',
      conexao: '4g',
    });
    expect(montarEvento(metrica({ name: 'CLS', value: 0.123456 }), '/x', null).valor).toBe(0.1235);
  });

  it('nenhum valor de vocabulário fechado sai com hífen', () => {
    const ratings: MetricaVital['rating'][] = ['good', 'needs-improvement', 'poor'];
    const navs: MetricaVital['navigationType'][] = [
      'navigate',
      'reload',
      'back-forward',
      'back-forward-cache',
      'prerender',
      'restore',
    ];
    for (const rating of ratings) {
      for (const navigationType of navs) {
        const e = montarEvento(metrica({ name: 'LCP', rating, navigationType }), '/', null);
        expect(`${e.metrica}|${e.classificacao}|${e.navegacao}`).not.toMatch(/-/);
      }
    }
  });
});

describe('criarColetor — quando e com que rota sai', () => {
  function montar(linha: MarcoDeRota[]) {
    const enviados: EventoVital[] = [];
    const coletor = criarColetor({
      enviar: (e) => enviados.push(e),
      linha,
      rotaAtual: () => '/rota-atual',
      conexao: () => null,
    });
    return { coletor, enviados };
  }

  it('INP do clique que navegou é da tela de ORIGEM, mesmo reportado depois da troca', () => {
    const { coletor, enviados } = montar([
      { t: 0, rota: '/pedidos' },
      { t: 1200, rota: '/pedidos/:id' },
    ]);
    coletor.aoMedir(metrica({ name: 'INP', value: 380, entries: [{ startTime: 1100 }] }));
    coletor.descarregar();
    expect(enviados).toHaveLength(1);
    expect(enviados[0].rota).toBe('/pedidos');
  });

  it('INP/CLS só saem ao esconder a aba, com o último valor; esconder de novo sem piora não repete', () => {
    const { coletor, enviados } = montar([{ t: 0, rota: '/' }]);
    coletor.aoMedir(metrica({ name: 'INP', value: 80, entries: [{ startTime: 10 }] }));
    coletor.aoMedir(metrica({ name: 'INP', value: 240, entries: [{ startTime: 20 }] }));
    expect(enviados).toHaveLength(0);
    coletor.descarregar();
    expect(enviados.map((e) => e.valor)).toEqual([240]);
    coletor.descarregar();
    expect(enviados).toHaveLength(1);
  });

  it('CLS vai para a tela do MAIOR deslocamento da janela', () => {
    const { coletor, enviados } = montar([
      { t: 0, rota: '/a' },
      { t: 500, rota: '/b' },
    ]);
    coletor.aoMedir(
      metrica({
        name: 'CLS',
        value: 0.3,
        entries: [
          { startTime: 100, value: 0.05 },
          { startTime: 600, value: 0.25 },
        ],
      }),
    );
    coletor.descarregar();
    expect(enviados[0].rota).toBe('/b');
  });

  it('LCP sai na hora; sem entrada (bfcache) cai na rota atual', () => {
    const { coletor, enviados } = montar([{ t: 0, rota: '/' }]);
    coletor.aoMedir(metrica({ name: 'LCP', value: 1800, entries: [{ startTime: 900 }] }));
    coletor.aoMedir(metrica({ name: 'FCP', id: 'v5-FCP-2', navigationType: 'back-forward-cache' }));
    expect(enviados.map((e) => [e.metrica, e.rota])).toEqual([
      ['lcp', '/'],
      ['fcp', '/rota-atual'],
    ]);
  });
});
