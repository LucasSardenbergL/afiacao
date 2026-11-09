import type { ElementType } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import {
  desatualizado,
  estadoDeLeitura,
  naoConsegui,
  type FatiaDeQuery,
} from "@/lib/leitura/estado-de-leitura";

/**
 * Card de CONTAGEM dos painéis de reposição (Cadastros, Mercado): quatro estados que não se
 * confundem (plano v7, C8/C9; mesmo idioma do `CardKpi` do recebimento):
 *
 *  - carregando  → esqueleto. Nunca "0": o zero do 1º paint é lido como fato;
 *  - sem leitura → "—" e o MOTIVO, sem a cor do valor. Antes o `queryFn` fazia
 *                  `if (error) return 0`, e "SKUs sem cadeia logística: 0" dizia "tudo mapeado";
 *  - desatualizado → o número da última leitura boa continua na tela, com o aviso de que a
 *                  atualização falhou (`desatualizado()`), em vez de sumir ou fingir que é atual;
 *  - pronta      → o número observado. Só aqui o zero é verdade.
 *
 * Pré-condição: o `queryFn` LANÇA no erro. Com `return 0` a query fica `success` e este card
 * mostraria o zero como fato. Ele não teria como saber da falha.
 */
export function KpiContagem({
  id,
  label,
  icon: Icon,
  query,
  tone,
  border,
}: {
  id: string;
  label: string;
  icon: ElementType;
  query: FatiaDeQuery & { data: number | undefined };
  /** classe de cor quando o valor lido é > 0 (`text-status-*` / `text-primary`) */
  tone: string;
  border: string;
}) {
  const estado = estadoDeLeitura(query);
  const temDado = query.data !== undefined;
  const velho = desatualizado(query, temDado);
  const valor = query.data;
  const positivo = valor !== undefined && valor > 0;
  const tom = positivo ? tone : "text-muted-foreground";
  const semLeitura = !temDado && naoConsegui(estado);

  const face = temDado ? (velho ? "desatualizado" : "pronta") : estado;

  return (
    <Card
      className={semLeitura ? "border-dashed border-border" : positivo ? border : "border-border"}
      data-testid={`kpi-${id}`}
      data-estado={face}
    >
      <CardContent className="pt-4 flex items-center justify-between">
        <div>
          <div className="text-xs text-muted-foreground">{label}</div>
          {temDado ? (
            <>
              <div className={`text-2xl font-bold mt-1 tabular-nums ${tom}`}>{valor}</div>
              {velho && (
                <div className="text-[11px] text-status-warning mt-0.5">
                  {velho === "sem-rede"
                    ? "Sem conexão — valor da última leitura"
                    : "Desatualizado — a última atualização falhou"}
                </div>
              )}
            </>
          ) : semLeitura ? (
            <>
              <div className="text-2xl font-bold mt-1 text-muted-foreground/60">—</div>
              <div className="text-[11px] text-status-warning mt-0.5">
                {estado === "sem-rede" ? "Sem conexão — não foi possível contar" : "Não foi possível carregar"}
              </div>
            </>
          ) : estado === "carregando" ? (
            <Skeleton className="h-8 w-16 mt-1" aria-label={`Carregando ${label}`} />
          ) : (
            <div className="text-2xl font-bold mt-1 text-muted-foreground/60">—</div>
          )}
        </div>
        <Icon className={`h-8 w-8 ${tom} opacity-60`} />
      </CardContent>
    </Card>
  );
}
