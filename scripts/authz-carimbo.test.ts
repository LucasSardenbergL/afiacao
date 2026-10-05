import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { removerComentarios } from '@/lib/gates/limpeza-fonte';

import { AUTHZ_MANIFEST } from './authz-manifest';
import { AUTHZ_TABELAS_FECHADAS } from './authz-tabelas-fechadas';
import {
  AUTHZ_RLS_ESPERADO,
  AUTHZ_RLS_PREDICADOS,
  LACUNAS_DECLARADAS,
  LACUNAS_POR_GRUPO,
  PREDICADOS_PLATAFORMA,
} from './authz-rls-esperado';

import {
  AVISO_DIAS,
  AUDITS,
  CARIMBO_PATH,
  CHAVES_RELIDAS_POR_VERSAO,
  PROJETO_HASH_PROD,
  SCHEMA_VERSION,
  VENCIDO_DIAS,
  RAIZ,
  avaliarCarimbo,
  escolherResumo,
  canonicalizar,
  combinarAnteriores,
  conferirCluster,
  fingerprintContrato,
  fingerprintAuditor,
  dadoDoContrato,
  envDeTesteSetadas,
  idFinding,
  lerArquivoDoCarimbo,
  lerCarimboAnterior,
  lerReferenciaDaMain,
  montarAchados,
  montarCarimbo,
  referenciaDoTexto,
  type Carimbo,
  type CarimboAnterior,
  type ChaveAudit,
  type ExecucaoDeAudit,
} from './lib/authz-carimbo';

const CHAVES = Object.keys(AUDITS) as ChaveAudit[];

/** Fingerprints "corretos" para os testes de avaliação — a menos que o caso os sabote de propósito. */
function fpsBons(): Record<ChaveAudit, { contrato: string; auditor: string }> {
  const o = {} as Record<ChaveAudit, { contrato: string; auditor: string }>;
  for (const k of CHAVES) o[k] = { contrato: `ct-${k}`, auditor: `au-${k}` };
  return o;
}

function carimboBom(medidoEm: string, over: Partial<Record<ChaveAudit, { exit: number; achados?: Carimbo['audits']['grants']['achados'] }>> = {}): Carimbo {
  const audits = {} as Carimbo['audits'];
  for (const k of CHAVES) {
    audits[k] = {
      script: AUDITS[k].script,
      exit: over[k]?.exit ?? 0,
      resumo: 'ok',
      denominador: null,
      contratoFingerprint: `ct-${k}`,
      auditorFingerprint: `au-${k}`,
      achados: over[k]?.achados ?? [],
    };
  }
  return {
    schemaVersion: SCHEMA_VERSION,
    medidoEm,
    sourceHead: 'deadbeef',
    alvo: { usuario: 'claude_ro', servidor: 'PostgreSQL 17.6', somenteLeitura: true, projetoHash: PROJETO_HASH_PROD },
    audits,
  };
}

const AGORA = new Date('2026-08-26T00:00:00.000Z');
const diasAtras = (d: number) => new Date(AGORA.getTime() - d * 86_400_000).toISOString();
const codigos = (v: { codigo: string }[]) => v.map((x) => x.codigo);

/** As envs que os arquivos de AUDITOR de `AUDITS` leem — medidas na fonte, sem comentários. */
function envsLidasPelosAuditores(): string[] {
  const nomes = new Set<string>();
  for (const k of CHAVES) {
    for (const rel of AUDITS[k].auditorFiles.filter((f) => f.endsWith('.ts'))) {
      const fonte = removerComentarios(readFileSync(join(RAIZ, rel), 'utf8'));
      for (const m of fonte.matchAll(/process\.env(?:\.([A-Z0-9_]+)|\[\s*['"]([A-Z0-9_]+)['"]\s*\])/g)) {
        nomes.add(m[1] ?? m[2]);
      }
    }
  }
  return [...nomes].sort();
}

// ══════════════════════════════════════════════════════════════════════════════════════════════
// canonicalizar — o serializador é a fundação do fingerprint. Se ele for cego, TODO o resto é
// teatro: o gate ficaria verde sem nunca ter comparado nada.
// ══════════════════════════════════════════════════════════════════════════════════════════════
describe('canonicalizar — cegueira de serialização', () => {
  // 🔴 SENTINELA do bug que motivou o serializador próprio. `JSON.stringify(new Set(['a']))` é
  // '{}' — sem erro. Um fingerprint por JSON.stringify nasceria cego a Set/Map, e o contrato de
  // authz TEM os dois (ACKNOWLEDGED_SENSITIVE, ACL_ONLY_INTERNAL, REESCRITAS_CONHECIDAS_INDEX).
  it('NÃO colapsa Set para {} (o que JSON.stringify faz)', () => {
    expect(JSON.stringify(new Set(['a']))).toBe('{}'); // o comportamento que estamos contornando
    expect(canonicalizar(new Set(['a']))).not.toBe('{}');
    expect(canonicalizar(new Set(['a']))).not.toBe(canonicalizar(new Set(['b'])));
    expect(canonicalizar(new Set(['a']))).not.toBe(canonicalizar(new Set([])));
  });

  it('NÃO colapsa Map para {}', () => {
    expect(JSON.stringify(new Map([['k', 1]]))).toBe('{}');
    expect(canonicalizar(new Map([['k', 1]]))).not.toBe('{}');
    expect(canonicalizar(new Map([['k', 1]]))).not.toBe(canonicalizar(new Map([['k', 2]])));
  });

  it('Set e Array com o mesmo conteúdo NÃO colidem (trocar lista por conjunto é mudança)', () => {
    expect(canonicalizar(new Set(['a', 'b']))).not.toBe(canonicalizar(['a', 'b']));
  });

  it('Set é estável na ordem de inserção; Array NÃO é (multiplicidade/ordem importam)', () => {
    expect(canonicalizar(new Set(['b', 'a']))).toBe(canonicalizar(new Set(['a', 'b'])));
    expect(canonicalizar(['b', 'a'])).not.toBe(canonicalizar(['a', 'b']));
  });

  it('objeto é estável na ordem das chaves', () => {
    expect(canonicalizar({ b: 1, a: 2 })).toBe(canonicalizar({ a: 2, b: 1 }));
  });

  it('exclui SÓ os campos de apresentação, e nada mais', () => {
    expect(canonicalizar({ x: 1, motivo: 'a' })).toBe(canonicalizar({ x: 1, motivo: 'b' }));
    expect(canonicalizar({ x: 1, provaExecutada: 'a' })).toBe(canonicalizar({ x: 1, provaExecutada: 'b' }));
    // campo semântico novo entra por DEFAULT — é a direção fail-safe da lista de exclusão
    expect(canonicalizar({ x: 1, campoNovo: 'a' })).not.toBe(canonicalizar({ x: 1, campoNovo: 'b' }));
  });

  // Fail-closed: valor que o serializador não sabe representar tem de QUEBRAR, não virar '{}'.
  it.each([
    ['Date', new Date(0)],
    ['função', () => 1],
    ['instância de classe', new (class Foo { x = 1 })()],
    ['bigint', 10n],
  ])('LANÇA em valor não representável: %s', (_nome, v) => {
    expect(() => canonicalizar(v)).toThrow(/não-serializável/);
  });
});

// ══════════════════════════════════════════════════════════════════════════════════════════════
// Fingerprints — falsificação: mutar o contrato TEM de mover o fingerprint. Um fingerprint que
// não se move é o mesmo que não existir.
// ══════════════════════════════════════════════════════════════════════════════════════════════
describe('fingerprint — sensibilidade (falsificação)', () => {
  it('é determinístico entre chamadas', () => {
    for (const k of CHAVES) {
      expect(fingerprintContrato(k)).toBe(fingerprintContrato(k));
      expect(fingerprintAuditor(k)).toBe(fingerprintAuditor(k));
    }
  });

  it('difere entre TODOS os audits (não há colisão de escopo)', () => {
    const cts = new Set(CHAVES.map(fingerprintContrato));
    const aus = new Set(CHAVES.map(fingerprintAuditor));
    expect(cts.size).toBe(CHAVES.length);
    expect(aus.size).toBe(CHAVES.length);
  });

  // Sabota formas equivalentes às dos contratos reais e exige que o fingerprint MUDE.
  it.each([
    ['entrada nova', { 'public.a': { fechadaPor: null, permitido: { anon: [], authenticated: [] } } }, { 'public.a': { fechadaPor: null, permitido: { anon: [], authenticated: [] } }, 'public.b': { fechadaPor: null, permitido: { anon: [], authenticated: [] } } }],
    ['privilégio a mais', { 'public.a': { permitido: { anon: [], authenticated: ['SELECT'] } } }, { 'public.a': { permitido: { anon: ['SELECT'], authenticated: ['SELECT'] } } }],
    ['âncora trocada', { 'public.a': { fechadaPor: null } }, { 'public.a': { fechadaPor: '2026_x.sql' } }],
    ['booleano de role', { 'public.f': { permitido: { anon: false, authenticated: true } } }, { 'public.f': { permitido: { anon: true, authenticated: true } } }],
    ['allOf vira anyOf', { 'public.f': { requiredGate: { allOf: [{ fn: 'g' }] } } }, { 'public.f': { requiredGate: { anyOf: [{ fn: 'g' }] } } }],
    ['md5 de reescrita', [{ arquivo: 'a.sql', funcao: 'public.f', md5ProdEsperado: 'aaa' }], [{ arquivo: 'a.sql', funcao: 'public.f', md5ProdEsperado: 'bbb' }]],
    ['Set de classificação', { s: new Set(['a']) }, { s: new Set(['a', 'b']) }],
  ])('a mutação "%s" move o canônico', (_n, antes, depois) => {
    expect(canonicalizar(antes)).not.toBe(canonicalizar(depois));
  });
});

// ══════════════════════════════════════════════════════════════════════════════════════════════
// idFinding — a identidade do achado sustenta `primeiraVez`. Id instável lava a dívida.
// ══════════════════════════════════════════════════════════════════════════════════════════════
describe('idFinding — estabilidade da dívida', () => {
  it('é estável quando só a PROSA do auditor muda (código + objeto são a âncora)', () => {
    const a = '❌ [DRIFT_PROD] public.sales_orders: anon tem INSERT,DELETE fora do permitido [nenhum] — grant aplicado à mão.';
    const b = '❌ [DRIFT_PROD] public.sales_orders: anon tem INSERT,DELETE fora do permitido — redação nova totalmente diferente.';
    expect(idFinding('grants', a)).toBe(idFinding('grants', b));
  });

  it('difere por CÓDIGO, por OBJETO e por AUDIT', () => {
    const base = '❌ [DRIFT_PROD] public.sales_orders: x';
    expect(idFinding('grants', base)).not.toBe(idFinding('grants', '❌ [NAO_APLICADA] public.sales_orders: x'));
    expect(idFinding('grants', base)).not.toBe(idFinding('grants', '❌ [DRIFT_PROD] public.product_costs: x'));
    expect(idFinding('grants', base)).not.toBe(idFinding('funcoes', base));
  });

  it('cai para a linha inteira quando a forma não parseia (fail-safe, sem colisão)', () => {
    expect(idFinding('grants', 'sem forma nenhuma A')).not.toBe(idFinding('grants', 'sem forma nenhuma B'));
  });

  // DOURADO e não-circular: o único achado já gravado num carimbo COMMITADO (f1154aa75, schema 2,
  // 2026-09-05), com o `id` que o gravador DAQUELA época escreveu. Se o algoritmo mudar, todo `id`
  // commitado deixa de casar e a próxima gravação regride TODA `primeiraVez` para hoje — sem mudar
  // forma nem versão, invisível à porta de releitura. Mudar `idFinding` exige migrar os ids junto.
  it('DOURADO: reproduz o id que o gravador escreveu num carimbo commitado (a herança depende disso)', () => {
    const linha =
      '❌ public.sayerlack_aplicar_custo_portal — [FUNCAO_AUSENTE_EM_PROD] public.sayerlack_aplicar_custo_portal está na allowlist e NÃO existe no banco — foi removida, renomeada, ou a allowlist ficou obsoleta.';
    expect(idFinding('funcoes', linha)).toBe('ef43258a5a7946e8');
  });
});

// ══════════════════════════════════════════════════════════════════════════════════════════════
// avaliarCarimbo — cada eixo casa o CÓDIGO DELIMITADO do ramo, não "saiu algum veredito".
// ══════════════════════════════════════════════════════════════════════════════════════════════
describe('avaliarCarimbo — os eixos e suas severidades', () => {
  // CONTROLE VERDE: sem isto os testes abaixo passariam com um gate vermelho-sempre.
  it('carimbo fresco, contratos batendo, exit 0 ⇒ ZERO veredito', () => {
    expect(avaliarCarimbo(carimboBom(diasAtras(1)), AGORA, fpsBons())).toEqual([]);
  });

  it('carimbo ausente ⇒ [CARIMBO_AUSENTE] e BLOQUEIA (ausência de dado não é aprovação)', () => {
    const v = avaliarCarimbo(null, AGORA, fpsBons());
    expect(codigos(v)).toEqual(['CARIMBO_AUSENTE']);
    expect(v[0].bloqueiaPR).toBe(true);
  });

  it('schemaVersion incompatível ⇒ [CARIMBO_AUSENTE], não leitura otimista', () => {
    const c = carimboBom(diasAtras(1));
    c.schemaVersion = SCHEMA_VERSION + 1;
    expect(codigos(avaliarCarimbo(c, AGORA, fpsBons()))).toEqual(['CARIMBO_AUSENTE']);
  });

  it('medidoEm no FUTURO ⇒ [CARIMBO_AUSENTE] (relógio errado ou carimbo forjado)', () => {
    const c = carimboBom(new Date(AGORA.getTime() + 86_400_000).toISOString());
    expect(codigos(avaliarCarimbo(c, AGORA, fpsBons()))).toEqual(['CARIMBO_AUSENTE']);
  });

  it('medidoEm inválido ⇒ [CARIMBO_AUSENTE]', () => {
    expect(codigos(avaliarCarimbo(carimboBom('não é data'), AGORA, fpsBons()))).toEqual(['CARIMBO_AUSENTE']);
  });

  it('audit faltando no carimbo ⇒ [CARIMBO_AUSENTE] e BLOQUEIA', () => {
    const c = carimboBom(diasAtras(1));
    delete (c.audits as Partial<Carimbo['audits']>).grants;
    const v = avaliarCarimbo(c, AGORA, fpsBons());
    expect(codigos(v)).toContain('CARIMBO_AUSENTE');
    expect(v.find((x) => x.codigo === 'CARIMBO_AUSENTE')?.bloqueiaPR).toBe(true);
  });

  it('CONTRATO mudou ⇒ [CARIMBO_CONTRATO_MUDOU] e BLOQUEIA (um PR conserta isso)', () => {
    const fps = fpsBons();
    fps.grants.contrato = 'outro';
    const v = avaliarCarimbo(carimboBom(diasAtras(1)), AGORA, fps);
    expect(codigos(v)).toEqual(['CARIMBO_CONTRATO_MUDOU']);
    expect(v[0].bloqueiaPR).toBe(true);
  });

  it('AUDITOR mudou ⇒ [CARIMBO_AUDITOR_MUDOU] e BLOQUEIA (instrumento ≠ o que produziu a evidência)', () => {
    const fps = fpsBons();
    fps.funcoes.auditor = 'outro';
    const v = avaliarCarimbo(carimboBom(diasAtras(1)), AGORA, fps);
    expect(codigos(v)).toEqual(['CARIMBO_AUDITOR_MUDOU']);
    expect(v[0].bloqueiaPR).toBe(true);
  });

  it(`idade > ${VENCIDO_DIAS}d ⇒ [CARIMBO_VELHO] e NÃO bloqueia PR`, () => {
    const v = avaliarCarimbo(carimboBom(diasAtras(VENCIDO_DIAS + 1)), AGORA, fpsBons());
    expect(codigos(v)).toEqual(['CARIMBO_VELHO']);
    expect(v[0].bloqueiaPR).toBe(false);
  });

  it(`idade entre ${AVISO_DIAS}d e ${VENCIDO_DIAS}d ⇒ [CARIMBO_AVISO], nunca [CARIMBO_VELHO]`, () => {
    const v = avaliarCarimbo(carimboBom(diasAtras(AVISO_DIAS + 1)), AGORA, fpsBons());
    expect(codigos(v)).toEqual(['CARIMBO_AVISO']);
  });

  it(`idade abaixo de ${AVISO_DIAS}d ⇒ silêncio nos dois eixos de idade`, () => {
    const v = avaliarCarimbo(carimboBom(diasAtras(AVISO_DIAS - 1)), AGORA, fpsBons());
    expect(codigos(v)).not.toContain('CARIMBO_AVISO');
    expect(codigos(v)).not.toContain('CARIMBO_VELHO');
  });

  it('exit≠0 ⇒ [CARIMBO_ACHADO], NÃO bloqueia PR, e a mensagem carrega a data de abertura', () => {
    const c = carimboBom(diasAtras(1), {
      grants: { exit: 1, achados: [{ id: 'x', linha: '❌ [DRIFT_PROD] public.sales_orders: anon tem INSERT,DELETE', primeiraVez: '2026-08-13', ultimaVez: '2026-08-26' }] },
    });
    const v = avaliarCarimbo(c, AGORA, fpsBons());
    expect(codigos(v)).toEqual(['CARIMBO_ACHADO']);
    expect(v[0].bloqueiaPR).toBe(false);
    // A idade da DÍVIDA tem de aparecer — senão o achado vira "conhecido e fresco" para sempre.
    expect(v[0].mensagem).toContain('2026-08-13');
  });

  // A TRAVA de cluster no ARTEFATO (revisão independente de 2026-10-05): o gate não lia `alvo`, e um
  // carimbo medido em OUTRO banco passava verde — num repo que auto-mergeia sem revisão humana, venha
  // do gravador, de edição à mão ou de conflito resolvido com `--ours`/`--theirs`. Ausente ≠ prod.
  it('alvo de OUTRO cluster, ou sem projetoHash ⇒ [CARIMBO_OUTRO_CLUSTER] e BLOQUEIA', () => {
    const casos: [string, (c: Carimbo) => void][] = [
      ['outro hash', (c) => { c.alvo.projetoHash = 'deadbeefdeadbeef'; }],
      ['o de prod com espaço', (c) => { c.alvo.projetoHash = ` ${PROJETO_HASH_PROD}`; }],
      ['projetoHash ausente', (c) => { delete (c.alvo as Partial<Carimbo['alvo']>).projetoHash; }],
      ['alvo ausente', (c) => { delete (c as Partial<Carimbo>).alvo; }],
    ];
    for (const [rot, mut] of casos) {
      const c = carimboBom(diasAtras(1));
      mut(c);
      const v = avaliarCarimbo(c, AGORA, fpsBons());
      expect(codigos(v), rot).toEqual(['CARIMBO_OUTRO_CLUSTER']);
      expect(v[0].bloqueiaPR, rot).toBe(true);
      expect(v[0].mensagem, rot).toContain(PROJETO_HASH_PROD);
    }
  });
});

// ══════════════════════════════════════════════════════════════════════════════════════════════
// O carimbo COMMITADO. Frescor NÃO é testado aqui de propósito: quem cobra idade é o gate, e um
// teste que envelhece sozinho quebraria a suíte inteira no 15º dia por algo que não é regressão.
// ══════════════════════════════════════════════════════════════════════════════════════════════
describe('db/authz-carimbo-prod.json — o artefato commitado', () => {
  it('existe, parseia e tem TODOS os audits de AUDITS com a forma esperada', () => {
    expect(existsSync(CARIMBO_PATH)).toBe(true);
    const c = JSON.parse(readFileSync(CARIMBO_PATH, 'utf8')) as Carimbo;
    expect(c.schemaVersion).toBe(SCHEMA_VERSION);
    expect(Number.isNaN(new Date(c.medidoEm).getTime())).toBe(false);
    for (const k of CHAVES) {
      expect(c.audits[k], `audit ${k}`).toBeDefined();
      expect(typeof c.audits[k].exit).toBe('number');
      expect(c.audits[k].contratoFingerprint).toMatch(/^[0-9a-f]{64}$/);
      expect(c.audits[k].auditorFingerprint).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  // A próxima renovação relê ESTE arquivo: se a porta o recusasse, o founder descobriria só ao gravar.
  it('o GRAVADOR o relê pela porta, e a projeção bate com o arquivo (toda primeiraVez)', () => {
    const texto = readFileSync(CARIMBO_PATH, 'utf8');
    const cru = JSON.parse(texto) as Carimbo;
    expect(relido(texto)).toEqual({
      schemaVersion: cru.schemaVersion,
      achados: Object.fromEntries(CHAVES.map((k) => [k, cru.audits[k].achados.map((a) => ({ id: a.id, primeiraVez: a.primeiraVez }))])),
    });
  });

  // A constante não é palpite: é o cluster em que a evidência de prod foi medida (as 36 versões
  // commitadas até 2026-10-01 têm este valor). Se divergir, o gate barra todo PR — e é aqui que se vê.
  it('foi medido em PROD: alvo.projetoHash é PROJETO_HASH_PROD, a trava que o gate cobra', () => {
    const c = JSON.parse(readFileSync(CARIMBO_PATH, 'utf8')) as Carimbo;
    expect(c.alvo.projetoHash).toBe(PROJETO_HASH_PROD);
    expect(PROJETO_HASH_PROD).toMatch(/^[0-9a-f]{16}$/);
  });

  it('todo achado registrado tem primeiraVez ≤ ultimaVez (a dívida não pode nascer do futuro)', () => {
    const c = JSON.parse(readFileSync(CARIMBO_PATH, 'utf8')) as Carimbo;
    for (const k of CHAVES) {
      for (const a of c.audits[k].achados) {
        expect(a.primeiraVez <= a.ultimaVez, `${k}/${a.id}`).toBe(true);
      }
    }
  });
});

// ══════════════════════════════════════════════════════════════════════════════════════════════
// Sensibilidade sobre os contratos REAIS — mais forte que as formas sintéticas acima, porque
// guarda contra a forma de verdade mudar. Medido: `authz-manifest.ts` levou 16 commits em 90 dias,
// e é a lista de EXCLUSÃO que decide quantos deles cobram uma re-medição de prod. Se ela parar de
// funcionar, ou o gate vira ruído (todo typo em `motivo` bloqueia PR) ou vira cego.
// ══════════════════════════════════════════════════════════════════════════════════════════════
describe('fingerprint sobre o contrato REAL', () => {
  it('editar `motivo` NÃO move o fingerprint (senão typo em comentário bloqueia PR)', () => {
    const base = canonicalizar(AUTHZ_MANIFEST);
    const c = structuredClone(AUTHZ_MANIFEST);
    c[Object.keys(c)[0]].motivo = `redação totalmente diferente ${'x'.repeat(50)}`;
    expect(canonicalizar(c)).toBe(base);
  });

  it('trocar `requiredGate` MOVE (é decisão de política — o ponto de revisão consciente)', () => {
    const base = canonicalizar(AUTHZ_MANIFEST);
    const c = structuredClone(AUTHZ_MANIFEST);
    c[Object.keys(c)[0]].requiredGate = { anyOf: [{ fn: 'sabotado' }] } as never;
    expect(canonicalizar(c)).not.toBe(base);
  });

  it('entrada NOVA no manifest MOVE (função nunca verificada em prod tem de cobrar medição)', () => {
    const base = canonicalizar(AUTHZ_MANIFEST);
    const c = structuredClone(AUTHZ_MANIFEST);
    c['public.funcao_inventada_pelo_teste'] = { sensitive: true, requiredGate: { allOf: [{ fn: 'g' }] }, motivo: 'x' } as never;
    expect(canonicalizar(c)).not.toBe(base);
  });

  it('abrir `anon` numa tabela fechada MOVE (o vetor que a Parte C existe para pegar)', () => {
    const base = canonicalizar(AUTHZ_TABELAS_FECHADAS);
    const c = structuredClone(AUTHZ_TABELAS_FECHADAS);
    c[Object.keys(c)[0]].permitido.anon = ['SELECT'];
    expect(canonicalizar(c)).not.toBe(base);
  });

  it('os contratos reais são serializáveis (nenhum valor exótico escapa do canonicalizar)', () => {
    for (const k of CHAVES) expect(() => fingerprintContrato(k)).not.toThrow();
  });
});

// ══════════════════════════════════════════════════════════════════════════════════════════════
// O JS embutido no workflow. Sem isto ele só seria exercitado PELA PRIMEIRA VEZ em produção, na
// main — e é justamente o pedaço que decide se um achado vira incidente visível ou não. O repo já
// tem o precedente de vitest que lê um artefato como TEXTO (o gate de forma das edges).
// ⚠️ O caminho que mais importa é o 3: a Issue fecha contra uma MEDIÇÃO NOVA E LIMPA, nunca
// porque "o workflow passou" — senão o monitor daria por resolvido o que ele não mediu.
// ══════════════════════════════════════════════════════════════════════════════════════════════
describe('ci.yml — o job authz-sentinela', () => {
  const yml = readFileSync(join(RAIZ, '.github', 'workflows', 'ci.yml'), 'utf8');

  /**
   * Extração TEXTUAL, sem parser de YAML — de propósito: `yaml` não é dependência declarada do
   * repo (só um pin em `overrides`), e declará-la mexeria no lockfile, que é ímã de conflito num
   * repo com ~30 worktrees. Os marcadores abaixo são o CONTRATO deste teste: se o workflow mudar
   * de forma, ele falha ALTO em vez de silenciar — que é o comportamento certo para um sentinela.
   */
  function blocoDoScript(nomeDoStep: string): string {
    const i = yml.indexOf(`- name: ${nomeDoStep}`);
    expect(i, `step \`${nomeDoStep}\` sumiu do ci.yml`).toBeGreaterThan(-1);
    const j = yml.indexOf('script: |', i);
    expect(j, `step \`${nomeDoStep}\` não tem \`script: |\``).toBeGreaterThan(-1);
    const linhas = yml.slice(yml.indexOf('\n', j) + 1).split('\n');
    const recuo = (linhas[0].match(/^ */) as RegExpMatchArray)[0].length;
    const corpo: string[] = [];
    for (const l of linhas) {
      if (l.trim() !== '' && (l.match(/^ */) as RegExpMatchArray)[0].length < recuo) break;
      corpo.push(l.slice(recuo));
    }
    return corpo.join('\n');
  }

  const script = blocoDoScript('Sincroniza a Issue authz-prod');

  it('roda SÓ na main (nunca segura PR de ninguém)', () => {
    const i = yml.indexOf('  authz-sentinela:');
    expect(i, 'job authz-sentinela sumiu').toBeGreaterThan(-1);
    expect(yml.slice(i, i + 200)).toContain("if: github.ref == 'refs/heads/main'");
  });

  it('o step bloqueante do `validate` NÃO usa --exigir-frescor (idade não barra PR)', () => {
    const i = yml.indexOf('- name: Authz carimbo de prod');
    expect(i, 'step do carimbo sumiu do job validate').toBeGreaterThan(-1);
    const trecho = yml.slice(i, i + 160);
    expect(trecho).toContain('run: bun run authz:carimbo');
    expect(trecho).not.toContain('--exigir-frescor');
  });

  it('o job sentinela USA --exigir-frescor (senão os dois eixos dele ficam mudos)', () => {
    expect(blocoDoScript.name).toBe('blocoDoScript'); // sanidade do helper
    expect(yml).toContain('bun run authz:carimbo -- --exigir-frescor --json');
  });

  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor as new (...a: string[]) => (...a: unknown[]) => Promise<void>;

  async function rodar(vereditos: unknown[], abertas: { number: number }[]): Promise<string[]> {
    const feitas: string[] = [];
    const github = { rest: { issues: {
      createLabel: async () => { feitas.push('createLabel'); },
      listForRepo: async () => ({ data: abertas }),
      createComment: async (a: { issue_number: number; body: string }) => { feitas.push(`comment#${a.issue_number}`); },
      create: async () => { feitas.push('CREATE'); return { data: { number: 99 } }; },
      update: async (a: { issue_number: number; state: string }) => { feitas.push(`update#${a.issue_number}:${a.state}`); },
    } } };
    const context = { repo: { owner: 'o', repo: 'r' }, serverUrl: 'https://gh', runId: 1 };
    const core = { info: () => {}, setFailed: (m: string) => { feitas.push(`FAILED:${m}`); } };
    const req = (m: string) => (m === 'fs' ? { readFileSync: () => JSON.stringify({ vereditos }) } : null);
    await new AsyncFunction('github', 'context', 'core', 'require', script)(github, context, core, req);
    return feitas;
  }

  const achado = [{ codigo: 'CARIMBO_ACHADO', bloqueiaPR: false, mensagem: 'aberto desde 2026-08-13' }];

  it('compila com `await` no topo (é assim que o github-script o executa)', () => {
    expect(script).not.toBe('');
    expect(() => new AsyncFunction('github', 'context', 'core', 'require', script)).not.toThrow();
  });

  it('achado + nenhuma Issue aberta ⇒ ABRE a Issue', async () => {
    expect(await rodar(achado, [])).toContain('CREATE');
  });

  it('achado + Issue já aberta ⇒ COMENTA, não duplica', async () => {
    const f = await rodar(achado, [{ number: 7 }]);
    expect(f).toContain('comment#7');
    expect(f).not.toContain('CREATE');
  });

  it('medição limpa + Issue aberta ⇒ FECHA (contra a medição, não contra "o workflow passou")', async () => {
    expect(await rodar([], [{ number: 7 }])).toContain('update#7:closed');
  });

  it('medição limpa + nenhuma Issue ⇒ no-op (não cria Issue para dizer que está tudo bem)', async () => {
    const f = await rodar([], []);
    expect(f).not.toContain('CREATE');
    expect(f.some((x) => x.startsWith('update#'))).toBe(false);
  });

  it('só CARIMBO_AVISO não é acionável ⇒ não abre incidente', async () => {
    const f = await rodar([{ codigo: 'CARIMBO_AVISO', bloqueiaPR: false, mensagem: '8 dias' }], []);
    expect(f).not.toContain('CREATE');
  });

  it('veredito ilegível ⇒ setFailed (o monitor não pode dar por limpo o que não leu)', async () => {
    const feitas: string[] = [];
    const core = { info: () => {}, setFailed: (m: string) => { feitas.push(`FAILED:${m}`); } };
    const github = { rest: { issues: { createLabel: async () => {}, listForRepo: async () => ({ data: [] }), createComment: async () => {}, create: async () => ({ data: { number: 1 } }), update: async () => {} } } };
    const req = (m: string) => (m === 'fs' ? { readFileSync: () => 'não é json' } : null);
    await new AsyncFunction('github', 'context', 'core', 'require', script)(github, { repo: { owner: 'o', repo: 'r' }, serverUrl: '', runId: 1 }, core, req);
    expect(feitas.some((x) => x.startsWith('FAILED:'))).toBe(true);
  });
});

// ══════════════════════════════════════════════════════════════════════════════════════════════
// escolherResumo — a regra que eu ERREI na 1ª versão. Fica testada porque raspar texto de saída
// humana é contrato acidental, e a única defesa possível é fixar a forma de cada audit real.
// ══════════════════════════════════════════════════════════════════════════════════════════════
describe('escolherResumo — o veredito é a ÚLTIMA linha ✅, não a primeira', () => {
  it('pega o SUMÁRIO quando há muitas asserções ✅ (a forma do authz:claude-ro:prod)', () => {
    const saida = ['🔒 sentinela', '  ✅ papel existe: SIM', '  ✅ memberships herdadas: 0', '✅ 25 asserções batem. O endurecimento continua de pé.'];
    expect(escolherResumo(saida)).toBe('✅ 25 asserções batem. O endurecimento continua de pé.');
    expect(escolherResumo(saida)).not.toContain('papel existe');
  });

  it('pega o ✅ único (a forma do authz:funcoes:prod / authz:audit:prod)', () => {
    expect(escolherResumo(['🔎 43 lidas', '✅ o EXECUTE de prod bate com o contrato'])).toBe('✅ o EXECUTE de prod bate com o contrato');
  });

  it('cai para a última linha quando NÃO há ✅ (a forma do audit que sai 1)', () => {
    const saida = ['❌ [DRIFT_PROD] public.sales_orders: anon tem INSERT,DELETE', 'audit-grants — 1 divergencia(s).'];
    expect(escolherResumo(saida)).toBe('audit-grants — 1 divergencia(s).');
  });

  it('saída vazia devolve string vazia, não explode', () => {
    expect(escolherResumo([])).toBe('');
  });
});

// ══════════════════════════════════════════════════════════════════════════════════════════════
// A 5ª chave (`rls`, 2026-08-27) e a guarda de env de teste que ela obrigou a generalizar.
// ══════════════════════════════════════════════════════════════════════════════════════════════
describe('chave `rls` — a quarta guarda enumerada', () => {
  it('está em AUDITS, com o script e os DOIS arquivos de auditor', () => {
    expect(AUDITS.rls).toBeDefined();
    expect(AUDITS.rls.script).toBe('authz:rls:prod');
    expect(AUDITS.rls.auditorFiles).toEqual(['db/audit-rls-prod.ts', 'scripts/lib/authz-rls.ts']);
    // o contrato dela é um MÓDULO do repo, não a baseline embutida no auditor
    expect(AUDITS.rls.contratoEmArquivo).toBeUndefined();
  });

  it('o contrato que o carimbo USA carrega os CINCO eixos, por identidade', () => {
    // Exerce `dadoDoContrato`, não uma reconstrução do objeto: a primeira versão deste teste
    // montava `{tabelas, predicados, plataforma}` aqui e canonicalizava — remover um eixo da
    // função real seguia VERDE (pego na falsificação). Identidade de referência é o que faz
    // "esqueci de incluir o eixo" virar vermelho. O 4º (`lacunas`) entrou em 2026-08-28: é o que
    // o contrato declara NÃO cobrir, e mudá-lo afrouxa o que o verde afirma. O 5º (`grupos`), no
    // mesmo dia, é a lacuna em BLOCO — e afrouxa por UMA LINHA: baixar `tabelasNoGrafo` faz o
    // audit deixar de acusar a tabela que ENTROU no grupo.
    const d = dadoDoContrato('rls') as Record<string, unknown>;
    expect(d.tabelas).toBe(AUTHZ_RLS_ESPERADO);
    expect(d.predicados).toBe(AUTHZ_RLS_PREDICADOS);
    expect(d.plataforma).toBe(PREDICADOS_PLATAFORMA);
    expect(d.lacunas).toBe(LACUNAS_DECLARADAS);
    expect(d.grupos).toBe(LACUNAS_POR_GRUPO);
    expect(Object.keys(d).sort()).toEqual(['grupos', 'lacunas', 'plataforma', 'predicados', 'tabelas']);
  });

  it('o canônico do contrato REAL representa o Set — o eixo que se serializaria como {}', () => {
    // Mover uma função para dentro de PREDICADOS_PLATAFORMA dispensa o congelamento do corpo dela;
    // é o eixo cuja mudança AFROUXA. `JSON.stringify(new Set(['a']))` é `'{}'` — se o canônico não
    // o representasse, esse afrouxamento não moveria o fingerprint. Cegueira no pior lugar.
    const canon = canonicalizar(dadoDoContrato('rls'));
    expect(canon).toContain('Set(');
    expect(canon).toContain('auth.uid');
    expect(canon).toContain('public.has_role');
    expect(canon).toContain('public.sales_orders');
  });

  it('baixar UMA contagem de grupo move o canônico — o afrouxamento de uma linha', () => {
    // A falsificação mais barata do eixo 5, e a que o carimbo tem de ver: `tabelasNoGrafo: 22 → 21`
    // não some com tabela nenhuma do contrato, não mexe em policy nenhuma, e faz o audit parar de
    // acusar a tabela que entrou no grupo. Se o fingerprint não se movesse, o carimbo seguiria
    // atestando uma declaração que já não é a medida.
    const base = canonicalizar(dadoDoContrato('rls'));
    const afrouxado = canonicalizar({
      tabelas: AUTHZ_RLS_ESPERADO, predicados: AUTHZ_RLS_PREDICADOS,
      plataforma: PREDICADOS_PLATAFORMA, lacunas: LACUNAS_DECLARADAS,
      grupos: LACUNAS_POR_GRUPO.map((g, i) => (i === 0 ? { ...g, tabelasNoGrafo: g.tabelasNoGrafo - 1 } : g)),
    });
    expect(afrouxado).not.toBe(base);
  });

  it.each([
    ['policy a mais', (c: Record<string, unknown>) => ({ ...c, zz: { forceRls: false, policies: {}, motivo: 'x' } })],
    ['plataforma ampliada', null],
  ])('a mutação "%s" move o canônico do contrato de rls', (rot, mut) => {
    const base = canonicalizar(dadoDoContrato('rls'));
    const depois =
      mut === null
        ? canonicalizar({
            tabelas: AUTHZ_RLS_ESPERADO, predicados: AUTHZ_RLS_PREDICADOS,
            plataforma: new Set([...PREDICADOS_PLATAFORMA, 'public.has_role']),
          })
        : canonicalizar({
            tabelas: mut(AUTHZ_RLS_ESPERADO as unknown as Record<string, unknown>),
            predicados: AUTHZ_RLS_PREDICADOS, plataforma: PREDICADOS_PLATAFORMA,
          });
    expect(depois, rot).not.toBe(base);
  });
});

describe('envDeTesteSetadas — a guarda que a lista literal já tinha deixado passar', () => {
  it('pega QUALQUER AUTHZ_*_TEST_JSON, não só as duas que existiam quando a regra nasceu', () => {
    expect(envDeTesteSetadas({ AUTHZ_GRANTS_TEST_JSON: '{}' })).toEqual(['AUTHZ_GRANTS_TEST_JSON']);
    expect(envDeTesteSetadas({ AUTHZ_RLS_TEST_JSON: '{}' })).toEqual(['AUTHZ_RLS_TEST_JSON']);
    // o audit que ainda não existe — é o caso que a lista literal erraria
    expect(envDeTesteSetadas({ AUTHZ_QUALQUER_COISA_TEST_JSON: '{}' })).toEqual(['AUTHZ_QUALQUER_COISA_TEST_JSON']);
  });

  it('pega a env do `claudeRo`, que NÃO tem o prefixo AUTHZ_ (o furo de 2026-10-01)', () => {
    expect(envDeTesteSetadas({ CLAUDE_RO_BASELINE_TEST_JSON: '{}' })).toEqual(['CLAUDE_RO_BASELINE_TEST_JSON']);
  });

  // 🔴 O teste que estava aqui calculava o nome "canônico" de cada chave (`AUTHZ_CLAUDE_RO_TEST_JSON`) e
  // provava que ELE era recusado — um nome que auditor nenhum lê. O do `claudeRo` é
  // `CLAUDE_RO_BASELINE_TEST_JSON`, fora do prefixo `AUTHZ_`: o runner o deixava passar e carimbaria a
  // baseline de TESTE como se fosse prod, com este teste verde. Os nomes agora saem da FONTE do auditor.
  it('TODA env que um auditor de AUDITS lê (medida na fonte) é recusada — exceto PSQL_RO, que tem guarda própria', () => {
    const lidas = envsLidasPelosAuditores();
    // SENTINELA contra cegueira: um scan que parasse de casar devolveria [] e aprovaria tudo.
    expect(lidas).toContain('CLAUDE_RO_BASELINE_TEST_JSON');
    expect(lidas).toContain('AUTHZ_GRANTS_TEST_JSON');
    expect(lidas).toContain('PSQL_RO');
    for (const nome of lidas.filter((n) => n !== 'PSQL_RO')) {
      expect(envDeTesteSetadas({ [nome]: '{}' }), nome).toEqual([nome]);
    }
  });

  it('ignora env vazia e env que não é de contrato (falso-positivo custa, mas não silencia)', () => {
    expect(envDeTesteSetadas({ AUTHZ_RLS_TEST_JSON: '' })).toEqual([]);
    expect(envDeTesteSetadas({ PSQL_RO: '/x', AUTHZ_TEST: '1', TEST_JSON: '1' })).toEqual([]);
  });
});

// ══════════════════════════════════════════════════════════════════════════════════════════════
// Anti-apodrecimento da CONTAGEM. Esta linha já esteve errada em produção: dizia "três FATIAS"
// depois que o 4º (claudeRo) e o 5º (rls) audits entraram no AUDITS — e é a mensagem que chega ao
// founder no momento do alarme. O conserto não foi trocar o número; foi tirá-lo da mão.
// ══════════════════════════════════════════════════════════════════════════════════════════════
describe('a contagem de fatias NÃO pode voltar a ser escrita à mão', () => {
  const ymlBruto = readFileSync(join(RAIZ, '.github', 'workflows', 'ci.yml'), 'utf8');

  it('o corpo da Issue DERIVA a contagem do payload, não de um literal', () => {
    const linha = ymlBruto.split('\n').find((l) => l.includes('FATIAS curadas'));
    expect(linha, 'a linha das FATIAS sumiu do ci.yml').toBeDefined();
    expect(linha).toContain('dados.audits');
    // qualquer numeral ou número por extenso ANTES de "FATIAS" é reintrodução do bug
    expect(linha).not.toMatch(/\b(um|dois|tr[êe]s|quatro|cinco|seis|\d+)\s+FATIAS/i);
  });

  it('o gate publica a lista de audits no JSON — sem ela o ci.yml não teria de onde derivar', () => {
    const gate = readFileSync(join(RAIZ, 'scripts', 'authz-carimbo-gate.ts'), 'utf8');
    expect(gate).toContain('audits: Object.keys(AUDITS)');
  });

  it('o doc aponta para a FONTE (AUDITS), em vez de repetir a contagem', () => {
    const doc = readFileSync(join(RAIZ, 'docs', 'agent', 'database.md'), 'utf8');
    expect(doc).toMatch(/FATIAS CURADAS enumeradas em `AUDITS`/);
    expect(doc).not.toMatch(/atesta (TR[ÊE]S|QUATRO|CINCO) FATIAS/i);
  });
});

// ══════════════════════════════════════════════════════════════════════════════════════════════
// A RELEITURA do carimbo ANTERIOR pelo gravador (2026-10-01). O gravador relia o anterior com
// `JSON.parse(...) as Carimbo` e usava dois campos dele: `alvo.projetoHash` (a TRAVA de cluster) e
// `audits[chave].achados[].primeiraVez` (a idade da dívida). Num carimbo de outro formato — ou com o
// campo fora do lugar — a trava era PULADA calada (`anterior.alvo?.projetoHash && …`) e a
// `primeiraVez` regredia para hoje. Narrativa: docs/historico/carimbo-gravador-rele-por-porta.md.
// ══════════════════════════════════════════════════════════════════════════════════════════════

/**
 * A forma REAL da versão imediatamente anterior, escrita à mão DE PROPÓSITO: derivá-la da tabela que
 * está sob teste tornaria o teste circular. Medida nas 24 versões v2 commitadas do carimbo. No bump,
 * ela passa a ser a forma da versão que acabou de deixar de ser a de hoje (a janela abaixo cobra).
 */
const ANTERIOR_A_DE_HOJE: { versao: number; chaves: readonly string[] } = {
  versao: 2,
  chaves: ['audit', 'claudeRo', 'funcoes', 'grants', 'rls'],
};

/** Um carimbo em `versao` com exatamente `chaves` em `audits` — a forma que o gravador daquela versão grava. */
function carimboNaForma(versao: number, chaves: readonly string[], achados: Record<string, unknown[]> = {}): Record<string, unknown> {
  const audits: Record<string, unknown> = {};
  for (const k of chaves) {
    const lista = achados[k] ?? [];
    audits[k] = { script: `s-${k}`, exit: lista.length ? 1 : 0, resumo: 'ok', denominador: null, contratoFingerprint: `ct-${k}`, auditorFingerprint: `au-${k}`, achados: lista };
  }
  return {
    schemaVersion: versao,
    medidoEm: diasAtras(1),
    sourceHead: 'deadbeef',
    alvo: { usuario: 'claude_ro', servidor: 'PostgreSQL 17.6', somenteLeitura: true, projetoHash: PROJETO_HASH_PROD },
    audits,
  };
}

const LINHA_GRANTS = '❌ [DRIFT_PROD] public.sales_orders: anon tem INSERT,DELETE fora do permitido';
const achadoAntigo = (chave: ChaveAudit, linha: string, primeiraVez: string) => ({ id: idFinding(chave, linha), linha, primeiraVez, ultimaVez: '2026-09-30' });
/** O carimbo de HOJE com um achado vivo em `grants` — a dívida que a releitura não pode lavar. */
const comDivida = (primeiraVez = '2026-08-13') => carimboBom(diasAtras(1), { grants: { exit: 1, achados: [achadoAntigo('grants', LINHA_GRANTS, primeiraVez)] } });
const comoDoc = (c: unknown) => structuredClone(c) as Record<string, unknown>;
const sem = (doc: Record<string, unknown>, campo: string) => Object.fromEntries(Object.entries(doc).filter(([k]) => k !== campo));
/** O carimbo de hoje com `audits` mexido por `mut` — para as formas inválidas no fundo. */
function comAudits(mut: (audits: Record<string, Record<string, unknown>>) => void): string {
  const d = structuredClone(comDivida()) as unknown as { audits: Record<string, Record<string, unknown>> };
  mut(d.audits);
  return JSON.stringify(d);
}

/** A projeção relida, ou LANÇA com o código da recusa — nenhum `toEqual` de aceitação passa por uma recusa. */
function relido(texto: string | null): CarimboAnterior | null {
  const l = lerCarimboAnterior(texto);
  if (!l.ok) throw new Error(`RECUSOU ${l.codigo}: ${l.motivo}`);
  return l.anterior;
}
/** Como `relido`, mas exige o anterior: texto não nulo nunca dá `null`. */
function lido(texto: string): CarimboAnterior {
  const a = relido(texto);
  if (a === null) throw new Error('a porta devolveu null para texto nao nulo');
  return a;
}
/** `{codigo, motivo}` da recusa, ou `ACEITOU` — nenhuma asserção de recusa casa isso. */
function recusa(texto: string | null): { codigo: string; motivo: string } {
  const l = lerCarimboAnterior(texto);
  return l.ok ? { codigo: 'ACEITOU', motivo: '' } : { codigo: l.codigo, motivo: l.motivo };
}

describe('lerCarimboAnterior — o gravador relê o anterior por uma porta que confere versão e forma', () => {
  // O CONTROLE, na mesma execução das recusas: uma porta que recusasse TUDO aprovaria todas elas.
  it('CONTROLE: o carimbo de HOJE é relido, e a projeção é a do arquivo (toda primeiraVez)', () => {
    expect(relido(`${JSON.stringify(comDivida(), null, 2)}\n`)).toEqual({
      schemaVersion: SCHEMA_VERSION,
      achados: Object.fromEntries(
        CHAVES.map((k) => [k, k === 'grants' ? [{ id: idFinding('grants', LINHA_GRANTS), primeiraVez: '2026-08-13' }] : []]),
      ),
    });
  });

  it('a versão IMEDIATAMENTE ANTERIOR é relida — é a migração legítima do PR que faz o bump', () => {
    const doc = carimboNaForma(ANTERIOR_A_DE_HOJE.versao, ANTERIOR_A_DE_HOJE.chaves, {
      grants: [achadoAntigo('grants', LINHA_GRANTS, '2026-08-13')],
    });
    const a = relido(JSON.stringify(doc));
    expect(a?.schemaVersion).toBe(ANTERIOR_A_DE_HOJE.versao);
    expect(a?.achados.grants).toEqual([{ id: idFinding('grants', LINHA_GRANTS), primeiraVez: '2026-08-13' }]);
  });

  // `null` = não há texto local. NÃO é nascimento por si — a evidência pode estar no git: quem decide
  // é `combinarAnteriores`, com a origin/main (revisão adversarial de 2026-10-03, achado A).
  it('sem texto local, a porta devolve anterior null — e só isso (o nascimento se decide com a main)', () => {
    expect(relido(null)).toBeNull();
  });

  it('versão FUTURA, antiga demais, ausente ou não inteira => CARIMBO_ANTERIOR_SCHEMA_INCOMPATIVEL', () => {
    for (const v of [SCHEMA_VERSION + 1, ANTERIOR_A_DE_HOJE.versao - 1, 0]) {
      const r = recusa(JSON.stringify({ ...comDivida(), schemaVersion: v }));
      expect(r.codigo, `schemaVersion ${v}`).toBe('CARIMBO_ANTERIOR_SCHEMA_INCOMPATIVEL');
      expect(r.motivo, `schemaVersion ${v}`).toContain(`schemaVersion ${v};`);
    }
    const ausente = recusa(JSON.stringify(sem(comoDoc(comDivida()), 'schemaVersion')));
    expect(ausente.codigo).toBe('CARIMBO_ANTERIOR_SCHEMA_INCOMPATIVEL');
    expect(ausente.motivo).toContain('schemaVersion ausente');
    for (const v of [String(SCHEMA_VERSION), SCHEMA_VERSION + 0.5, null]) {
      expect(recusa(JSON.stringify({ ...comDivida(), schemaVersion: v })).codigo, String(v)).toBe('CARIMBO_ANTERIOR_SCHEMA_INCOMPATIVEL');
    }
  });

  // Versão ANTES da forma: um carimbo de outro schema tem, legitimamente, outra forma — chamá-lo de
  // MALFORMADO mandaria o operador consertar o arquivo em vez de atualizar o código.
  it('a versão é conferida ANTES da forma: futura e sem `audits` é SCHEMA_INCOMPATIVEL, não MALFORMADO', () => {
    const futura = sem(comoDoc({ ...comDivida(), schemaVersion: SCHEMA_VERSION + 1 }), 'audits');
    expect(recusa(JSON.stringify(futura)).codigo).toBe('CARIMBO_ANTERIOR_SCHEMA_INCOMPATIVEL');
  });

  // Até 2026-10-05 a trava comparava a sonda com o `alvo` DESTE arquivo — que o operador edita, e cuja
  // recusa ensinava a editar. A trava agora é a sonda contra PROJETO_HASH_PROD (e o gate cobra o mesmo no
  // artefato): o anterior só empresta a HERANÇA, e a porta não exige o que ninguém mais lê. Um anterior
  // sem `alvo`, ou de outro cluster, empresta datas — e a herança fica com a mais antiga (dívida maior).
  it('o `alvo` do anterior NÃO é lido: sem ele, ou de outro cluster, a projeção é a mesma — a trava não mora aqui', () => {
    const base = () => comoDoc(comDivida());
    const esperado = lido(JSON.stringify(base()));
    const casos: [string, Record<string, unknown>][] = [
      ['alvo ausente', sem(base(), 'alvo')],
      ['alvo null', { ...base(), alvo: null }],
      ['projetoHash de outro cluster', { ...base(), alvo: { usuario: 'claude_ro', servidor: 'x', somenteLeitura: true, projetoHash: 'deadbeefdeadbeef' } }],
    ];
    for (const [rot, doc] of casos) expect(lido(JSON.stringify(doc)), rot).toEqual(esperado);
  });

  // A outra metade do achado: com os achados fora do lugar, a `primeiraVez` regredia para hoje calada
  // e a sentinela passava a dizer "aberto desde" errado.
  it('chave de audit FALTANDO ou SOBRANDO, ou achado fora da forma => CARIMBO_ANTERIOR_MALFORMADO nomeando o caminho', () => {
    const casos: [string, (a: Record<string, Record<string, unknown>>) => void, string][] = [
      ['chave faltando', (a) => { delete a.funcoes; }, 'audits.funcoes ausente'],
      ['chave sobrando', (a) => { a.inventada = a.grants; }, 'audits.inventada nao pertence ao schema'],
      ['audit que não é objeto', (a) => { a.rls = 'x' as never; }, 'audits.rls deveria ser objeto (veio texto)'],
      ['achados ausente', (a) => { delete a.grants.achados; }, 'audits.grants.achados ausente'],
      ['achados que não é lista', (a) => { a.grants.achados = 'x'; }, 'audits.grants.achados deveria ser lista (veio texto)'],
      ['achado sem id', (a) => { (a.grants.achados as Record<string, unknown>[])[0].id = undefined; }, 'audits.grants.achados[0].id'],
      ['primeiraVez fora da data', (a) => { (a.grants.achados as Record<string, unknown>[])[0].primeiraVez = '13/08/2026'; }, 'audits.grants.achados[0].primeiraVez'],
      // O FORMATO casa e o CALENDÁRIO não: a herança fica com a mais antiga, e propagaria o lixo para o
      // carimbo novo (`0000-00-00` venceria toda data real). Revisão independente de 2026-10-05.
      ['mês 13', (a) => { (a.grants.achados as Record<string, unknown>[])[0].primeiraVez = '2026-13-45'; }, 'audits.grants.achados[0].primeiraVez'],
      ['data zero', (a) => { (a.grants.achados as Record<string, unknown>[])[0].primeiraVez = '0000-00-00'; }, 'audits.grants.achados[0].primeiraVez'],
      ['30 de fevereiro', (a) => { (a.grants.achados as Record<string, unknown>[])[0].primeiraVez = '2026-02-30'; }, 'audits.grants.achados[0].primeiraVez'],
    ];
    for (const [rot, mut, trecho] of casos) {
      const r = recusa(comAudits(mut));
      expect(r.codigo, rot).toBe('CARIMBO_ANTERIOR_MALFORMADO');
      expect(r.motivo, rot).toContain(trecho);
    }
    expect(recusa(JSON.stringify(sem(comoDoc(comDivida()), 'audits'))).motivo).toContain('audits ausente');
    expect(recusa(JSON.stringify({ ...comDivida(), audits: [] })).motivo).toContain('audits deveria ser objeto (veio lista)');
  });

  it('raiz que não é objeto => MALFORMADO — `null` NUNCA é lido como nascimento', () => {
    for (const t of ['null', '[]', '42', '"x"']) expect(recusa(t).codigo, t).toBe('CARIMBO_ANTERIOR_MALFORMADO');
  });

  it('JSON ilegível => CARIMBO_ANTERIOR_ILEGIVEL (era SyntaxError cru, exit 1)', () => {
    expect(recusa('{ nao e json').codigo).toBe('CARIMBO_ANTERIOR_ILEGIVEL');
  });

  // O motivo é o que o operador e a suíte do binário casam: ASCII imprimível — sem acento, sem
  // travessão —, casável sem `-i` em `LC_ALL=C` e em `pt_BR.UTF-8`. Por isso nomeia o TIPO do que
  // veio, nunca o valor; e a chave que veio do arquivo é saneada.
  it('todo motivo de recusa é ASCII imprimível — inclusive com chave acentuada vinda do arquivo', () => {
    const casos = [
      '{ nao e json',
      'null',
      JSON.stringify({ ...comDivida(), schemaVersion: SCHEMA_VERSION + 1 }),
      JSON.stringify(sem(comoDoc(comDivida()), 'audits')),
      comAudits((a) => { a['ação'] = a.grants; }),
      comAudits((a) => { a.grants.achados = 'x'; }),
    ];
    for (const t of casos) {
      const r = recusa(t);
      expect(r.codigo, t.slice(0, 60)).not.toBe('ACEITOU');
      expect(r.motivo, r.codigo).toMatch(/^[\x20-\x7e]+$/);
    }
  });
});

describe('conferirCluster — a sonda contra PROJETO_HASH_PROD: o gravador não grava evidência de outro banco', () => {
  it('CONTROLE: a sonda de prod passa', () => {
    expect(conferirCluster(PROJETO_HASH_PROD)).toBeNull();
  });

  // A trava comparava com o carimbo anterior, e a recusa mandava "trocar alvo.projetoHash no carimbo
  // local" — a receita do erro honesto numa sessão no banco errado, que o gate (que não lia `alvo`)
  // deixava mergear. Revisão independente de 2026-10-05: a trava é a constante, e a mensagem não ensina
  // contorno — manda conferir o psql-ro.
  it('outro cluster => CARIMBO_OUTRO_CLUSTER nomeando os dois, em ASCII, sem receita de contorno', () => {
    for (const h of ['deadbeefdeadbeef', PROJETO_HASH_PROD.toUpperCase(), ` ${PROJETO_HASH_PROD}`, '']) {
      const r = conferirCluster(h);
      expect(r?.codigo, JSON.stringify(h)).toBe('CARIMBO_OUTRO_CLUSTER');
      expect(r?.motivo).toContain(`prod e ${PROJETO_HASH_PROD}`);
      expect(r?.motivo).toContain('psql-ro');
      expect(r?.motivo).toMatch(/^[\x20-\x7e]+$/);
      expect(r?.motivo).not.toMatch(/carimbo local/);
    }
    expect(conferirCluster('deadbeefdeadbeef')?.motivo).toContain('mede o cluster "deadbeefdeadbeef"');
  });
});

describe('montarAchados — a primeiraVez herdada nunca regride, nem na migração de versão', () => {
  const HOJE = '2026-10-01';
  const ID = idFinding('grants', LINHA_GRANTS);

  it('herda a primeiraVez de um anterior da versão ANTERIOR — a migração não lava a dívida', () => {
    const a = lido(JSON.stringify(carimboNaForma(ANTERIOR_A_DE_HOJE.versao, ANTERIOR_A_DE_HOJE.chaves, {
      grants: [achadoAntigo('grants', LINHA_GRANTS, '2026-08-13')],
    })));
    expect(montarAchados('grants', [LINHA_GRANTS], [a], HOJE, {})).toEqual([
      { id: ID, linha: LINHA_GRANTS, primeiraVez: '2026-08-13', ultimaVez: HOJE },
    ]);
  });

  it('a chave que a versão anterior não tinha nasce HOJE — é a primeira medição dela, não dívida lavada', () => {
    const novas = CHAVES.filter((k) => !ANTERIOR_A_DE_HOJE.chaves.includes(k));
    expect(novas.length, 'o bump acrescentou ao menos uma chave').toBeGreaterThan(0);
    const a = lido(JSON.stringify(carimboNaForma(ANTERIOR_A_DE_HOJE.versao, ANTERIOR_A_DE_HOJE.chaves)));
    for (const k of novas) expect(montarAchados(k, ['❌ [X] public.f: novo'], [a], HOJE, {})[0].primeiraVez, k).toBe(HOJE);
  });

  it('a semente vale só quando o anterior não conhece o achado — o anterior vence a semente', () => {
    expect(montarAchados('grants', [LINHA_GRANTS], [], HOJE, { [ID]: '2026-08-13' })[0].primeiraVez).toBe('2026-08-13');
    const a = lido(JSON.stringify(comDivida('2026-07-01')));
    expect(montarAchados('grants', [LINHA_GRANTS], [a], HOJE, { [ID]: '2026-08-13' })[0].primeiraVez).toBe('2026-07-01');
  });

  it('achado novo, sem anterior que o conheça nem semente, nasce hoje', () => {
    const a = lido(JSON.stringify(comDivida()));
    expect(montarAchados('grants', ['❌ [DRIFT_PROD] public.outra: x'], [a], HOJE, {})[0].primeiraVez).toBe(HOJE);
  });

  // O achado B da revisão adversarial: um local VELHO (conflito de merge resolvido com `--ours`) passava
  // pela porta — a forma está certa, o frescor não — e regredia a data do que a main já tinha visto.
  it('local VELHO e main mais nova: fica a primeiraVez MAIS ANTIGA dos dois, inclusive em chave que o local nem tem', () => {
    const novas = CHAVES.filter((k) => !ANTERIOR_A_DE_HOJE.chaves.includes(k));
    const nova = novas[0];
    expect(nova, 'o bump acrescentou ao menos uma chave').toBeDefined();
    const LINHA_NOVA = '❌ [DERIVA] public.f_nova: corpo diverge';
    const localVelho = lido(JSON.stringify(carimboNaForma(ANTERIOR_A_DE_HOJE.versao, ANTERIOR_A_DE_HOJE.chaves, {
      grants: [achadoAntigo('grants', LINHA_GRANTS, '2026-09-20')],
    })));
    const daMain = lido(JSON.stringify(carimboBom(diasAtras(1), {
      grants: { exit: 1, achados: [achadoAntigo('grants', LINHA_GRANTS, '2026-08-13')] },
      [nova]: { exit: 1, achados: [achadoAntigo(nova, LINHA_NOVA, '2026-09-26')] },
    })));
    expect(montarAchados('grants', [LINHA_GRANTS], [localVelho, daMain], HOJE, {})[0].primeiraVez).toBe('2026-08-13');
    expect(montarAchados(nova, [LINHA_NOVA], [localVelho, daMain], HOJE, {})[0].primeiraVez).toBe('2026-09-26');
    // e a ordem dos anteriores não importa
    expect(montarAchados('grants', [LINHA_GRANTS], [daMain, localVelho], HOJE, {})[0].primeiraVez).toBe('2026-08-13');
  });
});

describe('combinarAnteriores — a origin/main é a REFERÊNCIA da herança: sem ela, não se grava', () => {
  const local = () => lido(JSON.stringify(comDivida('2026-09-01')));
  const main = () => lido(JSON.stringify(comDivida('2026-08-13')));

  // O CONTROLE da matriz: os dois presentes, a herança dos DOIS (`montarAchados` fica com a mais antiga).
  it('CONTROLE: local e main presentes — a herança vem dos DOIS', () => {
    const r = combinarAnteriores(local(), { estado: 'presente', carimbo: main() });
    expect(r.ok ? r.heranca : 'RECUSOU').toEqual([local(), main()]);
  });

  // O achado A de 2026-10-03: `rm db/authz-carimbo-prod.json` zerava a dívida.
  it('local AUSENTE e main presente: a herança vem da MAIN — apagar o arquivo não zera a dívida', () => {
    const r = combinarAnteriores(null, { estado: 'presente', carimbo: main() });
    expect(r.ok ? r.heranca : 'RECUSOU').toEqual([main()]);
  });

  // O nascimento foi em 2026-08-27 (8962f213c) e não se repete: main SEM o carimbo é worktree ou remote
  // errado (rename, fork), nunca "primeira medição" — que gravaria a dívida zerada, calada. Revisão
  // independente de 2026-10-05: o ramo `ausente` era o último pelo qual a ausência de ARQUIVO passava.
  it('main SEM o carimbo => CARIMBO_ANTERIOR_SEM_REFERENCIA — com ou sem local: o nascimento não se repete', () => {
    for (const l of [null, local()]) {
      const r = combinarAnteriores(l, { estado: 'ausente' });
      expect(r.ok ? 'ACEITOU' : r.codigo).toBe('CARIMBO_ANTERIOR_SEM_REFERENCIA');
      expect(r.ok ? '' : r.motivo).toContain('desde 2026-08-27');
      expect(r.ok ? '' : r.motivo).toMatch(/^[\x20-\x7e]+$/);
    }
  });

  // Ausência de RESPOSTA não é ausência de carimbo: sem a main, a herança não confere o que ela já viu.
  it('main NÃO CONSULTADA => CARIMBO_ANTERIOR_SEM_REFERENCIA — com ou sem local, em ASCII', () => {
    for (const l of [null, local()]) {
      const r = combinarAnteriores(l, { estado: 'nao-consultada', motivo: 'git ls-tree origin/main falhou: fatal' });
      expect(r.ok ? 'ACEITOU' : r.codigo).toBe('CARIMBO_ANTERIOR_SEM_REFERENCIA');
      expect(r.ok ? '' : r.motivo).toContain('nao consegui ler o carimbo da origin/main');
      expect(r.ok ? '' : r.motivo).toMatch(/^[\x20-\x7e]+$/);
    }
  });
});

describe('lerReferenciaDaMain — o git responde, ou a referência é NÃO CONSULTADA (nunca "ausente")', () => {
  const REL = 'db/authz-carimbo-prod.json';
  /**
   * Os argumentos EXATOS de cada subcomando. O falso de antes indexava só pelo subcomando: um refactor
   * que trocasse `origin/main` por `main` ou `HEAD` passava verde — e, com `HEAD`, apagar e commitar o
   * arquivo virava nascimento de novo (revisão independente de 2026-10-05). Argumento inesperado LANÇA.
   */
  const ESPERADOS: Record<string, readonly string[]> = {
    fetch: ['fetch', 'origin', 'main', '--quiet'],
    'ls-tree': ['ls-tree', '--name-only', 'origin/main', '--', REL],
    show: ['show', `origin/main:${REL}`],
  };
  /** Um git falso: confere os argumentos, anota a chamada e devolve o texto dado — ou LANÇA o Error dado. */
  const gitFalso = (resp: Record<string, string | Error>, chamadas: string[][] = []) => (args: readonly string[]) => {
    chamadas.push([...args]);
    if (JSON.stringify(args) !== JSON.stringify(ESPERADOS[args[0]])) throw new Error(`git falso: argumentos inesperados ${JSON.stringify(args)}`);
    const respostas: Record<string, string | Error | undefined> = { fetch: '', ...resp };
    const r = respostas[args[0]];
    if (r === undefined) throw new Error(`git falso sem resposta para ${args[0]}`);
    if (r instanceof Error) throw r;
    return r;
  };

  it('CONTROLE: fetch, ls-tree e show da origin/main, nessa ordem e com esses argumentos => presente, pela MESMA porta', () => {
    const chamadas: string[][] = [];
    const l = lerReferenciaDaMain(gitFalso({ 'ls-tree': `${REL}\n`, show: JSON.stringify(comDivida()) }, chamadas), REL);
    expect(l.ok && l.referencia.estado === 'presente' ? l.referencia.carimbo : 'NAO').toEqual(lido(JSON.stringify(comDivida())));
    expect(chamadas).toEqual([ESPERADOS.fetch, ESPERADOS['ls-tree'], ESPERADOS.show]);
  });

  it('ref válida SEM o arquivo (ls-tree vazio, rc 0) => ausente (e quem recusa é combinarAnteriores)', () => {
    expect(lerReferenciaDaMain(gitFalso({ 'ls-tree': '' }), REL)).toEqual({ ok: true, referencia: { estado: 'ausente' } });
  });

  // A referência era a origin/main do ÚLTIMO fetch da worktree — e o audit `corpo`, que o mesmo gravador
  // roda logo depois, faz o fetch e grava "ref origin/main@<outro sha>" no MESMO carimbo: duas mains num
  // artefato só (revisão independente de 2026-10-05). Sem rede não há referência — recusa, não main velha.
  it('git que FALHA (sem rede, ref inexistente, repo quebrado) => nao-consultada — jamais ausente', () => {
    const falhas: [string, Record<string, string | Error>][] = [
      ['fetch', { fetch: new Error('fatal: unable to access github.com') }],
      ['ls-tree', { 'ls-tree': new Error('fatal: Not a valid object name origin/main') }],
      ['show', { 'ls-tree': `${REL}\n`, show: new Error('fatal: bad revision') }],
    ];
    for (const [passo, resp] of falhas) {
      const l = lerReferenciaDaMain(gitFalso(resp), REL);
      expect(l.ok && l.referencia.estado === 'nao-consultada' ? l.referencia.motivo : 'OUTRO', passo).toContain(`git ${passo}`);
    }
  });

  // Main mais NOVA que este código = worktree desatualizada: gravar por cima seria o downgrade.
  it('carimbo da main recusado pela porta => a recusa SOBE, com a origem no motivo', () => {
    const l = lerReferenciaDaMain(gitFalso({ 'ls-tree': `${REL}\n`, show: JSON.stringify({ ...comDivida(), schemaVersion: SCHEMA_VERSION + 1 }) }), REL);
    expect(l.ok ? 'ACEITOU' : l.codigo).toBe('CARIMBO_ANTERIOR_SCHEMA_INCOMPATIVEL');
    expect(l.ok ? '' : l.motivo).toContain('(o carimbo da origin/main)');
    expect(referenciaDoTexto('null').ok).toBe(false);
  });
});

describe('montarCarimbo — a trava e a herança fora do binário (que para na guarda de env por construção)', () => {
  const AGORA_ISO = '2026-10-05T12:00:00.000Z';
  const ALVO_PROD: Carimbo['alvo'] = { usuario: 'claude_ro', servidor: 'PostgreSQL 17.6', somenteLeitura: true, projetoHash: PROJETO_HASH_PROD };
  const limpas = (): Record<ChaveAudit, ExecucaoDeAudit> => {
    const o = {} as Record<ChaveAudit, ExecucaoDeAudit>;
    for (const k of CHAVES) o[k] = { exit: 0, linhas: [`✅ ${k}: limpo`] };
    return o;
  };
  const montar = (over: Partial<Parameters<typeof montarCarimbo>[0]> = {}) =>
    montarCarimbo({ alvo: ALVO_PROD, execucoes: limpas(), heranca: [], fps: fpsBons(), agora: AGORA_ISO, sourceHead: 'cafe', semente: {}, ...over });
  const montado = (over: Partial<Parameters<typeof montarCarimbo>[0]> = {}): Carimbo => {
    const r = montar(over);
    if (!r.ok) throw new Error(`RECUSOU ${r.codigo}: ${r.motivo}`);
    return r.carimbo;
  };

  // CONTROLE e IDA E VOLTA: o que o gravador monta, a porta relê e o gate aprova — o contrato entre os três.
  it('CONTROLE: medição limpa de prod vira carimbo que a porta relê e o gate aprova sem veredito', () => {
    const c = montado();
    expect(avaliarCarimbo(c, new Date(AGORA_ISO), fpsBons())).toEqual([]);
    expect(lido(JSON.stringify(c))).toEqual({ schemaVersion: SCHEMA_VERSION, achados: Object.fromEntries(CHAVES.map((k) => [k, []])) });
  });

  // A fiação que o binário não alcança: sem a trava aqui, a montagem gravaria evidência de outro banco, e
  // o gate só a barraria depois do commit (revisão independente de 2026-10-05).
  it('sonda de OUTRO cluster => CARIMBO_OUTRO_CLUSTER, e nenhum carimbo', () => {
    const r = montar({ alvo: { ...ALVO_PROD, projetoHash: 'deadbeefdeadbeef' } });
    expect(r.ok ? 'MONTOU' : r.codigo).toBe('CARIMBO_OUTRO_CLUSTER');
  });

  it('a herança chega ao carimbo: o achado vivo fica com a primeiraVez da main — e a ida e volta a preserva', () => {
    const ID = idFinding('grants', LINHA_GRANTS);
    const execucoes = { ...limpas(), grants: { exit: 1, linhas: ['🔎 denominador', LINHA_GRANTS] } };
    const c = montado({ execucoes, heranca: [lido(JSON.stringify(comDivida('2026-08-13')))] });
    expect(c.audits.grants.achados).toEqual([{ id: ID, linha: LINHA_GRANTS, primeiraVez: '2026-08-13', ultimaVez: '2026-10-05' }]);
    expect(lido(JSON.stringify(c)).achados.grants).toEqual([{ id: ID, primeiraVez: '2026-08-13' }]);
    expect(avaliarCarimbo(c, new Date(AGORA_ISO), fpsBons()).map((v) => v.mensagem).join(' ')).toContain('aberto desde 2026-08-13');
  });
});

describe('lerArquivoDoCarimbo — erro de leitura é recusa, nunca exceção solta (exit 1)', () => {
  it('CONTROLE: arquivo que existe devolve o texto; arquivo que não existe devolve null', () => {
    const r = lerArquivoDoCarimbo(CARIMBO_PATH);
    expect(r.ok && typeof r.texto === 'string' && r.texto.length > 0).toBe(true);
    expect(lerArquivoDoCarimbo(join(RAIZ, 'db', 'nao-existe-carimbo.json'))).toEqual({ ok: true, texto: null });
  });

  it('caminho que é DIRETÓRIO (EISDIR) => CARIMBO_ANTERIOR_ILEGIVEL com o código do erro', () => {
    const r = lerArquivoDoCarimbo(join(RAIZ, 'db'));
    expect(r.ok ? 'ACEITOU' : r.codigo).toBe('CARIMBO_ANTERIOR_ILEGIVEL');
    expect(r.ok ? '' : r.motivo).toContain('(EISDIR)');
  });
});

describe('CHAVES_RELIDAS_POR_VERSAO — a janela que o gravador relê acompanha o bump', () => {
  it('é a versão de HOJE e a IMEDIATAMENTE ANTERIOR — nem uma a mais, nem uma a menos', () => {
    expect(Object.keys(CHAVES_RELIDAS_POR_VERSAO).map(Number).sort((a, b) => a - b)).toEqual([SCHEMA_VERSION - 1, SCHEMA_VERSION]);
  });

  it('as chaves da versão de HOJE são exatamente as de AUDITS — audit novo sem bump fica vermelho aqui', () => {
    expect([...CHAVES_RELIDAS_POR_VERSAO[SCHEMA_VERSION]].sort()).toEqual([...CHAVES].sort());
  });

  it('a fixture da versão anterior é a da tabela — e ela anda junto com o bump', () => {
    expect(ANTERIOR_A_DE_HOJE.versao, 'no bump, a fixture passa a ser a forma REAL da versão que deixou de ser a de hoje').toBe(SCHEMA_VERSION - 1);
    expect([...CHAVES_RELIDAS_POR_VERSAO[SCHEMA_VERSION - 1]].sort()).toEqual([...ANTERIOR_A_DE_HOJE.chaves].sort());
  });
});

describe('o BINÁRIO do gravador contra anterior recusado — exit 2 com o código, antes de qualquer sonda de prod', () => {
  // HERMÉTICO e sem caminho até prod, por DOIS cintos independentes:
  //  1. a costura `AUTHZ_CARIMBO_ANTERIOR_TEST_JSON` casa `envDeTesteSetadas`: a guarda SEGUINTE à
  //     leitura do anterior aborta o runner, que nunca chega à sonda nem à escrita;
  //  2. HOME de mentira: o `psql-ro` de prod mora em `~/.config/afiacao/` — com HOME num tmp, nem existe.
  let home = '';
  beforeAll(() => {
    home = mkdtempSync(join(tmpdir(), 'carimbo-gravar-'));
  });
  afterAll(() => rmSync(home, { recursive: true, force: true }));

  /** `spawn` ASSÍNCRONO: `spawnSync` seguraria o event loop do worker pelo tempo do filho. */
  const gravadorCom = (anterior: string, main: string = JSON.stringify(comDivida())): Promise<{ status: number | null; saida: string }> => {
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) {
      if (v !== undefined && k !== 'PSQL_RO' && !/_TEST_JSON$/.test(k)) env[k] = v;
    }
    env.HOME = home;
    env.AUTHZ_CARIMBO_ANTERIOR_TEST_JSON = anterior;
    env.AUTHZ_CARIMBO_MAIN_TEST_JSON = main;
    return new Promise((ok, falha) => {
      const filho = spawn('bun', [join(RAIZ, 'db', 'authz-carimbo-gravar.ts')], { cwd: RAIZ, env, stdio: ['ignore', 'pipe', 'pipe'] });
      let saida = '';
      filho.stdout.setEncoding('utf8').on('data', (d: string) => (saida += d));
      filho.stderr.setEncoding('utf8').on('data', (d: string) => (saida += d));
      filho.on('error', falha);
      filho.on('close', (status) => ok({ status, saida }));
    });
  };
  /** O que o gravador imprime ao TENTAR a sonda (falha) ou depois dela (alvo). Nenhum caso aqui chega lá. */
  const CHEGOU_NA_SONDA = /sonda de alvo|read-only=/;

  // O CONTROLE, na MESMA execução dos vermelhos: um runner que recusasse todo anterior aprovaria todos eles.
  it('CONTROLE: anterior válido passa pela porta e o runner para na guarda SEGUINTE (a env de teste)', async () => {
    const r = await gravadorCom(JSON.stringify(comDivida()));
    expect(r.status, r.saida.slice(-1500)).toBe(2);
    expect(r.saida).toContain('AUTHZ_CARIMBO_ANTERIOR_TEST_JSON');
    expect(r.saida).not.toContain('CARIMBO-ANTERIOR-RECUSADO');
    expect(r.saida).not.toMatch(CHEGOU_NA_SONDA);
  }, 60_000);

  it.each([
    ['versão futura', () => JSON.stringify({ ...comDivida(), schemaVersion: SCHEMA_VERSION + 1 }), 'CARIMBO_ANTERIOR_SCHEMA_INCOMPATIVEL'],
    ['primeiraVez fora do calendário', () => comAudits((a) => { (a.grants.achados as Record<string, unknown>[])[0].primeiraVez = '2026-13-45'; }), 'CARIMBO_ANTERIOR_MALFORMADO'],
    ['JSON ilegível', () => '{ nao e json', 'CARIMBO_ANTERIOR_ILEGIVEL'],
    ['raiz null', () => 'null', 'CARIMBO_ANTERIOR_MALFORMADO'],
  ])('%s: exit 2 com CARIMBO-ANTERIOR-RECUSADO e o código — antes da sonda', async (_rot, texto, codigo) => {
    const r = await gravadorCom(texto());
    expect(r.status, r.saida.slice(-1500)).toBe(2);
    expect(r.saida).toContain(`CARIMBO-ANTERIOR-RECUSADO ${codigo} `);
    expect(r.saida).not.toMatch(CHEGOU_NA_SONDA);
  }, 60_000);

  // A referência também é lida ANTES da sonda, pela mesma porta: main mais nova que o código é a
  // worktree desatualizada, e gravar por cima seria o downgrade.
  it.each([
    ['main de versão futura', () => JSON.stringify({ ...comDivida(), schemaVersion: SCHEMA_VERSION + 1 }), 'CARIMBO_ANTERIOR_SCHEMA_INCOMPATIVEL'],
    ['main fora da forma', () => JSON.stringify({ ...comDivida(), audits: [] }), 'CARIMBO_ANTERIOR_MALFORMADO'],
  ])('%s: exit 2 com o código e a ORIGEM no motivo — antes da sonda', async (_rot, main, codigo) => {
    const r = await gravadorCom(JSON.stringify(comDivida()), main());
    expect(r.status, r.saida.slice(-1500)).toBe(2);
    expect(r.saida).toContain(`CARIMBO-ANTERIOR-RECUSADO ${codigo} - (o carimbo da origin/main)`);
    expect(r.saida).not.toMatch(CHEGOU_NA_SONDA);
  }, 60_000);
});

describe('a CLASSE — o carimbo commitado só é relido por porta que confere a versão', () => {
  // `JSON.parse(...) as Carimbo` lê um carimbo de outro formato como o de hoje: o defeito do gravador
  // (2026-10-01), irmão do da matriz do `exclusividade` (#2575). Os testes de comportamento acima só
  // vigiam os leitores que existem; um leitor novo com cast reabriria a classe calado.
  const GATE = 'scripts/authz-carimbo-gate.ts';
  const GRAVADOR = 'db/authz-carimbo-gravar.ts';
  const NUCLEO = 'scripts/lib/authz-carimbo.ts';
  const fontes = () =>
    ['scripts', 'db'].flatMap((dir) =>
      readdirSync(join(RAIZ, dir), { recursive: true, encoding: 'utf8' })
        .filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'))
        .map((f) => `${dir}/${f}`),
    );
  const limpa = (rel: string) => removerComentarios(readFileSync(join(RAIZ, rel), 'utf8'));
  /** O cast, e a ANOTAÇÃO que faz o mesmo sobre o `any` do `JSON.parse` — esta vale para todo arquivo,
   *  inclusive o que monta o caminho sem nomear o carimbo (revisão independente de 2026-10-05). */
  const CAST = /\bas\s+Carimbo\b|:\s*Carimbo\b\s*(?:=|=>)\s*(?:JSON\.parse|await|require\(|Bun\.file)/;

  it('nenhum leitor faz cast para `Carimbo` (nem por anotação), exceto o gate — que confere a versão em avaliarCarimbo antes de ler campo', () => {
    expect(fontes().filter((f) => f !== GATE && CAST.test(limpa(f)))).toEqual([]);
    // a regex enxerga as duas formas — senão o scan acima passaria por cegueira
    for (const t of ['const c = JSON.parse(t) as Carimbo;', 'const c: Carimbo = JSON.parse(t);', 'const f = (): Carimbo => JSON.parse(t);']) expect(CAST.test(t), t).toBe(true);
  });

  // O núcleo ficava FORA dos scans de baixo (é onde mora a porta): um leitor novo escrito DENTRO dele, com
  // anotação em vez de cast, passava (revisão independente de 2026-10-05). JSON.parse novo no núcleo: se lê
  // o carimbo, passe pela porta; se não, ajuste a contagem com o porquê.
  it('o núcleo faz JSON.parse num lugar só — a porta', () => {
    expect(limpa(NUCLEO).match(/\bJSON\.parse\(/g) ?? []).toHaveLength(1);
    expect(limpa(NUCLEO)).toMatch(/export function lerCarimboAnterior\([\s\S]*?\bJSON\.parse\(texto\)/);
  });

  // `as Carimbo` não é a única forma do cast: `const c: Carimbo = JSON.parse(t)` e `(): Carimbo => JSON.parse(t)`
  // compilam igual (`JSON.parse` devolve `any`) e a regex acima não os vê (revisão adversarial, achado C).
  // Toda forma passa por `JSON.parse` — então quem nomeia o carimbo não o chama: só a porta (o núcleo) e o gate.
  it('nenhum arquivo que nomeia o carimbo commitado faz JSON.parse, exceto o gate', () => {
    const nomeiam = fontes().filter((f) => f !== NUCLEO && /CARIMBO_PATH|authz-carimbo-prod\.json/.test(limpa(f)));
    expect(nomeiam.filter((f) => f !== GATE && /\bJSON\.parse\(/.test(limpa(f)))).toEqual([]);
  });

  it('todo arquivo que nomeia o carimbo commitado passa o texto por uma porta (lerCarimboAnterior | avaliarCarimbo)', () => {
    const leitores = fontes().filter((f) => f !== NUCLEO && /CARIMBO_PATH|authz-carimbo-prod\.json/.test(limpa(f)));
    expect(leitores.filter((f) => !/\b(lerCarimboAnterior|avaliarCarimbo)\(/.test(limpa(f)))).toEqual([]);
  });

  // A fiação do gravador que nenhum teste de comportamento alcança (o binário para na guarda de env): a
  // herança COMBINADA tem de chegar à montagem. TRIPWIRE de texto — prova presença, não controle: pega o
  // refactor honesto que troca a herança por `[]`; o comportamento é provado em montarCarimbo, acima.
  it('o gravador monta o carimbo por montarCarimbo, com a herança que combinarAnteriores devolveu', () => {
    const g = limpa(GRAVADOR);
    expect(g).toMatch(/\bconst combinados = combinarAnteriores\(/);
    expect(g).toMatch(/\bmontarCarimbo\(\{[^}]*\bheranca: combinados\.heranca\b/);
  });

  // Sem este, os scans acima passariam por CEGUEIRA: glob que parou de casar, ou limpeza que comeu o código.
  it('SENTINELA: o scan enxerga o gravador e o gate, cada um passa pela sua porta, e a exceção do gate é real', () => {
    const lista = fontes();
    expect(lista).toContain(GRAVADOR);
    expect(lista).toContain(GATE);
    expect(limpa(GRAVADOR)).toMatch(/\blerCarimboAnterior\(/);
    expect(limpa(GATE)).toMatch(/\bavaliarCarimbo\(/);
    // Se o gate deixar de fazer cast, a exceção acima vira letra morta: tire-a junto.
    expect(limpa(GATE)).toMatch(/\bas\s+Carimbo\b/);
    expect(limpa(GATE)).toMatch(/\bJSON\.parse\(/);
    expect(limpa(GRAVADOR)).not.toMatch(/\bJSON\.parse\(/);
  });
});
