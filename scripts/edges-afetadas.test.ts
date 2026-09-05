/**
 * A asserção que separa a via (c) das outras duas: o universo é `index.ts`, NÃO o mapa de
 * fingerprints. Se `edgesServidas` passasse a exigir `versao.ts`, a via (c) viraria uma cópia cara
 * da via (a) e a classe cega (41 edges medidas em 2026-09-05) voltaria inteira — em silêncio, com
 * a suíte do `edges-pendentes.sh` ainda verde, porque lá o fixture da edge fora do mapa passa a
 * não ter quem a enxergue. Por isso estes testes moram junto da lógica, e não só no harness bash.
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { calcularAfetadas, edgesServidas } from './edges-afetadas';

let raiz: string;
const LIB = 'supabase/functions/_shared/lib.ts';

beforeAll(() => {
  raiz = mkdtempSync(join(tmpdir(), 'edges-afetadas-test-'));
  const escrever = (rel: string, conteudo: string) => {
    const abs = join(raiz, rel);
    mkdirSync(join(abs, '..'), { recursive: true });
    writeFileSync(abs, conteudo, 'utf8');
  };
  escrever(LIB, 'export const x = 1;\n');
  // no mapa: tem `versao.ts` — a via (a) já a enxergaria
  escrever('supabase/functions/edge-no-mapa/index.ts', 'import "../_shared/lib.ts";\n');
  escrever('supabase/functions/edge-no-mapa/versao.ts', 'export const VERSAO = "v1";\n');
  // A CLASSE CEGA: importa `_shared/` e NÃO tem `versao.ts`
  escrever('supabase/functions/edge-fora/index.ts', 'import "../_shared/lib.ts";\n');
  // não depende de `_shared/`: mexer na lib não muda o bundle dela
  escrever('supabase/functions/edge-isolada/index.ts', 'import "./util.ts";\n');
  escrever('supabase/functions/edge-isolada/util.ts', 'export const y = 2;\n');
  // fecho ilegível: o import não resolve
  escrever('supabase/functions/edge-quebrada/index.ts', 'import "../_shared/nao-existe.ts";\n');
});

afterAll(() => rmSync(raiz, { recursive: true, force: true }));

describe('edgesServidas', () => {
  it('o universo é `index.ts`, não o mapa — edge SEM `versao.ts` entra', () => {
    expect(edgesServidas(raiz)).toEqual([
      'edge-fora',
      'edge-isolada',
      'edge-no-mapa',
      'edge-quebrada',
    ]);
  });
});

describe('calcularAfetadas', () => {
  it('mudança só em `_shared/` puxa a edge FORA do mapa — o caso que nenhuma outra via vê', () => {
    const { slugs } = calcularAfetadas(raiz, [LIB]);
    expect(slugs).toContain('edge-fora');
    expect(slugs).toContain('edge-no-mapa');
  });

  it('não arrasta edge cujo fecho não contém o arquivo alterado', () => {
    expect(calcularAfetadas(raiz, [LIB]).slugs).not.toContain('edge-isolada');
  });

  it('pega a edge pelo arquivo da PRÓPRIA pasta, não só por `_shared/`', () => {
    const { slugs } = calcularAfetadas(raiz, ['supabase/functions/edge-isolada/util.ts']);
    expect(slugs).toContain('edge-isolada');
    expect(slugs).not.toContain('edge-fora');
    expect(slugs).not.toContain('edge-no-mapa');
    // a de fecho ilegível acompanha TODA mudança de propósito: sem saber o que ela importa, não
    // dá para dizer que esta alteração não a atingiu.
    expect(slugs).toContain('edge-quebrada');
  });

  it('fail-CLOSED local: fecho ilegível entra como AFETADA e avisa — não medir não absolve', () => {
    const { slugs, avisos } = calcularAfetadas(raiz, [LIB]);
    expect(slugs).toContain('edge-quebrada');
    expect(avisos.join(' ')).toContain('edge-quebrada');
  });

  it('lista vazia por MÉRITO: nada alterado, ninguém afetado', () => {
    expect(calcularAfetadas(raiz, []).slugs).toEqual([]);
  });
});
