import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { PedidoRow } from '../PedidoRow';
import type { PedidoSugerido } from '../types';

// Supabase mockado por fonte: a prévia "recebe em" (pedido não disparado) lê o LT e chama a RPC.
type Resposta = { data: unknown; error: { message: string } | null };
let previa: Resposta = { data: [{ promessa: null, recebimento: null }], error: null };
let lts: Resposta = { data: [], error: null };
const chamadasRpc: { nome: string; args: Record<string, unknown> }[] = [];
function builder(resposta: () => Resposta) {
  const q: Record<string, unknown> = {};
  for (const m of ['select', 'order', 'range', 'eq']) q[m] = () => q;
  q.then = (ok: (r: Resposta) => unknown, ko?: (e: unknown) => unknown) => Promise.resolve(resposta()).then(ok, ko);
  return q;
}
vi.mock('@/integrations/supabase/client', () => ({
  supabase: {
    from: () => builder(() => lts),
    rpc: (nome: string, args: Record<string, unknown>) => {
      chamadasRpc.push({ nome, args });
      return builder(() => previa);
    },
  },
}));
beforeEach(() => {
  previa = { data: [{ promessa: null, recebimento: null }], error: null };
  lts = { data: [], error: null };
  chamadasRpc.length = 0;
});

function ped(partial: Partial<PedidoSugerido>): PedidoSugerido {
  return partial as unknown as PedidoSugerido;
}

function renderRow(
  p: PedidoSugerido,
  opts?: { onDispararIgnorandoMinimo?: () => void },
) {
  const onDisparar = vi.fn();
  const onOverride = opts?.onDispararIgnorandoMinimo;
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  const utils = render(
    <QueryClientProvider client={qc}>
    <table>
      <tbody>
        <PedidoRow
          p={p}
          onVerDetalhes={() => {}}
          onCancelar={() => {}}
          onVerPortal={() => {}}
          onDisparar={onDisparar}
          onDispararIgnorandoMinimo={onOverride}
          disparando={false}
        />
      </tbody>
    </table>
    </QueryClientProvider>,
  );
  return { onDisparar, ...utils };
}

describe('PedidoRow — re-disparo de falha_envio', () => {
  it('mostra "Re-disparar" e chama onDisparar quando status é falha_envio', () => {
    const { onDisparar } = renderRow(
      ped({ id: 1, status: 'falha_envio', fornecedor_nome: 'RENNER SAYERLACK S/A', num_skus: 18, valor_total: 7716.34 }),
    );
    const btn = screen.getByRole('button', { name: /Re-disparar/i });
    fireEvent.click(btn);
    expect(onDisparar).toHaveBeenCalledTimes(1);
  });

  it('mostra "Disparar" (não "Re-disparar") quando status é aprovado_aguardando_disparo', () => {
    renderRow(ped({ id: 2, status: 'aprovado_aguardando_disparo', fornecedor_nome: 'X', num_skus: 3, valor_total: 50 }));
    expect(screen.getByRole('button', { name: /^Disparar$/i })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Re-disparar/i })).toBeNull();
  });

  // #3169: aprovado + recusa definitiva do portal — "Disparar" reabria o terminal e reenviava itens
  // já recomprados. A saída é Cancelar (na linha) ou o "Forçar reenvio" do drawer (admin).
  it('aprovado + erro_nao_retentavel → NÃO oferece Disparar, mantém Cancelar', () => {
    renderRow(
      ped({ id: 4, status: 'aprovado_aguardando_disparo', status_envio_portal: 'erro_nao_retentavel', fornecedor_nome: 'RENNER SAYERLACK S/A', num_skus: 13, valor_total: 12414.42 }),
    );
    expect(screen.queryByRole('button', { name: /disparar/i })).toBeNull();
    expect(screen.getByRole('button', { name: /cancelar/i })).toBeTruthy();
  });

  it('falha_envio + erro_nao_retentavel → NÃO oferece Re-disparar', () => {
    renderRow(ped({ id: 5, status: 'falha_envio', status_envio_portal: 'erro_nao_retentavel', fornecedor_nome: 'X', num_skus: 1, valor_total: 1 }));
    expect(screen.queryByRole('button', { name: /disparar/i })).toBeNull();
  });

  it('não mostra botão de disparo quando status é disparado', () => {
    renderRow(
      ped({ id: 3, status: 'disparado', fornecedor_nome: 'X', num_skus: 3, valor_total: 50, omie_pedido_compra_numero: '123' }),
    );
    expect(screen.queryByRole('button', { name: /disparar/i })).toBeNull();
  });
});

describe('PedidoRow — tooltip de motivo (bloqueio / falha)', () => {
  it('bloqueado_guardrail com mensagem_bloqueio → mostra o ícone de motivo do bloqueio', () => {
    renderRow(
      ped({
        id: 10,
        status: 'bloqueado_guardrail',
        fornecedor_nome: 'X',
        num_skus: 5,
        valor_total: 999,
        mensagem_bloqueio: 'Variação acima de 50% vs ciclo anterior',
      }),
    );
    expect(screen.getByRole('button', { name: /Motivo do bloqueio/i })).toBeTruthy();
  });

  it('bloqueado_guardrail SEM mensagem_bloqueio → não renderiza o ícone (guard de null)', () => {
    renderRow(
      ped({ id: 11, status: 'bloqueado_guardrail', fornecedor_nome: 'X', num_skus: 5, valor_total: 999, mensagem_bloqueio: null }),
    );
    expect(screen.queryByRole('button', { name: /Motivo do bloqueio/i })).toBeNull();
  });

  it('falha_envio com resposta_canal.erro → mostra o ícone de motivo da falha', () => {
    renderRow(
      ped({
        id: 12,
        status: 'falha_envio',
        fornecedor_nome: 'RENNER SAYERLACK S/A',
        num_skus: 18,
        valor_total: 7716.34,
        resposta_canal: { erro: 'SKU(s) sem custo (preço unitário 0)' },
      }),
    );
    expect(screen.getByRole('button', { name: /Motivo da falha no disparo/i })).toBeTruthy();
  });

  it('falha_envio SEM resposta_canal.erro → não renderiza o ícone (guard de null)', () => {
    renderRow(
      ped({ id: 13, status: 'falha_envio', fornecedor_nome: 'X', num_skus: 18, valor_total: 50, resposta_canal: null }),
    );
    expect(screen.queryByRole('button', { name: /Motivo da falha no disparo/i })).toBeNull();
  });

  it('status normal → nenhum ícone de motivo', () => {
    renderRow(ped({ id: 14, status: 'aprovado_aguardando_disparo', fornecedor_nome: 'X', num_skus: 3, valor_total: 50 }));
    expect(screen.queryByRole('button', { name: /Motivo/i })).toBeNull();
  });
});

describe('PedidoRow — override do mínimo de faturamento ("Disparar mesmo assim")', () => {
  const gateMin = (over?: () => void) =>
    renderRow(
      ped({
        id: 20,
        status: 'falha_envio',
        fornecedor_nome: 'RENNER SAYERLACK S/A',
        num_skus: 4,
        valor_total: 1800,
        resposta_canal: { erro: 'abaixo do mínimo de faturamento', gate: 'minimo_faturamento' },
      }),
      over ? { onDispararIgnorandoMinimo: over } : undefined,
    );

  it('gate-min + gestor (callback): mostra "Disparar mesmo assim" no lugar de "Re-disparar"', () => {
    gateMin(vi.fn());
    expect(screen.getByRole('button', { name: /Disparar mesmo assim/i })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Re-disparar/i })).toBeNull();
  });

  it('gate-min SEM callback (não-gestor): cai no "Re-disparar" normal, sem override', () => {
    gateMin(undefined);
    expect(screen.getByRole('button', { name: /Re-disparar/i })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Disparar mesmo assim/i })).toBeNull();
  });

  it('falha_envio por OUTRO motivo + callback: NÃO oferece override (só "Re-disparar")', () => {
    renderRow(
      ped({
        id: 21,
        status: 'falha_envio',
        fornecedor_nome: 'RENNER SAYERLACK S/A',
        num_skus: 4,
        valor_total: 1800,
        resposta_canal: { erro: 'SKU(s) sem custo (preço unitário 0)' },
      }),
      { onDispararIgnorandoMinimo: vi.fn() },
    );
    expect(screen.getByRole('button', { name: /Re-disparar/i })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Disparar mesmo assim/i })).toBeNull();
  });

  it('confirmar no diálogo chama onDispararIgnorandoMinimo uma vez', () => {
    const over = vi.fn();
    gateMin(over);
    fireEvent.click(screen.getByRole('button', { name: /Disparar mesmo assim/i }));
    fireEvent.click(screen.getByRole('button', { name: /Confirmar e disparar/i }));
    expect(over).toHaveBeenCalledTimes(1);
  });
});

describe('PedidoRow — "recebe em" antes do disparo (prévia pela RPC, spec §6.3.1)', () => {
  const base = { id: 9, empresa: 'OBEN', fornecedor_nome: 'RENNER SAYERLACK S/A', num_skus: 1, valor_total: 10 };

  it('pendente com portal: empresa fechada na promessa → "recebe em 04/01 (prévia)" e a RPC recebe o portal', async () => {
    previa = { data: [{ promessa: '2026-12-23', recebimento: '2027-01-04' }], error: null };
    renderRow(ped({ ...base, status: 'pendente_aprovacao', portal_data_entrega: '2026-12-21' }));
    expect((await screen.findByTestId('previa-recebe-em')).textContent).toContain('recebe em 04/01 (prévia)');
    expect(chamadasRpc[0]).toMatchObject({ nome: 'calendario_previsao_pedido', args: { p_empresa: 'OBEN', p_portal_data: '2026-12-21' } });
  });

  it('aprovado sem portal: usa o LT do fornecedor habilitado (nome exato)', async () => {
    lts = { data: [{ fornecedor_nome: 'RENNER SAYERLACK S/A', lt_logistica_dias: 5 }], error: null };
    previa = { data: [{ promessa: '2026-12-24', recebimento: '2027-01-04' }], error: null };
    renderRow(ped({ ...base, status: 'aprovado_aguardando_disparo', portal_data_entrega: null }));
    expect(await screen.findByTestId('previa-recebe-em')).toBeTruthy();
    expect(chamadasRpc[0].args).toMatchObject({ p_portal_data: null, p_lt: 5 });
  });

  it('RPC com erro → "previsão indisponível", nunca silêncio', async () => {
    previa = { data: null, error: { message: 'boom' } };
    renderRow(ped({ ...base, status: 'bloqueado_guardrail', portal_data_entrega: '2026-12-21' }));
    expect((await screen.findByTestId('previa-recebe-em-indisponivel')).textContent).toContain('previsão indisponível');
    expect(screen.queryByTestId('previa-recebe-em')).toBeNull();
  });

  it('RPC devolve NULL (sem LT / sem calendário) → "previsão indisponível"', async () => {
    renderRow(ped({ ...base, status: 'pendente_aprovacao', portal_data_entrega: '2026-12-21' }));
    expect(await screen.findByTestId('previa-recebe-em-indisponivel')).toBeTruthy();
  });

  it('CONTROLE: recebimento = promessa → nada (o calendário não empurra)', async () => {
    previa = { data: [{ promessa: '2026-12-09', recebimento: '2026-12-09' }], error: null };
    renderRow(ped({ ...base, status: 'pendente_aprovacao', portal_data_entrega: '2026-12-07' }));
    await vi.waitFor(() => expect(chamadasRpc.length).toBe(1));
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.queryByTestId('previa-recebe-em')).toBeNull();
    expect(screen.queryByTestId('previa-recebe-em-indisponivel')).toBeNull();
  });

  it('disparado: usa as colunas gravadas, sem chamar a RPC', () => {
    renderRow(ped({ ...base, status: 'disparado', recebimento_ajustado_calendario: true, data_recebimento_prevista: '2027-01-05' }));
    expect(screen.getByTestId('recebe-em-calendario').textContent).toContain('recebe em 05/01');
    expect(chamadasRpc.length).toBe(0);
  });
});
