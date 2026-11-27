// Qual conta do envio o Omie CONFIRMOU — a mesma decisão que o `allConfirmed` tomava num predicado só,
// agora partida por conta (revisão /sales L2-b). O cupom do envio parcial imprimia o carrinho inteiro:
// a via da conta pendente/bloqueada saía com "(pendente ERP)" no lugar do número do PV, como se o pedido
// existisse no ERP. Cada conta só imprime se nenhum erro DELA ficou no envio.
//
// A partição é EXATA sobre o predicado antigo do `allConfirmed` — `allConfirmed === oben && colacor &&
// afiacao`. Passo que não está aqui (validate_*, create_production_order, aviso_*) não desconfirma conta.

export type ContaDoEnvio = 'oben' | 'colacor' | 'afiacao';
export type ContasConfirmadas = Record<ContaDoEnvio, boolean>;

const PASSOS_QUE_DESCONFIRMAM: Record<ContaDoEnvio, (step: string) => boolean> = {
  oben: (s) =>
    s === 'sync_oben_omie' || s === 'bloqueio_credito_oben' || s === 'bloqueio_tint_oben' ||
    s === 'bloqueio_atp_oben' || s === 'bloqueio_desconhecido_oben' || s === 'pv_divergente_oben',
  colacor: (s) =>
    s === 'sync_colacor_omie' || s === 'bloqueio_credito_colacor' ||
    s === 'bloqueio_desconhecido_colacor' || s === 'pv_divergente_colacor',
  afiacao: (s) => s === 'sync_os_omie' || s.startsWith('afiacao_') || s === 'aguardar_os_afiacao',
};

export function contasConfirmadasDoEnvio(errors: ReadonlyArray<{ step: string }>): ContasConfirmadas {
  const confirmada = (c: ContaDoEnvio) => !errors.some((e) => PASSOS_QUE_DESCONFIRMAM[c](e.step));
  return { oben: confirmada('oben'), colacor: confirmada('colacor'), afiacao: confirmada('afiacao') };
}

export function todasConfirmadas(c: ContasConfirmadas): boolean {
  return c.oben && c.colacor && c.afiacao;
}
