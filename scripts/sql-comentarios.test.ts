import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { removerComentariosSql, maiorBlocoDescartadoSql } from './lib/sql-comentarios';
import { stripComments } from './lib/authz-contract';

// O stripper que este arquivo substituiu — mantido AQUI (e só aqui) como réu, para que os casos
// digam o que mudou em vez de só afirmar o que passou a valer.
const REGEX_ANTIGA = (sql: string) => sql.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/--[^\n]*/g, ' ');

const DIR_MIGRATIONS = join(process.cwd(), 'supabase', 'migrations');
const migrations = readdirSync(DIR_MIGRATIONS)
  .filter((f) => f.endsWith('.sql'))
  .sort()
  .map((f) => ({ f, sql: readFileSync(join(DIR_MIGRATIONS, f), 'utf8') }));

describe('removerComentariosSql — gramática do Postgres', () => {
  it('remove comentário de linha e de bloco', () => {
    expect(removerComentariosSql('SELECT 1; -- some\nSELECT 2;')).toBe('SELECT 1;        \nSELECT 2;');
    expect(removerComentariosSql('SELECT /* x */ 1;')).toBe('SELECT         1;');
  });

  it('comentário de bloco ANINHA (o Postgres permite; `[\\s\\S]*?` fecharia no `*/` interno)', () => {
    expect(removerComentariosSql('SELECT /* a /* b */ c */ 1;')).toBe('SELECT                   1;');
    // o réu deixa `c */ 1;` virar código órfão
    expect(REGEX_ANTIGA('SELECT /* a /* b */ c */ 1;')).toBe('SELECT   c */ 1;');
  });

  it('`--` DENTRO de literal é DADO, não comentário — este é o eixo vivo', () => {
    const sql = "SELECT 'a -- b';";
    expect(removerComentariosSql(sql)).toBe(sql);
    // o réu comia o fecho da string junto: sobra uma aspa aberta que reemparelha o resto do arquivo
    expect(REGEX_ANTIGA(sql)).toBe("SELECT 'a  ");
  });

  it("`''` escapa a aspa dentro do literal", () => {
    const sql = "SELECT 'a''-- b';";
    expect(removerComentariosSql(sql)).toBe(sql);
  });

  it("E'…' ainda aceita `\\'` como escape", () => {
    const sql = "SELECT E'a\\'-- b';";
    expect(removerComentariosSql(sql)).toBe(sql);
  });

  it('identificador entre aspas duplas é preservado', () => {
    expect(removerComentariosSql('SELECT "a--b" FROM t;')).toBe('SELECT "a--b" FROM t;');
  });

  it('`--` dentro do corpo $$…$$ CONTINUA sendo comentário (é PL/pgSQL, e é a razão do gate existir)', () => {
    expect(removerComentariosSql('AS $$ x -- y\n z $$;')).toBe('AS $$ x     \n z $$;');
    expect(removerComentariosSql('AS $fn$ -- z $fn$;')).toBe('AS $fn$      $fn$;');
  });

  it('literal DENTRO do corpo $$…$$ é preservado (a recursão herda a gramática)', () => {
    const sql = "AS $$ v := '-- dado'; $$;";
    expect(removerComentariosSql(sql)).toBe(sql);
  });

  it('`$1` é parâmetro, não abertura de dollar-quote', () => {
    expect(removerComentariosSql('SELECT $1 -- c\n;')).toBe('SELECT $1     \n;');
  });

  it('stripComments do authz-contract usa este walker (uma regra só, não duas cópias)', () => {
    const sql = "SELECT 'a -- b'; -- fora\n";
    expect(stripComments(sql)).toBe(removerComentariosSql(sql));
  });
});

describe('invariantes sobre as migrations REAIS', () => {
  it('o corpus não encolheu por acidente (denominador explícito)', () => {
    expect(migrations.length).toBeGreaterThanOrEqual(650);
  });

  // Comprimento preservado é o que mantém `extractFunctions` — que fatia corpo por ÍNDICE —
  // coerente com o texto que ele mediu. Quebrar isso desalinha corpo de função silenciosamente.
  it('preserva o comprimento de cada migration (comentário vira espaço, `\\n` fica)', () => {
    const quebras = migrations.filter((m) => removerComentariosSql(m.sql).length !== m.sql.length);
    expect(quebras.map((m) => m.f)).toEqual([]);
  });

  // Sentinela herdado de `maiorBlocoDescartado` (src/lib/gates/limpeza-fonte.ts). Calibração MEDIDA
  // em 2026-08-20 sobre estas migrations: o maior bloco LEGÍTIMO descartado é 175 linhas
  // (20260615130000_tint_vigia_cobertura_sentinela.sql); um `/*` que nunca fecha no quarto inicial
  // dos 3 maiores arquivos devolve 676–762. O teto de 300 fica 1,7× acima do legítimo e 2,3× abaixo
  // do estrago medido — a mesma razão de folga do sentinela irmão (150 sobre 88 legítimo).
  const TETO_BLOCO = 300;
  it(`nenhuma migration perde bloco contíguo > ${TETO_BLOCO} linhas`, () => {
    const acima = migrations
      .map((m) => ({ f: m.f, n: maiorBlocoDescartadoSql(m.sql) }))
      .filter((x) => x.n > TETO_BLOCO);
    expect(acima).toEqual([]);
  });

  // Alarme que nunca se viu disparar é decoração — este prova que ele dispara.
  //
  // ⚠️ NÃO volte a envenenar "a maior migration, no quarto inicial": essa premissa é acidente do
  // corpus, não invariante. Um `/*` só engole até o PRÓXIMO `*/` — e neste repo `*/` aparece
  // DENTRO de comentário `--` como EXPRESSÃO DE CRON (`*/30`, `*/15`, `*/5`), que toda migration
  // de Sentinela carrega. Em 2026-08-24 a 20260824091755 (sonda de identidade da carteira) passou
  // a ser a maior do corpus e o veneno morreu num `watchdog */30` 165 linhas adiante: o teste
  // reprovou sem nenhum defeito real, nem na migration nem no walker.
  //
  // Premissa robusta no lugar: envenenar o MAIOR VÃO CONTÍGUO SEM `*/` de todo o corpus. Medido
  // em 2026-08-24 sobre 485 migrations: 53 admitem vão > 300 e 18 admitem > 600; o escolhido dá
  // 1095 linhas, ~3,6× o teto — a mesma folga da calibração original (676–762 sobre 300), só que
  // deixando de depender de qual arquivo é o maior.
  it('o sentinela DISPARA num arquivo envenenado (alarme não é decorativo)', () => {
    // início e tamanho do maior trecho de linhas consecutivas que não contêm `*/`
    const maiorVaoSemFecho = (linhas: string[]) => {
      const fechos = linhas.flatMap((l, i) => (l.includes('*/') ? [i] : []));
      const marcos = [-1, ...fechos, linhas.length];
      let melhor = { n: 0, ini: 0 };
      for (let i = 0; i < marcos.length - 1; i++) {
        const n = marcos[i + 1] - marcos[i];
        if (n > melhor.n) melhor = { n, ini: marcos[i] + 1 };
      }
      return melhor;
    };
    const alvo = migrations
      .map((m) => {
        const linhas = m.sql.split('\n');
        return { m, linhas, vao: maiorVaoSemFecho(linhas) };
      })
      .sort((a, b) => b.vao.n - a.vao.n)[0];
    const envenenado = [
      ...alvo.linhas.slice(0, alvo.vao.ini),
      '/* bloco que nunca fecha',
      ...alvo.linhas.slice(alvo.vao.ini),
    ].join('\n');
    expect(maiorBlocoDescartadoSql(alvo.m.sql)).toBeLessThanOrEqual(TETO_BLOCO);
    expect(maiorBlocoDescartadoSql(envenenado)).toBeGreaterThan(TETO_BLOCO);
  });
});
