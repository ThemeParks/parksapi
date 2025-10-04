/**
 * Tag validation system
 *
 * Provides type-safe tag creation and validation for entity tags.
 *
 * @example
 * ```typescript
 * import {TagBuilder} from './tags/index.js';
 *
 * const tags = [
 *   TagBuilder.fastPass(),
 *   TagBuilder.minimumHeight(107, 'cm'),
 *   TagBuilder.location(28.4743, -81.4677),
 * ];
 * ```
 */

// Export primary API
export {TagBuilder} from './tagBuilder.js';

// Export types and enums
export {
  TagType,
  TAG_NAMES,
  SIMPLE_TAG_TYPES,
  StandardLocationId,
  isSimpleTag,
  isValidTagType,
} from './tagTypes.js';

export type {LocationTagValue, HeightTagValue} from './tagTypes.js';

// Export validators (for advanced use cases)
export {
  isLocationValue,
  isHeightValue,
  validateTagValue,
  hasOnlyKeys,
} from './validators.js';
