import { describe, it, expect } from 'vitest';
import { extrairBuildId, resolverBuildId, BUILD_ID_DESCONHECIDO } from '@/lib/build-id';

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
