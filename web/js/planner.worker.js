// Keeps the route search off the main thread so the page stays responsive.
import { buildNetwork, plan, planArriving } from './transit.js?v=dev';

let network = null;

self.onmessage = ({ data }) => {
  try {
    if (data.type === 'init') {
      network = buildNetwork(data.db);
      self.postMessage({ id: data.id, ready: true });
    } else {
      const journeys = data.arriveBy
        ? planArriving(network, data.from, data.to, data.arriveBy, data.departure, data.preference)
        : plan(network, data.from, data.to, data.departure, data.preference);
      self.postMessage({ id: data.id, journeys });
    }
  } catch (error) {
    self.postMessage({ id: data.id, error: String(error) });
  }
};
