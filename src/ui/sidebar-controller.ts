import { element } from "./dom";

const STORAGE_KEY = "cloakhub.sidebar";
const DEFAULT_WIDTH = 280;
const MIN_WIDTH = 220;
const MAX_WIDTH = 520;

export function initializeSidebar() {
  const layout = element(".app-layout");
  const content = element("#sidebar-content");
  const toggle = element<HTMLButtonElement>("#sidebar-toggle");
  const handle = element("#sidebar-resize");
  let preferredWidth = DEFAULT_WIDTH;
  let collapsed = false;
  let drag: { pointerId: number; startX: number; startWidth: number; previousWidth: number } | undefined;

  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "null");
    if (typeof saved?.width === "number" && Number.isFinite(saved.width))
      preferredWidth = Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, saved.width));
    if (typeof saved?.collapsed === "boolean") collapsed = saved.collapsed;
  } catch {
    // Storage may be disabled or contain an older, invalid preference.
  }

  const maximumWidth = () => Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, innerWidth - 480));
  const clamp = (width: number) => Math.round(Math.max(MIN_WIDTH, Math.min(maximumWidth(), width)));
  const render = () => {
    const width = clamp(preferredWidth);
    layout.style.setProperty("--sidebar-width", `${width}px`);
    layout.classList.toggle("sidebar-collapsed", collapsed);
    content.hidden = collapsed;
    handle.hidden = collapsed;
    toggle.textContent = collapsed ? "›" : "‹";
    toggle.title = collapsed ? "Show sidebar" : "Hide sidebar";
    toggle.setAttribute("aria-label", toggle.title);
    toggle.setAttribute("aria-expanded", String(!collapsed));
    handle.setAttribute("aria-valuemax", String(maximumWidth()));
    handle.setAttribute("aria-valuenow", String(width));
    handle.setAttribute("aria-valuetext", `${width} pixels`);
  };
  const save = () => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ width: preferredWidth, collapsed }));
    } catch {
      // Resizing and folding still work without persistent storage.
    }
  };
  const finishDrag = (cancel = false) => {
    if (!drag) return;
    const previous = drag;
    drag = undefined;
    if (cancel) preferredWidth = previous.previousWidth;
    document.body.classList.remove("sidebar-resizing");
    if (handle.hasPointerCapture(previous.pointerId))
      handle.releasePointerCapture(previous.pointerId);
    render();
    if (!cancel) save();
  };

  toggle.onclick = () => {
    finishDrag(true);
    collapsed = !collapsed;
    render();
    save();
  };
  handle.onpointerdown = (event) => {
    if (event.button !== 0 || !event.isPrimary || drag) return;
    event.preventDefault();
    handle.focus();
    handle.setPointerCapture(event.pointerId);
    drag = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startWidth: clamp(preferredWidth),
      previousWidth: preferredWidth
    };
    document.body.classList.add("sidebar-resizing");
  };
  handle.onpointermove = (event) => {
    if (!drag || event.pointerId !== drag.pointerId) return;
    preferredWidth = clamp(drag.startWidth + event.clientX - drag.startX);
    render();
  };
  handle.onpointerup = (event) => {
    if (event.pointerId === drag?.pointerId) finishDrag();
  };
  handle.onpointercancel = () => finishDrag(true);
  handle.onlostpointercapture = () => finishDrag(true);
  handle.ondblclick = () => {
    preferredWidth = DEFAULT_WIDTH;
    render();
    save();
  };
  handle.onkeydown = (event) => {
    const step = event.shiftKey ? 32 : 16;
    const width = clamp(preferredWidth);
    const widths: Record<string, number> = {
      ArrowLeft: width - step,
      ArrowRight: width + step,
      Home: MIN_WIDTH,
      End: maximumWidth()
    };
    const next = widths[event.key];
    if (next === undefined) return;
    event.preventDefault();
    preferredWidth = clamp(next);
    render();
    save();
  };
  window.addEventListener("blur", () => finishDrag(true));
  window.addEventListener("resize", () => {
    finishDrag(true);
    render();
  });
  render();
}
