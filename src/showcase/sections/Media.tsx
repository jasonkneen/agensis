import { useState } from 'react';
import { SectionShell, Example } from '@/showcase/SectionShell';
import {
  Carousel,
  CarouselContent,
  CarouselItem,
  CarouselPrevious,
  CarouselNext,
} from '@/components/ui/carousel';
import { Calendar } from '@/components/ui/calendar';

const slides = ['One', 'Two', 'Three', 'Four', 'Five'];

export default function MediaSection() {
  const [date, setDate] = useState<Date | undefined>(new Date());

  return (
    <SectionShell title="Media" description="Carousel and calendar">
      <Example label="Carousel" full>
        <div className="px-12">
          <Carousel className="w-full max-w-xs" opts={{ loop: true }}>
            <CarouselContent>
              {slides.map((slide) => (
                <CarouselItem key={slide}>
                  <div className="flex aspect-video items-center justify-center rounded-lg border border-border bg-muted">
                    <span className="text-3xl font-semibold text-foreground">{slide}</span>
                  </div>
                </CarouselItem>
              ))}
            </CarouselContent>
            <CarouselPrevious />
            <CarouselNext />
          </Carousel>
        </div>
      </Example>

      <Example label="Calendar" full>
        <div className="flex flex-col gap-2">
          <Calendar
            mode="single"
            selected={date}
            onSelect={setDate}
            className="rounded-md border border-border"
          />
          <span className="text-sm text-muted-foreground">
            Selected: {date ? date.toLocaleDateString() : 'none'}
          </span>
        </div>
      </Example>
    </SectionShell>
  );
}
