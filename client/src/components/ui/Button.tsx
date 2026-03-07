import { forwardRef, type ButtonHTMLAttributes } from 'react';
import { cn } from '@/lib/utils';
import { Loader2 } from 'lucide-react';

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'primary' | 'secondary' | 'ghost' | 'danger' | 'outline';
  size?: 'sm' | 'md' | 'lg';
  isLoading?: boolean;
}

const variants: Record<string, string> = {
  primary: 'bg-brand-600 hover:bg-brand-500 text-white shadow-lg shadow-brand-500/20',
  secondary: 'bg-surface-800 hover:bg-surface-700 text-surface-200 border border-surface-600',
  ghost: 'hover:bg-surface-800 text-surface-300',
  danger: 'bg-red-600 hover:bg-red-500 text-white',
  outline: 'border border-surface-600 hover:bg-surface-800 text-surface-200',
};

const sizes: Record<string, string> = {
  sm: 'px-3 py-1.5 text-xs',
  md: 'px-4 py-2 text-sm',
  lg: 'px-6 py-3 text-base',
};

const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant = 'primary', size = 'md', isLoading, children, disabled, ...props }, ref) => (
    <button
      ref={ref}
      disabled={disabled || isLoading}
      className={cn(
        'inline-flex items-center justify-center rounded-xl font-medium transition-all duration-200 disabled:opacity-50 disabled:cursor-not-allowed active:scale-[0.98]',
        variants[variant], sizes[size], className,
      )}
      {...props}
    >
      {isLoading && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
      {children}
    </button>
  ),
);

Button.displayName = 'Button';
export { Button };
export default Button;
