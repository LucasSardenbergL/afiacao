// Gate do marcador `// EDGE-APOSENTADA:` — a metade (1) do contrato que o /fecho consome.
//
// O `edges-pendentes.sh` (Passo 3 do /fecho) classifica como INERTE toda edge cujo `index.ts` na
// REF carrega o marcador, e INERTE SUPRIME o chip de deploy. É um marcador DECLARADO — não se
// infere por `status: 410` no texto, porque `omie-analytics-sync` tem uma FUNÇÃO aposentada e a
// edge viva. O preço da declaração é poder mentir: um marcador numa edge VIVA esconderia um deploy
// real para sempre, e o script não tem como perceber. Este gate fecha essa metade: marcador ⇒ o
// handler responde `status: 410` no MESMO arquivo. A outra metade (a aposentadoria JÁ estar no ar)
// é responsabilidade de quem coloca o marcador — está escrita no contrato dele.
//
// Teste TEXTUAL (readTextFileSync): importar um `index.ts` subiria o `Deno.serve`.
const RAIZ = "supabase/functions";
const MARCADOR = "// EDGE-APOSENTADA:";

function edgesComMarcador(): string[] {
  const achadas: string[] = [];
  for (const d of Deno.readDirSync(RAIZ)) {
    if (!d.isDirectory || d.name.startsWith("_")) continue;
    let src: string;
    try {
      src = Deno.readTextFileSync(`${RAIZ}/${d.name}/index.ts`);
    } catch {
      continue; // pasta sem index.ts não é edge deployável
    }
    if (src.includes(MARCADOR)) achadas.push(d.name);
  }
  return achadas.sort();
}

Deno.test("EDGE-APOSENTADA: toda edge marcada responde status 410 no mesmo index.ts", () => {
  for (const slug of edgesComMarcador()) {
    const src = Deno.readTextFileSync(`${RAIZ}/${slug}/index.ts`);
    if (!src.includes("status: 410")) {
      throw new Error(
        `${slug}: carrega '${MARCADOR}' e NÃO responde 'status: 410' — marcador numa edge VIVA ` +
          `faria o /fecho suprimir um deploy real (INERTE mentiroso). Tire o marcador ou aposente a edge.`,
      );
    }
  }
});

Deno.test("EDGE-APOSENTADA: o conjunto marcado é o esperado (mudança aqui é decisão, não acidente)", () => {
  // Lista FECHADA de propósito: aposentar uma edge é decisão money-path/produto, e o marcador é o
  // que faz o /fecho parar de pedir deploy dela. Quem adicionar um, adiciona aqui — no diff.
  const esperado = ["tint-import"];
  const achadas = edgesComMarcador();
  if (JSON.stringify(achadas) !== JSON.stringify(esperado)) {
    throw new Error(
      `edges com '${MARCADOR}': ${JSON.stringify(achadas)} ≠ esperado ${JSON.stringify(esperado)}`,
    );
  }
});
