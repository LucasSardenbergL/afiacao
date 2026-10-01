import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { confrontar, detectar, type Sitio } from '@/lib/gates/hoje-utc';
import { CONHECIDOS } from '@/lib/gates/hoje-utc-baseline';

// GATE — o "hoje" UTC no TypeScript: `toISOString()` fatiado como data de negócio (front e edges) e, nas
// edges (servidor em UTC), o calendário "local" (`getDate()`…) e o locale sem `timeZone`. A classe e as
// formas estão no cabeçalho de `@/lib/gates/hoje-utc`; a varredura, em
// docs/historico/hoje-sp-typescript-e-data-ciclo.md. Mutações que provam o dente de cada camada:
// scripts/mutcheck.d/hoje-utc.mut.

const RAIZ = resolve(__dirname, '../..');
const DIRS = ['src', 'supabase/functions'];
const EXT = /\.(ts|tsx)$/;
const IGNORAR = /(\.test\.|_test\.|\.d\.ts$|__tests__|\.stories\.)/;

/** Pisos por universo: zero é leitura quebrada, nunca "repo sem a classe". Medido em 2026-10-01: 1.491 e 243. */
const PISOS = { src: 1300, edges: 200, sitios: 100 } as const;

function listar(dir: string, acc: string[] = []): string[] {
  for (const nome of readdirSync(resolve(RAIZ, dir))) {
    const rel = join(dir, nome);
    if (statSync(resolve(RAIZ, rel)).isDirectory()) {
      if (nome === 'node_modules' || nome === '.git') continue;
      listar(rel, acc);
    } else if (EXT.test(nome) && !IGNORAR.test(rel)) {
      acc.push(rel.replace(/\\/g, '/'));
    }
  }
  return acc;
}

const formas = (s: readonly Sitio[]) => s.map((x) => `${x.forma}: ${x.trecho}`);

describe('gate: o "hoje" UTC no TypeScript (classe ii do fuso, fase 3)', () => {
  const arquivos = DIRS.flatMap((d) => listar(d));
  const sitios = arquivos.flatMap((a) => detectar(a, readFileSync(resolve(RAIZ, a), 'utf8')));

  it('o walker anda de verdade: os dois universos, acima do piso, com as âncoras', () => {
    expect(arquivos.filter((a) => a.startsWith('src/')).length).toBeGreaterThan(PISOS.src);
    expect(arquivos.filter((a) => a.startsWith('supabase/functions/')).length).toBeGreaterThan(PISOS.edges);
    expect(arquivos).toContain('supabase/functions/gerar-pedidos-diario/index.ts');
    expect(arquivos).toContain('src/lib/dashboard/sp-date.ts');
    // controle POSITIVO de detecção no repo real: um detector cego daria 0 e a baseline acusaria tudo
    // como quitado — mas é melhor que a cegueira tenha nome próprio
    expect(sitios.length).toBeGreaterThan(PISOS.sitios);
  });

  it('o detector vê cada forma (fonte sintética)', () => {
    const edge = 'supabase/functions/x/index.ts';
    expect(formas(detectar(edge, [
      'const a = new Date().toISOString().slice(0, 10);',
      'const b = d.toJSON().substring(0, 7);',
      'const c = new Date(t)\n  .toISOString()\n  .slice(2, 10);',
      'const e = new Date().toISOString().split("T")[0];',
      "const f = x.toISOString().split('T')[0];",
      'const corte = new Date(Date.now() - 30 * 864e5).toISOString();',   // o ISO numa variável...
      "q.gte('visit_date', corte.slice(0, 10));",                          // ...fatiado depois
      'const js = y.toJSON(); const l = js.split("T")[0];',
      'const g = new Date().getDate();',
      'h.setHours(0, 0, 0, 0);',
      'const i = new Date().toLocaleDateString("pt-BR");',
      'const j = new Intl.DateTimeFormat("pt-BR", { day: "2-digit" });',
      'const k = new Date(x).toLocaleString("pt-BR");',
    ].join('\n')))).toEqual([
      'iso-fatiado: new Date().toISOString().slice(0, 10)',
      'iso-fatiado: d.toJSON().substring(0, 7)',
      'iso-fatiado: new Date(t) .toISOString() .slice(2, 10)',
      'iso-fatiado: new Date().toISOString().split("T")[0]',
      "iso-fatiado: x.toISOString().split('T')[0]",
      'iso-fatiado: corte.slice(0, 10)',
      'iso-fatiado: js.split("T")[0]',
      'calendario-local-no-servidor: new Date().getDate()',
      'calendario-local-no-servidor: h.setHours(0, 0, 0, 0)',
      'locale-sem-fuso-no-servidor: new Date().toLocaleDateString("pt-BR")',
      'locale-sem-fuso-no-servidor: new Intl.DateTimeFormat("pt-BR", { day: "2-digit" })',
      'locale-sem-fuso-no-servidor: new Date(x).toLocaleString("pt-BR")',
    ]);
  });

  it('e não vê o que não é a classe: comentário, string, UTC escrito, fuso escrito, get* no navegador', () => {
    const edge = 'supabase/functions/x/index.ts';
    expect(detectar(edge, [
      '// new Date().toISOString().slice(0, 10) — a forma errada CITADA num comentário',
      'const s = "new Date().toISOString().slice(0, 10)";',
      'const t = new Date().toISOString();',                       // o instante inteiro é UTC por contrato
      'const u = new Date().getUTCDate() + d.getUTCMonth();',
      'const v = new Date().toLocaleDateString("pt-BR", { timeZone: "America/Sao_Paulo" });',
      'const w = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Sao_Paulo" });',
      'const y = (1234.5).toLocaleString("pt-BR");',               // número, não data
      'const z = iso.slice(0, 10);',                               // nome que não foi declarado com o ISO
      'const nome = s.toUpperCase(); const p = nome.slice(0, 10);', // variável que não guarda ISO
    ].join('\n'))).toEqual([]);
    // no navegador o "local" é o fuso do usuário (SP): get* e toLocale* estão certos lá
    expect(detectar('src/x.ts', 'const a = new Date().getDate(); const b = new Date().toLocaleDateString("pt-BR");')).toEqual([]);
    // mas o ISO fatiado é UTC no navegador também
    expect(formas(detectar('src/x.ts', 'const a = new Date().toISOString().slice(0, 10);'))).toEqual([
      'iso-fatiado: new Date().toISOString().slice(0, 10)',
    ]);
  });

  it('nenhum sítio NOVO fora da baseline', () => {
    const { novos } = confrontar(sitios, CONHECIDOS);
    expect(
      novos,
      'o dia UTC tomado como dia de negócio: das 21h às 24h BRT ele já é amanhã. Use hojeSP()/addDias() ' +
        '(@/lib/dashboard/sp-date) ou spBusinessDate() (@/lib/time/sp-day) no front; hojeSP()/diaSP()/somarDias()/' +
        'paraDataOmie() (supabase/functions/_shared/hoje-sp.ts) nas edges. UTC de propósito: getUTC*()/Date.UTC ' +
        'montando a string. Sítio que é UTC contra UTC de verdade entra na baseline com o veredito e o motivo medidos. ' +
        'docs/historico/hoje-sp-typescript-e-data-ciclo.md',
    ).toEqual([]);
  });

  it('nenhuma entrada QUITADA esquecida na baseline (a lista só encolhe)', () => {
    expect(confrontar(sitios, CONHECIDOS).quitados).toEqual([]);
  });

  it('a detecção de QUITADO tem dente: uma entrada sem sítio no arquivo aparece', () => {
    const fantasma = { arquivo: 'src/x.ts', trecho: 'new Date().toISOString().slice(0, 10)', n: 1,
      veredito: 'afetado-baixo' as const, motivo: '[fase resto] entrada de controle que nenhum arquivo tem' };
    expect(confrontar(sitios, [...CONHECIDOS, fantasma]).quitados).toEqual([
      'src/x.ts · new Date().toISOString().slice(0, 10) (baseline 1, no arquivo 0)',
    ]);
  });

  it('a contagem é identidade: o MESMO trecho a mais num arquivo da baseline reprova', () => {
    const alvo = 'src/hooks/useExportNaoVinculados.ts';
    const base = CONHECIDOS.find((c) => c.arquivo === alvo && c.trecho === 'new Date().toISOString().slice(0, 10)');
    expect(base?.n).toBe(1);   // controle: o arquivo tem 1 na baseline
    const fonte = readFileSync(resolve(RAIZ, alvo), 'utf8') + '\nexport const outra = new Date().toISOString().slice(0, 10);\n';
    const { novos } = confrontar([...sitios.filter((s) => s.arquivo !== alvo), ...detectar(alvo, fonte)], CONHECIDOS);
    expect(novos).toEqual([`${alvo} · new Date().toISOString().slice(0, 10) (2× no arquivo, baseline 1)`]);
  });

  it('toda entrada da baseline diz o veredito e o porquê; afetado diz o dono', () => {
    expect(new Set(CONHECIDOS.map((c) => `${c.arquivo} · ${c.trecho}`)).size).toBe(CONHECIDOS.length);
    for (const c of CONHECIDOS) {
      expect(c.n, `${c.arquivo} · ${c.trecho}`).toBeGreaterThan(0);
      expect(c.motivo.length, `${c.arquivo} · ${c.trecho}`).toBeGreaterThan(20);
      if (c.veredito.startsWith('afetado')) expect(c.motivo, `${c.arquivo} · ${c.trecho}`).toMatch(/^\[fase [a-z-]+\] /);
    }
  });

  it('canário: o defeito-mãe reintroduzido em gerar-pedidos-diario REPROVA, nomeando o sítio', () => {
    const alvo = 'supabase/functions/gerar-pedidos-diario/index.ts';
    const fonte = readFileSync(resolve(RAIZ, alvo), 'utf8');
    // controle: o arquivo hoje usa o helper — senão o canário mediria o defeito de sempre
    expect(fonte).toContain('let dataCiclo = hojeSP();');
    const comDefeito = fonte.replace('let dataCiclo = hojeSP();', 'let dataCiclo = new Date().toISOString().slice(0, 10);');
    const outros = sitios.filter((s) => s.arquivo !== alvo);
    const { novos } = confrontar([...outros, ...detectar(alvo, comDefeito)], CONHECIDOS);
    expect(novos).toEqual([`${alvo} · new Date().toISOString().slice(0, 10) (1× no arquivo, baseline 0)`]);
  });
});
