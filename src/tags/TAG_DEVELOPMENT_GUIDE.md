# Tag System Development Guide

This guide explains how to add new tags to the system with minimal boilerplate and automatic validation.

## Overview

The tag system uses **completeness tests** to automatically verify that all tags are properly implemented. When you add a new tag, the tests will tell you exactly what's missing.

## Quick Start: Adding a New Tag

### Step 1: Run Completeness Tests First

```bash
npm test -- src/tags/__tests__/tagCompleteness.test.ts
```

All tests should pass ✅. These tests will fail when you add a new tag type without completing all steps.

---

## Adding a Simple Tag (Boolean Presence)

Simple tags like `PAID_RETURN_TIME`, `SINGLE_RIDER`, etc. just indicate presence (no value).

### Example: Adding "VIRTUAL_QUEUE" tag

**1. Add to `TagType` enum and register** (`src/tags/tagTypes.ts`)
```typescript
export enum TagType {
  // ... existing tags
  VIRTUAL_QUEUE = 'VIRTUAL_QUEUE',
}

// In the registration section:
registerSimple(TagType.VIRTUAL_QUEUE, 'Virtual Queue');
```

**2. Add builder method with @simpleTag decorator** (`src/tags/tagBuilder.ts`)
```typescript
/**
 * Create a Virtual Queue tag
 */
@simpleTag(TagType.VIRTUAL_QUEUE)
static virtualQueue(tagName?: string, id?: string): TagData {
  return TagBuilder.createTag(TagType.VIRTUAL_QUEUE, undefined, tagName, id);
}
```

**Note:** The `@simpleTag` decorator automatically registers this method for validation - no manual mapping needed!

**3. Add tests** (`src/tags/__tests__/tagBuilder.test.ts`)
```typescript
it('should create virtualQueue tag', () => {
  const tag = TagBuilder.virtualQueue();
  expect(tag.tag).toBe(TagType.VIRTUAL_QUEUE);
  expect(tag.tagName).toBe('Virtual Queue');
  expect(tag.value).toBeUndefined();
});
```

**4. Run completeness tests**
```bash
npm test -- src/tags/__tests__/tagCompleteness.test.ts
```

✅ All tests should pass! If not, the error message will tell you exactly what's missing.

---

## Adding a Complex Tag (With Value)

Complex tags like `LOCATION`, `MINIMUM_HEIGHT` have structured values.

### Example: Adding "AGE_RESTRICTION" tag

**1. Add to `TagType` enum and register** (`src/tags/tagTypes.ts`)
```typescript
export enum TagType {
  // ... existing tags
  AGE_RESTRICTION = 'AGE_RESTRICTION',
}

// In the registration section:
registerComplex(TagType.AGE_RESTRICTION, 'Age Restriction');
```

**2. Add type interface** (`src/tags/tagTypes.ts`)
```typescript
/**
 * Age restriction tag value structure
 */
export interface AgeRestrictionTagValue {
  minimumAge: number;
  unit: 'years' | 'months';
}
```

**3. Add validator function** (`src/tags/validators.ts`)
```typescript
/**
 * Type guard for AgeRestrictionTagValue
 */
export function isAgeRestrictionValue(value: any): value is AgeRestrictionTagValue {
  if (typeof value !== 'object' || value === null) {
    return false;
  }

  const keys = Object.keys(value);
  if (keys.length !== 2) {
    return false;
  }

  if (!keys.includes('minimumAge') || !keys.includes('unit')) {
    return false;
  }

  const {minimumAge, unit} = value;
  if (typeof minimumAge !== 'number' || isNaN(minimumAge) || minimumAge < 0) {
    return false;
  }

  if (unit !== 'years' && unit !== 'months') {
    return false;
  }

  return true;
}
```

**4. Add case in `validateTagValue`** (`src/tags/validators.ts`)
```typescript
export function validateTagValue(type: TagType, value: any): void {
  // ... existing cases

  switch (type) {
    // ... existing cases

    case TagType.AGE_RESTRICTION:
      if (!isAgeRestrictionValue(value)) {
        throw new Error(
          `Invalid age restriction tag value. Expected {minimumAge: number, unit: 'years' | 'months'}, got: ${JSON.stringify(value)}`
        );
      }
      break;
  }
}
```

**5. Add builder method with @complexTag decorator** (`src/tags/tagBuilder.ts`)
```typescript
/**
 * Create an Age Restriction tag
 */
@complexTag(TagType.AGE_RESTRICTION)
static ageRestriction(
  minimumAge: number,
  unit: 'years' | 'months',
  tagName?: string,
  id?: string
): TagData {
  const value: AgeRestrictionTagValue = {minimumAge, unit};
  return TagBuilder.createTag(TagType.AGE_RESTRICTION, value, tagName, id);
}
```

**Note:** The `@complexTag` decorator automatically registers this method for validation - no manual mapping needed!

**6. Add tests**
```typescript
it('should create age restriction tag', () => {
  const tag = TagBuilder.ageRestriction(13, 'years');
  expect(tag.tag).toBe(TagType.AGE_RESTRICTION);
  expect(tag.tagName).toBe('Age Restriction');
  expect(tag.value).toEqual({minimumAge: 13, unit: 'years'});
});
```

**7. Run completeness tests**
```bash
npm test -- src/tags/__tests__/tagCompleteness.test.ts
```

✅ All tests should pass!

---

## Adding a Standard Location ID

Standard location IDs ensure consistency across parks.

### Example: Adding "BABY_CARE_CENTER"

**1. Add to `StandardLocationId` enum** (`src/tags/tagTypes.ts`)
```typescript
export enum StandardLocationId {
  // ... existing IDs
  BABY_CARE_CENTER = 'location-baby-care-center',
}
```

**2. (Optional) Add helper method with @locationHelper decorator** (`src/tags/tagBuilder.ts`)

Helper methods are optional - for common locations only.

```typescript
/**
 * Create a Baby Care Center location tag with standard ID
 */
@locationHelper(StandardLocationId.BABY_CARE_CENTER)
static babyCareCenter(latitude: number, longitude: number): TagData {
  return TagBuilder.location(latitude, longitude, 'Baby Care Center', StandardLocationId.BABY_CARE_CENTER);
}
```

**Note:** The `@locationHelper` decorator automatically registers this method for validation - no manual mapping needed!

**3. Update test's recommended list** (if you added helper)

Edit `src/tags/__tests__/tagCompleteness.test.ts` to add your location to the `recommendedLocationIds` array:

```typescript
const recommendedLocationIds = [
  // ... existing IDs
  StandardLocationId.BABY_CARE_CENTER,
];
```

**4. Run completeness tests**
```bash
npm test -- src/tags/__tests__/tagCompleteness.test.ts
```

---

## Completeness Test Benefits

The completeness tests automatically verify:

✅ **Every `TagType` has a `TAG_NAME`** - Catches missing human-readable names
✅ **Every tag is categorized** - Either simple (in `SIMPLE_TAG_TYPES`) or complex (has validator)
✅ **Every tag has a builder method** - Maps tag types to builder methods
✅ **Builder methods work correctly** - Returns correct tag type and format
✅ **Standard location IDs are consistent** - All use `location-` prefix and lowercase-with-hyphens
✅ **Location helpers return correct IDs** - Maps StandardLocationId to helper methods

## Error Messages

The completeness tests provide clear error messages:

```
Missing TAG_NAMES for: VIRTUAL_QUEUE
Call registerSimple(TagType.VIRTUAL_QUEUE, 'Virtual Queue') in tagTypes.ts
```

```
Missing TagBuilder methods for simple tags: VIRTUAL_QUEUE
Add static method to TagBuilder class with @simpleTag decorator
```

```
Uncategorized TagTypes: AGE_RESTRICTION
Call registerComplex(TagType.AGE_RESTRICTION, 'Age Restriction') or add validator in validators.ts
```

## Quick Checklist

### Simple Tag Checklist
- [ ] Add to `TagType` enum and call `registerSimple()` 🎯
- [ ] Add builder method with `@simpleTag` decorator ⚡
- [ ] Add tests
- [ ] Run completeness tests ✅

### Complex Tag Checklist
- [ ] Add to `TagType` enum and call `registerComplex()` 🎯
- [ ] Add type interface
- [ ] Add validator function
- [ ] Add case in `validateTagValue` switch
- [ ] Add builder method with `@complexTag` decorator ⚡
- [ ] Add tests
- [ ] Run completeness tests ✅

### Standard Location ID Checklist
- [ ] Add to `StandardLocationId` enum (with `location-` prefix)
- [ ] (Optional) Add helper method with `@locationHelper` decorator ⚡
- [ ] (Optional) Add to `recommendedLocationIds` in completeness test
- [ ] Add tests
- [ ] Run completeness tests ✅

🎯 = Single registration call automatically adds to TAG_NAMES and SIMPLE_TAG_TYPES/complex category!
⚡ = Decorator automatically registers the method - no manual mapping needed!

## Testing Commands

```bash
# Run completeness tests only
npm test -- src/tags/__tests__/tagCompleteness.test.ts

# Run all tag tests
npm test -- src/tags/__tests__/

# Run full test suite
npm test
```

## Best Practices

1. **Always run completeness tests** when adding tags - they catch mistakes immediately
2. **Use descriptive TAG_NAMES** - These are shown to users
3. **Add JSDoc comments** - Document builder methods with @param and @example
4. **Write comprehensive tests** - Cover edge cases and error conditions
5. **Use standard location IDs** - Ensure consistency across parks
6. **Keep IDs lowercase-with-hyphens** - Maintains naming consistency

## Need Help?

The completeness tests will guide you! Run them after each step and they'll tell you exactly what's missing.

```bash
npm test -- src/tags/__tests__/tagCompleteness.test.ts
```
