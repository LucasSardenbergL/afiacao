import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';

/**
 * Guard — a gravação do ARGUMENTO de venda não pode falhar calada, nem gravar em linha morta.
 *
 * Irmão de `bundle-recomendacoes-erro-silencioso.test.tsx` (mesma tabela, mesma classe
 * §11 do money-path, outro escritor). Lá o defeito era o INSERT das recomendações; aqui é
 * o UPDATE que persiste o texto que a LLM gerou:
 *
 *   await supabase.from('farmer_bundle_recommendations').update({ argument_phone, … })
 *     .eq('id', bundleId);            // ← error descartado E sem filtro de status
 *
 * DOIS defeitos no mesmo statement:
 *
 * 1. ESCRITA CALADA (§11). O supabase-js NÃO lança em erro de banco — resolve normal com
 *    `error` preenchido. Um 42501 da RLS, uma coluna ausente (PGRST204) ou um 57014
 *    devolvem sucesso ao caller sem ter gravado. O que se perde é o argumento gerado por
 *    LLM: uma chamada de API paga mais o tempo da vendedora que leu e ajustou o texto.
 *
 * 2. GRAVAÇÃO EM GERAÇÃO APOSENTADA. Desde a migration 20260814223445 (aplicada em prod,
 *    conferida via psql-ro em 2026-08-15) um recálculo do motor marca a geração anterior
 *    como `status='expirado'`. O `.eq('id', …)` cru grava numa linha que NENHUM leitor
 *    mostra — os três (`useTacticalPlan`, `generate-tactical-plan`, `OfertaCruaCard`)
 *    filtram `status='pendente'`. Antes da migration nada era expirado e o defeito era
 *    latente; agora a janela é real: gerar o argumento, o motor recalcular, salvar.
 *
 * DISCRIMINADOR: nenhum caminho em que o UPDATE não gravou pode terminar em silêncio.
 * O retorno `Promise<void>` de antes não distinguia "gravou" de "não gravou" nem para o
 * caller nem para a tela — é o HTTP 200 mentiroso do §11 chegando à UI.
 *
 * §12 (a MENSAGEM morre no catch): o `error` do PostgREST é objeto PLANO, não `Error`.
 * O idiom `err instanceof Error ? … : String(err)` imprimiria "[object Object]"; por isso
 * o assert exige a frase do servidor no toast, não só que "algum" toast apareceu.
 */
const BUNDLE_ID = 'bundle-1';

const ARGUMENTO = {
  diagnostico: 'd',
  insight_tecnico: 'i',
  beneficio_operacional: 'bo',
  beneficio_economico: 'be',
  objecao_antecipada: 'oa',
  versao_phone: 'texto do telefone',
  versao_whatsapp: 'texto do whatsapp',
  versao_tecnica: 'texto tecnico',
};

/** Erro PLANO do PostgREST — herda de Object, não de Error (é o ponto do §12). */
const ERRO_RLS = {
  code: '42501',
  message: 'new row violates row-level security policy for table "farmer_bundle_recommendations"',
  details: '',
  hint: '',
};

type Escrita = {
  tabela: string;
  payload: Record<string, unknown>;
  filtros: Array<[string, unknown]>;
  selectPedido: string | null;
};

const { toastErro, toastOk } = vi.hoisted(() => ({ toastErro: vi.fn(), toastOk: vi.fn() }));
vi.mock('sonner', () => ({ toast: { error: toastErro, success: toastOk } }));

let escritas: Escrita[] = [];
/** Erro devolvido pelo update (null = banco aceitou). */
let erroUpdate: unknown = null;
/** Linhas que o UPDATE realmente afetou — `[]` é o caso "a linha alvo foi expirada". */
let linhasAfetadas: Array<{ id: string }> = [{ id: BUNDLE_ID }];

const resposta = () =>
  erroUpdate ? { data: null, error: erroUpdate } : { data: linhasAfetadas, error: null };

vi.mock('@/integrations/supabase/client', () => ({
  supabase: {
    from: (tabela: string) => ({
      update: (payload: Record<string, unknown>) => {
        const reg: Escrita = { tabela, payload, filtros: [], selectPedido: null };
        escritas.push(reg);
        // O builder do PostgREST é THENABLE: `await …update().eq()` resolve com
        // `{ data, error }` mesmo sem `.select()`. Sem o `then` aqui o mock deixaria a
        // forma pré-fix passar por acidente (`await objeto-comum` devolve o objeto), e o
        // teste ficaria verde contra o bug — o detector precisa ter dente.
        const chain = {
          eq(coluna: string, valor: unknown) {
            reg.filtros.push([coluna, valor]);
            return chain;
          },
          select(colunas: string) {
            reg.selectPedido = colunas;
            return Promise.resolve(resposta());
          },
          then(ok: (v: unknown) => unknown, err?: (e: unknown) => unknown) {
            return Promise.resolve(resposta()).then(ok, err);
          },
        };
        return chain;
      },
    }),
  },
}));

import { useBundleArguments } from '@/hooks/useBundleArguments';

async function salvar() {
  const { result } = renderHook(() => useBundleArguments());
  let retorno: unknown;
  await act(async () => {
    retorno = await result.current.saveArgumentToBundle(BUNDLE_ID, ARGUMENTO, 'misto', 'consultiva');
  });
  return retorno;
}

const textoDosToasts = () => toastErro.mock.calls.map((c) => String(c[0])).join(' | ');

describe('argumento do bundle: gravação não pode falhar calada nem cair em geração aposentada', () => {
  beforeEach(() => {
    escritas = [];
    erroUpdate = null;
    linhasAfetadas = [{ id: BUNDLE_ID }];
    toastErro.mockClear();
    toastOk.mockClear();
  });

  it('erro do banco vira toast COM O MOTIVO do servidor e retorno de falha (§11 + §12)', async () => {
    erroUpdate = ERRO_RLS;

    const retorno = await salvar();

    expect(toastErro, 'falha de escrita não pode terminar em silêncio').toHaveBeenCalled();
    expect(textoDosToasts(), 'o motivo do PostgREST tem de chegar à vendedora').toContain(
      'row-level security policy',
    );
    expect(textoDosToasts(), 'objeto plano no toast é o defeito do §12').not.toContain('[object Object]');
    expect(retorno, 'o caller precisa distinguir gravou de não gravou').toBe(false);
  });

  it('linha alvo já expirada (0 afetadas) avisa que houve recálculo, sem fingir sucesso', async () => {
    linhasAfetadas = [];

    const retorno = await salvar();

    expect(toastErro, 'gravar em linha morta não pode passar batido').toHaveBeenCalled();
    expect(textoDosToasts(), 'a mensagem tem de dizer o que fazer').toMatch(/recálculo|recalcul/i);
    expect(retorno).toBe(false);
  });

  it('o UPDATE filtra status=pendente — não escreve na geração aposentada', async () => {
    await salvar();

    expect(escritas, 'uma única escrita, na tabela das recomendações').toHaveLength(1);
    expect(escritas[0].tabela).toBe('farmer_bundle_recommendations');
    expect(escritas[0].filtros).toContainEqual(['id', BUNDLE_ID]);
    expect(
      escritas[0].filtros,
      'sem o filtro de status o update grava em linha que nenhum leitor mostra',
    ).toContainEqual(['status', 'pendente']);
  });

  it('pede as linhas de volta — é assim que "0 afetadas" fica distinguível de sucesso', async () => {
    await salvar();

    expect(
      escritas[0].selectPedido,
      'sem RETURNING não há como saber se a linha existia e estava pendente',
    ).toBeTruthy();
  });

  it('gravação bem-sucedida não alarma e reporta sucesso', async () => {
    const retorno = await salvar();

    expect(toastErro).not.toHaveBeenCalled();
    expect(retorno).toBe(true);
    expect(escritas[0].payload).toMatchObject({
      argument_phone: ARGUMENTO.versao_phone,
      argument_whatsapp: ARGUMENTO.versao_whatsapp,
      argument_technical: ARGUMENTO.versao_tecnica,
      customer_profile: 'misto',
      approach_type: 'consultiva',
    });
  });
});
