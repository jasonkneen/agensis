import { useEffect, useState } from 'react';
import { Check, Copy } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@agensis/ui/components/button';

/** Copies a message's markdown; the icon confirms with a check for 1.5s. */
export function CopyMessageButton({ markdown }: { markdown: string }) {
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), 1500);
    return () => window.clearTimeout(timer);
  }, [copied]);

  return (
    <Button
      type="button"
      variant="ghost"
      size="icon-xs"
      aria-label={copied ? 'Copied' : 'Copy message'}
      title={copied ? 'Copied' : 'Copy message'}
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(markdown);
          setCopied(true);
        } catch {
          toast.error("Couldn't copy that");
        }
      }}
    >
      {copied ? <Check /> : <Copy />}
    </Button>
  );
}
