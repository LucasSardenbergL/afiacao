import { useState, useEffect } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import { TableCell, TableRow } from "@/components/ui/table";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Layers, Trash2 } from "lucide-react";
import { Item } from "./types";
import { MapeamentoDialog } from "./MapeamentoDialog";

export function ItemRow({
  item,
  numFamilias,
  onUpdate,
  onDelete,
  onMapeamentoChanged,
}: {
  item: Item;
  numFamilias: number;
  onUpdate: (patch: Partial<Item>) => void;
  onDelete: () => void;
  onMapeamentoChanged: () => void;
}) {
  const [categoria, setCategoria] = useState(item.categoria_fornecedor);
  const [perc, setPerc] = useState(String(item.aumento_perc));
  const [vig, setVig] = useState(item.data_vigencia_especifica ?? "");
  const [mapDialogOpen, setMapDialogOpen] = useState(false);

  useEffect(() => {
    setCategoria(item.categoria_fornecedor);
    setPerc(String(item.aumento_perc));
    setVig(item.data_vigencia_especifica ?? "");
  }, [item]);

  return (
    <>
      <TableRow>
        <TableCell>
          <Input
            value={categoria}
            onChange={(e) => setCategoria(e.target.value)}
            onBlur={() => {
              if (categoria !== item.categoria_fornecedor) {
                onUpdate({ categoria_fornecedor: categoria });
              }
            }}
          />
        </TableCell>
        <TableCell>
          <Input
            type="number"
            step="0.01"
            value={perc}
            onChange={(e) => setPerc(e.target.value)}
            onBlur={() => {
              const n = Number(perc);
              if (!isNaN(n) && n !== item.aumento_perc) {
                onUpdate({ aumento_perc: n });
              }
            }}
          />
        </TableCell>
        <TableCell>
          <Input
            type="date"
            value={vig}
            onChange={(e) => setVig(e.target.value)}
            onBlur={() => {
              const v = vig || null;
              if (v !== item.data_vigencia_especifica) {
                onUpdate({ data_vigencia_especifica: v });
              }
            }}
          />
        </TableCell>
        <TableCell>
          <Button
            variant="outline"
            size="sm"
            onClick={() => setMapDialogOpen(true)}
            className="w-full justify-start"
          >
            <Layers className="h-3.5 w-3.5" />
            <span className="text-xs">
              {numFamilias > 0
                ? `${numFamilias} ${numFamilias === 1 ? "família" : "famílias"}`
                : "Mapear"}
            </span>
          </Button>
        </TableCell>
        <TableCell className="text-center">
          <Checkbox
            checked={item.confirmado}
            onCheckedChange={(c) => onUpdate({ confirmado: c === true })}
          />
        </TableCell>
        <TableCell>
          <AlertDialog>
            <AlertDialogTrigger asChild>
              <Button variant="ghost" size="sm">
                <Trash2 className="h-4 w-4 text-destructive" />
              </Button>
            </AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>Remover categoria?</AlertDialogTitle>
                <AlertDialogDescription>
                  A categoria "{item.categoria_fornecedor}" será desativada.
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>Voltar</AlertDialogCancel>
                <AlertDialogAction onClick={onDelete}>
                  Remover
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        </TableCell>
      </TableRow>

      <MapeamentoDialog
        open={mapDialogOpen}
        onOpenChange={setMapDialogOpen}
        item={item}
        onSaved={() => {
          setMapDialogOpen(false);
          onMapeamentoChanged();
        }}
      />
    </>
  );
}
