import { forwardRef, useId, type InputHTMLAttributes } from 'react';
import { cn } from '@/lib/utils';

interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  label?: string;
  error?: string;
}

// The label is tied to the field by id, so a screen reader reads it with the field, a tap on the words focuses the
// field, and a test can find the field by its label. The error is read with the field as well.
const Input = forwardRef<HTMLInputElement, InputProps>(({ label, error, className, id, ...props }, ref) => {
  const own = useId();
  const inputId = id ?? own;
  const errorId = `${inputId}-error`;
  return (
    <div>
      {label && <label htmlFor={inputId} className="block text-sm font-medium text-gray-600 mb-1.5">{label}</label>}
      <input
        ref={ref}
        id={inputId}
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? errorId : undefined}
        className={cn(
          // 16px (text-base) on a phone, or iPhone Safari zooms the page when the field is focused; the
          // compact text-sm from the sm breakpoint up, where nothing zooms.
          'w-full rounded-xl border border-gray-200 bg-gray-50 px-4 py-2.5 text-base sm:text-sm text-[#1a1a2e] placeholder:text-gray-400',
          'focus:outline-none focus:ring-2 focus:ring-[#1a1a2e] transition-colors',
          error && 'border-red-500', className,
        )}
        {...props}
      />
      {error && <p id={errorId} className="text-xs text-red-400 mt-1">{error}</p>}
    </div>
  );
});

Input.displayName = 'Input';
export default Input;
