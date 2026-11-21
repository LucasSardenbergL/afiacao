// Lógica testável (sem rede) da edge `banco-extrato-importar`: valida o caminho, baixa o arquivo,
// detecta o formato PELO CONTEÚDO, faz o parse e entrega o extrato PARSEADO à RPC
// `banco_extrato_registrar`, que decide tudo. Erro de parse NÃO chama a RPC (422).
// Money-path: ausente ≠ zero (saldo inicial ausente segue null), nunca fabricar número.
import { parseOfx } from "../_shared/extrato-parser-ofx.ts";
import {
  chavesDasLinhas,
  type EstrategiaChave,
  type ExtratoParseado,
} from "../_shared/extrato-nucleo.ts";
import { ESTRATEGIA_CHAVE_PADRAO } from "./versao.ts";

export interface Deps {
  baixar(path: string): Promise<Uint8Array>;
  registrar(p: Record<string, unknown>): Promise<unknown>;
  agora(): Date;
}

export interface Entrada {
  storage_path: string;
  banco_conta_id: string;
  /** `banco_conta.estrategia_chave` (null → `ESTRATEGIA_CHAVE_PADRAO`). */
  estrategia_chave: string | null;
}

export interface Resposta {
  status: number;
  corpo: unknown;
}

const erro = (status: number, mensagem: string): Resposta => ({ status, corpo: { erro: mensagem } });
const erroParse = (motivo: string, detalhe: string): Resposta => ({
  status: 422,
  corpo: { erro_parse: { motivo, detalhe } },
});

/**
 * O caminho tem de ser exatamente `{banco_conta_id}/{arquivo}`: um único segmento depois da pasta
 * da conta (sem `..`, sem subpasta). Devolve a mensagem de erro (400) ou null.
 */
export function validarCaminho(storagePath: unknown, bancoContaId: unknown): string | null {
  if (typeof bancoContaId !== "string" || bancoContaId === "") return "banco_conta_id ausente";
  if (typeof storagePath !== "string" || storagePath === "") return "storage_path ausente";
  const prefixo = `${bancoContaId}/`;
  if (!storagePath.startsWith(prefixo)) return "storage_path fora da pasta da conta";
  const resto = storagePath.slice(prefixo.length);
  if (resto === "" || resto === "." || resto === ".." || resto.includes("/") || resto.includes("\\")) {
    return "storage_path invalido";
  }
  return null;
}

/** Data civil (YYYY-MM-DD) em America/Sao_Paulo — Intl com timeZone, nunca offset fixo. */
export function dataEmSaoPaulo(d: Date): string {
  const partes = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Sao_Paulo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(d);
  const get = (t: string) => partes.find((p) => p.type === t)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const dig = await crypto.subtle.digest("SHA-256", new Uint8Array(bytes));
  return [...new Uint8Array(dig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

type Formato = "ofx" | "cnab240" | "desconhecido";

/** Detecta pelo CONTEÚDO (não pela extensão): OFX por cabeçalho/tag; CNAB por todas as linhas de 240. */
export function detectarFormato(bytes: Uint8Array): Formato {
  if (bytes.length === 0) return "desconhecido";
  const texto = new TextDecoder("latin1").decode(bytes); // 1 byte = 1 coluna
  const semBom = texto.replace(/^﻿|^ï»¿/, "");
  const cabeca = semBom.trimStart().slice(0, 4096).toUpperCase();
  if (cabeca.startsWith("OFXHEADER") || cabeca.includes("<OFX>")) return "ofx";
  const linhas = semBom.split(/\r\n|\r|\n/).filter((l) => l.length > 0);
  if (linhas.length > 0 && linhas.every((l) => l.length === 240)) return "cnab240";
  return "desconhecido";
}

function estrategiaDe(valor: string | null): EstrategiaChave | null {
  if (valor === null) return ESTRATEGIA_CHAVE_PADRAO;
  return valor === "id_bancario" || valor === "tupla" ? valor : null;
}

function montarPayload(
  entrada: Entrada,
  usuario: { id: string },
  hoje: string,
  sha256: string,
  estrategia: EstrategiaChave,
  extrato: ExtratoParseado,
  chaves: string[],
): Record<string, unknown> {
  return {
    banco_conta_id: entrada.banco_conta_id,
    formato: extrato.formato,
    sha256,
    storage_path: entrada.storage_path,
    hoje,
    enviado_por: usuario.id,
    estrategia_chave: estrategia,
    gerado_em: extrato.geradoEm,
    extrato: {
      banco: extrato.banco,
      agencia: extrato.agencia,
      conta: extrato.conta,
      periodo_inicio: extrato.periodoInicio,
      periodo_fim: extrato.periodoFim,
      saldo_inicial_centavos: extrato.saldoInicialCentavos, // null fica null — NUNCA 0
      saldo_final_centavos: extrato.saldoFinalCentavos,
      linhas: extrato.linhas.map((l, i) => ({
        data: l.data,
        sentido: l.sentido,
        valor_centavos: l.valorCentavos,
        descricao: l.descricao ?? "",
        documento: l.documento,
        id_bancario: l.idBancario,
        chave: chaves[i],
      })),
    },
  };
}

export async function processar(
  deps: Deps,
  entrada: Entrada,
  usuario: { id: string },
): Promise<Resposta> {
  const invalido = validarCaminho(entrada.storage_path, entrada.banco_conta_id);
  if (invalido) return erro(400, invalido);

  let bytes: Uint8Array;
  try {
    bytes = await deps.baixar(entrada.storage_path);
  } catch (e) {
    console.error("[banco-extrato-importar] falha ao baixar do Storage", e);
    return erro(502, "falha_ao_baixar_arquivo");
  }

  const formato = detectarFormato(bytes);
  if (formato === "cnab240") {
    // Ruling 11: sem parser CNAB (Task 5 bloqueada) — recusa explícita, nunca interpretar.
    return erroParse("formato_desconhecido", "cnab240_ainda_nao_suportado");
  }
  if (formato === "desconhecido") {
    return erroParse("formato_desconhecido", "formato_nao_reconhecido");
  }

  const parse = parseOfx(bytes);
  if (!parse.ok) return erroParse(parse.motivo, parse.detalhe);
  const extrato = parse.extrato;

  const estrategia = estrategiaDe(entrada.estrategia_chave);
  if (estrategia === null) {
    console.error("[banco-extrato-importar] estrategia_chave desconhecida na conta", entrada.estrategia_chave);
    return erro(500, "erro_interno");
  }
  const chaves = chavesDasLinhas(extrato.linhas, estrategia);
  if (chaves === null) {
    // A estratégia da conta não é aplicável a este arquivo (ex.: id_bancario com linha sem id).
    // Falha interna, não "recusado": a RPC não é chamada.
    console.error("[banco-extrato-importar] chavesDasLinhas devolveu null", estrategia);
    return erro(500, "erro_interno");
  }

  const payload = montarPayload(
    entrada,
    usuario,
    dataEmSaoPaulo(deps.agora()),
    await sha256Hex(bytes),
    estrategia,
    extrato,
    chaves,
  );

  try {
    const resultado = await deps.registrar(payload);
    return { status: 200, corpo: resultado };
  } catch (e) {
    // 22023 = erro de CONTRATO do payload (bug desta edge, não do arquivo): nunca "recusado".
    const code = (e as { code?: string } | null)?.code;
    console.error("[banco-extrato-importar] RPC banco_extrato_registrar falhou", code, e);
    return erro(500, "erro_interno");
  }
}
