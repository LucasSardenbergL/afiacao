import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  parseBRL, parseDiasPrzEnt, casarLinhasComItens, validarGrupoLeadtime, derivarCustos,
  consolidarLinhasPortal, extrairAddJson, resumirCaptura, round2, toleranciaChecksum, classificarErroRpcCusto,
  type ItemPedido, type LinhaPortal, type LinhaDom, type AddJsonPortal, type ItemEsperado,
} from '../sayerlack-scraping-pedido';

const item = (o: Partial<ItemPedido> = {}): ItemPedido => ({
  item_id: 1, sku_codigo_omie: 'OMIE1', sku_descricao: 'd', sku_portal: 'P1', qtde_final: 2, preco_atual: 10, ...o,
});
const linha = (o: Partial<LinhaPortal> = {}): LinhaPortal => ({ sku_portal: 'P1', prz_ent_raw: '8', total_linha: 20, ...o });

// ---------------------------------------------------------------------------------------------
// ESPELHO: a semântica mora no Deno (supabase/functions/enviar-pedido-portal-sayerlack/captura-custo.ts,
// deno test). Este arquivo prova (1) que o bloco espelhado é IDÊNTICO byte a byte e (2) que o call-site
// da edge consome o helper (igualdade textual não prova consumo — Codex P2, money-path.md).
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
  it('CP001..CP004 viram o motivo do ramo; qualquer outro código, caixa diferente ou ausência vira erro_rpc', () => {
    expect(classificarErroRpcCusto('CP001')).toBe('payload_invalido');
    expect(classificarErroRpcCusto('CP002')).toBe('po_omie_existente');
    expect(classificarErroRpcCusto('CP003')).toBe('pedido_nao_elegivel');
    expect(classificarErroRpcCusto('CP004')).toBe('itens_divergentes');
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
  it('call-site da edge: importa do módulo, consolida com os 3 conjuntos, interpola extrairAddJson no browser e não tem o total da última célula', () => {
    const edge = ler(`${EDGE_DIR}/index.ts`);
    expect(edge).toContain('from "./captura-custo.ts"');
    expect(edge).toContain('const extrairAddJson = ${extrairAddJson.toString()};');
    expect(edge).toMatch(/portalAddJson = extrairAddJson\(r\.parsed\)/);
    expect(edge).toMatch(/consolidarLinhasPortal\(capturados, addJson, esperados\)/);
    expect(edge).toMatch(/casarLinhasComItens\(cons\.linhas, itensParaCusto\)/);
    expect(edge).toContain("'[SENSOR_CAPTURA_CUSTO_CEGA]'");
    expect(edge).toContain('captura_custo: resumo');
    // O defeito histórico: "total" = última célula (coluna de ações). Não pode voltar.
    expect(edge).not.toContain('texts[texts.length - 1]');
    // Escrita só com o pedido inteiro provado, e o valor_total é o total PROVADO (data.value), não soma parcial.
    expect(edge).toMatch(/if \(pedidoInteiroProvado\) \{/);
    expect(edge).toMatch(/p_valor_total: cons\.total_pedido/);
  });
  it('call-site da edge: a escrita do custo é UMA RPC transacional (CAS no banco + tudo-ou-nada), não update item a item', () => {
    const edge = ler(`${EDGE_DIR}/index.ts`);
    // A RPC (migration 20260905090000_sayerlack_custo_portal_cas.sql) recebe o array de updates e o total provado.
    expect(edge).toMatch(/supabase\.rpc\("sayerlack_aplicar_custo_portal", \{\s*p_pedido_id: pedido\.id,\s*p_itens: derivado\.updates,\s*p_valor_total: cons\.total_pedido,/);
    // A recusa é classificada pela MARCA (SQLSTATE), e vai para o resumo/sensor como `erroRpc`.
    expect(edge).toMatch(/classificarErroRpcCusto\(eRpc\.code\)/);
    expect(edge).toMatch(/resumirCaptura\(\{[^}]*erroRpc/);
    // O defeito que a RPC fecha: escrita item a item em `pedido_compra_item` (parcial entre itens) e o
    // `valor_total` gravado à parte. Nenhum dos dois pode voltar à edge.
    // (o update de qtde inteira em pedido_compra_item, fora da captura, é outro writer legítimo — o alvo é o de CUSTO.)
    expect(edge).not.toMatch(/\.update\(\{ preco_unitario: u\.preco_unitario/);
    expect(edge).not.toMatch(/\.update\(\{ valor_total: cons\.total_pedido \}\)/);
    // O total provado entra na PROVA do pedido inteiro (sem total não há RPC — ela é tudo-ou-nada).
    expect(edge).toMatch(/cons\.total_pedido != null && match\.naoCasados\.length === 0/);
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
  it('casa por sku_portal e parseia prz; total_linha numérico passa, null é terminal', () => {
    const r = casarLinhasComItens([linha()], [item()]);
    expect(r.casados).toHaveLength(1);
    expect(r.casados[0].prz_ent).toBe(8);
    expect(r.casados[0].total_linha).toBe(20);
    expect(casarLinhasComItens([linha({ total_linha: null })], [item()]).casados[0].total_linha).toBeNull();
    expect(casarLinhasComItens([linha({ total_linha: Number.NaN })], [item()]).casados[0].total_linha).toBeNull();
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
    const r = casarLinhasComItens([linha(), linha()], [item()]);
    expect(r.ambiguos).toHaveLength(1);
  });
  it('item com sku_portal nulo vira naoCasado', () => {
    const r = casarLinhasComItens([linha()], [item({ sku_portal: null })]);
    expect(r.naoCasados).toHaveLength(1);
  });
});

describe('validarGrupoLeadtime', () => {
  const match = (przs: (number | null)[]) => ({
    casados: przs.map((p, i) => ({ item: item({ item_id: i, sku_codigo_omie: `O${i}` }), prz_ent: p, total_linha: null })),
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
  const matchCusto = (o: { qtde: number; preco_atual: number; total: number | null }) => ({
    casados: [{ item: item({ item_id: 7, qtde_final: o.qtde, preco_atual: o.preco_atual }), prz_ent: 8, total_linha: o.total }],
    naoCasados: [], ambiguos: [],
  });
  it('deriva unitário = total/qtde e sobrescreve quando difere', () => {
    const r = derivarCustos(matchCusto({ qtde: 4, preco_atual: 100, total: 1633.45 }));
    expect(r.updates).toHaveLength(1);
    expect(r.updates[0].item_id).toBe(7);
    expect(r.updates[0].valor_linha).toBe(1633.45);
    expect(r.updates[0].preco_unitario).toBeCloseTo(408.3625, 4);
  });
  it('mantém (não sobrescreve) quando o total da linha bate ao centavo', () => {
    const r = derivarCustos(matchCusto({ qtde: 4, preco_atual: 408.36, total: 1633.44 })); // 4*408.36=1633.44
    expect(r.updates).toHaveLength(0);
    expect(r.pulados[0]).toMatchObject({ motivo: 'sem_mudanca' });
  });
  it('pula total inválido (<=0, null, Infinity) sem fabricar custo', () => {
    expect(derivarCustos(matchCusto({ qtde: 4, preco_atual: 1, total: 0 })).updates).toHaveLength(0);
    expect(derivarCustos(matchCusto({ qtde: 4, preco_atual: 1, total: null })).updates).toHaveLength(0);
    expect(derivarCustos(matchCusto({ qtde: 4, preco_atual: 1, total: Number.POSITIVE_INFINITY })).pulados[0]).toMatchObject({ motivo: 'total_invalido' });
  });
  it('pula qtde inválida', () => {
    expect(derivarCustos(matchCusto({ qtde: 0, preco_atual: 1, total: 10 })).updates).toHaveLength(0);
  });
});

// Cobertura fina de consolidar/extrair/resumir vive no deno test (captura-custo.test.ts). Aqui só o
// contrato que a src consome: 1 caso feliz de cada fonte e o defeito de prod (DOM cego) sem custo.
describe('consolidarLinhasPortal (contrato espelhado)', () => {
  const dom = (o: Partial<LinhaDom> = {}): LinhaDom => ({ sku_portal: 'A', prz_ent_raw: '5', qtd_un_raw: '2', preco_venda_raw: '10,0000', preco_un_raw: '12,0000', ...o });
  const json: AddJsonPortal = { itens: [{ item: 'A', value: 12 }, { item: 'B', value: 30 }], value: 80, ordernum: 1 };
  const esp: ItemEsperado[] = [{ sku_portal: 'A', qtde_portal: 2 }, { sku_portal: 'B', qtde_portal: 3 }];
  it('N itens com DOM provado ⇒ dom_checksum', () => {
    const c = consolidarLinhasPortal([dom(), dom({ sku_portal: 'B', qtd_un_raw: '3', preco_venda_raw: '20,0000', preco_un_raw: '30,0000' })], json, esp);
    expect(c.fonte).toBe('dom_checksum');
    expect(c.linhas.map((l) => l.total_linha)).toEqual([20, 60]);
  });
  it('1 item ⇒ json_total_unico com o total do pedido', () => {
    const c = consolidarLinhasPortal([dom({ sku_portal: '', preco_venda_raw: '' })], { itens: [{ item: 'A', value: 12 }], value: 19.6, ordernum: 1 }, [esp[0]]);
    expect(c.fonte).toBe('json_total_unico');
    expect(c.linhas[0]).toMatchObject({ sku_portal: 'A', total_linha: 19.6 });
  });
  it('defeito de prod (DOM cego, N itens) ⇒ nenhuma/dom_incompleto e zero custo', () => {
    const c = consolidarLinhasPortal([dom({ sku_portal: '' }), dom({ sku_portal: '' })], json, esp);
    expect(c).toMatchObject({ fonte: 'nenhuma', motivo: 'dom_incompleto' });
    expect(c.linhas.every((l) => l.total_linha === null)).toBe(true);
  });
  it('extrairAddJson devolve null fora do form/add; resumirCaptura marca cega quando a fonte não provou', () => {
    expect(extrairAddJson({ success: true, message: 'Itens salvos na sessão com sucesso.' })).toBeNull();
    const c = consolidarLinhasPortal([], null, esp);
    const r = resumirCaptura({ cons: c, match: null, pulados: [], planejados: 0, atualizados: 0, jaTemOmie: false, nDom: 0, nJson: 0, nItens: 2 });
    expect(r).toMatchObject({ cego: true, motivo: 'sem_json' });
  });
});

describe('helpers numéricos espelhados', () => {
  it('round2 arredonda a centavo (com EPSILON) e toleranciaChecksum deriva do arredondamento exibido', () => {
    expect(round2(1.005)).toBe(1.01);
    expect(round2(1605.6738)).toBe(1605.67);
    expect(toleranciaChecksum([2, 2, 8])).toBeCloseTo(0.005 * 4 + 12 * 0.00005, 10);
  });
});
