/**
 * Links do Google Maps da ficha do Radar.
 *
 * Antes a busca juntava logradouro, número, bairro, município, UF e CEP em CAIXA ALTA ("RUA JOSE CAMPOS, 75, DISTRITO
 * INDUSTRIAL, OLIVEIRA, MG, 35540000"), e o Maps devolvia uma sugestão e negócios por perto, sem marcar o endereço.
 * Sem coordenada (lat/lng vazios em MG), o melhor é uma busca que o Maps resolva como ENDEREÇO:
 * "Rua Jose Campos 75, Oliveira - MG" — sem bairro (o da Receita costuma não bater com o do Maps) e com o CEP só quando
 * é de logradouro (o terminado em 000 é o genérico da cidade e puxa o centro).
 * O 2º link procura a EMPRESA (fantasia ou razão + cidade): quando ela está no Maps, cai no pin do próprio negócio.
 */

export interface EnderecoMapa {
  cnpj: string;
  logradouro?: string | null;
  numero?: string | null;
  municipio_nome?: string | null;
  uf?: string | null;
  cep?: string | null;
  nome_fantasia?: string | null;
  razao_social?: string | null;
}

const BASE = 'https://www.google.com/maps/search/?api=1&query=';
const PARTICULAS = new Set(['de', 'da', 'do', 'das', 'dos', 'e']);

const limpo = (v: string | null | undefined): string => (v ?? '').replace(/\s+/g, ' ').trim();

/** CAIXA ALTA da Receita → caixa de título ("RUA JOSE CAMPOS" → "Rua Jose Campos"). Siglas de 2 letras (UF) ficam. */
function titulo(t: string): string {
  return t
    .toLocaleLowerCase('pt-BR')
    .split(' ')
    .filter(Boolean)
    .map((p, i) => (i > 0 && PARTICULAS.has(p) ? p : p.charAt(0).toLocaleUpperCase('pt-BR') + p.slice(1)))
    .join(' ');
}

/** Número que a Receita grava como "S/N", "SN" ou "0" não ajuda o Maps. */
function numeroUtil(n: string): string {
  return /^(s\/?n|sn|0+)$/i.test(n) ? '' : n;
}

/** CEP de logradouro formatado (35540-123); o genérico da cidade (…000) e lixo saem. */
export function cepUtil(cep: string | null | undefined): string | null {
  const d = (cep ?? '').replace(/\D/g, '');
  if (d.length !== 8 || d.endsWith('000')) return null;
  return `${d.slice(0, 5)}-${d.slice(5)}`;
}

function cidadeUf(e: EnderecoMapa): string {
  const cidade = titulo(limpo(e.municipio_nome));
  const uf = limpo(e.uf).toUpperCase();
  return cidade && uf ? `${cidade} - ${uf}` : cidade || uf;
}

/** "Rua Jose Campos 75, Oliveira - MG" (+ ", 35540-123" se o CEP for de logradouro). null = sem logradouro. */
export function consultaEnderecoMaps(e: EnderecoMapa): string | null {
  const rua = titulo(limpo(e.logradouro));
  if (!rua) return null;
  const num = numeroUtil(limpo(e.numero));
  const partes = [num ? `${rua} ${num}` : rua, cidadeUf(e), cepUtil(e.cep)].filter((p): p is string => !!p);
  return partes.join(', ');
}

/** "Marcenaria Um, Oliveira - MG". null = sem nome. */
export function consultaEmpresaMaps(e: EnderecoMapa): string | null {
  const nome = limpo(e.nome_fantasia) || limpo(e.razao_social);
  if (!nome) return null;
  const lugar = cidadeUf(e);
  return lugar ? `${nome}, ${lugar}` : nome;
}

export function urlMapsEndereco(e: EnderecoMapa): string | null {
  const q = consultaEnderecoMaps(e);
  return q ? BASE + encodeURIComponent(q) : null;
}

export function urlMapsEmpresa(e: EnderecoMapa): string | null {
  const q = consultaEmpresaMaps(e);
  return q ? BASE + encodeURIComponent(q) : null;
}
