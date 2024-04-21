import parksapi from './lib/index.js';
import {entityType, queueType} from './lib/parks/parkTypes.js';
import moment from 'moment-timezone';
import path from 'path';
import {promises as fs} from 'fs';

const __dirname = path.dirname(process.argv[1]);

const destination = new parksapi.destinations.WalibiHolland();

const logSuccess = (...msg) => {
  // print green tick
  console.log(`[\x1b[32m✓\x1b[0m]`, ...msg);
}

const logError = (...msg) => {
  // print red cross
  console.log(`[\x1b[31m✗\x1b[0m]`, ...msg);
}

destination.on('error', (id, err, data) => {
  logError(`${id}: ${err} ${JSON.stringify(data, null, 4)}`);
  debugger;
});

const _requiredFields = [
  'timezone',
  '_id',
  'name',
  'entityType',
];

const requiredFields = {
  [entityType.destination]: [
    ..._requiredFields,
    'slug',
  ],
  [entityType.park]: [
    ..._requiredFields,
    '_parentId',
    '_destinationId',
  ],
  [entityType.attraction]: [
    ..._requiredFields,
    //'_parkId',
    '_parentId',
    '_destinationId',
    'attractionType',
  ],
  [entityType.show]: [
    ..._requiredFields,
    //'_parkId',
    '_parentId',
    '_destinationId',
  ],
  [entityType.restaurant]: [
    ..._requiredFields,
    //'_parkId',
    '_parentId',
    '_destinationId',
  ],
};

class EntityError extends Error {
  constructor(message, entity) {
    super(message);
    this.name = 'EntityError';
    this.entity = JSON.stringify(entity, null, 4);
  }
}

function TestEntity(ent) {
  if (!ent.entityType) {
    throw new EntityError('entityType is required', ent);
  }
  if (!ent._id) {
    throw new EntityError('_id is required', ent);
  }
  if (typeof ent._id !== 'string') {
    throw new EntityError('_id must be a string', ent);
  }

  if (ent._id === 'resortId') {
    throw new EntityError('resortId is default template _id, must change', ent);
  }
  if (ent.slug === 'resortslug') {
    throw new EntityError('resortslug is default template slug, must change', ent);
  }

  const entityType = ent.entityType;
  if (!requiredFields[entityType]) {
    throw new EntityError(`Invalid entityType: ${entityType}`, ent);
  }

  const fields = requiredFields[entityType];
  for (const field of fields) {
    if (ent[field] === undefined) {
      throw new EntityError(`${field} is required`, ent);
    }
  }

  if (entityType == "DESTINATION") {
    // destination must not have a parentId or destinationId
    if (ent._parentId) {
      throw new EntityError('destination must not have a parentId', ent);
    }
    if (ent._destinationId) {
      throw new EntityError('destination must not have a destinationId', ent);
    }
    if (ent._parkId) {
      throw new EntityError('destination must not have a parkId', ent);
    }
  }
}

function TestLiveData(data, ents) {
  if (!data._id) {
    throw new EntityError('Missing _id', data);
  }
  if (typeof data._id !== 'string') {
    throw new EntityError('livedata _id must be a string', data);
  }
  if (!data.status) {
    throw new EntityError('Missing status', data);
  }

  if (data?.queue && data?.queue[queueType.standBy]) {
    if (typeof data.queue[queueType.standBy].waitTime != 'number' && data.queue[queueType.standBy].waitTime !== null) {
      throw new EntityError('StandbyQueue missing waitTime number', data);
    }
  }

  const ent = ents.find((x) => x._id === data._id);
  if (!ent) {
    logError(`Missing entity ${data._id} for livedata: ${JSON.stringify(data)}`);
  } else {
    data._name = ent.name;
  }

  // logSuccess(`${data._id}: ${JSON.stringify(data)}`);
}

function TestSchedule(scheduleData, entityId) {
  const entSchedule = scheduleData.find((x) => x._id === entityId);
  if (!entSchedule) {
    throw new EntityError(`Missing schedule ${entityId}`, scheduleData);
  }

  if (entSchedule.schedule.length === 0) {
    throw new EntityError(`Schedule ${entityId} is empty`, scheduleData);
  }

  for (const schedule of entSchedule.schedule) {
    if (!schedule.type) {
      throw new EntityError('Missing type', schedule);
    }
    if (!schedule.date) {
      throw new EntityError('Missing date', schedule);
    }
    if (!schedule.openingTime) {
      throw new EntityError('Missing openingTime', schedule);
    }
    if (!schedule.closingTime) {
      throw new EntityError('Missing closingTime', schedule);
    }

    const open = moment(schedule.openingTime);
    if (!open.isValid()) {
      throw new EntityError('Invalid openingTime', schedule);
    }

    const close = moment(schedule.closingTime);
    if (!close.isValid()) {
      throw new EntityError('Invalid closingTime', schedule);
    }

  }

  // check we have some schedule data for the next 2 months
  const now = moment();
  const nextMonth = moment().add(2, 'month');
  let schedulesForNextMonth = 0;
  let scheduleDays = 0;
  for (const date = now.clone(); date.isBefore(nextMonth); date.add(1, 'day')) {
    scheduleDays++;
    const schedule = entSchedule.schedule.filter((x) => x.date === date.format('YYYY-MM-DD'));
    if (schedule && schedule.length > 0) {
      schedulesForNextMonth += schedule.length;
    }
  }

  if (schedulesForNextMonth === 0) {
    throw new EntityError(`No schedule data found for next 2 months for ${entityId}`);
  }

  logSuccess(`${entityId}: ${schedulesForNextMonth} schedules found for next month [${scheduleDays} days]`);

  // console.log(entSchedule.schedule);
}

async function TestDestination() {
  const destinations = [].concat(await destination.buildDestinationEntity());
  for (const dest of destinations) {
    TestEntity(dest);
  }

  const allEntities = await destination.getAllEntities();
  for (const ent of allEntities) {
    TestEntity(ent);
  }
  logSuccess(`${allEntities.length} entities tested`);
  const entityTypes = allEntities.reduce((x, ent) => {
    x[ent.entityType] = x[ent.entityType] || 0;
    x[ent.entityType]++;
    return x;
  }, {});
  Object.keys(entityTypes).forEach((x) => {
    console.log(`\t${entityTypes[x]} ${x} entities`);
  });

  // test for entity id collisions
  const entityIds = allEntities.map((x) => x._id);
  const duplicateEntityIds = entityIds.filter((x, i) => entityIds.indexOf(x) !== i);
  if (duplicateEntityIds.length > 0) {
    logError(`${duplicateEntityIds.length} entity ids are duplicated`);
    console.log(duplicateEntityIds);
  } else {
    logSuccess(`No entity ids are duplicated`);
  }

  // test for entity slug collisions
  const entitySlugs = allEntities.map((x) => x.slug).filter((x) => !!x);
  const duplicateEntitySlugs = entitySlugs.filter((x, i) => entitySlugs.indexOf(x) !== i);
  if (duplicateEntitySlugs.length > 0) {
    logError(`${duplicateEntitySlugs.length} entity slugs are duplicated`);
    console.log(duplicateEntitySlugs);
  } else {
    logSuccess(`No entity slugs are duplicated`);
  }

  // write all entities to a file
  const entityDataFile = path.join(__dirname, 'testout_Entities.json');
  await fs.writeFile(entityDataFile, JSON.stringify(allEntities, null, 4));

  const schedule = await destination.getEntitySchedules();
  // get parks
  const parks = await destination.getParkEntities();
  for (const park of parks) {
    TestSchedule(schedule, park._id);
  }
  logSuccess(`${parks.length} park schedules tested`);

  // write all schedule data to file
  const scheduleDataFile = path.join(__dirname, 'testout_Schedules.json');
  await fs.writeFile(scheduleDataFile, JSON.stringify(schedule, null, 4));

  const liveData = await destination.getEntityLiveData();
  // test for duplicate live data entries
  const liveDataIds = liveData.map((x) => x._id);
  const duplicateLiveDataIds = liveDataIds.filter((x, i) => liveDataIds.indexOf(x) !== i);
  if (duplicateLiveDataIds.length > 0) {
    logError(`${duplicateLiveDataIds.length} live data ids are duplicated`);
    console.log(duplicateLiveDataIds);
  } else {
    logSuccess(`No live data ids are duplicated`);
  }
  for (const ent of liveData) {
    TestLiveData(ent, allEntities);
  }
  logSuccess(`${liveData.length} live data tested`);

  // write all live data to file
  const liveDataFile = path.join(__dirname, 'testout_LiveData.json');
  await fs.writeFile(liveDataFile, JSON.stringify(liveData, null, 4));

  // check for custom test functions
  //  reflect all functions in the destination object
  //  check for any functions starting with "unittest_"
  //  call each function
  const customTests = Object.getOwnPropertyNames(Object.getPrototypeOf(destination)).filter((x) => x.startsWith('unittest_'));
  for (const test of customTests) {
    console.log(`Running custom test: ${test}`);
    await destination[test](logSuccess, logError);
  }
}

const run = async () => {
  try {
    await TestDestination();
  } catch (err) {
    console.error(err);
  }

  process.exit(0);
};

run();
