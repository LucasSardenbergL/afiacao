import { describe, expect, it } from 'vitest';
import type { Json } from '@/integrations/supabase/types';
import { estadoTaxa, lerCandidatosRepasse, lerPainelVenda, lerPreco, somarDias, validarAprovacao } from '../painel';

const c = (virou: number, nao_virou: number, nao_medivel: number, pendentes = 0) => ({
  virou,
  nao_virou,
  nao_medivel,
  pendentes,
});

describe('estadoTaxa — ausente ≠ zero', () => {
  const ativa = { baseConfiavel: true, exigeBaseConfiavel: false };

  it('com desfecho medível devolve o valor', () => {
    expect(estadoTaxa(c(1, 3, 0), 0.25, ativa)).toEqual({ tipo: 'valor', taxa: 0.25 });
  });

  it('nao_medivel acima de 20% das avaliadas → não consegui medir, nunca a taxa', () => {
    const e = estadoTaxa(c(2, 5, 2), 0.2857, ativa); // 2/9 = 22%
    expect(e.tipo).toBe('nao_medi');
  });

  it('nao_medivel em exatamente 20% ainda é medível', () => {
    expect(estadoTaxa(c(2, 2, 1), 0.5, ativa)).toEqual({ tipo: 'valor', taxa: 0.5 });
  });

  it('tudo pendente → aguardando janela; nada na lista → sem lista (nunca 0%)', () => {
    expect(estadoTaxa(c(0, 0, 0, 4), null, ativa)).toEqual({ tipo: 'aguardando', pendentes: 4 });
    expect(estadoTaxa(c(0, 0, 0, 0), null, ativa)).toEqual({ tipo: 'sem_lista' });
  });

  it('linha de base não confiável → não consegui medir mesmo com número', () => {
    const e = estadoTaxa(c(1, 3, 0), 0.25, { baseConfiavel: false, exigeBaseConfiavel: true });
    expect(e.tipo).toBe('nao_medi');
  });

  it('a taxa ativa não depende da base estar conferida', () => {
    expect(estadoTaxa(c(1, 1, 0), 0.5, { baseConfiavel: false, exigeBaseConfiavel: false }).tipo).toBe('valor');
  });
});

describe('validarAprovacao — espelho das recusas de venda_aprovar_repasse', () => {
  const hoje = '2026-10-20';
  const base = { ultimoPreco: 10, validoAte: '2026-12-01', hoje };

  it('alvo acima do último, em centavos, validade no intervalo → ok', () => {
    expect(validarAprovacao({ ...base, precoAlvo: 10.5 })).toEqual({ ok: true });
  });

  it('alvo igual ou abaixo do último preço → recusa (preço alvo nunca sugere baixar)', () => {
    expect(validarAprovacao({ ...base, precoAlvo: 10 }).ok).toBe(false);
    expect(validarAprovacao({ ...base, precoAlvo: 9.99 }).ok).toBe(false);
  });

  it('alvo acima de 2× o último → recusa (digitação)', () => {
    expect(validarAprovacao({ ...base, precoAlvo: 20.01 }).ok).toBe(false);
    expect(validarAprovacao({ ...base, precoAlvo: 20 }).ok).toBe(true);
  });

  it('mais de 2 casas → recusa', () => {
    expect(validarAprovacao({ ...base, precoAlvo: 10.555 }).ok).toBe(false);
  });

  it('validade hoje ou além de 1 ano → recusa; amanhã e hoje+365 → ok', () => {
    expect(validarAprovacao({ ...base, precoAlvo: 11, validoAte: hoje }).ok).toBe(false);
    expect(validarAprovacao({ ...base, precoAlvo: 11, validoAte: somarDias(hoje, 366) }).ok).toBe(false);
    expect(validarAprovacao({ ...base, precoAlvo: 11, validoAte: somarDias(hoje, 1) }).ok).toBe(true);
    expect(validarAprovacao({ ...base, precoAlvo: 11, validoAte: somarDias(hoje, 365) }).ok).toBe(true);
  });

  it('sem último preço provado ou sem alvo → recusa (nunca trata ausente como 0)', () => {
    expect(validarAprovacao({ ...base, ultimoPreco: null, precoAlvo: 11 }).ok).toBe(false);
    expect(validarAprovacao({ ...base, precoAlvo: null }).ok).toBe(false);
  });
});

describe('lerPreco', () => {
  it('aceita vírgula e ponto; vazio ou lixo é null', () => {
    expect(lerPreco('12,50')).toBe(12.5);
    expect(lerPreco('1.234,56')).toBe(1234.56);
    expect(lerPreco('12.5')).toBe(12.5);
    expect(lerPreco('')).toBeNull();
    expect(lerPreco('abc')).toBeNull();
  });
});

describe('somarDias', () => {
  it('atravessa virada de mês e de ano', () => {
    expect(somarDias('2026-12-31', 1)).toBe('2027-01-01');
    expect(somarDias('2026-03-01', -1)).toBe('2026-02-28');
  });
});

// Fixtures na forma que o corpo das RPCs na prod monta (conferido em 2026-10-21): contagens
// COALESCE(…, 0); taxas/receita/nome NULL quando não há base; `repasse_vigente` NULL = "não sei".
const contagem = { virou: 2, nao_virou: 1, nao_medivel: 0, pendentes: 3 };
function linhaJson(extra: Record<string, Json> = {}): Record<string, Json> {
  return {
    farmer_user_id: 'f1', farmer_nome: null, semana: '2026-10-13',
    na_lista: 10, mostradas: 8, contatados: 5, compraram: 2,
    ...contagem,
    receita_realizada: null, receita_incompleta: false, taxa_ativa: 0.6667, na_lista_sombra: 0,
    base_historico: { virou: 0, nao_virou: 0, nao_medivel: 0, pendentes: 0 },
    taxa_base_historico_mesma_semana: null,
    base_sombra: contagem, taxa_base_sombra: null, base_confiavel: false,
    ...extra,
  };
}
function painelJson(linhas: Json[] = [linhaJson()], repasseVigente: Json = null): Json {
  const ondaBase = { ligada: false, ligada_em: null, condicao_ao_ligar: null };
  return {
    hoje: '2026-10-21', periodo: { de: '2026-10-13', ate: '2026-10-26' },
    base_confiavel: false, repasse_disponivel: true, linhas,
    ondas: {
      onda_recompra: { ...ondaBase, prerequisitos: { historico_dias: 365, historico_meta: 365,
        sombra_ao_vivo: [{ dia: '2026-10-20', ao_vivo: true }], avaliada_hoje: true } },
      onda_complemento: { ...ondaBase, ligada: true, ligada_em: '2026-10-19T12:00:00+00:00',
        condicao_ao_ligar: { taxa: 0.9 },
        prerequisitos: { onda_recompra_ligada: true,
          semanas: [{ semana: '2026-10-06', farmers: 3, menor_taxa: null, ok: false }] } },
      onda_preco: { ...ondaBase, prerequisitos: { onda_complemento_ligada: true, repasse_vigente: repasseVigente } },
    },
  };
}

describe('lerPainelVenda — forma do jsonb de venda_painel', () => {
  it('lê o painel inteiro e preserva os NULL de contrato (ausente ≠ zero)', () => {
    const p = lerPainelVenda(painelJson());
    expect(p.linhas).toHaveLength(1);
    expect(p.linhas[0].receita_realizada).toBeNull();
    expect(p.linhas[0].farmer_nome).toBeNull();
    expect(p.linhas[0].taxa_base_sombra).toBeNull();
    expect(p.linhas[0].virou).toBe(2);
    expect(p.ondas.onda_preco.prerequisitos.repasse_vigente).toBeNull();
    expect(p.ondas.onda_complemento.condicao_ao_ligar).toEqual({ taxa: 0.9 });
    expect(p.ondas.onda_complemento.prerequisitos.semanas[0].menor_taxa).toBeNull();
    expect(p.ondas.onda_recompra.prerequisitos.sombra_ao_vivo).toEqual([{ dia: '2026-10-20', ao_vivo: true }]);
  });

  it('repasse_vigente booleano passa como booleano', () => {
    expect(lerPainelVenda(painelJson(undefined, false)).ondas.onda_preco.prerequisitos.repasse_vigente).toBe(false);
  });

  it('resposta NULL lança (o painel não inventa um vazio)', () => {
    expect(() => lerPainelVenda(null)).toThrow('venda_painel devolveu vazio');
  });

  it('receita como texto lança nomeando a chave, nunca vira número', () => {
    expect(() => lerPainelVenda(painelJson([linhaJson({ receita_realizada: '120.5' })])))
      .toThrow('"receita_realizada" fora da forma (número ou null)');
  });

  it('contagem ausente lança (chave ausente não é 0)', () => {
    const { virou: _virou, ...semVirou } = linhaJson();
    expect(() => lerPainelVenda(painelJson([semVirou]))).toThrow('"virou" fora da forma (número)');
  });

  it('taxa NULL onde a forma exige booleano lança', () => {
    expect(() => lerPainelVenda(painelJson([linhaJson({ base_confiavel: null })])))
      .toThrow('"base_confiavel" fora da forma (booleano)');
  });
});

function candidatoJson(extra: Record<string, Json> = {}): Record<string, Json> {
  return {
    comprador_id: 'c1', empresa: 'oben', omie_codigo_produto: 123, descricao: 'Verniz',
    status_defasagem: 'defasado', motivo: null, abaixo_piso: null, ultimo_preco: 10.5,
    data_ultima_compra: '2026-09-01', preco_sugerido: 11.2, alta_custo_perc: 7.5,
    valor_anual_recuperavel: null, c_last: 8, c_now: 9, n_pedidos: 4, cadencia_dias: 30,
    qtd_sugerida: 2, repasse_atual: null,
    ...extra,
  };
}

describe('lerCandidatosRepasse — forma do jsonb de venda_repasse_candidatos', () => {
  it('lê os candidatos, ignora a evidência de custo e preserva os NULL', () => {
    const [c] = lerCandidatosRepasse([candidatoJson()]);
    expect(c).not.toHaveProperty('c_last');
    expect(c.abaixo_piso).toBeNull();
    expect(c.valor_anual_recuperavel).toBeNull();
    expect(c.repasse_atual).toBeNull();
    expect(c.ultimo_preco).toBe(10.5);
  });

  it('lê o repasse_atual quando existe', () => {
    const [c] = lerCandidatosRepasse([candidatoJson({
      repasse_atual: { id: 'r1', preco_alvo: 11, valido_ate: '2026-12-31', revogado: false, vigente: true },
    })]);
    expect(c.repasse_atual).toEqual({ id: 'r1', preco_alvo: 11, valido_ate: '2026-12-31', revogado: false, vigente: true });
  });

  it('lista vazia é lista vazia; NULL ou objeto lança', () => {
    expect(lerCandidatosRepasse([])).toEqual([]);
    expect(() => lerCandidatosRepasse(null)).toThrow('esperava array');
    expect(() => lerCandidatosRepasse({})).toThrow('esperava array');
  });

  it("empresa fora de 'oben' lança", () => {
    expect(() => lerCandidatosRepasse([candidatoJson({ empresa: 'colacor' })])).toThrow('"empresa" fora da forma');
  });

  it('preço como texto lança nomeando a chave', () => {
    expect(() => lerCandidatosRepasse([candidatoJson({ ultimo_preco: '10.5' })]))
      .toThrow('"ultimo_preco" fora da forma (número ou null)');
  });
});
