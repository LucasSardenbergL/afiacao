// Mapa faixa → rótulo + classe de cor (tokens text-status-*). Compartilhado entre
// a lista de busca (ProductItemForm) e o carrinho (CartItemList). neutro não renderiza.
export const FAIXA_UI: Record<string, { label: string; cls: string }> = {
  vermelho: { label: 'Abaixo do custo', cls: 'text-status-error' },
  amarelo:  { label: 'Abaixo do piso',  cls: 'text-status-warning' },
  verde:    { label: 'Saudável',        cls: 'text-status-success' },
};
