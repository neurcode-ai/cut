import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const output = join(repositoryRoot, 'docs', 'assets', 'terminal-to-share.gif');
const work = mkdtempSync(join(tmpdir(), 'neurcode-share-demo-'));

const escapeXml = (value) => value
  .replaceAll('&', '&amp;')
  .replaceAll('<', '&lt;')
  .replaceAll('>', '&gt;');

const text = (x, y, value, options = {}) => {
  const {
    fill = '#d7dfda',
    size = 17,
    weight = 500,
    family = 'ui-monospace, SFMono-Regular, Menlo, monospace',
    anchor = 'start',
    opacity = 1,
  } = options;
  return `<text x="${x}" y="${y}" fill="${fill}" font-family="${family}" font-size="${size}" font-weight="${weight}" text-anchor="${anchor}" opacity="${opacity}">${escapeXml(value)}</text>`;
};

const stepPills = (active) => {
  const labels = ['Capture', 'Review', 'Publish', 'Deliver'];
  return labels.map((label, index) => {
    const x = 292 + index * 154;
    const selected = index === active;
    return `
      <rect x="${x}" y="56" width="132" height="38" rx="19" fill="${selected ? '#dff2ed' : '#f0f1ee'}"/>
      <circle cx="${x + 21}" cy="75" r="11" fill="${selected ? '#238271' : '#c8ccc7'}"/>
      ${text(x + 21, 79, String(index + 1), { fill: selected ? '#fff' : '#5f6863', size: 11, weight: 800, family: 'Arial, sans-serif', anchor: 'middle' })}
      ${text(x + 40, 80, label, { fill: selected ? '#185f54' : '#5f6863', size: 13, weight: 700, family: 'Arial, sans-serif' })}
    `;
  }).join('');
};

const terminalBody = (frame) => {
  const base = [
    text(94, 174, '$ npx @neurcode-ai/cut@0.5.0', { fill: '#f5f7f5', size: 18, weight: 650 }),
  ];
  if (frame === 0) {
    base.push(
      text(94, 222, 'Starting local Cut Composer…', { fill: '#8bc8ba', size: 16 }),
      '<rect x="94" y="248" width="11" height="22" rx="2" fill="#73b8a8"/>',
    );
  }
  if (frame >= 1) {
    base.push(
      text(94, 216, 'Review what will be shared', { fill: '#8bc8ba', size: 17, weight: 750 }),
      text(94, 252, 'i1  exact code', { size: 15 }),
      text(408, 252, '26 lines', { fill: '#93a099', size: 14, anchor: 'end' }),
      text(94, 282, 'i2  complete diff', { size: 15 }),
      text(408, 282, '+18 −0', { fill: '#93a099', size: 14, anchor: 'end' }),
      text(94, 312, 'i3  test evidence', { size: 15 }),
      text(408, 312, 'exit 0', { fill: '#73b8a8', size: 14, weight: 700, anchor: 'end' }),
      '<line x1="94" y1="338" x2="498" y2="338" stroke="#34403b"/>',
      text(94, 374, 'Secret scan', { fill: '#93a099', size: 14 }),
      text(498, 374, 'no findings', { fill: '#73b8a8', size: 14, weight: 700, anchor: 'end' }),
      text(94, 406, 'Everything else', { fill: '#93a099', size: 14 }),
      text(498, 406, 'stays local', { fill: '#f5f7f5', size: 14, weight: 700, anchor: 'end' }),
    );
  }
  if (frame === 1) {
    base.push(
      '<rect x="94" y="448" width="212" height="44" rx="8" fill="#238271"/>',
      text(200, 476, 'Approve this exact cut', { fill: '#fff', size: 14, weight: 750, family: 'Arial, sans-serif', anchor: 'middle' }),
    );
  }
  if (frame >= 2) {
    base.push(
      text(94, 466, '✓ Revision 1 published', { fill: '#8bc8ba', size: 16, weight: 750 }),
      text(94, 500, 'cut.neurcode.com/examples/code-review', { fill: '#f5f7f5', size: 14 }),
      text(94, 542, 'Public • immutable revision • 4 items', { fill: '#93a099', size: 13 }),
    );
  }
  return base.join('');
};

const viewerBody = (frame) => {
  if (frame === 0) {
    return `
      ${text(720, 208, 'Nothing uploaded', { fill: '#238271', size: 13, weight: 800, family: 'Arial, sans-serif' })}
      ${text(720, 250, 'Your Cut appears here', { fill: '#171b1a', size: 28, weight: 800, family: 'Arial, sans-serif' })}
      ${text(720, 282, 'only after local review.', { fill: '#171b1a', size: 28, weight: 800, family: 'Arial, sans-serif' })}
      <rect x="720" y="330" width="344" height="14" rx="7" fill="#eceeeb"/>
      <rect x="720" y="360" width="280" height="14" rx="7" fill="#eceeeb"/>
      <rect x="720" y="410" width="364" height="112" rx="10" fill="#f3f4f1"/>
    `;
  }

  const selectedAi = frame >= 3;
  return `
    ${text(702, 176, 'PUBLIC  •  REVISION 1', { fill: '#238271', size: 11, weight: 800, family: 'Arial, sans-serif' })}
    ${text(702, 216, 'Focused review:', { fill: '#171b1a', size: 25, weight: 800, family: 'Arial, sans-serif' })}
    ${text(702, 246, 'bounded evidence limits', { fill: '#171b1a', size: 25, weight: 800, family: 'Arial, sans-serif' })}
    <rect x="702" y="275" width="390" height="52" rx="8" fill="#f3f4f1"/>
    ${text(720, 298, 'i1', { fill: '#238271', size: 12, weight: 800, family: 'Arial, sans-serif' })}
    ${text(754, 299, 'implementation excerpt', { fill: '#3e4742', size: 14, family: 'Arial, sans-serif' })}
    ${text(720, 318, 'Does this validation belong at this boundary?', { fill: '#6f7873', size: 12, family: 'Arial, sans-serif' })}
    <rect x="702" y="344" width="390" height="77" rx="8" fill="#111614"/>
    ${text(720, 370, '+ if (!Number.isInteger(maxBytes)) {', { fill: '#9fe0cf', size: 13 })}
    ${text(720, 393, '+   throw new Error(…);', { fill: '#d7dfda', size: 13 })}
    ${text(720, 409, '+ }', { fill: '#9fe0cf', size: 13 })}
    <rect x="702" y="444" width="390" height="42" rx="8" fill="#f3f4f1"/>
    ${text(720, 470, '✓ focused test  •  exit 0  •  observed', { fill: '#185f54', size: 13, weight: 750, family: 'Arial, sans-serif' })}
    <rect x="702" y="511" width="186" height="37" rx="7" fill="${selectedAi ? '#f0f1ee' : '#171b1a'}"/>
    <rect x="896" y="511" width="196" height="37" rx="7" fill="${selectedAi ? '#238271' : '#f0f1ee'}"/>
    ${text(795, 535, 'People', { fill: selectedAi ? '#5f6863' : '#fff', size: 13, weight: 750, family: 'Arial, sans-serif', anchor: 'middle' })}
    ${text(994, 535, 'AI agent', { fill: selectedAi ? '#fff' : '#5f6863', size: 13, weight: 750, family: 'Arial, sans-serif', anchor: 'middle' })}
    ${selectedAi
      ? `
        ${text(702, 577, 'Copy with trust guidance and item citations', { fill: '#3e4742', size: 12, family: 'Arial, sans-serif' })}
        <rect x="702" y="592" width="122" height="34" rx="7" fill="#171b1a"/>
        <rect x="834" y="592" width="96" height="34" rx="7" fill="#e5f2ee"/>
        <rect x="940" y="592" width="96" height="34" rx="7" fill="#e5f2ee"/>
        ${text(763, 614, 'Copy for AI', { fill: '#fff', size: 12, weight: 750, family: 'Arial, sans-serif', anchor: 'middle' })}
        ${text(882, 614, 'Markdown', { fill: '#185f54', size: 11, weight: 750, family: 'Arial, sans-serif', anchor: 'middle' })}
        ${text(988, 614, 'JSON', { fill: '#185f54', size: 11, weight: 750, family: 'Arial, sans-serif', anchor: 'middle' })}
      `
      : text(702, 582, 'Readable code, diff, notes, and evidence.', { fill: '#3e4742', size: 13, family: 'Arial, sans-serif' })}
  `;
};

const frameSvg = (frame) => {
  const activeStep = Math.min(frame, 3);
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="675" viewBox="0 0 1200 675">
  <rect width="1200" height="675" fill="#f7f7f4"/>
  <rect x="28" y="24" width="1144" height="627" rx="24" fill="#fff" stroke="#dfe2dd"/>
  <rect x="60" y="56" width="38" height="38" rx="9" fill="#171b1a"/>
  ${text(79, 82, '[/]', { fill: '#fff', size: 14, weight: 800, anchor: 'middle' })}
  ${text(112, 81, 'Cut by Neurcode', { fill: '#171b1a', size: 18, weight: 800, family: 'Arial, sans-serif' })}
  ${stepPills(activeStep)}
  <rect x="60" y="120" width="510" height="506" rx="14" fill="#111614"/>
  <circle cx="84" cy="145" r="5" fill="#59645f"/>
  <circle cx="102" cy="145" r="5" fill="#59645f"/>
  <circle cx="120" cy="145" r="5" fill="#59645f"/>
  ${text(144, 150, 'terminal  •  local repository', { fill: '#7e8a84', size: 12 })}
  ${terminalBody(frame)}
  <circle cx="600" cy="362" r="25" fill="#dff2ed"/>
  ${text(600, 369, '→', { fill: '#238271', size: 23, weight: 800, family: 'Arial, sans-serif', anchor: 'middle' })}
  <rect x="630" y="120" width="510" height="506" rx="14" fill="#fff" stroke="#dfe2dd"/>
  <circle cx="654" cy="145" r="5" fill="#cfd3ce"/>
  <circle cx="672" cy="145" r="5" fill="#cfd3ce"/>
  <circle cx="690" cy="145" r="5" fill="#cfd3ce"/>
  ${text(714, 150, frame === 0 ? 'recipient viewer  •  waiting' : 'recipient viewer  •  verified', { fill: '#7b847f', size: 12 })}
  ${viewerBody(frame)}
</svg>`;
};

try {
  mkdirSync(dirname(output), { recursive: true });
  const durations = [1.4, 1.9, 2.2, 2.7];
  const pngs = [];
  for (let frame = 0; frame < durations.length; frame += 1) {
    const svg = join(work, `frame-${frame}.svg`);
    const png = join(work, `frame-${frame}.png`);
    writeFileSync(svg, frameSvg(frame));
    execFileSync('sips', ['-s', 'format', 'png', svg, '--out', png], { stdio: 'ignore' });
    pngs.push(png);
  }
  const concat = join(work, 'frames.txt');
  const entries = pngs.flatMap((png, index) => [
    `file '${png.replaceAll("'", "'\\''")}'`,
    `duration ${durations[index]}`,
  ]);
  entries.push(`file '${pngs.at(-1).replaceAll("'", "'\\''")}'`);
  writeFileSync(concat, `${entries.join('\n')}\n`);
  execFileSync('ffmpeg', [
    '-hide_banner',
    '-loglevel', 'error',
    '-y',
    '-f', 'concat',
    '-safe', '0',
    '-i', concat,
    '-vf',
    'fps=12,scale=1200:675:flags=lanczos,split[s0][s1];[s0]palettegen=max_colors=128:stats_mode=diff[p];[s1][p]paletteuse=dither=bayer:bayer_scale=4:diff_mode=rectangle',
    '-loop', '0',
    output,
  ]);
  process.stdout.write(`${output}\n`);
} finally {
  rmSync(work, { recursive: true, force: true });
}
