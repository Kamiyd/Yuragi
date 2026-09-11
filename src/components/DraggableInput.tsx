import {
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type ChangeEvent,
  type CSSProperties,
  type KeyboardEvent,
  type PointerEvent,
  type TransitionEvent,
} from "react";

export type DraggableInputProps = {
  id?: string;
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  onChange: (value: number) => void;
  formatValue?: (value: number) => string;
  inputScale?: number;
  disabled?: boolean;
  onInteractionCancel?: () => void;
  onInteractionEnd?: () => void;
  onInteractionStart?: () => void;
};

type DraggableInputStyle = CSSProperties & {
  "--draggable-input-progress": string;
};

type TextZone = { left: number; right: number };

const MARKER_INSET = 10;
const OVERDRAG_LIMIT = 8;
const OVERDRAG_RESISTANCE = 24;
const CONTENT_SHIFT_LIMIT = 2;
const MARKER_SHIFT_LIMIT = 3;
const VERTICAL_COMPRESSION_LIMIT = 0.04;

function clampAndSnap(value: number, min: number, max: number, step: number) {
  const clamped = Math.min(max, Math.max(min, value));
  if (!Number.isFinite(step) || step <= 0) return clamped;
  const snapped = min + Math.round((clamped - min) / step) * step;
  const precision = Math.max(0, (String(step).split(".")[1] || "").length);
  return Number(Math.min(max, Math.max(min, snapped)).toFixed(precision));
}

function progressFor(value: number, min: number, max: number) {
  const span = max - min;
  if (!Number.isFinite(value) || span <= 0) return 0;
  return Math.min(100, Math.max(0, ((value - min) / span) * 100));
}

function pointerValueFor(clientX: number, left: number, right: number, min: number, max: number, step: number) {
  const width = right - left;
  if (width <= 0) return null;
  const edge = Math.min(width, Math.max(0, clientX - left + MARKER_INSET));
  return clampAndSnap(min + (edge / width) * (max - min), min, max, step);
}

function overdragFor(clientX: number, left: number, right: number) {
  const distance = clientX < left ? clientX - left : clientX > right ? clientX - right : 0;
  if (!distance) return 0;
  return Number((Math.sign(distance) * OVERDRAG_LIMIT * (1 - Math.exp(-Math.abs(distance) / OVERDRAG_RESISTANCE))).toFixed(3));
}

function rubberBandFor(overdrag: number, width: number) {
  const progress = Math.min(1, Math.abs(overdrag) / OVERDRAG_LIMIT);
  const direction = Math.sign(overdrag);
  return {
    scaleX: Number((1 + Math.abs(overdrag) / Math.max(width, 1)).toFixed(6)),
    scaleY: Number((1 - progress * VERTICAL_COMPRESSION_LIMIT).toFixed(6)),
    contentShift: Number((direction * progress * CONTENT_SHIFT_LIMIT).toFixed(3)),
    markerShift: Number((direction * progress * MARKER_SHIFT_LIMIT).toFixed(3)),
  };
}

function textZoneFor(element: HTMLElement | null): TextZone | null {
  if (!element) return null;
  const bounds = element.getBoundingClientRect();
  return { left: bounds.left - 4, right: bounds.right + 4 };
}

function markerOpacityFor(markerX: number, zones: TextZone[], ghostOpacity = 0.16) {
  if (!zones.length) return 1;
  const distance = Math.min(...zones.map((zone) => markerX < zone.left ? zone.left - markerX : markerX > zone.right ? markerX - zone.right : 0));
  return Number((ghostOpacity + (1 - ghostOpacity) * Math.min(1, distance / 16)).toFixed(3));
}

function editorShieldOpacityFor(markerX: number, zone?: TextZone) {
  if (!zone) return 0;
  const start = zone.left - 16;
  if (markerX <= start) return 0;
  if (markerX < zone.left) return Number(((markerX - start) / 16).toFixed(3));
  return 1;
}

export default function DraggableInput({
  id,
  label,
  value,
  min,
  max,
  step,
  onChange,
  formatValue,
  inputScale = 1,
  disabled = false,
  onInteractionCancel,
  onInteractionEnd,
  onInteractionStart,
}: DraggableInputProps) {
  const generatedId = useId();
  const inputId = id || `draggable-input-${generatedId}`;
  const scaledValue = Number((value * inputScale).toFixed(6));
  const [draft, setDraft] = useState(String(scaledValue));
  const [editing, setEditing] = useState(false);
  const rowRef = useRef<HTMLDivElement>(null);
  const labelRef = useRef<HTMLSpanElement>(null);
  const formattedRef = useRef<HTMLSpanElement>(null);
  const markerRef = useRef<HTMLSpanElement>(null);
  const valueRef = useRef<HTMLInputElement>(null);
  const previousCanonicalRef = useRef(scaledValue);
  const editStartValueRef = useRef(value);
  const interactionRef = useRef(false);
  const pointerIdRef = useRef<number | null>(null);
  const rangeBoundsRef = useRef<{ left: number; right: number } | null>(null);
  const collisionZonesRef = useRef<TextZone[]>([]);
  const suppressBlurRef = useRef(false);
  const lastPointerValueRef = useRef<number | null>(null);
  const lastOverdragRef = useRef<number | null>(null);

  const style: DraggableInputStyle = {
    "--draggable-input-progress": `${progressFor(value, min, max)}%`,
  };
  const formattedValue = formatValue ? formatValue(value) : String(scaledValue);

  useEffect(() => {
    if (previousCanonicalRef.current === scaledValue) return;
    previousCanonicalRef.current = scaledValue;
    setDraft(String(scaledValue));
  }, [scaledValue]);

  useEffect(() => () => {
    if (interactionRef.current) onInteractionEnd?.();
  }, [onInteractionEnd]);

  useEffect(() => {
    if (editing) valueRef.current?.select();
  }, [editing]);

  useLayoutEffect(() => {
    const row = rowRef.current;
    const marker = markerRef.current;
    if (!row || !marker) return;
    const bounds = marker.getBoundingClientRect();
    const x = (bounds.left + bounds.right) / 2;
    const zones = [textZoneFor(labelRef.current), textZoneFor(formattedRef.current)].filter((zone): zone is TextZone => zone !== null);
    row.style.setProperty("--draggable-input-marker-opacity", String(markerOpacityFor(x, zones)));
    row.style.setProperty("--draggable-input-marker-opacity-dark", String(markerOpacityFor(x, zones, 0.08)));
  }, [formattedValue, label, value]);

  function startInteraction() {
    if (disabled || interactionRef.current) return;
    interactionRef.current = true;
    onInteractionStart?.();
  }

  function endInteraction(cancel = false) {
    if (!interactionRef.current) return;
    interactionRef.current = false;
    if (cancel) onInteractionCancel?.();
    else onInteractionEnd?.();
  }

  function commitDraft() {
    if (!draft.trim()) {
      setDraft(String(scaledValue));
      return;
    }
    const parsed = Number(draft);
    if (!Number.isFinite(parsed)) {
      setDraft(String(scaledValue));
      return;
    }
    const next = clampAndSnap(parsed / inputScale, min, max, step);
    setDraft(String(Number((next * inputScale).toFixed(6))));
    if (next !== value) onChange(next);
  }

  function handleValueKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === "Enter") {
      event.preventDefault();
      suppressBlurRef.current = true;
      commitDraft();
      event.currentTarget.blur();
      suppressBlurRef.current = false;
    } else if (event.key === "ArrowUp" || event.key === "ArrowDown") {
      event.preventDefault();
      const parsed = Number(draft);
      const base = Number.isFinite(parsed) ? parsed / inputScale : value;
      const next = clampAndSnap(base + (event.key === "ArrowUp" ? step : -step), min, max, step);
      setDraft(String(Number((next * inputScale).toFixed(6))));
    } else if (event.key === "Escape") {
      event.preventDefault();
      suppressBlurRef.current = true;
      const start = editStartValueRef.current;
      previousCanonicalRef.current = Number((start * inputScale).toFixed(6));
      setDraft(String(previousCanonicalRef.current));
      if (start !== value) onChange(start);
      event.currentTarget.blur();
      suppressBlurRef.current = false;
    }
  }

  function handleValueBlur() {
    setEditing(false);
    if (suppressBlurRef.current) {
      suppressBlurRef.current = false;
      return;
    }
    commitDraft();
  }

  function handleValueChange(event: ChangeEvent<HTMLInputElement>) {
    const nextDraft = event.currentTarget.value;
    setDraft(nextDraft);
    if (!window.matchMedia("(pointer: coarse)").matches || !nextDraft.trim()) return;
    const parsed = Number(nextDraft);
    if (!Number.isFinite(parsed)) return;
    const next = clampAndSnap(parsed / inputScale, min, max, step);
    previousCanonicalRef.current = Number((next * inputScale).toFixed(6));
    if (next !== value) onChange(next);
  }

  function reportPointerValue(clientX: number, bounds: { left: number; right: number }) {
    const next = pointerValueFor(clientX, bounds.left, bounds.right, min, max, step);
    if (next === null || next === lastPointerValueRef.current) return;
    lastPointerValueRef.current = next;
    if (next !== value) onChange(next);
  }

  function writeOverdrag(row: HTMLElement, overdrag: number, bounds: { left: number; right: number }, clientX: number) {
    const rubberBand = rubberBandFor(overdrag, bounds.right - bounds.left);
    row.toggleAttribute("data-overdragging", overdrag !== 0);
    if (overdrag) row.setAttribute("data-overdrag-direction", overdrag < 0 ? "left" : "right");
    else row.removeAttribute("data-overdrag-direction");
    row.style.setProperty("--draggable-input-overdrag", `${overdrag}px`);
    row.style.setProperty("--draggable-input-capsule-scale-x", String(rubberBand.scaleX));
    row.style.setProperty("--draggable-input-capsule-scale-y", String(rubberBand.scaleY));
    row.style.setProperty("--draggable-input-content-shift", `${rubberBand.contentShift}px`);
    row.style.setProperty("--draggable-input-marker-shift", `${rubberBand.markerShift}px`);
    const markerX = Math.min(bounds.right - MARKER_INSET, Math.max(bounds.left + MARKER_INSET, clientX)) + rubberBand.markerShift;
    const zones = collisionZonesRef.current;
    row.style.setProperty("--draggable-input-marker-opacity", String(markerOpacityFor(markerX, zones)));
    row.style.setProperty("--draggable-input-marker-opacity-dark", String(markerOpacityFor(markerX, zones, 0.08)));
    row.style.setProperty("--draggable-input-editor-shield-opacity", String(editorShieldOpacityFor(markerX, zones[zones.length - 1])));
  }

  function clearOverdrag(row: HTMLElement) {
    row.removeAttribute("data-overdragging");
    row.removeAttribute("data-overdrag-settling");
    row.removeAttribute("data-overdrag-direction");
    row.style.removeProperty("--draggable-input-overdrag");
    row.style.removeProperty("--draggable-input-capsule-scale-x");
    row.style.removeProperty("--draggable-input-capsule-scale-y");
    row.style.removeProperty("--draggable-input-content-shift");
    row.style.removeProperty("--draggable-input-marker-shift");
  }

  function settleOverdrag() {
    const row = rowRef.current;
    if (!row) return;
    const overdrag = Number.parseFloat(row.style.getPropertyValue("--draggable-input-overdrag"));
    row.removeAttribute("data-overdragging");
    if (!Number.isFinite(overdrag) || overdrag === 0 || window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) {
      clearOverdrag(row);
      return;
    }
    row.setAttribute("data-overdrag-settling", "");
    row.style.setProperty("--draggable-input-overdrag", "0px");
    row.style.setProperty("--draggable-input-capsule-scale-x", "1");
    row.style.setProperty("--draggable-input-capsule-scale-y", "1");
    row.style.setProperty("--draggable-input-content-shift", "0px");
    row.style.setProperty("--draggable-input-marker-shift", "0px");
  }

  function clearPointer(pointerId?: number) {
    if (pointerIdRef.current === null || (pointerId !== undefined && pointerIdRef.current !== pointerId)) return false;
    pointerIdRef.current = null;
    rangeBoundsRef.current = null;
    collisionZonesRef.current = [];
    lastPointerValueRef.current = null;
    lastOverdragRef.current = null;
    return true;
  }

  function handleRangePointerDown(event: PointerEvent<HTMLInputElement>) {
    if (disabled || interactionRef.current) return;
    const bounds = event.currentTarget.getBoundingClientRect();
    const rangeBounds = bounds.width > 0 ? { left: bounds.left, right: bounds.right } : null;
    pointerIdRef.current = event.pointerId;
    rangeBoundsRef.current = rangeBounds;
    collisionZonesRef.current = [textZoneFor(labelRef.current), textZoneFor(formattedRef.current)].filter((zone): zone is TextZone => zone !== null);
    lastPointerValueRef.current = null;
    lastOverdragRef.current = 0;
    startInteraction();
    if (rangeBounds) reportPointerValue(event.clientX, rangeBounds);
    event.currentTarget.setPointerCapture?.(event.pointerId);
  }

  function handleRangePointerMove(event: PointerEvent<HTMLInputElement>) {
    if (!interactionRef.current || pointerIdRef.current !== event.pointerId) return;
    const bounds = rangeBoundsRef.current;
    const row = rowRef.current;
    if (!bounds || !row) return;
    reportPointerValue(event.clientX, bounds);
    const overdrag = overdragFor(event.clientX, bounds.left, bounds.right);
    if (overdrag !== lastOverdragRef.current) {
      lastOverdragRef.current = overdrag;
      writeOverdrag(row, overdrag, bounds, event.clientX);
    }
  }

  function handleRangePointerEnd(event: PointerEvent<HTMLInputElement>, cancel = false) {
    if (!clearPointer(event.pointerId)) return;
    if (event.currentTarget.hasPointerCapture?.(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    settleOverdrag();
    endInteraction(cancel);
  }

  function handleTransitionEnd(event: TransitionEvent<HTMLDivElement>) {
    if (event.target === event.currentTarget && event.propertyName === "transform" && event.currentTarget.hasAttribute("data-overdrag-settling")) {
      clearOverdrag(event.currentTarget);
    }
  }

  function handleRangeChange(event: ChangeEvent<HTMLInputElement>) {
    if (pointerIdRef.current !== null) return;
    const next = event.currentTarget.valueAsNumber;
    if (Number.isFinite(next)) onChange(next);
  }

  function handleRangeKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End"].includes(event.key)) startInteraction();
  }

  function handleRangeKeyUp(event: KeyboardEvent<HTMLInputElement>) {
    if (["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End"].includes(event.key)) endInteraction();
  }

  return (
    <div className="draggable-input" data-disabled={disabled ? "" : undefined} ref={rowRef} style={style} onTransitionEnd={handleTransitionEnd}>
      <span aria-hidden="true" className="draggable-input__surface" />
      <span aria-hidden="true" className="draggable-input__marker" ref={markerRef} />
      <label className="draggable-input__label" htmlFor={inputId}><span ref={labelRef}>{label}</span></label>
      <input
        aria-label={label}
        className="draggable-input__range"
        disabled={disabled}
        id={inputId}
        max={max}
        min={min}
        onBlur={() => { clearPointer(); settleOverdrag(); endInteraction(); }}
        onChange={handleRangeChange}
        onKeyDown={handleRangeKeyDown}
        onKeyUp={handleRangeKeyUp}
        onLostPointerCapture={() => { clearPointer(); settleOverdrag(); endInteraction(); }}
        onPointerCancel={(event) => handleRangePointerEnd(event, true)}
        onPointerDown={handleRangePointerDown}
        onPointerMove={handleRangePointerMove}
        onPointerUp={(event) => handleRangePointerEnd(event)}
        onFocus={() => undefined}
        step={step}
        type="range"
        value={value}
      />
      <span className="draggable-input__value-zone">
        <input
          aria-label={`${label} 数值`}
          aria-valuemax={max * inputScale}
          aria-valuemin={min * inputScale}
          aria-valuenow={Number.isFinite(Number(draft)) ? Number(draft) : scaledValue}
          className="draggable-input__value"
          inputMode="decimal"
          max={max * inputScale}
          min={min * inputScale}
          onBlur={handleValueBlur}
          onChange={handleValueChange}
          onFocus={() => { editStartValueRef.current = value; setEditing(true); }}
          onKeyDown={handleValueKeyDown}
          ref={valueRef}
          role="spinbutton"
          spellCheck={false}
          step={step * inputScale}
          type={editing ? "text" : "number"}
          value={draft}
        />
        <span aria-hidden="true" className="draggable-input__formatted" ref={formattedRef}>{formattedValue}</span>
      </span>
    </div>
  );
}
