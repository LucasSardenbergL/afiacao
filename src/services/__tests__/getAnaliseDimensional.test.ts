import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Teste de contrato da paginação de `getAnaliseDimensional` (tela /financeiro/analytics).
 *
 * Irmão dos #719/#720 (queries sem `.range()`) e dos #1782/#1801 (a mesma capa alcançando
 * `.rpc()`): a capa de 1.000 linhas do PostgREST vale para RPC set-returning e é SILENCIOSA.
 * Aqui o consumidor AGREGA as linhas num Map por dimensão, então truncar não esvazia a tela —
 * encolhe cada total em silêncio, e um "contas a pagar por categoria" 12% menor é
 * indistinguível de um mês mais fraco.
 *
 * Medido em prod (2026-08-20): `fin_analise_cp_dimensoes` devolve 877 linhas no pior caso real
 * da tela (todas as empresas, ano 2025, mês = "todos"), numa série que cresce ~14% ao ano —
 * 407 em 2020, 877 em 2025. O universo de 1.227 usado abaixo é o próximo degrau dessa curva.
 *
 * O dublê reproduz o comportamento REAL do PostgREST: `.range(from, to)` devolve a janela
 * pedida, capada em 1.000 linhas por request.
 */

type Row = Record<string, unknown>;

const state: {
  universo: Row[];
  erroNaPagina: number | null;
  nullNaPagina: number | null;
  chamadas: Array<{ nome: string; ordens: string[]; range: [number, number] | null }>;
} = { universo: [], erroNaPagina: null, nullNaPagina: null, chamadas: [] };

const CAPA_POSTGREST = 1000;

function makeRpcBuilder(nome: string) {
  const registro: { nome: string; ordens: string[]; range: [number, number] | null } = {
    nome, ordens: [], range: null,
  };
  state.chamadas.push(registro);
  const builder = {
    order: (coluna: string, _opts?: unknown) => {
      // Ordem DEPOIS do range seria aplicada tarde demais para estabilizar a janela; o registro
      // guarda a sequência para o teste poder exigir a ordem certa.
      registro.ordens.push(registro.range ? `DEPOIS_DO_RANGE:${coluna}` : coluna);
      return builder;
    },
    range: (from: number, to: number) => {
      registro.range = [from, to];
      return builder;
    },
    then: (
      resolve: (v: { data: Row[] | null; error: unknown }) => unknown,
      reject?: (e: unknown) => unknown,
    ) => {
      try {
        if (!registro.range) {
          // Sem `.range()` o PostgREST devolve só o primeiro 1.000 — o defeito original.
          return Promise.resolve(state.universo.slice(0, CAPA_POSTGREST)).then((data) =>
            resolve({ data, error: null }),
          );
        }
        const [from, to] = registro.range;
        const pagina = Math.floor(from / CAPA_POSTGREST);
        if (state.erroNaPagina === pagina) {
          return Promise.resolve(
            resolve({ data: null, error: { message: 'canceling statement due to statement timeout', code: '57014' } }),
          );
        }
        if (state.nullNaPagina === pagina) {
          return Promise.resolve(resolve({ data: null, error: null }));
        }
        const fim = Math.min(to + 1, from + CAPA_POSTGREST);
        return Promise.resolve(resolve({ data: state.universo.slice(from, fim), error: null }));
      } catch (e) {
        return reject ? Promise.resolve(reject(e)) : Promise.reject(e);
      }
    },
  };
  return builder;
}

vi.mock('@/integrations/supabase/client', () => ({
  supabase: { rpc: (nome: string, _params: unknown) => makeRpcBuilder(nome) },
}));
vi.mock('@/lib/analytics', () => ({ captureException: vi.fn(), track: vi.fn() }));

import { getAnaliseDimensional } from '@/services/financeiroV2Service';
import { ehFalhaDePagina } from '@/lib/postgrest';

/** Uma linha da matview dimensional, com 1 título e R$ 10 — o total é a CONTAGEM de linhas. */
const linha = (i: number, tipo: 'cp' | 'cr'): Row => ({
  company: 'colacor',
  ano: 2025,
  mes: (i % 12) + 1,
  categoria_codigo: `C${i}`,
  categoria_descricao: 'CATEGORIA UNICA',
  departamento: i % 3 === 0 ? null : `DEP${i % 3}`,
  centro_custo: null,
  cnpj_cpf: `${i}`,
  status_titulo: 'A VENCER',
  qtd_titulos: 1,
  total_documento: 10,
  total_saldo: 10,
  ...(tipo === 'cp'
    ? { nome_fornecedor: `F${i}`, tipo_documento: 'NF', total_pago: 10 }
    : { vendedor_id: i, nome_cliente: `C${i}`, total_recebido: 10 }),
});

beforeEach(() => {
  state.universo = [];
  state.erroNaPagina = null;
  state.nullNaPagina = null;
  state.chamadas = [];
});

describe('getAnaliseDimensional pagina a RPC set-returning', () => {
  it('O CORAÇÃO: lê o universo INTEIRO — 1.227 linhas viram 1.227 títulos, não 1.000', async () => {
    // Sem paginação o resultado seria 1.000: plausível, silencioso e ERRADO em 18,5%. É o
    // mesmo desfecho do #1801, onde 227 clientes da cauda viravam veredito fabricado.
    state.universo = Array.from({ length: 1227 }, (_, i) => linha(i, 'cp'));

    const out = await getAnaliseDimensional('cp', 'all', 'categoria', 2025);

    expect(out).toHaveLength(1);
    expect(out[0].qtd_titulos).toBe(1227);
    expect(out[0].total_documento).toBe(12270);
    expect(state.chamadas).toHaveLength(2); // 0-999 e 1000-1999 (a 2ª volta curta e encerra)
  });

  it('ordena pela chave TOTAL da matview ANTES do `.range()`', async () => {
    // Sem ordem total o Postgres escolhe a ordem de cada página e o offset pula/duplica linha
    // — o mesmo bug de volta, e intermitente. A chave é o GROUP BY da matview, que o índice
    // UNIQUE do `REFRESH … CONCURRENTLY` impõe.
    state.universo = Array.from({ length: 5 }, (_, i) => linha(i, 'cp'));

    await getAnaliseDimensional('cp', 'colacor', 'categoria', 2025, 3);

    const [chamada] = state.chamadas;
    expect(chamada.ordens).toEqual([
      'company', 'ano', 'mes', 'categoria_codigo', 'categoria_descricao', 'departamento',
      'centro_custo', 'nome_fornecedor', 'cnpj_cpf', 'tipo_documento', 'status_titulo',
    ]);
    expect(chamada.range).toEqual([0, 999]);
  });

  it('o ramo CR pagina e ordena com a chave DELE (vendedor_id/nome_cliente, sem tipo_documento)', async () => {
    state.universo = Array.from({ length: 1500 }, (_, i) => linha(i, 'cr'));

    const out = await getAnaliseDimensional('cr', 'all', 'categoria', 2026);

    expect(out[0].qtd_titulos).toBe(1500);
    expect(state.chamadas[0].ordens).toEqual([
      'company', 'ano', 'mes', 'categoria_codigo', 'categoria_descricao', 'departamento',
      'centro_custo', 'vendedor_id', 'nome_cliente', 'cnpj_cpf', 'status_titulo',
    ]);
  });

  it('FAIL-CLOSED: página que falha LANÇA — não devolve o acumulado como se fosse o todo', async () => {
    // Paginar cura a capa, NÃO a falha no meio. Devolver as 1.000 primeiras linhas de um
    // universo de 1.227 porque a 2ª página deu timeout é a leitura parcial silenciosa
    // entrando pela outra porta.
    state.universo = Array.from({ length: 1227 }, (_, i) => linha(i, 'cp'));
    state.erroNaPagina = 1;

    // Casa a MARCA do ramo, não "lançou algo". Um `rejects.toThrow()` PELADO fica verde com
    // qualquer TypeError vindo do dublê e a garantia fail-closed some sem ninguém notar —
    // medido: trocar a mensagem dos DOIS guards de `fetchAllPages` não matava este teste.
    const erro = await getAnaliseDimensional('cp', 'all', 'categoria', 2025).catch((e: unknown) => e);
    expect(ehFalhaDePagina(erro)).toBe(true); // se RESOLVEU, cai aqui mostrando o parcial devolvido
    expect((erro as { motivo: string }).motivo).toBe('pagina_falhou');
  });

  it('FAIL-CLOSED: `data: null` sem error é resposta malformada, não fim de tabela', async () => {
    // Era o que o `?? []` removido daqui transformava em "nenhum título" — zero fabricado.
    state.universo = Array.from({ length: 1227 }, (_, i) => linha(i, 'cp'));
    state.nullNaPagina = 1;

    const erro = await getAnaliseDimensional('cp', 'all', 'categoria', 2025).catch((e: unknown) => e);
    expect(ehFalhaDePagina(erro)).toBe(true);
    expect((erro as { motivo: string }).motivo).toBe('data_null_sem_error');
  });
});
