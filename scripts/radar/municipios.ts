/**
 * Coordenadas dos municípios do Radar a partir de `municipios-ibge.csv`.
 *
 * O código de município da RFB É o `siafi_id` do IBGE (medido em prod 2026-11-02: 5.473 de 5.473
 * códigos de `radar_municipios` existem como `siafi_id`, com a mesma UF e a mesma coordenada dos que
 * casavam por nome). Por isso o casamento é pelo código; o nome normalizado fica de reserva. Casar só
 * pelo nome deixava 17 municípios sem coordenada (PARATI × Paraty, ASSU × Açu, BRASOPOLIS × Brazópolis…)
 * e os leads e concorrentes deles fora do mapa.
 */
import { normalizarChaveMunicipio } from "../../src/lib/radar/normalizar";

export const UF_POR_CODIGO_IBGE: Record<string, string> = { "11":"RO","12":"AC","13":"AM","14":"RR","15":"PA","16":"AP","17":"TO","21":"MA","22":"PI","23":"CE","24":"RN","25":"PB","26":"PE","27":"AL","28":"SE","29":"BA","31":"MG","32":"ES","33":"RJ","35":"SP","41":"PR","42":"SC","43":"RS","50":"MS","51":"MT","52":"GO","53":"DF" };

export interface Coordenada { lat: number; lng: number }

export interface IndiceCoordenadas {
  porSiafi: Map<string, Coordenada>;
  porNome: Map<string, Coordenada>;
}

/** Linhas do CSV SEM o cabeçalho: codigo_ibge,nome,latitude,longitude,capital,codigo_uf,siafi_id,… */
export function indexarCoordenadasIbge(linhas: string[]): IndiceCoordenadas {
  const porSiafi = new Map<string, Coordenada>();
  const porNome = new Map<string, Coordenada>();
  for (const l of linhas) {
    const [, nome, lat, lng, , ufCod, siafi] = l.split(",");
    const uf = UF_POR_CODIGO_IBGE[ufCod?.trim() ?? ""] ?? "";
    const c = { lat: +lat, lng: +lng };
    if (nome && uf) porNome.set(normalizarChaveMunicipio(nome, uf), c);
    if (siafi?.trim()) porSiafi.set(siafi.trim(), c);
  }
  return { porSiafi, porNome };
}

/** Coordenada do município RFB: pelo código (= siafi_id); se faltar, pelo nome normalizado na UF. */
export function coordenadaDoMunicipio(
  idx: IndiceCoordenadas, codigoRfb: string, nome: string, uf: string,
): Coordenada | undefined {
  return idx.porSiafi.get(codigoRfb.trim()) ?? idx.porNome.get(normalizarChaveMunicipio(nome, uf));
}
