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

## Known Issues
- Kennywood wait times: park opens April 28, 2026
- Silver Dollar City schedules: 500s on large day ranges (fixed with 7-day batching)
- Six Flags: 155 entities from international/seasonal parks return 404 from POI endpoint
