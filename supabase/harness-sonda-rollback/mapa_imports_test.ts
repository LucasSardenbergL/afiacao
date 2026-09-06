import { extrairRemotos, gerarImportMap } from "./mapa-imports.ts";

function eq(a: unknown, b: unknown, m: string) {
  if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${m}: ${JSON.stringify(a)} ≠ ${JSON.stringify(b)}`);
}

Deno.test("mapa-imports: as 5 famílias medidas casam em qualquer versão; o desconhecido é NOMEADO (fail-closed)", () => {
  const fonte = [
    'import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";',
    'import { serve } from "https://deno.land/std@0.190.0/http/server.ts";',
    'import { Resend } from "npm:resend@2.0.0";',
    'import Anthropic from "npm:@anthropic-ai/sdk@^0.93.0";',
    'import webpush from "npm:web-push@3.6.7";',
    'import x from "npm:desconhecido@1";',
    'import { y } from "./local.ts";',
  ].join("\n");
  const r = gerarImportMap(extrairRemotos(fonte), "file:///s");
  eq(Object.keys(r.imports).length, 5, "5 mapeados");
  eq(r.imports["npm:resend@2.0.0"], "file:///s/resend.ts", "resend");
  eq(r.imports["https://esm.sh/@supabase/supabase-js@2.49.1"], "file:///s/supabase.ts", "supabase por esm.sh");
  eq(r.imports["https://deno.land/std@0.190.0/http/server.ts"], "file:///s/std-serve.ts", "std serve");
  eq(r.desconhecidos, ["npm:desconhecido@1"], "desconhecido nomeado, sem stub genérico");
});

Deno.test("mapa-imports: as 8 variantes de supabase-js e as 4 de resend medidas na história casam todas", () => {
  const variantes = [
    "npm:@supabase/supabase-js@2", "npm:@supabase/supabase-js@^2", "npm:@supabase/supabase-js@2.45.0",
    "https://esm.sh/@supabase/supabase-js@2", "https://esm.sh/@supabase/supabase-js@2.45.0",
    "https://esm.sh/@supabase/supabase-js@2.39.0", "https://esm.sh/@supabase/supabase-js@2.49.1",
    "npm:resend@2.0.0", "npm:resend@2", "npm:resend@4.0.1", "npm:resend@6.12.2", "https://esm.sh/resend@2.0.0",
    "https://deno.land/std@0.168.0/http/server.ts", "https://deno.land/std@0.190.0/http/server.ts",
    "npm:@anthropic-ai/sdk@^0.93.0", "npm:web-push@3.6.7",
  ];
  const r = gerarImportMap(variantes, "file:///s");
  eq(r.desconhecidos, [], "nenhuma variante medida pode ficar sem stub");
  eq(Object.keys(r.imports).length, variantes.length, "todas mapeadas");
});
