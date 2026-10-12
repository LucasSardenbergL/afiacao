// Congelamento de módulos (M-41, plano 2026-09-05 §0.3 decisão 1).
// Congelar = esconder a rota e o item de navegação; o código fica, sem correção, até `ate`.
// Quem decide se uma rota está congelada é ESTA função — o guard do App.tsx e o filtro da
// navegação leem daqui, e o gate (__tests__/congelamento.gate.test.ts) cruza com o App.tsx.
import type { Congelamento, ModuloApp } from "./tipos";

export type RotaCongelada = Congelamento & { moduloId: string; moduloNome: string };

/** "/" é o destino do redirect — congelá-la viraria laço. Nunca entra. */
export const ROTA_DESTINO = "/";

function casaPrefixo(pathname: string, prefixo: string): boolean {
  if (prefixo === "/") return pathname === "/";
  return pathname === prefixo || pathname.startsWith(`${prefixo}/`);
}

/** Dono da rota = módulo com o prefixo MAIS LONGO que casa (ex.: /admin/reposicao vence /admin). */
export function moduloDaRota(pathname: string, modulos: ModuloApp[]): ModuloApp | null {
  let melhor: { m: ModuloApp; tam: number } | null = null;
  for (const m of modulos) {
    for (const p of m.rotaPrefixos) {
      if (casaPrefixo(pathname, p) && (!melhor || p.length > melhor.tam)) melhor = { m, tam: p.length };
    }
  }
  return melhor?.m ?? null;
}

export function rotaCongelada(pathname: string, modulos: ModuloApp[]): RotaCongelada | null {
  const caminho = pathname.length > 1 ? pathname.replace(/\/+$/, "") : pathname;
  if (caminho === ROTA_DESTINO) return null;

  // Parcial primeiro: o prefixo parcial é sempre mais específico que o do próprio módulo.
  for (const m of modulos) {
    const parcial = m.rotasCongeladas;
    if (parcial && parcial.prefixos.some((p) => casaPrefixo(caminho, p))) {
      return { desde: parcial.desde, ate: parcial.ate, motivo: parcial.motivo, moduloId: m.id, moduloNome: m.nome };
    }
  }

  const dono = moduloDaRota(caminho, modulos);
  if (!dono || dono.status === "ativo" || !dono.congelamento) return null;
  return { ...dono.congelamento, moduloId: dono.id, moduloNome: dono.nome };
}

/** "2027-01-10" → "10/01/2027" (sem Date: fuso não pode mudar o dia exibido). */
export function formatarDataCongelamento(iso: string): string {
  const [a, m, d] = iso.split("-");
  return `${d}/${m}/${a}`;
}
