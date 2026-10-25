import { useCallback, useEffect, useRef, useState } from 'react';
import type { Cell, ServerConfig } from '../../shared/protocol';
import { useT } from '../lib/i18n';

export type Viewport = { scale: number; offsetX: number; offsetY: number };

type Props = {
  config: ServerConfig;
  canvasRef: React.RefObject<Uint8Array | null>;
  /** bumped whenever the whole canvas buffer must be repainted */
  fullVersion: number;
  /** announced pixel patches; each entry is paired with `patchVersion` */
  patch: Cell[];
  patchVersion: number;
  /** bumped to re-render without repainting (hover, viewport) */
  selectedColor: number;
  canPlace: boolean;
  focusRequest: { x: number; y: number; nonce: number } | null;
  onPlace: (x: number, y: number, options?: { report?: boolean }) => void;
  onReport: (x: number, y: number) => void;
  onHover: (cell: { x: number; y: number } | null) => void;
  onViewportChange?: (v: Viewport) => void;
  children?: React.ReactNode;
};

const MIN_SCALE = 1;
const MAX_SCALE = 40;

/**
 * Canvas renderer and pointer interaction.
 *
 * Performance
 *  - The board lives in a 1px-per-cell offscreen canvas; a delta only writes a few
 *    `fillRect(1,1)`s, and the visible canvas is blitted with smoothing disabled so
 *    pixels stay crisp at any zoom.
 *  - Pan/zoom only mutate the viewport; the board is never re-uploaded.
 *  - Pointer handling supports mouse drag-pan, wheel/pinch zoom and tap-to-place,
 *    which is what makes the same component usable on desktop and iPhone.
 */
export default function PixelCanvas({
  config,
  canvasRef,
  fullVersion,
  patch,
  patchVersion,
  selectedColor,
  canPlace,
  focusRequest,
  onPlace,
  onReport,
  onHover,
  onViewportChange,
  children,
}: Props) {
  const { t } = useT();
  const hostRef = useRef<HTMLDivElement | null>(null);
  const viewRef = useRef<HTMLCanvasElement | null>(null);
  const boardRef = useRef<HTMLCanvasElement | null>(null);
  const boardCtxRef = useRef<CanvasRenderingContext2D | null>(null);

  const [viewport, setViewport] = useState<Viewport>({ scale: 4, offsetX: 0, offsetY: 0 });
  const [hover, setHover] = useState<{ x: number; y: number } | null>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });

  const viewportRef = useRef(viewport);
  viewportRef.current = viewport;
  const hoverRef = useRef(hover);
  hoverRef.current = hover;

  /* ------------------------------------------------------------- board --- */

  const ensureBoard = useCallback((): CanvasRenderingContext2D | null => {
    if (boardCtxRef.current) return boardCtxRef.current;
    const board = document.createElement('canvas');
    board.width = config.width;
    board.height = config.height;
    const ctx = board.getContext('2d', { alpha: false });
    if (!ctx) return null;
    boardRef.current = board;
    boardCtxRef.current = ctx;
    return ctx;
  }, [config.height, config.width]);

  const paletteRgbRef = useRef<Array<[number, number, number]>>([]);
  useEffect(() => {
    paletteRgbRef.current = config.palette.map(hexToRgb);
  }, [config.palette]);

  const paintFullBoard = useCallback(() => {
    const ctx = ensureBoard();
    const indices = canvasRef.current;
    if (!ctx || !indices) return;
    const palette = paletteRgbRef.current;
    const image = ctx.createImageData(config.width, config.height);
    const data = image.data;
    for (let i = 0; i < indices.length; i++) {
      const rgb = palette[indices[i]!] ?? [0, 0, 0];
      const p = i * 4;
      data[p] = rgb[0];
      data[p + 1] = rgb[1];
      data[p + 2] = rgb[2];
      data[p + 3] = 255;
    }
    ctx.putImageData(image, 0, 0);
  }, [canvasRef, config.height, config.width, ensureBoard]);

  const paintPatch = useCallback(
    (cells: Cell[]) => {
      if (cells.length === 0) return;
      const ctx = ensureBoard();
      if (!ctx) return;
      const palette = paletteRgbRef.current;
      for (const cell of cells) {
        const rgb = palette[cell.c] ?? [0, 0, 0];
        ctx.fillStyle = `rgb(${rgb[0]},${rgb[1]},${rgb[2]})`;
        ctx.fillRect(cell.x, cell.y, 1, 1);
      }
    },
    [ensureBoard],
  );

  /* ----------------------------------------------------------- painting -- */

  const draw = useCallback(() => {
    const view = viewRef.current;
    const board = boardRef.current;
    if (!view || !board) return;
    const ctx = view.getContext('2d', { alpha: false });
    if (!ctx) return;
    const dpr = Math.min(3, window.devicePixelRatio || 1);
    const cssW = view.clientWidth;
    const cssH = view.clientHeight;
    if (cssW === 0 || cssH === 0) return;
    if (view.width !== Math.round(cssW * dpr) || view.height !== Math.round(cssH * dpr)) {
      view.width = Math.round(cssW * dpr);
      view.height = Math.round(cssH * dpr);
    }
    const { scale, offsetX, offsetY } = viewportRef.current;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.imageSmoothingEnabled = false;
    ctx.fillStyle = '#080a13';
    ctx.fillRect(0, 0, cssW, cssH);

    const drawW = config.width * scale;
    const drawH = config.height * scale;

    // Checkerboard behind the artwork so "empty" reads as empty.
    const cell = Math.max(8, Math.min(28, Math.round(scale * 2)));
    ctx.fillStyle = '#101424';
    ctx.fillRect(offsetX, offsetY, drawW, drawH);
    ctx.fillStyle = '#161b30';
    const cols = Math.ceil(drawW / cell);
    const rows = Math.ceil(drawH / cell);
    for (let row = 0; row < rows; row++) {
      for (let col = 0; col < cols; col++) {
        if ((row + col) % 2 === 0) continue;
        ctx.fillRect(offsetX + col * cell, offsetY + row * cell, cell, cell);
      }
    }

    ctx.drawImage(board, offsetX, offsetY, drawW, drawH);

    if (scale >= 7) {
      ctx.strokeStyle = 'rgba(255,255,255,0.06)';
      ctx.lineWidth = 1;
      const step = scale >= 18 ? 1 : 4;
      ctx.beginPath();
      for (let x = 0; x <= config.width; x += step) {
        const px = Math.round(offsetX + x * scale) + 0.5;
        if (px < 0 || px > cssW) continue;
        ctx.moveTo(px, Math.max(0, offsetY));
        ctx.lineTo(px, Math.min(cssH, offsetY + drawH));
      }
      for (let y = 0; y <= config.height; y += step) {
        const py = Math.round(offsetY + y * scale) + 0.5;
        if (py < 0 || py > cssH) continue;
        ctx.moveTo(Math.max(0, offsetX), py);
        ctx.lineTo(Math.min(cssW, offsetX + drawW), py);
      }
      ctx.stroke();
    }

    const target = hoverRef.current ?? (focusRequest ? { x: focusRequest.x, y: focusRequest.y } : null);
    if (target) {
      ctx.strokeStyle = canPlace ? 'rgba(255,255,255,0.95)' : 'rgba(255,120,120,0.9)';
      ctx.lineWidth = 2;
      const sx = offsetX + target.x * scale;
      const sy = offsetY + target.y * scale;
      ctx.strokeRect(sx + 1, sy + 1, Math.max(2, scale - 2), Math.max(2, scale - 2));
    }

    ctx.strokeStyle = 'rgba(140,160,255,0.4)';
    ctx.lineWidth = 1;
    ctx.strokeRect(offsetX + 0.5, offsetY + 0.5, drawW - 1, drawH - 1);
  }, [canPlace, config.height, config.width, focusRequest]);

  /* ------------------------------------------------------------- resize -- */

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const observer = new ResizeObserver((entries) => {
      const rect = entries[0]?.contentRect;
      if (rect && rect.width > 0) setSize({ width: rect.width, height: rect.height });
    });
    observer.observe(host);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    paintFullBoard();
    draw();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fullVersion, config.width, config.height]);

  useEffect(() => {
    if (patch.length === 0) return;
    paintPatch(patch);
    draw();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [patchVersion]);

  useEffect(() => {
    draw();
  }, [draw, viewport, size, hover, selectedColor]);

  useEffect(() => {
    onViewportChange?.(viewport);
  }, [onViewportChange, viewport]);

  /* --------------------------------------------------- initial viewport -- */

  const setViewportSafe = useCallback(
    (vp: Viewport) => {
      const host = hostRef.current;
      const cssW = host?.clientWidth ?? 800;
      const cssH = host?.clientHeight ?? 600;
      setViewport(clampViewport(vp, config, cssW, cssH));
    },
    [config],
  );

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const cssW = host.clientWidth;
    const cssH = host.clientHeight;
    if (cssW === 0 || cssH === 0) return;
    const padding = 24;
    const scale = Math.max(
      MIN_SCALE,
      Math.min((cssW - padding * 2) / config.width, (cssH - padding * 2) / config.height),
    );
    setViewport({
      scale,
      offsetX: (cssW - config.width * scale) / 2,
      offsetY: (cssH - config.height * scale) / 2,
    });
    // Fit once per canvas geometry.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [config.width, config.height]);

  /* ------------------------------------------------------ focus request -- */

  useEffect(() => {
    if (!focusRequest) return;
    const host = hostRef.current;
    if (!host) return;
    const cssW = host.clientWidth;
    const cssH = host.clientHeight;
    const scale = Math.max(viewportRef.current.scale, 10);
    setViewportSafe({
      scale,
      offsetX: cssW / 2 - (focusRequest.x + 0.5) * scale,
      offsetY: cssH / 2 - (focusRequest.y + 0.5) * scale,
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusRequest?.nonce]);

  /* ------------------------------------------------------------ pointer -- */

  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const gesture = useRef<{
    startX: number;
    startY: number;
    moved: boolean;
    pinchStart?: { distance: number; scale: number };
  } | null>(null);

  const screenToCell = useCallback(
    (clientX: number, clientY: number) => {
      const host = hostRef.current;
      if (!host) return null;
      const rect = host.getBoundingClientRect();
      const { scale, offsetX, offsetY } = viewportRef.current;
      const x = Math.floor((clientX - rect.left - offsetX) / scale);
      const y = Math.floor((clientY - rect.top - offsetY) / scale);
      if (x < 0 || y < 0 || x >= config.width || y >= config.height) return null;
      return { x, y };
    },
    [config.height, config.width],
  );

  const kind = useRef<'place' | 'report'>('place');
  const pressTimer = useRef<number | null>(null);

  const clearPress = () => {
    if (pressTimer.current !== null) {
      window.clearTimeout(pressTimer.current);
      pressTimer.current = null;
    }
  };

  const onPointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    // Floating controls (palette tabs, share/report, cooldown CTA) live inside the
    // stage so they can hover over the canvas. Their presses must stay theirs:
    // capturing the pointer here would swallow the resulting click.
    if (event.target !== viewRef.current) return;

    (event.currentTarget as HTMLElement).setPointerCapture?.(event.pointerId);
    pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (pointers.current.size === 1) {
      // Shift+click reports on desktop; long-press reports on touch.
      kind.current = event.shiftKey ? 'report' : 'place';
      gesture.current = { startX: event.clientX, startY: event.clientY, moved: false };
      clearPress();
      pressTimer.current = window.setTimeout(() => {
        const cell = screenToCell(event.clientX, event.clientY);
        if (cell && kind.current === 'place') {
          kind.current = 'report';
          onReport(cell.x, cell.y);
          if (gesture.current) gesture.current.moved = true;
        }
      }, 620);
    } else if (pointers.current.size === 2) {
      clearPress();
      const [a, b] = [...pointers.current.values()];
      if (a && b) {
        gesture.current = {
          startX: 0,
          startY: 0,
          moved: true,
          pinchStart: { distance: Math.hypot(a.x - b.x, a.y - b.y), scale: viewportRef.current.scale },
        };
      }
    }
  };

  const onPointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    // Ignore moves that did not start on the canvas surface (overlay controls).
    if (!pointers.current.has(event.pointerId) && event.pointerType !== 'mouse') return;
    const previous = pointers.current.get(event.pointerId);
    pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
    const host = hostRef.current;
    if (!gesture.current && event.pointerType === 'mouse' && event.target !== viewRef.current) return;

    if (pointers.current.size >= 2) {
      clearPress();
      const [a, b] = [...pointers.current.values()];
      const pinch = gesture.current?.pinchStart;
      if (a && b && pinch && host) {
        const rect = host.getBoundingClientRect();
        const distance = Math.hypot(a.x - b.x, a.y - b.y);
        const midX = (a.x + b.x) / 2 - rect.left;
        const midY = (a.y + b.y) / 2 - rect.top;
        const current = viewportRef.current;
        const cellX = (midX - current.offsetX) / current.scale;
        const cellY = (midY - current.offsetY) / current.scale;
        const scale = clamp(pinch.scale * (distance / (pinch.distance || 1)), MIN_SCALE, MAX_SCALE);
        setViewportSafe({ scale, offsetX: midX - cellX * scale, offsetY: midY - cellY * scale });
      }
      return;
    }

    const g = gesture.current;
    if (g && previous && event.buttons === 1 && host) {
      const moved = Math.hypot(event.clientX - g.startX, event.clientY - g.startY);
      if (moved > 6) {
        g.moved = true;
        clearPress();
      }
      if (g.moved) {
        const current = viewportRef.current;
        setViewportSafe({
          scale: current.scale,
          offsetX: current.offsetX + (event.clientX - previous.x),
          offsetY: current.offsetY + (event.clientY - previous.y),
        });
      }
    }

    const cell = screenToCell(event.clientX, event.clientY);
    if (cell?.x !== hoverRef.current?.x || cell?.y !== hoverRef.current?.y) {
      setHover(cell);
      onHover(cell);
    }
  };

  const endGesture = (event: React.PointerEvent<HTMLDivElement>) => {
    clearPress();
    pointers.current.delete(event.pointerId);
    const g = gesture.current;
    if (pointers.current.size === 0) {
      // `pointerup` on the pane (never on an overlay child) means "place here".
      if (event.type === 'pointerup' && g && !g.moved) {
        const cell = screenToCell(event.clientX, event.clientY);
        if (cell) {
          if (kind.current === 'report') onReport(cell.x, cell.y);
          else onPlace(cell.x, cell.y);
        }
      }
      gesture.current = null;
      kind.current = 'place';
    }
  };

  const onWheel = (event: React.WheelEvent<HTMLDivElement>) => {
    event.preventDefault();
    const host = hostRef.current;
    if (!host) return;
    const rect = host.getBoundingClientRect();
    const current = viewportRef.current;
    const factor = Math.exp(-event.deltaY * 0.0022);
    const scale = clamp(current.scale * factor, MIN_SCALE, MAX_SCALE);
    const x = event.clientX - rect.left;
    const y = event.clientY - rect.top;
    const cellX = (x - current.offsetX) / current.scale;
    const cellY = (y - current.offsetY) / current.scale;
    setViewportSafe({ scale, offsetX: x - cellX * scale, offsetY: y - cellY * scale });
  };

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const prevent = (event: Event) => event.preventDefault();
    host.addEventListener('gesturestart', prevent);
    host.addEventListener('contextmenu', prevent);
    return () => {
      host.removeEventListener('gesturestart', prevent);
      host.removeEventListener('contextmenu', prevent);
    };
  }, []);

  const zoomBy = (factor: number) => {
    const host = hostRef.current;
    if (!host) return;
    const current = viewportRef.current;
    const scale = clamp(current.scale * factor, MIN_SCALE, MAX_SCALE);
    const cx = host.clientWidth / 2;
    const cy = host.clientHeight / 2;
    const cellX = (cx - current.offsetX) / current.scale;
    const cellY = (cy - current.offsetY) / current.scale;
    setViewportSafe({ scale, offsetX: cx - cellX * scale, offsetY: cy - cellY * scale });
  };

  const fit = () => {
    const host = hostRef.current;
    if (!host) return;
    const cssW = host.clientWidth;
    const cssH = host.clientHeight;
    const padding = 24;
    const scale = Math.max(
      MIN_SCALE,
      Math.min((cssW - padding * 2) / config.width, (cssH - padding * 2) / config.height),
    );
    setViewport({
      scale,
      offsetX: (cssW - config.width * scale) / 2,
      offsetY: (cssH - config.height * scale) / 2,
    });
  };

  return (
    <div className="canvas-stage">
      <div
        ref={hostRef}
        className="canvas-host"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endGesture}
        onPointerCancel={endGesture}
        onPointerLeave={() => {
          setHover(null);
          onHover(null);
        }}
        onWheel={onWheel}
        role="application"
        aria-label={t('app.canvasAria')}
        data-testid="canvas-host"
      >
        <canvas ref={viewRef} className="canvas-view" data-testid="canvas-view" />
        {children}
      </div>
      <div className="zoom-controls" role="group" aria-label={t('app.zoomControls')}>
        <button type="button" onClick={() => zoomBy(1.35)} aria-label={t('app.zoomIn')} data-testid="zoom-in">
          +
        </button>
        <button type="button" onClick={() => zoomBy(1 / 1.35)} aria-label={t('app.zoomOut')} data-testid="zoom-out">
          −
        </button>
        <button type="button" onClick={fit} aria-label={t('app.zoomFit')} data-testid="zoom-fit">
          fit
        </button>
        <span className="zoom-readout" data-testid="zoom-readout">
          {viewport.scale.toFixed(1)}×
        </span>
      </div>
    </div>
  );
}

/* ---------------------------------------------------------------- helpers */

export function clampViewport(
  vp: Viewport,
  config: { width: number; height: number },
  cssW: number,
  cssH: number,
): Viewport {
  const scale = clamp(vp.scale, MIN_SCALE, MAX_SCALE);
  const drawW = config.width * scale;
  const drawH = config.height * scale;
  // Always keep at least ~64px of the board inside the viewport on each axis.
  const keep = 64;
  const minOffsetX = keep - drawW;
  const maxOffsetX = Math.max(cssW - keep, keep - drawW);
  const minOffsetY = keep - drawH;
  const maxOffsetY = Math.max(cssH - keep, keep - drawH);
  return {
    scale,
    offsetX: clamp(vp.offsetX, minOffsetX, maxOffsetX),
    offsetY: clamp(vp.offsetY, minOffsetY, maxOffsetY),
  };
}

function clamp(value: number, min: number, max: number): number {
  if (max < min) return min;
  return Math.min(max, Math.max(min, value));
}

export function hexToRgb(hex: string): [number, number, number] {
  const clean = hex.replace('#', '');
  const full = clean.length === 3 ? clean.split('').map((c) => c + c).join('') : clean;
  return [
    Number.parseInt(full.slice(0, 2), 16) || 0,
    Number.parseInt(full.slice(2, 4), 16) || 0,
    Number.parseInt(full.slice(4, 6), 16) || 0,
  ];
}

export { MIN_SCALE, MAX_SCALE };
