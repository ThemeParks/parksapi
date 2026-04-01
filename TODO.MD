# ParksAPI TypeScript Migration TODO

## Current Status

**Migrated (TypeScript in `src/`):**
- Core framework: cache, config, http, injector, datetime, proxy, tracing, virtual queue (1001 tests)
- Universal Studios: Orlando + Hollywood (2 destinations)
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

**Totals: ~97 destinations, 1001 tests, 44 test files**

## Remaining Migrations (20 parks)

### High Priority
- [ ] **Walt Disney World** (4 parks) — most complex, multiple APIs, custom DB
- [ ] **Disneyland Resort** (2 parks) — similar to WDW
- [ ] **Hong Kong Disneyland** (1 park)

### Medium Priority
- [ ] **SeaWorld / Busch Gardens** (5 parks) — shared framework
- [ ] **Walibi + Bellewaerde** (4 parks) — likely shared API
- [ ] **Plopsa** (2 parks) — Plopsaland, Plopsaland Deutschland

### Standalone Parks
- [ ] HansaPark
- [ ] Futuroscope
- [ ] Universal Studios Beijing

### Standalone Asian Parks
- [ ] Everland
- [ ] Lotte World
- [ ] Chimelong

## Post-Migration: Entity ID Changes

These parks have different entity IDs in TS vs JS. Before switching the collector,
run `npm run migrate -- <parkId>` to update externalIds on api.themeparks.wiki.

- **Walibi Holland** — attractions switched from `attr_gforce` (slugified name) to API UUIDs
- **Bellewaerde** — same change as Walibi Holland
- **Walibi Rhône-Alpes** — same change as Walibi Holland
- **Walibi Belgium** — same change as Walibi Holland
- **Plopsaland De Panne** — old API used different ID format; new API uses `plopsa_id`

## Known Issues
- Kennywood wait times: park opens April 28, 2026
- Silver Dollar City schedules: 500s on large day ranges (fixed with 7-day batching)
- Six Flags: 155 entities from international/seasonal parks return 404 from POI endpoint
