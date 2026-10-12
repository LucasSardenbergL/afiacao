/**
 * Credencial e cliente Supabase VINCULADOS ao dono de um item da fila offline.
 *
 * Por que não basta conferir a sessão antes do handler (Codex, desenho da fila com dono,
 * 2026-10-12): o SDK relê o token do storage a CADA requisição. `confirmUnit` faz três
 * requisições com `await` entre elas; se a sessão troca de A para B depois da conferência, as
 * requisições saem como B (reproduzido: A/B/B). A conferência só vale se o token conferido for
 * o MESMO que assina — então capturamos `{ userId, accessToken }` de UMA leitura da sessão,
 * conferimos o `sub` do próprio JWT e montamos um cliente que só conhece AQUELE token.
 *
 * O cliente do dono passa pelo mesmo write-guard da lente "Ver como" do singleton.
 * Não persiste token nenhum (nada vai para a fila) nem mexe no `Authorization` do singleton.
 */
import { createClient } from '@supabase/supabase-js';
import type { Database } from '@/integrations/supabase/types';
import { supabase } from '@/integrations/supabase/client';
import { createLensGuardedClient } from '@/lib/impersonation/lens-write-guard';

export type ClienteSupabase = typeof supabase;

export interface CredencialDoDono {
  userId: string;
  accessToken: string;
}

/** `sub` do payload do JWT (sem validar assinatura — quem valida é o servidor). */
export function subDoJwt(token: string): string | null {
  const partes = token.split('.');
  if (partes.length !== 3) return null;
  try {
    const b64 = partes[1].replace(/-/g, '+').replace(/_/g, '/');
    const json = JSON.parse(atob(b64.padEnd(b64.length + ((4 - (b64.length % 4)) % 4), '=')));
    return typeof json?.sub === 'string' && json.sub.length > 0 ? json.sub : null;
  } catch {
    return null;
  }
}

/**
 * Credencial da sessão ATUAL, numa leitura só. `null` (= ninguém, nada é enviado) se não há
 * sessão, se a leitura falha, ou se o `sub` do token não é o `user.id` da mesma sessão.
 */
export async function credencialDaSessao(): Promise<CredencialDoDono | null> {
  try {
    const { data, error } = await supabase.auth.getSession();
    const sessao = data?.session;
    if (error || !sessao?.access_token || !sessao.user?.id) return null;
    if (subDoJwt(sessao.access_token) !== sessao.user.id) return null;
    return { userId: sessao.user.id, accessToken: sessao.access_token };
  } catch {
    return null;
  }
}

/** Cliente que assina TODA requisição com `accessToken` — nunca relê a sessão do aparelho. */
export function criarClienteDoDono(accessToken: string): ClienteSupabase {
  const cru = createClient<Database>(
    import.meta.env.VITE_SUPABASE_URL,
    import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY,
    { accessToken: async () => accessToken },
  );
  return createLensGuardedClient(cru) as unknown as ClienteSupabase;
}
