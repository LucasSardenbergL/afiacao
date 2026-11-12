// Link do resumo diário por e-mail (venda R2 · Entrega 1): /meu-dia/abrir/:token → `venda_resumo_abrir` → a ficha do
// comprador no Meu Dia (/meu-dia?ficha=<comprador>). Puro: a página e a fila decidem com ele; o teste prova a régua.
import type { Json } from '@/integrations/supabase/types';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Token do link (uuid) ou null — link malformado vai para o Meu Dia sem chamar nada. */
export function lerTokenDoLink(token: string | undefined | null): string | null {
  const t = typeof token === 'string' ? token.trim().toLowerCase() : '';
  return UUID.test(t) ? t : null;
}

/** O id do comprador do parâmetro `ficha` da URL, ou null. */
export function lerFichaDaUrl(v: string | null | undefined): string | null {
  return lerTokenDoLink(v);
}

export function linkFichaMeuDia(compradorId: string): string {
  return `/meu-dia?ficha=${encodeURIComponent(compradorId)}`;
}

export interface AberturaResumo {
  comprador_id: string;
  registrado: boolean;
  do_destinatario: boolean;
}

/** Retorno de `venda_resumo_abrir`: NULL (token desconhecido) → null; forma fora do contrato → null (vai ao Meu Dia). */
export function lerAbertura(data: Json | null): AberturaResumo | null {
  if (typeof data !== 'object' || data === null || Array.isArray(data)) return null;
  const c = data.comprador_id;
  if (typeof c !== 'string' || !UUID.test(c)) return null;
  return {
    comprador_id: c,
    registrado: data.registrado === true,
    do_destinatario: data.do_destinatario === true,
  };
}
