import {
  Carousel,
  CarouselContent,
  CarouselItem,
  CarouselNext,
  CarouselPrevious,
} from '@/components/ui/carousel';
import { cn } from '@/lib/utils';
import { WireframeDemo } from './WireframeDemo';
import type { GallerySlide } from '@/lib/wireframeScenes';

// ---------------------------------------------------------------------------
// The panel above the release notes: a slider where each slide pairs an
// animated wireframe demo (left) with its explanation (right).
//
// Built on the existing Carousel primitive (embla) rather than a hand-rolled
// slider, so it inherits the app's arrow buttons, keyboard handling and drag
// behaviour instead of growing a second set that behaves almost-but-not-quite
// the same.
//
// The demo/prose split stacks on a narrow dialog: at ~32rem a 16:10 diagram
// beside two lines of text leaves both too small to read, and a demo nobody
// can see is worse than no demo.
// ---------------------------------------------------------------------------

export interface FeatureGalleryProps {
  slides: GallerySlide[];
  className?: string;
}

export function FeatureGallery({ slides, className }: FeatureGalleryProps) {
  if (slides.length === 0) return null;

  return (
    <section
      // A CONTAINER query, not a viewport one: this lives in a dialog whose
      // width has nothing to do with the window's, so the stacking point has to
      // be decided by the panel's own size.
      className={cn('@container/gallery rounded-xl border border-border/70 bg-card/60 p-3', className)}
      aria-label="Feature highlights"
    >
      <Carousel className="w-full" opts={{ loop: true }}>
        <CarouselContent>
          {slides.map(slide => (
            <CarouselItem key={slide.id}>
              <div className="grid items-center gap-4 @md/gallery:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
                <WireframeDemo scene={slide.scene} className="aspect-[16/10]" />
                <div className="flex flex-col gap-1.5">
                  <h3 className="text-sm font-semibold text-foreground">{slide.title}</h3>
                  <p className="text-sm leading-snug text-muted-foreground">{slide.body}</p>
                </div>
              </div>
            </CarouselItem>
          ))}
        </CarouselContent>
        {/* Controls sit inside the padded panel rather than the default
            outside-the-edge placement, which would clip against the dialog. */}
        <CarouselPrevious className="left-1" />
        <CarouselNext className="right-1" />
      </Carousel>
    </section>
  );
}
