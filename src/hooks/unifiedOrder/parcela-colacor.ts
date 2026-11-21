/**
 * Sugestão de prazo da COLACOR: qual código de cliente consultar no histórico.
 *
 * Oben e Colacor são contas Omie SEPARADAS e os códigos de cliente COLIDEM: o 101 da Oben
 * pode ser, na Colacor, outro comprador. A seleção consultava `buscar_ultima_parcela` na
 * Colacor com o código da OBEN → o PV Colacor (cliente 202) saía com o prazo do 101, se a
 * vendedora não mexesse no prazo.
 *
 * Regra: só o código da PRÓPRIA Colacor serve. O lookup por documento (`buscar_cliente`,
 * account colacor) vence; sem ele, vale o código Colacor que o cadastro já trazia. Sem
 * nenhum dos dois → `null` = NÃO consultar (o prazo fica no padrão '999'). Ausente ≠ código
 * Oben: por isso a função nem recebe o código Oben.
 */
export interface LookupClienteColacor {
  cliente?: { codigo_cliente?: number | null } | null;
}

function codigoValido(codigo: number | null | undefined): codigo is number {
  return typeof codigo === 'number' && Number.isInteger(codigo) && codigo > 0;
}

export function codigoParaParcelaColacor(
  lookup: LookupClienteColacor | null | undefined,
  codigoColacorConhecido: number | null | undefined,
): number | null {
  const doLookup = lookup?.cliente?.codigo_cliente;
  if (codigoValido(doLookup)) return doLookup;
  if (codigoValido(codigoColacorConhecido)) return codigoColacorConhecido;
  return null;
}
