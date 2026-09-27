import { describe, it, expect } from 'vitest';
import {
  ALLOWLIST_CITACAO,
  CENSO_FIM,
  CENSO_INICIO,
  coberturaDeHooks,
  conferirCitacoes,
  extrairCitacoes,
  bloqueantesSemScript,
  hooksLigados,
  inventarioCI,
  inventarioHooks,
  lerCenso,
  padraoInvocacao,
  type HookLigado,
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
    'bloqueia.sh': 'jq -n \'{hookSpecificOutput:{hookEventName:"PreToolUse",permissionDecision:"deny"}}\'\n',
    'so-avisa.sh': '# permissionDecision:"deny" quebraria investigação — por isso NÃO uso\necho aviso\n',
  };

  it('classifica pelo código, não pelo comentário', () => {
    const hooks = inventarioHooks(settings, (a) => fontes[a] ?? null);
    expect(hooks.find((h) => h.arquivo === 'bloqueia.sh')?.bloqueia).toBe(true);
    expect(hooks.find((h) => h.arquivo === 'so-avisa.sh')?.bloqueia).toBe(false);
    expect(hooks.some((h) => h.denySemEnvelope)).toBe(false);
  });

  it('hook ilegível não vira gate (fail-safe: não inventa bloqueio)', () => {
    const hooks = inventarioHooks(settings, () => null);
    expect(hooks.every((h) => !h.bloqueia && !h.denySemEnvelope)).toBe(true);
  });
});

describe('inventarioHooks — o deny só conta DENTRO do envelope que o harness honra', () => {
  const um = JSON.stringify({
    hooks: { PreToolUse: [{ hooks: [{ command: '"$CLAUDE_PROJECT_DIR/.claude/hooks/alvo.sh"' }] }] },
  });
  const classificar = (fonte: string) => inventarioHooks(um, () => fonte)[0];

  // Medido em 2026-09-27 (Claude Code 2.1.281, sonda PreToolUse sobre `Skill`, log provando que o
  // hook RODOU nas três chamadas): só o envelope completo negou; as outras duas deixaram a skill
  // carregar. As duas primeiras abaixo são essas formas, e é por elas que o censo mentiu 136 dias.
  it('deny no TOPO do JSON (o check-gstack.sh) não bloqueia — e é acusado', () => {
    const h = classificar(`echo '{"permissionDecision":"deny","message":"gstack ausente"}'\n`);
    expect(h.bloqueia).toBe(false);
    expect(h.denySemEnvelope).toBe(true);
  });

  it('hookSpecificOutput SEM hookEventName também não bloqueia — e é acusado', () => {
    const h = classificar(`jq -n '{hookSpecificOutput:{permissionDecision:"deny",permissionDecisionReason:$r}}'\n`);
    expect(h.bloqueia).toBe(false);
    expect(h.denySemEnvelope).toBe(true);
  });

  it('envelope completo bloqueia, nas duas grafias do repo (jq e printf) e em qualquer ordem', () => {
    const jq = `jq -n --arg r "$m" '{hookSpecificOutput:{hookEventName:"PreToolUse",permissionDecision:"deny",permissionDecisionReason:$r}}'\n`;
    const printf = `printf '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"%s"}}\\n' "$m"\n`;
    const invertido = `jq -n '{hookSpecificOutput:{permissionDecision:"deny",hookEventName:"PreToolUse"}}'\n`;
    for (const fonte of [jq, printf, invertido]) {
      expect(classificar(fonte)).toMatchObject({ bloqueia: true, denySemEnvelope: false });
    }
  });

  it('hookEventName de OUTRO evento não arma o deny de PreToolUse', () => {
    const h = classificar(`jq -n '{hookSpecificOutput:{hookEventName:"PostToolUse",permissionDecision:"deny"}}'\n`);
    expect(h).toMatchObject({ bloqueia: false, denySemEnvelope: true });
  });

  it('um ramo certo NÃO absolve o ramo errado do mesmo hook', () => {
    const h = classificar(
      `jq -n '{hookSpecificOutput:{hookEventName:"PreToolUse",permissionDecision:"deny"}}'\n` +
        `echo '{"permissionDecision":"deny"}'\n`,
    );
    expect(h).toMatchObject({ bloqueia: true, denySemEnvelope: true });
  });
});

describe('hooksLigados — TODO hook do settings.json, com ou sem arquivo', () => {
  const settings = JSON.stringify({
    hooks: {
      PreToolUse: [
        {
          matcher: 'Bash',
          hooks: [
            { type: 'command', command: '"$CLAUDE_PROJECT_DIR/.claude/hooks/b.sh"' },
            { type: 'command', command: '"$CLAUDE_PROJECT_DIR/.claude/hooks/a.sh"' },
          ],
        },
      ],
      PostToolUse: [{ hooks: [{ type: 'command', command: '"$CLAUDE_PROJECT_DIR/.claude/hooks/a.sh"' }] }],
      Stop: [{ hooks: [{ type: 'command', command: 'echo tchau' }] }],
    },
  });

  it('um por arquivo, no PRIMEIRO evento em que aparece', () => {
    const comArquivo = hooksLigados(settings).filter((h) => h.arquivo !== null);
    expect(comArquivo.map((h) => [h.arquivo, h.evento])).toEqual([
      ['a.sh', 'PreToolUse'],
      ['b.sh', 'PreToolUse'],
    ]);
  });

  // O `inventarioHooks` PULA o comando que não aponta arquivo (`if (!m) continue`): para o censo de
  // deny é o certo, para a cobertura é o buraco — um hook inline some do inventário e fica verde
  // por não existir. Aqui ele vem com `arquivo: null`, e quem decide o que fazer é o chamador.
  it('comando SEM arquivo não some: vem com arquivo null', () => {
    expect(hooksLigados(settings).find((h) => h.arquivo === null)).toMatchObject({
      evento: 'Stop',
      comando: 'echo tchau',
    });
  });

  it('settings.json sem hooks devolve vazio, não explode', () => {
    expect(hooksLigados('{}')).toEqual([]);
  });
});

describe('coberturaDeHooks — hook ligado precisa de suíte do test:hooks que o EXECUTE', () => {
  const hook = (arquivo: string): HookLigado => ({
    evento: 'PreToolUse',
    comando: `"$CLAUDE_PROJECT_DIR/.claude/hooks/${arquivo}"`,
    arquivo,
  });
  const suite = (fonte: string | null) => ({ arquivo: 'scripts/test-x.sh', fonte });

  it('coberto: a suíte cita o hook como CAMINHO numa linha de código', () => {
    expect(coberturaDeHooks([hook('x.sh')], [suite('HOOK="$here/../.claude/hooks/x.sh"\nbash "$HOOK"\n')])).toEqual([]);
  });

  it('o caminho pode vir de variável — `"$HOOKS/x.sh"` é a forma do test-hooks-sessionstart.sh', () => {
    expect(coberturaDeHooks([hook('x.sh')], [suite('out="$(bash "$HOOKS/x.sh")"\n')])).toEqual([]);
  });

  // Citar não é executar: é a lição da classe (docs/historico/gates-textuais-cegos.md). O comentário
  // no FIM da linha é o caso que um filtro local de `^#` deixaria passar — só o stripper sabe.
  it('citação só em COMENTÁRIO não cobre — nem no começo, nem no fim da linha', () => {
    const fontes = ['# roda .claude/hooks/x.sh\necho ok\n', 'echo ok  # roda .claude/hooks/x.sh\n'];
    for (const f of fontes) {
      expect(coberturaDeHooks([hook('x.sh')], [suite(f)]).map((s) => s.hook.arquivo)).toEqual(['x.sh']);
    }
  });

  // Medido em 2026-09-27: a PRIMEIRA linha não-comentada do test-hooks-sessionstart.sh que cita o
  // pos-compact-ptbr.sh é `echo "── pos-compact-ptbr.sh ──"` — rótulo. Ela sozinha não pode cobrir.
  it('citação como RÓTULO (nome sem `/` antes) não é caminho — não cobre', () => {
    expect(coberturaDeHooks([hook('x.sh')], [suite('echo "── x.sh ──"\n')]).length).toBe(1);
  });

  it('o `#` que NÃO abre comentário (`${d#./}`) não esconde a citação — regex local esconderia', () => {
    expect(coberturaDeHooks([hook('x.sh')], [suite('bash "${d#./}/.claude/hooks/x.sh"\n')])).toEqual([]);
  });

  it('prefixo ou sufixo de OUTRO nome não cobre (`/nao-x.sh`, `/x.sh.bak`)', () => {
    const r = coberturaDeHooks([hook('x.sh')], [suite('bash "$R/hooks/nao-x.sh"\ncp "$R/hooks/x.sh.bak" .\n')]);
    expect(r.length).toBe(1);
  });

  it('suíte que não pôde ser lida (fonte null) não cobre ninguém', () => {
    expect(coberturaDeHooks([hook('x.sh')], [suite(null)]).length).toBe(1);
  });

  it('hook sem arquivo é achado — não há nome que uma suíte possa citar', () => {
    const inline: HookLigado = { evento: 'Stop', comando: 'echo tchau', arquivo: null };
    const r = coberturaDeHooks([inline], [suite('echo tchau\n')]);
    expect(r.map((s) => s.hook.comando)).toEqual(['echo tchau']);
    expect(r[0].motivo).toMatch(/sem arquivo/);
  });

  it('cada hook responde por si: o coberto não absolve o vizinho', () => {
    const r = coberturaDeHooks([hook('x.sh'), hook('y.sh')], [suite('bash "$R/.claude/hooks/x.sh"\n')]);
    expect(r.map((s) => s.hook.arquivo)).toEqual(['y.sh']);
  });
});

/** Monta um bloco de censo com as LINHAS dadas, mais prosa fora dele que não pode ser lida. */
const comCenso = (...linhas: string[]) =>
  `antes\n${CENSO_INICIO}\n${linhas.join('\n')}\n${CENSO_FIM}\ndepois \`fora:do:bloco\``;

describe('lerCenso — bloco delimitado, não prosa', () => {
  it('extrai os nomes entre crases do bloco', () => {
    const censo = lerCenso(comCenso('**Gates** (2): `test` · `docs:indice`.'));
    expect(censo.achou).toBe(true);
    expect(censo.nomes).toEqual(['docs:indice', 'test']);
    expect(censo.ocorrencias).toBe(2);
    expect(censo.repetidos).toEqual([]);
    expect(censo.listas).toEqual([{ rotulo: 'Gates', declarado: 2, contados: 2 }]);
  });

  it('bloco ausente é "não consegui avaliar", não "está tudo certo"', () => {
    expect(lerCenso('doc sem bloco').achou).toBe(false);
  });

  // O caso REAL: o #2420 colou a lista inteira duas vezes e os dois sentidos do gate, que são
  // cruzamentos de conjunto, não viram nada. O `Set` de antes devolvia exatamente `['a','b']`.
  it('nome repetido é DADO, não some na deduplicação', () => {
    const censo = lerCenso(comCenso('**Gates** (4): `a` · `b` · `a` · `b`.'));
    expect(censo.nomes).toEqual(['a', 'b']);
    expect(censo.ocorrencias).toBe(4);
    expect(censo.repetidos).toEqual([
      { nome: 'a', vezes: 2 },
      { nome: 'b', vezes: 2 },
    ]);
  });

  it('repetição ENTRE listas conta igual — foi o defeito do #2344 (nome nas duas listas)', () => {
    const censo = lerCenso(
      comCenso('**Reprovam** (1): `mutcheck`.', '', '**Nao reprovam** (1): `mutcheck`.'),
    );
    expect(censo.repetidos).toEqual([{ nome: 'mutcheck', vezes: 2 }]);
    expect(censo.listas.map((l) => l.declarado)).toEqual([1, 1]);
  });

  it('o (N) do cabeçalho é lido CRU — é ele que mente quando a lista está em dobro', () => {
    const censo = lerCenso(comCenso('**Gates** (2): `a` · `b` · `a` · `b`.'));
    expect(censo.listas).toEqual([{ rotulo: 'Gates', declarado: 2, contados: 4 }]);
  });

  it('prosa depois do número não atrapalha o cabeçalho', () => {
    const censo = lerCenso(comCenso('**Nao reprovam** (2, informativos por desenho): `a` · `b`.'));
    expect(censo.listas).toEqual([
      { rotulo: 'Nao reprovam', declarado: 2, contados: 2 },
    ]);
  });

  it('lista SEM (N) é `declarado: null` — ausência de dado, nunca isenção', () => {
    const censo = lerCenso(comCenso('- e tambem o `gate:solto` aqui'));
    expect(censo.listas).toEqual([
      { rotulo: '- e tambem o `gate:solto` aqui', declarado: null, contados: 1 },
    ]);
  });

  it('linha sem nome nenhum não vira lista (linha em branco, prosa, comentário)', () => {
    const censo = lerCenso(comCenso('', 'so prosa, sem crase', '**Gates** (1): `a`.'));
    expect(censo.listas).toHaveLength(1);
    expect(censo.ocorrencias).toBe(1);
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
