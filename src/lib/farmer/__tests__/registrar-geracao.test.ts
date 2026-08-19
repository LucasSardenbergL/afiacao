import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * O sensor de head é FAIL-OPEN por desenho — falha nele não pode derrubar a tela, porque o
 * cálculo já é válido e já foi exibido. O defeito não era o fail-open: era ele ser MUDO.
 *
 * Como só escrevia no `console`, dois desfechos opostos deixavam o MESMO rastro observável
 * (nenhum): a geração legitimamente vazia que registrou, e a que não conseguiu registrar. Para
 * quem for medir a frequência do zero — a fase 2, que decide expirar carteira — os dois casos
 * são indistinguíveis, e a cegueira acontece exatamente quando mais importa.
 *
 * A correção não é deixar de ser fail-open: é DEVOLVER o desfecho (para o caller decidir) e
 * reportar ao canal operacional (`captureException`), que é onde a falha vira número.
 *
 * FG106 é a exceção que confirma: não é falha, é o compare-and-swap recusando um registro
 * mais VELHO por cima de um head mais novo. Reportar isso ao Sentry seria ruído — a recusa é
 * o mecanismo funcionando.
 */
const captureException = vi.fn();
const rpc = vi.fn();

vi.mock('@/integrations/supabase/client', () => ({ supabase: { rpc: (...a: unknown[]) => rpc(...a) } }));
vi.mock('@/lib/analytics', () => ({ captureException: (...a: unknown[]) => captureException(...a) }));

import { registrarGeracaoFarmer } from '../registrar-geracao';

const PARAMS = {
  motor: 'bundle' as const,
  farmerId: 'farmer-1',
  runId: 'run-1',
  resultado: 'vazio' as const,
  linhasGeradas: 0,
  completude: 'degradado' as const,
  motivo: 'não consegui ler: vendaveis',
  insumos: { vendaveis: { ok: false, n: 0 } },
  headVisto: null,
};

beforeEach(() => { captureException.mockClear(); rpc.mockClear(); });

describe('registrarGeracaoFarmer — fail-open, mas NUNCA mudo', () => {
  it('devolve registrado:true quando a RPC grava', async () => {
    rpc.mockResolvedValue({ error: null });

    await expect(registrarGeracaoFarmer(PARAMS)).resolves.toEqual({ registrado: true });
    expect(captureException).not.toHaveBeenCalled();
  });

  it('devolve registrado:false E reporta ao canal operacional quando a RPC falha', async () => {
    rpc.mockResolvedValue({ error: { code: '57014', message: 'statement timeout' } });

    const r = await registrarGeracaoFarmer(PARAMS);

    expect(r).toMatchObject({ registrado: false, motivo: 'falha_rpc' });
    // Sem isto o sensor fica cego em silêncio: nenhuma linha nova na tabela e nenhum sinal
    // de que a ausência é falha, não vazio legítimo.
    expect(captureException).toHaveBeenCalledTimes(1);
  });

  it('FG106 devolve registrado:false SEM reportar — a recusa do CAS é o mecanismo, não falha', async () => {
    rpc.mockResolvedValue({ error: { code: 'FG106', message: 'head já avançou' } });

    const r = await registrarGeracaoFarmer(PARAMS);

    expect(r).toMatchObject({ registrado: false, motivo: 'head_avancou' });
    expect(captureException).not.toHaveBeenCalled();
  });

  it('a exceção do transporte não escapa — fail-open é para a TELA, não para o rastro', async () => {
    rpc.mockRejectedValue(new Error('rede caiu'));

    const r = await registrarGeracaoFarmer(PARAMS);

    expect(r).toMatchObject({ registrado: false, motivo: 'falha_rpc' });
    expect(captureException).toHaveBeenCalledTimes(1);
  });
});
