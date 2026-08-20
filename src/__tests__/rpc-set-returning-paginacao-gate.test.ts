import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { resolve, join } from 'node:path';

/**
 * Gate: RPC **set-returning** chamada do frontend precisa PAGINAR.
 *
 * A capa de 1.000 linhas do PostgREST vale para `.rpc()` exatamente como vale para `.from()`,
 * e é SILENCIOSA: a resposta capada é indistinguível de "acabou". `fetchAllPages` só protege
 * quem passa por ele, então a RPC crua é o ponto cego — e a varredura que paginou as TABELAS
 * não alcança RPC nenhuma. Já mordeu duas vezes, nas duas o motor parecia funcionar:
 *
 *   #1782 `get_skus_margem_positiva` (2.462 linhas) — gate de EXCLUSÃO: perdida a cauda, o lote
 *         sai vazio, o writer pula a gravação de propósito e `farmer_bundle_recommendations`
 *         CONGELA. Sem erro, sem toast.
 *   #1765→este `get_carteira_margem_faixa` (1.227 linhas) — 227 clientes caem fora do Map e
 *         viram `margemFaixa: 'neutro'` com o health score renormalizado: veredito FABRICADO,
 *         indistinguível de "margem não apurável".
 *
 * Em ambos a defesa existente cobria o vazio TOTAL (erro de transporte, `data: null`) e era
 * cega ao vazio PARCIAL. É o §6 do money-path: um universo lido pela metade produz um
 * resultado que PARECE completo.
 *
 * COMO ESTE GATE FUNCIONA. A fonte da verdade de "quem é set-returning" é o próprio
 * `types.ts` gerado do schema (`Returns: {...}[]`), então RPC nova entra sozinha na vigilância
 * — não há lista para alguém esquecer de atualizar.
 *
 * A BASELINE abaixo é dívida ENUMERADA, não aprovada. São as 23 chamadas que já existiam
 * quando o gate nasceu, e o motivo de estarem aqui em vez de corrigidas é honesto: `claude_ro`
 * não tem EXECUTE nessas funções, então eu não pude MEDIR o universo de cada uma, e paginar no
 * escuro mudaria comportamento de reposição/financeiro/pricing sem prova. Fabricar uma
 * justificativa por linha ("universo pequeno") seria exatamente o `Number(null)===0` da
 * apuração. O gate impede a lista de CRESCER e obriga a encolher: entrada que some do código
 * tem de sair daqui também.
 *
 * ⚠️ Estar na baseline NÃO é atestado de segurança. Três são de risco money-path conhecido —
 * `get_ultimos_precos_cliente` (preço de partida), `reposicao_pos_candidatos` e
 * `get_carteira_margem_faixa`-like — e continuam registradas como chip do founder.
 */

const RAIZ = resolve(__dirname, '../..');

/** Comentário entre `.rpc()` e `.range()` é ruído — e neste repo ele é LONGO de propósito. */
function semComentarios(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^[ \t]*\/\/[^\n]*/gm, '');
}

/** Nomes cujo `Returns` no types.ts é ARRAY — só esses sofrem a capa de linhas. */
export function nomesSetReturning(types: string): Set<string> {
  const nomes = new Set<string>();
  for (const m of types.matchAll(/^ {6}(\w+): \{\s*$/gm)) {
    const trecho = types.slice(m.index!, m.index! + 2500);
    const fim = trecho.indexOf('\n      }');
    const corpo = fim > 0 ? trecho.slice(0, fim) : trecho;
    if (/Returns:[\s\S]*?\}\[\]/.test(corpo) || /Returns:\s*\w+\[\]/.test(corpo)) nomes.add(m[1]);
  }
  for (const m of types.matchAll(/^ {6}(\w+): \{[^\n]*Returns:\s*[^;\n}]*\[\][^\n]*\}/gm)) nomes.add(m[1]);
  return nomes;
}

/**
 * Chamadas `.rpc('nome')` de função set-returning SEM `.range()` à vista.
 * Puro de propósito: é o que as fixtures abaixo falsificam sem tocar arquivo real.
 */
export function chamadasSemPaginacao(fonte: string, setReturning: Set<string>): string[] {
  const txt = semComentarios(fonte);
  const achados: string[] = [];
  for (const m of txt.matchAll(/\.rpc\(\s*'([a-z0-9_]+)'/g)) {
    if (!setReturning.has(m[1])) continue;
    if (!/\.range\(/.test(txt.slice(m.index!, m.index! + 400))) achados.push(m[1]);
  }
  return achados;
}

function arquivosFonte(dir: string, out: string[] = []): string[] {
  for (const n of readdirSync(dir)) {
    const p = join(dir, n);
    if (statSync(p).isDirectory()) {
      if (n !== 'node_modules' && n !== '__tests__') arquivosFonte(p, out);
    } else if (/\.tsx?$/.test(n) && !/\.test\.tsx?$/.test(n) && !p.endsWith('types.ts')) {
      out.push(p);
    }
  }
  return out;
}

/** Dívida existente quando o gate nasceu (2026-08-19). NÃO é aprovação — ver cabeçalho. */
const BASELINE = new Set<string>([
  'carteira_por_municipio @ src/hooks/useRoutePlanner.ts',
  'fin_analise_cp_dimensoes_rpc @ src/services/financeiroV2Service.ts',
  'fin_analise_cr_dimensoes_rpc @ src/services/financeiroV2Service.ts',
  'fin_consolidado_intercompany @ src/pages/FinanceiroIntercompany.tsx',
  'fin_estimar_estoque_omie @ src/hooks/useEstoqueValor.ts',
  'fin_projecao_13_semanas @ src/hooks/dashboard/useFinanceiroZone.ts',
  'fin_regua_condicao_prazo @ src/hooks/useCustoPrazoRegua.ts',
  'gerar_pedidos_sugeridos_ciclo @ src/pages/AdminReposicaoPedidos.tsx',
  'get_data_health @ src/hooks/useDataHealth.ts',
  'get_ultimos_precos_cliente @ src/hooks/unifiedOrder/useCustomerSelection.ts',
  'get_whatsapp_funil @ src/hooks/useWhatsappFunil.ts',
  'get_whatsapp_pendentes @ src/hooks/useWhatsappPendentes.ts',
  'get_whatsapp_proposta_cotacao @ src/pages/RotaPropostas.tsx',
  'list_impersonation_targets @ src/hooks/useImpersonationTargets.ts',
  'listar_pedidos_a_separar @ src/queries/usePedidosASeparar.ts',
  'radar_contagem_por_municipio @ src/queries/useRadarCidadesRota.ts',
  'radar_prospects_para_rota @ src/hooks/useRoutePlanner.ts',
  'reposicao_pos_candidatos @ src/pages/AdminReposicaoPedidos.tsx',
  'reposicao_pos_marcador @ src/pages/AdminReposicaoPedidos.tsx',
  'reverter_run_auto @ src/hooks/useParamAutoMudancas.ts',
  'staff_get_sales_order_payload @ src/components/salesOrderEdit/useSalesOrderEdit.ts',
  'staff_get_sales_order_payload @ src/components/salesOrders/useSalesOrderDetail.ts',
  'staff_get_sales_order_payload @ src/pages/SalesPrintDashboard.tsx',
]);

function achadosAtuais(): string[] {
  const setReturning = nomesSetReturning(
    readFileSync(resolve(RAIZ, 'src/integrations/supabase/types.ts'), 'utf8'),
  );
  const achados: string[] = [];
  for (const f of arquivosFonte(resolve(RAIZ, 'src'))) {
    const rel = f.replace(RAIZ + '/', '');
    for (const nome of chamadasSemPaginacao(readFileSync(f, 'utf8'), setReturning)) {
      achados.push(`${nome} @ ${rel}`);
    }
  }
  return achados;
}

describe('RPC set-returning chamada do frontend pagina', () => {
  it('não nasce chamada NOVA sem `.range()`', () => {
    const novas = [...new Set(achadosAtuais())].filter((a) => !BASELINE.has(a)).sort();
    expect(
      novas,
      `RPC set-returning chamada sem paginar (a capa de 1.000 do PostgREST vale para .rpc()):\n` +
        novas.map((n) => `  - ${n}`).join('\n') +
        `\nPagine com fetchAllPages + .order() ESTÁVEL + .range(), como em useBundleEngine.ts.`,
    ).toEqual([]);
  });

  it('a baseline encolhe: entrada que sumiu do código sai da lista', () => {
    // Sem isto a lista apodrece e passa a "aprovar" chamadas que não existem mais — e o
    // próximo leitor lê 23 dívidas onde há 5.
    const atuais = new Set(achadosAtuais());
    const obsoletas = [...BASELINE].filter((b) => !atuais.has(b)).sort();
    expect(obsoletas, `saíram do código — remova da BASELINE:\n${obsoletas.join('\n')}`).toEqual([]);
  });

  it('FALSIFICAÇÃO: o gate acusa uma chamada crua e absolve a paginada', () => {
    // Gate inerte é o pior desfecho: passa verde para sempre e ninguém percebe. Estas
    // fixtures provam a detecção sem sabotar arquivo real.
    const setRet = new Set(['minha_rpc_grande']);

    expect(chamadasSemPaginacao(`const { data } = await supabase.rpc('minha_rpc_grande');`, setRet))
      .toEqual(['minha_rpc_grande']);

    expect(
      chamadasSemPaginacao(
        `fetchAllPages((de, ate) => supabase.rpc('minha_rpc_grande').order('id').range(de, ate), 'x')`,
        setRet,
      ),
    ).toEqual([]);

    // Escalar não sofre capa de LINHAS — acusá-la seria ruído que faria o gate ser ignorado.
    expect(chamadasSemPaginacao(`await supabase.rpc('rpc_escalar')`, setRet)).toEqual([]);

    // O comentário longo entre `.rpc()` e `.range()` é o idioma deste repo: não pode gerar
    // falso positivo (foi o que aconteceu na primeira medição, com o próprio fix do #1782).
    expect(
      chamadasSemPaginacao(
        `supabase.rpc('minha_rpc_grande')\n` +
          Array.from({ length: 12 }, (_, i) => `  // linha de comentário bem comprida número ${i} explicando o porquê`).join('\n') +
          `\n  .order('id', { ascending: true })\n  .range(de, ate)`,
        setRet,
      ),
    ).toEqual([]);
  });

  it('a fonte da verdade é o types.ts: set-returning é `Returns` ARRAY', () => {
    const types = readFileSync(resolve(RAIZ, 'src/integrations/supabase/types.ts'), 'utf8');
    const nomes = nomesSetReturning(types);
    // As duas que já morderam o repo — se o parser parar de reconhecê-las, o gate fica cego.
    expect(nomes.has('get_carteira_margem_faixa')).toBe(true);
    expect(nomes.has('get_skus_margem_positiva')).toBe(true);
    // Escalar (`Returns: Json`) fica de fora.
    expect(nomes.has('get_carteira_saude')).toBe(false);
  });
});
