import { describe, expect, it } from 'vitest';
import {
  auditarCitacoes,
  CONGELADOS,
  lerDocsVivos,
  parseCitacoes,
  type Citacao,
} from './docs-citacoes-gate-check';

const RAIZ = '/repo';
const DOC = 'docs/agent/exemplo.md';

/** Leitor injetado: o auditor não toca disco, então o "repo" é este Map. */
const repo = (arquivos: Record<string, string>) => (p: string) => arquivos[p] ?? null;

const cita = (alvo: string, linhas: string[], ancora: string | null): Citacao => ({
  doc: DOC,
  linhaDoDoc: 1,
  alvo,
  linhas,
  ancora,
});

const msgs = (r: { achados: { msg: string }[] }) => r.achados.map((a) => a.msg).join(' | ');

describe('parseCitacoes — o que conta como citação', () => {
  it('captura caminho, linha e âncora', () => {
    const [c] = parseCitacoes(DOC, 'veja `src/a.ts:12`<!--cita: const x-->');
    expect(c).toMatchObject({ alvo: 'src/a.ts', linhas: ['12'], ancora: 'const x' });
  });

  it('âncora ausente vira null (e não string vazia)', () => {
    const [c] = parseCitacoes(DOC, 'veja `src/a.ts:12` e mais nada');
    expect(c.ancora).toBeNull();
  });

  it('tolera espaço e parêntese ao redor da âncora', () => {
    const [c] = parseCitacoes(DOC, '(`src/a.ts:12`<!--   cita:   const x   -->)');
    expect(c.ancora).toBe('const x');
  });

  it('captura a forma multi-linha para o auditor poder recusá-la', () => {
    const [c] = parseCitacoes(DOC, '`a.md:133,416`');
    expect(c.linhas).toEqual(['133', '416']);
  });

  it('link markdown comum NÃO é citação (não tem :linha)', () => {
    expect(parseCitacoes(DOC, '[roadmap](../ux-audit/03-roadmap.md)')).toHaveLength(0);
  });

  it('registra a linha do DOC, para a mensagem apontar onde consertar', () => {
    const [c] = parseCitacoes(DOC, 'linha1\nlinha2\n`src/a.ts:9`<!--cita: z-->');
    expect(c.linhaDoDoc).toBe(3);
  });
});

describe('auditarCitacoes — a regressão que este gate existe para pegar', () => {
  const idx = new Map<string, string[]>();

  it('passa quando a linha citada realmente contém a âncora', () => {
    const r = auditarCitacoes(
      [cita('src/a.ts', ['2'], 'Carbon Touch Target')],
      RAIZ,
      idx,
      repo({ '/repo/src/a.ts': 'linha1\nCarbon Touch Target spec\nlinha3' }),
    );
    expect(r.achados).toHaveLength(0);
    expect(r.verificadas).toBe(1);
  });

  // O caso real: o #1813 inseriu 2 linhas no topo de um doc citado e as 5 citações do #1803
  // passaram a apontar para `**ICE**: ...`. A linha CONTINUAVA existindo — só o conteúdo mudou.
  it('REPROVA quando o conteúdo desloca, mesmo a linha continuando a existir', () => {
    const r = auditarCitacoes(
      [cita('src/a.ts', ['2'], 'Carbon Touch Target')],
      RAIZ,
      idx,
      repo({ '/repo/src/a.ts': 'nova\nlinha1\nCarbon Touch Target spec' }),
    );
    expect(r.achados).toHaveLength(1);
    expect(msgs(r)).toContain('deveria conter');
    expect(msgs(r)).toContain('linha1'); // mostra o que está lá HOJE, para o conserto ser óbvio
  });

  it('REPROVA citação sem âncora — número de linha sozinho é inverificável', () => {
    const r = auditarCitacoes(
      [cita('src/a.ts', ['1'], null)],
      RAIZ,
      idx,
      repo({ '/repo/src/a.ts': 'qualquer coisa' }),
    );
    expect(msgs(r)).toContain('não tem âncora');
  });

  it('REPROVA âncora vazia (não deixa burlar com `<!--cita:-->`)', () => {
    const r = auditarCitacoes(
      [cita('src/a.ts', ['1'], '')],
      RAIZ,
      idx,
      repo({ '/repo/src/a.ts': 'qualquer coisa' }),
    );
    expect(msgs(r)).toContain('âncora VAZIA');
  });

  it('REPROVA linha fora do arquivo', () => {
    const r = auditarCitacoes(
      [cita('src/a.ts', ['99'], 'x')],
      RAIZ,
      idx,
      repo({ '/repo/src/a.ts': 'uma linha só' }),
    );
    expect(msgs(r)).toContain('FORA do arquivo');
  });

  it('REPROVA arquivo citado que não existe', () => {
    const r = auditarCitacoes([cita('src/sumiu.ts', ['1'], 'x')], RAIZ, idx, repo({}));
    expect(msgs(r)).toContain('NÃO existe no repo');
  });

  it('REPROVA a forma `:133,416` — uma âncora só descreve UMA linha', () => {
    const r = auditarCitacoes(
      [cita('src/a.ts', ['1', '2'], 'x')],
      RAIZ,
      idx,
      repo({ '/repo/src/a.ts': 'a\nb' }),
    );
    expect(msgs(r)).toContain('várias linhas de uma vez');
  });

  it('resolve basename ÚNICO no repo (citação sem barra ainda é verificada)', () => {
    const r = auditarCitacoes(
      [cita('unico.ts', ['1'], 'achei')],
      RAIZ,
      new Map([['unico.ts', ['/repo/src/fundo/unico.ts']]]),
      repo({ '/repo/src/fundo/unico.ts': 'achei aqui' }),
    );
    expect(r.achados).toHaveLength(0);
    expect(r.verificadas).toBe(1);
  });

  // Precisão: adivinhar QUAL `index.ts` seria fábrica de falso-positivo.
  it('PULA basename ambíguo em vez de chutar — e conta o buraco', () => {
    const r = auditarCitacoes(
      [cita('index.ts', ['1'], 'x')],
      RAIZ,
      new Map([['index.ts', ['/repo/a/index.ts', '/repo/b/index.ts']]]),
      repo({}),
    );
    expect(r.achados).toHaveLength(0);
    expect(r.ambiguas).toBe(1);
  });

  it('PULA caminho externo declarado em EXTERNOS', () => {
    const r = auditarCitacoes(
      [cita('postgrest-js/src/PostgrestBuilder.ts', ['185'], null)],
      RAIZ,
      idx,
      repo({}),
    );
    expect(r.achados).toHaveLength(0);
    expect(r.externas).toBe(1);
  });

  it('resolve relativo ao DOC antes da raiz (link markdown `../` funciona)', () => {
    const r = auditarCitacoes(
      [cita('../ux-audit/03-roadmap.md', ['1'], 'ICE')],
      RAIZ,
      idx,
      repo({ '/repo/docs/ux-audit/03-roadmap.md': 'ICE = Impact × Confidence × Ease' }),
    );
    expect(r.achados).toHaveLength(0);
  });
});

describe('lerDocsVivos — escopo', () => {
  const vivos = lerDocsVivos('.');

  it('varre os docs vivos (agent/visual-direction/runbooks)', () => {
    expect(vivos).toContain('docs/agent/mapa-do-app.md');
    expect(vivos).toContain('docs/visual-direction/01-direcao.md');
  });

  it('NÃO varre artefato datado listado em CONGELADOS', () => {
    for (const c of CONGELADOS) expect(vivos).not.toContain(c);
  });

  // Um spec de maio cita o código de maio e está CERTO ao fazer isso.
  it('NÃO varre docs congelados por diretório (historico/superpowers/ux-audit)', () => {
    expect(vivos.some((v) => v.startsWith('docs/historico/'))).toBe(false);
    expect(vivos.some((v) => v.startsWith('docs/superpowers/'))).toBe(false);
    expect(vivos.some((v) => v.startsWith('docs/ux-audit/'))).toBe(false);
  });
});
