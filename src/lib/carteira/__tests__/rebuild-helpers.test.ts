// src/lib/carteira/__tests__/rebuild-helpers.test.ts
import { describe, it, expect } from 'vitest';
import { computeCarteira, coerceCodigoVendedor, montarClientes, avaliarGuardProof, avaliarGuardResultado, parseBaselineSaudavel, extrairQuarantinados, aplicarMascaras, verificarCobertura } from '../rebuild-helpers';

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

  it('código → 2 vendedores distintos → QUARANTINA (hunter_orphan + eligible=false), NÃO omite', () => {
    // Antes: não emitia nada → upsert-only preservava o assignment ANTIGO (stale). Agora o membro é
    // PRESERVADO com eligible=false: zero comissão, invisível, reconciliado. O caller real (edge) torna
    // este ramo inalcançável filtrando o map por conta; o helper puro não pode CONFIAR nisso (D2).
    const r = computeCarteira(
      [{ customer_user_id: 'c4', omie_codigo_vendedor: 10 }],
      [
        { omie_codigo_vendedor: 10, user_id: 'regina' },
        { omie_codigo_vendedor: 10, user_id: 'tati' },
      ],
      HUNTER,
    );
    expect(r.assignments).toEqual([
      { customer_user_id: 'c4', owner_user_id: HUNTER, source: 'hunter_orphan', omie_codigo_vendedor: 10, eligible: false },
    ]);
    expect(r.conflicts).toEqual([
      { customer_user_id: 'c4', omie_codigo_vendedor: 10, candidate_user_ids: ['regina', 'tati'] },
    ]);
    // o membro NÃO some da saída — é essa a diferença entre "stale" e "preservado inelegível"
    expect(r.assignments.map((a) => a.customer_user_id)).toContain('c4');
  });

  it('conflito de mapeamento SEM Hunter (null) → não emite (limitação real: sem owner NOT NULL não há row)', () => {
    // owner_user_id é NOT NULL e o CHECK de source só aceita omie|hunter_orphan → sem Hunter o helper puro
    // não consegue emitir a quarentena. Quem fecha esse buraco é o guard D3 no edge (aborta sem Hunter).
    const r = computeCarteira(
      [{ customer_user_id: 'c4', omie_codigo_vendedor: 10 }],
      [
        { omie_codigo_vendedor: 10, user_id: 'regina' },
        { omie_codigo_vendedor: 10, user_id: 'tati' },
      ],
      null,
    );
    expect(r.assignments).toHaveLength(0);
    expect(r.conflicts).toHaveLength(1);
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

describe('avaliarGuardResultado — CRON vs baseline persistido (R3) + BOOTSTRAP trava de saída vs carteira atual (R4)', () => {
  // CRON = não-autorizado. omieAtual/forcado são inertes no ramo cron (não são lidos), mas o tipo os exige.
  const cron = (omieElegivelNovo: number, baselinePersistido: number) =>
    avaliarGuardResultado({ omieElegivelNovo, baselinePersistido, autorizado: false, omieAtual: 0, forcado: false });

  it('0 omie ELEGÍVEL → aborta sempre (carteira 100% Hunter nunca é gravada)', () => {
    const r = cron(0, 5000);
    expect(r.abortar).toBe(true);
    expect(r.motivo).toMatch(/hunter|elegiv/i);
  });
  it('CRON: bootstrap (baseline persistido=0) sem autorização → aborta INDEPENDENTE da carteira (#1 R3)', () => {
    const r = cron(100, 0);
    expect(r.abortar).toBe(true);
    expect(r.motivo).toMatch(/bootstrap|autoriza/i);
  });
  it('CRON: catraca vs baseline persistido — 2399 < 80% de 4797 aborta (não a carteira atual)', () => {
    const r = cron(2399, 4797);
    expect(r.abortar).toBe(true);
    expect(r.motivo).toMatch(/regress|baseline|80%/i);
  });
  it('CRON: baseline persistido segue 4797 → 1200 também aborta (sem degradação em série)', () => {
    expect(cron(1200, 4797).abortar).toBe(true);
  });
  it('CRON: regime saudável (≥80% do baseline) → não aborta; baseline sobe (recorde)', () => {
    const r = cron(5000, 4797);
    expect(r.abortar).toBe(false);
    expect(r.novoBaseline).toBe(5000);
  });
  it('CRON: flutuação dentro de 20% → não aborta; baseline NÃO desce (max — evita catraca)', () => {
    const r = cron(4600, 4797);
    expect(r.abortar).toBe(false);
    expect(r.novoBaseline).toBe(4797);
  });

  // ── BOOTSTRAP (autorizado) — trava de SAÍDA vs a carteira ATUAL (Codex R4) ──
  it('BOOTSTRAP primeira população (omieAtual=0) → grava; baseline = novo (não há saída a preservar)', () => {
    const r = avaliarGuardResultado({ omieElegivelNovo: 4200, baselinePersistido: 0, autorizado: true, omieAtual: 0, forcado: false });
    expect(r.abortar).toBe(false);
    expect(r.novoBaseline).toBe(4200);
  });
  it('BOOTSTRAP saudável (não encolhe vs a carteira atual) → grava', () => {
    const r = avaliarGuardResultado({ omieElegivelNovo: 2750, baselinePersistido: 0, autorizado: true, omieAtual: 2747, forcado: false });
    expect(r.abortar).toBe(false);
    expect(r.novoBaseline).toBe(2750);
  });
  it('BOOTSTRAP que ENCOLHERIA a carteira omie < 80% da atual → ABORTA sem force (cenário 1226: 1521 < 0,8×2747)', () => {
    const r = avaliarGuardResultado({ omieElegivelNovo: 1521, baselinePersistido: 0, autorizado: true, omieAtual: 2747, forcado: false });
    expect(r.abortar).toBe(true);
    expect(r.motivo).toMatch(/encolheria|force|80%/i);
  });
  it('BOOTSTRAP corrupção/flaggeds (omieElegivelNovo=1) vs carteira atual cheia → ABORTA (o >0 sozinho não basta mais — furo Codex R4)', () => {
    const r = avaliarGuardResultado({ omieElegivelNovo: 1, baselinePersistido: 0, autorizado: true, omieAtual: 2747, forcado: false });
    expect(r.abortar).toBe(true);
  });
  it('BOOTSTRAP com &force=1 → grava mesmo encolhendo (reset legítimo: vendedor desligado); baseline = novo', () => {
    const r = avaliarGuardResultado({ omieElegivelNovo: 1521, baselinePersistido: 4797, autorizado: true, omieAtual: 2747, forcado: true });
    expect(r.abortar).toBe(false);
    expect(r.novoBaseline).toBe(1521);
  });
  it('BOOTSTRAP com force NÃO fura o "0 omie elegível" (100% Hunter nunca grava, nem forçado)', () => {
    const r = avaliarGuardResultado({ omieElegivelNovo: 0, baselinePersistido: 0, autorizado: true, omieAtual: 2747, forcado: true });
    expect(r.abortar).toBe(true);
  });
  it('BOOTSTRAP fronteira: exatamente 80% da atual NÃO aborta; logo abaixo aborta', () => {
    expect(avaliarGuardResultado({ omieElegivelNovo: 800, baselinePersistido: 0, autorizado: true, omieAtual: 1000, forcado: false }).abortar).toBe(false);
    expect(avaliarGuardResultado({ omieElegivelNovo: 799, baselinePersistido: 0, autorizado: true, omieAtual: 1000, forcado: false }).abortar).toBe(true);
  });
  it('BOOTSTRAP não eroda o baseline (R4b): ref = max(atual, baseline) — atual 2198 < baseline 2747 → 1759 aborta', () => {
    // sem o max, 1759 < 0,8×2198=1758,4 seria FALSE (passava e erodia o baseline p/ 1759). Com ref=max=2747: 1759 < 2197,6 → aborta.
    const r = avaliarGuardResultado({ omieElegivelNovo: 1759, baselinePersistido: 2747, autorizado: true, omieAtual: 2198, forcado: false });
    expect(r.abortar).toBe(true);
  });
  it('BOOTSTRAP primeira população TRUNCADA (omieAtual=0) mas com baseline histórico 2747 → 1 aborta (protegida pelo max)', () => {
    const r = avaliarGuardResultado({ omieElegivelNovo: 1, baselinePersistido: 2747, autorizado: true, omieAtual: 0, forcado: false });
    expect(r.abortar).toBe(true);
  });
  it('BOOTSTRAP &force=1 fura a ref-max (reset legítimo assume, mesmo vs baseline histórico); baseline = novo', () => {
    const r = avaliarGuardResultado({ omieElegivelNovo: 1759, baselinePersistido: 2747, autorizado: true, omieAtual: 2198, forcado: true });
    expect(r.abortar).toBe(false);
    expect(r.novoBaseline).toBe(1759);
  });
  it('BOOTSTRAP sem force é MONOTÔNICO: novo 2198 ≥ 80% de 2747 passa MAS o baseline NÃO desce (Codex R4c)', () => {
    // O furo: sem baseline monotônico, gravar 2198 baixava o baseline p/ 2198, e o próximo bootstrap desceria
    // p/ 1759 (erosão em etapas de 20% sem force). Com o max no novoBaseline, força é o ÚNICO jeito de baixar.
    const r = avaliarGuardResultado({ omieElegivelNovo: 2198, baselinePersistido: 2747, autorizado: true, omieAtual: 2747, forcado: false });
    expect(r.abortar).toBe(false);       // 2198 ≥ 0,8×2747=2197,6 → passa
    expect(r.novoBaseline).toBe(2747);   // monotônico: NÃO desce sem force
  });
  it('BOOTSTRAP com baseline DESATUALIZADO (0) e carteira real 2747 → persiste 2747, não 2198 (Codex R5)', () => {
    // O furo R5: max(baseline=0, novo=2198) persistia 2198 e ESQUECIA os 2747 da carteira real; o run seguinte
    // compararia com 2198 e deixaria cair p/ 1759 — erosão acumulada de 36% SEM force. O omieAtual no max mata.
    const r = avaliarGuardResultado({ omieElegivelNovo: 2198, baselinePersistido: 0, autorizado: true, omieAtual: 2747, forcado: false });
    expect(r.abortar).toBe(false);       // 2198 ≥ 0,8×max(2747,0)=2197,6 → passa
    expect(r.novoBaseline).toBe(2747);   // persiste o MAIOR dos três (o atual), não o novo
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

describe('verificarCobertura (pós-condição estrutural — D4)', () => {
  const rows = (ids: string[]) => ids.map((customer_user_id) => ({ customer_user_id }));

  it('saída cobre EXATAMENTE os membros → ok', () => {
    expect(verificarCobertura(['a', 'b', 'c'], rows(['a', 'b', 'c']))).toEqual({ ok: true, motivo: null });
  });

  it('ordem diferente também é ok (compara CONJUNTO, não sequência)', () => {
    expect(verificarCobertura(['a', 'b', 'c'], rows(['c', 'a', 'b'])).ok).toBe(true);
  });

  it('membro do ledger SEM row → ok=false (é o stale: upsert-only deixaria o assignment antigo vivo)', () => {
    const r = verificarCobertura(['a', 'b', 'c'], rows(['a', 'c']));
    expect(r.ok).toBe(false);
    expect(r.motivo).toMatch(/1 membro.*sem row/);
    expect(r.motivo).toContain('b'); // aponta QUEM sumiu
  });

  it('row p/ NÃO-membro do ledger → ok=false', () => {
    const r = verificarCobertura(['a', 'b'], rows(['a', 'b', 'x']));
    expect(r.ok).toBe(false);
    expect(r.motivo).toMatch(/nao-membro/);
    expect(r.motivo).toContain('x');
  });

  it('customer_user_id duplicado na saída → ok=false', () => {
    const r = verificarCobertura(['a', 'b'], rows(['a', 'b', 'b']));
    expect(r.ok).toBe(false);
    expect(r.motivo).toMatch(/duplicado/);
  });

  it('ledger vazio + saída vazia → ok (degenerado, mas coerente)', () => {
    expect(verificarCobertura([], []).ok).toBe(true);
  });
});

describe('composição computeCarteira + verificarCobertura (o erro catastrófico: membro sumir)', () => {
  it('conflito de mapeamento: o membro conflitado PERMANECE na saída → cobertura ok', () => {
    // Se o conflito voltasse a ser OMITIDO, este membro sumiria da saída e a cobertura acusaria — é
    // exatamente o mecanismo do A′. O par computeCarteira+verificarCobertura prende essa regressão.
    const membroIds = ['c-limpo', 'c-conflito'];
    const clientes = membroIds.map((id) => ({ customer_user_id: id, omie_codigo_vendedor: id === 'c-limpo' ? 10 : 20 }));
    const map = [
      { omie_codigo_vendedor: 10, user_id: 'regina' },
      { omie_codigo_vendedor: 20, user_id: 'regina' },
      { omie_codigo_vendedor: 20, user_id: 'tati' }, // 20 → 2 vendedores = conflito
    ];
    const { assignments } = computeCarteira(clientes, map, HUNTER);
    expect(verificarCobertura(membroIds, assignments)).toEqual({ ok: true, motivo: null });
    const conflitado = assignments.find((a) => a.customer_user_id === 'c-conflito');
    expect(conflitado).toBeDefined();
    expect(conflitado!.eligible).toBe(false); // preservado, mas inelegível (zero comissão)
  });
});

describe('fixture da CANÁRIA de deploy (?canary=1) — verdade-base do que o edge afirma', () => {
  // O edge carteira-rebuild expõe ?canary=1 com esta MESMA fixture e um bloco `expected` HARD-CODED.
  // Aqui provamos, contra o helper REAL, que aquele `expected` é a verdade — senão a canária viraria
  // uma mentira verde (afirmando um comportamento que o helper não tem). A paridade textual entre este
  // esperado e o do edge é guardada em src/__tests__/edge-money-path-invariants.test.ts.
  const HUNTER_FIX = '00000000-0000-4000-8000-0000000000ff';
  const M = ['00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000002'];
  const VA = '00000000-0000-4000-8000-00000000000a';
  const VB = '00000000-0000-4000-8000-00000000000b';
  const rodar = () => computeCarteira(
    [
      { customer_user_id: M[0], omie_codigo_vendedor: 111 },
      { customer_user_id: M[1], omie_codigo_vendedor: 222 },
    ],
    [
      { omie_codigo_vendedor: 111, user_id: VA },
      { omie_codigo_vendedor: 222, user_id: VA },
      { omie_codigo_vendedor: 222, user_id: VB },
    ],
    HUNTER_FIX,
  );

  it('o helper ATUAL produz exatamente o `expected` que o edge hard-coda', () => {
    const out = rodar();
    const conflitado = out.assignments.find((a) => a.customer_user_id === M[1]) ?? null;
    expect({
      membroConflitadoPresente: conflitado !== null,
      conflitadoSource: conflitado?.source ?? null,
      conflitadoEligible: conflitado?.eligible ?? null,
      conflitadoCodigo: conflitado?.omie_codigo_vendedor ?? null,
      conflictsRegistrados: out.conflicts.length,
      coberturaOk: verificarCobertura(M, out.assignments).ok,
    }).toEqual({
      membroConflitadoPresente: true,
      conflitadoSource: 'hunter_orphan',
      conflitadoEligible: false,
      conflitadoCodigo: 222,
      conflictsRegistrados: 1,
      coberturaOk: true,
    });
  });

  it('a fixture DISCRIMINA: sob o comportamento ANTIGO (omitir conflito) a canária ficaria vermelha', () => {
    // Simula o código velho: filtra da saída o membro conflitado (era o que emitLegado fazia ao NÃO emitir).
    // Se a canária não distinguisse velho×novo, ela não provaria deploy nenhum — este assert é o que
    // garante que ela tem poder discriminante.
    const out = rodar();
    const comoAntigo = out.assignments.filter((a) => a.customer_user_id !== M[1]);
    const conflitadoAntigo = comoAntigo.find((a) => a.customer_user_id === M[1]) ?? null;
    expect(conflitadoAntigo).toBeNull();                              // velho: membro SOME
    expect(verificarCobertura(M, comoAntigo).ok).toBe(false);         // e a cobertura acusa
    expect(out.assignments.find((a) => a.customer_user_id === M[1])).toBeDefined(); // novo: PERMANECE
  });
});
