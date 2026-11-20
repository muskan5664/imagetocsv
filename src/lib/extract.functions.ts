import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { GoogleGenAI } from "@google/genai";

const Input = z.object({
  image: z.string().min(20).max(12_000_000),
  hint: z.string().max(300).optional(),
  mode: z.enum(["auto", "purchase-bill", "aman-medical"]).optional(),
});

const SYSTEM = `You are a precise table extraction engine.
Given an image, extract the tabular data it contains (spreadsheet, receipt, invoice, report, handwritten table, etc).
Return ONLY valid CSV: comma separated, one row per line, first line = header row.
Quote fields containing commas, quotes or newlines with double quotes.
Never add commentary, markdown fences or explanations. If there is no table, infer a sensible two-column key,value CSV from the text in the image.`;

const BILL_SYSTEM = `You are a pharmacy purchase-bill (GST tax invoice) extraction engine.
Read the invoice image and output ONE product line per row, ready to import into a Purchase Bill Entry screen.

Return ONLY valid CSV with EXACTLY this header, in this order:
Product Name,Pack,Company,Batch,Expiry,Qty,Free,Pur Rate,Dis %,Net Rate,Sale Rate,MRP,GST%,Amount

Rules:
- Product Name: full item name as printed (keep strength/size, e.g. "LIVZYME FORTE 150ML").
- Pack / Packing: the packing column, e.g. 1X300ML, 1X4TAB. If absent, leave empty.
- Company: manufacturer / Mfd Name column.
- Batch: batch number exactly as printed.
- Expiry: MM/YY format.
- Qty: purchased quantity (number only, exclude free).
- Free: free quantity actually received, as a WHOLE number. Only fill it when a free quantity is explicitly printed for that line (e.g. "Qty+FR 10+1"). "Lot (9+1)" is only a scheme note, not free stock — in that case use 0. Never output a decimal here.
- Pur Rate: the printed Rate (purchase rate before discount).
- Dis %: discount percentage column (Dis%), number only. If blank use 0.
- Net Rate: Pur Rate * (1 - Dis%/100), rounded to 2 decimals.
- Sale Rate: Pur Rate * 1.15, rounded to 2 decimals (leave empty only if Pur Rate is unknown).
- MRP: MRP column, number only.
- GST%: total GST rate for the line (add CGST+SGST, e.g. "2.5+2.5" -> 5). If shown as 0+0 use 0.
- Amount: the printed line amount; if missing use Qty * Net Rate rounded to 2 decimals.

Numbers must be plain (no currency symbols, no commas inside numbers, no thousands separators).
Skip header/footer/tax-summary/total rows — only actual product lines.
Never output markdown fences, notes or explanations.`;

const AMAN_SYSTEM = `You are a pharmacy purchase-bill extraction engine for the "Aman Medical" import format.
Read the invoice image and output ONE product line per row.

Return ONLY valid CSV with EXACTLY this header, in this order:
Pack.,Product,HSN,LOT S,QTY,FREE,MFR,Batch.,Exp.,M.R.P.,Rate,Dis%,GST%,Amount,NET Rate

Rules:
- Pack.: the packing column exactly as printed, truncated the same way the bill prints it (e.g. "1 VAI", "300 M", "10 TA", "1*100", "6 TAB"). If absent leave empty.
- Product: full item name as printed, uppercase (e.g. "PAN IV.40 INJ", "METROGYL IV INJ. 100ML").
- HSN: first 4 digits of the HSN code (usually 3004). If absent use 3004.
- LOT S: the scheme/lot note exactly as printed (e.g. "9+1", "10+15"); empty if none.
- QTY: purchased quantity, whole number, excluding free.
- FREE: free quantity actually received as a whole number; if only a scheme note like "9+1" is printed, use 0.
- MFR: manufacturer short code exactly as printed, max 5 characters (e.g. ALKEM, ABBOT, ARIST, HIM T).
- Batch.: batch number exactly as printed.
- Exp.: MM/YY format.
- M.R.P.: MRP per pack, plain number with 2 decimals.
- Rate: purchase rate before discount, 2 decimals.
- Dis%: discount percentage, number only with 2 decimals; if blank use 0.00.
- GST%: total GST rate for the line (CGST+SGST), one decimal (e.g. 5.0, 12.0).
- Amount: printed line amount; if missing use QTY * Rate rounded to 2 decimals.
- NET Rate: net landing rate per unit including GST effect as printed; if not printed compute Rate * (1 - Dis%/100) * (1 + GST%/100) rounded to 2 decimals.

Example of correct output (format only, not real data):
Pack.,Product,HSN,LOT S,QTY,FREE,MFR,Batch.,Exp.,M.R.P.,Rate,Dis%,GST%,Amount,NET Rate
1 VAI,PAN IV.40 INJ,3004,10+15,25,0,ALKEM,25740123,11/27,53.90,16.43,3.00,5.0,410.75,16.73
15 TA,DIGENE TAB ORANGE.,3004,9+1,9,0,ABBOT,862003D7,02/29,30.10,20.66,3.00,5.0,185.94,21.04

Numbers must be plain (no currency symbols, no thousands separators).
Skip header/footer/tax-summary/total rows — only actual product lines.
Never output markdown fences, notes or explanations.`;

function stripFences(text: string) {
  return text
    .trim()
    .replace(/^```[a-zA-Z]*\s*/m, "")
    .replace(/```\s*$/m, "")
    .trim();
}

function splitDataUrl(dataUrl: string) {
  const match = /^data:([^;,]+);base64,(.+)$/s.exec(dataUrl.trim());
  if (!match) return null;
  return { mimeType: match[1]!, data: match[2]! };
}

const MODEL_FALLBACK_CHAIN = ["gemini-4-hydrogen", "gemini-3.1-flash-lite"] as const;

function getErrorStatus(err: unknown): number | undefined {
  if (!err || typeof err !== "object") return undefined;
  const record = err as Record<string, unknown>;
  if (typeof record["status"] === "number") return record["status"];
  if (typeof record["code"] === "number") return record["code"];
  const msg = err instanceof Error ? err.message : String(err);
  const match = /\b(400|401|403|404|429|500|502|503|504)\b/.exec(msg);
  return match ? Number(match[1]) : undefined;
}

function isTransientError(err: unknown): boolean {
  const status = getErrorStatus(err);
  if (status === 429 || status === 500 || status === 502 || status === 503 || status === 504) {
    return true;
  }
  const msg = (err instanceof Error ? err.message : String(err)).toLowerCase();
  return (
    msg.includes("unavailable") ||
    msg.includes("high demand") ||
    msg.includes("overloaded") ||
    msg.includes("temporarily") ||
    msg.includes("timeout") ||
    msg.includes("fetch failed")
  );
}

function formatGeminiError(err: unknown): string {
  const status = getErrorStatus(err);
  const rawMsg = err instanceof Error ? err.message : String(err);
  const lower = rawMsg.toLowerCase();

  if (status === 503 || lower.includes("unavailable") || lower.includes("high demand")) {
    return "Gemini is currently experiencing high demand (503). Automatic retries and fallback also hit peak load — please try again in a few seconds.";
  }
  if (status === 429 || lower.includes("resource_exhausted")) {
    return "Gemini API rate limit reached (429). Please wait a moment and try again, or check your quota in Settings > Secrets.";
  }
  if (
    status === 401 ||
    status === 403 ||
    lower.includes("permission_denied") ||
    lower.includes("api_key_invalid")
  ) {
    return "Gemini API key was rejected. Please verify your API key in Settings > Secrets.";
  }
  return rawMsg;
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export const imageToCsv = createServerFn({ method: "POST" })
  .validator((input: unknown) => Input.parse(input))
  .handler(async ({ data }) => {
    const geminiKey = process.env["GEMINI_API_KEY"];
    if (!geminiKey) throw new Error("Gemini API key is not configured.");

    const system =
      data.mode === "purchase-bill"
        ? BILL_SYSTEM
        : data.mode === "aman-medical"
          ? AMAN_SYSTEM
          : SYSTEM;

    const prompt =
      (data.mode === "purchase-bill" || data.mode === "aman-medical"
        ? "Extract every product line of this purchase bill as CSV using the required columns."
        : "Extract the table in this image as CSV.") +
      (data.hint ? ` Extra instruction: ${data.hint}` : "");

    const parts = splitDataUrl(data.image);
    if (!parts) throw new Error("Unsupported image format.");

    const ai = new GoogleGenAI({
      apiKey: geminiKey,
      httpOptions: {
        headers: {
          "User-Agent": "aistudio-build",
        },
      },
    });

    const imagePart = {
      inlineData: {
        mimeType: parts.mimeType,
        data: parts.data,
      },
    };
    const textPart = {
      text: prompt,
    };

    let raw = "";
    let usedModel: string = MODEL_FALLBACK_CHAIN[0];
    let lastError: unknown = null;

    for (const model of MODEL_FALLBACK_CHAIN) {
      const maxAttempts = 3;
      let succeeded = false;

      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        try {
          const response = await ai.models.generateContent({
            model,
            contents: { parts: [imagePart, textPart] },
            config: {
              systemInstruction: system,
            },
          });
          raw = response.text || "";
          usedModel = model;
          succeeded = true;
          break;
        } catch (err) {
          lastError = err;
          if (!isTransientError(err)) {
            throw new Error(formatGeminiError(err));
          }
          if (attempt < maxAttempts) {
            const delayMs = Math.min(1000 * 2 ** (attempt - 1), 4000);
            await sleep(delayMs);
          }
        }
      }

      if (succeeded) break;
    }

    if (!raw && lastError) {
      throw new Error(formatGeminiError(lastError));
    }

    const source = "own-key" as const;

    const csv = stripFences(raw);
    if (!csv) throw new Error("No table could be read from that image.");

    return { csv, source, model: usedModel };
  });
