import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';

import {
  AVISO_DIAS,
  AUDITS,
  CARIMBO_PATH,
  SCHEMA_VERSION,
  VENCIDO_DIAS,
  avaliarCarimbo,
  canonicalizar,
  fingerprintContrato,
  fingerprintAuditor,
  idFinding,
  type Carimbo,
  type ChaveAudit,
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
    alvo: { usuario: 'claude_ro', servidor: 'PostgreSQL 17.6', somenteLeitura: true, projetoHash: 'abc' },
    audits,
  };
}

const AGORA = new Date('2026-08-26T00:00:00.000Z');
const diasAtras = (d: number) => new Date(AGORA.getTime() - d * 86_400_000).toISOString();
const codigos = (v: { codigo: string }[]) => v.map((x) => x.codigo);

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

  it('difere entre os 3 audits (não há colisão de escopo)', () => {
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
});

// ══════════════════════════════════════════════════════════════════════════════════════════════
// O carimbo COMMITADO. Frescor NÃO é testado aqui de propósito: quem cobra idade é o gate, e um
// teste que envelhece sozinho quebraria a suíte inteira no 15º dia por algo que não é regressão.
// ══════════════════════════════════════════════════════════════════════════════════════════════
describe('db/authz-carimbo-prod.json — o artefato commitado', () => {
  it('existe, parseia e tem os 3 audits com a forma esperada', () => {
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

  it('todo achado registrado tem primeiraVez ≤ ultimaVez (a dívida não pode nascer do futuro)', () => {
    const c = JSON.parse(readFileSync(CARIMBO_PATH, 'utf8')) as Carimbo;
    for (const k of CHAVES) {
      for (const a of c.audits[k].achados) {
        expect(a.primeiraVez <= a.ultimaVez, `${k}/${a.id}`).toBe(true);
      }
    }
  });
});
