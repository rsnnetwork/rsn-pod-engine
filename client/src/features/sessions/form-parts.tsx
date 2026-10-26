// The two small pieces the Schedule Event form's page and its rounds card share.

/** The class every select and number field on the form carries: at least 44px tall for a finger. */
export const selectClass = 'w-full min-h-[44px] rounded-xl border border-gray-200 bg-gray-50 px-4 py-2.5 text-sm text-[#1a1a2e] focus:outline-none focus:ring-2 focus:ring-[#1a1a2e] transition-all duration-200';

/** A sentence under the field it is about. */
export function FieldError({ message }: { message?: string }) {
  return message ? <p role="alert" className="text-xs text-red-400 mt-1">{message}</p> : null;
}
