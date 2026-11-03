// Totais de títulos (CR/CP) do resumo financeiro, com disponibilidade PRÓPRIA, separada do saldo
// bancário (plano v4, lote 13 — follow-up do parecer Codex). Antes, títulos indisponíveis de UMA
// empresa (`sem_acesso`, `desconhecida`, saldo NULL, erro da RPC) faziam `getResumoFinanceiro`
// lançar, e o Dashboard apagava junto o saldo CC que tinha sido lido certo.
//
// Ausente ≠ zero: títulos indisponíveis são `null` (com o motivo), nunca R$ 0. E o consolidado é
// indisponível se faltar QUALQUER CNPJ — somar só quem respondeu daria um total menor apresentado
// como total do grupo (a mesma régua do `saldo_total_cc`).

export interface TotaisTitulos {
  total_a_receber: number | null;
  total_a_pagar: number | null;
  total_vencido_receber: number | null;
  total_vencido_pagar: number | null;
  /** CR − CP abertos. */
  posicao_liquida: number | null;
  /** Por que os títulos estão indisponíveis; `null` quando os totais são conhecidos. */
  titulos_motivo: string | null;
  /**
   * `true` só quando a indisponibilidade veio de falha de LEITURA (RPC com erro ou rejeitada) —
   * transitória, vale tentar de novo. Dado ausente (`sem_acesso`, `desconhecida`, saldo NULL) não marca.
   */
  titulos_falha_leitura?: true;
}

export const TITULOS_INDISPONIVEIS = (motivo: string, falhaLeitura = false): TotaisTitulos => ({
  total_a_receber: null,
  total_a_pagar: null,
  total_vencido_receber: null,
  total_vencido_pagar: null,
  posicao_liquida: null,
  titulos_motivo: motivo,
  ...(falhaLeitura ? { titulos_falha_leitura: true as const } : {}),
});

/** Soma os totais por CNPJ; `null` em tudo se a lista vier vazia ou se algum CNPJ não tiver títulos. */
export function consolidarTitulos(porCnpj: readonly TotaisTitulos[]): TotaisTitulos {
  if (porCnpj.length === 0) return TITULOS_INDISPONIVEIS('nenhuma empresa no resumo');
  // `typeof` e não `!== null`: um resumo sem o campo (undefined) não é motivo de indisponibilidade —
  // quem decide são os totais null logo abaixo.
  const motivos = porCnpj.map((r) => r.titulos_motivo).filter((m): m is string => typeof m === 'string');
  if (motivos.length > 0 || porCnpj.some((r) => r.total_a_receber === null || r.total_a_pagar === null
      || r.total_vencido_receber === null || r.total_vencido_pagar === null)) {
    return TITULOS_INDISPONIVEIS(motivos.length > 0 ? motivos.join(' · ') : 'títulos de alguma empresa indisponíveis');
  }
  const somar = (campo: 'total_a_receber' | 'total_a_pagar' | 'total_vencido_receber' | 'total_vencido_pagar') =>
    porCnpj.reduce((s, r) => s + (r[campo] as number), 0);
  const receber = somar('total_a_receber');
  const pagar = somar('total_a_pagar');
  return {
    total_a_receber: receber,
    total_a_pagar: pagar,
    total_vencido_receber: somar('total_vencido_receber'),
    total_vencido_pagar: somar('total_vencido_pagar'),
    posicao_liquida: receber - pagar,
    titulos_motivo: null,
  };
}
