// ─── A message that fails to send is said in words, never "Network Error" (final fix wave CM3, 2 Nov 2026) ────────
//
// useSendMessage fell back to the error's own text, so a dropped connection toasted axios's "Network Error". A refusal
// the server words for members (a block, a closed account) is still said as the server says it; a request that got no
// answer says the shared "Connection lost" sentence; anything else says a plain sentence of its own.

import * as fs from 'fs';
import * as path from 'path';
import { SEND_FAILED, sendFailureSentence } from '../../../../client/src/features/messages/thread/send-failure';
import { CONNECTION_LOST } from '../../../../client/src/features/reason/errors';

const CLIENT = path.join(__dirname, '../../../../client/src');
const read = (rel: string) => fs.readFileSync(path.join(CLIENT, rel), 'utf8').replace(/\r\n/g, '\n');

describe('what a failed send says', () => {
  it('a dropped connection says "Connection lost", never the library text', () => {
    const dropped = Object.assign(new Error('Network Error'), { isAxiosError: true, code: 'ERR_NETWORK', request: {} });
    expect(sendFailureSentence(dropped)).toBe(CONNECTION_LOST);
    expect(sendFailureSentence(Object.assign(new Error('timeout of 30000ms exceeded'), { code: 'ECONNABORTED' }))).toBe(CONNECTION_LOST);
  });

  it("a refusal the server words for members is said in the server's words", () => {
    const blocked = { response: { status: 403, data: { error: { message: 'You cannot message this person.' } } } };
    expect(sendFailureSentence(blocked)).toBe('You cannot message this person.');
  });

  it('a server text that is not for members (an id, a code word) or a fault of ours says the plain sentence', () => {
    expect(sendFailureSentence({ response: { status: 404, data: { error: { message: 'User with id 3a7c1f52-5b9e-4f0a-8e0d-2c4b6d8f1a22 not found' } } } }))
      .toBe(SEND_FAILED);
    expect(sendFailureSentence({ response: { status: 500, data: {} } })).toBe(SEND_FAILED);
    expect(sendFailureSentence(new TypeError('Cannot read properties of undefined'))).toBe(SEND_FAILED);
    expect(sendFailureSentence(new Error('No recipient'))).toBe(SEND_FAILED);
    expect(SEND_FAILED).toBe('Your message was not sent. Please try again.');
  });

  it('the send hook says it through this rule, and never reads err.message', () => {
    const hook = read('features/messages/thread/useSendMessage.ts');
    expect(hook).toMatch(/addToast\(sendFailureSentence\(err\), 'error'\);/);
    expect(hook).not.toMatch(/err\?\.message/);
  });
});
