import { describe, it, expect } from 'vitest';
import {
  avaliarCompletude,
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
});
