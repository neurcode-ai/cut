#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { root } from './lib.mjs';

const artifactManifestPath = join(root, '.artifacts', 'public-package-manifest.json');
const artifacts = JSON.parse(readFileSync(artifactManifestPath, 'utf8')).artifacts;
const outputDirectory = join(root, 'sbom');
mkdirSync(outputDirectory, { recursive: true });

function collect(node, components, dependencies) {
  const name = node?.name || node?.from;
  let version = node?.version;
  let license;
  if (node?.path) {
    try {
      const manifest = JSON.parse(readFileSync(join(node.path, 'package.json'), 'utf8'));
      if (!version || String(version).startsWith('link:')) version = manifest.version;
      license = manifest.license;
    } catch {}
  }
  if (!name || !version || String(version).startsWith('link:')) return null;
  const encodedName = name.startsWith('@')
    ? `%40${name.slice(1).split('/').map(encodeURIComponent).join('/')}`
    : encodeURIComponent(name);
  const ref = `pkg:npm/${encodedName}@${version}`;
  components.set(ref, {
    type: 'library',
    'bom-ref': ref,
    name,
    version,
    purl: ref,
    ...(license ? { licenses: [{ license: { id: license } }] } : {}),
  });
  const childRefs = [];
  for (const child of Object.values(node.dependencies || {})) {
    const childRef = collect(child, components, dependencies);
    if (childRef) childRefs.push(childRef);
  }
  dependencies.set(ref, [...new Set(childRefs)].sort());
  return ref;
}

for (const artifact of artifacts) {
  const tree = JSON.parse(execFileSync(
    'pnpm',
    ['--filter', artifact.name, 'list', '--prod', '--depth', 'Infinity', '--json'],
    { cwd: root, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 },
  ))[0];
  const components = new Map();
  const dependencies = new Map();
  const rootRef = collect(tree, components, dependencies);
  const document = {
    bomFormat: 'CycloneDX',
    specVersion: '1.5',
    serialNumber: `urn:uuid:${createHash('sha256').update(artifact.sha256).digest('hex').slice(0, 32).replace(
      /^(.{8})(.{4})(.{4})(.{4})(.{12})$/,
      '$1-$2-$3-$4-$5',
    )}`,
    version: 1,
    metadata: {
      component: {
        ...(components.get(rootRef) || {
          type: 'application',
          'bom-ref': `pkg:npm/${encodeURIComponent(artifact.name)}`,
          name: artifact.name,
        }),
        hashes: [{ alg: 'SHA-256', content: artifact.sha256 }],
        properties: [
          { name: 'neurcode:packed-file', value: artifact.file },
          { name: 'neurcode:packed-bytes', value: String(artifact.bytes) },
        ],
      },
    },
    components: [...components.entries()]
      .filter(([ref]) => ref !== rootRef)
      .map(([, value]) => value)
      .sort((a, b) => a['bom-ref'].localeCompare(b['bom-ref'])),
    dependencies: [...dependencies.entries()]
      .map(([ref, dependsOn]) => ({ ref, dependsOn }))
      .sort((a, b) => a.ref.localeCompare(b.ref)),
  };
  const safeName = artifact.name.replace('@', '').replace('/', '-');
  writeFileSync(
    join(outputDirectory, `${safeName}.cdx.json`),
    `${JSON.stringify(document, null, 2)}\n`,
    { mode: 0o644 },
  );
}
process.stdout.write(`Generated ${artifacts.length} packed-artifact SBOM(s).\n`);
