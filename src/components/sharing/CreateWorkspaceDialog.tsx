import { useEffect, useState } from 'react';
import { FolderPlus } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  Field,
  FieldGroup,
  FieldLabel,
} from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Spinner } from '@/components/ui/spinner';

interface CreateWorkspaceDialogProps {
  open: boolean;
  onClose: () => void;
  onCreate: (values: { name: string; description: string; icon: string }) => Promise<void>;
}

export function CreateWorkspaceDialog({
  open,
  onClose,
  onCreate,
}: CreateWorkspaceDialogProps) {
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [icon, setIcon] = useState('🗂️');
  const [creating, setCreating] = useState(false);

  useEffect(() => {
    if (!open) return;
    setName('');
    setDescription('');
    setIcon('🗂️');
    setCreating(false);
  }, [open]);

  const handleSubmit = async () => {
    if (!name.trim() || creating) return;
    setCreating(true);
    try {
      await onCreate({
        name: name.trim(),
        description: description.trim(),
        icon: icon.trim() || '🗂️',
      });
    } finally {
      setCreating(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={nextOpen => { if (!nextOpen) onClose(); }}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader className="pr-8">
          <div className="flex items-center gap-3">
            <div className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-muted">
              <FolderPlus className="size-5" />
            </div>
            <div className="min-w-0">
              <DialogTitle>Create workspace</DialogTitle>
              <DialogDescription>
                Create a shared place for docs, chat, files, and canvas.
              </DialogDescription>
            </div>
          </div>
        </DialogHeader>

        <FieldGroup>
          <Field>
            <FieldLabel htmlFor="workspace-name">Name</FieldLabel>
            <Input
              id="workspace-name"
              autoFocus
              value={name}
              onChange={e => setName(e.target.value)}
              placeholder="My workspace"
              onKeyDown={e => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  handleSubmit();
                }
              }}
            />
          </Field>

          <div className="grid grid-cols-[5.25rem_1fr] gap-3">
            <Field>
              <FieldLabel htmlFor="workspace-icon">Icon</FieldLabel>
              <Input
                id="workspace-icon"
                value={icon}
                onChange={e => setIcon(e.target.value)}
                placeholder="🗂️"
                maxLength={4}
                className="text-center text-lg"
              />
            </Field>

            <Field>
              <FieldLabel htmlFor="workspace-description">Description</FieldLabel>
              <Input
                id="workspace-description"
                value={description}
                onChange={e => setDescription(e.target.value)}
                placeholder="Optional"
              />
            </Field>
          </div>
        </FieldGroup>

        <DialogFooter>
          <Button type="button" variant="outline" onClick={onClose} disabled={creating}>
            Cancel
          </Button>
          <Button type="button" onClick={handleSubmit} disabled={!name.trim() || creating}>
            {creating ? <Spinner data-icon="inline-start" /> : <FolderPlus data-icon="inline-start" />}
            Create workspace
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
