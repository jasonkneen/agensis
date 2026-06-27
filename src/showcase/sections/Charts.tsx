import { useState } from 'react';
import { Area, AreaChart, Bar, BarChart, CartesianGrid, XAxis } from 'recharts';
import { SectionShell, Example } from '@/showcase/SectionShell';
import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
  ChartLegend,
  ChartLegendContent,
  type ChartConfig,
} from '@/components/ui/chart';
import { Button } from '@/components/ui/button';

const monthlyData = [
  { month: 'Jan', desktop: 186, mobile: 80 },
  { month: 'Feb', desktop: 305, mobile: 200 },
  { month: 'Mar', desktop: 237, mobile: 120 },
  { month: 'Apr', desktop: 173, mobile: 190 },
  { month: 'May', desktop: 209, mobile: 130 },
  { month: 'Jun', desktop: 264, mobile: 140 },
];

const chartConfig = {
  desktop: { label: 'Desktop', color: 'hsl(221 83% 53%)' },
  mobile: { label: 'Mobile', color: 'hsl(142 71% 45%)' },
} satisfies ChartConfig;

export default function ChartsSection() {
  const [showMobile, setShowMobile] = useState(true);

  return (
    <SectionShell title="Charts" description="Recharts-based charts">
      <Example label="Area Chart" full>
        <div className="w-full space-y-3">
          <Button
            variant="outline"
            size="sm"
            onClick={() => setShowMobile((v) => !v)}
          >
            {showMobile ? 'Hide mobile' : 'Show mobile'}
          </Button>
          <ChartContainer config={chartConfig} className="w-full">
            <AreaChart accessibilityLayer data={monthlyData} margin={{ left: 12, right: 12 }}>
              <CartesianGrid vertical={false} />
              <XAxis
                dataKey="month"
                tickLine={false}
                axisLine={false}
                tickMargin={8}
              />
              <ChartTooltip content={<ChartTooltipContent indicator="dot" />} />
              <ChartLegend content={<ChartLegendContent />} />
              <Area
                dataKey="desktop"
                type="natural"
                fill="var(--color-desktop)"
                fillOpacity={0.4}
                stroke="var(--color-desktop)"
                stackId="a"
              />
              {showMobile && (
                <Area
                  dataKey="mobile"
                  type="natural"
                  fill="var(--color-mobile)"
                  fillOpacity={0.4}
                  stroke="var(--color-mobile)"
                  stackId="a"
                />
              )}
            </AreaChart>
          </ChartContainer>
        </div>
      </Example>

      <Example label="Bar Chart" full>
        <ChartContainer config={chartConfig} className="w-full">
          <BarChart accessibilityLayer data={monthlyData} margin={{ left: 12, right: 12 }}>
            <CartesianGrid vertical={false} />
            <XAxis
              dataKey="month"
              tickLine={false}
              axisLine={false}
              tickMargin={8}
            />
            <ChartTooltip content={<ChartTooltipContent indicator="dashed" />} />
            <ChartLegend content={<ChartLegendContent />} />
            <Bar dataKey="desktop" fill="var(--color-desktop)" radius={4} />
            <Bar dataKey="mobile" fill="var(--color-mobile)" radius={4} />
          </BarChart>
        </ChartContainer>
      </Example>
    </SectionShell>
  );
}
