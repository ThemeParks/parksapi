// src/harness/parkMapping.ts

/**
 * Maps TS destination registry IDs to JS export class names.
 * Manually curated — JS class names don't follow a predictable pattern.
 *
 * Add entries as parks are migrated to TypeScript.
 * This is also the registry of "which parks have both implementations."
 */
export const parkMapping: Record<string, string> = {
  // Universal
  'universalorlando': 'UniversalOrlando',
  'universalstudios': 'UniversalStudios',
  // Cedar Fair parks are NOT in JS lib/index.js exports — they exist in
  // lib/parks/attractionsio/attractionsiov3.js but aren't publicly exported.
  // Cannot capture JS snapshots for these via the standard harness.
  // Efteling
  'efteling': 'Efteling',
  // Phantasialand
  'phantasialand': 'Phantasialand',
  // Liseberg
  'liseberg': 'Liseberg',
  // PortAventura
  'portaventuraworld': 'PortAventuraWorld',
  // Six Flags
  'sixflags': 'SixFlags',
  // Parcs Reunidos (StayApp)
  'movieparkgermany': 'MovieParkGermany',
  'bobbejaanland': 'Bobbejaanland',
  'mirabilandia': 'Mirabilandia',
  'parquedeatraccionesmadrid': 'ParqueDeAtraccionesMadrid',
  'parquewarnermadrid': 'ParqueWarnerMadrid',
  'kennywood': 'Kennywood',
  'dollywood': 'Dollywood',
  'silverdollarcity': 'SilverDollarCity',
  // TE2 (Australia)
  'seaworldgoldcoast': 'SeaWorldGoldCoast',
  'warnerbrosmovieworld': 'WarnerBrosMovieWorld',
  'paradisecountry': 'ParadiseCountry',
  'wetnwildgoldcoast': 'WetNWildGoldCoast',
};

/**
 * Reverse mapping: JS class name -> TS park ID
 */
export function jsClassToTsParkId(jsClassName: string): string | undefined {
  return Object.entries(parkMapping).find(([, js]) => js === jsClassName)?.[0];
}
