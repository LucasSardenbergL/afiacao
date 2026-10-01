import { describe, expect, it } from 'vitest';
import { removerCercas, removerCodigo, somenteCercas } from './markdown-codigo';

describe('removerCercas — só o bloco cercado, a crase inline fica', () => {
  it('esvazia bloco cercado preservando a NUMERAÇÃO das linhas', () => {
    const { texto } = removerCercas('a\n```\nsegredo\n```\nb');
    expect(texto.split('\n')).toHaveLength(5);
    expect(texto).not.toContain('segredo');
    expect(texto.split('\n')[4]).toBe('b');
  });

  // O DISCRIMINANTE desta camada, e a razão de ela existir separada: o gate de citações mede algo
  // que NASCE entre crases. Medido em 2026-08-22 sobre os docs vivos, usar `removerCodigo` no
  // lugar deste deixa 0 das 22 citações — verde por cegueira total.
  it('NÃO toca no que está entre crases na mesma linha', () => {
    expect(removerCercas('veja `src/a.ts:12` aqui').texto).toContain('src/a.ts:12');
  });

  it('`~~~` não fecha um bloco aberto com ```', () => {
    expect(removerCercas('```\n~~~\nsegredo\n```\ndepois').texto).not.toContain('segredo');
  });

  it('cerca com info string (```ts) abre, e ``` sozinho fecha', () => {
    const { texto, cercaAberta } = removerCercas('```ts\ncodigo\n```\ndepois');
    expect(cercaAberta).toBeNull();
    expect(texto).toContain('depois');
  });

  it('cerca não fechada é sinalizada com a linha da abertura e o que ela engoliu', () => {
    const { cercaAberta } = removerCercas('a\n```\nb');
    expect(cercaAberta).toMatchObject({ linha: 2, marca: '```' });
    expect(cercaAberta?.textoEngolido).toContain('b');
  });
});

describe('removerCodigo — cerca E crase, para quem mede o que não deve morar em código', () => {
  it('esvazia bloco cercado preservando a NUMERAÇÃO das linhas', () => {
    const { texto } = removerCodigo('a\n```\n[x](y.md)\n```\nb');
    expect(texto.split('\n')).toHaveLength(5);
    expect(texto).not.toContain('y.md');
    expect(texto.split('\n')[4]).toBe('b');
  });

  it('esvazia trecho entre crases na mesma linha', () => {
    expect(removerCodigo('veja `[a.md](b.md)` como exemplo').texto).not.toContain('b.md');
  });

  // A lição de `gates-textuais-cegos.md`: um `[\s\S]*?` entre crases engoliria dezenas de linhas a
  // partir de uma crase solta em prosa, e o gate ficaria verde por CEGUEIRA.
  it('crase SEM par na linha é texto — não engole as linhas seguintes', () => {
    const { texto } = removerCodigo('preço em ` reais\n[x](quebrado.md)\nfim');
    expect(texto).toContain('quebrado.md');
  });

  it('run de crases só fecha com run do MESMO tamanho', () => {
    expect(removerCodigo('``a ` b`` fim').texto).toBe(' fim');
  });

  it('`~~~` não fecha um bloco aberto com ```', () => {
    expect(removerCodigo('```\n~~~\n[x](y.md)\n```\ndepois').texto).not.toContain('y.md');
  });

  it('cerca com info string (```ts) abre, e ``` sozinho fecha', () => {
    const { texto, cercaAberta } = removerCodigo('```ts\ncodigo\n```\n[x](y.md)');
    expect(cercaAberta).toBeNull();
    expect(texto).toContain('y.md');
  });

  it('cerca não fechada é sinalizada com a linha da abertura', () => {
    expect(removerCodigo('a\n```\nb').cercaAberta).toMatchObject({ linha: 2, marca: '```' });
  });
});

describe('somenteCercas — o inverso: só o CÓDIGO das cercas, para quem mede o que o doc manda rodar', () => {
  it('a prosa vira linha vazia e o código fica, na MESMA numeração de linha', () => {
    const { texto, cercaAberta } = somenteCercas('prosa now()\n```sql\nselect 1\n\nselect 2\n```\ndepois');
    expect(cercaAberta).toBeNull();
    const linhas = texto.split('\n');
    expect(linhas).toHaveLength(7);
    expect(linhas[0]).toBe('');
    expect(linhas[2]).toBe('select 1');
    expect(linhas[4]).toBe('select 2');
    expect(linhas[6]).toBe('');
  });

  it('crase inline na prosa NÃO é código de cerca — some junto com a prosa', () => {
    expect(somenteCercas("use `date_trunc('month', now())` com cuidado").texto).toBe('');
  });

  it('é o complemento exato de removerCercas: nenhuma linha não vazia aparece nos dois', () => {
    const doc = 'a\n~~~\nb\n~~~\nc\n```ts\nd\n```\ne';
    const fora = removerCercas(doc).texto.split('\n');
    const dentro = somenteCercas(doc).texto.split('\n');
    fora.forEach((l, i) => expect(l !== '' && dentro[i] !== '').toBe(false));
    expect(dentro.join('')).toContain('b');
    expect(dentro.join('')).toContain('d');
  });

  it('cerca não fechada: o resto do arquivo é código, e a abertura é sinalizada', () => {
    const { texto, cercaAberta } = somenteCercas('a\n```\nb');
    expect(cercaAberta).toMatchObject({ linha: 2, marca: '```' });
    expect(texto).toContain('b');
  });
});
