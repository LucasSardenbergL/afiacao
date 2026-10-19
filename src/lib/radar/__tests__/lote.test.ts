import { describe, expect, it } from 'vitest';
import {
  executarEmLote,
  resumirLote,
  limitarSelecao,
  csvEmpresas,
  TETO_LOTE,
  type ResultadoItem,
} from '../lote';

const atraso = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('executarEmLote', () => {
  it('processa todos os itens e preserva a ORDEM de entrada no resultado', async () => {
    const r = await executarEmLote([3, 1, 2], async (n) => { await atraso(n * 5); return n * 10; }, { concorrencia: 3 });
    expect(r.map((x) => x.item)).toEqual([3, 1, 2]);
    expect(r.map((x) => (x.status === 'ok' ? x.valor : null))).toEqual([30, 10, 20]);
  });

  it('continua nos erros: a falha de um item não derruba o lote', async () => {
    const r = await executarEmLote(['a', 'b', 'c'], async (s) => {
      if (s === 'b') throw new Error('boom');
      return s.toUpperCase();
    }, { concorrencia: 2 });
    expect(r[0]).toEqual({ item: 'a', status: 'ok', valor: 'A' });
    expect(r[1]).toEqual({ item: 'b', status: 'falha', erro: 'boom' });
    expect(r[2]).toEqual({ item: 'c', status: 'ok', valor: 'C' });
  });

  it('respeita o teto de concorrência', async () => {
    let ativos = 0; let pico = 0;
    await executarEmLote([1, 2, 3, 4, 5, 6], async () => {
      ativos++; pico = Math.max(pico, ativos);
      await atraso(5);
      ativos--;
    }, { concorrencia: 2 });
    expect(pico).toBe(2);
  });

  it('reporta progresso a cada item concluído (feitos/total)', async () => {
    const chamadas: Array<[number, number]> = [];
    await executarEmLote([1, 2, 3], async () => undefined, { concorrencia: 1, onProgresso: (f, t) => chamadas.push([f, t]) });
    expect(chamadas).toEqual([[1, 3], [2, 3], [3, 3]]);
  });

  it('cancelamento: itens ainda não iniciados saem como "cancelado", não como falha', async () => {
    const ac = new AbortController();
    const r = await executarEmLote([1, 2, 3, 4], async (n) => {
      if (n === 1) ac.abort();
      await atraso(2);
      return n;
    }, { concorrencia: 1, signal: ac.signal });
    expect(r[0].status).toBe('ok');
    expect(r.slice(1).every((x) => x.status === 'cancelado')).toBe(true);
  });

  it('pararEm: o erro que para o lote cancela os não iniciados (rate-limit persistente)', async () => {
    const r = await executarEmLote([1, 2, 3], async (n) => {
      if (n === 2) throw new Error('OMIE_TRANSIENT (oben): rate limit persistiu após 3 tentativas');
      return n;
    }, { concorrencia: 1, pararEm: (e) => e instanceof Error && /OMIE_TRANSIENT/.test(e.message) });
    expect(r.map((x) => x.status)).toEqual(['ok', 'falha', 'cancelado']);
  });

  it('erro não-Error vira string legível (nunca "[object Object]")', async () => {
    const r = await executarEmLote([1], async () => { throw { message: 'obj' }; }, { concorrencia: 1 });
    expect(r[0]).toEqual({ item: 1, status: 'falha', erro: 'obj' });
  });
});

describe('resumirLote', () => {
  it('conta ok/falha/cancelado e separa criados de já-existentes pelo classificador', () => {
    const rs: ResultadoItem<string, { ja_existia: boolean }>[] = [
      { item: 'a', status: 'ok', valor: { ja_existia: false } },
      { item: 'b', status: 'ok', valor: { ja_existia: true } },
      { item: 'c', status: 'falha', erro: 'x' },
      { item: 'd', status: 'cancelado' },
    ];
    expect(resumirLote(rs, (v) => v.ja_existia)).toEqual({ total: 4, ok: 2, criados: 1, ja_existiam: 1, falhas: 1, cancelados: 1 });
  });
});

describe('limitarSelecao', () => {
  it('corta no teto e devolve quantos ficaram de fora (o usuário precisa saber)', () => {
    const ids = Array.from({ length: TETO_LOTE + 7 }, (_, i) => `c${i}`);
    const { dentro, fora } = limitarSelecao(ids);
    expect(dentro).toHaveLength(TETO_LOTE);
    expect(fora).toBe(7);
  });
  it('abaixo do teto não corta nada', () => {
    expect(limitarSelecao(['a', 'b'])).toEqual({ dentro: ['a', 'b'], fora: 0 });
  });
});

describe('csvEmpresas', () => {
  const base = {
    cnpj: '12345678000195', razao_social: 'ACME; LTDA', nome_fantasia: null, telefone1: '3199990000', telefone2: null,
    email: 'a@b.com', municipio_nome: 'BELO HORIZONTE', uf: 'MG', cnae_principal: '3101200', cnae_descricao: 'Móveis "de madeira"',
    data_abertura: '2024-01-15', porte: '01', capital_social: 1500.5, prospeccao_status: 'a_contatar',
    logradouro: '=RUA X', numero: '10', bairro: null, cep: '30000000',
  };
  it('cabeçalho + 1 linha; `;` e aspas escapados; fórmula neutralizada; null = célula vazia', () => {
    const csv = csvEmpresas([base]);
    const [cab, linha] = csv.split('\n');
    expect(cab.startsWith('cnpj;razao_social;nome_fantasia;telefone1;telefone2;email;municipio;uf;cnae;cnae_descricao')).toBe(true);
    expect(linha).toContain('"ACME; LTDA"');
    expect(linha).toContain('"Móveis ""de madeira"""');
    expect(linha).toContain(";'=RUA X;");
    expect(linha).toContain('12.345.678/0001-95');
    // capital null → vazio (ausente ≠ zero)
    const semCapital = csvEmpresas([{ ...base, capital_social: null }]).split('\n')[1];
    expect(semCapital).toMatch(/;;|;$/);
  });
  it('formata capital no padrão pt-BR (vírgula decimal)', () => {
    expect(csvEmpresas([base]).split('\n')[1]).toContain('1500,50');
  });
});
