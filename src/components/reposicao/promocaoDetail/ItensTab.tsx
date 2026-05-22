// Aba "Itens da campanha": tabela de itens (com edição inline + células de
// mapeamento/desconto extra) + formulário de adicionar item.
// Extraída de src/pages/AdminReposicaoPromocaoDetail.tsx (god-component split).
//
// O estado de adicionar-item (novo*) e o handleAddItem são 100% locais a esta
// aba, então vivem aqui. As mutations de linha (update/delete) ficam no parent
// e chegam via callbacks onUpdateItem/onDeleteItem — comportamento idêntico ao
// original.
import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";
import { Loader2, Plus, Trash2 } from "lucide-react";
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
import { MapeamentoStatusCell } from "./MapeamentoStatusCell";
import { DescontoExtraCell } from "./DescontoExtraCell";
import type { ItemRow } from "./types";

export function ItensTab({
  campanhaId,
  itens,
  efetivoMap,
  loadingItens,
  userEmail,
  onUpdateItem,
  onDeleteItem,
}: {
  campanhaId: string;
  itens: ItemRow[];
  efetivoMap: Record<number, number>;
  loadingItens: boolean;
  userEmail: string;
  onUpdateItem: (itemId: number, changes: Partial<ItemRow>) => void;
  onDeleteItem: (itemId: number) => void;
}) {
  const qc = useQueryClient();
  const [addingItem, setAddingItem] = useState(false);
  const [novoCodFornecedor, setNovoCodFornecedor] = useState("");
  const [novoDesconto, setNovoDesconto] = useState("");
  const [novoVolume, setNovoVolume] = useState("");
  const [savingNovoItem, setSavingNovoItem] = useState(false);

  const handleAddItem = async () => {
    if (!novoCodFornecedor.trim() || !novoDesconto.trim()) {
      toast.error("Código e desconto obrigatórios");
      return;
    }
    const desc = parseFloat(novoDesconto);
    if (isNaN(desc) || desc <= 0 || desc > 100) {
      toast.error("Desconto deve ser entre 0 e 100%");
      return;
    }
    const vol = novoVolume.trim() ? parseFloat(novoVolume) : null;

    setSavingNovoItem(true);
    try {
      const { data: inserted, error: insertErr } = await supabase
        .from("promocao_item")
        .insert({
          campanha_id: Number(campanhaId),
          sku_codigo_fornecedor: novoCodFornecedor.trim(),
          desconto_perc: desc,
          volume_minimo: vol,
          ativo: true,
          confirmado: false,
        })
        .select("id")
        .single();
      if (insertErr) throw insertErr;

      const novoId = (inserted as { id: number }).id;
      // Chama RPC de expansão
      const { error: rpcErr } = await supabase.rpc(
        "expandir_promocao_item" as never,
        { p_item_id: novoId } as never,
      );
      if (rpcErr) throw rpcErr;

      toast.success("Item adicionado");
      setAddingItem(false);
      setNovoCodFornecedor("");
      setNovoDesconto("");
      setNovoVolume("");
      qc.invalidateQueries({ queryKey: ["promocao-itens", campanhaId] });
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Erro ao adicionar item");
    } finally {
      setSavingNovoItem(false);
    }
  };

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between">
        <CardTitle className="text-base">
          Itens da campanha
        </CardTitle>
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
                  <TableHead className="text-right">
                    Vol. mín.
                  </TableHead>
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
                                e.target.value !==
                                item.sku_codigo_fornecedor
                              ) {
                                onUpdateItem(item.id, {
                                  sku_codigo_fornecedor: e.target.value,
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
                              onUpdateItem(item.id, { desconto_perc: v });
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
                              onUpdateItem(item.id, changes)
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
                              onUpdateItem(item.id, { volume_minimo: v });
                            }
                          }}
                        />
                      </TableCell>
                      <TableCell>
                        <MapeamentoStatusCell
                          item={item}
                          onUpdate={(changes) =>
                            onUpdateItem(item.id, changes)
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
                        onChange={(e) =>
                          setNovoCodFornecedor(e.target.value)
                        }
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
                        onChange={(e) =>
                          setNovoDesconto(e.target.value)
                        }
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
                        onChange={(e) =>
                          setNovoVolume(e.target.value)
                        }
                      />
                    </TableCell>
                    <TableCell colSpan={2}>
                      <div className="flex gap-1 justify-end">
                        <Button
                          size="sm"
                          onClick={handleAddItem}
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
                          onClick={() => {
                            setAddingItem(false);
                            setNovoCodFornecedor("");
                            setNovoDesconto("");
                            setNovoVolume("");
                          }}
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
  );
}
