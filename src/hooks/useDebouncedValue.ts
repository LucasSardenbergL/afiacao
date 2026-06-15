import { useEffect, useState } from 'react';

/**
 * Retorna `value` "atrasado" por `delayMs`: mudanças em rajada (digitação)
 * colapsam e só o último valor é propagado quando a rajada para.
 *
 * Uso canônico — busca controlada que entra numa queryKey do React Query:
 *
 *   const [search, setSearch] = useState('');
 *   const debouncedSearch = useDebouncedValue(search);
 *   useQuery({ queryKey: ['lista', debouncedSearch], ... });
 *
 * O input continua controlado por `search` (digitação fluida); a query só
 * dispara quando o usuário pausa — sem isso, cada TECLA virava um request.
 */
export function useDebouncedValue<T>(value: T, delayMs = 300): T {
  const [debounced, setDebounced] = useState(value);

  useEffect(() => {
    const timer = window.setTimeout(() => setDebounced(value), delayMs);
    return () => window.clearTimeout(timer);
  }, [value, delayMs]);

  return debounced;
}
