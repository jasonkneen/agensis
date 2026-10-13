import { Area, AreaChart, Bar, BarChart, CartesianGrid, Cell, Line, LineChart, Pie, PieChart, XAxis, YAxis } from 'recharts';
import { ChartContainer, ChartTooltip, ChartTooltipContent, type ChartConfig } from '@agensis/ui/components/chart';
import { SERIES_COLORS, STATUS_COLORS } from './reportColors';
import type { BurndownPoint, FlowPoint, StatusFlowPoint, StatusSlice, VelocityWeek } from '../../lib/pm/reports';

// The charts for the project Reports tab and the Dashboard. Its own module so the
// Projects window lazy-imports it: recharts is large and only these views draw it.

const shortDay = (ms: number) => new Date(ms).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });

export function BurndownChart({ points }: { points: BurndownPoint[] }) {
  const config: ChartConfig = {
    remaining: { label: 'Remaining', color: SERIES_COLORS.remaining },
    ideal: { label: 'Ideal pace', color: SERIES_COLORS.ideal },
  };
  return (
    <ChartContainer config={config} className="h-44 w-full" aria-label="Burndown chart">
      <LineChart data={points} margin={{ left: 0, right: 8, top: 8 }}>
        <CartesianGrid vertical={false} strokeOpacity={0.4} />
        <XAxis dataKey="day" tickFormatter={shortDay} tickLine={false} axisLine={false} tick={{ fontSize: 10 }} minTickGap={24} />
        <YAxis width={26} allowDecimals={false} tickLine={false} axisLine={false} tick={{ fontSize: 10 }} />
        <ChartTooltip content={<ChartTooltipContent labelFormatter={value => shortDay(Number(value))} />} />
        <Line dataKey="ideal" type="linear" stroke="var(--color-ideal)" strokeDasharray="4 4" dot={false} strokeWidth={1.5} />
        <Line dataKey="remaining" type="stepAfter" stroke="var(--color-remaining)" dot={false} strokeWidth={2.5} />
      </LineChart>
    </ChartContainer>
  );
}

export function VelocityChart({ weeks }: { weeks: VelocityWeek[] }) {
  const config: ChartConfig = { done: { label: 'Done', color: SERIES_COLORS.velocity } };
  return (
    <ChartContainer config={config} className="h-44 w-full" aria-label="Velocity chart">
      <BarChart data={weeks} margin={{ left: 0, right: 8, top: 14 }}>
        <XAxis dataKey="weekStart" tickFormatter={shortDay} tickLine={false} axisLine={false} tick={{ fontSize: 10 }} />
        <YAxis width={22} allowDecimals={false} tickLine={false} axisLine={false} tick={{ fontSize: 10 }} />
        <ChartTooltip content={<ChartTooltipContent hideLabel />} />
        <Bar dataKey="done" radius={4}>
          {weeks.map(week => (
            <Cell key={week.weekStart} fill="var(--color-done)" fillOpacity={week.current ? 0.5 : 1} />
          ))}
        </Bar>
      </BarChart>
    </ChartContainer>
  );
}

export function FlowChart({ points }: { points: FlowPoint[] }) {
  const config: ChartConfig = {
    created: { label: 'Created', color: SERIES_COLORS.created },
    completed: { label: 'Completed', color: SERIES_COLORS.completed },
  };
  return (
    <ChartContainer config={config} className="h-32 w-full" aria-label="Created versus completed">
      <LineChart data={points} margin={{ left: 0, right: 8, top: 8 }}>
        <XAxis dataKey="day" tickFormatter={shortDay} tickLine={false} axisLine={false} tick={{ fontSize: 10 }} minTickGap={24} />
        <YAxis width={22} allowDecimals={false} tickLine={false} axisLine={false} tick={{ fontSize: 10 }} />
        <ChartTooltip content={<ChartTooltipContent labelFormatter={value => shortDay(Number(value))} />} />
        <Line dataKey="created" type="monotone" stroke="var(--color-created)" dot={false} strokeWidth={2} />
        <Line dataKey="completed" type="monotone" stroke="var(--color-completed)" dot={false} strokeWidth={2} />
      </LineChart>
    </ChartContainer>
  );
}

/** Tasks in each status over time, stacked: the cumulative flow diagram. */
export function StatusFlowChart({ points }: { points: StatusFlowPoint[] }) {
  const config: ChartConfig = {
    done: { label: 'Done', color: STATUS_COLORS.done },
    in_progress: { label: 'In progress', color: STATUS_COLORS.in_progress },
    todo: { label: 'To do', color: STATUS_COLORS.todo },
    cancelled: { label: 'Cancelled', color: STATUS_COLORS.cancelled },
  };
  return (
    <ChartContainer config={config} className="h-44 w-full" aria-label="Cumulative flow by status">
      <AreaChart data={points} margin={{ left: 0, right: 8, top: 8 }}>
        <CartesianGrid vertical={false} strokeOpacity={0.4} />
        <XAxis dataKey="day" tickFormatter={shortDay} tickLine={false} axisLine={false} tick={{ fontSize: 10 }} minTickGap={24} />
        <YAxis width={26} allowDecimals={false} tickLine={false} axisLine={false} tick={{ fontSize: 10 }} />
        <ChartTooltip content={<ChartTooltipContent labelFormatter={value => shortDay(Number(value))} />} />
        {(['done', 'in_progress', 'todo', 'cancelled'] as const).map(status => (
          <Area key={status} dataKey={status} type="stepAfter" stackId="flow" stroke={`var(--color-${status})`} fill={`var(--color-${status})`} fillOpacity={0.55} strokeWidth={1.5} />
        ))}
      </AreaChart>
    </ChartContainer>
  );
}

export function StatusRing({ slices, label }: { slices: StatusSlice[]; label: string }) {
  const config: ChartConfig = Object.fromEntries(slices.map(slice => [slice.status, { label: slice.status.replace('_', ' '), color: STATUS_COLORS[slice.status] }]));
  const data = slices.filter(slice => slice.count > 0);
  return (
    <div className="relative">
      <ChartContainer config={config} className="mx-auto h-32 w-full" aria-label="Status breakdown">
        <PieChart>
          <ChartTooltip content={<ChartTooltipContent hideLabel nameKey="status" />} />
          <Pie data={data} dataKey="count" nameKey="status" innerRadius={34} outerRadius={52} paddingAngle={2}>
            {data.map(slice => (
              <Cell key={slice.status} fill={STATUS_COLORS[slice.status]} />
            ))}
          </Pie>
        </PieChart>
      </ChartContainer>
      <div className="pointer-events-none absolute inset-0 grid place-items-center text-lg font-semibold">{label}</div>
    </div>
  );
}
