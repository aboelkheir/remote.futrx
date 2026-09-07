export interface BrowserAddressTab {
  url: string;
  active: boolean;
}

// The broker reports tabs periodically. Those reports must not replace a URL
// that a person is currently editing in the address bar.
export function syncBrowserAddress(
  currentAddress: string,
  tabs: readonly BrowserAddressTab[],
  editing: boolean,
): string {
  if (editing) return currentAddress;
  const active = tabs.find((tab) => tab.active);
  if (!active) return currentAddress;
  return active.url === "about:blank" ? "" : active.url;
}
