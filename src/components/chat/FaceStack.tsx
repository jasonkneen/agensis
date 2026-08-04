import { Bot } from 'lucide-react';
import { cn } from '../../lib/utils';
import { isImageAvatar, isPetSpritesheetAvatar, renderablePetAssetUrl } from '../../lib/openpets';
import { faceStack, type ReaderFace } from '../../lib/readerFaces';

// The overlapping row of little faces inside a chip: who read this, who
// acknowledged it.
//
// EVERY DECISION IS IN src/lib/readerFaces.ts — the three-face cap, the
// overflow count, the "Someone" fallback. This component renders and nothing
// else, because the frontend runner only sees tests/unit/**/*.test.ts and a
// `.test.tsx` file is outside that glob.
//
// THE FACES ARE `aria-hidden`. Every chip that uses this puts the same fact in
// words on its own aria-label, so a screen reader hears "Seen by Coder and
// Grok" once instead of hearing three unlabelled images and then the sentence.
//
// AN AGENT'S FACE CARRIES ITS ACCENT COLOUR — the same colour its name is drawn
// in on its own messages. That is what makes the chip readable at 16px: you
// recognise the colour before you can resolve the initials.

function Face({ face }: { face: ReaderFace }) {
  const avatar = face.avatar;
  const style = face.accent
    ? { backgroundColor: `color-mix(in srgb, ${face.accent} 22%, transparent)`, color: face.accent }
    : undefined;

  return (
    <span
      // The NAME, never the id. A uuid in the markup is the same identifier
      // leak as a uuid in a tooltip — it lands in any screenshot of the DOM and
      // in every saved page — and the tests for the reaction row already assert
      // against exactly that. "unknown" is the hook for a face that would draw
      // as "Someone".
      data-reader-face={face.name || 'unknown'}
      title={face.name || 'Someone'}
      className={cn(
        'inline-flex size-4 shrink-0 items-center justify-center overflow-hidden rounded-full',
        // The ring is what separates two overlapping faces. It is the chip's
        // own background rather than a border, so the faces read as stacked
        // cards instead of as circles with outlines.
        'ring-1 ring-background',
        face.accent ? '' : 'bg-muted text-muted-foreground',
      )}
      style={style}
    >
      {avatar && isPetSpritesheetAvatar(avatar) ? (
        <span className="animated-pet-avatar-shell size-full">
          <span className="animated-pet-avatar" style={{ backgroundImage: `url(${renderablePetAssetUrl(avatar)})` }} />
        </span>
      ) : avatar && isImageAvatar(avatar) ? (
        <img src={renderablePetAssetUrl(avatar)} alt="" className="size-full object-cover" loading="lazy" draggable={false} />
      ) : face.name ? (
        <span className="text-[8px] font-semibold leading-none">{face.initials}</span>
      ) : face.isAgent ? (
        <Bot className="size-2.5" />
      ) : (
        <span className="text-[8px] font-semibold leading-none">{face.initials}</span>
      )}
    </span>
  );
}

export interface FaceStackProps {
  readerIds: readonly string[];
  resolveFace: (readerId: string) => ReaderFace;
  /** Faces drawn before the row collapses to "+N". See faceStack() for why 3. */
  max?: number;
  className?: string;
}

export function FaceStack({ readerIds, resolveFace, max = 3, className }: FaceStackProps) {
  const { shown, overflow } = faceStack(readerIds, resolveFace, max);
  if (shown.length === 0) return null;

  return (
    <span
      data-face-stack=""
      aria-hidden="true"
      className={cn('inline-flex items-center', className)}
    >
      {shown.map((face, index) => (
        <span key={face.id} className={index === 0 ? '' : '-ml-1'}>
          <Face face={face} />
        </span>
      ))}
      {/* Past the cap a numeral genuinely beats a face: four 16px slivers say
          less than "+4" does. */}
      {overflow > 0 && (
        <span className="ml-1 text-[10px] font-medium tabular-nums">+{overflow}</span>
      )}
    </span>
  );
}
