import { clsx, type ClassValue } from 'clsx'
import { twMerge } from 'tailwind-merge'

export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs))
}

// The list column beside a reader: one fixed width for every library and the
// favorites view, full width on phones. Three 132px cover columns wide on
// iPads, leaving the reader more room; four above the 13" iPad Pro's 1376px
// (87.5rem = 1400px: in rem, so Tailwind orders it after md).
export const LIST_COLUMN_CLASS = 'w-full flex-1 md:w-99 md:flex-none min-[87.5rem]:w-132'
