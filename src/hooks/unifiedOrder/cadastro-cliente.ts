/**
 * 8.2 (rodada 3): o cliente do pedido é IDENTIFICADO no app — nunca o vendedor.
 *
 * Antes, quando a busca do cadastro local falhava (ou o cliente não tinha cadastro), o staff seguia com
 * `customerUserId = null` e o envio gravava `customer_user_id = user.id`: o pedido nascia no nome do
 * VENDEDOR e o telefone dele sobrescrevia o do Omie (21/11, cliente COM cadastro, busca falhou).
 *
 * Estados (só staff; o autoatendimento é sempre o próprio usuário):
 *   • `nao_verificado` — sem cliente selecionado;
 *   • `resolvendo`     — buscando o cadastro;
 *   • `confirmado`     — cadastro encontrado → libera;
 *   • `sem_cadastro`   — a busca respondeu e não há cadastro → bloqueia; saída "Trocar" (depois de cadastrar);
 *   • `indisponivel`   — a busca FALHOU (não sabemos) → bloqueia; saída "Trocar" (seleção nova, como no 8.1).
 * Falha de busca nunca vira "sem cadastro" (ausente ≠ erro): criar em cima de erro de leitura duplicaria.
 */
export type EstadoCadastro = 'nao_verificado' | 'resolvendo' | 'confirmado' | 'sem_cadastro' | 'indisponivel';

/** Desfecho da busca: `erro` = a busca lançou; senão o id encontrado (ou null = não há cadastro). */
export function interpretarCadastro(localUserId: string | null | undefined, erro: unknown): EstadoCadastro {
  if (erro) return 'indisponivel';
  return typeof localUserId === 'string' && localUserId.trim() ? 'confirmado' : 'sem_cadastro';
}

/** 8.2 (Codex r3/r4): com um envio deste carrinho ainda sem confirmação (envelope comprometido), "Trocar"
 *  zera o checkoutId e o próximo envio pode criar um 2º PV. A saída é RECARREGAR: o envelope persiste e o
 *  reenvio (cliente selecionado de novo, cadastro confirmado) usa o MESMO pedido. */
export const MSG_CADASTRO_ENVIO_PENDENTE =
  'Há um envio deste carrinho ainda sem confirmação. Não use “Trocar” (o pedido poderia sair em dobro): recarregue a página e selecione o cliente de novo.';

/** Guard do caminho de envio do STAFF: mensagem = bloqueia; `null` = libera (só `confirmado`). */
export function mensagemBloqueioCadastro(estado: EstadoCadastro, envioPendente = false): string | null {
  if (envioPendente && (estado === 'sem_cadastro' || estado === 'indisponivel')) return MSG_CADASTRO_ENVIO_PENDENTE;
  switch (estado) {
    case 'confirmado': return null;
    case 'resolvendo': return 'Aguarde — ainda identificando o cliente no app.';
    case 'sem_cadastro': return 'Este cliente não tem cadastro no app — o pedido sairia no nome do vendedor. Cadastre o cliente e use “Trocar” para selecioná-lo de novo.';
    case 'indisponivel': return 'Não foi possível identificar o cliente no app. Use “Trocar” e selecione o cliente de novo.';
    default: return 'Selecione o cliente antes de enviar.';
  }
}
