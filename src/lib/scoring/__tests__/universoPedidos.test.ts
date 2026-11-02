import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { STATUS_NAO_VENDA } from '@/lib/farmer/universo-pedidos';

/**
 * O universo de PEDIDOS do scoring do farmer.
 *
 * Toda esta frente nasceu de as duas pontas discordarem: o hook filtrava por ALLOWLIST
 * (`confirmado`/`faturado`/`entregue`) e `private.margem_cliente_agregada()` por DENYLIST. Como
 * `confirmado` e `entregue` têm ZERO linhas em prod, a allowlist resolvia para só `faturado` e
 * escondia 10.236 pedidos reais (`importado`/`separacao`/`enviado`).
 *
 * O teste que importa não é "a constante tem 4 itens" — é que ela **continue espelhando o SQL**,
 * e que o hook **não volte para uma allowlist**. Uma divergência aqui é invisível no typecheck,
 * no lint e na tela: só aparece como número diferente entre a margem e o resto do score.
 */
describe('universo de pedidos do scoring', () => {
  it('espelha a denylist de private.margem_cliente_agregada()', () => {
    // Verbatim do corpo em PROD (pg_get_functiondef, 2026-08-13):
    //   WHERE so.status NOT IN ('cancelado', 'rascunho', 'pendente', 'orcamento')
    expect([...STATUS_NAO_VENDA].sort()).toEqual(
      ['cancelado', 'orcamento', 'pendente', 'rascunho'],
    );
  });

  it('o hook consome a denylist e NÃO reintroduz a allowlist de status', () => {
    // Gate estrutural (padrão de `paginacao-artesanal-gate.test.ts`): lê o FONTE, porque a
    // regressão aqui é textual — alguém "restaura" o `.in('status', [...])` num rebase e nada
    // quebra, só a tela volta a divergir da autoridade.
    // Caminho a partir da raiz do repo (cwd do vitest), como os demais gates que leem fonte —
    // `new URL(..., import.meta.url)` não resolve como file:// aqui.
    const hook = readFileSync('src/hooks/useFarmerScoring.ts', 'utf8');
    const semComentarios = hook
      .split('\n')
      .filter((l) => !l.trim().startsWith('//') && !l.trim().startsWith('*') && !l.trim().startsWith('/*'))
      .join('\n');

    expect(
      /\.in\(\s*['"]status['"]/.test(semComentarios),
      'o hook voltou a filtrar status por allowlist — diverge de margem_cliente_agregada()',
    ).toBe(false);
    // Desde o lote 16 (plano v4) o universo de pedidos é lido em `@/lib/farmer/universo-pedidos-query`,
    // compartilhado com cross-sell e bundle: o hook passa por ele, e a denylist + `deleted_at` moram lá.
    expect(semComentarios.includes('buscarUniversoPedidos('), 'o hook não lê o universo compartilhado').toBe(true);
    const compartilhado = readFileSync('src/lib/farmer/universo-pedidos-query.ts', 'utf8')
      .split('\n')
      .filter((l) => !l.trim().startsWith('//') && !l.trim().startsWith('*') && !l.trim().startsWith('/*'))
      .join('\n');
    expect(
      compartilhado.includes('STATUS_NAO_VENDA'),
      'o universo compartilhado não usa mais a denylist',
    ).toBe(true);
    expect(
      /\.is\(\s*['"]deleted_at['"]\s*,\s*null\s*\)/.test(compartilhado),
      'o universo compartilhado não filtra deleted_at — e a denylist sozinha traria pedido apagado',
    ).toBe(true);
  });
});
