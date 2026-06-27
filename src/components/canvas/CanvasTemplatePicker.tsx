import { LayoutTemplate } from 'lucide-react';
import type { CanvasTemplate } from '../../lib/canvasTemplates';
import { CANVAS_TEMPLATES } from '../../lib/canvasTemplates';
import type { CanvasAppDefinition } from '../../lib/canvasApps';
import { CANVAS_APPS } from '../../lib/canvasApps';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent } from '@/components/ui/card';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Marker, MarkerContent } from '@/components/ui/marker';
import { ScrollArea } from '@/components/ui/scroll-area';
import { cn } from '@/lib/utils';

interface CanvasTemplatePickerProps {
  open: boolean;
  onClose: () => void;
  onApply: (template: CanvasTemplate) => void;
  onCreateApp: (app: CanvasAppDefinition) => void;
}

const CanvasTemplatePicker = ({ open, onClose, onApply, onCreateApp }: CanvasTemplatePickerProps) => {
  const handleApply = (template: CanvasTemplate) => {
    onApply(template);
    onClose();
  };

  const handleCreateApp = (app: CanvasAppDefinition) => {
    onCreateApp(app);
    onClose();
  };

  return (
    <Dialog
      open={open}
      onOpenChange={nextOpen => {
        if (!nextOpen) onClose();
      }}
    >
      <DialogContent className="w-[calc(100vw-2rem)] max-w-3xl p-0">
        <DialogHeader className="border-b px-5 py-4">
          <DialogTitle className="flex items-center gap-2">
            <LayoutTemplate data-icon="inline-start" />
            Canvas Apps
          </DialogTitle>
          <DialogDescription className="max-w-xl">
            Add applets or structured layouts to the current canvas.
          </DialogDescription>
        </DialogHeader>

        <ScrollArea className="max-h-[min(62vh,520px)]">
          <div className="flex flex-col gap-5 p-5">
            <section className="flex flex-col gap-3">
              <Marker variant="separator">
                <MarkerContent>Applets</MarkerContent>
              </Marker>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
                {CANVAS_APPS.map(app => (
                  <Card
                    key={app.id}
                    role="button"
                    tabIndex={0}
                    size="sm"
                    className="min-h-40 cursor-pointer rounded-lg transition-colors hover:bg-muted/50 focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
                    onClick={() => handleCreateApp(app)}
                    onKeyDown={event => {
                      if (event.key === 'Enter' || event.key === ' ') {
                        event.preventDefault();
                        handleCreateApp(app);
                      }
                    }}
                  >
                    <CardContent className="flex h-full min-h-40 flex-col gap-3 p-4">
                      <span className="text-base font-semibold leading-snug text-foreground">{app.name}</span>
                      <span className="text-sm leading-relaxed text-muted-foreground">{app.description}</span>
                      <Badge variant="secondary" className="mt-auto w-fit text-xs">
                        HTML applet
                      </Badge>
                    </CardContent>
                  </Card>
                ))}
              </div>
            </section>

            <section className="flex flex-col gap-3">
              <Marker variant="separator">
                <MarkerContent>Layouts</MarkerContent>
              </Marker>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
                {CANVAS_TEMPLATES.map(template => (
                  <Card
                    key={template.id}
                    role="button"
                    tabIndex={0}
                    size="sm"
                    className={cn(
                      'min-h-44 cursor-pointer rounded-lg transition-colors hover:bg-muted/50 focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50',
                    )}
                    onClick={() => handleApply(template)}
                    onKeyDown={event => {
                      if (event.key === 'Enter' || event.key === ' ') {
                        event.preventDefault();
                        handleApply(template);
                      }
                    }}
                  >
                    <CardContent className="flex h-full min-h-44 flex-col gap-3 p-4">
                      <span className="text-2xl leading-none">{template.icon}</span>
                      <span className="text-base font-semibold leading-snug text-foreground">{template.name}</span>
                      <span className="text-sm leading-relaxed text-muted-foreground">{template.description}</span>
                      <Badge variant="outline" className="mt-auto w-fit text-xs">
                        {template.objects.length} objects
                      </Badge>
                    </CardContent>
                  </Card>
                ))}
              </div>
            </section>
          </div>
        </ScrollArea>
      </DialogContent>
    </Dialog>
  );
};

export default CanvasTemplatePicker;
