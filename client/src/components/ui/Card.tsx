import { type ReactNode } from 'react';
import { cn } from '@/lib/utils';

interface CardProps {
  children: ReactNode;
  className?: string;
  hover?: boolean;
  onClick?: () => void;
  /** Forwarded to the DOM. Callers (e.g. the circle wall's per-post hook) were
   *  already passing this; without it declared here it was silently dropped. */
  'data-testid'?: string;
}

export default function Card({ children, className, hover, onClick, ...rest }: CardProps) {
  return (
    <div
      onClick={onClick}
      data-testid={rest['data-testid']}
      className={cn(
        'rounded-2xl border border-gray-200 bg-white p-6 shadow-sm',
        hover && 'hover:border-gray-300 hover:bg-gray-50 hover:shadow-md hover:-translate-y-0.5 transition-all duration-300 cursor-pointer',
        className,
      )}
    >
      {children}
    </div>
  );
}
