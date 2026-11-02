import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';

/**
 * `wrapper` de `renderHook`/`render` com um QueryClient NOVO por chamada — cache nenhum vaza de um
 * teste para outro. Nasceu quando os motores do Farmer passaram a ler o universo de pedidos por
 * react-query (plano v4, lote 16) e todo teste que os renderiza passou a precisar do provider.
 * `retry: false`: erro de leitura aparece na hora, como em produção para essas consultas.
 */
export function comQueryClient(
  client: QueryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } }),
) {
  return function ComQueryClient({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  };
}
