import type { EvidenceItem, ShareBundle, ShareItem } from '../model';

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function escapeAttribute(value: string): string {
  return escapeHtml(value);
}

function blobText(bundle: ShareBundle, hash: string | undefined): string {
  if (!hash) return '';
  const blob = bundle.blobs.get(hash);
  if (!blob) throw new Error(`Missing Cut blob: ${hash}`);
  return blob.toString('utf8');
}

function ansiLine(value: string): string {
  const classes = new Set<string>();
  let result = '';
  let cursor = 0;
  const pattern = /\u001b\[([0-9;]*)m/g;
  const renderSegment = (segment: string): string => classes.size
    ? `<span class="${[...classes].join(' ')}">${escapeHtml(segment)}</span>`
    : escapeHtml(segment);
  for (const match of value.matchAll(pattern)) {
    const index = match.index ?? 0;
    if (index > cursor) result += renderSegment(value.slice(cursor, index));
    const codes = (match[1] || '0').split(';').map((code) => Number(code));
    for (const code of codes) {
      if (code === 0) classes.clear();
      else if (code === 1) classes.add('ansi-bold');
      else if (code === 2) classes.add('ansi-dim');
      else if (code === 22) {
        classes.delete('ansi-bold');
        classes.delete('ansi-dim');
      } else if (code === 39) {
        for (const name of [...classes]) if (name.startsWith('ansi-fg-')) classes.delete(name);
      } else {
        const colors: Record<number, string> = {
          30: 'black', 31: 'red', 32: 'green', 33: 'yellow', 34: 'blue', 35: 'magenta', 36: 'cyan', 37: 'white',
          90: 'bright-black', 91: 'bright-red', 92: 'bright-green', 93: 'bright-yellow',
          94: 'bright-blue', 95: 'bright-magenta', 96: 'bright-cyan', 97: 'bright-white',
        };
        if (colors[code]) {
          for (const name of [...classes]) if (name.startsWith('ansi-fg-')) classes.delete(name);
          classes.add(`ansi-fg-${colors[code]}`);
        }
      }
    }
    cursor = index + match[0].length;
  }
  return `${result}${renderSegment(value.slice(cursor))}`;
}

function codeLines(
  text: string,
  kind?: 'diff',
  ansi = false,
  startLine = 1,
  idPrefix?: string,
  cut1ArchiveCompatibility = false,
): string {
  const lines = text.replace(/\n$/, '').split('\n');
  return lines.map((line, index) => {
    const diffClass = kind === 'diff'
      ? line.startsWith('+') && !line.startsWith('+++')
        ? ' add'
        : line.startsWith('-') && !line.startsWith('---')
          ? ' del'
          : line.startsWith('@@')
            ? ' hunk'
            : ''
      : '';
    const rendered = ansi ? ansiLine(line || ' ') : escapeHtml(line || ' ');
    const lineNumber = startLine + index;
    const lineId = idPrefix ? `${idPrefix}${cut1ArchiveCompatibility ? '.' : '-'}L${lineNumber}` : '';
    const id = lineId ? ` id="${escapeAttribute(lineId)}"` : '';
    const lineAnchor = lineId && !cut1ArchiveCompatibility
      ? `<a class="ln" href="#${escapeAttribute(lineId)}" aria-label="Line ${lineNumber}">${lineNumber}</a>`
      : `<span class="ln">${lineNumber}</span>`;
    return `<span class="line${diffClass}"${id}>${lineAnchor}<span class="src">${rendered}</span></span>`;
  }).join('');
}

function itemLabel(item: ShareItem): string {
  if (item.kind === 'file' || item.kind === 'excerpt') return item.path;
  if (item.kind === 'diff') return 'Unified diff';
  return (item as EvidenceItem).argv.join(' ');
}

function renderItem(bundle: ShareBundle, item: ShareItem, note: string | undefined, cut1ArchiveCompatibility: boolean): string {
  const badge = `<span class="badge">${escapeHtml(item.provenance)}</span><span class="badge observed">observed</span>`;
  const noteHtml = note
    ? `<aside><strong>Author note · asserted</strong><p>${escapeHtml(note).replace(/\n/g, '<br>')}</p></aside>`
    : '';
  let body = '';

  if (item.kind === 'file') {
    body = `<pre>${codeLines(blobText(bundle, item.blob), undefined, false, 1, item.id, cut1ArchiveCompatibility)}</pre>`;
  } else if (item.kind === 'excerpt') {
    body = `<p class="boundary">Selected lines ${item.range.start}–${item.range.end}</p><pre>${codeLines(blobText(bundle, item.blob), undefined, false, item.range.start, item.id, cut1ArchiveCompatibility)}</pre>`;
    body += item.context
      ? `<details><summary>Expand author-approved context · lines ${item.context.start}–${item.context.end}</summary><pre>${codeLines(blobText(bundle, item.context.blob), undefined, false, item.context.start, `${item.id}.context`, cut1ArchiveCompatibility)}</pre></details>`
      : '<p class="boundary">Context ends here — the author included nothing beyond this range.</p>';
  } else if (item.kind === 'diff') {
    body = `<p class="boundary">${item.files.length} file(s) · +${item.addedLines} −${item.removedLines} · ${escapeHtml(item.base)} → ${escapeHtml(item.head)}</p><pre>${codeLines(blobText(bundle, item.blob), 'diff', false, 1, cut1ArchiveCompatibility ? undefined : item.id)}</pre>`;
  } else {
    const stdout = item.stdout
      ? `<h3>Observed stdout${item.stdoutTruncated ? ' · bounded' : ''}</h3><pre>${codeLines(blobText(bundle, item.stdout), undefined, true, 1, cut1ArchiveCompatibility ? undefined : `${item.id}-stdout`)}</pre>`
      : '';
    const stderr = item.stderr
      ? `<h3>Observed stderr${item.stderrTruncated ? ' · bounded' : ''}</h3><pre>${codeLines(blobText(bundle, item.stderr), undefined, true, 1, cut1ArchiveCompatibility ? undefined : `${item.id}-stderr`)}</pre>`
      : '';
    body = `<p class="boundary">exit ${item.exit} · ${item.durationMs} ms · ${escapeHtml(item.startedAt)} · cwd ${escapeHtml(item.cwd)}${item.timedOut ? ' · timed out' : ''}</p>${stdout}${stderr}`;
  }

  return `<section id="${escapeAttribute(item.id)}"><header><div><span class="eyebrow">${escapeHtml(item.kind)}</span><h2>${escapeHtml(itemLabel(item))}</h2></div><div>${badge}</div></header>${noteHtml}${body}</section>`;
}

export function renderHtml(bundle: ShareBundle, options: { cut1ArchiveCompatibility?: boolean } = {}): string {
  const cut1ArchiveCompatibility = options.cut1ArchiveCompatibility === true;
  // `cut/1` archives embed this HTML and are required to remain byte-identical
  // to the first public writer. The live/non-archive renderer uses Cut branding.
  const productTitle = cut1ArchiveCompatibility ? 'Neurcode Share' : 'Cut by Neurcode';
  const previewLabel = cut1ArchiveCompatibility ? 'Neurcode Share · local preview' : 'Cut by Neurcode · local preview';
  const inventoryLabel = cut1ArchiveCompatibility ? 'Share inventory' : 'Cut inventory';
  const { manifest } = bundle.cut;
  const notes = new Map(bundle.cut.story.frames.map((frame) => [frame.cite.item, frame.note]));
  const inventory = bundle.cut.pack.items.map((item) =>
    `<li><a href="${escapeAttribute(`#${item.id}`)}"><span>${escapeHtml(itemLabel(item))}</span><small>${escapeHtml(item.kind)} · ${item.bytes} B · ${escapeHtml(item.provenance)}</small></a></li>`
  ).join('');
  const items = bundle.cut.pack.items.map((item) => renderItem(bundle, item, notes.get(item.id), cut1ArchiveCompatibility)).join('');

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <meta name="robots" content="noindex,nofollow,noarchive">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:; base-uri 'none'; form-action 'none'">
  <title>${escapeHtml(manifest.title)} · ${productTitle}</title>
  <style>
    :root{color-scheme:light;--ink:#17201d;--muted:#61706a;--paper:#f5f3ec;--card:#fffefa;--line:#d8d9d1;--accent:#136f63;--code:#131816;--codeInk:#e9f0eb}
    *{box-sizing:border-box}body{margin:0;background:var(--paper);color:var(--ink);font:16px/1.55 ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
    main{width:min(1180px,calc(100% - 32px));margin:40px auto 80px}.brief{background:var(--card);border:1px solid var(--line);border-radius:18px;padding:clamp(24px,5vw,54px);box-shadow:0 18px 50px #1e312513}
    .eyebrow{text-transform:uppercase;letter-spacing:.12em;font-size:11px;font-weight:750;color:var(--accent)}h1{font:700 clamp(34px,6vw,68px)/1.02 ui-serif,Georgia,serif;margin:.25em 0}.intent{font-size:clamp(18px,2.5vw,25px);max-width:830px}
    .origin{color:var(--muted);font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:13px;overflow-wrap:anywhere}.layout{display:grid;grid-template-columns:290px minmax(0,1fr);gap:24px;margin-top:24px}.layout>article{min-width:0}
    nav{align-self:start;position:sticky;top:20px;min-width:0;background:var(--card);border:1px solid var(--line);border-radius:14px;padding:18px}nav h2{margin:0 0 10px;font-size:15px}nav ul{list-style:none;margin:0;padding:0}nav a{display:flex;min-width:0;flex-direction:column;padding:10px 8px;border-top:1px solid #ecece5;color:inherit;text-decoration:none}nav a:hover{background:#f0f5f1}nav span,nav small{min-width:0;overflow-wrap:anywhere}nav small{color:var(--muted)}
    section{background:var(--card);border:1px solid var(--line);border-radius:14px;margin:0 0 22px;padding:20px;overflow:hidden}section header{display:flex;justify-content:space-between;gap:18px;align-items:start}section h2{margin:2px 0 14px;font:650 23px/1.2 ui-serif,Georgia,serif;overflow-wrap:anywhere}
    .badge{display:inline-block;border:1px solid #9ab8b0;background:#eaf4f1;color:#155e55;border-radius:999px;padding:3px 8px;margin:0 0 4px 5px;font-size:11px;white-space:nowrap}.badge.observed{background:#eef0eb;border-color:#c7ccc4;color:#4b554f}
    aside{border-left:4px solid var(--accent);background:#edf5f1;padding:12px 15px;margin:4px 0 16px}aside p{margin:4px 0 0}.boundary{color:var(--muted);font-size:13px}
    pre{margin:12px -20px -20px;background:var(--code);color:var(--codeInk);overflow:auto;padding:14px 0;font:13px/1.6 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;tab-size:2}.line{display:grid;grid-template-columns:56px minmax(max-content,1fr);min-height:21px}.ln{color:#708078;text-align:right;padding-right:15px;user-select:none${cut1ArchiveCompatibility ? '' : ';text-decoration:none'}}${cut1ArchiveCompatibility ? '' : '.line:target{outline:2px solid #65b8a9;outline-offset:-2px}'}.src{white-space:pre;padding-right:18px}.line.add{background:#173c2e}.line.del{background:#452626}.line.hunk{background:#22334a;color:#b8d2f2}
    .ansi-bold{font-weight:800}.ansi-dim{opacity:.7}.ansi-fg-black{color:#7d877f}.ansi-fg-red,.ansi-fg-bright-red{color:#ff8b8b}.ansi-fg-green,.ansi-fg-bright-green{color:#80dca4}.ansi-fg-yellow,.ansi-fg-bright-yellow{color:#f4d37b}.ansi-fg-blue,.ansi-fg-bright-blue{color:#8bb9ff}.ansi-fg-magenta,.ansi-fg-bright-magenta{color:#e2a2ff}.ansi-fg-cyan,.ansi-fg-bright-cyan{color:#78d9dc}.ansi-fg-white,.ansi-fg-bright-white{color:#fff}.ansi-fg-bright-black{color:#a7afa9}
    details{border:1px solid var(--line);border-radius:10px;margin-top:18px;overflow:hidden}summary{cursor:pointer;padding:12px 14px;font-weight:650}details pre{margin:0}
    footer{color:var(--muted);max-width:850px;margin:32px auto;font-size:13px}.sr{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0,0,0,0)}
    @media(max-width:820px){main{width:min(100% - 20px,1180px);margin-top:10px}.layout{grid-template-columns:1fr}nav{position:static}.brief{border-radius:12px;padding:24px}section{padding:16px}pre{margin-left:-16px;margin-right:-16px}.badge{white-space:normal}}
  </style>
</head>
<body>
<main>
  <article class="brief">
    <span class="eyebrow">${previewLabel}</span>
    <h1>${escapeHtml(manifest.title)}</h1>
    <p class="intent"><strong>Author intent · asserted:</strong> ${escapeHtml(manifest.intent || 'No intent supplied.')}</p>
    <p class="origin">${escapeHtml(manifest.origin.remote)} @ ${escapeHtml(manifest.origin.head)} · ${escapeHtml(manifest.origin.branch || '(detached)')} · ${manifest.origin.dirty ? 'uncommitted worktree' : 'clean checkout'} · captured ${escapeHtml(manifest.createdAt)}${cut1ArchiveCompatibility ? '' : ` · digest ${escapeHtml(manifest.digest)}`}</p>
  </article>
  <div class="layout">
    <nav aria-label="${inventoryLabel}"><h2>Inventory · ${bundle.cut.pack.items.length} item(s)</h2><ul>${inventory}</ul></nav>
    <article>${items}</article>
  </div>
  <footer>
    <p><strong>Snapshot honesty:</strong> this is captured source and observed output from one point in time. Provenance labels describe how bytes entered; they are not endorsements.</p>
    <p>Revocation can stop future access through Neurcode, but cannot recall copies already downloaded, cached, screenshotted, or consumed by agents.</p>
    <p>Made with <code>${cut1ArchiveCompatibility ? 'npx @neurcode-ai/cli share' : 'npx @neurcode-ai/cut@0.2.0'}</code>.</p>
  </footer>
</main>
</body>
</html>
`;
}
