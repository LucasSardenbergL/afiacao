import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { extrairBuildId, resolverBuildId, BUILD_ID_DESCONHECIDO } from '@/lib/build-id';

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

// Prova de ponta a ponta contra o HTML que o Vite REALMENTE gera. Pula sem `dist/`
// (o CI não builda antes de testar) — por isso o guard de paridade acima, que roda
// sempre, é quem sustenta a garantia no CI.
const DIST = join(process.cwd(), 'dist/index.html');
describe.skipIf(!existsSync(DIST))('contra o dist/ real', () => {
  it('acha o entry no index.html gerado pelo build de produção', () => {
    const doc = document.implementation.createHTMLDocument('dist');
    doc.documentElement.innerHTML = readFileSync(DIST, 'utf8');
    const id = resolverBuildId(doc);
    expect(id).not.toBe(BUILD_ID_DESCONHECIDO);
    expect(id).toMatch(/^index-[A-Za-z0-9_-]+$/);
  });
});
