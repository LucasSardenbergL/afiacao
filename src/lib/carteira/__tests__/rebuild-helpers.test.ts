// src/lib/carteira/__tests__/rebuild-helpers.test.ts
import { describe, it, expect } from 'vitest';
import { computeCarteira, coerceCodigoVendedor, montarClientes, avaliarGuardProof, avaliarGuardResultado, parseBaselineSaudavel, extrairQuarantinados, aplicarMascaras } from '../rebuild-helpers';

const HUNTER = 'hunter-uid';

describe('computeCarteira (legado — aliasMap vazio)', () => {
  it('código mapeado p/ 1 vendedor → assignment source=omie, eligible=true', () => {
    const r = computeCarteira(
      [{ customer_user_id: 'c1', omie_codigo_vendedor: 10 }],
      [{ omie_codigo_vendedor: 10, user_id: 'regina' }],
      HUNTER,
    );
    expect(r.assignments).toEqual([
      { customer_user_id: 'c1', owner_user_id: 'regina', source: 'omie', omie_codigo_vendedor: 10, eligible: true },
    ]);
    expect(r.conflicts).toHaveLength(0);
    expect(r.orphanCount).toBe(0);
  });

  it('código null → órfão vai pro Hunter (hunter_orphan), eligible=true', () => {
    const r = computeCarteira(
      [{ customer_user_id: 'c2', omie_codigo_vendedor: null }],
      [{ omie_codigo_vendedor: 10, user_id: 'regina' }],
      HUNTER,
    );
    expect(r.assignments).toEqual([
      { customer_user_id: 'c2', owner_user_id: HUNTER, source: 'hunter_orphan', omie_codigo_vendedor: null, eligible: true },
    ]);
    expect(r.orphanCount).toBe(1);
  });

  it('código presente mas NÃO mapeado → órfão vai pro Hunter, preserva o código', () => {
    const r = computeCarteira(
      [{ customer_user_id: 'c3', omie_codigo_vendedor: 99 }],
      [{ omie_codigo_vendedor: 10, user_id: 'regina' }],
      HUNTER,
    );
    expect(r.assignments[0]).toEqual({
      customer_user_id: 'c3', owner_user_id: HUNTER, source: 'hunter_orphan', omie_codigo_vendedor: 99, eligible: true,
    });
    expect(r.orphanCount).toBe(1);
  });

  it('código que mapeia p/ 2 vendedores distintos → conflito, sem assignment', () => {
    const r = computeCarteira(
      [{ customer_user_id: 'c4', omie_codigo_vendedor: 10 }],
      [
        { omie_codigo_vendedor: 10, user_id: 'regina' },
        { omie_codigo_vendedor: 10, user_id: 'tati' },
      ],
      HUNTER,
    );
    expect(r.assignments).toHaveLength(0);
    expect(r.conflicts).toEqual([
      { customer_user_id: 'c4', omie_codigo_vendedor: 10, candidate_user_ids: ['regina', 'tati'] },
    ]);
  });

  it('sem Hunter (null) → órfão é contado mas não vira assignment', () => {
    const r = computeCarteira(
      [{ customer_user_id: 'c5', omie_codigo_vendedor: null }],
      [],
      null,
    );
    expect(r.assignments).toHaveLength(0);
    expect(r.orphanCount).toBe(1);
  });
});

describe('computeCarteira (B-lite — canonicalização clone→gêmeo)', () => {
  const find = (r: ReturnType<typeof computeCarteira>, id: string) =>
    r.assignments.find((a) => a.customer_user_id === id);

  it('clone (com vendedor) + gêmeo (órfão) → gêmeo herda o vendedor e fica eligible=true; clone eligible=false', () => {
    const r = computeCarteira(
      [
        { customer_user_id: 'clone', omie_codigo_vendedor: 10 }, // cadastro Colacor SC, vendedor=regina
        { customer_user_id: 'gemeo', omie_codigo_vendedor: null }, // cadastro Oben, sem vendedor (com nome)
      ],
      [{ omie_codigo_vendedor: 10, user_id: 'regina' }],
      HUNTER,
      new Map([['clone', 'gemeo']]),
    );
    // gêmeo (canônico) vira o cliente visível, dono = vendedora do clone
    expect(find(r, 'gemeo')).toEqual({
      customer_user_id: 'gemeo', owner_user_id: 'regina', source: 'omie', omie_codigo_vendedor: 10, eligible: true,
    });
    // clone escondido (preservado)
    expect(find(r, 'clone')).toEqual({
      customer_user_id: 'clone', owner_user_id: 'regina', source: 'omie', omie_codigo_vendedor: 10, eligible: false,
    });
    expect(r.orphanCount).toBe(0); // o gêmeo deixou de ser órfão
  });

  it('cliente normal (fora do aliasMap) é inalterado e eligible=true', () => {
    const r = computeCarteira(
      [
        { customer_user_id: 'clone', omie_codigo_vendedor: 10 },
        { customer_user_id: 'gemeo', omie_codigo_vendedor: null },
        { customer_user_id: 'normal', omie_codigo_vendedor: 20 },
      ],
      [
        { omie_codigo_vendedor: 10, user_id: 'regina' },
        { omie_codigo_vendedor: 20, user_id: 'tati' },
      ],
      HUNTER,
      new Map([['clone', 'gemeo']]),
    );
    expect(find(r, 'normal')).toEqual({
      customer_user_id: 'normal', owner_user_id: 'tati', source: 'omie', omie_codigo_vendedor: 20, eligible: true,
    });
  });

  it('gêmeo com vendedor próprio + clone com OUTRO vendedor → conflito: NÃO canonicaliza, ambos VISÍVEIS (eligible=true)', () => {
    const r = computeCarteira(
      [
        { customer_user_id: 'clone', omie_codigo_vendedor: 10 }, // vendedor=regina
        { customer_user_id: 'gemeo', omie_codigo_vendedor: 20 }, // vendedor=tati (≠)
      ],
      [
        { omie_codigo_vendedor: 10, user_id: 'regina' },
        { omie_codigo_vendedor: 20, user_id: 'tati' },
      ],
      HUNTER,
      new Map([['clone', 'gemeo']]),
    );
    // fail-closed SEGURO: cada membro vira cliente normal visível, nenhum escondido stale
    expect(find(r, 'clone')).toEqual({
      customer_user_id: 'clone', owner_user_id: 'regina', source: 'omie', omie_codigo_vendedor: 10, eligible: true,
    });
    expect(find(r, 'gemeo')).toEqual({
      customer_user_id: 'gemeo', owner_user_id: 'tati', source: 'omie', omie_codigo_vendedor: 20, eligible: true,
    });
    expect(r.conflicts).toEqual([
      { customer_user_id: 'gemeo', omie_codigo_vendedor: 10, candidate_user_ids: ['regina', 'tati'] },
    ]);
  });

  it('cadeia A→B→C (canônico que também é alias) → chainViolations não-vazio (caller deve abortar)', () => {
    const r = computeCarteira(
      [
        { customer_user_id: 'a', omie_codigo_vendedor: 10 },
        { customer_user_id: 'b', omie_codigo_vendedor: null },
        { customer_user_id: 'c', omie_codigo_vendedor: null },
      ],
      [{ omie_codigo_vendedor: 10, user_id: 'regina' }],
      HUNTER,
      new Map([['a', 'b'], ['b', 'c']]), // 'b' é canônico de 'a' MAS também é alias → cadeia
    );
    expect(r.chainViolations).toContain('a');
  });

  it('clone órfão (sem vendedor) + gêmeo órfão → canônico vira hunter; clone escondido no hunter', () => {
    const r = computeCarteira(
      [
        { customer_user_id: 'clone', omie_codigo_vendedor: null },
        { customer_user_id: 'gemeo', omie_codigo_vendedor: null },
      ],
      [],
      HUNTER,
      new Map([['clone', 'gemeo']]),
    );
    expect(find(r, 'gemeo')).toEqual({
      customer_user_id: 'gemeo', owner_user_id: HUNTER, source: 'hunter_orphan', omie_codigo_vendedor: null, eligible: true,
    });
    expect(find(r, 'clone')).toEqual({
      customer_user_id: 'clone', owner_user_id: HUNTER, source: 'hunter_orphan', omie_codigo_vendedor: null, eligible: false,
    });
  });
});

// ── P0-B-bis ponta 2/2: load lê o vendedor da PROOF oben (não do espelho poluído) ──
// O vendedor vem de omie_customer_account_map_fresco(account='oben') via lookup por user_id.
// A LISTA de membros continua do espelho (preserva a herança B-lite); só a FONTE do vendedor muda.

describe('coerceCodigoVendedor (bigint-safe — leitura da proof via PostgREST)', () => {
  it('inteiro positivo seguro → o próprio número', () => {
    expect(coerceCodigoVendedor(10)).toBe(10);
  });
  it('string numérica (PostgREST pode devolver bigint como string) → number', () => {
    expect(coerceCodigoVendedor('42')).toBe(42);
  });
  it('0 → null (0 = "sem vendedor" explícito, não é código válido)', () => {
    expect(coerceCodigoVendedor(0)).toBeNull();
    expect(coerceCodigoVendedor('0')).toBeNull();
  });
  it('negativo → null', () => {
    expect(coerceCodigoVendedor(-5)).toBeNull();
  });
  it('não-inteiro → null', () => {
    expect(coerceCodigoVendedor(1.5)).toBeNull();
  });
  it('acima de 2^53 (bigint inseguro) → null — não casar por precisão perdida com outro vendedor', () => {
    expect(coerceCodigoVendedor(Number.MAX_SAFE_INTEGER + 2)).toBeNull();
    expect(coerceCodigoVendedor('90071992547409920')).toBeNull(); // > 2^53
  });
  it('null / undefined / string não-numérica → null', () => {
    expect(coerceCodigoVendedor(null)).toBeNull();
    expect(coerceCodigoVendedor(undefined)).toBeNull();
    expect(coerceCodigoVendedor('abc')).toBeNull();
    expect(coerceCodigoVendedor('')).toBeNull();
  });
  it('rejeita strings NÃO-canônicas antes de converter (P2 Codex: hex/exp/decimal-lossy/sinal/espaços)', () => {
    expect(coerceCodigoVendedor('0x2a')).toBeNull();   // hex → NÃO 42
    expect(coerceCodigoVendedor('1e3')).toBeNull();    // exponencial → NÃO 1000
    expect(coerceCodigoVendedor('42.0000000000000001')).toBeNull(); // lossy → NÃO 42
    expect(coerceCodigoVendedor('42.0')).toBeNull();   // decimal → não é inteiro canônico
    expect(coerceCodigoVendedor(' 42 ')).toBeNull();   // espaços
    expect(coerceCodigoVendedor('+42')).toBeNull();    // sinal
    expect(coerceCodigoVendedor('4_2')).toBeNull();    // separador
  });
});

describe('montarClientes (merge lista-do-espelho × vendedor-da-proof)', () => {
  it('id do espelho com vendedor na proof → usa o código da proof', () => {
    expect(montarClientes(['a'], new Map([['a', 10]]))).toEqual([
      { customer_user_id: 'a', omie_codigo_vendedor: 10 },
    ]);
  });
  it('id do espelho AUSENTE da proof (ex.: clone sem document) → vendedor null', () => {
    expect(montarClientes(['clone'], new Map())).toEqual([
      { customer_user_id: 'clone', omie_codigo_vendedor: null },
    ]);
  });
  it('preserva a ordem do espelho (determinismo de paginação)', () => {
    expect(montarClientes(['b', 'a'], new Map([['a', 1], ['b', 2]]))).toEqual([
      { customer_user_id: 'b', omie_codigo_vendedor: 2 },
      { customer_user_id: 'a', omie_codigo_vendedor: 1 },
    ]);
  });
  it('espelho vazio → []', () => {
    expect(montarClientes([], new Map([['a', 1]]))).toEqual([]);
  });
});

describe('avaliarGuardProof (fail-closed pré-compute: proof oben anômala → abortar antes de escrever)', () => {
  it('estado saudável (fresca ≈ crua, com vendedores) → não aborta', () => {
    expect(avaliarGuardProof({ proofCrua: 5238, proofFresca: 5238, comVendedor: 1000 }))
      .toEqual({ abortar: false, motivo: null });
  });
  it('proof oben fresca VAZIA (expirou 7d / sync parou) → aborta', () => {
    const r = avaliarGuardProof({ proofCrua: 5238, proofFresca: 0, comVendedor: 0 });
    expect(r.abortar).toBe(true);
    expect(r.motivo).toMatch(/vazia/i);
  });
  it('fresca < 50% da CRUA (TTL/sync degradou) → aborta — denominador é a proof, NÃO o espelho (#4 Codex)', () => {
    const r = avaliarGuardProof({ proofCrua: 5238, proofFresca: 2000, comVendedor: 1000 });
    expect(r.abortar).toBe(true);
    expect(r.motivo).toMatch(/crua|50%/i);
  });
  it('crescimento do espelho NÃO dispara o guard (fresca≈crua) — corrige o falso-positivo #4', () => {
    // o espelho pode inchar com não-oben; o guard só compara proof oben crua×fresca.
    expect(avaliarGuardProof({ proofCrua: 5238, proofFresca: 5238, comVendedor: 4000 }).abortar).toBe(false);
  });
  it('proof cheia mas ZERO vendedores (ponta 1 não surtiu efeito) → aborta — não zerar a carteira p/ Hunter', () => {
    const r = avaliarGuardProof({ proofCrua: 5238, proofFresca: 5238, comVendedor: 0 });
    expect(r.abortar).toBe(true);
    expect(r.motivo).toMatch(/vendedor/i);
  });
});

describe('avaliarGuardResultado (guard vs BASELINE PERSISTIDO — Codex R3: fecha baseline=0 && atual>0)', () => {
  it('0 omie ELEGÍVEL → aborta sempre (carteira 100% Hunter nunca é gravada)', () => {
    const r = avaliarGuardResultado({ omieElegivelNovo: 0, baselinePersistido: 5000, autorizado: false });
    expect(r.abortar).toBe(true);
    expect(r.motivo).toMatch(/hunter|elegiv/i);
  });
  it('BOOTSTRAP (baseline persistido=0) SEM autorização → aborta INDEPENDENTE da carteira atual (#1 R3)', () => {
    // o buraco fechado: persistência do baseline falhou (=0) mas a carteira atual tem N>0 → NÃO reabre catraca.
    const r = avaliarGuardResultado({ omieElegivelNovo: 100, baselinePersistido: 0, autorizado: false });
    expect(r.abortar).toBe(true);
    expect(r.motivo).toMatch(/bootstrap|autoriza/i);
  });
  it('BOOTSTRAP autorizado (flag explícito) → grava e define o baseline pelo novo', () => {
    const r = avaliarGuardResultado({ omieElegivelNovo: 4200, baselinePersistido: 0, autorizado: true });
    expect(r.abortar).toBe(false);
    expect(r.novoBaseline).toBe(4200);
  });
  it('catraca BLOQUEADA: compara com o baseline persistido (não a carteira atual) — 2399 < 80% de 4797 aborta', () => {
    const r = avaliarGuardResultado({ omieElegivelNovo: 2399, baselinePersistido: 4797, autorizado: false });
    expect(r.abortar).toBe(true);
    expect(r.motivo).toMatch(/regress|baseline|80%/i);
  });
  it('catraca 2º passo: o baseline persistido segue 4797 → 1200 também aborta (sem degradação em série)', () => {
    expect(avaliarGuardResultado({ omieElegivelNovo: 1200, baselinePersistido: 4797, autorizado: false }).abortar).toBe(true);
  });
  it('regime normal saudável (novo ≥ 80% do baseline) → não aborta; baseline sobe (recorde)', () => {
    const r = avaliarGuardResultado({ omieElegivelNovo: 5000, baselinePersistido: 4797, autorizado: false });
    expect(r.abortar).toBe(false);
    expect(r.novoBaseline).toBe(5000);
  });
  it('flutuação dentro de 20% → não aborta; baseline NÃO desce (max — evita catraca)', () => {
    const r = avaliarGuardResultado({ omieElegivelNovo: 4600, baselinePersistido: 4797, autorizado: false });
    expect(r.abortar).toBe(false);
    expect(r.novoBaseline).toBe(4797);
  });
  it('queda legítima grande → só passa com autorização explícita (reset do baseline)', () => {
    expect(avaliarGuardResultado({ omieElegivelNovo: 3000, baselinePersistido: 4797, autorizado: false }).abortar).toBe(true);
    const comAuth = avaliarGuardResultado({ omieElegivelNovo: 3000, baselinePersistido: 4797, autorizado: true });
    expect(comAuth.abortar).toBe(false);
    expect(comAuth.novoBaseline).toBe(3000);
  });
});

describe('parseBaselineSaudavel (valida o baseline lido do company_config — P2 Codex R3)', () => {
  it('decimal canônico válido → número (0 = bootstrap, é VÁLIDO)', () => {
    expect(parseBaselineSaudavel('4797')).toBe(4797);
    expect(parseBaselineSaudavel('0')).toBe(0);
  });
  it('lixo/exp/decimal/negativo/vazio → null (o edge aborta em vez de virar valor inseguro)', () => {
    expect(parseBaselineSaudavel('4797lixo')).toBeNull(); // NÃO 4797
    expect(parseBaselineSaudavel('1e9')).toBeNull();       // NÃO 1
    expect(parseBaselineSaudavel('4797.5')).toBeNull();
    expect(parseBaselineSaudavel('-5')).toBeNull();
    expect(parseBaselineSaudavel('abc')).toBeNull();
    expect(parseBaselineSaudavel('')).toBeNull();
    expect(parseBaselineSaudavel(null)).toBeNull();
    expect(parseBaselineSaudavel(undefined)).toBeNull();
  });
  it('acima de 2^53 → null (evita Infinity/congelar rebuilds)', () => {
    expect(parseBaselineSaudavel('90071992547409920')).toBeNull();
  });
});

describe('herança B-lite via proof (integração — P1 #1): clone AUSENTE da proof herda do gêmeo', () => {
  it('gêmeo tem vendedor oben na proof; clone (fora da proof) é membro e fica eligible=false', () => {
    // Produção: o clone (cadastro sem document) NÃO está na proof → vendedor null; o gêmeo (oben) tem.
    const espelhoIds = ['clone', 'gemeo'];
    const proofOben = new Map<string, number | null>([['gemeo', 20]]); // clone ausente
    const clientes = montarClientes(espelhoIds, proofOben);
    const r = computeCarteira(
      clientes,
      [{ omie_codigo_vendedor: 20, user_id: 'tati' }],
      HUNTER,
      new Map([['clone', 'gemeo']]),
    );
    const find = (id: string) => r.assignments.find((a) => a.customer_user_id === id);
    // O QUE IMPORTA: o gêmeo mantém o vendedor oben (não vira Hunter — herança de AGRUPAMENTO preservada).
    expect(find('gemeo')).toEqual({
      customer_user_id: 'gemeo', owner_user_id: 'tati', source: 'omie', omie_codigo_vendedor: 20, eligible: true,
    });
    // clone preservado como membro ESCONDIDO (eligible=false → filtrado por fetchCarteiraClientes;
    // não some, não fica stale). Como não tem vendedor próprio na proof, o registro morto vai p/ hunter —
    // irrelevante p/ comissão/tela (eligible=false), mas prova que o clone NÃO é apagado.
    expect(find('clone')).toEqual({
      customer_user_id: 'clone', owner_user_id: HUNTER, source: 'hunter_orphan', omie_codigo_vendedor: null, eligible: false,
    });
    expect(r.orphanCount).toBe(0); // o gêmeo não é órfão; o clone escondido não infla a métrica
  });
});

// ── P0-B-bis Fatia 2 — quarantine de identidade ambígua.
// Hoje um doc ambíguo é deletado da proof pelo sync → o rebuild vê vendedor null → o cliente cai no Hunter
// com eligible=TRUE → comissão sobre um cliente cuja identidade NÃO sabemos. O quarantine derruba o eligible
// preservando o membro. O que NÃO se pode fazer é tirá-lo da LISTA: o upsert-only não reconcilia ausentes
// (onConflict customer_user_id, sem DELETE) → o assignment antigo persistiria STALE (vendedor errado, válido).
describe('extrairQuarantinados (Fatia 2 — consumo FAIL-CLOSED de identity_state)', () => {
  it('verified → NÃO quarantina (o caso de 100% da produção hoje: 6909/6909)', () => {
    expect(extrairQuarantinados([{ user_id: 'u1', identity_state: 'verified' }])).toEqual(new Set());
  });

  it('ambiguous → quarantina (o único estado que a Fatia 2 popula)', () => {
    expect(extrairQuarantinados([{ user_id: 'u1', identity_state: 'ambiguous' }])).toEqual(new Set(['u1']));
  });

  it('FAIL-CLOSED: estados que a Fatia 2 não popula (inactive/conflict) já quarantinam', () => {
    // D2: consumimos `!== verified`, não `=== ambiguous`. Se um gatilho real de inactive/conflict aparecer,
    // a rede já está armada — em vez de falhar ABERTO (cliente de identidade dúbia pagando comissão).
    const r = extrairQuarantinados([
      { user_id: 'a', identity_state: 'inactive' },
      { user_id: 'b', identity_state: 'conflict' },
    ]);
    expect(r).toEqual(new Set(['a', 'b']));
  });

  it('FAIL-CLOSED: null/undefined/estado desconhecido quarantinam (nunca vira verified por omissão)', () => {
    const r = extrairQuarantinados([
      { user_id: 'a', identity_state: null },
      { user_id: 'b', identity_state: undefined as unknown as string },
      { user_id: 'c', identity_state: 'estado_futuro_qualquer' },
      { user_id: 'd', identity_state: 'Verified' }, // case-sensitive de propósito: só o literal exato passa
      { user_id: 'e', identity_state: ' verified' }, // idem — espaço não é verified
    ]);
    expect(r).toEqual(new Set(['a', 'b', 'c', 'd', 'e']));
  });

  it('lista mista → só os não-verified entram', () => {
    const r = extrairQuarantinados([
      { user_id: 'ok1', identity_state: 'verified' },
      { user_id: 'amb', identity_state: 'ambiguous' },
      { user_id: 'ok2', identity_state: 'verified' },
    ]);
    expect(r).toEqual(new Set(['amb']));
  });

  it('lista vazia → set vazio (ledger vazio degrada p/ comportamento de hoje, aditivo)', () => {
    expect(extrairQuarantinados([])).toEqual(new Set());
  });
});

describe('aplicarMascaras (Fatia 2 — quarantine + flaggeds derrubam eligible, NUNCA a presença)', () => {
  const base = [
    { customer_user_id: 'c1', owner_user_id: 'regina', source: 'omie' as const, omie_codigo_vendedor: 10, eligible: true },
    { customer_user_id: 'c2', owner_user_id: HUNTER, source: 'hunter_orphan' as const, omie_codigo_vendedor: null, eligible: true },
  ];

  it('sem máscara nenhuma → passa idêntico (aditivo: 0 ambíguos = comportamento de hoje)', () => {
    expect(aplicarMascaras(base, new Set(), new Set())).toEqual(base);
  });

  it('O INVARIANTE: quarantinado PERMANECE na saída, só com eligible=false', () => {
    const r = aplicarMascaras(base, new Set(), new Set(['c1']));
    // Presença preservada — se sumisse, o upsert-only deixaria o assignment antigo STALE (o furo do A′).
    expect(r).toHaveLength(2);
    expect(r.find((a) => a.customer_user_id === 'c1')).toEqual({
      customer_user_id: 'c1', owner_user_id: 'regina', source: 'omie', omie_codigo_vendedor: 10, eligible: false,
    });
    // e o não-quarantinado fica intocado
    expect(r.find((a) => a.customer_user_id === 'c2')?.eligible).toBe(true);
  });

  it('flagged (fornecedor fora da carteira) continua derrubando eligible — regressão do padrão existente', () => {
    const r = aplicarMascaras(base, new Set(['c2']), new Set());
    expect(r.find((a) => a.customer_user_id === 'c2')?.eligible).toBe(false);
    expect(r.find((a) => a.customer_user_id === 'c1')?.eligible).toBe(true);
  });

  it('flagged E quarantinado compõem (nenhum "ressuscita" o outro)', () => {
    const r = aplicarMascaras(base, new Set(['c1']), new Set(['c1']));
    expect(r.find((a) => a.customer_user_id === 'c1')?.eligible).toBe(false);
  });

  it('eligible=false de origem (clone B-lite) NUNCA é promovido a true pela máscara', () => {
    const clone = [{ customer_user_id: 'clone', owner_user_id: HUNTER, source: 'hunter_orphan' as const, omie_codigo_vendedor: null, eligible: false }];
    expect(aplicarMascaras(clone, new Set(), new Set())[0].eligible).toBe(false);
  });

  it('não muta a entrada (o caller reusa assignments p/ métricas)', () => {
    const entrada = structuredClone(base);
    aplicarMascaras(entrada, new Set(['c1']), new Set(['c1']));
    expect(entrada).toEqual(base);
  });
});

describe('quarantine (integração Fatia 2): doc ambíguo → membro vivo, invisível, ZERO comissão', () => {
  it('o ambíguo (deletado da proof pelo sync) fica no ledger, tem row e NÃO gera comissão', () => {
    // Cenário de produção: `amb` teve o doc ambíguo → o sync o deletou da proof e marcou o ledger.
    // `ok` é saudável. AMBOS continuam na LISTA do ledger (acumulador — nunca encolhe).
    const membroIds = ['amb', 'ok'];
    const proofOben = new Map<string, number | null>([['ok', 10]]); // `amb` foi deletado da proof
    const ledger = [
      { user_id: 'amb', identity_state: 'ambiguous' },
      { user_id: 'ok', identity_state: 'verified' },
    ];

    const clientes = montarClientes(membroIds, proofOben);
    const { assignments } = computeCarteira(clientes, [{ omie_codigo_vendedor: 10, user_id: 'regina' }], HUNTER);
    const rows = aplicarMascaras(assignments, new Set(), extrairQuarantinados(ledger));

    const amb = rows.find((a) => a.customer_user_id === 'amb');
    // 1. o membro NÃO some (senão: assignment antigo STALE = vendedor errado cobrando comissão)
    expect(amb).toBeDefined();
    // 2. zero comissão + invisível: todos os leitores filtram por `WHERE eligible`
    expect(amb?.eligible).toBe(false);
    // 3. sem vendedor (já perdido na proof) — o Hunter recebe a row morta, mas ela é inerte
    expect(amb?.omie_codigo_vendedor).toBeNull();

    // 4. o saudável segue intocado com seu vendedor
    expect(rows.find((a) => a.customer_user_id === 'ok')).toEqual({
      customer_user_id: 'ok', owner_user_id: 'regina', source: 'omie', omie_codigo_vendedor: 10, eligible: true,
    });
  });

  it('CONTRASTE (o que a Fatia 2 conserta): sem o quarantine, o ambíguo iria pro Hunter ELEGÍVEL', () => {
    // Este é o comportamento de HOJE — o teste existe p/ deixar o delta explícito e pegar uma reversão.
    const clientes = montarClientes(['amb'], new Map());
    const { assignments } = computeCarteira(clientes, [{ omie_codigo_vendedor: 10, user_id: 'regina' }], HUNTER);
    expect(assignments[0]).toEqual({
      customer_user_id: 'amb', owner_user_id: HUNTER, source: 'hunter_orphan', omie_codigo_vendedor: null, eligible: true,
    });
    // com o ledger marcando `ambiguous`, o MESMO input vira eligible=false:
    const rows = aplicarMascaras(assignments, new Set(), extrairQuarantinados([{ user_id: 'amb', identity_state: 'ambiguous' }]));
    expect(rows[0].eligible).toBe(false);
  });

  it('ledger 100% verified (a produção de hoje) → saída IDÊNTICA à sem quarantine (aditivo/fail-safe)', () => {
    const clientes = montarClientes(['a', 'b'], new Map<string, number | null>([['a', 10], ['b', 10]]));
    const { assignments } = computeCarteira(clientes, [{ omie_codigo_vendedor: 10, user_id: 'regina' }], HUNTER);
    const ledger = [{ user_id: 'a', identity_state: 'verified' }, { user_id: 'b', identity_state: 'verified' }];
    expect(aplicarMascaras(assignments, new Set(), extrairQuarantinados(ledger))).toEqual(assignments);
  });
});
