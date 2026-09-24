import { describe, it, expect } from 'vitest';
import { devVersion, devBuildLabel } from '../src/core/dev-build.js';

const AT = new Date('2026-09-24T17:12:45Z');

describe('devVersion', () => {
  it('builds past a released version, so the Marketplace copy never looks newer', () => {
    expect(devVersion('0.7.1', true, AT)).toBe('0.7.2-dev.202609241712');
  });

  it('builds up to an unreleased version, so publishing it supersedes the dev build', () => {
    expect(devVersion('0.7.2', false, AT)).toBe('0.7.2-dev.202609241712');
  });

  it('bumps the patch as a number and zero-pads the UTC stamp', () => {
    expect(devVersion('0.9.9', true, new Date('2026-01-02T03:04:05Z'))).toBe('0.9.10-dev.202601020304');
  });
});

describe('devBuildLabel', () => {
  it('reads the build time out of a dev version', () => {
    expect(devBuildLabel('0.7.2-dev.202609241712')).toBe('dev 17:12');
  });

  it('is absent on a Marketplace version', () => {
    expect(devBuildLabel('0.7.1')).toBeUndefined();
  });

  it('reads what devVersion writes', () => {
    expect(devBuildLabel(devVersion('0.7.1', true, new Date('2026-01-02T03:04:05Z')))).toBe('dev 03:04');
  });
});
