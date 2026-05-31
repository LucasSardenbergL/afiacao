// Coerção/validação dos parâmetros de disparo (tabela route_disparo_config). PURO/testável.
// O form usa strings (inputs) + % p/ a reserva; o DB usa números + fração. Estes helpers
// convertem nos dois sentidos com clamps (não deixa salvar lixo no money-path da lista).

export interface RouteDisparoConfig {
  disparo_inicio: string;          // 'HH:MM'
  disparo_corte: string;           // 'HH:MM'
  meta_tier_cap: number;
  win_back_reserva_pct: number;    // 0-1
  cold_start_piso_dia: number;
  capacidade_ligacoes_dia: number;
  cadencia_min_dias: number;
}
export interface ConfigForm {
  disparoInicio: string;
  disparoCorte: string;
  metaTierCap: string;
  winBackReservaPercent: string;   // 0-100 (exibição)
  coldStartPisoDia: string;
  capacidadeLigacoesDia: string;
  cadenciaMinDias: string;
}

export function isValidHHMM(s: string): boolean {
  return /^([01]\d|2[0-3]):[0-5]\d$/.test(s);
}

function intGE0(s: string): number {
  const n = parseInt(s, 10); // trunca decimal ('2.9'→2)
  return Number.isFinite(n) ? Math.max(0, n) : 0;
}

export function formToConfig(form: ConfigForm): RouteDisparoConfig {
  const pct = Number(form.winBackReservaPercent);
  const pctFrac = Number.isFinite(pct) ? Math.min(1, Math.max(0, pct / 100)) : 0;
  return {
    disparo_inicio: isValidHHMM(form.disparoInicio) ? form.disparoInicio : '07:30',
    disparo_corte: isValidHHMM(form.disparoCorte) ? form.disparoCorte : '15:30',
    meta_tier_cap: intGE0(form.metaTierCap),
    win_back_reserva_pct: pctFrac,
    cold_start_piso_dia: intGE0(form.coldStartPisoDia),
    capacidade_ligacoes_dia: intGE0(form.capacidadeLigacoesDia),
    cadencia_min_dias: intGE0(form.cadenciaMinDias),
  };
}

export function configToForm(cfg: RouteDisparoConfig): ConfigForm {
  return {
    disparoInicio: cfg.disparo_inicio,
    disparoCorte: cfg.disparo_corte,
    metaTierCap: String(cfg.meta_tier_cap),
    winBackReservaPercent: String(Math.round(cfg.win_back_reserva_pct * 100)),
    coldStartPisoDia: String(cfg.cold_start_piso_dia),
    capacidadeLigacoesDia: String(cfg.capacidade_ligacoes_dia),
    cadenciaMinDias: String(cfg.cadencia_min_dias),
  };
}
