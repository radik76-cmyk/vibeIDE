import { Resvg } from "@resvg/resvg-js";

const FONT_SIZE = 14;
const HEADER_FONT_SIZE = 13;
const LINE_HEIGHT = 1.5;
const CELL_PAD_X = 12;
const CELL_PAD_Y = 8;
const FONT_FAMILY = "Consolas, 'Courier New', monospace";

const LIGHT = {
  bg: "#ffffff",
  headerBg: "#f0f3f6",
  headerFg: "#1a1a2e",
  cellFg: "#2d2d3a",
  border: "#d1d5db",
  stripe: "#f8f9fb",
};

function escXml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function measureText(text: string, fontSize: number): number {
  return text.length * fontSize * 0.62;
}

export function renderTablePng(
  headers: string[],
  rows: string[][]
): Buffer {
  const t = LIGHT;
  const colCount = headers.length;

  const colWidths: number[] = [];
  for (let c = 0; c < colCount; c++) {
    let max = measureText(headers[c], HEADER_FONT_SIZE) + CELL_PAD_X * 2;
    for (const row of rows) {
      const w = measureText(row[c] ?? "", FONT_SIZE) + CELL_PAD_X * 2;
      if (w > max) max = w;
    }
    colWidths.push(Math.ceil(max));
  }

  const rowHeight = Math.ceil(FONT_SIZE * LINE_HEIGHT + CELL_PAD_Y * 2);
  const headerHeight = Math.ceil(HEADER_FONT_SIZE * LINE_HEIGHT + CELL_PAD_Y * 2);
  const totalWidth = colWidths.reduce((a, b) => a + b, 0) + 1;
  const totalHeight = headerHeight + rowHeight * rows.length + 1;

  const parts: string[] = [];
  parts.push(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${totalWidth}" height="${totalHeight}">`
  );
  parts.push(`<rect width="${totalWidth}" height="${totalHeight}" fill="${t.bg}" rx="6"/>`);

  // Header background
  parts.push(
    `<rect x="0" y="0" width="${totalWidth}" height="${headerHeight}" fill="${t.headerBg}" rx="6"/>`
  );
  // Square off bottom corners of header
  parts.push(
    `<rect x="0" y="${headerHeight - 6}" width="${totalWidth}" height="6" fill="${t.headerBg}"/>`
  );

  // Header cells
  let x = 0;
  for (let c = 0; c < colCount; c++) {
    const textX = x + CELL_PAD_X;
    const textY = headerHeight / 2;
    parts.push(
      `<text x="${textX}" y="${textY}" font-family="${FONT_FAMILY}" font-size="${HEADER_FONT_SIZE}" font-weight="600" fill="${t.headerFg}" dominant-baseline="central">${escXml(headers[c])}</text>`
    );
    x += colWidths[c];
  }

  // Header bottom border
  parts.push(
    `<line x1="0" y1="${headerHeight}" x2="${totalWidth}" y2="${headerHeight}" stroke="${t.border}" stroke-width="1"/>`
  );

  // Data rows
  for (let r = 0; r < rows.length; r++) {
    const rowY = headerHeight + r * rowHeight;

    // Zebra stripe
    if (r % 2 === 1) {
      parts.push(
        `<rect x="0" y="${rowY}" width="${totalWidth}" height="${rowHeight}" fill="${t.stripe}"/>`
      );
    }

    x = 0;
    for (let c = 0; c < colCount; c++) {
      const textX = x + CELL_PAD_X;
      const textY = rowY + rowHeight / 2;
      parts.push(
        `<text x="${textX}" y="${textY}" font-family="${FONT_FAMILY}" font-size="${FONT_SIZE}" fill="${t.cellFg}" dominant-baseline="central">${escXml(rows[r][c] ?? "")}</text>`
      );
      x += colWidths[c];
    }

    // Row separator
    if (r < rows.length - 1) {
      const lineY = rowY + rowHeight;
      parts.push(
        `<line x1="0" y1="${lineY}" x2="${totalWidth}" y2="${lineY}" stroke="${t.border}" stroke-width="0.5" opacity="0.5"/>`
      );
    }
  }

  // Outer border
  parts.push(
    `<rect x="0" y="0" width="${totalWidth}" height="${totalHeight}" fill="none" stroke="${t.border}" stroke-width="1" rx="6"/>`
  );

  // Column separators
  x = 0;
  for (let c = 0; c < colCount - 1; c++) {
    x += colWidths[c];
    parts.push(
      `<line x1="${x}" y1="0" x2="${x}" y2="${totalHeight}" stroke="${t.border}" stroke-width="0.5" opacity="0.4"/>`
    );
  }

  parts.push("</svg>");

  const svg = parts.join("\n");
  const resvg = new Resvg(svg, {
    fitTo: { mode: "width", value: Math.min(totalWidth * 2, 2048) },
  });
  return Buffer.from(resvg.render().asPng());
}
