// ─── The empty-balance alert (7 Sep 2026) ────────────────────────────────────
//
// The prepaid Anthropic key ran dry three times (2 Jul, 3 Sep, 7 Sep) and was
// noticed hours later each time, by a red test run or by Ali. Every Anthropic
// client is wrapped: the exact "credit balance is too low" refusal emails the
// team once, then stays quiet for an hour while it keeps failing. Any other
// error passes through untouched.

jest.mock('../../../config', () => ({
  __esModule: true,
  default: { llmBalanceAlertTo: 'dev@rsn.network, ops@rsn.network' },
}));
jest.mock('../../../config/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
const mockSend = jest.fn();
jest.mock('../../../services/email/email.service', () => ({
  __esModule: true,
  sendLlmBalanceAlertEmail: (...a: unknown[]) => mockSend(...a),
}));

import { withBalanceAlert, isLowBalanceError, noteLlmError, alertRecipients, _resetBalanceAlertForTests } from '../../../services/onboarding/llm-balance-alert';

const BODY = '{"type":"error","error":{"type":"invalid_request_error","message":"Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits."}}';
/** The shape the SDK throws: status + body text in the message, body parsed under `error`. */
const lowBalance = () => Object.assign(new Error(`400 ${BODY}`), { status: 400, error: JSON.parse(BODY) });
const flush = () => new Promise((r) => setImmediate(r));
const T0 = new Date('2026-09-07T13:28:00Z').getTime();

beforeEach(() => {
  _resetBalanceAlertForTests();
  mockSend.mockReset();
  mockSend.mockResolvedValue({ sent: true });
  jest.useFakeTimers({ now: T0, doNotFake: ['setImmediate', 'nextTick'] });
});
afterEach(() => { jest.useRealTimers(); });

describe('isLowBalanceError', () => {
  it('recognises the refusal in the message, in the parsed body, and nowhere else', () => {
    expect(isLowBalanceError(lowBalance())).toBe(true);
    expect(isLowBalanceError({ error: { error: { message: 'Your credit balance is too low to access the Anthropic API.' } } })).toBe(true);
    expect(isLowBalanceError(new Error('overloaded_error'))).toBe(false);
    expect(isLowBalanceError(new Error('429 rate limit'))).toBe(false);
    expect(isLowBalanceError(null)).toBe(false);
  });
  it('reads the comma-separated recipients', () => {
    expect(alertRecipients()).toEqual(['dev@rsn.network', 'ops@rsn.network']);
  });
});

describe('withBalanceAlert', () => {
  it('a refused call emails every recipient once, rethrows, and stays quiet for an hour', async () => {
    const create = jest.fn().mockRejectedValue(lowBalance());
    const client = withBalanceAlert({ messages: { create } });

    await expect(client.messages.create({ model: 'claude-haiku-4-5', tools: [{ name: 'web_search' }] })).rejects.toThrow(/credit balance is too low/);
    await flush();
    expect(mockSend).toHaveBeenCalledTimes(2);
    expect(mockSend).toHaveBeenCalledWith({ to: 'dev@rsn.network', where: 'claude-haiku-4-5 with web search', at: '2026-09-07T13:28:00.000Z' });
    expect(mockSend).toHaveBeenCalledWith(expect.objectContaining({ to: 'ops@rsn.network' }));

    // Ten minutes later, still failing: no second email.
    jest.setSystemTime(T0 + 10 * 60 * 1000);
    await expect(client.messages.create({ model: 'claude-haiku-4-5' })).rejects.toThrow();
    await flush();
    expect(mockSend).toHaveBeenCalledTimes(2);

    // An hour on: one more.
    jest.setSystemTime(T0 + 61 * 60 * 1000);
    await expect(client.messages.create({ model: 'claude-haiku-4-5' })).rejects.toThrow();
    await flush();
    expect(mockSend).toHaveBeenCalledTimes(4);
    expect(mockSend).toHaveBeenLastCalledWith(expect.objectContaining({ where: 'claude-haiku-4-5' }));
  });

  it('other failures pass through without an email, and successes are untouched', async () => {
    const create = jest.fn().mockRejectedValueOnce(new Error('overloaded_error')).mockResolvedValueOnce({ content: [{ type: 'text', text: 'hi' }] });
    const client = withBalanceAlert({ messages: { create } });
    await expect(client.messages.create({ model: 'm' })).rejects.toThrow('overloaded_error');
    await expect(client.messages.create({ model: 'm' })).resolves.toEqual({ content: [{ type: 'text', text: 'hi' }] });
    await flush();
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('when the email itself fails, the next refusal retries after five minutes instead of an hour', async () => {
    mockSend.mockResolvedValue({ sent: false });
    expect(noteLlmError(lowBalance(), 'chat')).toBe(true);
    await flush();
    expect(mockSend).toHaveBeenCalledTimes(2);

    jest.setSystemTime(T0 + 4 * 60 * 1000);
    expect(noteLlmError(lowBalance(), 'chat')).toBe(false);

    jest.setSystemTime(T0 + 6 * 60 * 1000);
    mockSend.mockResolvedValue({ sent: true });
    expect(noteLlmError(lowBalance(), 'chat')).toBe(true);
    await flush();
    expect(mockSend).toHaveBeenCalledTimes(4);
  });
});
