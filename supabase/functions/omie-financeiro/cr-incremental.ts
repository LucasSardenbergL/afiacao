// Decisor de MODO e JANELA do sync de contas a receber (plano v4, lote 15 — B3). Puro, sem IO: o
// teste roda o código real em Deno (cr-incremental_test.ts). Desenho e evidência medida:
// docs/superpowers/specs/2026-11-01-fin-cr-incremental-design.md.
//
// O que o Omie garante (medido na oben, 2026-11-01): `filtrar_apenas_alteracao=S` filtra por `info.dAlt`
// em granularidade de DIA (limites inclusivos), e baixa, estorno, cancelamento e inclusão carimbam o
// `dAlt` no momento do registro. NÃO garante: exclusão (some de toda listagem) e o status relativo ao dia
// (`A VENCER` → `ATRASADO` sem alteração) — por isso o incremental relista o conjunto ABERTO inteiro.
import { diaSP, paraDataOmie, somarDias } from "../_shared/hoje-sp.ts";

/** Full (rede de segurança) no máximo a cada 7 dias — ver §3.3 do desenho. */
export const FULL_MAX_DIAS = 7;
/** A marca d'água volta 1 dia: cobre a granularidade de dia e alteração durante o próprio run. */
const SOBREPOSICAO_DIAS = 1;

// Marcadores em `sync_state` (entity_type × account=empresa), cada um com UM writer nesta edge.
/** last_sync_at = início do full em andamento (gravado na página 1). */
export const MARCADOR_FULL_INICIO = "fin_cr_full_inicio";
/** last_sync_at = início do último full que chegou ao FIM REAL (copiado do de cima no fim). */
export const MARCADOR_FULL_OK = "fin_cr_full_ok";
/** last_sync_at = início (t0) do último incremental íntegro (A + B + reconciliação). */
export const MARCADOR_INCREMENTAL_OK = "fin_cr_incremental_ok";

export type EstadoCR = {
  /** Início do último full completo; null = nunca houve. */
  fullOkEm: Date | null;
  /** t0 do último incremental íntegro; null = nunca houve. */
  incrementalOkEm: Date | null;
};

export type ModoCR =
  | { modo: "continuar_full" }
  | { modo: "full"; motivo: "estado_ilegivel" | "sem_full" | "full_vencido" }
  | { modo: "incremental"; de: string; ate: string; marca: string };

const DIA_MS = 86_400_000;

/**
 * Decide o modo do run de UMA empresa. `estado` null = não deu para ler o `sync_state` (tabela, rede,
 * migration não aplicada): cai no full, que é o comportamento anterior a este lote — falhar FECHADO aqui
 * é nunca pular a listagem completa por falta de marca.
 */
export function decidirModoCR(input: { cursorPendente: boolean; estado: EstadoCR | null; agora: Date }): ModoCR {
  const { cursorPendente, estado, agora } = input;
  if (cursorPendente) return { modo: "continuar_full" };
  if (!estado) return { modo: "full", motivo: "estado_ilegivel" };
  if (!estado.fullOkEm) return { modo: "full", motivo: "sem_full" };
  if (agora.getTime() - estado.fullOkEm.getTime() > FULL_MAX_DIAS * DIA_MS) {
    return { modo: "full", motivo: "full_vencido" };
  }
  // A marca é o t0 do último incremental íntegro; o início do full só serve no bootstrap (nenhum
  // incremental ainda). NÃO é o máximo dos dois: a continuação de um full reinicia o piso de páginas e
  // pode fechar `complete` truncado (Codex, código, P1) — deixar o full avançar a marca pularia alterações
  // de título fechado em páginas não visitadas. Janela mais larga é sempre segura.
  const marcaEm = estado.incrementalOkEm ?? estado.fullOkEm;
  return { modo: "incremental", ...janelaAlteracao(marcaEm, agora) };
}

/**
 * Janela de `filtrar_por_data_de/ate` (formato do Omie) para os títulos alterados desde a marca. Datas no
 * fuso de São Paulo, que é o do `dAlt` do Omie (conferido: alterações das 18–20 h BRT caem no próprio dia).
 */
export function janelaAlteracao(marcaEm: Date, agora: Date): { de: string; ate: string; marca: string } {
  const marca = diaSP(marcaEm);
  const hoje = diaSP(agora);
  if (marca > hoje) throw new RangeError(`janelaAlteracao: marca no futuro (${marca} > ${hoje})`);
  return { de: paraDataOmie(somarDias(marca, -SOBREPOSICAO_DIAS)), ate: paraDataOmie(hoje), marca };
}

/**
 * Veredito do fim de uma listagem ESTRITA (A, B e a reconfirmação): null = íntegra; texto = motivo para
 * LANÇAR. A contagem declarada é lida da 1ª página ANTES do veredito de página vazia — vazia com contagem
 * > 0 é truncamento, não fim (Codex, código, P1) — e precisa existir: sem ela não há como afirmar o todo.
 */
export function falhaVarreduraEstrita(input: { reachedEnd: boolean; lidos: number; declarados: unknown }): string | null {
  if (!input.reachedEnd) return "sem_fim_real";
  const declarados = inteiroNaoNegativo(input.declarados);
  if (declarados === null) return "contagem_ausente";
  if (input.lidos < declarados) return "truncada";
  return null;
}

// ── Prova de exclusão (C2) ──────────────────────────────────────────────────────────────────────
// Ausência no conjunto aberto NÃO prova exclusão: a listagem paginada desliza (Codex, desenho, P0). A
// prova é UMA resposta do Omie — leitura consistente, sem página para deslizar — listando o cliente do
// candidato na janela de emissão dele, com a contagem que a própria resposta declara. Medido na oben em
// 2026-11-02: os 2 controles reais vieram (1 página, cliente e emissão respeitados); o fantasma voltou
// vazio com `total_de_registros: 0`, sem fault; outro voltou com 3 títulos do cliente e sem ele.

/** Teto de listagens-prova por run e empresa: o backlog inicial (oben, 29) drena em ~3 runs. */
const MAX_PROVAS_POR_RUN = 10;
/** Janela de emissão da prova: ±1 dia em volta da emissão gravada. */
const FOLGA_EMISSAO_DIAS = 1;
/** registros_por_pagina da prova; resposta com isso ou mais itens não cabe numa página só. */
export const PAGINA_PROVA = 100;

export type TituloProva = { codigo_lancamento_omie?: unknown; codigo_cliente_fornecedor?: unknown };

export type VeredictoProva =
  | { tipo: "presente" }
  | { tipo: "ausente_provado"; evidencia: Record<string, unknown> }
  | { tipo: "inconclusivo"; motivo: string };

/** Janela de emissão (formato do Omie) da listagem-prova. Emissão ausente/malformada LANÇA. */
export function janelaEmissao(emissao: string): { de: string; ate: string } {
  return {
    de: paraDataOmie(somarDias(emissao, -FOLGA_EMISSAO_DIAS)),
    ate: paraDataOmie(somarDias(emissao, FOLGA_EMISSAO_DIAS)),
  };
}

/**
 * Lê UMA resposta da listagem-prova. Só devolve `ausente_provado` quando a resposta se afirma completa
 * (1 página, contagem declarada = itens recebidos, abaixo do tamanho da página), todo item tem código e
 * é do cliente pedido — qualquer coisa fora disso é `inconclusivo` (o candidato fica para outro run;
 * nunca apaga por falta de dado).
 */
/** Inteiro ≥ 0 de verdade (número ou string só de dígitos); qualquer outra coisa é null — `Number("")` é 0 fabricado. */
function inteiroNaoNegativo(v: unknown): number | null {
  if (typeof v === "number") return Number.isSafeInteger(v) && v >= 0 ? v : null;
  if (typeof v === "string" && /^[0-9]+$/.test(v)) {
    const n = Number(v);
    return Number.isSafeInteger(n) ? n : null;
  }
  return null;
}

export function avaliarProvaCliente(input: {
  codigo: number;
  cliente: number;
  janela: { de: string; ate: string };
  totalDePaginas: unknown;
  totalDeRegistros: unknown;
  titulos: TituloProva[];
}): VeredictoProva {
  const { codigo, cliente, janela, totalDePaginas, totalDeRegistros, titulos } = input;
  const codigos: number[] = [];
  for (const t of titulos) {
    const c = Number(t.codigo_lancamento_omie);
    if (!Number.isSafeInteger(c) || c <= 0) return { tipo: "inconclusivo", motivo: "titulo_sem_codigo" };
    codigos.push(c);
  }
  if (codigos.includes(codigo)) return { tipo: "presente" };
  if (titulos.some((t) => Number(t.codigo_cliente_fornecedor) !== cliente)) {
    return { tipo: "inconclusivo", motivo: "filtro_cliente_ignorado" };
  }
  const declarado = inteiroNaoNegativo(totalDeRegistros);
  const paginas = inteiroNaoNegativo(totalDePaginas);
  if (declarado === null || paginas === null) return { tipo: "inconclusivo", motivo: "contagem_ausente" };
  // Vazio medido no Omie: páginas 0 e registros 0. Com itens, exatamente 1 página.
  const paginasCoerentes = titulos.length === 0 ? paginas <= 1 : paginas === 1;
  if (!paginasCoerentes || declarado !== titulos.length || titulos.length >= PAGINA_PROVA) {
    return { tipo: "inconclusivo", motivo: "multipagina_ou_contagem_divergente" };
  }
  return {
    tipo: "ausente_provado",
    evidencia: {
      cliente,
      emissao_de: janela.de,
      emissao_ate: janela.ate,
      total_de_registros: declarado,
      codigos_vistos: codigos,
    },
  };
}

// ── Orquestração do run incremental (A → B → C1 → C2 → C2b → C3 → marca) ─────────────────────────────
// Aqui, e não no index.ts, para o FLUXO ser testado com dependências falsas: falha em qualquer etapa
// LANÇA e a marca d'água (última etapa) não é gravada. O index.ts só liga as dependências reais.

type RespostaRpc = { data: unknown; error: { code?: string; message?: string } | null };
export type RespostaProva = { totalDePaginas: unknown; totalDeRegistros: unknown; titulos: TituloProva[] };
type CandidatoCR = { codigo: number; cliente: number | null; emissao: string | null };

export type DepsIncrementalCR = {
  /** Lista até o FIM REAL com os guards do full em modo estrito (lança se incompleto); acrescenta os códigos gravados. */
  listarEstrito(filtros: Record<string, string>, codigos: Set<number>): Promise<{ paginas: number; totalSynced: number }>;
  marcarAusentes(vistos: number[]): Promise<RespostaRpc>;
  /** UMA chamada ao Omie (página 1) da listagem-prova; lança em falha de transporte/forma. */
  listarProva(cliente: number, janela: { de: string; ate: string }): Promise<RespostaProva>;
  excluirConfirmados(confirmados: Array<{ codigo: number; evidencia: Record<string, unknown> }>): Promise<RespostaRpc>;
  gravarMarca(): Promise<void>;
  orcamentoEsgotado(): boolean;
  agoraIso(): string;
  /** Ordem das provas no run; default aleatória (teste injeta uma determinística). */
  embaralhar?<T>(xs: T[]): T[];
};

/** Fisher–Yates: sem ordem fixa, inconclusivos perenes não monopolizam o teto de provas (Codex, P2). */
export function embaralhar<T>(xs: T[]): T[] {
  const r = [...xs];
  for (let i = r.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [r[i], r[j]] = [r[j], r[i]];
  }
  return r;
}

/** O `data` de uma RPC como objeto, ou null — o `error` já foi checado antes; forma errada não vira campo. */
function registro(v: unknown): Record<string, unknown> | null {
  return v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

/**
 * A migration 20261102020000 ainda não aplicada: a RPC não existe. ÚNICO erro que não lança. `42883` sozinho
 * não basta — é também função/operador faltando DENTRO da RPC (Codex, P1): só conta se nomear a própria RPC.
 */
export function rpcAusente(error: { code?: string; message?: string } | null, rpc: string): boolean {
  if (error?.code === "PGRST202") return true;
  return error?.code === "42883" && (error.message ?? "").includes(rpc);
}

export async function executarIncrementalCR(
  janela: { de: string; ate: string; marca: string },
  deps: DepsIncrementalCR,
) {
  const codigos = new Set<number>();
  const a = await deps.listarEstrito({ filtrar_apenas_titulos_em_aberto: "S" }, codigos);
  const abertos = codigos.size;
  const b = await deps.listarEstrito(
    { filtrar_por_data_de: janela.de, filtrar_por_data_ate: janela.ate, filtrar_apenas_alteracao: "S" },
    codigos,
  );
  const base = {
    janela,
    paginas_abertos: a.paginas,
    paginas_alterados: b.paginas,
    abertos,
    vistos: codigos.size,
    totalSynced: a.totalSynced + b.totalSynced,
  };

  const marc = await deps.marcarAusentes([...codigos]);
  if (marc.error) {
    if (!rpcAusente(marc.error, "fin_cr_marcar_ausentes")) throw new Error(`CR marcar_ausentes: ${marc.error.message ?? marc.error.code}`);
    // Sem a migration: A+B estão íntegros (a marca pode avançar), só não há reconciliação.
    await deps.gravarMarca();
    return { ...base, reconciliacao: "indisponivel" as const };
  }
  const m = registro(marc.data);
  if (!m || !Array.isArray(m.candidatos)) throw new Error("CR marcar_ausentes: retorno sem lista de candidatos");
  const candidatos = (deps.embaralhar ?? embaralhar)(m.candidatos as CandidatoCR[]);

  // C2 — uma listagem por (cliente, janela de emissão): parcelas da mesma NF dividem a prova.
  const provas = new Map<string, { resposta: RespostaProva; janela: { de: string; ate: string } }>();
  const confirmados: Array<{ codigo: number; evidencia: Record<string, unknown> }> = [];
  let presentes = 0;
  let inconclusivos = 0;
  let adiados = 0;
  for (const c of candidatos) {
    if (c.cliente == null || !c.emissao) {
      inconclusivos++;
      continue;
    }
    const jan = janelaEmissao(c.emissao);
    const chave = `${c.cliente}|${jan.de}|${jan.ate}`;
    let prova = provas.get(chave);
    if (!prova) {
      if (provas.size >= MAX_PROVAS_POR_RUN || deps.orcamentoEsgotado()) {
        adiados++;
        continue;
      }
      prova = { resposta: await deps.listarProva(c.cliente, jan), janela: jan };
      provas.set(chave, prova);
    }
    const v = avaliarProvaCliente({
      codigo: c.codigo,
      cliente: c.cliente,
      janela: prova.janela,
      totalDePaginas: prova.resposta.totalDePaginas,
      totalDeRegistros: prova.resposta.totalDeRegistros,
      titulos: prova.resposta.titulos,
    });
    if (v.tipo === "presente") presentes++;
    else if (v.tipo === "inconclusivo") inconclusivos++;
    else confirmados.push({ codigo: c.codigo, evidencia: { ...v.evidencia, consultado_em: deps.agoraIso() } });
  }

  // C2b — o Omie muda cliente/emissão sem o espelho saber; se isso cair entre B e a prova, a prova lê a
  // chave velha e volta vazia (Codex, código, P0). Relista os alterados de [último dia de B, hoje] logo
  // antes do C3: código visto sai dos confirmados, e o upsert carimba updated_at > t0, que a guarda do C3
  // também barra (defesa dupla).
  let reobservados = 0;
  let paginasReconfirmacao = 0;
  if (confirmados.length > 0) {
    const vistosAgora = new Set<number>();
    const r = await deps.listarEstrito(
      {
        filtrar_por_data_de: janela.ate,
        filtrar_por_data_ate: paraDataOmie(diaSP(new Date(deps.agoraIso()))),
        filtrar_apenas_alteracao: "S",
      },
      vistosAgora,
    );
    paginasReconfirmacao = r.paginas;
    for (let i = confirmados.length - 1; i >= 0; i--) {
      if (vistosAgora.has(confirmados[i].codigo)) {
        confirmados.splice(i, 1);
        reobservados++;
      }
    }
  }

  let excluidos = 0;
  if (confirmados.length > 0) {
    const exc = await deps.excluirConfirmados(confirmados);
    if (exc.error) throw new Error(`CR excluir_confirmados: ${exc.error.message ?? exc.error.code}`);
    const n = Number(registro(exc.data)?.excluidos);
    if (!Number.isSafeInteger(n)) throw new Error("CR excluir_confirmados: retorno sem contagem");
    excluidos = n;
  }

  await deps.gravarMarca();
  return {
    ...base,
    reconciliacao: "ok" as const,
    marcados: m.marcados,
    limpos: m.limpos,
    candidatos: candidatos.length,
    provas: provas.size,
    presentes,
    inconclusivos,
    adiados,
    reobservados,
    paginas_reconfirmacao: paginasReconfirmacao,
    excluidos,
  };
}
