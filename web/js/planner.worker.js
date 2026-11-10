// Keeps the route search off the main thread so the page stays responsive.
import { buildNetwork, plan, planArriving, planProposed, tripFacts } from './transit.js?v=dev';

let db = null, network = null;

self.onmessage = ({ data }) => {
  try {
    if (data.type === 'init') {
      db = data.db;
      network = buildNetwork(db);
      self.postMessage({ id: data.id, ready: true });
    } else if (data.type === 'facts') {
      self.postMessage({ id: data.id, facts: tripFacts(network, db, data.from, data.to, data.departure) });
    } else {
      const searched = data.arriveBy
        ? planArriving(network, data.from, data.to, data.arriveBy, data.departure, data.preference)
        : plan(network, data.from, data.to, data.departure, data.preference);
      // The AI's plans lead when they hold up against the route data; otherwise the search's own do.
      const proposed = data.proposals?.length
        ? planProposed(network, data.proposals, data.from, data.to, { departure: data.departure, arriveBy: data.arriveBy, preference: data.preference, baseline: searched })
        : [];
      self.postMessage({ id: data.id, journeys: proposed.length ? proposed : searched, byAI: proposed.length > 0 });
    }
  } catch (error) {
    self.postMessage({ id: data.id, error: String(error) });
  }
};
