// Gerador do import map de um closure histórico: casa cada especificador REMOTO com um stub do
// catálogo, por FAMÍLIA e sem depender da versão (a história tem 16 especificadores distintos em 5
// famílias, medidos em 3.226 closures).
//
// Especificador fora do catálogo NÃO recebe stub genérico: ele é devolvido em `desconhecidos`, o
// closure vira `INVERIFICAVEL` e a edge fica FORA da allowlist. Stub genérico seria a forma mais
// barata de fabricar "zero efeito": o que não roda não faz nada.
const REMOTO = /\bfrom\s+['"]((?:npm:|https?:\/\/|jsr:|node:)[^'"]+)['"]|\bimport\s+['"]((?:npm:|https?:\/\/|jsr:|node:)[^'"]+)['"]/g;

export function extrairRemotos(fonte: string): string[] {
  const out = new Set<string>();
  for (const m of fonte.matchAll(REMOTO)) {
    const esp = m[1] ?? m[2];
    if (esp) out.add(esp);
  }
  return [...out].sort();
}

const FAMILIAS: Array<[RegExp, string]> = [
  [/^(?:npm:|https:\/\/esm\.sh\/)@supabase\/supabase-js(?:@|$)/, "supabase.ts"],
  [/^https:\/\/deno\.land\/std@[^/]+\/http\/server\.ts$/, "std-serve.ts"],
  [/^(?:npm:|https:\/\/esm\.sh\/)resend(?:@|$)/, "resend.ts"],
  [/^npm:@anthropic-ai\/sdk(?:@|$)/, "anthropic.ts"],
  [/^npm:web-push(?:@|$)/, "web-push.ts"],
];

export function gerarImportMap(
  especificadores: string[],
  raizStubs: string,
): { imports: Record<string, string>; desconhecidos: string[] } {
  const imports: Record<string, string> = {};
  const desconhecidos: string[] = [];
  const raiz = raizStubs.replace(/\/$/, "");
  for (const e of especificadores) {
    const fam = FAMILIAS.find(([re]) => re.test(e));
    if (fam) imports[e] = `${raiz}/${fam[1]}`;
    else desconhecidos.push(e);
  }
  return { imports, desconhecidos };
}
