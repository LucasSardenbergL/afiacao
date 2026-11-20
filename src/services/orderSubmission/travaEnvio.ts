/**
 * Trava de envio do Novo Pedido (rodada 2 da auditoria, achados A2/A3/A5).
 *
 * Por REF (não state): o toque duplo entre o clique e o re-render do `disabled` vê a MESMA
 * closure com `submitting=false` e dispararia 2 fluxos completos (= 2 PVs/orçamentos).
 *
 * - `executarComTravaDeEnvio`: ÚNICO lugar que liga e desliga a trava. Toda saída do corpo
 *   (return antecipado, como o conflito de envelope do A2, ou exceção) libera no `finally` —
 *   antes, um `return` sem `ref = false` deixava "Enviar pedido" morto até recarregar.
 * - `protegerDuranteEnvio`: os mutadores do carrinho viram no-op (com aviso) enquanto a trava
 *   está ligada (A5) — editar no meio do envio era apagado pelo `clearCart` do sucesso.
 */
export interface TravaRef {
  current: boolean;
}

/** Desfecho quando a trava já estava ligada: o corpo NÃO rodou. */
export const ENVIO_EM_ANDAMENTO = Symbol('envio_em_andamento');

export async function executarComTravaDeEnvio<T>(
  trava: TravaRef,
  setSubmitting: (v: boolean) => void,
  corpo: () => Promise<T>,
): Promise<T | typeof ENVIO_EM_ANDAMENTO> {
  if (trava.current) return ENVIO_EM_ANDAMENTO;
  trava.current = true;
  setSubmitting(true);
  try {
    return await corpo();
  } finally {
    trava.current = false;
    setSubmitting(false);
  }
}

// `never[]` nos parâmetros aceita qualquer assinatura de função sem cair em `any`.
type Mutador = (...args: never[]) => unknown;

export function protegerDuranteEnvio<M extends Record<string, Mutador>>(
  trava: TravaRef,
  mutadores: M,
  aoBarrar: () => void,
): M {
  const protegidos: Record<string, Mutador> = {};
  for (const [nome, fn] of Object.entries(mutadores)) {
    protegidos[nome] = (...args: never[]) => {
      if (trava.current) {
        aoBarrar();
        return undefined;
      }
      return fn(...args);
    };
  }
  return protegidos as M;
}
