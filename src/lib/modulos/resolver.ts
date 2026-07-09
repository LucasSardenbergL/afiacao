// Resolver de ownership do manifesto de módulos: quem é o dono de cada arquivo,
// e validação anti-apodrecimento (órfãos, sobreposições, globs mortos, lista stale).
import { casaPadrao } from "./padrao";
import type { ModuloApp, NaoClassificado, ProblemaManifesto } from "./tipos";

export function donoDoArquivo(caminho: string, modulos: ModuloApp[]): string[] {
  return modulos
    .filter((m) => [...m.codigo, ...m.testes].some((p) => casaPadrao(p, caminho)))
    .map((m) => m.id);
}

export function validarManifesto(
  arquivos: string[],
  modulos: ModuloApp[],
  naoClassificados: NaoClassificado[],
): ProblemaManifesto[] {
  const problemas: ProblemaManifesto[] = [];
  const ncPaths = new Set(naoClassificados.map((n) => n.path));
  const arquivosSet = new Set(arquivos);

  for (const arq of arquivos) {
    const donos = donoDoArquivo(arq, modulos);
    if (donos.length === 0 && !ncPaths.has(arq)) problemas.push({ tipo: "orfao", detalhe: arq });
    if (donos.length >= 2)
      problemas.push({ tipo: "sobreposicao", detalhe: `${arq} → ${donos.join(", ")}` });
  }

  for (const m of modulos) {
    for (const padrao of [...m.codigo, ...m.testes]) {
      if (!arquivos.some((a) => casaPadrao(padrao, a)))
        problemas.push({ tipo: "glob-morto", detalhe: `${m.id}: ${padrao}` });
    }
  }

  for (const nc of naoClassificados) {
    if (!arquivosSet.has(nc.path)) {
      problemas.push({ tipo: "nao-classificado-inexistente", detalhe: nc.path });
    } else {
      const donos = donoDoArquivo(nc.path, modulos);
      if (donos.length > 0)
        problemas.push({ tipo: "nao-classificado-com-dono", detalhe: `${nc.path} → ${donos.join(", ")}` });
    }
  }

  return problemas;
}
