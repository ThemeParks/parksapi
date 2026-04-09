# ThemeParks.wiki Park Data Backend

An open-source TypeScript library for fetching real-time theme park data — wait times, schedules, and entity metadata — from 74+ destinations worldwide.

This library powers the free API at [ThemeParks.wiki](https://themeparks.wiki).

**License:** MIT

## Sponsored By

<div style="display: flex; align-items: center;">
  <a href="https://touringplans.com/">
    <img src="https://themeparks.wiki/sponsors/touringplans.png" alt="TouringPlans.com" width="40" style="margin-right: 10px;"/>
  </a>
  <span>
    <a href="https://touringplans.com/">TouringPlans.com</a>
  </span>
</div>

<div style="display: flex; align-items: center;">
  <a href="https://www.queue-times.com/">
    <img src="https://themeparks.wiki/sponsors/queuetimes.png" alt="Queue Times" width="40" style="margin-right: 10px;"/>
  </a>
  <span>
    <a href="https://www.queue-times.com/">Queue Times</a>
  </span>
</div>

## Quick Start

**Requirements:** Node.js 24+, npm 11+

```bash
git clone https://github.com/ThemeParks/parksapi.git
cd parksapi
npm install
cp .env.example .env  # Add your API credentials
npm run dev            # Test all parks
```

Most parks require API credentials not provided in this repo — you must source these yourself.

## Usage

```typescript
import {getDestinationById} from '@themeparks/parksapi';

const dest = await getDestinationById('universalorlando');
const park = new dest.DestinationClass();

const entities = await park.getEntities();   // Rides, shows, restaurants
const liveData = await park.getLiveData();    // Wait times, statuses
const schedules = await park.getSchedules();  // Operating hours
```

## Client Libraries

To fetch data from the ThemeParks.wiki API (rather than running this library directly):

- [JavaScript Client](https://github.com/ThemeParks/ThemeParks_JavaScript)
- [Python Client](https://github.com/ThemeParks/ThemeParks_Python)

## Commands

```bash
npm run build          # Compile TypeScript
npm run dev            # Test all parks
npm run dev -- <id>    # Test specific park (e.g. universalorlando)
npm run dev -- --list  # List all available park IDs
npm test               # Run unit tests
npm run test:coverage  # Coverage report
npm run health         # Health check all endpoints
```

## Supported Destinations

74 destinations across Disney, Universal, Cedar Fair, Six Flags, Merlin, and many more.

Run `npm run dev -- --list` for the full list with IDs and categories, or see below:

<details>
<summary>All destinations</summary>

| Destination | ID |
|---|---|
| Alton Towers | `altontowers` |
| Bellewaerde | `bellewaerde` |
| Bobbejaanland | `bobbejaanland` |
| Busch Gardens Tampa | `buschgardenstampa` |
| Busch Gardens Williamsburg | `buschgardenswilliamsburg` |
| California's Great America | `californiasgreatamerica` |
| Canada's Wonderland | `canadaswonderland` |
| Carowinds | `carowinds` |
| Cedar Point | `cedarpoint` |
| Chessington World of Adventures | `chessingtonworldofadventures` |
| Chimelong | `chimelong` |
| Disneyland Paris | `disneylandparis` |
| Djurs Sommerland | `djurssommerland` |
| Dollywood | `dollywood` |
| Dorney Park | `dorneypark` |
| Efteling | `efteling` |
| Europa-Park | `europapark` |
| Everland | `everland` |
| Futuroscope | `futuroscope` |
| Gardaland | `gardaland` |
| Hansa-Park | `hansapark` |
| Heide Park | `heidepark` |
| Hersheypark | `hersheypark` |
| Kennywood | `kennywood` |
| Kings Dominion | `kingsdominion` |
| Kings Island | `kingsisland` |
| Knoebels | `knoebels` |
| Knott's Berry Farm | `knottsberryfarm` |
| Legoland Billund | `legolandbillund` |
| Legoland California | `legolandcalifornia` |
| Legoland Deutschland | `legolanddeutschland` |
| Legoland Japan | `legolandjapan` |
| Legoland Korea | `legolandkorea` |
| Legoland New York | `legolandnewyork` |
| Legoland Orlando | `legolandorlando` |
| Legoland Windsor | `legolandwindsor` |
| Liseberg | `liseberg` |
| Lotte World | `lotteworld` |
| Michigan's Adventure | `michigansadventure` |
| Mirabilandia | `mirabilandia` |
| Movie Park Germany | `movieparkgermany` |
| Parc Asterix | `parcasterix` |
| Paradise Country | `paradisecountry` |
| Parque de Atracciones Madrid | `parquedeatraccionesmadrid` |
| Parque Warner Madrid | `parquewarnermadrid` |
| Paultons Park | `paultonspark` |
| Peppa Pig Theme Park Florida | `peppapigthemeparkflorida` |
| Phantasialand | `phantasialand` |
| Plopsaland | `plopsaland` |
| Plopsaland Deutschland | `plopsalanddeutschland` |
| PortAventura World | `portaventuraworld` |
| Sea World Gold Coast | `seaworldgoldcoast` |
| SeaWorld Orlando | `seaworldorlando` |
| SeaWorld San Antonio | `seaworldsanantonio` |
| SeaWorld San Diego | `seaworldsandiego` |
| Shanghai Disneyland Resort | `shanghaidisneylandresort` |
| Silver Dollar City | `silverdollarcity` |
| Six Flags | `sixflags` |
| Thorpe Park | `thorpepark` |
| Tokyo Disney Resort | `tokyodisneyresort` |
| Toverland | `toverland` |
| Universal Orlando | `universalorlando` |
| Universal Singapore | `universalsingapore` |
| Universal Studios | `universalstudios` |
| Universal Studios Beijing | `universalstudiosbeijing` |
| Universal Studios Japan | `universalstudiosjapan` |
| Valleyfair | `valleyfair` |
| Walibi Belgium | `walibibelgium` |
| Walibi Holland | `walibiholland` |
| Walibi Rhone-Alpes | `walibirhonealpes` |
| Warner Bros. Movie World | `warnerbrosmovieworld` |
| Wet'n'Wild Gold Coast | `wetnwildgoldcoast` |
| Wild Adventures | `wildadventures` |
| Worlds of Fun | `worldsoffun` |

</details>

## Entity Types

Each destination produces **entities** of the following types:

- **Destination** — A resort or group of parks (e.g., Walt Disney World Resort)
- **Park** — A theme park within a destination (e.g., Magic Kingdom)
- **Attraction** — A ride, transport, or similar experience (e.g., Pirates of the Caribbean)
- **Show** — A performance or parade with scheduled show times
- **Restaurant** — A dining location

## Configuration

Environment variables follow the pattern `{CLASSNAME}_{PROPERTY}`:

```
UNIVERSALORLANDO_APIKEY=your-key-here
EFTELING_APPVERSION=5.0.0
```

Create a `.env` file in the project root. Some destinations share configuration via prefixes (e.g., `ATTRACTIONSIO_BASEURL` applies to all Attractions.io parks).

Run `npm run dev -- <id> -v` to see which config properties a destination expects.

## Architecture

The library uses a **decorator-based design** with TypeScript:

- **`@destinationController`** — Auto-registers destinations, applies config proxy
- **`@config`** — Property-level config injection from env vars
- **`@http`** — Queue-based HTTP with retry, caching, validation
- **`@inject`** — Event-based dependency injection (auth headers, response transforms)
- **`@cache`** — SQLite-backed caching with TTL

All parks extend the `Destination` base class using the **Template Method Pattern** — implement `buildEntityList()`, `buildLiveData()`, and `buildSchedules()`.

See `CLAUDE.md` for full architecture documentation.

## Contributing

Contributions are welcome. To add a new destination:

1. Create `src/parks/<name>/<name>.ts` extending `Destination`
2. Implement entity, live data, and schedule methods
3. Test with `npm run dev -- <id>`
4. Submit a PR

See `CLAUDE.md` and `.claude/skills/implementing-parks.md` for detailed implementation guidance.

## Support

General support is available for the [ThemeParks.wiki API](https://themeparks.wiki). This source code is self-service (sponsors get support benefits).

## API Documentation

[https://themeparks.github.io/parksapi/](https://themeparks.github.io/parksapi/)
