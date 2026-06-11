/**
 * Chave PÚBLICA VAPID do Web Push (RFC 8292). Pública por definição — vai no
 * bundle sem risco (identifica o servidor de push; quem manda push precisa da
 * PRIVADA, que vive só como secret da edge `enviar-push` no Supabase).
 * Par gerado em 2026-06-10 (`web-push generate-vapid-keys`). Rotacionar = gerar
 * par novo, trocar aqui + secret, e as vendedoras reativarem no card.
 */
export const VAPID_PUBLIC_KEY =
  'BKN3yET55ssQxXVjmc_5D3ud1znzAIsOJOoYdUsElsFARyhyzQzA9WgVFtvZytJnKpigTvlqZKvoyDdwIdHGQn0';

/** Converte a chave base64url pro Uint8Array que o pushManager.subscribe exige. */
export function vapidKeyToUint8Array(base64url: string): Uint8Array {
  const padding = '='.repeat((4 - (base64url.length % 4)) % 4);
  const base64 = (base64url + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(base64);
  const arr = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) arr[i] = raw.charCodeAt(i);
  return arr;
}
