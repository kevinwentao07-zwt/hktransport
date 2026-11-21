// Keeps the route search off the main thread so the page stays responsive.
import { buildNetwork, planLocal, planArriving, requireEdUHKShuttle } from './transit.js?v=dev';
import { withEdUHKShuttle } from './eduhk.js?v=dev';

let db = null, network = null, shuttleNetwork = null, shuttleOnlyNetwork = null;

self.onmessage = ({ data }) => {
  try {
    if (data.type === 'init') {
      db = data.db;
      network = buildNetwork(db);
      shuttleNetwork = null;
      shuttleOnlyNetwork = null;
      self.postMessage({ id: data.id, ready: true });
    } else if (data.type === 'plan') {
      const { from, to, arriveBy, departure, preference, preferredMode, includeEdUHK, shuttleOnly } = data;
      if (includeEdUHK || shuttleOnly) shuttleNetwork ??= buildNetwork(withEdUHKShuttle(db));
      const activeNetwork = shuttleOnly ? (shuttleOnlyNetwork ??= requireEdUHKShuttle(shuttleNetwork))
        : includeEdUHK ? shuttleNetwork : network;
      const plan = (net, origin, destination, time, ranking) => planLocal(net, origin, destination, time, ranking, preferredMode);
      const journeys = arriveBy
        ? planArriving(activeNetwork, from, to, arriveBy, departure, preference, 8, plan)
        : plan(activeNetwork, from, to, departure, preference);
      self.postMessage({ id: data.id, journeys });
    }
  } catch (error) {
    self.postMessage({ id: data.id, error: String(error) });
  }
};
