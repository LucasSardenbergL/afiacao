/**
 * @vitest-environment jsdom
 *
 * Exceção ao particionamento por extensão (`projects` em vitest.config.ts): este é um
 * `.ts` — logo, no ambiente `node` por padrão — mas toca DOM. O docblock sobrepõe o
 * project e é local ao arquivo, então não vira ímã de conflito entre worktrees.
 */
import { describe, it, expect } from 'vitest';
import { BUILD_ID_DESCONHECIDO, extrairBuildId, extrairCommitEm, resolverBuildId, resolverCommit } from '@/lib/build-id';

describe('extrairBuildId', () => {
  it('extrai o hash do chunk do entry', () => {
    expect(extrairBuildId(['/assets/index-DnOk4g4H.js'])).toBe('index-DnOk4g4H');
  });

  // script.src no DOM devolve a URL ABSOLUTA resolvida, nunca o atributo cru.
  it('funciona com URL absoluta (a forma que o DOM realmente entrega)', () => {
    expect(extrairBuildId(['https://app.colacor.com.br/assets/index-DghZxghH.js'])).toBe('index-DghZxghH');
  });

  it('ignora o CSS do entry (index-*.css) e casa só o .js', () => {
    expect(extrairBuildId(['/assets/index-BhK2xz.css'])).toBe(BUILD_ID_DESCONHECIDO);
  });

  it('ignora chunks que não são o entry', () => {
    expect(extrairBuildId(['/assets/vendor-react-abc123.js', '/assets/index-XYZ789.js'])).toBe('index-XYZ789');
  });

  it('degrada em dev (o entry é /src/main.tsx, sem hash)', () => {
    expect(extrairBuildId(['/src/main.tsx'])).toBe(BUILD_ID_DESCONHECIDO);
  });

  it('degrada sem entrada', () => {
    expect(extrairBuildId([])).toBe(BUILD_ID_DESCONHECIDO);
  });
});

describe('resolverBuildId', () => {
  it('lê o entry do <script type="module"> do documento', () => {
    const doc = document.implementation.createHTMLDocument('t');
    const s = doc.createElement('script');
    s.type = 'module';
    s.setAttribute('src', '/assets/index-DnOk4g4H.js');
    doc.head.appendChild(s);
    expect(resolverBuildId(doc)).toBe('index-DnOk4g4H');
  });

  it('degrada para desconhecido quando não há entry no documento', () => {
    const doc = document.implementation.createHTMLDocument('t');
    expect(resolverBuildId(doc)).toBe(BUILD_ID_DESCONHECIDO);
  });

  it('não explode sem document (SSR/worker)', () => {
    expect(resolverBuildId(null)).toBe(BUILD_ID_DESCONHECIDO);
  });
});

describe('commit do build (app-commit-sha / app-commit-em) — a versão igual no preview e no Publish', () => {
  it('extrairCommitEm lê a data do commit do HTML como texto; ilegível/ausente → null', () => {
    expect(extrairCommitEm('<meta name="app-commit-em" content="2026-10-18T19:02:11.000Z">')).toBe(
      '2026-10-18T19:02:11.000Z',
    );
    expect(extrairCommitEm('<meta name="app-commit-em" content="ontem">')).toBeNull();
    expect(extrairCommitEm('<meta name="app-build-em" content="2026-10-18T19:06:02.000Z">')).toBeNull();
  });

  it('resolverCommit: sem documento ou sem as metas (builder sem .git) → { null, null }, nunca "dev"', () => {
    expect(resolverCommit(null)).toEqual({ sha: null, em: null });
    const vazio = { querySelector: () => null } as unknown as Document;
    expect(resolverCommit(vazio)).toEqual({ sha: null, em: null });
  });

  it('resolverCommit lê as duas metas do documento carregado', () => {
    const metas: Record<string, string> = {
      'meta[name="app-commit-sha"]': '0153e797',
      'meta[name="app-commit-em"]': '2026-10-18T19:02:11.000Z',
    };
    const doc = {
      querySelector: (sel: string) => (sel in metas ? { getAttribute: () => metas[sel] } : null),
    } as unknown as Document;
    expect(resolverCommit(doc)).toEqual({ sha: '0153e797', em: '2026-10-18T19:02:11.000Z' });
  });
});
