// Walker da árvore real de src/ — insumo do gate e do boletim.
// Retorna TODOS os arquivos (qualquer extensão), paths POSIX relativos à raiz do repo, ordenados.
import { readdirSync } from "node:fs";
import { join } from "node:path";

export function listarArquivosSrc(raizRepo: string = process.cwd()): string[] {
  const resultado: string[] = [];
  const visita = (rel: string) => {
    for (const e of readdirSync(join(raizRepo, rel), { withFileTypes: true })) {
      const caminho = `${rel}/${e.name}`;
      if (e.isDirectory()) visita(caminho);
      else resultado.push(caminho);
    }
  };
  visita("src");
  return resultado.sort();
}
