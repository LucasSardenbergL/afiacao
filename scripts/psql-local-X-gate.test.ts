import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { beforeAll, describe, expect, it } from 'vitest';

import {
  PISOS,
  RAIZES_PADRAO,
  analisar,
  analisarPassos,
  detectar,
  veredito,
  type Analise,
  type Sitio,
} from './psql-local-X-gate';
import { contarPulsos, descreverPulsos, drenarCedendo, type Pulsos } from '@/test/loop-livre';
import { enumerar } from './shell-variavel-colada-gate';

/**
 * Dente do fiscal de psql local sem `-X` (docs/historico/psql-sem-X-le-o-psqlrc.md). Roda no CI por
 * `bun run test` — puramente textual, não executa shell. As mutações que provam que cada bloco abaixo
 * tem dente vivem em `scripts/mutcheck.d/psql-local-X.mut`. O universo (walker) e os alarmes do
 * stripper são os do irmão `shell-variavel-colada-gate`, importados — e testados lá.
 *
 * ⚠️ Fonte de teste vai em aspas SIMPLES do TS, nunca em template literal: lá `${…}` é interpolação
 * do próprio TS, e o caso `"${PGBIN}/psql"` testaria outra string.
 */

// `import.meta.dir` é do Bun e não existe no vitest — `import.meta.url` existe nos dois.
const RAIZ = resolve(fileURLToPath(import.meta.url), '../..');
const situacoes = (fonte: string) => detectar('x.sh', fonte).map((s) => s.situacao);

/** O helper das 286 provas ANTES da erradicação (2026-09-30), byte a byte. */
const P_ANTES = 'P()  { "$PGBIN/psql" -p "$PORT" -h /tmp -U postgres -d prove -v ON_ERROR_STOP=1 "$@"; }';
const P_DEPOIS = 'P()  { "$PGBIN/psql" -X -p "$PORT" -h /tmp -U postgres -d prove -v ON_ERROR_STOP=1 "$@"; }';

describe('controle POSITIVO — se o detector parar de casar, isto fica vermelho', () => {
  it('o helper P() das provas, na forma de ANTES, é violação — e na de DEPOIS, não', () => {
    expect(detectar('db/test-x.sh', P_ANTES + '\n')).toEqual<Sitio[]>([
      { arquivo: 'db/test-x.sh', linha: 1, situacao: 'violacao', binario: '"$PGBIN/psql"', trecho: P_ANTES },
    ]);
    expect(situacoes(P_DEPOIS)).toEqual(['comX']);
  });

  it('-X FORA da posição canônica não conta (a forma de antes das 2 provas tint)', () => {
    expect(situacoes('PA() { "$PGBIN/psql" -p "$PORT" -h "$SOCK" -U postgres -X -v ON_ERROR_STOP=1 "$@"; }')).toEqual(['violacao']);
  });

  it('-x minúsculo é o OPOSTO (saída expandida) — e `-Xq`/`--no-psqlrc` não são a forma canônica', () => {
    expect(situacoes('"$PGBIN/psql" -x -c "SELECT 1"')).toEqual(['violacao']);
    expect(situacoes('"$PGBIN/psql" -Xq -c "SELECT 1"')).toEqual(['violacao']);
    expect(situacoes('"$PGBIN/psql" --no-psqlrc -c "SELECT 1"')).toEqual(['violacao']);
  });
});

describe('as formas do binário — todo token que termina em /psql', () => {
  it.each([
    ['aspas duplas', '"$PGBIN/psql"'],
    ['chaves', '"${PGBIN}/psql"'],
    ['nu', '$PGBIN/psql'],
    ['nu com chaves', '${PGBIN}/psql'],
    ['aspa antes da barra', '"$PGBIN"/psql'],
    ['aspas simples', "'/usr/lib/postgresql/17/bin/psql'"],
    ['caminho absoluto', '/opt/homebrew/opt/postgresql@17/bin/psql'],
  ])('%s: sem -X é violação, com -X passa', (_rotulo, bin) => {
    expect(situacoes(`${bin} -p 5432 -c 'SELECT 1'`)).toEqual(['violacao']);
    expect(situacoes(`${bin} -X -p 5432 -c 'SELECT 1'`)).toEqual(['comX']);
  });

  it('em posição de comando de qualquer tipo: $(…), pipe, array, xargs, exec, fim de linha', () => {
    expect(situacoes('out="$("$PGBIN/psql" -tA -c "SELECT 1")"')).toEqual(['violacao']);
    expect(situacoes('printf x | "$PGBIN/psql" -c "SELECT 1"')).toEqual(['violacao']);
    expect(situacoes('PSQL=("$PGBIN/psql" -h /tmp -q)')).toEqual(['violacao']);
    expect(situacoes('PSQL=("$PGBIN/psql" -X -h /tmp -q)')).toEqual(['comX']);
    expect(situacoes('seq 1 3 | xargs -P 3 -I{} "$PGBIN/psql" -c "SELECT {}"')).toEqual(['violacao']);
    expect(situacoes('exec "$PGBIN/psql" -p 1 "\\$@"')).toEqual(['violacao']);
    expect(situacoes('"$PGBIN/psql" \\\n  -X -c "SELECT 1"')).toEqual(['violacao']);
    expect(situacoes('PSQL="$PGBIN/psql"')).toEqual(['violacao']);
  });

  it('duas chamadas na mesma linha são julgadas cada uma', () => {
    expect(situacoes('"$PGBIN/psql" -X -c a && "$PGBIN/psql" -c b')).toEqual(['comX', 'violacao']);
  });
});

describe('o que NÃO é psql local', () => {
  it('o wrapper psql-ro — o psqlrc-ro dele é a trava de READ ONLY', () => {
    expect(situacoes('"$HOME/.config/afiacao/psql-ro" -c "SELECT 1"')).toEqual([]);
    expect(situacoes('~/.config/afiacao/psql-ro -v ON_ERROR_STOP=1 -f q.sql')).toEqual([]);
    expect(situacoes('"$PSQL_RO" -tA -c "SELECT 1"')).toEqual([]);
  });

  it('nomes derivados: psqlrc, psql_dono(), v_psql, $PSQL', () => {
    expect(situacoes('PSQLRC="$TMPD/psqlrc-fake"')).toEqual([]);
    expect(situacoes('psql_dono() { "$@"; }; v_psql=1; "$PSQL" -c x')).toEqual([]);
  });
});

describe('a isenção: PSQLRC= explícito no MESMO comando', () => {
  it('o fake que imita o wrapper de prod lê um psqlrc de propósito', () => {
    expect(situacoes('exec env PSQLRC="$TMPD/psqlrc-fake" "$PGBIN/psql" -p $PORT "\\$@"')).toEqual(['isentoPsqlrc']);
  });

  it('o fake escrito por echo também (é o que o test-db-aplicar faz)', () => {
    expect(situacoes('echo "exec env PSQLRC=/dev/null $PGBIN/psql -h localhost \\"\\$@\\""')).toEqual(['isentoPsqlrc']);
  });

  it('PSQLRC de OUTRO comando não isenta — nem nome parecido', () => {
    expect(situacoes('export PSQLRC=/x; "$PGBIN/psql" -c 1')).toEqual(['violacao']);
    expect(situacoes('PSQLRC=/x true && "$PGBIN/psql" -c 1')).toEqual(['violacao']);
    expect(situacoes('MEU_PSQLRC=/x "$PGBIN/psql" -c 1')).toEqual(['violacao']);
  });
});

describe('comentário é isenção — e quem decide é o stripper COMPARTILHADO', () => {
  it('linha de comentário e comentário de fim de linha não contam', () => {
    expect(situacoes(`# ${P_ANTES}\necho ok  # "$PGBIN/psql" -c 1\n`)).toEqual([]);
  });

  it('`#` DENTRO de aspas é dado: a chamada depois dele segue visível (regex local a apagaria)', () => {
    expect(situacoes('echo "passo #2" && "$PGBIN/psql" -c 1\n')).toEqual(['violacao']);
  });

  it('heredoc (citado ou não) conta: o fake escrito por cat roda depois', () => {
    expect(situacoes('cat > "$T/fake" <<EOF\nexec "$PGBIN/psql" -p 1 "\\$@"\nEOF\n')).toEqual(['violacao']);
    expect(situacoes("cat > \"$T/fake\" <<'EOF'\nexec \"$PGBIN/psql\" -p 1 \"$@\"\nEOF\n")).toEqual(['violacao']);
  });

  it('a linha reportada é a da FONTE (a limpeza preserva o número de linhas)', () => {
    expect(detectar('x.sh', `# 1\n# 2\n\n${P_ANTES}\n`).map((s) => s.linha)).toEqual([4]);
  });
});

describe('veredito — 2 nunca é "passou"', () => {
  const um = (situacao: Sitio['situacao'], arquivo = 'db/a.sh'): Sitio => ({ arquivo, linha: 1, situacao, binario: 'b', trecho: 't' });
  const limpo: Analise = { caminhos: ['db/a.sh'], sitios: [um('comX')], alarmes: [] };
  const muitos = (raiz: string, n: number) => Array.from({ length: n }, (_, i) => `${raiz}/s${i}.sh`);
  const cheio: Analise = {
    ...limpo,
    caminhos: Object.entries(PISOS.arquivosPorRaiz).flatMap(([raiz, piso]) => muitos(raiz, piso)),
    sitios: Array.from({ length: PISOS.comXEmDb }, () => um('comX')),
  };

  it('limpo, sem pisos → 0 (isenção PSQLRC não é violação)', () => {
    expect(veredito({ ...limpo, sitios: [um('comX'), um('isentoPsqlrc')] }, false).codigo).toBe(0);
  });

  it('com violação → 1, e a saída aponta arquivo:linha, o conserto e o aviso do psql-ro', () => {
    const v = veredito({ ...limpo, sitios: detectar('db/a.sh', P_ANTES + '\n') }, false);
    expect(v.codigo).toBe(1);
    const texto = v.linhas.join('\n');
    expect(texto).toContain('db/a.sh:1');
    expect(texto).toContain('"$PGBIN/psql" -X');
    expect(texto).toContain('NUNCA ponha -X no psql-ro');
  });

  it('nenhum arquivo lido → 2 (ausente ≠ zero violações)', () => {
    expect(veredito({ ...limpo, caminhos: [] }, false).codigo).toBe(2);
  });

  it('alarme do stripper → 2, mesmo sem violação', () => {
    expect(veredito({ ...limpo, alarmes: ['x.sh: 1 heredoc(s) aberto(s)'] }, false).codigo).toBe(2);
  });

  it('ponta a ponta, com a máquina real: heredoc sem delimitador vira INDETERMINADO, não "limpo"', () => {
    const r = analisar([{ caminho: 'x.sh', fonte: `cat <<EOF\n${P_DEPOIS}\n` }]);
    expect(r.alarmes).toHaveLength(1);
    expect(veredito(r, false).codigo).toBe(2);
  });

  it('com pisos: exatamente nos pisos passa (controle dos casos de baixo)', () => {
    expect(veredito(cheio, true).codigo).toBe(0);
  });

  it('com pisos: forma certa em db/ abaixo do piso (o detector cegou) → 2', () => {
    const v = veredito({ ...cheio, sitios: cheio.sitios.slice(1) }, true);
    expect(v.codigo).toBe(2);
    expect(v.linhas.join('\n')).toContain('o detector cegou?');
  });

  it('com pisos: -X visto FORA de db/ não completa o piso de db/', () => {
    const v = veredito({ ...cheio, sitios: [...cheio.sitios.slice(1), um('comX', 'scripts/b.sh')] }, true);
    expect(v.codigo).toBe(2);
  });

  it('com pisos: perder UMA raiz fura o piso dela', () => {
    const v = veredito({ ...cheio, caminhos: cheio.caminhos.filter((c) => !c.startsWith('.claude/hooks/')) }, true);
    expect(v.codigo).toBe(2);
    expect(v.linhas.join('\n')).toContain('.claude/hooks/');
  });
});

describe('o corpo REAL do repo', () => {
  let r: Analise;
  // A varredura do repo CEDE o event loop entre os arquivos (`analisarPassos` + `drenarCedendo`):
  // de uma vez, ela era UM bloqueio síncrono no `beforeAll` (6,9s sob carga em 2026-10-05), e acima
  // de 60s o RPC do vitest estoura — `test` rc=1 sem teste falhando (src/test/loop-livre.ts).
  let pulsos: Pulsos<Analise>;
  beforeAll(async () => {
    pulsos = await contarPulsos(() => drenarCedendo(analisarPassos(enumerar(RAIZES_PADRAO, RAIZ).map((c) => ({ caminho: relative(RAIZ, c), fonte: readFileSync(c, 'utf8') })))));
    r = pulsos.resultado;
  }, 30_000);

  it('a varredura do repo cede o event loop do worker — o pulso bate entre os arquivos', () => {
    expect(pulsos.batidas, descreverPulsos(pulsos)).toBeGreaterThanOrEqual(2);
  });

  it('nenhuma chamada de psql local sem -X', () => {
    expect(r.sitios.filter((s) => s.situacao === 'violacao').map((s) => `${s.arquivo}:${s.linha} ${s.binario}`)).toEqual([]);
  });

  it('o fiscal MEDIU e o stripper não desabou: com pisos, o veredito é 0 — não 2', () => {
    expect(veredito(r, true)).toEqual({ codigo: 0, linhas: [expect.stringContaining('✅')] });
  });

  /**
   * A FALSIFICAÇÃO, permanente: um arquivo REAL do núcleo com o `-X` tirado de volta, em memória, tem
   * de virar violação na linha do helper — e só nela. Se o detector cegar para a forma que existia
   * nas 286 provas, isto fica vermelho mesmo com o corpo inteiro limpo.
   */
  it('reintroduzir a chamada sem -X num arquivo real do núcleo → violação na linha do P()', () => {
    const caminho = 'db/test-sales_orders_omie_hash_unique.sh';
    const fonte = readFileSync(resolve(RAIZ, caminho), 'utf8');
    const linhaDoP = fonte.split('\n').findIndex((l) => l.startsWith('P()  { "$PGBIN/psql" -X ')) + 1;
    expect(linhaDoP).toBeGreaterThan(0);
    const sabotada = fonte.replace('"$PGBIN/psql" -X ', '"$PGBIN/psql" ');
    expect(detectar(caminho, fonte).filter((s) => s.situacao === 'violacao')).toEqual([]);
    expect(detectar(caminho, sabotada).filter((s) => s.situacao === 'violacao').map((s) => s.linha)).toEqual([linhaDoP]);
  });

  /** O universo medido POR FORA do walker: o `git ls-files` não consulta nem o walker nem as raízes. */
  it('todo .sh/.bash RASTREADO do repo está no universo do fiscal', () => {
    const git = spawnSync('git', ['ls-files', '-z', '--', '*.sh', '*.bash'], { cwd: RAIZ, encoding: 'utf8' });
    expect(git.status).toBe(0); // git ausente ou quebrado não vira "nada fora do universo"
    const rastreados = git.stdout.split('\0').filter(Boolean);
    expect(rastreados.length).toBeGreaterThanOrEqual(400);
    const lidos = new Set(r.caminhos);
    expect(rastreados.filter((c) => !lidos.has(c))).toEqual([]);
  });
});
