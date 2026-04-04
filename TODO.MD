# ParksAPI TypeScript Migration TODO

## Current Status

**Migrated (TypeScript in `src/`):**
- Core framework: cache, config, http, injector, datetime, proxy, tracing, virtual queue
- Universal Studios: Orlando, Hollywood, Japan (USJ), Singapore (USS), Beijing (5 destinations)
- Cedar Fair / Attractions.io v3: 12 parks via API discovery
- Attractions.io v1: 16 parks (Merlin/Legoland) with SQLite entity store
- Efteling: Multi-language (en/nl), virtual queue, live API, restaurants
- Phantasialand: Anonymous auth, location spoofing, HTML calendar
- Liseberg: Public API, no auth
- PortAventura World: Strapi v4 CMS + client SSL certificates (3 parks)
- Parcs Reunidos / StayApp: 5 parks
- Six Flags: 34 destinations via Firebase Remote Config
- Herschend / HFE: Dollywood, Silver Dollar City, Kennywood, Wild Adventures
- Disney: Disneyland Paris (GraphQL), Tokyo Disney Resort, Shanghai Disneyland Resort
- TE2 / Australia: 4 parks
- Hersheypark, Parc Asterix, Europa-Park (3 sub-parks), Toverland, Paultons Park
- SeaWorld / Busch Gardens: 5 parks (Orlando, San Diego, San Antonio, Tampa, Williamsburg)
- Walibi + Bellewaerde: 4 parks (Holland, Belgium, Rhône-Alpes, Bellewaerde)
- Plopsa: 2 parks (Plopsaland De Panne, Plopsaland Deutschland)
- HansaPark
- Futuroscope: Session auth, Next.js calendar scraping
- Everland
- Universal Studios Japan (USJ): UDX platform, OAuth2 + public CDN, fake-UTC show times
- Universal Studios Singapore (USS)
- Lotte World
- Chimelong: Guangzhou + Zhuhai (2 destinations)

**Totals: ~118 destinations, 1064 tests, 45 test files**

## Remaining Migrations

### High Priority
- [ ] **Walt Disney World** (4 parks) — most complex, multiple APIs, custom DB
- [ ] **Disneyland Resort** (2 parks) — similar to WDW
- [ ] **Hong Kong Disneyland** (1 park)

## Post-Migration: Entity ID Changes

These parks have different entity IDs in TS vs JS. Before switching the collector,
run `npm run migrate -- <parkId>` to update externalIds on api.themeparks.wiki.

- ~~**Walibi Holland**~~ — done (attractions switched from `attr_gforce` slugified name to API UUIDs)
- ~~**Bellewaerde**~~ — done
- ~~**Walibi Rhône-Alpes**~~ — done
- ~~**Walibi Belgium**~~ — done
- ~~**Plopsaland De Panne**~~ — done (old API used different ID format; new API uses `plopsa_id`)

## Known Issues
- Kennywood wait times: park opens April 28, 2026
- Silver Dollar City schedules: 500s on large day ranges (fixed with 7-day batching)
- Six Flags: 155 entities from international/seasonal parks return 404 from POI endpoint

### Universal Studios Singapore (`src/parks/uss/universalsingapore.ts`)

- **Schedule data**: No schedule endpoint has been found in the API yet. `buildSchedules()` returns empty. Needs investigation to find operating hours data.
- **Wait time data**: Wait times untested while park is open. The `WaitTime` field is expected to return a numeric string (e.g. `"15"`) when attractions are operating — confirm this is parsed correctly once live data is available during park hours.
