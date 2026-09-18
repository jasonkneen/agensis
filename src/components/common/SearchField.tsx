import { Search } from 'lucide-react';
import { Input } from '@agensis/ui/components/input';
import { cn } from '@/lib/utils';

// A search input with the glyph inside it. Five windows drew this by hand —
// the same relative wrapper, the same absolutely-positioned icon, the same
// `h-8 pl-8 text-sm` on the Input — which is five places for the icon's inset
// and the input's padding to drift apart. The sidebar's search is NOT this:
// it is a semantic `.sidebar-search` surface with its own frosting rules.

type SearchFieldProps = Omit<React.ComponentPropsWithoutRef<typeof Input>, 'type'> & {
  /** The wrapper's classes: width, margins. The Input's own go on `inputClassName`. */
  className?: string;
  inputClassName?: string;
};

export function SearchField({ className, inputClassName, ...props }: SearchFieldProps) {
  return (
    <div className={cn('relative', className)}>
      <Search aria-hidden="true" className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
      <Input type="search" {...props} className={cn('h-8 pl-8 text-sm', inputClassName)} />
    </div>
  );
}
