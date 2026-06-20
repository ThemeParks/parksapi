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
        parkId: 19,
        timezone: 'Asia/Shanghai',
        ...(options?.config ?? {}),
      },
    });
    this.destinationLocation ??= {latitude: 31.3599, longitude: 118.4582};
  }
}
