import {Fantawild} from './fantawild.js';
import {destinationController} from '../../destinationRegistry.js';
import type {DestinationConstructor} from '../../destination.js';

@destinationController({category: ['Fantawild']})
export class WuhuDreamland extends Fantawild {
  constructor(options?: DestinationConstructor) {
    super({
      ...options,
      config: {
        destinationId: 'fantawild_wuhudreamland',
        destinationName: 'Fantawild Dreamland Wuhu',
        timezone: 'Asia/Shanghai',
        ...(options?.config ?? {}),
      },
    });
    // parkId is numeric and DestinationConstructor.config is string-only, so
    // assign it directly. The @config decorator still honours an env-var
    // override (FANTAWILD_PARKID / WUHUDREAMLAND_PARKID); only fall back to
    // the literal when nothing set it.
    if (!this.parkId) this.parkId = 19;
    this.destinationLocation ??= {latitude: 31.3599, longitude: 118.4582};
  }
}
