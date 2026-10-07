import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  parseBRL, parseDiasPrzEnt, casarLinhasComItens, validarGrupoLeadtime, derivarCustos,
  consolidarLinhasPortal, extrairAddJson, resumirCaptura, round2, toleranciaChecksum, classificarErroRpcCusto,
  centavosDaMercadoria, centesimosDaAliquota, ipiCentavos,
  type ItemPedido, type LinhaPortal, type LinhaDom, type AddJsonPortal, type ItemEsperado,
} from '../sayerlack-scraping-pedido';

const item = (o: Partial<ItemPedido> = {}): ItemPedido => ({
  item_id: 1, sku_codigo_omie: 'OMIE1', sku_descricao: 'd', sku_portal: 'P1', qtde_final: 2, ...o,
});
const linha = (o: Partial<LinhaPortal> = {}): LinhaPortal => ({ sku_portal: 'P1', prz_ent_raw: '8', total_linha: 20, valor_ipi: 0.65, ...o });

// ---------------------------------------------------------------------------------------------
// ESPELHO: a semântica mora no Deno (supabase/functions/enviar-pedido-portal-sayerlack/captura-custo.ts,
// deno test). Este arquivo prova (1) que o bloco espelhado é IDÊNTICO byte a byte, (2) que os call-sites das
// edges consomem o helper (igualdade textual não prova consumo — Codex P2, money-path.md) e (3) a paridade
// com o arquivo-ouro dos 29 pedidos reais, que a prova PG17 (db/test-sayerlack-ipi-po.sh) também confere.
// ---------------------------------------------------------------------------------------------
const RAIZ = resolve(__dirname, '../../../..');
const EDGE_DIR = 'supabase/functions/enviar-pedido-portal-sayerlack';
const ler = (p: string) => readFileSync(resolve(RAIZ, p), 'utf8');
const INICIO = '// >>> ESPELHO(captura-custo) INICIO';
const FIM = '// <<< ESPELHO(captura-custo) FIM';
function bloco(fonte: string, nome: string): string {
  const a = fonte.indexOf(INICIO);
  const b = fonte.indexOf(FIM);
  if (a === -1 || b === -1 || b < a) throw new Error(`${nome}: marcadores do espelho ausentes/invertidos`);
  return fonte.slice(a, b + FIM.length);
}

describe('classificarErroRpcCusto (espelho src): casa a MARCA da SQLSTATE, nunca "lançou algo"', () => {
  it('CP001–CP004, CP006 e CP007 viram o motivo do ramo; o resto (inclusive o CP005 aposentado) vira erro_rpc', () => {
    expect(classificarErroRpcCusto('CP001')).toBe('payload_invalido');
    expect(classificarErroRpcCusto('CP002')).toBe('po_omie_existente');
    expect(classificarErroRpcCusto('CP003')).toBe('pedido_nao_elegivel');
    expect(classificarErroRpcCusto('CP004')).toBe('itens_divergentes');
    expect(classificarErroRpcCusto('CP006')).toBe('aliquota_ipi_ausente');
    expect(classificarErroRpcCusto('CP007')).toBe('prova_ipi_divergente');
    expect(classificarErroRpcCusto('CP005')).toBe('erro_rpc');
    expect(classificarErroRpcCusto('42501')).toBe('erro_rpc');
    expect(classificarErroRpcCusto('cp002')).toBe('erro_rpc');
    expect(classificarErroRpcCusto(undefined)).toBe('erro_rpc');
    expect(classificarErroRpcCusto(null)).toBe('erro_rpc');
  });
});

describe('espelho Deno ↔ src (captura de custo)', () => {
  it('sentinela: o bloco existe nos DOIS arquivos e tem corpo (não é comparação de vazio com vazio)', () => {
    const deno = bloco(ler(`${EDGE_DIR}/captura-custo.ts`), 'deno');
    const src = bloco(ler('src/lib/reposicao/sayerlack-scraping-pedido.ts'), 'src');
    expect(deno.length).toBeGreaterThan(5_000);
    expect(deno).toContain('export function consolidarLinhasPortal(');
    expect(src).toContain('export function consolidarLinhasPortal(');
  });
  it('o bloco espelhado é IDÊNTICO byte a byte (edite no Deno e copie pra cá)', () => {
    const deno = bloco(ler(`${EDGE_DIR}/captura-custo.ts`), 'deno');
    const src = bloco(ler('src/lib/reposicao/sayerlack-scraping-pedido.ts'), 'src');
    expect(src).toBe(deno);
  });
  it('call-site da edge: lê as alíquotas pela função do banco, consolida com o IPI e interpola extrairAddJson no browser', () => {
    const edge = ler(`${EDGE_DIR}/index.ts`);
    expect(edge).toContain('from "./captura-custo.ts"');
    expect(edge).toContain('const extrairAddJson = ${extrairAddJson.toString()};');
    expect(edge).toMatch(/portalAddJson = extrairAddJson\(r\.parsed\)/);
    expect(edge).toMatch(/supabase\.rpc\("sayerlack_ipi_itens", \{ p_pedido_id: pedido\.id \}\)/);
    expect(edge).toMatch(/consolidarLinhasPortal\(capturados, addJson, esperados, eIpi \|\| !Array\.isArray\(ipiRows\) \? 'falhou' : 'ok'\)/);
    expect(edge).toMatch(/casarLinhasComItens\(cons\.linhas, itensParaCusto\)/);
    expect(edge).toContain("'[SENSOR_CAPTURA_CUSTO_CEGA]'");
    expect(edge).toContain('captura_custo: resumo');
    // O defeito histórico: "total" = última célula (coluna de ações). Não pode voltar.
    expect(edge).not.toContain('texts[texts.length - 1]');
    // O pulo 'sem_mudanca' e a leitura de preco_atual que o alimentava saíram: todo item é gravado.
    expect(edge).not.toContain('preco_atual');
    expect(edge).toMatch(/if \(pedidoInteiroProvado\) \{/);
    expect(edge).toMatch(/p_valor_total: cons\.total_pedido/);
  });
  it('call-site da edge: a escrita do custo é UMA RPC transacional (CAS + pedido inteiro + IPI conferido), não update item a item', () => {
    const edge = ler(`${EDGE_DIR}/index.ts`);
    expect(edge).toMatch(/supabase\.rpc\("sayerlack_aplicar_custo_portal", \{\s*p_pedido_id: pedido\.id,\s*p_itens: derivado\.updates,\s*p_valor_total: cons\.total_pedido,/);
    expect(edge).toMatch(/classificarErroRpcCusto\(eRpc\.code\)/);
    expect(edge).toMatch(/resumirCaptura\(\{[^}]*erroRpc/);
    expect(edge).not.toMatch(/\.update\(\{ preco_unitario: u\.preco_unitario/);
    expect(edge).not.toMatch(/\.update\(\{ valor_total: cons\.total_pedido \}\)/);
    expect(edge).toMatch(/cons\.total_pedido != null && match\.naoCasados\.length === 0/);
    expect(edge).toMatch(/&& pulados\.length === 0;/);
  });
  it('call-site do disparo: os itens do PO saem de montarProdutosIncluir (pedido inteiro), lidos com select("*")', () => {
    const disparo = ler('supabase/functions/disparar-pedidos-aprovados/index.ts');
    expect(disparo).toContain('from "./produto-po.ts"');
    expect(disparo).toMatch(/= montarProdutosIncluir\(items as ItemRow\[\]\);/);
    expect(disparo).not.toMatch(/nValUnit: Number\(it\.preco_unitario\)/);
    // A leitura dos itens do PO (`// a. Items`) tem de trazer as colunas da decomposição sem citá-las (banco sem a
    // migration não quebra): voltar à lista explícita de colunas desligaria o preço exato EM SILÊNCIO — o PO volta
    // ao IPI embutido, com o total certo, e nenhum outro teste acusa.
    const a = disparo.indexOf('// a. Items');
    expect(a).toBeGreaterThan(0);
    const leitura = disparo.slice(a, disparo.indexOf('.eq("pedido_id", pedido.id)', a));
    expect(leitura).toContain('.from("pedido_compra_item")');
    expect(leitura).toContain('.select("*")');
  });
  it('bloco espelhado NÃO tem crase nem ${ dentro de extrairAddJson (vai pro Browserless por toString)', () => {
    const deno = ler(`${EDGE_DIR}/captura-custo.ts`);
    const a = deno.indexOf('export function extrairAddJson(');
    const b = deno.indexOf('\n}\n', a);
    const corpo = deno.slice(a, b);
    expect(corpo.length).toBeGreaterThan(500);
    expect(corpo).not.toContain('`');
    expect(corpo).not.toContain('${');
  });
});

describe('parseBRL', () => {
  it('parseia formato pt-BR (ponto=milhar, vírgula=decimal)', () => {
    expect(parseBRL('R$ 1.633,45')).toBe(1633.45);
    expect(parseBRL('20,00')).toBe(20);
    expect(parseBRL('1.000')).toBe(1000);
  });
  it('retorna null pra lixo', () => {
    expect(parseBRL('')).toBeNull();
    expect(parseBRL('abc')).toBeNull();
    expect(parseBRL(null as unknown as string)).toBeNull();
  });
});

describe('parseDiasPrzEnt', () => {
  it('extrai o inteiro de dias', () => {
    expect(parseDiasPrzEnt('8')).toBe(8);
    expect(parseDiasPrzEnt('8 dias')).toBe(8);
    expect(parseDiasPrzEnt(' 12 ')).toBe(12);
  });
  it('retorna null pra vazio/sem número', () => {
    expect(parseDiasPrzEnt('')).toBeNull();
    expect(parseDiasPrzEnt('n/a')).toBeNull();
  });
});

describe('casarLinhasComItens', () => {
  it('casa por sku_portal e parseia prz; mercadoria e IPI numéricos passam, null/NaN são terminais', () => {
    const r = casarLinhasComItens([linha()], [item()]);
    expect(r.casados).toHaveLength(1);
    expect(r.casados[0]).toMatchObject({ prz_ent: 8, total_linha: 20, valor_ipi: 0.65 });
    expect(casarLinhasComItens([linha({ total_linha: null })], [item()]).casados[0].total_linha).toBeNull();
    expect(casarLinhasComItens([linha({ valor_ipi: Number.NaN })], [item()]).casados[0].valor_ipi).toBeNull();
  });
  it('item sem linha no portal vira naoCasado', () => {
    const r = casarLinhasComItens([], [item()]);
    expect(r.naoCasados).toHaveLength(1);
    expect(r.casados).toHaveLength(0);
  });
  it('sku_portal em 2 itens vira ambíguo (de-para não é único por sku_portal)', () => {
    const r = casarLinhasComItens([linha()], [item(), item({ item_id: 2, sku_codigo_omie: 'OMIE2' })]);
    expect(r.ambiguos).toHaveLength(2);
    expect(r.casados).toHaveLength(0);
  });
  it('sku_portal em 2 linhas vira ambíguo', () => {
    expect(casarLinhasComItens([linha(), linha()], [item()]).ambiguos).toHaveLength(1);
  });
  it('item com sku_portal nulo vira naoCasado', () => {
    expect(casarLinhasComItens([linha()], [item({ sku_portal: null })]).naoCasados).toHaveLength(1);
  });
});

describe('validarGrupoLeadtime', () => {
  const match = (przs: (number | null)[]) => ({
    casados: przs.map((p, i) => ({ item: item({ item_id: i, sku_codigo_omie: `O${i}` }), prz_ent: p, total_linha: null, valor_ipi: null })),
    naoCasados: [], ambiguos: [],
  });
  it('ok quando todos os prz batem o esperado', () => {
    const r = validarGrupoLeadtime(match([8, 8]), 8);
    expect(r.status).toBe('ok');
    expect(r.mismatches).toHaveLength(0);
  });
  it('mismatch quando ≥1 prz difere', () => {
    const r = validarGrupoLeadtime(match([8, 15]), 8);
    expect(r.status).toBe('mismatch');
    expect(r.mismatches).toEqual([{ sku_codigo_omie: 'O1', prz_ent: 15, lt_esperado: 8 }]);
  });
  it('indisponivel quando ltEsperado é null (sem config de grupo)', () => {
    expect(validarGrupoLeadtime(match([8]), null).status).toBe('indisponivel');
  });
  it('indisponivel quando nada parseável (prz null)', () => {
    expect(validarGrupoLeadtime(match([null]), 8).status).toBe('indisponivel');
  });
  it('prz null não conta como mismatch — só pulado', () => {
    const r = validarGrupoLeadtime(match([8, null]), 8);
    expect(r.status).toBe('ok');
    expect(r.pulados).toEqual(['O1']);
  });
});

describe('derivarCustos', () => {
  const matchCusto = (o: { qtde: number; total: number | null; ipi: number | null }) => ({
    casados: [{ item: item({ item_id: 7, qtde_final: o.qtde }), prz_ent: 8, total_linha: o.total, valor_ipi: o.ipi }],
    naoCasados: [], ambiguos: [],
  });
  it('transporta mercadoria + IPI + o eco da qtde (os preços a RPC deriva)', () => {
    const r = derivarCustos(matchCusto({ qtde: 2, total: 426.8652, ipi: 27.75 }));
    expect(r.updates).toEqual([{ item_id: 7, qtde_final: 2, valor_mercadoria: 426.8652, valor_ipi: 27.75 }]);
  });
  it('todo item vira update, mesmo com o preço já igual (o pulo sem_mudanca saiu)', () => {
    expect(derivarCustos(matchCusto({ qtde: 1, total: 10, ipi: 0 })).updates).toHaveLength(1);
  });
  it('IPI ausente/negativo, mercadoria ou qtde inválida ⇒ pulado, sem fabricar custo', () => {
    expect(derivarCustos(matchCusto({ qtde: 1, total: 10, ipi: null })).pulados[0]).toMatchObject({ motivo: 'ipi_invalido' });
    expect(derivarCustos(matchCusto({ qtde: 1, total: 10, ipi: -1 })).pulados[0]).toMatchObject({ motivo: 'ipi_invalido' });
    expect(derivarCustos(matchCusto({ qtde: 1, total: Number.POSITIVE_INFINITY, ipi: 1 })).pulados[0]).toMatchObject({ motivo: 'total_invalido' });
    expect(derivarCustos(matchCusto({ qtde: 0, total: 10, ipi: 1 })).pulados[0]).toMatchObject({ motivo: 'qtde_invalida' });
  });
});

// Cobertura fina de consolidar/extrair/resumir vive no deno test (captura-custo.test.ts). Aqui o contrato que a
// src consome e a paridade com o arquivo-ouro.
describe('consolidarLinhasPortal (contrato espelhado)', () => {
  const dom = (o: Partial<LinhaDom> = {}): LinhaDom => ({ sku_portal: 'A', prz_ent_raw: '5', qtd_un_raw: '2', preco_venda_raw: '20,0000', preco_un_raw: '12,0000', ...o });
  const json: AddJsonPortal = { itens: [{ item: 'A', value: 12 }, { item: 'B', value: 30 }], value: 80.65, ordernum: 1 };
  const esp: ItemEsperado[] = [
    { sku_portal: 'A', qtde_portal: 2, ncm: '3208.10.20', aliquota_ipi_pct: 3.25 },
    { sku_portal: 'B', qtde_portal: 3, ncm: '3214.90.00', aliquota_ipi_pct: 0 },
  ];
  const domN = [dom(), dom({ sku_portal: 'B', qtd_un_raw: '3', preco_venda_raw: '60,0000', preco_un_raw: '30,0000' })];
  it('N itens com DOM provado e IPI (20 × 3,25% = 0,65; 60 × 0%) ⇒ dom_checksum', () => {
    const c = consolidarLinhasPortal(domN, json, esp, 'ok');
    expect(c.fonte).toBe('dom_checksum');
    expect(c.linhas.map((l) => [l.total_linha, l.valor_ipi])).toEqual([[20, 0.65], [60, 0]]);
    expect(c.checksum.total_modelado).toBe(80.65);
  });
  it('a soma SEM o IPI não fecha: o portal cobra a linha mais o IPI', () => {
    expect(consolidarLinhasPortal(domN, { ...json, value: 80 }, esp, 'ok').motivo).toBe('checksum_divergente');
  });
  it('NCM sem alíquota ⇒ nenhuma/ipi_ncm_desconhecido e a lista do que cadastrar', () => {
    const c = consolidarLinhasPortal(domN, json, [esp[0], { ...esp[1], aliquota_ipi_pct: null }], 'ok');
    expect(c).toMatchObject({ fonte: 'nenhuma', motivo: 'ipi_ncm_desconhecido', ncm_sem_aliquota: ['3214.90.00'] });
  });
  it('defeito de prod (DOM cego, N itens) ⇒ nenhuma/dom_incompleto e zero custo', () => {
    const c = consolidarLinhasPortal([dom({ sku_portal: '' }), dom({ sku_portal: '' })], json, esp, 'ok');
    expect(c).toMatchObject({ fonte: 'nenhuma', motivo: 'dom_incompleto' });
    expect(c.linhas.every((l) => l.total_linha === null && l.valor_ipi === null)).toBe(true);
  });
  it('extrairAddJson devolve null fora do form/add; resumirCaptura marca cega quando a fonte não provou', () => {
    expect(extrairAddJson({ success: true, message: 'Itens salvos na sessão com sucesso.' })).toBeNull();
    const c = consolidarLinhasPortal([], null, esp, 'ok');
    const r = resumirCaptura({ cons: c, match: null, pulados: [], planejados: 0, atualizados: 0, jaTemOmie: false, nDom: 0, nJson: 0, nItens: 2 });
    expect(r).toMatchObject({ cego: true, motivo: 'sem_json', ncm_sem_aliquota: [] });
  });
});

describe('helpers numéricos espelhados', () => {
  it('IPI em centavos inteiros = round(numeric, 2) do Postgres; o ponto flutuante erra a fronteira', () => {
    expect(ipiCentavos(6500, 650)).toBe(423);
    expect(round2(round2(65) * 6.5 / 100)).toBe(4.22);
    expect(centavosDaMercadoria(426.8652)).toBe(42687);
    expect(centesimosDaAliquota(3.25)).toBe(325);
    expect(centesimosDaAliquota(3.255)).toBeNull();
    expect(toleranciaChecksum(3)).toBeCloseTo(0.005 + 3 * 0.0101, 10);
  });
});

interface LinhaOuro { sku_portal: string; ncm: string; qtd_un_raw: string; preco_un_raw: string; preco_venda_raw: string; preco_venda: number; ipi: number }
interface PedidoOuro { pedido_id: number; total_json: number; total_modelado: number; linhas: LinhaOuro[] }
interface ArquivoOuro { aliquotas_pct: Record<string, number>; pedidos: PedidoOuro[] }

describe('paridade com o arquivo-ouro (29 pedidos reais, db/fixtures/sayerlack-ipi-backtest-20261005.json)', () => {
  const ouro = JSON.parse(ler('db/fixtures/sayerlack-ipi-backtest-20261005.json')) as ArquivoOuro;
  const ncm8 = (ncm: string) => ncm.replace(/\D/g, '');
  const montar = (p: PedidoOuro, aliq: (ncm: string) => number | null) => ({
    dom: p.linhas.map((l) => ({ sku_portal: l.sku_portal, prz_ent_raw: '5', qtd_un_raw: l.qtd_un_raw, preco_venda_raw: l.preco_venda_raw, preco_un_raw: l.preco_un_raw })),
    json: { itens: p.linhas.map((l) => ({ item: l.sku_portal, value: parseBRL(l.preco_un_raw) as number })), value: p.total_json, ordernum: p.pedido_id },
    esperados: p.linhas.map((l) => ({ sku_portal: l.sku_portal, qtde_portal: parseBRL(l.qtd_un_raw) as number, ncm: l.ncm, aliquota_ipi_pct: aliq(l.ncm) })),
  });
  const real = (ncm: string) => ouro.aliquotas_pct[ncm8(ncm)] ?? null;
  it('sentinela: 29 pedidos, 13 alíquotas, e o Preço Venda numérico é o parse do texto do DOM', () => {
    expect(ouro.pedidos).toHaveLength(29);
    expect(Object.keys(ouro.aliquotas_pct)).toHaveLength(13);
    for (const p of ouro.pedidos) for (const l of p.linhas) expect(parseBRL(l.preco_venda_raw)).toBe(l.preco_venda);
  });
  it('todo pedido real fecha a prova com IPI e reproduz o IPI de cada linha ao centavo', () => {
    for (const p of ouro.pedidos) {
      const { dom, json, esperados } = montar(p, real);
      const c = consolidarLinhasPortal(dom, json, esperados, 'ok');
      expect(c.fonte, `pedido ${p.pedido_id}`).toBe('dom_checksum');
      expect(c.linhas.map((l) => l.valor_ipi), `pedido ${p.pedido_id}`).toEqual(p.linhas.map((l) => l.ipi));
      expect(c.checksum.total_modelado, `pedido ${p.pedido_id}`).toBe(p.total_modelado);
    }
  });
  it('trocar a alíquota de UM NCM pela vizinha derruba todo pedido que o contém (identificabilidade, em CI)', () => {
    const vizinha: Record<string, number> = { '3.25': 6.5, '6.5': 3.25, '1.3': 0, '0': 1.3 };
    let derrubados = 0;
    for (const alvo of Object.keys(ouro.aliquotas_pct)) {
      const trocada = vizinha[String(ouro.aliquotas_pct[alvo])];
      for (const p of ouro.pedidos.filter((q) => q.linhas.some((l) => ncm8(l.ncm) === alvo))) {
        const { dom, json, esperados } = montar(p, (ncm) => (ncm8(ncm) === alvo ? trocada : real(ncm)));
        expect(consolidarLinhasPortal(dom, json, esperados, 'ok').motivo, `${alvo}→${trocada} no pedido ${p.pedido_id}`).toBe('checksum_divergente');
        derrubados++;
      }
    }
    expect(derrubados).toBeGreaterThan(29); // cada NCM em ≥1 pedido; os comuns em vários
  });
});
