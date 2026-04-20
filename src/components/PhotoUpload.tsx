import { useState, useRef } from 'react';
import { Button } from '@/components/ui/button';
import { supabase } from '@/integrations/supabase/client';
import { useToast } from '@/hooks/use-toast';
import { logger } from '@/lib/logger';
import { Camera, X, Loader2, Image as ImageIcon } from 'lucide-react';
import { cn } from '@/lib/utils';

interface PhotoUploadProps {
  photos: string[];
  onPhotosChange: (photos: string[]) => void;
  userId: string;
  maxPhotos?: number;
  disabled?: boolean;
}

export function PhotoUpload({ photos, onPhotosChange, userId, maxPhotos = 5, disabled = false }: PhotoUploadProps) {
  const { toast } = useToast();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);

  const handleFileSelect = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const files = event.target.files;
    if (!files || files.length === 0) return;

    if (photos.length + files.length > maxPhotos) {
      toast({
        title: 'Limite de fotos',
        description: `Você pode adicionar no máximo ${maxPhotos} fotos`,
        variant: 'destructive',
      });
      return;
    }

    setUploading(true);
    const newPhotos: string[] = [];

    try {
      for (const file of Array.from(files)) {
        // Validate file type
        if (!file.type.startsWith('image/')) {
          toast({
            title: 'Arquivo inválido',
            description: 'Apenas imagens são permitidas',
            variant: 'destructive',
          });
          continue;
        }

        // Validate file size (max 5MB)
        if (file.size > 5 * 1024 * 1024) {
          toast({
            title: 'Arquivo muito grande',
            description: 'O tamanho máximo é 5MB por foto',
            variant: 'destructive',
          });
          continue;
        }

        // Generate unique filename
        const fileExt = file.name.split('.').pop();
        const fileName = `${userId}/${Date.now()}-${Math.random().toString(36).substring(7)}.${fileExt}`;

        // Upload to Supabase Storage
        const { data, error } = await supabase.storage
          .from('tool-photos')
          .upload(fileName, file);

        if (error) {
          logger.error('Failed to upload photo', {
            stage: 'upload',
            fileSize: file.size,
            fileType: file.type,
            error,
          });
          toast({
            title: 'Erro ao enviar foto',
            description: error.message,
            variant: 'destructive',
          });
          continue;
        }

        // Get public URL
        const { data: urlData } = supabase.storage
          .from('tool-photos')
          .getPublicUrl(data.path);

        newPhotos.push(urlData.publicUrl);
      }

      if (newPhotos.length > 0) {
        onPhotosChange([...photos, ...newPhotos]);
        toast({
          title: 'Fotos adicionadas!',
          description: `${newPhotos.length} foto(s) enviada(s) com sucesso`,
        });
      }
    } catch (error) {
      logger.error('Unexpected error uploading photos', { stage: 'upload', error });
      toast({
        title: 'Erro ao enviar fotos',
        description: 'Tente novamente',
        variant: 'destructive',
      });
    } finally {
      setUploading(false);
      // Reset input
      if (fileInputRef.current) {
        fileInputRef.current.value = '';
      }
    }
  };

  const removePhoto = async (photoUrl: string) => {
    try {
      // Extract path from URL
      const urlParts = photoUrl.split('/tool-photos/');
      if (urlParts.length === 2) {
        const path = urlParts[1];
        await supabase.storage.from('tool-photos').remove([path]);
      }
      onPhotosChange(photos.filter(p => p !== photoUrl));
    } catch (error) {
      logger.warn('Failed to remove photo from storage (removing from UI anyway)', {
        stage: 'persist_url',
        error,
      });
      // Still remove from UI even if storage delete fails
      onPhotosChange(photos.filter(p => p !== photoUrl));
    }
  };

  return (
    <div className="space-y-3">
      <input
        ref={fileInputRef}
        type="file"
        accept="image/*"
        multiple
        onChange={handleFileSelect}
        className="hidden"
        disabled={disabled || uploading}
      />

      {/* Photo grid */}
      {photos.length > 0 && (
        <div className="grid grid-cols-4 gap-2">
          {photos.map((photo, index) => (
            <div key={index} className="relative aspect-square rounded-lg overflow-hidden group">
              <img
                src={photo}
                alt={`Foto ${index + 1}`}
                className="w-full h-full object-cover"
              />
              {!disabled && (
                <button
                  onClick={() => removePhoto(photo)}
                  className="absolute top-1 right-1 w-6 h-6 bg-destructive text-destructive-foreground rounded-full flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity"
                >
                  <X className="w-3 h-3" />
                </button>
              )}
            </div>
          ))}
        </div>
      )}

      {/* Add photo button */}
      {photos.length < maxPhotos && !disabled && (
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="w-full"
          onClick={() => fileInputRef.current?.click()}
          disabled={uploading}
        >
          {uploading ? (
            <>
              <Loader2 className="w-4 h-4 mr-2 animate-spin" />
              Enviando...
            </>
          ) : (
            <>
              <Camera className="w-4 h-4 mr-2" />
              Adicionar foto ({photos.length}/{maxPhotos})
            </>
          )}
        </Button>
      )}

      {photos.length === 0 && !uploading && (
        <div 
          onClick={() => !disabled && fileInputRef.current?.click()}
          className={cn(
            "border-2 border-dashed border-border rounded-lg p-6 text-center",
            !disabled && "cursor-pointer hover:border-primary/50 hover:bg-primary/5 transition-colors"
          )}
        >
          <ImageIcon className="w-8 h-8 text-muted-foreground mx-auto mb-2" />
          <p className="text-sm text-muted-foreground">
            Tire fotos da ferramenta para auxiliar na análise
          </p>
        </div>
      )}
    </div>
  );
}
