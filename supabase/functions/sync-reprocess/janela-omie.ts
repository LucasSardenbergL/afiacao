// A janela de datas do ListarPedidos do sync-reprocess, no dia de NEGÓCIO (America/Sao_Paulo).
//
// POR QUE EXISTE — a classe (ii) do fuso, fase 3 (docs/historico/hoje-sp-typescript-e-data-ciclo.md).
// O index.ts montava as datas com `getDate()` sobre o instante: no servidor (UTC) é o dia UTC, e das
// 21:00 às 23:59 BRT ele já é o dia SEGUINTE ao de SP — os crons das 21:15 e 23:15 (operational) e o das
// 23:30 (strategic) pediam ao Omie a janela até AMANHÃ e perdiam o dia mais antigo. Aqui são `dias` de
// calendário de SP para trás de HOJE em SP, os dois extremos inclusive: o que o código velho dava durante
// o DIA. Lógica PURA (o instante é injetável); testes em janela-omie_test.ts.
import { hojeSP, paraDataOmie, somarDias } from "../_shared/hoje-sp.ts";

/** `{ de, ate }` no formato do Omie (DD/MM/AAAA). `dias` não inteiro LANÇA (o somarDias recusa). */
export function janelaPedidosOmie(agora: Date, dias: number): { de: string; ate: string } {
  const hoje = hojeSP(agora);
  return { de: paraDataOmie(somarDias(hoje, -dias)), ate: paraDataOmie(hoje) };
}
