// Card de histórico de check-ins do trimestre.
// Extraído verbatim de src/components/des/CheckinQualitativoTab.tsx (god-component split).
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { type DescontoCheckin } from "./types";
import { fmtPct, fmtDate } from "./format";

interface HistoricoCheckinsProps {
  loading: boolean;
  historico: DescontoCheckin[] | undefined;
}

export function HistoricoCheckins({ loading, historico }: HistoricoCheckinsProps) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Checkins anteriores neste trimestre</CardTitle>
      </CardHeader>
      <CardContent>
        {loading ? (
          <Skeleton className="h-32 w-full" />
        ) : (historico ?? []).length === 0 ? (
          <p className="text-sm text-muted-foreground text-center py-6">
            Nenhum checkin registrado ainda neste trimestre.
          </p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Data</TableHead>
                <TableHead>Tipo</TableHead>
                <TableHead>Avaliado por</TableHead>
                <TableHead className="text-right">Qualitativos</TableHead>
                <TableHead className="text-right">Desconto projetado</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {historico!.map((h) => (
                <TableRow key={h.checkin_id}>
                  <TableCell className="text-xs">{fmtDate(h.data_avaliacao)}</TableCell>
                  <TableCell>
                    <Badge variant={h.tipo === "confirmacao_andre" ? "default" : "secondary"} className="text-xs">
                      {h.tipo === "confirmacao_andre" ? "Confirmação" : "Projeção"}
                    </Badge>
                  </TableCell>
                  <TableCell className="text-xs text-muted-foreground">
                    {h.avaliado_por ?? "—"}
                  </TableCell>
                  <TableCell className="text-right text-xs">
                    {fmtPct(h.qualitativos_atingidos_perc)}
                  </TableCell>
                  <TableCell className="text-right text-xs font-medium">
                    {fmtPct(h.desconto_total_projetado)}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </CardContent>
    </Card>
  );
}
