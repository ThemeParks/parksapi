import parksapi from './lib/index.js';
import moment from 'moment-timezone';
import path from 'path';
import {promises as fs} from 'fs';
import {time} from 'console';

const __dirname = path.dirname(process.argv[1]);

// park to save responses for
const destination = new parksapi.destinations.Efteling();

destination.http.injectForDomainResponse({
  // sift query to filter out unwanted requests
  hostname: 'api.efteling.com',
}, async (resp, method, url, data, options) => {
  // generate folder to store response in
  const urlObj = new URL(url);
  const hostname = urlObj.hostname;
  const pathSrc = urlObj.pathname;
  const body = resp.body;
  const timestamp = moment().format('YYYYMMDD_HHmmss');
  const dataFolder = path.join(__dirname, 'data', hostname);
  // create directory if it doesn't exist
  await fs.mkdir(dataFolder, {recursive: true});
  // create filename
  const filename = path.join(__dirname, 'data', hostname, `${pathSrc.replace(/\//g, '_')}_${timestamp}.json`);
  console.log(`[\x1b[33m!\x1b[0m]`, `Writing to ${filename}...`);
  try {
    const fileOutput = JSON.stringify({
      timestamp: timestamp,
      method: method,
      url: url,
      data: data,
      options: options,
      body: body,
    }, null, 4);
    await fs.writeFile(filename, fileOutput);
  } catch (err) {
    console.error(`[\x1b[31m✗\x1b[0m]`, `Error writing to ${filename}: ${err}`);
  }

  // make sure we return the response so the library can continue
  return resp;
});

async function run() {
  const sync = async () => {
    console.log(`[\x1b[33m!\x1b[0m]`, `Syncing at ${new Date().toISOString()}`);

    // get live data
    try {
      await destination.getEntityLiveData();
    } catch (err) {
      console.error(`[\x1b[31m✗\x1b[0m]`, `Error getting live data: ${err}`);
    }
  };

  // get live data every minute
  setInterval(() => {
    sync();
  }, 1000 * 60);
  sync();
}
run();
