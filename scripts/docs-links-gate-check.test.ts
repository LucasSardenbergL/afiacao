import { describe, expect, it } from 'vitest';
import {
  type AchadoLink,
  type CausaLink,
  auditarLinks,
  type DocMd,
  ehExterno,
  extrairLinks,
  resolverDestino,
  sugerirCaminho,
} from './docs-links-gate-check';

/** Repo de mentira: o conjunto de caminhos RASTREADOS é a autoridade, como no gate real. */
const repo = (...paths: string[]) => new Set(paths);

const doc = (arquivo: string, texto: string): DocMd[] => [{ arquivo, texto }];

const msgs = (a: AchadoLink[]) => a.map((f) => f.msg).join(' | ');
const causas = (a: AchadoLink[]): CausaLink[] => a.map((f) => f.causa);

/** Por padrão nada existe no disco — quem testa a discriminação passa o seu próprio. */
const nadaNoDisco = () => false;

describe('extrairLinks — o que o gate se propõe a julgar', () => {
  const links = (texto: string, arquivo = 'docs/a/x.md') => extrairLinks({ arquivo, texto }).links;

  // O DISCRIMINANTE deste gate. Medido: os 5 únicos falsos-positivos do corpus são inline code em
  // docs que documentam o gate irmão — `gate-indice-docs.md:60` tem `[a.md](b.md)` como ilustração.
  // Um stripper que só entendesse ``` deixaria o gate nascer com 5 exceções permanentes.
  it('inline code do doc que DOCUMENTA o gate irmão não vira link', () => {
    const linha = '4. **TEXTO = DESTINO** — `[a.md](b.md)` é copiar-colar; quem clica cai em `b.md`.';
    expect(extrairLinks({ arquivo: 'docs/historico/gate-indice-docs.md', texto: linha }).links).toEqual([]);
  });

  it('pega link relativo de .md', () => {
    expect(links('[i](../b/y.md)')[0]).toMatchObject({ alvo: '../b/y.md', destino: 'docs/b/y.md' });
  });

  it('resolve só a parte do ARQUIVO quando há âncora', () => {
    expect(links('[i](../b/y.md#secao)')[0].destino).toBe('docs/b/y.md');
  });

  it('ignora http, https e mailto', () => {
    expect(links('[a](https://x.com/y.md) [b](http://x/y.md) [c](mailto:a@b.md)')).toEqual([]);
  });

  it('ignora âncora pura e alvo que não é .md', () => {
    expect(links('[a](#secao) [b](../img.png) [c](../pasta/)')).toEqual([]);
  });

  it('aceita `](<alvo>)` e `](alvo "Título")`', () => {
    expect(links('[a](<../b/y.md>) [b](../b/z.md "T")').map((l) => l.destino)).toEqual([
      'docs/b/y.md',
      'docs/b/z.md',
    ]);
  });

  it('decodifica %20 no caminho', () => {
    expect(links('[a](../b/com%20espaco.md)')[0].destino).toBe('docs/b/com espaco.md');
  });

  it('numera a linha 1-based para o erro ser clicável', () => {
    expect(links('titulo\n\n[i](../b/y.md)')[0].linha).toBe(3);
  });
});

describe('resolverDestino', () => {
  it('resolve relativo a partir do diretório do arquivo', () => {
    expect(resolverDestino('.claude/skills/fecho/SKILL.md', '../../docs/x.md')).toBe('.claude/docs/x.md');
  });

  it('trata `/x.md` como raiz do repo (semântica do GitHub)', () => {
    expect(resolverDestino('docs/a/x.md', '/docs/b/y.md')).toBe('docs/b/y.md');
  });

  it('ehExterno reconhece esquema, âncora e ignora caminho comum', () => {
    expect([ehExterno('#a'), ehExterno('https://a'), ehExterno('../a.md')]).toEqual([true, true, false]);
  });
});

describe('auditarLinks — as quatro invariantes', () => {
  // 1. RESOLVE.
  it('link que resolve não acusa nada', () => {
    const a = auditarLinks(doc('docs/a/x.md', '[i](../b/y.md)'), repo('docs/b/y.md'), nadaNoDisco);
    expect(a).toEqual([]);
  });

  it('link que não resolve acusa, dizendo para ONDE resolveu', () => {
    const a = auditarLinks(doc('docs/a/x.md', '[i](../b/y.md)'), repo(), nadaNoDisco);
    expect(causas(a)).toEqual(['ausente']);
    expect(msgs(a)).toContain('docs/b/y.md');
  });

  // O INCIDENTE (#1863) — a regressão que este gate existe para pegar.
  it('reproduz o #1863: `../../` de .claude/skills/fecho/ cai em .claude/docs/', () => {
    const a = auditarLinks(
      doc('.claude/skills/fecho/SKILL.md', 'veja [x](../../docs/historico/mergeabilidade-assincrona.md)'),
      repo('docs/historico/mergeabilidade-assincrona.md'),
      nadaNoDisco,
    );
    expect(causas(a)).toEqual(['ausente']);
    expect(a[0].msg).toContain('.claude/docs/historico/mergeabilidade-assincrona.md');
    // e entrega o caminho certo, em vez de só dizer que está errado
    expect(a[0].msg).toContain('../../../docs/historico/mergeabilidade-assincrona.md');
  });

  // 2. RASTREADO — a autoridade é o índice do git, não o disco de quem escreveu.
  it('arquivo NO DISCO mas fora do git é link quebrado — e a mensagem diz isso', () => {
    const a = auditarLinks(doc('docs/a/x.md', '[i](../b/y.md)'), repo(), (p) => p === 'docs/b/y.md');
    expect(causas(a)).toEqual(['nao-rastreado']);
  });

  // O APFS do macOS é case-insensitive: sem o Set do git, isto passaria no laptop e quebraria no CI.
  it('caixa diferente NÃO resolve (o gate julga como Linux/GitHub, não como APFS)', () => {
    const a = auditarLinks(doc('docs/a/x.md', '[i](../B/Y.md)'), repo('docs/b/y.md'), () => true);
    expect(a).toHaveLength(1);
  });

  // 3. DENTRO DO REPO.
  it('`../` a mais escapa a raiz do repo', () => {
    const a = auditarLinks(doc('docs/x.md', '[i](../../fora.md)'), repo(), nadaNoDisco);
    expect(causas(a)).toEqual(['fora-do-repo']);
  });

  // 4. CERCA FECHADA — só COM VÍTIMA.
  it('cerca aberta que esconde link acusa e NOMEIA o link escondido', () => {
    const a = auditarLinks(doc('docs/a/x.md', 'a\n```\n[i](../b/y.md)\n'), repo(), nadaNoDisco);
    expect(causas(a)).toEqual(['cerca-aberta']);
    expect(msgs(a)).toContain('escondendo 1 link');
    expect(msgs(a)).toContain('../b/y.md');
  });

  // Medido: os 2 casos vivos do corpus são cerca pendurada na última linha, que não cega nada.
  it('cerca aberta que não esconde link nenhum NÃO acusa (gritar sem vítima ensina a ignorar)', () => {
    expect(auditarLinks(doc('docs/a/x.md', 'texto\n```'), repo(), nadaNoDisco)).toEqual([]);
  });

  it('link DENTRO de cerca fechada não é julgado', () => {
    const a = auditarLinks(doc('docs/a/x.md', '```\n[i](../nao/existe.md)\n```'), repo(), nadaNoDisco);
    expect(a).toEqual([]);
  });
});

describe('sugerirCaminho — a classe medida: caminho escrito a partir da RAIZ do repo', () => {
  it('alvo que é caminho de raiz vira o relativo certo', () => {
    const s = sugerirCaminho('docs/historico/auditoria.md', 'docs/ux-audit/01.md', repo('docs/ux-audit/01.md'));
    expect(s).toBe('../ux-audit/01.md');
  });

  it('preserva a âncora na sugestão', () => {
    const s = sugerirCaminho('docs/a/x.md', 'docs/b/y.md#secao', repo('docs/b/y.md'));
    expect(s).toBe('../b/y.md#secao');
  });

  it('cai para basename ÚNICO quando o caminho de raiz não bate', () => {
    expect(sugerirCaminho('docs/a/x.md', '../z/unico.md', repo('docs/b/unico.md'))).toBe('../b/unico.md');
  });

  // Chute em mensagem de erro é pior que silêncio.
  it('basename AMBÍGUO não sugere nada', () => {
    const s = sugerirCaminho('docs/a/x.md', '../z/README.md', repo('docs/b/README.md', 'docs/c/README.md'));
    expect(s).toBeNull();
  });

  it('prefixa ./ quando o alvo é irmão', () => {
    expect(sugerirCaminho('docs/a/x.md', 'docs/a/y.md', repo('docs/a/y.md'))).toBe('./y.md');
  });
});
