import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within, fireEvent } from '@testing-library/react';
import type { AnaliseDimensional } from '@/services/financeiroV2Service';
import { MOTIVO_BAIXA_NAO_INGERIDA } from '@/lib/financeiro/procedencia-baixa';

/**
 * `/financeiro/analytics` afirmava "R$ 0,00 recebido" sobre R$ 27,8M de títulos com status
 * RECEBIDO — não por bug de cálculo, mas por exibir crua uma coluna que o ingest nunca preencheu
 * (#396: baixa = 0 em 44.524/44.524 CR e 16.125/16.125 CP, medido em prod 2026-09-09). Um número
 * tem a MESMA aparência quando é medido e quando é fabricado, então nada na tela convidava a
 * desconfiar — a família do `ausente ≠ zero` (CLAUDE.md), um andar acima do `|| 0`.
 *
 * A contenção tem de alcançar os QUATRO caminhos, não só a coluna que se olhou primeiro: coluna,
 * SALDO (que é `valor_documento` cheio para liquidado, pelo mesmo motivo), card de resumo e CSV —
 * o CSV é o que sai da tela e vira anexo, planilha e decisão.
 *
 * ⚠️ O último bloco é o CONTROLE, e é ele que impede a correção de mentir no sentido oposto: com a
 * baixa disponível, um total legitimamente ZERO tem de aparecer como `R$ 0,00`, não como "—".
 *
 * O ramo CP (Payables) não é exercitado aqui DE PROPÓSITO: trocá-lo exigiria abrir um `Select` do
 * Radix, que em jsdom não reage a `click`, e a tela não bifurca por tipo — card, coluna e CSV
 * chamam o mesmo `fmtBaixa`/`rotuloBaixa`. Quem cobre os dois razões é o teste do service
 * (`getAnaliseDimensional.test.ts`), onde as matviews são de fato diferentes.
 */

const getAnaliseDimensionalMock = vi.fn<() => Promise<AnaliseDimensional[]>>();
const downloadCSVMock = vi.fn<(conteudo: string, nome: string) => void>();

vi.mock('@/services/financeiroV2Service', () => ({
  getAnaliseDimensional: () => getAnaliseDimensionalMock(),
}));
vi.mock('@/services/financeiroService', () => ({
  downloadCSV: (conteudo: string, nome: string) => downloadCSVMock(conteudo, nome),
}));

import FinanceiroAnalytics from '../FinanceiroAnalytics';

/** Uma linha de recebíveis realista: R$ 27,8M de documento, com a baixa NÃO ingerida. */
const linhaDegradada: AnaliseDimensional = {
  company: 'colacor',
  ano: 2026,
  mes: 0,
  dimensao: 'categoria',
  valor_dimensao: 'VENDA DE MERCADORIA',
  qtd_titulos: 44_524,
  total_documento: 27_855_279.84,
  total_pago_recebido: null,
  total_saldo: null,
  motivo_baixa: MOTIVO_BAIXA_NAO_INGERIDA,
};

/** A MESMA tela com a baixa disponível e um período em que, de fato, nada entrou. */
const linhaZeroMedido: AnaliseDimensional = {
  ...linhaDegradada,
  total_pago_recebido: 0,
  total_saldo: 0,
  motivo_baixa: null,
};

/** Texto do VALOR do card, lido pela estrutura (rótulo e valor são irmãos). */
async function valorDoCard(rotulo: string) {
  // "Recebido" também é cabeçalho da tabela — o card é o `<p>`, e casar pelo texto solto pegaria
  // o `<th>` e aprovaria o card errado.
  const el = await waitFor(() => {
    const achado = screen.getAllByText(rotulo).find(e => e.tagName === 'P');
    if (!achado) throw new Error(`rótulo de card "${rotulo}" ausente`);
    return achado;
  });
  return el.nextElementSibling?.textContent ?? '';
}

/** Células da (única) linha de dados: [dimensão, qtd, total, baixa, saldo, %]. */
async function celulas() {
  const celula = await screen.findByText(linhaDegradada.valor_dimensao);
  const tr = celula.closest('tr');
  if (!tr) throw new Error('linha da tabela ausente');
  return within(tr).getAllByRole('cell').map(c => c.textContent ?? '');
}

async function csvExportado() {
  fireEvent.click(await screen.findByRole('button', { name: /CSV/i }));
  await waitFor(() => expect(downloadCSVMock).toHaveBeenCalled());
  return downloadCSVMock.mock.calls[0][0];
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('baixa NÃO ingerida: os quatro caminhos degradam para "—"', () => {
  beforeEach(() => {
    getAnaliseDimensionalMock.mockResolvedValue([linhaDegradada]);
  });

  it('a COLUNA "Recebido" mostra "—" e o total do documento continua medido', async () => {
    render(<FinanceiroAnalytics />);

    const [, qtd, documento, recebido] = await celulas();
    expect(recebido).toBe('—');
    expect(documento).toBe('R$ 27.9M'); // ASCII, sem locale — o que É medido não degrada
    expect(qtd).toBe('44524');
  });

  it('o SALDO degrada junto — ele é doc − baixa, e a baixa é o 0 que nunca foi ingerido', async () => {
    render(<FinanceiroAnalytics />);

    const [, , , , saldo] = await celulas();
    expect(saldo).toBe('—');
  });

  it('o CARD de resumo mostra "—", não "R$ 0,0k" (era a afirmação mais visível da tela)', async () => {
    render(<FinanceiroAnalytics />);

    expect(await valorDoCard('Recebido')).toBe('—');
  });

  it('a tela DIZ o motivo — "—" sem explicação é lido como bug da tela', async () => {
    render(<FinanceiroAnalytics />);

    expect(await screen.findByText(new RegExp(MOTIVO_BAIXA_NAO_INGERIDA, 'i'))).toBeTruthy();
  });

  it('o CSV não reimprime o "0.00": célula "—" e cabeçalho com o motivo', async () => {
    render(<FinanceiroAnalytics />);
    await celulas();

    const csv = await csvExportado();
    const [cabecalho, linha] = csv.split('\n');
    expect(cabecalho).toContain(`Total Recebido (${MOTIVO_BAIXA_NAO_INGERIDA})`);
    expect(cabecalho).toContain(`Saldo (${MOTIVO_BAIXA_NAO_INGERIDA})`);
    // Casa a POSIÇÃO, não o arquivo inteiro: `0.00` aparece legitimamente no total do documento.
    const colunas = linha.split(',');
    expect(colunas[3]).toBe('—');
    expect(colunas[4]).toBe('—');
    expect(colunas[2]).toBe('27855279.84');
  });
});

describe('🔒 CONTROLE: com a baixa disponível, zero MEDIDO continua sendo R$ 0,00', () => {
  beforeEach(() => {
    getAnaliseDimensionalMock.mockResolvedValue([linhaZeroMedido]);
  });

  it('a coluna e o card mostram o zero como NÚMERO — degradar aqui seria a mentira oposta', async () => {
    render(<FinanceiroAnalytics />);

    const [, , , recebido, saldo] = await celulas();
    // Regex tolerante ao separador: sem ICU completo o Node cai para o formato en-US, e um
    // `toBe('R$ 0,00')` ficaria vermelho por locale, não pela regra sob teste (#1483).
    expect(recebido).toMatch(/^R\$\s?0[.,]00$/);
    expect(saldo).toMatch(/^R\$\s?0[.,]00$/);
    expect(recebido).not.toBe('—');
    expect(await valorDoCard('Recebido')).toMatch(/^R\$\s?0[.,]00$/);
  });

  it('sem motivo não há aviso na tela, e o CSV volta a trazer o número', async () => {
    render(<FinanceiroAnalytics />);
    await celulas();

    expect(screen.queryByText(new RegExp(MOTIVO_BAIXA_NAO_INGERIDA, 'i'))).toBeNull();

    const csv = await csvExportado();
    const [cabecalho, linha] = csv.split('\n');
    expect(cabecalho).toContain('Total Recebido,Saldo');
    expect(linha.split(',')[3]).toBe('0.00');
  });
});
