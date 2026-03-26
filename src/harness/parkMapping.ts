// src/harness/parkMapping.ts

/**
 * Maps TS destination registry IDs to JS export class names.
 * Manually curated — JS class names don't follow a predictable pattern.
 *
 * Add entries as parks are migrated to TypeScript.
 * This is also the registry of "which parks have both implementations."
 */
export const parkMapping: Record<string, string> = {
  'universalorlando': 'UniversalOrlando',
  'universalstudios': 'UniversalStudios',
};

/**
 * Reverse mapping: JS class name -> TS park ID
 */
export function jsClassToTsParkId(jsClassName: string): string | undefined {
  return Object.entries(parkMapping).find(([, js]) => js === jsClassName)?.[0];
}
