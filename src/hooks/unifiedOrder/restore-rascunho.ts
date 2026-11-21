// Restore do rascunho do Novo Pedido — decisão pura (follow-up Codex P1 do #4068).
//
// O carrinho do rascunho foi precificado para o cliente DELE. Restaurar sem cliente na tela punha
// esse carrinho na tela e, se a vendedora selecionasse OUTRO cliente, os itens (com preço negociado
// para o primeiro) iam no pedido do segundo. A regra: rascunho com cliente IDENTIFICADO só é
// aplicado sobre esse mesmo cliente — com a tela vazia, espera a seleção dele.

/** `codigo_cliente` 0 (cliente aberto pelo 360 sem cadastro Omie) não identifica ninguém. */
export function codigoClienteIdentifica(codigo: number | null | undefined): codigo is number {
  return typeof codigo === 'number' && Number.isFinite(codigo) && codigo > 0;
}

export type DecisaoRestore = 'recusar' | 'aplicar' | 'esperarCliente';

/** Ao clicar "Restaurar": recusa rascunho de outro cliente, espera o cliente quando a tela está vazia. */
export function decidirRestore(codigoRascunho: number | null, codigoAtual: number | null): DecisaoRestore {
  // Guard de sempre (Codex P1 anterior): os dois códigos conhecidos e diferentes → outro cliente.
  if (codigoRascunho != null && codigoAtual != null && codigoRascunho !== codigoAtual) return 'recusar';
  if (codigoClienteIdentifica(codigoRascunho) && codigoAtual == null) return 'esperarCliente';
  return 'aplicar';
}

export type DecisaoPendente = 'esperar' | 'aplicar' | 'descartar';

/** Com o restore pendente, a cada troca do cliente selecionado. */
export function resolverRestorePendente(codigoPendente: number, codigoSelecionado: number | null): DecisaoPendente {
  if (codigoSelecionado == null) return 'esperar';
  return codigoSelecionado === codigoPendente ? 'aplicar' : 'descartar';
}
