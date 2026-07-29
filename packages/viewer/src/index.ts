import {
  readShareArchive,
  renderAgentJson,
  renderHtml,
  renderMarkdown,
  type ShareBundle,
} from '@neurcode-ai/share-format';

export type ShareRenderFormat = 'html' | 'markdown' | 'json';

export function renderVerifiedArchive(
  archive: Uint8Array,
  format: ShareRenderFormat,
): string {
  const bundle = readShareArchive(archive);
  return renderBundle(bundle, format);
}

export function renderBundle(bundle: ShareBundle, format: ShareRenderFormat): string {
  if (format === 'html') return renderHtml(bundle);
  if (format === 'markdown') return renderMarkdown(bundle);
  return renderAgentJson(bundle);
}
