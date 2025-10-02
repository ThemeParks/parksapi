# ParksAPI Test Harness

Flexible testing system for validating park implementations.

## Quick Start

```bash
# List all available parks
npm run dev -- --list

# Test a specific park
npm run dev -- universalorlando

# Test all parks in a category
npm run dev -- --category Universal

# Test all parks
npm run dev

# Verbose output (shows detailed test progress)
npm run dev -- universalorlando --verbose
```

## Usage

### List Available Parks

```bash
npm run dev -- --list
```

Shows all registered parks organized by category.

### Test a Specific Park

```bash
npm run dev -- <parkId>
```

Example:
```bash
npm run dev -- universalorlando
```

Runs all 4 required tests:
1. `getDestinations()` - Validates destination entities
2. `getEntities()` - Validates parks, attractions, shows, restaurants
3. `getLiveData()` - Validates wait times and operating status
4. `getSchedules()` - Validates park operating hours

### Test by Category

```bash
npm run dev -- --category <category>
```

Example:
```bash
npm run dev -- --category Universal
```

Available categories:
- Universal
- Disney
- Six Flags
- Cedar Fair
- SeaWorld
- Merlin
- Independent
- Other

### Test All Parks

```bash
npm run dev
```

Runs tests on all registered parks and provides a summary report.

## Options

### Verbose Output

```bash
npm run dev -- universalorlando --verbose
```

Shows detailed test progress with entity counts, wait times, and schedules.

### Skip Tests

Skip specific test types to speed up testing:

```bash
# Skip live data tests (wait times)
npm run dev -- universalorlando --skip-live-data

# Skip schedule tests (operating hours)
npm run dev -- universalorlando --skip-schedules

# Combine options
npm run dev -- --skip-live-data --skip-schedules
```

## Output

### Single Park Test

```
🎢 ParksAPI Test Suite

============================================================
Testing: Universal Orlando Resort
============================================================

1. Testing getDestinations()...
   ✓ Found 1 destination(s) (1ms)

2. Testing getEntities()...
   ✓ Found 125 entities (2543ms)
     - DESTINATION: 1
     - PARK: 3
     - ATTRACTION: 87
     - SHOW: 12
     - RESTAURANT: 22

3. Testing getLiveData()...
   ✓ Found 99 live data entries (1832ms)
     - With wait times: 72
     - OPERATING: 68
     - CLOSED: 24
     - DOWN: 7

4. Testing getSchedules()...
   ✓ Found 3 schedule(s) with 570 total days (982ms)

✅ Universal Orlando Resort: 4/4 tests passed (5358ms)
```

### All Parks Test

```
🎢 ParksAPI Test Suite

Testing all 2 parks

✅ Universal Orlando Resort (4/4 tests)
✅ Universal Studios Hollywood (4/4 tests)


================================================================================
📊 TEST SUMMARY
================================================================================

Parks Tested:    2
Parks Passed:    2 ✅
Parks Failed:    0
Total Tests:     8/8
Total Duration:  10.52s

Individual Results:
  ✅ Universal Orlando Resort                      4/4        5.36s
  ✅ Universal Studios Hollywood                   4/4        5.16s

================================================================================
🎉 ALL TESTS PASSED!
================================================================================
```

## Adding New Parks to Registry

Parks register themselves automatically using the `@park` decorator:

### 1. Add decorator to your destination class

ID and name are automatically derived from the class name:

```typescript
import {destinationController} from '../../destinationRegistry.js';

// Single category
@destinationController({ category: 'Independent' })
export class YourNewPark extends Destination {
  // ID: 'yournewpark'
  // Name: 'Your New Park'
}

// Multiple categories
@destinationController({ category: ['Six Flags', 'California'] })
export class SixFlagsMagicMountain extends Destination {
  // ID: 'sixflagsmagicmountain'
  // Name: 'Six Flags Magic Mountain'
}
```

### 2. File placement

Place your file in the `src/parks/` directory structure:

```
src/parks/
  ├── universal/
  │   └── universal.ts
  └── yourpark/
      └── yourpark.ts
```

That's it! The test harness automatically discovers and loads all `.ts` files in `src/parks/`. Your destination will automatically appear in `--list` and be available for testing.

**No manual imports needed** - destinations are discovered dynamically!

## Test Validation

Each test validates:

### getDestinations()
- Returns an array
- Array is not empty
- Each destination has `id`, `name`, `entityType`
- `entityType` is `'DESTINATION'`

### getEntities()
- Returns an array
- Array is not empty
- Each entity has `id`, `name`, `entityType`
- Counts entities by type

### getLiveData()
- Returns an array
- Counts entries by status (OPERATING, CLOSED, DOWN)
- Counts entries with wait time data
- Validates queue and showtime structures

### getSchedules()
- Returns an array
- Each schedule has `id` and `schedule` array
- Validates schedule entry structures
- Counts total days across all schedules

## Exit Codes

- `0` - All tests passed
- `1` - One or more tests failed

Use in CI/CD pipelines:

```bash
npm run dev && echo "Tests passed!" || echo "Tests failed!"
```

## Architecture

- **parkRegistry.ts** - Central registry of all park implementations
- **testRunner.ts** - Generic test runner for any Destination class
- **test.ts** - CLI interface and main entry point

## Tips

- Use `--skip-live-data` and `--skip-schedules` during development to speed up iteration
- Use `--verbose` when debugging specific park implementations
- Test individual parks frequently during development
- Run full test suite before committing changes
