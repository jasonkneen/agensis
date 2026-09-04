import { clsx, type ClassValue } from "clsx"
import { twMerge } from "tailwind-merge"

/**
 * Merge class names, letting later Tailwind utilities win over earlier ones.
 *
 * Every component in this package uses it, so it is the one hard dependency the
 * primitives share. stripHtml/normalizeTextInput deliberately stayed in the app
 * (src/lib/utils.ts): they are text helpers with no styling role.
 */
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}
