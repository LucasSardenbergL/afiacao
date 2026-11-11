import { describe, expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, truncateSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  chaveDoManifesto,
  enumerarClosures,
  limparMemoGit,
  Mecanica,
  materializarClosure,
  identidadeDosControles,
  classificarVeredito,
  gateG1,
  gateG3,
  gateG4,
  pontoFixoDeArquivos,
  sentinelaStripper,
  type Veredito,
} from './sonda-cron-prova';

const OPTIONS_OK = [
  "Deno.serve(async (req) => {",
  "  if (req.method === 'OPTIONS') {",
  "    const sonda = await atenderSondaOptions(req, respostaSonda, VERSAO);",
  "    if (sonda) return sonda;",
  "    return new Response(null, { headers: corsHeaders });",
  "  }",
  "  const auth = await authorizeCronOrStaff(req);",
].join("\n");

describe('gateG1 — o ramo dentro do bloco OPTIONS, antes do CORS', () => {
  it('aceita a forma canônica', () => {
    expect(gateG1('monthly-report', OPTIONS_OK)).toBeNull();
  });
  it('reprova ramo ausente, NOMEANDO a edge', () => {
    const sem = OPTIONS_OK.replace(/ {4}const sonda[^\n]*\n {4}if \(sonda\) return sonda;\n/, '');
    expect(gateG1('monthly-report', sem)).toMatch(/monthly-report.*atenderSondaOptions/);
  });
  it('reprova ramo DEPOIS do return de CORS (código morto)', () => {
    const invertido = OPTIONS_OK.replace(
      "    const sonda = await atenderSondaOptions(req, respostaSonda, VERSAO);\n    if (sonda) return sonda;\n    return new Response(null, { headers: corsHeaders });",
      "    return new Response(null, { headers: corsHeaders });\n    const sonda = await atenderSondaOptions(req, respostaSonda, VERSAO);\n    if (sonda) return sonda;",
    );
    expect(gateG1('monthly-report', invertido)).toMatch(/DEPOIS do return de CORS/);
  });
  it("aceita corpo de CORS que não é `null` — o preflight de 'ok' é o de 3 edges REAIS", () => {
    // Regressão de 2026-09-07: o gate casava a string literal `new Response(null, …)`, e
    // `reposicao-depara-sayerlack-auto`, `carteira-positivacao-snapshot` e `omie-nfe-webhook`
    // respondem `'ok'` desde sempre. Passar no gate exigiria MUDAR o preflight delas — o oposto
    // do que ele protege. O gêmeo deste gate vive em `_shared/sonda-versao-contrato_test.ts`.
    for (const corpo of ["'ok'", '"ok"', '`ok`']) {
      const variante = OPTIONS_OK.replace('new Response(null,', `new Response(${corpo},`);
      expect(gateG1('reposicao-depara-sayerlack-auto', variante)).toBeNull();
    }
  });
  it('reprova quando o fallback de CORS SOME — corpo literal é o que separa fallback de chamada', () => {
    const semCors = OPTIONS_OK.replace('    return new Response(null, { headers: corsHeaders });\n', '');
    expect(gateG1('monthly-report', semCors)).toMatch(/perdeu o return de CORS/);
    // Uma CHAMADA no lugar do literal não é o fallback: pode fazer IO e mudar o preflight.
    const comChamada = OPTIONS_OK.replace('new Response(null,', 'new Response(montarCors(),');
    expect(gateG1('monthly-report', comChamada)).toMatch(/perdeu o return de CORS/);
  });
  it('reprova IO dentro do bloco — e NÃO se engana com IO citado em comentário', () => {
    const comIo = OPTIONS_OK.replace('    if (sonda) return sonda;', '    if (sonda) return sonda;\n    await supabase.from("t").select();\n    void fetch("x");');
    expect(gateG1('monthly-report', comIo)).toMatch(/IO dentro do bloco OPTIONS/);
    const soComentario = OPTIONS_OK.replace('    if (sonda) return sonda;', '    if (sonda) return sonda;\n    // nunca chame fetch( aqui');
    expect(gateG1('monthly-report', soComentario)).toBeNull();
  });
});

const RELE_OK = [
  'const saida = montarRequestSonda(baseUrl, alvo, await derivarCredencial(chave, alvo));',
  'const violacao = barreiraSaida(saida, baseUrl, alvo, ALLOWLIST);',
  'resposta = await fetch(saida, { signal: AbortSignal.timeout(TIMEOUT_MS) });',
].join('\n');

describe('gateG3 — o relé só emite OPTIONS, e mede a VARIÁVEL', () => {
  it('aceita o relé canônico', () => expect(gateG3(RELE_OK)).toBeNull());
  it('reprova 2 fetch', () => expect(gateG3(`${RELE_OK}\nawait fetch(outraCoisa);`)).toMatch(/2 chamada/));
  it('reprova fetch que não recebe o request da barreira', () => {
    const burlado = RELE_OK.replace('fetch(saida,', 'fetch(new Request(url),');
    expect(gateG3(burlado)).toMatch(/não recebe|nasce de/);
  });
  it('reprova method literal no fetch', () => {
    expect(gateG3(RELE_OK.replace('fetch(saida, {', 'fetch(saida, { method: "POST",'))).toMatch(/method/);
  });
  it('NÃO se engana com x-cron-secret no CORS de entrada (é o header que o cron manda PARA o relé)', () => {
    const comCors = `const corsHeaders = { "Access-Control-Allow-Headers": "content-type, x-cron-secret" };\n${RELE_OK}`;
    expect(gateG3(comCors)).toBeNull();
  });
  it('reprova x-cron-secret montado em headers de SAÍDA', () => {
    const vazando = `${RELE_OK}\nconst h = { headers: { "x-cron-secret": s } };`;
    expect(gateG3(vazando)).toMatch(/cron-secret/);
  });
});

describe('sentinelaStripper — alarme de SUB-limpeza', () => {
  it('acusa quando o texto não tem bloco de comentário grande (stripper cego ou fonte sem doc)', () => {
    expect(sentinelaStripper('const x = 1;\nconst y = 2;')).toMatch(/stripper/);
  });
  it('aceita um cabeçalho real de 10 linhas comentadas', () => {
    const doc = `${Array.from({ length: 10 }, (_, i) => `// linha ${i}`).join('\n')}\nconst x = 1;`;
    expect(sentinelaStripper(doc)).toBeNull();
  });
});

describe('gateG4 — o espelho no banco ⊆ allowlist', () => {
  it('reprova INSERT com slug fora, nomeando o slug', () => {
    const m = [{ nome: 'm.sql', sql: "INSERT INTO public.deploy_sonda_alvos (edge, motivo) VALUES ('omie-webhook', 'x');" }];
    expect(gateG4(m, ['monthly-report'])).toMatch(/omie-webhook/);
  });
  it('aceita slug da allowlist e ignora migration que não menciona a tabela', () => {
    const m = [
      { nome: 'm.sql', sql: "INSERT INTO public.deploy_sonda_alvos (edge, motivo) VALUES ('monthly-report', 'x');" },
      { nome: 'n.sql', sql: 'CREATE TABLE outra ();' },
    ];
    expect(gateG4(m, ['monthly-report'])).toBeNull();
  });
});

const chamada = (over: Record<string, unknown> = {}) => ({
  status: 200, probe: false, efeitos: 0, fetches: 0, corpoHash: 'h', headers: {}, quiesceu: true, ...over,
});
const base = (): Veredito => ({
  importErro: null,
  efeitosNoImport: 0,
  handler: true,
  a: chamada(),
  b: ['preflight-browser', 'hex-invalido', 'credencial-errada', 'outra-edge'].map((nome) => ({ nome, ...chamada() })),
  c: { classe: 'controle', efeitos: 2, fetches: 0, degrau: 'controle-0' },
});

describe('classificarVeredito', () => {
  it('PASSA quando inerte com controle positivo', () => expect(classificarVeredito(base(), false)).toBe('PASSA'));
  it('FALHA com efeito no OPTIONS', () => {
    expect(classificarVeredito({ ...base(), a: chamada({ efeitos: 1 }) }, false)).toBe('FALHA');
  });
  it('FALHA com IO no import, mesmo que o import tenha lançado', () => {
    expect(classificarVeredito({ ...base(), efeitosNoImport: 1, importErro: 'boom' }, false)).toBe('FALHA');
  });
  it('FALHA quando um negativo responde diferente do preflight', () => {
    const v = base();
    v.b[3] = { ...v.b[3], corpoHash: 'outro' };
    expect(classificarVeredito(v, false)).toBe('FALHA');
  });
  it('FALHA quando um closure SEM o ramo responde probe, e quando um COM o ramo não responde', () => {
    expect(classificarVeredito({ ...base(), a: chamada({ probe: true }) }, false)).toBe('FALHA');
    expect(classificarVeredito(base(), true)).toBe('FALHA');
    expect(classificarVeredito({ ...base(), a: chamada({ probe: true }) }, true)).toBe('PASSA');
  });
  it('FALHA quando o relógio virtual não quiesceu', () => {
    expect(classificarVeredito({ ...base(), a: chamada({ quiesceu: false }) }, false)).toBe('FALHA');
  });
  it('INVERIFICAVEL: import falhou sem efeito, ou controle inconclusivo', () => {
    expect(classificarVeredito({ ...base(), importErro: 'Module not found', handler: false }, false)).toBe('INVERIFICAVEL');
    expect(classificarVeredito({ ...base(), c: { classe: 'inconclusivo', efeitos: 0, fetches: 0, degrau: null } }, false)).toBe('INVERIFICAVEL');
  });
});

describe('cache e enumeração', () => {
  it('a chave muda com o harness — closure igual, instrumento diferente, veredito a refazer', () => {
    expect(chaveDoManifesto('c1', 'h1', 'x1')).not.toBe(chaveDoManifesto('c1', 'h2', 'x1'));
    expect(chaveDoManifesto('c1', 'h1', 'x1')).toBe(chaveDoManifesto('c1', 'h1', 'x1'));
  });
  it('a chave muda com os CONTROLES — trocar o controle por um inerte tem de reexecutar', () => {
    // Regressão de 2026-09-07: sem isto, sabotar o corpo do controle de `sync-reprocess` deixava
    // os 43 vereditos em cache e a falsificação saía VERDE. Controle inerte aprova qualquer coisa.
    expect(chaveDoManifesto('c1', 'h1', 'x1')).not.toBe(chaveDoManifesto('c1', 'h1', 'x2'));
  });
  it('a identidade dos controles é ESTÁVEL por edge e DISTINTA entre edges com controles diferentes', () => {
    expect(identidadeDosControles('sync-reprocess')).toBe(identidadeDosControles('sync-reprocess'));
    expect(identidadeDosControles('sync-reprocess')).not.toBe(identidadeDosControles('sonda-relay'));
    // Edge fora da allowlist não tem controle: identidade do vazio, nunca um throw silencioso.
    expect(identidadeDosControles('nao-existe')).toBe(identidadeDosControles('outra-que-nao-existe'));
  });
  it('o ponto fixo alcança dependência que só existia no passado, e os commits QUE SÓ ELA tem', () => {
    // O caso real: `_shared/velho.ts` não existe mais hoje, mas um `index.ts` antigo o importava.
    // O histórico do index já traz o commit em que isso acontecia (s2); o fecho DESSE sha revela o
    // arquivo; e o histórico DO ARQUIVO traz um commit (s3) que o histórico do index não tinha —
    // um closure distinto que a enumeração ingênua perderia inteiro.
    const fechos: Record<string, string[]> = {
      s1: ['a/index.ts', '_shared/x.ts'],
      s2: ['a/index.ts', '_shared/velho.ts'],
      s3: ['a/index.ts', '_shared/velho.ts'],
    };
    const historico = (files: string[]) => (files.includes('_shared/velho.ts') ? ['s1', 's2', 's3'] : ['s1', 's2']);
    expect(pontoFixoDeArquivos(['a/index.ts'], historico, (sha) => fechos[sha])).toEqual({
      arquivos: ['_shared/velho.ts', '_shared/x.ts', 'a/index.ts'],
      shas: ['s1', 's2', 's3'],
    });
  });
});

describe('memo das leituras do git na enumeração (E18)', () => {
  // O risco do memo é VERDE-FALSO: chave incompleta devolve a história velha, o conjunto de
  // closures encolhe e um closure novo sai da prova em silêncio. Aqui o memo está QUENTE (mesmo
  // processo, mesma raiz) quando entra um commit novo — ele tem de aparecer.
  it('commit novo depois da 1ª enumeração vira closure novo; memo quente == memo frio', () => {
    const raiz = mkdtempSync(join(tmpdir(), 'sonda-memo-'));
    const g = (...a: string[]) => execFileSync('git', a, { cwd: raiz, encoding: 'utf8' });
    try {
      g('init', '-q');
      g('config', 'user.email', 't@t');
      g('config', 'user.name', 't');
      mkdirSync(join(raiz, 'supabase/functions/e1'), { recursive: true });
      mkdirSync(join(raiz, 'supabase/functions/_shared'), { recursive: true });
      writeFileSync(join(raiz, 'supabase/functions/e1/index.ts'), "import { h } from '../_shared/h.ts';\nh();\n");
      writeFileSync(join(raiz, 'supabase/functions/_shared/h.ts'), 'export const h = () => 1;\n');
      g('add', '-A');
      g('commit', '-qm', 'c1');
      limparMemoGit();
      expect(enumerarClosures('e1', raiz)).toHaveLength(1);

      // Só o helper muda: a história do index.ts NÃO tem este commit — só a do _shared tem.
      writeFileSync(join(raiz, 'supabase/functions/_shared/h.ts'), 'export const h = () => 2;\n');
      g('commit', '-qam', 'c2');
      const quente = enumerarClosures('e1', raiz).map((c) => c.identidade).sort();
      limparMemoGit();
      const frio = enumerarClosures('e1', raiz).map((c) => c.identidade).sort();
      expect(quente).toHaveLength(2);
      expect(quente).toEqual(frio);
    } finally {
      limparMemoGit();
      rmSync(raiz, { recursive: true, force: true });
    }
  });
});

describe('materializarClosure — arquivo do git, conferência e retry SÓ da materialização (E21)', () => {
  // Incidente: run 43029163344, `tar: Unexpected EOF in archive` no closure `fin-valor-cockpit`,
  // re-run do mesmo SHA verde. Causa não provada — então o que se prova aqui é o CONTRATO: falha de
  // materialização é detectada (inclusive a que sai 0), re-tentada UMA vez em diretório novo,
  // registrada, e persistindo vira Mecanica (exit 2). Nunca closure aprovado sem os arquivos.
  type Exec = Parameters<typeof materializarClosure>[4];
  const real: NonNullable<Exec> = (cmd, args, cwd) => {
    const r = spawnSync(cmd, args, { cwd, encoding: 'utf8' });
    return { status: r.status, stderr: r.stderr ?? '' };
  };
  const ARQS = {
    'supabase/functions/e1/index.ts': "import { h } from '../_shared/h.ts';\nh();\n",
    'supabase/functions/_shared/h.ts': `export const h = () => ${'1 + '.repeat(400)}1;\n`,
  };
  function repo(): { raiz: string; sha: string } {
    const raiz = mkdtempSync(join(tmpdir(), 'sonda-mat-'));
    const g = (...a: string[]) => execFileSync('git', a, { cwd: raiz, encoding: 'utf8' });
    g('init', '-q'); g('config', 'user.email', 't@t'); g('config', 'user.name', 't');
    for (const [p, c] of Object.entries(ARQS)) {
      mkdirSync(join(raiz, p, '..'), { recursive: true });
      writeFileSync(join(raiz, p), c);
    }
    g('add', '-A'); g('commit', '-qm', 'c1');
    return { raiz, sha: g('rev-parse', 'HEAD').trim() };
  }
  const CAMINHOS = ['supabase/functions/e1', 'supabase/functions/_shared'];
  /** Exec que sabota só a 1ª chamada de `cmd`, DEPOIS de rodá-la de verdade. */
  function sabotaPrimeira(cmd: string, depois: (args: string[]) => void): { exec: NonNullable<Exec>; dirs: string[] } {
    let n = 0; const dirs: string[] = [];
    const exec: NonNullable<Exec> = (c, args, cwd) => {
      const r = real(c, args, cwd);
      if (c === 'tar') dirs.push(args[args.indexOf('-C') + 1]);
      if (c === cmd && ++n === 1) depois(args);
      return r;
    };
    return { exec, dirs };
  }
  const tarDe = (args: string[]) => args[args.indexOf('-o') + 1];

  it('controle: materializa todos os arquivos do sha, sem retry no registro', () => {
    const { raiz, sha } = repo();
    const log: string[] = [];
    try {
      const dir = materializarClosure('e1', sha, CAMINHOS, raiz, real, (l) => log.push(l));
      for (const [p, c] of Object.entries(ARQS)) expect(readFileSync(join(dir, p), 'utf8')).toBe(c);
      expect(log).toEqual([]);
      rmSync(dir, { recursive: true, force: true });
    } finally { rmSync(raiz, { recursive: true, force: true }); }
  });

  it('tar truncado (o EOF do incidente) → registra etapa=extracao e acerta na 2ª, em diretório NOVO', () => {
    const { raiz, sha } = repo();
    const log: string[] = [];
    const { exec, dirs } = sabotaPrimeira('git', (a) => truncateSync(tarDe(a), 700));
    try {
      const dir = materializarClosure('e1', sha, CAMINHOS, raiz, exec, (l) => log.push(l));
      expect(log[0]).toMatch(new RegExp(`tentativa 1/2\\): sha=${sha} etapa=extracao tamanho=700B exit=[1-9]`));
      expect(log[1]).toContain('OK na tentativa 2/2');
      expect(dirs).toHaveLength(2);
      expect(dir).toBe(dirs[1]);
      expect(dirs[0]).not.toBe(dirs[1]);
      expect(existsSync(dirs[0])).toBe(false);
      expect(readFileSync(join(dir, 'supabase/functions/_shared/h.ts'), 'utf8')).toBe(ARQS['supabase/functions/_shared/h.ts']);
      rmSync(dir, { recursive: true, force: true });
    } finally { rmSync(raiz, { recursive: true, force: true }); }
  });

  it('tar sai 0 mas falta arquivo → etapa=conferencia (exit 0 não é prova)', () => {
    const { raiz, sha } = repo();
    const log: string[] = [];
    const { exec } = sabotaPrimeira('tar', (a) => unlinkSync(join(a[a.indexOf('-C') + 1], 'supabase/functions/_shared/h.ts')));
    try {
      const dir = materializarClosure('e1', sha, CAMINHOS, raiz, exec, (l) => log.push(l));
      expect(log[0]).toMatch(/etapa=conferencia .*exit=0 .*h\.ts ausente/);
      rmSync(dir, { recursive: true, force: true });
    } finally { rmSync(raiz, { recursive: true, force: true }); }
  });

  it('tar sai 0 com arquivo cortado → etapa=conferencia pelo TAMANHO do blob', () => {
    const { raiz, sha } = repo();
    const log: string[] = [];
    const { exec } = sabotaPrimeira('tar', (a) => truncateSync(join(a[a.indexOf('-C') + 1], 'supabase/functions/_shared/h.ts'), 10));
    try {
      const dir = materializarClosure('e1', sha, CAMINHOS, raiz, exec, (l) => log.push(l));
      expect(log[0]).toMatch(/etapa=conferencia .*h\.ts com 10B, blob tem \d+B/);
      rmSync(dir, { recursive: true, force: true });
    } finally { rmSync(raiz, { recursive: true, force: true }); }
  });

  it('falha PERSISTENTE → Mecanica com as 2 tentativas registradas (nunca closure aprovado)', () => {
    const { raiz, sha } = repo();
    const log: string[] = [];
    let chamadas = 0;
    const quebrado: NonNullable<Exec> = (c, args, cwd) => {
      if (c === 'git') { chamadas++; return { status: 128, stderr: 'fatal: sabotado' }; }
      return real(c, args, cwd);
    };
    try {
      let erro: unknown = null;
      try { materializarClosure('e1', sha, CAMINHOS, raiz, quebrado, (l) => log.push(l)); } catch (e) { erro = e; }
      expect(erro).toBeInstanceOf(Mecanica);
      expect((erro as Error).message).toMatch(/materialização falhou nas 2 tentativas — sha=\w+ etapa=archive tamanho=—B exit=128 stderr="fatal: sabotado" \| sha=/);
      expect(chamadas).toBe(2);
      expect(log).toHaveLength(2);
    } finally { rmSync(raiz, { recursive: true, force: true }); }
  });
});
