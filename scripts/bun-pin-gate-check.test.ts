import { describe, it, expect } from 'vitest';
import { auditBunPins, readWorkflows, type WorkflowFile } from './bun-pin-gate-check';

/**
 * Monta um workflow com um job por valor de `bun-version`. O valor entra CRU no YAML de propósito:
 * o gate lê o TEXTO, que é onde `1.3` (float) e `bun-v1.3.15` (bot mal configurado) se revelam.
 */
function wf(...vals: string[]): WorkflowFile {
  const jobs = vals
    .map(
      (v, i) => `  job${i}:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v5
      - uses: oven-sh/setup-bun@v2
        with:
          bun-version: ${v}
      - run: bun install --frozen-lockfile
`,
    )
    .join('');
  return { file: '.github/workflows/ci.yml', yaml: `name: t\non: [push]\njobs:\n${jobs}` };
}

describe('auditBunPins — invariante 1: formato estrito x.y.z', () => {
  it('passa com pin estrito nas DUAS ocorrências (o estado que o PR #1352 deixou)', () => {
    expect(auditBunPins([wf('1.3.14', '1.3.14')])).toHaveLength(0);
  });

  // Cada caso abaixo é um formato que a validateStrict() da action REJEITA → cai na
  // api.github.com → SPOF de rede de volta, com o CI verde. Todos têm que dar vermelho aqui.
  it.each([
    ['latest', 'o default histórico que causou o incidente de 2026-07-16'],
    ['^1.3.14', 'caret'],
    ['~1.3.14', 'tilde'],
    ['v1.3.14', 'prefixo v'],
    ['1.3.x', 'o exemplo da PRÓPRIA doc do input da action'],
    ['1.x', 'wildcard largo'],
    ['">=1.3.14"', 'range'],
    ['1.3.14-canary', 'pré-release'],
    ['bun-v1.3.15', 'saída de bot mal configurado: as releases do bun são tagueadas bun-v*'],
  ])('FALHA com bun-version: %s (%s)', (val) => {
    const f = auditBunPins([wf(val, val)]);
    expect(f.length).toBeGreaterThan(0);
    expect(f[0].level).toBe('error');
  });

  it('a mensagem do `latest` explica que o CI fica VERDE até a API degradar', () => {
    const f = auditBunPins([wf('latest')]);
    expect(f[0].msg).toContain('api.github.com');
    expect(f[0].msg).toContain('VERDE');
  });

  it('reporta a LINHA do erro (clicável no editor)', () => {
    const f = auditBunPins([wf('latest')]);
    expect(f[0].line).toBeGreaterThan(0);
  });
});

describe('auditBunPins — invariante 2: o YAML lê x.y como float', () => {
  it('FALHA com `1.3` e a mensagem cita o FLOAT', () => {
    const f = auditBunPins([wf('1.3')]);
    expect(f).toHaveLength(1);
    expect(f[0].msg).toContain('FLOAT');
  });

  it('FALHA com `1.30` — o float PERDE o zero e viraria 1.3 silenciosamente', () => {
    const f = auditBunPins([wf('1.30')]);
    expect(f).toHaveLength(1);
    expect(f[0].msg).toContain('FLOAT');
  });

  it('FALHA com `"1.3"` entre aspas — string, mas ainda não é x.y.z', () => {
    expect(auditBunPins([wf('"1.3"')])).toHaveLength(1);
  });
});

describe('auditBunPins — invariante 3: as ocorrências sobem JUNTAS', () => {
  it('FALHA quando os jobs divergem (o bug de bumpar só uma das duas)', () => {
    const f = auditBunPins([wf('1.3.14', '1.3.13')]);
    expect(f).toHaveLength(1);
    expect(f[0].msg).toContain('divergem');
    expect(f[0].msg).toContain('1.3.14');
    expect(f[0].msg).toContain('1.3.13');
  });

  it('divergência entre ARQUIVOS diferentes também pega', () => {
    const a: WorkflowFile = { ...wf('1.3.14'), file: '.github/workflows/ci.yml' };
    const b: WorkflowFile = { ...wf('1.3.13'), file: '.github/workflows/outro.yml' };
    expect(auditBunPins([a, b])).toHaveLength(1);
  });

  it('mesma versão em vários arquivos → passa', () => {
    const a: WorkflowFile = { ...wf('1.3.14'), file: '.github/workflows/ci.yml' };
    const b: WorkflowFile = { ...wf('1.3.14'), file: '.github/workflows/outro.yml' };
    expect(auditBunPins([a, b])).toHaveLength(0);
  });
});

describe('auditBunPins — setup-bun sem bun-version (default = latest)', () => {
  it('FALHA quando um step usa setup-bun e OMITE o bun-version', () => {
    const f = auditBunPins([
      {
        file: '.github/workflows/ci.yml',
        yaml: `name: t
on: [push]
jobs:
  job0:
    runs-on: ubuntu-latest
    steps:
      - uses: oven-sh/setup-bun@v2
      - run: bun install
`,
      },
    ]);
    expect(f).toHaveLength(1);
    expect(f[0].msg).toContain('latest');
  });

  it('FALHA quando UM dos dois setup-bun tem pin e o outro não', () => {
    const f = auditBunPins([
      {
        file: '.github/workflows/ci.yml',
        yaml: `name: t
on: [push]
jobs:
  a:
    steps:
      - uses: oven-sh/setup-bun@v2
        with:
          bun-version: 1.3.14
  b:
    steps:
      - uses: oven-sh/setup-bun@v2
`,
      },
    ]);
    expect(f).toHaveLength(1);
    expect(f[0].msg).toContain('setup-bun');
  });

  it('pega setup-bun pinado por SHA (uses: oven-sh/setup-bun@<sha>)', () => {
    const f = auditBunPins([
      {
        file: '.github/workflows/ci.yml',
        yaml: `name: t
on: [push]
jobs:
  job0:
    steps:
      - uses: oven-sh/setup-bun@4bc047ad259df6fc24a6c9b0f9a0cb08cf17fbe5
`,
      },
    ]);
    expect(f).toHaveLength(1);
  });
});

describe('auditBunPins — robustez', () => {
  it('aceita aspas e comentário inline: `"1.3.14"  # nota`', () => {
    expect(auditBunPins([wf('"1.3.14"  # pin do incidente #1352')])).toHaveLength(0);
  });

  it('ignora workflow sem setup-bun nenhum (ex.: auto-merge.yml)', () => {
    const f = auditBunPins([
      {
        file: '.github/workflows/auto-merge.yml',
        yaml: `name: Auto-merge
on: [pull_request]
jobs:
  enable:
    runs-on: ubuntu-latest
    steps:
      - run: gh pr merge --auto --squash "$PR"
`,
      },
    ]);
    expect(f).toHaveLength(0);
  });

  it('não confunde action de nome parecido (outro/setup-bun) com a oven-sh/setup-bun', () => {
    const f = auditBunPins([
      {
        file: '.github/workflows/ci.yml',
        yaml: `name: t
on: [push]
jobs:
  job0:
    steps:
      - uses: outro/setup-bun@v2
`,
      },
    ]);
    expect(f).toHaveLength(0);
  });
});

describe('auditBunPins — o repo de verdade', () => {
  // O VEREDITO sobre os workflows REAIS NÃO mora aqui — mora no step `bunpin:check` do `ci.yml`,
  // que é bloqueante e roda este mesmo `auditBunPins(readWorkflows())`. Até 2026-09-20 vivia aqui
  // um `it('os workflows REAIS do repo passam no gate')` com `expect(findings).toHaveLength(0)`:
  // mesmo código, mesma árvore, mesmo CI — SEGUNDA PORTA, não segundo detector. O preço não era o
  // tempo, era a LEITURA: o motor de exclusividade mede o STEP, via o `test` co-pegando todo
  // defeito deste eixo e carimbou EXCLUSIVIDADE_ZERO ("redundância medida") no único dono do pin
  // do bun — medido no #2509 com o defeito `bun-despinado` (vermelhos `bunpin:check` + `test`).
  // Quem lesse o carimbo concluiria que dá para aposentar o gate; o eixo dele é um SPOF de rede
  // que em 2026-07-16 matou TODO PR do repo em ~6s. Mesma resolução do #2378 no `docs:indice`
  // (que o #2391 levou a `[SO ELE]`) e do #2519 no `sonda:autentica`; a classe está em
  // docs/historico/exclusividade-media-outra-coisa.md ("segundas portas").
  //
  // Medido ao tirar (mesma invocação, 2 locales, controle verde, restauração por cópia provada):
  // com `bun-despinado` aplicado no `ci.yml` REAL, a suíte INTEIRA do vitest fica verde e o
  // `bunpin:check` reprova citando o arquivo — a duplicata saiu, a detecção ficou.
  //
  // O que fica aqui é o que o step não dá: as formas sintéticas acima (calibração e falsificação)
  // e a guarda ANTI-VÁCUO abaixo, que prova o DENOMINADOR. Não devolva o veredito para cá.

  // ⚠️ Guarda ANTI-VÁCUO. Se `readWorkflows` parar de casar (diretório renomeado, filtro de
  // extensão quebrado), o gate passa por não achar NADA — "verde por ausência de dado". Cobra
  // VOLUME, não identidade: se o pin está CERTO é a invariante do step, e ela não volta para cá.
  it('o repo de fato pina o bun (o gate não passa à toa, sem achar ocorrência nenhuma)', () => {
    const yamls = readWorkflows()
      .map((w) => w.yaml)
      .join('\n');
    expect((yamls.match(/bun-version:/g) ?? []).length).toBeGreaterThanOrEqual(2);
  });
});
