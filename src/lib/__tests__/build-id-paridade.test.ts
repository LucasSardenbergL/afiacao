/**
 * @vitest-environment jsdom
 *
 * Exceção ao particionamento por extensão (`projects` em vitest.config.ts): este é um
 * `.ts` — logo, no ambiente `node` por padrão — mas toca DOM. O docblock sobrepõe o
 * project e é local ao arquivo, então não vira ímã de conflito entre worktrees.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { extrairBuildEm, extrairBuildId, resolverBuildEm, resolverBuildId, BUILD_ID_DESCONHECIDO } from '@/lib/build-id';

const VERIFY_SH = join(process.cwd(), '.claude/skills/lovable-deploy-verify/scripts/verify-frontend.sh');

/**
 * O regex de `build-id.ts` e o do `verify-frontend.sh` são os DOIS LADOS da conta de
 * adoção (cliente executa × servidor entrega). Se um mudar sozinho, os dois param de
 * casar e o sintoma é "adoção 0%" — indistinguível de ninguém ter atualizado, que é
 * exatamente o erro que este trabalho existe pra tornar impossível.
 *
 * A paridade é checada por COMPORTAMENTO, não por texto: dois regexes escritos
 * diferente podem ser equivalentes, e dois quase-iguais podem divergir.
 */
function padraoDoVerificador(): RegExp {
  const linha = readFileSync(VERIFY_SH, 'utf8')
    .split('\n')
    .find((l) => l.includes('ENTRY=') && l.includes('grep -oE'));
  if (!linha) throw new Error('verify-frontend.sh mudou de forma: não achei a linha do ENTRY');
  const casou = /grep -oE '([^']+)'/.exec(linha);
  if (!casou?.[1]) throw new Error(`não consegui extrair o regex de: ${linha}`);
  return new RegExp(casou[1]);
}

describe('paridade com verify-frontend.sh', () => {
  const AMOSTRAS = [
    '/assets/index-TTF9Kw1g.js', // build REAL medido em 2026-08-24
    '/assets/index-DghZxghH.js', // o que o SW servia no incidente
    '/assets/index-DnOk4g4H.js', // o que o servidor entregava no incidente
    'https://steu.lovable.app/assets/index-Ab_c-123.js',
    '/assets/vendor-react-abc.js',
    '/assets/index-BhK2xz.css',
    '/src/main.tsx',
  ];

  it('os dois lados concordam, amostra por amostra', () => {
    const reShell = padraoDoVerificador();
    for (const src of AMOSTRAS) {
      const doShell = reShell.exec(src)?.[0] ?? null;
      const daApp = extrairBuildId([src]);
      const esperado = doShell === null ? BUILD_ID_DESCONHECIDO : doShell.replace(/^.*\/assets\//, '').replace(/\.js$/, '');
      expect(daApp, `divergência em ${src} (shell viu ${doShell})`).toBe(esperado);
    }
  });
});

// Prova de ponta a ponta contra o HTML que o Vite REALMENTE gera. Na suíte comum pula sem `dist/`
// (o job `testes` não builda). O CI a roda DEPOIS do build, no job `edges-e-build`, com
// `BUILD_ID_EXIGE_DIST=1` (M-21): ali `dist/` ausente é VERMELHO, não skip — senão um build que
// mudasse de lugar faria a prova sumir calada, exatamente o "1 skipped" que ela era antes.
const DIST = join(process.cwd(), 'dist/index.html');
const EXIGE_DIST = process.env.BUILD_ID_EXIGE_DIST === '1';
describe.skipIf(!existsSync(DIST) && !EXIGE_DIST)('contra o dist/ real', () => {
  it('acha o entry no index.html gerado pelo build de produção', () => {
    expect(existsSync(DIST), `${DIST} não existe — o build não rodou antes desta prova`).toBe(true);
    const doc = document.implementation.createHTMLDocument('dist');
    doc.documentElement.innerHTML = readFileSync(DIST, 'utf8');
    const id = resolverBuildId(doc);
    expect(id).not.toBe(BUILD_ID_DESCONHECIDO);
    expect(id).toMatch(/^index-[A-Za-z0-9_-]+$/);
  });

  it('o carimbo ordenável sai no MESMO index.html, e a leitura de texto (servidor) = a de DOM (cliente)', () => {
    const html = readFileSync(DIST, 'utf8');
    const doc = document.implementation.createHTMLDocument('dist');
    doc.documentElement.innerHTML = html;
    const doDom = resolverBuildEm(doc);
    expect(doDom, 'dist/index.html sem <meta name="app-build-em"> — o plugin carimboDeBuild saiu do vite.config?').not.toBeNull();
    expect(extrairBuildEm(html)).toBe(doDom);
    // build_id segue o eixo de adoção: o carimbo vai junto, não no lugar.
    expect(resolverBuildId(doc)).toBe(extrairBuildId([html]));
  });
});

// O carimbo é COMPLEMENTO do build_id, nunca substituto (o build_id é o eixo de adoção):
// as duas leituras saem do mesmo documento e uma não mexe na outra.
describe('paridade build_id × carimbo (build_em)', () => {
  const HTML =
    '<head><meta name="app-build-em" content="2026-10-17T15:00:00.000Z"></head>' +
    '<body><script type="module" src="/assets/index-TTF9Kw1g.js"></script></body>';

  it('lê os dois do mesmo documento; texto (servidor) e DOM (cliente) concordam', () => {
    const doc = document.implementation.createHTMLDocument('t');
    doc.documentElement.innerHTML = HTML;
    expect(resolverBuildId(doc)).toBe('index-TTF9Kw1g');
    expect(extrairBuildId([HTML])).toBe('index-TTF9Kw1g');
    expect(resolverBuildEm(doc)).toBe('2026-10-17T15:00:00.000Z');
    expect(extrairBuildEm(HTML)).toBe('2026-10-17T15:00:00.000Z');
  });

  it('sem o carimbo, o build_id não muda (build anterior ao carimbo segue identificável)', () => {
    const semCarimbo = '<script type="module" src="/assets/index-TTF9Kw1g.js"></script>';
    const doc = document.implementation.createHTMLDocument('t');
    doc.documentElement.innerHTML = semCarimbo;
    expect(resolverBuildId(doc)).toBe('index-TTF9Kw1g');
    expect(resolverBuildEm(doc)).toBeNull();
    expect(extrairBuildEm(semCarimbo)).toBeNull();
  });

  it('carimbo ilegível → null (ausência de dado, nunca um instante inventado)', () => {
    expect(extrairBuildEm('<meta name="app-build-em" content="ontem">')).toBeNull();
  });
});
