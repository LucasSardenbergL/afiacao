// Varredura do ListarOS (injetável: listar, gravar, relógio) — testes em varredura_test.ts.
//
// A varredura só é ÍNTEGRA (serve para marcar sumiço) quando TUDO abaixo vale (Codex P1, 2026-11-26):
//   · terminou numa página VAZIA ou num fim-de-paginação do Omie, e esse fim veio DEPOIS do piso
//     monotônico de `total_de_paginas` (fim no meio do declarado = anomalia → aborta, nunca "fim");
//   · nenhuma página repetida (`fingerprintPagina` dos nCodOS: o Omie devolvendo a mesma página de novo
//     faria o laço "terminar" com metade das OS);
//   · `total_de_registros` DECLARADO e lidas = distintas = declarado (ausente ou divergente → não íntegra);
//     nCodOS repetido entre páginas (paginação instável) aborta;
//   · nenhuma OS sem identidade (shape_err).
// Malformada ≠ fim: resposta sem `osCadastro` lança. Teto de páginas ou de relógio sem ver o fim lança.
import { fingerprintPagina } from "../_shared/omie-paginacao.ts";
import { extrairLista, type OSLinha, parseOS, totalDeclarado } from "./os-parse.ts";

export const REG_POR_PAGINA = 50;
export const MAX_PAGINAS = 200; // 10k OS ≫ as ~300 OS da vida da Colacor SC; pega total lixo, não dimensiona

/** `null` = o Omie sinalizou FIM de paginação (faultstring de "não existem registros"). */
export type Listar = (pagina: number) => Promise<Record<string, unknown> | null>;
export type Gravar = (linhas: OSLinha[]) => Promise<void>;

export interface Resumo {
  integra: boolean;
  motivo_nao_integra: string | null;
  paginas: number;
  lidas: number;
  distintas: number;
  shape_err: number;
  amostra_shape_err: string | null;
  total_registros_declarado: number | null;
  total_paginas_declarado: number | null;
  valor_ilegivel: number;
  prazo_ilegivel: number;
  cliente_ilegivel: number;
  datas_ilegiveis: number;
  status_ilegivel: number;
}

export class VarreduraAbortada extends Error {
  constructor(mensagem: string, public parcial: Omit<Resumo, "integra" | "motivo_nao_integra">) {
    super(mensagem);
  }
}

export async function varrer(listar: Listar, gravar: Gravar, opts: { deadline: number; agora?: () => number }): Promise<Resumo> {
  const agora = opts.agora ?? Date.now;
  const vistas = new Set<number>();
  const fingerprints = new Set<string>();
  let pisoPaginas = 0;           // 0 = nada declarado ainda
  let pisoRegistros: number | null = null;
  let fimVisto = false;
  const r = {
    paginas: 0, lidas: 0, distintas: 0, shape_err: 0, amostra_shape_err: null as string | null,
    total_registros_declarado: null as number | null, total_paginas_declarado: null as number | null,
    valor_ilegivel: 0, prazo_ilegivel: 0, cliente_ilegivel: 0, datas_ilegiveis: 0, status_ilegivel: 0,
  };
  const abortar = (msg: string): never => {
    r.distintas = vistas.size;
    throw new VarreduraAbortada(msg, { ...r });
  };

  for (let pagina = 1; pagina <= MAX_PAGINAS; pagina++) {
    if (agora() > opts.deadline) abortar(`relógio esgotado na página ${pagina} sem ver o fim`);
    const resp = await listar(pagina);
    if (resp === null) {
      // fim-de-paginação do Omie: só vale DEPOIS do piso declarado (Codex P1 — no meio, autorizaria o sumiço do resto)
      if (pagina <= pisoPaginas) abortar(`fim-de-paginação na página ${pagina} antes do total declarado (${pisoPaginas})`);
      fimVisto = true;
      break;
    }
    const tp = totalDeclarado(resp, "total_de_paginas");
    if (tp !== undefined) {
      if (tp > MAX_PAGINAS) abortar(`total_de_paginas=${tp} acima do teto anti-runaway (${MAX_PAGINAS})`);
      pisoPaginas = Math.max(pisoPaginas, tp);
      r.total_paginas_declarado = pisoPaginas;
    }
    const tr = totalDeclarado(resp, "total_de_registros");
    if (tr !== undefined) {
      pisoRegistros = Math.max(pisoRegistros ?? 0, tr);
      r.total_registros_declarado = pisoRegistros;
    }
    const lista = extrairLista(resp);
    if (lista === null) abortar(`página ${pagina}: resposta sem osCadastro (malformada ≠ fim)`);
    if (lista!.length === 0) {
      if (pagina <= pisoPaginas) abortar(`página ${pagina}/${pisoPaginas} veio vazia antes do fim declarado`);
      fimVisto = true;
      break;
    }

    const linhas = new Map<number, OSLinha>();
    const codigos: (number | null)[] = [];
    for (const item of lista!) {
      const p = parseOS(item);
      r.lidas++;
      if (!p.ok) {
        r.shape_err++;
        r.amostra_shape_err ??= p.motivo.slice(0, 200);
        codigos.push(null);
        continue;
      }
      const l = p.linha;
      codigos.push(l.n_cod_os);
      if (l.valor_total === null) r.valor_ilegivel++;
      if (l.prazo_max_dias === null) r.prazo_ilegivel++;
      if (l.n_cod_cli === null) r.cliente_ilegivel++;
      if (l.data_inclusao === null) r.datas_ilegiveis++;
      if (l.faturada === null || l.cancelada === null) r.status_ilegivel++;
      // ID já visto (nesta ou noutra página) = paginação instável (OS nova empurrando a ordem): com
      // páginas sobrepostas o total ainda poderia "fechar" (Codex desenho P1-2) → aborta, nunca íntegra
      if (vistas.has(l.n_cod_os)) abortar(`nCodOS ${l.n_cod_os} repetido na página ${pagina} (paginação instável)`);
      vistas.add(l.n_cod_os);
      linhas.set(l.n_cod_os, l);
    }
    const fp = fingerprintPagina(codigos);
    if (fingerprints.has(fp)) abortar(`página ${pagina} repetida (mesmos nCodOS de uma página anterior)`);
    fingerprints.add(fp);
    r.paginas++;
    if (linhas.size > 0) await gravar([...linhas.values()]);
  }
  if (!fimVisto) abortar(`ListarOS esgotou ${MAX_PAGINAS} páginas sem ver o fim`);

  r.distintas = vistas.size;
  let motivo: string | null = null;
  if (r.shape_err > 0) motivo = `${r.shape_err} OS sem identidade legível`;
  else if (pisoRegistros === null) motivo = "total_de_registros não declarado";
  else if (r.lidas !== r.distintas) motivo = `${r.lidas} lidas ≠ ${r.distintas} distintas`;
  else if (pisoRegistros !== r.distintas) motivo = `total_de_registros=${pisoRegistros} ≠ ${r.distintas} OS distintas lidas`;
  else if (pisoPaginas === 0 && r.distintas > 0) motivo = "total_de_paginas não declarado";
  return { integra: motivo === null, motivo_nao_integra: motivo, ...r };
}
