export function element<T extends HTMLElement = HTMLElement>(
  selector: string,
  root: ParentNode = document
): T {
  const found = root.querySelector<T>(selector);
  if (!found) throw new Error(`Missing element: ${selector}`);
  return found;
}
export function escape(value: unknown): string {
  return String(value ?? "").replace(
    /[&<>"']/g,
    (char) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        char
      ]!
  );
}
export function toast(message: string, error = false): void {
  const item = document.createElement("div");
  item.className = `toast${error ? " error" : ""}`;
  item.textContent = message;
  element("#toasts").append(item);
  setTimeout(() => item.remove(), error ? 8000 : 4000);
}
export async function copyText(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
    return;
  } catch {
    /* HTTP/permission fallback */
  }
  const input = document.createElement("textarea");
  input.value = text;
  input.style.cssText = "position:fixed;left:-9999px";
  document.body.append(input);
  input.select();
  const copied = document.execCommand("copy");
  input.remove();
  if (!copied)
    throw new Error(
      "Clipboard access is blocked. Allow clipboard access and try again."
    );
}
export function confirmAction(
  title: string,
  description: string,
  label: string,
  danger = false
): Promise<boolean> {
  const dialog = element<HTMLDialogElement>("#confirm-dialog");
  if (dialog.open) return Promise.resolve(false);
  dialog.innerHTML = `<form method="dialog"><h2 id="confirm-title">${escape(title)}</h2><p>${escape(description)}</p><div class="dialog-actions"><button value="cancel" class="secondary">Cancel</button><button value="confirm" class="${danger ? "danger" : "primary"}">${escape(label)}</button></div></form>`;
  dialog.returnValue = "cancel";
  dialog.showModal();
  return new Promise((resolve) =>
    dialog.addEventListener(
      "close",
      () => resolve(dialog.returnValue === "confirm"),
      { once: true }
    )
  );
}
export function relativeTime(value: string | null): string {
  if (!value) return "No activity yet";
  const seconds = Math.max(0, (Date.now() - Date.parse(value)) / 1000);
  if (seconds < 60) return "Just now";
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
}
export function memory(bytes: number | null): string {
  return bytes === null
    ? "—"
    : bytes >= 1073741824
      ? `${(bytes / 1073741824).toFixed(1)} GB`
      : `${Math.round(bytes / 1048576)} MB`;
}
