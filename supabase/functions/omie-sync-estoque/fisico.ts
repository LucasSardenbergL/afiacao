// Varredura do físico (ListarPosEstoque): a SOMA por SKU e o VEREDITO de completude, puros. O handler pagina e
// entrega cada resposta a `pagina()`; quem decide se o retrato pode ser publicado é `veredito()`.
//
// Por que existe (achado preexistente do adversarial do #2817; desenho da v1.6 com o Codex, 2026-10-06): a v1.5
// calculava `varreduraTruncada` DEPOIS do upsert e só suspendia a inativação — o físico incompleto saía com ok:true. E
// o helper compartilhado responde "não truncada" quando o total declarado está ausente, zero ou inválido: uma resposta
// vazia passaria por completa, gravaria zero linhas e inativaria os 399 habilitados. Por isso o veredito tem TRÊS
// estados, e só `completo` autoriza publicar; `inconsistente` e `desconhecido` abortam o run antes da fase do PO.
//
// LIMITE, que vale para a inativação: contagem estável e chaves únicas NÃO provam ausência. Uma remoção antes do cursor
// somada a uma inserção depois dele preserva a contagem, não repete chave e pula uma linha — o SKU pulado vira "não
// encontrado". O veredito estreita essa janela; não a fecha.

export interface LinhaPosEstoque {
  nCodProd?: unknown;
  codigo_local_estoque?: unknown;
  fisico?: unknown;
  reservado?: unknown;
  [k: string]: unknown;
}

/** Soma por SKU habilitado. O método devolve UMA LINHA POR LOCAL de estoque: o físico do SKU é a soma dos locais. */
export interface AgregadoSku {
  fisico: number;
  reservado: number;
  locais: number;
}

type EstadoVarredura = "completo" | "inconsistente" | "desconhecido";

export interface VereditoFisico {
  estado: EstadoVarredura;
  /** null só no `completo`. */
  motivo: string | null;
  totalDeclarado: number | null;
  registrosLidos: number;
  /** Sensores — não decidem. Linha sem local fica FORA da checagem de unicidade (não se inventa identidade vazia). */
  linhasSemLocal: number;
  paginasSemTotal: number;
}

/** Marca ASCII, caixa fixa, no INÍCIO da recusa: o registro do run guarda só 300 caracteres do erro. */
export const MARCA_FISICO = "FISICO_NAO_PUBLICAVEL";

// nTotRegistros: inteiro positivo (número ou string de dígitos). Ausente ou ZERO = a página não declarou — zero conta
// como ausência porque uma API que só declara o total na 1ª página mandaria 0 nas outras, e tratá-lo como inválido
// recusaria TODO run (o total que decide é o positivo, e ele tem de ser o mesmo em todas as páginas que o declaram).
// Negativo, fracionário ou texto é inválido.
function lerTotalDeclarado(v: unknown): number | null | "invalido" {
  if (v === undefined || v === null) return null;
  const n = typeof v === "number"
    ? v
    : typeof v === "string" && /^\d+$/.test(v.trim())
    ? Number(v.trim())
    : Number.NaN;
  if (n === 0) return null;
  return Number.isSafeInteger(n) && n > 0 ? n : "invalido";
}

function lerLocal(v: unknown): string | null {
  if (typeof v === "number" && Number.isFinite(v)) return String(v);
  if (typeof v === "string" && v.trim() !== "") return v.trim();
  return null;
}

export interface AcumuladorFisico {
  pagina(itens: readonly LinhaPosEstoque[], nTotRegistros: unknown): void;
  readonly encontrados: ReadonlyMap<string, AgregadoSku>;
  /** Membros de grupo de equivalência NÃO habilitados: mapa à parte, fora das invariantes do `encontrados`. */
  readonly membros: ReadonlyMap<string, AgregadoSku>;
  /** Membro com físico/reservado não finito em algum local: sem linha (a soma parcial seria fabricada). */
  readonly membrosIlegiveis: readonly string[];
  readonly registrosLidos: number;
  veredito(): VereditoFisico;
}

/**
 * @param habilitado  o SKU entra na soma? (as demais linhas só contam para a completude e a unicidade)
 * @param esperados   quantos SKUs habilitados existem — com algum esperado, nenhum encontrado é vazio INESPERADO
 * @param membro      membro de grupo de equivalência NÃO habilitado? Vai para `membros`: o motor lê o físico dele no
 *                    GREATEST do grupo, e sem este caminho a linha congelava no valor de quando era habilitado
 */
export function criarAcumuladorFisico(
  habilitado: (sku: string) => boolean,
  esperados: number,
  membro: (sku: string) => boolean = () => false,
): AcumuladorFisico {
  const encontrados = new Map<string, AgregadoSku>();
  const membros = new Map<string, AgregadoSku>();
  const membrosIlegiveis = new Set<string>();
  const totais = new Set<number>();
  const chaves = new Set<string>();
  let registrosLidos = 0;
  let totalInvalido = false;
  let paginasSemTotal = 0;
  let linhasSemLocal = 0;
  let primeiraRepetida: string | null = null;
  const naoFinitos: string[] = [];

  return {
    pagina(itens, nTotRegistros) {
      const total = lerTotalDeclarado(nTotRegistros);
      if (total === null) paginasSemTotal++;
      else if (total === "invalido") totalInvalido = true;
      else totais.add(total);

      registrosLidos += itens.length;
      for (const item of itens) {
        const codigo = String(item.nCodProd ?? "").trim();
        if (!codigo) continue;
        // Unicidade ANTES do filtro de habilitados: um deslize da listagem repete QUALQUER linha.
        const local = lerLocal(item.codigo_local_estoque);
        if (local === null) {
          linhasSemLocal++;
        } else {
          const chave = `${codigo}|${local}`;
          if (chaves.has(chave)) primeiraRepetida ??= chave;
          else chaves.add(chave);
        }
        const ehHabilitado = habilitado(codigo);
        if (!ehHabilitado && !membro(codigo)) continue;
        const fisico = Number(item.fisico ?? 0);
        const reservado = Number(item.reservado ?? 0);
        if (!Number.isFinite(fisico) || !Number.isFinite(reservado)) {
          // No habilitado, barra a varredura inteira; no membro, só tira o membro — nunca barra os habilitados.
          if (ehHabilitado) {
            naoFinitos.push(codigo);
          } else {
            membrosIlegiveis.add(codigo);
            membros.delete(codigo);
          }
          continue;
        }
        if (!ehHabilitado && membrosIlegiveis.has(codigo)) continue;
        const destino = ehHabilitado ? encontrados : membros;
        const acc = destino.get(codigo) ?? { fisico: 0, reservado: 0, locais: 0 };
        acc.fisico += fisico;
        acc.reservado += reservado;
        acc.locais += 1;
        destino.set(codigo, acc);
      }
    },
    get encontrados() {
      return encontrados;
    },
    get membros() {
      return membros;
    },
    get membrosIlegiveis() {
      return [...membrosIlegiveis];
    },
    get registrosLidos() {
      return registrosLidos;
    },
    veredito() {
      const base = { registrosLidos, linhasSemLocal, paginasSemTotal };
      const recusa = (estado: EstadoVarredura, motivo: string, totalDeclarado: number | null): VereditoFisico => ({
        ...base,
        estado,
        motivo,
        totalDeclarado,
      });
      if (totalInvalido || totais.size === 0) {
        return recusa("desconhecido", "total de registros declarado ausente ou inválido", null);
      }
      if (totais.size > 1) {
        return recusa("inconsistente", `total declarado mudou entre páginas (${[...totais].join(", ")})`, null);
      }
      const total = [...totais][0];
      if (primeiraRepetida !== null) {
        return recusa("inconsistente", `par produto|local repetido (${primeiraRepetida}): a listagem deslizou`, total);
      }
      if (naoFinitos.length > 0) {
        return recusa(
          "inconsistente",
          `físico/reservado não finito em ${naoFinitos.length} SKU(s) (ex.: ${naoFinitos[0]})`,
          total,
        );
      }
      if (registrosLidos < total) {
        return recusa("inconsistente", `varredura truncada: lidos ${registrosLidos} de ${total} declarados`, total);
      }
      if (registrosLidos > total) {
        return recusa("inconsistente", `sobre-leitura: lidos ${registrosLidos} de ${total} declarados`, total);
      }
      if (esperados > 0 && encontrados.size === 0) {
        return recusa("inconsistente", `nenhum dos ${esperados} SKUs habilitados apareceu (${registrosLidos} lidos)`, total);
      }
      return { ...base, estado: "completo", motivo: null, totalDeclarado: total };
    },
  };
}

/** Lança (com a marca no início) se o retrato não é provadamente completo. `faseMs` vai na frente do motivo. */
export function exigirFisicoPublicavel(v: VereditoFisico, faseMs: number): void {
  if (v.estado === "completo") return;
  throw new Error(`${MARCA_FISICO} ${v.estado} (físico ${faseMs}ms): ${v.motivo}; nada foi gravado`);
}
