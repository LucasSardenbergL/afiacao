/**
 * Radar pacote F (achado 2) — "Sua fila de hoje" passa a ser do vendedor: quem tem território (os municípios onde tem
 * mais clientes da carteira, a MESMA escolha do card "Prospectar hoje" e do e-mail semanal) abre o /radar no recorte
 * "Perto dos seus clientes" — a cidade nº 1 do território, com chips para as outras. Staff sem território (gestor,
 * master) mantém o default de antes ("MG e vizinhos", ordem por score).
 *
 * Por que UMA cidade, e não as três juntas: a fila, o ranking e o mapa filtram pelo MESMO código de município exato
 * (`p_municipio_codigo`); juntar três exigiria mudar as três RPCs juntas, senão a contagem e a fila discordariam.
 *
 * O default é VIRTUAL (não vai para a URL): vale enquanto a URL não diz nada de lugar (UF, cidade, região) e o vendedor
 * não pediu "Toda a região" (`perto=nao`). Mexer em qualquer filtro de lugar desliga o automático.
 */
import type { MunicipioTerritorio } from '@/lib/radar/prospectar-hoje';
import type { RegiaoRadar } from '@/lib/radar/ui-helpers';

export type { MunicipioTerritorio };

/** Valor de `perto` na URL que desliga o recorte automático. Vazio = automático. */
export const PERTO_DESLIGADO = 'nao';

const ehObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const texto = (v: unknown): string | null => (typeof v === 'string' && v.trim() !== '' ? v.trim() : null);

/** Leitor ESTRITO da `radar_meu_territorio`: fora do formato LANÇA (a tela cai no default e diz), nunca vira "vazio". */
export function lerTerritorio(data: unknown, origem: string): MunicipioTerritorio[] {
  if (!Array.isArray(data)) throw new Error(`${origem}: resposta fora do formato (lista)`);
  return data.map((t, i): MunicipioTerritorio => {
    const codigo = ehObj(t) ? texto(t.municipio_codigo) : null;
    const nome = ehObj(t) ? texto(t.municipio_nome) : null;
    const clientes = ehObj(t) && typeof t.clientes === 'number' && Number.isInteger(t.clientes) ? t.clientes : null;
    if (!ehObj(t) || !codigo || !/^[0-9]{4}$/.test(codigo) || !nome || clientes === null || clientes < 1) {
      throw new Error(`${origem}: resposta fora do formato (territorio[${i}])`);
    }
    return { municipioCodigo: codigo, municipioNome: nome, uf: texto(t.uf) ?? '', clientes };
  });
}

/** Os campos de LUGAR da URL — os que o recorte do território respeita (qualquer um preenchido = escolha explícita). */
export interface LugarDaUrl {
  uf: string;
  municipio: string;
  municipioCodigo: string;
  regiao: string;
  perto: string;
}

/** Recorte de lugar que o território aplica por cima da URL (só os campos que mudam). */
export interface RecorteTerritorio {
  municipio: string;
  municipioCodigo: string;
  uf: string;
  regiao: RegiaoRadar;
}

/** O automático vale? Só com território, sem nenhum lugar na URL e sem "Toda a região". */
export function territorioAutomatico(url: LugarDaUrl, territorio: readonly MunicipioTerritorio[] | null | undefined): MunicipioTerritorio | null {
  if (!territorio || territorio.length === 0) return null;
  if (url.perto === PERTO_DESLIGADO) return null;
  if (url.uf || url.municipio || url.municipioCodigo || (url.regiao && url.regiao !== 'atuacao')) return null;
  return territorio[0];
}

/** Os filtros de lugar que abrem a fila de uma cidade do território. A UF vai junto: a cidade pode estar fora de "MG e
 *  vizinhos", e o código exato com a região errada abriria uma fila vazia calada. */
export function recorteDaCidade(c: MunicipioTerritorio): RecorteTerritorio {
  return { municipio: c.municipioNome, municipioCodigo: c.municipioCodigo, uf: c.uf, regiao: 'atuacao' };
}

/** A cidade do território que está recortando a fila agora (automática ou escolhida no chip), ou null. */
export function cidadeDoTerritorioAtiva(
  municipioCodigo: string,
  territorio: readonly MunicipioTerritorio[] | null | undefined,
): MunicipioTerritorio | null {
  if (!municipioCodigo || !territorio) return null;
  return territorio.find((t) => t.municipioCodigo === municipioCodigo) ?? null;
}

/** Um patch de filtros mexe em LUGAR? (Mexer desliga o automático — senão limpar o campo cidade o traria de volta.) */
export function patchMexeEmLugar(patch: Record<string, unknown>): boolean {
  return ['uf', 'municipio', 'municipioCodigo', 'regiao'].some((k) => k in patch);
}
