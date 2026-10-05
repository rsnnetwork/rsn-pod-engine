// Stroke icons copied from Stefan's v4 prototype (index.html, the `icons` map).
import type { ReactElement, SVGProps } from 'react';

export type ReasonIconName =
  | 'foryou' | 'people' | 'entities' | 'circles' | 'pods' | 'events'
  | 'messages' | 'introductions' | 'profile' | 'settings' | 'support' | 'more';

const PATHS: Record<ReasonIconName, ReactElement> = {
  foryou: <><path d="M12 3 4.5 8.2v7.6L12 21l7.5-5.2V8.2L12 3Z" /><circle cx="12" cy="12" r="2.4" /><path d="M12 5.5v3M6.8 9l2.7 1.5m7.7-1.5-2.7 1.5" /></>,
  people: <><circle cx="8" cy="8" r="3" /><circle cx="17" cy="9" r="2.5" /><path d="M3 20c0-4 2-6 5-6s5 2 5 6M13 19c.3-3 1.8-4.5 4-4.5 2.4 0 4 1.7 4 4.5" /><path d="M11 11.2 14 10.5" /></>,
  entities: <><path d="M5 4h9v16H5zM14 8h5v12h-5" /><path d="M8 8h3M8 12h3M8 16h3M16 12h1M16 16h1" /></>,
  circles: <><circle cx="12" cy="12" r="8" /><circle cx="12" cy="4" r="1.4" /><circle cx="19" cy="14" r="1.4" /><circle cx="5" cy="14" r="1.4" /></>,
  pods: <><circle cx="12" cy="5" r="2" /><circle cx="5" cy="12" r="2" /><circle cx="19" cy="12" r="2" /><circle cx="8" cy="19" r="2" /><circle cx="16" cy="19" r="2" /><path d="m10.7 6.5-4 4M13.3 6.5l4 4M6.8 13.7l1.8 3.4M17.2 13.7l-1.8 3.4M10 19h4" /></>,
  events: <><rect x="4" y="5" width="16" height="15" rx="2" /><path d="M8 3v4M16 3v4M4 10h16" /><circle cx="9" cy="14" r="1" /><circle cx="15" cy="14" r="1" /></>,
  messages: <><path d="M5 5h14a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2h-8l-5 4v-4H5a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2Z" /><circle cx="9" cy="11" r=".7" /><circle cx="12" cy="11" r=".7" /><circle cx="15" cy="11" r=".7" /></>,
  introductions: <><path d="M8.5 14.5 6 17a3.5 3.5 0 0 1-5-5l4-4a3.5 3.5 0 0 1 5 0" /><path d="m15.5 9.5 2.5-2.5a3.5 3.5 0 0 1 5 5l-4 4a3.5 3.5 0 0 1-5 0" /><path d="m8 16 8-8" /></>,
  profile: <><circle cx="12" cy="8" r="3" /><path d="M5 21c0-5 2.6-7 7-7s7 2 7 7" /><circle cx="18.5" cy="5.5" r="1" /></>,
  settings: <><path d="M5 6h14M5 12h14M5 18h14" /><circle cx="9" cy="6" r="2" /><circle cx="15" cy="12" r="2" /><circle cx="11" cy="18" r="2" /></>,
  support: <><circle cx="12" cy="12" r="8" /><path d="M9.8 9a2.4 2.4 0 1 1 3.6 2.1c-.9.5-1.4 1-1.4 2.2" /><circle cx="12" cy="17" r=".7" /></>,
  more: <><circle cx="5" cy="12" r="1.4" /><circle cx="12" cy="12" r="1.4" /><circle cx="19" cy="12" r="1.4" /></>,
};

export function ReasonIcon({ name, ...props }: { name: ReasonIconName } & SVGProps<SVGSVGElement>) {
  return (
    <svg
      viewBox="0 0 24 24" width={22} height={22} fill="none" stroke="currentColor"
      strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" {...props}
    >
      {PATHS[name]}
    </svg>
  );
}
