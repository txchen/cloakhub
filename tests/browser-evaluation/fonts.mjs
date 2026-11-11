// document.fonts.check() can return true for a missing family. Inspect actual
// rendered platform fonts instead; correlate this with fc-list/file provenance.
export const FONT_AUDIT_FAMILIES = ['Arial', 'Arial Black', 'Times New Roman', 'Courier New', 'Verdana', 'Georgia', 'Trebuchet MS', 'Comic Sans MS', 'Tahoma', 'Microsoft Sans Serif', 'Segoe UI', 'Calibri', 'Cambria', 'Consolas', 'Helvetica Neue', 'DejaVu Sans', 'Liberation Sans'];

export async function auditRenderedFonts(context, page) {
  const session = await context.newCDPSession(page);
  const rootId = 'evaluation-font-audit';
  try {
    await page.evaluate(({ rootId, names }) => {
      const root = document.createElement('div'); root.id = rootId;
      for (const [index, family] of names.entries()) {
        const span = document.createElement('span'); span.id = `${rootId}-${index}`;
        span.style.cssText = `display:block;font:16px "${family}",monospace;white-space:nowrap`;
        span.textContent = 'Aa09 MWil 0123456789'; root.append(span);
      }
      document.body.append(root);
      for (const span of root.children) span.getBoundingClientRect();
    }, { rootId, names: FONT_AUDIT_FAMILIES });
    await session.send('DOM.enable');
    await session.send('CSS.enable');
    const { root } = await session.send('DOM.getDocument');
    const rows = [];
    for (const [index, requested] of FONT_AUDIT_FAMILIES.entries()) {
      const { nodeId } = await session.send('DOM.querySelector', { nodeId: root.nodeId, selector: `#${rootId}-${index}` });
      const { fonts } = await session.send('CSS.getPlatformFontsForNode', { nodeId });
      rows.push({ requested, fonts });
    }
    return { text: 'Aa09 MWil 0123456789', rows, note: 'Actual platform fonts used for this ASCII text, not a complete Unicode coverage or installed-font test. Missing requested families may fall back.' };
  } finally {
    try { await page.evaluate(id => document.getElementById(id)?.remove(), rootId); }
    finally { await session.detach(); }
  }
}
