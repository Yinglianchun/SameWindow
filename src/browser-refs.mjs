export function snapshotElementRef(snapshotId, index) {
  return `${snapshotId}:e${index + 1}`;
}

export class ElementRefRegistry {
  constructor() {
    this.activeSnapshotId = "";
    this.entries = new Map();
  }

  begin(snapshotId) {
    this.activeSnapshotId = snapshotId;
    this.entries.clear();
  }

  commit(snapshotId, entries) {
    if (snapshotId !== this.activeSnapshotId) {
      throw new Error("snapshot was superseded; take a fresh snapshot");
    }
    for (const entry of entries) {
      this.entries.set(entry.ref, { ...entry, snapshotId });
    }
  }

  resolve(ref, page) {
    const entry = this.entries.get(ref);
    if (
      !entry
      || entry.page !== page
      || entry.snapshotId !== this.activeSnapshotId
    ) {
      throw new Error(`element ref ${ref} is stale; take a fresh snapshot`);
    }
    return entry;
  }

  pages() {
    return [...new Set([...this.entries.values()].map((entry) => entry.page))];
  }

  clear() {
    this.activeSnapshotId = "";
    this.entries.clear();
  }
}

export function resolvePageReference(
  tabRef,
  refToPage,
  pages,
  selectedPage,
  strict = false,
) {
  let page = tabRef ? refToPage.get(tabRef) : selectedPage;
  if (!page || page.isClosed() || !pages.includes(page)) {
    if (strict && tabRef) {
      throw new Error(`browser tab ref ${tabRef} is stale; take a fresh snapshot`);
    }
    page = pages[0] ?? null;
  }
  return page;
}
