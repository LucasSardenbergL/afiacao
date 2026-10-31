import { describe, expect, it } from 'vitest';
import {
  casaFiltrosExplicitos, intercalarAmostra, lerAmostraVigente, pendenteNaAmostra, resumirAmostra, PASSO_AMOSTRA,
  TETO_LEITURA_AMOSTRA,
} from '@/lib/radar/amostra';

const lead = (cnpj: string, o: Partial<Parameters<typeof casaFiltrosExplicitos>[0]> = {}) => ({
  cnpj, uf: 'MG', razao_social: 'MOVEIS SILVA LTDA', nome_fantasia: null, municipio_nome: 'UBA',
  cnae_principal: '3101200', prospeccao_status: 'a_contatar', ja_cliente: false, ...o,
});
const SEM_FILTRO = { busca: '', uf: '', municipio: '', cnae: '', status: '' };
const fila = (n: number, p = 'F') => Array.from({ length: n }, (_, i) => ({ cnpj: `${p}${i + 1}` }));

describe('intercalarAmostra', () => {
  it('põe 1 da amostra a cada 10 posições, na ordem do sorteio', () => {
    const out = intercalarAmostra(fila(25), fila(5, 'A'), false).map((e) => e.cnpj);
    expect(PASSO_AMOSTRA).toBe(10);
    expect(out[9]).toBe('A1');
    expect(out[19]).toBe('A2');
    expect(out.filter((c) => c.startsWith('A'))).toEqual(['A1', 'A2']);
    expect(out.filter((c) => c.startsWith('F'))).toHaveLength(25);
  });

  it('é estável por prefixo: a página seguinte não mexe no que já estava na tela', () => {
    const a = fila(5, 'A');
    const p1 = intercalarAmostra(fila(50), a, false).map((e) => e.cnpj);
    const p2 = intercalarAmostra(fila(100), a, false).map((e) => e.cnpj);
    expect(p2.slice(0, p1.length)).toEqual(p1);
  });

  it('fila comum que acabou: a amostra que sobrou entra no fim (não some)', () => {
    const out = intercalarAmostra(fila(3), fila(4, 'A'), true).map((e) => e.cnpj);
    expect(out).toEqual(['F1', 'F2', 'F3', 'A1', 'A2', 'A3', 'A4']);
  });

  it('fila comum vazia e acabou: só a amostra', () => {
    expect(intercalarAmostra([], fila(2, 'A'), true).map((e) => e.cnpj)).toEqual(['A1', 'A2']);
  });

  it('sem fim, a sobra espera a próxima página (não é empilhada no meio)', () => {
    expect(intercalarAmostra(fila(3), fila(4, 'A'), false).map((e) => e.cnpj)).toEqual(['F1', 'F2', 'F3']);
  });

  it('tira da fila comum o sorteado que também veio nela (sem linha duplicada)', () => {
    const out = intercalarAmostra([...fila(12), { cnpj: 'A1' }], [{ cnpj: 'A1' }], false).map((e) => e.cnpj);
    expect(out.filter((c) => c === 'A1')).toHaveLength(1);
    expect(out[9]).toBe('A1');
  });
});

describe('casaFiltrosExplicitos', () => {
  it('região e ranking não são filtros explícitos: sem nada digitado, todo pendente casa (PA incluído)', () => {
    expect(casaFiltrosExplicitos(lead('X', { uf: 'PA' }), SEM_FILTRO)).toBe(true);
  });

  it('respeita UF, busca, município, CNAE (exato e prefixo) e status', () => {
    const e = lead('X');
    expect(casaFiltrosExplicitos(e, { ...SEM_FILTRO, uf: 'SP' })).toBe(false);
    expect(casaFiltrosExplicitos(e, { ...SEM_FILTRO, uf: 'MG' })).toBe(true);
    expect(casaFiltrosExplicitos(e, { ...SEM_FILTRO, busca: 'silva' })).toBe(true);
    expect(casaFiltrosExplicitos(e, { ...SEM_FILTRO, busca: 'souza' })).toBe(false);
    expect(casaFiltrosExplicitos(e, { ...SEM_FILTRO, municipio: 'ub' })).toBe(true);
    expect(casaFiltrosExplicitos(e, { ...SEM_FILTRO, municipio: 'muriae' })).toBe(false);
    expect(casaFiltrosExplicitos(e, { ...SEM_FILTRO, cnae: '3101-2/00' })).toBe(true);
    expect(casaFiltrosExplicitos(e, { ...SEM_FILTRO, cnae: '3102-1/00' })).toBe(false);
    expect(casaFiltrosExplicitos(e, { ...SEM_FILTRO, cnae: '31' })).toBe(true);
    expect(casaFiltrosExplicitos(e, { ...SEM_FILTRO, cnae: '47' })).toBe(false);
    expect(casaFiltrosExplicitos(e, { ...SEM_FILTRO, status: 'a_contatar' })).toBe(true);
    expect(casaFiltrosExplicitos(e, { ...SEM_FILTRO, status: 'em_conversa' })).toBe(false);
  });

  it('busca só-curinga não filtra (mesma regra da fila no servidor)', () => {
    expect(casaFiltrosExplicitos(lead('X'), { ...SEM_FILTRO, busca: '%%' })).toBe(true);
  });
});

describe('pendenteNaAmostra / resumirAmostra', () => {
  it('pendente = a contatar e não cliente', () => {
    expect(pendenteNaAmostra({ prospeccao_status: 'a_contatar', ja_cliente: false })).toBe(true);
    expect(pendenteNaAmostra({ prospeccao_status: 'a_contatar', ja_cliente: true })).toBe(false);
    expect(pendenteNaAmostra({ prospeccao_status: 'em_conversa', ja_cliente: false })).toBe(false);
  });

  it('o denominador é o sorteio inteiro: quem saiu da fila aparece no motivo', () => {
    const r = resumirAmostra([
      { posicao: 1, cnpj: 'A', empresa: lead('A') },
      { posicao: 2, cnpj: 'B', empresa: lead('B', { uf: 'PA' }) },
      { posicao: 3, cnpj: 'C', empresa: lead('C', { uf: 'RS' }) },
      { posicao: 4, cnpj: 'D', empresa: lead('D', { prospeccao_status: 'em_conversa' }) },
      { posicao: 5, cnpj: 'E', empresa: lead('E', { prospeccao_status: 'descartado' }) },
      { posicao: 6, cnpj: 'F', empresa: lead('F', { ja_cliente: true }) },
      { posicao: 7, cnpj: 'G', empresa: null },
    ]);
    expect(r).toEqual({
      total: 7, pendentes: 3, contatados: 1, descartados: 1, jaClientes: 1, semDados: 1,
      pendentesForaDaAtuacao: 2, ufsForaDaAtuacao: ['PA', 'RS'],
    });
    expect(r.pendentes + r.contatados + r.descartados + r.jaClientes + r.semDados).toBe(r.total);
  });
});

describe('lerAmostraVigente', () => {
  const linha = (posicao: number, o: Record<string, unknown> = {}) =>
    ({ sorteio: 'coorte-2026-10', grupo: 'amostra', cnpj: `C${posicao}`, posicao, ...o });

  it('lê e ordena por posição', () => {
    expect(lerAmostraVigente([linha(2), linha(1)], 'f').map((s) => s.cnpj)).toEqual(['C1', 'C2']);
  });

  it('recusa topo, forma errada e mais de um sorteio', () => {
    expect(() => lerAmostraVigente([linha(1, { grupo: 'topo' })], 'f')).toThrow('fora da forma');
    expect(() => lerAmostraVigente([linha(0)], 'f')).toThrow('fora da forma');
    expect(() => lerAmostraVigente({}, 'f')).toThrow('fora da forma lista');
    expect(() => lerAmostraVigente([linha(1), linha(2, { sorteio: 'coorte-2026-09' })], 'f')).toThrow('mais de um sorteio');
  });

  it('no teto do PostgREST é ERRO, nunca "acabou"', () => {
    const muitas = Array.from({ length: TETO_LEITURA_AMOSTRA }, (_, i) => linha(i + 1));
    expect(() => lerAmostraVigente(muitas, 'f')).toThrow('no teto da leitura');
  });
});
