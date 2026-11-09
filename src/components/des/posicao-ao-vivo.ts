import type { Json } from "@/integrations/supabase/types";
import { faixaDeJson } from "./faixa-json";

/**
 * Leitura da `v_des_posicao_trimestre_ao_vivo` para a tela.
 *
 * A posição do trimestre é faturado confirmado do GoodData + pedidos em trânsito. Sem
 * `fat_bruto_confirmado` (sem snapshot no trimestre), a soma é só trânsito: não é posição, e a faixa
 * e o gap que saem dela também não são (money-path §2: ausente ≠ zero). A migration
 * 20261105091216 faz a view devolver NULL nesse caso. Este gate repete a regra no front para valer
 * também com a view antiga, que ainda somava `COALESCE(fat, 0) + trânsito`.
 */
export interface LinhaPosicaoAoVivo {
  fat_bruto_confirmado?: number | null;
  posicao_ao_vivo_conservadora?: number | null;
  posicao_ao_vivo_otimista?: number | null;
  faixa_conservadora?: Json | null;
  faixa_otimista?: Json | null;
  gap_para_meta_pessoal?: number | null;
  meta_pessoal?: number | null;
}

export interface PosicaoAoVivo {
  /** `false` = sem faturado confirmado: posição, faixa, gap e progresso são `null`. */
  conhecida: boolean;
  conservadora: number | null;
  otimista: number | null;
  /** Estrelas da faixa. Com posição conhecida e abaixo da 1ª faixa, 0 é fato (nenhuma faixa atingida). */
  estrelasConservadora: number | null;
  estrelasOtimista: number | null;
  faixaConservadoraId: number | null;
  faixaConservadoraNumero: number | null;
  meta: number | null;
  /** Quanto falta para a meta pessoal. `null` sem posição ou sem meta cadastrada (> 0). */
  gap: number | null;
  /** % da meta (0–100). `null` sem posição ou sem meta cadastrada (> 0). */
  progresso: number | null;
  /** `null` quando não dá para saber (sem posição ou sem meta) — nunca "atingida" por ausência. */
  metaAtingida: boolean | null;
}

const numero = (v: number | string | null | undefined): number | null => {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

/** Há faturado confirmado E a view trouxe a posição: só então posição, faixa e gap valem. */
export function posicaoConhecida(linha: LinhaPosicaoAoVivo | null | undefined): boolean {
  if (!linha) return false;
  return numero(linha.fat_bruto_confirmado) !== null && numero(linha.posicao_ao_vivo_conservadora) !== null;
}

export function derivarPosicaoAoVivo(linha: LinhaPosicaoAoVivo | null | undefined): PosicaoAoVivo {
  const meta = numero(linha?.meta_pessoal);
  const conservadora = numero(linha?.posicao_ao_vivo_conservadora);
  const otimista = numero(linha?.posicao_ao_vivo_otimista);

  if (!linha || !posicaoConhecida(linha) || conservadora === null) {
    return {
      conhecida: false,
      conservadora: null,
      otimista: null,
      estrelasConservadora: null,
      estrelasOtimista: null,
      faixaConservadoraId: null,
      faixaConservadoraNumero: null,
      meta,
      gap: null,
      progresso: null,
      metaAtingida: null,
    };
  }

  const faixaC = faixaDeJson(linha.faixa_conservadora);
  const faixaO = faixaDeJson(linha.faixa_otimista);
  const temMeta = meta !== null && meta > 0;
  const gap = temMeta ? numero(linha.gap_para_meta_pessoal) : null;

  return {
    conhecida: true,
    conservadora,
    otimista,
    estrelasConservadora: faixaC?.estrelas ?? 0,
    estrelasOtimista: faixaO?.estrelas ?? 0,
    faixaConservadoraId: faixaC?.faixa_id ?? null,
    faixaConservadoraNumero: faixaC?.faixa_numero ?? 0,
    meta,
    gap,
    progresso: temMeta ? Math.min((conservadora / meta) * 100, 100) : null,
    metaAtingida: temMeta && gap !== null ? gap <= 0 : null,
  };
}
