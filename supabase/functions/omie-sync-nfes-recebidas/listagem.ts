// Fim da listagem do `ListarRecebimentos`. Decisão pura, testada em listagem_test.ts (Deno).
//
// A Omie sinaliza "acabou" por FAULT, não por lista vazia. A fault canônica é "Não existem registros
// para a página", e o regex que o laço de páginas usava não a reconhecia: a janela de 3 dias sem
// documento (fim de semana, feriado) virava `erros++`, o run fechava `error` ("0 NFes processadas
// com 1 erro(s) — rate-limit/Omie?") e o watchdog disparava alerta crítico FALSO — 07-05, 07-20,
// 08-04, 09-08 e 10-06 (medido, psql-ro). A irmã `omie-sync-ctes-recebidos`, no mesmo endpoint, já
// tratava essa fault como fim. A canônica vem do classificador compartilhado (`_shared/omie-falha.ts`,
// que normaliza acento e caixa); os textos que o laço já aceitava continuam aceitos.
//
// A canônica só é fim na PÁGINA 1, a janela vazia. O laço nunca pede página além do total declarado,
// então a mesma fault numa página > 1 quer dizer que a listagem encolheu entre páginas, ou que a Omie
// superestimou o total: é anomalia, e continua erro VISÍVEL, como antes deste conserto (revisão
// adversarial, P3-a). Fault que NÃO é fim continua erro em qualquer página: tratá-la como fim
// fecharia o run `complete` com a listagem PARCIAL — a fabricação de completude que o guard de
// páginas existe para impedir.
import { classificarFaultstring } from "../_shared/omie-falha.ts";

const FIM_LEGADO = /not\s*found|sem\s*registros|n[ãa]o\s*encontrado|nenhum\s*registro/i;

export function ehFimDaListagem(faultstring: string, pagina: number): boolean {
  if (FIM_LEGADO.test(faultstring)) return true;
  return pagina === 1 && classificarFaultstring(faultstring) === "fim_de_pagina";
}
