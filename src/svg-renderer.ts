/**
 * Server-side SVG renderer using JSDOM + Excalidraw's exportToSvg.
 *
 * Sets up a minimal browser environment via JSDOM so that Excalidraw's
 * DOM-based SVG generation works in Node.js/Bun. The JSDOM instance is
 * created once and reused across calls.
 *
 * Known limitations (see plan's Known Risks):
 * - Text measurement may be approximate without a real rendering engine.
 * - Font inlining is skipped server-side (skipInliningFonts: true).
 * - If JSDOM + exportToSvg fails, falls back to a minimal placeholder SVG.
 */
import { PSEUDO_TYPES } from "./shared.js";

const EXPORT_PADDING = 20;

/** Lazy-loaded JSDOM + Excalidraw modules. */
let initialized = false;
let exportToSvgFn: any = null;
let convertToExcalidrawElementsFn: any = null;

/**
 * Initialize the JSDOM environment and import Excalidraw.
 * Must be called before any rendering. Idempotent.
 */
async function ensureInitialized(): Promise<void> {
  if (initialized) return;

  const { JSDOM } = await import("jsdom");

  const dom = new JSDOM("<!DOCTYPE html><html><body></body></html>", {
    url: "http://localhost",
    pretendToBeVisual: true,
  });

  // Patch globals that Excalidraw needs for DOM-based SVG generation
  const g = globalThis as any;
  if (!g.window) g.window = dom.window;
  if (!g.document) g.document = dom.window.document;
  if (!g.navigator) g.navigator = dom.window.navigator;
  if (!g.HTMLElement) g.HTMLElement = dom.window.HTMLElement;
  if (!g.SVGElement) g.SVGElement = dom.window.SVGElement;
  if (!g.Element) g.Element = dom.window.Element;
  if (!g.DOMParser) g.DOMParser = dom.window.DOMParser;
  if (!g.XMLSerializer) g.XMLSerializer = dom.window.XMLSerializer;
  // FontFace stub — JSDOM doesn't support the Font Loading API
  if (!g.FontFace) {
    g.FontFace = class FontFace {
      family: string;
      constructor(family: string, _source: any) {
        this.family = family;
      }
      async load() {
        return this;
      }
    };
  }
  // document.fonts stub
  if (!g.document.fonts) {
    g.document.fonts = {
      add: () => {},
      check: () => true,
      load: async () => [],
      ready: Promise.resolve(),
      forEach: () => {},
    };
  }

  try {
    const excalidraw = await import("@excalidraw/excalidraw");
    exportToSvgFn = excalidraw.exportToSvg;
    convertToExcalidrawElementsFn = excalidraw.convertToExcalidrawElements;
    initialized = true;
  } catch (err) {
    console.error("Failed to initialize Excalidraw for server-side rendering:", err);
    // Mark as initialized so we don't retry — renderSvg will use fallback
    initialized = true;
  }
}

/**
 * Extract the last cameraUpdate viewport from an elements array.
 *
 * @param elements - Elements array that may include cameraUpdate pseudo-elements.
 * @returns The viewport rect, or null if no cameraUpdate found.
 */
function extractViewport(
  elements: any[],
): { x: number; y: number; width: number; height: number } | null {
  let viewport: { x: number; y: number; width: number; height: number } | null = null;
  for (const el of elements) {
    if (el.type === "cameraUpdate") {
      viewport = { x: el.x, y: el.y, width: el.width, height: el.height };
    }
  }
  return viewport;
}

/**
 * Compute the bounding box of all elements.
 *
 * @param elements - Excalidraw elements.
 * @returns Min x/y across all elements.
 */
function computeSceneBounds(elements: any[]): { minX: number; minY: number } {
  let minX = Infinity;
  let minY = Infinity;
  for (const el of elements) {
    if (el.x != null) {
      minX = Math.min(minX, el.x);
      minY = Math.min(minY, el.y);
      if (el.points && Array.isArray(el.points)) {
        for (const pt of el.points) {
          minX = Math.min(minX, el.x + pt[0]);
          minY = Math.min(minY, el.y + pt[1]);
        }
      }
    }
  }
  return { minX: isFinite(minX) ? minX : 0, minY: isFinite(minY) ? minY : 0 };
}

/**
 * Render resolved Excalidraw elements to an SVG string.
 *
 * Uses Excalidraw's exportToSvg with a JSDOM-provided DOM environment.
 * Falls back to a simple placeholder SVG if the Excalidraw pipeline fails.
 *
 * @param elements - Resolved elements array (may include pseudo-elements which are filtered out).
 * @returns SVG markup string.
 */
export async function renderSvg(elements: any[]): Promise<string> {
  await ensureInitialized();

  // Extract viewport before filtering pseudo-elements
  const viewport = extractViewport(elements);

  // Filter out pseudo-elements
  const realElements = elements.filter((el: any) => !PSEUDO_TYPES.has(el.type));
  if (realElements.length === 0) {
    return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 300"><text x="200" y="150" text-anchor="middle" fill="#999">Empty diagram</text></svg>';
  }

  // If Excalidraw failed to load, use fallback
  if (!exportToSvgFn || !convertToExcalidrawElementsFn) {
    return generateFallbackSvg(realElements, viewport);
  }

  try {
    // Convert using skeleton API for label support (same as DrawingPanel.tsx)
    const withDefaults = realElements.map((el: any) =>
      el.label
        ? { ...el, label: { textAlign: "center", verticalAlign: "middle", ...el.label } }
        : el,
    );
    const converted = convertToExcalidrawElementsFn(withDefaults, {
      regenerateIds: false,
    }).map((el: any) => (el.type === "text" ? { ...el, fontFamily: 1 } : el));

    const svg = await exportToSvgFn({
      elements: converted,
      appState: {
        viewBackgroundColor: "#ffffff",
        exportBackground: true,
      },
      files: null,
      exportPadding: EXPORT_PADDING,
      skipInliningFonts: true,
    });

    if (!svg) {
      return generateFallbackSvg(realElements, viewport);
    }

    // Apply viewport-based viewBox if a cameraUpdate was present
    if (viewport) {
      const { minX, minY } = computeSceneBounds(converted);
      const vbX = viewport.x - minX + EXPORT_PADDING;
      const vbY = viewport.y - minY + EXPORT_PADDING;
      svg.setAttribute("viewBox", `${vbX} ${vbY} ${viewport.width} ${viewport.height}`);
    }

    return svg.outerHTML;
  } catch (err) {
    console.error("exportToSvg failed, using fallback:", err);
    return generateFallbackSvg(realElements, viewport);
  }
}

/**
 * Generate a minimal fallback SVG when Excalidraw's exportToSvg is unavailable.
 * Renders basic shapes and text as simple SVG elements.
 *
 * @param elements - Real Excalidraw elements (pseudo-elements already filtered).
 * @param viewport - Optional viewport from cameraUpdate.
 * @returns SVG markup string.
 */
function generateFallbackSvg(
  elements: any[],
  viewport: { x: number; y: number; width: number; height: number } | null,
): string {
  const vp = viewport ?? { x: 0, y: 0, width: 800, height: 600 };
  const parts: string[] = [];

  parts.push(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${vp.x} ${vp.y} ${vp.width} ${vp.height}">`,
  );
  parts.push(`<rect x="${vp.x}" y="${vp.y}" width="${vp.width}" height="${vp.height}" fill="#ffffff"/>`);

  for (const el of elements) {
    const fill = el.backgroundColor && el.backgroundColor !== "transparent"
      ? el.backgroundColor
      : "none";
    const stroke = el.strokeColor ?? "#1e1e1e";
    const sw = el.strokeWidth ?? 2;

    switch (el.type) {
      case "rectangle":
        parts.push(
          `<rect x="${el.x}" y="${el.y}" width="${el.width}" height="${el.height}" fill="${fill}" stroke="${stroke}" stroke-width="${sw}" rx="${el.roundness ? 8 : 0}"/>`,
        );
        if (el.label?.text) {
          const cx = el.x + el.width / 2;
          const cy = el.y + el.height / 2;
          const fs = el.label.fontSize ?? 16;
          parts.push(
            `<text x="${cx}" y="${cy}" text-anchor="middle" dominant-baseline="central" font-size="${fs}" fill="${stroke}">${escapeXml(el.label.text)}</text>`,
          );
        }
        break;
      case "ellipse":
        parts.push(
          `<ellipse cx="${el.x + el.width / 2}" cy="${el.y + el.height / 2}" rx="${el.width / 2}" ry="${el.height / 2}" fill="${fill}" stroke="${stroke}" stroke-width="${sw}"/>`,
        );
        break;
      case "diamond": {
        const cx = el.x + el.width / 2;
        const cy = el.y + el.height / 2;
        parts.push(
          `<polygon points="${cx},${el.y} ${el.x + el.width},${cy} ${cx},${el.y + el.height} ${el.x},${cy}" fill="${fill}" stroke="${stroke}" stroke-width="${sw}"/>`,
        );
        break;
      }
      case "text":
        parts.push(
          `<text x="${el.x}" y="${el.y + (el.fontSize ?? 16)}" font-size="${el.fontSize ?? 16}" fill="${stroke}">${escapeXml(el.text ?? "")}</text>`,
        );
        break;
      case "arrow":
        if (el.points && el.points.length >= 2) {
          const pts = el.points.map((p: number[]) => `${el.x + p[0]},${el.y + p[1]}`).join(" ");
          parts.push(
            `<polyline points="${pts}" fill="none" stroke="${stroke}" stroke-width="${sw}" marker-end="${el.endArrowhead ? 'url(#arrow)' : ''}"/>`,
          );
        }
        break;
    }
  }

  // Arrow marker definition
  parts.push('<defs><marker id="arrow" viewBox="0 0 10 10" refX="10" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z" fill="#1e1e1e"/></marker></defs>');
  parts.push("</svg>");

  return parts.join("\n");
}

/**
 * Escape special XML characters in text content.
 *
 * @param str - Raw text string.
 * @returns XML-safe string.
 */
function escapeXml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
