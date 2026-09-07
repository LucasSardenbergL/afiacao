import { describe, it, expect } from 'vitest';
import {
  ALLOWLIST_CITACAO,
  CENSO_FIM,
  CENSO_INICIO,
  conferirCitacoes,
  extrairCitacoes,
  bloqueantesSemScript,
  inventarioCI,
  inventarioHooks,
  lerCenso,
  padraoInvocacao,
} from './gates-frescura-check';

/**
 * Eixo POR FORA #1 do `gates:frescura`: fixtures SINTÉTICAS, nenhuma leitura do `ci.yml` real.
 *
 * O gate mora dentro do `ci.yml` e lê o `ci.yml` — herda o defeito da máquina que vigia. Se a
 * única prova de que ele funciona fosse "rodou verde no CI", a prova valeria zero no dia em que o
 * step saísse do arquivo. Aqui as entradas são escritas à mão e os vereditos são conhecidos.
 */

describe('extrairCitacoes — o que o manual AFIRMA ser máquina', () => {
  it('pega `bun run x`, token com forma de script e apelido .gate', () => {
    const nomes = extrairCitacoes(
      ['roda `bun run docs:indice` sempre', 'o `sonda:bump` reprova', 'senão `manifesto.gate` falha'].join('\n'),
    ).map((c) => c.nome);
    expect(nomes).toEqual(['docs:indice', 'sonda:bump', 'manifesto.gate']);
  });

  it('reporta a LINHA da citação — é o que o achado precisa mostrar', () => {
    expect(extrairCitacoes('a\nb\nusa `docs:links` aqui')).toEqual([{ nome: 'docs:links', linha: 3 }]);
  });

  it('ignora o que está dentro de cerca de código, e SÓ isso', () => {
    // Dentro da cerca o comando ILUSTRA uso local (`bun dev`); fora, entre crases, ele AFIRMA.
    const md = ['```bash', 'bun run typecheck:app', '```', 'mas o `docs:citacoes` é gate'].join('\n');
    expect(extrairCitacoes(md).map((c) => c.nome)).toEqual(['docs:citacoes']);
  });

  it('NÃO zera a medição por passar tudo pelo stripper agressivo (verde por cegueira)', () => {
    // A regressão que este caso trava: usar `removerCodigo` no lugar de `removerCercas` apagaria
    // a crase inline, que é justamente onde a citação canônica nasce — 16 citações viram 0, exit 0.
    expect(extrairCitacoes('o `claude:size` vigia o teto').length).toBe(1);
  });
});

describe('inventarioCI — o que REPROVA, e o que é aviso de propósito', () => {
  const yml = [
    'jobs:',
    '  validate:',
    '    steps:',
    '      - name: Tests',
    '        run: bun run test',
    '      - name: Fan-out (informativo, nunca reprova)',
    '        run: bun run sonda:fanout',
    '        continue-on-error: true',
    '      - name: Dead code',
    '        run: bunx knip',
  ].join('\n');

  it('conta o step bloqueante', () => {
    expect(inventarioCI(yml).map((g) => g.nome)).toContain('test');
  });

  it('NÃO conta step com continue-on-error — gate que acusa ruído é gate que se desliga', () => {
    expect(inventarioCI(yml).map((g) => g.nome)).not.toContain('sonda:fanout');
  });

  it('reconhece `bunx <bin>` além de `bun run <script>`', () => {
    expect(inventarioCI(yml).map((g) => g.nome)).toContain('knip');
  });

  it('devolve a linha do step, que é o `ci.yml:<linha>` do achado', () => {
    expect(inventarioCI(yml).find((g) => g.nome === 'test')?.linha).toBe(4);
  });
});

describe('bloqueantesSemScript — o que o inventário NÃO consegue nomear', () => {
  const yml = [
    'jobs:',
    '  validate:',
    '    steps:',
    '      - name: Roda script',
    '        run: bun run test',
    '      - name: Baixa binario pinado',
    '        run: curl -fsSL http://x/y | tar -xJ',
    '      - name: Aviso',
    '        run: python3 checa.py',
    '        continue-on-error: true',
  ].join('\n');

  // Não é filtro calado: é contador. Exclusão silenciosa é o mesmo veneno do censo datado — um
  // gate futuro em python ou shell puro cai aqui, e o número no log é o que faz alguém perceber.
  it('lista o step bloqueante que não invoca script', () => {
    expect(bloqueantesSemScript(yml)).toEqual(['validate: Baixa binario pinado']);
  });

  it('não lista o que já tem nome de comando, nem o que é aviso', () => {
    const r = bloqueantesSemScript(yml);
    expect(r.some((x) => x.includes('Roda script'))).toBe(false);
    expect(r.some((x) => x.includes('Aviso'))).toBe(false);
  });
});

describe('inventarioHooks — deny de verdade x "deny" em comentário', () => {
  const settings = JSON.stringify({
    hooks: {
      PreToolUse: [
        { hooks: [{ command: '"$CLAUDE_PROJECT_DIR/.claude/hooks/bloqueia.sh"' }] },
        { hooks: [{ command: '"$CLAUDE_PROJECT_DIR/.claude/hooks/so-avisa.sh"' }] },
      ],
    },
  });

  // O caso REAL que este teste congela: `read-contexto-nudge.sh` cita "deny" três vezes, todas em
  // comentário explicando por que ele decidiu NÃO negar. Uma varredura crua o promove a bloqueio.
  const fontes: Record<string, string> = {
    'bloqueia.sh': 'jq -n \'{hookSpecificOutput:{permissionDecision:"deny"}}\'\n',
    'so-avisa.sh': '# permissionDecision:"deny" quebraria investigação — por isso NÃO uso\necho aviso\n',
  };

  it('classifica pelo código, não pelo comentário', () => {
    const hooks = inventarioHooks(settings, (a) => fontes[a] ?? null);
    expect(hooks.find((h) => h.arquivo === 'bloqueia.sh')?.bloqueia).toBe(true);
    expect(hooks.find((h) => h.arquivo === 'so-avisa.sh')?.bloqueia).toBe(false);
  });

  it('hook ilegível não vira gate (fail-safe: não inventa bloqueio)', () => {
    expect(inventarioHooks(settings, () => null).every((h) => !h.bloqueia)).toBe(true);
  });
});

describe('lerCenso — bloco delimitado, não prosa', () => {
  it('extrai os nomes entre crases do bloco', () => {
    const md = `antes\n${CENSO_INICIO}\n\`test\` · \`docs:indice\`\n${CENSO_FIM}\ndepois \`fora:do:bloco\``;
    expect(lerCenso(md)).toEqual({ nomes: ['docs:indice', 'test'], achou: true });
  });

  it('bloco ausente é "não consegui avaliar", não "está tudo certo"', () => {
    expect(lerCenso('doc sem bloco').achou).toBe(false);
  });
});

describe('padraoInvocacao — invocação, não menção', () => {
  it('`test` só conta quando alguém RODA (a palavra aparece no repo inteiro)', () => {
    expect(padraoInvocacao('test').test('esse test é importante')).toBe(false);
    expect(padraoInvocacao('test').test('run: bun run test')).toBe(true);
  });

  it('token com `:` ou `.` vale nu — ninguém digita `docs:indice` por acaso', () => {
    expect(padraoInvocacao('docs:indice').test('ver docs:indice')).toBe(true);
  });

  it('não casa prefixo de outro nome', () => {
    expect(padraoInvocacao('sonda:bump').test('bun run sonda:bumpX')).toBe(false);
  });
});

describe('conferirCitacoes — os dois motivos de órfão', () => {
  const scripts = { 'docs:indice': 'bun scripts/docs-indice-gate-check.ts', solto: 'echo oi' };

  it('nome que não existe em lugar nenhum', () => {
    const r = conferirCitacoes([{ nome: 'nao:existe', linha: 9 }], scripts, [], '');
    expect(r).toHaveLength(1);
    expect(r[0].existe).toBe(false);
    expect(r[0].citacao.linha).toBe(9);
  });

  it('existe mas ninguém invoca — o buraco silencioso', () => {
    const r = conferirCitacoes([{ nome: 'solto', linha: 2 }], scripts, [], '');
    expect(r).toHaveLength(1);
    expect(r[0].existe).toBe(true);
    expect(r[0].invocado).toBe(false);
  });

  it('invocado por workflow/hook/skill passa', () => {
    expect(conferirCitacoes([{ nome: 'docs:indice', linha: 1 }], scripts, [], 'bun run docs:indice')).toHaveLength(0);
  });

  it('`*.test.ts` com o nome conta como invocado — vitest descobre por glob', () => {
    const cit = [{ nome: 'manifesto.gate', linha: 1 }];
    expect(conferirCitacoes(cit, {}, ['src/lib/modulos/__tests__/manifesto.gate.test.ts'], '')).toHaveLength(0);
  });

  it('a allowlist isenta — e é curta o bastante para caber no diff', () => {
    const nome = Object.keys(ALLOWLIST_CITACAO)[0];
    expect(conferirCitacoes([{ nome, linha: 1 }], {}, [], '')).toHaveLength(0);
    expect(Object.keys(ALLOWLIST_CITACAO).length).toBeLessThanOrEqual(5);
  });
});
