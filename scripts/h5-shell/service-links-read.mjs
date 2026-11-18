// Reads the linked services (Settings → Devices → Link a device, ServiceLinks.jsx; "Also update" of the Update dialog, LinkedUpdates.jsx). A module of
// its own, so the Update button (loaded with the page) does not pull the Settings chunk into the first download.
import { api } from './common.jsx';

export const LIST = '/api/service-links';

// The links, or null when this server has no linking (an older server answers 404). Any other failure is thrown: it says nothing about the server's version.
export async function readLinks() {
  try {
    const data = await api('GET', LIST);
    return data && data.supported === true && Array.isArray(data.links) ? data.links : null;
  } catch (error) {
    if (error.status === 404) return null;
    throw error;
  }
}
