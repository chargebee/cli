/** Visible width for ASCII help: one cell per JS code point (`✓` is width 1). */
export function displayWidth(s: string): number {
  return [...s].length;
}

function padEndDisplay(s: string, width: number): string {
  const w = displayWidth(s);
  if (w >= width) return [...s].slice(0, width).join("");
  return s + " ".repeat(width - w);
}

/** Draw a box whose every line (including the title border) has the same length. */
export function renderBox(title: string, body: string[]): string {
  const titleStr = ` ${title} `;
  const inner = Math.max(titleStr.length + 1, ...body.map(displayWidth), 56);
  const dashAfter = inner - titleStr.length;
  const top = `┌${titleStr}${"─".repeat(dashAfter)}┐`;
  const mid = body.map((row) => `│${padEndDisplay(row, inner)}│`);
  const bot = `└${"─".repeat(inner)}┘`;
  return [top, ...mid, bot].join("\n");
}
