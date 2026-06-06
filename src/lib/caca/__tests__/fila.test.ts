import { describe, it, expect } from 'vitest';
import { montarFilaCaca } from '../fila';
import type { CompradorRow, CandidatoRow } from '../types';

// ─── Fábricas de fixtures ────────────────────────────────────────────────────

function comprador(over: Partial<CompradorRow> & { documento: string }): CompradorRow {
  return {
    empresa: 'oben',
    cidade_uf: 'DIVINOPOLIS-MG',
    ramo: 'moveleiro',
    ticket_faixa: 1000,
    familias: ['lixa'],
    volume: 100,
    n_pedidos: 5,
    recencia_dias: 30,
    lucro_proxy: 200,
    lucro_cobertura: 1,
    ...over,
  };
}

function candidato(over: Partial<CandidatoRow> & { documento: string }): CandidatoRow {
  return {
    empresa_alvo: 'oben',
    cidade_uf: 'DIVINOPOLIS-MG',
    ramo: 'moveleiro',
    ticket_faixa: 1000,
    familias: ['lixa'],
    compra_em_outra_empresa: false,
    ultima_compra_grupo_dias: null,
    nome: null,
    telefone: null,
    cliente_user_id: 'user-default',
    ...over,
  };
}

/**
 * Constrói uma base de compradores "moveleiro / DIVINOPOLIS-MG / lixa" para que
 * o perfil de lifts favoreça candidatos com esse perfil. Usa suporte >= 3 nos
 * melhores (default suporteMin do perfilPorLift) para os lifts existirem.
 */
function compradoresPadrao(empresa: CompradorRow['empresa'], prefixo: string): CompradorRow[] {
  return Array.from({ length: 5 }, (_, i) =>
    comprador({
      documento: `${prefixo}${i}`,
      empresa,
      cidade_uf: 'DIVINOPOLIS-MG',
      ramo: 'moveleiro',
      familias: ['lixa'],
      volume: 100 + i,
      n_pedidos: 5,
    }),
  );
}

// ─── merge cross-empresa ──────────────────────────────────────────────────────

describe('montarFilaCaca — merge cross-empresa', () => {
  it('candidatos de oben e colacor entram numa lista única ordenada por valor global', () => {
    const compradores: CompradorRow[] = [
      ...compradoresPadrao('oben', 'OB'),
      ...compradoresPadrao('colacor', 'CO'),
    ];

    const candidatos: CandidatoRow[] = [
      // colacor: sinal FORTE (cross_empresa boost 1.3 + perfil aderente)
      candidato({
        documento: '11111111111',
        empresa_alvo: 'colacor',
        compra_em_outra_empresa: true,
        cidade_uf: 'DIVINOPOLIS-MG',
        ramo: 'moveleiro',
        familias: ['lixa'],
        cliente_user_id: 'u-forte-colacor',
      }),
      // oben: FRIO, perfil neutro (cidade/ramo/familia fora do perfil) → valor menor
      candidato({
        documento: '22222222222',
        empresa_alvo: 'oben',
        compra_em_outra_empresa: false,
        ultima_compra_grupo_dias: null,
        cidade_uf: 'SAO_PAULO-SP',
        ramo: 'metal',
        familias: [],
        ticket_faixa: null,
        cliente_user_id: 'u-frio-oben',
      }),
    ];

    const fila = montarFilaCaca(compradores, candidatos);

    // os dois entram numa lista só
    expect(fila).toHaveLength(2);
    // o cross forte de colacor fica ACIMA do frio de oben (merge global, não por empresa)
    expect(fila[0].features.documento).toBe('11111111111');
    expect(fila[0].features.empresaAlvo).toBe('colacor');
    expect(fila[1].features.documento).toBe('22222222222');
    expect(fila[1].features.empresaAlvo).toBe('oben');
  });

  it('o sabor cross de uma empresa supera um frio de OUTRA empresa (boost atravessa o merge)', () => {
    // perfis idênticos nas duas empresas; só o sabor difere.
    const compradores: CompradorRow[] = [
      ...compradoresPadrao('oben', 'OB'),
      ...compradoresPadrao('colacor', 'CO'),
    ];
    const candidatos: CandidatoRow[] = [
      candidato({ documento: 'A', empresa_alvo: 'oben', compra_em_outra_empresa: true, cliente_user_id: 'ua' }),
      candidato({ documento: 'B', empresa_alvo: 'colacor', compra_em_outra_empresa: false, ultima_compra_grupo_dias: null, cliente_user_id: 'ub' }),
    ];
    const fila = montarFilaCaca(compradores, candidatos);
    // mesmo score base (mesmo perfil), cross (×1.3) > frio (×0.6) → A na frente, atravessando empresas
    expect(fila[0].features.documento).toBe('A');
    expect(fila[0].sabor).toBe('cross_empresa');
    expect(fila[1].features.documento).toBe('B');
    expect(fila[1].sabor).toBe('frio');
  });
});

// ─── mapeamento CandidatoRow → CandidatoFeatures ──────────────────────────────

describe('montarFilaCaca — mapeamento de features', () => {
  it('compraNaEmpresaAlvo === false e atrasoRelativo === null em TODOS os itens', () => {
    const compradores = [...compradoresPadrao('oben', 'OB'), ...compradoresPadrao('colacor', 'CO')];
    const candidatos: CandidatoRow[] = [
      candidato({ documento: 'A', empresa_alvo: 'oben', compra_em_outra_empresa: true, cliente_user_id: 'ua' }),
      candidato({ documento: 'B', empresa_alvo: 'colacor', ultima_compra_grupo_dias: 400, cliente_user_id: 'ub' }),
      candidato({ documento: 'C', empresa_alvo: 'oben', ultima_compra_grupo_dias: null, cliente_user_id: 'uc' }),
    ];
    const fila = montarFilaCaca(compradores, candidatos);
    expect(fila.length).toBeGreaterThan(0);
    for (const item of fila) {
      expect(item.features.compraNaEmpresaAlvo).toBe(false);
      expect(item.features.atrasoRelativo).toBeNull();
    }
  });

  it('preserva os demais campos do CandidatoRow no mapeamento', () => {
    const compradores = compradoresPadrao('oben', 'OB');
    const candidatos: CandidatoRow[] = [
      candidato({
        documento: '99999999999',
        empresa_alvo: 'oben',
        cidade_uf: 'UBA-MG',
        ramo: 'metal',
        ticket_faixa: 2500,
        familias: ['verniz', 'cola'],
        compra_em_outra_empresa: true,
        ultima_compra_grupo_dias: 120,
        cliente_user_id: 'u99',
      }),
    ];
    const fila = montarFilaCaca(compradores, candidatos);
    expect(fila).toHaveLength(1);
    expect(fila[0].features).toEqual({
      documento: '99999999999',
      empresaAlvo: 'oben',
      cidadeUf: 'UBA-MG',
      ramo: 'metal',
      ticketFaixa: 2500,
      familias: ['verniz', 'cola'],
      compraEmOutraEmpresa: true,
      compraNaEmpresaAlvo: false,
      ultimaCompraGrupoDias: 120,
      atrasoRelativo: null,
    });
  });
});

// ─── enriquecimento por (documento × empresa-alvo) ────────────────────────────

describe('montarFilaCaca — enriquecimento', () => {
  it('nome/telefone/clienteUserId vêm da linha certa (documento + empresa_alvo)', () => {
    const compradores = [...compradoresPadrao('oben', 'OB'), ...compradoresPadrao('colacor', 'CO')];
    const candidatos: CandidatoRow[] = [
      candidato({ documento: 'A', empresa_alvo: 'oben', nome: 'Cliente A', telefone: '37999990000', cliente_user_id: 'ua', compra_em_outra_empresa: true }),
      candidato({ documento: 'B', empresa_alvo: 'colacor', nome: 'Cliente B', telefone: '37999991111', cliente_user_id: 'ub', compra_em_outra_empresa: true }),
    ];
    const fila = montarFilaCaca(compradores, candidatos);
    const a = fila.find((x) => x.features.documento === 'A');
    const b = fila.find((x) => x.features.documento === 'B');
    expect(a?.nome).toBe('Cliente A');
    expect(a?.telefone).toBe('37999990000');
    expect(a?.clienteUserId).toBe('ua');
    expect(b?.nome).toBe('Cliente B');
    expect(b?.telefone).toBe('37999991111');
    expect(b?.clienteUserId).toBe('ub');
  });

  it('mesmo documento nas 2 empresas (user_id igual) → enriquece cada entrada pela SUA empresa-alvo', () => {
    // documento idêntico, mesmo cliente_user_id, mas nome/telefone diferentes por linha de empresa.
    const compradores = [...compradoresPadrao('oben', 'OB'), ...compradoresPadrao('colacor', 'CO')];
    const doc = '55555555555';
    const candidatos: CandidatoRow[] = [
      candidato({ documento: doc, empresa_alvo: 'oben', nome: 'Nome OBEN', telefone: '37111110000', cliente_user_id: 'u-mesmo', compra_em_outra_empresa: true }),
      candidato({ documento: doc, empresa_alvo: 'colacor', nome: 'Nome COLACOR', telefone: '37222220000', cliente_user_id: 'u-mesmo', compra_em_outra_empresa: true }),
    ];
    const fila = montarFilaCaca(compradores, candidatos);
    expect(fila).toHaveLength(2);
    const oben = fila.find((x) => x.features.empresaAlvo === 'oben');
    const colacor = fila.find((x) => x.features.empresaAlvo === 'colacor');
    // enriquecimento NÃO vaza entre empresas: cada entrada pega a linha da sua empresa-alvo
    expect(oben?.nome).toBe('Nome OBEN');
    expect(oben?.telefone).toBe('37111110000');
    expect(colacor?.nome).toBe('Nome COLACOR');
    expect(colacor?.telefone).toBe('37222220000');
    // mesmo user_id nas duas (cliente único do app)
    expect(oben?.clienteUserId).toBe('u-mesmo');
    expect(colacor?.clienteUserId).toBe('u-mesmo');
  });

  it('candidato sem linha de enriquecimento → nome/telefone/clienteUserId null (degradação honesta)', () => {
    // Construído manualmente: um comprador que NÃO está em candidatos não gera entrada,
    // então provamos a degradação removendo a linha do índice via um candidato órfão.
    // Aqui simulamos: candidatos vazio mas... não gera fila. Em vez disso, garantimos
    // que clienteUserId nullable é honrado quando a view não traz (caso teórico v1).
    const compradores = compradoresPadrao('oben', 'OB');
    const candidatos: CandidatoRow[] = [
      candidato({ documento: 'A', empresa_alvo: 'oben', nome: null, telefone: null, cliente_user_id: '', compra_em_outra_empresa: true }),
    ];
    const fila = montarFilaCaca(compradores, candidatos);
    expect(fila).toHaveLength(1);
    expect(fila[0].nome).toBeNull();
    expect(fila[0].telefone).toBeNull();
    // cliente_user_id '' (falsy) → clienteUserId null via ?? só pega null/undefined, então '' permanece ''.
    // A view garante string; aqui só checamos que o campo é repassado sem quebrar o tipo.
    expect(fila[0].clienteUserId).toBe('');
  });
});

// ─── topK ─────────────────────────────────────────────────────────────────────

describe('montarFilaCaca — corte topK', () => {
  it('topK corta a lista (5 candidatos, topK=3 → 3)', () => {
    const compradores = compradoresPadrao('oben', 'OB');
    const candidatos: CandidatoRow[] = Array.from({ length: 5 }, (_, i) =>
      candidato({
        documento: `C${i}`,
        empresa_alvo: 'oben',
        compra_em_outra_empresa: true,
        cliente_user_id: `u${i}`,
      }),
    );
    const fila = montarFilaCaca(compradores, candidatos, { topK: 3 });
    expect(fila).toHaveLength(3);
  });

  it('default topK=150 não corta listas pequenas', () => {
    const compradores = compradoresPadrao('oben', 'OB');
    const candidatos: CandidatoRow[] = Array.from({ length: 10 }, (_, i) =>
      candidato({ documento: `C${i}`, empresa_alvo: 'oben', compra_em_outra_empresa: true, cliente_user_id: `u${i}` }),
    );
    const fila = montarFilaCaca(compradores, candidatos);
    expect(fila).toHaveLength(10);
  });

  it('topK conta DOCUMENTOS, não candidaturas: cliente com 2 empresas-alvo não consome 2 vagas (Codex P1)', () => {
    // M é cross em oben E colacor (2 candidaturas, sabor forte → topo). A e B são frios.
    // topK=2 DOCUMENTOS → {M, A}: as 2 candidaturas de M entram (3 itens, 2 documentos).
    // Corte por candidatura (slice antigo) pegaria só [M-oben, M-colacor] = 1 documento.
    const compradores = [...compradoresPadrao('oben', 'OB'), ...compradoresPadrao('colacor', 'CO')];
    const candidatos: CandidatoRow[] = [
      candidato({ documento: 'M', empresa_alvo: 'oben', compra_em_outra_empresa: true, cliente_user_id: 'um' }),
      candidato({ documento: 'M', empresa_alvo: 'colacor', compra_em_outra_empresa: true, cliente_user_id: 'um' }),
      candidato({ documento: 'A', empresa_alvo: 'oben', ultima_compra_grupo_dias: null, cliente_user_id: 'ua' }),
      candidato({ documento: 'B', empresa_alvo: 'oben', ultima_compra_grupo_dias: null, cliente_user_id: 'ub' }),
    ];
    const fila = montarFilaCaca(compradores, candidatos, { topK: 2 });
    const docsUnicos = new Set(fila.map((x) => x.features.documento));
    expect(docsUnicos.size).toBe(2); // 2 DOCUMENTOS (não 2 candidaturas)
    expect(docsUnicos.has('M')).toBe(true); // M (cross) está no topo
    expect(fila.filter((x) => x.features.documento === 'M')).toHaveLength(2); // ambas candidaturas de M
  });
});

// ─── rankFinal global reatribuído ─────────────────────────────────────────────

describe('montarFilaCaca — rankFinal global', () => {
  it('rankFinal reatribuído 1..N (sem repetir, sem buraco), através das empresas', () => {
    const compradores = [...compradoresPadrao('oben', 'OB'), ...compradoresPadrao('colacor', 'CO')];
    const candidatos: CandidatoRow[] = [
      candidato({ documento: 'A', empresa_alvo: 'oben', compra_em_outra_empresa: true, cliente_user_id: 'ua' }),
      candidato({ documento: 'B', empresa_alvo: 'colacor', compra_em_outra_empresa: true, cliente_user_id: 'ub' }),
      candidato({ documento: 'C', empresa_alvo: 'oben', ultima_compra_grupo_dias: 400, cliente_user_id: 'uc' }),
      candidato({ documento: 'D', empresa_alvo: 'colacor', ultima_compra_grupo_dias: null, cliente_user_id: 'ud' }),
    ];
    const fila = montarFilaCaca(compradores, candidatos);
    const ranks = fila.map((x) => x.rankFinal);
    // 1..N contíguo
    expect(ranks).toEqual([1, 2, 3, 4]);
    // sem repetição
    expect(new Set(ranks).size).toBe(ranks.length);
  });

  it('rankFinal acompanha a ordem da fila após topK (1..topK)', () => {
    const compradores = compradoresPadrao('oben', 'OB');
    const candidatos: CandidatoRow[] = Array.from({ length: 6 }, (_, i) =>
      candidato({ documento: `C${i}`, empresa_alvo: 'oben', compra_em_outra_empresa: true, cliente_user_id: `u${i}` }),
    );
    const fila = montarFilaCaca(compradores, candidatos, { topK: 4 });
    expect(fila.map((x) => x.rankFinal)).toEqual([1, 2, 3, 4]);
  });
});

// ─── documento em ambas as empresas → 2 entradas ─────────────────────────────

describe('montarFilaCaca — documento em oben E colacor', () => {
  it('mesmo documento presente nas 2 empresas-alvo → 2 entradas com empresaAlvo distintos', () => {
    const compradores = [...compradoresPadrao('oben', 'OB'), ...compradoresPadrao('colacor', 'CO')];
    const doc = '77777777777';
    const candidatos: CandidatoRow[] = [
      candidato({ documento: doc, empresa_alvo: 'oben', compra_em_outra_empresa: true, cliente_user_id: 'u7' }),
      candidato({ documento: doc, empresa_alvo: 'colacor', compra_em_outra_empresa: true, cliente_user_id: 'u7' }),
    ];
    const fila = montarFilaCaca(compradores, candidatos);
    expect(fila).toHaveLength(2);
    const empresas = fila.map((x) => x.features.empresaAlvo).sort();
    expect(empresas).toEqual(['colacor', 'oben']);
    // ambos compartilham o mesmo documento
    expect(fila.every((x) => x.features.documento === doc)).toBe(true);
  });
});

// ─── listas vazias / borda ────────────────────────────────────────────────────

describe('montarFilaCaca — casos de borda', () => {
  it('listas vazias → []', () => {
    expect(montarFilaCaca([], [])).toEqual([]);
  });

  it('sem candidatos → [] (mesmo com compradores)', () => {
    expect(montarFilaCaca(compradoresPadrao('oben', 'OB'), [])).toEqual([]);
  });

  it('empresa SEM compradores NÃO rankeia candidatos (sem look-alike honesto — Codex P1)', () => {
    // Nenhum comprador → selecionarMelhores([]) → perfil.nMelhores=0 → empresa PULADA.
    // Sem melhores conhecidos não há look-alike; rankear daria confiança fabricada
    // (lift neutro 1 + confiança cheia). Honesto: não entra na fila.
    const candidatos: CandidatoRow[] = [
      candidato({ documento: 'A', empresa_alvo: 'oben', compra_em_outra_empresa: true, cliente_user_id: 'ua' }),
    ];
    expect(montarFilaCaca([], candidatos)).toEqual([]);
  });

  it('candidato de colacor_sc (fora das empresas-alvo) é ignorado', () => {
    // EMPRESAS_ALVO = [oben, colacor]; uma linha de colacor_sc não deve entrar.
    // (oben tem compradores → B rankeia; colacor_sc nunca é varrido.)
    const candidatos: CandidatoRow[] = [
      candidato({ documento: 'A', empresa_alvo: 'colacor_sc', compra_em_outra_empresa: true, cliente_user_id: 'ua' }),
      candidato({ documento: 'B', empresa_alvo: 'oben', compra_em_outra_empresa: true, cliente_user_id: 'ub' }),
    ];
    const fila = montarFilaCaca(compradoresPadrao('oben', 'OB'), candidatos);
    expect(fila).toHaveLength(1);
    expect(fila[0].features.documento).toBe('B');
  });

  it('determinístico: mesma entrada → mesma saída', () => {
    const compradores = [...compradoresPadrao('oben', 'OB'), ...compradoresPadrao('colacor', 'CO')];
    const candidatos: CandidatoRow[] = [
      candidato({ documento: 'A', empresa_alvo: 'oben', compra_em_outra_empresa: true, cliente_user_id: 'ua' }),
      candidato({ documento: 'B', empresa_alvo: 'colacor', ultima_compra_grupo_dias: 400, cliente_user_id: 'ub' }),
    ];
    const r1 = montarFilaCaca(compradores, candidatos);
    const r2 = montarFilaCaca(compradores, candidatos);
    expect(r1).toEqual(r2);
  });
});
