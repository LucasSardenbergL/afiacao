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
  it('o sentinela DISPARA num arquivo envenenado (alarme não é decorativo)', () => {
    const maior = [...migrations].sort((a, b) => b.sql.length - a.sql.length)[0];
    const linhas = maior.sql.split('\n');
    const corte = Math.floor(linhas.length / 4);
    const envenenado = [...linhas.slice(0, corte), '/* bloco que nunca fecha', ...linhas.slice(corte)].join('\n');
    expect(maiorBlocoDescartadoSql(maior.sql)).toBeLessThanOrEqual(TETO_BLOCO);
    expect(maiorBlocoDescartadoSql(envenenado)).toBeGreaterThan(TETO_BLOCO);
  });
});
