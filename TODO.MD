# ParksAPI TypeScript Migration TODO

## Current Status

**Migrated (TypeScript in `src/`):**
- Core framework: cache, config, http, injector, datetime, proxy, tracing, virtual queue (848 tests)
- Universal Studios: Orlando + Hollywood (2 parks)
- Cedar Fair / Attractions.io v3: 12 parks via API discovery
- Efteling: Multi-language (en/nl), virtual queue, live API
- Phantasialand: Anonymous auth, location spoofing, HTML calendar
- Liseberg: Public API, no auth
- PortAventura World: Strapi v4 CMS + client SSL certificates (3 parks)
- Parcs Reunidos / StayApp: 5 parks (Movie Park Germany, Bobbejaanland, Mirabilandia, Parque de Atracciones Madrid, Parque Warner Madrid)
- Six Flags: 34 destinations via Firebase Remote Config, dynamic park discovery
- Herschend / HFE: Dollywood, Silver Dollar City, Kennywood, Wild Adventures (shared framework)
- Disney: Disneyland Paris (GraphQL), Tokyo Disney Resort (device registration), Shanghai Disneyland Resort (version compare API)
- TE2 / Australia: 4 parks (SeaWorld Gold Coast, Warner Bros Movie World, Paradise Country, Wet'n'Wild Gold Coast)
- Hersheypark: Simple two-endpoint park
- Parc Asterix: GraphQL persisted queries + offline ZIP/SQLite package

**Totals: ~80 destinations, 848 tests**

## Remaining Migrations

### High Priority
- [ ] **Walt Disney World** (4 parks) — most complex, multiple APIs, custom DB
- [ ] **Disneyland Resort** (2 parks) — similar to WDW but separate API
- [ ] **Hong Kong Disneyland** (1 park) — similar to other Disney parks
- [ ] **Attractions.io v1** (~17 parks) — Merlin/Legoland, needs APK version utility

### Medium Priority
- [ ] **SeaWorld / Busch Gardens** (5 parks) — straightforward
- [ ] **Walibi parks** (4 parks) — Walibi Holland, Bellewaerde, Walibi Rhone Alpes, Walibi Belgium
- [ ] **Plopsa parks** (2 parks) — Plopsaland, Plopsaland Deutschland
- [ ] **EuropaPark** — custom database

### Standalone European Parks
- [ ] Toverland
- [ ] Hansapark
- [ ] Futuroscope

### Standalone Asian Parks
- [ ] Everland
- [ ] Lotte World
- [ ] Chimelong

### Other
- [ ] Universal Studios Beijing
- [ ] Paultons Park

## Known Issues
- Kennywood wait times: park opens April 28, 2026 — no wait time destination ID yet
- Silver Dollar City schedules: server intermittently 500s on large day ranges (fixed with 7-day batching)
- Six Flags: 155 entities from international/seasonal parks return 404 from POI endpoint
- Efteling: 3 entity differences vs JS (JS uses stale static files, TS uses live API)

## Feature Opportunities
- [ ] Per-domain rate limiting
- [ ] Static POI data file support
- [ ] Restaurant entities for more parks
