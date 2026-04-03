# TODO

## Universal Studios Singapore (`src/parks/uss/universalsingapore.ts`)

- **Schedule data**: No schedule endpoint has been found in the API yet. `buildSchedules()` returns empty. Needs investigation to find operating hours data.
- **Wait time data**: Wait times untested while park is open. The `WaitTime` field is expected to return a numeric string (e.g. `"15"`) when attractions are operating — confirm this is parsed correctly once live data is available during park hours.
