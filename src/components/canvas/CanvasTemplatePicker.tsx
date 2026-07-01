import { LayoutTemplate, Plus } from 'lucide-react';
import type { CanvasAppDefinition } from '../../lib/canvasApps';
import { CANVAS_APPS, APPLETS_FOLDER, extractHtmlFromDocContent } from '../../lib/canvasApps';
import type { Document } from '../../types';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent } from '@/components/ui/card';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { ScrollArea } from '@/components/ui/scroll-area';

interface CanvasTemplatePickerProps {
  open: boolean;
  onClose: () => void;
  onCreateApp: (app: CanvasAppDefinition) => void;
  onCreateDocApp?: (doc: Document) => void;
  onCreateCustomApp: () => void;
  documents?: Document[];
}

const CanvasTemplatePicker = ({ open, onClose, onCreateApp, onCreateDocApp, onCreateCustomApp, documents = [] }: CanvasTemplatePickerProps) => {
  const appletDocs = documents.filter(d => d.folder === APPLETS_FOLDER && !!extractHtmlFromDocContent(d.content ?? ''));

  const handleCreateApp = (app: CanvasAppDefinition) => {
    onCreateApp(app);
    onClose();
  };

  const handleCreateDocApp = (doc: Document) => {
    onCreateDocApp?.(doc);
    onClose();
  };

  const handleCreateCustomApp = () => {
    onCreateCustomApp();
    onClose();
  };

  return (
    <Dialog
      open={open}
      onOpenChange={nextOpen => {
        if (!nextOpen) onClose();
      }}
    >
      <DialogContent className="w-[min(920px,calc(100vw-2rem))] max-w-none p-0 sm:max-w-none">
        <DialogHeader className="border-b px-5 py-4">
          <DialogTitle className="flex items-center gap-2">
            <LayoutTemplate data-icon="inline-start" />
            Canvas Apps
          </DialogTitle>
          <DialogDescription className="max-w-xl">
            Add applets to the current canvas.
          </DialogDescription>
        </DialogHeader>

        <ScrollArea className="max-h-[min(62vh,520px)]">
          <div className="p-5">
            <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
              <Card
                role="button"
                tabIndex={0}
                size="sm"
                className="cursor-pointer rounded-lg border-dashed transition-colors hover:bg-muted/50 focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
                onClick={handleCreateCustomApp}
                onKeyDown={event => {
                  if (event.key === 'Enter' || event.key === ' ') {
                    event.preventDefault();
                    handleCreateCustomApp();
                  }
                }}
              >
                <CardContent className="flex min-h-36 flex-col justify-between gap-4 p-4">
                  <div className="flex items-start gap-3">
                    <span className="grid size-9 shrink-0 place-items-center rounded-full border border-border bg-secondary text-secondary-foreground">
                      <Plus className="size-4" />
                    </span>
                    <div className="min-w-0">
                      <div className="text-base font-semibold leading-snug text-foreground">New applet</div>
                      <div className="mt-1 max-w-sm text-sm leading-relaxed text-muted-foreground">
                        Open an applet-builder chat with the right SDK brief.
                      </div>
                    </div>
                  </div>
                  <Badge variant="outline" className="w-fit text-xs">
                    AI build brief
                  </Badge>
                </CardContent>
              </Card>
              {CANVAS_APPS.map(app => (
                <Card
                  key={app.id}
                  role="button"
                  tabIndex={0}
                  size="sm"
                  className="cursor-pointer rounded-lg transition-colors hover:bg-muted/50 focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
                  onClick={() => handleCreateApp(app)}
                  onKeyDown={event => {
                    if (event.key === 'Enter' || event.key === ' ') {
                      event.preventDefault();
                      handleCreateApp(app);
                    }
                  }}
                >
                  <CardContent className="flex min-h-36 flex-col gap-3 p-4">
                    <span className="text-base font-semibold leading-snug text-foreground">{app.name}</span>
                    <span className="max-w-sm text-sm leading-relaxed text-muted-foreground">{app.description}</span>
                    <Badge variant="secondary" className="mt-auto w-fit text-xs">
                      HTML applet
                    </Badge>
                  </CardContent>
                </Card>
              ))}
              {appletDocs.map(doc => (
                <Card
                  key={doc.id}
                  role="button"
                  tabIndex={0}
                  size="sm"
                  className="cursor-pointer rounded-lg transition-colors hover:bg-muted/50 focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
                  onClick={() => handleCreateDocApp(doc)}
                  onKeyDown={event => {
                    if (event.key === 'Enter' || event.key === ' ') {
                      event.preventDefault();
                      handleCreateDocApp(doc);
                    }
                  }}
                >
                  <CardContent className="flex min-h-36 flex-col gap-3 p-4">
                    <span className="text-base font-semibold leading-snug text-foreground">{doc.title}</span>
                    <span className="max-w-sm text-sm leading-relaxed text-muted-foreground">Saved applet from the Applets folder</span>
                    <Badge variant="outline" className="mt-auto w-fit text-xs">
                      Saved applet
                    </Badge>
                  </CardContent>
                </Card>
              ))}
            </div>
          </div>
        </ScrollArea>
      </DialogContent>
    </Dialog>
  );
};

export default CanvasTemplatePicker;
