import { Bar, BarChart, Cell, Pie, PieChart, XAxis, YAxis } from 'recharts';
import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from '@agensis/ui/components/chart';

/**
 * The Usage tab's visuals.
 *
 * Deliberately its own module so the settings dialog can lazy-import it:
 * recharts is ~1.1MB and this is the only surface in the shipped app that
 * renders a chart, so bundling it into the index chunk would make every user
 * download it to open a settings tab most never visit. Kept out, it arrives
 * only when this panel does.
 *
 * Values are pre-formatted by the caller — this component does no unit maths,
 * so the numbers on the axis always agree with the numbers on the cards beside
 * them.
 */

export interface UsageChartsProps {
  storage: Array<{ label: string; bytes: number }>;
  counts: Array<{ label: string; value: number }>;
  formatBytes: (bytes: number) => string;
}

/* Chart colours come from the theme's chart ramp, so they change with the
   palette instead of pinning one hard-coded hue per series. */
const STORAGE_COLORS = ['var(--chart-1)', 'var(--chart-2)'];

export default function UsageCharts({ storage, counts, formatBytes }: UsageChartsProps) {
  const storageTotal = storage.reduce((sum, slice) => sum + slice.bytes, 0);
  const countsTotal = counts.reduce((sum, item) => sum + item.value, 0);

  const storageConfig: ChartConfig = Object.fromEntries(
    storage.map((slice, index) => [
      slice.label,
      { label: slice.label, color: STORAGE_COLORS[index % STORAGE_COLORS.length] },
    ]),
  );
  const countsConfig: ChartConfig = { value: { label: 'Count', color: 'var(--chart-1)' } };

  return (
    <div className="grid gap-4 sm:grid-cols-2">
      <div className="rounded-lg border border-border p-3">
        <div className="text-xs font-medium">Storage split</div>
        <div className="mt-0.5 text-2xs text-muted-foreground">{formatBytes(storageTotal)} total</div>
        {storageTotal > 0 ? (
          <ChartContainer config={storageConfig} className="mt-2 h-40 w-full">
            <PieChart>
              <ChartTooltip content={<ChartTooltipContent hideLabel />} />
              <Pie data={storage} dataKey="bytes" nameKey="label" innerRadius={34} outerRadius={58} paddingAngle={2}>
                {storage.map((slice, index) => (
                  <Cell key={slice.label} fill={STORAGE_COLORS[index % STORAGE_COLORS.length]} />
                ))}
              </Pie>
            </PieChart>
          </ChartContainer>
        ) : (
          /* A donut of nothing is a grey ring that looks like a loading state.
             Say the real thing instead. */
          <div className="mt-2 flex h-40 items-center justify-center text-xs text-muted-foreground">
            Nothing stored yet
          </div>
        )}
      </div>

      <div className="rounded-lg border border-border p-3">
        <div className="text-xs font-medium">Entity counts</div>
        <div className="mt-0.5 text-2xs text-muted-foreground">{countsTotal.toLocaleString()} items</div>
        {countsTotal > 0 ? (
          <ChartContainer config={countsConfig} className="mt-2 h-40 w-full">
            <BarChart data={counts} layout="vertical" margin={{ left: 4, right: 8 }}>
              <XAxis type="number" hide />
              <YAxis
                type="category"
                dataKey="label"
                width={86}
                tickLine={false}
                axisLine={false}
                tick={{ fontSize: 10 }}
              />
              <ChartTooltip content={<ChartTooltipContent hideLabel />} />
              <Bar dataKey="value" fill="var(--chart-1)" radius={3} />
            </BarChart>
          </ChartContainer>
        ) : (
          <div className="mt-2 flex h-40 items-center justify-center text-xs text-muted-foreground">
            Nothing here yet
          </div>
        )}
      </div>
    </div>
  );
}
