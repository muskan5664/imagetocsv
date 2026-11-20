import { createFileRoute } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AlertCircle,
  Check,
  ChevronLeft,
  ChevronRight,
  Copy,
  Download,
  Loader2,
  Plus,
  RotateCcw,
  Trash2,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { imageToCsv } from "@/lib/extract.functions";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "Bill to CSV — Purchase bill photos into import-ready rows" },
      {
        name: "description",
        content:
          "Photograph a GST purchase bill and get a CSV with product, pack, company, batch, expiry, qty, rates, MRP and GST ready to import.",
      },
      {
        property: "og:title",
        content: "Bill to CSV — Purchase bill photos into import-ready rows",
      },
      {
        property: "og:description",
        content:
          "Photograph a GST purchase bill and get a CSV with product, pack, company, batch, expiry, qty, rates, MRP and GST ready to import.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: Index,
});

function parseCsv(csv: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < csv.length; i++) {
    const c = csv[i];
    if (quoted) {
      if (c === '"') {
        if (csv[i + 1] === '"') {
          field += '"';
          i++;
        } else quoted = false;
      } else field += c;
      continue;
    }
    if (c === '"') quoted = true;
    else if (c === ",") {
      row.push(field);
      field = "";
    } else if (c === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else if (c !== "\r") field += c;
  }
  if (field.length || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => r.some((cell) => cell.trim() !== ""));
}

function escapeCsvCell(value: string): string {
  if (/[",\n\r]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

function serializeCsv(rows: string[][]): string {
  return rows.map((row) => row.map((cell) => escapeCsvCell(cell)).join(",")).join("\n");
}

function normalizeHeaderCell(cell: string): string {
  return cell.trim().toLowerCase().replace(/\s+/g, " ");
}

function isSameHeader(a: string[], b: string[]): boolean {
  if (!a.length || !b.length) return false;
  const normA = a.map(normalizeHeaderCell);
  const normB = b.map(normalizeHeaderCell);
  if (normA.length === normB.length && normA.every((v, idx) => v === normB[idx])) {
    return true;
  }
  const setA = new Set(normA.filter(Boolean));
  if (setA.size === 0) return false;
  let matches = 0;
  for (const col of normB) {
    if (col && setA.has(col)) matches++;
  }
  return matches / Math.max(setA.size, normB.length) >= 0.6;
}

function mergePageCsvs(csvList: string[], mode: Mode): string {
  const valid = csvList.map((c) => parseCsv(c)).filter((rows) => rows.length > 0);
  if (valid.length === 0) return "";
  if (valid.length === 1) return serializeCsv(valid[0]!);

  const firstPage = valid[0]!;
  const header = firstPage[0] ?? [];
  const merged: string[][] = [...firstPage];

  for (let i = 1; i < valid.length; i++) {
    const pageRows = valid[i]!;
    if (pageRows.length === 0) continue;
    const firstRow = pageRows[0] ?? [];
    const skipFirst = mode !== "auto" || isSameHeader(header, firstRow);
    const dataRows = skipFirst ? pageRows.slice(1) : pageRows;
    for (const r of dataRows) {
      merged.push(r);
    }
  }

  const maxCols = merged.reduce((max, r) => Math.max(max, r.length), 0);
  const normalized = merged.map((r) =>
    r.length < maxCols ? [...r, ...Array<string>(maxCols - r.length).fill("")] : r,
  );

  return serializeCsv(normalized);
}

/**
 * Compress very large camera photos client-side while preserving crisp text
 * so uploads stay fast and safely under serverless body size limits.
 */
async function prepareImageDataUrl(file: File): Promise<string> {
  const rawDataUrl = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error(`Could not read ${file.name}.`));
    reader.readAsDataURL(file);
  });

  if (rawDataUrl.length <= 2_800_000) {
    return rawDataUrl;
  }

  return await new Promise<string>((resolve) => {
    const img = new Image();
    img.onload = () => {
      const maxDim = 2200;
      let { width, height } = img;
      if (width > maxDim || height > maxDim) {
        const scale = Math.min(maxDim / width, maxDim / height);
        width = Math.round(width * scale);
        height = Math.round(height * scale);
      }
      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext("2d");
      if (!ctx) {
        resolve(rawDataUrl);
        return;
      }
      ctx.drawImage(img, 0, 0, width, height);
      const compressed = canvas.toDataURL("image/jpeg", 0.88);
      resolve(compressed.length < rawDataUrl.length ? compressed : rawDataUrl);
    };
    img.onerror = () => resolve(rawDataUrl);
    img.src = rawDataUrl;
  });
}

function formatSeconds(totalSec: number): string {
  const clamped = Math.max(0, Math.round(totalSec));
  const mins = Math.floor(clamped / 60);
  const secs = clamped % 60;
  if (mins > 0) {
    return `${mins}m ${secs}s`;
  }
  return `${secs}s`;
}

type Mode = "purchase-bill" | "auto" | "aman-medical";
type PageStatus = "pending" | "processing" | "done" | "error";

interface BillPage {
  id: string;
  name: string;
  preview: string;
  status: PageStatus;
  csv?: string | undefined;
  rowCount?: number | undefined;
  model?: string | undefined;
  error?: string | undefined;
  durationMs?: number | undefined;
}

const DEFAULT_PAGE_ESTIMATE_MS = 8500;

const AMAN_EXAMPLE: string[][] = [
  [
    "Pack.",
    "Product",
    "HSN",
    "LOT S",
    "QTY",
    "FREE",
    "MFR",
    "Batch.",
    "Exp.",
    "M.R.P.",
    "Rate",
    "Dis%",
    "GST%",
    "Amount",
    "NET Rate",
  ],
  [
    "1 VAI",
    "PAN IV.40 INJ",
    "3004",
    "10+15",
    "25",
    "0",
    "ALKEM",
    "25740123",
    "11/27",
    "53.90",
    "16.43",
    "3.00",
    "5.0",
    "410.75",
    "16.73",
  ],
  [
    "15 TA",
    "DIGENE TAB ORANGE.",
    "3004",
    "9+1",
    "9",
    "0",
    "ABBOT",
    "862003D7",
    "02/29",
    "30.10",
    "20.66",
    "3.00",
    "5.0",
    "185.94",
    "21.04",
  ],
  [
    "100 m",
    "METROGYL IV INJ. 100ML",
    "3004",
    "",
    "22",
    "0",
    "UNIQU",
    "VIIW26052",
    "01/29",
    "22.00",
    "14.50",
    "0.00",
    "5.0",
    "319.00",
    "15.23",
  ],
];

const BILL_EXAMPLE: string[][] = [
  [
    "Product Name",
    "Pack",
    "Company",
    "Batch",
    "Expiry",
    "Qty",
    "Free",
    "Pur Rate",
    "Dis %",
    "Net Rate",
    "Sale Rate",
    "MRP",
    "GST%",
    "Amount",
  ],
  [
    "LIVZYME FORTE 150ML",
    "1X150ML",
    "ALKEM",
    "AB1234",
    "11/27",
    "10",
    "1",
    "82.50",
    "10",
    "74.25",
    "94.88",
    "120.00",
    "12",
    "742.50",
  ],
  [
    "MONTINA L TAB",
    "10X10",
    "ARISTO",
    "SPA260052",
    "12/27",
    "5",
    "0",
    "57.86",
    "3",
    "56.12",
    "66.54",
    "84.37",
    "5",
    "280.60",
  ],
];

function Index() {
  const extract = useServerFn(imageToCsv);
  const inputRef = useRef<HTMLInputElement>(null);
  const addMoreRef = useRef<HTMLInputElement>(null);
  const cancelRef = useRef(false);

  const [pages, setPages] = useState<BillPage[]>([]);
  const [mode, setMode] = useState<Mode>("auto");
  const [dragging, setDragging] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  // Live progress state
  const [runStartedAt, setRunStartedAt] = useState<number | null>(null);
  const [pageStartedAt, setPageStartedAt] = useState<number | null>(null);
  const [runTotalCount, setRunTotalCount] = useState(0);
  const [runCompletedCount, setRunCompletedCount] = useState(0);
  const [activePageIndex, setActivePageIndex] = useState<number | null>(null);
  const [avgPageMs, setAvgPageMs] = useState<number>(DEFAULT_PAGE_ESTIMATE_MS);
  const [lastDurationMs, setLastDurationMs] = useState<number | null>(null);
  const [nowTick, setNowTick] = useState<number>(() => Date.now());

  useEffect(() => {
    if (!loading) return;
    const id = window.setInterval(() => setNowTick(Date.now()), 200);
    return () => window.clearInterval(id);
  }, [loading]);

  const combinedCsv = useMemo(() => {
    const doneCsvs = pages.filter((p) => p.status === "done" && p.csv).map((p) => p.csv!);
    if (doneCsvs.length === 0) return null;
    return mergePageCsvs(doneCsvs, mode);
  }, [pages, mode]);

  const rows = useMemo(() => (combinedCsv ? parseCsv(combinedCsv) : []), [combinedCsv]);

  const completedPagesCount = useMemo(
    () => pages.filter((p) => p.status === "done").length,
    [pages],
  );
  const pendingOrFailedCount = useMemo(
    () => pages.filter((p) => p.status === "pending" || p.status === "error").length,
    [pages],
  );
  const modelsUsed = useMemo(() => {
    const set = new Set(pages.map((p) => p.model).filter((m): m is string => Boolean(m)));
    return Array.from(set);
  }, [pages]);

  const progressStats = useMemo(() => {
    if (!loading || !runStartedAt || runTotalCount === 0) {
      return { percent: 0, elapsedSec: 0, remainingSec: null as number | null };
    }

    const elapsedMs = Math.max(0, nowTick - runStartedAt);
    const currentPageElapsedMs = pageStartedAt ? Math.max(0, nowTick - pageStartedAt) : 0;

    // Smooth asymptotic curve for the active page: reaches ~88% around avgPageMs, caps at 94%
    const ratio = currentPageElapsedMs / Math.max(avgPageMs, 2500);
    const inFlightFraction = Math.min(0.94, 0.1 + 0.84 * (1 - Math.exp(-1.55 * ratio)));

    const rawPercent = ((runCompletedCount + inFlightFraction) / runTotalCount) * 100;
    const percent = Math.min(99, Math.max(1, Math.round(rawPercent)));

    const remainingCurrentMs = Math.max(1000, avgPageMs - currentPageElapsedMs);
    const remainingFuturePages = Math.max(0, runTotalCount - runCompletedCount - 1);
    const remainingMs = remainingCurrentMs + remainingFuturePages * avgPageMs;

    return {
      percent,
      elapsedSec: elapsedMs / 1000,
      remainingSec:
        currentPageElapsedMs > avgPageMs * 1.6 && remainingFuturePages === 0
          ? null
          : remainingMs / 1000,
    };
  }, [loading, runStartedAt, pageStartedAt, nowTick, runCompletedCount, runTotalCount, avgPageMs]);

  const addFiles = useCallback(async (fileList: FileList | File[]) => {
    const files = Array.from(fileList);
    if (files.length === 0) return;

    const errors: string[] = [];
    const newPages: BillPage[] = [];

    for (const file of files) {
      if (!file.type.startsWith("image/")) {
        errors.push(`${file.name} is not an image file.`);
        continue;
      }
      if (file.size > 15 * 1024 * 1024) {
        errors.push(`${file.name} is larger than 15 MB.`);
        continue;
      }
      try {
        const preview = await prepareImageDataUrl(file);
        newPages.push({
          id: `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
          name: file.name.replace(/\.[^.]+$/, "") || "page",
          preview,
          status: "pending",
        });
      } catch (e) {
        errors.push(e instanceof Error ? e.message : `Failed to load ${file.name}.`);
      }
    }

    if (newPages.length > 0) {
      setPages((prev) => [...prev, ...newPages]);
      setLastDurationMs(null);
    }
    setError(errors.length > 0 ? errors.join(" ") : null);
  }, []);

  const handleModeChange = useCallback(
    (nextMode: Mode) => {
      if (nextMode === mode) return;
      setMode(nextMode);
      setError(null);
      setLastDurationMs(null);
      setPages((prev) =>
        prev.map((p) => ({
          id: p.id,
          name: p.name,
          preview: p.preview,
          status: "pending",
        })),
      );
    },
    [mode],
  );

  const removePage = useCallback((id: string) => {
    setPages((prev) => prev.filter((p) => p.id !== id));
    setError(null);
  }, []);

  const movePage = useCallback((index: number, direction: -1 | 1) => {
    setPages((prev) => {
      const target = index + direction;
      if (target < 0 || target >= prev.length) return prev;
      const next = [...prev];
      const current = next[index]!;
      next[index] = next[target]!;
      next[target] = current;
      return next;
    });
  }, []);

  const runExtraction = useCallback(
    async (reprocessAll = false) => {
      if (pages.length === 0 || loading) return;

      const targetIndices = pages
        .map((p, idx) => ({ p, idx }))
        .filter(({ p }) => reprocessAll || p.status !== "done")
        .map(({ idx }) => idx);

      if (targetIndices.length === 0) return;

      cancelRef.current = false;
      const batchStart = Date.now();
      setLoading(true);
      setError(null);
      setLastDurationMs(null);
      setRunStartedAt(batchStart);
      setRunTotalCount(targetIndices.length);
      setRunCompletedCount(0);
      setNowTick(batchStart);

      if (reprocessAll) {
        setPages((prev) =>
          prev.map((p) => ({
            id: p.id,
            name: p.name,
            preview: p.preview,
            status: "pending",
          })),
        );
      }

      // Grab page 1 header if already extracted (for consistent columns in `auto` mode)
      let firstPageHeader: string[] | null = null;
      if (!reprocessAll && mode === "auto") {
        const existingFirstDone = pages.find((p) => p.status === "done" && p.csv);
        if (existingFirstDone?.csv) {
          const parsed = parseCsv(existingFirstDone.csv);
          if (parsed[0]?.length) firstPageHeader = parsed[0];
        }
      }

      const durations: number[] = [];
      let failedCount = 0;
      let lastFailureMessage = "";

      for (let step = 0; step < targetIndices.length; step++) {
        if (cancelRef.current) break;

        const pageIndex = targetIndices[step]!;
        const page = pages[pageIndex]!;
        const pStart = Date.now();

        setActivePageIndex(pageIndex);
        setPageStartedAt(pStart);
        setPages((prev) =>
          prev.map((item, idx) =>
            idx === pageIndex ? { ...item, status: "processing", error: undefined } : item,
          ),
        );

        let hint: string | undefined;
        if (pages.length > 1) {
          if (mode === "auto" && firstPageHeader && firstPageHeader.length > 0) {
            hint =
              `This is page ${pageIndex + 1} of ${pages.length} of the same document. Use these exact CSV column headers in the same order: ${firstPageHeader.join(", ")}.`.slice(
                0,
                580,
              );
          } else if (pageIndex > 0) {
            hint = `This is page ${pageIndex + 1} of ${pages.length} of a multi-page bill. Extract only the product rows on this page.`;
          }
        }

        try {
          const result = await extract({
            data: {
              image: page.preview,
              mode,
              ...(hint ? { hint } : {}),
            },
          });

          const durationMs = Date.now() - pStart;
          durations.push(durationMs);
          const avg = durations.reduce((sum, d) => sum + d, 0) / durations.length;
          setAvgPageMs(Math.max(3000, Math.round(avg)));

          const parsed = parseCsv(result.csv);
          if (!firstPageHeader && parsed[0]?.length) {
            firstPageHeader = parsed[0];
          }
          const dataRowCount = Math.max(0, parsed.length - 1);

          setPages((prev) =>
            prev.map((item, idx) =>
              idx === pageIndex
                ? {
                    ...item,
                    status: "done",
                    csv: result.csv,
                    rowCount: dataRowCount,
                    model: result.model,
                    durationMs,
                    error: undefined,
                  }
                : item,
            ),
          );
        } catch (e) {
          failedCount++;
          lastFailureMessage = e instanceof Error ? e.message : "Something went wrong.";
          setPages((prev) =>
            prev.map((item, idx) =>
              idx === pageIndex
                ? {
                    ...item,
                    status: "error",
                    error: lastFailureMessage,
                  }
                : item,
            ),
          );
        }

        setRunCompletedCount(step + 1);
      }

      const totalElapsed = Date.now() - batchStart;
      setLastDurationMs(totalElapsed);
      setLoading(false);
      setActivePageIndex(null);
      setPageStartedAt(null);
      setRunStartedAt(null);

      if (failedCount > 0) {
        setError(
          targetIndices.length === 1
            ? lastFailureMessage
            : `${failedCount} of ${targetIndices.length} pages failed (${lastFailureMessage}). You can retry only the failed pages.`,
        );
      }
    },
    [pages, loading, extract, mode],
  );

  const cancelRun = useCallback(() => {
    cancelRef.current = true;
  }, []);

  const download = useCallback(() => {
    if (!combinedCsv) return;
    const baseName = pages[0]?.name || "bill";
    const downloadName =
      pages.length > 1 ? `${baseName}-${completedPagesCount}-pages.csv` : `${baseName}.csv`;
    const url = URL.createObjectURL(new Blob([combinedCsv], { type: "text/csv;charset=utf-8" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = downloadName;
    a.click();
    URL.revokeObjectURL(url);
  }, [combinedCsv, pages, completedPagesCount]);

  const copyCsv = useCallback(() => {
    if (!combinedCsv) return;
    navigator.clipboard.writeText(combinedCsv);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1800);
  }, [combinedCsv]);

  const reset = useCallback(() => {
    cancelRef.current = true;
    setPages([]);
    setError(null);
    setLoading(false);
    setLastDurationMs(null);
    setRunStartedAt(null);
    setPageStartedAt(null);
    setActivePageIndex(null);
  }, []);

  const activePage = activePageIndex !== null ? pages[activePageIndex] : null;

  const primaryButtonLabel = loading
    ? `Converting (${progressStats.percent}%)…`
    : completedPagesCount > 0 && pendingOrFailedCount > 0
      ? `Convert ${pendingOrFailedCount} remaining ${pendingOrFailedCount === 1 ? "page" : "pages"}`
      : pages.length > 1
        ? `Convert all ${pages.length} pages to CSV`
        : "Convert to CSV";

  return (
    <>
      <div className="aurora" aria-hidden="true" />

      <div className="sticky top-0 z-30 border-b border-border/60 bg-background/70 backdrop-blur-xl">
        <div className="mx-auto flex w-full max-w-5xl items-center justify-between gap-4 px-5 py-3">
          <div className="flex items-center gap-2.5">
            <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-primary font-mono text-sm font-bold text-primary-foreground">
              S
            </span>
            <span className="font-mono text-sm tracking-tight whitespace-nowrap">
              Bill<span className="text-primary">→</span>CSV
            </span>
          </div>
          <p className="text-right text-xs text-muted-foreground sm:text-sm">
            Website created by <span className="font-medium text-foreground">Satyam Gupta</span>
          </p>
        </div>
      </div>

      <main className="mx-auto min-h-screen w-full max-w-5xl px-5 py-12 sm:py-16">
        <header className="mb-10 text-center sm:mb-14">
          <p className="font-mono text-xs tracking-widest text-primary">
            GST Purchase Bill · Multi-Page AI OCR
          </p>
          <h1 className="text-gradient mx-auto mt-4 max-w-3xl text-balance text-4xl font-semibold leading-[1.1] tracking-tight sm:text-6xl">
            Turn single or multi-page bill photos into one import-ready sheet
          </h1>
          <p className="mx-auto mt-5 max-w-xl text-balance text-muted-foreground">
            Upload one page or add multiple pages of the same GST invoice. Every product line across
            all pages is merged into one clean CSV with Product Name, Pack, Company, Batch, Expiry,
            Qty, Rates, MRP, GST% and Amount.
          </p>
        </header>

        <section className="panel glow-ring p-5 sm:p-7">
          <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
            <div className="inline-flex flex-wrap gap-1 rounded-xl border border-border/70 bg-background/50 p-1">
              {(
                [
                  ["auto", "Any table (as printed)"],
                  ["purchase-bill", "Purchase bill (import ready)"],
                  ["aman-medical", "Aman Medical"],
                ] as const
              ).map(([value, label]) => (
                <button
                  key={value}
                  type="button"
                  disabled={loading}
                  onClick={() => handleModeChange(value)}
                  className={`whitespace-nowrap rounded-lg px-3.5 py-2 text-sm transition-all disabled:opacity-50 ${
                    mode === value
                      ? "bg-primary text-primary-foreground shadow-[0_8px_24px_-12px] shadow-primary"
                      : "text-muted-foreground hover:text-foreground"
                  }`}
                >
                  {label}
                </button>
              ))}
            </div>

            {pages.length > 0 && (
              <div className="flex items-center gap-2 font-mono text-xs tabular-nums text-muted-foreground">
                <span>
                  {pages.length} {pages.length === 1 ? "page" : "pages"}
                </span>
                {completedPagesCount > 0 && (
                  <>
                    <span aria-hidden="true">·</span>
                    <span className="text-primary">{completedPagesCount} converted</span>
                  </>
                )}
              </div>
            )}
          </div>

          {mode !== "auto" && (
            <div className="mb-6 overflow-hidden rounded-xl border border-border/70 bg-background/40">
              <div className="flex items-center justify-between gap-3 border-b border-border/60 px-4 py-2.5">
                <span className="font-mono text-xs text-muted-foreground">
                  Format example · {mode === "aman-medical" ? "Aman Medical" : "Purchase bill"}
                </span>
              </div>
              <div className="overflow-auto">
                <table className="w-full border-collapse text-xs">
                  <thead className="bg-secondary/70">
                    <tr>
                      {(mode === "aman-medical" ? AMAN_EXAMPLE : BILL_EXAMPLE)[0]!.map(
                        (cell, i) => (
                          <th
                            key={i}
                            className="whitespace-nowrap border-b border-border px-3 py-2 text-left font-medium"
                          >
                            {cell}
                          </th>
                        ),
                      )}
                    </tr>
                  </thead>
                  <tbody>
                    {(mode === "aman-medical" ? AMAN_EXAMPLE : BILL_EXAMPLE)
                      .slice(1)
                      .map((r, ri) => (
                        <tr key={ri} className="odd:bg-muted/20">
                          {r.map((cell, ci) => (
                            <td
                              key={ci}
                              className="whitespace-nowrap border-b border-border/50 px-3 py-1.5 font-mono tabular-nums text-muted-foreground"
                            >
                              {cell}
                            </td>
                          ))}
                        </tr>
                      ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/* Hidden file inputs */}
          <input
            ref={inputRef}
            type="file"
            accept="image/*"
            multiple
            className="hidden"
            onChange={(e) => {
              if (e.target.files) {
                void addFiles(e.target.files);
              }
              e.target.value = "";
            }}
          />
          <input
            ref={addMoreRef}
            type="file"
            accept="image/*"
            multiple
            className="hidden"
            onChange={(e) => {
              if (e.target.files) {
                void addFiles(e.target.files);
              }
              e.target.value = "";
            }}
          />

          {pages.length === 0 ? (
            <div
              onDragOver={(e) => {
                e.preventDefault();
                setDragging(true);
              }}
              onDragLeave={() => setDragging(false)}
              onDrop={(e) => {
                e.preventDefault();
                setDragging(false);
                if (e.dataTransfer.files?.length) {
                  void addFiles(e.dataTransfer.files);
                }
              }}
              onClick={() => inputRef.current?.click()}
              className={`flex cursor-pointer flex-col items-center justify-center rounded-xl border border-dashed px-6 py-20 text-center transition-all ${
                dragging
                  ? "border-primary bg-primary/10"
                  : "border-border/80 bg-background/40 hover:border-primary/60 hover:bg-primary/5"
              }`}
            >
              <span className="flex h-12 w-12 items-center justify-center rounded-full border border-primary/40 bg-primary/10 text-primary">
                <Plus className="h-5 w-5" />
              </span>
              <p className="mt-5 text-base font-medium">Drop one or more bill photos here</p>
              <p className="mt-1 text-sm text-muted-foreground">
                or click to browse — select multiple pages at once, or add more pages later
              </p>
            </div>
          ) : (
            <div
              onDragOver={(e) => {
                e.preventDefault();
                if (!loading) setDragging(true);
              }}
              onDragLeave={() => setDragging(false)}
              onDrop={(e) => {
                e.preventDefault();
                setDragging(false);
                if (!loading && e.dataTransfer.files?.length) {
                  void addFiles(e.dataTransfer.files);
                }
              }}
              className={`space-y-6 rounded-xl transition-colors ${
                dragging ? "ring-2 ring-primary/60 ring-offset-4 ring-offset-background" : ""
              }`}
            >
              {/* Multi-page gallery */}
              <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4">
                {pages.map((page, index) => (
                  <div
                    key={page.id}
                    className={`group flex flex-col overflow-hidden rounded-xl border bg-background/50 transition-colors ${
                      page.status === "processing"
                        ? "border-primary"
                        : page.status === "error"
                          ? "border-destructive/60"
                          : "border-border/70"
                    }`}
                  >
                    <div className="relative aspect-[4/3] w-full overflow-hidden bg-background/80">
                      <img
                        src={page.preview}
                        alt={`Bill page ${index + 1}: ${page.name}`}
                        referrerPolicy="no-referrer"
                        className="h-full w-full object-contain p-1.5"
                      />
                      {page.status === "processing" && (
                        <div className="absolute inset-0 flex items-center justify-center bg-background/70 backdrop-blur-[2px]">
                          <Loader2 className="h-6 w-6 animate-spin text-primary" />
                        </div>
                      )}
                      {!loading && (
                        <button
                          type="button"
                          onClick={() => removePage(page.id)}
                          aria-label={`Remove page ${index + 1}`}
                          className="absolute right-2 top-2 flex h-7 w-7 items-center justify-center rounded-lg border border-border/80 bg-background/90 text-muted-foreground transition-colors hover:border-destructive/60 hover:text-destructive-foreground"
                        >
                          <X className="h-3.5 w-3.5" />
                        </button>
                      )}
                    </div>

                    <div className="flex flex-1 flex-col justify-between gap-2 border-t border-border/60 p-3">
                      <div className="min-w-0">
                        <div className="flex items-center justify-between gap-2">
                          <span className="font-mono text-xs font-medium tabular-nums text-foreground">
                            Page {index + 1}
                          </span>
                          <span
                            className={`flex items-center gap-1 font-mono text-[11px] tabular-nums ${
                              page.status === "done"
                                ? "text-primary"
                                : page.status === "error"
                                  ? "text-destructive-foreground"
                                  : page.status === "processing"
                                    ? "text-primary"
                                    : "text-muted-foreground"
                            }`}
                          >
                            {page.status === "done" && (
                              <>
                                <Check className="h-3 w-3" />
                                {page.rowCount ?? 0} rows
                              </>
                            )}
                            {page.status === "processing" && "Reading…"}
                            {page.status === "error" && (
                              <>
                                <AlertCircle className="h-3 w-3" />
                                Failed
                              </>
                            )}
                            {page.status === "pending" && "Ready"}
                          </span>
                        </div>
                        <p
                          className="mt-0.5 truncate text-xs text-muted-foreground"
                          title={page.name}
                        >
                          {page.name}
                        </p>
                      </div>

                      {pages.length > 1 && !loading && (
                        <div className="flex items-center justify-between border-t border-border/40 pt-2">
                          <button
                            type="button"
                            disabled={index === 0}
                            onClick={() => movePage(index, -1)}
                            aria-label={`Move page ${index + 1} earlier`}
                            className="inline-flex h-7 items-center gap-1 rounded-md px-2 text-xs text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground disabled:opacity-30"
                          >
                            <ChevronLeft className="h-3.5 w-3.5" />
                          </button>
                          <span className="font-mono text-[11px] text-muted-foreground">Order</span>
                          <button
                            type="button"
                            disabled={index === pages.length - 1}
                            onClick={() => movePage(index, 1)}
                            aria-label={`Move page ${index + 1} later`}
                            className="inline-flex h-7 items-center gap-1 rounded-md px-2 text-xs text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground disabled:opacity-30"
                          >
                            <ChevronRight className="h-3.5 w-3.5" />
                          </button>
                        </div>
                      )}
                    </div>
                  </div>
                ))}

                {/* Add more page tile */}
                {!loading && (
                  <button
                    type="button"
                    onClick={() => addMoreRef.current?.click()}
                    className="flex min-h-[168px] cursor-pointer flex-col items-center justify-center gap-2 rounded-xl border border-dashed border-border/80 bg-background/30 p-4 text-center text-muted-foreground transition-colors hover:border-primary/60 hover:bg-primary/5 hover:text-foreground"
                  >
                    <span className="flex h-10 w-10 items-center justify-center rounded-full border border-primary/40 bg-primary/10 text-primary">
                      <Plus className="h-5 w-5" />
                    </span>
                    <span className="text-sm font-medium text-foreground">Add more page</span>
                    <span className="text-xs text-muted-foreground">
                      Page {pages.length + 1} · drop or click
                    </span>
                  </button>
                )}
              </div>

              {/* Action bar */}
              <div className="flex flex-wrap items-center gap-3 border-t border-border/60 pt-5">
                {pendingOrFailedCount > 0 || completedPagesCount === 0 ? (
                  <Button
                    onClick={() => void runExtraction(false)}
                    disabled={loading}
                    size="lg"
                    className="whitespace-nowrap"
                  >
                    {loading && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                    {primaryButtonLabel}
                  </Button>
                ) : (
                  <Button
                    onClick={() => void runExtraction(true)}
                    disabled={loading}
                    size="lg"
                    className="whitespace-nowrap"
                  >
                    <RotateCcw className="mr-2 h-4 w-4" />
                    Re-convert all {pages.length} {pages.length === 1 ? "page" : "pages"}
                  </Button>
                )}

                {!loading && (
                  <Button
                    variant="secondary"
                    size="lg"
                    onClick={() => addMoreRef.current?.click()}
                    className="whitespace-nowrap"
                  >
                    <Plus className="mr-2 h-4 w-4" />
                    Add more page
                  </Button>
                )}

                {!loading && completedPagesCount > 0 && pendingOrFailedCount > 0 && (
                  <Button
                    variant="secondary"
                    size="lg"
                    onClick={() => void runExtraction(true)}
                    className="whitespace-nowrap"
                  >
                    <RotateCcw className="mr-2 h-4 w-4" />
                    Re-convert all
                  </Button>
                )}

                {loading ? (
                  <Button
                    variant="secondary"
                    size="lg"
                    onClick={cancelRun}
                    className="whitespace-nowrap"
                  >
                    Cancel
                  </Button>
                ) : (
                  <Button
                    variant="ghost"
                    size="lg"
                    onClick={reset}
                    className="ml-auto whitespace-nowrap text-muted-foreground hover:text-foreground"
                  >
                    <Trash2 className="mr-2 h-4 w-4" />
                    Clear all
                  </Button>
                )}
              </div>

              {/* Live Conversion Progress & ETA */}
              {loading && (
                <div
                  role="status"
                  aria-live="polite"
                  className="space-y-3 border-t border-border/60 pt-5"
                >
                  <div className="flex flex-wrap items-baseline justify-between gap-2">
                    <div className="min-w-0">
                      <p className="text-sm font-medium text-foreground">
                        {runTotalCount > 1
                          ? `Reading page ${Math.min(runCompletedCount + 1, runTotalCount)} of ${runTotalCount}`
                          : "Reading bill with Gemini"}
                        {activePage ? ` · ${activePage.name}` : ""}
                      </p>
                      <p className="mt-0.5 font-mono text-xs tabular-nums text-muted-foreground">
                        Elapsed {formatSeconds(progressStats.elapsedSec)}
                        <span aria-hidden="true"> · </span>
                        {progressStats.remainingSec !== null
                          ? `Est. ~${formatSeconds(progressStats.remainingSec)} left`
                          : "Almost done…"}
                      </p>
                    </div>
                    <span className="font-mono text-lg font-semibold tabular-nums text-primary">
                      {progressStats.percent}%
                    </span>
                  </div>

                  <Progress value={progressStats.percent} className="h-2.5 bg-secondary" />
                </div>
              )}

              {/* Completion timing summary */}
              {!loading && lastDurationMs !== null && completedPagesCount > 0 && !error && (
                <div className="flex flex-wrap items-center gap-2 border-t border-border/60 pt-4 font-mono text-xs tabular-nums text-muted-foreground">
                  <Check className="h-3.5 w-3.5 text-primary" />
                  <span className="text-foreground">
                    100% complete · {completedPagesCount}{" "}
                    {completedPagesCount === 1 ? "page" : "pages"} converted in{" "}
                    {(lastDurationMs / 1000).toFixed(1)}s
                  </span>
                </div>
              )}
            </div>
          )}

          {error && (
            <div className="mt-5 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-destructive/40 bg-destructive/10 px-4 py-3 text-sm text-destructive-foreground">
              <p className="min-w-0 flex-1">{error}</p>
              {pages.length > 0 && (
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => void runExtraction(false)}
                  disabled={loading}
                  className="whitespace-nowrap"
                >
                  {loading ? "Retrying…" : "Retry failed"}
                </Button>
              )}
            </div>
          )}
        </section>

        {rows.length > 0 && (
          <section className="panel glow-ring mt-8 overflow-hidden">
            <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border/70 px-5 py-4">
              <div className="flex flex-wrap items-center gap-2 font-mono text-xs tabular-nums text-muted-foreground sm:text-sm">
                <h2 className="font-medium text-foreground">
                  {rows.length - 1} rows · {rows[0]?.length ?? 0} columns
                </h2>
                {completedPagesCount > 1 && (
                  <>
                    <span aria-hidden="true">·</span>
                    <span>{completedPagesCount} pages merged</span>
                  </>
                )}
                {modelsUsed.length > 0 && (
                  <>
                    <span aria-hidden="true">·</span>
                    <span title={`Extracted with Gemini API (${modelsUsed.join(", ")})`}>
                      Gemini API
                    </span>
                  </>
                )}
              </div>
              <div className="flex gap-2">
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={copyCsv}
                  className="whitespace-nowrap"
                >
                  {copied ? (
                    <>
                      <Check className="mr-1.5 h-3.5 w-3.5" />
                      Copied
                    </>
                  ) : (
                    <>
                      <Copy className="mr-1.5 h-3.5 w-3.5" />
                      Copy CSV
                    </>
                  )}
                </Button>
                <Button size="sm" onClick={download} className="whitespace-nowrap">
                  <Download className="mr-1.5 h-3.5 w-3.5" />
                  Download .csv
                </Button>
              </div>
            </div>
            <div className="max-h-[28rem] overflow-auto">
              <table className="w-full border-collapse text-sm">
                <thead className="sticky top-0 bg-secondary/95 backdrop-blur">
                  <tr>
                    {rows[0]?.map((cell, i) => (
                      <th
                        key={i}
                        className="whitespace-nowrap border-b border-border px-4 py-3 text-left font-medium"
                      >
                        {cell}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {rows.slice(1).map((r, ri) => (
                    <tr key={ri} className="transition-colors odd:bg-muted/25 hover:bg-primary/5">
                      {r.map((cell, ci) => (
                        <td
                          key={ci}
                          className="whitespace-nowrap border-b border-border/50 px-4 py-2.5 font-mono tabular-nums text-muted-foreground"
                        >
                          {cell}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        )}

        <footer className="mt-14 border-t border-border/60 pt-6 font-mono text-xs text-muted-foreground">
          Images are processed on demand and never stored.
        </footer>
      </main>
    </>
  );
}
