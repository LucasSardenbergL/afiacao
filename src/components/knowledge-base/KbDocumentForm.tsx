import { useState } from 'react';
import { useForm, Controller } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { useUploadKbDocument } from '@/hooks/useUploadKbDocument';
import { KB_DOCUMENT_TYPE_LABEL, type KbDocumentType } from '@/lib/knowledge-base/types';
import { Upload, Loader2 } from 'lucide-react';

const schema = z.object({
  title: z.string().min(3, 'Título muito curto'),
  type: z.enum(['boletim_tecnico', 'case', 'comparativo', 'tutorial', 'msds', 'outro']),
  supplier: z.string().optional(),
  product_code: z.string().optional(),
  tags: z.string().optional(),
});

type FormValues = z.infer<typeof schema>;

interface Props {
  onUploaded?: () => void;
}

export function KbDocumentForm({ onUploaded }: Props) {
  const [file, setFile] = useState<File | null>(null);
  const upload = useUploadKbDocument();
  const {
    register,
    handleSubmit,
    control,
    formState: { errors },
    reset,
  } = useForm<FormValues>({
    resolver: zodResolver(schema),
    defaultValues: { type: 'boletim_tecnico' },
  });

  const onSubmit = (values: FormValues) => {
    if (!file) return;
    upload.mutate(
      {
        file,
        title: values.title,
        type: values.type as KbDocumentType,
        supplier: values.supplier || undefined,
        product_code: values.product_code || undefined,
        tags: values.tags ? values.tags.split(',').map((t) => t.trim()).filter(Boolean) : [],
      },
      {
        onSuccess: () => {
          setFile(null);
          reset();
          onUploaded?.();
        },
      },
    );
  };

  return (
    <form onSubmit={handleSubmit(onSubmit)} className="space-y-3">
      <div>
        <Label htmlFor="file">Arquivo PDF</Label>
        <Input
          id="file"
          type="file"
          accept="application/pdf"
          onChange={(e) => setFile(e.target.files?.[0] ?? null)}
        />
        {file && (
          <div className="text-2xs text-muted-foreground mt-1">
            {file.name} · {(file.size / 1024).toFixed(0)} KB
          </div>
        )}
      </div>
      <div>
        <Label htmlFor="title">Título</Label>
        <Input id="title" {...register('title')} placeholder="Ex: Verniz PU 6827 — Boletim técnico" />
        {errors.title && <div className="text-2xs text-status-error mt-1">{errors.title.message}</div>}
      </div>
      <div>
        <Label htmlFor="type">Tipo</Label>
        <Controller
          control={control}
          name="type"
          render={({ field }) => (
            <Select value={field.value} onValueChange={field.onChange}>
              <SelectTrigger id="type">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {Object.entries(KB_DOCUMENT_TYPE_LABEL).map(([k, label]) => (
                  <SelectItem key={k} value={k}>
                    {label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
        />
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div>
          <Label htmlFor="supplier">Fornecedor</Label>
          <Input id="supplier" {...register('supplier')} placeholder="sayerlack, farben…" />
        </div>
        <div>
          <Label htmlFor="product_code">Código produto</Label>
          <Input id="product_code" {...register('product_code')} placeholder="FO20.6827.00" />
        </div>
      </div>
      <div>
        <Label htmlFor="tags">Tags (separe por vírgula)</Label>
        <Input id="tags" {...register('tags')} placeholder="madeira, pu, fosco" />
      </div>
      <Button type="submit" disabled={!file || upload.isPending} className="w-full">
        {upload.isPending ? (
          <Loader2 className="w-3.5 h-3.5 animate-spin mr-2" />
        ) : (
          <Upload className="w-3.5 h-3.5 mr-2" />
        )}
        Enviar e indexar
      </Button>
    </form>
  );
}
