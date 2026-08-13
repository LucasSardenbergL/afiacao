import { describe, it, expect } from 'vitest';
import {
  avaliarCotacaoProposta,
  montarParamsProposta,
  formatarPrazoEntrega,
  MAX_BODY_TEMPLATE_META,
  type CotacaoRow,
} from './proposta-cotacao';
import type { CestaItem, CestaResult } from './cesta-recompra';
import type { CrossSellCand } from './cross-sell';

function mkItem(sku: number, qtd: number): CestaItem {
  return {
    omie_codigo_produto: sku, qtdSugerida: qtd, dueRatio: 1, nPedidos: 4,
    cadenciaDias: 30, confidence: 'alta', motivo: 'recorrente_due', ultimoPrecoRef: 999,
  };
}
function mkCesta(principal: CestaItem[], secundarios: CestaItem[] = []): CestaResult {
  return { principal, secundarios, totalPedidos: 6, confianca: 'alta' };
}
function mkRow(sku: number, over: Partial<CotacaoRow> = {}): CotacaoRow {
  return {
    omie_codigo_produto: sku, product_id: `uuid-${sku}`, codigo: `C${sku}`,
    descricao: `PRODUTO ${sku}`, unidade: 'UN', ativo: true, estoque: 100,
    preco: 10, fonte_preco: 'praticado', ...over,
  };
}

const CORPO_REF = 'Olá, {{1}}! Preparamos sua reposição para a entrega de {{2}} na sua região: {{3}}. Quer que a gente já separe? Responda SIM ou fale com sua vendedora. Para não receber mais, responda PARAR.';

const baseInput = {
  crossSell: [] as CrossSellCand[],
  nomesPorSku: { 1: 'LIXA A275', 2: 'THINNER 4403', 3: 'VERNIZ X' } as Record<number, string>,
  prazoEntrega: { iso: '2026-07-14', label: 'amanhã (14/07)' },
  primeiroNome: 'João',
  telefone: '5537999990000',
  template: { corpoReferencia: CORPO_REF, ativo: true },
};

describe('avaliarCotacaoProposta — travas fail-closed (money-path: ausente ≠ zero)', () => {
  it('caminho feliz: linhas válidas → sem travas, total = Σ qtd×preço recotado, render presente', () => {
    const r = avaliarCotacaoProposta({
      ...baseInput,
      cesta: mkCesta([mkItem(1, 2)], [mkItem(2, 1)]),
      cotacao: [mkRow(1, { preco: 10.5 }), mkRow(2, { preco: 45 })],
    });
    expect(r.travada).toBe(false);
    expect(r.travasGerais).toEqual([]);
    expect(r.linhas.map(l => l.motivoTrava)).toEqual([null, null]);
    expect(r.total).toBeCloseTo(2 * 10.5 + 1 * 45);
    // o preço da linha é o RECOTADO — nunca o ultimoPrecoRef (999) da cesta
    expect(r.linhas[0].preco).toBe(10.5);
    // o render é a mensagem EXATA (corpo do template + params)
    expect(r.render).toBe('Olá, João! Preparamos sua reposição para a entrega de amanhã (14/07) na sua região: 2× LIXA A275; 1× THINNER 4403. Quer que a gente já separe? Responda SIM ou fale com sua vendedora. Para não receber mais, responda PARAR.');
  });

  it('linha sem preço (RPC devolve NULL) → trava a proposta INTEIRA, total/render null (nunca parcial)', () => {
    const r = avaliarCotacaoProposta({
      ...baseInput,
      cesta: mkCesta([mkItem(1, 2), mkItem(2, 1)]),
      cotacao: [mkRow(1), mkRow(2, { preco: null, fonte_preco: null })],
    });
    expect(r.travada).toBe(true);
    expect(r.total).toBeNull();
    expect(r.render).toBeNull();
    expect(r.linhas[0].motivoTrava).toBeNull();
    expect(r.linhas[1].motivoTrava).toBe('sem_preco');
  });

  it('preço 0 vindo por engano (defesa em profundidade) → sem_preco, jamais soma R$0', () => {
    const r = avaliarCotacaoProposta({
      ...baseInput,
      cesta: mkCesta([mkItem(1, 2)]),
      cotacao: [mkRow(1, { preco: 0, fonte_preco: 'tabela' })],
    });
    expect(r.travada).toBe(true);
    expect(r.linhas[0].motivoTrava).toBe('sem_preco');
    expect(r.total).toBeNull();
  });

  it('qtd sugerida 0/NaN/negativa (histórico zerado) → qtd_invalida — nunca "0× PRODUTO" (Codex P0)', () => {
    for (const qtd of [0, NaN, -2]) {
      const r = avaliarCotacaoProposta({
        ...baseInput,
        cesta: mkCesta([mkItem(1, qtd)]),
        cotacao: [mkRow(1)],
      });
      expect(r.linhas[0].motivoTrava).toBe('qtd_invalida');
      expect(r.travada).toBe(true);
      expect(r.total).toBeNull();
    }
  });

  it('estoque NULL/NaN/Infinity = informação não-confiável (≠ zero) → sem_estoque_info (Codex P0)', () => {
    for (const estoque of [null, NaN, Infinity]) {
      const r = avaliarCotacaoProposta({
        ...baseInput,
        cesta: mkCesta([mkItem(1, 2)]),
        cotacao: [mkRow(1, { estoque })],
      });
      expect(r.linhas[0].motivoTrava).toBe('sem_estoque_info');
      expect(r.travada).toBe(true);
    }
  });

  it('estoque menor que a quantidade sugerida → estoque_insuficiente', () => {
    const r = avaliarCotacaoProposta({
      ...baseInput,
      cesta: mkCesta([mkItem(1, 5)]),
      cotacao: [mkRow(1, { estoque: 3 })],
    });
    expect(r.linhas[0].motivoTrava).toBe('estoque_insuficiente');
  });

  it('SKU inativo → inativo; unidade vazia → sem_unidade; sem linha na cotação → nao_encontrado', () => {
    const r = avaliarCotacaoProposta({
      ...baseInput,
      cesta: mkCesta([mkItem(1, 1), mkItem(2, 1), mkItem(3, 1)]),
      cotacao: [mkRow(1, { ativo: false }), mkRow(2, { unidade: '  ' })],
    });
    expect(r.linhas[0].motivoTrava).toBe('inativo');
    expect(r.linhas[1].motivoTrava).toBe('sem_unidade');
    expect(r.linhas[2].motivoTrava).toBe('nao_encontrado');
    expect(r.travada).toBe(true);
  });

  it('travas gerais: sem prazo / sem nome / sem telefone travam mesmo com linhas OK', () => {
    const cesta = mkCesta([mkItem(1, 1)]);
    const cotacao = [mkRow(1)];
    expect(avaliarCotacaoProposta({ ...baseInput, cesta, cotacao, prazoEntrega: null }).travasGerais).toContain('sem_prazo');
    expect(avaliarCotacaoProposta({ ...baseInput, cesta, cotacao, primeiroNome: null }).travasGerais).toContain('sem_nome');
    expect(avaliarCotacaoProposta({ ...baseInput, cesta, cotacao, primeiroNome: '  ' }).travasGerais).toContain('sem_nome');
    expect(avaliarCotacaoProposta({ ...baseInput, cesta, cotacao, telefone: null }).travasGerais).toContain('sem_telefone');
    const r = avaliarCotacaoProposta({ ...baseInput, cesta, cotacao, prazoEntrega: null });
    expect(r.travada).toBe(true);
    expect(r.total).toBeNull();
  });

  it('template ilegível → template_indisponivel; inativo → template_inativo (sem "mensagem exata" não há envio — Codex P1)', () => {
    const cesta = mkCesta([mkItem(1, 1)]);
    const cotacao = [mkRow(1)];
    const semTpl = avaliarCotacaoProposta({ ...baseInput, cesta, cotacao, template: null });
    expect(semTpl.travasGerais).toContain('template_indisponivel');
    expect(semTpl.travada).toBe(true);
    expect(semTpl.render).toBeNull();
    const inativo = avaliarCotacaoProposta({
      ...baseInput, cesta, cotacao,
      template: { corpoReferencia: CORPO_REF, ativo: false },
    });
    expect(inativo.travasGerais).toContain('template_inativo');
    expect(inativo.travada).toBe(true);
  });

  it('corpo renderizado acima do limite Meta → mensagem_longa (trava explícita, sem truncar — Codex P2)', () => {
    const nomeGigante = 'X'.repeat(MAX_BODY_TEMPLATE_META);
    const r = avaliarCotacaoProposta({
      ...baseInput,
      nomesPorSku: { 1: nomeGigante },
      cesta: mkCesta([mkItem(1, 1)]),
      cotacao: [mkRow(1)],
    });
    expect(r.travasGerais).toContain('mensagem_longa');
    expect(r.travada).toBe(true);
    expect(r.render).toBeNull();
    expect(r.total).toBeNull();
  });

  it('travasExtras do orquestrador (ex.: conversa de outro cliente) travam a proposta', () => {
    const r = avaliarCotacaoProposta({
      ...baseInput,
      cesta: mkCesta([mkItem(1, 1)]),
      cotacao: [mkRow(1)],
      travasExtras: ['conversa_de_outro_cliente'],
    });
    expect(r.travasGerais).toContain('conversa_de_outro_cliente');
    expect(r.travada).toBe(true);
  });

  it('cesta vazia → trava geral cesta_vazia (nada a propor não é proposta)', () => {
    const r = avaliarCotacaoProposta({ ...baseInput, cesta: mkCesta([]), cotacao: [] });
    expect(r.travasGerais).toContain('cesta_vazia');
    expect(r.travada).toBe(true);
  });

  it('cross-sell indisponível é REMOVIDO (recomendação, não promessa) — não trava a cesta', () => {
    const r = avaliarCotacaoProposta({
      ...baseInput,
      cesta: mkCesta([mkItem(1, 1)]),
      crossSell: [
        { omie_codigo_produto: 30, nome: 'OK CROSS', lie: 5 },
        { omie_codigo_produto: 31, nome: 'INATIVO CROSS', lie: 4 },
        { omie_codigo_produto: 32, nome: 'SEM ESTOQUE CROSS', lie: 3 },
        { omie_codigo_produto: 33, nome: 'SUMIDO CROSS', lie: 2 },
      ],
      cotacao: [
        mkRow(1),
        mkRow(30), mkRow(31, { ativo: false }), mkRow(32, { estoque: 0 }),
      ],
    });
    expect(r.travada).toBe(false);
    expect(r.crossSellOk.map(x => x.omie_codigo_produto)).toEqual([30]);
    expect(r.crossSellRemovidos.map(x => x.motivo)).toEqual(['inativo', 'estoque_insuficiente', 'nao_encontrado']);
    // cross-sell não entra no total (sem qtd, sem preço citado)
    expect(r.total).toBeCloseTo(10);
    // mas entra na mensagem como sugestão
    expect(r.render).toContain('sugestão: OK CROSS');
  });

  it('só os secundários DENTRO da janela enviada (maxSecundarios) são cotados/travantes', () => {
    const r = avaliarCotacaoProposta({
      ...baseInput,
      cesta: mkCesta([mkItem(1, 1)], [mkItem(2, 1), mkItem(3, 1), mkItem(4, 1), mkItem(5, 1)]),
      maxSecundarios: 3,
      // SKU 5 (4º secundário, fora da janela) sem cotação — NÃO pode travar
      cotacao: [mkRow(1), mkRow(2), mkRow(3), mkRow(4)],
    });
    expect(r.travada).toBe(false);
    expect(r.linhas.map(l => l.omie_codigo_produto)).toEqual([1, 2, 3, 4]);
  });
});

describe('montarParamsProposta — params do template HSM ({{1}} nome, {{2}} prazo, {{3}} cesta compacta)', () => {
  it('monta os 3 params; itens "qtd× nome" separados por "; "', () => {
    const r = avaliarCotacaoProposta({
      ...baseInput,
      cesta: mkCesta([mkItem(1, 2)], [mkItem(2, 1.5)]),
      cotacao: [mkRow(1), mkRow(2)],
    });
    const params = montarParamsProposta({
      primeiroNome: 'João', prazoLabel: 'amanhã (14/07)',
      linhas: r.linhas, crossSellOk: r.crossSellOk,
    });
    expect(params).toEqual(['João', 'amanhã (14/07)', '2× LIXA A275; 1.5× THINNER 4403']);
  });

  it('cross-sell entra como sugestão no fim do {{3}} (singular/plural)', () => {
    const linhas = avaliarCotacaoProposta({
      ...baseInput, cesta: mkCesta([mkItem(1, 1)]), cotacao: [mkRow(1)],
    }).linhas;
    const um = montarParamsProposta({
      primeiroNome: 'João', prazoLabel: 'amanhã (14/07)', linhas,
      crossSellOk: [{ nome: 'VERNIZ X' }],
    });
    expect(um[2]).toBe('1× LIXA A275; sugestão: VERNIZ X');
    const dois = montarParamsProposta({
      primeiroNome: 'João', prazoLabel: 'amanhã (14/07)', linhas,
      crossSellOk: [{ nome: 'VERNIZ X' }, { nome: 'COLA Y' }],
    });
    expect(dois[2]).toBe('1× LIXA A275; sugestões: VERNIZ X, COLA Y');
  });
});

describe('formatarPrazoEntrega — determinístico, fail-closed (nunca fabrica prazo)', () => {
  it('rota de amanhã → "amanhã (DD/MM)"', () => {
    expect(formatarPrazoEntrega('2026-07-13', '2026-07-14', false))
      .toEqual({ iso: '2026-07-14', label: 'amanhã (14/07)' });
  });
  it('dia só-diárias (sem rota) → entrega diária de amanhã', () => {
    expect(formatarPrazoEntrega('2026-07-13', null, true))
      .toEqual({ iso: '2026-07-14', label: 'amanhã (14/07)' });
  });
  it('sem rota e sem diária → null (trava sem_prazo; jamais inventa data)', () => {
    expect(formatarPrazoEntrega('2026-07-13', null, false)).toBeNull();
  });
  it('routeDate ≠ amanhã (defensivo) → só a data, sem "amanhã"', () => {
    expect(formatarPrazoEntrega('2026-07-13', '2026-07-16', false))
      .toEqual({ iso: '2026-07-16', label: '16/07' });
  });
});
