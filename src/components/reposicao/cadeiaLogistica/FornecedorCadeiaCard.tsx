// Card expansível de um fornecedor com a tabela de etapas logísticas.
// Extraído verbatim de src/pages/AdminReposicaoCadeiaLogistica.tsx (god-component split).
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import {
  ArrowDown,
  ArrowUp,
  ChevronDown,
  ChevronRight,
  Pencil,
  Plus,
  Repeat,
  X,
} from "lucide-react";
import { Etapa, Fornecedor } from "./types";
import { tipoLabel } from "./shared";

interface FornecedorCadeiaCardProps {
  fornecedor: Fornecedor;
  lista: Etapa[];
  isOpen: boolean;
  podeEditar: boolean;
  onToggle: () => void;
  onNovaEtapa: () => void;
  onEditar: (e: Etapa) => void;
  onTrocar: (e: Etapa) => void;
  onDesativar: (e: Etapa) => void;
  onReordenar: (args: { etapa: Etapa; direcao: "up" | "down" }) => void;
}

export function FornecedorCadeiaCard({
  fornecedor: f,
  lista,
  isOpen,
  podeEditar,
  onToggle,
  onNovaEtapa,
  onEditar,
  onTrocar,
  onDesativar,
  onReordenar,
}: FornecedorCadeiaCardProps) {
  const ativas = lista.filter((e) => e.ativo);
  const ltTotal = ativas.reduce((s, e) => s + (e.lt_dias || 0), 0);
  const cadeia =
    ativas
      .map((e) => e.parceiro_nome || e.descricao)
      .filter(Boolean)
      .join(" → ") || "—";

  return (
    <Card>
      <Collapsible open={isOpen} onOpenChange={onToggle}>
        <CollapsibleTrigger asChild>
          <CardHeader className="cursor-pointer hover:bg-muted/40 transition-colors">
            <div className="flex items-start justify-between gap-3">
              <div className="flex items-start gap-2 min-w-0">
                {isOpen ? (
                  <ChevronDown className="h-5 w-5 mt-0.5 shrink-0" />
                ) : (
                  <ChevronRight className="h-5 w-5 mt-0.5 shrink-0" />
                )}
                <div className="min-w-0">
                  <CardTitle className="text-base">{f.fornecedor_nome}</CardTitle>
                  <p className="text-xs text-muted-foreground mt-1 truncate">
                    {cadeia}
                  </p>
                </div>
              </div>
              <div className="flex flex-col items-end gap-1 shrink-0">
                <Badge variant="outline" className="font-mono">
                  {ltTotal}d totais
                </Badge>
                <span className="text-xs text-muted-foreground">
                  {ativas.length} etapa{ativas.length !== 1 ? "s" : ""}
                </span>
              </div>
            </div>
          </CardHeader>
        </CollapsibleTrigger>
        <CollapsibleContent>
          <CardContent className="space-y-3">
            <div className="flex justify-end">
              <Button
                size="sm"
                onClick={onNovaEtapa}
                disabled={!podeEditar}
              >
                <Plus className="h-4 w-4 mr-1" /> Adicionar etapa
              </Button>
            </div>
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-20">Ordem</TableHead>
                    <TableHead>Descrição</TableHead>
                    <TableHead>Parceiro</TableHead>
                    <TableHead className="text-right">LT</TableHead>
                    <TableHead>Unidade</TableHead>
                    <TableHead>Contato</TableHead>
                    <TableHead>Válido desde</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead className="text-right">Ações</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {lista.length === 0 && (
                    <TableRow>
                      <TableCell
                        colSpan={9}
                        className="text-center text-sm text-muted-foreground py-6"
                      >
                        Nenhuma etapa cadastrada.
                      </TableCell>
                    </TableRow>
                  )}
                  {lista.map((e) => (
                    <TableRow
                      key={e.id}
                      className={!e.ativo ? "opacity-60" : ""}
                    >
                      <TableCell>
                        <div className="flex items-center gap-1">
                          <span className="font-mono text-sm">{e.ordem}</span>
                          {e.ativo && podeEditar && (
                            <div className="flex flex-col">
                              <Button
                                variant="ghost"
                                size="sm"
                                className="h-4 w-4 p-0"
                                onClick={() => onReordenar({ etapa: e, direcao: "up" })}
                              >
                                <ArrowUp className="h-3 w-3" />
                              </Button>
                              <Button
                                variant="ghost"
                                size="sm"
                                className="h-4 w-4 p-0"
                                onClick={() => onReordenar({ etapa: e, direcao: "down" })}
                              >
                                <ArrowDown className="h-3 w-3" />
                              </Button>
                            </div>
                          )}
                        </div>
                      </TableCell>
                      <TableCell className="text-sm">{e.descricao}</TableCell>
                      <TableCell>
                        <div className="flex flex-col gap-0.5">
                          <span className="text-sm">
                            {e.parceiro_nome ?? "—"}
                          </span>
                          <Badge
                            variant="secondary"
                            className="text-[10px] w-fit"
                          >
                            {tipoLabel(e.parceiro_tipo)}
                          </Badge>
                        </div>
                      </TableCell>
                      <TableCell className="text-right font-mono text-sm">
                        {e.lt_dias}
                      </TableCell>
                      <TableCell className="text-xs">
                        {e.lt_unidade}
                      </TableCell>
                      <TableCell className="text-xs">
                        {e.parceiro_contato ?? "—"}
                      </TableCell>
                      <TableCell className="text-xs">
                        {e.valido_desde
                          ? new Date(e.valido_desde).toLocaleDateString("pt-BR")
                          : "—"}
                      </TableCell>
                      <TableCell>
                        {e.ativo ? (
                          <Badge variant="default">Ativo</Badge>
                        ) : (
                          <Badge variant="outline">Inativo</Badge>
                        )}
                      </TableCell>
                      <TableCell className="text-right space-x-1">
                        {e.ativo && podeEditar && (
                          <>
                            <Button
                              variant="ghost"
                              size="sm"
                              onClick={() => onEditar(e)}
                              title="Editar"
                            >
                              <Pencil className="h-3.5 w-3.5" />
                            </Button>
                            <Button
                              variant="ghost"
                              size="sm"
                              onClick={() => onTrocar(e)}
                              title="Trocar parceiro"
                            >
                              <Repeat className="h-3.5 w-3.5" />
                            </Button>
                            <Button
                              variant="ghost"
                              size="sm"
                              onClick={() => {
                                if (
                                  confirm(
                                    `Desativar etapa "${e.descricao}"? Isso irá recalcular os parâmetros.`,
                                  )
                                )
                                  onDesativar(e);
                              }}
                              title="Desativar"
                            >
                              <X className="h-3.5 w-3.5" />
                            </Button>
                          </>
                        )}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          </CardContent>
        </CollapsibleContent>
      </Collapsible>
    </Card>
  );
}
