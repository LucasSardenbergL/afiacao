import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { removerComentarios } from '@/lib/gates/limpeza-fonte';
import { acharSingleShots, TABELAS_RISCO } from '@/lib/gates/single-shot-truncado';

// ── GATE ESTRUTURAL: single-shot que espera a tabela INTEIRA (metade TRUNCAGEM) ───────
//
// `supabase.from('fin_contas_pagar').select('*')` sem `.range()`/`.limit()` devolve as 1.000
// primeiras linhas — a capa do PostgREST — SEM erro e SEM aviso, e o consumidor as trata como
// o todo. Fix-controle: #1471 (os engines liam `product_costs`/`omie_products` truncados; 72%
// dos SKUs viravam "sem custo" e margem 100% no topo do ranking). Esta é a metade que faltava:
//   - a metade FALHA (leitura que falha vira zero/vazio) → `leitura-single-shot-gate` +
//     `erro-colapsado-em-vazio-gate`;
//   - a forma `.rpc()` set-returning → `rpc-set-returning-paginacao-gate`;
//   - os LAÇOS → `paginacao-artesanal-gate`.
// O predicado (puro, calibrado em `src/lib/gates/__tests__/single-shot-truncado.test.ts`)
// vive em `src/lib/gates/single-shot-truncado.ts`.
//
// Por que TEXTUAL (readFileSync): metade dos sítios vive em edges Deno que o vitest não
// executa. Ler FONTE cobre as duas metades com um contrato só, no CI `validate`.

const RAIZ = resolve(__dirname, '../..');
const DIRS = ['src', 'supabase/functions', 'scripts'];
const EXT = /\.(ts|tsx)$/;
const IGNORAR = /(\.test\.|_test\.|\.d\.ts$|__tests__|\.stories\.)/;

function listarFontes(dir: string, acc: string[] = []): string[] {
  for (const nome of readdirSync(resolve(RAIZ, dir))) {
    const rel = join(dir, nome);
    const abs = resolve(RAIZ, rel);
    if (statSync(abs).isDirectory()) {
      if (nome === 'node_modules' || nome === '.git') continue;
      listarFontes(rel, acc);
    } else if (EXT.test(nome) && !IGNORAR.test(rel)) {
      acc.push(rel);
    }
  }
  return acc;
}

function medir(): Map<string, number> {
  const mapa = new Map<string, number>();
  for (const dir of DIRS) {
    for (const arquivo of listarFontes(dir)) {
      const n = acharSingleShots(removerComentarios(readFileSync(resolve(RAIZ, arquivo), 'utf8'))).length;
      if (n > 0) mapa.set(arquivo, n);
    }
  }
  return mapa;
}

// DÍVIDA baselinada por CONTAGEM (medida 2026-10-10). A contagem — não a presença do caminho
// — impede um sítio NOVO de nascer num arquivo já listado (achado Codex no #1581). Crescer =
// REINTRODUÇÃO (vermelho). Encolher = reprova pedindo a atualização: a lista só encolhe, e
// encolhe REGISTRADO. Comentário de cada linha = `linha:tabela` no instante da medição
// (orientação para quem for quitar; o gate compara só a contagem).
//
// Quitados na entrega que criou este gate: financeiroService (mapeamento DRE, categorias
// Omie), FinanceiroConciliacao (stats), TintFormulas (mapa de custo tintométrico).
const DIVIDA: ReadonlyMap<string, number> = new Map([
  ['src/components/customer360/hooks.ts', 1], // 125:customer_preferred_items — veredito: não afetado hoje (máx 132 itens/cliente em prod)
  ['src/components/intelligence/IntelligenceManagerialTab.tsx', 1], // 72:profiles
  ['src/components/intelligence/IntelligenceOperationalTab.tsx', 1], // 64:profiles
  ['src/components/intelligence/IntelligenceStrategicTab.tsx', 2], // 80:order_items(LIMIT1000) 89:profiles
  ['src/components/intelligence/IntelligenceUserSimulator.tsx', 1], // 16:profiles
  ['src/components/loyalty/useAdminLoyalty.ts', 1], // 48:profiles
  ['src/components/reposicao/ConfirmacaoPanel.tsx', 1], // 48:pedido_compra_sugerido
  ['src/components/reposicao/HistoricoComChart.tsx', 2], // 38:pedido_compra_sugerido 99:pedido_compra_sugerido
  ['src/components/reposicao/aumentoDetail/MapeamentoDialog.tsx', 1], // 50:omie_products(LIMIT1000)
  ['src/components/reposicao/aumentoDetail/SkuPickerDialog.tsx', 1], // 37:omie_products(LIMIT1000)
  ['src/components/reposicao/pedidos/CiclosAnteriores.tsx', 1], // 18:pedido_compra_sugerido
  ['src/components/skuMapeamento/useSkuMapeamento.ts', 3], // 208:sku_parametros 221:pedido_compra_item 252:sku_parametros
  ['src/components/tintImport/queries.ts', 1], // 12:omie_products
  ['src/hooks/dashboard/useEstoqueZone.ts', 1], // 38:nfe_recebimentos
  ['src/hooks/dashboard/useVendasZone.ts', 1], // 47:sales_orders
  ['src/hooks/useDepartmentsAdmin.ts', 1], // 23:profiles
  ['src/hooks/useExcecaoCredito.ts', 1], // 75:user_roles
  ['src/hooks/usePontoEquilibrio.ts', 2], // 227:fin_categorias 376:fin_categorias
  ['src/hooks/useReposicaoSessao.ts', 2], // 42:pedido_compra_sugerido 133:pedido_compra_sugerido
  ['src/hooks/useRoutePlanner.ts', 1], // 333:profiles
  ['src/hooks/useTeamKpis.ts', 1], // 57:farmer_calls
  ['src/hooks/useUnifiedOrder.ts', 1], // 122:omie_servicos
  ['src/pages/AdminApprovals.tsx', 2], // 45:user_roles 52:profiles
  ['src/pages/AdminReposicaoCadastros.tsx', 2], // 65:sku_parametros 279:pedido_compra_sugerido(LIMIT1000)
  ['src/pages/AdminReposicaoPedidos.tsx', 2], // 128:pedido_compra_sugerido 157:pedido_compra_sugerido
  ['src/pages/AdminVendorSipCredentials.tsx', 1], // 46:profiles
  ['src/pages/ExecutiveDashboard.tsx', 1], // 42:user_roles
  ['src/pages/GovernanceAudit.tsx', 1], // 101:profiles
  ['src/pages/GovernancePermissions.tsx', 1], // 68:profiles
  ['src/pages/GovernanceSettings.tsx', 1], // 26:user_roles
  ['src/pages/GovernanceUsers.tsx', 1], // 54:profiles
  ['src/pages/Recebimento.tsx', 1], // 129:nfe_recebimentos
  ['src/pages/SalesPrintDashboard.tsx', 1], // 91:sales_orders
  ['src/pages/SalesProducts.tsx', 1], // 55:omie_products
  ['src/pages/SalesQuotes.tsx', 1], // 62:sales_orders
  ['src/pages/TintCorantes.tsx', 2], // 15:tint_corantes 29:omie_products
  ['src/services/financeiroConciliacao.ts', 1], // 51:fin_movimentacoes
  ['supabase/functions/analyze-services/index.ts', 1], // 147:omie_servicos
  ['supabase/functions/analyze-unified-order/index.ts', 1], // 599:omie_servicos (profiles/omie_products saíram: só-imagem em 2 passos, keyset em transcricao.ts)
  ['supabase/functions/calculate-scores/index.ts', 1], // 639:user_roles
  ['supabase/functions/disparar-pedidos-aprovados/index.ts', 1], // 1811:pedido_compra_sugerido
  ['supabase/functions/enviar-pedido-portal-sayerlack/index.ts', 1], // 2333:pedido_compra_sugerido
  ['supabase/functions/fin-ic-reconcile/index.ts', 2], // 128:fin_contas_receber 135:fin_contas_pagar
  ['supabase/functions/fin-regime-tributario/index.ts', 1], // 392:fin_dre_snapshots
  ['supabase/functions/fin-suggest-mapping/index.ts', 1], // 124:fin_categoria_dre_mapping
  ['supabase/functions/fin-valor-engine/index.ts', 1], // 276:fin_dre_snapshots
  ['supabase/functions/gerar-pedidos-diario/index.ts', 1], // 348:pedido_compra_sugerido
  ['supabase/functions/omie-financeiro/index.ts', 6], // 1712:fin_contas_receber 1722:fin_contas_receber 1732:fin_contas_pagar 1740:fin_contas_pagar 1752:fin_categoria_dre_mapping 1763:fin_dre_snapshots
  ['supabase/functions/omie-sync-ctes-recebidos/candidatas.ts', 1], // 67:purchase_orders_tracking
  ['supabase/functions/omie-sync-estoque/index.ts', 2], // 356:pedido_compra_sugerido 807:sku_parametros
  ['supabase/functions/omie-sync-vendas-items/index.ts', 1], // 363:venda_items_history
  ['supabase/functions/omie-sync/index.ts', 1], // 1376:omie_servicos
  ['supabase/functions/omie-vendas-sync/index.ts', 1], // 4192:customer_preferred_items — veredito: não afetado hoje (máx 132 itens/cliente em prod)
  ['supabase/functions/process-recurring-orders/index.ts', 1], // 73:omie_servicos
  ['supabase/functions/scoring-recalc-batch/index.ts', 1], // 117:farmer_calls
  ['supabase/functions/sync-reprocess/index.ts', 1], // 1013:sync_reprocess_log
  ['supabase/functions/tint-sync-agent/index.ts', 1], // 768:tint_corantes
  ['supabase/functions/visit-score-recalc-batch/index.ts', 1], // 115:farmer_calls
  ['supabase/functions/whatsapp-inbound/index.ts', 1], // 148:profiles
  ['supabase/functions/whatsapp-send-template/index.ts', 1], // 66:profiles
]);

describe('gate estrutural: single-shot que espera a tabela inteira (metade truncagem)', () => {
  it('sentinela: o walker anda e o predicado tem alvo (ausência de sinal ≠ aprovação)', () => {
    const fontes = DIRS.flatMap((d) => listarFontes(d));
    expect(fontes.length, 'walker listou fontes de menos — glob/recursão quebrada').toBeGreaterThan(500);
    expect(fontes, 'o helper de src/ sumiu da varredura').toContain('src/lib/postgrest.ts');
    expect(fontes, 'as edges sumiram da varredura').toContain('supabase/functions/_shared/paginate.ts');
    // Esvaziar a lista de tabelas deixaria tudo verde por vacuidade.
    expect(TABELAS_RISCO.size, 'TABELAS_RISCO encolheu — o gate perde o alvo').toBeGreaterThan(60);
    // E a medição precisa ENXERGAR a dívida conhecida: zero sítios seria detector quebrado.
    expect(medir().size, 'o detector não achou nada — quebrou, não "zerou a dívida"').toBeGreaterThan(10);
  });

  it('nenhum single-shot ilimitado NOVO sobre tabela de risco', () => {
    const medido = medir();
    const reintroducoes: string[] = [];
    const quitacoes: string[] = [];
    for (const [arquivo, n] of medido) {
      const base = DIVIDA.get(arquivo) ?? 0;
      if (n > base) reintroducoes.push(`${arquivo} (${base}→${n})`);
      else if (n < base) quitacoes.push(`${arquivo} (${base}→${n})`);
    }
    for (const [arquivo, base] of DIVIDA) if (!medido.has(arquivo)) quitacoes.push(`${arquivo} (${base}→0)`);

    expect(
      reintroducoes,
      'REINTRODUÇÃO: leitura sem `.range()`/`.limit()` sobre tabela que passa (ou vai passar) de 1.000 ' +
        'linhas — o PostgREST trunca em silêncio e o parcial vira "o todo". Use fetchAllPages ' +
        '(@/lib/postgrest), fetchAll (_shared/paginate.ts) ou truncagem HONESTA (janela + count exato no ' +
        `mesmo request + aviso na tela, padrão useSalesOrders). Arquivos (baseline→medido): ${reintroducoes.join(', ')}`,
    ).toEqual([]);
    expect(
      quitacoes,
      `dívida quitada (total ou parcial) — ATUALIZE a baseline para ela só encolher: ${quitacoes.join(', ')}`,
    ).toEqual([]);
  });
});
