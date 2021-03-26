import Resort from '../resort.js';
import Pusher from 'pusher-js';

export class BlackpoolPleasureBeach extends Resort {
  constructor(options = {}) {

    options.configPrefixes = ['BLACKPOOL'].concat(options.configPrefixes || []);

    options.pusherKey = options.pusherKey || '';
    options.pusherCluster = options.pusherCluster || '';
    options.pusherRideChannel = options.pusherRideChannel || '';
    options.pusherRideMessage = options.pusherRideMessage || '';

    super(options);

    console.log(this.config);
  }

  async buildResortEntity() {
    return {
      // TODO
      ...this.buildBaseEntityObject(),
      _id: 'blackpoolpleasurebeach',
      name: 'Blackpool Pleasure Beach',
    };
  }

  async buildParkEntities() {
    return [
      {
        // TODO
        ...this.buildBaseEntityObject(),
        _id: 'blackpoolpleasurebeachpark',
        name: 'Blackpool Pleasure Beach',
      },
    ];
  }

  async buildAttractionEntities() {
    // TODO
    return [];
  }

  async buildRestaurantEntities() {
    // TODO
    return [];
  }
};

// DEBUG - REMOVE
if (import.meta.url.endsWith('blackpool.js')) {
  const B = new BlackpoolPleasureBeach();
  const pusher = new Pusher(B.config.pusherKey, {
    cluster: B.config.pusherCluster,
  });

  const channel = pusher.subscribe(B.config.pusherRideChannel);
  channel.bind(B.config.pusherRideMessage, (data) => {
    console.log(data);
  });

  pusher.connection.bind('connected', (d) => {
    console.log('CONNECTED', d);
  });
  pusher.connection.bind('disconnected', (d) => {
    console.log('DISCONNECTED', d);
  });
}
