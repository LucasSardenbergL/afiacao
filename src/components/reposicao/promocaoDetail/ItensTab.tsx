// Tab "Itens" — tabela de itens da campanha com edição inline + linha de adição.
// Extraída de src/pages/AdminReposicaoPromocaoDetail.tsx (god-component split).
import { Plus, Trash2, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { TabsContent } from "@/components/ui/tabs";
import { MapeamentoStatusCell } from "@/components/reposicao/promocaoDetail/MapeamentoStatusCell";
import { DescontoExtraCell } from "@/components/reposicao/promocaoDetail/DescontoExtraCell";
import { type ItemRow } from "@/components/reposicao/promocaoDetail/types";

type UpdateItemArgs = { itemId: number; changes: Partial<ItemRow> };

type ItensTabProps = {
  itens: ItemRow[];
  loadingItens: boolean;
  efetivoMap: Record<number, number>;
  userEmail: string;
  addingItem: boolean;
  setAddingItem: (value: boolean) => void;
  novoCodFornecedor: string;
  setNovoCodFornecedor: (value: string) => void;
  novoDesconto: string;
  setNovoDesconto: (value: string) => void;
  novoVolume: string;
  setNovoVolume: (value: string) => void;
  savingNovoItem: boolean;
  onAddItem: () => void;
  onUpdateItem: (args: UpdateItemArgs) => void;
  onDeleteItem: (itemId: number) => void;
  onCancelAdd: () => void;
};

export function ItensTab({
  itens,
  loadingItens,
  efetivoMap,
  userEmail,
  addingItem,
  setAddingItem,
  novoCodFornecedor,
  setNovoCodFornecedor,
  novoDesconto,
  setNovoDesconto,
  novoVolume,
  setNovoVolume,
  savingNovoItem,
  onAddItem,
  onUpdateItem,
  onDeleteItem,
  onCancelAdd,
}: ItensTabProps) {
  return (
    <TabsContent value="itens" className="space-y-4">
      <Card>
        <CardHeader className="flex flex-row items-center justify-between">
          <CardTitle className="text-base">Itens da campanha</CardTitle>
          <Button
            size="sm"
            onClick={() => setAddingItem(true)}
            disabled={addingItem}
          >
            <Plus className="h-4 w-4" /> Adicionar item
          </Button>
        </CardHeader>
        <CardContent>
          {loadingItens ? (
            <div className="flex items-center gap-2 text-sm text-muted-foreground py-6">
              <Loader2 className="h-4 w-4 animate-spin" /> Carregando…
            </div>
          ) : (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Cód. fornecedor</TableHead>
                    <TableHead>Descrição</TableHead>
                    <TableHead className="text-right">Desc.%</TableHead>
                    <TableHead>Extra</TableHead>
                    <TableHead className="text-right">Vol. mín.</TableHead>
                    <TableHead>SKU Omie</TableHead>
                    <TableHead className="w-12"></TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {itens.length === 0 && !addingItem && (
                    <TableRow>
                      <TableCell
                        colSpan={7}
                        className="text-center text-muted-foreground py-8"
                      >
                        Nenhum item nesta campanha.
                      </TableCell>
                    </TableRow>
                  )}
                  {itens.map((item) => {
                    const efetivo = efetivoMap[item.id];
                    return (
                      <TableRow key={item.id}>
                        <TableCell>
                          {item.confirmado ? (
                            <span className="font-mono text-sm">
                              {item.sku_codigo_fornecedor}
                            </span>
                          ) : (
                            <Input
                              className="h-8 font-mono text-sm"
                              defaultValue={item.sku_codigo_fornecedor}
                              onBlur={(e) => {
                                if (
                                  e.target.value !== item.sku_codigo_fornecedor
                                ) {
                                  onUpdateItem({
                                    itemId: item.id,
                                    changes: {
                                      sku_codigo_fornecedor: e.target.value,
                                    },
                                  });
                                }
                              }}
                            />
                          )}
                        </TableCell>
                        <TableCell className="text-sm text-muted-foreground max-w-xs truncate">
                          {item.descricao_produto_fornecedor || "—"}
                        </TableCell>
                        <TableCell className="text-right">
                          <Input
                            type="number"
                            step="0.1"
                            className="h-8 w-20 text-right tabular-nums"
                            defaultValue={item.desconto_perc}
                            onBlur={(e) => {
                              const v = parseFloat(e.target.value);
                              if (!isNaN(v) && v !== item.desconto_perc) {
                                onUpdateItem({
                                  itemId: item.id,
                                  changes: { desconto_perc: v },
                                });
                              }
                            }}
                          />
                        </TableCell>
                        <TableCell>
                          <div className="flex flex-col gap-0.5">
                            <DescontoExtraCell
                              item={item}
                              userEmail={userEmail}
                              onSave={(changes) =>
                                onUpdateItem({ itemId: item.id, changes })
                              }
                            />
                            {efetivo !== undefined && (
                              <span className="text-[10px] text-muted-foreground">
                                Efetivo: {efetivo}%
                              </span>
                            )}
                          </div>
                        </TableCell>
                        <TableCell className="text-right">
                          <Input
                            type="number"
                            step="1"
                            className="h-8 w-20 text-right tabular-nums"
                            defaultValue={item.volume_minimo ?? ""}
                            placeholder="—"
                            onBlur={(e) => {
                              const v = e.target.value.trim()
                                ? parseFloat(e.target.value)
                                : null;
                              if (v !== item.volume_minimo) {
                                onUpdateItem({
                                  itemId: item.id,
                                  changes: { volume_minimo: v },
                                });
                              }
                            }}
                          />
                        </TableCell>
                        <TableCell>
                          <MapeamentoStatusCell
                            item={item}
                            onUpdate={(changes) =>
                              onUpdateItem({ itemId: item.id, changes })
                            }
                          />
                        </TableCell>
                        <TableCell>
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={() => {
                              if (confirm("Remover este item?")) {
                                onDeleteItem(item.id);
                              }
                            }}
                          >
                            <Trash2 className="h-4 w-4 text-destructive" />
                          </Button>
                        </TableCell>
                      </TableRow>
                    );
                  })}
                  {addingItem && (
                    <TableRow className="bg-accent/30">
                      <TableCell>
                        <Input
                          className="h-8 font-mono text-sm"
                          placeholder="DR.4403"
                          value={novoCodFornecedor}
                          onChange={(e) => setNovoCodFornecedor(e.target.value)}
                          autoFocus
                        />
                      </TableCell>
                      <TableCell className="text-xs text-muted-foreground">
                        (auto)
                      </TableCell>
                      <TableCell>
                        <Input
                          type="number"
                          step="0.1"
                          className="h-8 w-20 text-right"
                          placeholder="20"
                          value={novoDesconto}
                          onChange={(e) => setNovoDesconto(e.target.value)}
                        />
                      </TableCell>
                      <TableCell></TableCell>
                      <TableCell>
                        <Input
                          type="number"
                          step="1"
                          className="h-8 w-20 text-right"
                          placeholder="—"
                          value={novoVolume}
                          onChange={(e) => setNovoVolume(e.target.value)}
                        />
                      </TableCell>
                      <TableCell colSpan={2}>
                        <div className="flex gap-1 justify-end">
                          <Button
                            size="sm"
                            onClick={onAddItem}
                            disabled={savingNovoItem}
                          >
                            {savingNovoItem && (
                              <Loader2 className="h-3 w-3 animate-spin" />
                            )}
                            Salvar
                          </Button>
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={onCancelAdd}
                            disabled={savingNovoItem}
                          >
                            Cancelar
                          </Button>
                        </div>
                      </TableCell>
                    </TableRow>
                  )}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>
    </TabsContent>
  );
}
