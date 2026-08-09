import assert from 'node:assert/strict';
import { test } from 'node:test';
import { hostedTeamSlug } from './hosted';
import { hostedPublishDestination } from './create';

test('hosted team slugs are canonical, bounded, and shell-safe', () => {
  assert.equal(hostedTeamSlug(' Platform-Engineering-A1B2C3 '), 'platform-engineering-a1b2c3');
  assert.equal(hostedTeamSlug('a'), 'a');
  assert.equal(hostedTeamSlug(`a${'b'.repeat(46)}z`), `a${'b'.repeat(46)}z`);

  for (const invalid of ['', '-team', 'team-', 'two teams', 'team/other', 'a'.repeat(49), undefined]) {
    assert.throws(() => hostedTeamSlug(invalid), /neurcode-cut teams/);
  }
});

test('the disclosure review names the exact team destination', () => {
  assert.match(hostedPublishDestination({
    visibility: 'restricted',
    expiryHours: 168,
    recipientCount: 0,
    reply: false,
    teamSlug: 'backend',
  }), /team destination: backend/);
});
