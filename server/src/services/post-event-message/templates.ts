import type { PostEventMessageBucket } from '@rsn/shared';

export interface TemplateContext {
  firstName: string;
  eventTitle: string;
  eventDate: string;
  senderName: string;
}

export function buildMessage(bucket: PostEventMessageBucket, ctx: TemplateContext): string {
  const hi = `Hi ${ctx.firstName && ctx.firstName.trim() ? ctx.firstName.trim() : 'there'},`;
  const ev = `${ctx.eventTitle} on ${ctx.eventDate}`;
  const sign = `— ${ctx.senderName}`;
  switch (bucket) {
    case 'stayed':
      return [hi,
        `Thank you for being part of ${ev}. You stayed with us right through to the end and met a good few people, which is exactly what we hoped for.`,
        `Since we're always improving, I'd love your honest take. What worked, what felt clunky, or anything that got in your way? Just reply here and tell me.`,
        `Thanks again for giving it a go. ${sign}`].join('\n\n');
    case 'left_early':
      return [hi,
        `Thank you for joining ${ev}. You got a few conversations in before you had to head off partway through, and I'm glad you came.`,
        `I'd genuinely like to know what made you leave — whether something wasn't working, the format, the timing, or just life. Just reply here and tell me. It helps us make the next one better.`,
        sign].join('\n\n');
    case 'could_not_join':
      return [hi,
        `Thank you for coming to ${ev}. It looks like you weren't able to get into the conversations once things got going, and I'm sorry about that.`,
        `Would you tell me what happened on your end — what you saw on your screen, where it got stuck? Just reply here. I'd really like to make the next one work for you.`,
        sign].join('\n\n');
    case 'no_show':
      return [hi,
        `Thank you for signing up for ${ev}. It looks like you didn't get the chance to take part, and I'm sorry we missed you.`,
        `If anything got in the way — the timing, something technical, or the joining process — I'd love to hear it. Just reply here. I hope to have you at the next one.`,
        sign].join('\n\n');
  }
}
