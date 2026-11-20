// Keeps the route search off the main thread so the page stays responsive.
import { buildNetwork, planLocal, planArriving } from './transit.js?v=dev';

let db = null, network = null;

self.onmessage = ({ data }) => {
  try {
    if (data.type === 'init') {
      db = data.db;
      network = buildNetwork(db);
      self.postMessage({ id: data.id, ready: true });
    } else if (data.type === 'plan') {
      const { from, to, arriveBy, departure, preference, preferredMode } = data;
      const plan = (net, origin, destination, time, ranking) => planLocal(net, origin, destination, time, ranking, preferredMode);
      const journeys = arriveBy
        ? planArriving(network, from, to, arriveBy, departure, preference, 8, plan)
        : plan(network, from, to, departure, preference);
      self.postMessage({ id: data.id, journeys });
    }
  } catch (error) {
    self.postMessage({ id: data.id, error: String(error) });
  }
};
