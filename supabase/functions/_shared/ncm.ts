// NCM em 8 dígitos — compartilhado entre os DOIS writers de `nfe_recebimento_itens`
// (`omie-nfe-recebimento-sync` e `omie-nfe-webhook`).
//
// Por que aqui e não na sync: o deploy de uma edge pelo Lovable empacota SÓ a pasta da função e
// `_shared/`. Import de OUTRA pasta de função compila e passa em todos os gates locais, mas o
// bundle de deploy falha com `Module not found` (medido em 2026-10-19: omie-nfe-webhook v1.3
// importava `../omie-nfe-recebimento-sync/itens.ts`; 8/8 hashes conferidos, deploy recusado).
// A cópia em `omie-nfe-recebimento-sync/itens.ts` segue sendo a usada pela sync até o PR da RPC
// (`importar_nfe_recebimento`), que reescreve as duas edges e passa a importar daqui.

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
