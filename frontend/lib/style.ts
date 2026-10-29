import { clsx, type ClassValue } from 'clsx'
import { twMerge } from 'tailwind-merge'

export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs))
}

// The list column beside a reader: one fixed width for every library and the
// favorites view on desktop, full width on phones.
export const LIST_COLUMN_CLASS = 'w-full flex-1 md:w-132 md:flex-none'
