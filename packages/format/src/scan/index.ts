import { createHash } from 'node:crypto';

export type SecretFindingKind =
  | 'aws-access-key'
  | 'github-token'
  | 'private-key'
  | 'authorization-token'
  | 'connection-string'
  | 'jwt'
  | 'provider-token'
  | 'secret-assignment'
  | 'sensitive-filename'
  | 'high-entropy-token';

export interface SecretFinding {
  id: string;
  kind: SecretFindingKind;
  scope: string;
  line: number;
  summary: string;
}

export interface ScanField {
  scope: string;
  text: string;
}

interface Rule {
  kind: Exclude<SecretFindingKind, 'high-entropy-token' | 'sensitive-filename'>;
  pattern: RegExp;
  summary: string;
}

const RULES: Rule[] = [
  {
    kind: 'aws-access-key',
    pattern: /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g,
    summary: 'AWS access-key identifier',
  },
  {
    kind: 'github-token',
    pattern: /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,})\b/g,
    summary: 'GitHub access token',
  },
  {
    kind: 'provider-token',
    pattern: /\b(?:sk-(?:proj-)?[A-Za-z0-9_-]{20,}|sk_live_[A-Za-z0-9]{20,}|xox[baprs]-[A-Za-z0-9-]{20,}|AIza[A-Za-z0-9_-]{30,})\b/g,
    summary: 'Provider API token',
  },
  {
    kind: 'private-key',
    pattern: /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/g,
    summary: 'Private-key block',
  },
  {
    kind: 'authorization-token',
    pattern: /\b(?:authorization|bearer)\s*[:=]?\s+["']?(?:Bearer\s+)?[A-Za-z0-9._~+/=-]{20,}/gi,
    summary: 'Authorization credential',
  },
  {
    kind: 'connection-string',
    pattern: /\b(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis):\/\/[^/\s:@]+:[^@\s/]+@[^/\s]+/gi,
    summary: 'Connection string containing credentials',
  },
  {
    kind: 'jwt',
    pattern: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g,
    summary: 'JSON Web Token',
  },
  {
    kind: 'secret-assignment',
    pattern: /\b(?:api[_-]?key|client[_-]?secret|access[_-]?token|refresh[_-]?token|password|passwd|secret)\b\s*[:=]\s*["']?[A-Za-z0-9._~+/=-]{16,}/gi,
    summary: 'Secret-like value assigned to a credential field',
  },
];

function lineAt(text: string, index: number): number {
  let line = 1;
  for (let cursor = 0; cursor < index; cursor += 1) {
    if (text.charCodeAt(cursor) === 10) line += 1;
  }
  return line;
}

function findingId(kind: SecretFindingKind, scope: string, index: number, match: string): string {
  const material = `${kind}\0${scope}\0${index}\0${createHash('sha256').update(match).digest('hex')}`;
  return `sf_${createHash('sha256').update(material).digest('hex').slice(0, 12)}`;
}

function entropy(value: string): number {
  const counts = new Map<string, number>();
  for (const character of value) counts.set(character, (counts.get(character) ?? 0) + 1);
  let result = 0;
  for (const count of counts.values()) {
    const probability = count / value.length;
    result -= probability * Math.log2(probability);
  }
  return result;
}

function overlaps(index: number, length: number, occupied: Array<[number, number]>): boolean {
  return occupied.some(([start, end]) => index < end && index + length > start);
}

export function scanText(field: ScanField): SecretFinding[] {
  const findings: SecretFinding[] = [];
  const occupied: Array<[number, number]> = [];
  const filenameCandidate = field.scope.startsWith('path:') ? field.text : field.scope;
  if (
    (/^(?:file|excerpt|context):/i.test(field.scope) || field.scope.startsWith('path:'))
    && /(?:^|\/)(?:secrets?|credentials?)(?:\.[^/:]+)?(?::|$)|\.(?:pem|p12|pfx|key)(?::|$)/i.test(filenameCandidate)
  ) {
    findings.push({
      id: findingId('sensitive-filename', field.scope, 0, filenameCandidate),
      kind: 'sensitive-filename',
      scope: field.scope,
      line: 1,
      summary: 'Sensitive filename requires explicit review',
    });
  }

  for (const rule of RULES) {
    const pattern = new RegExp(rule.pattern.source, rule.pattern.flags);
    for (const match of field.text.matchAll(pattern)) {
      const index = match.index ?? 0;
      const value = match[0];
      findings.push({
        id: findingId(rule.kind, field.scope, index, value),
        kind: rule.kind,
        scope: field.scope,
        line: lineAt(field.text, index),
        summary: rule.summary,
      });
      occupied.push([index, index + value.length]);
    }
  }

  const tokenPattern = /[A-Za-z0-9+/=_-]{32,160}/g;
  for (const match of field.text.matchAll(tokenPattern)) {
    const index = match.index ?? 0;
    const value = match[0];
    if (overlaps(index, value.length, occupied)) continue;
    if (/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(value)) continue;
    if (/^[A-Za-z]+$/.test(value) || /^[0-9]+$/.test(value)) continue;
    if (new Set(value).size < 10 || entropy(value) < 4.25) continue;
    findings.push({
      id: findingId('high-entropy-token', field.scope, index, value),
      kind: 'high-entropy-token',
      scope: field.scope,
      line: lineAt(field.text, index),
      summary: 'High-entropy token-like value',
    });
  }

  return findings.sort((a, b) =>
    a.scope.localeCompare(b.scope)
    || a.line - b.line
    || a.kind.localeCompare(b.kind)
    || a.id.localeCompare(b.id)
  );
}

export function scanFields(fields: ScanField[]): SecretFinding[] {
  const unique = new Map<string, SecretFinding>();
  for (const field of fields) {
    for (const finding of scanText(field)) unique.set(finding.id, finding);
  }
  return [...unique.values()].sort((a, b) =>
    a.scope.localeCompare(b.scope)
    || a.line - b.line
    || a.kind.localeCompare(b.kind)
    || a.id.localeCompare(b.id)
  );
}
