import { createFileRoute } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useCallback, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
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
      { property: "og:title", content: "Bill to CSV — Purchase bill photos into import-ready rows" },
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

type Mode = "purchase-bill" | "auto" | "aman-medical";

const AMAN_EXAMPLE: string[][] = [
  ["Pack.","Product","HSN","LOT S","QTY","FREE","MFR","Batch.","Exp.","M.R.P.","Rate","Dis%","GST%","Amount","NET Rate"],
  ["1 VAI","PAN IV.40 INJ","3004","10+15","25","0","ALKEM","25740123","11/27","53.90","16.43","3.00","5.0","410.75","16.73"],
  ["15 TA","DIGENE TAB ORANGE.","3004","9+1","9","0","ABBOT","862003D7","02/29","30.10","20.66","3.00","5.0","185.94","21.04"],
  ["100 m","METROGYL IV INJ. 100ML","3004","","22","0","UNIQU","VIIW26052","01/29","22.00","14.50","0.00","5.0","319.00","15.23"],
];

const BILL_EXAMPLE: string[][] = [
  ["Product Name","Pack","Company","Batch","Expiry","Qty","Free","Pur Rate","Dis %","Net Rate","Sale Rate","MRP","GST%","Amount"],
  ["LIVZYME FORTE 150ML","1X150ML","ALKEM","AB1234","11/27","10","1","82.50","10","74.25","94.88","120.00","12","742.50"],
  ["MONTINA L TAB","10X10","ARISTO","SPA260052","12/27","5","0","57.86","3","56.12","66.54","84.37","5","280.60"],
];

function Index() {
  const extract = useServerFn(imageToCsv);
  const inputRef = useRef<HTMLInputElement>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [fileName, setFileName] = useState<string>("table");
  const [csv, setCsv] = useState<string | null>(null);
  const [source, setSource] = useState<"own-key" | "lovable" | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const [mode, setMode] = useState<Mode>("auto");


  const rows = useMemo(() => (csv ? parseCsv(csv) : []), [csv]);


  const handleFile = useCallback((file: File) => {
    if (!file.type.startsWith("image/")) {
      setError("Please choose an image file (PNG, JPG, WEBP…).");
      return;
    }
    if (file.size > 8 * 1024 * 1024) {
      setError("Image is larger than 8 MB. Try a smaller one.");
      return;
    }
    setError(null);
    setCsv(null);
    setSource(null);
    setFileName(file.name.replace(/\.[^.]+$/, "") || "table");
    const reader = new FileReader();
    reader.onload = () => setPreview(String(reader.result));
    reader.readAsDataURL(file);
  }, []);

  const run = useCallback(async () => {
    if (!preview) return;
    setLoading(true);
    setError(null);
    try {
      const result = await extract({ data: { image: preview, mode } });
      setCsv(result.csv);
      setSource(result.source);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Something went wrong.");
    } finally {
      setLoading(false);
    }
  }, [preview, extract, mode]);


  const download = useCallback(() => {
    if (!csv) return;
    const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = `${fileName}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }, [csv, fileName]);

  const reset = () => {
    setPreview(null);
    setCsv(null);
    setSource(null);
    setError(null);
  };

  return (
    <>
      <div className="aurora" aria-hidden="true" />

      <div className="sticky top-0 z-30 border-b border-border/60 bg-background/70 backdrop-blur-xl">
        <div className="mx-auto flex w-full max-w-5xl items-center justify-between gap-4 px-5 py-3">
          <div className="flex items-center gap-2.5">
            <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-primary font-mono text-sm font-bold text-primary-foreground">
              S
            </span>
            <span className="font-mono text-sm tracking-tight">
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
          <span className="inline-flex items-center gap-2 rounded-full border border-primary/30 bg-primary/10 px-3 py-1 font-mono text-[11px] uppercase tracking-[0.25em] text-primary">
            gst purchase bill · ai ocr
          </span>
          <h1 className="text-gradient mx-auto mt-5 max-w-3xl text-4xl font-semibold leading-[1.1] tracking-tight sm:text-6xl">
            Turn a purchase bill photo into an import-ready sheet
          </h1>
          <p className="mx-auto mt-5 max-w-xl text-balance text-muted-foreground">
            Snap the physical GST invoice. Every product line comes back with Product Name, Pack,
            Company, Batch, Expiry, Qty, Rate, Dis%, Net Rate, Sale Rate, MRP, GST% and Amount — the
            exact columns your Purchase Bill Entry screen expects.
          </p>
        </header>

        <section className="panel glow-ring p-5 sm:p-7">
          <div className="mb-6 inline-flex flex-wrap gap-1 rounded-xl border border-border/70 bg-background/50 p-1">
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
                onClick={() => setMode(value)}
                className={`rounded-lg px-3.5 py-2 text-sm transition-all ${
                  mode === value
                    ? "bg-primary text-primary-foreground shadow-[0_8px_24px_-12px] shadow-primary"
                    : "text-muted-foreground hover:text-foreground"
                }`}
              >
                {label}
              </button>
            ))}
          </div>

          {mode !== "auto" && (
            <div className="mb-6 overflow-hidden rounded-xl border border-border/70 bg-background/40">
              <div className="flex items-center justify-between gap-3 border-b border-border/60 px-4 py-2.5">
                <span className="font-mono text-[11px] uppercase tracking-widest text-muted-foreground">
                  Format example · {mode === "aman-medical" ? "Aman Medical" : "Purchase bill"}
                </span>
              </div>
              <div className="overflow-auto">
                <table className="w-full border-collapse text-xs">
                  <thead className="bg-secondary/70">
                    <tr>
                      {(mode === "aman-medical"
                        ? AMAN_EXAMPLE
                        : BILL_EXAMPLE)[0]!.map((cell, i) => (
                        <th
                          key={i}
                          className="whitespace-nowrap border-b border-border px-3 py-2 text-left font-medium"
                        >
                          {cell}
                        </th>
                      ))}
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
                              className="whitespace-nowrap border-b border-border/50 px-3 py-1.5 text-muted-foreground"
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

          {!preview ? (
            <div
              onDragOver={(e) => {
                e.preventDefault();
                setDragging(true);
              }}
              onDragLeave={() => setDragging(false)}
              onDrop={(e) => {
                e.preventDefault();
                setDragging(false);
                const file = e.dataTransfer.files?.[0];
                if (file) handleFile(file);
              }}
              onClick={() => inputRef.current?.click()}
              className={`flex cursor-pointer flex-col items-center justify-center rounded-xl border border-dashed px-6 py-20 text-center transition-all ${
                dragging
                  ? "border-primary bg-primary/10"
                  : "border-border/80 bg-background/40 hover:border-primary/60 hover:bg-primary/5"
              }`}
            >
              <span className="flex h-12 w-12 items-center justify-center rounded-full border border-primary/40 bg-primary/10 font-mono text-lg text-primary">
                +
              </span>
              <p className="mt-5 text-base font-medium">Drop your bill photo here</p>
              <p className="mt-1 text-sm text-muted-foreground">
                or click to browse — PNG, JPG, WEBP up to 8 MB
              </p>
              <input
                ref={inputRef}
                type="file"
                accept="image/*"
                className="hidden"
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  if (file) handleFile(file);
                }}
              />
            </div>
          ) : (
            <div className="grid gap-6 sm:grid-cols-[minmax(0,1fr)_16rem] sm:items-start">
              <img
                src={preview}
                alt="Uploaded purchase bill to convert to CSV"
                className="max-h-96 w-full rounded-xl border border-border/70 bg-background/40 object-contain p-2"
              />
              <div className="flex flex-row gap-3 sm:flex-col">
                <Button onClick={run} disabled={loading} size="lg" className="w-full">
                  {loading ? "Reading bill…" : "Convert to CSV"}
                </Button>
                <Button variant="secondary" onClick={reset} size="lg" className="w-full">
                  Choose another
                </Button>
              </div>
            </div>
          )}

          {error && (
            <p className="mt-5 rounded-xl border border-destructive/40 bg-destructive/10 px-4 py-3 text-sm text-destructive-foreground">
              {error}
            </p>
          )}
        </section>


        {rows.length > 0 && (
          <section className="panel glow-ring mt-8 overflow-hidden">
            <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border/70 px-5 py-4">
              <div className="flex flex-wrap items-center gap-3">
                <h2 className="font-mono text-sm uppercase tracking-widest text-muted-foreground">
                  {rows.length - 1} rows · {rows[0]?.length ?? 0} columns
                </h2>
                {source && (
                  <span
                    className={`rounded-full border px-2.5 py-1 font-mono text-[11px] uppercase tracking-wider ${
                      source === "own-key"
                        ? "border-primary/40 bg-primary/10 text-primary"
                        : "border-border bg-muted text-muted-foreground"
                    }`}
                    title={
                      source === "own-key"
                        ? "Extracted with your own Gemini API key"
                        : "Your key was unavailable, so Lovable AI was used as fallback"
                    }
                  >
                    {source === "own-key" ? "Your key" : "Lovable AI"}
                  </span>
                )}
              </div>
              <div className="flex gap-2">
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => csv && navigator.clipboard.writeText(csv)}
                >
                  Copy CSV
                </Button>
                <Button size="sm" onClick={download}>
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
                          className="whitespace-nowrap border-b border-border/50 px-4 py-2.5 text-muted-foreground"
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

