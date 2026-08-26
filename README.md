# ThemeParks.wiki Park Data Backend

An open-source TypeScript library for fetching real-time theme park data — wait times, schedules, and entity metadata — from <!-- destinations:count -->80<!-- /destinations:count -->+ destinations worldwide.

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

<div style="display: flex; align-items: center;">
  <a href="https://pocketpark.fr/">
    <img src="https://themeparks.wiki/sponsors/pocketpark.png" alt="Pocket'Park" width="40" style="margin-right: 10px;"/>
  </a>
  <span>
    <a href="https://pocketpark.fr/">Pocket'Park</a>
  </span>
</div>

## Quick Start

**Requirements:** Node.js 24+, npm 11+

```bash
git clone https://github.com/ThemeParks/parksapi.git
cd parksapi
npm install
touch .env             # Add your API credentials
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

### Without Node installed

Every command above also runs in a container, so nothing has to be installed on
the host beyond Docker (or Podman):

```bash
make build             # Build the dev image once
make park PARK=efteling
make test
make                   # Full list of targets
```

`make build` builds the image — the TypeScript compile is `make compile`.

Most destinations need credentials in `.env` in the repo root; the container
creates an empty one on first run, and `make park PARK=efteling` is one of the
few that passes without any. Dependencies install into `node_modules/` on first
run and reinstall when the lockfile changes (`make deps` forces it).

The container serves the API only. The React admin UI is a host-side build:
run `npm run web:build` on the host once, and `web-ui/dist` is visible in the
container through the bind mount.

git is not installed in the image — commit from the host, the tree is
bind-mounted.

The default engine is Docker. On a Podman host, override `COMPOSE` (untested):

```bash
make COMPOSE="podman-compose --env-file /dev/null --podman-run-args=--userns=keep-id" park PARK=efteling
```

## Supported Destinations

<!-- destinations:table -->
80 destinations across Disney, Universal, Cedar Fair, Six Flags, Merlin, and many more.

Some parks are served through a parent destination rather than an id of their own — Cedar Point and Knott's Berry Farm arrive under the Six Flags controller, for instance — so they are entities in the output rather than rows here.

Run `npm run dev -- --list` for the same list with categories.

<details>
<summary>All destinations</summary>

| Destination | ID |
|---|---|
| Alton Towers | `altontowers` |
| Bellewaerde | `bellewaerde` |
| Blackpool Pleasure Beach | `blackpoolpleasurebeach` |
| Bobbejaanland | `bobbejaanland` |
| Busch Gardens Tampa | `buschgardenstampa` |
| Busch Gardens Williamsburg | `buschgardenswilliamsburg` |
| Chessington World Of Adventures | `chessingtonworldofadventures` |
| Chimelong | `chimelong` |
| Disneyland Paris | `disneylandparis` |
| Djurs Sommerland | `djurssommerland` |
| Dollywood | `dollywood` |
| Efteling | `efteling` |
| Energylandia | `energylandia` |
| Europa Park | `europapark` |
| Everland | `everland` |
| Fantawild | `fantawild` |
| Flamingo Land | `flamingoland` |
| Fuji Q Highland | `fujiqhighland` |
| Futuroscope | `futuroscope` |
| Galveston Island Waterpark | `galvestonislandwaterpark` |
| Gardaland | `gardaland` |
| Genting Skyworlds | `gentingskyworlds` |
| Great Escape Parks | `greatescapeparks` |
| Hansa Park | `hansapark` |
| Heide Park | `heidepark` |
| Hersheypark | `hersheypark` |
| Kennywood | `kennywood` |
| Kentucky Kingdom | `kentuckykingdom` |
| Knoebels | `knoebels` |
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
| Michigans Adventure | `michigansadventure` |
| Mid America Parks | `midamericaparks` |
| Mirabilandia | `mirabilandia` |
| Movie Park Germany | `movieparkgermany` |
| Nigloland | `nigloland` |
| Ocean Park Hong Kong | `oceanparkhongkong` |
| Paradise Country | `paradisecountry` |
| Parc Asterix | `parcasterix` |
| Parque De Atracciones Madrid | `parquedeatraccionesmadrid` |
| Parque Warner Madrid | `parquewarnermadrid` |
| Paultons Park | `paultonspark` |
| Peppa Pig Theme Park Florida | `peppapigthemeparkflorida` |
| Phantasialand | `phantasialand` |
| Plopsaland | `plopsaland` |
| Plopsaland Deutschland | `plopsalanddeutschland` |
| Port Aventura World | `portaventuraworld` |
| Qiddiya City | `qiddiyacity` |
| Sea World Gold Coast | `seaworldgoldcoast` |
| Seaworld Orlando | `seaworldorlando` |
| Seaworld San Antonio | `seaworldsanantonio` |
| Seaworld San Diego | `seaworldsandiego` |
| Sesame Place Philadelphia | `sesameplacephiladelphia` |
| Sesame Place San Diego | `sesameplacesandiego` |
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
| Walibi Rhone Alpes | `walibirhonealpes` |
| Warner Bros Movie World | `warnerbrosmovieworld` |
| Wet N Wild Gold Coast | `wetnwildgoldcoast` |
| Worlds Of Fun | `worldsoffun` |

</details>
<!-- /destinations:table -->


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
