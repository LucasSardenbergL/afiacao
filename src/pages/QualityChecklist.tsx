import { useState, useEffect } from 'react';
import { useParams } from 'react-router-dom';
import { Header } from '@/components/Header';
import { BottomNav } from '@/components/BottomNav';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/contexts/AuthContext';
import { useToast } from '@/hooks/use-toast';
import { Loader2, Camera, CheckCircle2, XCircle, Upload, Shield } from 'lucide-react';

interface OrderItem {
  category: string;
  quantity: number;
  toolName?: string;
  photos?: string[];
}

interface Checklist {
  id: string;
  item_index: number;
  sharpness_ok: boolean;
  balance_ok: boolean;
  finish_ok: boolean;
  dimensions_ok: boolean;
  before_photos: string[];
  after_photos: string[];
  notes: string | null;
  approved: boolean;
}

const CRITERIA = [
  { key: 'sharpness_ok', label: 'Fio de Corte', description: 'Afiação uniforme e no ângulo correto' },
  { key: 'balance_ok', label: 'Balanceamento', description: 'Ferramenta balanceada sem vibrações' },
  { key: 'finish_ok', label: 'Acabamento', description: 'Superfície sem marcas ou imperfeições' },
  { key: 'dimensions_ok', label: 'Dimensões', description: 'Medidas dentro da tolerância' },
] as const;

const QualityChecklist = () => {
  const { id: orderId } = useParams<{ id: string }>();
  const { user, isStaff } = useAuth();
  const { toast } = useToast();

  const [orderItems, setOrderItems] = useState<OrderItem[]>([]);
  const [checklists, setChecklists] = useState<Map<number, Checklist>>(new Map());
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [uploadingPhoto, setUploadingPhoto] = useState<{ index: number; type: 'before' | 'after' } | null>(null);

  useEffect(() => {
    if (orderId && isStaff) loadData();
  }, [orderId, isStaff]);

  const loadData = async () => {
    if (!orderId) return;
    try {
      const [orderRes, checklistRes] = await Promise.all([
        supabase.from('orders').select('items').eq('id', orderId).single(),
        (supabase as any).from('quality_checklists').select('*').eq('order_id', orderId),
      ]);

      if (orderRes.data) {
        const items = Array.isArray(orderRes.data.items) ? orderRes.data.items : [];
        setOrderItems(items.map((item: unknown) => {
          const i = item as Record<string, unknown>;
          return {
            category: (i.category as string) || '',
            quantity: (i.quantity as number) || 1,
            toolName: (i.toolName as string) || '',
            photos: (i.photos as string[]) || [],
          };
        }));
      }

      if (checklistRes.data) {
        const map = new Map<number, Checklist>();
        (checklistRes.data as any[]).forEach((cl) => {
          map.set(cl.item_index, {
            ...cl,
            before_photos: cl.before_photos || [],
            after_photos: cl.after_photos || [],
          });
        });
        setChecklists(map);
      }
    } catch (error) {
      console.error('Error loading data:', error);
    } finally {
      setLoading(false);
    }
  };

  const getOrCreateChecklist = (itemIndex: number): Checklist => {
    return checklists.get(itemIndex) || {
      id: '',
      item_index: itemIndex,
      sharpness_ok: false,
      balance_ok: false,
      finish_ok: false,
      dimensions_ok: false,
      before_photos: [],
      after_photos: [],
      notes: null,
      approved: false,
    };
  };

  const updateChecklistField = (itemIndex: number, field: string, value: unknown) => {
    const current = getOrCreateChecklist(itemIndex);
    setChecklists(prev => new Map(prev).set(itemIndex, { ...current, [field]: value }));
  };

  const handlePhotoUpload = async (itemIndex: number, type: 'before' | 'after', e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file || !orderId) return;

    setUploadingPhoto({ index: itemIndex, type });
    try {
      const fileName = `${orderId}/${itemIndex}/${type}_${Date.now()}.${file.name.split('.').pop()}`;
      const { data, error } = await supabase.storage.from('tool-photos').upload(fileName, file, { cacheControl: '3600', upsert: false });
      if (error) throw error;

      const { data: urlData } = supabase.storage.from('tool-photos').getPublicUrl(data.path);
      const current = getOrCreateChecklist(itemIndex);
      const photoField = type === 'before' ? 'before_photos' : 'after_photos';
      const updatedPhotos = [...current[photoField], urlData.publicUrl];
      updateChecklistField(itemIndex, photoField, updatedPhotos);
      toast({ title: 'Foto enviada!' });
    } catch (error) {
      console.error('Error uploading photo:', error);
      toast({ title: 'Erro ao enviar foto', variant: 'destructive' });
    } finally {
      setUploadingPhoto(null);
    }
  };

  const saveChecklist = async (itemIndex: number) => {
    if (!orderId || !user) return;
    setSaving(true);

    try {
      const cl = getOrCreateChecklist(itemIndex);
      const allOk = cl.sharpness_ok && cl.balance_ok && cl.finish_ok && cl.dimensions_ok;

      if (cl.after_photos.length === 0) {
        toast({ title: 'Foto obrigatória', description: 'Adicione pelo menos uma foto "Depois"', variant: 'destructive' });
        setSaving(false);
        return;
      }

      const payload = {
        order_id: orderId,
        item_index: itemIndex,
        inspector_id: user.id,
        sharpness_ok: cl.sharpness_ok,
        balance_ok: cl.balance_ok,
        finish_ok: cl.finish_ok,
        dimensions_ok: cl.dimensions_ok,
        before_photos: cl.before_photos,
        after_photos: cl.after_photos,
        notes: cl.notes,
        approved: allOk,
        updated_at: new Date().toISOString(),
      };

      if (cl.id) {
        const { error } = await (supabase as any).from('quality_checklists').update(payload).eq('id', cl.id);
        if (error) throw error;
      } else {
        const { data: inserted, error } = await (supabase as any).from('quality_checklists').insert(payload).select().single();
        if (error) throw error;
        if (inserted) {
          setChecklists(prev => new Map(prev).set(itemIndex, { ...cl, id: (inserted as any).id, approved: allOk }));
        }
      }

      toast({ title: allOk ? '✅ Item aprovado!' : '⚠️ Checklist salvo com pendências' });
    } catch (error) {
      console.error('Error saving checklist:', error);
      toast({ title: 'Erro ao salvar', variant: 'destructive' });
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return (
      <div className="min-h-screen bg-background pb-24">
        <Header title="Controle de Qualidade" showBack />
        <div className="flex items-center justify-center pt-32">
          <Loader2 className="w-8 h-8 animate-spin text-primary" />
        </div>
        <BottomNav />
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-background pb-24">
      <Header title="Controle de Qualidade" showBack />
      <main className="pt-16 px-4 max-w-lg mx-auto">
        <div className="flex items-center gap-2 mb-4">
          <Shield className="w-5 h-5 text-primary" />
          <p className="text-sm text-muted-foreground">Preencha o checklist para cada ferramenta. Foto "Depois" é obrigatória.</p>
        </div>

        {orderItems.map((item, index) => {
          const cl = getOrCreateChecklist(index);
          const allOk = cl.sharpness_ok && cl.balance_ok && cl.finish_ok && cl.dimensions_ok;

          return (
            <Card key={index} className="mb-4">
              <CardHeader className="pb-2">
                <div className="flex items-center justify-between">
                  <CardTitle className="text-base">
                    {item.toolName || item.category} ({item.quantity}x)
                  </CardTitle>
                  {cl.id && (
                    <Badge variant={cl.approved ? 'default' : 'secondary'} className={cl.approved ? 'bg-emerald-500' : ''}>
                      {cl.approved ? <><CheckCircle2 className="w-3 h-3 mr-1" /> Aprovado</> : <><XCircle className="w-3 h-3 mr-1" /> Pendente</>}
                    </Badge>
                  )}
                </div>
              </CardHeader>
              <CardContent className="space-y-4">
                {item.photos && item.photos.length > 0 && (
                  <div>
                    <Label className="text-xs text-muted-foreground mb-1 block">📷 Fotos do cliente (antes)</Label>
                    <div className="flex gap-2 overflow-x-auto pb-1">
                      {item.photos.map((photo, pi) => (
                        <img key={pi} src={photo} alt={`Antes ${pi + 1}`} className="w-16 h-16 object-cover rounded-lg border" />
                      ))}
                    </div>
                  </div>
                )}

                <div>
                  <Label className="text-xs text-muted-foreground mb-1 block">📷 Foto Antes (funcionário)</Label>
                  <div className="flex gap-2 items-center flex-wrap">
                    {cl.before_photos.map((photo, pi) => (
                      <img key={pi} src={photo} alt={`Antes ${pi + 1}`} className="w-16 h-16 object-cover rounded-lg border" />
                    ))}
                    <label className="w-16 h-16 border-2 border-dashed border-border rounded-lg flex items-center justify-center cursor-pointer hover:border-primary/50 transition-colors">
                      {uploadingPhoto?.index === index && uploadingPhoto.type === 'before' ? (
                        <Loader2 className="w-5 h-5 animate-spin text-muted-foreground" />
                      ) : (
                        <Camera className="w-5 h-5 text-muted-foreground" />
                      )}
                      <input type="file" accept="image/*" capture="environment" className="hidden" onChange={e => handlePhotoUpload(index, 'before', e)} />
                    </label>
                  </div>
                </div>

                <div>
                  <Label className="text-xs text-muted-foreground mb-1 block">📷 Foto Depois (obrigatória) *</Label>
                  <div className="flex gap-2 items-center flex-wrap">
                    {cl.after_photos.map((photo, pi) => (
                      <img key={pi} src={photo} alt={`Depois ${pi + 1}`} className="w-16 h-16 object-cover rounded-lg border border-primary/30" />
                    ))}
                    <label className="w-16 h-16 border-2 border-dashed border-primary/40 rounded-lg flex items-center justify-center cursor-pointer hover:border-primary transition-colors bg-primary/5">
                      {uploadingPhoto?.index === index && uploadingPhoto.type === 'after' ? (
                        <Loader2 className="w-5 h-5 animate-spin text-primary" />
                      ) : (
                        <Upload className="w-5 h-5 text-primary" />
                      )}
                      <input type="file" accept="image/*" capture="environment" className="hidden" onChange={e => handlePhotoUpload(index, 'after', e)} />
                    </label>
                  </div>
                </div>

                <div className="space-y-3">
                  {CRITERIA.map(c => (
                    <label key={c.key} className="flex items-start gap-3 p-2 rounded-lg hover:bg-muted cursor-pointer">
                      <Checkbox
                        checked={(cl as any)[c.key]}
                        onCheckedChange={v => updateChecklistField(index, c.key, v)}
                        className="mt-0.5"
                      />
                      <div>
                        <p className="text-sm font-medium">{c.label}</p>
                        <p className="text-xs text-muted-foreground">{c.description}</p>
                      </div>
                    </label>
                  ))}
                </div>

                <div>
                  <Label className="text-xs mb-1 block">Observações</Label>
                  <Textarea
                    value={cl.notes || ''}
                    onChange={e => updateChecklistField(index, 'notes', e.target.value)}
                    placeholder="Anomalias, danos encontrados..."
                    rows={2}
                  />
                </div>

                <Button
                  className="w-full"
                  onClick={() => saveChecklist(index)}
                  disabled={saving}
                  variant={allOk && cl.after_photos.length > 0 ? 'default' : 'outline'}
                >
                  {saving ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <CheckCircle2 className="w-4 h-4 mr-2" />}
                  {allOk ? 'Aprovar Item' : 'Salvar Checklist'}
                </Button>
              </CardContent>
            </Card>
          );
        })}

        {orderItems.length === 0 && (
          <div className="text-center py-12">
            <p className="text-muted-foreground">Nenhum item encontrado neste pedido</p>
          </div>
        )}
      </main>
      <BottomNav />
    </div>
  );
};

export default QualityChecklist;
