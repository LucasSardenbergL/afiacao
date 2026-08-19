import { describe, it, expect } from 'vitest';
import {
  avaliarCompletude,
  INSUMOS_OBRIGATORIOS_BUNDLE,
  INSUMOS_OBRIGATORIOS_CROSS_SELL,
  type InsumosSnapshot,
} from '../completude-snapshot';

/**
 * O que estes testes protegem: `completude='completo'` é o ÚNICO rótulo que a fase 2
 * poderá usar para expirar a geração de um farmer. Um falso `completo` não produz número
 * errado — apaga a carteira inteira de uma vendedora. Por isso todo caso duvidoso tem um
 * teste exigindo `degradado`.
 */

const COMPLETO: InsumosSnapshot = {
  scores: { ok: true, n: 3858 },
  catalogo: { ok: true, n: 3108 },
  vendaveis: { ok: true, n: 1200 },
  pedidos: { ok: true, n: 861 },
  carteira_ativa: { ok: true, n: 171 },
  clientes_com_profile: { ok: true, n: 168 },
  regras: { ok: true, n: 450 },
  // Cestas UTILIZÁVEIS (items mapeados para o catálogo), não pedidos.
  baskets: { ok: true, n: 479 },
};

const OBRIGATORIOS = ['scores', 'catalogo', 'vendaveis', 'pedidos', 'carteira_ativa', 'clientes_com_profile'];

describe('avaliarCompletude', () => {
  it('snapshot íntegro é completo, sem motivo', () => {
    expect(avaliarCompletude(COMPLETO, INSUMOS_OBRIGATORIOS_CROSS_SELL)).toEqual({
      completude: 'completo',
      motivo: null,
    });
  });

  // ─── "não consegui ler" degrada SEMPRE ───────────────────────────────────
  it.each(OBRIGATORIOS)(
    'insumo obrigatório com ok:false degrada (%s)',
    (nome) => {
      const r = avaliarCompletude(
        { ...COMPLETO, [nome]: { ok: false, n: 0 } },
        INSUMOS_OBRIGATORIOS_CROSS_SELL,
      );
      expect(r.completude).toBe('degradado');
      expect(r.motivo).toContain(nome);
    },
  );

  it('insumo NÃO-obrigatório com ok:false também degrada — leitura parcial é leitura parcial', () => {
    // `regras` pode vir legitimamente VAZIO, mas não pode vir MAL LIDO: um universo lido
    // pela metade produz um resultado que parece completo e não é (money-path §6).
    const r = avaliarCompletude(
      { ...COMPLETO, regras: { ok: false, n: 0 } },
      INSUMOS_OBRIGATORIOS_CROSS_SELL,
    );
    expect(r.completude).toBe('degradado');
    expect(r.motivo).toContain('regras');
  });

  // ─── "li e veio vazio" degrada só nos obrigatórios ───────────────────────
  it.each(OBRIGATORIOS)(
    'insumo obrigatório vazio degrada (%s)',
    (nome) => {
      const r = avaliarCompletude(
        { ...COMPLETO, [nome]: { ok: true, n: 0 } },
        INSUMOS_OBRIGATORIOS_CROSS_SELL,
      );
      expect(r.completude).toBe('degradado');
      expect(r.motivo).toContain(nome);
    },
  );

  it('regras vazias NÃO degradam — base sem coocorrência é estado legítimo', () => {
    // Este é o caso que separa "zero de verdade" de "zero por dado faltando": a base pode
    // simplesmente não ter padrão, e o motor ainda recomenda por popularidade.
    expect(
      avaliarCompletude({ ...COMPLETO, regras: { ok: true, n: 0 } }, INSUMOS_OBRIGATORIOS_CROSS_SELL),
    ).toEqual({ completude: 'completo', motivo: null });
  });

  // ─── ausente ≠ zero, aplicado à própria medição ──────────────────────────
  it('insumo obrigatório NÃO DECLARADO degrada, e o motivo diz que é ausência', () => {
    // Um insumo que o motor nem tentou ler não pode ser lido como "veio vazio". Se um
    // caminho novo esquecer de declarar um insumo, o head tem de sair degradado — nunca
    // completo por omissão, que seria licença de expirar concedida por descuido.
    const { carteira_ativa: _omitido, ...semCarteira } = COMPLETO;
    const r = avaliarCompletude(semCarteira, INSUMOS_OBRIGATORIOS_CROSS_SELL);
    expect(r.completude).toBe('degradado');
    expect(r.motivo).toContain('não declarado');
    expect(r.motivo).toContain('carteira_ativa');
  });

  it('snapshot VAZIO não é completo por vacuidade', () => {
    const r = avaliarCompletude({}, INSUMOS_OBRIGATORIOS_CROSS_SELL);
    expect(r.completude).toBe('degradado');
  });

  // ─── determinismo do motivo ──────────────────────────────────────────────
  it('o motivo é ESTÁVEL: a mesma falha em ordens de inserção diferentes dá o mesmo texto', () => {
    // Sem ordem estável, duas execuções com a MESMA falha gravam motivos diferentes, e
    // agregar o head por motivo passa a contar duas causas onde há uma.
    const a: InsumosSnapshot = { scores: { ok: false, n: 0 }, catalogo: { ok: false, n: 0 } };
    const b: InsumosSnapshot = { catalogo: { ok: false, n: 0 }, scores: { ok: false, n: 0 } };
    expect(avaliarCompletude(a, INSUMOS_OBRIGATORIOS_CROSS_SELL).motivo).toBe(
      avaliarCompletude(b, INSUMOS_OBRIGATORIOS_CROSS_SELL).motivo,
    );
  });

  it('a falha de LEITURA tem precedência sobre o vazio — o motivo aponta a causa raiz', () => {
    // Com scores mal lidos E catálogo vazio, o que explica o zero é o primeiro: reportar
    // "catálogo vazio" mandaria quem investiga para o lugar errado.
    const r = avaliarCompletude(
      { ...COMPLETO, scores: { ok: false, n: 0 }, catalogo: { ok: true, n: 0 } },
      INSUMOS_OBRIGATORIOS_CROSS_SELL,
    );
    expect(r.motivo).toContain('não consegui ler');
    expect(r.motivo).toContain('scores');
  });

  it('degradado SEMPRE tem motivo — a RPC recusa com FG104 sem ele', () => {
    const casos: InsumosSnapshot[] = [
      { ...COMPLETO, scores: { ok: false, n: 0 } },
      { ...COMPLETO, pedidos: { ok: true, n: 0 } },
      {},
    ];
    for (const insumos of casos) {
      const r = avaliarCompletude(insumos, INSUMOS_OBRIGATORIOS_CROSS_SELL);
      expect(r.completude).toBe('degradado');
      expect(r.motivo).toBeTruthy();
      expect(r.motivo!.trim()).not.toBe('');
    }
  });

  it('completo SEMPRE tem motivo null — a coluna só é preenchida quando degrada', () => {
    expect(avaliarCompletude(COMPLETO, INSUMOS_OBRIGATORIOS_CROSS_SELL).motivo).toBeNull();
  });

  // ─── a assimetria entre os DOIS motores ────────────────────────────────────────
  // Até aqui a suíte só exercia a lista do cross-sell; a do bundle não tinha teste algum,
  // e foi por essa fresta que ela herdou `regras` como opcional — premissa que vale só
  // para quem tem caminho por popularidade.

  it('regras vazias DEGRADAM no bundle — lá o zero é por CONSTRUÇÃO, não falta de padrão', () => {
    // Todo bundle nasce de `applicableRules`, que sai de `discoveredRules`. Sem regra o
    // motor devolve zero sempre; `completo` aqui daria à fase 2 licença para expirar a
    // carteira de bundles exatamente quando o histórico ficou insuficiente.
    const r = avaliarCompletude({ ...COMPLETO, regras: { ok: true, n: 0 } }, INSUMOS_OBRIGATORIOS_BUNDLE);
    expect(r.completude).toBe('degradado');
    expect(r.motivo).toContain('regras');
  });

  it('a MESMA leitura dá veredicto diferente por motor — a assimetria é desenho, não acidente', () => {
    const semRegras: InsumosSnapshot = { ...COMPLETO, regras: { ok: true, n: 0 } };
    expect(avaliarCompletude(semRegras, INSUMOS_OBRIGATORIOS_CROSS_SELL).completude).toBe('completo');
    expect(avaliarCompletude(semRegras, INSUMOS_OBRIGATORIOS_BUNDLE).completude).toBe('degradado');
  });

  it('bundle que NÃO declara regras degrada por AUSÊNCIA — ausente ≠ zero na própria medição', () => {
    const { regras: _omitido, ...semRegras } = COMPLETO;
    const r = avaliarCompletude(semRegras, INSUMOS_OBRIGATORIOS_BUNDLE);
    expect(r.completude).toBe('degradado');
    expect(r.motivo).toContain('não declarado');
    expect(r.motivo).toContain('regras');
  });
  // ─── COBERTURA útil, não `n > 0` ────────────────────────────────────
  // `n > 0` responde "esse insumo existe?", que não é a pergunta. A pergunta é "o cálculo
  // alcançou a carteira?". Um farmer com 101 clientes ativos e 1 perfil produz zero por ter
  // pulado 100 deles (`if (!profile) continue`) — e todos os universos globais seguem fartos.
  it('cobertura ABAIXO do piso degrada — 1 perfil para 101 clientes ativos não é snapshot íntegro', () => {
    const r = avaliarCompletude(
      {
        ...COMPLETO,
        carteira_ativa: { ok: true, n: 101 },
        clientes_com_profile: { ok: true, n: 1, esperado: 101, pisoCobertura: 0.5 },
      },
      INSUMOS_OBRIGATORIOS_CROSS_SELL,
    );
    expect(r.completude).toBe('degradado');
    expect(r.motivo).toContain('cobertura insuficiente');
    expect(r.motivo).toContain('clientes_com_profile');
  });

  it('cobertura ACIMA do piso segue completa — a regra mede o buraco, não a existência', () => {
    const r = avaliarCompletude(
      {
        ...COMPLETO,
        carteira_ativa: { ok: true, n: 171 },
        clientes_com_profile: { ok: true, n: 168, esperado: 171, pisoCobertura: 0.5 },
      },
      INSUMOS_OBRIGATORIOS_CROSS_SELL,
    );
    expect(r).toEqual({ completude: 'completo', motivo: null });
  });

  it('esperado ZERO não degrada por cobertura — 0/0 é o universo vazio, que outro insumo já julga', () => {
    const r = avaliarCompletude(
      {
        ...COMPLETO,
        clientes_com_profile: { ok: true, n: 5, esperado: 0, pisoCobertura: 0.5 },
      },
      INSUMOS_OBRIGATORIOS_CROSS_SELL,
    );
    expect(r.completude).toBe('completo');
  });

  it('a falha de LEITURA ainda vence a cobertura — causa raiz primeiro', () => {
    const r = avaliarCompletude(
      {
        ...COMPLETO,
        scores: { ok: false, n: 0 },
        clientes_com_profile: { ok: true, n: 1, esperado: 101, pisoCobertura: 0.5 },
      },
      INSUMOS_OBRIGATORIOS_CROSS_SELL,
    );
    expect(r.motivo).toContain('não consegui ler');
  });

  // ─── baskets: a cesta UTILIZÁVEL, não o pedido ──────────────────────
  // `pedidos` conta clientes com pedido. O bundle não consome pedido, consome CESTA: items
  // vazio, malformado ou com `omie_codigo_produto` sem correspondência no catálogo não vira
  // basket. Sem este insumo, uma base cujos pedidos não mapeiam deixa `pedidos`,
  // `carteira_ativa` e `catalogo` fartos, gera zero regra e o head sai `completo`.
  it('baskets vazio degrada no bundle — pedido sem item mapeável não é cesta', () => {
    const r = avaliarCompletude(
      { ...COMPLETO, baskets: { ok: true, n: 0 } },
      INSUMOS_OBRIGATORIOS_BUNDLE,
    );
    expect(r.completude).toBe('degradado');
    expect(r.motivo).toContain('baskets');
  });

  it('bundle que NÃO declara baskets degrada por ausência', () => {
    const semBaskets = { ...COMPLETO };
    delete semBaskets.baskets;
    const r = avaliarCompletude(semBaskets, INSUMOS_OBRIGATORIOS_BUNDLE);
    expect(r.completude).toBe('degradado');
    expect(r.motivo).toContain('baskets');
  });
});
