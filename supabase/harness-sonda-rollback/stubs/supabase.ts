// Stub de `@supabase/supabase-js` (npm: e esm.sh, todas as versões da história).
import { proxy } from "./contador.ts";
export function createClient(..._a: unknown[]): unknown {
  return proxy("client");
}
export default { createClient };
