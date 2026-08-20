import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { removerComentarios, medirPreservacao, maiorBlocoDescartado } from '../limpeza-fonte';

// Prova do stripper que os gates textuais usam para não medir a prosa que DESCREVE o defeito.
//
// O que estava errado antes (medido em 2026-08-20): todo gate limpava comentário com
// `s.replace(/\/\*[\s\S]*?\*\//g, '')`. Regex não sabe o que é string, então um `/*` dentro de
// string pareava com o próximo `*/` REAL do arquivo. O fiscal media o que sobrava — e ficava
// verde por CEGUEIRA, que é indistinguível de verde por mérito.
//
// A CALIBRAÇÃO é o coração deste arquivo: um detector precisa provar que enxerga a forma que
// deve remover E que NÃO remove a forma que deve preservar. Sem os dois lados, "não achou nada"
// e "está quebrado" são o mesmo output.

// O header real das edges Sayerlack — a string que envenenou 1.041 de 1.226 linhas.
const ACEITA = `'image/avif,image/webp,*/*;q=0.8'`;

describe('removerComentarios: remove comentário, e SÓ comentário', () => {
  it('remove bloco e linha', () => {
    const fonte = ['/* cabeçalho', '   com prosa */', 'const a = 1; // rabo', '// linha inteira', 'const b = 2;'].join('\n');
    const limpo = removerComentarios(fonte);
    expect(limpo).not.toMatch(/prosa|rabo|linha inteira/);
    expect(limpo).toMatch(/const a = 1;/);
    expect(limpo).toMatch(/const b = 2;/);
  });

  it('PRESERVA o número de linhas — gate com `^…`/multiline e gate que compara POSIÇÃO dependem disso', () => {
    const fonte = ['const a = 1;', '/* uma', 'duas', 'três */', 'const b = 2;'].join('\n');
    expect(removerComentarios(fonte).split('\n').length).toBe(fonte.split('\n').length);
  });

  // ── O caso que originou a classe ────────────────────────────────────────────────────────
  it('NÃO remove um `/*` que vive dentro de string (o mimetype coringa do header Accept)', () => {
    const fonte = [
      `const headers = { Accept: ${ACEITA} };`,
      'const alvo = 1;',
      '/* comentário de verdade, este SAI */',
      'const depois = 2;',
    ].join('\n');
    const limpo = removerComentarios(fonte);
    expect(limpo, 'a string do header sai intacta').toContain(ACEITA);
    expect(limpo, 'a linha ENTRE o falso `/*` e o `*/` real não pode sumir').toMatch(/const alvo = 1;/);
    expect(limpo, 'o código depois do bloco real não pode sumir').toMatch(/const depois = 2;/);
    expect(limpo, 'o comentário de verdade sai').not.toMatch(/comentário de verdade/);
  });

  it('controle: o stripper ANTIGO apagava justamente essa região (a cegueira era real, não teórica)', () => {
    const fonte = [
      `const headers = { Accept: ${ACEITA} };`,
      'const alvo = 1;',
      '/* comentário de verdade */',
      'const depois = 2;',
    ].join('\n');
    const antigo = fonte.replace(/\/\*[\s\S]*?\*\//g, '');
    expect(antigo, 'sem este vermelho, o teste acima não prova nada').not.toMatch(/const alvo = 1;/);
  });

  it('`/*` em aspas duplas, template e regex literal também sobrevivem', () => {
    const casos = [
      'const a = "abre /* aqui";',
      'const b = `template /* aqui ${x} */ fim`;',
      'const c = /\\/\\*/g;',
    ];
    for (const caso of casos) {
      const fonte = `${caso}\nconst marcador = 1;\n/* bloco */\nconst fim = 2;`;
      const limpo = removerComentarios(fonte);
      expect(limpo, `sumiu código depois de: ${caso}`).toMatch(/const marcador = 1;/);
      expect(limpo, `sumiu código depois de: ${caso}`).toMatch(/const fim = 2;/);
    }
  });

  it('`//` dentro de string não é comentário (URL não pode truncar a linha)', () => {
    const fonte = `const u = 'https://exemplo.com/x'; const v = 2;`;
    expect(removerComentarios(fonte)).toMatch(/const v = 2;/);
  });

  it('`//` dentro de regex literal não é comentário', () => {
    const fonte = 'const re = /\\/\\/+/g; const v = 2;';
    expect(removerComentarios(fonte)).toMatch(/const v = 2;/);
  });

  it('divisão não é regex literal (senão o stripper comeria da barra até a próxima)', () => {
    const fonte = 'const m = total / linhas; const n = outro / 2; const v = 3;';
    const limpo = removerComentarios(fonte);
    expect(limpo).toMatch(/const v = 3;/);
    expect(limpo).toBe(fonte);
  });

  it('comentário de linha DEPOIS de string com aspas não some junto com a string', () => {
    const fonte = `const s = 'a'; // some\nconst t = 'b';`;
    const limpo = removerComentarios(fonte);
    expect(limpo).not.toMatch(/some/);
    expect(limpo).toMatch(/const t = 'b';/);
  });

  it('apóstrofo solto (texto JSX) não engole além da própria linha', () => {
    const fonte = `const a = <p>Don't</p>;\nconst b = 2;\nconst c = 3;`;
    const limpo = removerComentarios(fonte);
    expect(limpo, 'o estrago de uma leitura ambígua é no máximo o RESTO DA LINHA').toMatch(/const b = 2;/);
    expect(limpo).toMatch(/const c = 3;/);
  });

  it('bloco sem fechamento não apaga o arquivo inteiro além do que já é comentário', () => {
    const fonte = 'const a = 1;\n/* nunca fecha\nmais prosa';
    expect(removerComentarios(fonte)).toMatch(/const a = 1;/);
  });

  it('é idempotente', () => {
    const fonte = readFileSync(resolve(__dirname, '../limpeza-fonte.ts'), 'utf8');
    const um = removerComentarios(fonte);
    expect(removerComentarios(um)).toBe(um);
  });
});

// ── O sentinela que faltava ────────────────────────────────────────────────────────────────
// Os gates já provam que o walker anda (quantos ARQUIVOS leu). Faltava o outro denominador:
// quanto de CADA arquivo o fiscal chegou a olhar. Este bloco é ele, e roda sobre o repo inteiro.

const RAIZ = resolve(__dirname, '../../../..');
const DIRS = ['src', 'supabase/functions', 'scripts'];
const EXT = /\.(ts|tsx)$/;
const IGNORAR = /(\.d\.ts$|\.stories\.)/;

function listarFontes(dir: string, acc: string[] = []): string[] {
  for (const nome of readdirSync(resolve(RAIZ, dir))) {
    const rel = join(dir, nome);
    const st = statSync(resolve(RAIZ, rel));
    if (st.isDirectory()) {
      if (nome === 'node_modules' || nome === '.git') continue;
      listarFontes(rel, acc);
    } else if (EXT.test(nome) && !IGNORAR.test(rel)) {
      acc.push(rel);
    }
  }
  return acc;
}

// Teto do maior bloco contíguo descartado. Calibrado em 2026-08-20 sobre os 2.390 fontes:
// maior cabeçalho legítimo = 88 linhas (`src/hooks/useFarmerScoring.ts`); região comida pelo par
// falso em `sayerlack-captura-precos/index.ts` = 924. 150 fica entre os dois com folga dos dois
// lados. Subir este número é decisão consciente — e o commit que subir precisa dizer por quê.
const TETO_BLOCO = 150;

// Piso da fração preservada, entre arquivos com corpo. Eixo GROSSO de propósito: ele NÃO teria
// pego o caso Sayerlack (0,118 preservado, contra 0,154 de um `versao.ts` legítimo) — quem pega
// aquele é o TETO_BLOCO. Este piso cobre o outro extremo: stripper que passa a engolir quase tudo.
const PISO_FRACAO = 0.1;
const CORPO_MINIMO = 60;

describe('sentinela: a limpeza não descarta região grande demais para ser comentário', () => {
  const fontes = DIRS.flatMap((d) => listarFontes(d));

  it('o walker anda de verdade', () => {
    expect(fontes.length).toBeGreaterThan(2000);
    expect(fontes).toContain('supabase/functions/sayerlack-captura-precos/index.ts');
  });

  it(`nenhum arquivo perde bloco contíguo > ${TETO_BLOCO} linhas`, () => {
    const estouros = fontes
      .map((f) => [f, maiorBlocoDescartado(readFileSync(resolve(RAIZ, f), 'utf8'))] as const)
      .filter(([, n]) => n > TETO_BLOCO)
      .map(([f, n]) => `${f}: ${n} linhas`);
    expect(
      estouros,
      'ou nasceu um cabeçalho gigante (aí suba TETO_BLOCO dizendo por quê), ou o stripper ' +
        'voltou a comer código achando que era comentário — que é a classe inteira deste arquivo',
    ).toEqual([]);
  });

  it(`nenhum arquivo com ≥${CORPO_MINIMO} linhas preserva menos que ${PISO_FRACAO}`, () => {
    const afundados = fontes
      .map((f) => [f, medirPreservacao(readFileSync(resolve(RAIZ, f), 'utf8'))] as const)
      .filter(([, m]) => m.linhasOriginais >= CORPO_MINIMO && m.fracao < PISO_FRACAO)
      .map(([f, m]) => `${f}: ${m.linhasPreservadas}/${m.linhasOriginais}`);
    expect(afundados, 'o fiscal está olhando quase nada destes arquivos').toEqual([]);
  });
});
