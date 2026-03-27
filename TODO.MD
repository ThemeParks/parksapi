# ParksAPI TypeScript Migration TODO

## Current Status

**Migrated (TypeScript in `src/`):**
- Core framework: cache, config, http, injector, datetime, proxy, tracing, virtual queue (701 tests)
- Universal Studios: Orlando + Hollywood (2 parks)
- Cedar Fair / Attractions.io v3: 12 parks via API discovery
- Efteling: Multi-language (en/nl), virtual queue, live API
- Phantasialand: Anonymous auth, location spoofing, HTML calendar
- Liseberg: Public API, no auth
- PortAventura World: Strapi v4 CMS + client SSL certificates (3 parks)
- Parcs Reunidos / StayApp: 5 parks (Movie Park Germany, Bobbejaanland, Mirabilandia, Parque de Atracciones Madrid, Parque Warner Madrid)
- Six Flags: 34 destinations via Firebase Remote Config, dynamic park discovery
- Herschend / HFE: Dollywood, Silver Dollar City, Kennywood (shared framework)

**Totals: ~49 destinations, ~65+ parks, 701 tests**

## Remaining Migrations

### High Priority
- [ ] **SeaWorld / Busch Gardens** (5 parks) — straightforward
- [ ] **Disney** (~12 parks) — most complex, multiple APIs, custom DB
- [ ] **Attractions.io v1** (~17 parks) — Merlin/Legoland, needs APK version utility

### Medium Priority
- [ ] **TE2 / Australia** (4 parks) — SeaWorld Gold Coast, Warner Bros Movie World, etc.
- [ ] **Walibi parks** (4 parks) — Walibi Holland, Bellewaerde, Walibi Rhone Alpes, Walibi Belgium
- [ ] **Plopsa parks** (2 parks) — Plopsaland, Plopsaland Deutschland

### Standalone European Parks
- [ ] Toverland
- [ ] Hansapark
- [ ] Futuroscope

### Standalone Asian Parks
- [ ] Everland
- [ ] Lotte World
- [ ] Chimelong

### Other
- [ ] Hersheypark
- [ ] Wild Adventures (HFE destId 3 — same framework as Dollywood)

## Known Issues
- Kennywood wait times: park opens April 28, 2026 — no wait time destination ID yet
- Silver Dollar City schedules: server intermittently 500s on large day ranges (fixed with 7-day batching)
- Six Flags: 155 entities from international/seasonal parks return 404 from POI endpoint
- Parcs Reunidos: Kennywood removed (uses HFE API, not StayApp)
- Efteling: 3 entity differences vs JS (JS uses stale static files, TS uses live API)

## Feature Opportunities
- [ ] Per-domain rate limiting
- [ ] Static POI data file support
- [ ] Restaurant entities for more parks
- [ ] Wild Adventures implementation (HFE destId 3)
