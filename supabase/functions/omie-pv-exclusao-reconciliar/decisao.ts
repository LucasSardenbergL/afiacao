// Régua PURA da reconciliação de PV excluído no Omie (sem I/O; testes em decisao_test.ts).
//
// Incidente: PV 13693 (Oben, 2026-11-21, limpeza manual no PR #4082) e PV 12231 (codigo_pedido
// 12156020937, achado no diagnóstico do mesmo dia): excluídos direto no Omie, seguiam no app como
// pedido 'enviado'/'importado' contando nas vendas, e a reserva de estoque ficava 'ativa' para sempre.
//
// Precisão > recall (money-path §1): só a AUSÊNCIA AFIRMADA do PV consultado vira "ausente".
// Transitório, rate limit, corpo ilegível, fault de outra entidade, código divergente ou qualquer
// coisa que a régua não reconheça = "indeterminado" — nada muda no app.
import { classificarResposta, type RespostaOmie } from "../_shared/omie-cliente.ts";
import { classificarFaultCota } from "../_shared/omie-cota.ts";
import { avaliarPagina, proximoTotalPaginas, varreduraTruncada } from "../_shared/omie-paginacao.ts";

export type Consulta =
  | { tipo: "existe"; codigoPedido: number; numeroPedido: string | null; etapa: string | null; cancelado: string | null }
  | { tipo: "ausente"; fault: string }
  | { tipo: "indeterminado"; detalhe: string };

// Forma INTEGRAL do fault de ausência medida em 2026-11-21 (ConsultarPedido do PV 12231):
//   `ERROR: Pedido não cadastrado para o Código [12156020937] !`
// O PID é extraído DA PRÓPRIA cláusula de ausência e tem de ser o consultado. A régua frouxa (regex de
// "pedido … não cadastrado" + código em qualquer lugar) aceitava `Pedido [X] - cliente não cadastrado`
// (Codex, desenho 2026-11-21, P0-2): qualquer texto fora desta forma é indeterminado.
const FAULT_PEDIDO_AUSENTE = /^\s*(?:ERROR:\s*)?Pedido n[aã]o cadastrado para o C[oó]digo \[(\d+)\]\s*!?\s*$/i;

function codigoDoCabecalho(corpo: Record<string, unknown> | null): { cab: Record<string, unknown> | null; info: Record<string, unknown> | null } {
  const pvp = corpo?.pedido_venda_produto as Record<string, unknown> | undefined;
  const cab = (pvp?.cabecalho ?? corpo?.cabecalho) as Record<string, unknown> | undefined;
  const info = (pvp?.infoCadastro ?? corpo?.infoCadastro) as Record<string, unknown> | undefined;
  return { cab: cab && typeof cab === "object" ? cab : null, info: info && typeof info === "object" ? info : null };
}

/** Resposta de `ConsultarPedido({ codigo_pedido })` devolvida por `chamarOmie` (leitura). */
export function classificarConsulta(r: RespostaOmie, codigoPedido: number): Consulta {
  if (!Number.isSafeInteger(codigoPedido) || codigoPedido <= 0) {
    return { tipo: "indeterminado", detalhe: `código consultado inválido (${codigoPedido})` };
  }
  // `chamarOmie` devolve a ÚLTIMA resposta quando a retentativa de leitura esgota: ela pode ser
  // transitória/rate limit. Só a resposta FINAL é lida como fato.
  const classe = classificarResposta(r);
  if (classe !== "final") return { tipo: "indeterminado", detalhe: `resposta ${classe} (HTTP ${r.status})` };

  // 425 (bloqueio por consumo indevido) e 429 NUNCA são ausência, qualquer que seja o corpo (P0-2).
  if (r.status === 425 || r.status === 429) return { tipo: "indeterminado", detalhe: `HTTP ${r.status}` };
  if (r.faultstring !== null) {
    const f = r.faultstring;
    const m = FAULT_PEDIDO_AUSENTE.exec(f);
    if (m && Number(m[1]) === codigoPedido) return { tipo: "ausente", fault: f.slice(0, 300) };
    return { tipo: "indeterminado", detalhe: `fault não reconhecido: ${f.slice(0, 200)}` };
  }
  if (!r.ok) return { tipo: "indeterminado", detalhe: `HTTP ${r.status} sem faultstring` };

  const { cab, info } = codigoDoCabecalho(r.corpo);
  const cod = cab?.codigo_pedido;
  if (typeof cod === "number" && cod === codigoPedido) {
    const num = cab?.numero_pedido;
    const etapa = cab?.etapa;
    const canc = info?.cancelado;
    return {
      tipo: "existe",
      codigoPedido: cod,
      numeroPedido: typeof num === "string" || typeof num === "number" ? String(num) : null,
      etapa: typeof etapa === "string" ? etapa : null,
      cancelado: typeof canc === "string" ? canc : null,
    };
  }
  return { tipo: "indeterminado", detalhe: `resposta sem o codigo_pedido consultado (${JSON.stringify(cod ?? null)})` };
}

/** Exceção de `chamarOmie` (rede, timeout, sem tempo): nunca é ausência. */
export function classificarErro(detalhe: string): Consulta {
  return { tipo: "indeterminado", detalhe: detalhe.slice(0, 300) };
}

/** Fault de cota/bloqueio do Omie (425 "consumo indevido", REDUNDANT, concorrência): a conta PARA. */
export function faultDeCota(r: RespostaOmie): string | null {
  if (r.faultstring && classificarFaultCota(r.faultstring)) return r.faultstring;
  if (r.status === 425 || r.status === 429) return r.faultstring ?? `HTTP ${r.status}`;
  return null;
}

// ── Triagem por janela de inclusão (ListarPedidos sem erro) ─────────────────────────────────────
// `filtrar_apenas_inclusao: "S"` + datas devolve EXATAMENTE os PVs com dInc na janela (medido
// 2026-11-21: 88 = 88 da listagem completa). O conjunto só serve se a janela foi lida INTEIRA: página
// vazia antes do fim declarado, total declarado acima do lido ou resposta não-final ⇒ incompleta, e a
// triagem não marca suspeito nenhum (o ausente seria "não li", não "não existe" — money-path §8).
export type Janela =
  | { completa: true; pids: number[]; paginas: number }
  | { completa: false; motivo: string; paginas: number };

export type BuscarPagina = (pagina: number) => Promise<RespostaOmie>;

export async function coletarJanela(buscar: BuscarPagina, maxPaginas = 50): Promise<Janela> {
  const pids: number[] = [];
  let total = 1;
  let declarado: number | undefined;
  for (let pagina = 1; pagina <= maxPaginas; pagina++) {
    const r = await buscar(pagina);
    if (r.faultstring && /n[aã]o existem registros/i.test(r.faultstring)) {
      // EOF do contrato. Na página 1 = janela vazia (0 pedidos); depois = fim, se não faltou página.
      if (pagina < total) return { completa: false, motivo: `EOF na página ${pagina} de ${total}`, paginas: pagina };
      break;
    }
    if (classificarResposta(r) !== "final" || !r.ok || r.corpo === null) {
      return { completa: false, motivo: `página ${pagina}: resposta não-final (HTTP ${r.status}${r.faultstring ? ` · ${r.faultstring.slice(0, 120)}` : ""})`, paginas: pagina };
    }
    const lista = r.corpo.pedido_venda_produto;
    if (!Array.isArray(lista)) return { completa: false, motivo: `página ${pagina}: sem pedido_venda_produto`, paginas: pagina };
    try {
      total = proximoTotalPaginas(total, Number(r.corpo.total_de_paginas ?? NaN) || undefined, maxPaginas);
    } catch (e) {
      return { completa: false, motivo: String((e as Error).message).slice(0, 160), paginas: pagina };
    }
    const d = Number(r.corpo.total_de_registros);
    if (Number.isSafeInteger(d) && d >= 0) declarado = Math.max(declarado ?? 0, d);
    const veredito = avaliarPagina(lista.length, pagina, total);
    if (veredito === "anomalia") return { completa: false, motivo: `página ${pagina} vazia antes do fim declarado (${total})`, paginas: pagina };
    if (veredito === "fim") break;
    for (const p of lista) {
      const cod = (p as { cabecalho?: { codigo_pedido?: unknown } })?.cabecalho?.codigo_pedido;
      if (typeof cod !== "number" || !Number.isSafeInteger(cod) || cod <= 0) {
        return { completa: false, motivo: `página ${pagina}: item sem codigo_pedido válido`, paginas: pagina };
      }
      pids.push(cod);
    }
    if (pagina === maxPaginas) return { completa: false, motivo: `teto de ${maxPaginas} páginas`, paginas: pagina };
  }
  const unicos = [...new Set(pids)];
  if (varreduraTruncada(unicos.length, declarado)) {
    return { completa: false, motivo: `lidos ${unicos.length} < declarados ${declarado}`, paginas: total };
  }
  return { completa: true, pids: unicos, paginas: total };
}
