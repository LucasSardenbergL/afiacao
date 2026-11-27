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
 *   • `sem_cadastro`   — a busca respondeu e não há cadastro → bloqueia; saída "Revalidar cadastro" (depois de cadastrar);
 *   • `indisponivel`   — a busca FALHOU (não sabemos) → bloqueia; saída "Revalidar cadastro".
 * Falha de busca nunca vira "sem cadastro" (ausente ≠ erro): criar em cima de erro de leitura duplicaria.
 */
export type EstadoCadastro = 'nao_verificado' | 'resolvendo' | 'confirmado' | 'sem_cadastro' | 'indisponivel';

/** Desfecho da busca: `erro` = a busca lançou; senão o id encontrado (ou null = não há cadastro). */
export function interpretarCadastro(localUserId: string | null | undefined, erro: unknown): EstadoCadastro {
  if (erro) return 'indisponivel';
  return typeof localUserId === 'string' && localUserId.trim() ? 'confirmado' : 'sem_cadastro';
}

/** Guard do caminho de envio do STAFF: mensagem = bloqueia; `null` = libera (só `confirmado`). */
export function mensagemBloqueioCadastro(estado: EstadoCadastro): string | null {
  switch (estado) {
    case 'confirmado': return null;
    case 'resolvendo': return 'Aguarde — ainda identificando o cliente no app.';
    case 'sem_cadastro': return 'Este cliente não tem cadastro no app — o pedido sairia no nome do vendedor. Cadastre o cliente e toque em “Revalidar cadastro”.';
    case 'indisponivel': return 'Não foi possível identificar o cliente no app. Toque em “Revalidar cadastro” antes de enviar.';
    default: return 'Selecione o cliente antes de enviar.';
  }
}
