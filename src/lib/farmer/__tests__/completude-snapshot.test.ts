import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
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
  carteira_com_historico_utilizavel: { ok: true, n: 150 },
  regras: { ok: true, n: 450 },
};

const OBRIGATORIOS = [
  'scores',
  'catalogo',
  'vendaveis',
  'pedidos',
  'carteira_ativa',
  'clientes_com_profile',
  'carteira_com_historico_utilizavel',
];

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
  // ─── carteira ATIVA ≠ carteira com histórico UTILIZÁVEL ────────────────────────
  // O pré-requisito que o §7.5 do design deixou declarado como LIMITAÇÃO: `carteira_ativa`
  // conta cliente com PEDIDO, e pedido não é insumo — insumo é item que RESOLVE para SKU do
  // catálogo ATIVO. Os itens do jsonb `sales_orders.items` não têm `product_id`: 100% da
  // resolução passa por `omie_codigo_produto` → `omie_products` (`.eq('ativo', true)`), e os
  // dois motores descartam em silêncio o que não resolve (`if (!productId) continue`).
  //
  // Medido em prod (psql-ro, 18/08/2026), pedidos confirmado/faturado/entregue:
  //   47.735 itens · 28.675 resolvem para SKU ativo = 60,1%
  //   861 clientes com item · 754 com item que resolve → 107 (12,4%) têm pedido e NENHUM
  //   item utilizável.
  // Esses 107 são exatamente o falso `completo` que a fase 2 usaria como licença para
  // expirar: histórico existe, mas é inutilizável pelo motor.

  const COBERTURA = 'carteira_com_historico_utilizavel';

  it('a cobertura de histórico utilizável é obrigatória nos DOIS motores', () => {
    // Nomeada LITERALMENTE, e não derivada das listas: um teste que lê a lista para depois
    // afirmar sobre a lista fica verde justamente quando o insumo é removido dela.
    expect(INSUMOS_OBRIGATORIOS_CROSS_SELL).toContain(COBERTURA);
    expect(INSUMOS_OBRIGATORIOS_BUNDLE).toContain(COBERTURA);
  });

  it.each([
    ['cross-sell', INSUMOS_OBRIGATORIOS_CROSS_SELL],
    ['bundle', INSUMOS_OBRIGATORIOS_BUNDLE],
  ] as const)(
    'carteira ativa FARTA com zero histórico utilizável degrada (%s)',
    (_motor, obrigatorios) => {
      // O caso dos 107: `pedidos` farto (861), `carteira_ativa` farta (171), catálogo e
      // scores fartos — e mesmo assim nada de onde tirar coocorrência. Sem este insumo o
      // veredicto seria `completo`, e o zero final seria lido como "não há o que ofertar".
      const r = avaliarCompletude(
        { ...COMPLETO, carteira_ativa: { ok: true, n: 171 }, [COBERTURA]: { ok: true, n: 0 } },
        obrigatorios,
      );
      expect(r.completude).toBe('degradado');
      expect(r.motivo).toContain(COBERTURA);
    },
  );

  it('motor que NÃO declara a cobertura degrada por AUSÊNCIA, não por vazio', () => {
    // `clientes_com_profile` e a cobertura são declarados TARDE nos dois motores (dependem
    // do cruzamento com a carteira). Um caminho que saia antes disso não pode ser lido como
    // "li e veio vazio" — e, sobretudo, nunca pode sair `completo` por omissão.
    const { [COBERTURA]: _omitido, ...semCobertura } = COMPLETO;
    const r = avaliarCompletude(semCobertura, INSUMOS_OBRIGATORIOS_BUNDLE);
    expect(r.completude).toBe('degradado');
    expect(r.motivo).toContain('não declarado');
    expect(r.motivo).toContain(COBERTURA);
  });

  // ─── gate de FONTE: listar aqui não basta, o motor tem de DECLARAR ─────────────
  it.each([
    ['src/hooks/useCrossSellEngine.ts', INSUMOS_OBRIGATORIOS_CROSS_SELL],
    ['src/hooks/useBundleEngine.ts', INSUMOS_OBRIGATORIOS_BUNDLE],
  ] as const)('%s declara TODOS os insumos que a lista dele exige', (rel, obrigatorios) => {
    // Por que um gate de FONTE e não só teste de comportamento: obrigatório listado que o
    // motor não declara cai em "insumo obrigatório não declarado" e derruba TODA geração
    // daquele motor para `degradado`. É fail-closed, mas silencioso — a fase 2 simplesmente
    // nunca expiraria nada, e nada no comportamento observável diria por quê. O defeito
    // desta família nunca está no helper, e sim em não chamá-lo no call-site
    // (money-path §7); só quem lê a fonte pega.
    const fonte = readFileSync(resolve(process.cwd(), rel), 'utf8');
    const naoDeclarados = obrigatorios.filter(
      (nome) => !new RegExp(`insumos\\.${nome}\\s*=`).test(fonte),
    );
    expect(naoDeclarados).toEqual([]);
  });
});
