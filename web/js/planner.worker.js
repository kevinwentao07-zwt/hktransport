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
      const journeys = data.arriveBy
        ? planArriving(network, data.from, data.to, data.arriveBy, data.departure, data.preference, 8, planLocal)
        : planLocal(network, data.from, data.to, data.departure, data.preference);
      self.postMessage({ id: data.id, journeys });
    }
  } catch (error) {
    self.postMessage({ id: data.id, error: String(error) });
  }
};
