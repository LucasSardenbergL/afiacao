// Tab "Negociação" — histórico de eventos da campanha.
// Extraída de src/pages/AdminReposicaoPromocaoDetail.tsx (god-component split).
import { Plus, Mail } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { TabsContent } from "@/components/ui/tabs";
import {
  tipoEventoIcon,
  formatDateTimeBR,
  formatRelative,
} from "@/components/reposicao/promocaoDetail/helpers";
import {
  TIPO_EVENTO_LABELS,
  type Evento,
} from "@/components/reposicao/promocaoDetail/types";

type NegociacaoTabProps = {
  eventos: Evento[];
  onOpenEvento: () => void;
};

export function NegociacaoTab({ eventos, onOpenEvento }: NegociacaoTabProps) {
  return (
    <TabsContent value="negociacao" className="space-y-4">
      <Card>
        <CardHeader className="flex flex-row items-center justify-between">
          <CardTitle className="text-base">Histórico de negociação</CardTitle>
          <Button size="sm" onClick={onOpenEvento}>
            <Plus className="h-4 w-4" /> Registrar evento
          </Button>
        </CardHeader>
        <CardContent>
          {eventos.length === 0 ? (
            <p className="text-sm text-muted-foreground py-6 text-center">
              Nenhum evento registrado ainda.
            </p>
          ) : (
            <div className="space-y-3">
              {eventos.map((ev) => {
                const Icon = tipoEventoIcon(ev.tipo_evento);
                return (
                  <div
                    key={ev.id}
                    className="flex gap-3 p-3 rounded-md border bg-card"
                  >
                    <div className="shrink-0 h-8 w-8 rounded-full bg-primary/10 flex items-center justify-center">
                      <Icon className="h-4 w-4 text-primary" />
                    </div>
                    <div className="flex-1 min-w-0 space-y-1">
                      <div className="flex items-center justify-between gap-2 flex-wrap">
                        <div className="font-medium text-sm">
                          {TIPO_EVENTO_LABELS[ev.tipo_evento]}
                        </div>
                        <div className="text-xs text-muted-foreground">
                          {formatRelative(ev.data_evento)} ·{" "}
                          {formatDateTimeBR(ev.data_evento)}
                        </div>
                      </div>
                      {(ev.desconto_perc_proposto !== null ||
                        ev.volume_minimo_proposto !== null) && (
                        <div className="flex gap-2 flex-wrap">
                          {ev.desconto_perc_proposto !== null && (
                            <Badge variant="secondary">
                              {ev.desconto_perc_proposto}% desconto
                            </Badge>
                          )}
                          {ev.volume_minimo_proposto !== null && (
                            <Badge variant="secondary">
                              Vol. mín. {ev.volume_minimo_proposto}
                            </Badge>
                          )}
                        </div>
                      )}
                      {ev.conteudo && (
                        <p className="text-sm whitespace-pre-wrap">
                          {ev.conteudo}
                        </p>
                      )}
                      <div className="text-xs text-muted-foreground flex items-center gap-2 flex-wrap">
                        <span>Por: {ev.registrado_por || "—"}</span>
                        {ev.email_referencia && (
                          <button
                            className="hover:text-foreground transition-colors flex items-center gap-1"
                            onClick={() => {
                              navigator.clipboard.writeText(
                                ev.email_referencia!,
                              );
                              toast.success("Copiado");
                            }}
                          >
                            <Mail className="h-3 w-3" />
                            {ev.email_referencia}
                          </button>
                        )}
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </CardContent>
      </Card>
    </TabsContent>
  );
}
