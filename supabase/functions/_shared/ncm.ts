// NCM em 8 dígitos — compartilhado entre `omie-nfe-recebimento-sync` (itens.ts) e `omie-nfe-webhook`.
//
// Mora em `_shared/` porque o empacotador do Lovable leva só a pasta da função + `_shared/`: import de
// OUTRA pasta de função ("../omie-nfe-recebimento-sync/itens.ts") passa no Deno local e no CI e falha no
// deploy com "Module not found" (medido no deploy da webhook v1.3, 2026-10-18).

/**
 * O NCM em 8 dígitos, que é o que cabe em `nfe_recebimento_itens.ncm` (`varchar(8)`).
 *
 * O Omie devolve o NCM PONTUADO (`2909.60.90`), e gravá-lo cru estourava a coluna: 22001 no
 * insert do lote inteiro, e toda NF-e de produção ficou só com o cabeçalho (0 itens, medido em
 * 2026-09-26). O NCM é o bloco `dddd.dd.dd` do início (pontos opcionais); o que vem depois de um
 * separador não-dígito é extensão (EX TIPI, ex.: `3920.49.00.01`) e não faz parte dele. Qualquer
 * outra forma vira `null`: ausente, nunca um código fabricado por corte ou preenchimento.
 */
export function normalizarNcm(bruto: string | null | undefined): string | null {
  if (bruto == null) return null;
  const m = /^\s*(\d{4})\.?(\d{2})\.?(\d{2})(?:\D.*)?$/.exec(bruto);
  return m ? `${m[1]}${m[2]}${m[3]}` : null;
}
