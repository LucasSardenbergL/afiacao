import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';
import { canonicalizarRota } from '@/lib/analytics-rota-canonica';
import { removerComentarios, maiorBlocoDescartado, medirPreservacao } from '@/lib/gates/limpeza-fonte';

/**
 * O que este arquivo defende: a chave de `navegacao.rota_servida` vira LINHA no
 * nosso Postgres. Se a canonicalização deixar passar um identificador, o acervo
 * de telemetria passa a guardar dado de domínio — e ninguém percebe, porque
 * telemetria é fail-open por desenho e nada quebra.
 *
 * Por isso o teste tem duas metades que não se substituem:
 *  - a máscara recusa o que NÃO é forma de tela (unitários abaixo);
 *  - a máscara preserva o que É forma de tela (o gate contra o `App.tsx`) —
 *    sem esta metade, `() => ':id'` passaria em tudo.
 */

const appTsx = readFileSync(
  resolve(dirname(fileURLToPath(import.meta.url)), '../../App.tsx'),
  'utf-8',
);

/** ⚠️ Stripper COMPARTILHADO, nunca regex local: `path=` dentro de comentário não é rota. */
const appTsxLimpo = removerComentarios(appTsx);

function pathsDeclarados(): string[] {
  return [...appTsxLimpo.matchAll(/<Route\s+path="([^"]+)"/g)]
    .map((m) => m[1])
    .filter((p) => p !== '*'); // catch-all não é uma tela — casa o que sobrou
}

describe('canonicalizarRota — a máscara recusa o que não é forma de tela', () => {
  it('UUID vira :id — quem o pega é o teto de 24 chars, não uma regra dedicada', () => {
    // A regra `/^[0-9a-f]{8}-…$/` existiu e a falsificação a derrubou: era
    // inalcançável (UUID tem 36 chars). Esta asserção passou a ancorar o teto —
    // subi-lo acima de 32 deixa UUID passar cru, e é aqui que fica vermelho.
    expect(canonicalizarRota('/orders/3f2a9c1e-4b7d-4e21-9f88-1c0de5a7b210')).toBe('/orders/:id');
  });

  it('UUID sem hífens vira :id — aqui quem pega é o hex longo', () => {
    expect(canonicalizarRota('/orders/3f2a9c1e4b7d4e219f881c0de5a7b210')).toBe('/orders/:id');
  });

  it('id numérico vira :id', () => {
    expect(canonicalizarRota('/pedido/48213')).toBe('/pedido/:id');
  });

  it('hex longo (token/hash) vira :id', () => {
    expect(canonicalizarRota('/x/a1b2c3d4e5f6a7b8')).toBe('/x/:id');
  });

  it('e-mail num segmento vira :id — o @ está fora do alfabeto', () => {
    expect(canonicalizarRota('/perfil/fulano@empresa.com.br')).toBe('/perfil/:id');
  });

  it('percent-encoding vira :id', () => {
    expect(canonicalizarRota('/busca/joao%20silva')).toBe('/busca/:id');
  });

  it('segmento acima de 24 chars vira :id', () => {
    expect(canonicalizarRota('/kb/documento-muito-comprido-demais')).toBe('/kb/:id');
  });

  it('querystring nunca entra na chave, mesmo se alguém passar a URL inteira', () => {
    expect(canonicalizarRota('/formulas?cor=12345&cliente=abc')).toBe('/formulas');
  });

  it('fragmento nunca entra na chave', () => {
    expect(canonicalizarRota('/formulas#secao-2')).toBe('/formulas');
  });

  it('travessia de diretório vira :id, não navega', () => {
    expect(canonicalizarRota('/admin/../../etc')).toBe('/admin/:id/:id/etc');
  });

  it('profundidade acima do teto é truncada e MARCADA', () => {
    const rota = canonicalizarRota('/a/b/c/d/e/f/g/h');
    expect(rota).toBe('/a/b/c/d/e/f/:trunc');
  });

  it('a chave respeita o teto de 100 chars do left() da RPC', () => {
    const fundo = '/' + Array.from({ length: 6 }, () => 'segmento-de-vinte-quatro').join('/');
    expect(canonicalizarRota(fundo).length).toBeLessThanOrEqual(100);
  });

  it('raiz é /', () => {
    expect(canonicalizarRota('/')).toBe('/');
    expect(canonicalizarRota('')).toBe('/');
  });
});

describe('canonicalizarRota — a máscara PRESERVA o que é forma de tela', () => {
  it('rota estática atravessa intacta', () => {
    expect(canonicalizarRota('/admin/standard-processes')).toBe('/admin/standard-processes');
  });

  it('o segmento com ponto do OAuth do Lovable sobrevive', () => {
    expect(canonicalizarRota('/.lovable/oauth/consent')).toBe('/.lovable/oauth/consent');
  });

  it('a URL real e o pattern do router colapsam na MESMA chave', () => {
    // É esta propriedade que faz numerador (rotas servidas) e denominador
    // (rotas declaradas) serem comparáveis. Sem ela a cobertura mente.
    expect(canonicalizarRota('/orders/9c1f2b7a-0e34-4a56-8b12-77de90ac3311')).toBe(
      canonicalizarRota('/orders/:id'),
    );
    expect(canonicalizarRota('/tools/2f8c1d9e-1111-4222-8333-444455556666/reports')).toBe(
      canonicalizarRota('/tools/:toolId/reports'),
    );
  });
});

describe('gate: toda rota declarada no App.tsx sobrevive à canonicalização', () => {
  const paths = pathsDeclarados();

  it('o App.tsx declara rotas — o gate não está medindo uma lista vazia', () => {
    expect(paths.length).toBeGreaterThan(100);
  });

  it('nenhuma rota canônica carrega caractere fora do alfabeto fechado', () => {
    const fora = paths
      .map((p) => canonicalizarRota(p.startsWith('/') ? p : `/${p}`))
      .filter((r) => !/^[a-z0-9._/:-]*$/.test(r));
    expect(fora).toEqual([]);
  });

  it('nenhum NOME de parâmetro sobrevive — só :id e :trunc', () => {
    const vazados = paths
      .map((p) => canonicalizarRota(p.startsWith('/') ? p : `/${p}`))
      .flatMap((r) => r.split('/'))
      .filter((seg) => seg.startsWith(':') && seg !== ':id' && seg !== ':trunc');
    expect(vazados).toEqual([]);
  });

  it('rota estática do App.tsx nunca é mascarada por engano', () => {
    // Falso-positivo da máscara custa uma tela que some do denominador sem
    // ninguém notar. Nenhum segmento ESTÁTICO declarado pode virar :id.
    const mascaradasIndevidamente = paths
      .filter((p) => !p.includes(':'))
      .map((p) => ({ p, r: canonicalizarRota(p.startsWith('/') ? p : `/${p}`) }))
      .filter(({ r }) => r.includes(':id'));
    expect(mascaradasIndevidamente).toEqual([]);
  });
});

describe('sentinela do stripper — o gate acima não pode medir um arquivo esvaziado', () => {
  it('a limpeza preservou o corpo do App.tsx', () => {
    const { fracao } = medirPreservacao(appTsx);
    expect(fracao).toBeGreaterThan(0.5);
  });

  it('nenhum bloco contíguo grande foi descartado pela limpeza', () => {
    // Teto calibrado em `limpeza-fonte.ts`: o maior cabeçalho honesto do repo
    // tem 88 linhas; 150 fica acima dele e muito abaixo do estrago medido.
    expect(maiorBlocoDescartado(appTsx)).toBeLessThan(150);
  });

  it('o stripper não comeu as declarações de rota', () => {
    expect(appTsxLimpo).toContain('<Routes>');
    expect(appTsxLimpo).toContain('path="orders"');
  });
});
