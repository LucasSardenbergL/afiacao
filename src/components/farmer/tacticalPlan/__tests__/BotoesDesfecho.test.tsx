import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { BotoesDesfecho, DESFECHOS, payloadDeUmToque, rotuloDoDesfecho } from '../BotoesDesfecho';

const impMock = vi.fn(() => ({ isImpersonating: false }));
vi.mock('@/contexts/ImpersonationContext', () => ({ useImpersonation: () => impMock() }));
vi.mock('@/lib/analytics', () => ({ track: vi.fn() }));

import { track } from '@/lib/analytics';

const eventos = () => (track as ReturnType<typeof vi.fn>).mock.calls as [string, Record<string, unknown>][];

beforeEach(() => {
  impMock.mockReturnValue({ isImpersonating: false });
  vi.clearAllMocks();
});

function setup(onRecord = vi.fn(async () => {})) {
  render(<BotoesDesfecho planId="p1" onRecord={onRecord} />);
  return onRecord;
}

describe('payloadDeUmToque — ausente ≠ zero', () => {
  // O ponto INTEIRO da entrega. Um toque captura UM fato (qual foi o desfecho); todo o resto
  // é desconhecido e tem de chegar ao banco como NULL. `0` em actual_margin entraria nas
  // médias de efetividade como resultado apurado — a fabricação que o money-path proíbe.
  it('[PAYLOAD-1T] margem não apurada é null, nunca 0', () => {
    for (const d of DESFECHOS) {
      const p = payloadDeUmToque(d.valor);
      expect(p.actualMargin).toBeNull();
      expect(p.actualMargin).not.toBe(0);
    }
  });

  it('[PAYLOAD-1T] duração não cronometrada é null, nunca 0', () => {
    // `0` afirmaria uma ligação instantânea — e vira denominador em profitPerHour.
    for (const d of DESFECHOS) {
      expect(payloadDeUmToque(d.valor).callDurationSeconds).toBeNull();
    }
  });

  it('[PAYLOAD-1T] planFollowed é null nos CINCO, inclusive nos que tiveram conversa', () => {
    // A armadilha sutil: gravar `true` em "vendeu/futuro/não vendeu" pareceria razoável e
    // seria fabricação — o toque não pergunta se ela seguiu o roteiro. `false` nos sem-conversa
    // seria pior ainda: afirma que ela ignorou um plano que nem chegou a ser executado.
    for (const d of DESFECHOS) {
      const p = payloadDeUmToque(d.valor);
      expect(p.planFollowed).toBeNull();
      expect(p.planFollowed).not.toBe(false);
      expect(p.planFollowed).not.toBe(true);
    }
  });

  it('[PAYLOAD-1T] callResult é o único campo afirmado', () => {
    expect(payloadDeUmToque('venda_realizada').callResult).toBe('venda_realizada');
    expect(payloadDeUmToque('nao_atendeu').objectionType).toBeUndefined();
    expect(payloadDeUmToque('nao_atendeu').notes).toBeUndefined();
  });
});

describe('DESFECHOS — vocabulário', () => {
  it('preserva exatamente os cinco valores que o select detalhado já grava', () => {
    // Inventar valor novo aqui partiria o histórico em dois vocabulários sem migration.
    expect(DESFECHOS.map((d) => d.valor)).toEqual([
      'venda_realizada', 'interesse_futuro', 'sem_interesse', 'nao_atendeu', 'reagendado',
    ]);
  });

  it('rotuloDoDesfecho traduz o valor gravado; valor desconhecido volta cru', () => {
    expect(rotuloDoDesfecho('venda_realizada')).toBe('Vendeu');
    // Sem inventar rótulo: um valor gravado por outro writer aparece como está, e não some.
    expect(rotuloDoDesfecho('valor_de_outro_writer')).toBe('valor_de_outro_writer');
  });
});

describe('BotoesDesfecho — interação', () => {
  it('renderiza os cinco botões', () => {
    setup();
    for (const d of DESFECHOS) {
      expect(screen.getByRole('button', { name: d.rotulo })).toBeTruthy();
    }
  });

  it('um toque registra o desfecho daquele botão', async () => {
    const onRecord = setup();
    fireEvent.click(screen.getByRole('button', { name: 'Não atendeu' }));
    await waitFor(() => expect(onRecord).toHaveBeenCalledTimes(1));
    expect(onRecord).toHaveBeenCalledWith('p1', expect.objectContaining({
      callResult: 'nao_atendeu',
      actualMargin: null,
      callDurationSeconds: null,
      planFollowed: null,
    }));
  });

  it('[DUPLO-1T] toque duplo não dispara dois registros', async () => {
    // A RPC recusa a segunda gravação com "Plano já concluído" e o toast de erro puniria
    // quem só tocou duas vezes num alvo de 44px.
    let liberar: () => void = () => {};
    const onRecord = vi.fn(() => new Promise<void>((r) => { liberar = r; }));
    render(<BotoesDesfecho planId="p1" onRecord={onRecord} />);

    fireEvent.click(screen.getByRole('button', { name: 'Vendeu' }));
    fireEvent.click(screen.getByRole('button', { name: 'Vendeu' }));
    fireEvent.click(screen.getByRole('button', { name: 'Remarcou' }));

    expect(onRecord).toHaveBeenCalledTimes(1);
    liberar();
    await waitFor(() => expect(onRecord).toHaveBeenCalledTimes(1));
  });

  it('[DUPLO-1T] falha do registro devolve os botões — a vendedora pode tentar de novo', async () => {
    // Sem o finally, um erro de rede deixaria o card travado em "salvando" para sempre.
    const onRecord = vi.fn(async () => { throw new Error('rede'); });
    render(<BotoesDesfecho planId="p1" onRecord={onRecord} />);
    fireEvent.click(screen.getByRole('button', { name: 'Vendeu' }));
    await waitFor(() => {
      expect((screen.getByRole('button', { name: 'Vendeu' }) as HTMLButtonElement).disabled).toBe(false);
    });
  });

  it('[LENTE-1T] sob a lente "Ver como" os botões ficam desabilitados', () => {
    // Registrar resultado é WRITE — mesma regra do RecordResultDialog. `useAuth` é sempre
    // real; só leitura usa o id efetivo (impersonation.md).
    impMock.mockReturnValue({ isImpersonating: true });
    const onRecord = setup();
    for (const d of DESFECHOS) {
      expect((screen.getByRole('button', { name: d.rotulo }) as HTMLButtonElement).disabled).toBe(true);
    }
    fireEvent.click(screen.getByRole('button', { name: 'Vendeu' }));
    expect(onRecord).not.toHaveBeenCalled();
  });
});

describe('BotoesDesfecho — telemetria do clique', () => {
  // O sensor previsto pela errata de #1716. Com 533 planos gerados e 0 desfechos, o clique é
  // a metade que faltava: sem ele, "não abrem a tela" e "abrem, clicam e a RPC recusa" são o
  // mesmo zero em `farmer_tactical_plans.call_result`.
  it('[TELE-1T] cada um dos CINCO botões emite desfecho_clicado com o seu valor', () => {
    for (const d of DESFECHOS) {
      vi.clearAllMocks();
      const { unmount } = render(<BotoesDesfecho planId="p1" onRecord={vi.fn(async () => {})} />);
      fireEvent.click(screen.getByRole('button', { name: d.rotulo }));
      expect(eventos()).toContainEqual([
        'plano_tatico.desfecho_clicado',
        { desfecho: d.valor, plano_id: 'p1', origem: 'um_toque' },
      ]);
      unmount();
    }
  });

  it('[TELE-1T] o clique é emitido ANTES do await — falha de rede não some com a intenção', async () => {
    // Se o evento saísse no `onSuccess`, o caso que mais interessa (clicou e a gravação
    // morreu) não deixaria rastro nenhum — e é justamente ele que separa "não registram"
    // de "tentaram registrar e o sistema recusou".
    render(<BotoesDesfecho planId="p1" onRecord={vi.fn(async () => { throw new Error('rede'); })} />);
    fireEvent.click(screen.getByRole('button', { name: 'Vendeu' }));
    // Síncrono de propósito: o evento tem de existir ANTES de a promise da gravação resolver.
    expect(eventos().map(([e]) => e)).toContain('plano_tatico.desfecho_clicado');
    // Deixa o `finally` reabilitar os botões dentro do act — senão o React avisa que houve
    // update fora dele, e teste que polui a saída esconde o próximo aviso de verdade.
    await waitFor(() => {
      expect((screen.getByRole('button', { name: 'Vendeu' }) as HTMLButtonElement).disabled).toBe(false);
    });
  });

  it('[TELE-1T] clique BARRADO pelo guard não vira evento — intenção ≠ tentativa', () => {
    // Sob a lente e durante a gravação o clique é ignorado. Contá-lo inflaria o numerador
    // com toques que nunca chegaram à RPC.
    impMock.mockReturnValue({ isImpersonating: true });
    render(<BotoesDesfecho planId="p1" onRecord={vi.fn(async () => {})} />);
    fireEvent.click(screen.getByRole('button', { name: 'Vendeu' }));
    expect(eventos()).toHaveLength(0);
  });

  it('[TELE-1T] toque duplo emite UMA vez — 1× por desfecho, não por toque', async () => {
    let liberar: () => void = () => {};
    render(<BotoesDesfecho planId="p1" onRecord={vi.fn(() => new Promise<void>((r) => { liberar = r; }))} />);
    fireEvent.click(screen.getByRole('button', { name: 'Vendeu' }));
    fireEvent.click(screen.getByRole('button', { name: 'Vendeu' }));
    expect(eventos().filter(([e]) => e === 'plano_tatico.desfecho_clicado')).toHaveLength(1);
    liberar();
    await waitFor(() => expect(eventos().filter(([e]) => e === 'plano_tatico.desfecho_clicado')).toHaveLength(1));
  });
});
