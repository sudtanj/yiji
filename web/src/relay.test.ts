import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { checkRelayUrl, relayBackend } from './backends';

class FakeSocket {
  static last: FakeSocket;
  sent: string[] = [];
  closed = false;
  onopen?: () => void;
  onmessage?: (e: { data: string }) => void;
  onclose?: (e: { reason: string }) => void;
  constructor(public url: string) {
    FakeSocket.last = this;
    queueMicrotask(() => this.onopen?.());
  }
  send(s: string) {
    this.sent.push(s);
  }
  close() {
    this.closed = true;
  }
  say(data: string) {
    this.onmessage?.({ data });
  }
}

const row = { id: 'a', data: 'blob', updated_at: 1 };
const tick = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => vi.stubGlobal('WebSocket', FakeSocket));
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

/** Runs `op` against a relay that answers "ok" to the hello and `reply` to the request. */
async function run<T>(op: () => Promise<T>, reply: string) {
  const p = op();
  await tick();
  FakeSocket.last.say('ok');
  FakeSocket.last.say(reply);
  return { result: await p, ws: FakeSocket.last };
}

describe('relayBackend', () => {
  const backend = relayBackend('wss://relay.test/', 'pw');

  it('sends the hello, then the request after "ok"', async () => {
    const p = backend.list();
    await tick();
    expect(FakeSocket.last.url).toBe('wss://relay.test/');
    expect(FakeSocket.last.sent).toEqual([JSON.stringify({ token: 'pw', vault: true })]);
    FakeSocket.last.say('ok');
    expect(FakeSocket.last.sent[1]).toBe(JSON.stringify({ op: 'list' }));
    FakeSocket.last.say('{"rows":[]}');
    await p;
  });

  it('lists rows and closes the socket', async () => {
    const { result, ws } = await run(() => backend.list(), JSON.stringify({ rows: [row] }));
    expect(result).toEqual([row]);
    expect(ws.closed).toBe(true);
  });

  it.each([
    ['put', { op: 'put', row }, () => backend.put(row)],
    ['create', { op: 'create', row }, () => backend.create(row)],
    ['remove', { op: 'remove', id: 'a' }, () => backend.remove('a')],
  ])('sends %s', async (_, request, op) => {
    const { ws } = await run(op, '{}');
    expect(JSON.parse(ws.sent[1])).toEqual(request);
  });

  it('throws the relay error reply', async () => {
    await expect(run(() => backend.put(row), '{"error":"disk full"}')).rejects.toThrow('disk full');
  });

  it('throws the close reason when the hello is rejected', async () => {
    const p = backend.list();
    await tick();
    FakeSocket.last.onclose?.({ reason: 'bad token' });
    await expect(p).rejects.toThrow('bad token');
  });

  it('times out after 35 s', async () => {
    vi.useFakeTimers();
    const p = backend.list();
    const assertion = expect(p).rejects.toThrow('timed out after 35s');
    await vi.advanceTimersByTimeAsync(35_000);
    await assertion;
    expect(FakeSocket.last.closed).toBe(true);
  });
});

describe('checkRelayUrl', () => {
  it.each(['wss://relay.example/', 'ws://localhost:8080', 'ws://127.0.0.1:1'])('accepts %s', (u) => {
    expect(checkRelayUrl(u)).toBeNull();
  });
  it.each(['ws://relay.example/', 'https://relay.example/', 'relay', ''])('rejects %s', (u) => {
    expect(checkRelayUrl(u)).not.toBeNull();
  });
});
