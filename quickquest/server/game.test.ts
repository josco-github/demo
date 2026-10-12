import { describe, expect, it } from 'vitest';
import { joinRoom, makeRoom, newCode, startRound, submitAnswer } from './game';

const token = 'a'.repeat(64);
function roomWithTwo() {
  const r = makeRoom('ABCDE', 'host', 'Host', token);
  joinRoom(r, 'guest', 'Guest', 'b'.repeat(64), 'socket-2', 60_000);
  r.seats.get('guest')!.ready = true;
  return r;
}
describe('QuickQuest game rules', () => {
  it('creates five-character codes from a set without ambiguous characters', () => {
    const code = newCode();
    expect(code).toMatch(/^[A-HJ-NP-Z2-9]{5}$/);
  });
  it('sanitizes nicknames and enforces the eight-player room limit', () => {
    const r = makeRoom('ABCDE', 'host', ' <Boss> ', token);
    expect(r.seats.get('host')?.name).toBe('Boss');
    for (let i=1;i<=7;i++) joinRoom(r, `p${i}`, `Guest ${i}`, String(i).repeat(64), `s${i}`, 60_000);
    expect(() => joinRoom(r, 'p8', 'Last Player', '8'.repeat(64), 's8', 60_000)).toThrow(/full/);
  });
  it('normalizes case and surrounding punctuation in Unscramble', () => {
    const r = roomWithTwo(); startRound(r, 1000); r.answer = 'rainbow';
    const result = submitAnswer(r, 'guest', '  RAINBOW! ', 2000);
    expect(result.points).toBe(120);
    expect(r.seats.get('guest')?.score).toBe(120);
  });
  it('scores incorrect answers zero and locks a player to one attempt', () => {
    const r = roomWithTwo(); startRound(r, 1000); r.answer = 'rainbow';
    expect(submitAnswer(r, 'guest', 'river', 11_000).points).toBe(0);
    expect(() => submitAnswer(r, 'guest', 'rainbow', 12_000)).toThrow(/already submitted/);
  });
  it('rejects a submission at the server deadline', () => {
    const r = roomWithTwo(); startRound(r, 1000);
    expect(() => submitAnswer(r, 'guest', r.answer, 31_000)).toThrow(/Time is up/);
  });
  it('adds the speed bonus only during the first ten seconds', () => {
    const first = roomWithTwo(); startRound(first, 1000); first.answer = 'rainbow';
    expect(submitAnswer(first, 'guest', 'rainbow', 10_999).points).toBe(120);
    const later = roomWithTwo(); startRound(later, 1000); later.answer = 'rainbow';
    expect(submitAnswer(later, 'guest', 'rainbow', 11_001).points).toBe(100);
  });
  it('accepts curated Category Sprint words and rejects duplicates', () => {
    const r = roomWithTwo(); startRound(r, 1000); r.mode = 'sprint'; r.category = 'Animals'; r.answer = 'o';
    expect(submitAnswer(r, 'guest', 'OTTER', 11_001).points).toBe(100);
    expect(submitAnswer(r, 'host', 'otter', 12_000).points).toBe(0);
  });
  it('assigns the host role when a player reconnects after everyone disconnected', () => {
    const r = roomWithTwo();
    const now=Date.now();
    r.seats.get('host')!.connected = false; r.seats.get('host')!.disconnectedAt = now;
    r.seats.get('guest')!.connected = false; r.seats.get('guest')!.disconnectedAt = now;
    joinRoom(r, 'guest', 'Guest', 'b'.repeat(64), 'socket-new', 60_000);
    expect(r.hostId).toBe('guest');
    expect(r.seats.get('guest')?.host).toBe(true);
  });
  it('does not leak the Unscramble answer to active room state', async () => {
    const { publicState } = await import('./game');
    const r = roomWithTwo(); startRound(r, 1000);
    expect(publicState(r).answer).toBeNull();
    r.mode = 'sprint'; r.answer = 'a';
    expect(publicState(r).answer).toBe('a');
  });
});
