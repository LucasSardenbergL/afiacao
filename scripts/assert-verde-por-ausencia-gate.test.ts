import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { enumerar } from './shell-variavel-colada-gate';
import { PISOS, RAIZES_PADRAO, analisar, detectar, veredito, type Analise } from './assert-verde-por-ausencia-gate';

/**
 * Dente do fiscal do assert de prova que passa com o valor AUSENTE (docs/historico/assert-verde-por-
 * ausencia.md). Roda no CI por `bun run test` — puramente textual, não executa SQL. As mutações que
 * provam que cada bloco abaixo tem dente vivem em `scripts/mutcheck.d/assert-verde-por-ausencia.mut`.
 *
 * ⚠️ Fonte de teste vai em aspas SIMPLES ou DUPLAS do TS, nunca em template literal: lá `${…}` é
 * interpolação do próprio TS, e a linha testada seria outra.
 */

// `import.meta.dir` é do Bun e não existe no vitest — `import.meta.url` existe nos dois.
const RAIZ = resolve(fileURLToPath(import.meta.url), '../..');

/** Um bloco DO num heredoc citado, como as provas escrevem: o corpo começa na LINHA 4. */
const doBloco = (corpo: string) => "P -v ON_ERROR_STOP=1 -q <<'SQL'\nDO $$\nBEGIN\n" + corpo + '\nEND $$;\nSQL\n';
const linhas = (fonte: string) => detectar('db/test-x.sh', fonte).sitios.map((s) => s.linha);

/** O caso de origem, byte a byte como estava na main (744ead16a) antes do conserto. */
const C1_2 = "  IF q900 <> 12.5 THEN RAISE EXCEPTION 'C1.2 FALHOU: AX@900 = % (esperado 12.5)', q900; END IF;";
const ARQUIVO_DO_C1_2 = 'db/test-tint-promote.sh';

describe('controle POSITIVO — se o detector parar de casar, isto fica vermelho', () => {
  it('o caso que abriu a classe: o C1.2 do tint-promote', () => {
    expect(detectar(ARQUIVO_DO_C1_2, doBloco(C1_2)).sitios).toEqual([
      { arquivo: ARQUIVO_DO_C1_2, linha: 4, trecho: "IF q900 <> 12.5", operadores: 1 },
    ]);
  });

  it.each([
    ['`!=`', "  IF v != 1 THEN RAISE EXCEPTION 'x'; END IF;"],
    ['ELSIF', "  IF a IS NULL THEN RAISE EXCEPTION 'a'; ELSIF a <> 2 THEN RAISE EXCEPTION 'b'; END IF;"],
    ['chave JSON', "  IF r->>'faixa' <> 'verde' THEN RAISE EXCEPTION 'A1'; END IF;"],
    ['chave JSON com cast', "  IF (r->>'cmc')::numeric <> 100 THEN RAISE EXCEPTION 'A'; END IF;"],
    ['função em volta do valor', "  IF round(q3600_vm, 6) <> 12.8 THEN RAISE EXCEPTION 'C1.4'; END IF;"],
    ['subconsulta escalar (o `<>` de FORA)', "  IF (SELECT valor FROM t WHERE id = 1) <> 3845 THEN RAISE EXCEPTION 'p1'; END IF;"],
    ['parêntese booleano', "  IF (a IS DISTINCT FROM 1) OR NOT (b <> 2) THEN RAISE EXCEPTION 'x'; END IF;"],
    ['condição em várias linhas', "  IF a IS DISTINCT FROM 1\n     OR b <> 2 THEN\n    RAISE EXCEPTION 'x';\n  END IF;"],
    ['PL/pgSQL minúsculo', "  if r.origin <> 'sales' then raise exception 'x'; end if;"],
    ['acumulador `+`', "  IF n <> 0 THEN falhas := falhas + 1; END IF;"],
    ['acumulador `||`', "  IF n <> 0 THEN falhas := falhas || format('C8 %s', n); END IF;"],
    ['acumulador `array_append`', "  IF (SELECT x FROM v WHERE k = 'K1') <> '300'\n    THEN f := array_append(f, 'V1'); END IF;"],
    ['registro de falha por INSERT', "  IF v <> 1 THEN INSERT INTO falhas VALUES ('x'); END IF;"],
    ['a guarda escrita à mão (`X IS NULL OR X <> y`): idioma único', "  IF p IS NULL OR p <> 196.11 THEN RAISE EXCEPTION 'C2.1'; END IF;"],
  ])('%s', (_rotulo, corpo) => {
    expect(linhas(doBloco(corpo))).toEqual([4]);
  });

  it('cadeia OR: um site, com os DOIS operadores contados', () => {
    const [s] = detectar('db/test-x.sh', doBloco("  IF a <> 1 OR b <> 2 THEN RAISE EXCEPTION 'x'; END IF;")).sitios;
    expect(s.operadores).toBe(2);
  });

  it.each([
    ['dólar escapado de heredoc NÃO citado', "P <<SQL\nDO \\$\\$\nBEGIN\n  IF v <> 1 THEN RAISE EXCEPTION 'x'; END IF;\nEND \\$\\$;\nSQL\n", 4],
    ['tag com dígito', "P <<'SQL'\nDO $c1$\nBEGIN\n  IF v <> 1 THEN RAISE EXCEPTION 'x'; END IF;\nEND $c1$;\nSQL\n", 4],
    ['DO LANGUAGE plpgsql', "P <<'SQL'\nDO LANGUAGE plpgsql $$\nBEGIN\n  IF v <> 1 THEN RAISE EXCEPTION 'x'; END IF;\nEND $$;\nSQL\n", 4],
    ['helper `pg_temp.*` da própria prova', "P <<'SQL'\nCREATE FUNCTION pg_temp.confere(v int) RETURNS void LANGUAGE plpgsql AS $$\nBEGIN\n  IF v <> 1 THEN RAISE EXCEPTION 'x'; END IF;\nEND $$;\nSQL\n", 4],
    ['DO numa linha de `psql -c`', 'P -c "DO \\$\\$ BEGIN IF v <> 1 THEN RAISE EXCEPTION \'x\'; END IF; END \\$\\$;"\n', 1],
  ])('bloco: %s', (_rotulo, fonte, linha) => {
    expect(linhas(fonte)).toEqual([linha]);
  });
});

describe('o que NÃO é a classe', () => {
  it.each([
    ['já convertido', "  IF q900 IS DISTINCT FROM 12.5 THEN RAISE EXCEPTION 'C1.2'; END IF;"],
    ['`<>` DENTRO de subconsulta é filtro, não comparação do assert', "  IF (SELECT count(*) FROM t WHERE a <> b) IS DISTINCT FROM 0 THEN RAISE EXCEPTION 'x'; END IF;"],
    ['`<>` dentro de EXISTS', "  IF EXISTS (SELECT 1 FROM t WHERE a <> b) THEN RAISE EXCEPTION 'x'; END IF;"],
    ['`<>` em string SQL (inclusive com aspa escapada)', "  IF v IS DISTINCT FROM 'a''<>' THEN RAISE EXCEPTION 'a <> b'; END IF;"],
    ['`<>` em comentário SQL', "  IF v IS DISTINCT FROM 1 -- antes: v <> 1\n  THEN RAISE EXCEPTION 'x'; END IF;"],
    ['argumento de função (`coalesce(a <> b, true)` já guarda o NULL)', "  IF coalesce(a <> b, true) THEN RAISE EXCEPTION 'x'; END IF;"],
    ['o THEN não é assert: RETURN (trigger)', "  IF TG_OP <> 'INSERT' THEN RETURN NEW; END IF;"],
    ['o THEN não é assert: re-raise em handler', "  IF SQLSTATE <> 'P0001' THEN RAISE; END IF;"],
    ['o THEN não é assert: NOTICE da perna de falsificação', "  IF v <> 1 THEN RAISE NOTICE 'SABOTAGEM_PASSOU'; END IF;"],
    ['o THEN não é assert: aplicar a sabotagem', "  IF v_ok <> v_def THEN EXECUTE v_ok; END IF;"],
  ])('%s', (_rotulo, corpo) => {
    expect(linhas(doBloco(corpo))).toEqual([]);
  });

  it('corpo de CREATE FUNCTION pública é fixture/código sob teste — trocar ali mudaria o produto simulado', () => {
    const fonte =
      "P <<'SQL'\nCREATE OR REPLACE FUNCTION public.criar_plano(p text) RETURNS void LANGUAGE plpgsql AS $$\nBEGIN\n" +
      "  IF p <> 'x' THEN RAISE EXCEPTION 'race'; END IF;\nEND $$;\nSQL\n";
    expect(linhas(fonte)).toEqual([]);
  });

  it('mas o DO depois da função volta a ser assert (o bloco é o ÚLTIMO aberto antes do IF)', () => {
    const fonte =
      "P <<'SQL'\nCREATE FUNCTION public.f(p text) RETURNS void LANGUAGE plpgsql AS $$ BEGIN IF p <> 'x' THEN RAISE EXCEPTION 'r'; END IF; END $$;\n" +
      "DO $$\nBEGIN\n  IF v <> 1 THEN RAISE EXCEPTION 'x'; END IF;\nEND $$;\nSQL\n";
    expect(linhas(fonte)).toEqual([5]);
  });

  it('bash `if … != …; then` e `END IF` não são o IF do PL/pgSQL', () => {
    expect(linhas('if [ "$a" != "$b" ]; then echo x; fi\n' + doBloco("  PERFORM 1;\n  END IF;"))).toEqual([]);
  });

  it('DDL `IF EXISTS` / `IF NOT EXISTS` não é condição', () => {
    expect(linhas(doBloco('  DROP TABLE IF EXISTS t;\n  CREATE TABLE IF NOT EXISTS u (a int);\n  PERFORM 1;'))).toEqual([]);
  });
});

describe('comentário de SHELL é a ÚNICA isenção — e quem decide é o stripper COMPARTILHADO', () => {
  it('linha de comentário e comentário de fim de linha não contam', () => {
    expect(linhas("# IF v <> 1 THEN RAISE EXCEPTION 'x';\n" + doBloco('  PERFORM 1;') + "echo ok  # IF v <> 1 THEN RAISE EXCEPTION 'x'\n")).toEqual([]);
  });

  it('`#` DENTRO de heredoc é dado: o `#>>` do jsonb segue visível (regex local o apagaria)', () => {
    expect(linhas(doBloco("  IF r#>>'{a,b}' <> 'x' THEN RAISE EXCEPTION 'x'; END IF;"))).toEqual([4]);
  });

  it('a linha reportada é a da FONTE (a limpeza preserva o número de linhas)', () => {
    expect(linhas('# um\n# dois\n' + doBloco(C1_2))).toEqual([6]);
  });

  it('o denominador conta asserts de bloco DO com OU sem `<>` — é o sensor de cegueira', () => {
    const d = detectar('db/test-x.sh', doBloco(C1_2 + "\n  IF n IS DISTINCT FROM 2 THEN RAISE EXCEPTION 'C1.1'; END IF;"));
    expect(d.asserts).toBe(2);
    expect(d.sitios).toHaveLength(1);
  });
});

describe('o universo — todo shell de db/, e só ele', () => {
  let tmp: string;
  const escreve = (rel: string, fonte: string) => {
    mkdirSync(dirname(join(tmp, rel)), { recursive: true });
    writeFileSync(join(tmp, rel), fonte);
  };

  beforeAll(() => {
    tmp = mkdtempSync(join(tmpdir(), 'assert-verde-por-ausencia-'));
    escreve('db/test-a.sh', doBloco(C1_2));
    escreve('db/lib/harness.sh', doBloco("  IF v_n <> 1 THEN RAISE EXCEPTION 'SABOTAGEM SEM ANCORA UNICA'; END IF;"));
    escreve('scripts/fora.sh', doBloco(C1_2));
  });
  afterAll(() => rmSync(tmp, { recursive: true, force: true }));

  it('lê as provas E o harness que elas carregam (`db/lib/`) — e nada fora de db/', () => {
    const lidos = enumerar(RAIZES_PADRAO, tmp).map((c) => relative(tmp, c)).sort();
    expect(lidos).toEqual(['db/lib/harness.sh', 'db/test-a.sh']);
  });

  it('o assert do harness em db/lib/ é da mesma classe: violação', () => {
    const arquivos = enumerar(RAIZES_PADRAO, tmp).map((c) => ({ caminho: relative(tmp, c), fonte: readFileSync(c, 'utf8') }));
    expect(analisar(arquivos).violacoes.map((v) => v.arquivo).sort()).toEqual(['db/lib/harness.sh', 'db/test-a.sh']);
  });
});

describe('os alarmes do stripper — herdados do irmão, e vistos disparar AQUI', () => {
  it('heredoc sem delimitador vira INDETERMINADO, não "limpo" — mesmo escondendo uma violação', () => {
    const r = analisar([{ caminho: 'db/test-x.sh', fonte: "P <<'SQL'\nDO $$ BEGIN\n" + C1_2 + '\nEND $$;\n' }]);
    expect(r.alarmes.length).toBeGreaterThan(0);
    expect(veredito(r, false).codigo).toBe(2);
  });
});

describe('veredito — 2 nunca é "passou"', () => {
  const limpo: Analise = { caminhos: ['db/test-a.sh'], linhasDeCodigo: 10, asserts: 3, violacoes: [], alarmes: [] };
  const provas = Array.from({ length: PISOS.provas }, (_, i) => `db/test-p${i}.sh`);
  const cheio: Analise = {
    ...limpo, caminhos: [...provas, 'db/lib/pg-harness.sh'], linhasDeCodigo: PISOS.linhasDeCodigo, asserts: PISOS.asserts,
  };

  it('limpo, sem pisos → 0', () => {
    expect(veredito(limpo, false).codigo).toBe(0);
  });

  it('com violação → 1, e a saída aponta arquivo:linha E o conserto (IS DISTINCT FROM)', () => {
    const v = veredito({ ...limpo, violacoes: [{ arquivo: 'db/test-a.sh', linha: 4, trecho: 'IF q900 <> 12.5', operadores: 1 }] }, false);
    expect(v.codigo).toBe(1);
    const texto = v.linhas.join('\n');
    expect(texto).toContain('db/test-a.sh:4');
    expect(texto).toContain('IS DISTINCT FROM');
  });

  it('nenhum arquivo lido → 2 (ausente ≠ zero violações)', () => {
    expect(veredito({ ...limpo, caminhos: [] }, false).codigo).toBe(2);
  });

  it('alarme do stripper → 2, mesmo COM violação (não dá para confiar em nenhuma das duas)', () => {
    const v = veredito({ ...limpo, alarmes: ['db/test-a.sh: x'], violacoes: [{ arquivo: 'db/test-a.sh', linha: 4, trecho: 'IF', operadores: 1 }] }, false);
    expect(v.codigo).toBe(2);
  });

  it('com pisos: exatamente nos pisos passa (controle dos casos de baixo)', () => {
    expect(veredito(cheio, true).codigo).toBe(0);
  });

  it('com pisos: uma prova a menos → 2 — e shell que não é prova não conta para ele', () => {
    expect(veredito({ ...cheio, caminhos: cheio.caminhos.slice(1) }, true).codigo).toBe(2);
  });

  it('com pisos: linhas de código abaixo do piso → 2', () => {
    expect(veredito({ ...cheio, linhasDeCodigo: PISOS.linhasDeCodigo - 1 }, true).codigo).toBe(2);
  });

  it('com pisos: asserts reconhecidos abaixo do piso → 2 (o detector ficou cego — zero violações não vale)', () => {
    const v = veredito({ ...cheio, asserts: PISOS.asserts - 1 }, true);
    expect(v.codigo).toBe(2);
    expect(v.linhas.join('\n')).toContain('cego');
  });
});

describe('o corpo REAL do repo', () => {
  let arquivos: { caminho: string; fonte: string }[];

  beforeAll(() => {
    arquivos = enumerar(RAIZES_PADRAO, RAIZ).map((c) => ({ caminho: relative(RAIZ, c), fonte: readFileSync(c, 'utf8') }));
  });

  it('nenhum assert de prova compara com `<>`/`!=`', () => {
    expect(analisar(arquivos).violacoes).toEqual([]);
  });

  it('o fiscal MEDIU e o stripper não desabou: com pisos, o veredito é 0 — não 2', () => {
    const r = analisar(arquivos);
    expect(r.alarmes).toEqual([]);
    expect(r.asserts).toBeGreaterThanOrEqual(PISOS.asserts);
    expect(veredito(r, true).codigo).toBe(0);
  });

  it('falsificação: devolver o `<>` ao C1.2 do arquivo real acusa exatamente ele (e o corpo intocado, não)', () => {
    const real = arquivos.find((a) => a.caminho === ARQUIVO_DO_C1_2);
    expect(real).toBeDefined();
    const fonte = (real as { fonte: string }).fonte;
    const convertido = "IF q900 IS DISTINCT FROM 12.5 THEN";
    expect(fonte.split(convertido)).toHaveLength(2); // a âncora existe e é única
    const sabotado = fonte.replace(convertido, 'IF q900 <> 12.5 THEN');
    const linha = fonte.slice(0, fonte.indexOf(convertido)).split('\n').length;
    const rs = analisar(arquivos.map((a) => (a.caminho === ARQUIVO_DO_C1_2 ? { ...a, fonte: sabotado } : a)));
    expect(rs.violacoes.map((v) => `${v.arquivo}:${v.linha}`)).toEqual([`${ARQUIVO_DO_C1_2}:${linha}`]);
  });

  /**
   * O universo medido POR FORA do walker: o `git ls-files` não consulta nem o walker nem as raízes.
   * Shell novo em db/ fica vermelho aqui em vez de invisível para o fiscal.
   */
  it('todo .sh/.bash RASTREADO sob db/ está no universo do fiscal', () => {
    const git = spawnSync('git', ['ls-files', '-z', '--', 'db/*.sh', 'db/**/*.sh', 'db/*.bash', 'db/**/*.bash'], {
      cwd: RAIZ, encoding: 'utf8',
    });
    expect(git.status).toBe(0);
    const rastreados = [...new Set(git.stdout.split('\0').filter(Boolean))];
    expect(rastreados.length).toBeGreaterThanOrEqual(PISOS.provas);
    const lidos = new Set(arquivos.map((a) => a.caminho));
    expect(rastreados.filter((r) => !lidos.has(r))).toEqual([]);
  });
});
