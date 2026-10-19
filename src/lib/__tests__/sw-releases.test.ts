import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';
import {
  opcoesDeBusca,
  BUILD_LEGADO,
  CACHE_ASSETS_PROGRESSIVO,
  CACHE_META,
  ESTADO_INICIAL,
  avaliarResposta,
  buildIdDoManifesto,
  cachesDescartaveis,
  entryPrimeiro,
  estadoComLegado,
  htmlEhDaRelease,
  normalizarEstado,
  respostaServivel,
  faltantes,
  faseDaPagina,
  navegacaoSoRede,
  nomeCachePrecacheWorkbox,
  nomeCacheRelease,
  promover,
  reaproveitavel,
  urlDaEntrada,
  type EstadoPublicado,
} from '@/sw/releases';

const SCOPE = 'https://steu.lovable.app/';
const LEGADO = nomeCachePrecacheWorkbox(SCOPE);
const MANIFESTO = [
  { url: 'index.html', revision: 'abc' },
  { url: 'assets/index-NOVO999.js', revision: null },
  { url: 'assets/index-NOVO999.css', revision: null },
  { url: 'assets/vendor-react-Dm9CHLxI.js', revision: null },
  { url: 'pwa-192x192.png', revision: 'r1' },
];

describe('build da release = o entry REAL (há vários index-*.js no bundle)', () => {
  const HTML = '<script type="module" crossorigin src="/assets/index-NOVO999.js"></script>';
  const comChunkHomonimo = [
    { url: 'index.html', revision: 'abc' },
    { url: 'assets/index-CHUNK000.js', revision: null }, // chunk compartilhado também chamado index
    { url: 'assets/index-NOVO999.js', revision: null },
  ];

  it('entryPrimeiro põe o entry do index.html na frente — e só ele', () => {
    const m = entryPrimeiro(comChunkHomonimo, HTML);
    expect(m[0].url).toBe('assets/index-NOVO999.js');
    expect(m).toHaveLength(3);
    expect(buildIdDoManifesto(m)).toBe('index-NOVO999');
  });

  it('sem o transform, o 1º index-*.js seria o chunk errado — por isso o SW só lê a 1ª entrada', () => {
    expect(buildIdDoManifesto(comChunkHomonimo)).toBeNull();
  });

  it('fail-closed: entry fora do HTML ou do manifesto derruba o BUILD', () => {
    expect(() => entryPrimeiro(comChunkHomonimo, '<html></html>')).toThrow(/não encontrado no index.html/);
    expect(() => entryPrimeiro(comChunkHomonimo, '<script src="/assets/index-OUTRO11.js">')).toThrow(/fora do manifesto/);
  });
});

describe('o que falta baixar', () => {
  it('URL absoluta sem revisão é a chave da release', () => {
    expect(urlDaEntrada(MANIFESTO[1], SCOPE)).toBe('https://steu.lovable.app/assets/index-NOVO999.js');
  });
  it('só arquivo com hash é reaproveitável de outro cache; com revisão rebaixa', () => {
    expect(reaproveitavel(MANIFESTO[3])).toBe(true);
    expect(reaproveitavel(MANIFESTO[0])).toBe(false);
  });
  it('faltantes = manifesto menos o já gravado (retoma de onde parou)', () => {
    const presentes = new Set([urlDaEntrada(MANIFESTO[0], SCOPE), urlDaEntrada(MANIFESTO[3], SCOPE)]);
    expect(faltantes(MANIFESTO, presentes, SCOPE).map((e) => e.url)).toEqual([
      'assets/index-NOVO999.js',
      'assets/index-NOVO999.css',
      'pwa-192x192.png',
    ]);
  });
});

describe('avaliarResposta — nunca gravar lixo na release', () => {
  const js = 'https://steu.lovable.app/assets/index-NOVO999.js';
  it('200 JS → ok', () => {
    expect(avaliarResposta(js, { ok: true, status: 200, contentType: 'text/javascript; charset=utf-8' })).toBe('ok');
  });
  it('404 → ausente: o host apagou o build; a release ficou obsoleta', () => {
    expect(avaliarResposta(js, { ok: false, status: 404, contentType: 'text/plain' })).toBe('ausente');
  });
  it('200 com HTML num .js (fallback de SPA) → inválida', () => {
    expect(avaliarResposta(js, { ok: true, status: 200, contentType: 'text/html' })).toBe('invalida');
  });
  it('5xx → transitória (retenta depois, sem marcar falha)', () => {
    expect(avaliarResposta(js, { ok: false, status: 503, contentType: null })).toBe('transitoria');
  });
  it('index.html com HTML é ok (só .js/.css exigem não-HTML)', () => {
    expect(avaliarResposta('https://steu.lovable.app/index.html', { ok: true, status: 200, contentType: 'text/html' })).toBe('ok');
  });
});

describe('promoção e retenção', () => {
  const novo = { buildId: 'index-NOVO999', cache: nomeCacheRelease('index-NOVO999') };

  it('o precache do Workbox no aparelho é a release servida até a 1ª promoção', () => {
    expect(estadoComLegado(ESTADO_INICIAL, LEGADO).promovida).toEqual({ buildId: BUILD_LEGADO, cache: LEGADO });
    expect(estadoComLegado(ESTADO_INICIAL, null)).toEqual(ESTADO_INICIAL);
  });

  it('promover guarda a anterior (página aberta nela continua servida)', () => {
    const e = promover(estadoComLegado(ESTADO_INICIAL, LEGADO), novo);
    expect(e.promovida).toEqual(novo);
    expect(e.anteriores.map((r) => r.cache)).toEqual([LEGADO]);
  });

  it('retém as DUAS anteriores: aba que atravessa 2 promoções não perde seus chunks (P2 Codex)', () => {
    const b = { buildId: 'index-B', cache: nomeCacheRelease('index-B') };
    const c = { buildId: 'index-C', cache: nomeCacheRelease('index-C') };
    const e = promover(promover(promover(estadoComLegado(ESTADO_INICIAL, LEGADO), novo), b), c);
    expect(e.promovida).toEqual(c);
    expect(e.anteriores.map((r) => r.buildId)).toEqual(['index-B', 'index-NOVO999']);
    const nomes = [LEGADO, novo.cache, b.cache, c.cache];
    expect(cachesDescartaveis(nomes, e, c.cache)).toEqual([LEGADO]);
  });

  it('normalizarEstado aceita a forma antiga (anterior único) e lixo', () => {
    expect(normalizarEstado({ promovida: novo, anterior: { buildId: BUILD_LEGADO, cache: LEGADO } })).toEqual({
      promovida: novo,
      anteriores: [{ buildId: BUILD_LEGADO, cache: LEGADO }],
    });
    expect(normalizarEstado(null)).toEqual(ESTADO_INICIAL);
  });

  it('promover a mesma release é no-op', () => {
    const e = promover(ESTADO_INICIAL, novo);
    expect(promover(e, novo)).toBe(e);
  });

  it('1ª promoção RETÉM o legado (o build velho ainda pode estar aberto) e apaga releases órfãs', () => {
    const e = promover(estadoComLegado(ESTADO_INICIAL, LEGADO), novo);
    const nomes = [LEGADO, novo.cache, nomeCacheRelease('index-ORFA111'), CACHE_META, CACHE_ASSETS_PROGRESSIVO, 'supabase-picking-cache'];
    expect(cachesDescartaveis(nomes, e, novo.cache)).toEqual([nomeCacheRelease('index-ORFA111')]);
  });

  it('legado só sai quando deixa de ser retido — nunca toca supabase-*, meta ou runtime', () => {
    const e1 = promover(estadoComLegado(ESTADO_INICIAL, LEGADO), novo);
    const outro = { buildId: 'index-OUTRO22', cache: nomeCacheRelease('index-OUTRO22') };
    const e2 = promover(e1, outro);
    const nomes = [LEGADO, novo.cache, outro.cache, CACHE_META, CACHE_ASSETS_PROGRESSIVO, 'supabase-orders-cache'];
    expect(cachesDescartaveis(nomes, e2, outro.cache)).toEqual([]); // legado ainda é a 2ª anterior
    const terceiro = { buildId: 'index-TERC333', cache: nomeCacheRelease('index-TERC333') };
    expect(cachesDescartaveis([...nomes, terceiro.cache], promover(e2, terceiro), terceiro.cache)).toEqual([LEGADO]);
  });
});

describe('P1 do Codex: o HTML precisa ser do build da release', () => {
  it('HTML de outro build (Publish no meio do preparo) é recusado', () => {
    expect(htmlEhDaRelease('<script src="/assets/index-NOVO999.js">', 'index-NOVO999')).toBe(true);
    expect(htmlEhDaRelease('<script src="/assets/index-MAIS999.js">', 'index-NOVO999')).toBe(false);
    expect(htmlEhDaRelease('<html></html>', 'index-NOVO999')).toBe(false);
  });
});

describe('respostaServivel — vale na gravação E na leitura (P2 Codex)', () => {
  const js = 'https://steu.lovable.app/assets/x-1.js';
  it('200 JS serve; 206 parcial, opaca e HTML-200 num .js não', () => {
    expect(respostaServivel(js, { status: 200, type: 'basic', contentType: 'text/javascript' })).toBe(true);
    expect(respostaServivel(js, { status: 206, type: 'basic', contentType: 'text/javascript' })).toBe(false);
    expect(respostaServivel(js, { status: 200, type: 'opaque', contentType: null })).toBe(false);
    expect(respostaServivel(js, { status: 200, type: 'basic', contentType: 'text/html' })).toBe(false);
  });
});

describe('navegação', () => {
  it('OAuth do Lovable e rotas internas nunca vêm do cache', () => {
    expect(navegacaoSoRede('/~oauth/callback')).toBe(true);
    expect(navegacaoSoRede('/__lovable')).toBe(true);
    expect(navegacaoSoRede('/recebimento')).toBe(false);
  });
});

describe('faseDaPagina', () => {
  const base: EstadoPublicado = { type: 'RELEASE_ESTADO', promovida: null, release: null, progresso: null, problema: null };
  it('promovida ≠ meu build → pronta', () => {
    expect(faseDaPagina('index-A', { ...base, promovida: 'index-B', release: 'index-B' })).toBe('pronta');
  });
  it('promovida = legado não é "versão nova" para uma página nova', () => {
    expect(faseDaPagina('index-A', { ...base, promovida: BUILD_LEGADO, release: 'index-A' })).toBe('em_dia');
  });
  it('SW preparando outro build → baixando; obsoleta continua baixando (SW mais novo vem no update)', () => {
    expect(faseDaPagina('index-A', { ...base, promovida: 'index-A', release: 'index-B' })).toBe('baixando');
    expect(faseDaPagina('index-A', { ...base, promovida: 'index-A', release: 'index-B', problema: 'obsoleta' })).toBe('baixando');
  });
  it('quota/inválida → falhou', () => {
    expect(faseDaPagina('index-A', { ...base, promovida: 'index-A', release: 'index-B', problema: 'quota' })).toBe('falhou');
    expect(faseDaPagina('index-A', { ...base, promovida: 'index-A', release: 'index-B', problema: 'invalida' })).toBe('falhou');
  });
  it('tudo no meu build → em dia', () => {
    expect(faseDaPagina('index-A', { ...base, promovida: 'index-A', release: 'index-A' })).toBe('em_dia');
  });
});

describe('cookie `__dpl` do host (2026-10-19): o preparo busca SEM cookies', () => {
  // Medido no Chrome do founder: com cookies, `/index.html` e os assets vinham do deployment
  // PINADO (velho) — entry novo 404 → `obsoleta` para sempre; `/sw.js` vinha sempre do mais novo.
  it('toda entrada vai com credentials omit; o modo de cache segue por tipo (hash = default, revisão = no-cache)', () => {
    expect(opcoesDeBusca({ url: 'assets/vendor-react-Dm9CHLxI.js', revision: null })).toEqual({ cache: 'default', credentials: 'omit' });
    expect(opcoesDeBusca({ url: 'index.html', revision: 'abc' })).toEqual({ cache: 'no-cache', credentials: 'omit' });
  });

  it('o SW usa opcoesDeBusca no fetch do preparo — nenhum fetch com cookies em sw.ts', () => {
    const src = readFileSync(new URL('../../sw/sw.ts', import.meta.url), 'utf8');
    expect(src).toContain('fetch(url, opcoesDeBusca(e))');
    expect(src).not.toMatch(/credentials:\s*['"](same-origin|include)['"]/);
  });
});
