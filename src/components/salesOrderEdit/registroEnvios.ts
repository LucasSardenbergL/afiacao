// Estado do salvar que precisa sobreviver à TELA (revisão /sales leva 1, #30; Codex 2026-11-26).
//
// O editor remonta a cada `:id` (cada pedido tem a sua instância), então a resposta atrasada do pedido A não
// tem como escrever na tela do pedido B. Mas dois fatos são do PEDIDO, não da tela, e valem enquanto o app
// estiver aberto: (1) o envio de A ainda está voando — uma tela nova de A não pode mandar outro por cima;
// (2) A ficou divergente do Omie — reabrir A (mesmo depois de ir e voltar) relê o app, não o Omie, e não
// pode reabilitar o carrinho velho. A trava durável no banco é a próxima entrega (PR 2 da leva 1).

const emVoo = new Set<string>();
const divergentes = new Set<string>();
const ouvintes = new Set<() => void>();

const avisar = () => { for (const f of ouvintes) f(); };
/** Chave canônica: só os dígitos hexadecimais, em minúsculas. A rota aceita o UUID em maiúsculas, sem hífens
 *  ou entre chaves, e o banco devolve sempre o formato com hífens (Codex 2026-11-26). */
const chave = (pedidoId: string) => pedidoId.toLowerCase().replace(/[^0-9a-f]/g, '');

/** Adquire o envio do pedido: `false` se outro já voa (outra tela, mesma aba) — síncrono, sem janela entre
 *  conferir e marcar (Codex 2026-11-26: A→B→A com dois cliques mandava dois envios do mesmo PV). */
export function iniciarEnvio(pedidoId: string): boolean {
  // Divergente também recusa: a trava não depende de a tela ter lido o registro pela mesma grafia.
  if (emVoo.has(chave(pedidoId)) || divergentes.has(chave(pedidoId))) return false;
  emVoo.add(chave(pedidoId));
  avisar();
  return true;
}

export function encerrarEnvio(pedidoId: string): void {
  emVoo.delete(chave(pedidoId));
  avisar();
}

export function marcarDivergente(pedidoId: string): void {
  divergentes.add(chave(pedidoId));
  avisar();
}

export function estadoDoPedido(pedidoId: string): { emVoo: boolean; divergente: boolean } {
  return { emVoo: emVoo.has(chave(pedidoId)), divergente: divergentes.has(chave(pedidoId)) };
}

export function ouvirRegistro(f: () => void): () => void {
  ouvintes.add(f);
  return () => { ouvintes.delete(f); };
}

/** Só para testes: o registro é do módulo e vazaria de um teste para o outro. */
export function limparRegistroParaTeste(): void {
  emVoo.clear();
  divergentes.clear();
  avisar();
}
