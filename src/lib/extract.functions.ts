import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

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

/** Direct Google Generative Language API using the user's own Gemini key. */
async function callGemini(key: string, system: string, prompt: string, image: string) {
  const parts = splitDataUrl(image);
  if (!parts) throw new Error("Unsupported image format.");

  const res = await fetch(
    "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.6-flash:generateContent",
    {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": key },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: system }] },
        contents: [
          {
            role: "user",
            parts: [
              { text: prompt },
              { inlineData: { mimeType: parts.mimeType, data: parts.data } },
            ],
          },
        ],
      }),
    },
  );

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Gemini API error ${res.status}: ${body.slice(0, 300)}`);
  }

  const json = (await res.json()) as {
    candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
  };
  return (json.candidates?.[0]?.content?.parts ?? [])
    .map((p) => p.text ?? "")
    .join("");
}

/** Lovable AI Gateway fallback. */
async function callGateway(key: string, system: string, prompt: string, image: string) {
  const res = await fetch("https://ai.gateway.lovable.dev/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Lovable-API-Key": key,
      "X-Lovable-AIG-SDK": "fetch",
    },
    body: JSON.stringify({
      model: "google/gemini-3.6-flash",
      messages: [
        { role: "system", content: system },
        {
          role: "user",
          content: [
            { type: "text", text: prompt },
            { type: "image_url", image_url: { url: image } },
          ],
        },
      ],
    }),
  });

  if (res.status === 429) throw new Error("Rate limit reached. Please try again in a moment.");
  if (res.status === 402) throw new Error("AI credits exhausted. Add credits to continue.");
  if (!res.ok) throw new Error(`Extraction failed (${res.status}).`);

  const json = (await res.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
  };
  return json.choices?.[0]?.message?.content ?? "";
}

export const imageToCsv = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) => Input.parse(input))
  .handler(async ({ data }) => {
    const geminiKey = process.env["GEMINI_API_KEY"];
    const lovableKey = process.env["LOVABLE_API_KEY"];
    if (!geminiKey && !lovableKey) throw new Error("AI is not configured.");

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

    let raw = "";
    let source: "own-key" | "lovable" = "own-key";

    if (geminiKey) {
      try {
        raw = await callGemini(geminiKey, system, prompt, data.image);
      } catch (err) {
        console.error("Own Gemini key failed, falling back to Lovable AI:", err);
        if (!lovableKey) {
          throw err instanceof Error ? err : new Error("Extraction failed.");
        }
      }
    }

    if (!raw.trim() && lovableKey) {
      raw = await callGateway(lovableKey, system, prompt, data.image);
      source = "lovable";
    }

    const csv = stripFences(raw);
    if (!csv) throw new Error("No table could be read from that image.");
    return { csv, source };
  });

