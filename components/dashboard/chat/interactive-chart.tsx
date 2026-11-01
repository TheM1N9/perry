"use client";

import { useId, useLayoutEffect, useRef, useState } from "react";
import { TableIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";

type Cell = string | number | boolean | null;
const number = new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 });
const tick = new Intl.NumberFormat(undefined, { notation: "compact", maximumFractionDigits: 1 });

export function InteractiveChart({ columns, rows, type, title }: { columns: string[]; rows: Cell[][]; type: "bar" | "line"; title: string }) {
  const id = useId();
  const root = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(600);
  const [dataOpen, setDataOpen] = useState(false);
  useLayoutEffect(() => {
    const element = root.current;
    if (!element) return;
    const measure = () => setWidth(Math.max(220, element.clientWidth));
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  const points = rows.flatMap((row, index) => typeof row[1] === "number" && Number.isFinite(row[1]) ? [{ index, label: String(row[0] ?? "Missing"), value: row[1] }] : []);
  const min = Math.min(0, ...points.map((point) => point.value));
  const max = Math.max(0, ...points.map((point) => point.value));
  const upper = max === min ? min + 1 : max;
  const scale = Math.max(Math.abs(min), Math.abs(upper), 1);
  const range = upper / scale - min / scale;
  const percent = (value: number) => (value / scale - min / scale) / range * 100;
  const x = (index: number) => rows.length === 1 ? width / 2 : 44 + index / Math.max(1, rows.length - 1) * (width - 60);
  const y = (value: number) => 192 - percent(value) / 100 * 168;
  return <div ref={root} className="min-w-0 space-y-3" data-interactive-chart={type}>
    <figure aria-label={`${title}: ${columns[1] ?? "Values"}`}>
      <figcaption className="mb-3 text-xs text-muted-foreground">{columns[1] ?? "Value"}</figcaption>
      {points.length === 0 ? <p className="py-4 text-sm text-muted-foreground">No numeric values to plot.</p>
        : type === "line" ? <svg width="100%" height="240" viewBox={`0 0 ${width} 240`} role="img" aria-labelledby={`${id}-chart-title`}>
          <title id={`${id}-chart-title`}>{`${title}. ${points.map((point) => `${point.label}: ${number.format(point.value)}`).join("; ")}. Exact values are available under Show data.`}</title>
          {[min, min / 2 + upper / 2, upper].map((value, index) => <g key={index}>
            <line x1="44" x2={width - 16} y1={y(value)} y2={y(value)} stroke="var(--border)" />
            <text x="36" y={y(value) + 4} textAnchor="end" fill="var(--muted-foreground)" fontSize="12">{tick.format(value)}</text>
          </g>)}
          <path d={points.map((point, index) => `${index && point.index === points[index - 1].index + 1 ? "L" : "M"} ${x(point.index)} ${y(point.value)}`).join(" ")} fill="none" stroke="var(--primary)" strokeWidth="2.5" strokeLinejoin="round" strokeLinecap="round" />
          {points.map((point, index) => <g key={index}>
            <circle cx={x(point.index)} cy={y(point.value)} r="3.5" fill="var(--primary)"><title>{point.label}: {number.format(point.value)}</title></circle>
            {(index === 0 || index === points.length - 1 || index % Math.max(1, Math.ceil(points.length / (width < 400 ? 3 : 5))) === 0) && <text x={x(point.index)} y="218" textAnchor={index === 0 ? "start" : index === points.length - 1 ? "end" : "middle"} fill="var(--muted-foreground)" fontSize="12">{point.label.length > 12 ? `${point.label.slice(0, 10)}…` : point.label}</text>}
          </g>)}
        </svg> : <ol className="grid max-h-96 gap-3 overflow-y-auto" aria-label="Chart values">{points.map((point, index) => <li key={index} className="grid grid-cols-[minmax(4.5rem,1fr)_minmax(0,2fr)_auto] items-center gap-3 text-sm">
          <span className="min-w-0 break-words">{point.label}</span>
          <span className="relative block h-3 rounded-sm bg-muted" aria-hidden>
            <span className="absolute inset-y-0 rounded-sm bg-primary" style={{ left: `${Math.min(percent(0), percent(point.value))}%`, width: `${Math.abs(percent(point.value) - percent(0))}%` }} />
            {min < 0 && max > 0 && <span className="absolute inset-y-0 border-l border-foreground/40" style={{ left: `${percent(0)}%` }} />}
          </span>
          <span className="text-right tabular-nums">{number.format(point.value)}</span>
        </li>)}</ol>}
    </figure>
    {points.length < rows.length && <p className="text-xs text-muted-foreground">{rows.length - points.length} {rows.length - points.length === 1 ? "row has" : "rows have"} no numeric value.</p>}
    <Button type="button" variant="ghost" size="sm" className="min-h-11 px-0 text-muted-foreground sm:min-h-8" aria-expanded={dataOpen} aria-controls={`${id}-data`} onClick={() => setDataOpen(!dataOpen)}><TableIcon />{dataOpen ? "Hide data" : "Show data"}</Button>
    {dataOpen && <div id={`${id}-data`} className="max-h-80 overflow-auto"><Table>
      <TableHeader><TableRow>{columns.map((column, index) => <TableHead key={index} scope="col">{column}</TableHead>)}</TableRow></TableHeader>
      <TableBody>{rows.map((row, index) => <TableRow key={index}>{row.map((cell, column) => <TableCell key={column} className="tabular-nums">{cell === null ? "Missing" : String(cell)}</TableCell>)}</TableRow>)}</TableBody>
    </Table></div>}
  </div>;
}
