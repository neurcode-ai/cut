# Cut Inbox

`cut inbox` lists authorized root conversations without returning source,
paths, commands, private URLs, capabilities, recipient addresses, or content.
Browser authorization is requested only when needed.

```sh
cut inbox
cut inbox --status waiting
cut inbox --status answered --limit 25
cut inbox --team platform-engineering-a1b2c3
cut inbox --cursor CURSOR_FROM_PREVIOUS_PAGE
cut inbox --json
```

`--limit` is an integer from 1 through 100. Pagination is cursor-based; use the
opaque `nextCursor` exactly as returned. Waiting and Answered are derived from
the active conversation rather than a manually editable workflow status.
Removed team members lose server visibility immediately.

Human output escapes C0/C1 controls, ANSI escapes, and bidirectional override
characters. JSON is canonical and has this stable V1 shape:

```ts
interface CutInboxPageV1 {
  schemaVersion: 1;
  items: Array<{
    id: string;
    title: string;
    url: string;
    relationship: 'created' | 'received' | 'team';
    state: 'waiting' | 'answered';
    author: 'You' | 'Cut creator';
    team: { name: string; slug: string } | null;
    createdAt: string;
    latestActivityAt: string;
    feedback: { comments: number; replies: number };
  }>;
  nextCursor: string | null;
  limit: number;
  status: 'all' | 'waiting' | 'answered';
  team: { name: string; slug: string } | null;
}
```

The CLI rejects oversized responses, unknown states, unsafe URLs, malformed
dates, invalid cursors, out-of-range counts, and more items than the declared
page limit. It projects only documented fields before rendering or emitting
JSON.
