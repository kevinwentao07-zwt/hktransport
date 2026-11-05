// Keeps the route search off the main thread so the page stays responsive.
import { buildNetwork, plan } from './transit.js?v=dev';

let network = null;

self.onmessage = ({ data }) => {
  try {
    if (data.type === 'init') {
      network = buildNetwork(data.db);
      self.postMessage({ id: data.id, ready: true });
    } else {
      const journeys = plan(network, data.from, data.to, data.departure, data.preference);
      self.postMessage({ id: data.id, journeys });
    }
  } catch (error) {
    self.postMessage({ id: data.id, error: String(error) });
  }
};
