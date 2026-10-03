import { describe, expect, it } from 'vitest';

import {
  fingerprintFromHeaders,
  fingerprintHasSignal,
  fingerprintsMatch,
} from '@/services/opds/sourceMap';

describe('fingerprintFromHeaders', () => {
  it('reads etag, last-modified, and content-length case-insensitively', () => {
    expect(
      fingerprintFromHeaders({
        ETag: '"abc"',
        'Last-Modified': 'Wed, 01 Oct 2025 12:00:00 GMT',
        'Content-Length': '12345',
      }),
    ).toEqual({
      etag: '"abc"',
      lastModified: 'Wed, 01 Oct 2025 12:00:00 GMT',
      contentLength: 12345,
    });
  });

  it('ignores non-numeric content-length', () => {
    expect(fingerprintFromHeaders({ 'content-length': 'chunked' })).toEqual({});
  });
});

describe('fingerprintsMatch', () => {
  it('matches on etag when both sides have one', () => {
    expect(fingerprintsMatch({ etag: '"a"' }, { etag: '"a"' })).toBe(true);
    expect(fingerprintsMatch({ etag: '"a"' }, { etag: '"b"' })).toBe(false);
  });

  it('matches on last-modified + content-length when etags are absent', () => {
    expect(
      fingerprintsMatch(
        { lastModified: 'x', contentLength: 10 },
        { lastModified: 'x', contentLength: 10 },
      ),
    ).toBe(true);
    expect(
      fingerprintsMatch(
        { lastModified: 'x', contentLength: 10 },
        { lastModified: 'x', contentLength: 11 },
      ),
    ).toBe(false);
  });

  it('does not treat content-length alone as a match', () => {
    expect(fingerprintsMatch({ contentLength: 10 }, { contentLength: 10 })).toBe(false);
  });

  it('uses a stable feed revision and size when HTTP validators are unavailable', () => {
    const stored = { entryUpdated: '2026-10-01T12:00:00Z', contentLength: 10 };
    expect(fingerprintsMatch(stored, stored)).toBe(true);
    expect(fingerprintsMatch(stored, { ...stored, contentLength: 11 })).toBe(false);
    expect(fingerprintsMatch(stored, { ...stored, entryUpdated: '2026-10-02T12:00:00Z' })).toBe(
      false,
    );
    expect(fingerprintsMatch(stored, { contentLength: 10 })).toBe(false);
    expect(
      fingerprintsMatch(
        { entryUpdated: 'invalid', contentLength: 10 },
        { entryUpdated: 'invalid', contentLength: 10 },
      ),
    ).toBe(false);
  });

  it('does not let the feed fallback overrule a changed HTTP validator', () => {
    const fp = { entryUpdated: '2026-10-01T12:00:00Z', contentLength: 10 };
    expect(fingerprintsMatch({ ...fp, etag: 'old' }, { ...fp, etag: 'new' })).toBe(false);
    expect(fingerprintsMatch({ ...fp, lastModified: 'old' }, { ...fp, lastModified: 'new' })).toBe(
      false,
    );
  });
});

describe('fingerprintHasSignal', () => {
  it('is true when any field is present', () => {
    expect(fingerprintHasSignal({})).toBe(false);
    expect(fingerprintHasSignal({ etag: '"a"' })).toBe(true);
    expect(fingerprintHasSignal({ contentLength: 1 })).toBe(true);
  });
});
