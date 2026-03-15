import { type ReactNode } from 'react';
import { cn } from '@/lib/utils';

interface BadgeProps {
  children: ReactNode;
  variant?: 'default' | 'success' | 'info' | 'warning' | 'danger' | 'brand';
  className?: string;
}

const variants: Record<string, string> = {
  default: 'bg-gray-100 text-gray-600',
  success: 'bg-emerald-50 text-emerald-600',
  info: 'bg-blue-50 text-blue-600',
  warning: 'bg-amber-50 text-amber-600',
  danger: 'bg-red-50 text-red-600',
  brand: 'bg-rsn-red-light text-rsn-red',
};

export default function Badge({ children, variant = 'default', className }: BadgeProps) {
  return (
    <span className={cn('inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium', variants[variant], className)}>
      {children}
    </span>
  );
}
