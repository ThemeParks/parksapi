import Efteling from './parks/efteling/efteling.js';
import {
  WaltDisneyWorldResort,
  DisneylandResort,
  HongKongDisneyland,
} from './parks/wdw/waltdisneyworldbase.js';
import {
  DisneylandParis,
} from './parks/dlp/disneylandparis.js';
import {
  ShanghaiDisneylandPark,
} from './parks/shdr/shanghaidisneyresort.js';
import {
  TokyoDisneyResort,
} from './parks/tdr/tokyodisneyresort.js';
import {
  // parks - DEPRECATED
  UniversalStudiosFlorida,
  UniversalIslandsOfAdventure,
  UniversalVolcanoBay,
  // UniversalStudios,
} from './parks/universal/universalstudios.js';
import {
  // destinations
  UniversalStudios,
  UniversalOrlando,
} from './parks/universal/universal.js';
import {
  // destinations
  EuropaPark,
} from './parks/europa/europapark.js';

export default {
  parks: {
    ShanghaiDisneylandPark,
    TokyoDisneyResort,
    UniversalStudiosFlorida,
    UniversalIslandsOfAdventure,
    UniversalVolcanoBay,
  },
  allParks: [
    ShanghaiDisneylandPark,
    TokyoDisneyResort,
    UniversalStudiosFlorida,
    UniversalIslandsOfAdventure,
    UniversalVolcanoBay,
  ],
  destinations: {
    WaltDisneyWorldResort,
    DisneylandResort,
    DisneylandParis,
    TokyoDisneyResort,
    HongKongDisneyland,
    UniversalStudios,
    UniversalOrlando,
    EuropaPark,
    Efteling,
  },
};
